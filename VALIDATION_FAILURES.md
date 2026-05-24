# Validation Failures — Test Case Results

Log de PDFs reales que fallan validation testing. Permite trazar regresiones conforme se commitean fixes en app.jsx.

---

## Test Case: T20 Hulu (2025-05-24)

**Status:** FAILING (9 problems, 3 achievements)

**Branch tested:** `claude/stoic-wozniak-847dt` @ SVG export implementation  
**API key:** Present (web_search enabled)  
**PDF generated:** `Hulu-ownership-report.pdf`

---

## Problem Matrix

| # | Problem | Severity | Category | Issue Ref | Root Cause | Fix Location |
|---|---------|----------|----------|-----------|-----------|--------------|
| 1 | Segment label confusion ("Direct-to-Consumer Streaming Services" vs "Entertainment") | **HIGH** | Rendering + SYSTEM_PROMPT | New (Phrase confusion) | Agente confundió "Disney Entertainment" division + "Direct-to-Consumer Streaming Services" unit con "Entertainment" segment oficial del 10-K | `SYSTEM_PROMPT` revenue inference rules (`:23-73`) + PDF rendering ownership hierarchy (`:2901-2978`) |
| 2 | Chain inconsistency Disney Streaming $88.9B > Disney Entertainment $40.63B (flagged but unresolved) | **HIGH** | #1 (chain normalization) | #1 | Las dos layers intermedias inventadas/duplicadas; "Disney Streaming" $88B no es entity real. El PDF flagged la inconsistency pero no resuelve cuál eliminar. | `SYSTEM_PROMPT` Issue #1 block (entity deduplication rules) + `Reconciliation` section rendering (`:2901-2978`) |
| 7 | Likely_causes wrong (cita Sports/Experiences cuando gap está dentro Entertainment) | **HIGH** | Reconciliation logic | #7 | Agente citó segments irrelevantes en lugar de identifying uncaptured products dentro del mismo segment (ESPN linear, ABC affiliate fees, FX, National Geographic, Disney Channel, etc.) | `SYSTEM_PROMPT` reconciliation block Issue #7 (`:99-108`) + likely_causes prompt rule (`:70-75` synthesis) |
| 8 | Revenue Cascade denominators confundidos | **HIGH** | Renderer / PDF generation | New (Math error) | Tres números sin coherencia: parent $88.9B (fiction), segment $40.63B (correcto), focal $11.6B (correcto). Porcentajes computados contra denominadores equivocados. | PDF rendering revenue cascade section (`:2901-2978`), línea donde se calcula `coverage_pct` |
| 9 | Risk Assessment subestimado (MEDIUM cuando HIGH) | **MEDIUM** | Risk scoring logic | New (Logic) | Agente identifica inconsistencies pero no escalona risk en consecuencia. Hulu PDF tiene chain inconsistency + likely_causes wrong + label confusion → risk debe ser HIGH. | `SYSTEM_PROMPT` risk assessment block (end of synthesis phase) + PDF rendering (`:2977-2978`) |
| 3 | Disney+ como sibling de Hulu (cuando son co-products) | **MEDIUM** | Sibling discovery logic | New (Semantic) | Falla en detectar que Disney+ y Hulu comparten CEO (Joe Earley, President DTC). Son producto-hermanos del mismo unit, no competidores/siblings. | `SYSTEM_PROMPT` sibling discovery rules (`:40-50`) + sibling filter logic (`:1083-1099` renderer) |
| 4 | Pixar/Walt Disney Animation sin revenue en cousins | **MEDIUM** | #10 (new category) | #10 | Extensión de Issue #10. Siblings/cousins sin `revenue_estimate.central`. Renderer no distingue "data_missing" de "$0". | NodeCard rendering (`:397-450`) + cousins section renderer (`:1120-1150`) |
| 5 | Acquisition history reduce 16 años JV a "acquired 2023" | **MEDIUM** | #2 (acquisition history) | #2 | Agente omitió JV context (News Corp/NBC/Disney 2007 → Disney 67% 2019 → Disney 100% 2023). Reportó solo deal final sin capturar historia. | `SYSTEM_PROMPT` acquisition block (Issue #6, `:152-160`) + NodeCard acquisition display (`:447-452`) |
| 6 | Hulu leadership post-2013 missing (10+ years gap) | **LOW** | #11 (new category) | #11 | Agente pasó de founders históricos (Jason Kilar ← 2013) a Joe Earley (parent level), sin documentar liderazgo de producto intermedio. | `SYSTEM_PROMPT` strategic_control section (Issue #5, `:110-115`) + NodeCard strategic_control display (`:462-480`) |

