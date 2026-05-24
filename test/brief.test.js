import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  deriveVerdict,
  classifyReconciliation,
  classifySignal,
  detectCounterSignals,
  buildAsciiTree,
  deriveOwnershipClarity,
  detectMaAttention,
  buildDataTrace,
  buildMispricingSkeleton,
  detectFamilyConcentrated,
  isConsumerSector,
  detectSector,
  buildPeerMultiplesFromCatalog,
  buildDiscountDecomposition,
  buildVerdictChangerMap,
  buildConfidenceBuckets,
  buildGapLeverageStars,
  buildSectionConfidence,
  buildLimitationsList,
  splitDataSources,
  buildCapitalPathSummaryText,
  buildActionableReads,
  sanitizeForPdf,
} from '../brief.js';
import { synthesize } from '../synth.js';

const here = dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(readFileSync(join(here, 'fixtures', f), 'utf8'));

const t04 = load('t04-nectar.json');

// ─── Verdict Derivation Tests ──────────────────────────────────────────

test('deriveVerdict: returns object with required fields', () => {
  const tree = { company: 'Brand', parent: null, signals_found: [] };
  const positioning = { focal_vs_siblings: 'test' };

  const verdict = deriveVerdict(tree, positioning);

  assert.ok('label' in verdict);
  assert.ok('trajectory' in verdict);
  assert.ok('capital_decision' in verdict);
  assert.ok('_inputs' in verdict);
});

test('deriveVerdict: with co_owners and no parent → Not actionable flag present', () => {
  const tree = {
    company: 'Brand',
    parent: null,
    co_owners: [{ company: 'Co-owner 1' }, { company: 'Co-owner 2' }],
    signals_found: [],
    terminal_layer: 'private',
  };
  const positioning = { focal_vs_siblings: 'test' };

  const verdict = deriveVerdict(tree, positioning);

  assert.equal(verdict.capital_decision, 'Not actionable as standalone');
});

// ─── Reconciliation Classification Tests ─────────────────────────────

test('classifyReconciliation: overshoot (pct_delta > 50) → interpretation: overshoot', () => {
  const recon = {
    sum_children_central: 1000,
    parent_benchmark: 600,
    ratio: 1.67,
    pct_delta: 67,
    circular: false,
    circular_siblings: [],
  };
  const tree = { parent: { company: 'Mondelez' }, siblings: [] };

  const classified = classifyReconciliation(recon, tree);

  assert.equal(classified.interpretation, 'overshoot');
  assert.ok(classified.honest_explanation.includes('overstated'));
});

test('classifyReconciliation: gap (pct_delta < -50) → interpretation: gap_uncovered', () => {
  const recon = {
    sum_children_central: 300,
    parent_benchmark: 800,
    ratio: 0.375,
    pct_delta: -63,
    circular: false,
    circular_siblings: [],
  };
  const tree = { parent: { company: 'Parent' }, siblings: [] };

  const classified = classifyReconciliation(recon, tree);

  assert.equal(classified.interpretation, 'gap_uncovered');
  assert.ok(classified.honest_explanation.includes('missing'));
});

test('classifyReconciliation: circular → interpretation: circular', () => {
  const recon = {
    sum_children_central: 1000,
    parent_benchmark: 1000,
    ratio: 1.0,
    pct_delta: 0,
    circular: true,
    circular_siblings: ['Brand A', 'Brand B'],
  };
  const tree = { parent: { company: 'Parent' }, siblings: [] };

  const classified = classifyReconciliation(recon, tree);

  assert.equal(classified.interpretation, 'circular');
  assert.ok(classified.honest_explanation.includes('self-fulfilling'));
});

test('classifyReconciliation: reconciles (delta within ±20%) → interpretation: reconciles', () => {
  const recon = {
    sum_children_central: 950,
    parent_benchmark: 1000,
    ratio: 0.95,
    pct_delta: -5,
    circular: false,
    circular_siblings: [],
  };
  const tree = { parent: { company: 'Parent' }, siblings: [] };

  const classified = classifyReconciliation(recon, tree);

  assert.equal(classified.interpretation, 'reconciles');
});

// ─── Signal Classification Tests ───────────────────────────────────────

test('classifySignal: basic signal mapping', () => {
  const sig = {
    type: 'hiring',
    label: 'New hires in marketing',
    value: '50 new positions',
    source: 'linkedin',
    weight: 'high',
  };

  const classified = classifySignal(sig);

  assert.equal(classified.signal_type, 'Hiring acceleration');
  assert.equal(classified.weight, 'high');
  assert.equal(classified.evidence_source, 'linkedin');
  assert.equal(classified.interpretation, null, 'interpretation is stubbed for LLM');
});

