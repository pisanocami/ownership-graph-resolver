import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  synthesize, collectEntities, deriveStatus, deriveRevenueStatus,
  normalizeChain, deriveDivestiture, isCircularEstimate, collectControlLayers,
  guardConglomerateRevenueOnSubAffiliate, computeRevenueDivergence,
} from '../synth.js';

const here = dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(readFileSync(join(here, 'fixtures', f), 'utf8'));

const t04 = load('t04-nectar.json');
const t01 = load('t01-anthropic.json');
const tZara = load('t-zara.json');
const tTikTok = load('t-tiktok.json');

// ─── Bundle A: Cloverlane temporal accuracy + status (T04) ──────────────────

test('T04: Cloverlane (recent active brand) survives the sibling pipeline', () => {
  const entities = collectEntities(t04.ownership);
  assert.ok(
    entities.some((e) => e.company === 'Cloverlane'),
    'Cloverlane must be collected for revenue enrichment, not dropped by the cap'
  );

  const out = synthesize(t04.ownership, t04.revenueByCompany, t04.parentAnchor);
  const clover = out.ownership_tree.siblings.find((s) => s.company === 'Cloverlane');
  assert.ok(clover, 'Cloverlane present among synthesized siblings');
  assert.equal(deriveStatus(clover).label, 'active', 'in_current_sources:true → active');
});

test('T04: historical-only siblings derive to legacy/discontinued', () => {
  const out = synthesize(t04.ownership, t04.revenueByCompany, t04.parentAnchor);
  const legacyCount = out.ownership_tree.siblings.filter((s) =>
    ['legacy', 'discontinued'].includes(deriveStatus(s).label)
  ).length;
  assert.ok(legacyCount >= 1, 'at least one historical-only brand (Bundle/Wovenly/Level) is legacy');
});

test('T04: sibling with no estimate exposes a descriptive reason, not "n/a"', () => {
  const out = synthesize(t04.ownership, t04.revenueByCompany, t04.parentAnchor);
  const clover = out.ownership_tree.siblings.find((s) => s.company === 'Cloverlane');
  const rs = deriveRevenueStatus(clover);
  assert.equal(rs.hasEstimate, false);
  assert.match(rs.reason, /launched/i);
  assert.notEqual(rs.reason, 'n/a');
});

// ─── Bundle C: strategic_control on every layer (T04) ───────────────────────

test('T04: strategic_control is populated per layer, not just focal', () => {
  const out = synthesize(t04.ownership, t04.revenueByCompany, t04.parentAnchor);
  const tree = out.ownership_tree;
  assert.ok(tree.strategic_control.length > 0, 'focal (Nectar) has control');
  assert.ok(tree.parent.strategic_control.length > 0, 'parent (Resident) has control');
  assert.ok(tree.parent.parent.parent.strategic_control.length > 0, 'root (Ashley) has control');
});

test('T04: an empty layer carries a no_data_found note', () => {
  const out = synthesize(t04.ownership, t04.revenueByCompany, t04.parentAnchor);
  const ashleyGlobal = out.ownership_tree.parent.parent; // Ashley Global Retail
  assert.equal(ashleyGlobal.strategic_control.length, 0);
  assert.match(ashleyGlobal.strategic_control_note, /^no_data_found/);
});

test('T04: strategic_control items use free role_description, not an enum field', () => {
  const out = synthesize(t04.ownership, t04.revenueByCompany, t04.parentAnchor);
  const item = out.ownership_tree.strategic_control[0];
  assert.equal(typeof item.role_description, 'string');
  assert.equal(item.relationship, undefined, 'no hardcoded enum relationship key');
});

// ─── Bundle B: reconciliation explanation (T04) ─────────────────────────────

test('T04: a >20% reconciliation gap produces an explanation with 1:1 evidence', () => {
  const out = synthesize(t04.ownership, t04.revenueByCompany, t04.parentAnchor);
  const recon = out.positioning_analysis.reconciliation;
  assert.ok(recon, 'reconciliation fires (parent + >=2 known revenues)');
  assert.ok(Math.abs(recon.pct_delta) > 20, 'gap is material');
  assert.ok(recon.explanation, 'explanation attached');
  assert.ok(recon.explanation.likely_causes.length >= 1);
  assert.equal(
    recon.explanation.likely_causes.length,
    recon.explanation.evidence_for_each.length,
    'causes and evidence are 1:1'
  );
  const joined = recon.explanation.likely_causes.join(' | ').toLowerCase();
  assert.match(joined, /missing|wholesale|b2b|non-brand|white-?label/);
});

// ─── Regression guardrails (T01 Anthropic) ──────────────────────────────────

test('T01: Bun still appears as a sibling', () => {
  const out = synthesize(t01.ownership, t01.revenueByCompany, t01.parentAnchor);
  assert.ok(
    out.ownership_tree.siblings.some((s) => s.company === 'Bun'),
    'Bun must not be lost by the new sibling pipeline'
  );
});

test('T01: no parent / <2 known revenues → reconciliation stays inert (null)', () => {
  const out = synthesize(t01.ownership, t01.revenueByCompany, t01.parentAnchor);
  assert.equal(out.positioning_analysis.reconciliation, null);
});

// ─── Zara report fixes (discontinued status, double-count, currency, dedup) ──

test('Zara: a listed-but-closed brand (Uterqüe) is discontinued, not active', () => {
  const out = synthesize(tZara.ownership, tZara.revenueByCompany, tZara.parentAnchor);
  const uterque = out.ownership_tree.siblings.find((s) => s.company === 'Uterqüe');
  assert.ok(uterque);
  assert.equal(deriveStatus(uterque).label, 'discontinued', 'closure signal + no revenue → discontinued');
  assert.equal(uterque._derived_status.label, 'discontinued');
});

