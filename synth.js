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

// ─── Bug #5: Chain normalization (legal_name vs brand_name) ─────────────────
// Some models emit two consecutive layers that are actually the SAME legal
// entity captured under different name forms ("ByteDance Ltd." as root and
// "ByteDance" as parent, both with bytedance.com). This produces a duplicated
// tree with divergent revenues. We collapse a parent→child pair when they
// share 2+ strong identifiers (domain, ticker, legal entity reference, or
// HQ+founders+founding date triple). We deliberately do NOT collapse:
//   - Holding vs operating subsidiary with distinct UBO (Inditex ≠ Pontegadea)
//   - Holding vs operating subsidiary that legitimately differ (Alphabet ≠ Google LLC)
//   - "X Holdings" / "X Group" + "X" sibling pairs — flagged in notes for review.
const LEGAL_SUFFIX_RE = /\b(inc\.?|incorporated|ltd\.?|limited|llc|l\.l\.c\.|corp\.?|corporation|plc|sa|s\.a\.|se|ag|gmbh|kk|kabushiki|nv|n\.v\.|bv|b\.v\.|oyj|spa|s\.p\.a\.|pte\.?|pty\.?|co\.?)\b/gi;
const HOLDING_TOKEN_RE = /\b(holdings?|group|holding)\b/i;

function stripLegalSuffix(name) {
  if (!name) return '';
  return String(name).toLowerCase().replace(LEGAL_SUFFIX_RE, '').replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
}

function normDomain(d) {
  if (!d) return null;
  return String(d).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').trim() || null;
}

function sameToken(a, b) {
  if (!a || !b) return false;
  return String(a).toLowerCase().trim() === String(b).toLowerCase().trim();
}

// Returns array of identifier names that match between two nodes.
function sharedIdentifiers(a, b) {
  const shared = [];
  const da = normDomain(a.domain), db = normDomain(b.domain);
  if (da && db && da === db) shared.push('domain');
  if (sameToken(a.ticker, b.ticker)) shared.push('ticker');
  const lerA = a.legal_entity_reference || a.cik || a.lei || a.registration_id;
  const lerB = b.legal_entity_reference || b.cik || b.lei || b.registration_id;
  if (sameToken(lerA, lerB)) shared.push('legal_entity_reference');
  const hq = sameToken(a.headquarters || a.hq, b.headquarters || b.hq);
  const founded = sameToken(a.founding_date || a.founded, b.founding_date || b.founded);
  const foundersA = (a.founders || []).map((f) => (typeof f === 'string' ? f : f?.name || '').toLowerCase().trim()).filter(Boolean).sort().join('|');
  const foundersB = (b.founders || []).map((f) => (typeof f === 'string' ? f : f?.name || '').toLowerCase().trim()).filter(Boolean).sort().join('|');
  const founders = foundersA && foundersB && foundersA === foundersB;
  if (hq && founded && founders) shared.push('hq+founders+founding_date');
  return shared;
}

function pickCanonicalName(a, b) {
  // Prefer the name carrying a formal legal suffix (e.g. "ByteDance Ltd." over "ByteDance").
  const aHas = LEGAL_SUFFIX_RE.test(a.company || ''); LEGAL_SUFFIX_RE.lastIndex = 0;
  const bHas = LEGAL_SUFFIX_RE.test(b.company || ''); LEGAL_SUFFIX_RE.lastIndex = 0;
  if (aHas && !bHas) return a.company;
  if (bHas && !aHas) return b.company;
  // Otherwise the longer name (typically more specific).
  return (a.company || '').length >= (b.company || '').length ? a.company : b.company;
}

