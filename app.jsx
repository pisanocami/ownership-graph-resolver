import React, { useState, useEffect, useMemo } from 'react';
import ReactFlow, { Background, Controls, MiniMap, Handle, Position } from 'reactflow';
import 'reactflow/dist/style.css';
import jsPDF from 'jspdf';
import {
  synthesize,
  collectEntities,
  formatUSD,
  keyOf,
  safeExtractJSON,
  deriveStatus,
  deriveRevenueStatus,
  deriveDivestiture,
  collectControlLayers,
} from './synth.js';

const PROVIDERS = {
  anthropic: {
    label: 'Claude',
    models: [{ id: 'claude-sonnet-4-20250514', label: 'Sonnet 4' }],
  },
  gemini: {
    label: 'Gemini',
    models: [
      { id: 'gemini-2.5-flash', label: '2.5 Flash' },
      { id: 'gemini-2.5-pro', label: '2.5 Pro' },
    ],
  },
};

const DEFAULT_PROVIDER = 'anthropic';
const DEFAULT_MODEL = PROVIDERS[DEFAULT_PROVIDER].models[0].id;

// ─── System prompts ──────────────────────────────────────────────────────────

const OWNERSHIP_PROMPT = `You are a research agent that resolves corporate ownership graphs. Your output is a hierarchical, verifiable tree. Every node is backed by a concrete source. If you cannot back it, you do not emit it. An incomplete tree beats a false tree.

PROCESS

Step 1 — Identity verification. Before resolving ownership, confirm WHICH entity it is (canonical domain, sector, country). If the input has more than one plausible match, return disambiguation_required:true with candidates and stop.

Step 2 — Distinguish legal entity vs operating brand. Mark node_type: "legal_entity" | "operating_brand" on each node.

Step 3 — Parent search. Queries in order: "[company] parent company" → "[company] acquired by" → "[company] subsidiary of" → SEC EDGAR if US-public → financial press.

ACQUISITION HANDLING (CRITICAL — read carefully):
A company can have an ANNOUNCED but UNCLOSED deal. You MUST distinguish three states and never mix them:
  - current_legal_parent: the entity that LEGALLY OWNS the company TODAY (the only one that consolidates its financials right now).
  - pending_acquisition: a deal that has been ANNOUNCED but has not closed yet — antitrust/regulatory pending, no consolidation yet. Capture expected_close_date if available and source_url of the deal announcement.
  - post_close_consolidated_parent: the entity that WILL own the company once the pending deal closes. This is NOT the current owner.
Rules:
  1. The "parent" field of the node MUST be the current_legal_parent. NEVER set "parent" to the post-close acquirer of a deal that has not legally closed.
  2. If a pending deal exists, ALSO populate pending_acquisition (with acquirer, announced_date, expected_close_date, source_url) and post_close_consolidated_parent ({"company": ..., "source_url": ...}). Both are independent of the "parent" field.
  3. Siblings (next step) are ALWAYS drawn from the current_legal_parent's brand portfolio — NEVER from the acquirer's portfolio while the deal is pending.
  4. NEVER mix shareholders/governance of one universe with the parent of the other. Example: if the current_legal_parent is private/family-owned (Mars, Cargill, IKEA-INGKA, etc.), do NOT list institutional shareholders (BlackRock, Vanguard, etc.) because there are no public shares to hold. Those shareholders only exist in the public-company universe.
  5. If you cannot tell whether the deal has closed, treat it as pending (more conservative) and explain in notes.

Step 4 — Recurse to root. Stop conditions: ultimate parent identifiable, PE firm (mark terminal_layer:"private_equity" and stop), or no evidence. Recurse through current_legal_parent only, never through the pending acquirer.

Step 5 — Siblings. List brands at the same layer of the CURRENT LEGAL PARENT, ONLY with verifiable source. The "siblings" field is ALWAYS current_siblings_under_current_parent — do not contaminate it with brands of the post-close acquirer. If you want to surface the acquirer's portfolio for context, place them in the SEPARATE field "future_cousins_post_close" (and only when pending_acquisition is non-null). For EACH sibling capture: a free-text "category" describing what it sells (e.g. "premium hybrid mattress", "rugs", "B2B billing SaaS" — whatever the sources say; "" if unknown), and presence signals: in_current_sources (true if it appears in a PRIMARY/current source), in_historical_sources (true if it appears in a SECONDARY/older source), and last_mention_date (most recent date you saw it referenced, or null). Do NOT label a sibling active/legacy/discontinued — only report the raw flags and date; classification happens downstream.

SOURCE PRIORITIZATION (apply when listing siblings and children):
PRIMARY (current state, last ~24 months): the aggregator's official brand portfolio / "our brands" page, press releases dated within the last 24 months, and communications about the most recent acquisition. These reflect the CURRENT lineup.
SECONDARY (historical, may be stale): FTC/SEC filings, press releases older than 2 years, Wikipedia/Wikidata.
RULE: a brand present in a PRIMARY source but ABSENT from SECONDARY ones is CURRENT, not invalid — capture it (e.g. a brand launched in the last 1–2 years). NEVER drop a brand solely because older/secondary sources omit it.

Step 6 — Children. If the input is a parent, list direct subsidiaries.

Step 7 — Strategic control. Capture control/governance relationships that are NOT formal ownership: founders, the last pre-acquisition funding round, the current executive leader (CEO/President), board members, investors/VCs, PE backers, major shareholders. Include ONLY with clear evidence (funding press release, SEC 13D/13G, official board page, M&A announcement). Describe each relationship as a FREE-TEXT role_description (e.g. "lead Series B investor", "co-founder & CEO", "PE sponsor") — do NOT pick from a fixed list. POPULATE strategic_control for EVERY node in the chain (root, each parent, and the focal), not just the focal. Aggregator layers especially tend to have independent founders and prior funding rounds. For acquired companies, capture BOTH the historical pre-acquisition investors AND the current post-acquisition executives. If a layer genuinely has no evidenced control info, set strategic_control:[] and strategic_control_note:"no_data_found: <reason>".

DEPTH/FAN-OUT CAP
Limit ownership recursion to 2–3 generations. Cap siblings to the 8 most material brands, but ALWAYS include every brand with in_current_sources:true before any historical-only brand — only drop historical-only brands when over the cap. Cap children to 6 direct subsidiaries.

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
  "in_current_sources": bool,          // appears in a PRIMARY/current source
  "in_historical_sources": bool,       // appears in a SECONDARY/older source
  "last_mention_date": str|null,       // most recent date referenced (ISO-ish) or null
  "category": str,                     // free text from sources; "" if unknown. NOT an enum.
  "parent": {recursive} | null,             // ALWAYS the current legal parent. Never the post-close acquirer of an unclosed deal.
  "siblings": [{"company": str, "domain": str, "node_type": str, "category": str, "in_current_sources": bool, "in_historical_sources": bool, "last_mention_date": str|null, "source_urls": [url]}],   // current_siblings_under_current_parent — brands of the current legal parent ONLY.
  "future_cousins_post_close": [{"company": str, "domain": str, "category": str, "source_urls": [url]}] | null,   // ONLY when pending_acquisition is non-null. Brands of the announced acquirer that would become cousins post-close. Empty/null otherwise.
  "pending_acquisition": {                  // null if no announced-but-unclosed deal
    "acquirer": str,
    "announced_date": str|null,             // ISO YYYY-MM-DD if known
    "expected_close_date": str|null,        // ISO YYYY-MM-DD if disclosed
    "regulatory_status": str|null,          // e.g. "antitrust review", "shareholder vote pending"
    "source_url": str
  } | null,
  "post_close_consolidated_parent": {"company": str, "source_url": str} | null,   // entity that WILL own focal once pending_acquisition closes
  "children": [{recursive}],
  "acquisition": {"acquired_by": str, "year": int, "source_url": str} | null,   // CLOSED acquisitions only (historical). Pending deals go in pending_acquisition.
  "strategic_control": [{"entity": str, "role_description": str, "evidence": str, "source_url": str}],
  "strategic_control_note": str|null,  // when strategic_control is []: "no_data_found: <reason>"
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
5. If you find evidence the brand was historically LARGER (a revenue peak, layoffs, declining traffic, "down from"), capture it as a "press" signal and state the peak in the value — this matters for reconciliation downstream.
6. If revenue flows through wholesale / B2B / white-label / marketplace channels rather than the brand's own DTC site, say so explicitly in reasoning_summary — it explains gaps between brand-site signals and reported revenue.

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
  "signals_attempted": <int>,         // how many signal types you tried to find
  "signals_found_count": <int>,       // how many yielded usable data (== signals_found.length)
  "signals_found": [
    {
      "type": "web_traffic" | "hiring" | "reviews" | "pricing" | "funding" | "customers" | "press" | "marketplace" | "other",
      "label": "<short signal name, max 5 words>",
      "value": "<the actual data point found>",
      "source": "<source name or short URL>",
      "weight": "low" | "medium" | "high"
    }
  ],
  "reasoning_summary": "<2-4 sentences explaining how the signals triangulate to the estimate>",
  "reason_for_null": str|null         // when the estimate is 0/unknown, a FREE-TEXT reason (e.g. "brand launched <12mo ago, no traffic or funding data yet"). NOT a code like "n/a".
}
\`\`\`

Weak/contradictory signals → wider range, "low" confidence. If you genuinely cannot estimate, set the numbers to 0, confidence "low", and write a descriptive reason_for_null explaining why (never the string "n/a").`;