test('Zara: siblings consolidated in the focal segment are excluded from the sum', () => {
  const out = synthesize(tZara.ownership, tZara.revenueByCompany, tZara.parentAnchor);
  const recon = out.positioning_analysis.reconciliation;
  assert.ok(recon, 'reconciliation fires');
  assert.ok(recon.consolidated_siblings.includes('Zara Home'), 'Zara Home flagged consolidated');
  assert.ok(recon.consolidated_siblings.includes('Lefties'), 'Lefties flagged consolidated');
  // Zara Home ($1.8B) must NOT be double-counted on top of the Zara segment.
  assert.ok(recon.sum_children_central < 43_000_000_000, 'Zara Home excluded from the sum');
  assert.equal(recon.sum_children_central, 42_170_000_000);
});

test('Zara: parent revenue + ratio use the anchor USD total (currency consistency)', () => {
  const out = synthesize(tZara.ownership, tZara.revenueByCompany, tZara.parentAnchor);
  const parent = out.ownership_tree.parent;
  assert.equal(parent.revenue_estimate.central, 42_317_000_000, 'parent shown in anchor USD');
  assert.equal(parent.revenue_estimate.anchor_sourced, true);
  assert.match(out.positioning_analysis.focal_vs_parent_ratio, /70\.9%/);
});

// ─── Bug #1: context_unverified discipline for homonymous siblings ──────────

test('Bug #1: sibling with ALL context_unverified signals is zeroed with descriptive reason', () => {
  // Simulate the Siena (Resident sibling) vs Siena AI (SaaS) collision.
  const ownership = JSON.parse(JSON.stringify(t04.ownership));
  const revenueByCompany = {
    ...t04.revenueByCompany,
    'siena': {
      company: 'Siena',
      revenue_estimate: { low: 4_000_000, high: 8_000_000, central: 5_900_000 },
      confidence: 'medium',
      signals_found: [
        { type: 'pricing', label: 'pricing page', value: '$750/mo', source: 'siena.cx', weight: 'medium', context_unverified: true },
        { type: 'reviews', label: 'G2 4.8/5', value: 'G2 rating', source: 'g2.com', weight: 'high', context_unverified: true },
      ],
      reasoning_summary: 'Pricing + G2 rating triangulate to ~$5.9M ARR.',
    },
  };
  // Inject Siena into siblings if not present.
  if (!ownership.siblings.some((s) => s.company === 'Siena')) {
    ownership.siblings.push({ company: 'Siena', in_current_sources: true, in_historical_sources: false, category: 'hybrid mattress' });
  }
  const entities = collectEntities(ownership);
  const entByCo = Object.fromEntries(entities.map((e) => [e.company.toLowerCase().trim(), e]));
  const out = synthesize(ownership, revenueByCompany, t04.parentAnchor, entByCo);
  const siena = out.ownership_tree.siblings.find((s) => s.company === 'Siena');
  assert.ok(siena);
  assert.equal(siena.revenue_estimate.central, 0, 'all context_unverified → estimate zeroed');
  assert.equal(siena.revenue_estimate.confidence, 'low');
  assert.equal(siena.context_unverified_all, true, 'flag propagated to node');
  assert.match(siena.reason_for_null, /homonymous|context_unverified|verify/i);
  assert.match(siena.reason_for_null, /Resident/, 'reason names the parent for clarity');
  siena.signals_found.forEach((s) => {
    assert.equal(s.weight, 'low', 'context_unverified signal weight forced to low');
  });
});

test('Bug #1: collectEntities propagates parent_company to siblings', () => {
  const entities = collectEntities(t04.ownership);
  const focalParent = t04.ownership.parent.company;
  const siblingEnt = entities.find((e) => e.role === 'sibling');
  assert.ok(siblingEnt, 'at least one sibling collected');
  assert.equal(siblingEnt.parent_company, focalParent, 'sibling carries the focal parent name for disambiguation');
});

// ─── TikTok: surface buried data, circular reconciliation, divestiture ──────

test('TikTok: the parent\'s JV (USDS) and its ownership split are surfaced', () => {
  const out = synthesize(tTikTok.ownership, tTikTok.revenueByCompany, tTikTok.parentAnchor);
  const layers = collectControlLayers(out.ownership_tree);
  const jv = layers.find((l) => l.node.company === 'TikTok USDS Joint Venture LLC');
  assert.ok(jv, 'USDS JV (child of the parent) must appear in the control layers');
  assert.equal(jv.under, 'ByteDance Ltd.');
  assert.ok(jv.node.strategic_control.some((s) => s.entity === 'Oracle Corporation'));
});

test('TikTok: a top-down-from-parent estimate makes reconciliation circular', () => {
  const out = synthesize(tTikTok.ownership, tTikTok.revenueByCompany, tTikTok.parentAnchor);
  const recon = out.positioning_analysis.reconciliation;
  assert.ok(recon);
  assert.equal(recon.circular, true, 'Douyin estimated as a share of the parent → circular');
  assert.ok(recon.circular_siblings.includes('Douyin'));
  assert.ok(isCircularEstimate(out.ownership_tree.siblings.find((s) => s.company === 'Douyin')));
});

test('TikTok: a pending divestiture is detected from captured signals', () => {
  const out = synthesize(tTikTok.ownership, tTikTok.revenueByCompany, tTikTok.parentAnchor);
  const ml = out.ownership_tree.siblings.find((s) => s.company === 'Mobile Legends: Bang Bang');
  assert.ok(ml._divestiture && ml._divestiture.divesting, 'Moonton sale → divesting flag');
  assert.match(ml._divestiture.detail, /Moonton|Savvy/);
  assert.equal(deriveDivestiture({ signals_found: [] }), null);
});

test('TikTok: signal coverage counts are attached to nodes', () => {
  const out = synthesize(tTikTok.ownership, tTikTok.revenueByCompany, tTikTok.parentAnchor);
  const douyin = out.ownership_tree.siblings.find((s) => s.company === 'Douyin');
  assert.equal(douyin.signals_found_count, 4);
  assert.equal(out.ownership_tree.signals_attempted, 2);
});