function uniqueByLower(arr) {
  const seen = new Set();
  const out = [];
  for (const v of arr || []) {
    const k = typeof v === 'string' ? v.toLowerCase().trim() : JSON.stringify(v);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

function uniqueStrategicControl(arr) {
  const seen = new Set();
  const out = [];
  for (const sc of arr || []) {
    const k = `${(sc.entity || '').toLowerCase().trim()}|${(sc.role_description || sc.relationship || '').toLowerCase().trim()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(sc);
  }
  return out;
}

function mergeRevenueRange(a, b) {
  // Widest unified range; central = midpoint of unified range when both present.
  if (!a && !b) return undefined;
  if (!a) return b;
  if (!b) return a;
  const low = Math.min(a.low || 0, b.low || 0);
  const high = Math.max(a.high || 0, b.high || 0);
  const central = high > 0 ? Math.round((low + high) / 2) : 0;
  return {
    low,
    high,
    central,
    confidence: a.confidence === 'high' || b.confidence === 'high' ? 'high'
      : a.confidence === 'medium' || b.confidence === 'medium' ? 'medium' : 'low',
  };
}

// Merge child INTO parent (parent name slot keeps recursion structure but takes
// canonical name). Returns the merged node; child.parent becomes the new parent.
function mergePair(parent, child, sharedKeys) {
  const canonical = pickCanonicalName(parent, child);
  const merged = { ...parent };
  merged.company = canonical;
  merged.domain = normDomain(parent.domain) || normDomain(child.domain) || parent.domain || child.domain;
  merged.node_type = parent.node_type === 'legal_entity' || child.node_type === 'legal_entity' ? 'legal_entity' : (parent.node_type || child.node_type);
  merged.sources = uniqueByLower([...(parent.sources || []), ...(child.sources || [])]);
  merged.signals_found = uniqueByLower([...(parent.signals_found || []), ...(child.signals_found || [])]);
  merged.strategic_control = uniqueStrategicControl([...(parent.strategic_control || []), ...(child.strategic_control || [])]);
  if (parent.revenue_estimate || child.revenue_estimate) {
    merged.revenue_estimate = mergeRevenueRange(parent.revenue_estimate, child.revenue_estimate);
  }
  const noteParts = [];
  if (parent.notes) noteParts.push(parent.notes);
  if (child.notes) noteParts.push(child.notes);
  noteParts.push(`Collapsed duplicate chain layers "${parent.company}" and "${child.company}" (shared: ${sharedKeys.join(', ')}); canonical name: "${canonical}".`);
  merged.notes = noteParts.join(' | ');
  merged._collapsed_from = uniqueByLower([
    ...((parent._collapsed_from) || []),
    ...((child._collapsed_from) || []),
    parent.company,
    child.company,
  ]);
  merged._collapsed_shared = sharedKeys;
  // The merged node takes the LOWER (child) slot in the tree; its new parent
  // is whatever sat above the HIGHER layer (parent.parent).
  merged.parent = parent.parent || null;
  // Siblings/children: prefer the child's set (it's the operating/lower layer
  // where brand-level fan-out usually lives), fall back to the parent's.
  merged.siblings = (child.siblings && child.siblings.length) ? child.siblings : (parent.siblings || []);
  merged.children = (child.children && child.children.length) ? child.children : (parent.children || []);
  return merged;
}

// Walk focal → root, collapsing adjacent layers that should be one entity.
// Returns { tree, collapses: [{ from: [a,b], canonical, shared }], holdingFlags: [...] }
export function normalizeChain(ownership) {
  if (!ownership) return { tree: ownership, collapses: [], holdingFlags: [] };
  const tree = JSON.parse(JSON.stringify(ownership));
  const collapses = [];
  const holdingFlags = [];

  // Climb from focal. At each step, check (current → current.parent) pair.
  // We treat the higher node (parent) as the "canonical slot" being merged into.
  // For simplicity, do a fixed number of passes; chain length is small (<=4).
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    let cursor = tree;
    let prev = null; // node whose .parent === cursor
    while (cursor && cursor.parent) {
      const child = cursor;          // "lower" layer
      const parent = cursor.parent;  // "higher" layer
      const strippedChild = stripLegalSuffix(child.company);
      const strippedParent = stripLegalSuffix(parent.company);
      const nameMatch = strippedChild && strippedParent && strippedChild === strippedParent;

      // "X Holdings" / "X Group" + "X" → don't auto-collapse, flag for review.
      const childToken = (child.company || '').match(HOLDING_TOKEN_RE);
      const parentToken = (parent.company || '').match(HOLDING_TOKEN_RE);
      const holdingShape = !nameMatch && (
        (childToken && stripLegalSuffix((child.company || '').replace(HOLDING_TOKEN_RE, '')) === strippedParent) ||
        (parentToken && stripLegalSuffix((parent.company || '').replace(HOLDING_TOKEN_RE, '')) === strippedChild)
      );

      const shared = sharedIdentifiers(parent, child);
      // Collapse rule: share 2+ identifiers from {domain, ticker, legal_entity_reference, hq+founders+founding_date}.
      // Name-equivalence (modulo legal suffix) alone is NOT enough.
      if (!holdingShape && shared.length >= 2) {
        const merged = mergePair(parent, child, shared);
        collapses.push({ from: [parent.company, child.company], canonical: merged.company, shared });
        if (prev) prev.parent = merged;
        else {
          // child was the focal — splice merged in as the focal.
          Object.keys(child).forEach((k) => { delete child[k]; });
          Object.assign(child, merged);
        }
        changed = true;
        break; // restart pass
      }

      if (holdingShape) {
        const tag = `${parent.company} ↔ ${child.company}`;
        if (!holdingFlags.includes(tag)) holdingFlags.push(tag);
      }

      prev = cursor;
      cursor = cursor.parent;
    }
    if (!changed) break;
  }

  return { tree, collapses, holdingFlags };
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

// ─── Entity collection for revenue enrichment ───────────────────────────────

export function collectEntities(ownership) {
  if (!ownership) return [];
  const out = [];
  const seen = new Set();
  const push = (entity, role, parentName) => {
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
      // Parent context for disambiguation in the revenue agent — without it,
      // sibling lookups for common names (Siena, Mercury, Atlas…) collide with
      // unrelated homonymous companies.
      parent_company: parentName || null,
    });
  };
  const focalParent = ownership.parent?.company || null;
  push(ownership, 'focal', focalParent);
  let p = ownership.parent;
  let depth = 0;
  while (p && depth < 2) {
    push(p, depth === 0 ? 'parent' : 'grandparent', p.parent?.company || null);
    p = p.parent;
    depth++;
  }
  // Prioritize current/active brands before slicing so a recently launched brand
  // (e.g. Cloverlane) is never the one dropped by the cap.
  const orderedSiblings = [...(ownership.siblings || [])].sort(
    (a, b) => (b.in_current_sources === true) - (a.in_current_sources === true)
  );
  // Siblings share the focal's parent in the corporate tree.
  orderedSiblings.slice(0, 8).forEach((s) => push(s, 'sibling', focalParent));
  (ownership.children || []).slice(0, 3).forEach((c) => push(c, 'child', ownership.company));
  return out;
}

// Enforce context_unverified discipline downstream of the model:
//  - Any signal marked context_unverified has its weight forced to "low".
//  - When EVERY signal on a revenue record is context_unverified (and there is
//    at least one signal), zero out the estimate, drop confidence to "low",
//    and synthesize a reason_for_null if the model didn't already write one.
// This is the safety net for Bug #1: even if the model accidentally promotes
// a homonym signal to medium/high, we refuse to surface its estimate.
function applyContextUnverifiedDiscipline(rev, ent) {
  if (!rev || !Array.isArray(rev.signals_found) || rev.signals_found.length === 0) return rev;
  rev.signals_found = rev.signals_found.map((s) => (
    s && s.context_unverified ? { ...s, weight: 'low' } : s
  ));
  const allUnverified = rev.signals_found.every((s) => s && s.context_unverified);
  if (allUnverified) {
    const central = rev.revenue_estimate?.central || 0;
    if (central > 0) {
      rev.revenue_estimate_unverified = { ...rev.revenue_estimate };
      rev.revenue_estimate = { low: 0, high: 0, central: 0 };
    }
    rev.confidence = 'low';
    if (!rev.reason_for_null) {
      const parent = ent?.parent_company;
      const who = ent?.company || 'this entity';
      rev.reason_for_null = parent
        ? `Could not verify signals belong to ${who} as brand of ${parent} vs homonymous entities — all captured signals were context_unverified.`
        : `Could not verify captured signals belong to ${who} vs homonymous entities — all signals were context_unverified.`;
    }
    rev.context_unverified_all = true;
  } else if (rev.signals_found.some((s) => s && s.context_unverified)) {
    rev.context_unverified_some = true;
  }
  return rev;
}

export function attachRevenue(ownership, revenueByCompany, entitiesByCompany = {}) {
  if (!ownership) return ownership;
  const clone = JSON.parse(JSON.stringify(ownership));
  const lookupEnt = (k) => entitiesByCompany[k] || null;
  const visit = (node) => {
    if (!node) return;
    const key = (node.company || '').toLowerCase().trim();
    const rev = revenueByCompany[key];
    if (rev) {
      applyContextUnverifiedDiscipline(rev, lookupEnt(key));
      node.revenue_estimate = {
        low: rev.revenue_estimate?.low ?? 0,
        high: rev.revenue_estimate?.high ?? 0,
        central: rev.revenue_estimate?.central ?? 0,
        confidence: rev.confidence || 'low',
      };
      node.signals_found = rev.signals_found || [];
      node.reasoning_summary = rev.reasoning_summary || '';
      if (rev.reason_for_null) node.reason_for_null = rev.reason_for_null;
      if (rev.error) node.revenue_error = rev.error;
      if (rev.context_unverified_all) node.context_unverified_all = true;
      if (rev.context_unverified_some) node.context_unverified_some = true;
    }
    node._derived_status = deriveStatus(node);
    if (node.parent) visit(node.parent);
    (node.siblings || []).forEach((s) => {
      const sk = (s.company || '').toLowerCase().trim();
      const sr = revenueByCompany[sk];
      if (sr) {
        applyContextUnverifiedDiscipline(sr, lookupEnt(sk));
        s.revenue_estimate = {
          low: sr.revenue_estimate?.low ?? 0,
          high: sr.revenue_estimate?.high ?? 0,
          central: sr.revenue_estimate?.central ?? 0,
          confidence: sr.confidence || 'low',
        };
        s.signals_found = sr.signals_found || [];
        s.reasoning_summary = sr.reasoning_summary || '';
        if (sr.reason_for_null) s.reason_for_null = sr.reason_for_null;
        if (sr.context_unverified_all) s.context_unverified_all = true;
        if (sr.context_unverified_some) s.context_unverified_some = true;
      }
      s._derived_status = deriveStatus(s);
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
export function synthesize(ownership, revenueByCompany, parentAnchor = null, entitiesByCompany = {}) {
  // Defensive normalization: even if the model honored the chain-collapse
  // instruction, re-run the rule downstream so two-layer duplicates are never
  // displayed (Bug #5).
  const { tree: normalized, collapses, holdingFlags } = normalizeChain(ownership);
  const tree = attachRevenue(normalized, revenueByCompany, entitiesByCompany);
  const anchorAdjustment = applyAnchorAdjustment(tree, parentAnchor);
  if (parentAnchor) tree.parent_anchor = parentAnchor;
  const notes = [];
  collapses.forEach((c) => {
    notes.push(`Chain normalized: collapsed "${c.from[0]}" and "${c.from[1]}" into "${c.canonical}" (shared identifiers: ${c.shared.join(', ')}).`);
  });
  holdingFlags.forEach((tag) => {
    notes.push(`⚠ Review: ${tag} look like a holding/operating pair — kept as separate layers; verify they are not the same legal entity.`);
  });

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

    const benchmark = anchorTotal > 0 ? anchorTotal : parentRev;
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
        anchor_adjustment: anchorAdjustment,
      };
      if (consolidated_siblings.length) {
        const verb = consolidated_siblings.length > 1 ? 'are' : 'is';
        notes.push(`${consolidated_siblings.join(', ')} ${verb} consolidated within the ${tree.parent.company} "${focalSeg.name}" segment — excluded from the sum to avoid double-counting.`);
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
