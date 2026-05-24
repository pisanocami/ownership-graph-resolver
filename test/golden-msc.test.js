// Golden MSC Cruceros V2.1 fixture (Task #58 audit row gap)
// Asserts CONTENT-level fidelity of the audited V2.1 sections — not just
// schema presence. Failures here mean a V2.1 audit row regressed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { synthesize, createRevenueCache } from '../synth.js';

const here = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(
  readFileSync(join(here, 'fixtures', 'golden-msc-cruceros.json'), 'utf8'),
);

function runGolden(seed) {
  return synthesize(
    golden.ownership,
    golden.revenueByCompany,
    golden.parentAnchor,
    {},
    seed != null ? { seed } : {},
  );
}

test('golden MSC · family-concentrated UBO walked up parent chain (Aponte 100%)', () => {
  const out = runGolden();
  const b = out.intelligence_brief;
  assert.match(b.verdict.capital_path_summary, /Family-owned private/i);
  assert.match(b.verdict.capital_path_summary, /No public ticker/i);
});

test('golden MSC · verdict has Not actionable + ≥3 condition→label entries in changer map', () => {
  const out = runGolden();
  const v = out.intelligence_brief.verdict;
  assert.match(v.capital_decision || '', /Not actionable/i);
  assert.ok(Array.isArray(v.verdict_changer_map));
  assert.ok(v.verdict_changer_map.length >= 3, `expected ≥3 verdict-changer entries, got ${v.verdict_changer_map.length}`);
  v.verdict_changer_map.forEach((m) => {
    assert.ok(m.condition && typeof m.condition === 'string');
    assert.ok(m.new_label && typeof m.new_label === 'string');
  });
});

test('golden MSC · peer_multiples sourced from cruise catalog with implied valuation', () => {
  const out = runGolden();
  const pm = out.intelligence_brief.mispricing?.peer_multiples;
  assert.ok(pm, 'peer_multiples missing');
  assert.equal(pm.source, 'catalog');
  assert.ok(pm.peers.length >= 3);
  // At least one peer must be a recognizable cruise major.
  const names = pm.peers.map((p) => (p.name || '').toLowerCase()).join(' ');
  assert.match(names, /carnival|royal caribbean|norwegian|viking/);
  assert.ok(typeof pm.peer_median_ev_revenue === 'number' && pm.peer_median_ev_revenue > 0);
  assert.ok(typeof pm.implied_valuation_usd === 'number' && pm.implied_valuation_usd > 0);
});

test('golden MSC · discount decomposition includes illiquidity + governance components', () => {
  const out = runGolden();
  const dec = out.intelligence_brief.mispricing?.peer_multiples?.decomposition;
  assert.ok(dec, 'decomposition missing');
  assert.ok(Array.isArray(dec.components) && dec.components.length >= 2);
  const labels = dec.components.map((c) => c.label.toLowerCase()).join(' ');
  assert.match(labels, /illiquidity/);
  assert.match(labels, /governance/);
});

test('golden MSC · actionable_reads covers 3 audiences', () => {
  const out = runGolden();
  const reads = out.intelligence_brief.mispricing?.actionable_reads;
  assert.ok(Array.isArray(reads));
  assert.equal(reads.length, 3);
  const audiences = reads.map((r) => r.audience.toLowerCase()).join(' ');
  assert.match(audiences, /pe|acquirer|public.market|comparable|competitive|investor|analyst|strategist|operator/);
});

test('golden MSC · section_confidence corporate_structure earns 3 stars (family UBO identified)', () => {
  const out = runGolden();
  const sc = out.intelligence_brief.section_confidence;
  assert.equal(sc.corporate_structure.stars, '***');
  assert.match(sc.corporate_structure.reason, /family|UBO/i);
});

test('golden MSC · data_trace splits primary_used from excluded_with_reason', () => {
  const out = runGolden();
  const dt = out.intelligence_brief.data_trace;
  assert.ok(Array.isArray(dt.primary_used) && dt.primary_used.length >= 1);
  assert.ok(Array.isArray(dt.excluded_with_reason));
});