test('Zara: strategic_control is deduplicated across layers', () => {
  const out = synthesize(tZara.ownership, tZara.revenueByCompany, tZara.parentAnchor);
  const tree = out.ownership_tree;
  const parentEntities = new Set(tree.parent.strategic_control.map((s) => s.entity));
  const focalRepeats = tree.strategic_control.filter((s) => parentEntities.has(s.entity));
  assert.equal(focalRepeats.length, 0, 'no owner repeated from the parent layer on the focal');
  assert.ok(tree.parent.strategic_control.some((s) => s.entity === 'Amancio Ortega'));
});

// ─── Bug #5: Chain normalization (legal_name vs brand_name) ─────────────────

test('Bug #5: ByteDance Ltd. + ByteDance with shared domain+founders+HQ collapse to one', () => {
  const ownership = {
    company: 'TikTok',
    domain: 'tiktok.com',
    node_type: 'operating_brand',
    parent: {
      company: 'ByteDance',
      domain: 'bytedance.com',
      node_type: 'legal_entity',
      headquarters: 'Beijing, China',
      founding_date: '2012-03-01',
      founders: ['Zhang Yiming', 'Liang Rubo'],
      sources: ['https://bytedance.com/about'],
      revenue_estimate: { low: 150e9, high: 160e9, central: 155e9, confidence: 'medium' },
      parent: {
        company: 'ByteDance Ltd.',
        domain: 'bytedance.com',
        node_type: 'legal_entity',
        headquarters: 'Beijing, China',
        founding_date: '2012-03-01',
        founders: ['Zhang Yiming', 'Liang Rubo'],
        sources: ['https://sec.gov/...'],
        revenue_estimate: { low: 165e9, high: 175e9, central: 170.5e9, confidence: 'high' },
        parent: null,
      },
    },
  };
  const { tree, collapses } = normalizeChain(ownership);
  assert.equal(collapses.length, 1, 'one collapse fires');
  assert.equal(collapses[0].canonical, 'ByteDance Ltd.', 'formal legal name wins as canonical');
  assert.ok(collapses[0].shared.includes('domain'));
  assert.ok(collapses[0].shared.length >= 2, '2+ identifiers shared');
  // Chain should now be TikTok → ByteDance Ltd. (single layer), no nested duplicate.
  assert.equal(tree.parent.company, 'ByteDance Ltd.');
  assert.equal(tree.parent.parent, null, 'duplicate layer removed');
  // Revenue range unified to the widest band [150B, 175B].
  assert.equal(tree.parent.revenue_estimate.low, 150e9);
  assert.equal(tree.parent.revenue_estimate.high, 175e9);
  // Sources merged.
  assert.equal(tree.parent.sources.length, 2);
});

test('Bug #5: Inditex + Pontegadea (distinct UBO, distinct domains) do NOT collapse', () => {
  // Inject a Pontegadea-like layer above Inditex.
  const ownership = JSON.parse(JSON.stringify(tZara.ownership));
  ownership.parent.parent = {
    company: 'Pontegadea Inversiones SL',
    domain: 'pontegadea.com',
    node_type: 'legal_entity',
    parent: null,
  };
  const { collapses } = normalizeChain(ownership);
  assert.equal(collapses.length, 0, 'Inditex ≠ Pontegadea: no collapse');
});

test('Bug #5: Alphabet Inc. + Google LLC (distinct domains) do NOT collapse', () => {
  const ownership = {
    company: 'YouTube',
    domain: 'youtube.com',
    parent: {
      company: 'Google LLC',
      domain: 'google.com',
      node_type: 'legal_entity',
      ticker: null,
      headquarters: 'Mountain View, CA',
      parent: {
        company: 'Alphabet Inc.',
        domain: 'abc.xyz',
        node_type: 'legal_entity',
        ticker: 'GOOGL',
        headquarters: 'Mountain View, CA',
        parent: null,
      },
    },
  };
  const { collapses } = normalizeChain(ownership);
  assert.equal(collapses.length, 0, 'Alphabet ≠ Google: no collapse');
});

test('Bug #5: "X Holdings" + "X" with no other identifier overlap is flagged, not collapsed', () => {
  const ownership = {
    company: 'Focal',
    parent: {
      company: 'Acme',
      domain: 'acme.com',
      parent: {
        company: 'Acme Holdings',
        domain: 'acmeholdings.com',
        parent: null,
      },
    },
  };
  const { collapses, holdingFlags } = normalizeChain(ownership);
  assert.equal(collapses.length, 0, 'holding/operating pair not auto-collapsed');
  assert.ok(holdingFlags.some((f) => f.includes('Acme')), 'flagged for review');
});

test('Bug #5: name match modulo legal suffix alone is NOT enough to collapse', () => {
  const ownership = {
    company: 'Focal',
    parent: {
      company: 'Foo',
      domain: 'foo-operating.com',
      parent: {
        company: 'Foo Ltd.',
        domain: 'foo-holdings.com',
        parent: null,
      },
    },
  };
  const { collapses } = normalizeChain(ownership);
  assert.equal(collapses.length, 0, 'distinct domains + just name match → no collapse');
});

test('Bug #5: synthesize surfaces a collapse note when normalization fires', () => {
  const ownership = {
    company: 'TikTok',
    domain: 'tiktok.com',
    siblings: [],
    parent: {
      company: 'ByteDance',
      domain: 'bytedance.com',
      ticker: null,
      headquarters: 'Beijing',
      founders: ['Zhang Yiming'],
      founding_date: '2012-03-01',
      parent: {
        company: 'ByteDance Ltd.',
        domain: 'bytedance.com',
        headquarters: 'Beijing',
        founders: ['Zhang Yiming'],
        founding_date: '2012-03-01',
        parent: null,
      },
    },
  };
  const out = synthesize(ownership, {}, null, {});
  const noteHit = out.positioning_analysis.strategic_notes.some((n) => /Chain normalized.*ByteDance Ltd\./.test(n));
  assert.ok(noteHit, 'collapse surfaces in strategic_notes');
});

// ─── Task #40: Chain normalization round 2 (Ashley / Disney / Activision) ──

