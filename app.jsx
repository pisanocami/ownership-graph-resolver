import React, { useState, useEffect, useMemo } from 'react';
import ReactFlow, { Background, Controls, MiniMap, Handle, Position } from 'reactflow';
import 'reactflow/dist/style.css';

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

function keyOf(node) {
  return (node?.company || '').toLowerCase().trim();
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
  push(ownership, 'focal');
  let p = ownership.parent;
  let depth = 0;
  while (p && depth < 2) {
    push(p, depth === 0 ? 'parent' : 'grandparent');
    p = p.parent;
    depth++;
  }
  (ownership.siblings || []).slice(0, 4).forEach((s) => push(s, 'sibling'));
  (ownership.children || []).slice(0, 3).forEach((c) => push(c, 'child'));
  return out;
}

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

// Rescale focal + sibling central estimates so they sum to the parent's
// reported 10-K total. Each adjustment is clamped to the entity's own
// [low, high] band, the raw estimate is preserved on `revenue_estimate_raw`,
// and `anchor_adjusted: true` is flagged so the UI and reconciliation can
// distinguish corrected values from raw model output.
function applyAnchorAdjustment(tree, parentAnchor) {
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

// Deterministic local synthesis. Chosen over a 3rd LLM call because (a) the
// positioning math is mechanical (ratios, ranking) and (b) it avoids token cost
// and JSON-parse risk of a synthesis call given two large prior outputs.
function synthesize(ownership, revenueByCompany, parentAnchor = null) {
  const tree = attachRevenue(ownership, revenueByCompany);
  const anchorAdjustment = applyAnchorAdjustment(tree, parentAnchor);
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
  // estimated central. Large gaps surface as an explicit warning. When an
  // anchor adjustment was applied, diagnose against the raw (pre-adjustment)
  // values so the warning reflects the original model gap, not the corrected one.
  const rawFocalRev = tree.revenue_estimate_raw?.central ?? focalRev;
  const sibCentrals = siblings.map((s) => s.revenue_estimate_raw?.central ?? s.revenue_estimate?.central ?? 0);
  const sumChildCentral = rawFocalRev + sibCentrals.reduce((a, b) => a + b, 0);
  const knownSibCount = sibCentrals.filter((x) => x > 0).length + (rawFocalRev > 0 ? 1 : 0);

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
        anchor_adjustment: anchorAdjustment,
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

// ─── App ─────────────────────────────────────────────────────────────────────

const STEPS = [
  { id: 'ownership', label: 'Ownership' },
  { id: 'revenue', label: 'Revenue' },
  { id: 'anchor', label: 'Anchor' },
  { id: 'synthesis', label: 'Synthesis' },
];

function stepState(stepId, phase, loading, result) {
  if (!loading && result) return 'done';
  if (!loading) return 'pending';
  if (phase === 'ownership') return stepId === 'ownership' ? 'active' : 'pending';
  if (phase === 'revenue') {
    if (stepId === 'ownership') return 'done';
    if (stepId === 'revenue' || stepId === 'anchor') return 'active';
    return 'pending';
  }
  if (phase === 'synthesis') {
    if (stepId === 'synthesis') return 'active';
    return 'done';
  }
  return 'pending';
}

export default function App() {
  const [theme, setTheme] = useState(() => {
    if (typeof window === 'undefined') return 'light';
    return window.localStorage.getItem('orva.theme') || 'light';
  });
  const [brand, setBrand] = useState('');
  const [hint, setHint] = useState('');
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState(null);
  const [trace, setTrace] = useState([]);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [showRaw, setShowRaw] = useState(false);
  const [sharedView, setSharedView] = useState(false);
  const [selectedKey, setSelectedKey] = useState(null);
  const [viewMode, setViewMode] = useState(() => {
    if (typeof window === 'undefined') return 'tree';
    const v = window.localStorage.getItem('orva.view');
    return v === 'graph' || v === 'tree' ? v : 'tree';
  });
  const [logsOpen, setLogsOpen] = useState(false);

  // Apply theme + persist
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { window.localStorage.setItem('orva.theme', theme); } catch {}
  }, [theme]);

  // Persist view mode
  useEffect(() => {
    try { window.localStorage.setItem('orva.view', viewMode); } catch {}
  }, [viewMode]);

  // Load fonts
  useEffect(() => {
    if (document.getElementById('orva-fonts')) return;
    const link = document.createElement('link');
    link.id = 'orva-fonts';
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap';
    document.head.appendChild(link);
  }, []);

  // Decode shared view from URL hash
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
          setSelectedKey(keyOf(payload.ownership_tree));
        }
      } catch (e) {
        setError('Could not decode shared report: ' + e.message);
      }
    })();
  }, []);

  // When a fresh result lands, default-select the focal entity.
  useEffect(() => {
    if (result?.ownership_tree && !selectedKey) {
      setSelectedKey(keyOf(result.ownership_tree));
    }
  }, [result, selectedKey]);

  function appendTrace(items) {
    setTrace((prev) => [...prev, ...items]);
  }

  async function investigate() {
    if (!brand.trim()) return;
    setLoading(true);
    setTrace([]);
    setResult(null);
    setError(null);
    setSelectedKey(null);
    setLogsOpen(false);
    setPhase('ownership');

    try {
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
      if (!ownership) throw new Error('Ownership phase did not return parseable JSON.');
      if (ownership.disambiguation_required) {
        setResult({ disambiguation: ownership, raw: ownershipResp.text });
        setError('Disambiguation required — please re-run with a more specific context hint.');
        setLoading(false);
        setPhase(null);
        return;
      }

      setPhase('revenue');
      const entities = collectEntities(ownership);
      appendTrace([{ kind: 'phase', phase: 'revenue', label: `estimating revenue for ${entities.length} entit${entities.length === 1 ? 'y' : 'ies'}` }]);

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
          return safeExtractJSON(resp.text);
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
            const resp = await callAnthropic({ system: REVENUE_PROMPT, user, maxSearches: 4, maxTokens: 3072 });
            appendTrace(resp.trace.map((t) => ({ ...t, tag })));
            const parsed = safeExtractJSON(resp.text);
            if (!parsed) return { company: ent.company, role: ent.role, error: 'parse_failed', confidence: 'low' };
            return { company: ent.company, role: ent.role, ...parsed };
          } catch (e) {
            appendTrace([{ kind: 'error', tag, message: e.message }]);
            return { company: ent.company, role: ent.role, error: e.message, confidence: 'low' };
          }
        })
      );

      const parentAnchor = await parentAnchorPromise;

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

  function onKeyDown(e) {
    if (e.key === 'Enter' && !loading) investigate();
  }

  const showStepper = loading || (trace.length > 0 && !result?.ownership_tree);
  const toggleTheme = () => setTheme(theme === 'light' ? 'dark' : 'light');

  return (
    <div className="app">
      <div className="container">
        <header className="app-header">
          <div className="brand">
            <div className="brand-title">Ownership &amp; Revenue Agent</div>
            <div className="brand-sub">Resolve a brand's corporate family with revenue per node.</div>
          </div>
          <div className="header-actions no-print">
            <button
              className="icon-btn"
              onClick={toggleTheme}
              aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
              title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
            >
              {theme === 'light' ? <MoonIcon /> : <SunIcon />}
            </button>
          </div>
        </header>

        {sharedView && (
          <div className="banner banner-shared no-print">
            <span className="mono" style={{ fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
              ★ shared report · read-only
            </span>
            <a href={window.location.pathname} className="mono" style={{ fontSize: 11 }}>
              ↳ run new investigation
            </a>
          </div>
        )}

        {!sharedView && (
          <section className="no-print">
            <div className="input-form">
              <div>
                <label className="field-label">Target brand</label>
                <input
                  className="input"
                  type="text"
                  value={brand}
                  onChange={(e) => setBrand(e.target.value)}
                  placeholder="e.g. Mercury, MUD\WTR, Whole Foods"
                  disabled={loading}
                  onKeyDown={onKeyDown}
                />
              </div>
              <div>
                <label className="field-label">Context (optional)</label>
                <input
                  className="input"
                  type="text"
                  value={hint}
                  onChange={(e) => setHint(e.target.value)}
                  placeholder="domain, industry, geography…"
                  disabled={loading}
                  onKeyDown={onKeyDown}
                />
              </div>
              <button
                className="btn btn-primary"
                onClick={investigate}
                disabled={loading || !brand.trim()}
                style={{ height: 38 }}
              >
                {loading ? '· · · working' : 'Investigate →'}
              </button>
            </div>

            {showStepper && (
              <Stepper phase={phase} loading={loading} result={result} />
            )}
          </section>
        )}

        {error && (
          <div className="banner banner-danger no-print" style={{ marginTop: 16 }}>
            <span className="banner-icon">⚠</span>
            <span>{error}</span>
          </div>
        )}

        {result?.disambiguation && (
          <section className="section">
            <div className="section-head">
              <span className="section-title">Disambiguation candidates</span>
            </div>
            <div className="card">
              {(result.disambiguation.disambiguation_candidates || []).map((c, i) => (
                <div key={i} className="strategic-item">
                  <div className="strategic-head">
                    <span className="strategic-entity">{c.company}</span>
                  </div>
                  <div className="strategic-details" style={{ marginLeft: 0 }}>
                    {c.sector} · {c.country}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {result?.ownership_tree && (
          <ResultView
            result={result}
            showRaw={showRaw}
            setShowRaw={setShowRaw}
            selectedKey={selectedKey}
            setSelectedKey={setSelectedKey}
            viewMode={viewMode}
            setViewMode={setViewMode}
            theme={theme}
          />
        )}

        {!sharedView && trace.length > 0 && (
          <LogsPanel trace={trace} open={logsOpen} setOpen={setLogsOpen} />
        )}
      </div>
    </div>
  );
}

// ─── Stepper ─────────────────────────────────────────────────────────────────

function Stepper({ phase, loading, result }) {
  return (
    <div className="stepper no-print" role="status">
      {STEPS.map((s, i) => {
        const st = stepState(s.id, phase, loading, result);
        return (
          <React.Fragment key={s.id}>
            <div className={`step ${st}`}>
              <span className="step-dot">{st === 'done' ? '✓' : i + 1}</span>
              <span>{s.label}</span>
            </div>
            {i < STEPS.length - 1 && <span className="step-sep" />}
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ─── ResultView ──────────────────────────────────────────────────────────────

function ResultView({ result, showRaw, setShowRaw, selectedKey, setSelectedKey, viewMode, setViewMode, theme }) {
  const tree = result.ownership_tree;
  const positioning = result.positioning_analysis || {};
  const recon = positioning.reconciliation;
  const anchor = positioning.parent_anchor;
  const [shareState, setShareState] = useState('idle');

  const allNodes = useMemo(() => flattenTree(tree), [tree]);
  const revenueMap = useMemo(() => {
    const m = {};
    (result._revenueResults || []).forEach((r) => { m[(r.company || '').toLowerCase().trim()] = r; });
    return m;
  }, [result]);
  const selectedNode = allNodes.find((n) => keyOf(n) === selectedKey) || tree;
  const selectedRevenue = revenueMap[keyOf(selectedNode)];

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
      setShareState('error');
      setTimeout(() => setShareState('idle'), 2200);
    }
  }

  const strategicNotes = Array.isArray(positioning.strategic_notes)
    ? positioning.strategic_notes
    : [positioning.strategic_notes].filter(Boolean);

  return (
    <>
      {/* Export actions */}
      <div className="no-print" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
        <button className="btn btn-sm" onClick={() => window.print()}>↓ PDF</button>
        <button
          className={`btn btn-sm ${shareState === 'copied' ? 'btn-primary' : ''}`}
          onClick={handleShare}
        >
          {shareState === 'copied' ? '✓ Link copied' : shareState === 'working' ? '· · · encoding' : shareState === 'error' ? '✕ failed' : '⎘ Copy share link'}
        </button>
      </div>

      {/* Banners */}
      {recon && <ReconciliationBanner recon={recon} parent={tree.parent} anchor={anchor} focal={tree} />}
      {strategicNotes.filter((n) => n && n.startsWith('⚠')).map((n, i) => (
        <div key={i} className="banner banner-warning" style={{ marginTop: 10 }}>
          <span className="banner-icon">⚠</span>
          <span>{n.replace(/^⚠\s*/, '')}</span>
        </div>
      ))}

      {/* Two-column report */}
      <div className="report-grid">
        {/* LEFT — ownership structure */}
        <div className="left-col">
          <div className="col-header">
            <div>
              <h2 className="col-title">Ownership structure</h2>
              <div className="col-sub">Click a node to inspect its revenue and signals.</div>
            </div>
            <div className="toggle-group no-print" role="tablist" aria-label="View mode">
              <button
                className={viewMode === 'tree' ? 'active' : ''}
                onClick={() => setViewMode('tree')}
                role="tab"
                aria-selected={viewMode === 'tree'}
              >
                Tree
              </button>
              <button
                className={viewMode === 'graph' ? 'active' : ''}
                onClick={() => setViewMode('graph')}
                role="tab"
                aria-selected={viewMode === 'graph'}
              >
                Graph
              </button>
            </div>
          </div>
          {viewMode === 'tree' ? (
            <TreeView tree={tree} selectedKey={selectedKey} onSelect={setSelectedKey} />
          ) : (
            <GraphView tree={tree} selectedKey={selectedKey} onSelect={setSelectedKey} theme={theme} />
          )}

          {/* Strategic control + non-warning notes (under tree on desktop) */}
          {(tree.strategic_control || []).length > 0 && (
            <section className="section">
              <div className="section-head"><span className="section-title">Strategic control</span></div>
              <div className="card">
                {tree.strategic_control.map((s, i) => (
                  <div key={i} className="strategic-item">
                    <div className="strategic-head">
                      <span className="strategic-rel">{s.relationship}</span>
                      <span className="strategic-entity">{s.entity}</span>
                    </div>
                    {s.details && <div className="strategic-details">{s.details}</div>}
                    {s.source_url && (
                      <div className="strategic-source">
                        <a href={s.source_url} target="_blank" rel="noopener noreferrer">{s.source_url}</a>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {strategicNotes.filter((n) => n && !n.startsWith('⚠') && n !== 'No distinctive structural signals captured.').length > 0 && (
            <section className="section">
              <div className="section-head"><span className="section-title">Notes</span></div>
              <div className="card" style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                {strategicNotes
                  .filter((n) => n && !n.startsWith('⚠') && n !== 'No distinctive structural signals captured.')
                  .map((n, i) => <div key={i} style={{ padding: '4px 0' }}>· {n}</div>)}
              </div>
            </section>
          )}

          {/* Raw JSON */}
          <section className="section no-print">
            <button className="raw-toggle" onClick={() => setShowRaw(!showRaw)}>
              {showRaw ? '▾ Hide raw JSON' : '▸ Show raw JSON'}
            </button>
            {showRaw && (
              <pre className="raw-pre">
                {JSON.stringify({ focal_company: result.focal_company, ownership_tree: result.ownership_tree, positioning_analysis: result.positioning_analysis }, null, 2)}
              </pre>
            )}
          </section>
        </div>

        {/* RIGHT — detail panel */}
        <div className="right-col">
          <div className="col-header">
            <div>
              <h2 className="col-title">Entity detail</h2>
              <div className="col-sub">{selectedNode ? roleLabel(selectedNode, tree) : 'Select a node'}</div>
            </div>
          </div>
          <DetailPanel node={selectedNode} revenueResult={selectedRevenue} tree={tree} positioning={positioning} />
        </div>
      </div>
    </>
  );
}

function roleLabel(node, tree) {
  if (keyOf(node) === keyOf(tree)) return 'Focal entity';
  if (keyOf(node) === keyOf(tree.parent)) return 'Immediate parent';
  if ((tree.siblings || []).some((s) => keyOf(s) === keyOf(node))) return 'Sibling';
  if ((tree.children || []).some((c) => keyOf(c) === keyOf(node))) return 'Child';
  return 'Ancestor';
}

// ─── Reconciliation banner ───────────────────────────────────────────────────

function ReconciliationBanner({ recon, parent, anchor, focal }) {
  const ratio = recon.ratio;
  const pctDelta = recon.pct_delta;
  const absDelta = Math.abs(pctDelta);
  const variant = ratio > 1.5 || ratio < 0.5
    ? 'warning'
    : absDelta <= 20
    ? 'success'
    : 'info';
  const severityLabel = absDelta <= 20 ? 'reconciles' : absDelta <= 50 ? 'soft mismatch' : 'large gap';

  const sumStr = formatUSD(recon.sum_children_central);
  const benchStr = formatUSD(recon.parent_benchmark);
  const isAnchored = recon.parent_benchmark_source === '10-K';
  const fiscalYear = anchor?.fiscal_year;
  const parentName = parent?.company || 'Parent';
  const sourceLabel = isAnchored
    ? `${parentName} ${fiscalYear ? `FY${fiscalYear} ` : ''}10-K`
    : `${parentName} estimated central`;

  const segments = Array.isArray(anchor?.segments) ? anchor.segments : [];
  const hasSegments = anchor?.is_public && segments.length > 0;
  const benchmark = recon.parent_benchmark;

  // Coverage bar: ratio 1.0 sits at the 50% midpoint. Clamp display to [0, 2.0].
  const clamped = Math.max(0, Math.min(2, ratio));
  const barFill = (clamped / 2) * 100;
  const barFillColor =
    variant === 'warning' ? 'var(--warning)' : variant === 'success' ? 'var(--accent)' : 'var(--accent)';
  const deltaColor =
    variant === 'warning' ? 'var(--warning)' : variant === 'success' ? 'var(--accent-hover)' : 'var(--text)';

  return (
    <div className={`banner banner-${variant}`} style={{ marginTop: 16, flexDirection: 'column', gap: 14 }}>
      {/* Headline row */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', width: '100%' }}>
        <span className="banner-icon">Σ</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, marginBottom: 2 }}>
            Reconciliation · focal + siblings = <span className="mono">{sumStr}</span> vs <span className="mono">{benchStr}</span> ({sourceLabel})
          </div>
          <div style={{ fontSize: 12, opacity: 0.85 }}>
            Ratio <span className="mono">{(ratio * 100).toFixed(0)}%</span> · delta <span className="mono">{pctDelta > 0 ? '+' : ''}{pctDelta}%</span> · {recon.children_counted} entit{recon.children_counted === 1 ? 'y' : 'ies'} included · <span style={{ color: deltaColor, fontWeight: 600 }}>{severityLabel}</span>
          </div>
        </div>
      </div>

      {/* Coverage bar — center tick at 100% (= ratio 1.0×) */}
      <div style={{ width: '100%' }}>
        <div
          style={{
            position: 'relative',
            height: 10,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: 0,
              width: `${barFill}%`,
              background: barFillColor,
              opacity: 0.85,
              transition: 'width 240ms ease',
            }}
          />
          <div
            style={{
              position: 'absolute',
              top: -3,
              bottom: -3,
              left: '50%',
              width: 1,
              background: 'var(--text)',
              opacity: 0.55,
            }}
          />
        </div>
        <div
          className="mono"
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: 10,
            color: 'var(--text-subtle)',
            letterSpacing: '0.06em',
            marginTop: 4,
          }}
        >
          <span>0×</span>
          <span style={{ color: 'var(--text-muted)' }}>1.0× · parent</span>
          <span>2.0×+</span>
        </div>
      </div>

      {/* Segments table — when parent is public and segment data is present */}
      {hasSegments && (
        <div style={{ width: '100%' }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              fontSize: 11,
              color: 'var(--text-muted)',
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              fontWeight: 600,
              marginBottom: 6,
            }}
          >
            <span>{parentName} reported segments{fiscalYear ? ` · FY${fiscalYear}` : ''}</span>
            {anchor?.source_url && (
              <a
                href={anchor.source_url}
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontSize: 11, textTransform: 'none', letterSpacing: 0 }}
              >
                view filing →
              </a>
            )}
          </div>
          <div style={{ border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden', background: 'var(--bg)' }}>
            {segments.map((seg, i) => {
              const isFocalSeg = !!seg.contains_focal;
              const segRev = seg.revenue_usd || 0;
              const pct = benchmark > 0 ? (segRev / benchmark) * 100 : 0;
              return (
                <div
                  key={i}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '8px 12px',
                    borderBottom: i < segments.length - 1 ? '1px solid var(--border)' : 'none',
                    background: isFocalSeg ? 'var(--accent-soft)' : 'transparent',
                    fontSize: 12,
                  }}
                >
                  <span style={{ width: 12, color: 'var(--accent)', fontSize: 11 }}>{isFocalSeg ? '★' : ''}</span>
                  <span style={{ flex: 1, color: isFocalSeg ? 'var(--text)' : 'var(--text-muted)', fontWeight: isFocalSeg ? 600 : 400 }}>
                    {seg.name}
                    {isFocalSeg && focal?.company && (
                      <span
                        className="mono"
                        style={{
                          marginLeft: 8,
                          color: 'var(--accent-hover)',
                          fontSize: 10,
                          letterSpacing: '0.04em',
                          textTransform: 'uppercase',
                          fontWeight: 600,
                        }}
                      >
                        contains {focal.company}
                      </span>
                    )}
                  </span>
                  <span className="mono" style={{ color: 'var(--text-subtle)', fontSize: 11, minWidth: 48, textAlign: 'right' }}>
                    {pct.toFixed(1)}%
                  </span>
                  <span className="mono" style={{ color: isFocalSeg ? 'var(--text)' : 'var(--text-muted)', minWidth: 96, textAlign: 'right' }}>
                    {formatUSD(segRev)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {anchor && anchor.is_public === false && (
        <div style={{ fontSize: 12, fontStyle: 'italic', color: 'var(--text-muted)' }}>
          {parentName} is not publicly traded — no 10-K anchor available; benchmark uses estimates only.
        </div>
      )}
    </div>
  );
}

// ─── Tree view ───────────────────────────────────────────────────────────────

function TreeView({ tree, selectedKey, onSelect }) {
  const parents = [];
  let p = tree.parent;
  while (p) { parents.unshift(p); p = p.parent; }
  return (
    <div className="tree">
      {parents.map((node, i) => (
        <React.Fragment key={`p${i}`}>
          <TreeNode node={node} role={i === 0 && parents.length > 1 ? 'root' : 'parent'} selectedKey={selectedKey} onSelect={onSelect} />
          <div className="tree-connector" />
        </React.Fragment>
      ))}
      <TreeNode node={tree} role="focal" selectedKey={selectedKey} onSelect={onSelect} />
      {(tree.siblings || []).length > 0 && (
        <>
          <div className="tree-section-label">Siblings</div>
          <div className="tree-grid">
            {tree.siblings.map((s, i) => (
              <TreeNode key={`s${i}`} node={s} role="sibling" selectedKey={selectedKey} onSelect={onSelect} />
            ))}
          </div>
        </>
      )}
      {(tree.children || []).length > 0 && (
        <>
          <div className="tree-section-label">Children</div>
          <div className="tree-grid">
            {tree.children.map((c, i) => (
              <TreeNode key={`c${i}`} node={c} role="child" selectedKey={selectedKey} onSelect={onSelect} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function TreeNode({ node, role, selectedKey, onSelect }) {
  const isFocal = role === 'focal';
  const isSelected = keyOf(node) === selectedKey;
  const rev = node.revenue_estimate;
  return (
    <button
      type="button"
      className={`tree-node ${isFocal ? 'focal' : ''} ${isSelected ? 'selected' : ''}`}
      onClick={() => onSelect(keyOf(node))}
    >
      <div className="tree-node-main">
        <span className="tree-node-name">{node.company}</span>
        <div className="tree-node-meta">
          <span className={`chip ${isFocal ? 'chip-accent' : ''}`}>{role}</span>
          {node.layer && <span className="chip">{node.layer}</span>}
          {node.terminal_layer === 'private_equity' && <span className="chip chip-warning">PE</span>}
          {node.status && node.status !== 'active' && <span className="chip chip-danger">{node.status}</span>}
        </div>
      </div>
      <div className={`tree-node-rev ${rev ? '' : 'empty'}`}>
        {rev ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span className={`confidence-dot confidence-${rev.confidence || 'unknown'}`} />
            {formatUSD(rev.central)}
          </span>
        ) : 'n/a'}
      </div>
    </button>
  );
}

// ─── Graph view (React Flow) ────────────────────────────────────────────────

const flowNodeTypes = { entity: FlowNode };

function FlowNode({ data }) {
  const { node, role, selected, onSelect } = data;
  const rev = node.revenue_estimate;
  const isFocal = role === 'focal';
  const handleStyle = { background: 'transparent', border: 'none', width: 1, height: 1 };
  return (
    <div
      className={`flow-node ${isFocal ? 'focal' : ''} ${selected ? 'selected' : ''}`}
      onClick={() => onSelect(keyOf(node))}
    >
      <Handle type="target" position={Position.Top} style={handleStyle} className="flow-handle" />
      <div className="flow-node-name">{node.company}</div>
      {node.domain && <div className="flow-node-domain">{node.domain}</div>}
      <div className="flow-node-meta">
        <span className={`chip ${isFocal ? 'chip-accent' : ''}`}>{role}</span>
        {rev && (
          <>
            <span className={`confidence-dot confidence-${rev.confidence || 'unknown'}`} />
            <span className="flow-node-rev">{formatUSD(rev.central)}</span>
            {rev.anchor_adjusted && (
              <span
                className="chip"
                title={
                  node.revenue_estimate_raw
                    ? `Anchor-adjusted from raw ${formatUSD(node.revenue_estimate_raw.central)}${rev.anchor_clamped ? ' (clamped to band)' : ''}`
                    : 'Anchor-adjusted to parent 10-K total'
                }
              >
                {rev.anchor_clamped ? 'adj·clamp' : 'adj'}
              </span>
            )}
          </>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} style={handleStyle} className="flow-handle" />
    </div>
  );
}

function GraphView({ tree, selectedKey, onSelect, theme }) {
  const { nodes, edges } = useMemo(() => buildFlowData(tree, selectedKey, onSelect), [tree, selectedKey, onSelect]);
  return (
    <div className="flow-container">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={flowNodeTypes}
        fitView
        fitViewOptions={{ padding: 0.18 }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag
        zoomOnScroll
        proOptions={{ hideAttribution: false }}
      >
        <Background
          color={theme === 'dark' ? '#2a2a30' : '#d4d4d8'}
          gap={20}
          size={1}
        />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable nodeStrokeWidth={0} maskColor={theme === 'dark' ? 'rgba(10,10,12,0.6)' : 'rgba(244,244,245,0.6)'} />
      </ReactFlow>
    </div>
  );
}

function buildFlowData(tree, selectedKey, onSelect) {
  const nodes = [];
  const edges = [];
  const GAP_Y = 130;
  const GAP_X = 260;

  const parents = [];
  let p = tree.parent;
  while (p) { parents.unshift(p); p = p.parent; }

  parents.forEach((node, i) => {
    nodes.push({
      id: `p${i}`,
      type: 'entity',
      position: { x: 0, y: i * GAP_Y },
      data: { node, role: i === 0 && parents.length > 1 ? 'root' : 'parent', selected: keyOf(node) === selectedKey, onSelect },
    });
    if (i > 0) edges.push({ id: `ep${i - 1}_${i}`, source: `p${i - 1}`, target: `p${i}` });
  });

  const focalY = parents.length * GAP_Y;
  const siblings = tree.siblings || [];
  const half = Math.ceil(siblings.length / 2);
  const row = [
    ...siblings.slice(0, half).map((s, idx) => ({ id: `sL${idx}`, node: s, role: 'sibling' })),
    { id: 'focal', node: tree, role: 'focal' },
    ...siblings.slice(half).map((s, idx) => ({ id: `sR${idx}`, node: s, role: 'sibling' })),
  ];
  row.forEach((item, idx) => {
    const x = (idx - (row.length - 1) / 2) * GAP_X;
    nodes.push({
      id: item.id,
      type: 'entity',
      position: { x, y: focalY },
      data: { node: item.node, role: item.role, selected: keyOf(item.node) === selectedKey, onSelect },
    });
    if (parents.length > 0) {
      edges.push({ id: `epf_${item.id}`, source: `p${parents.length - 1}`, target: item.id });
    }
  });

  const children = tree.children || [];
  const childY = focalY + GAP_Y;
  children.forEach((node, i) => {
    const id = `c${i}`;
    const x = (i - (children.length - 1) / 2) * GAP_X;
    nodes.push({
      id,
      type: 'entity',
      position: { x, y: childY },
      data: { node, role: 'child', selected: keyOf(node) === selectedKey, onSelect },
    });
    edges.push({ id: `efc_${id}`, source: 'focal', target: id });
  });

  return { nodes, edges };
}

// ─── Detail panel ────────────────────────────────────────────────────────────

function DetailPanel({ node, revenueResult, tree, positioning }) {
  if (!node) {
    return <div className="card detail-empty">No entity selected.</div>;
  }
  const rev = node.revenue_estimate;
  const signals = revenueResult?.signals_found || node.signals_found || [];
  const reasoning = revenueResult?.reasoning_summary || node.reasoning_summary;
  const error = revenueResult?.error || node.revenue_error;
  const isFocal = keyOf(node) === keyOf(tree);

  return (
    <div className="card card-pad-lg">
      <h3 className="detail-name">{node.company}</h3>
      {node.domain && <div className="detail-domain">{node.domain}</div>}
      <div className="detail-chips">
        {node.layer && <span className="chip">{node.layer}</span>}
        {node.node_type && <span className="chip">{node.node_type.replace('_', ' ')}</span>}
        {node.terminal_layer === 'private_equity' && <span className="chip chip-warning">PE-owned</span>}
        {node.standalone && <span className="chip chip-accent">standalone</span>}
        {node.status && node.status !== 'active' && <span className="chip chip-danger">{node.status}</span>}
      </div>

      {node.acquisition?.acquired_by && (
        <div style={{ marginTop: 12, fontSize: 13, color: 'var(--text-muted)' }}>
          Acquired by <strong style={{ color: 'var(--text)' }}>{node.acquisition.acquired_by}</strong>
          {node.acquisition.year ? ` · ${node.acquisition.year}` : ''}
          {node.acquisition.source_url && (
            <> · <a href={node.acquisition.source_url} target="_blank" rel="noopener noreferrer">source</a></>
          )}
        </div>
      )}

      {rev ? (
        <div className="rev-card">
          <div className="card-title">Annual revenue estimate</div>
          <div className="rev-big">{formatUSD(rev.central)}</div>
          <div className="rev-range">range {formatUSD(rev.low)} — {formatUSD(rev.high)}</div>
          <div className="rev-foot">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span className={`confidence-dot confidence-${rev.confidence || 'unknown'}`} />
              <span>{rev.confidence || 'unknown'} confidence</span>
            </span>
            {rev.anchor_adjusted && (
              <span className="chip" style={{ marginLeft: 8 }}>
                anchor-adjusted{rev.anchor_clamped ? ' · clamped' : ''}
                {rev.anchor_scale ? ` · ${rev.anchor_scale}×` : ''}
              </span>
            )}
          </div>
          {rev.anchor_adjusted && node.revenue_estimate_raw && (
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted)' }}>
              Raw model estimate: {formatUSD(node.revenue_estimate_raw.central)} (range {formatUSD(node.revenue_estimate_raw.low)} — {formatUSD(node.revenue_estimate_raw.high)})
            </div>
          )}
        </div>
      ) : (
        <div className="rev-card" style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          No revenue estimated for this entity.
        </div>
      )}

      {error && (
        <div className="banner banner-warning" style={{ marginTop: 12 }}>
          <span className="banner-icon">⚠</span>
          <span>Revenue agent error: {error}</span>
        </div>
      )}

      {reasoning && (
        <div style={{ marginTop: 14, fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6 }}>
          {reasoning}
        </div>
      )}

      {signals.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <div className="card-title">Signals captured</div>
          {signals.map((s, i) => (
            <div key={i} className="signal-row">
              <div className="signal-type">{s.type}</div>
              <div>
                <div className="signal-label">{s.label}</div>
                <div className="signal-value">{s.value}</div>
                {s.source && <div className="signal-source">via {s.source}</div>}
              </div>
              <div className="signal-weight">{s.weight}</div>
            </div>
          ))}
        </div>
      )}

      {isFocal && (
        <div style={{ marginTop: 18 }}>
          <div className="card-title">Positioning</div>
          <PosRow label="vs parent" value={positioning.focal_vs_parent_ratio} />
          <PosRow label="vs siblings" value={positioning.focal_vs_siblings} />
          <PosRow label="growth signals" value={positioning.growth_signals} />
        </div>
      )}
    </div>
  );
}

function PosRow({ label, value }) {
  return (
    <div style={{ padding: '8px 0', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 3 }}>{label}</div>
      <div style={{ color: 'var(--text)' }}>{value || '—'}</div>
    </div>
  );
}

// ─── Logs panel ──────────────────────────────────────────────────────────────

function LogsPanel({ trace, open, setOpen }) {
  return (
    <div className="logs-panel no-print">
      <button className="logs-toggle" onClick={() => setOpen(!open)}>
        <span>{open ? '▾' : '▸'} Agent logs · {trace.length} events</span>
        <span className="mono" style={{ fontSize: 11 }}>{open ? 'hide' : 'show'}</span>
      </button>
      {open && (
        <div className="logs-body">
          {trace.map((item, i) => <LogRow key={i} index={i + 1} item={item} />)}
        </div>
      )}
    </div>
  );
}

function LogRow({ index, item }) {
  const idx = <span className="log-idx">[{String(index).padStart(2, '0')}]</span>;
  const tag = item.tag ? <span className="log-tag">[{item.tag}]</span> : null;
  if (item.kind === 'phase') {
    return (
      <div className="log-row log-row-phase">
        {idx}
        <span className="log-kind log-kind-phase">phase</span>
        <span className="log-text">· {item.phase} → {item.label}</span>
      </div>
    );
  }
  if (item.kind === 'search') {
    return (
      <div className="log-row">
        {idx}
        {tag}
        <span className="log-kind log-kind-search">search</span>
        <span className="log-text">"{item.query}"</span>
      </div>
    );
  }
  if (item.kind === 'results') {
    return (
      <div className="log-row">
        {idx}
        {tag}
        <span className="log-kind log-kind-results">fetched</span>
        <span className="log-text">{item.count} result{item.count === 1 ? '' : 's'}{item.sources?.length ? ` · ${item.sources.slice(0, 2).join(' · ').slice(0, 90)}` : ''}</span>
      </div>
    );
  }
  if (item.kind === 'error') {
    return (
      <div className="log-row">
        {idx}
        {tag}
        <span className="log-kind log-kind-error">error</span>
        <span className="log-text">{item.message}</span>
      </div>
    );
  }
  const text = item.text && item.text.length > 320 ? item.text.slice(0, 320) + '…' : item.text;
  return (
    <div className="log-row">
      {idx}
      {tag}
      <span className="log-thought">{text}</span>
    </div>
  );
}

// ─── Tree flattening ─────────────────────────────────────────────────────────

function flattenTree(tree) {
  if (!tree) return [];
  const out = [];
  const seen = new Set();
  const add = (n) => {
    if (!n) return;
    const k = keyOf(n);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(n);
  };
  let p = tree.parent;
  const chain = [];
  while (p) { chain.unshift(p); p = p.parent; }
  chain.forEach(add);
  add(tree);
  (tree.siblings || []).forEach(add);
  (tree.children || []).forEach(add);
  return out;
}

// ─── Icons ───────────────────────────────────────────────────────────────────

function SunIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}
function MoonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}