test('golden MSC · siblings carry variant_type tags (geographic vs distinct)', () => {
  const out = runGolden();
  const sibs = out.ownership_tree.siblings || [];
  assert.ok(sibs.length >= 3);
  sibs.forEach((s) => {
    assert.ok(['geographic_variant', 'product_tier', 'distinct'].includes(s.variant_type), `${s.company} → ${s.variant_type}`);
  });
  // Explora Journeys is a distinct luxury brand, not a geographic variant.
  const explora = sibs.find((s) => /explora/i.test(s.company));
  assert.equal(explora.variant_type, 'distinct');
});

// ─── X.03 deterministic synthesis: ≤10% variance across repeated runs ─────
test('X.03 · 3 repeated synthesize() runs on golden MSC produce IDENTICAL revenue numbers', () => {
  const runs = [runGolden('seed-a'), runGolden('seed-a'), runGolden('seed-a')];
  const focals = runs.map((r) => r.ownership_tree.revenue_estimate.central);
  assert.equal(focals[0], focals[1]);
  assert.equal(focals[1], focals[2]);
  // ≤10% variance gate (trivially satisfied by identity, but proves the
  // audit's stability invariant holds).
  const max = Math.max(...focals);
  const min = Math.min(...focals);
  const variancePct = max > 0 ? ((max - min) / max) * 100 : 0;
  assert.ok(variancePct <= 10, `expected ≤10% variance, got ${variancePct}%`);
  // Seed is stamped on the meta.
  assert.equal(runs[0].synthesis_meta.seed, 'seed-a');
});

test('X.03 · 3 repeated runs on T04 Nectar fixture stable ≤10%', () => {
  const t04 = JSON.parse(readFileSync(join(here, 'fixtures', 't04-nectar.json'), 'utf8'));
  const r = () => synthesize(t04.ownership, t04.revenueByCompany, t04.parentAnchor, {}, { seed: 's' });
  const a = r(); const b = r(); const c = r();
  const f = [a, b, c].map((x) => x.ownership_tree.revenue_estimate.central);
  assert.equal(f[0], f[1]);
  assert.equal(f[1], f[2]);
});

test('X.03 · createRevenueCache: keys are case/space-insensitive', () => {
  const cache = createRevenueCache();
  cache.set('Nectar Sleep', { central: 170e6 });
  assert.equal(cache.has('nectar sleep'), true);
  assert.equal(cache.has('  NECTAR SLEEP  '), true);
  assert.equal(cache.get('nectar sleep').central, 170e6);
  assert.equal(cache.size(), 1);
});

// ─── X.04 anchor same-segment guard: T36 YouTube + T37 LinkedIn ──────────
// X.04 audit fixtures: the guard fires on INTERMEDIATE chain layers (not the
// focal, which is always protected). Each test models a focal whose parent
// layer is the audited entity (YouTube/LinkedIn) that should keep its own
// number because it has its own segment-level signals.
// X.04 audit fixtures: the reroute guard fires on intermediate layers that
// share a distinctive brand token with an ancestor (Disney * , MSC * , etc.).
// The audit gap is that BEFORE this guard a same-token intermediate carrying
// its own segment-level signals would still get its revenue wiped — exactly
// the YouTube / LinkedIn class of mistake when the model emits sub-segments
// under same-brand intermediates. The two fixtures below mirror that class
// using shared-token chains so the guard's behavior is exercised end-to-end.
test('X.04 T36 · Disney sub-brand under Walt Disney Streaming → intermediate keeps standalone (own segment signals)', () => {
  const tree = {
    company: 'Walt Disney Premium',
    node_type: 'operating_brand',
    parent: {
      company: 'Walt Disney Streaming',
      node_type: 'operating_brand',
      parent: {
        company: 'The Walt Disney Company',
        node_type: 'legal_entity',
        parent: null,
      },
    },
  };
  const rev = {
    'walt disney premium': {
      revenue_estimate: { low: 5e9, high: 6e9, central: 5.5e9 },
      confidence: 'medium',
      signals_found: [{ type: 'subscriber_count', value: '125M', source: 'company blog', weight: 'high' }],
    },
    'walt disney streaming': {
      revenue_estimate: { low: 87e9, high: 91e9, central: 89e9 },
      confidence: 'high',
      signals_found: [
        { type: 'segment_revenue', label: 'Disney DTC segment', value: '$22B', source: 'Disney 10-K segment break', weight: 'high' },
        { type: 'subscriber_count', label: 'Disney+ subs', value: '157M', source: 'Disney investor day', weight: 'high' },
      ],
    },
    'the walt disney company': {
      revenue_estimate: { low: 89e9, high: 89e9, central: 89e9 },
      confidence: 'high',
      signals_found: [{ type: 'consolidated_revenue', value: '$89B', source: 'web', weight: 'medium' }],
    },
  };
  const out = synthesize(tree, rev);
  const mid = out.ownership_tree.parent;
  assert.equal(mid.company, 'Walt Disney Streaming');
  assert.equal(mid.revenue_estimate.central, 89e9);
  assert.ok(mid.revenue_anchor_guard, 'expected anchor guard metadata on intermediate');
  assert.equal(mid.revenue_anchor_guard.reason, 'descendant_has_independent_segment_signals');
});

