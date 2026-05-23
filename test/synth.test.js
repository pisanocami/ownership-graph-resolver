import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { synthesize, collectEntities, deriveStatus, deriveRevenueStatus } from '../synth.js';

const here = dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(readFileSync(join(here, 'fixtures', f), 'utf8'));

const t04 = load('t04-nectar.json');
const t01 = load('t01-anthropic.json');
const tZara = load('t-zara.json');

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

test('Zara: strategic_control is deduplicated across layers', () => {
  const out = synthesize(tZara.ownership, tZara.revenueByCompany, tZara.parentAnchor);
  const tree = out.ownership_tree;
  const parentEntities = new Set(tree.parent.strategic_control.map((s) => s.entity));
  const focalRepeats = tree.strategic_control.filter((s) => parentEntities.has(s.entity));
  assert.equal(focalRepeats.length, 0, 'no owner repeated from the parent layer on the focal');
  assert.ok(tree.parent.strategic_control.some((s) => s.entity === 'Amancio Ortega'));
});
