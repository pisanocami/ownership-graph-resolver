// Pure synthesis + derivation logic, extracted from app.jsx so it can be unit
// tested without React/DOM/fetch. Imported back into app.jsx for the pipeline
// and UI. No JSX, no browser globals.

// ─── Pure helpers ──────────────────────────────────────────────────────────

// Extract a JSON object from a model response. Handles three real-world cases:
//   1. The model wrapped the JSON in a ```json fence.
//   2. The model emitted trailing prose / citations / a second object AFTER
//      the closing `}` (Gemini with Google Search grounding does this often).
//   3. The model got truncated and never wrote the final closing braces.
// Strategy: locate the first `{`, then walk the string while counting brace
// depth — but only while OUTSIDE of a JSON string (respecting `\"` escapes).
// When depth returns to 0 we slice exactly that substring and parse it. If we
// run off the end without closing, fall back to the old "append `}` and retry"
// trick for the truncation case.
export function safeExtractJSON(text) {
  if (!text) return null;
  const fence = text.match(/```json\s*([\s\S]+?)\s*```/);
  const candidate = fence ? fence[1] : text;
  const cleaned = candidate.replace(/```json|```/g, '').trim();
  const firstBrace = cleaned.indexOf('{');
  if (firstBrace === -1) return null;

  // Walk with brace counting + string-state awareness.
  let depth = 0;
  let inString = false;
  let escape = false;
  let end = -1;
  for (let i = firstBrace; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }

  if (end !== -1) {
    try { return JSON.parse(cleaned.slice(firstBrace, end + 1)); } catch { /* fall through */ }
  }

  // Truncation fallback: never closed. Try appending `}` to whatever we have.
  let attempt = cleaned.slice(firstBrace);
  try { return JSON.parse(attempt); } catch { /* keep trying */ }
  for (let i = 0; i < 15; i++) {
    attempt += '}';
    try { return JSON.parse(attempt); } catch { /* keep trying */ }
  }
  return null;
}

