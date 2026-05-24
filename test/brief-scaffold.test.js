import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { synthesize } from '../synth.js';

const here = dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(readFileSync(join(here, 'fixtures', f), 'utf8'));

// Load a real fixture with correct structure
const t04 = load('t04-nectar.json');

// Phase 0 scaffolding: verify intelligence_brief structure is wired

test('brief scaffold: should attach intelligence_brief to synthesized result', () => {
  const result = synthesize(t04.ownership, t04.revenueByCompany, t04.parentAnchor);

  assert.ok(result.intelligence_brief, 'intelligence_brief key missing');
  assert.ok(result.intelligence_brief.verdict, 'verdict missing');
  assert.ok(result.intelligence_brief.behavioral_signals, 'behavioral_signals missing');
  assert.ok(result.intelligence_brief.corporate_structure, 'corporate_structure missing');
  assert.ok(result.intelligence_brief.data_trace, 'data_trace missing');
});

test('brief scaffold: should have verdict object shape', () => {
  const result = synthesize(t04.ownership, t04.revenueByCompany, t04.parentAnchor);
  const { verdict } = result.intelligence_brief;

  assert.ok(typeof verdict === 'object');
  assert.ok('label' in verdict);
  assert.ok('trajectory' in verdict);
  assert.ok('capital_decision' in verdict);
  assert.ok('confidence' in verdict);
  assert.ok('_inputs' in verdict);
});

test('brief scaffold: behavioral_signals should be an array', () => {
  const result = synthesize(t04.ownership, t04.revenueByCompany, t04.parentAnchor);
  const { behavioral_signals } = result.intelligence_brief;

  assert.ok(Array.isArray(behavioral_signals));
});

test('brief scaffold: should have corporate_structure with all keys', () => {
  const result = synthesize(t04.ownership, t04.revenueByCompany, t04.parentAnchor);
  const { corporate_structure } = result.intelligence_brief;

  assert.ok('ascii_tree' in corporate_structure);
  assert.ok('ownership_clarity' in corporate_structure);
  assert.ok('history_note' in corporate_structure);
});

test('brief scaffold: should not break existing synthesis output', () => {
  const result = synthesize(t04.ownership, t04.revenueByCompany, t04.parentAnchor);

  assert.ok(result.focal_company, 'focal_company missing');
  assert.ok(result.ownership_tree, 'ownership_tree missing');
  assert.ok(result.positioning_analysis, 'positioning_analysis missing');
});
