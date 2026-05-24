# Brief Mode Implementation Design — Phases 8-10

**Status:** Phase 3-5 complete (Investigate mode: Tree, Signals, Recon, JSON)  
**Next:** Implement Brief mode tabs (Verdict, Signals, Mispricing, Competitive, Confidence)  
**Reference Case:** Colgate-Palmolive Company (operating_brand)

---

## CONTEXT

**Current State:**
```
Colgate (operating_brand)
├─ Type: operating_brand · operational
├─ Owner: Colgate-Palmolive Company
├─ Confidence: high
└─ No children/siblings in this subset
```

**Brief mode goal:** Convert complex ownership tree + reconciliation + signals into **executive-friendly** 1-3 page summary, suitable for:
- Board presentations
- Investment theses
- Risk assessments
- Competitive intelligence briefs

**Data sources available:**
```javascript
result = {
  focal_company: {
    brand, domain, category, ...
  },
  ownership_tree: {
    company, domain, layer, confidence, revenue_estimate,
    strategic_control: [{entity, relationship, evidence, source_url}],
    parent, siblings, children,
    signals_found: [{type, label, value, weight, source}],
    ...
  },
  positioning_analysis: {
    reconciliation: {ratio, pct_delta, circular, likely_causes},
    parent_anchor: {company, revenue_estimate, fiscal_year},
    focal_vs_parent_ratio, focal_vs_siblings, growth_signals,
    behavioral_signals: [{...}],
    strategic_notes: ["...", "..."],
    confidence_assessment: {verdict, factors, risks}
  },
  intelligence_brief: {
    verdict: "...",
    behavioral_signals: "...",
    mispricing_hypothesis: "...",
    competitive_context: "...",
    confidence_assessment: {...},
    audience_notes: {...}
  }
}
```

---

## PHASE 8: BRIEF MODE — VERDICT TAB

### Responsibility
**Single authoritative statement + key facts** about the company's ownership and strategic position.

### Component Structure

```jsx
function BriefVerdictView({ tree, positioning, brief }) {
  // Extract key facts
  const verdict = brief?.verdict || "No verdict generated";
  const parent = tree.parent?.company || "Standalone";
  const confidence = tree.confidence;
  const layer = tree.layer;
  
  return (
    <div style={{ paddingBottom: 20 }}>
      {/* Headline verdict */}
      <section className="section">
        <div className="card" style={{ 
          padding: 20, 
          borderLeft: `4px solid ${confidenceColor(confidence)}`,
          background: confidenceBgColor(confidence)
        }}>
          <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-muted)', marginBottom: 8 }}>
            Verdict
          </div>
          <div style={{ fontSize: 18, fontWeight: 600, lineHeight: 1.6, color: 'var(--text)' }}>
            {verdict}
          </div>
        </div>
      </section>
      
      {/* Key facts grid */}
      <section className="section" style={{ marginTop: 16 }}>
        <div className="section-head">
          <span className="section-title">Key Facts</span>
        </div>
        <div style={{ 
          display: 'grid', 
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: 12
        }}>
          <div className="card" style={{ padding: 12 }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 6 }}>
              ENTITY TYPE
            </div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>
              {tree.node_type === 'legal_entity' ? 'Legal Entity' : 'Operating Brand'}
            </div>
          </div>
          
          <div className="card" style={{ padding: 12 }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 6 }}>
              PARENT COMPANY
            </div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>
              {parent === 'Standalone' ? '—' : parent}
            </div>
          </div>
          
          <div className="card" style={{ padding: 12 }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 6 }}>
              LAYER
            </div>
            <div style={{ fontSize: 13, fontWeight: 500, textTransform: 'capitalize' }}>
              {layer || 'unknown'}
            </div>
          </div>
          
          <div className="card" style={{ padding: 12 }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 6 }}>
              CONFIDENCE
            </div>
            <div style={{ fontSize: 13, fontWeight: 500, textTransform: 'capitalize' }}>
              <span className={`confidence-badge confidence-${confidence}`}>
                {confidence}
              </span>
            </div>
          </div>
        </div>
      </section>
      
      {/* Evidence summary */}
      {positioning?.positioning_notes?.length > 0 && (
        <section className="section" style={{ marginTop: 16 }}>
          <div className="section-head">
            <span className="section-title">Supporting Evidence</span>
          </div>
          <div className="card" style={{ padding: 12 }}>
            <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13 }}>
              {positioning.positioning_notes.slice(0, 5).map((note, i) => (
                <li key={i} style={{ marginBottom: 8, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                  {note}
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
    </div>
  );
}
```