test('Round 2: Ashley triple-layer collapses into one canonical layer regardless of which sub-affiliate carries the conglomerate revenue', () => {
  // Three consecutive "ashley" layers — the recurrence reported in T04*.
  const ownership = {
    company: 'Resident Home',
    domain: 'residenthome.com',
    parent: {
      company: 'Ashley Home',
      domain: 'ashleyhome.com',
      parent: {
        company: 'Ashley Global Retail',
        domain: 'ashleyglobalretail.com',
        parent: {
          company: 'Ashley Furniture Industries',
          domain: 'ashleyfurniture.com',
          parent: null,
        },
      },
    },
  };
  // Model put the conglomerate $11B on Ashley Home (the wrong sub-affiliate).
  const revenueByCompany = {
    'ashley home': {
      revenue_estimate: { low: 11e9, high: 11e9, central: 11e9 }, confidence: 'medium', signals_found: [],
    },
  };
  const out = synthesize(ownership, revenueByCompany, null, {});
  // Chain above Resident Home is now a single Ashley layer.
  assert.equal(out.ownership_tree.parent.company, 'Ashley Furniture Industries',
    'canonical name is the longest/most-formal Ashley layer');
  assert.equal(out.ownership_tree.parent.parent, null,
    'the three Ashley layers collapsed into one — no nested Ashley duplicates');
  // The $11B survives the collapse and lands on the canonical layer.
  assert.equal(out.ownership_tree.parent.revenue_estimate.central, 11e9);
  // The collapse is surfaced in plain-language notes.
  const noteHit = out.positioning_analysis.strategic_notes.some(
    (n) => /Chain normalized.*3 consecutive.*ashley.*Ashley Furniture Industries/.test(n)
  );
  assert.ok(noteHit, 'multi-layer collapse note is surfaced');
});

test('Round 2: an intermediate sub-affiliate carrying the conglomerate total is re-routed, not silently shown', () => {
  // Two intermediate layers, both with the conglomerate $88.9B. The 3+ rule
  // does NOT fire (only 2 layers share "disney"), so the post-attach guard
  // is what must clear the misattribution.
  const ownership = {
    company: 'Hulu',
    domain: 'hulu.com',
    parent: {
      company: 'Disney Streaming',
      domain: 'disneystreaming.com',
      parent: {
        company: 'The Walt Disney Company',
        domain: 'thewaltdisneycompany.com',
        ticker: 'DIS',
        parent: null,
      },
    },
  };
  const revenueByCompany = {
    'hulu': { revenue_estimate: { low: 8e9, high: 9e9, central: 8.5e9 }, confidence: 'high', signals_found: [] },
    'disney streaming': { revenue_estimate: { low: 88e9, high: 90e9, central: 88.9e9 }, confidence: 'medium', signals_found: [] },
    'the walt disney company': { revenue_estimate: { low: 88e9, high: 90e9, central: 88.9e9 }, confidence: 'high', signals_found: [] },
  };
  const out = synthesize(ownership, revenueByCompany, null, {});
  // Disney Streaming's misattributed conglomerate revenue is cleared and
  // re-routed to the root, where it legitimately belongs.
  const streaming = out.ownership_tree.parent;
  assert.equal(streaming.company, 'Disney Streaming', 'intermediate node identity preserved');
  assert.equal(streaming.revenue_estimate.central, 0, 'conglomerate total cleared from sub-affiliate');
  assert.ok(streaming.revenue_estimate_rerouted, 'original value preserved on the node for audit');
  assert.equal(streaming.revenue_rerouted_to, 'The Walt Disney Company');
  // The root still carries its total.
  assert.equal(out.ownership_tree.parent.parent.revenue_estimate.central, 88.9e9);
  // The re-route is explained in the notes.
  const noteHit = out.positioning_analysis.strategic_notes.some(
    (n) => /re-routed to "The Walt Disney Company"/.test(n) && /Disney Streaming/.test(n)
  );
  assert.ok(noteHit, 're-route is explained in strategic_notes');
  // Focal revenue is never touched by the guard.
  assert.equal(out.ownership_tree.revenue_estimate.central, 8.5e9);
});

test('Round 2: Activision Publishing vs Activision Blizzard with distinct revenues are KEPT separate (scoped revenue case)', () => {
  // Same holding token "activision" but different revenue scopes (publishing
  // label vs consolidated parent). Should NOT collapse, NOT re-route — the
  // existing "subsidiary cannot out-earn its owner" check handles the gap.
  const ownership = {
    company: 'Call of Duty',
    domain: 'callofduty.com',
    parent: {
      company: 'Activision Publishing',
      domain: 'activision.com',
      parent: {
        company: 'Activision Blizzard',
        domain: 'activisionblizzard.com',
        ticker: 'ATVI',
        parent: null,
      },
    },
  };
  const revenueByCompany = {
    'activision publishing': { revenue_estimate: { low: 9e9, high: 10e9, central: 10e9 }, confidence: 'low', signals_found: [] },
    'activision blizzard': { revenue_estimate: { low: 5e9, high: 6e9, central: 5.72e9 }, confidence: 'high', signals_found: [] },
  };
  const out = synthesize(ownership, revenueByCompany, null, {});
  // Both layers survive as their own chain entries.
  assert.equal(out.ownership_tree.parent.company, 'Activision Publishing');
  assert.equal(out.ownership_tree.parent.parent.company, 'Activision Blizzard');
  // Revenues kept as captured — guard only fires on matching figures.
  assert.equal(out.ownership_tree.parent.revenue_estimate.central, 10e9);
  assert.equal(out.ownership_tree.parent.parent.revenue_estimate.central, 5.72e9);
  // Existing child>parent consistency check still fires for the impossible pair.
  const consistencyHit = out.positioning_analysis.strategic_notes.some(
    (n) => /Revenue consistency.*Activision Publishing.*Activision Blizzard/.test(n)
  );
  assert.ok(consistencyHit, 'subsidiary-out-earns-owner check still flags the pair');
});

