// Pure synthesis + derivation logic, extracted from app.jsx so it can be unit
// tested without React/DOM/fetch. Imported back into app.jsx for the pipeline
// and UI. No JSX, no browser globals.

import { buildIntelligenceBrief } from './brief.js';

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

// Generic / structural modifier tokens that are not distinctive holding-family
// identifiers on their own. Used by sharedHoldingToken below: when comparing
// e.g. "Ashley Furniture Industries" vs "Ashley Home" we want "ashley" to
// surface as the shared distinctive token, not "industries" or "home".
const GENERIC_BRAND_TOKEN_RE = /^(the|and|of|a|an|holdings?|holding|group|co|company|corp|corporation|incorporated|inc|ltd|limited|llc|plc|sa|se|ag|gmbh|nv|bv|spa|kk|industries|industry|global|international|intl|enterprises?|brands?|partners?|streaming|home|retail|publishing|entertainment|stores?|services?|technologies|technology|tech|systems?|solutions?|media|digital|studios?|labs?|works|operations?|networks?)$/i;

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

// Pick the canonical layer among a run of same-holding-token layers. Preference:
// (1) layer with a real revenue figure (the "with-revenue" wins so we don't lose
// the number), (2) most formal legal suffix, (3) longest name. The chosen layer
// is what callers will keep as the canonical chain entry.
function pickCanonicalLayer(layers, _revLookupFn) {
  if (!layers || layers.length === 0) return null;
  if (layers.length === 1) return layers[0];
  // Pick by name shape only: a legal suffix wins (most formal), else the
  // longest name. Revenue is preserved separately via attachRevenue's
  // _collapsed_from alias lookup, so we don't need to bias toward whichever
  // merged layer happened to carry the number.
  let best = layers[0];
  for (let i = 1; i < layers.length; i++) {
    const cur = layers[i];
    const bestHas = LEGAL_SUFFIX_RE.test(best.company || ''); LEGAL_SUFFIX_RE.lastIndex = 0;
    const curHas = LEGAL_SUFFIX_RE.test(cur.company || ''); LEGAL_SUFFIX_RE.lastIndex = 0;
    if (curHas && !bestHas) { best = cur; continue; }
    if (bestHas && !curHas) continue;
    if ((cur.company || '').length > (best.company || '').length) best = cur;
  }
  return best;
}

// Tokenize a company name into its distinctive brand tokens (strip legal
// suffixes, splits, generic modifier words). "Ashley Furniture Industries" →
// ["ashley", "furniture"]; "Walt Disney Company" → ["walt", "disney"].
function brandTokens(name) {
  if (!name) return [];
  return stripLegalSuffix(name)
    .split(/[\s\-&/.,]+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length >= 3 && !GENERIC_BRAND_TOKEN_RE.test(t));
}

// Returns the distinctive token shared between two company names, or null when
// none. Used to detect same-holding-family layers (Ashley * , Disney *,
// Activision *) that the model has emitted as separate chain entries.
function sharedHoldingToken(a, b) {
  const ta = new Set(brandTokens(a?.company));
  for (const t of brandTokens(b?.company)) {
    if (ta.has(t)) return t;
  }
  return null;
}

// Token shared across ALL layers in the list (intersection of their
// brandTokens). Returns the first surviving token or null.
function commonHoldingToken(layers) {
  if (!layers || layers.length < 2) return null;
  let acc = new Set(brandTokens(layers[0]?.company));
  for (let i = 1; i < layers.length; i++) {
    const next = new Set(brandTokens(layers[i]?.company));
    acc = new Set([...acc].filter((t) => next.has(t)));
    if (acc.size === 0) return null;
  }
  return acc.values().next().value || null;
}

// Central revenue figure looked up by company key (pre-attach). 0 when missing.
function revLookupCentral(node, revenueByCompany) {
  if (!node || !revenueByCompany) return 0;
  const r = revenueByCompany[keyOf(node)];
  return r?.revenue_estimate?.central || 0;
}

