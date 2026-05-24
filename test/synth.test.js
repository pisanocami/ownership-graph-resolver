import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  synthesize, collectEntities, deriveStatus, deriveRevenueStatus,
  normalizeChain, deriveDivestiture, isCircularEstimate, collectControlLayers,
  guardConglomerateRevenueOnSubAffiliate, computeRevenueDivergence,
  needsSiblingBackfill, mergeSiblings, mergeCousins,
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

// ─── Task #43: prior JV history surfaced in notes for consolidated subsidiaries ──

test('Task #43: Hulu prior JV (Disney 67% / Comcast 33%, 2023 consolidation) surfaces in strategic_notes', () => {
  const ownership = {
    company: 'Hulu',
    domain: 'hulu.com',
    node_type: 'operating_brand',
    notes: 'Prior joint venture: Disney 67% / Comcast (NBCUniversal) 33% — consolidated by Disney in 2023 via $8.61B buyout of NBCUniversal\'s stake.',
    acquisition: {
      acquired_by: 'The Walt Disney Company',
      year: 2023,
      price_usd: 8_610_000_000,
      price_display: '$8.61B',
      deal_type: 'all_cash',
      source_url: 'https://thewaltdisneycompany.com/...',
    },
    parent: {
      company: 'The Walt Disney Company',
      domain: 'thewaltdisneycompany.com',
      ticker: 'DIS',
      parent: null,
    },
  };
  const out = synthesize(ownership, {}, null, {});
  // Raw model notes preserved on the focal node (tree → UI/JSON/PDF flow).
  assert.match(out.ownership_tree.notes, /Disney 67%.*Comcast.*33%/);
  // Promoted into strategic_notes so users see the prior configuration.
  const hit = out.positioning_analysis.strategic_notes.some(
    (n) => /Prior JV history \(Hulu\)/.test(n) && /Disney 67%.*Comcast.*33%/.test(n) && /2023/.test(n)
  );
  assert.ok(hit, 'JV-history note promoted to strategic_notes');
  // acquisition.price_usd remains the FINAL consolidating deal only — not a
  // historical aggregate of every Hulu transaction back to 2009.
  assert.equal(out.ownership_tree.acquisition.price_usd, 8_610_000_000);
  assert.equal(out.ownership_tree.acquisition.year, 2023);
});

test('Task #43: a parent-layer JV-history note is also promoted (e.g. SonyBMG era on the parent)', () => {
  const ownership = {
    company: 'Some Sony Music Label',
    parent: {
      company: 'Sony Music Entertainment',
      notes: 'Prior joint venture: Sony 50% / Bertelsmann 50% (SonyBMG) — consolidated by Sony in 2008 buyout of Bertelsmann\'s stake.',
      parent: null,
    },
  };
  const out = synthesize(ownership, {}, null, {});
  const hit = out.positioning_analysis.strategic_notes.some(
    (n) => /Prior JV history \(Sony Music Entertainment\)/.test(n) && /Bertelsmann/.test(n)
  );
  assert.ok(hit, 'parent-layer JV history surfaces too');
});

test('Task #43: regex does not match incidental "jv" substrings or unrelated acquisition mentions', () => {
  const ownership = {
    company: 'Acme',
    notes: 'Acme acquired SomeCo in 2022 — no JVs ever existed in this lineage.',
    parent: { company: 'Acme Holdings', parent: null },
  };
  const out = synthesize(ownership, {}, null, {});
  const hit = out.positioning_analysis.strategic_notes.some((n) => /Prior JV history/.test(n));
  assert.equal(hit, false, 'lone "JVs" mention without consolidation pairing must not promote');
});