test('Round 2: the guard never clears the focal\'s own revenue even when an ancestor matches', () => {
  // Pathological case: focal "Patagonia" and parent "Patagonia Purpose Trust"
  // share the token AND a 100%-pass-through revenue. The focal must NOT be
  // cleared — that is what the user asked about.
  const tree = {
    company: 'Patagonia',
    revenue_estimate: { low: 1.6e9, high: 1.6e9, central: 1.6e9, confidence: 'high' },
    parent: {
      company: 'Patagonia Purpose Trust',
      revenue_estimate: { low: 1.6e9, high: 1.6e9, central: 1.6e9, confidence: 'low' },
      parent: null,
    },
  };
  const reroutes = guardConglomerateRevenueOnSubAffiliate(tree);
  assert.equal(reroutes.length, 0, 'no re-route — focal is never touched');
  assert.equal(tree.revenue_estimate.central, 1.6e9);
});

test('Round 2: the focal is NEVER collapsed even when it shares a holding token with its parent and root', () => {
  // Disney Cruise → Disney Entertainment → The Walt Disney Company. All three
  // share the "disney" token, but the user queried Disney Cruise — collapsing
  // the focal away would destroy the queried entity's identity.
  const ownership = {
    company: 'Disney Cruise',
    domain: 'disneycruise.disney.go.com',
    parent: {
      company: 'Disney Entertainment',
      domain: 'disneyentertainment.com',
      parent: {
        company: 'The Walt Disney Company',
        domain: 'thewaltdisneycompany.com',
        ticker: 'DIS',
        parent: null,
      },
    },
  };
  const out = synthesize(ownership, {}, null, {});
  assert.equal(out.ownership_tree.company, 'Disney Cruise', 'focal identity preserved');
  // The two parent-chain layers above the focal still share "disney" but
  // there are only 2 of them — Pass A needs 3+, so they remain separate
  // (and the existing 2-identifier rule doesn't fire either).
  assert.equal(out.ownership_tree.parent.company, 'Disney Entertainment');
  assert.equal(out.ownership_tree.parent.parent.company, 'The Walt Disney Company');
});

// ─── Task #42: bottom-up vs top-down divergence on sibling estimates ───────

test('Task #42: computeRevenueDivergence flags >30% disagreement between sub-estimates', () => {
  // The T04* Nectar case: $450M sibling (top-down 12% of Resident) vs $275M
  // bottom-up. 39% divergence → flag fires.
  const div = computeRevenueDivergence({
    bottom_up: { low: 250e6, high: 300e6, central: 275e6, confidence: 'medium', method: 'signals' },
    top_down:  { low: 400e6, high: 500e6, central: 450e6, confidence: 'low',    method: 'share_of_parent' },
  });
  assert.ok(div, 'divergence record produced when both sub-estimates present');
  assert.equal(div.divergence_pct, 39);
  assert.equal(div.divergence_flag, true);
  // Bottom-up has medium confidence → preferred as central.
  assert.equal(div.central, 275e6);
  assert.equal(div.method, 'bottom_up_preferred');
});

test('Task #42: divergence below 30% leaves flag false', () => {
  const div = computeRevenueDivergence({
    bottom_up: { central: 100e6, confidence: 'medium' },
    top_down:  { central: 120e6, confidence: 'low' },
  });
  assert.equal(div.divergence_pct, 17);
  assert.equal(div.divergence_flag, false);
});

test('Task #42: only one strategy present → no divergence record, no override', () => {
  assert.equal(computeRevenueDivergence({ bottom_up: { central: 100e6, confidence: 'medium' } }), null);
  assert.equal(computeRevenueDivergence({ top_down:  { central: 100e6, confidence: 'low'    } }), null);
  assert.equal(computeRevenueDivergence({}), null);
  assert.equal(computeRevenueDivergence(null), null);
});

test('Task #42: low-confidence bottom-up triggers blended central, not bottom-up override', () => {
  const div = computeRevenueDivergence({
    bottom_up: { central: 200e6, confidence: 'low' },
    top_down:  { central: 400e6, confidence: 'low' },
  });
  assert.equal(div.method, 'blended');
  assert.equal(div.central, 300e6);
  assert.equal(div.divergence_flag, true);
});

test('Task #42: T04*\' Awara/Nectar regression — Nectar as sibling exposes BU/TD divergence and warning', () => {
  // Awara is focal, Resident is parent, Nectar is a sibling. The upstream
  // revenue agent emitted BOTH a bottom-up signal-based estimate AND a top-
  // down share-of-parent estimate for Nectar. The synthesizer must (a) plumb
  // both sub-estimates onto the sibling, (b) raise divergence_flag because
  // they disagree by >30%, and (c) replace the legacy `central` with the
  // documented pick (bottom-up preferred when its confidence is medium+).
  const ownership = {
    company: 'Awara',
    domain: 'awarasleep.com',
    siblings: [
      { company: 'Nectar', domain: 'nectarsleep.com', in_current_sources: true, category: 'memory foam mattress' },
    ],
    parent: {
      company: 'Resident Home',
      domain: 'residenthome.com',
      parent: null,
    },
  };
  const revenueByCompany = {
    'awara': {
      revenue_estimate: { low: 40e6, high: 60e6, central: 50e6 },
      confidence: 'medium',
      signals_found: [],
      reasoning_summary: 'Triangulated from traffic + pricing.',
    },
    'nectar': {
      // Legacy single central from the model; gets overridden by the divergence pick.
      revenue_estimate: { low: 270e6, high: 460e6, central: 365e6 },
      confidence: 'low',
      signals_found: [],
      reasoning_summary: 'Bottom-up traffic + AOV vs top-down 12% of Resident parent total.',
      bottom_up: {
        low: 250e6, high: 300e6, central: 275e6, confidence: 'medium',
        method: 'signals',
        source_summary: 'Bottom-up: SimilarWeb visits × 1.8% conv × $1,100 AOV.',
      },
      top_down: {
        low: 400e6, high: 500e6, central: 450e6, confidence: 'low',
        method: 'share_of_parent',
        source_summary: 'Top-down: 12% of Resident Home consolidated ($3.75B).',
      },
    },
  };
  const out = synthesize(ownership, revenueByCompany, null, {});
  const nectar = out.ownership_tree.siblings.find((s) => s.company === 'Nectar');
  assert.ok(nectar, 'Nectar survives synthesis as a sibling');
  const r = nectar.revenue_estimate;
  // Both sub-estimates plumbed through.
  assert.ok(r.bottom_up && r.top_down, 'bottom_up and top_down sub-estimates exposed on the sibling');
  assert.equal(r.bottom_up.central, 275e6);
  assert.equal(r.top_down.central, 450e6);
  // Divergence math and flag.
  assert.equal(r.divergence_pct, 39);
  assert.equal(r.divergence_flag, true);
  // Central picked per documented rule (bottom-up confidence is medium → preferred).
  assert.equal(r.central, 275e6, 'central overridden to bottom-up pick, not the legacy 365M');
  assert.equal(r.method, 'bottom_up_preferred');
  // Legacy low/high range from the agent is preserved as the outer range.
  assert.equal(r.low, 270e6);
  assert.equal(r.high, 460e6);
});

