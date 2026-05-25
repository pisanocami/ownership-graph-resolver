import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dedupSignals, validateInterpretation, applyInterpretationGate,
  validatePeerRevenue, pickTopSignals, buildMispricingSkeleton,
} from '../brief.js';

// ─── B3: Top-3 preview is distinct + truncated ──────────────────────────────

test('B3: top signals carry truncated headline/tagline (NEW.19)', () => {
  const longEvidence = 'A'.repeat(200);
  const signals = [
    { signal_type: 'Revenue signal', weight: 'high', evidence: longEvidence, interpretation: 'B'.repeat(200), directional_implication: 'positive' },
    { signal_type: 'Hiring acceleration', weight: 'medium', evidence: 'short', interpretation: 'x', directional_implication: 'positive' },
    { signal_type: 'Media coverage', weight: 'low', evidence: 'y', interpretation: 'z', directional_implication: 'neutral' },
  ];
  const top = pickTopSignals(signals, 3);
  assert.ok(top[0].evidence_headline.length <= 80);
  assert.ok(top[0].interpretation_tagline.length <= 60);
  assert.equal(top[0].direction, 'positive');
  // headline is a truncation of the evidence, not the full body
  assert.notEqual(top[0].evidence_headline, longEvidence);
});

// ─── B4: signal dedup ───────────────────────────────────────────────────────

test('B4: dedupSignals collapses word-for-word duplicates (NEW.21)', () => {
  const signals = [
    { signal_type: 'Revenue signal', evidence: '$2.5B FY24 revenue' },
    { signal_type: 'Revenue signal', evidence: '$2.5B FY24 revenue' }, // dup
    { signal_type: 'Hiring acceleration', evidence: '+200 roles' },
  ];
  const out = dedupSignals(signals);
  assert.equal(out.length, 2);
});

// ─── B5: interpretation quality gate ────────────────────────────────────────

test('B5: interpretation identical to evidence is invalid (NEW.25)', () => {
  const ev = 'Revenue grew 30% year over year in 2024';
  assert.equal(validateInterpretation(ev, ev).valid, false);
});

test('B5: distinct analytic interpretation passes', () => {
  const ev = 'Opened 3 new factories in Vietnam';
  const interp = 'Signals a multi-year capacity bet ahead of demand; bullish on forward volume.';
  assert.equal(validateInterpretation(ev, interp).valid, true);
});

test('B5: applyInterpretationGate marks failures', () => {
  const sig = { evidence: 'Layoffs of 500 staff', interpretation: 'Layoffs of 500 staff' };
  applyInterpretationGate(sig);
  assert.ok(sig._interpretation_failed);
  assert.match(sig.interpretation, /interpretation generation failed/);
});

// ─── B6: peer revenue validation ────────────────────────────────────────────

test('B6: peer revenue ≈ its parent total is dropped (NEW.20)', () => {
  // Crest "revenue" = P&G total → drop
  const v = validatePeerRevenue(82e9, 84e9, 3e9);
  assert.equal(v.valid, false);
  assert.equal(v.action, 'drop_revenue_estimate');
});

test('B6: peer >10× focal is flagged', () => {
  const v = validatePeerRevenue(50e9, null, 3e9);
  assert.equal(v.valid, false);
  assert.equal(v.action, 'flag_for_review');
});

test('B6: buildMispricingSkeleton drops parent-attributed peers to "—"', () => {
  const tree = { company: 'Colgate', revenue_estimate: { central: 4e9 }, signals_found: [] };
  const competitive = [
    { competitor: 'Crest', estimated_revenue_usd: 82e9, parent_estimated_revenue_usd: 84e9 },
    { competitor: 'Sensodyne', estimated_revenue_usd: 3e9, parent_estimated_revenue_usd: 50e9 },
  ];
  const m = buildMispricingSkeleton(tree, {}, competitive);
  const crest = m.peer_multiples.peers.find((p) => p.name === 'Crest');
  const sensodyne = m.peer_multiples.peers.find((p) => p.name === 'Sensodyne');
  assert.equal(crest.revenue, null, 'Crest revenue dropped (parent attribution)');
  assert.ok(crest.revenue_dropped);
  assert.equal(sensodyne.revenue, 3e9, 'valid peer revenue retained');
});
