import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSignalCache, mergeSignals, getOrFetchSignals } from '../signal_cache.js';
import {
  SEARCH_STRATEGIES, normalizeCategoryKey, strategyKeyFor, requiredQueriesFor, fetchRequiredSignals,
} from '../search_strategies/index.js';
import {
  indexEntities, buildRunSnapshot, detectCrossRunVariance, computeModelParity,
} from '../determinism.js';

// ─── D2: signal-level cache + retention across runs ─────────────────────────

test('D2: cached signal retained across runs even when not re-surfaced (NEW.37)', async () => {
  const cache = createSignalCache();
  // Run 1 surfaces Chuck Vogel + an Awara revenue anchor.
  await getOrFetchSignals(cache, { company: 'Resident Home' }, () => [
    { signal_label: 'Chuck Vogel co-founder', signal_type: 'family', evidence_value: 'Co-founder of Resident Home' },
  ], { runId: 'run-1' });
  await getOrFetchSignals(cache, { company: 'Awara' }, () => [
    { signal_label: 'Awara 2024 DTC revenue', evidence_value: '$9.2M', source: 'Grips Intelligence' },
  ], { runId: 'run-1' });

  // Run 2: the model surfaces NOTHING new for these entities.
  const run2Resident = await getOrFetchSignals(cache, { company: 'Resident Home' }, () => [], { runId: 'run-2' });
  const run2Awara = await getOrFetchSignals(cache, { company: 'Awara' }, () => [], { runId: 'run-2' });

  assert.ok(run2Resident.some((s) => s.signal_label === 'Chuck Vogel co-founder'), 'Chuck Vogel retained');
  assert.ok(run2Awara.some((s) => s.source === 'Grips Intelligence'), 'Awara Grips anchor retained');
});

test('D2: mergeSignals dedups by signal_label, fresh wins', () => {
  const cached = [{ signal_label: 'rev', evidence_value: '$8.5M', source: 'old' }];
  const fresh = [{ signal_label: 'rev', evidence_value: '$9.2M', source: 'Grips' }, { signal_label: 'traffic', evidence_value: '2M' }];
  const merged = mergeSignals(cached, fresh);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((s) => s.signal_label === 'rev').source, 'Grips');
});

test('D2: file persistence round-trips (Node)', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sigcache-'));
  const file = path.join(dir, 'signals.json');
  const c1 = createSignalCache();
  c1.set({ entity_id: 'Awara', signal_label: 'rev', evidence_value: '$9.2M' });
  await c1.flushToFile(file);
  const c2 = createSignalCache();
  const n = await c2.loadFromFile(file);
  assert.equal(n, 1);
  assert.equal(c2.get('Awara', 'rev').evidence_value, '$9.2M');
  rmSync(dir, { recursive: true, force: true });
});

// ─── D3: search-strategy whitelist ──────────────────────────────────────────

test('D3: mattress operating_brand produces the required query list', () => {
  const entity = { company: 'Awara', node_type: 'operating_brand', category: 'luxury mattress brand' };
  assert.equal(normalizeCategoryKey(entity.category), 'mattress');
  assert.equal(strategyKeyFor(entity), 'operating_brand:mattress');
  const queries = requiredQueriesFor(entity);
  assert.ok(queries.includes('Awara Grips Intelligence revenue'));
  assert.equal(queries.length, SEARCH_STRATEGIES['operating_brand:mattress'].length);
});

test('D3: PE firm is category-agnostic; uncovered category yields no queries', () => {
  assert.equal(strategyKeyFor({ company: '3G Capital', node_type: 'private_equity_firm' }), 'private_equity_firm');
  assert.deepEqual(requiredQueriesFor({ company: 'Weird Co', node_type: 'operating_brand', category: 'artisanal widgets' }), []);
});

test('D3: fetchRequiredSignals runs the injected searcher', async () => {
  const entity = { company: 'Awara', node_type: 'operating_brand', category: 'mattress' };
  const { queries, signals } = await fetchRequiredSignals(entity, (q) => [{ signal_label: q, evidence_value: 'x' }]);
  assert.equal(signals.length, queries.length);
});

// ─── D4: cross-run variance detection ───────────────────────────────────────

test('D4: flags >50% revenue variance vs latest cached run (NEW.36)', () => {
  const prev = buildRunSnapshot({ ownership_tree: { company: 'Resident Home', children: [{ company: 'Awara', revenue_estimate: { central: 8.5e6 } }] } }, { runId: 'r1' });
  const cur = buildRunSnapshot({ ownership_tree: { company: 'Resident Home', children: [{ company: 'Awara', revenue_estimate: { central: 65e6 } }] } }, { runId: 'r2' });
  const flags = detectCrossRunVariance(cur, [prev]);
  assert.ok(flags && flags.length === 1);
  assert.equal(flags[0].entity, 'Awara');
  assert.ok(flags[0].variance_pct > 50);
});

test('D4: returns null when within threshold', () => {
  const prev = buildRunSnapshot({ ownership_tree: { company: 'X', children: [{ company: 'A', revenue_estimate: { central: 100 } }] } });
  const cur = buildRunSnapshot({ ownership_tree: { company: 'X', children: [{ company: 'A', revenue_estimate: { central: 110 } }] } });
  assert.equal(detectCrossRunVariance(cur, [prev]), null);
});

// ─── D5: model parity ───────────────────────────────────────────────────────

test('D5: identical structure → parity 1.0 even if revenue differs', () => {
  const sonnet = { ownership_tree: { company: 'MSC Cruceros', primary_parent_id: 'MSC Group', revenue_estimate: { central: 5e9 }, siblings: [{ company: 'Explora Journeys', primary_parent_id: 'MSC Group' }] } };
  const gemini = { ownership_tree: { company: 'MSC Cruceros', primary_parent_id: 'MSC Group', revenue_estimate: { central: 4e9 }, siblings: [{ company: 'Explora Journeys', primary_parent_id: 'MSC Group' }] } };
  const p = computeModelParity(sonnet, gemini);
  assert.equal(p.parity, 1);
});

test('D5: structural divergence lowers parity', () => {
  const a = { ownership_tree: { company: 'X', primary_parent_id: 'P', siblings: [{ company: 'S1', primary_parent_id: 'P' }] } };
  const b = { ownership_tree: { company: 'X', primary_parent_id: 'Q', siblings: [] } };
  const p = computeModelParity(a, b);
  assert.ok(p.parity < 1);
});