test('Task #42: a sibling with only the legacy single estimate is unchanged (backward compatible)', () => {
  // Most siblings today carry just one estimate; the new fields must not appear
  // and central must equal what the agent emitted.
  const out = synthesize(t04.ownership, t04.revenueByCompany, t04.parentAnchor);
  const legacySibling = out.ownership_tree.siblings.find(
    (s) => s.revenue_estimate && s.revenue_estimate.central > 0
  );
  assert.ok(legacySibling, 'at least one legacy sibling with a single estimate');
  assert.equal(legacySibling.revenue_estimate.bottom_up, undefined);
  assert.equal(legacySibling.revenue_estimate.top_down, undefined);
  assert.equal(legacySibling.revenue_estimate.divergence_flag, undefined);
});

// ─── Task #41: segment-panel percentages use parent total as denominator ───

test('Task #41: reconciliation surfaces parent_total_revenue so segment % rows can use it as the denominator', () => {
  // LVMH-style: Fashion & Leather Goods is ~$42B of LVMH's ~$86B total. The
  // OLD UI divided 42 / 11 (focal-segment denominator) → ~386%. The fix uses
  // total_revenue_usd (~$86B) → ~49%.
  const ownership = {
    company: 'Tiffany & Co.',
    domain: 'tiffany.com',
    parent: {
      company: 'LVMH',
      domain: 'lvmh.com',
      ticker: 'MC.PA',
      parent: null,
    },
  };
  const parentAnchor = {
    is_public: true,
    fiscal_year: '2023',
    total_revenue_usd: 86_153_000_000,
    segments: [
      { name: 'Fashion & Leather Goods', revenue_usd: 42_169_000_000, contains_focal: false },
      { name: 'Wines & Spirits', revenue_usd: 6_602_000_000, contains_focal: false },
      { name: 'Perfumes & Cosmetics', revenue_usd: 8_271_000_000, contains_focal: false },
      { name: 'Watches & Jewelry', revenue_usd: 10_902_000_000, contains_focal: true },
      { name: 'Selective Retailing', revenue_usd: 17_885_000_000, contains_focal: false },
      { name: 'Other', revenue_usd: 324_000_000, contains_focal: false },
    ],
  };
  const revenueByCompany = {
    'tiffany & co.': { revenue_estimate: { low: 4e9, high: 5e9, central: 4.5e9 }, confidence: 'medium', signals_found: [] },
  };
  const out = synthesize(ownership, revenueByCompany, parentAnchor, {});

  // The total flows through to reconciliation so the UI can use it as denominator.
  const recon = out.positioning_analysis.reconciliation;
  // Reconciliation may or may not fire depending on sibling coverage; the
  // anchor itself is always surfaced on the parent node and on the tree.
  const surfacedTotal = recon?.parent_total_revenue
    || out.ownership_tree.parent?.parent_anchor?.total_revenue_usd
    || out.ownership_tree.parent_anchor?.total_revenue_usd;
  assert.equal(surfacedTotal, 86_153_000_000, 'parent consolidated total is exposed to the UI');

  // Sanity check the math the UI now performs.
  const fashionPct = (42_169_000_000 / surfacedTotal) * 100;
  assert.ok(fashionPct > 48 && fashionPct < 50,
    `Fashion & Leather Goods ≈ 49% of parent total (got ${fashionPct.toFixed(1)}%); old focal-segment denominator produced ~386%`);

  // All named segment shares sum to ≈ 100% (allowing for "Other").
  const sumPct = parentAnchor.segments.reduce(
    (a, s) => a + ((s.revenue_usd || 0) / surfacedTotal) * 100, 0,
  );
  assert.ok(sumPct >= 99 && sumPct <= 101, `segment shares sum to ≈100% (got ${sumPct.toFixed(1)}%)`);
});

// ─── Bug #3 follow-up: cousins get revenue with parent context ──────────────

test('Cousins: collectEntities includes intra_parent_cousins with role and parent context', () => {
  const ownership = {
    company: 'Tiffany & Co.',
    domain: 'tiffany.com',
    siblings: [{ company: 'Bulgari', domain: 'bulgari.com', in_current_sources: true }],
    intra_parent_cousins: [
      { company: 'Louis Vuitton', domain: 'louisvuitton.com', via_division: 'Fashion & Leather Goods', in_current_sources: true },
      { company: 'Dior', domain: 'dior.com', via_division: 'Fashion & Leather Goods', in_current_sources: true },
    ],
    parent: { company: 'LVMH', domain: 'lvmh.com', parent: null },
  };
  const ents = collectEntities(ownership);
  const lv = ents.find((e) => e.company === 'Louis Vuitton');
  assert.ok(lv, 'cousin is collected for revenue');
  assert.equal(lv.role, 'cousin');
  assert.equal(lv.parent_company, 'LVMH', 'cousin carries parent context for disambiguation');
  assert.equal(lv.via_division, 'Fashion & Leather Goods');
});