// Two revenue centrals are "approximately equal" within ±5% of the larger.
function approxRevenueMatch(a, b) {
  if (!(a > 0) || !(b > 0)) return false;
  const tol = Math.max(a, b) * 0.05;
  return Math.abs(a - b) <= tol;
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
// When `canonicalOverride` is provided (used by the holding-token rules) it is
// used as the canonical name instead of running pickCanonicalName.
function mergePair(parent, child, sharedKeys, canonicalOverride = null) {
  const canonical = canonicalOverride || pickCanonicalName(parent, child);
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
// Returns { tree, collapses: [{ from: [a,b], canonical, shared, mode }], holdingFlags: [...] }
//
// `revenueByCompany` (optional) is the same lookup used by attachRevenue; when
// provided, it powers two additional collapse modes for the Ashley/Disney/
// Activision recurrence (round 2 of Bug #5):
//   - holding_token_revenue_match: 2 adjacent layers share a distinctive brand
//     token (e.g. "ashley") AND their lookup revenues are within ~5% of each
//     other → same legal entity emitted twice.
//   - holding_token_run: 3+ consecutive layers all share a single distinctive
//     brand token → almost certainly the same conglomerate's name variants
//     (Ashley Furniture Industries / Ashley Global Retail / Ashley Home).
export function normalizeChain(ownership, revenueByCompany = null) {
  if (!ownership) return { tree: ownership, collapses: [], holdingFlags: [] };
  const tree = JSON.parse(JSON.stringify(ownership));
  const collapses = [];
  const holdingFlags = [];
  const revLookupFn = (n) => revLookupCentral(n, revenueByCompany || {});

  // Splice a `merged` node into the position currently held by `child` in the
  // chain. `prev` is whatever has child as its parent (null when child === tree).
  const spliceInto = (child, prev, merged) => {
    if (prev) prev.parent = merged;
    else {
      Object.keys(child).forEach((k) => { delete child[k]; });
      Object.assign(child, merged);
    }
  };

  for (let pass = 0; pass < 6; pass++) {
    let changed = false;

    // ── Pass A: long-run holding-token collapse (3+ consecutive layers sharing
    // one distinctive brand token). Catches Ashley triple-layer regardless of
    // which sub-affiliate the model attached the conglomerate revenue to.
    const chainArr = [];
    let walker = tree;
    const prevOf = []; // prevOf[i] is the node whose .parent === chainArr[i]; null for i=0
    while (walker) {
      prevOf.push(chainArr.length === 0 ? null : chainArr[chainArr.length - 1]);
      chainArr.push(walker);
      walker = walker.parent;
    }
    // Find the longest run of consecutive layers sharing a common token.
    // The focal (index 0) is EXCLUDED — the user's queried entity must never
    // be collapsed into its parent/root even if the names share a token
    // (e.g. "Disney Cruise" → "Disney Entertainment" → "The Walt Disney
    // Company"; focal must remain "Disney Cruise").
    let bestStart = -1; let bestLen = 0; let bestTok = null;
    for (let i = 1; i < chainArr.length - 1; i++) {
      for (let j = chainArr.length; j > i + 1; j--) {
        const slice = chainArr.slice(i, j);
        const tok = commonHoldingToken(slice);
        if (tok && (j - i) > bestLen) { bestStart = i; bestLen = j - i; bestTok = tok; }
        if (tok) break;
      }
    }
    if (bestLen >= 3) {
      const run = chainArr.slice(bestStart, bestStart + bestLen);
      const canonical = pickCanonicalLayer(run, revLookupFn);
      // Collapse the run pairwise, bottom-up, into a single merged node.
      let merged = run[0];
      for (let k = 1; k < run.length; k++) {
        merged = mergePair(run[k], merged, [`holding_token:${bestTok}`], canonical.company);
      }
      // After bottom-up collapse, `merged.parent` is run[run.length-1].parent —
      // which is the layer ABOVE the run (or null).
      merged.parent = run[run.length - 1].parent || null;
      collapses.push({
        from: run.map((n) => n.company),
        canonical: merged.company,
        shared: [`holding_token:${bestTok}`],
        mode: 'holding_token_run',
      });
      const childOfRun = run[0];
      const prevOfRun = prevOf[bestStart];
      spliceInto(childOfRun, prevOfRun, merged);
      changed = true;
      continue;
    }

    // ── Pass B: original 2-layer collapse (2+ strong identifiers).
    let cursor = tree;
    let prev = null;
    while (cursor && cursor.parent) {
      const child = cursor;
      const parent = cursor.parent;
      const strippedChild = stripLegalSuffix(child.company);
      const strippedParent = stripLegalSuffix(parent.company);
      const nameMatch = strippedChild && strippedParent && strippedChild === strippedParent;

      const childToken = (child.company || '').match(HOLDING_TOKEN_RE);
      const parentToken = (parent.company || '').match(HOLDING_TOKEN_RE);
      const holdingShape = !nameMatch && (
        (childToken && stripLegalSuffix((child.company || '').replace(HOLDING_TOKEN_RE, '')) === strippedParent) ||
        (parentToken && stripLegalSuffix((parent.company || '').replace(HOLDING_TOKEN_RE, '')) === strippedChild)
      );

      const shared = sharedIdentifiers(parent, child);
      if (!holdingShape && shared.length >= 2) {
        const merged = mergePair(parent, child, shared);
        collapses.push({ from: [parent.company, child.company], canonical: merged.company, shared, mode: 'shared_identifiers' });
        spliceInto(child, prev, merged);
        changed = true;
        break;
      }

      // Note (Task #40): a 2-layer "shared holding token + matching revenue"
      // collapse rule was considered here but rejected — it false-positives on
      // legitimate parent/subsidiary pairs with 100% ownership (e.g. Patagonia
      // ↔ Patagonia Purpose Trust). The 2-layer misattribution case is handled
      // instead by guardConglomerateRevenueOnSubAffiliate after attach, which
      // clears the intermediate sub-affiliate's revenue without dropping its
      // node identity. The 3+ same-token-run case stays in Pass A above.

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

// Conglomerate-revenue guard: after attachRevenue runs, walk the focal→root
// chain. When a descendant carries a revenue figure that matches a strict
// ancestor's revenue AND the two share a distinctive holding token (so they
// are almost certainly the same conglomerate captured twice), clear the
// descendant's number — the conglomerate total cannot legitimately sit on a
// sub-affiliate operational layer. The cleared layer keeps its node identity
// (chain position, sources, strategic_control) so callers can still render it,
// but its revenue_estimate is reset and a re-route record is returned for the
// synthesis-note pass to surface in plain language.
//
// Returns: [{ from: <descendant>, to: <ancestor>, central, token }]
export function guardConglomerateRevenueOnSubAffiliate(tree) {
  if (!tree) return [];
  const reroutes = [];
  // Walk top-down so when multiple descendants would each lose to the same
  // ancestor, each is recorded relative to that ancestor.
  const chain = [];
  let n = tree;
  while (n) { chain.unshift(n); n = n.parent; }
  // chain is now [root, ..., focal]. The focal (i === chain.length - 1) is
  // intentionally skipped — its revenue is what the user asked about and must
  // never be cleared by this guard; misattribution we care about is on the
  // INTERMEDIATE chain layers between focal and root.
  for (let i = chain.length - 2; i >= 1; i--) {
    const descendant = chain[i];
    const dCentral = descendant.revenue_estimate?.central || 0;
    if (!(dCentral > 0)) continue;
    for (let j = i - 1; j >= 0; j--) {
      const ancestor = chain[j];
      const aCentral = ancestor.revenue_estimate?.central || 0;
      if (!(aCentral > 0)) continue;
      const token = sharedHoldingToken(descendant, ancestor);
      if (!token) continue;
      if (!approxRevenueMatch(dCentral, aCentral)) continue;
      // Clear the descendant's misattributed conglomerate-level revenue.
      descendant.revenue_estimate_rerouted = { ...descendant.revenue_estimate };
      descendant.revenue_estimate = { low: 0, high: 0, central: 0, confidence: 'low' };
      descendant.revenue_rerouted_to = ancestor.company;
      reroutes.push({ from: descendant.company, to: ancestor.company, central: dCentral, token });
      break; // descendant handled; don't double-reroute it
    }
  }
  return reroutes;
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

// Task #42: when the upstream revenue agent emits both a bottom-up (signal-based)
// estimate AND a top-down (share-of-parent) estimate for the same sibling, compute
// the divergence between the two centrals and pick a documented central. The
// agent attaches these as `rev.bottom_up` / `rev.top_down` sub-records of the
// shape `{ low, high, central, confidence, method, source_summary }`. When only
// one strategy is present this returns null and the existing single estimate
// flows through unchanged.
//
// Central-pick rule:
//   - prefer bottom_up when its confidence is medium or high (signal-grounded);
//   - otherwise blend the two centrals (arithmetic mean) so neither side dominates.
//
// Divergence flag fires when |buC - tdC| / max(buC, tdC) > 0.30 — matching the
// T04* Nectar regression (sibling $450M vs focal-as-focal $275M = 39%).
export function computeRevenueDivergence(rev) {
  const bu = rev?.bottom_up;
  const td = rev?.top_down;
  if (!bu || !td) return null;
  const buC = Number(bu.central) || 0;
  const tdC = Number(td.central) || 0;
  if (!(buC > 0) || !(tdC > 0)) return null;
  const denom = Math.max(buC, tdC);
  const divergence_pct = Math.round((Math.abs(buC - tdC) / denom) * 100);
  const divergence_flag = divergence_pct > 30;
  const preferBU = bu.confidence === 'medium' || bu.confidence === 'high';
  const central = preferBU ? buC : Math.round((buC + tdC) / 2);
  const method = preferBU ? 'bottom_up_preferred' : 'blended';
  return {
    bottom_up: { ...bu },
    top_down: { ...td },
    divergence_pct,
    divergence_flag,
    central,
    method,
  };
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
  const push = (entity, role, parentName, extra = {}) => {
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
      ...extra,
    });
  };
  const focalParent = ownership.parent?.company || null;
  push(ownership, 'focal', focalParent);
  let p = ownership.parent;
  let depth = 0;
  while (p && depth < 2) {
    // Skip individuals (UBO natural persons) — the revenue agent investigates
    // companies, not people; "Zhang Yiming revenue" is a meaningless query.
    if (p.node_type !== 'individual') {
      push(p, depth === 0 ? 'parent' : 'grandparent', p.parent?.company || null);
    }
    p = p.parent;
    depth++;
  }
  // Issue #3: the ROOT always deserves an independent estimate. Public mega-caps
  // (Microsoft, Berkshire, Apple, Alphabet) must never surface null revenue just
  // because they sit beyond the depth-2 ancestor walk above a chain like
  // Call of Duty → Activision Publishing → Activision Blizzard → Microsoft.
  // Walk to the top; dedup skips it when it was already captured as parent/grandparent.
  let root = ownership.parent;
  while (root && root.parent) root = root.parent;
  if (root && root.node_type !== 'individual') {
    push(root, 'root', null);
  }
  // Issue #4-bis: distribution-channel brands (free OS/browser vehicles such as
  // Chrome or Android) have no standalone revenue — their economics roll up to
  // the parent. Skip the revenue-inference call entirely so we neither pay for it
  // nor invent a misleading figure; they render as "—" downstream.
  const earnsStandalone = (n) => n && n.revenue_model !== 'distribution_channel';
  // Prioritize current/active brands before slicing so a recently launched brand
  // (e.g. Cloverlane) is never the one dropped by the cap.
  const orderedSiblings = [...(ownership.siblings || [])]
    .filter(earnsStandalone)
    .sort((a, b) => (b.in_current_sources === true) - (a.in_current_sources === true));
  // Siblings share the focal's parent in the corporate tree.
  orderedSiblings.slice(0, 8).forEach((s) => push(s, 'sibling', focalParent));
  (ownership.children || []).filter(earnsStandalone).slice(0, 3).forEach((c) => push(c, 'child', ownership.company));
  // Bug #2 co-owners: additional formal owners (steward ownership, JVs,
  // dual-class). Estimate revenue for each so the UI and reconciliation can
  // surface their economic contribution (e.g. Comcast in pre-2023 Hulu).
  (ownership.co_owners || []).slice(0, 5).forEach((co) => push(co, 'co_owner', null, {
    ownership_role: co.ownership_role || null,
    stake_pct: co.stake_pct ?? null,
    voting_pct: co.voting_pct ?? null,
    entity_type: co.entity_type || null,
  }));
  // Cousins: same parent, different segment. Capped to keep cost predictable
  // on mega-aggregators (LVMH, P&G, Unilever…). Current-source brands first so
  // a cap never drops a live brand in favor of a historical one.
  const orderedCousins = [...(ownership.intra_parent_cousins || [])]
    .filter(earnsStandalone)
    .sort((a, b) => (b.in_current_sources === true) - (a.in_current_sources === true));
  orderedCousins.slice(0, 6).forEach((c) => push(c, 'cousin', focalParent, {
    via_division: c.via_division || null,
  }));
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
    // Primary lookup is by current (post-collapse) company name. If the layer
    // was produced by a chain collapse (Task #40), the conglomerate's revenue
    // may have been keyed under one of the merged names instead — fall back to
    // those before declaring "no revenue", so the canonical layer keeps the
    // number rather than dropping it.
    let rev = revenueByCompany[key];
    if (!rev && Array.isArray(node._collapsed_from)) {
      for (const alt of node._collapsed_from) {
        const altKey = (alt || '').toLowerCase().trim();
        if (altKey && altKey !== key && revenueByCompany[altKey]) {
          rev = revenueByCompany[altKey];
          node._revenue_lookup_alias = alt;
          break;
        }
      }
    }
    if (rev) {
      applyContextUnverifiedDiscipline(rev, lookupEnt(key));
      const div = computeRevenueDivergence(rev);
      node.revenue_estimate = {
        low: rev.revenue_estimate?.low ?? 0,
        high: rev.revenue_estimate?.high ?? 0,
        central: rev.revenue_estimate?.central ?? 0,
        confidence: rev.confidence || 'low',
        ...(div ? {
          bottom_up: div.bottom_up,
          top_down: div.top_down,
          divergence_pct: div.divergence_pct,
          divergence_flag: div.divergence_flag,
          method: div.method,
        } : {}),
      };
      node.signals_found = rev.signals_found || [];
      node.reasoning_summary = rev.reasoning_summary || '';
      if (rev.signals_attempted != null) node.signals_attempted = rev.signals_attempted;
      if (rev.signals_found_count != null) node.signals_found_count = rev.signals_found_count;
      if (rev.reason_for_null) node.reason_for_null = rev.reason_for_null;
      if (rev.error) node.revenue_error = rev.error;
      if (rev.context_unverified_all) node.context_unverified_all = true;
      if (rev.context_unverified_some) node.context_unverified_some = true;
    }
    node._derived_status = deriveStatus(node);
    node._divestiture = deriveDivestiture(node);
    if (node.parent) visit(node.parent);
    const applyToPeer = (peer) => {
      const pk = (peer.company || '').toLowerCase().trim();
      const pr = revenueByCompany[pk];
      // Issue #4-bis: a distribution channel never carries a standalone estimate,
      // even if a stray revenue record exists upstream — refuse to attach it.
      if (pr && peer.revenue_model !== 'distribution_channel') {
        applyContextUnverifiedDiscipline(pr, lookupEnt(pk));
        const pdiv = computeRevenueDivergence(pr);
        peer.revenue_estimate = {
          low: pr.revenue_estimate?.low ?? 0,
          high: pr.revenue_estimate?.high ?? 0,
          // Task #42: when both bottom_up and top_down sub-estimates are present
          // on a sibling, override central with the documented pick rule (prefer
          // bottom-up if confidence ≥ medium, else blend) so the cross-run
          // divergence (e.g. T04* Nectar $450M sibling vs $275M focal) is
          // surfaced rather than buried under whichever single number the agent
          // emitted as `central`. Out-of-scope on the focal — its own pipeline
          // owns its central.
          central: pdiv ? pdiv.central : (pr.revenue_estimate?.central ?? 0),
          confidence: pr.confidence || 'low',
          ...(pdiv ? {
            bottom_up: pdiv.bottom_up,
            top_down: pdiv.top_down,
            divergence_pct: pdiv.divergence_pct,
            divergence_flag: pdiv.divergence_flag,
            method: pdiv.method,
          } : {}),
        };
        peer.signals_found = pr.signals_found || [];
        peer.reasoning_summary = pr.reasoning_summary || '';
        if (pr.signals_attempted != null) peer.signals_attempted = pr.signals_attempted;
        if (pr.signals_found_count != null) peer.signals_found_count = pr.signals_found_count;
        if (pr.reason_for_null) peer.reason_for_null = pr.reason_for_null;
        if (pr.context_unverified_all) peer.context_unverified_all = true;
        if (pr.context_unverified_some) peer.context_unverified_some = true;
      } else if (peer.revenue_model === 'distribution_channel') {
        // Issue #4-bis: no standalone revenue was estimated by design (the call
        // was skipped in collectEntities). Surface a contextual reason so the UI
        // explains the dash instead of leaving it blank or showing $0.
        const owner = node.parent?.company || node.company || 'the parent brand';
        peer.reason_for_null = peer.reason_for_null
          || `Distribution channel — revenue accrues to ${owner}; not estimated standalone.`;
      }
      peer._derived_status = deriveStatus(peer);
      peer._divestiture = deriveDivestiture(peer);
    };
    (node.siblings || []).forEach(applyToPeer);
    (node.intra_parent_cousins || []).forEach(applyToPeer);
    (node.co_owners || []).forEach(applyToPeer);
    (node.children || []).forEach(visit);
  };
  visit(clone);
  return clone;
}

// Issue #7 (F11): the per-sibling anchor auto-correct was removed. Scaling raw
// estimates by `anchorTotal / sumRaw` to force them to sum to the parent's 10-K
// total converted an honest coverage gap into fictional precision (e.g. T18
// GEICO: $42B raw → $44B "adjusted", National Indemnity inflated past its whole
// reinsurance segment). F11 = capture what you find; classify only after capture.
// We now preserve raw central estimates and surface the gap via the deterministic
// reconciliation explanation (`buildReconciliationExplanation`) instead.

// Build the focal → root layer chain (root first), used for per-layer passes.
function layerChain(tree) {
  const chain = [];
  let p = tree.parent;
  while (p) { chain.unshift(p); p = p.parent; }
  return [...chain, tree];
}

// Issue #5: a child can never out-earn the parent that owns it. When a captured
// central exceeds its parent's (e.g. Activision Publishing $10B > Activision
// Blizzard $5.72B), the figures are from different fiscal eras or scopes
// (pre/post-acquisition). Flag the outlier with requires_review instead of
// silently presenting the impossible child>parent — never auto-fix the number.
// Returns the list of "child > parent" pairs found (for the synthesis note).
function flagRevenueConsistency(tree) {
  const central = (n) => n?.revenue_estimate?.central || 0;
  const flagged = [];
  const check = (child, parent) => {
    if (!child || !parent) return;
    const c = central(child);
    const p = central(parent);
    if (c > 0 && p > 0 && c > p) {
      child.requires_review = true;
      child.revenue_review_reason =
        `Estimate ${formatUSD(c)} exceeds owner ${parent.company} (${formatUSD(p)}) — impossible for a subsidiary; likely a different fiscal era or scope (pre/post-acquisition).`;
      flagged.push(`${child.company} (${formatUSD(c)}) > ${parent.company} (${formatUSD(p)})`);
    }
  };
  // Every node in the focal→root chain vs the node directly above it.
  let n = tree;
  while (n && n.parent) { check(n, n.parent); n = n.parent; }
  // Focal's direct children vs the focal; siblings vs the shared parent.
  (tree.children || []).forEach((c) => check(c, tree));
  (tree.siblings || []).forEach((s) => check(s, tree.parent));
  return flagged;
}

// Issue #5-bis: pull a declared segment revenue figure (e.g. "Mars Petcare $22B")
// out of free-text signals/notes so reconciliation can flag a within-segment
// coverage gap even when there is no 10-K segment anchor. Requires the segment
// name to appear within a short window before the dollar figure (avoids matching
// an unrelated number elsewhere in the blob). Returns USD or null.
function parseDeclaredSegmentRevenue(segmentName, blob) {
  if (!segmentName || !blob) return null;
  const seg = String(segmentName).trim();
  if (seg.length < 3) return null;
  const esc = seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(esc + '[^$]{0,40}\\$\\s?([0-9]+(?:\\.[0-9]+)?)\\s?(b|bn|billion|m|mm|million)\\b', 'i');
  const m = blob.match(re);
  if (!m) return null;
  const val = parseFloat(m[1]);
  if (!isFinite(val) || val <= 0) return null;
  return m[2].toLowerCase().startsWith('b') ? val * 1e9 : val * 1e6;
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
  // displayed (Bug #5). Round 2 (Task #40) extends this with revenue-aware
  // holding-token rules for the Ashley/Disney/Activision recurrence, and a
  // post-attach guard that clears conglomerate revenue misattributed to a
  // sub-affiliate operational layer.
  const { tree: normalized, collapses, holdingFlags } = normalizeChain(ownership, revenueByCompany);
  const tree = attachRevenue(normalized, revenueByCompany, entitiesByCompany);
  if (parentAnchor) tree.parent_anchor = parentAnchor;
  const notes = [];
  collapses.forEach((c) => {
    if (c.mode === 'holding_token_run') {
      notes.push(`Chain normalized: collapsed ${c.from.length} consecutive "${(c.shared[0] || '').replace('holding_token:', '')}" layers (${c.from.map((n) => `"${n}"`).join(', ')}) into "${c.canonical}" — same conglomerate emitted under multiple name variants.`);
    } else if (c.mode === 'holding_token_revenue_match') {
      const tok = (c.shared.find((s) => s.startsWith('holding_token:')) || '').replace('holding_token:', '');
      notes.push(`Chain normalized: collapsed "${c.from[0]}" and "${c.from[1]}" into "${c.canonical}" — shared brand token "${tok}" and matching revenue figures indicate one entity emitted twice.`);
    } else {
      notes.push(`Chain normalized: collapsed "${c.from[0]}" and "${c.from[1]}" into "${c.canonical}" (shared identifiers: ${c.shared.join(', ')}).`);
    }
  });
  holdingFlags.forEach((tag) => {
    notes.push(`⚠ Review: ${tag} look like a holding/operating pair — kept as separate layers; verify they are not the same legal entity.`);
  });

  // Conglomerate-revenue guard: descendants must not carry the same revenue
  // figure as a strict ancestor when they share a distinctive brand token.
  const reroutes = guardConglomerateRevenueOnSubAffiliate(tree);
  reroutes.forEach((r) => {
    notes.push(`Chain normalized: ${formatUSD(r.central)} attached to "${r.from}" matched its ancestor "${r.to}" exactly and shared the "${r.token}" brand token — re-routed to "${r.to}" (the conglomerate total cannot legitimately sit on a sub-affiliate operational layer).`);
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

  // Issue #5: flag any child whose central exceeds its parent's (run after the
  // parent's revenue is finalized above, including the 10-K anchor override).
  const consistencyFlags = flagRevenueConsistency(tree);
  if (consistencyFlags.length > 0) {
    notes.push(`⚠ Revenue consistency: ${consistencyFlags.join('; ')} — a subsidiary cannot out-earn its owner; flagged for review (likely mismatched fiscal eras or scope, not a real figure to trust).`);
  }

  const focalRev = tree.revenue_estimate?.central || 0;
  const parentRev = tree.parent?.revenue_estimate?.central || 0;
  // Bug #2: when co_owners exist (steward ownership, JVs, dual-class), the
  // focal's economic base is parent + co_owners combined — otherwise the ratio
  // exceeds 100% (e.g. Patagonia → Purpose Trust 2% / Holdfast 98%).
  const coOwners = Array.isArray(tree.co_owners) ? tree.co_owners : [];
  const coOwnersRev = coOwners.reduce((a, c) => a + (c.revenue_estimate?.central || 0), 0);
  const ownerGroupRev = parentRev + coOwnersRev;
  const ownerGroupLabel = coOwners.length > 0
    ? `${tree.parent?.company || 'parent'} + ${coOwners.length} co-owner${coOwners.length === 1 ? '' : 's'}`
    : tree.parent?.company || 'parent';

  let focal_vs_parent_ratio = 'N/A (standalone)';
  if (tree.parent && ownerGroupRev > 0) {
    const pct = ((focalRev / ownerGroupRev) * 100).toFixed(1);
    focal_vs_parent_ratio = `${pct}% of ${ownerGroupLabel} revenue`;
  } else if (tree.parent && ownerGroupRev === 0) {
    focal_vs_parent_ratio = `${ownerGroupLabel} revenue unknown`;
  }

  const siblings = tree.siblings || [];
  let focal_vs_siblings = 'No siblings';
  if (siblings.length > 0) {
    // Issue #10: distinguish "not computed" (no estimate, or a distribution
    // channel that is never estimated) from a real $0. Uncomputed entries render
    // "—", sort last, and are counted separately so they don't masquerade as
    // zero-revenue brands (e.g. Bud Light's Budweiser/Michelob were showing $0).
    const entryOf = (company, rev, focal) => {
      const c = rev?.central;
      const computed = typeof c === 'number' && c > 0;
      return { company, central: computed ? c : 0, computed, focal };
    };
    const ranked = [
      entryOf(tree.company, tree.revenue_estimate, true),
      ...siblings.map((s) => entryOf(s.company, s.revenue_estimate, false)),
    ].sort((a, b) => (Number(b.computed) - Number(a.computed)) || (b.central - a.central));
    const uncomputed = ranked.filter((r) => !r.computed).length;
    const rank = ranked.findIndex((r) => r.focal) + 1;
    const tail = uncomputed > 0 ? ` (${uncomputed} not computed)` : '';
    focal_vs_siblings = `Ranked ${rank} of ${ranked.length}${tail} in family — ${ranked
      .map((r) => `${r.focal ? '★ ' : ''}${r.company} ${r.computed ? formatUSD(r.central) : '—'}`)
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
  if (coOwners.length > 0) {
    const labels = coOwners.map((c) => {
      const stake = c.stake_pct != null ? ` ${c.stake_pct}% econ` : '';
      const vote = c.voting_pct != null ? ` / ${c.voting_pct}% vote` : '';
      const role = c.ownership_role ? ` (${c.ownership_role.replace(/_/g, ' ')})` : '';
      return `${c.company}${role}${stake || vote ? ' —' : ''}${stake}${vote}`;
    }).join('; ');
    const parentRoleStr = tree.ownership_role ? ` as ${tree.ownership_role.replace(/_/g, ' ')}` : '';
    notes.push(`Multi-owner structure: ${tree.parent?.company || 'parent'}${parentRoleStr} alongside co-owner${coOwners.length === 1 ? '' : 's'}: ${labels}. Focal-vs-parent ratio uses the combined owner group.`);
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
  // estimated central. Large gaps surface as an explicit warning + a
  // deterministic explanation — never by scaling the raw estimates (Issue #7).
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
      // Issue #4-bis: distribution channels (Chrome, Android) carry no standalone
      // revenue — never add them to the numerator (they'd double-count the parent).
      if (s.revenue_model === 'distribution_channel') return;
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

    // Prefer the focal segment's reported revenue when available — siblings
    // are already segment-filtered upstream, so benchmarking against the
    // PARENT total guarantees a permanent under-count for multi-division
    // aggregators (LVMH, P&G, Inditex). Fall back to parent total, then to
    // parent's estimated central.
    //
    // Issue #12 guardrail: a reported "segment" whose revenue is far SMALLER than
    // the focal + siblings it supposedly contains is really a sub-product line
    // mis-labelled as a segment (e.g. "LinkedIn $17.81B" reported as Microsoft's
    // focal segment while the siblings sit at the Productivity & Business
    // Processes level). Trusting it yields nonsense ratios (444%, 1642%). Distrust
    // it when the captured sum overshoots it >2× AND the parent's consolidated
    // total is larger — fall back to the parent total.
    const segmentLooksLikeSubLine =
      focalSegmentRev > 0 && sumChildCentralAdj > 2 * focalSegmentRev && anchorTotal > focalSegmentRev;
    const useSegmentBenchmark = focalSegmentRev > 0 && !segmentLooksLikeSubLine;
    const benchmark = useSegmentBenchmark
      ? focalSegmentRev
      : anchorTotal > 0 ? anchorTotal : parentRev;
    const benchmarkSource = useSegmentBenchmark
      ? 'segment'
      : anchorTotal > 0 ? '10-K' : 'estimated';
    const benchmarkLabel = useSegmentBenchmark
      ? `${tree.parent.company} "${focalSeg.name}" segment (${parentAnchor.fiscal_year || 'latest'} 10-K)`
      : anchorTotal > 0
        ? `${tree.parent.company} ${parentAnchor.fiscal_year || 'latest'} 10-K reported revenue`
        : `${tree.parent.company} estimated central revenue`;
    if (segmentLooksLikeSubLine) {
      notes.push(`⚠ Reported segment "${focalSeg.name}" (${formatUSD(focalSegmentRev)}) is smaller than the focal + siblings it supposedly contains (${formatUSD(sumChildCentralAdj)}) — likely a sub-product line, not a reportable segment. Benchmarking against ${tree.parent.company} consolidated total (${formatUSD(benchmark)}) instead.`);
    }

    // Circular detection: when the benchmark is the parent's ESTIMATED central
    // (no independent filing and no segment anchor) and a counted sibling was
    // itself estimated top-down as a share of that parent total, summing it
    // back is self-fulfilling. Only flag when such siblings make up a
    // meaningful chunk of the benchmark.
    const isConsolidatedInFocal = (s) => {
      const name = (s.company || '').toLowerCase().trim();
      const focalSegName = useSegmentBenchmark ? (focalSeg.name || '').toLowerCase() : '';
      return useSegmentBenchmark && focalSegName && name && focalSegName.includes(name);
    };
    const circular_siblings = siblings
      .filter((s, i) => !isConsolidatedInFocal(s) && sibCentrals[i] > 0 && isCircularEstimate(s))
      .map((s) => s.company);
    const circularCentral = siblings.reduce(
      (a, s, i) => (!isConsolidatedInFocal(s) && isCircularEstimate(s) ? a + (sibCentrals[i] || 0) : a),
      0,
    );
    const circular = benchmarkSource === 'estimated'
      && circular_siblings.length > 0
      && benchmark > 0
      && circularCentral >= 0.3 * benchmark;

    if (benchmark > 0) {
      const ratio = sumChildCentralAdj / benchmark;
      const pctDelta = Math.round((ratio - 1) * 100);
      reconciliation = {
        sum_children_central: sumChildCentralAdj,
        parent_benchmark: benchmark,
        parent_benchmark_source: benchmarkSource,
        parent_benchmark_label: benchmarkLabel,
        parent_benchmark_segment_name: useSegmentBenchmark ? focalSeg.name : null,
        parent_total_revenue: anchorTotal > 0 ? anchorTotal : null,
        ratio: Number(ratio.toFixed(3)),
        pct_delta: pctDelta,
        focal_segment_revenue: focalSegmentRev || null,
        children_counted: childrenCounted,
        consolidated_siblings: consolidated_siblings.length ? consolidated_siblings : undefined,
        circular: circular || undefined,
        circular_siblings: circular ? circular_siblings : undefined,
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
      if (useSegmentBenchmark && focalSegmentRev > 0 && rawFocalRev > 0) {
        const segRatio = rawFocalRev / focalSegmentRev;
        if (segRatio > 1.3 || segRatio < 0.7) {
          notes.push(`⚠ Focal estimate (${formatUSD(rawFocalRev)}) diverges from its parent 10-K segment revenue (${formatUSD(focalSegmentRev)}, ${Math.round(segRatio * 100)}%).`);
        }
      }
    }
  }
  // Issue #11: capture depth must not silently vary by which brand is focal. When
  // the parent is a large company but very few in-segment siblings were captured,
  // the run is likely incomplete (e.g. T26 Snickers captured 0 Mars Wrigley
  // siblings vs T21 Royal Canin's 7). Surface it so coverage reads as a floor, not
  // proof. Uses anchor total when public, else the parent's estimated central, so
  // it also fires for private conglomerates like Mars.
  if (tree.parent) {
    const anchorTot = parentAnchor && parentAnchor.is_public ? (parentAnchor.total_revenue_usd || 0) : 0;
    const parentSize = Math.max(anchorTot, parentRev || 0);
    const sibCount = (tree.siblings || []).length;
    const floor = parentSize > 50e9 ? 5 : 3;
    if (parentSize > 5e9 && sibCount < floor) {
      notes.push(`⚠ Only ${sibCount} sibling${sibCount === 1 ? '' : 's'} captured under ${tree.parent.company} (${formatUSD(parentSize)} parent) — expected ≥${floor} for a conglomerate this size; the sibling set may be incomplete and reconciliation coverage is a floor, not a ceiling.`);
    }
  }

  // Issue #5-bis: when no 10-K segment anchor exists, use a segment revenue figure
  // declared in captured signals/notes (e.g. "Mars Petcare $22B") as a
  // supplementary benchmark to flag a within-segment coverage gap.
  if (tree.focal_segment && reconciliation && reconciliation.parent_benchmark_source !== 'segment') {
    const blob = [tree, ...siblings]
      .map((n) => `${n.reasoning_summary || ''} ${n.notes || ''} ${(n.signals_found || []).map((sig) => `${sig.label || ''} ${sig.value || ''}`).join(' ')}`)
      .join(' ');
    const declaredSeg = parseDeclaredSegmentRevenue(tree.focal_segment, blob);
    if (declaredSeg && declaredSeg > 0) {
      reconciliation.segment_anchor_from_signals = declaredSeg;
      const sumCaptured = reconciliation.sum_children_central || 0;
      const gap = declaredSeg - sumCaptured;
      if (sumCaptured > 0 && gap > 0.2 * declaredSeg) {
        notes.push(`Captured focal + siblings sum ${formatUSD(sumCaptured)} vs ${tree.focal_segment} segment declared ${formatUSD(declaredSeg)} in signals — ~${formatUSD(gap)} gap suggests uncaptured ${tree.focal_segment} brands.`);
      }
    }
  }

  if (parentAnchor && parentAnchor.is_public === false) {
    notes.push(`${tree.parent?.company || 'Parent'} is not publicly traded — no 10-K anchor available; reconciliation uses estimates only.`);
  }

  // Task #43: surface prior joint-venture history captured by the agent in
  // model-provided "notes" on the focal or any parent layer (Step 6.7).
  // Pattern: a sentence describing prior JV owners + stakes + consolidation
  // year (e.g. "Prior joint venture: Disney 67% / Comcast 33% — consolidated
  // by Disney in 2023..."). Promote so users see it in strategic_notes; raw
  // node.notes already flows through the tree unchanged.
  const jvHistoryRe = /\b(joint[\s-]?venture|jv)\b[\s\S]{0,200}?\b(consolidat|buyout|bought\s+out|acquir)/i;
  const jvLayers = [tree, ...(function chain(n) { const out = []; let p = n?.parent; while (p) { out.push(p); p = p.parent; } return out; })(tree)];
  jvLayers.forEach((node) => {
    const txt = (node && typeof node.notes === 'string') ? node.notes.trim() : '';
    if (!txt || !jvHistoryRe.test(txt)) return;
    const label = node === tree ? tree.company : node.company;
    const already = notes.some((n) => n.includes(txt));
    if (!already) notes.push(`Prior JV history (${label}): ${txt}`);
  });

  const strategic_notes = notes.length > 0 ? notes : ['No distinctive structural signals captured.'];

  const intelligence_brief = buildIntelligenceBrief(tree, {
    focal_vs_parent_ratio,
    focal_vs_siblings,
    growth_signals,
    strategic_notes,
    reconciliation,
    parent_anchor: parentAnchor || null,
  }, { collapses, holdingFlags });

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
    intelligence_brief,
  };
}