export function formatUSD(n) {
  if (n == null || isNaN(n)) return '—';
  if (n === 0) return '$0';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n}`;
}

export function keyOf(node) {
  return (node?.company || '').toLowerCase().trim();
}

// ─── Derivation / classification layer (F11: classify downstream, never capture) ──

// Convert presence flags into a display status label. Captures stay free-form;
// this is the ONLY place active/legacy/discontinued/unknown is decided.
// Backward-compat: old cached/shared reports only carry the legacy enum `status`.
export function deriveStatus(node) {
  if (!node || typeof node !== 'object') return { label: 'unknown', reason: 'no node' };
  const hasFlags =
    node.in_current_sources !== undefined || node.in_historical_sources !== undefined;

  // Explicit closure overrides presence flags: a brand can still be *listed*
  // ("in current sources") yet have been wound down or merged away. Classify from
  // the free-text captures (F11-compliant), gated on the absence of a live estimate.
  const central = node.revenue_estimate?.central || 0;
  const blob = `${node.reason_for_null || ''} ${node.reasoning_summary || ''} ${node.notes || ''}`.toLowerCase();
  const closureSignal = /ceas(e|ed|ing)|discontinu|shut ?down|closed all|wound down|no longer operat|integrated into|merged into|absorbed into|folded into/.test(blob);
  if (node.discontinued === true || (closureSignal && central <= 0)) {
    return {
      label: 'discontinued',
      reason: node.discontinued === true ? 'discontinuation signal captured' : 'closure signal in captured text',
    };
  }

  if (!hasFlags) {
    // Legacy enum fallback for pre-F11 records.
    if (typeof node.status === 'string') {
      if (node.status === 'active') return { label: 'active', reason: 'legacy status field' };
      return { label: node.status === 'defunct' ? 'discontinued' : 'legacy', reason: 'legacy status field' };
    }
    return { label: 'unknown', reason: 'no presence signals captured' };
  }

  if (node.in_current_sources === true) {
    return { label: 'active', reason: 'present in current/primary sources' };
  }
  if (node.in_historical_sources === true) {
    return { label: 'legacy', reason: 'only in historical/secondary sources' };
  }
  return { label: 'unknown', reason: 'no presence signals captured' };
}

// Replaces the rejected enum `revenue_status`. Surfaces the free reason_for_null
// when there is no estimate.
export function deriveRevenueStatus(node) {
  const central = node?.revenue_estimate?.central || 0;
  if (central > 0) {
    return { hasEstimate: true, label: 'estimated', reason: null };
  }
  const reason = node?.reason_for_null || null;
  return { hasEstimate: false, label: 'no_estimate', reason };
}

// Classifier OVER free text — not a captured enum. Used only to preserve the
// "investor governance is material" synthesis note without coupling to an enum.
export function deriveStrategicRoleClass(roleDescription) {
  const s = (roleDescription || '').toLowerCase();
  if (/invest|\bvc\b|venture|private equity|\bpe\b|sponsor|backer|shareholder/.test(s)) {
    return 'investor';
  }
  if (/founder|co-?founder/.test(s)) return 'founder';
  if (/ceo|president|chief|executive|chair/.test(s)) return 'executive';
  if (/board|director/.test(s)) return 'board';
  return 'other';
}

// Detect a pending/announced divestiture from captured free text (signals, reasoning,
// notes). F11-compliant classifier — surfaces structural change the model recorded only
// as prose (e.g. "ByteDance agreed to sell Moonton to Savvy Games Group").
const DIVEST_RE = /agreed to sell|to be sold|is being sold|sold .{0,40}? to |divest|spin[- ]?off|spun off|spinning off|carve[- ]?out|carved out/i;
export function deriveDivestiture(node) {
  if (!node || typeof node !== 'object') return null;
  const sigs = node.signals_found || [];
  for (const s of sigs) {
    const txt = `${s.label || ''} ${s.value || ''}`;
    if (DIVEST_RE.test(txt)) return { divesting: true, detail: (s.value || s.label || '').trim(), source_url: s.source || null };
  }
  const blob = `${node.reasoning_summary || ''} ${node.notes || ''}`;
  if (DIVEST_RE.test(blob)) {
    const sentence = blob.split(/(?<=[.!?])\s+/).find((seg) => DIVEST_RE.test(seg));
    return { divesting: true, detail: (sentence || '').trim(), source_url: null };
  }
  return null;
}

// A revenue estimate is "circular" for reconciliation when it was derived top-down as a
// fraction of the parent/group total — summing it back to compare against that same total
// is self-fulfilling and gives false confidence.
const CIRCULAR_RE = /top[- ]?down|%\s*of\s*(the\s*)?(parent|group|total|bytedance|company)|share\s*(generated\s*)?(from|of)\b|applying the reported share|fraction of .{0,30}(parent|total|group)|derived (from|using) .{0,40}(parent|total|group|reported)|reported share/i;
export function isCircularEstimate(node) {
  return CIRCULAR_RE.test(`${node?.reasoning_summary || ''}`);
}

// Collect every node that carries strategic_control (or a no-data note) for display,
// not just the focal→root chain. Crucially includes the ancestors' OTHER children
// (e.g. a JV/subsidiary under the parent like "TikTok USDS JV") whose ownership split
// is otherwise buried in raw JSON. Returns ordered { node, isFocal, under } entries.
export function collectControlLayers(tree) {
  if (!tree) return [];
  const chain = [];
  let p = tree.parent;
  while (p) { chain.unshift(p); p = p.parent; }
  const has = (n) => n && ((n.strategic_control || []).length > 0 || n.strategic_control_note);
  const out = [];
  const focalKey = keyOf(tree);
  chain.forEach((n) => { if (has(n)) out.push({ node: n, isFocal: false, under: null }); });
  chain.forEach((anc) => (anc.children || []).forEach((c) => {
    if (keyOf(c) !== focalKey && has(c)) out.push({ node: c, isFocal: false, under: anc.company });
  }));
  if (has(tree)) out.push({ node: tree, isFocal: true, under: null });
  (tree.children || []).forEach((c) => { if (has(c)) out.push({ node: c, isFocal: false, under: tree.company }); });
  (tree.siblings || []).forEach((s) => { if (has(s)) out.push({ node: s, isFocal: false, under: tree.parent?.company || null }); });
  return out;
}

// ─── Entity collection for revenue enrichment ───────────────────────────────

export function collectEntities(ownership) {
  if (!ownership) return [];
  const out = [];
  const seen = new Set();
  const push = (entity, role) => {
    if (!entity || !entity.company) return;
    const key = entity.company.toLowerCase().trim();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      company: entity.company,
      domain: entity.domain || null,
      role,
      layer: entity.layer || null,
      category: entity.category || null,
      in_current_sources: entity.in_current_sources,
      in_historical_sources: entity.in_historical_sources,
    });
  };
  push(ownership, 'focal');
  let p = ownership.parent;
  let depth = 0;
  while (p && depth < 2) {
    push(p, depth === 0 ? 'parent' : 'grandparent');
    p = p.parent;
    depth++;
  }
  // Prioritize current/active brands before slicing so a recently launched brand
  // (e.g. Cloverlane) is never the one dropped by the cap.
  const orderedSiblings = [...(ownership.siblings || [])].sort(
    (a, b) => (b.in_current_sources === true) - (a.in_current_sources === true)
  );
  orderedSiblings.slice(0, 8).forEach((s) => push(s, 'sibling'));
  (ownership.children || []).slice(0, 3).forEach((c) => push(c, 'child'));
  return out;
}

export function attachRevenue(ownership, revenueByCompany) {
  if (!ownership) return ownership;
  const clone = JSON.parse(JSON.stringify(ownership));
  const visit = (node) => {
    if (!node) return;
    const key = (node.company || '').toLowerCase().trim();
    const rev = revenueByCompany[key];
    if (rev) {
      node.revenue_estimate = {
        low: rev.revenue_estimate?.low ?? 0,
        high: rev.revenue_estimate?.high ?? 0,
        central: rev.revenue_estimate?.central ?? 0,
        confidence: rev.confidence || 'low',
      };
      node.signals_found = rev.signals_found || [];
      node.reasoning_summary = rev.reasoning_summary || '';
      if (rev.signals_attempted != null) node.signals_attempted = rev.signals_attempted;
      if (rev.signals_found_count != null) node.signals_found_count = rev.signals_found_count;
      if (rev.reason_for_null) node.reason_for_null = rev.reason_for_null;
      if (rev.error) node.revenue_error = rev.error;
    }
    node._derived_status = deriveStatus(node);
    node._divestiture = deriveDivestiture(node);
    if (node.parent) visit(node.parent);
    (node.siblings || []).forEach((s) => {
      const sk = (s.company || '').toLowerCase().trim();
      const sr = revenueByCompany[sk];
      if (sr) {
        s.revenue_estimate = {
          low: sr.revenue_estimate?.low ?? 0,
          high: sr.revenue_estimate?.high ?? 0,
          central: sr.revenue_estimate?.central ?? 0,
          confidence: sr.confidence || 'low',
        };
        s.signals_found = sr.signals_found || [];
        s.reasoning_summary = sr.reasoning_summary || '';
        if (sr.signals_attempted != null) s.signals_attempted = sr.signals_attempted;
        if (sr.signals_found_count != null) s.signals_found_count = sr.signals_found_count;
        if (sr.reason_for_null) s.reason_for_null = sr.reason_for_null;
      }
      s._derived_status = deriveStatus(s);
      s._divestiture = deriveDivestiture(s);
    });
    (node.children || []).forEach(visit);
  };
  visit(clone);
  return clone;
}

// Rescale focal + sibling central estimates so they sum to the parent's
// reported 10-K total. Each adjustment is clamped to the entity's own
// [low, high] band, the raw estimate is preserved on `revenue_estimate_raw`,
// and `anchor_adjusted: true` is flagged so the UI and reconciliation can
// distinguish corrected values from raw model output.
export function applyAnchorAdjustment(tree, parentAnchor) {
  if (!tree || !parentAnchor || !parentAnchor.is_public) return null;
  const anchorTotal = parentAnchor.total_revenue_usd || 0;
  if (anchorTotal <= 0) return null;

  const targets = [tree, ...(tree.siblings || [])].filter(
    (n) => n && n.revenue_estimate && (n.revenue_estimate.central || 0) > 0
  );
  if (targets.length < 2) return null;

  const sumRaw = targets.reduce((a, n) => a + (n.revenue_estimate.central || 0), 0);
  if (sumRaw <= 0) return null;
  const scale = anchorTotal / sumRaw;
  // Skip if already within 5% — no meaningful correction to make.
  if (Math.abs(scale - 1) < 0.05) return null;

  let adjustedSum = 0;
  targets.forEach((n) => {
    const rev = n.revenue_estimate;
    const rawCentral = rev.central || 0;
    const scaled = rawCentral * scale;
    const clamped = Math.max(rev.low || 0, Math.min(rev.high || Infinity, scaled));
    n.revenue_estimate_raw = { low: rev.low, high: rev.high, central: rawCentral, confidence: rev.confidence };
    n.revenue_estimate = {
      ...rev,
      central: Math.round(clamped),
      anchor_adjusted: true,
      anchor_scale: Number(scale.toFixed(3)),
      anchor_clamped: clamped !== scaled,
    };
    adjustedSum += clamped;
  });

  return {
    scale: Number(scale.toFixed(3)),
    anchor_total: anchorTotal,
    sum_raw: Math.round(sumRaw),
    sum_adjusted: Math.round(adjustedSum),
    adjusted_count: targets.length,
    residual_pct: Math.round(((adjustedSum - anchorTotal) / anchorTotal) * 100),
  };
}

// Build the focal → root layer chain (root first), used for per-layer passes.
function layerChain(tree) {
  const chain = [];
  let p = tree.parent;
  while (p) { chain.unshift(p); p = p.parent; }
  return [...chain, tree];
}

// Deterministic explanation for a reconciliation gap > 20% (Bundle B). Built
// ONLY from captured facts — no LLM call. Returns parallel cause/evidence arrays.
function buildReconciliationExplanation({ ratio, tree, siblings, parentAnchor }) {
  const causes = [];
  const evidence = [];
  const reasoningBlobs = [tree, ...siblings]
    .map((n) => `${n.reasoning_summary || ''} ${n.notes || ''}`)
    .join(' ')
    .toLowerCase();
  const channelHit = /wholesale|b2b|white-?label|marketplace|retail partner|distributor/.test(reasoningBlobs);

  if (ratio < 0.8) {
    // Undercount side.
    const missing = siblings.filter(
      (s) => s.in_current_sources === true && !((s.revenue_estimate?.central || 0) > 0)
    );
    if (missing.length > 0) {
      causes.push('Missing or unestimated siblings (verify completeness of the brand list)');
      const names = missing.map((s) => s.company).join(', ');
      const reasons = missing.map((s) => s.reason_for_null).filter(Boolean);
      evidence.push(
        `${missing.length} current-source sibling(s) have no revenue estimate: ${names}.` +
          (reasons.length ? ` Reason(s): ${reasons.join('; ')}.` : '')
      );
    }
    if (channelHit) {
      causes.push('Aggregator has non-brand revenue streams (B2B, wholesale, white-label, marketplace)');
      evidence.push('Captured revenue reasoning mentions wholesale/B2B/white-label channels that do not flow to per-brand DTC estimates.');
    }
    if (parentAnchor && Array.isArray(parentAnchor.segments) && parentAnchor.segments.length > 0) {
      const known = new Set([tree, ...siblings].map((n) => keyOf(n)));
      const unmatched = parentAnchor.segments.filter(
        (seg) => !seg.contains_focal && ![...known].some((k) => k && (seg.name || '').toLowerCase().includes(k))
      );
      if (unmatched.length > 0) {
        causes.push('Parent reports revenue lines not attributable to the captured brands');
        evidence.push(`Parent filing has ${unmatched.length} segment(s) not matched to any captured brand: ${unmatched.map((s) => s.name).join(', ')}.`);
      }
    }
  } else if (ratio > 1.2) {
    // Overcount side.
    const stale = siblings.filter((s) => {
      const lbl = deriveStatus(s).label;
      return (lbl === 'legacy' || lbl === 'discontinued') && (s.revenue_estimate?.central || 0) > 0;
    });
    if (stale.length > 0) {
      causes.push('Sibling set is over-broad (legacy/discontinued brands still counted)');
      evidence.push(`${stale.length} sibling(s) classified legacy/discontinued still contribute revenue: ${stale.map((s) => s.company).join(', ')}.`);
    }
    const peakHit = [tree, ...siblings].some((n) =>
      (n.signals_found || []).some((sig) => sig.type === 'press' && /peak|historic|decline|former|down from/i.test(`${sig.label} ${sig.value}`))
    );
    if (peakHit) {
      causes.push('Per-brand revenue overstated against historical peaks rather than current run-rate');
      evidence.push('A captured press signal references a historical peak / decline, suggesting current revenue is below the estimate used.');
    }
  }

  if (causes.length === 0) {
    causes.push('Insufficient captured evidence to attribute the gap');
    evidence.push('No missing-sibling, channel, segment, or historical-peak signals were captured to explain the delta.');
    return { likely_causes: causes, evidence_for_each: evidence };
  }
  return { likely_causes: causes.slice(0, 3), evidence_for_each: evidence.slice(0, 3) };
}

// Deterministic local synthesis. Chosen over a 3rd LLM call because (a) the
// positioning math is mechanical (ratios, ranking) and (b) it avoids token cost
// and JSON-parse risk of a synthesis call given two large prior outputs.
export function synthesize(ownership, revenueByCompany, parentAnchor = null) {
  const tree = attachRevenue(ownership, revenueByCompany);
  const anchorAdjustment = applyAnchorAdjustment(tree, parentAnchor);
  if (parentAnchor) tree.parent_anchor = parentAnchor;
  const notes = [];

  // Normalize per-layer strategic_control (Bundle C): every node in the chain
  // carries its own array + note; default to [] so the UI can iterate safely.
  // Dedup across layers (root→focal) so an owner shown at a higher layer isn't
  // repeated below (e.g. a founder listed on both parent and focal).
  const seenControl = new Set();
  layerChain(tree).forEach((node) => {
    if (!Array.isArray(node.strategic_control)) node.strategic_control = [];
    if (node.strategic_control_note === undefined) node.strategic_control_note = null;
    node.strategic_control = node.strategic_control.filter((sc) => {
      const k = (sc.entity || '').toLowerCase().trim();
      if (!k) return true;
      if (seenControl.has(k)) return false;
      seenControl.add(k);
      return true;
    });
  });

  // Currency/consistency: when the parent is anchored to a public filing reported
  // in USD, display the parent's revenue as the anchor total. The model's own parent
  // estimate can be in the wrong currency (e.g. an EUR figure labeled USD), which
  // otherwise disagrees with the reconciliation benchmark. Preserve the raw value.
  if (tree.parent && parentAnchor && parentAnchor.is_public && (parentAnchor.total_revenue_usd || 0) > 0) {
    const anchorUsd = parentAnchor.total_revenue_usd;
    const cur = tree.parent.revenue_estimate?.central || 0;
    if (cur <= 0 || Math.abs(cur - anchorUsd) / anchorUsd > 0.02) {
      if (cur > 0 && !tree.parent.revenue_estimate_raw) tree.parent.revenue_estimate_raw = tree.parent.revenue_estimate;
      tree.parent.revenue_estimate = {
        low: anchorUsd,
        high: anchorUsd,
        central: anchorUsd,
        confidence: tree.parent.revenue_estimate?.confidence || 'high',
        anchor_sourced: true,
      };
      notes.push(`${tree.parent.company} revenue shown from its ${parentAnchor.fiscal_year || 'latest'} filing (${formatUSD(anchorUsd)}); model's raw parent estimate preserved.`);
    }
  }

  const focalRev = tree.revenue_estimate?.central || 0;
  const parentRev = tree.parent?.revenue_estimate?.central || 0;

  let focal_vs_parent_ratio = 'N/A (standalone)';
  if (tree.parent && parentRev > 0) {
    const pct = ((focalRev / parentRev) * 100).toFixed(1);
    focal_vs_parent_ratio = `${pct}% of ${tree.parent.company} revenue`;
  } else if (tree.parent && parentRev === 0) {
    focal_vs_parent_ratio = `${tree.parent.company} revenue unknown`;
  }

  const siblings = tree.siblings || [];
  let focal_vs_siblings = 'No siblings';
  if (siblings.length > 0) {
    const ranked = [
      { company: tree.company, central: focalRev, focal: true },
      ...siblings.map((s) => ({
        company: s.company,
        central: s.revenue_estimate?.central || 0,
        focal: false,
      })),
    ].sort((a, b) => b.central - a.central);
    const rank = ranked.findIndex((r) => r.focal) + 1;
    focal_vs_siblings = `Ranked ${rank} of ${ranked.length} in family — ${ranked
      .map((r) => `${r.focal ? '★ ' : ''}${r.company} ${formatUSD(r.central)}`)
      .join(' · ')}`;
  }

  const focalSignals = tree.signals_found || [];
  const growthHits = focalSignals
    .filter((s) => ['press', 'hiring', 'funding'].includes(s.type))
    .slice(0, 3)
    .map((s) => `${s.label} (${s.source})`);
  const growth_signals = growthHits.length > 0 ? growthHits.join('; ') : 'No explicit YoY growth signals captured.';

  if (tree.pending_acquisition?.acquirer) {
    const pa = tree.pending_acquisition;
    const when = pa.expected_close_date ? ` (expected close ${pa.expected_close_date})` : '';
    const ann = pa.announced_date ? `, announced ${pa.announced_date}` : '';
    notes.push(`⚠ Pending acquisition by ${pa.acquirer}${ann}${when} — parent, siblings, and reconciliation reflect the CURRENT legal owner (${tree.parent?.company || 'standalone'}), not the post-close acquirer. ${pa.regulatory_status ? `Status: ${pa.regulatory_status}.` : ''}`);
    if (tree.post_close_consolidated_parent?.company && tree.post_close_consolidated_parent.company !== pa.acquirer) {
      notes.push(`Post-close consolidated parent will be ${tree.post_close_consolidated_parent.company}.`);
    }
  }
  if (tree.terminal_layer === 'private_equity') notes.push('Family is PE-owned — expect optimization for EBITDA and exit timing.');
  if ((tree.strategic_control || []).some((s) => deriveStrategicRoleClass(s.role_description || s.relationship) === 'investor')) {
    notes.push('Investor governance is material to strategic direction.');
  }
  if (focalRev && parentRev && focalRev / parentRev > 0.4) notes.push('Focal is a major contributor to parent revenue.');
  if (focalRev && parentRev && focalRev / parentRev < 0.05) notes.push('Focal is a small line within the parent — likely lower strategic attention.');
  if (siblings.length >= 3 && focalRev) {
    const sibRevs = siblings.map((s) => s.revenue_estimate?.central || 0);
    const maxSib = Math.max(...sibRevs);
    if (focalRev > maxSib) notes.push('Focal leads the sibling cohort by revenue — likely cash cow of the family.');
    else if (focalRev < Math.min(...sibRevs.filter((x) => x > 0))) notes.push('Focal trails siblings — may be a growth bet or underperforming.');
  }

  // ── Reconciliation: sum(focal + siblings) vs parent reported total ─────────
  // Prefer the 10-K anchor when available; otherwise fall back to the parent's
  // estimated central. Large gaps surface as an explicit warning. When an
  // anchor adjustment was applied, diagnose against the raw (pre-adjustment)
  // values so the warning reflects the original model gap, not the corrected one.
  const rawFocalRev = tree.revenue_estimate_raw?.central ?? focalRev;
  const sibCentrals = siblings.map((s) => s.revenue_estimate_raw?.central ?? s.revenue_estimate?.central ?? 0);
  const knownSibCount = sibCentrals.filter((x) => x > 0).length + (rawFocalRev > 0 ? 1 : 0);

  let reconciliation = null;
  if (tree.parent && knownSibCount >= 2) {
    const anchorTotal = parentAnchor && parentAnchor.is_public ? (parentAnchor.total_revenue_usd || 0) : 0;
    const focalSeg = parentAnchor && Array.isArray(parentAnchor.segments)
      ? parentAnchor.segments.find((s) => s.contains_focal) : null;
    const focalSegmentRev = focalSeg?.revenue_usd || 0;
    const focalSegName = (focalSeg?.name || '').toLowerCase();

    // Exclude siblings already consolidated inside the focal's reported segment
    // (e.g. a segment named "Zara (including Zara Home and Lefties)") so they are
    // not double-counted against the parent total.
    const consolidated_siblings = [];
    let sumChildren = rawFocalRev;
    let countedSiblings = 0;
    siblings.forEach((s, i) => {
      const name = (s.company || '').toLowerCase().trim();
      if (anchorTotal > 0 && focalSegName && name && focalSegName.includes(name)) {
        consolidated_siblings.push(s.company);
        return;
      }
      const c = sibCentrals[i];
      sumChildren += c;
      if (c > 0) countedSiblings++;
    });
    const sumChildCentralAdj = sumChildren;
    const childrenCounted = countedSiblings + (rawFocalRev > 0 ? 1 : 0);

    // Circular detection: when the benchmark is the parent's ESTIMATED central (no
    // independent filing) and a counted sibling was itself estimated top-down as a
    // share of that parent total, summing it back is self-fulfilling. Only flag when
    // such siblings make up a meaningful chunk of the benchmark.
    const isConsolidated = (s) => {
      const name = (s.company || '').toLowerCase().trim();
      return anchorTotal > 0 && focalSegName && name && focalSegName.includes(name);
    };
    const circular_siblings = siblings.filter((s, i) => !isConsolidated(s) && sibCentrals[i] > 0 && isCircularEstimate(s)).map((s) => s.company);
    const circularCentral = siblings.reduce((a, s, i) => (!isConsolidated(s) && isCircularEstimate(s) ? a + (sibCentrals[i] || 0) : a), 0);

    const benchmark = anchorTotal > 0 ? anchorTotal : parentRev;
    const circular = anchorTotal === 0 && circular_siblings.length > 0 && benchmark > 0 && circularCentral >= 0.3 * benchmark;
    const benchmarkLabel = anchorTotal > 0
      ? `${tree.parent.company} ${parentAnchor.fiscal_year || 'latest'} 10-K reported revenue`
      : `${tree.parent.company} estimated central revenue`;

    if (benchmark > 0) {
      const ratio = sumChildCentralAdj / benchmark;
      const pctDelta = Math.round((ratio - 1) * 100);
      reconciliation = {
        sum_children_central: sumChildCentralAdj,
        parent_benchmark: benchmark,
        parent_benchmark_source: anchorTotal > 0 ? '10-K' : 'estimated',
        ratio: Number(ratio.toFixed(3)),
        pct_delta: pctDelta,
        focal_segment_revenue: focalSegmentRev || null,
        children_counted: childrenCounted,
        consolidated_siblings: consolidated_siblings.length ? consolidated_siblings : undefined,
        circular: circular || undefined,
        circular_siblings: circular ? circular_siblings : undefined,
        anchor_adjustment: anchorAdjustment,
      };
      if (consolidated_siblings.length) {
        const verb = consolidated_siblings.length > 1 ? 'are' : 'is';
        notes.push(`${consolidated_siblings.join(', ')} ${verb} consolidated within the ${tree.parent.company} "${focalSeg.name}" segment — excluded from the sum to avoid double-counting.`);
      }
      if (circular) {
        const verb = circular_siblings.length > 1 ? 'were' : 'was';
        notes.push(`⚠ Reconciliation may be circular: ${circular_siblings.join(', ')} ${verb} estimated top-down as a share of ${tree.parent.company}'s own total, so summing back to that total is self-fulfilling — treat the ${Math.round(ratio * 100)}% coverage as unverified, not confirmation.`);
      }
      // Bundle B: when the gap is material (>20% either way), attach a
      // deterministic explanation built from captured facts.
      if (Math.abs(pctDelta) > 20) {
        reconciliation.explanation = buildReconciliationExplanation({ ratio, tree, siblings, parentAnchor });
      }
      const sumStr = formatUSD(sumChildCentralAdj);
      const benchStr = formatUSD(benchmark);
      if (ratio > 1.5) {
        notes.push(`⚠ Reconciliation: sum of focal + ${siblings.length} sibling estimates (${sumStr}) is ${pctDelta > 0 ? '+' : ''}${pctDelta}% vs ${benchmarkLabel} (${benchStr}) — sibling estimates likely overstated or sibling set is over-broad.`);
      } else if (ratio < 0.5) {
        notes.push(`⚠ Reconciliation: sum of focal + ${siblings.length} sibling estimates (${sumStr}) covers only ${Math.round(ratio * 100)}% of ${benchmarkLabel} (${benchStr}) — likely missing siblings or underestimated revenues.`);
      } else if (anchorTotal > 0) {
        notes.push(`Reconciliation: focal + siblings (${sumStr}) reconciles within ${Math.abs(pctDelta)}% of ${benchmarkLabel} (${benchStr}).`);
      }
      if (focalSegmentRev > 0 && rawFocalRev > 0) {
        const segRatio = rawFocalRev / focalSegmentRev;
        if (segRatio > 1.3 || segRatio < 0.7) {
          notes.push(`⚠ Focal estimate (${formatUSD(rawFocalRev)}) diverges from its parent 10-K segment revenue (${formatUSD(focalSegmentRev)}, ${Math.round(segRatio * 100)}%).`);
        }
      }
      if (anchorAdjustment) {
        const direction = anchorAdjustment.scale > 1 ? 'scaled up' : 'scaled down';
        const residualClause = Math.abs(anchorAdjustment.residual_pct) >= 5
          ? ` Residual gap after band-clamping: ${anchorAdjustment.residual_pct > 0 ? '+' : ''}${anchorAdjustment.residual_pct}%.`
          : '';
        notes.push(`Auto-corrected: ${anchorAdjustment.adjusted_count} central estimates ${direction} by ${anchorAdjustment.scale}× to reconcile with ${benchmarkLabel} (${formatUSD(anchorAdjustment.anchor_total)}); raw values preserved.${residualClause}`);
      }
    }
  }
  if (parentAnchor && parentAnchor.is_public === false) {
    notes.push(`${tree.parent?.company || 'Parent'} is not publicly traded — no 10-K anchor available; reconciliation uses estimates only.`);
  }

  const strategic_notes = notes.length > 0 ? notes : ['No distinctive structural signals captured.'];

  return {
    focal_company: tree.company,
    ownership_tree: tree,
    positioning_analysis: {
      focal_vs_parent_ratio,
      focal_vs_siblings,
      growth_signals,
      strategic_notes,
      reconciliation,
      parent_anchor: parentAnchor || null,
    },
  };
}