test('Cousins: cap respects in_current_sources prioritization', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({
    company: `LegacyBrand${i}`,
    in_current_sources: false,
    in_historical_sources: true,
    via_division: 'Other',
  }));
  many.push({ company: 'LiveBrand', in_current_sources: true, via_division: 'Other' });
  const ownership = {
    company: 'Focal', siblings: [],
    intra_parent_cousins: many,
    parent: { company: 'Parent', parent: null },
  };
  const ents = collectEntities(ownership);
  const cousins = ents.filter((e) => e.role === 'cousin');
  assert.ok(cousins.length <= 6, 'cousins are capped to keep cost predictable');
  assert.ok(cousins.some((c) => c.company === 'LiveBrand'), 'current-source brand survives the cap');
});

test('Cousins: synthesize attaches revenue estimate to cousin nodes', () => {
  const ownership = {
    company: 'Tiffany & Co.',
    siblings: [],
    intra_parent_cousins: [
      { company: 'Louis Vuitton', via_division: 'Fashion & Leather Goods', in_current_sources: true },
    ],
    parent: { company: 'LVMH', parent: null },
  };
  const revenueByCompany = {
    'louis vuitton': {
      revenue_estimate: { low: 20e9, high: 25e9, central: 22e9 },
      confidence: 'high',
      signals_found: [{ type: 'press', label: 'LVMH 10-K', value: '$22B', source: 'lvmh.com', weight: 'high' }],
      reasoning_summary: 'From LVMH Fashion & Leather Goods segment.',
    },
  };
  const out = synthesize(ownership, revenueByCompany, null, {});
  const lv = out.ownership_tree.intra_parent_cousins.find((c) => c.company === 'Louis Vuitton');
  assert.ok(lv, 'cousin survives in synthesized tree');
  assert.equal(lv.revenue_estimate.central, 22e9, 'cousin revenue is attached');
  assert.equal(lv.revenue_estimate.confidence, 'high');
  assert.equal(lv.via_division, 'Fashion & Leather Goods', 'via_division preserved for UI');
});

// ─── Bug #2: co_owners (multi-owner / steward / JV) ─────────────────────────

const patagoniaOwnership = {
  company: 'Patagonia', domain: 'patagonia.com', node_type: 'legal_entity',
  layer: 'brand', in_current_sources: true,
  ownership_role: 'voting_control',
  parent: {
    company: 'Patagonia Purpose Trust', domain: null, node_type: 'legal_entity',
    layer: 'parent', in_current_sources: true, parent: null, siblings: [], children: [],
    strategic_control: [], sources: [],
  },
  co_owners: [
    {
      company: 'Holdfast Collective',
      ownership_role: 'economic_beneficiary',
      stake_pct: 98, voting_pct: 0,
      evidence: 'Chouinard family transferred 98% non-voting shares to Holdfast Collective (2022).',
      entity_type: 'nonprofit',
      source_urls: ['https://www.patagonia.com/ownership/'],
    },
  ],
  siblings: [], children: [], strategic_control: [], sources: [],
};

test('Bug #2: collectEntities includes co_owners with role + stake context', () => {
  const ents = collectEntities(patagoniaOwnership);
  const holdfast = ents.find((e) => e.company === 'Holdfast Collective');
  assert.ok(holdfast, 'Holdfast Collective is collected for revenue enrichment');
  assert.equal(holdfast.role, 'co_owner');
  assert.equal(holdfast.ownership_role, 'economic_beneficiary');
  assert.equal(holdfast.stake_pct, 98);
  assert.equal(holdfast.entity_type, 'nonprofit');
});

test('Bug #2: synthesize attaches revenue to co_owners and folds them into the owner-group ratio', () => {
  const revenueByCompany = {
    'patagonia': {
      revenue_estimate: { low: 1.5e9, high: 1.8e9, central: 1.6e9 },
      confidence: 'high', signals_found: [], reasoning_summary: '',
    },
    'patagonia purpose trust': {
      revenue_estimate: { low: 1.6e9, high: 1.6e9, central: 1.6e9 },
      confidence: 'low', signals_found: [], reasoning_summary: '',
    },
    'holdfast collective': {
      revenue_estimate: { low: 0, high: 0, central: 0 },
      confidence: 'low', signals_found: [],
      reason_for_null: 'Nonprofit beneficiary; no operating revenue.',
    },
  };
  const out = synthesize(patagoniaOwnership, revenueByCompany, null, {});
  const co = out.ownership_tree.co_owners[0];
  assert.ok(co.revenue_estimate, 'co_owner has revenue_estimate attached');
  assert.equal(co.revenue_estimate.central, 0, 'beneficiary central revenue is zero');
  // Ratio uses combined owner group (parent + co_owners); should not exceed 100%.
  const ratioStr = out.positioning_analysis.focal_vs_parent_ratio;
  assert.match(ratioStr, /co-owner/, 'ratio label mentions co-owner group');
  const pct = parseFloat(ratioStr.match(/([\d.]+)%/)[1]);
  assert.ok(pct <= 100, `focal/(parent+co_owners) ratio must not exceed 100% (got ${pct}%)`);
  const multiNote = out.positioning_analysis.strategic_notes.find((n) => /Multi-owner structure/.test(n));
  assert.ok(multiNote, 'multi-owner note is surfaced');
  assert.match(multiNote, /Holdfast Collective/);
});

test('Bug #2: ownership without co_owners is unchanged (backward compatible)', () => {
  const ents = collectEntities(t04.ownership);
  assert.equal(ents.filter((e) => e.role === 'co_owner').length, 0);
  const out = synthesize(t04.ownership, t04.revenueByCompany, t04.parentAnchor);
  // Legacy ratio format ("X% of <parent> revenue") preserved when no co_owners.
  assert.match(out.positioning_analysis.focal_vs_parent_ratio, /of .+ revenue|standalone|unknown/);
});

// ─── Issue #7: auto-correct removed — raw estimates preserved, honest gap ─────

