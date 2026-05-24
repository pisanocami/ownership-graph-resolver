import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  synthesize, collectEntities, deriveStatus, deriveRevenueStatus,
  normalizeChain, deriveDivestiture, isCircularEstimate, collectControlLayers,
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
