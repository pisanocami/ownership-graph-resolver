# Ownership Resolver UI — Implementation Status & TODO

**Last Updated:** 2026-05-24  
**Current Branch:** `test` (merged from `claude/cool-bell-i5r9p`)  
**Status:** Phase 2 complete, Phases 3-7 remaining

---

## ✅ COMPLETED (Phases 1-2)

### Phase 1: Sidebar + History List Refactor
- ✅ CSS foundation (styles.css): sidebar layout, responsive breakpoints, new component classes
- ✅ Sidebar component with fixed 280px width
- ✅ History list moved to sidebar
- ✅ Sidebar responsive: hidden at 960px, drawer appears on mobile with hamburger toggle
- ✅ New Investigation form in sidebar (brand + context inputs)
- ✅ Provider/model selector in sidebar
- ✅ Stepper component displays in sidebar
- ✅ Export section placeholder in sidebar

### Phase 2: Mode Toggle & Sub-Navigation
- ✅ Mode state management (investigate | brief)
- ✅ Mode toggle buttons in investigation header card
- ✅ Sub-nav tabs (Investigate: Tree/Signals/Recon/JSON; Brief: Verdict/Signals/Mispricing/Competitive/Confidence)
- ✅ URL routing with hash-based navigation (#i/{brand}/{mode}/{subNav})
- ✅ Conditional rendering for Investigate vs Brief modes
- ✅ Tree view renders within Investigate/tree tab
- ✅ JSON view renders within Investigate/json tab
- ✅ Brief mode placeholder
- ✅ Mobile drawer with proper click handling
- ✅ Example cards auto-trigger investigation

---

## ❌ TODO (Phases 3-7)

### Phase 3: Signals & Recon Views (NEXT)

#### Signals Tab (Investigate mode)
**Purpose:** Flat list of all behavioral signals captured across all entities in the ownership tree.

**Data Source:** `result.ownership_tree` (recursively extract all nodes) + signals found in each node  
**Files to modify:** `app.jsx` (new SignalsView component)

**What to display:**
1. Flat table/list showing:
   - Entity name (company)
   - Signal type (e.g., "equity_stake", "board_member", "investor", "control_mechanism")
   - Signal value (e.g., "21% equity", "Jane Doe", "Series C led by Benchmark")
   - Confidence (high/medium/low)
   - Source URL (clickable link)
   - Layer/context (where in the tree: parent, sibling, child, etc.)

2. Make it sortable/filterable by:
   - Signal type
   - Entity name
   - Confidence level

**Data extraction logic:**
```javascript
function extractAllSignals(tree) {
  const signals = [];
  
  function walk(node, parentName = null) {
    if (!node) return;
    
    // Strategic control signals
    if (node.strategic_control && Array.isArray(node.strategic_control)) {
      node.strategic_control.forEach(sc => {
        signals.push({
          entity: node.company,
          type: sc.relationship, // board_member, investor, pe_backer, etc.
          value: sc.entity,
          details: sc.details,
          confidence: node.confidence,
          sourceUrl: sc.source_url,
          context: 'strategic_control'
        });
      });
    }
    
    // Ownership relationships (parent, siblings, children)
    if (node.parent) {
      signals.push({
        entity: node.company,
        type: 'parent',
        value: node.parent.company,
        confidence: node.confidence,
        context: 'ownership'
      });
    }
    
    // Co-owners (from positioning_analysis or node data)
    if (node.co_owners && Array.isArray(node.co_owners)) {
      node.co_owners.forEach(co => {
        signals.push({
          entity: node.company,
          type: 'co_owner',
          value: co.company,
          stake: co.stake,
          confidence: node.confidence,
          context: 'ownership'
        });
      });
    }
    
    // Recurse through tree
    if (node.children && Array.isArray(node.children)) {
      node.children.forEach(child => walk(child, node.company));
    }
    if (node.siblings && Array.isArray(node.siblings)) {
      node.siblings.forEach(sibling => walk(sibling, parentName));
    }
  }
  
  walk(tree);
  return signals;
}
```

**Component structure:**
```jsx
function SignalsView({ tree, positioning }) {
  const signals = useMemo(() => extractAllSignals(tree), [tree]);
  const [filterType, setFilterType] = useState('all');
  const [sortBy, setSortBy] = useState('entity');
  
  const filtered = signals.filter(s => 
    filterType === 'all' || s.type === filterType
  );
  
  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === 'entity') return a.entity.localeCompare(b.entity);
    if (sortBy === 'confidence') {
      const confRank = { high: 0, medium: 1, low: 2 };
      return confRank[a.confidence] - confRank[b.confidence];
    }
    return 0;
  });
  
  return (
    <div>
      <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
        <select value={filterType} onChange={e => setFilterType(e.target.value)}>
          <option value="all">All signal types</option>
          <option value="parent">Parent</option>
          <option value="board_member">Board member</option>
          <option value="investor">Investor</option>
          <option value="pe_backer">PE backer</option>
          {/* etc */}
        </select>
        <select value={sortBy} onChange={e => setSortBy(e.target.value)}>
          <option value="entity">By entity</option>
          <option value="confidence">By confidence</option>
        </select>
      </div>
      
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border)' }}>
            <th style={{ textAlign: 'left', padding: '8px', fontWeight: 600 }}>Entity</th>
            <th style={{ textAlign: 'left', padding: '8px', fontWeight: 600 }}>Signal Type</th>
            <th style={{ textAlign: 'left', padding: '8px', fontWeight: 600 }}>Value</th>
            <th style={{ textAlign: 'left', padding: '8px', fontWeight: 600 }}>Confidence</th>
            <th style={{ textAlign: 'left', padding: '8px', fontWeight: 600 }}>Source</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((signal, i) => (
            <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
              <td style={{ padding: '8px', fontSize: 13 }}>{signal.entity}</td>
              <td style={{ padding: '8px', fontSize: 13 }}>{signal.type}</td>
              <td style={{ padding: '8px', fontSize: 13 }}>{signal.value}</td>
              <td style={{ padding: '8px', fontSize: 13 }}>
                <span className={`confidence-dot confidence-${signal.confidence}`} />
              </td>
              <td style={{ padding: '8px', fontSize: 13 }}>
                {signal.sourceUrl ? (
                  <a href={signal.sourceUrl} target="_blank" rel="noopener noreferrer">
                    🔗 source
                  </a>
                ) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

---

#### Recon Tab (Investigate mode)
**Purpose:** Full reconciliation math showing focal entity revenue vs sum of components.

**Data Source:** `result.positioning_analysis.reconciliation` + `result.positioning_analysis.parent_anchor`

**What to display:**
1. **Header metric:** Coverage ratio (e.g., "68% coverage" with visual bar)
2. **Reconciliation table:**
   - Focal entity revenue estimate
   - Sum of siblings revenue
   - Sum of children revenue
   - Expected total (parent's disclosed revenue if public)
   - Gap/difference
   - Percentage gap

3. **Breakdown of gap causes:**
   - "Parent has other operating units not in this tree" (if parent is conglomerate)
   - "Some siblings/children revenue not disclosed"
   - "Exchange rate/consolidation differences"
   - "Circular or indirect ownership detected"
   - etc.

4. **Visual elements:**
   - Stacked bar chart showing focal + siblings + children vs parent total
   - Color coding for confidence levels
   - Tooltips on hover showing source assumptions

**Component structure:**
```jsx
function ReconView({ tree, positioning }) {
  const recon = positioning.reconciliation || {};
  const anchor = positioning.parent_anchor || {};
  
  const focalRev = tree.revenue_estimate;
  const siblingsRev = (tree.siblings || []).reduce((sum, s) => sum + (s.revenue_estimate || 0), 0);
  const childrenRev = (tree.children || []).reduce((sum, c) => sum + (c.revenue_estimate || 0), 0);
  const parentDisclosed = anchor.revenue_estimate; // from 10-K if public
  
  const totalOurs = focalRev + siblingsRev + childrenRev;
  const gap = parentDisclosed ? parentDisclosed - totalOurs : null;
  const gapPct = gap && parentDisclosed ? (Math.abs(gap) / parentDisclosed * 100).toFixed(1) : null;
  
  return (
    <div>
      <div className="recon-header" style={{ marginBottom: 24 }}>
        <h3>Reconciliation: {tree.company} vs {tree.parent?.company}</h3>
        
        {parentDisclosed && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
              Coverage Ratio: {recon.ratio?.toFixed(2) || '?'}
            </div>
            <div style={{
              width: '100%',
              height: 24,
              background: 'var(--border)',
              borderRadius: 4,
              overflow: 'hidden',
              marginBottom: 8
            }}>
              <div style={{
                width: `${Math.min(100, (totalOurs / parentDisclosed) * 100)}%`,
                height: '100%',
                background: 'var(--accent)',
                transition: 'width 0.3s'
              }} />
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {formatUSD(totalOurs)} / {formatUSD(parentDisclosed)}
              {gapPct && <span style={{ marginLeft: 8 }}>{gapPct}% gap</span>}
            </div>
          </div>
        )}
      </div>
      
      <table style={{ width: '100%', marginBottom: 24 }}>
        <tbody>
          <tr style={{ borderBottom: '1px solid var(--border)' }}>
            <td style={{ padding: 8 }}>{tree.company} (focal)</td>
            <td style={{ padding: 8, textAlign: 'right', fontFamily: 'monospace' }}>
              {formatUSD(focalRev)}
            </td>
            <td style={{ padding: 8 }}>
              <span className={`chip confidence-${tree.confidence}`}>
                {tree.confidence}
              </span>
            </td>
          </tr>
          
          {siblingsRev > 0 && (
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              <td style={{ padding: 8 }}>Siblings ({tree.siblings?.length})</td>
              <td style={{ padding: 8, textAlign: 'right', fontFamily: 'monospace' }}>
                {formatUSD(siblingsRev)}
              </td>
              <td style={{ padding: 8 }}>—</td>
            </tr>
          )}
          
          {childrenRev > 0 && (
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              <td style={{ padding: 8 }}>Children ({tree.children?.length})</td>
              <td style={{ padding: 8, textAlign: 'right', fontFamily: 'monospace' }}>
                {formatUSD(childrenRev)}
              </td>
              <td style={{ padding: 8 }}>—</td>
            </tr>
          )}
          
          <tr style={{ borderBottom: '2px solid var(--border-strong)', fontWeight: 600 }}>
            <td style={{ padding: 8 }}>Our total estimate</td>
            <td style={{ padding: 8, textAlign: 'right', fontFamily: 'monospace' }}>
              {formatUSD(totalOurs)}
            </td>
            <td style={{ padding: 8 }}>—</td>
          </tr>
          
          {parentDisclosed && (
            <>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={{ padding: 8 }}>{tree.parent?.company} (parent disclosed)</td>
                <td style={{ padding: 8, textAlign: 'right', fontFamily: 'monospace' }}>
                  {formatUSD(parentDisclosed)}
                </td>
                <td style={{ padding: 8 }}>
                  <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                    10-K {anchor.fiscal_year}
                  </span>
                </td>
              </tr>
              
              <tr style={{ 
                background: gapPct && gapPct > 30 ? 'var(--warning-bg)' : 'var(--info-bg)',
                borderBottom: '1px solid var(--border)'
              }}>
                <td style={{ padding: 8, fontWeight: 600 }}>Gap</td>
                <td style={{ padding: 8, textAlign: 'right', fontFamily: 'monospace', fontWeight: 600 }}>
                  {formatUSD(gap)} ({gapPct}%)
                </td>
                <td style={{ padding: 8 }}>—</td>
              </tr>
            </>
          )}
        </tbody>
      </table>
      
      {recon.likely_causes && (
        <div className="recon-causes" style={{ marginTop: 16 }}>
          <h4>Likely causes of gap:</h4>
          <ul style={{ fontSize: 13, color: 'var(--text-muted)', paddingLeft: 20 }}>
            {recon.likely_causes.map((cause, i) => (
              <li key={i}>{cause}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
```

---

### Phase 4: Search + Filter Refinement
- Implement live search filtering in history list
- Add filter dropdowns (confidence, date)
- Add sort selector (recent, alphabetical, revenue, confidence)
- Test with 25+ items
- Compact visual list (1 line per item)
- Pinned items feature (optional)

### Phase 5: Mobile Drawer + Responsive Polish
- Ensure drawer opens/closes on mobile
- Touch-friendly button sizing (44px+ targets)
- Responsive typography adjustments
- Landscape mode support (optional pin drawer)

### Phase 6: Testing + Refinement
- Cross-browser testing (Chrome, Firefox, Safari)
- Performance testing (history list with 100+ items)
- Edge cases (long names, missing fields, stale state)
- Telemetry setup (mode-switch tracking)

### Phase 7: Deploy
- Feature flag setup (optional)
- Monitor mode-switch behavior
- Iterate based on Susan/Zach actual usage

---

## Current Code Structure

### Key Files Modified
1. **app.jsx** (~7500 lines)
   - App component with new state: mode, investigateSubNav, briefSubNav, mobileDrawerOpen, historySearch, historyFilters
   - Sidebar component (input form, history list, filters, exports)
   - EmptyState component (4 example cards)
   - ResultView updated with mode toggle + mode-specific rendering
   - URL routing with hash-based navigation
   - Placeholder views for Signals/Recon/Brief

2. **styles.css** (~700 lines)
   - New layout classes: .app-container, .sidebar, .main-content, .mobile-drawer, .hamburger-btn
   - Sidebar component styles: .history-search, .history-filters, .history-list, .history-row
   - Empty state styles: .empty-state, .example-card
   - Mode toggle + sub-nav styles: .mode-toggle, .sub-nav
   - Investigation header card styles: .investigation-header-card
   - Responsive breakpoints at 960px (sidebar ↔ drawer)

3. **server.js** (no changes needed)
   - Existing endpoints support new UI fine

---

## Data Access Patterns

### Where to get data for each view:

**Signals:**
- Strategic control: `tree.strategic_control[]` (from ownership resolution)
- Co-owners: `tree.co_owners[]` (multiple owners of same entity)
- Board members: extracted from `tree.strategic_control` where type='board_member'
- Investors: extracted from `tree.strategic_control` where type='investor'

**Recon:**
- Focal revenue: `tree.revenue_estimate`
- Siblings: `tree.siblings[].revenue_estimate`
- Children: `tree.children[].revenue_estimate`
- Parent disclosed revenue: `positioning_analysis.parent_anchor.revenue_estimate` (if public)
- Gap math: `positioning_analysis.reconciliation.ratio`, `pct_delta`, `circular`, `likely_causes`

**Brief (future):**
- Verdict: `result.intelligence_brief.verdict` (AI-generated)
- Behavioral signals: `result.intelligence_brief.behavioral_signals`
- Mispricing: `result.intelligence_brief.mispricing_hypothesis`
- Competitive: `result.intelligence_brief.competitive_context`
- Confidence: `result.intelligence_brief.confidence_assessment`
- Audiences: `result.intelligence_brief.audience_notes`

---

## Next Session Checklist

- [ ] Create SignalsView component (extract + display signals from tree)
- [ ] Create ReconView component (reconciliation math + gap analysis)
- [ ] Update app.jsx to render SignalsView when investigateSubNav === 'signals'
- [ ] Update app.jsx to render ReconView when investigateSubNav === 'recon'
- [ ] Test Signals tab with multi-level tree (should show all strategic_control + relationships)
- [ ] Test Recon tab with parent_anchor data (coverage ratio, gap causes)
- [ ] Push to test branch
- [ ] Create PR for review

---

## Testing Notes

**Current status:**
- ✅ App loads without errors
- ✅ Sidebar renders correctly (desktop + mobile drawer)
- ✅ Mode toggle switches Investigate ↔ Brief
- ✅ Sub-nav tabs appear/disappear based on mode
- ✅ Tree tab shows ownership structure
- ✅ JSON tab shows raw data
- ✅ Empty state + example cards work
- ✅ URL routing syncs with navigation
- ⚠️ Signals/Recon tabs show placeholders (need real content)
- ⚠️ Brief mode shows placeholder (future phase)

**Next test targets:**
1. Signals tab displays signals from real data
2. Recon tab shows coverage ratio and gap math
3. History filtering works with 25+ items
4. Mobile drawer closes after user actions
5. URL state persists across reload
