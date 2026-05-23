import React, { useState, useEffect, useMemo } from 'react';

const MODEL = 'claude-sonnet-4-20250514';

// ─── System prompts ──────────────────────────────────────────────────────────

const OWNERSHIP_PROMPT = `You are a research agent that resolves corporate ownership graphs. Your output is a hierarchical, verifiable tree. Every node is backed by a concrete source. If you cannot back it, you do not emit it. An incomplete tree beats a false tree.

PROCESS

Step 1 — Identity verification. Before resolving ownership, confirm WHICH entity it is (canonical domain, sector, country). If the input has more than one plausible match, return disambiguation_required:true with candidates and stop.

Step 2 — Distinguish legal entity vs operating brand. Mark node_type: "legal_entity" | "operating_brand" on each node.

Step 3 — Parent search. Queries in order: "[company] parent company" → "[company] acquired by" → "[company] subsidiary of" → SEC EDGAR if US-public → financial press.

Step 4 — Recurse to root. Stop conditions: ultimate parent identifiable, PE firm (mark terminal_layer:"private_equity" and stop), or no evidence.

Step 5 — Siblings. For each intermediate node, list brands at the same layer, ONLY with verifiable source.

Step 6 — Children. If the input is a parent, list direct subsidiaries.

Step 7 — Strategic control. Capture control/governance relationships that are NOT formal ownership: board members, investors/VCs, PE backers, major shareholders, founders. Include ONLY with clear evidence (funding press release, SEC 13D/13G, official board page, M&A announcement).

DEPTH/FAN-OUT CAP
Limit ownership recursion to 2–3 generations. Cap siblings to the 6 most material brands. Cap children to 6 direct subsidiaries.

ANTI-HALLUCINATION
Without parent evidence → standalone:true. Without evidence → don't emit. Internal memory loses to search.

CONFIDENCE
high: ≥2 Tier A/B sources, <3 years.
medium: 1 Tier A/B or ≥2 Tier C.
low: only Tier C or >3 years without reconfirmation.

STRICT JSON OUTPUT, NO PROSE, NO MARKDOWN FENCES:
{
  "company": str, "domain": str, "node_type": "legal_entity"|"operating_brand",
  "layer": "brand"|"aggregator"|"parent"|"root",
  "standalone": bool,
  "terminal_layer": "root"|"private_equity"|null,
  "status": "active"|"defunct"|"acquired"|"spun_off",
  "parent": {recursive} | null,
  "siblings": [{"company": str, "domain": str, "node_type": str}],
  "children": [{recursive}],
  "acquisition": {"acquired_by": str, "year": int, "source_url": str} | null,
  "strategic_control": [{"entity": str, "relationship": "board_member"|"investor"|"pe_backer"|"major_shareholder"|"founder", "details": str, "source_url": str}],
  "confidence": "high"|"medium"|"low",
  "sources": [url],
  "notes": str,
  "disambiguation_required": bool,
  "disambiguation_candidates": [{"company": str, "sector": str, "country": str}]
}`;

const REVENUE_PROMPT = `You are a Revenue Inference Agent investigating private companies.

Goal: estimate the annual revenue of a brand by gathering behavioral signals from the web. The user gives you a brand name; you investigate and produce a revenue range with confidence.

## Search strategy

1. Disambiguate first: confirm which entity you are investigating.
2. Gather behavioral signals — proxies for revenue:
   - Web traffic estimates (SimilarWeb / Semrush mentions)
   - Hiring velocity (LinkedIn count, careers postings)
   - Customer base size (G2, Trustpilot, Capterra, App Store)
   - Public pricing pages (ACV / deal size)
   - Funding history (total raised, valuation)
   - Press coverage and YoY growth quotes
   - Customer logos / case studies
   - Geographic footprint
   - Marketplace presence (Amazon BSR, app rank)
3. Cross-reference at least 2 sources per critical signal.
4. Be skeptical of any single revenue figure quoted online.

Aim for 4+ distinct signals. Stop earlier if more searches will not help. You have a HARD CAP of 4 web searches.

## Output

Produce a final JSON block in this EXACT format, wrapped in \`\`\`json ... \`\`\`:

\`\`\`json
{
  "revenue_estimate": {
    "low": <USD integer>,
    "high": <USD integer>,
    "central": <USD integer>
  },
  "confidence": "low" | "medium" | "high",
  "signals_found": [
    {
      "type": "web_traffic" | "hiring" | "reviews" | "pricing" | "funding" | "customers" | "press" | "marketplace" | "other",
      "label": "<short signal name, max 5 words>",
      "value": "<the actual data point found>",
      "source": "<source name or short URL>",
      "weight": "low" | "medium" | "high"
    }
  ],
  "reasoning_summary": "<2-4 sentences explaining how the signals triangulate to the estimate>"
}
\`\`\`

Weak/contradictory signals → wider range, "low" confidence. If you genuinely cannot estimate, set numbers to 0 and confidence "low" with a reasoning_summary explaining why.`;

const PARENT_ANCHOR_PROMPT = `You are a filings agent. Given a PARENT company and a FOCAL subsidiary, determine if PARENT is publicly traded and, if so, extract the latest annual-report (10-K / 20-F / annual filing) segment revenue.

Rules:
- Search authoritative sources only: SEC EDGAR, the company's IR site, the actual 10-K/20-F PDF, or a reputable financial press summary of the filing.
- If the filing breaks revenue by segment, list each segment with USD revenue. Mark "contains_focal":true on the segment that most plausibly contains FOCAL (by brand list, business description, or geography).
- If PARENT is private or no filing is locatable, return is_public:false and null fields.
- HARD CAP: 2 web searches. Be decisive.

Return STRICT JSON in a \`\`\`json ... \`\`\` block:
\`\`\`json
{
  "is_public": bool,
  "ticker": str | null,
  "fiscal_year": int | null,
  "total_revenue_usd": <int USD> | null,
  "segments": [
    {"name": str, "revenue_usd": <int USD>, "contains_focal": bool}
  ],
  "source_url": str | null,
  "notes": str
}
\`\`\``;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function b64urlEncode(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function encodeShareable(payload) {
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json);
  if (typeof CompressionStream !== 'undefined') {
    const cs = new CompressionStream('gzip');
    const writer = cs.writable.getWriter();
    writer.write(bytes);
    writer.close();
    const compressed = new Uint8Array(await new Response(cs.readable).arrayBuffer());
    return 'g.' + b64urlEncode(compressed);
  }
  return 'r.' + b64urlEncode(bytes);
}