---

## Problem Details

### #1: Segment Label Confusion

**PDF Evidence:**
- Page 1: "Hulu is owned by Disney Streaming, in its Direct-to-Consumer Streaming Services segment"
- Page 2-3: Revenue panel says "Direct-to-Consumer Streaming **$40.63B SEGMENT**"
- Page 5 (Reconciliation): References "Entertainment' segment (2023 10-K)" which is the ACTUAL segment
- **Contradiction:** Executive summary cites one label; reconciliation cites correct label; but neither explains why there are two labels for the same concept.

**Root Cause:**
Agente confundió:
- "Disney Entertainment" (corporate division name, not same as segment)
- "Direct-to-Consumer Streaming Services" (business unit within Disney Entertainment)
- "Entertainment" (official 10-K segment containing both Disney+ and Hulu)

**Fix Strategy:**
1. SYSTEM_PROMPT: When discovering parent segment, **verify segment name against 10-K filing** before using. If agente infers a non-standard label (like "Direct-to-Consumer Streaming Services"), cross-check against official segment names.
2. Schema: Add `segment_name_source: "10-K"|"inferred"|"legacy_name"` to track which label is authoritative.
3. Renderer: If multiple labels exist for same entity, pick authoritative one (10-K > inferred > legacy).

**Test Verification:**
Re-run Hulu with SYSTEM_PROMPT fix. Expected: "Hulu is owned by Disney Streaming, in its **Entertainment** segment ($40.63B from 2023 10-K)" — single label, consistent across pages.

---

### #2: Chain Inconsistency (Disney Streaming $88.9B > Disney Entertainment $40.63B)

**PDF Evidence:**
- Page 1-2: "The Walt Disney Company → Disney Entertainment → Disney Streaming → Hulu"
- Disney Streaming: $88.90B (claimed revenue)
- Disney Entertainment: $40.63B (official 10-K segment)
- **Violation:** Child > Parent. PDF flags this on Page 4 ("Revenue consistency: Disney Streaming > Disney Entertainment — a subsidiary cannot out-earn its owner") but leaves both numbers in the chain.

**Root Cause:**
"Disney Streaming" is not a real entity with $88B revenue. Agente probably:
1. Confused total Alphabet/Disney (~$88-91B) with a "streaming" division
2. Or duplicated the parent's revenue into an intermediate layer

The two intermediate layers (Disney Entertainment + Disney Streaming) should collapse into one.

**Fix Strategy:**
1. SYSTEM_PROMPT Issue #1 (chain normalization): Add rule: **"If sum(children.central) ≈ parent.central AND no additional revenue sources in parent, mark parent as `redundant_alias: true`."**
2. Synthesis: Flag which entity is redundant + recommend collapsing.
3. Renderer: Show both entities but mark redundant with badge "(likely duplicate of parent)".
4. **HARD CONSTRAINT:** Never persist child > parent in output without `requires_review: true`.

**Test Verification:**
Re-run Hulu. Expected chain: "The Walt Disney Company ($307B) → Disney Entertainment ($40.63B)" — Disney Streaming layer removed or collapsed, marked as redundant.

---