test('classifySignal: context_unverified → force weight to low', () => {
  const sig = {
    type: 'funding',
    label: 'Series C rumored',
    value: '$100M',
    source: 'rumor',
    weight: 'high',
    context_unverified: true,
  };

  const classified = classifySignal(sig);

  assert.equal(classified.weight, 'low', 'weight forced to low when context_unverified');
});

test('classifySignal: layoff detection', () => {
  const sig = {
    type: 'hiring',
    label: 'Workforce reduction',
    value: '500 layoffs',
    source: 'news',
    weight: 'high',
  };

  const classified = classifySignal(sig);

  assert.equal(classified.signal_type, 'Workforce reduction');
});

// ─── Counter Signals Detection Tests ───────────────────────────────────

test('detectCounterSignals: high-revenue brand missing expected signals', () => {
  const tree = {
    company: 'BigBrand',
    revenue_estimate: { central: 10e9 },
    parent: { company: 'Parent' },
    signals_found: [
      { type: 'press', label: 'Press coverage' },
    ],
  };

  const gaps = detectCounterSignals(tree);

  assert.ok(gaps.length > 0, 'should detect missing signals');
  const gapTypes = gaps.map((g) => g.signal_type);
  assert.ok(gapTypes.some((gt) => gt.includes('Hiring') || gt.includes('Funding')), 'should flag missing growth signals');
});

test('detectCounterSignals: small brand with few signals → minimal gaps', () => {
  const tree = {
    company: 'SmallBrand',
    revenue_estimate: { central: 100e6 },
    parent: null,
    signals_found: [],
  };

  const gaps = detectCounterSignals(tree);

  assert.ok(gaps.length <= 1, 'small standalone brand should have minimal expected signals');
});

// ─── Ownership Clarity Tests ──────────────────────────────────────────

test('deriveOwnershipClarity: single parent, no co-owners → clean', () => {
  const tree = {
    company: 'Brand',
    parent: { company: 'Parent' },
    co_owners: [],
    strategic_control: [{ company: 'Parent' }],
  };

  const clarity = deriveOwnershipClarity(tree);

  assert.equal(clarity, 'clean');
});

test('deriveOwnershipClarity: multiple co-owners → multi_owner', () => {
  const tree = {
    company: 'Brand',
    parent: { company: 'Parent' },
    co_owners: [
      { company: 'Co-owner 1' },
      { company: 'Co-owner 2' },
    ],
  };

  const clarity = deriveOwnershipClarity(tree);

  assert.equal(clarity, 'multi_owner');
});

test('deriveOwnershipClarity: no parent, many control actors → confused', () => {
  const tree = {
    company: 'Brand',
    parent: null,
    co_owners: [],
    strategic_control: [
      { company: 'Actor 1' },
      { company: 'Actor 2' },
      { company: 'Actor 3' },
      { company: 'Actor 4' },
      { company: 'Actor 5' },
    ],
  };

  const clarity = deriveOwnershipClarity(tree);

  assert.equal(clarity, 'confused');
});

// ─── M&A Attention Tests ──────────────────────────────────────────────

test('detectMaAttention: pending acquisition → recent_activity', () => {
  const tree = {
    company: 'Brand',
    pending_acquisition: { acquirer: 'Acquirer Inc', expected_close_date: '2025-06-01' },
  };

  const maAttention = detectMaAttention(tree);

  assert.equal(maAttention, 'recent_activity');
});

test('detectMaAttention: acquisition rumor (no pending, old year) → rumored', () => {
  const tree = {
    company: 'Brand',
    pending_acquisition: null,
    acquisition: { status: 'rumored', year: 2000 }, // old year so it doesn't match <= 3 years rule
  };

  const maAttention = detectMaAttention(tree);

  assert.equal(maAttention, 'rumored');
});

test('detectMaAttention: no M&A signals → none', () => {
  const tree = {
    company: 'Brand',
    pending_acquisition: null,
    acquisition: null,
  };

  const maAttention = detectMaAttention(tree);

  assert.equal(maAttention, 'none');
});

// ─── ASCII Tree Builder Tests ─────────────────────────────────────────

test('buildAsciiTree: subsidiary with parent', () => {
  const tree = {
    company: 'Toblerone',
    type: 'Brand',
    parent: { company: 'Mondelez' },
    siblings: [{ company: 'Cadbury' }, { company: 'Milka' }],
  };

  const ascii = buildAsciiTree(tree);

  assert.ok(ascii.includes('Toblerone'));
  assert.ok(ascii.includes('Mondelez'));
  assert.ok(ascii.includes('2 brands'));
});

