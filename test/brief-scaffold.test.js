import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { synthesize } from '../synth.js';

const here = dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(readFileSync(join(here, 'fixtures', f), 'utf8'));

const tToblerone = load('t-toblerone.json');
const tPatagonia = load('t-patagonia.json');

// Phase 0 scaffolding: verify intelligence_brief structure is wired and returns shaped-but-empty objects

test('brief scaffold: should attach intelligence_brief to synthesized result', () => {
  const result = synthesize(tToblerone.ownership_tree, {}, null, {});

  assert.ok(result.intelligence_brief, 'intelligence_brief key missing');
  assert.ok(result.intelligence_brief.verdict, 'verdict missing');
  assert.ok(result.intelligence_brief.behavioral_signals, 'behavioral_signals missing');
  assert.ok(result.intelligence_brief.corporate_structure, 'corporate_structure missing');
});

test('brief scaffold: should return shaped-but-empty verdict object', () => {
  const result = synthesize(tToblerone.ownership_tree, {}, null, {});
  const { verdict } = result.intelligence_brief;

  assert.equal(verdict.label, null);
  assert.equal(verdict.trajectory, null);
  assert.equal(verdict.capital_decision, null);
  assert.equal(verdict.confidence, 'low');
});

test('brief scaffold: should return empty behavioral_signals array', () => {
  const result = synthesize(tToblerone.ownership_tree, {}, null, {});
  const { behavioral_signals } = result.intelligence_brief;

  assert.ok(Array.isArray(behavioral_signals));
  assert.equal(behavioral_signals.length, 0);
});

test('brief scaffold: should include reconciliation_honest for subsidiary', () => {
  const result = synthesize(tToblerone.ownership_tree, {}, null, {});

  assert.ok(result.intelligence_brief.reconciliation_honest, 'reconciliation_honest missing for subsidiary');
});

test('brief scaffold: should exclude reconciliation_honest for standalone', () => {
  const result = synthesize(tPatagonia.ownership_tree, {}, null, {});

  assert.equal(result.intelligence_brief.reconciliation_honest, null, 'reconciliation_honest should be null for standalone');
});

test('brief scaffold: should not break existing synthesis output', () => {
  const result = synthesize(tToblerone.ownership_tree, {}, null, {});

  assert.ok(result.focal_company, 'focal_company missing');
  assert.ok(result.ownership_tree, 'ownership_tree missing');
  assert.ok(result.positioning_analysis, 'positioning_analysis missing');
});
