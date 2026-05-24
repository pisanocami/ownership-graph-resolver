# Bug Reports and Known Issues

## Bug #2: Co-owners Visual Distinction

**Status:** Identified and documented

**Location:** `app.jsx` lines 2392-2460 (`CoOwnersSection` component)

**Description:**

The co-owners section displays additional ownership information beyond the consolidating parent, but the visual hierarchy and distinction between different ownership roles and entity types could be clearer.

**Current Implementation:**

- `coOwnerRoleMeta()` function (lines 2395-2407) generates distinct icons and tone classes based on:
  - Entity type: trust (§), nonprofit (✦), government (⌘), family_group (◈), individual (◉)
  - Ownership role: voting (⚖ warning tone), economic ($), JV (⇄)
  - Default: • (neutral tone)

**Problem:**

1. **Icon visibility**: While icons are assigned, they may not be visually distinct enough in the co-owner list
2. **Tone inconsistency**: Some roles use `chip-accent` (blue), some use `chip-warning` (yellow), some have no tone
3. **Layout**: The `.co-owner-parent` row has special styling but doesn't visually stand out enough from regular co-owner rows
4. **Chip clarity**: Multiple chips in `.co-owner-meta` don't clearly indicate which is the role vs. entity type

**Expected Behavior:**

- Each role/entity type should be immediately visually distinguishable (color, icon, badge style)
- Parent row should clearly stand out as "consolidating parent"
- Economic vs. voting stakes should be visually different
- Trust/nonprofit entities should be visually distinct from commercial entities

**Suggested Solutions:**

1. **Color-code by role**:
   - Voting control: Yellow/warning tone
   - Economic/beneficiary: Blue/accent tone
   - Trust: Purple or distinct color
   - Nonprofit: Green or distinct color
   - Individual: Gray or neutral

2. **Improve badges**:
   - Make role badge more prominent
   - Distinguish "consolidating parent" with distinct badge
   - Use different chip styles for roles vs. entity types

3. **Layout improvements**:
   - Add background color/highlight to parent row
   - Consider grouping by role type (all voting together, all economic together)

4. **CSS enhancements needed**:
   - Add color variants for each role type
   - Improve `.co-owner-parent` styling (currently in styles.css line 399)
   - Add role-specific chip classes (`.chip-voting`, `.chip-economic`, `.chip-trust`, etc.)

**Implementation Status:**

- [x] Bug identified and documented
- [ ] CSS color variants created
- [ ] Visual refinement completed
- [ ] Testing across roles

---

## Bug #4: UBO Type Badge Labels

**Status:** Tracked

**Location:** `app.jsx` lines 2462-2476 (`uboTypeMeta` function)

**Description:**

Ultimate Beneficial Owner (UBO) type badges need clear labeling and tooltips for:
- Family group UBOs
- Individual UBOs
- Trust/foundation/nonprofit UBOs
- Sovereign wealth fund UBOs

**Current Status:** Function exists but integration into UI components may need review.

---

## Future Improvements

- [ ] Storybook component library
- [ ] Accessibility audit (WCAG 2.1 AA)
- [ ] Animation standards documentation
- [ ] Shadow/depth system refinement
- [ ] Co-owners visual refinement (Bug #2)