const PARENT_ANCHOR_PROMPT = `You are a filings agent. Given a PARENT company and a FOCAL subsidiary, determine if PARENT is publicly traded and, if so, extract the latest annual-report (10-K / 20-F / annual filing) segment revenue.

CRITICAL: PARENT here is the CURRENT LEGAL PARENT (the entity that owns FOCAL today and consolidates its financials). If the user mentions a pending/announced acquisition by a different acquirer, IGNORE the acquirer — their filings do not yet consolidate FOCAL. Only look at the current legal parent's most recent filed annual report.

Rules:
- Search authoritative sources only: SEC EDGAR, the company's IR site, the actual 10-K/20-F PDF, or a reputable financial press summary of the filing.
- If the filing breaks revenue by segment, list each segment with USD revenue. Mark "contains_focal":true on the segment that most plausibly contains FOCAL (by brand list, business description, or geography).
- If PARENT is private (family-owned, mutual, cooperative, PE-held, etc.) or no filing is locatable, return is_public:false and null fields. Do NOT substitute the pending acquirer's filing — that is a different universe.
- In "notes", mention if a segment mixes wholesale vs DTC revenue, or includes discontinued/legacy brands — this helps explain reconciliation gaps downstream.
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

function isSafeUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// Pool executor: limits max concurrent tasks. Prevents rate-limit 429s and cost spikes.
async function concurrencyPool(tasks, maxConcurrent = 3) {
  const results = [];
  let running = 0;
  let nextIdx = 0;

  return new Promise((resolve, reject) => {
    const launch = () => {
      while (running < maxConcurrent && nextIdx < tasks.length) {
        running++;
        const idx = nextIdx++;
        Promise.resolve(tasks[idx]())
          .then((res) => { results[idx] = res; })
          .catch((err) => { results[idx] = Promise.reject(err); })
          .finally(() => {
            running--;
            if (nextIdx < tasks.length) launch();
            else if (running === 0) resolve(results);
          });
      }
      if (nextIdx >= tasks.length && running === 0) resolve(results);
    };
    launch();
  });
}

function formatRelativeTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

// Provider-agnostic dispatcher. Routes to the right proxy + builder/parser pair.
// Both providers normalize to the same { text, trace, raw } contract so the rest
// of the pipeline (safeExtractJSON, logs, synthesis) stays provider-unaware.
async function callLLM({ provider = DEFAULT_PROVIDER, model, system, user, maxSearches = 4, maxTokens = 4096 }) {
  if (provider === 'gemini') return callGemini({ model, system, user, maxTokens });
  return callAnthropic({ model, system, user, maxSearches, maxTokens });
}

// Call the existing Express proxy → Anthropic.
async function callAnthropic({ model = DEFAULT_MODEL, system, user, maxSearches = 4, maxTokens = 4096 }) {
  const res = await fetch('/api/anthropic', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
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

// Call the Express proxy → Gemini (Google Search grounding). Gemini self-limits
// search use, so maxSearches has no per-call analogue here.
//
// Auto-retry on MAX_TOKENS truncation: ownership JSON for aggregators with many
// brands (e.g. Kellanova / Pringles) routinely runs past a conservative budget.
// If the first call hits MAX_TOKENS AND the text fails to parse as JSON, we
// retry once with the budget doubled (capped at Gemini's 65536 ceiling) and
// emit a synthetic trace event so the user sees the retry.
const GEMINI_MAX_OUTPUT_CEILING = 65536;

async function callGeminiOnce({ model, system, user, budget, isFlash }) {
  const generationConfig = { maxOutputTokens: budget };
  if (isFlash) generationConfig.thinkingConfig = { thinkingBudget: 0 };

  const res = await fetch('/api/gemini', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      contents: [{ role: 'user', parts: [{ text: user }] }],
      systemInstruction: { parts: [{ text: system }] },
      tools: [{ google_search: {} }],
      generationConfig,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`API ${res.status}: ${errText.slice(0, 240)}`);
  }
  const data = await res.json();
  const parsed = parseGeminiResponse(data);
  parsed.finishReason = data.candidates?.[0]?.finishReason || null;
  parsed.budgetUsed = budget;
  return parsed;
}

async function callGemini({ model, system, user, maxTokens = 4096 }) {
  // Gemini 2.5 Flash ships with thinking mode ON by default; "thoughts" tokens
  // are charged against maxOutputTokens, which can silently truncate the JSON.
  // Disable thinking on Flash so the whole budget goes to the actual answer.
  // Keep thinking enabled on Pro (it benefits from extended reasoning).
  const isFlash = /flash/i.test(model || '');
  // Generous initial budgets — Flash output is cheap and the JSON can be large.
  // Caller's maxTokens hint acts as a floor, never a ceiling.
  const initialBudget = Math.min(
    GEMINI_MAX_OUTPUT_CEILING,
    Math.max(maxTokens, isFlash ? 24576 : 16384)
  );

  let parsed = await callGeminiOnce({ model, system, user, budget: initialBudget, isFlash });

  // Retry once if truncated AND the text doesn't already contain a parseable
  // JSON object. We probe with safeExtractJSON to avoid wasting a second call
  // when the partial output happens to still parse.
  if (parsed.finishReason === 'MAX_TOKENS' && !safeExtractJSON(parsed.text)) {
    const retryBudget = Math.min(GEMINI_MAX_OUTPUT_CEILING, initialBudget * 2);
    if (retryBudget > initialBudget) {
      parsed.trace.push({
        kind: 'phase',
        label: `Output truncated at ${initialBudget} tokens — retrying with ${retryBudget}-token budget`,
      });
      const retried = await callGeminiOnce({ model, system, user, budget: retryBudget, isFlash });
      // Prepend the original trace so the retry context is preserved.
      retried.trace = [...parsed.trace, ...retried.trace];
      retried.retried = true;
      return retried;
    }
  }
  return parsed;
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

// Normalize Gemini's candidates/groundingMetadata shape into the same
// { text, trace, raw } contract as parseAnthropicResponse.
function parseGeminiResponse(data) {
  const trace = [];
  let text = '';
  const cand = data.candidates?.[0];
  const parts = cand?.content?.parts || [];
  for (const part of parts) {
    if (part.text && part.text.trim()) {
      trace.push({ kind: 'thought', text: part.text.trim() });
      text += part.text + '\n';
    }
  }
  const gm = cand?.groundingMetadata;
  if (gm) {
    (gm.webSearchQueries || []).forEach((q) => trace.push({ kind: 'search', query: q }));
    const chunks = gm.groundingChunks || [];
    if (chunks.length) {
      const sources = chunks.slice(0, 4).map((c) => c.web?.title || c.web?.uri || '').filter(Boolean);
      trace.push({ kind: 'results', count: chunks.length, sources });
    }
  }
  return { text, trace, raw: data };
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
  const [history, setHistory] = useState([]);
  const [loadedFrom, setLoadedFrom] = useState(null); // { id, createdAt } when hydrated from cache
  const [provider, setProvider] = useState(() => {
    if (typeof window === 'undefined') return DEFAULT_PROVIDER;
    const p = window.localStorage.getItem('orva.provider');
    return p && PROVIDERS[p] ? p : DEFAULT_PROVIDER;
  });
  const [model, setModel] = useState(() => {
    if (typeof window === 'undefined') return DEFAULT_MODEL;
    const p = window.localStorage.getItem('orva.provider');
    const m = window.localStorage.getItem('orva.model');
    const prov = p && PROVIDERS[p] ? p : DEFAULT_PROVIDER;
    return PROVIDERS[prov].models.some((x) => x.id === m) ? m : PROVIDERS[prov].models[0].id;
  });

  // Apply theme + persist
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { window.localStorage.setItem('orva.theme', theme); } catch {}
  }, [theme]);

  // Persist view mode
  useEffect(() => {
    try { window.localStorage.setItem('orva.view', viewMode); } catch {}
  }, [viewMode]);

  // Persist provider/model
  useEffect(() => {
    try { window.localStorage.setItem('orva.provider', provider); } catch {}
  }, [provider]);
  useEffect(() => {
    try { window.localStorage.setItem('orva.model', model); } catch {}
  }, [model]);

  function changeProvider(next) {
    setProvider(next);
    const models = PROVIDERS[next]?.models || [];
    if (!models.some((m) => m.id === model)) setModel(models[0]?.id);
  }

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

  async function refreshHistory() {
    try {
      const res = await fetch('/api/investigations');
      if (!res.ok) return;
      const items = await res.json();
      setHistory(items);
    } catch { /* ignore */ }
  }

  useEffect(() => { refreshHistory(); }, []);

  function appendTrace(items) {
    setTrace((prev) => [...prev, ...items]);
  }

  async function openFromHistory(id) {
    try {
      setError(null);
      const res = await fetch(`/api/investigations/${id}`);
      if (!res.ok) throw new Error('Could not load investigation');
      const record = await res.json();
      setBrand(record.brand);
      setHint(record.hint || '');
      setResult(record.result);
      setTrace([]);
      setLoadedFrom({ id: record.id, createdAt: record.createdAt });
    } catch (e) {
      setError(e.message || String(e));
    }
  }

  async function deleteFromHistory(id) {
    try {
      await fetch(`/api/investigations/${id}`, { method: 'DELETE' });
      if (loadedFrom?.id === id) setLoadedFrom(null);
      refreshHistory();
    } catch { /* ignore */ }
  }

  async function investigate(opts = {}) {
    if (!brand.trim()) return;
    const force = !!opts.force;
    setLoading(true);
    setTrace([]);
    setResult(null);
    setError(null);
    setSelectedKey(null);
    setLogsOpen(false);
    setLoadedFrom(null);

    // Cache lookup — skip when force re-run is requested.
    if (!force) {
      try {
        const q = new URLSearchParams({ brand: brand.trim(), hint: hint.trim() });
        const res = await fetch(`/api/investigations/lookup?${q.toString()}`);
        if (res.ok) {
          const record = await res.json();
          setResult(record.result);
          setLoadedFrom({ id: record.id, createdAt: record.createdAt });
          setLoading(false);
          setPhase(null);
          return;
        }
      } catch { /* fall through to live run */ }
    }

    setPhase('ownership');
    try {
      appendTrace([{ kind: 'phase', phase: 'ownership', label: `resolving ownership of ${brand.trim()}` }]);
      const ownershipUser = `Resolve the corporate ownership of: "${brand.trim()}"${hint.trim() ? `\n\nContext: ${hint.trim()}` : ''}`;
      const ownershipResp = await callLLM({
        provider,
        model,
        system: OWNERSHIP_PROMPT,
        user: ownershipUser,
        maxSearches: 8,
        maxTokens: 6144,
      });
      appendTrace(ownershipResp.trace.map((t) => ({ ...t, tag: 'ownership' })));
      const ownership = safeExtractJSON(ownershipResp.text);
      if (!ownership) {
        const fr = ownershipResp.finishReason ? ` (finishReason: ${ownershipResp.finishReason})` : '';
        const preview = (ownershipResp.text || '').trim().slice(0, 200);
        const hintMsg = ownershipResp.finishReason === 'MAX_TOKENS'
          ? ' — output was truncated. Try Gemini 2.5 Pro or Claude Sonnet for this query.'
          : (!preview ? ' — empty response from the model.' : '');
        throw new Error(`Ownership phase did not return parseable JSON${fr}.${hintMsg}${preview ? ` Preview: "${preview}…"` : ''}`);
      }
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
          const resp = await callLLM({
            provider,
            model,
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

      const revenueResults = await concurrencyPool(
        entities.map((ent) => async () => {
          const tag = `revenue:${ent.company}`;
          appendTrace([{ kind: 'phase', phase: tag, label: `→ ${ent.company} (${ent.role})` }]);
          try {
            const user = `Investigate the annual revenue of: "${ent.company}"${ent.domain ? ` (domain: ${ent.domain})` : ''}. Role in corporate family: ${ent.role}.`;
            const resp = await callLLM({ provider, model, system: REVENUE_PROMPT, user, maxSearches: 4, maxTokens: 3072 });
            appendTrace(resp.trace.map((t) => ({ ...t, tag })));
            const parsed = safeExtractJSON(resp.text);
            if (!parsed) return { company: ent.company, role: ent.role, error: 'parse_failed', confidence: 'low' };
            return { company: ent.company, role: ent.role, ...parsed };
          } catch (e) {
            appendTrace([{ kind: 'error', tag, message: e.message }]);
            return { company: ent.company, role: ent.role, error: e.message, confidence: 'low' };
          }
        }),
        3
      );

      const parentAnchor = await parentAnchorPromise;

      setPhase('synthesis');
      appendTrace([{ kind: 'phase', phase: 'synthesis', label: 'merging ownership + revenue → positioning' }]);
      const byCompany = {};
      revenueResults.forEach((r) => { byCompany[r.company.toLowerCase().trim()] = r; });
      const synthesized = synthesize(ownership, byCompany, parentAnchor);
      const finalResult = { ...synthesized, _entities: entities, _revenueResults: revenueResults, _parentAnchor: parentAnchor };
      setResult(finalResult);
      appendTrace([{ kind: 'phase', phase: 'done', label: 'investigation complete' }]);

      // Persist for instant re-open later.
      try {
        const saveRes = await fetch('/api/investigations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ brand: brand.trim(), hint: hint.trim(), result: finalResult }),
        });
        if (saveRes.ok) {
          const saved = await saveRes.json();
          setLoadedFrom({ id: saved.id, createdAt: saved.createdAt });
          refreshHistory();
        }
      } catch { /* persistence is best-effort */ }
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
                onClick={() => investigate()}
                disabled={loading || !brand.trim()}
                style={{ height: 38 }}
              >
                {loading ? '· · · working' : 'Investigate →'}
              </button>
              {loadedFrom && !loading && (
                <button
                  className="btn btn-secondary"
                  onClick={() => investigate({ force: true })}
                  disabled={!brand.trim()}
                  style={{ height: 38 }}
                  title="Bypass cache and rerun a fresh investigation"
                >
                  ↻ Re-run fresh
                </button>
              )}
            </div>

            <div className="provider-bar no-print">
              <span className="provider-bar-label">Model</span>
              <select
                className="select"
                value={provider}
                onChange={(e) => changeProvider(e.target.value)}
                disabled={loading}
                aria-label="Provider"
              >
                {Object.entries(PROVIDERS).map(([id, p]) => (
                  <option key={id} value={id}>{p.label}</option>
                ))}
              </select>
              <select
                className="select"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={loading}
                aria-label="Model"
              >
                {(PROVIDERS[provider]?.models || []).map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </div>

            {loadedFrom && !loading && (
              <div className="mono" style={{ marginTop: 10, fontSize: 11, color: 'var(--text-subtle)' }}>
                ✓ loaded from cache · {formatRelativeTime(loadedFrom.createdAt)}
              </div>
            )}

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

        {!sharedView && history.length > 0 && (
          <section className="section no-print">
            <div className="section-head">
              <span className="section-title">Prior investigations</span>
              <span className="mono" style={{ fontSize: 11, color: 'var(--text-subtle)' }}>
                {history.length} saved
              </span>
            </div>
            <div className="card">
              <div className="history-grid history-head">
                <span>Company</span>
                <span className="history-num">Revenue</span>
                <span>Confidence</span>
                <span className="history-time">Time</span>
                <span />
              </div>
              {history.map((h) => (
                <HistoryRow
                  key={h.id}
                  item={h}
                  active={loadedFrom?.id === h.id}
                  onOpen={() => openFromHistory(h.id)}
                  onDelete={() => deleteFromHistory(h.id)}
                />
              ))}
            </div>
          </section>
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
        <button className="btn btn-sm" onClick={() => generatePDF(result)}>↓ PDF</button>
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

          {/* Strategic control per layer + non-warning notes (under tree on desktop) */}
          <StrategicControlSection tree={tree} />

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
  const variant = recon.circular || ratio > 1.5 || ratio < 0.5
    ? 'warning'
    : absDelta <= 20
    ? 'success'
    : 'info';
  const severityLabel = recon.circular
    ? 'circular — unverified'
    : absDelta <= 20 ? 'reconciles' : absDelta <= 50 ? 'soft mismatch' : 'large gap';

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
          {recon.circular && (
            <div style={{ fontSize: 12, marginTop: 6, color: 'var(--warning)' }}>
              ⚠ {recon.circular_siblings?.join(', ')} {recon.circular_siblings?.length > 1 ? 'were' : 'was'} estimated top-down as a share of {parentName}'s own total — summing back to that total is self-fulfilling. Treat the coverage as unverified, not confirmation.
            </div>
          )}
          {recon.consolidated_siblings && recon.consolidated_siblings.length > 0 && (
            <div style={{ fontSize: 12, marginTop: 4, opacity: 0.85 }}>
              {recon.consolidated_siblings.join(', ')} excluded from the sum (consolidated within the focal's reported segment).
            </div>
          )}
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

      {/* Likely causes of the gap (Bundle B) — only when a material gap was diagnosed */}
      {recon.explanation && Array.isArray(recon.explanation.likely_causes) && recon.explanation.likely_causes.length > 0 && (
        <div style={{ width: '100%' }}>
          <div
            style={{
              fontSize: 11, color: 'var(--text-muted)', letterSpacing: '0.04em',
              textTransform: 'uppercase', fontWeight: 600, marginBottom: 6,
            }}
          >
            Likely causes of the gap
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {recon.explanation.likely_causes.map((cause, i) => (
              <div key={i} style={{ fontSize: 12 }}>
                <div style={{ fontWeight: 600, color: 'var(--text)' }}>· {cause}</div>
                {recon.explanation.evidence_for_each?.[i] && (
                  <div style={{ color: 'var(--text-muted)', marginLeft: 12 }}>
                    {recon.explanation.evidence_for_each[i]}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

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
            {anchor?.source_url && isSafeUrl(anchor.source_url) && (
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

// ─── Strategic control (per layer) ───────────────────────────────────────────

function StrategicControlSection({ tree }) {
  // Surface control for every node that has it — including the parent's other
  // children (JVs/subsidiaries), not just the focal→root chain.
  const layers = collectControlLayers(tree);
  if (layers.length === 0) return null;

  return (
    <section className="section">
      <div className="section-head"><span className="section-title">Strategic control</span></div>
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {layers.map(({ node, isFocal, under }, i) => (
          <StrategicControlLayer key={keyOf(node) || i} node={node} isFocal={isFocal} under={under} />
        ))}
      </div>
    </section>
  );
}

function StrategicControlLayer({ node, isFocal, under }) {
  const items = node.strategic_control || [];
  const [open, setOpen] = useState(isFocal);
  if (items.length === 0 && !node.strategic_control_note) return null;
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 10px', background: 'var(--bg-elevated)', border: 'none',
          cursor: 'pointer', textAlign: 'left', color: 'var(--text)',
        }}
      >
        <span style={{ color: 'var(--text-subtle)', fontSize: 11 }}>{open ? '▾' : '▸'}</span>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{node.company}</span>
        {isFocal && <span className="chip chip-accent">focal</span>}
        {under && <span className="chip" style={{ fontSize: 10 }}>under {under}</span>}
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-subtle)' }}>
          {items.length > 0 ? `${items.length} relationship${items.length === 1 ? '' : 's'}` : 'no data'}
        </span>
      </button>
      {open && (
        <div style={{ padding: '4px 10px 8px' }}>
          {items.length === 0 ? (
            <div style={{ fontSize: 12, fontStyle: 'italic', color: 'var(--text-muted)', padding: '6px 0' }}>
              {node.strategic_control_note || 'no_data_found'}
            </div>
          ) : (
            items.map((s, i) => (
              <div key={i} className="strategic-item">
                <div className="strategic-head">
                  <span className="strategic-rel">{s.role_description || s.relationship}</span>
                  <span className="strategic-entity">{s.entity}</span>
                </div>
                {(s.evidence || s.details) && <div className="strategic-details">{s.evidence || s.details}</div>}
                {s.source_url && isSafeUrl(s.source_url) && (
                  <div className="strategic-source">
                    <a href={s.source_url} target="_blank" rel="noopener noreferrer">{s.source_url}</a>
                  </div>
                )}
              </div>
            ))
          )}
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
      {(() => {
        const immediate = parents[parents.length - 1];
        const units = (immediate?.children || []).filter((c) => keyOf(c) !== keyOf(tree));
        return units.length > 0 ? (
          <>
            <div className="tree-section-label">Units under {immediate.company}</div>
            <div className="tree-grid">
              {units.map((u, i) => (
                <TreeNode key={`u${i}`} node={u} role="subsidiary" selectedKey={selectedKey} onSelect={onSelect} />
              ))}
            </div>
          </>
        ) : null;
      })()}
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

// Derived status chip (F11: label computed from presence flags, never captured).
// active → no chip; legacy → warning; discontinued → danger; unknown → neutral.
function StatusBadge({ node }) {
  const { label } = node._derived_status || deriveStatus(node);
  if (label === 'active') return null;
  const cls = label === 'discontinued' ? 'chip-danger' : label === 'legacy' ? 'chip-warning' : '';
  return <span className={`chip ${cls}`}>{label}</span>;
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
          {node.category && <span className="chip">{node.category}</span>}
          {node.terminal_layer === 'private_equity' && <span className="chip chip-warning">PE</span>}
          <StatusBadge node={node} />
          {(node._divestiture || deriveDivestiture(node)) && <span className="chip chip-warning">divesting</span>}
        </div>
      </div>
      <div className={`tree-node-rev ${rev && rev.central > 0 ? '' : 'empty'}`}>
        {rev && rev.central > 0 ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span className={`confidence-dot confidence-${rev.confidence || 'unknown'}`} />
            {formatUSD(rev.central)}
          </span>
        ) : '—'}
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
        {node.category && <span className="chip">{node.category}</span>}
        <StatusBadge node={node} />
        {rev && rev.central > 0 && (
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

function HistoryRow({ item, active, onOpen, onDelete }) {
  return (
    <div
      className={`history-grid history-row${active ? ' active' : ''}`}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <span className="history-company">
        {item.focal_company || item.brand}
        {item.hint && (
          <span className="mono" style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-subtle)' }}>
            {item.hint}
          </span>
        )}
      </span>
      <span className="history-num">
        {item.central != null ? formatUSD(item.central) : '—'}
      </span>
      <span>
        {item.confidence ? (
          <span className={`chip confidence-${item.confidence}`}>{item.confidence}</span>
        ) : null}
      </span>
      <span className="history-time">{formatRelativeTime(item.createdAt)}</span>
      <button
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        title="Delete"
        className="icon-btn"
        style={{
          background: 'transparent',
          border: 'none',
          color: 'var(--text-subtle)',
          cursor: 'pointer',
          fontSize: 16,
          padding: '4px 8px',
        }}
      >
        ×
      </button>
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

  // Other units under the immediate parent (e.g. a JV/subsidiary), placed to the
  // right of the parent so their ownership split isn't lost.
  if (parents.length > 0) {
    const immediate = parents[parents.length - 1];
    const units = (immediate.children || []).filter((c) => keyOf(c) !== keyOf(tree));
    units.forEach((node, i) => {
      const id = `pc${i}`;
      nodes.push({
        id,
        type: 'entity',
        position: { x: (i + 1.5) * GAP_X, y: (parents.length - 1) * GAP_Y },
        data: { node, role: 'subsidiary', selected: keyOf(node) === selectedKey, onSelect },
      });
      edges.push({ id: `epc_${id}`, source: `p${parents.length - 1}`, target: id });
    });
  }

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
        {node.category && <span className="chip">{node.category}</span>}
        {node.terminal_layer === 'private_equity' && <span className="chip chip-warning">PE-owned</span>}
        {node.standalone && <span className="chip chip-accent">standalone</span>}
        <StatusBadge node={node} />
      </div>

      {node.acquisition?.acquired_by && (
        <div style={{ marginTop: 12, fontSize: 13, color: 'var(--text-muted)' }}>
          Acquired by <strong style={{ color: 'var(--text)' }}>{node.acquisition.acquired_by}</strong>
          {node.acquisition.year ? ` · ${node.acquisition.year}` : ''}
          {node.acquisition.source_url && isSafeUrl(node.acquisition.source_url) && (
            <> · <a href={node.acquisition.source_url} target="_blank" rel="noopener noreferrer">source</a></>
          )}
        </div>
      )}

      {node.pending_acquisition?.acquirer && (
        <div style={{ marginTop: 12, padding: '8px 10px', border: '1px solid var(--warning-border, #c79a3b)', borderRadius: 6, background: 'var(--warning-soft, rgba(199,154,59,0.08))', fontSize: 13 }}>
          <div style={{ fontWeight: 600, color: 'var(--text)' }}>
            ⏳ Pending acquisition by {node.pending_acquisition.acquirer}
          </div>
          <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>
            {node.pending_acquisition.announced_date && <>announced {node.pending_acquisition.announced_date}</>}
            {node.pending_acquisition.expected_close_date && <> · expected close {node.pending_acquisition.expected_close_date}</>}
            {node.pending_acquisition.regulatory_status && <> · {node.pending_acquisition.regulatory_status}</>}
            {node.pending_acquisition.source_url && isSafeUrl(node.pending_acquisition.source_url) && (
              <> · <a href={node.pending_acquisition.source_url} target="_blank" rel="noopener noreferrer">source</a></>
            )}
          </div>
          <div style={{ marginTop: 4, fontStyle: 'italic', color: 'var(--text-muted)' }}>
            Parent & siblings shown reflect the current legal owner — not the post-close acquirer.
          </div>
          {Array.isArray(node.future_cousins_post_close) && node.future_cousins_post_close.length > 0 && (
            <div style={{ marginTop: 6, color: 'var(--text-muted)' }}>
              Future cousins post-close: {node.future_cousins_post_close.map((c) => c.company).filter(Boolean).join(', ')}
            </div>
          )}
        </div>
      )}

      {(() => { const d = node._divestiture || deriveDivestiture(node); return d && d.divesting ? (
        <div style={{ marginTop: 12, padding: '8px 10px', border: '1px solid var(--warning-border, #c79a3b)', borderRadius: 6, background: 'var(--warning-soft, rgba(199,154,59,0.08))', fontSize: 13 }}>
          <div style={{ fontWeight: 600, color: 'var(--text)' }}>↗ Pending divestiture</div>
          {d.detail && <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>{d.detail}</div>}
        </div>
      ) : null; })()}

      {rev && rev.central > 0 ? (
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
          {deriveRevenueStatus(node).reason && (
            <div style={{ marginTop: 6, fontStyle: 'italic' }}>{deriveRevenueStatus(node).reason}</div>
          )}
        </div>
      )}

      {error && (
        <div className="banner banner-warning" style={{ marginTop: 12 }}>
          <span className="banner-icon">⚠</span>
          <span>Revenue agent error: {error}</span>
        </div>
      )}

      {reasoning && (
        <div className="reasoning-text">
          {reasoning}
        </div>
      )}

      {(node.last_mention_date || node.signals_found_count != null || revenueResult?.signals_found_count != null) && (
        <div style={{ marginTop: 12, fontSize: 11, color: 'var(--text-subtle)', display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          {node.last_mention_date && <span>last referenced · {node.last_mention_date}</span>}
          {(node.signals_found_count ?? revenueResult?.signals_found_count) != null && (
            <span>signals · {node.signals_found_count ?? revenueResult?.signals_found_count}/{node.signals_attempted ?? revenueResult?.signals_attempted ?? '?'} found</span>
          )}
        </div>
      )}

      {signals.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <div className="card-title">Signals captured</div>
          <div className="signal-list">
            {signals.map((s, i) => (
              <div key={i} className="signal-row">
                <div className="signal-type">{s.type}</div>
                <div>
                  <div className="signal-label">{s.label}</div>
                  <div className="signal-value">{s.value}</div>
                  {s.source && <div className="signal-source">via {s.source}</div>}
                </div>
                <div className={`signal-weight signal-weight-${String(s.weight || '').toLowerCase()}`}>{s.weight}</div>
              </div>
            ))}
          </div>
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
  // Ancestors' other children (e.g. a JV/subsidiary under the parent) so they're selectable.
  chain.forEach((anc) => (anc.children || []).forEach(add));
  add(tree);
  (tree.siblings || []).forEach(add);
  (tree.children || []).forEach(add);
  return out;
}

// Generate professional PDF report. Vector-text layout (crisp at any zoom) with a
// designed cover band, section headers, colored pills, bordered/zebra tables, an
// embedded high-res snapshot of the on-screen ownership map, page numbers, and the
// full F11 dataset (derived status + category, reconciliation explanation, per-layer
// strategic control). Forces a direct download via a Blob + anchor.
async function generatePDF(result) {
  if (!result || !result.ownership_tree) return;

  const tree = result.ownership_tree;
  const positioning = result.positioning_analysis || {};
  const recon = positioning.reconciliation;
  const focal = tree.company;
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

  // Palette (light, print-friendly) mirroring the app's design tokens.
  const C = {
    accent: [8, 145, 178], accentHover: [14, 116, 144], accentSoft: [236, 254, 255],
    text: [24, 24, 27], muted: [82, 82, 91], subtle: [161, 161, 170],
    border: [229, 231, 235], surface: [247, 247, 248],
    activeFg: [21, 128, 61], activeBg: [220, 252, 231],
    warning: [180, 83, 9], warnBg: [255, 251, 235],
    danger: [185, 28, 28], dangerBg: [254, 242, 242],
    white: [255, 255, 255], ink: [17, 17, 20], tint: [224, 247, 250],
  };

  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const margin = 16;
  const contentW = pageW - 2 * margin;
  const bottomLimit = pageH - 16;
  let y = margin;

  const font = (size, style = 'normal') => { pdf.setFontSize(size); pdf.setFont('helvetica', style); };
  const addPage = () => { pdf.addPage(); y = margin; };
  const ensure = (h) => { if (y + h > bottomLimit) addPage(); };

  // jsPDF's standard font uses WinAnsi (cp1252); glyphs outside it (e.g. ★, emoji,
  // arrows) render as garbage. Map the common star marker and strip pictographs.
  const sanitize = (s) => String(s ?? '')
    .replace(/[★☆]/g, '*')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{27BF}\u{2B00}-\u{2BFF}️]/gu, '');
  // Trim a string to fit a pixel/mm width at the CURRENT font, appending an ellipsis.
  const truncateToWidth = (str, w) => {
    let s = sanitize(str);
    if (pdf.getTextWidth(s) <= w) return s;
    while (s.length > 1 && pdf.getTextWidth(s + '...') > w) s = s.slice(0, -1);
    return s.replace(/[\s,]+$/, '') + '...';
  };

  const text = (str, opts = {}) => {
    const { size = 10, style = 'normal', color = C.text, x = margin, maxW = contentW, gap = 1.8 } = opts;
    font(size, style); pdf.setTextColor(...color);
    const lines = pdf.splitTextToSize(sanitize(str), maxW);
    const lineH = size * 0.42;
    lines.forEach((ln) => {
      ensure(lineH);
      pdf.text(ln, x, y, { baseline: 'top' });
      y += lineH;
    });
    y += gap;
  };

  const section = (title, reserve = 24) => {
    // Reserve space for the header + first content so a header never lands alone
    // at the bottom of a page (keep-with-next).
    ensure(reserve);
    y += 3;
    pdf.setFillColor(...C.accent);
    pdf.rect(margin, y, 2.2, 5.4, 'F');
    font(12, 'bold'); pdf.setTextColor(...C.ink);
    pdf.text(sanitize(title.toUpperCase()), margin + 5, y + 0.3, { baseline: 'top' });
    y += 7.5;
    pdf.setDrawColor(...C.border); pdf.setLineWidth(0.3);
    pdf.line(margin, y, margin + contentW, y);
    y += 4;
  };

  // Inline pill; returns the width consumed so callers can chain pills on one row.
  const pill = (label, x, yy, fill, fg) => {
    font(7.5, 'bold');
    const lbl = sanitize(label);
    const tw = pdf.getTextWidth(lbl);
    const padX = 2.2, h = 4.8, w = tw + padX * 2;
    pdf.setFillColor(...fill);
    pdf.roundedRect(x, yy, w, h, 1.2, 1.2, 'F');
    pdf.setTextColor(...fg);
    pdf.text(lbl, x + padX, yy + h / 2 + 0.15, { baseline: 'middle' });
    return w;
  };

  const statusColors = (label) =>
    label === 'active' ? [C.activeBg, C.activeFg]
      : label === 'legacy' ? [C.warnBg, C.warning]
        : label === 'discontinued' ? [C.dangerBg, C.danger]
          : [C.surface, C.muted];

  const table = (headers, rows, widths) => {
    const rowH = 7, headH = 8;
    ensure(headH + rows.length * rowH + 4);
    const top = y;
    let x = margin;
    pdf.setFillColor(...C.ink);
    pdf.rect(margin, y, contentW, headH, 'F');
    font(8.5, 'bold'); pdf.setTextColor(...C.white);
    headers.forEach((h, i) => { pdf.text(String(h), x + 2, y + headH / 2 + 0.2, { baseline: 'middle' }); x += widths[i]; });
    y += headH;
    rows.forEach((row, ri) => {
      if (ri % 2 === 1) { pdf.setFillColor(...C.surface); pdf.rect(margin, y, contentW, rowH, 'F'); }
      x = margin;
      row.forEach((cell, i) => {
        const val = cell && typeof cell === 'object' ? cell.text : cell;
        const color = cell && typeof cell === 'object' && cell.color ? cell.color : C.text;
        const style = cell && typeof cell === 'object' && cell.bold ? 'bold' : 'normal';
        font(8.5, style); pdf.setTextColor(...color);
        const line = truncateToWidth(val, widths[i] - 4);
        pdf.text(line, x + 2, y + rowH / 2 + 0.2, { baseline: 'middle' });
        x += widths[i];
      });
      y += rowH;
    });
    pdf.setDrawColor(...C.border); pdf.setLineWidth(0.2);
    pdf.rect(margin, top, contentW, headH + rows.length * rowH);
    y += 4;
  };

  // ─── Cover band (page 1) ───
  pdf.setFillColor(...C.accent);
  pdf.rect(0, 0, pageW, 34, 'F');
  font(22, 'bold'); pdf.setTextColor(...C.white);
  pdf.text(focal, margin, 14, { baseline: 'middle' });
  font(10.5, 'normal'); pdf.setTextColor(...C.tint);
  pdf.text('Ownership & Revenue Analysis', margin, 23, { baseline: 'middle' });
  font(8.5, 'normal');
  pdf.text(`${dateStr} · ${timeStr}`, margin, 29, { baseline: 'middle' });
  y = 42;

  // ─── Executive Summary ───
  section('Executive Summary');
  const revEst = tree.revenue_estimate || {};
  text(
    `${focal} is a ${tree.layer || 'brand'}${tree.parent ? ` under ${tree.parent.company}` : ' (standalone)'} with an estimated annual revenue of ${formatUSD(revEst.low)}–${formatUSD(revEst.high)} (central ${formatUSD(revEst.central)}).`,
    { size: 10.5, color: C.muted, gap: 3 }
  );
  {
    ensure(6);
    let px = margin; const py = y;
    px += pill(`confidence: ${revEst.confidence || 'unknown'}`, px, py, C.surface, C.muted) + 2;
    const st = deriveStatus(tree).label;
    const [sbg, sfg] = statusColors(st);
    px += pill(st, px, py, sbg, sfg) + 2;
    if (tree.category) px += pill(tree.category, px, py, C.accentSoft, C.accentHover) + 2;
    if (tree.terminal_layer === 'private_equity') px += pill('PE-owned', px, py, C.warnBg, C.warning) + 2;
    y = py + 8;
  }

  // ─── Ownership Map (native vector diagram) ───
  const chain = [];
  let cp = tree.parent;
  while (cp) { chain.unshift(cp); cp = cp.parent; }
  const siblings = tree.siblings || [];

  const drawEntityBox = (x, yy, w, h, node, focal = false) => {
    pdf.setFillColor(...(focal ? C.accentSoft : C.white));
    pdf.setDrawColor(...(focal ? C.accent : C.border));
    pdf.setLineWidth(focal ? 0.5 : 0.2);
    pdf.roundedRect(x, yy, w, h, 1.6, 1.6, 'FD');
    font(8.5, 'bold'); pdf.setTextColor(...C.ink);
    pdf.text(truncateToWidth(node.company, w - 6), x + 3, yy + 4.6, { baseline: 'middle' });
    const rev = node.revenue_estimate;
    font(8, 'normal'); pdf.setTextColor(...C.muted);
    pdf.text(rev && rev.central > 0 ? formatUSD(rev.central) : '—', x + 3, yy + 8.8, { baseline: 'middle' });
    const st = deriveStatus(node).label;
    if (st !== 'active') {
      const [bg, fg] = statusColors(st);
      pill(st, x + 3, yy + h - 5.4, bg, fg);
    } else if (node.category) {
      font(6.6, 'normal'); pdf.setTextColor(...C.subtle);
      pdf.text(truncateToWidth(node.category, w - 6), x + 3, yy + h - 3.2, { baseline: 'middle' });
    }
    if (node._divestiture || deriveDivestiture(node)) {
      font(7.5, 'bold');
      const dw = pdf.getTextWidth('divesting') + 4.4;
      pill('divesting', x + w - 3 - dw, yy + 2, C.warnBg, C.warning);
    }
  };

  const drawGrid = (items) => {
    const cols = 3, gap = 4;
    const cardW = (contentW - (cols - 1) * gap) / cols;
    const cardH = 17;
    for (let i = 0; i < items.length;) {
      ensure(cardH + gap);
      const rowY = y;
      for (let c = 0; c < cols && i < items.length; c++, i++) {
        drawEntityBox(margin + c * (cardW + gap), rowY, cardW, cardH, items[i], false);
      }
      y = rowY + cardH + gap;
    }
  };

  section('Ownership Map');
  const boxH = 16, colW = 96, colX = margin + (contentW - colW) / 2;
  const drawCenter = (node, focal, connectDown) => {
    ensure(boxH + (connectDown ? 6 : 2));
    drawEntityBox(colX, y, colW, boxH, node, focal);
    y += boxH;
    if (connectDown) {
      pdf.setDrawColor(...C.border); pdf.setLineWidth(0.4);
      pdf.line(colX + colW / 2, y, colX + colW / 2, y + 5);
      y += 5;
    }
  };
  chain.forEach((n) => drawCenter(n, false, true));
  drawCenter(tree, true, siblings.length > 0);

  if (siblings.length > 0) {
    y += 1;
    text('Siblings', { size: 8.5, style: 'bold', color: C.muted, gap: 2 });
    drawGrid(siblings);
  }
  if ((tree.children || []).length > 0) {
    y += 1;
    text('Children', { size: 8.5, style: 'bold', color: C.muted, gap: 2 });
    drawGrid(tree.children);
  }
  const immediateParent = chain[chain.length - 1];
  const parentUnits = (immediateParent?.children || []).filter((c) => keyOf(c) !== keyOf(tree));
  if (parentUnits.length > 0) {
    y += 1;
    text(`Units under ${immediateParent.company}`, { size: 8.5, style: 'bold', color: C.muted, gap: 2 });
    drawGrid(parentUnits);
  }
  y += 2;

  // ─── Revenue Breakdown ───
  const breakdownRows = [tree, ...siblings].map((n) => {
    const st = deriveStatus(n).label;
    const [, fg] = statusColors(st);
    const rev = n.revenue_estimate;
    return [
      { text: n.company, bold: n === tree },
      n.category || '—',
      (rev && rev.central > 0) ? formatUSD(rev.central) : '—',
      (rev && rev.confidence) || '—',
      { text: st, color: fg, bold: true },
    ];
  });
  if (breakdownRows.length > 0) {
    section('Revenue Breakdown');
    table(['Company', 'Category', 'Revenue', 'Conf.', 'Status'], breakdownRows, [46, 48, 30, 22, 32]);
  }

  // ─── Positioning Analysis ───
  if (positioning.focal_vs_parent_ratio || siblings.length > 0 || positioning.growth_signals) {
    section('Positioning Analysis');
    if (positioning.focal_vs_parent_ratio) text(`Parent ratio: ${positioning.focal_vs_parent_ratio}`, { size: 9.5, color: C.text, gap: 1 });
    if (siblings.length > 0) {
      // Build the ranking from data (avoids the ★ glyph and right-margin overflow
      // of the raw positioning string).
      const ranked = [{ company: tree.company, central: tree.revenue_estimate?.central || 0 },
        ...siblings.map((s) => ({ company: s.company, central: s.revenue_estimate?.central || 0 }))]
        .sort((a, b) => b.central - a.central);
      const focalRank = ranked.findIndex((r) => r.company === tree.company) + 1;
      const list = ranked.map((r, i) => `#${i + 1} ${r.company} ${r.central > 0 ? formatUSD(r.central) : '—'}`).join('  ·  ');
      text(`Sibling ranking: focal is #${focalRank} of ${ranked.length} by revenue.`, { size: 9.5, color: C.text, gap: 1 });
      text(list, { size: 9, color: C.muted });
    }
    if (positioning.growth_signals) text(`Growth signals: ${positioning.growth_signals}`, { size: 9, color: C.muted });
  }

  // ─── Reconciliation (+ explanation) ───
  if (recon) {
    section('Reconciliation');
    text(
      `Focal + siblings ${formatUSD(recon.sum_children_central)} vs ${formatUSD(recon.parent_benchmark)} (${recon.parent_benchmark_source}). Coverage ${(recon.ratio * 100).toFixed(0)}%, delta ${recon.pct_delta > 0 ? '+' : ''}${recon.pct_delta}%.`,
      { size: 9.5, color: C.text, gap: 2.5 }
    );
    // Coverage bar — center tick at 1.0× (parent).
    ensure(11);
    const barW = contentW, barH = 4.5, btop = y;
    pdf.setFillColor(...C.surface); pdf.rect(margin, btop, barW, barH, 'F');
    const clamped = Math.max(0, Math.min(2, recon.ratio));
    const col = (recon.ratio > 1.5 || recon.ratio < 0.5) ? C.warning : C.accent;
    pdf.setFillColor(...col); pdf.rect(margin, btop, (clamped / 2) * barW, barH, 'F');
    pdf.setDrawColor(...C.ink); pdf.setLineWidth(0.3); pdf.line(margin + barW / 2, btop - 1, margin + barW / 2, btop + barH + 1);
    pdf.setDrawColor(...C.border); pdf.setLineWidth(0.2); pdf.rect(margin, btop, barW, barH);
    y += barH + 2;
    font(7, 'normal'); pdf.setTextColor(...C.subtle);
    pdf.text('0×', margin, y, { baseline: 'top' });
    pdf.text('1.0× parent', margin + barW / 2, y, { align: 'center', baseline: 'top' });
    pdf.text('2.0×+', margin + barW, y, { align: 'right', baseline: 'top' });
    y += 6;
    if (recon.circular && recon.circular_siblings?.length) {
      text(`Caveat: ${recon.circular_siblings.join(', ')} ${recon.circular_siblings.length > 1 ? 'were' : 'was'} estimated top-down as a share of the parent's own total — summing back to that total is self-fulfilling. Treat the coverage as unverified, not confirmation.`,
        { size: 8.5, style: 'italic', color: C.warning, maxW: contentW, gap: 2 });
    }
    if (recon.consolidated_siblings && recon.consolidated_siblings.length) {
      text(`${recon.consolidated_siblings.join(', ')} consolidated within the focal's reported segment — excluded from the sum to avoid double-counting.`,
        { size: 8.5, style: 'italic', color: C.muted, maxW: contentW, gap: 2 });
    }
    if (recon.explanation && Array.isArray(recon.explanation.likely_causes)) {
      text('Likely causes of the gap', { size: 9.5, style: 'bold', color: C.ink, gap: 1.5 });
      recon.explanation.likely_causes.forEach((cause, i) => {
        text(`• ${cause}`, { size: 9, style: 'bold', color: C.text, x: margin + 2, maxW: contentW - 4, gap: 0.6 });
        const ev = recon.explanation.evidence_for_each?.[i];
        if (ev) text(ev, { size: 8.5, color: C.muted, x: margin + 6, maxW: contentW - 8, gap: 1.6 });
      });
    }
  }

  // ─── Strategic Control (every node that has it, incl. parent's JVs/subsidiaries) ───
  const scLayers = collectControlLayers(tree);
  if (scLayers.length > 0) {
    section('Strategic Control');
    scLayers.forEach(({ node, under }) => {
      const items = node.strategic_control || [];
      if (items.length === 0 && !node.strategic_control_note) return;
      ensure(7);
      font(10, 'bold'); pdf.setTextColor(...C.ink);
      pdf.text(truncateToWidth(node.company, contentW - 50), margin, y + 0.3, { baseline: 'top' });
      let lx = margin + pdf.getTextWidth(sanitize(node.company)) + 3;
      if (node.layer) lx += pill(node.layer, lx, y - 0.2, C.surface, C.muted) + 2;
      if (under) pill(`under ${under}`, lx, y - 0.2, C.accentSoft, C.accentHover);
      y += 6;
      if (items.length === 0) {
        text(node.strategic_control_note || 'no_data_found', { size: 8.5, style: 'italic', color: C.subtle, x: margin + 3 });
      } else {
        items.slice(0, 12).forEach((s) => {
          text(`${s.entity} — ${s.role_description || s.relationship || ''}`, { size: 9, style: 'bold', color: C.text, x: margin + 3, maxW: contentW - 6, gap: 0.6 });
          const ev = s.evidence || s.details;
          if (ev) text(ev, { size: 8.5, color: C.muted, x: margin + 6, maxW: contentW - 9, gap: 1.4 });
        });
      }
      y += 1.5;
    });
  }

  // ─── Footer + page numbers (all pages) ───
  const pageCount = pdf.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    pdf.setPage(i);
    pdf.setDrawColor(...C.border); pdf.setLineWidth(0.2);
    pdf.line(margin, pageH - 11, pageW - margin, pageH - 11);
    font(7.5, 'normal'); pdf.setTextColor(...C.subtle);
    pdf.text('Generated by Ownership & Revenue Agent · Confidential', margin, pageH - 7, { baseline: 'middle' });
    pdf.text(`${i} / ${pageCount}`, pageW - margin, pageH - 7, { align: 'right', baseline: 'middle' });
  }

  // Force a direct file download via a Blob + anchor, bypassing jsPDF's save()
  // fallback that can open the browser PDF viewer / print dialog instead.
  const filename = `${focal.replace(/\s+/g, '-')}-ownership-report.pdf`;
  try {
    const blob = pdf.output('blob');
    const url = URL.createObjectURL(blob);
    const doc = (window.top && window.top.document) || window.document;
    const a = doc.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    doc.body.appendChild(a);
    a.click();
    setTimeout(() => {
      try { doc.body.removeChild(a); } catch (_) {}
      URL.revokeObjectURL(url);
    }, 1000);
  } catch (_) {
    pdf.save(filename);
  }
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
