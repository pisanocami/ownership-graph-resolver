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