test('buildAsciiTree: standalone', () => {
  const tree = {
    company: 'Patagonia',
    type: 'Brand',
    parent: null,
    co_owners: [{ company: 'Purpose Trust' }],
    children: [],
  };

  const ascii = buildAsciiTree(tree);

  assert.ok(ascii.includes('Patagonia'));
  assert.ok(ascii.includes('Purpose Trust'));
  assert.ok(!ascii.includes('Parent:'));
});

// ─── Data Trace Builder Tests ─────────────────────────────────────────

test('buildDataTrace: extracts sources from signals', () => {
  const tree = {
    company: 'Brand',
    revenue_estimate: { source: 'filing' },
    signals_found: [
      { source: 'news' },
      { source: 'linkedin' },
      { source: 'news' }, // duplicate
    ],
  };

  const trace = buildDataTrace(tree);

  assert.ok(trace.primary_sources.includes('filing'));
  assert.ok(trace.primary_sources.includes('news'));
  assert.ok(trace.primary_sources.includes('linkedin'));
  assert.equal(trace.primary_sources.length, 3, 'should deduplicate');
});

// ─── Mispricing Skeleton Tests ────────────────────────────────────────

test('buildMispricingSkeleton: pending acquisition → ma_attention: recent_activity', () => {
  const tree = {
    company: 'Brand',
    pending_acquisition: { acquirer: 'Buyer' },
  };

  const skeleton = buildMispricingSkeleton(tree, {});

  assert.equal(skeleton.ma_attention, 'recent_activity');
});

test('buildMispricingSkeleton: no thesis field populated (LLM gate)', () => {
  const tree = {
    company: 'Brand',
    pending_acquisition: null,
  };

  const skeleton = buildMispricingSkeleton(tree, {});

  assert.equal(skeleton.has_thesis, false);
  assert.equal(skeleton.hypothesis, null);
});

// ─── Integration Tests (using real fixture) ────────────────────────────

test('integration: real fixture has all brief sections', () => {
  const result = synthesize(t04.ownership, t04.revenueByCompany, t04.parentAnchor);
  const brief = result.intelligence_brief;

  assert.ok(brief.verdict, 'verdict missing');
  assert.ok(Array.isArray(brief.behavioral_signals), 'behavioral_signals should be array');
  assert.ok(brief.corporate_structure, 'corporate_structure missing');
  assert.ok(brief.data_trace, 'data_trace missing');
});

// ═══════════════════════════════════════════════════════════════════════════
// V2.1 Perfect-Brief enrichment helper tests (Task #58)
// ═══════════════════════════════════════════════════════════════════════════

test('detectFamilyConcentrated: walks parent chain to find individual UBO', () => {
  // Aponte case: family sits 3 layers up (focal -> opco -> group -> family).
  const tree = {
    company: 'MSC Cruises',
    parent: {
      company: 'MSC Group',
      parent: {
        company: 'Gianluigi Aponte',
        node_type: 'individual',
        ownership_pct: 100,
      },
    },
  };
  const fam = detectFamilyConcentrated(tree);
  assert.equal(fam.is_family, true);
  assert.equal(fam.surname, 'aponte');
  assert.equal(fam.total_pct, 100);
});

test('isConsumerSector: cruise focal returns true', () => {
  assert.equal(isConsumerSector({ company: 'MSC Cruises', focal_segment: 'cruise line' }), true);
  assert.equal(isConsumerSector({ company: 'Acme B2B Middleware' }), false);
});

test('detectSector + buildPeerMultiplesFromCatalog: cruise → 4 peers from catalog', () => {
  const tree = { company: 'MSC Cruises', focal_segment: 'cruise' };
  assert.equal(detectSector(tree), 'cruise');
  const peers = buildPeerMultiplesFromCatalog(tree);
  assert.equal(peers.source, 'catalog');
  assert.equal(peers.peers.length, 4);
  assert.ok(peers.peers.every((p) => typeof p.ev_to_revenue === 'number'));
});

test('buildDiscountDecomposition: private family-concentrated → illiquidity + governance components', () => {
  const tree = {
    company: 'Brand',
    parent: { company: 'Founder', node_type: 'individual', ownership_pct: 100 },
    revenue_estimate: { central: 1e9 },
  };
  const dec = buildDiscountDecomposition(tree);
  assert.ok(dec);
  assert.ok(dec.components.some((c) => c.label === 'Illiquidity'));
  assert.ok(dec.components.some((c) => /Governance/i.test(c.label)));
  assert.ok(/%/.test(dec.aggregate_discount_range));
});