test('Task #43: nodes without JV-history notes do NOT trigger the surface', () => {
  // T16 regression guard — Patagonia's co_owners flow must remain unaffected
  // by the JV-history surface (the notes there describe a current steward-
  // ownership transition, not a prior JV consolidation).
  const ownership = {
    company: 'Patagonia',
    notes: 'Holdfast Collective captured as economic_beneficiary co-owner; Purpose Trust kept as parent because it holds 100% voting power.',
    parent: { company: 'Patagonia Purpose Trust', parent: null },
  };
  const out = synthesize(ownership, {}, null, {});
  const hit = out.positioning_analysis.strategic_notes.some((n) => /Prior JV history/.test(n));
  assert.equal(hit, false, 'co-owner transition note must not be misread as JV history');
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

// ════════════════════════════════════════════════════════════════════════════
// Sprint 3 fixes
// ════════════════════════════════════════════════════════════════════════════

// ─── Issue #12: sub-product line mis-reported as the segment anchor ───────────

test('Issue #12: LinkedIn — a segment smaller than its siblings is distrusted, falls back to parent total', () => {
  // The parent-anchor agent mis-reported "LinkedIn $17.81B" as the focal segment
  // while Office/Dynamics sit at the Productivity & Business Processes level. The
  // pre-fix benchmark of sum($84.81B) vs $17.81B produced a 477% nonsense ratio.
  const ownership = {
    company: 'LinkedIn', domain: 'linkedin.com', node_type: 'operating_brand',
    focal_segment: 'Productivity and Business Processes',
    siblings: [
      { company: 'Microsoft Office', domain: 'office.com', in_current_sources: true },
      { company: 'Microsoft Dynamics', domain: 'dynamics.microsoft.com', in_current_sources: true },
    ],
    parent: { company: 'Microsoft', domain: 'microsoft.com', node_type: 'legal_entity', parent: null },
  };
  const revenueByCompany = {
    'linkedin': { revenue_estimate: { low: 16e9, high: 19e9, central: 17.81e9 }, confidence: 'high', signals_found: [], reasoning_summary: '' },
    'microsoft office': { revenue_estimate: { low: 55e9, high: 65e9, central: 60e9 }, confidence: 'medium', signals_found: [], reasoning_summary: '' },
    'microsoft dynamics': { revenue_estimate: { low: 6e9, high: 8e9, central: 7e9 }, confidence: 'medium', signals_found: [], reasoning_summary: '' },
  };
  const parentAnchor = {
    is_public: true, fiscal_year: 2025, total_revenue_usd: 281_700_000_000,
    segments: [{ name: 'LinkedIn', revenue_usd: 17_810_000_000, contains_focal: true }],
  };
  const out = synthesize(ownership, revenueByCompany, parentAnchor, {});
  const recon = out.positioning_analysis.reconciliation;
  assert.ok(recon, 'reconciliation fires');
  assert.equal(recon.parent_benchmark_source, '10-K', 'falls back to parent total, not the sub-line segment');
  assert.equal(recon.parent_benchmark, 281_700_000_000, 'benchmark is the consolidated total');
  assert.ok(recon.ratio < 1, `ratio is sane against the parent total (got ${recon.ratio}, must be < 1)`);
  const notes = out.positioning_analysis.strategic_notes.join(' | ');
  assert.match(notes, /sub-product line/i, 'guardrail note explains the mislabeled segment');
});

test('Issue #12: YouTube — "YouTube ads" sub-line distrusted vs Alphabet consolidated total', () => {
  const ownership = {
    company: 'YouTube', domain: 'youtube.com', node_type: 'operating_brand',
    focal_segment: 'Google Services',
    siblings: [
      { company: 'Google Search', in_current_sources: true },
      { company: 'Google Play', in_current_sources: true },
    ],
    parent: { company: 'Google LLC', domain: 'google.com', node_type: 'legal_entity', parent: null },
  };
  const revenueByCompany = {
    'youtube': { revenue_estimate: { low: 30e9, high: 33e9, central: 31.51e9 }, confidence: 'high', signals_found: [], reasoning_summary: '' },
    'google search': { revenue_estimate: { low: 170e9, high: 180e9, central: 175e9 }, confidence: 'medium', signals_found: [], reasoning_summary: '' },
    'google play': { revenue_estimate: { low: 45e9, high: 55e9, central: 50e9 }, confidence: 'medium', signals_found: [], reasoning_summary: '' },
  };
  const parentAnchor = {
    is_public: true, fiscal_year: 2023, total_revenue_usd: 307_390_000_000,
    segments: [{ name: 'YouTube ads', revenue_usd: 31_510_000_000, contains_focal: true }],
  };
  const out = synthesize(ownership, revenueByCompany, parentAnchor, {});
  const recon = out.positioning_analysis.reconciliation;
  assert.equal(recon.parent_benchmark_source, '10-K', 'distrusts the tiny YouTube-ads sub-line');
  assert.ok(recon.ratio < 1.2, `sane ratio vs the parent total (got ${recon.ratio})`);
});

// ─── Issue #7-bis: overshoot vs a REAL segment is surfaced, never rescaled ────

test('Issue #7-bis: an overshoot vs a real segment anchor is flagged, not auto-corrected', () => {
  // Siblings legitimately exceed the focal's segment (~+60%). Surface a warning,
  // but the raw centrals must survive — no "Auto-corrected … ×" scaling.
  const ownership = {
    company: 'Brand A', node_type: 'operating_brand', focal_segment: 'Segment X',
    siblings: [{ company: 'Brand B', in_current_sources: true }],
    parent: { company: 'BigCo', node_type: 'legal_entity', parent: null },
  };
  const revenueByCompany = {
    'brand a': { revenue_estimate: { low: 9e9, high: 11e9, central: 10e9 }, confidence: 'high', signals_found: [], reasoning_summary: '' },
    'brand b': { revenue_estimate: { low: 5e9, high: 7e9, central: 6e9 }, confidence: 'high', signals_found: [], reasoning_summary: '' },
  };
  // Real segment $10B; sum $16B → ratio 1.6 overshoot, but sum < 2× segment so the segment stays trusted.
  const parentAnchor = { is_public: true, fiscal_year: 2024, total_revenue_usd: 50e9, segments: [{ name: 'Segment X', revenue_usd: 10e9, contains_focal: true }] };
  const out = synthesize(ownership, revenueByCompany, parentAnchor, {});
  const focal = out.ownership_tree;
  assert.equal(focal.revenue_estimate.central, 10e9, 'focal raw preserved');
  assert.equal(focal.siblings[0].revenue_estimate.central, 6e9, 'sibling raw preserved');
  const notes = out.positioning_analysis.strategic_notes.join(' | ');
  assert.doesNotMatch(notes, /auto-?corrected|scaled (up|down|by)/i, 'no scaling note');
  const recon = out.positioning_analysis.reconciliation;
  assert.equal(recon.parent_benchmark_source, 'segment', 'real segment trusted (sum < 2× segment)');
  assert.ok(recon.ratio > 1.5, `overshoot ratio preserved (got ${recon.ratio})`);
});

// ─── Issue #9-bis: panel denominator data (parent total ≠ focal segment) ──────

test('Issue #9-bis: reconciliation exposes parent_total distinct from the focal segment', () => {
  const ownership = {
    company: 'Tiffany', node_type: 'operating_brand', focal_segment: 'Watches & Jewelry',
    siblings: [{ company: 'Bulgari', in_current_sources: true }],
    parent: { company: 'LVMH', node_type: 'legal_entity', parent: null },
  };
  const revenueByCompany = {
    'tiffany': { revenue_estimate: { low: 4e9, high: 5e9, central: 4.5e9 }, confidence: 'high', signals_found: [], reasoning_summary: '' },
    'bulgari': { revenue_estimate: { low: 3e9, high: 4e9, central: 3.5e9 }, confidence: 'medium', signals_found: [], reasoning_summary: '' },
  };
  const parentAnchor = { is_public: true, fiscal_year: 2024, total_revenue_usd: 84_680_000_000, segments: [{ name: 'Watches & Jewelry', revenue_usd: 11_810_000_000, contains_focal: true }] };
  const out = synthesize(ownership, revenueByCompany, parentAnchor, {});
  const recon = out.positioning_analysis.reconciliation;
  assert.equal(recon.parent_total_revenue, 84_680_000_000, 'parent consolidated total preserved (panel denominator)');
  assert.equal(recon.focal_segment_revenue, 11_810_000_000, 'focal segment revenue preserved');
  assert.notEqual(recon.parent_total_revenue, recon.focal_segment_revenue, 'panel denominator is the parent total, not the focal segment');
});

// ─── Issue #2-bis: broadened co_owners activation ─────────────────────────────

test('Issue #2-bis: concentrated strategic blocs surface as co_owners with stakes (Aston Martin)', () => {
  const ownership = {
    company: 'Aston Martin Lagonda', domain: 'astonmartin.com', node_type: 'legal_entity',
    ownership_role: 'controlling_holder',
    co_owners: [
      { company: 'Public Investment Fund', ownership_role: 'strategic_investor', stake_pct: 20.5, entity_type: 'government', evidence: 'PIF ~20.5% per 2024 disclosures.', source_urls: [] },
      { company: 'Geely', ownership_role: 'strategic_investor', stake_pct: 17, entity_type: 'corporation', evidence: 'Geely ~17%.', source_urls: [] },
      { company: 'Mercedes-Benz', ownership_role: 'strategic_partner', stake_pct: 20, entity_type: 'corporation', evidence: 'Mercedes ~20% (technology partnership).', source_urls: [] },
    ],
    parent: { company: 'Yew Tree Consortium', node_type: 'legal_entity', ownership_role: 'controlling_holder', parent: null },
  };
  const revenueByCompany = {
    'aston martin lagonda': { revenue_estimate: { low: 1.5e9, high: 2e9, central: 1.8e9 }, confidence: 'high', signals_found: [], reasoning_summary: '' },
  };
  const coEnts = collectEntities(ownership).filter((e) => e.role === 'co_owner');
  assert.equal(coEnts.length, 3, 'all 3 strategic blocs collected as co_owners (cap raised to 5)');
  const out = synthesize(ownership, revenueByCompany, null, {});
  const note = out.positioning_analysis.strategic_notes.find((n) => /Multi-owner structure/.test(n));
  assert.ok(note, 'multi-owner note present');
  assert.match(note, /Public Investment Fund/);
  assert.match(note, /Geely/);
  assert.match(note, /Mercedes-Benz/);
  assert.match(note, /20\.5% econ/, 'equity stake surfaced');
});

test('Issue #2-bis: individual super-voting holders surface as co_owners with voting_pct (Page+Brin)', () => {
  const ownership = {
    company: 'Alphabet', domain: 'abc.xyz', node_type: 'legal_entity', ownership_role: 'voting_control',
    co_owners: [
      { company: 'Sergey Brin', ownership_role: 'super_voting_holder', voting_pct: 25.3, entity_type: 'individual', evidence: 'Class B ~25.3% voting.', source_urls: [] },
    ],
    parent: { company: 'Larry Page', node_type: 'individual', ubo_type: 'individual', stake: { voting_pct: 27.4 }, parent: null },
  };
  const revenueByCompany = { 'alphabet': { revenue_estimate: { low: 300e9, high: 310e9, central: 307e9 }, confidence: 'high', signals_found: [], reasoning_summary: '' } };
  const out = synthesize(ownership, revenueByCompany, null, {});
  const note = out.positioning_analysis.strategic_notes.find((n) => /Multi-owner structure/.test(n));
  assert.ok(note, 'multi-owner note present');
  assert.match(note, /Sergey Brin/);
  assert.match(note, /25\.3% vote/, 'voting stake surfaced');
});

// ─── Issue #10: "not computed" siblings render as "—", not $0 ─────────────────

test('Issue #10: siblings without an estimate render as "—", never $0, and are not ranked as zero', () => {
  const ownership = {
    company: 'Bud Light', domain: 'budlight.com', node_type: 'operating_brand',
    siblings: [
      { company: 'Budweiser', in_current_sources: true },
      { company: 'Michelob Ultra', in_current_sources: true },
      { company: 'Natural Light', in_current_sources: true },
    ],
    parent: { company: 'Anheuser-Busch InBev', node_type: 'legal_entity', parent: null },
  };
  const revenueByCompany = {
    'bud light': { revenue_estimate: { low: 5e9, high: 7e9, central: 6e9 }, confidence: 'high', signals_found: [], reasoning_summary: '' },
  };
  const out = synthesize(ownership, revenueByCompany, null, {});
  const vs = out.positioning_analysis.focal_vs_siblings;
  assert.match(vs, /—/, 'uncomputed siblings show an em-dash');
  assert.doesNotMatch(vs, /\$0\b/, 'no sibling shows $0');
  assert.match(vs, /3 not computed/, 'uncomputed count surfaced');
  assert.match(vs, /★ Bud Light \$6\.00B/, 'focal ranked first with its real revenue');
});

// ─── Issue #4-bis: distribution-channel brands carry no standalone revenue ────

test('Issue #4-bis: a distribution channel (Chrome) is skipped for revenue and never shown standalone', () => {
  const ownership = {
    company: 'YouTube', domain: 'youtube.com', node_type: 'operating_brand', focal_segment: 'Google Services',
    siblings: [
      { company: 'Google Chrome', domain: 'google.com/chrome', revenue_model: 'distribution_channel', in_current_sources: true },
      { company: 'Google Pixel', domain: 'store.google.com', revenue_model: 'direct_revenue', in_current_sources: true },
    ],
    parent: { company: 'Google LLC', node_type: 'legal_entity', parent: null },
  };
  // A stray $120B Chrome figure exists upstream — it must be refused outright.
  const revenueByCompany = {
    'youtube': { revenue_estimate: { low: 30e9, high: 33e9, central: 31.5e9 }, confidence: 'high', signals_found: [], reasoning_summary: '' },
    'google chrome': { revenue_estimate: { low: 110e9, high: 130e9, central: 120e9 }, confidence: 'low', signals_found: [], reasoning_summary: '' },
    'google pixel': { revenue_estimate: { low: 5e9, high: 6e9, central: 5.5e9 }, confidence: 'medium', signals_found: [], reasoning_summary: '' },
  };
  const ents = collectEntities(ownership);
  assert.equal(ents.find((e) => e.company === 'Google Chrome'), undefined, 'Chrome is not sent for revenue inference');
  assert.ok(ents.find((e) => e.company === 'Google Pixel'), 'Pixel (direct_revenue) is still collected');

  const out = synthesize(ownership, revenueByCompany, null, {});
  const chrome = out.ownership_tree.siblings.find((s) => s.company === 'Google Chrome');
  assert.equal(chrome.revenue_estimate, undefined, 'Chrome gets NO standalone revenue despite the stray $120B');
  assert.match(chrome.reason_for_null, /distribution channel/i, 'Chrome explains the dash');
  const vs = out.positioning_analysis.focal_vs_siblings;
  assert.doesNotMatch(vs, /120/, 'the $120B figure never reaches the ranking');
});

// ─── Issue #5-bis: declared segment revenue from signals anchors a gap ────────

test('Issue #5-bis: a segment revenue declared in signals anchors a within-segment gap (Royal Canin)', () => {
  const ownership = {
    company: 'Royal Canin', domain: 'royalcanin.com', node_type: 'operating_brand', focal_segment: 'Mars Petcare',
    siblings: [
      { company: 'Pedigree', in_current_sources: true },
      { company: 'Whiskas', in_current_sources: true },
    ],
    parent: { company: 'Mars, Incorporated', node_type: 'legal_entity', parent: null },
  };
  const revenueByCompany = {
    'royal canin': { revenue_estimate: { low: 5e9, high: 7e9, central: 6e9 }, confidence: 'high', signals_found: [{ type: 'press', label: 'segment size', value: 'Mars Petcare segment ~$22B in 2023', source: 'press', weight: 'medium', context_unverified: false }], reasoning_summary: 'Royal Canin sits in the Mars Petcare segment ($22B).' },
    'pedigree': { revenue_estimate: { low: 3e9, high: 4e9, central: 3.77e9 }, confidence: 'medium', signals_found: [], reasoning_summary: '' },
    'whiskas': { revenue_estimate: { low: 1.5e9, high: 2.5e9, central: 2e9 }, confidence: 'medium', signals_found: [], reasoning_summary: '' },
    // Mars total estimate gives the benchmark a value (Mars is private → no 10-K).
    'mars, incorporated': { revenue_estimate: { low: 45e9, high: 55e9, central: 50e9 }, confidence: 'medium', signals_found: [], reasoning_summary: '' },
  };
  const out = synthesize(ownership, revenueByCompany, { is_public: false, total_revenue_usd: null, segments: [] }, {});
  const recon = out.positioning_analysis.reconciliation;
  assert.ok(recon, 'reconciliation fires against the estimated parent total');
  assert.equal(recon.segment_anchor_from_signals, 22e9, 'declared "Mars Petcare $22B" parsed from signals');
  const notes = out.positioning_analysis.strategic_notes.join(' | ');
  assert.match(notes, /Mars Petcare segment declared \$22\.00B in signals/, 'within-segment gap note surfaced');
  assert.match(notes, /uncaptured Mars Petcare brands/);
});

// ─── Issue #11: sibling-capture floor warning ─────────────────────────────────

test('Issue #11: too few siblings under a large parent raises an incompleteness warning (Snickers)', () => {
  const ownership = {
    company: 'Snickers', node_type: 'operating_brand', focal_segment: 'Mars Wrigley',
    siblings: [],
    parent: { company: 'Mars, Incorporated', node_type: 'legal_entity', parent: null },
  };
  const revenueByCompany = {
    'snickers': { revenue_estimate: { low: 2e9, high: 4e9, central: 3e9 }, confidence: 'medium', signals_found: [], reasoning_summary: '' },
    'mars, incorporated': { revenue_estimate: { low: 45e9, high: 50e9, central: 47e9 }, confidence: 'medium', signals_found: [], reasoning_summary: '' },
  };
  const out = synthesize(ownership, revenueByCompany, null, {});
  const notes = out.positioning_analysis.strategic_notes.join(' | ');
  assert.match(notes, /Only 0 siblings captured under Mars, Incorporated/, 'incompleteness warning fires');
  assert.match(notes, /reconciliation coverage is a floor/);
});

test('Task #53: single-segment public parent does not trigger the incomplete-capture warning', () => {
  const ownership = {
    company: 'PDD Marketplace', node_type: 'operating_brand', focal_segment: 'Online Marketplace',
    siblings: [{ company: 'Temu', in_current_sources: true }],
    parent: { company: 'PDD Holdings', node_type: 'legal_entity', parent: null },
  };
  const revenueByCompany = {
    'pdd marketplace': { revenue_estimate: { low: 20e9, high: 30e9, central: 25e9 }, confidence: 'high', signals_found: [], reasoning_summary: '' },
    'temu': { revenue_estimate: { low: 15e9, high: 20e9, central: 18e9 }, confidence: 'medium', signals_found: [], reasoning_summary: '' },
    'pdd holdings': { revenue_estimate: { low: 40e9, high: 50e9, central: 45e9 }, confidence: 'high', signals_found: [], reasoning_summary: '' },
  };
  const parentAnchor = {
    is_public: true,
    total_revenue_usd: 45e9,
    fiscal_year: '2024',
    segments: [{ name: 'Online Marketplace', revenue_usd: 45e9, contains_focal: true }],
  };
  const out = synthesize(ownership, revenueByCompany, parentAnchor, {});
  const notes = out.positioning_analysis.strategic_notes.join(' | ');
  assert.doesNotMatch(notes, /sibling set may be incomplete/, 'no incomplete-capture warning for single-segment parent');
  assert.doesNotMatch(notes, /sibling capture is likely incomplete/, 'no multi-segment warning for single-segment parent');
  assert.match(notes, /focused single-segment parent/, 'surfaces focused-business explanation instead');
});

test('Task #53: private focused/single-segment parent (MSC Cruises-like) does not trigger the warning', () => {
  const ownership = {
    company: 'MSC Cruises', node_type: 'operating_brand', focal_segment: 'MSC Cruises',
    siblings: [{ company: 'Explora Journeys', in_current_sources: true }],
    parent: { company: 'MSC Cruises S.A.', node_type: 'legal_entity', parent: null },
  };
  const revenueByCompany = {
    'msc cruises': { revenue_estimate: { low: 8e9, high: 12e9, central: 10e9 }, confidence: 'medium', signals_found: [], reasoning_summary: '' },
    'explora journeys': { revenue_estimate: { low: 0.2e9, high: 0.5e9, central: 0.3e9 }, confidence: 'low', signals_found: [], reasoning_summary: '' },
    'msc cruises s.a.': { revenue_estimate: { low: 9e9, high: 12e9, central: 10.5e9 }, confidence: 'medium', signals_found: [], reasoning_summary: '' },
  };
  const out = synthesize(ownership, revenueByCompany, null, {});
  const notes = out.positioning_analysis.strategic_notes.join(' | ');
  assert.doesNotMatch(notes, /sibling capture is likely incomplete/, 'no strong incompleteness warning for private focused parent');
  assert.doesNotMatch(notes, /sibling capture may be incomplete/, 'no ambiguous warning either');
  assert.match(notes, /focused single-segment parent/, 'surfaces focused-business explanation for private parents too');
});

test('Task #53: private multi-brand conglomerate with shared first token still raises the incompleteness warning', () => {
  const ownership = {
    company: 'Snickers', node_type: 'operating_brand', focal_segment: 'Mars Wrigley',
    siblings: [],
    parent: { company: 'Mars Incorporated', node_type: 'legal_entity', parent: null },
  };
  const revenueByCompany = {
    'snickers': { revenue_estimate: { low: 2e9, high: 4e9, central: 3e9 }, confidence: 'medium', signals_found: [], reasoning_summary: '' },
    'mars incorporated': { revenue_estimate: { low: 45e9, high: 50e9, central: 47e9 }, confidence: 'medium', signals_found: [], reasoning_summary: '' },
  };
  const out = synthesize(ownership, revenueByCompany, null, {});
  const notes = out.positioning_analysis.strategic_notes.join(' | ');
  assert.doesNotMatch(notes, /focused single-segment parent/, 'shared first token alone must not classify as focused');
  assert.match(notes, /sibling capture may be incomplete/, 'still emits incompleteness warning for true conglomerate');
});

test('Task #53: multi-segment parent with few captured siblings still raises the incompleteness warning', () => {
  const ownership = {
    company: 'Snickers', node_type: 'operating_brand', focal_segment: 'Mars Wrigley',
    siblings: [],
    parent: { company: 'BigCo', node_type: 'legal_entity', parent: null },
  };
  const revenueByCompany = {
    'snickers': { revenue_estimate: { low: 2e9, high: 4e9, central: 3e9 }, confidence: 'medium', signals_found: [], reasoning_summary: '' },
    'bigco': { revenue_estimate: { low: 40e9, high: 50e9, central: 45e9 }, confidence: 'medium', signals_found: [], reasoning_summary: '' },
  };
  const parentAnchor = {
    is_public: true,
    total_revenue_usd: 45e9,
    fiscal_year: '2024',
    segments: [
      { name: 'Mars Wrigley', revenue_usd: 15e9, contains_focal: true },
      { name: 'Petcare', revenue_usd: 20e9, contains_focal: false },
      { name: 'Food', revenue_usd: 10e9, contains_focal: false },
    ],
  };
  const out = synthesize(ownership, revenueByCompany, parentAnchor, {});
  const notes = out.positioning_analysis.strategic_notes.join(' | ');
  assert.match(notes, /sibling capture is likely incomplete/, 'multi-segment evidence keeps the strong warning');
  assert.match(notes, /3 reported segments/);
});

test('Issue #11: a well-covered conglomerate (≥ floor siblings) raises no incompleteness warning', () => {
  const ownership = {
    company: 'Royal Canin', node_type: 'operating_brand', focal_segment: 'Mars Petcare',
    siblings: [
      { company: 'Pedigree', in_current_sources: true },
      { company: 'Whiskas', in_current_sources: true },
      { company: 'Iams', in_current_sources: true },
      { company: 'Nutro', in_current_sources: true },
      { company: 'Banfield', in_current_sources: true },
    ],
    parent: { company: 'Mars, Incorporated', node_type: 'legal_entity', parent: null },
  };
  const revenueByCompany = {
    'royal canin': { revenue_estimate: { low: 5e9, high: 7e9, central: 6e9 }, confidence: 'high', signals_found: [], reasoning_summary: '' },
    'mars, incorporated': { revenue_estimate: { low: 45e9, high: 55e9, central: 50e9 }, confidence: 'medium', signals_found: [], reasoning_summary: '' },
  };
  const out = synthesize(ownership, revenueByCompany, null, {});
  const notes = out.positioning_analysis.strategic_notes.join(' | ');
  assert.doesNotMatch(notes, /sibling set may be incomplete/, 'no incompleteness warning with 5 siblings');
});

// ─── Task #52: sibling backfill helpers (ISSUE-AWARA-SIBLINGS-MISSING) ──────

test('Task #52: needsSiblingBackfill fires when parent exists and siblings < 3', () => {
  const r = needsSiblingBackfill({
    company: 'Awara Sleep',
    parent: { company: 'Resident Home LLC', node_type: 'legal_entity' },
    siblings: [],
  });
  assert.equal(r.needed, true);
  assert.equal(r.floor, 3);
  assert.equal(r.parent_name, 'Resident Home LLC');
});

test('Task #52: needsSiblingBackfill fires for partial captures (1 or 2 siblings)', () => {
  const r = needsSiblingBackfill({
    company: 'Awara Sleep',
    parent: { company: 'Resident Home LLC' },
    siblings: [{ company: 'DreamCloud' }, { company: 'Nectar' }],
  });
  assert.equal(r.needed, true);
});

test('Task #52: needsSiblingBackfill skips when floor already met', () => {
  const r = needsSiblingBackfill({
    company: 'Nectar Sleep',
    parent: { company: 'Resident Home LLC' },
    siblings: [{ company: 'A' }, { company: 'B' }, { company: 'C' }],
  });
  assert.equal(r.needed, false);
});

test('Task #52: needsSiblingBackfill is independent of focal characteristics', () => {
  // The whole point: capture depth must not vary by which brand is focal.
  // No special-case for small focals, low-rank focals, short chains, etc.
  const small = needsSiblingBackfill({
    company: 'Tiny Brand', revenue_estimate: { central: 10e6 },
    parent: { company: 'Mars Wrigley', node_type: 'legal_entity' },
    siblings: [],
  });
  const big = needsSiblingBackfill({
    company: 'M&Ms', revenue_estimate: { central: 5e9 },
    parent: { company: 'Mars Wrigley', node_type: 'legal_entity' },
    siblings: [],
  });
  assert.equal(small.needed, true);
  assert.equal(big.needed, true);
});

test('Task #52: needsSiblingBackfill skips standalone, individual UBO, PE terminal, and missing parent', () => {
  assert.equal(needsSiblingBackfill(null).needed, false);
  assert.equal(needsSiblingBackfill({ company: 'X', standalone: true, parent: { company: 'Y' } }).needed, false);
  assert.equal(needsSiblingBackfill({ company: 'X', parent: null }).needed, false);
  assert.equal(
    needsSiblingBackfill({ company: 'X', parent: { company: 'Z', node_type: 'individual' } }).needed,
    false,
    'individual UBO parents have no portfolio brands to enumerate',
  );
  assert.equal(
    needsSiblingBackfill({ company: 'X', parent: { company: 'PE Sponsor', terminal_layer: 'private_equity' } }).needed,
    false,
    'PE terminal parents do not have sibling brands at the focal layer',
  );
});

test('Task #52: mergeSiblings preserves existing entries and adds new ones, deduped by company name', () => {
  const existing = [
    { company: 'DreamCloud', domain: 'dreamcloud.com', category: 'hybrid mattress', custom_field: 'preserved' },
  ];
  const discovered = [
    { company: 'dreamcloud' }, // case-insensitive dup → skipped
    { company: 'Nectar', domain: 'nectarsleep.com', in_current_sources: true },
    { company: 'Awara', domain: 'awara.com' },
    { company: 'Awara' }, // dup within discovered → skipped
  ];
  const { siblings, added } = mergeSiblings(existing, discovered, 'Cloverlane');
  assert.equal(siblings.length, 3);
  assert.equal(siblings[0].custom_field, 'preserved', 'existing entry kept intact');
  assert.equal(siblings[0].category, 'hybrid mattress');
  assert.deepEqual(added, ['Nectar', 'Awara']);
  const nectar = siblings.find((s) => s.company === 'Nectar');
  assert.equal(nectar._backfilled, true, 'backfilled rows are tagged');
  assert.equal(nectar.revenue_model, 'direct_revenue', 'default revenue_model is direct_revenue');
  assert.equal(nectar.node_type, 'operating_brand', 'default node_type is operating_brand');
});

test('Task #52: mergeSiblings filters the focal even under a truncated product-line suffix', () => {
  const { siblings, added } = mergeSiblings(
    [],
    [
      { company: 'Awara' },           // first-token match of "Awara Sleep" focal → filtered
      { company: 'awara sleep' },     // exact match → filtered
      { company: 'Nectar Sleep' },    // legitimate sibling under the same parent
      { company: 'DreamCloud' },
    ],
    'Awara Sleep',
  );
  assert.deepEqual(added.sort(), ['DreamCloud', 'Nectar Sleep'].sort());
  assert.ok(!siblings.some((s) => /awara/i.test(s.company)));
});

test('Task #52: mergeSiblings does not over-filter on unrelated tokens', () => {
  // The focal-match heuristic only matches when one name is a single token AND
  // it equals the leading token of the other multi-token name. It must not
  // collapse genuinely distinct brands that happen to share a non-leading word.
  const { added } = mergeSiblings(
    [],
    [
      { company: 'Mars Wrigley' },  // shares "Wrigley" with focal but different leading token
      { company: 'Snickers' },
    ],
    'Extra Gum Wrigley',
  );
  assert.deepEqual(added.sort(), ['Mars Wrigley', 'Snickers'].sort());
});

test('Task #52: mergeSiblings tolerates null/undefined/garbage inputs', () => {
  assert.deepEqual(mergeSiblings(null, null, null), { siblings: [], added: [] });
  assert.deepEqual(mergeSiblings(undefined, [{ company: '' }, { }], 'X'), { siblings: [], added: [] });
  const r = mergeSiblings([{ company: 'A' }], 'not-an-array', 'X');
  assert.equal(r.siblings.length, 1);
});

test('Task #52: Snickers (Mars Wrigley mega-cap parent) requires floor 5, not 3', () => {
  // Mars Wrigley is on the mega-cap allowlist — floor must be 5 even when
  // some siblings were already captured. This is the ticket's explicit
  // Snickers acceptance criterion.
  const bf = needsSiblingBackfill({
    company: 'Snickers',
    parent: { company: 'Mars Wrigley', node_type: 'legal_entity' },
    siblings: [{ company: "M&M's" }, { company: 'Twix' }],
  });
  assert.equal(bf.needed, true, 'floor 5 not met by 2 captured siblings');
  assert.equal(bf.floor, 5);
  assert.equal(bf.is_mega_cap, true);
});

test('Task #52: mega-cap floor stops requiring backfill once 5 siblings are captured', () => {
  const bf = needsSiblingBackfill({
    company: 'Snickers',
    parent: { company: 'Mars Wrigley' },
    siblings: ["M&M's", 'Twix', 'Skittles', 'Extra', 'Orbit'].map((c) => ({ company: c })),
  });
  assert.equal(bf.needed, false);
  assert.equal(bf.floor, 5);
});

test('Task #52: mega-cap detection uses explicit revenue hint when name is unfamiliar', () => {
  const bf = needsSiblingBackfill({
    company: 'X', siblings: [],
    parent: { company: 'Obscure Holdings Ltd', anchor_revenue: 80e9 },
  });
  assert.equal(bf.is_mega_cap, true);
  assert.equal(bf.floor, 5);
});

test('Task #52: MSC Cruceros (single-segment private holding) — backfill runs at floor 3 and installs ≥1', () => {
  // MSC Cruises sits under MSC Group — a private, focused-business parent.
  // Floor is 3 (not 5; not a mega-cap on the allowlist). Backfill should
  // run and install at least 1 sibling brand (e.g. MSC Cargo, MSC Foundation).
  const ownership = {
    company: 'MSC Cruceros',
    domain: 'msccruceros.es',
    node_type: 'operating_brand',
    parent: { company: 'MSC Group', node_type: 'legal_entity', parent: null },
    siblings: [],
  };
  const bf = needsSiblingBackfill(ownership);
  assert.equal(bf.needed, true);
  assert.equal(bf.floor, 3, 'MSC Group is not on the mega-cap allowlist');
  assert.equal(bf.is_mega_cap, false);
  // Simulate a backfill returning a single related MSC brand.
  const { siblings, added } = mergeSiblings(
    ownership.siblings,
    [{ company: 'MSC Cargo', domain: 'msccargo.com', category: 'logistics' }],
    ownership.company,
  );
  ownership.siblings = siblings;
  assert.ok(added.length >= 1, 'at least 1 sibling installed for MSC Cruceros');
  const entities = collectEntities(ownership);
  assert.ok(entities.some((e) => e.role === 'sibling' && e.company === 'MSC Cargo'));
});

test('Task #52: Resident Home 4-way focal permutation produces mutually consistent siblings', () => {
  // Acceptance criterion from the ticket: rotating the focal among
  // Awara / Nectar / DreamCloud / Siena under Resident Home LLC must yield
  // ≥3 siblings each AND the four trees must be mutually consistent — i.e.,
  // every brand that's a sibling in run X is also focal-or-sibling in run Y.
  const RESIDENT_HOME_BRANDS = ['Awara Sleep', 'Nectar', 'DreamCloud', 'Siena'];
  // Synthetic backfill returns the other three brands when given any focal.
  const backfillFor = (focal) =>
    RESIDENT_HOME_BRANDS.filter((b) => b !== focal).map((b) => ({
      company: b,
      domain: `${b.split(' ')[0].toLowerCase()}.com`,
      category: 'mattress',
      in_current_sources: true,
    }));

  const trees = RESIDENT_HOME_BRANDS.map((focal) => {
    const ownership = {
      company: focal,
      domain: `${focal.split(' ')[0].toLowerCase()}.com`,
      node_type: 'operating_brand',
      parent: { company: 'Resident Home LLC', node_type: 'legal_entity', parent: null },
      siblings: [],
    };
    const bf = needsSiblingBackfill(ownership);
    assert.equal(bf.needed, true, `${focal}: backfill should fire when empty`);
    const { siblings } = mergeSiblings(ownership.siblings, backfillFor(focal), focal);
    ownership.siblings = siblings;
    return ownership;
  });

  // (1) Every run yields ≥3 siblings.
  trees.forEach((t) => {
    assert.ok(
      (t.siblings || []).length >= 3,
      `${t.company}: only ${(t.siblings || []).length} siblings (expected ≥3)`,
    );
  });

  // (2) Mutual consistency: the universe of {focal ∪ siblings} is identical
  // across all four runs — capture depth doesn't vary by which brand is focal.
  const universes = trees.map((t) => {
    const u = new Set([t.company.toLowerCase()]);
    (t.siblings || []).forEach((s) => u.add(s.company.toLowerCase()));
    return [...u].sort();
  });
  const ref = universes[0];
  for (let i = 1; i < universes.length; i++) {
    assert.deepEqual(universes[i], ref, `${trees[i].company} universe diverges from ${trees[0].company}`);
  }

  // (3) Revenue phase schedules all 4 brands in every run.
  trees.forEach((t) => {
    const entities = collectEntities(t);
    const brandNames = new Set(entities.map((e) => e.company));
    RESIDENT_HOME_BRANDS.forEach((b) => {
      assert.ok(brandNames.has(b), `${t.company}: ${b} not scheduled for revenue phase`);
    });
  });
});

test('Task #52: mergeCousins preserves via_division and cousin-specific fields', () => {
  // Code-review finding: mergeSiblings strips cousin-specific schema. Cousins
  // must keep via_division so the brief can render "via <division>" context.
  const existing = [
    { company: 'Louis Vuitton', via_division: 'Fashion & Leather Goods', custom: 'kept' },
  ];
  const discovered = [
    { company: 'louis vuitton' }, // dedup
    { company: 'Hennessy', via_division: 'Wines & Spirits', domain: 'hennessy.com' },
    { company: 'Sephora', via_division: 'Selective Retailing' },
  ];
  const { cousins, added } = mergeCousins(existing, discovered, 'Dior');
  assert.equal(cousins.length, 3);
  assert.equal(cousins[0].custom, 'kept', 'existing cousin preserved intact');
  const hennessy = cousins.find((c) => c.company === 'Hennessy');
  assert.equal(hennessy.via_division, 'Wines & Spirits', 'via_division preserved on backfilled cousin');
  assert.equal(hennessy.relation, 'intra_parent_cousin');
  assert.equal(hennessy._backfilled, true);
  assert.deepEqual(added.sort(), ['Hennessy', 'Sephora'].sort());
});

test('Task #52: T-Awara regression — after backfill, all 4 Resident Home brands install as siblings', () => {
  // Simulates the bug scenario: ownership returns Awara with 0 siblings, the
  // backfill call returns the 3 other Resident Home brands, and the merged
  // tree is fed into collectEntities. The revenue phase should now schedule
  // focal + parent + 3 siblings (5+ entities), not just focal+parent.
  const ownership = {
    company: 'Awara Sleep',
    domain: 'awara.com',
    node_type: 'operating_brand',
    parent: { company: 'Resident Home LLC', node_type: 'legal_entity', parent: null },
    siblings: [], // ← the bug: empty despite the agent knowing about siblings
  };
  const bf = needsSiblingBackfill(ownership);
  assert.equal(bf.needed, true);
  const discovered = [
    { company: 'DreamCloud', domain: 'dreamcloud.com', category: 'hybrid mattress', in_current_sources: true },
    { company: 'Nectar', domain: 'nectarsleep.com', category: 'memory foam', in_current_sources: true },
    { company: 'Siena', domain: 'sienamattress.com', category: 'memory foam', in_current_sources: true },
    { company: 'Cloverlane', domain: 'cloverlane.com', category: 'hybrid mattress', in_current_sources: true },
  ];
  const { siblings, added } = mergeSiblings(ownership.siblings, discovered, ownership.company);
  ownership.siblings = siblings;
  assert.equal(siblings.length, 4, 'all 4 Resident Home portfolio brands installed');
  assert.equal(added.length, 4);
  const entities = collectEntities(ownership);
  const siblingEntities = entities.filter((e) => e.role === 'sibling');
  assert.equal(siblingEntities.length, 4, 'revenue phase now schedules all 4 siblings');
  assert.ok(entities.some((e) => e.company === 'DreamCloud' && e.parent_company === 'Resident Home LLC'));
});

// ─── Issue #6-bis: stock-swap acquisition price flows through synthesis ───────

test('Issue #6-bis: a stock-swap acquisition price survives synthesis intact', () => {
  const ownership = {
    company: 'YouTube', domain: 'youtube.com', node_type: 'operating_brand',
    acquisition: { acquired_by: 'Google', year: 2006, price_usd: 1_650_000_000, price_display: '$1.65B', deal_type: 'stock_swap', source_url: 'https://example.com' },
    parent: { company: 'Google LLC', node_type: 'legal_entity', parent: null },
  };
  const revenueByCompany = { 'youtube': { revenue_estimate: { low: 30e9, high: 33e9, central: 31.5e9 }, confidence: 'high', signals_found: [], reasoning_summary: '' } };
  const out = synthesize(ownership, revenueByCompany, null, {});
  const acq = out.ownership_tree.acquisition;
  assert.equal(acq.deal_type, 'stock_swap');
  assert.equal(acq.price_usd, 1_650_000_000);
  assert.equal(acq.price_display, '$1.65B');
});