### #7: Likely_Causes Wrong

**PDF Evidence:**
- Page 5 (Reconciliation): "Likely causes of the gap. Parent reports revenue lines not attributable to the captured brands. Parent filing has 2 segment(s) not matched to any captured brand: **Sports, Experiences**."
- **Reality:** Sports and Experiences are DIFFERENT segments, not part of Entertainment segment where Hulu lives. The gap (focal $11.6B + siblings $25.05B = $36.65B vs. Entertainment segment $40.63B) comes from:
  - ESPN linear/broadcast (captured as "ESPN" sibling but massive revenue not in Entertainment segment — live sports broadcasting is separate)
  - ABC linear/affiliate fees (captured as cousin but contributes to Entertainment)
  - FX linear networks
  - National Geographic networks
  - Disney Channel
  - International streaming variants

**Root Cause:**
Agente cited segments that are OUTSIDE the focal segment (correctly excluded) as explanation for gap WITHIN the focal segment. This is backwards logic.

**Fix Strategy:**
1. SYSTEM_PROMPT reconciliation block (Issue #7): Rewrite rule to **enumerate uncaptured products WITHIN the focal segment**, not cite other segments.
2. Ask specifically: "If focal's parent segment is Entertainment, list ALL Entertainment-attributed revenue lines (including Disney Channel, FX, ABC broadcast, National Geographic) that are NOT captured in focal + siblings."
3. Likely_causes should be: "Entertainment segment includes linear networks (FX, ABC affiliate fees, National Geographic), Disney Channel, and international variants not fully captured in Hulu estimate."

**Test Verification:**
Re-run Hulu. Expected: Reconciliation section cites specific uncaptured PRODUCTS (ESPN linear, ABC broadcast, etc.) within Entertainment, not unrelated segments.

---

### #8: Revenue Cascade Denominators Confundidos

**PDF Evidence:**
- Page 3: "Disney Streaming $88.90B PARENT · 100% → Direct-to-Consumer Streami... $40.63B SEGMENT · 45.7% → Hulu $11.60B FOCAL · 13.0%"
- **Math check:** $40.63B / $88.9B = 45.7% ✓ (correct computation of wrong numbers)
- **Problem:** $88.9B is not a real parent figure; $40.63B is segment, not parent entity revenue
- **Result:** The percentages are computed against the wrong baseline, making visual comparison meaningless

**Root Cause:**
Renderer is faithfully computing ratios from (fictional Disney Streaming $88.9B → real segment $40.63B → real focal $11.6B), but the denominators are mismatched (one is fictional, one is segment, one is entity).

**Fix Strategy:**
1. Before rendering Revenue Cascade, **validate coherence** of the chain.
2. Rule: If parent.central is suspected to be duplicate/fictional (via Issue #1 deduplication), use parent.parent.central as denominator instead.
3. Renderer: If denominators are incoherent (one from segment, one from entity, one from inferred), show a warning: "⚠ Parent revenue chain may be inconsistent — see Reconciliation."

**Test Verification:**
Re-run Hulu with Issue #1 fix. Expected: "Alphabet $307.4B (100%) → Disney Entertainment $40.63B (13.2%) → Hulu $11.6B (28.5%)" — consistent chain, realistic percentages.

---

### #9: Risk Assessment Subestimado

**PDF Evidence:**
- Page 4: "OVERALL RISK GRADE MEDIUM"
- But the PDF simultaneously shows:
  - Chain inconsistency (child > parent)
  - Segment label confusion
  - Likely_causes incomplete/wrong
  - 38% unexplained gap in reconciliation

**Root Cause:**
Risk assessment logic doesn't escalate based on combination of issues. Individual checks pass (e.g., "inconsistency detected ✓") but overall risk remains MEDIUM instead of aggregating to HIGH.

**Fix Strategy:**
1. SYSTEM_PROMPT: Add risk aggregation rule at synthesis end: **"If any of: (child > parent), (likely_causes incomplete), (segment label mismatch), (gap > 30%) → risk = HIGH. If ≥2 of above → risk = HIGH."**
2. Renderer: Show risk factors breakdown so user can see WHY risk is HIGH, not just the grade.

**Test Verification:**
Re-run Hulu. Expected: "OVERALL RISK GRADE HIGH" with explanatory factors listed.

---

### #3: Disney+ as Sibling of Hulu

**PDF Evidence:**
- Page 2-3: Siblings list shows Disney+ $10.80B ranked #2 after Hulu $11.60B
- **Problem:** Disney+ and Hulu are not competitors; they are co-products of the same Direct-to-Consumer Streaming business unit, both led by Joe Earley (President DTC).

**Root Cause:**
Sibling discovery logic uses corporate taxonomy (both are Disney products) but misses **shared executive ownership**. They should be flagged as "co-products of same unit" or `related_products: true`, not as siblings in competitive ranking.

**Fix Strategy:**
1. SYSTEM_PROMPT: Extend sibling discovery rule: **"If two entities share the same direct manager/CEO, mark as `shared_leadership: true` and note in positioning_analysis as 'co-products of X unit' rather than competitors."**
2. Renderer: Show shared-leadership entities grouped together with a note "Co-products under [CEO name]" rather than ranked as siblings.

**Test Verification:**
Re-run Hulu. Expected: Disney+ appears in positioning analysis as "co-product with Hulu under Joe Earley, President DTC" NOT as sibling in competitive ranking.

---

### #4: Pixar/Walt Disney Animation Without Revenue in Cousins

**PDF Evidence:**
- Page 4: Cousins include "Pixar" and "Walt Disney Animation Studios" with revenue shown as "—" (missing)

**Root Cause:**
Issue #10: Renderer doesn't distinguish between "data_missing: true" (revenue estimation failed) and "$0 revenue" (entity has zero revenue). Both render as "—".

**Fix Strategy:**
1. Schema: Add `revenue_data_quality: "audited"|"estimated"|"missing"|"zero"` to each revenue_estimate.
2. If central is null, check reason_for_null: if "estimation failed" → mark as data_missing; if "entity has no independent revenue" → mark as zero.
3. Renderer: Show "—" for missing, "$0" for zero, with tooltip explaining difference.

**Test Verification:**
Re-run Hulu. Expected: Pixar/WDAS show "— (data not available)" not ambiguous "—".

---

### #5: Acquisition History Reduces 16-Year JV to "Acquired 2023"

**PDF Evidence:**
- Page 2: "Hulu acquired by The Walt Disney Company for $8.61 billion (minimum) (all cash) (2023)"

**Reality:**
- 2007: Hulu founded as JV (News Corp + NBC + Disney each ~33%)
- 2019: Disney acquires Fox's 33% + NBC's 33% (Disney now 67%)
- 2023: Disney acquires Comcast's 33% (Disney now 100%)

The $8.61B deal in 2023 was consolidation of minority stake, not acquisition of Hulu.

**Root Cause:**
Agente captured only the most recent deal (2023) without context of prior ownership transitions. Issue #2 (acquisition history) needs extension to capture JV → majority → 100% progression.

**Fix Strategy:**
1. SYSTEM_PROMPT Issue #2: If focal entity had JV period, capture all ownership milestones: `acquisition_history: [{"year": int, "event": "founded_as_jv"|"majority_stake"|"consolidation"|..., "participants": [{"company": str, "stake": pct}], "price_usd": int | null}]`
2. Renderer: Show full ownership timeline, not just final acquisition.

**Test Verification:**
Re-run Hulu. Expected: Acquisition section shows:
```
2007: Founded as JV (News Corp 33%, NBC 33%, Disney 33%)
2019: Disney acquires Fox/NBC stakes (67% for ~$71B Fox deal)
2023: Disney consolidates Comcast stake (100% for $8.61B)
```

---

### #6: Hulu Leadership Post-2013 Missing

**PDF Evidence:**
- Page 5 (Strategic Control): Lists Jason Kilar, Beth Comstock as founders, then jumps to Joe Earley (President DTC, parent level). Gap of 10+ years without CEO/leadership.

**Root Cause:**
Issue #11 (new): If `strategic_control` contains historical founders but focal is 10+ generations descendant, capture current leadership at each layer. Agente didn't distinguish historical vs. current.

**Fix Strategy:**
1. SYSTEM_PROMPT: Add rule **"For each entity in chain, capture current leadership title + year assumed (sourced from web_search). If leader is historical, mark with year range. If gap > 5 years, flag as `leadership_gap: true`."**
2. Schema: `strategic_control: [{"name": str, "title": str, "years": "YYYY-YYYY"|"YYYY-present", "is_historical": bool}]`
3. Renderer: Show leadership timeline, flag gaps.

**Test Verification:**
Re-run Hulu. Expected: Strategic Control section shows:
```
Founders (2007): Jason Kilar, Beth Comstock
Hulu CEO (2013-2019): Mike Hopkins
Hulu CEO (2019-2022): Randy Freer
Hulu President (2022-present): Joe Earley [Parent level, shared with Disney+]
```

---

## Achievements Confirmed Working

✅ **Cousin sub-categorization by division** (Issue #4 feature)  
- "Disney Entertainment Television" (ABC, FX, National Geographic) rendered correctly
- "Walt Disney Studios" (20th Century, Marvel, Lucasfilm) rendered correctly
- Grouped by `via_label` in PDF
- **Status:** Working as designed

✅ **Consistency check logic flagged child > parent**  
- Correctly identified Disney Streaming $88.9B > Disney Entertainment $40.63B
- Rendered flag on Page 4: "Revenue consistency: Disney Streaming > Disney Entertainment"
- **Status:** Logic works; renderer doesn't resolve

✅ **Signals evidence matrix visualization**  
- Table format with source/type/label/value/weight columns
- Clear, readable in PDF
- **Status:** Working as designed

---

## Fix Priority Roadmap

**CRITICAL (blocks credibility):**
1. Issue #1: Entity deduplication (Disney Streaming fictitious layer)
2. Issue #7: Likely_causes accuracy (reconciliation explanation)

**HIGH (data integrity):**
3. #8: Revenue Cascade denominator coherence (math consistency)
4. #9: Risk assessment escalation (confidence grade)

**MEDIUM (semantic clarity):**
5. #3: Sibling discovery + shared leadership
6. #4: Revenue data_missing vs. zero distinction

**LOW (metadata):**
7. #5: Acquisition history JV progression
8. #6: Leadership gaps in chain

---

## Regression Test Protocol

Before committing fixes, re-run Hulu PDF generation and verify:
- [ ] Disney Streaming layer eliminated or marked redundant
- [ ] Segment label consistent across all pages
- [ ] Likely_causes cites uncaptured products within segment
- [ ] Revenue Cascade percentages recomputed coherently
- [ ] Risk grade HIGH with factor breakdown
- [ ] Disney+ marked as co-product, not sibling
- [ ] Pixar revenue shows "— (missing)" not ambiguous "—"
- [ ] Acquisition shows 2007 JV + 2019 majority + 2023 consolidation
- [ ] Strategic Control shows leadership timeline with gaps noted

---

## Next Test Case to Validate

- **T17 Call of Duty** (Microsoft, gaming): Tests Issue #3 (segments panel), #4 (cousins), #5 (child ≤ parent), #7 (reconciliation)
- **T18 GEICO** (conglomerate, 29% coverage): Tests Issue #7 (likely_causes on high gaps)
- **T16 Patagonia** (co-ownership): Tests Issue #2 (multi-owner JV)