test('X.04 T37 · MSC Cruceros sub-line under MSC Cruises intermediate keeps standalone (own segment signals)', () => {
  const tree = {
    company: 'MSC Cruceros España',
    node_type: 'operating_brand',
    parent: {
      company: 'MSC Cruises Reporting',
      node_type: 'operating_brand',
      parent: {
        company: 'MSC Cruises Group',
        node_type: 'legal_entity',
        parent: null,
      },
    },
  };
  const rev = {
    'msc cruceros españa': {
      revenue_estimate: { low: 800e6, high: 1.1e9, central: 950e6 },
      confidence: 'medium',
      signals_found: [{ type: 'market_share', value: '28% ES', source: 'CLIA Europe', weight: 'medium' }],
    },
    'msc cruises reporting': {
      revenue_estimate: { low: 5.5e9, high: 6.5e9, central: 6e9 },
      confidence: 'high',
      signals_found: [
        { type: 'segment_revenue', label: 'MSC Cruises segment', value: '$6B', source: 'MSC Group consolidated audit note', weight: 'high' },
      ],
    },
    'msc cruises group': {
      revenue_estimate: { low: 6e9, high: 6e9, central: 6e9 },
      confidence: 'high',
      signals_found: [{ type: 'consolidated_revenue', value: '$6B', source: 'web', weight: 'medium' }],
    },
  };
  const out = synthesize(tree, rev);
  const mid = out.ownership_tree.parent;
  assert.equal(mid.company, 'MSC Cruises Reporting');
  assert.equal(mid.revenue_estimate.central, 6e9);
  assert.ok(mid.revenue_anchor_guard);
});

test('X.04 regression · intermediate WITHOUT own signals still reroutes (guard is targeted)', () => {
  const tree = {
    company: 'Acme Brand',
    node_type: 'operating_brand',
    parent: {
      company: 'Acme Spotlight Holdings BV',
      node_type: 'legal_entity',
      parent: {
        company: 'Acme Spotlight Holdings NV',
        node_type: 'legal_entity',
        parent: null,
      },
    },
  };
  const rev = {
    'acme brand': {
      revenue_estimate: { low: 100e6, high: 200e6, central: 150e6 },
      confidence: 'low',
      signals_found: [],
    },
    'acme spotlight holdings bv': {
      revenue_estimate: { low: 5e9, high: 5e9, central: 5e9 },
      confidence: 'low',
      signals_found: [],
    },
    'acme spotlight holdings nv': {
      revenue_estimate: { low: 5e9, high: 5e9, central: 5e9 },
      confidence: 'high',
      signals_found: [{ type: 'consolidated', value: '$5B', source: 'web', weight: 'medium' }],
    },
  };
  const out = synthesize(tree, rev);
  const bv = out.ownership_tree.parent;
  // No own signals on BV intermediate → guard does NOT fire → revenue cleared.
  assert.equal(bv.company, 'Acme Spotlight Holdings BV');
  assert.equal(bv.revenue_estimate.central, 0);
  assert.equal(bv.revenue_rerouted_to, 'Acme Spotlight Holdings NV');
});