### Data Extraction Logic

```javascript
function extractVerdictData(tree, positioning, brief) {
  const verdict = brief?.verdict || generateDefaultVerdict(tree, positioning);
  
  function generateDefaultVerdict(tree, positioning) {
    const parent = tree.parent?.company;
    const confidence = tree.confidence;
    const isStandalone = !parent;
    
    if (isStandalone) {
      return `${tree.company} is an independent ${tree.node_type === 'legal_entity' ? 'legal entity' : 'brand'} with no identified parent company.`;
    }
    
    if (confidence === 'high') {
      return `${tree.company} is a ${tree.layer || 'subsidiary'} of ${parent}, with high-confidence ownership verified through multiple sources.`;
    }
    
    if (confidence === 'medium') {
      return `${tree.company} appears to be owned by ${parent}, though some details require further verification.`;
    }
    
    return `${tree.company}'s ownership structure remains partially unclear; additional research may be needed.`;
  }
  
  return {
    verdict,
    parent: tree.parent?.company || 'Standalone',
    entityType: tree.node_type,
    layer: tree.layer,
    confidence: tree.confidence,
    notes: positioning?.strategic_notes || []
  };
}
```

### Testing (Phase 8)

- [ ] Verdict displays for all confidence levels (high/medium/low)
- [ ] Standalone companies show "—" for parent
- [ ] Key facts grid is responsive (1-col on mobile, 4-col on desktop)
- [ ] Evidence list limits to 5 items (no scroll)
- [ ] Colgate example loads and shows parent as "Colgate-Palmolive Company"
- [ ] Confidence badge color matches Investigate mode dot colors

---

## PHASE 9: BRIEF MODE — BEHAVIORAL SIGNALS + ANALYTICS TABS

### Responsibility
**Signals tab:** Condensed version of Investigate→Signals, highlighting top 5-10 signals.  
**Mispricing tab:** Reconciliation-driven analysis (gap explanation).  
**Competitive tab:** Competitive positioning relative to siblings.  
**Confidence tab:** Detailed assessment of data quality + risks.

### 9.1 Signals Tab

```jsx
function BriefSignalsView({ tree, positioning }) {
  const allSignals = useMemo(() => extractAllSignals(tree), [tree]);
  
  // Top signals: sort by weight/confidence, take top 10
  const topSignals = allSignals
    .filter(s => s.weight > 0.5 || s.confidence === 'high')
    .sort((a, b) => (b.weight || 0) - (a.weight || 0))
    .slice(0, 10);
  
  if (topSignals.length === 0) {
    return <div className="empty-state">No significant signals detected.</div>;
  }
  
  return (
    <div style={{ paddingBottom: 20 }}>
      <section className="section">
        <div className="section-head">
          <span className="section-title">Top Behavioral Signals ({topSignals.length})</span>
        </div>
        <div className="card">
          {topSignals.map((signal, i) => (
            <div
              key={i}
              style={{
                padding: 12,
                borderBottom: i < topSignals.length - 1 ? '1px solid var(--border)' : 'none',
                fontSize: 13
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 500, marginBottom: 4 }}>
                    <code style={{ background: 'var(--surface-2)', padding: '2px 6px', borderRadius: 3 }}>
                      {signal.type}
                    </code>
                  </div>
                  <div style={{ color: 'var(--text)', marginBottom: 4 }}>
                    {signal.value}
                  </div>
                  {signal.details && (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                      {signal.details}
                    </div>
                  )}
                </div>
                <div 
                  className={`confidence-dot confidence-${signal.confidence || 'unknown'}`}
                  style={{ marginLeft: 8, flexShrink: 0 }}
                  title={signal.confidence}
                />
              </div>
            </div>
          ))}
        </div>
      </section>
      
      {/* Interpretation */}
      <section className="section" style={{ marginTop: 16 }}>
        <div className="section-head">
          <span className="section-title">Signal Interpretation</span>
        </div>
        <div className="card" style={{ padding: 12, fontSize: 13, color: 'var(--text-muted)' }}>
          {topSignals.some(s => s.type === 'acquisition') && (
            <div style={{ marginBottom: 8 }}>
              • <strong>Acquisition signal:</strong> Entity has undergone M&A activity.
            </div>
          )}
          {topSignals.some(s => s.type === 'co_owner') && (
            <div style={{ marginBottom: 8 }}>
              • <strong>Co-ownership:</strong> Multiple entities hold stakes.
            </div>
          )}
          {topSignals.some(s => s.type === 'parent_relationship') && (
            <div style={{ marginBottom: 8 }}>
              • <strong>Parent relationship:</strong> Subsidiary of larger entity.
            </div>
          )}
          {topSignals.filter(s => s.context === 'strategic_control').length > 0 && (
            <div style={{ marginBottom: 8 }}>
              • <strong>Strategic control:</strong> Governance/control relationships beyond ownership.
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
```

### 9.2 Mispricing Tab

```jsx
function BriefMispricingView({ tree, positioning }) {
  const recon = positioning?.reconciliation || {};
  const anchor = positioning?.parent_anchor || {};
  
  const focalRev = tree.revenue_estimate?.central || 0;
  const parentDisclosed = anchor.revenue_estimate?.central;
  const gap = parentDisclosed ? parentDisclosed - focalRev : null;
  const gapPct = gap && parentDisclosed ? Math.abs(gap) / parentDisclosed * 100 : null;
  
  if (!gapPct || gapPct < 5) {
    return (
      <div className="card" style={{ padding: 16, textAlign: 'center', color: 'var(--text-muted)' }}>
        No significant revenue gap detected (coverage {((focalRev / parentDisclosed) * 100).toFixed(0)}%).
      </div>
    );
  }
  
  return (
    <div style={{ paddingBottom: 20 }}>
      <section className="section">
        <div className="section-head">
          <span className="section-title">Revenue Reconciliation Gap</span>
        </div>
        <div className="card" style={{ 
          padding: 16,
          background: gapPct > 30 ? 'var(--danger-bg)' : gapPct > 15 ? 'var(--warning-bg)' : 'var(--info-bg)'
        }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
            Reported parent revenue vs. our breakdown
          </div>
          <div style={{ fontSize: 20, fontWeight: 600, marginBottom: 12 }}>
            {gapPct > 0 ? '+' : ''}{gapPct.toFixed(1)}% gap ({formatUSD(Math.abs(gap))})
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            {gapPct > 30 && '⚠ Large gap suggests missing units or structural complexity'}
            {gapPct > 15 && gapPct <= 30 && '↳ Moderate gap — likely other segments not detailed here'}
            {gapPct <= 15 && '✓ Small gap — good coverage'}
          </div>
        </div>
      </section>
      
      {/* Likely causes */}
      {recon.likely_causes?.length > 0 && (
        <section className="section" style={{ marginTop: 16 }}>
          <div className="section-head">
            <span className="section-title">Likely Causes</span>
          </div>
          <div className="card" style={{ padding: 12 }}>
            <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13 }}>
              {recon.likely_causes.map((cause, i) => (
                <li key={i} style={{ marginBottom: 6, color: 'var(--text-muted)' }}>
                  {cause}
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
    </div>
  );
}
```

### 9.3 Competitive Tab

```jsx
function BriefCompetitiveView({ tree, positioning }) {
  const siblings = tree.siblings || [];
  const siblingsRev = siblings.map(s => ({
    company: s.company,
    revenue: s.revenue_estimate?.central || 0,
    confidence: s.confidence
  }));
  
  const totalRev = (tree.revenue_estimate?.central || 0) + 
                   siblingsRev.reduce((sum, s) => sum + s.revenue, 0);
  
  const focal = {
    company: tree.company,
    revenue: tree.revenue_estimate?.central || 0,
    share: totalRev ? ((tree.revenue_estimate?.central || 0) / totalRev * 100).toFixed(1) : '?'
  };
  
  return (
    <div style={{ paddingBottom: 20 }}>
      <section className="section">
        <div className="section-head">
          <span className="section-title">Position Among Siblings</span>
        </div>
        
        {siblings.length === 0 ? (
          <div className="card" style={{ padding: 12, color: 'var(--text-muted)', fontSize: 13 }}>
            No sibling companies identified.
          </div>
        ) : (
          <>
            {/* Share chart */}
            <div className="card" style={{ padding: 12, marginBottom: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 10 }}>
                Revenue distribution across sibling group
              </div>
              {/* Simple bar chart */}
              <div style={{ display: 'flex', gap: 8, height: 40, alignItems: 'flex-end' }}>
                {[focal, ...siblingsRev]
                  .sort((a, b) => b.revenue - a.revenue)
                  .map((item, i) => {
                    const height = totalRev ? (item.revenue / totalRev) * 100 : 0;
                    return (
                      <div
                        key={i}
                        style={{
                          flex: 1,
                          height: `${Math.max(20, height)}%`,
                          background: item.company === focal.company ? 'var(--accent)' : 'var(--surface-2)',
                          borderRadius: 4,
                          minHeight: 4
                        }}
                        title={`${item.company}: ${formatUSD(item.revenue)}`}
                      />
                    );
                  })}
              </div>
            </div>
            
            {/* Table */}
            <div className="card">
              <table style={{ width: '100%', fontSize: 12 }}>
                <thead style={{ borderBottom: '1px solid var(--border)' }}>
                  <tr>
                    <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600 }}>Brand</th>
                    <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600 }}>Revenue</th>
                    <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600 }}>% of Group</th>
                  </tr>
                </thead>
                <tbody>
                  {[focal, ...siblingsRev]
                    .sort((a, b) => b.revenue - a.revenue)
                    .map((item, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td style={{ padding: '8px 12px', fontWeight: item.company === focal.company ? 600 : 400 }}>
                          {item.company}
                          {item.company === focal.company && ' (focal)'}
                        </td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'monospace' }}>
                          {formatUSD(item.revenue)}
                        </td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'monospace' }}>
                          {((item.revenue / totalRev) * 100).toFixed(1)}%
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
```

### 9.4 Confidence Tab

```jsx
function BriefConfidenceView({ tree, positioning, brief }) {
  const confidence = tree.confidence;
  const confidenceDetail = brief?.confidence_assessment || {};
  
  const factors = {
    high: [
      '✓ Multiple Tier A/B sources (SEC, M&A press, official filings)',
      '✓ Recently verified (<3 years)',
      '✓ Clear parent-subsidiary relationship'
    ],
    medium: [
      '○ Mix of Tier B sources and trade press',
      '○ Partially verified, some gaps remain',
      '○ Ownership path may have intermediaries'
    ],
    low: [
      '△ Limited source evidence',
      '△ Older information or unconfirmed reports',
      '△ Complex structure, multiple interpretations possible'
    ]
  };
  
  const riskFactors = confidenceDetail?.risks || [];
  
  return (
    <div style={{ paddingBottom: 20 }}>
      <section className="section">
        <div className="section-head">
          <span className="section-title">Confidence Assessment</span>
        </div>
        <div className="card" style={{
          padding: 16,
          borderLeft: `4px solid ${confidenceColor(confidence)}`,
          background: confidenceBgColor(confidence)
        }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4, textTransform: 'uppercase' }}>
            Confidence: {confidence}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
            {confidence === 'high' && 'High confidence in the ownership structure based on multiple verified sources.'}
            {confidence === 'medium' && 'Moderate confidence; some details may require additional verification.'}
            {confidence === 'low' && 'Low confidence; significant uncertainty remains about the ownership structure.'}
          </div>
        </div>
      </section>
      
      {/* Supporting factors */}
      <section className="section" style={{ marginTop: 16 }}>
        <div className="section-head">
          <span className="section-title">Supporting Factors</span>
        </div>
        <div className="card" style={{ padding: 12 }}>
          <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13 }}>
            {factors[confidence]?.map((factor, i) => (
              <li key={i} style={{ marginBottom: 6, color: 'var(--text-muted)' }}>
                {factor}
              </li>
            ))}
          </ul>
        </div>
      </section>
      
      {/* Risk factors */}
      {riskFactors.length > 0 && (
        <section className="section" style={{ marginTop: 16 }}>
          <div className="section-head">
            <span className="section-title">Risk Factors</span>
          </div>
          <div className="card" style={{ padding: 12, background: 'var(--danger-bg)' }}>
            <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13 }}>
              {riskFactors.map((risk, i) => (
                <li key={i} style={{ marginBottom: 6, color: 'var(--text)', fontWeight: 500 }}>
                  {risk}
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
      
      {/* Methodology note */}
      <section className="section" style={{ marginTop: 16 }}>
        <div className="card" style={{ padding: 12, fontSize: 12, color: 'var(--text-muted)', background: 'var(--surface)' }}>
          <strong>Methodology:</strong> Confidence determined by source tier (SEC filings/M&A press = Tier A, news/Crunchbase = Tier B, trade press = Tier C), 
          recency (<3 years = full weight), and structural clarity. Two Tier A sources = high confidence.
        </div>
      </section>
    </div>
  );
}
```

### Testing (Phase 9)

- [ ] Signals tab shows top 10 signals sorted by weight
- [ ] Mispricing tab shows gap only if > 5%
- [ ] Competitive tab handles 0 siblings gracefully
- [ ] Confidence tab color matches tree.confidence level
- [ ] All tabs work for Colgate example
- [ ] Risk factors display when present
- [ ] Methodology note is readable in small print

---

## PHASE 10: EXPORT + POLISH

### 10.1 PDF Export for Brief Mode

Enhance existing `handleGeneratePDF` to support Brief mode with all 5 tabs on a single 3-5 page PDF.

```javascript
async function handleGeneratePDF(mode) {
  if (mode === 'brief-full') {
    // Generate comprehensive brief PDF with all 5 tabs
    const html = generateBriefHTML({
      verdict: BriefVerdictView content,
      signals: BriefSignalsView content,
      mispricing: BriefMispricingView content,
      competitive: BriefCompetitiveView content,
      confidence: BriefConfidenceView content
    });
    
    downloadPDF(html, `${tree.company}_Brief.pdf`);
  }
}
```

### 10.2 Tab Navigation + State Persistence

Enhance brief mode tab state persistence in URL hash:

```javascript
// URL format: #i/{company}/brief/{tab}
// Examples: #i/Colgate/brief/verdict, #i/Colgate/brief/signals
```

### 10.3 Responsive Adjustments

Ensure all Brief tabs are mobile-friendly:
- Font sizes: 13px body → 12px on mobile
- Grid layouts: 2-4 columns → 1 column on mobile
- Table scroll: Enable horizontal scroll for competitive table
- Card padding: Reduce from 16px → 12px on mobile

### Testing (Phase 10)

- [ ] Brief PDF exports with all 5 tabs
- [ ] URL hash reflects active tab (#brief/verdict, etc.)
- [ ] Tab state persists across page reload
- [ ] Mobile rendering (font sizes, grid, tables)
- [ ] PDF footer includes metadata (date, source)
- [ ] Export button text changes based on selected mode
- [ ] Share link encodes Brief mode state

---

## IMPLEMENTATION CHECKLIST

### Phase 8: Verdict Tab
- [ ] Component created: `BriefVerdictView`
- [ ] Helper: `extractVerdictData`
- [ ] CSS: `.verdict-card`, `.confidence-badge`
- [ ] Integration: Tab renders when `briefSubNav === 'verdict'`
- [ ] Test case: Colgate loads verdict correctly

### Phase 9: Signals/Mispricing/Competitive/Confidence Tabs
- [ ] `BriefSignalsView` component
- [ ] `BriefMispricingView` component
- [ ] `BriefCompetitiveView` component
- [ ] `BriefConfidenceView` component
- [ ] All tabs render in correct state
- [ ] Responsive grid/table layouts
- [ ] Test all 5 tabs with Colgate

### Phase 10: Export + Polish
- [ ] PDF export for brief mode
- [ ] URL hash routing for brief tabs
- [ ] Mobile responsive adjustments
- [ ] Tab state persistence
- [ ] Share link encoding

---

## ESTIMATED TIMELINE

| Phase | Component | Time | Status |
|-------|-----------|------|--------|
| 8 | Verdict Tab | 2-3h | —  |
| 9 | Signals/Mispricing/Competitive/Confidence | 6-8h | — |
| 10 | Export/Polish/Testing | 3-4h | — |
| **Total** | Brief Mode Complete | **11-15h** | — |

---

## SUCCESS CRITERIA

✓ All 5 Brief tabs render without errors  
✓ Colgate example loads correctly with real data  
✓ PDF exports include all tabs  
✓ Mobile responsive (< 720px)  
✓ URL hash routing works (#brief/signals, etc.)  
✓ Tab state persists across page reload  
✓ All Confidence colors match Investigate mode  
✓ No JS console errors  
✓ Performance: page load < 2s, tab switch < 300ms  