test('Issue #7: a >5% anchor gap no longer rescales estimates (raw preserved)', () => {
  // GEICO-style: sum of focal + sibling ($67B) is far below the public parent's
  // 10-K total ($364.67B). The old auto-correct scaled them up 5.4× (inflating
  // National Indemnity past its whole segment). Now the raw values must survive.
  const ownership = {
    company: 'GEICO', domain: 'geico.com', node_type: 'operating_brand', siblings: [
      { company: 'National Indemnity Company', domain: 'nationalindemnity.com', in_current_sources: true },
    ],
    parent: { company: 'Berkshire Hathaway', domain: 'berkshirehathaway.com', node_type: 'legal_entity', parent: null },
  };
  const revenueByCompany = {
    'geico': { revenue_estimate: { low: 40e9, high: 44e9, central: 42e9 }, confidence: 'high', signals_found: [], reasoning_summary: 'Triangulated from $42.9B premiums written.' },
    'national indemnity company': { revenue_estimate: { low: 20e9, high: 30e9, central: 25e9 }, confidence: 'medium', signals_found: [], reasoning_summary: '' },
  };
  const parentAnchor = { is_public: true, total_revenue_usd: 364_670_000_000, fiscal_year: 2023, segments: [] };
  const out = synthesize(ownership, revenueByCompany, parentAnchor, {});
  const focal = out.ownership_tree;
  const sib = focal.siblings.find((s) => s.company === 'National Indemnity Company');

  assert.equal(focal.revenue_estimate.central, 42e9, 'focal central stays RAW (not scaled up)');
  assert.equal(sib.revenue_estimate.central, 25e9, 'sibling central stays RAW (not inflated)');
  assert.equal(focal.revenue_estimate.anchor_adjusted, undefined, 'no anchor_adjusted flag');
  assert.equal(focal.revenue_estimate_raw, undefined, 'no scaling shadow value created');

  const notes = out.positioning_analysis.strategic_notes.join(' | ');
  assert.doesNotMatch(notes, /auto-?corrected/i, 'no "Auto-corrected … scaled by ×" note');

  // The honest coverage gap is still surfaced with a deterministic explanation.
  const recon = out.positioning_analysis.reconciliation;
  assert.ok(recon, 'reconciliation still fires');
  assert.equal(recon.anchor_adjustment, undefined, 'reconciliation carries no anchor_adjustment block');
  assert.ok(recon.ratio < 0.5, `honest coverage ratio preserved (got ${recon.ratio})`);
  assert.ok(recon.explanation && recon.explanation.likely_causes.length >= 1, 'gap explanation attached');
});

// ─── Issue #5: a child cannot out-earn its parent → requires_review ──────────

test('Issue #5: child revenue exceeding parent is flagged, not silently shown', () => {
  // Activision Publishing ($10B, post-acquisition scope) > Activision Blizzard
  // ($5.72B, last standalone FY) — logically impossible for a subsidiary.
  const ownership = {
    company: 'Call of Duty', domain: 'callofduty.com', node_type: 'operating_brand',
    parent: {
      company: 'Activision Publishing', domain: 'activision.com', node_type: 'legal_entity',
      parent: {
        company: 'Activision Blizzard', domain: 'activisionblizzard.com', node_type: 'legal_entity',
        parent: { company: 'Microsoft', domain: 'microsoft.com', node_type: 'legal_entity', parent: null },
      },
    },
  };
  const revenueByCompany = {
    'call of duty': { revenue_estimate: { low: 5e9, high: 6e9, central: 5.5e9 }, confidence: 'high', signals_found: [], reasoning_summary: '' },
    'activision publishing': { revenue_estimate: { low: 9e9, high: 11e9, central: 10e9 }, confidence: 'medium', signals_found: [], reasoning_summary: '' },
    'activision blizzard': { revenue_estimate: { low: 5e9, high: 6e9, central: 5.72e9 }, confidence: 'high', signals_found: [], reasoning_summary: '' },
    'microsoft': { revenue_estimate: { low: 240e9, high: 250e9, central: 245e9 }, confidence: 'high', signals_found: [], reasoning_summary: '' },
  };
  const out = synthesize(ownership, revenueByCompany, null, {});
  const publishing = out.ownership_tree.parent;
  assert.equal(publishing.company, 'Activision Publishing');
  assert.equal(publishing.requires_review, true, 'outlier flagged for review');
  assert.match(publishing.revenue_review_reason, /exceeds owner Activision Blizzard/);
  assert.notEqual(out.ownership_tree.requires_review, true, 'a normal child (CoD < Publishing) is not flagged');
  const notes = out.positioning_analysis.strategic_notes.join(' | ');
  assert.match(notes, /Revenue consistency/);
  assert.match(notes, /Activision Publishing/);
});

// ─── Issue #3: the root is always collected for an independent estimate ──────

test('Issue #3: a deep root (Microsoft) is collected and gets a revenue estimate', () => {
  const ownership = {
    company: 'Call of Duty', domain: 'callofduty.com',
    parent: {
      company: 'Activision Publishing', domain: 'activision.com',
      parent: {
        company: 'Activision Blizzard', domain: 'activisionblizzard.com',
        parent: { company: 'Microsoft', domain: 'microsoft.com', node_type: 'legal_entity', parent: null },
      },
    },
  };
  const ents = collectEntities(ownership);
  const ms = ents.find((e) => e.company === 'Microsoft');
  assert.ok(ms, 'root (beyond the depth-2 walk) is still collected');
  assert.equal(ms.role, 'root');

  const revenueByCompany = {
    'microsoft': { revenue_estimate: { low: 240e9, high: 250e9, central: 245e9 }, confidence: 'high', signals_found: [], reasoning_summary: '' },
  };
  const out = synthesize(ownership, revenueByCompany, null, {});
  const root = out.ownership_tree.parent.parent.parent;
  assert.equal(root.company, 'Microsoft');
  assert.equal(root.revenue_estimate.central, 245e9, 'root revenue is attached (not null)');
});

test('Issue #3: an individual/UBO root is NOT sent for a revenue lookup', () => {
  const ownership = {
    company: 'Ashley Furniture', domain: 'ashleyfurniture.com',
    parent: { company: 'Wanek Family', node_type: 'individual', parent: null },
  };
  const ents = collectEntities(ownership);
  assert.equal(ents.find((e) => e.company === 'Wanek Family'), undefined, 'natural-person/family root is skipped');
});
