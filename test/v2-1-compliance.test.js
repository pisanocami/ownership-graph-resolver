// V2.1 Perfect-Brief compliance suite (Task #58)
// Cross-cuts the deterministic invariants every brief must satisfy after
// running synthesize() on a fixture, regardless of LLM enrichment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { synthesize } from '../synth.js';
import { sanitizeForPdf } from '../brief.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, 'fixtures');
const fixtures = readdirSync(fixturesDir).filter((f) => f.endsWith('.json'));

const load = (f) => JSON.parse(readFileSync(join(fixturesDir, f), 'utf8'));

function isOwnershipFixture(obj) {
  return obj && typeof obj === 'object' && typeof obj.company === 'string';
}

fixtures.forEach((file) => {
  const raw = load(file);
  if (!isOwnershipFixture(raw)) return;
  test(`V2.1 compliance · ${file}`, () => {
    const out = synthesize(raw, {}, null, {});
    const b = out.intelligence_brief;

    // P1.04 — capital_path_summary must be a non-empty string.
    assert.equal(typeof b.verdict.capital_path_summary, 'string');
    assert.ok(b.verdict.capital_path_summary.length > 0, 'capital_path_summary empty');

    // P7.03 — verdict_changer_map is an array (may be empty when fully actionable).
    assert.ok(Array.isArray(b.verdict.verdict_changer_map));

    // P5.05 — actionable_reads has at least one entry with audience+read.
    assert.ok(Array.isArray(b.mispricing.actionable_reads));
    assert.ok(b.mispricing.actionable_reads.length >= 1);
    assert.ok(b.mispricing.actionable_reads.every((r) => r.audience && r.read));

    // P7.01 — confidence_buckets has high/medium/low arrays.
    assert.ok(b.confidence_buckets);
    assert.ok(Array.isArray(b.confidence_buckets.high));
    assert.ok(Array.isArray(b.confidence_buckets.medium));
    assert.ok(Array.isArray(b.confidence_buckets.low));

    // P9.04 — section_confidence covers the six expected sections.
    const sc = b.section_confidence;
    ['verdict', 'behavioral_signals', 'corporate_structure', 'reconciliation', 'mispricing', 'competitive_context']
      .forEach((k) => assert.ok(sc[k] && sc[k].stars, `section_confidence.${k} missing`));

    // P9.03 — limitations_list is an array.
    assert.ok(Array.isArray(b.limitations_list));

    // P9.01 — data_trace has primary_used + excluded_with_reason arrays.
    assert.ok(Array.isArray(b.data_trace.primary_used));
    assert.ok(Array.isArray(b.data_trace.excluded_with_reason));

    // P7.02 — known_gaps_starred is an array of {gap, stars 1–3}.
    assert.ok(Array.isArray(b.confidence_gaps.known_gaps_starred));
    b.confidence_gaps.known_gaps_starred.forEach((g) => {
      assert.ok(g.gap);
      assert.ok(g.stars >= 1 && g.stars <= 3);
    });

    // X.01 — siblings each carry a variant_type when present.
    if (Array.isArray(out.ownership_tree.siblings)) {
      out.ownership_tree.siblings.forEach((s) => {
        assert.ok(['geographic_variant', 'product_tier', 'distinct'].includes(s.variant_type), `sibling ${s.company} missing variant_type`);
      });
    }

    // R.02 — sanitizer is idempotent on already-clean ASCII strings.
    const summary = b.verdict.capital_path_summary;
    assert.equal(sanitizeForPdf(summary), sanitizeForPdf(sanitizeForPdf(summary)));
  });
});