async function decodeShareable(token) {
  if (!token) return null;
  const [prefix, body] = token.split('.', 2);
  if (!body) return null;
  const bytes = b64urlDecode(body);
  let jsonBytes = bytes;
  if (prefix === 'g') {
    if (typeof DecompressionStream === 'undefined') return null;
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    writer.write(bytes);
    writer.close();
    jsonBytes = new Uint8Array(await new Response(ds.readable).arrayBuffer());
  } else if (prefix !== 'r') {
    return null;
  }
  return JSON.parse(new TextDecoder().decode(jsonBytes));
}

function safeExtractJSON(text) {
  if (!text) return null;
  const fence = text.match(/```json\s*([\s\S]+?)\s*```/);
  const candidate = fence ? fence[1] : text;
  const cleaned = candidate.replace(/```json|```/g, '').trim();
  const firstBrace = cleaned.indexOf('{');
  if (firstBrace === -1) return null;
  let attempt = cleaned.slice(firstBrace);
  try {
    return JSON.parse(attempt);
  } catch {
    for (let i = 0; i < 15; i++) {
      attempt += '}';
      try { return JSON.parse(attempt); } catch { /* keep trying */ }
    }
  }
  return null;
}

function formatUSD(n) {
  if (n == null || isNaN(n)) return '—';
  if (n === 0) return '$0';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n}`;
}

function confidenceColor(c) {
  if (c === 'high') return '#40BECC';
  if (c === 'medium') return '#c4a85a';
  return '#a07a7a';
}

function weightColor(w) {
  if (w === 'high') return '#40BECC';
  if (w === 'medium') return '#a8a59c';
  return '#5a5853';
}

// Call the existing Express proxy → Anthropic.
async function callAnthropic({ system, user, maxSearches = 4, maxTokens = 4096 }) {
  const res = await fetch('/api/anthropic', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxSearches }],
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`API ${res.status}: ${errText.slice(0, 240)}`);
  }
  const data = await res.json();
  return parseAnthropicResponse(data);
}

function parseAnthropicResponse(data) {
  const trace = [];
  let text = '';
  for (const block of data.content || []) {
    if (block.type === 'text') {
      if (block.text && block.text.trim()) {
        trace.push({ kind: 'thought', text: block.text.trim() });
        text += block.text + '\n';
      }
    } else if (block.type === 'server_tool_use' && block.name === 'web_search') {
      trace.push({ kind: 'search', query: (block.input && block.input.query) || '...' });
    } else if (block.type === 'web_search_tool_result') {
      const results = Array.isArray(block.content) ? block.content : [];
      const sources = results.slice(0, 4).map((r) => r.title || r.url || '').filter(Boolean);
      trace.push({ kind: 'results', count: results.length, sources });
    }
  }
  return { text, trace, raw: data };
}

// Collect entities to enrich with revenue. Caps depth/fan-out to keep cost bounded.
function collectEntities(ownership) {
  if (!ownership) return [];
  const out = [];
  const seen = new Set();
  const push = (entity, role) => {
    if (!entity || !entity.company) return;
    const key = entity.company.toLowerCase().trim();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ company: entity.company, domain: entity.domain || null, role, layer: entity.layer || null });
  };
  // focal first
  push(ownership, 'focal');
  // parent chain (max 2 levels up)
  let p = ownership.parent;
  let depth = 0;
  while (p && depth < 2) {
    push(p, depth === 0 ? 'parent' : 'grandparent');
    p = p.parent;
    depth++;
  }
  // siblings (cap 4)
  (ownership.siblings || []).slice(0, 4).forEach((s) => push(s, 'sibling'));
  // children (cap 3)
  (ownership.children || []).slice(0, 3).forEach((c) => push(c, 'child'));
  return out;
}

// Attach revenue estimates back onto the ownership tree by entity name match.
function attachRevenue(ownership, revenueByCompany) {
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
      if (rev.error) node.revenue_error = rev.error;
    }
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
      }
    });
    (node.children || []).forEach(visit);
  };
  visit(clone);
  return clone;
}

// Deterministic local synthesis. Chosen over a 3rd LLM call because (a) the
// positioning math is mechanical (ratios, ranking) and (b) it avoids token cost
// and JSON-parse risk of a synthesis call given two large prior outputs.
function synthesize(ownership, revenueByCompany, parentAnchor = null) {
  const tree = attachRevenue(ownership, revenueByCompany);
  const focalRev = tree.revenue_estimate?.central || 0;
  const parentRev = tree.parent?.revenue_estimate?.central || 0;
  if (parentAnchor) tree.parent_anchor = parentAnchor;

  let focal_vs_parent_ratio = 'N/A (standalone)';
  if (tree.parent && parentRev > 0) {
    const pct = ((focalRev / parentRev) * 100).toFixed(1);
    focal_vs_parent_ratio = `${pct}% of ${tree.parent.company} central revenue`;
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

  // Pull press / hiring / funding signals across the focal entity for growth narrative.
  const focalSignals = tree.signals_found || [];
  const growthHits = focalSignals
    .filter((s) => ['press', 'hiring', 'funding'].includes(s.type))
    .slice(0, 3)
    .map((s) => `${s.label} (${s.source})`);
  const growth_signals = growthHits.length > 0 ? growthHits.join('; ') : 'No explicit YoY growth signals captured.';

  const notes = [];
  if (tree.terminal_layer === 'private_equity') notes.push('Family is PE-owned — expect optimization for EBITDA and exit timing.');
  if ((tree.strategic_control || []).some((s) => s.relationship === 'investor' || s.relationship === 'pe_backer')) {
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
  // estimated central. Large gaps surface as an explicit warning.
  const sibCentrals = siblings.map((s) => s.revenue_estimate?.central || 0);
  const sumChildCentral = focalRev + sibCentrals.reduce((a, b) => a + b, 0);
  const knownSibCount = sibCentrals.filter((x) => x > 0).length + (focalRev > 0 ? 1 : 0);

  let reconciliation = null;
  if (tree.parent && knownSibCount >= 2) {
    const anchorTotal = parentAnchor && parentAnchor.is_public ? (parentAnchor.total_revenue_usd || 0) : 0;
    const focalSegmentRev = parentAnchor && Array.isArray(parentAnchor.segments)
      ? (parentAnchor.segments.find((s) => s.contains_focal)?.revenue_usd || 0)
      : 0;
    const benchmark = anchorTotal > 0 ? anchorTotal : parentRev;
    const benchmarkLabel = anchorTotal > 0
      ? `${tree.parent.company} ${parentAnchor.fiscal_year || 'latest'} 10-K reported revenue`
      : `${tree.parent.company} estimated central revenue`;

    if (benchmark > 0) {
      const ratio = sumChildCentral / benchmark;
      const pctDelta = Math.round((ratio - 1) * 100);
      reconciliation = {
        sum_children_central: sumChildCentral,
        parent_benchmark: benchmark,
        parent_benchmark_source: anchorTotal > 0 ? '10-K' : 'estimated',
        ratio: Number(ratio.toFixed(3)),
        pct_delta: pctDelta,
        focal_segment_revenue: focalSegmentRev || null,
        children_counted: knownSibCount,
      };
      const sumStr = formatUSD(sumChildCentral);
      const benchStr = formatUSD(benchmark);
      if (ratio > 1.5) {
        notes.push(`⚠ Reconciliation: sum of focal + ${siblings.length} sibling estimates (${sumStr}) is ${pctDelta > 0 ? '+' : ''}${pctDelta}% vs ${benchmarkLabel} (${benchStr}) — sibling estimates likely overstated or sibling set is over-broad.`);
      } else if (ratio < 0.5) {
        notes.push(`⚠ Reconciliation: sum of focal + ${siblings.length} sibling estimates (${sumStr}) covers only ${Math.round(ratio * 100)}% of ${benchmarkLabel} (${benchStr}) — likely missing siblings or underestimated revenues.`);
      } else if (anchorTotal > 0) {
        notes.push(`Reconciliation: focal + siblings (${sumStr}) reconciles within ${Math.abs(pctDelta)}% of ${benchmarkLabel} (${benchStr}).`);
      }
      if (focalSegmentRev > 0 && focalRev > 0) {
        const segRatio = focalRev / focalSegmentRev;
        if (segRatio > 1.3 || segRatio < 0.7) {
          notes.push(`⚠ Focal estimate (${formatUSD(focalRev)}) diverges from its parent 10-K segment revenue (${formatUSD(focalSegmentRev)}, ${Math.round(segRatio * 100)}%).`);
        }
      }
    }
  }
  if (parentAnchor && parentAnchor.is_public === false) {
    notes.push(`${tree.parent?.company || 'Parent'} is not publicly traded — no 10-K anchor available; reconciliation uses estimates only.`);
  }

  const strategic_notes = notes.length > 0 ? notes.join(' ') : 'No distinctive structural signals captured.';

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

// ─── App ─────────────────────────────────────────────────────────────────────

export default function App() {
  const [brand, setBrand] = useState('');
  const [hint, setHint] = useState('');
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState(null);
  const [trace, setTrace] = useState([]);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [showRaw, setShowRaw] = useState(false);
  const [sharedView, setSharedView] = useState(false);

  useEffect(() => {
    const link = document.createElement('link');
    link.href = 'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,400;1,500&family=JetBrains+Mono:wght@400;500&family=Inter:wght@300;400;500;600&display=swap';
    link.rel = 'stylesheet';
    document.head.appendChild(link);

    const style = document.createElement('style');
    style.textContent = `
      @media print {
        body { background: #fff !important; }
        .no-print { display: none !important; }
        .print-root {
          background: #fff !important;
          background-image: none !important;
          color: #111 !important;
          padding: 0 !important;
        }
        .print-root * {
          color: #111 !important;
          background: transparent !important;
          border-color: #ccc !important;
        }
        .print-root a { color: #1a5f8a !important; text-decoration: underline; }
        .print-root section, .print-root div { page-break-inside: avoid; }
      }
    `;
    document.head.appendChild(style);
  }, []);

  useEffect(() => {
    const hash = window.location.hash;
    const match = hash.match(/^#share=(.+)$/);
    if (!match) return;
    (async () => {
      try {
        const payload = await decodeShareable(decodeURIComponent(match[1]));
        if (payload && payload.ownership_tree) {
          setResult(payload);
          setBrand(payload.focal_company || payload.ownership_tree.company || '');
          setSharedView(true);
        }
      } catch (e) {
        setError('Could not decode shared report: ' + e.message);
      }
    })();
  }, []);

  function appendTrace(items) {
    setTrace((prev) => [...prev, ...items]);
  }

  async function investigate() {
    if (!brand.trim()) return;
    setLoading(true);
    setTrace([]);
    setResult(null);
    setError(null);
    setPhase('ownership');

    try {
      // Phase 1 — ownership
      appendTrace([{ kind: 'phase', phase: 'ownership', label: `resolving ownership of ${brand.trim()}` }]);
      const ownershipUser = `Resolve the corporate ownership of: "${brand.trim()}"${hint.trim() ? `\n\nContext: ${hint.trim()}` : ''}`;
      const ownershipResp = await callAnthropic({
        system: OWNERSHIP_PROMPT,
        user: ownershipUser,
        maxSearches: 8,
        maxTokens: 4096,
      });
      appendTrace(ownershipResp.trace.map((t) => ({ ...t, tag: 'ownership' })));
      const ownership = safeExtractJSON(ownershipResp.text);
      if (!ownership) {
        throw new Error('Ownership phase did not return parseable JSON.');
      }
      if (ownership.disambiguation_required) {
        setResult({ disambiguation: ownership, raw: ownershipResp.text });
        setError('Disambiguation required — please re-run with a more specific context hint.');
        setLoading(false);
        setPhase(null);
        return;
      }

      // Phase 2 — revenue (parallel) + optional parent 10-K anchor (parallel)
      setPhase('revenue');
      const entities = collectEntities(ownership);
      appendTrace([{ kind: 'phase', phase: 'revenue', label: `estimating revenue for ${entities.length} entit${entities.length === 1 ? 'y' : 'ies'}` }]);

      // Fire the parent anchor lookup in parallel with the revenue calls when a
      // parent exists. The agent itself decides if the parent is public; if not,
      // it returns is_public:false and we just skip the anchor.
      const parentAnchorPromise = (async () => {
        if (!ownership.parent || !ownership.parent.company) return null;
        const parentName = ownership.parent.company;
        const tag = `anchor:${parentName}`;
        appendTrace([{ kind: 'phase', phase: tag, label: `→ ${parentName} 10-K segment revenue (if public)` }]);
        try {
          const resp = await callAnthropic({
            system: PARENT_ANCHOR_PROMPT,
            user: `PARENT: "${parentName}"\nFOCAL subsidiary: "${ownership.company}"\n\nDetermine if PARENT is public and, if so, extract the latest annual-report segment revenue.`,
            maxSearches: 2,
            maxTokens: 1536,
          });
          appendTrace(resp.trace.map((t) => ({ ...t, tag })));
          const parsed = safeExtractJSON(resp.text);
          if (!parsed) return null;
          return parsed;
        } catch (e) {
          appendTrace([{ kind: 'error', tag, message: e.message }]);
          return null;
        }
      })();

      const revenueResults = await Promise.all(
        entities.map(async (ent) => {
          const tag = `revenue:${ent.company}`;
          appendTrace([{ kind: 'phase', phase: tag, label: `→ ${ent.company} (${ent.role})` }]);
          try {
            const user = `Investigate the annual revenue of: "${ent.company}"${ent.domain ? ` (domain: ${ent.domain})` : ''}. Role in corporate family: ${ent.role}.`;
            const resp = await callAnthropic({
              system: REVENUE_PROMPT,
              user,
              maxSearches: 4,
              maxTokens: 3072,
            });
            appendTrace(resp.trace.map((t) => ({ ...t, tag })));
            const parsed = safeExtractJSON(resp.text);
            if (!parsed) {
              return { company: ent.company, role: ent.role, error: 'parse_failed', confidence: 'low' };
            }
            return { company: ent.company, role: ent.role, ...parsed };
          } catch (e) {
            appendTrace([{ kind: 'error', tag, message: e.message }]);
            return { company: ent.company, role: ent.role, error: e.message, confidence: 'low' };
          }
        })
      );

      const parentAnchor = await parentAnchorPromise;

      // Phase 3 — synthesis (local merge)
      setPhase('synthesis');
      appendTrace([{ kind: 'phase', phase: 'synthesis', label: 'merging ownership + revenue → positioning' }]);
      const byCompany = {};
      revenueResults.forEach((r) => { byCompany[r.company.toLowerCase().trim()] = r; });
      const synthesized = synthesize(ownership, byCompany, parentAnchor);
      setResult({ ...synthesized, _entities: entities, _revenueResults: revenueResults, _parentAnchor: parentAnchor });
      appendTrace([{ kind: 'phase', phase: 'done', label: 'investigation complete' }]);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
      setPhase(null);
    }
  }

  const inputStyle = {
    width: '100%',
    background: 'transparent',
    border: 'none',
    borderBottom: '1px solid #2a2a2e',
    color: '#f4f2eb',
    padding: '12px 0',
    fontSize: '15px',
    fontFamily: '"Inter", -apple-system, sans-serif',
    outline: 'none',
    boxSizing: 'border-box',
  };

  return (
    <div
      className="print-root"
      style={{
        minHeight: '100vh',
        background: '#0a0a0c',
        backgroundImage: 'radial-gradient(ellipse 60% 40% at top, #14141822 0%, transparent 60%)',
        color: '#e8e6df',
        fontFamily: '"Inter", -apple-system, sans-serif',
        padding: '56px 24px 96px',
        fontSize: '14px',
        lineHeight: 1.6,
      }}
    >
      <div style={{ maxWidth: '820px', margin: '0 auto' }}>
        {sharedView && (
          <div
            className="no-print"
            style={{
              background: '#0e1a1c',
              border: '1px solid #1f3a3f',
              padding: '14px 20px',
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: '11px',
              letterSpacing: '0.08em',
              color: '#40BECC',
              marginBottom: '32px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '16px',
              flexWrap: 'wrap',
            }}
          >
            <span>★ shared report · read-only view</span>
            <a
              href={window.location.pathname}
              style={{ color: '#a8a59c', textDecoration: 'underline', fontSize: '10px', letterSpacing: '0.15em', textTransform: 'uppercase' }}
            >
              ↳ run new investigation
            </a>
          </div>
        )}
        {/* HEADER */}
        <header style={{ marginBottom: '56px', borderBottom: '1px solid #1c1c20', paddingBottom: '36px' }}>
          <div
            style={{
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: '10px',
              letterSpacing: '0.25em',
              color: '#40BECC',
              marginBottom: '14px',
              textTransform: 'uppercase',
            }}
          >
            module · signal.ownership_revenue · v0
          </div>
          <h1
            style={{
              fontFamily: '"Cormorant Garamond", serif',
              fontSize: '48px',
              fontWeight: 500,
              margin: 0,
              letterSpacing: '-0.02em',
              color: '#f4f2eb',
              lineHeight: 1.05,
            }}
          >
            Ownership &amp; Revenue Agent
          </h1>
          <p
            style={{
              fontFamily: '"Cormorant Garamond", serif',
              fontStyle: 'italic',
              fontSize: '19px',
              color: '#8a8780',
              margin: '12px 0 0',
              fontWeight: 400,
            }}
          >
            From brand to full corporate family — with a revenue estimate on every node and a positioning read on the focal entity.
          </p>
        </header>

        {/* INPUT */}
        {!sharedView && (
        <section className="no-print" style={{ marginBottom: '56px' }}>
          <Label>Target brand</Label>
          <input
            type="text"
            value={brand}
            onChange={(e) => setBrand(e.target.value)}
            placeholder="e.g. Mercury, MUD\WTR, Whole Foods"
            disabled={loading}
            onKeyDown={(e) => { if (e.key === 'Enter' && !loading) investigate(); }}
            style={inputStyle}
          />
          <div style={{ marginTop: '28px' }}>
            <Label>Context (optional)</Label>
            <input
              type="text"
              value={hint}
              onChange={(e) => setHint(e.target.value)}
              placeholder="domain, industry, geography, founding year…"
              disabled={loading}
              onKeyDown={(e) => { if (e.key === 'Enter' && !loading) investigate(); }}
              style={inputStyle}
            />
          </div>
          <button
            onClick={investigate}
            disabled={loading || !brand.trim()}
            style={{
              marginTop: '32px',
              background: loading || !brand.trim() ? 'transparent' : '#40BECC',
              color: loading || !brand.trim() ? '#5a5853' : '#0a0a0c',
              border: loading || !brand.trim() ? '1px solid #2a2a2e' : '1px solid #40BECC',
              padding: '14px 36px',
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: '11px',
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              fontWeight: 500,
              cursor: loading || !brand.trim() ? 'not-allowed' : 'pointer',
              transition: 'all 0.15s ease',
            }}
          >
            {loading ? `· · · ${phase || 'working'}` : '→ investigate'}
          </button>
        </section>
        )}

        {/* TRACE */}
        {!sharedView && (loading || trace.length > 0) && (
          <section className="no-print" style={{ marginBottom: '56px' }}>
            <SectionHead>Investigation log</SectionHead>
            <div style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: '12px', color: '#a8a59c' }}>
              {trace.map((item, i) => (
                <TraceItem key={i} index={i + 1} item={item} />
              ))}
              {loading && (
                <div style={{ color: '#40BECC', padding: '14px 0', fontStyle: 'italic', fontSize: '12px', letterSpacing: '0.05em' }}>
                  · · · agent working — phase: {phase}
                </div>
              )}
            </div>
          </section>
        )}

        {/* ERROR */}
        {error && (
          <div
            style={{
              background: '#1a1212',
              border: '1px solid #3a2222',
              padding: '16px 20px',
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: '12px',
              color: '#d4a8a8',
              marginBottom: '36px',
            }}
          >
            ⚠ {error}
          </div>
        )}

        {/* DISAMBIGUATION */}
        {result?.disambiguation && (
          <section>
            <SectionHead>Disambiguation candidates</SectionHead>
            {(result.disambiguation.disambiguation_candidates || []).map((c, i) => (
              <div key={i} style={{ padding: '12px 0', borderBottom: '1px solid #18181c' }}>
                <div style={{ color: '#f4f2eb', fontWeight: 500 }}>{c.company}</div>
                <div style={{ color: '#8a8780', fontSize: '12px', marginTop: 4 }}>
                  {c.sector} · {c.country}
                </div>
              </div>
            ))}
          </section>
        )}

        {/* RESULT */}
        {result?.ownership_tree && (
          <ResultView result={result} showRaw={showRaw} setShowRaw={setShowRaw} />
        )}
      </div>
    </div>
  );
}

// ─── Result view ─────────────────────────────────────────────────────────────

function ResultView({ result, showRaw, setShowRaw }) {
  const tree = result.ownership_tree;
  const positioning = result.positioning_analysis || {};
  const rev = tree.revenue_estimate || {};
  const [shareState, setShareState] = useState('idle');

  async function handleShare() {
    try {
      setShareState('working');
      const payload = {
        focal_company: result.focal_company,
        ownership_tree: result.ownership_tree,
        positioning_analysis: result.positioning_analysis,
        _revenueResults: result._revenueResults,
        _entities: result._entities,
      };
      const token = await encodeShareable(payload);
      const url = `${window.location.origin}${window.location.pathname}#share=${encodeURIComponent(token)}`;
      await navigator.clipboard.writeText(url);
      setShareState('copied');
      setTimeout(() => setShareState('idle'), 2200);
    } catch (e) {
      console.error(e);
      setShareState('error');
      setTimeout(() => setShareState('idle'), 2200);
    }
  }

  const btn = {
    background: 'transparent',
    border: '1px solid #2a2a2e',
    color: '#e8e6df',
    padding: '10px 18px',
    fontFamily: '"JetBrains Mono", monospace',
    fontSize: '10px',
    letterSpacing: '0.2em',
    textTransform: 'uppercase',
    cursor: 'pointer',
    transition: 'all 0.15s ease',
  };

  return (
    <section>
      <div
        className="no-print"
        style={{
          display: 'flex',
          gap: '12px',
          justifyContent: 'flex-end',
          marginBottom: '20px',
          flexWrap: 'wrap',
        }}
      >
        <button onClick={() => window.print()} style={btn}>↓ download PDF</button>
        <button
          onClick={handleShare}
          style={{
            ...btn,
            borderColor: shareState === 'copied' ? '#40BECC' : '#2a2a2e',
            color: shareState === 'copied' ? '#40BECC' : '#e8e6df',
          }}
        >
          {shareState === 'copied' ? '✓ link copied' : shareState === 'working' ? '· · · encoding' : shareState === 'error' ? '✕ failed' : '⎘ copy share link'}
        </button>
      </div>
      <SectionHead>Estimate · {tree.company}</SectionHead>
      <div
        style={{
          border: '1px solid #2a2a2e',
          padding: '36px',
          marginBottom: '40px',
          background: 'linear-gradient(180deg, #0e0e12 0%, #0a0a0c 100%)',
        }}
      >
        <div
          style={{
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: '10px',
            color: '#7a7770',
            letterSpacing: '0.22em',
            textTransform: 'uppercase',
            marginBottom: '16px',
          }}
        >
          annual revenue range · focal entity
        </div>
        <div
          style={{
            fontFamily: '"Cormorant Garamond", serif',
            fontSize: '46px',
            color: '#f4f2eb',
            fontWeight: 500,
            letterSpacing: '-0.02em',
            lineHeight: 1.1,
          }}
        >
          {formatUSD(rev.low)}
          <span style={{ color: '#40BECC', margin: '0 18px', fontSize: '32px', verticalAlign: 'middle' }}>—</span>
          {formatUSD(rev.high)}
        </div>
        <div
          style={{
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: '12px',
            color: '#a8a59c',
            marginTop: '20px',
            display: 'flex',
            gap: '32px',
            flexWrap: 'wrap',
          }}
        >
          <span>central · <span style={{ color: '#f4f2eb' }}>{formatUSD(rev.central)}</span></span>
          <span>confidence · <span style={{ color: confidenceColor(rev.confidence) }}>{rev.confidence || 'unknown'}</span></span>
          <span>layer · <span style={{ color: '#f4f2eb' }}>{tree.layer || '—'}</span></span>
          {tree.standalone && <span style={{ color: '#40BECC' }}>standalone</span>}
        </div>
      </div>

      <SectionHead>Ownership tree</SectionHead>
      <div style={{ marginBottom: '40px' }}>
        <OwnershipTree tree={tree} />
      </div>

      {(tree.strategic_control || []).length > 0 && (
        <>
          <SectionHead>Strategic control</SectionHead>
          <div style={{ marginBottom: '40px' }}>
            {tree.strategic_control.map((s, i) => (
              <div
                key={i}
                style={{
                  padding: '14px 0',
                  borderBottom: '1px solid #18181c',
                  fontFamily: '"JetBrains Mono", monospace',
                  fontSize: '12px',
                }}
              >
                <div style={{ display: 'flex', gap: '14px', alignItems: 'baseline' }}>
                  <span style={{ color: '#40BECC', width: 130, flexShrink: 0 }}>{s.relationship}</span>
                  <span style={{ color: '#f4f2eb', fontWeight: 500 }}>{s.entity}</span>
                </div>
                {s.details && (
                  <div style={{ color: '#a8a59c', marginTop: 6, paddingLeft: 144, fontSize: '11px' }}>{s.details}</div>
                )}
                {s.source_url && (
                  <div style={{ paddingLeft: 144, marginTop: 4 }}>
                    <a href={s.source_url} target="_blank" rel="noopener noreferrer" style={{ color: '#5a5853', fontSize: '10px', fontStyle: 'italic' }}>
                      {s.source_url}
                    </a>
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      <SectionHead>Positioning analysis</SectionHead>
      <div style={{ marginBottom: '40px' }}>
        <PositioningRow label="Focal vs parent" body={positioning.focal_vs_parent_ratio} />
        <PositioningRow label="Focal vs siblings" body={positioning.focal_vs_siblings} />
        <PositioningRow label="Growth signals" body={positioning.growth_signals} />
        <PositioningRow label="Strategic notes" body={positioning.strategic_notes} italic />
      </div>

      <SectionHead>Signals captured</SectionHead>
      <div style={{ marginBottom: '40px' }}>
        {(result._revenueResults || []).map((r, i) => (
          <EntitySignals key={i} entry={r} />
        ))}
      </div>

      <section className="no-print" style={{ marginTop: '24px', borderTop: '1px solid #1c1c20', paddingTop: '24px' }}>
        <button
          onClick={() => setShowRaw(!showRaw)}
          style={{
            background: 'transparent',
            border: 'none',
            color: '#5a5853',
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: '10px',
            letterSpacing: '0.2em',
            textTransform: 'uppercase',
            cursor: 'pointer',
            padding: 0,
          }}
        >
          {showRaw ? '▾ hide raw JSON' : '▸ show raw JSON'}
        </button>
        {showRaw && (
          <pre
            style={{
              marginTop: '16px',
              padding: '16px',
              background: '#0e0e12',
              border: '1px solid #1c1c20',
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: '11px',
              color: '#8a8780',
              whiteSpace: 'pre-wrap',
              lineHeight: 1.5,
              maxHeight: '480px',
              overflowY: 'auto',
            }}
          >
            {JSON.stringify({ focal_company: result.focal_company, ownership_tree: result.ownership_tree, positioning_analysis: result.positioning_analysis }, null, 2)}
          </pre>
        )}
      </section>
    </section>
  );
}

function PositioningRow({ label, body, italic }) {
  return (
    <div style={{ padding: '16px 0', borderBottom: '1px solid #18181c' }}>
      <div
        style={{
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: '10px',
          color: '#7a7770',
          letterSpacing: '0.2em',
          textTransform: 'uppercase',
          marginBottom: 8,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: italic ? '"Cormorant Garamond", serif' : '"Inter", -apple-system, sans-serif',
          fontStyle: italic ? 'italic' : 'normal',
          fontSize: italic ? '18px' : '14px',
          color: '#e8e6df',
          lineHeight: 1.55,
        }}
      >
        {body || '—'}
      </div>
    </div>
  );
}

// Ownership tree — nested cards (parent chain rendered above focal, siblings + children below).
function OwnershipTree({ tree }) {
  // Build parent chain top-down.
  const parents = [];
  let p = tree.parent;
  while (p) {
    parents.unshift(p);
    p = p.parent;
  }
  return (
    <div>
      {parents.map((node, i) => (
        <div key={`p${i}`} style={{ marginBottom: 8 }}>
          <EntityCard node={node} role={i === 0 && parents.length > 1 ? 'root' : 'parent'} />
          <Connector />
        </div>
      ))}
      <EntityCard node={tree} role="focal" />
      {(tree.siblings || []).length > 0 && (
        <div style={{ marginTop: 16 }}>
          <SubLabel>Siblings</SubLabel>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 8 }}>
            {tree.siblings.map((s, i) => <EntityCard key={i} node={s} role="sibling" compact />)}
          </div>
        </div>
      )}
      {(tree.children || []).length > 0 && (
        <div style={{ marginTop: 16 }}>
          <SubLabel>Children</SubLabel>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 8 }}>
            {tree.children.map((c, i) => <EntityCard key={i} node={c} role="child" compact />)}
          </div>
        </div>
      )}
    </div>
  );
}

function SubLabel({ children }) {
  return (
    <div
      style={{
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: '10px',
        letterSpacing: '0.2em',
        color: '#7a7770',
        textTransform: 'uppercase',
        marginBottom: 10,
      }}
    >
      {children}
    </div>
  );
}

function Connector() {
  return <div style={{ width: 1, height: 18, background: '#2a2a2e', marginLeft: 24 }} />;
}

function EntityCard({ node, role, compact }) {
  if (!node) return null;
  const rev = node.revenue_estimate;
  const isFocal = role === 'focal';
  return (
    <div
      style={{
        border: `1px solid ${isFocal ? '#40BECC' : '#2a2a2e'}`,
        background: isFocal ? 'linear-gradient(180deg, #0e1518 0%, #0a0a0c 100%)' : '#0e0e12',
        padding: compact ? '14px 16px' : '18px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div
            style={{
              fontFamily: '"Cormorant Garamond", serif',
              fontSize: compact ? '20px' : '24px',
              color: '#f4f2eb',
              fontWeight: 500,
              letterSpacing: '-0.01em',
              lineHeight: 1.1,
            }}
          >
            {node.company}
          </div>
          {node.domain && (
            <div style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: '11px', color: '#7a7770', marginTop: 4 }}>
              {node.domain}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <Chip color="#40BECC">{role}</Chip>
          {node.layer && <Chip>{node.layer}</Chip>}
          {node.terminal_layer === 'private_equity' && <Chip color="#c4a85a">PE</Chip>}
          {node.status && node.status !== 'active' && <Chip color="#a07a7a">{node.status}</Chip>}
        </div>
      </div>
      <div
        style={{
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: '12px',
          color: '#a8a59c',
          display: 'flex',
          gap: 18,
          flexWrap: 'wrap',
          marginTop: 6,
        }}
      >
        {rev ? (
          <>
            <span>
              revenue · <span style={{ color: '#f4f2eb' }}>{formatUSD(rev.low)} — {formatUSD(rev.high)}</span>
            </span>
            <span>
              central · <span style={{ color: '#f4f2eb' }}>{formatUSD(rev.central)}</span>
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: confidenceColor(rev.confidence) }} />
              <span>{rev.confidence}</span>
            </span>
          </>
        ) : (
          <span style={{ color: '#5a5853', fontStyle: 'italic' }}>revenue not estimated</span>
        )}
        {node.revenue_error && <span style={{ color: '#a07a7a' }}>err · {node.revenue_error}</span>}
      </div>
      {node.acquisition?.acquired_by && (
        <div style={{ fontFamily: '"Cormorant Garamond", serif', fontStyle: 'italic', fontSize: 14, color: '#8a8780', marginTop: 4 }}>
          Acquired by {node.acquisition.acquired_by}{node.acquisition.year ? ` · ${node.acquisition.year}` : ''}
        </div>
      )}
    </div>
  );
}

function Chip({ children, color }) {
  const c = color || '#7a7770';
  return (
    <span
      style={{
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: '9px',
        color: c,
        letterSpacing: '0.18em',
        textTransform: 'uppercase',
        padding: '3px 8px',
        border: `1px solid ${c}44`,
      }}
    >
      {children}
    </span>
  );
}

function EntitySignals({ entry }) {
  const [open, setOpen] = useState(false);
  const signals = entry.signals_found || [];
  const hasContent = signals.length > 0 || entry.reasoning_summary || entry.error;
  return (
    <div style={{ borderBottom: '1px solid #18181c', padding: '12px 0' }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          background: 'transparent',
          border: 'none',
          color: '#e8e6df',
          padding: 0,
          cursor: hasContent ? 'pointer' : 'default',
          width: '100%',
          textAlign: 'left',
          display: 'flex',
          alignItems: 'baseline',
          gap: 12,
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: '12px',
        }}
      >
        <span style={{ color: '#5a5853' }}>{open ? '▾' : '▸'}</span>
        <span style={{ color: '#f4f2eb', flex: 1 }}>{entry.company}</span>
        <span style={{ color: '#7a7770' }}>{entry.role}</span>
        {entry.revenue_estimate?.central != null && (
          <span style={{ color: '#a8a59c' }}>{formatUSD(entry.revenue_estimate.central)}</span>
        )}
        <span style={{ color: confidenceColor(entry.confidence) }}>{entry.confidence || '—'}</span>
      </button>
      {open && (
        <div style={{ marginTop: 12, paddingLeft: 24 }}>
          {entry.error && (
            <div style={{ color: '#d4a8a8', fontFamily: '"JetBrains Mono", monospace', fontSize: '11px', marginBottom: 10 }}>
              error · {entry.error}
            </div>
          )}
          {signals.map((s, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                padding: '10px 0',
                borderBottom: '1px solid #14141a',
                alignItems: 'flex-start',
                gap: 14,
                fontFamily: '"JetBrains Mono", monospace',
                fontSize: '11px',
              }}
            >
              <div style={{ width: 90, flexShrink: 0, color: '#7a7770' }}>{s.type}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: '#f4f2eb', fontWeight: 500 }}>{s.label}</div>
                <div style={{ color: '#a8a59c', marginTop: 3, wordBreak: 'break-word' }}>{s.value}</div>
                {s.source && (
                  <div style={{ color: '#5a5853', marginTop: 3, fontSize: '10px', fontStyle: 'italic' }}>via {s.source}</div>
                )}
              </div>
              <div
                style={{
                  flexShrink: 0,
                  color: weightColor(s.weight),
                  fontSize: '9px',
                  letterSpacing: '0.15em',
                  textTransform: 'uppercase',
                  padding: '2px 7px',
                  border: `1px solid ${weightColor(s.weight)}44`,
                }}
              >
                {s.weight}
              </div>
            </div>
          ))}
          {entry.reasoning_summary && (
            <div
              style={{
                marginTop: 14,
                fontFamily: '"Cormorant Garamond", serif',
                fontStyle: 'italic',
                fontSize: 16,
                color: '#c8c5bc',
                lineHeight: 1.55,
              }}
            >
              "{entry.reasoning_summary}"
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Shared small components ─────────────────────────────────────────────────

function Label({ children }) {
  return (
    <div
      style={{
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: '10px',
        letterSpacing: '0.2em',
        color: '#7a7770',
        textTransform: 'uppercase',
        marginBottom: '6px',
      }}
    >
      {children}
    </div>
  );
}

function SectionHead({ children }) {
  return (
    <div
      style={{
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: '10px',
        letterSpacing: '0.25em',
        color: '#40BECC',
        textTransform: 'uppercase',
        marginBottom: '20px',
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
      }}
    >
      <span>{children}</span>
      <span style={{ flex: 1, height: '1px', background: '#1c1c20' }}></span>
    </div>
  );
}

function TraceItem({ index, item }) {
  const indexStyle = { color: '#5a5853', width: 40, flexShrink: 0, fontSize: 11 };
  const rowStyle = { display: 'flex', padding: '6px 0', gap: 4, alignItems: 'baseline' };
  const tag = item.tag ? <span style={{ color: '#5a5853', marginRight: 8 }}>[{item.tag}]</span> : null;

  if (item.kind === 'phase') {
    return (
      <div style={{ ...rowStyle, padding: '14px 0 6px', borderTop: '1px solid #14141a', marginTop: 6 }}>
        <span style={indexStyle}>[{String(index).padStart(2, '0')}]</span>
        <span style={{ color: '#40BECC', letterSpacing: '0.15em', textTransform: 'uppercase', fontSize: 10 }}>
          phase · {item.phase}
        </span>
        <span style={{ color: '#5a5853', margin: '0 6px' }}>›</span>
        <span style={{ color: '#e8e6df' }}>{item.label}</span>
      </div>
    );
  }
  if (item.kind === 'search') {
    return (
      <div style={rowStyle}>
        <span style={indexStyle}>[{String(index).padStart(2, '0')}]</span>
        {tag}
        <span style={{ color: '#40BECC' }}>search</span>
        <span style={{ color: '#5a5853', margin: '0 6px' }}>›</span>
        <span style={{ color: '#e8e6df' }}>"{item.query}"</span>
      </div>
    );
  }
  if (item.kind === 'results') {
    return (
      <div style={rowStyle}>
        <span style={indexStyle}>[{String(index).padStart(2, '0')}]</span>
        {tag}
        <span style={{ color: '#8a8780' }}>fetched</span>
        <span style={{ color: '#5a5853', margin: '0 6px' }}>›</span>
        <span style={{ color: '#a8a59c' }}>
          {item.count} result{item.count === 1 ? '' : 's'}
          {item.sources && item.sources.length > 0 && (
            <span style={{ color: '#5a5853', marginLeft: 8, fontStyle: 'italic' }}>
              ({item.sources.slice(0, 2).join(' · ').slice(0, 90)})
            </span>
          )}
        </span>
      </div>
    );
  }
  if (item.kind === 'error') {
    return (
      <div style={rowStyle}>
        <span style={indexStyle}>[{String(index).padStart(2, '0')}]</span>
        {tag}
        <span style={{ color: '#d4a8a8' }}>error › {item.message}</span>
      </div>
    );
  }
  // thought
  const text = item.text && item.text.length > 320 ? item.text.slice(0, 320) + '…' : item.text;
  return (
    <div style={{ ...rowStyle, padding: '12px 0' }}>
      <span style={indexStyle}>[{String(index).padStart(2, '0')}]</span>
      {tag}
      <span
        style={{
          color: '#c8c5bc',
          fontFamily: '"Inter", -apple-system, sans-serif',
          fontSize: 13,
          fontStyle: 'italic',
          lineHeight: 1.6,
        }}
      >
        {text}
      </span>
    </div>
  );
}