test('buildVerdictChangerMap: family-concentrated → ≥3 condition/label entries', () => {
  const tree = { company: 'Brand', parent: { company: 'Aponte', node_type: 'individual', ownership_pct: 100 } };
  const fam = detectFamilyConcentrated(tree);
  const cap = { decision: 'Not actionable as standalone', reason: 'family_concentrated_100pct' };
  const map = buildVerdictChangerMap(tree, cap, fam);
  assert.ok(map.length >= 3);
  assert.ok(map.every((m) => m.condition && m.new_label));
});

test('buildConfidenceBuckets: returns high/medium/low arrays', () => {
  const tree = { company: 'Brand', revenue_estimate: { confidence: 'high', source: 'public 10-K' }, parent: { ticker: 'XYZ' } };
  const positioning = { parent_anchor: { is_public: true, fiscal_year: '2024' } };
  const b = buildConfidenceBuckets(tree, positioning, []);
  assert.ok(Array.isArray(b.high));
  assert.ok(Array.isArray(b.medium));
  assert.ok(Array.isArray(b.low));
  assert.ok(b.high.length >= 1);
});

test('buildGapLeverageStars: family succession gap → 3 stars', () => {
  const stars = buildGapLeverageStars(['Family succession event'], { is_family: true });
  assert.equal(stars[0].stars, 3);
});

test('buildSectionConfidence: returns 6 sections each with stars + reason', () => {
  const sc = buildSectionConfidence(
    { revenue_estimate: { confidence: 'medium' }, signals_found: [] },
    { reconciliation: {} }, {}, { is_family: false },
  );
  assert.ok(sc.verdict.stars);
  assert.ok(sc.behavioral_signals.stars);
  assert.ok(sc.reconciliation.stars);
});

test('buildLimitationsList: private parent → 10-K note', () => {
  const tree = { parent: { company: 'Holdings X' }, revenue_estimate: { central: 1e9 } };
  const lims = buildLimitationsList(tree, { parent_anchor: { is_public: false } }, []);
  assert.ok(lims.some((l) => /10-K|anchor/.test(l)));
});

test('splitDataSources: returns primary_used + excluded_with_reason', () => {
  const tree = {
    company: 'MSC',
    focal_segment: 'cruise',
    revenue_estimate: { source: 'company website' },
    signals_found: [{ source: 'FT' }],
  };
  const s = splitDataSources(tree);
  assert.ok(s.primary_used.includes('company website'));
  assert.ok(s.excluded_with_reason.some((e) => /SimilarWeb/.test(e.source)));
});

test('buildCapitalPathSummaryText: family-private with no M&A → 3-part summary', () => {
  const tree = { company: 'Brand' };
  const fam = { is_family: true, total_pct: 100 };
  const cap = { reason: 'family_concentrated_100pct' };
  const txt = buildCapitalPathSummaryText(tree, fam, cap);
  assert.match(txt, /Family-owned private/);
  assert.match(txt, /No public ticker/);
  assert.match(txt, /No M&A/);
});

test('buildActionableReads: not-actionable → 3 audience reads', () => {
  const reads = buildActionableReads(
    { company: 'Brand' },
    { capital_decision: 'Not actionable as standalone' },
    {},
    { surname: 'aponte' },
  );
  assert.equal(reads.length, 3);
  assert.ok(reads.every((r) => r.audience && r.read));
});

test('sanitizeForPdf: replaces unicode glyphs with ASCII equivalents', () => {
  const input = '▣ Heading • bullet — em-dash … ★ star ✓ check → arrow';
  const out = sanitizeForPdf(input);
  assert.doesNotMatch(out, /[▣•—…★✓→]/);
  assert.match(out, /# Heading - bullet - em-dash \.\.\. \* star OK check -> arrow/);
});

test('sanitizeForPdf: handles null/undefined safely', () => {
  assert.equal(sanitizeForPdf(null), '');
  assert.equal(sanitizeForPdf(undefined), '');
  assert.equal(sanitizeForPdf(123), '123');
});

test('V2.1 integration: buildIntelligenceBrief return shape includes all new fields', () => {
  const out = synthesize(t04, {}, null, {});
  const b = out.intelligence_brief;
  assert.ok('verdict_changer_map' in b.verdict);
  assert.ok('capital_path_summary' in b.verdict);
  assert.ok('actionable_reads' in b.mispricing);
  assert.ok('confidence_buckets' in b);
  assert.ok('section_confidence' in b);
  assert.ok('limitations_list' in b);
  assert.ok('excluded_with_reason' in b.data_trace);
  assert.ok('primary_used' in b.data_trace);
  assert.ok('known_gaps_starred' in b.confidence_gaps);
});
