import React, { useState, useEffect, useMemo, useRef } from 'react';
import ReactFlow, { Background, Controls, MiniMap, Handle, Position } from 'reactflow';
import 'reactflow/dist/style.css';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';
import {
  synthesize,
  collectEntities,
  formatUSD,
  keyOf,
  safeExtractJSON,
  deriveStatus,
  deriveRevenueStatus,
  normalizeChain,
  deriveDivestiture,
  collectControlLayers,
  needsSiblingBackfill,
  mergeSiblings,
  mergeCousins,
  createRevenueCache,
} from './synth.js';
import { isConsumerSector, sanitizeForPdf } from './brief.js';

// X.03 deterministic synthesis seed (Task #58): a stable seed derived from
// (focal, parent, calendar day) lets repeated runs within the same UTC day
// return identical revenue and a single intra-session cache key. The cache
// itself is module-scoped so back-to-back runs on the same focal reuse the
// prior revenue rather than re-rolling it.
function buildSynthesisSeed(focalName, parentName) {
  const day = new Date().toISOString().slice(0, 10);
  const focal = String(focalName || '').toLowerCase().trim();
  const parent = String(parentName || '').toLowerCase().trim();
  return `${focal}|${parent}|${day}`;
}
const __revenueCache = createRevenueCache();

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

Step 5 — Siblings (SEGMENT-FILTERED — read carefully). Siblings are brands at the SAME layer of the CURRENT LEGAL PARENT **and inside the same business segment / division / operating label as the focal**. They are NOT "every brand the parent owns".

SEGMENT-FILTER RULE (Bug #3 regression — applies to ALL multi-division aggregators, e.g. LVMH, P&G, Unilever, Inditex, Kering, Estée Lauder, Richemont, AB InBev, Kellanova, Diageo, Nestlé):
  a) First, identify the focal's segment/division/label within the parent's structure. "Segment" here means ANY internal grouping — a 10-K reporting segment, a corporate division, OR an OPERATING LABEL / business unit that the parent uses even when it is NOT a separate legal entity and does NOT appear in the 10-K. Sources, in order: the parent's IR / "our brands" / "our studios" / "our labels" page (which usually groups by division/label), the parent's latest 10-K / 20-F segment breakdown (use parent_anchor.segments[].contains_focal when it exists downstream), the Wikipedia "Subsidiaries" / "Brands" / "Divisions" section, or a reputable financial summary. E.g. Tiffany & Co. → LVMH "Watches & Jewelry"; Tide → P&G "Fabric & Home Care" (laundry sub-segment); Call of Duty → Activision Blizzard label "Activision" (the three operating labels Activision / Blizzard / King are NOT in the 10-K but ARE the right division cut — siblings = other Activision-label franchises like Crash Bandicoot, Spyro, Tony Hawk's; World of Warcraft/Overwatch/Diablo are Blizzard-label cousins, Candy Crush is a King-label cousin); Zara → Inditex (single-segment, so all brands are siblings).
  b) Populate "siblings" with ONLY brands that share that segment (Tiffany siblings = Bulgari, Chaumet, Fred, Repossi, TAG Heuer, Hublot — NOT Louis Vuitton, Dior, Givenchy, Fendi). For Tide: siblings = Ariel, Gain — NOT Downy/Dawn/Febreze/Mr. Clean.
  c) Brands of OTHER segments of the same parent are NOT siblings. Place them in the NEW field "intra_parent_cousins" with their own segment in "via_division" (e.g. {"company":"Louis Vuitton","via_division":"Fashion & Leather Goods", ...}). These are real cousins inside the same family but a different business line.
  d) Capture the focal's own division in "focal_segment" (top-level field) so the UI/reconciliation can label it.
  e) If the parent has NO declared segments (private with no disclosure, or genuinely single-segment), keep ALL portfolio brands as siblings and set "focal_segment": null. Note this in "notes".

MEGA-AGGREGATOR HEURISTIC: If your initial brand-list for siblings would exceed 10 entries, that is a strong signal you are missing a segment cut. STOP, run an extra search for the parent's segment / division / label structure ("[parent] business segments", "[parent] divisions", "[parent] operating labels", "[parent] studios"), apply the filter, and report in "notes" that you segmented (e.g. "Segmented LVMH portfolio by division; siblings restricted to Watches & Jewelry." or "Split Activision Blizzard by operating label; siblings restricted to the Activision label, Blizzard/King brands placed as cousins.").

The "siblings" field is ALWAYS current_siblings_under_current_parent_AND_same_segment — never the acquirer's portfolio while a deal is pending (those go in "future_cousins_post_close" as before).

For EACH sibling AND each intra_parent_cousin capture: a free-text "category" describing what it sells (e.g. "premium hybrid mattress", "rugs", "B2B billing SaaS" — whatever the sources say; "" if unknown), and presence signals: in_current_sources (true if it appears in a PRIMARY/current source), in_historical_sources (true if it appears in a SECONDARY/older source), and last_mention_date (most recent date you saw it referenced, or null). Do NOT label a sibling active/legacy/discontinued — only report the raw flags and date; classification happens downstream.

REVENUE MODEL (Issue #4-bis — do NOT double-count non-revenue brands). For EACH sibling and intra_parent_cousin, set "revenue_model":
  - "direct_revenue" — generates its OWN standalone revenue (Office, Pixel hardware, LinkedIn subscriptions, Tide, most consumer brands). This is the DEFAULT when unsure.
  - "distribution_channel" — a FREE product / OS / browser that is a vehicle for the parent's revenue, not an independent P&L line (Google Chrome, Android). Its economics are the parent's (e.g. Search ad revenue), so it must NOT receive a standalone revenue number — listing Chrome at "$120B" double-counts Search ads.
  - "sub_product_line" — a separable slice of a LARGER brand (YouTube Premium vs YouTube advertising; Prime Video within Amazon Prime).
Classify free distribution vehicles as "distribution_channel" so downstream skips estimating a fictional standalone figure for them.

SOURCE PRIORITIZATION (apply when listing siblings and children):
PRIMARY (current state, last ~24 months): the aggregator's official brand portfolio / "our brands" page, press releases dated within the last 24 months, and communications about the most recent acquisition. These reflect the CURRENT lineup.
SECONDARY (historical, may be stale): FTC/SEC filings, press releases older than 2 years, Wikipedia/Wikidata.
RULE: a brand present in a PRIMARY source but ABSENT from SECONDARY ones is CURRENT, not invalid — capture it (e.g. a brand launched in the last 1–2 years). NEVER drop a brand solely because older/secondary sources omit it.

Step 6 — Children. If the input is a parent, list direct subsidiaries.

Step 6.5 — Chain normalization (legal_name vs brand_name). Before emitting JSON, walk the parent chain and for EACH consecutive parent↔child pair ask: are these actually the SAME legal entity captured under two name forms (e.g. "ByteDance Ltd." as root and "ByteDance" as parent)? COLLAPSE the pair into ONE layer when they share 2+ of these identifiers:
  (a) canonical domain (after stripping www/protocol),
  (b) ticker symbol,
  (c) legal-entity reference (CIK, LEI, registration ID, or SEC filer ID),
  (d) the triple {headquarters, founders, founding_date} matching together.
When collapsing: keep the MORE FORMAL legal name as canonical ("X Ltd." > "X", "Y Corporation" > "Y"); union sources/signals/strategic_control; if revenues diverge, take the WIDEST unified range; note the collapse in "notes" ("Collapsed X and Y — shared <identifiers>").
DO NOT collapse when only the bare names match (modulo legal suffix) without 2+ identifier overlap — that is not enough evidence.
DO NOT collapse legitimately distinct layers:
  - Holding vs operating subsidiary with different UBO (e.g. Inditex ≠ Pontegadea Inversiones).
  - Holding vs operating subsidiary with distinct domains/tickers (e.g. Alphabet Inc. abc.xyz ≠ Google LLC google.com).
SPECIAL CASE — "X Holdings" / "X Group" paired with "X" (same root token, no other identifier overlap): do NOT auto-collapse. Keep both layers and add to "notes": "Review needed: <X Holdings> and <X> may be the same legal entity — verify.".
After this step, no two consecutive layers in the chain should be the same legal entity under different name forms.
Emit "legal_entity_reference" (CIK/LEI/registration ID) and "ticker" on each layer when known — these IDs are what makes the normalization auditable.

Step 6.6 — Co-owners (multi-owner / dual-class / steward-ownership). The "parent" slot is single-valued: it MUST be the owner that exercises voting control and/or consolidates the entity. When the focal has ADDITIONAL formal owners with their own economic or voting stake — not advisors, lenders, or governance influencers (those go in strategic_control) — capture them in the parallel "co_owners" array. Each co_owner is a real legal owner with a measurable stake.
Trigger this when ANY of the following applies, with clear evidence (foundation page, M&A doc, SEC filing, official IR disclosure):
  - STEWARD OWNERSHIP / SPLIT VOTING-vs-ECONOMIC: e.g. Patagonia → Patagonia Purpose Trust holds ~2% / 100% voting (parent, ownership_role:"voting_control"); Holdfast Collective holds ~98% / 0% voting (co_owner, ownership_role:"economic_beneficiary"). Bosch → Robert Bosch Stiftung 94% economic / 0% voting; Robert Bosch Industrietreuhand KG 0% economic / 93% voting.
  - JOINT VENTURE with two declared owners: e.g. Hulu pre-2023 → Disney 67% (parent), Comcast 33% (co_owner). Verizon/Vodafone JVs. Sony Music / SonyBMG era.
  - DUAL-CLASS PUBLIC STRUCTURE where a SEPARATE legal entity holds the controlling class (not just an individual — those go through UBO Step 7.5): e.g. NYT Class B holding company.
  - CONCENTRATED STRATEGIC BLOCS (Issue #2-bis): 2+ NAMED holders that EACH hold an explicit equity stake >10% and together form the control bloc — NOT passive index funds. E.g. Aston Martin Lagonda → Yew Tree Consortium ~33% (largest → parent), Public Investment Fund (PIF) ~20.5%, Mercedes-Benz ~20%, Geely ~17% (all co_owners). Saudi Aramco → PIF majority + minority free float. Capture each bloc as a co_owner with stake_pct and a one-line evidence string.
  - INDIVIDUAL DUAL-CLASS SUPER-VOTING (Issue #2-bis): when 1–3 individuals TOGETHER hold majority VOTING power via a super-voting share class. E.g. Alphabet → Larry Page ~27.4% voting + Sergey Brin ~25.3% voting (combined ~52.7% control via Class B); Meta → Mark Zuckerberg; Snap → Spiegel + Murphy. Promote the single largest as "parent" via UBO Step 7.5 and capture the OTHER controlling individual(s) as co_owners with voting_pct and entity_type:"individual". This OVERRIDES the "widely-held public" exclusion — Page+Brin are NOT dispersed holders.
On the parent itself, populate "ownership_role" — describe the role in FREE TEXT (e.g. "voting_control", "majority_economic", "joint_venture_partner", "controlling_holder"). On a single-owner standard subsidiary, ownership_role can be "sole_owner" or null.
DO NOT use co_owners for:
  - PASSIVE / DISPERSED index or institutional holders with no control bloc (BlackRock, Vanguard, State Street holding ordinary index positions) — those are strategic_control. This exclusion does NOT cover named, concentrated, strategically-active stakes (a sovereign fund's 20% block, a strategic partner's 20%, a founder's super-voting class) — those ARE co_owners per the triggers above.
  - Pending acquisitions — that goes in pending_acquisition.
  - A SINGLE founder/individual who is the sole controlling owner — promote via UBO Step 7.5 instead (but when 2+ individuals SHARE voting control, the largest is the UBO/parent and the rest are co_owners, per the super-voting trigger above).
Cap co_owners at 5 entries. Document each role transition in "notes" (e.g. "Holdfast Collective captured as economic_beneficiary co-owner; Purpose Trust kept as parent because it holds 100% voting power.").
For EACH co_owner capture: company, ownership_role (free text), stake_pct (economic %, 0-100), voting_pct (voting %, 0-100, may differ from economic), evidence (one sentence quote/paraphrase), entity_type ("trust"|"nonprofit"|"corporation"|"individual"|"government"|"family_group"), source_urls.

Step 6.7 — Prior joint-venture history (consolidated subsidiaries). When the focal (or its parent) is TODAY a wholly-consolidated subsidiary BUT was a declared joint venture with multiple owners within the LAST ~5 YEARS, capture that prior JV configuration in ONE plain "notes" sentence on the affected node (focal or parent). Trigger when evidence shows: (a) a prior JV/partnership ownership split, AND (b) a buyout/consolidation event within the last ~5 years that ended the JV (e.g. Hulu — Disney 67% / Comcast 33% JV consolidated in 2023 when Disney bought out NBCUniversal's 33% stake for ~$8.61B). The sentence MUST name the prior owners with their stakes and the consolidation year (e.g. "Prior joint venture: Disney 67% / Comcast (NBCUniversal) 33% — consolidated by Disney in 2023 via $8.61B buyout of NBCUniversal's stake."). Do NOT use co_owners for these historical owners — co_owners is for CURRENT formal owners only. Do NOT invent JV history without primary-source evidence (M&A press release, SEC filing, IR communication). Skip this step entirely when the JV ended more than ~5 years ago, or when the entity was always wholly-owned.

Acquisition price discipline (paired with Step 6.7): "acquisition.price_usd" is the FINAL consolidating deal value only — the single transaction that produced the current ownership state. Do NOT sum a historical aggregate of multiple deals (e.g. for Hulu, price_usd is Disney's ~$8.61B 2023 buyout of NBCUniversal's 33%, NOT $71B representing Disney's cumulative spend across the 2009 JV formation + 2019 21CF stake + 2023 final buyout). When the entity reached today's ownership through multiple historical transactions, capture ONLY the final consolidating deal here; describe the earlier transactions narratively in the Step 6.7 "notes" sentence.

Step 7 — Strategic control. Capture control/governance relationships that are NOT formal ownership: founders, the last pre-acquisition funding round, the current executive leader (CEO/President), board members, investors/VCs, PE backers, major shareholders. Include ONLY with clear evidence (funding press release, SEC 13D/13G, official board page, M&A announcement). Describe each relationship as a FREE-TEXT role_description (e.g. "lead Series B investor", "co-founder & CEO", "PE sponsor") — do NOT pick from a fixed list. POPULATE strategic_control for EVERY node in the chain (root, each parent, and the focal), not just the focal. Aggregator layers especially tend to have independent founders and prior funding rounds. For acquired companies, capture BOTH the historical pre-acquisition investors AND the current post-acquisition executives. If a layer genuinely has no evidenced control info, set strategic_control:[] and strategic_control_note:"no_data_found: <reason>".

Step 7.5 — UBO promotion (Ultimate Beneficial Owner as a chain node). The chain's "root" is normally the topmost legal entity. PROMOTE an additional layer above that legal entity — as its own node in the parent chain — when ANY of these four triggers fires with clear evidence:
  A. FAMILY OFFICE / HOLDING VEHICLE declared: a named family-controlled holding or office that owns the top operating entity (e.g. "Arnault Family Group" over LVMH, "Pontegadea Inversiones" over Inditex, "Walton Enterprises" over Walmart, "Cascade Investment" over a Gates holding). Use node_type:"individual" only when the UBO is literally a natural person; use node_type:"legal_entity" with ubo_type:"family_group" when the vehicle is an entity.
  B. INDIVIDUAL FOUNDER / SHAREHOLDER with material control: a natural person holding >20% equity OR >50% voting power in the top legal entity (e.g. Zhang Yiming in ByteDance Ltd., Mark Zuckerberg in Meta via Class B voting, Amancio Ortega in Inditex via Pontegadea, Warren Buffett in Berkshire Hathaway). Use node_type:"individual" and ubo_type:"individual".
  C. TRUST / FOUNDATION / NONPROFIT as declared owner (e.g. Robert Bosch Stiftung over Bosch, Tata Trusts over Tata Sons, Novo Nordisk Foundation over Novo Holdings). Use node_type:"legal_entity" and ubo_type:"trust".
  D. SOVEREIGN WEALTH FUND / STATE OWNER with majority stake (e.g. PIF over Lucid majority, Mubadala over GlobalFoundries, Temasek over Singtel). Use node_type:"legal_entity" and ubo_type:"sovereign".

DO NOT promote a UBO node when:
  - Founder stake is <10% with no special voting class and no board control (typical late-stage public CEO).
  - The top entity is a widely-held public company with dispersed ownership (no single shareholder >10%, no family bloc, no foundation owner — e.g. Apple, Microsoft today, most S&P 500 names). In that case the legal entity IS the root; institutional shareholders go in strategic_control, not as a UBO node.
  - You only have rumors / press speculation without a primary source (proxy filing, foundation page, family office press release, M&A doc).

When a UBO node is promoted, it becomes the new "root" layer of the parent chain (its terminal_layer is "root"), and the previously-topmost legal entity becomes its child via the normal parent recursion. Populate the UBO node payload with:
  - node_type: "individual" | "legal_entity"
  - ubo_type: "family_group" | "individual" | "trust" | "sovereign"
  - terminal_layer: "root"
  - stake: { equity_pct: number|null, voting_pct: number|null, evidence: str, source_url: str } — capture whatever is disclosed; null fields are fine.
  - Standard fields (company, layer:"root", confidence, sources, strategic_control where applicable — e.g. an individual UBO's strategic_control may be empty or describe other roles such as board chair).

If multiple triggers apply, prefer the most concrete vehicle (a named family office trumps a bare individual name; a foundation trumps an individual trustee). Document the chosen trigger in "notes" ("UBO promoted: trigger B — individual founder Zhang Yiming holds ~22% equity per ...").

DEPTH/FAN-OUT CAP
Limit ownership recursion to 2–3 generations. Cap siblings to the 8 most material brands, but ALWAYS include every brand with in_current_sources:true before any historical-only brand — only drop historical-only brands when over the cap. Cap children to 6 direct subsidiaries.

SIBLING CAPTURE FLOOR (Issue #11 — capture depth must NOT vary by which brand is focal). When the current legal parent is an identified multi-brand conglomerate (Mars, Mondelēz, Nestlé, P&G, Unilever, AB InBev, PepsiCo, Kraft Heinz, etc.), you MUST capture at least 3 in-segment siblings — at least 5 when the parent is a mega-cap (>$50B revenue). Do NOT stop after resolving only the focal just because its segment is less famous. If your first sibling search returns none, run targeted fallbacks before emitting: "[parent] [segment] brands", "[parent] brands portfolio", "[parent] [category] brands" (e.g. focal Snickers → search "Mars Wrigley brands" / "Mars snacking brands" → siblings M&M's, Skittles, Twix, Extra, Orbit). Apply the SEGMENT-FILTER and the 8-cap above to whatever you find. This guarantees Royal Canin (Mars Petcare) and Snickers (Mars Wrigley) get comparable sibling coverage.

ANTI-HALLUCINATION
Without parent evidence → standalone:true. Without evidence → don't emit. Internal memory loses to search.

CONFIDENCE
high: ≥2 Tier A/B sources, <3 years.
medium: 1 Tier A/B or ≥2 Tier C.
low: only Tier C or >3 years without reconfirmation.

STRICT JSON OUTPUT, NO PROSE, NO MARKDOWN FENCES:
{
  "company": str, "domain": str, "node_type": "legal_entity"|"operating_brand"|"individual",
  "layer": "brand"|"aggregator"|"parent"|"root",
  "standalone": bool,
  "terminal_layer": "root"|"private_equity"|null,
  "ubo_type": "family_group"|"individual"|"trust"|"sovereign"|null,    // populated ONLY on a promoted UBO node (Step 7.5). null on regular corporate layers.
  "stake": {                                                            // populated ONLY on a promoted UBO node. Captures the ownership/control evidence.
    "equity_pct": <number 0-100>|null,
    "voting_pct": <number 0-100>|null,
    "evidence": str,
    "source_url": str
  } | null,
  "in_current_sources": bool,          // appears in a PRIMARY/current source
  "in_historical_sources": bool,       // appears in a SECONDARY/older source
  "last_mention_date": str|null,       // most recent date referenced (ISO-ish) or null
  "category": str,                     // free text from sources; "" if unknown. NOT an enum.
  "parent": {recursive} | null,             // ALWAYS the current legal parent. Never the post-close acquirer of an unclosed deal.
  "ownership_role": str | null,             // Free-text role of "parent" over THIS node: "voting_control" | "majority_economic" | "joint_venture_partner" | "controlling_holder" | "sole_owner" | etc. null when no co_owners exist.
  "co_owners": [{                           // Additional formal owners beyond the parent slot — only with measurable stake evidence (Step 6.6). Cap 5. Empty/[] when single-owner.
    "company": str,
    "ownership_role": str,                  // Free text: "economic_beneficiary" | "joint_venture_partner" | "non_voting_holder" | etc.
    "stake_pct": <number 0-100> | null,     // Economic ownership %.
    "voting_pct": <number 0-100> | null,    // Voting power %, may differ from economic.
    "evidence": str,
    "entity_type": "trust"|"nonprofit"|"corporation"|"individual"|"government"|"family_group",
    "source_urls": [url]
  }],
  "focal_segment": str | null,              // The parent's segment/division/operating-label that contains the focal (e.g. "Watches & Jewelry", "Fabric & Home Care", or the publishing label "Activision"). null only when parent is genuinely single-segment with no internal grouping.
  "siblings": [{"company": str, "domain": str, "node_type": str, "category": str, "revenue_model": "direct_revenue"|"distribution_channel"|"sub_product_line", "in_current_sources": bool, "in_historical_sources": bool, "last_mention_date": str|null, "source_urls": [url]}],   // current_siblings_under_current_parent AND inside focal_segment ONLY. revenue_model: "distribution_channel" = free vehicle (Chrome, Android), no standalone revenue.
  "intra_parent_cousins": [{"company": str, "domain": str, "node_type": str, "category": str, "revenue_model": "direct_revenue"|"distribution_channel"|"sub_product_line", "via_division": str, "in_current_sources": bool, "in_historical_sources": bool, "last_mention_date": str|null, "source_urls": [url]}] | null,   // Brands of the SAME parent but in a DIFFERENT segment/division/operating-label than the focal. via_division names that other segment OR label (e.g. "Blizzard", "King"). null only when parent is genuinely single-segment.
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
  "acquisition": {"acquired_by": str, "year": int, "month": int|null, "day": int|null, "price_usd": int|null, "price_display": str|null, "price_source_url": str|null, "price_confidence": "high"|"medium"|"low"|null, "deal_type": "all_cash"|"stock_swap"|"mixed"|null, "source_url": str} | null,   // CLOSED acquisitions only (historical). Pending deals go in pending_acquisition. ALWAYS capture price_usd + price_display + deal_type when the deal value was publicly disclosed (e.g. Microsoft–Activision $68.7B all_cash, LVMH–Tiffany $15.8B). price_usd is the integer USD value (68700000000). Stock-swap and mixed deals ALSO have a publicly disclosed announced value — capture it identically (Issue #6-bis): YouTube $1.65B all-stock 2006 → price_usd 1650000000, deal_type "stock_swap"; Pixar $7.4B all-stock 2006; Nest $3.2B 2014; Instagram ~$1B cash+stock → deal_type "mixed". Do NOT leave price_usd null just because the consideration was stock. Leave price fields null only for genuinely undisclosed private deals.
  "strategic_control": [{"entity": str, "role_description": str, "evidence": str, "source_url": str}],
  "strategic_control_note": str|null,  // when strategic_control is []: "no_data_found: <reason>"
  "confidence": "high"|"medium"|"low",
  "sources": [url],
  "notes": str,
  "disambiguation_required": bool,
  "disambiguation_candidates": [{"company": str, "sector": str, "country": str}]
}`;

// Task #52 (ISSUE-AWARA-SIBLINGS-MISSING) — focused sibling enumeration prompt.
// Used as a deterministic safety net when the main OWNERSHIP_PROMPT call
// discovered siblings during search (they show up in reasoning) but failed to
// populate them in the JSON's "siblings" slot. This call does ONE job — list
// the in-segment portfolio brands of a given parent that share the focal's
// segment — so the LLM cannot "forget" to fill it. Its output is merged into
// the existing ownership tree before the revenue phase runs.
const SIBLING_BACKFILL_PROMPT = `You are a sibling-enumeration agent. Your only job: given a FOCAL brand and its CURRENT LEGAL PARENT, list the OTHER brands the parent owns that share the focal's business segment / division / operating label. These are "siblings". This is a structured enumeration task — your reasoning is worthless if it does not end up inside the JSON "siblings" array. NEVER mention siblings in prose without also installing them in the array.
RULES
 1. Use search aggressively. Try, in order: "[parent] portfolio brands", "[parent] our brands", "[parent] subsidiary brands", "[parent] [focal_segment] brands" (when a segment is given), "[parent] brands [category]".
 2. Apply the SAME segment-filter rule as the main ownership prompt: siblings must share the focal's segment/division/operating-label. Brands in OTHER segments of the same parent go in "intra_parent_cousins" with "via_division" naming that other segment.
 3. NEVER include the focal itself in "siblings". NEVER include the parent. NEVER include grandparent.
 4. Capture as many in-segment siblings as you can find (target ≥3; ≥5 if the parent is a mega-cap conglomerate). The 8-cap from the main prompt still applies.
 5. For each sibling, capture: company, domain, node_type ("operating_brand" by default), category (free text), revenue_model ("direct_revenue" | "distribution_channel" | "sub_product_line" — DEFAULT "direct_revenue"), in_current_sources (bool), in_historical_sources (bool), last_mention_date (ISO date or null), source_urls (list).
 6. If after searching you find NO siblings, return an empty array — but include a one-line "notes" string explaining why ("Parent has no public brand portfolio", "Single-segment private holding", etc.). An empty array with a reason is acceptable; an empty array with no reason is a failure.
 7. STRICT JSON OUTPUT, NO PROSE, NO MARKDOWN FENCES. Output exactly this shape:
{
  "siblings": [{"company": str, "domain": str|null, "node_type": str, "category": str, "revenue_model": "direct_revenue"|"distribution_channel"|"sub_product_line", "in_current_sources": bool, "in_historical_sources": bool, "last_mention_date": str|null, "source_urls": [url]}],
  "intra_parent_cousins": [{"company": str, "domain": str|null, "via_division": str, "category": str, "revenue_model": str, "in_current_sources": bool, "in_historical_sources": bool, "last_mention_date": str|null, "source_urls": [url]}] | null,
  "notes": str
}`;

const REVENUE_PROMPT = `You are a Revenue Inference Agent investigating private companies.

Goal: estimate the annual revenue of a brand by gathering behavioral signals from the web. The user gives you a brand name; you investigate and produce a revenue range with confidence.

## Disambiguation discipline (CRITICAL — read first)

The user will tell you the brand's role in a corporate family and, for non-root entities, the PARENT company. You MUST verify that every signal you accept belongs to the SAME entity — not a homonymous company.

Common-name siblings (e.g. "Siena", "Mercury", "Apple", "Bundle", "Mars", "Atlas", "Echo", "Origin") routinely collide with unrelated companies (SaaS, fintech, agencies, public corps). Default assumption: a top search hit for a common name is NOT your target unless the page explicitly mentions the parent, its other brands, or the correct sector/category.

Rules:
1. If a PARENT or category is provided, your FIRST web search for any non-root entity MUST include the parent or category as a qualifier (e.g. \`"Siena" "Resident" mattress\` or \`"Siena" Ashley Furniture brand\`) BEFORE searching the bare name.
2. For every signal you record, ask: "does the source page mention the parent, sibling brands, the focal's domain, or its sector?" If yes → accept normally. If no → you cannot prove it belongs to this entity. Mark the signal with \`context_unverified: true\` and force its \`weight\` to "low".
3. Pricing pages, G2/Capterra reviews, hiring counts, and traffic numbers from a same-named SaaS / agency / consultancy are extremely likely to be the WRONG entity for a consumer/DTC brand under a furniture or CPG parent. Be ruthless about marking these context_unverified.
4. NEVER promote a context_unverified signal to medium/high weight.
5. If ALL signals end up context_unverified, set the estimate to 0, confidence "low", and write a reason_for_null like: "Could not verify signals belong to {brand} as brand of {parent} vs homonymous entities ({list the colliding entities you saw, e.g. 'Siena AI customer-service SaaS'})."

## Search strategy

1. Disambiguate first: confirm which entity you are investigating. For non-root entities, the first query must include the parent or category qualifier (see rule 1 above).
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
      "weight": "low" | "medium" | "high",
      "context_unverified": bool      // true when the source does NOT mention the parent / sibling brands / focal domain / sector — i.e. you cannot prove the data point belongs to this entity vs a homonymous one. Forces weight to "low".
    }
  ],
  "reasoning_summary": "<2-4 sentences explaining how the signals triangulate to the estimate>",
  "reason_for_null": str|null         // when the estimate is 0/unknown, a FREE-TEXT reason (e.g. "brand launched <12mo ago, no traffic or funding data yet", or "Could not verify signals belong to {brand} as brand of {parent} vs homonymous entities (...)"). NOT a code like "n/a".
}
\`\`\`

Weak/contradictory signals → wider range, "low" confidence. If you genuinely cannot estimate — including the case where every signal you found is context_unverified — set the numbers to 0, confidence "low", and write a descriptive reason_for_null explaining why (never the string "n/a").`;

const PARENT_ANCHOR_PROMPT = `You are a filings agent. Given a PARENT company and a FOCAL subsidiary, determine if PARENT is publicly traded and, if so, extract the latest annual-report (10-K / 20-F / annual filing) segment revenue.

CRITICAL: PARENT here is the CURRENT LEGAL PARENT (the entity that owns FOCAL today and consolidates its financials). If the user mentions a pending/announced acquisition by a different acquirer, IGNORE the acquirer — their filings do not yet consolidate FOCAL. Only look at the current legal parent's most recent filed annual report.

Rules:
- Search authoritative sources only: SEC EDGAR, the company's IR site, the actual 10-K/20-F PDF, or a reputable financial press summary of the filing.
- SEGMENT GRANULARITY (CRITICAL — Issue #12): "segments" means the OFFICIAL PRIMARY REPORTABLE OPERATING SEGMENTS as defined in the filing's segment footnote — the coarsest revenue cut the filing itself labels as reportable segments. These are NOT product lines, brands, or business units inside a segment.
    - Microsoft → "Productivity and Business Processes", "Intelligent Cloud", "More Personal Computing". (LinkedIn, Office, Dynamics, Windows are product lines INSIDE those segments — never emit them as segments.)
    - Alphabet → "Google Services", "Google Cloud", "Other Bets". (YouTube ads, Search, Android, Chrome, Play are product lines INSIDE Google Services — never emit them as segments.)
    - Berkshire Hathaway → "Insurance and Other", "Railroad", "Utilities and Energy", "Manufacturing", "Service and Retailing".
  List each OFFICIAL segment with its USD revenue. Mark "contains_focal":true on the OFFICIAL segment that contains FOCAL (LinkedIn → Productivity and Business Processes; YouTube → Google Services; GEICO → Insurance and Other). NEVER mark a product line / sub-brand as a segment or as contains_focal.
- If the filing ALSO discloses the focal's own product-line revenue (e.g. LinkedIn $17.81B, YouTube advertising $31.51B), capture it in "focal_product_line" as {name, revenue_usd} — this is INFORMATIONAL only, it is NOT a segment and NOT the reconciliation anchor. Leave focal_product_line null when undisclosed.
- SANITY: segments[].revenue_usd should roughly sum to total_revenue_usd. If your segments sum to only a small fraction of total, you have captured product lines, not reportable segments — re-cut to the official segments before answering.
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
    {"name": str, "revenue_usd": <int USD>, "contains_focal": bool}    // OFFICIAL reportable segments ONLY — never product lines/brands inside a segment.
  ],
  "focal_product_line": {"name": str, "revenue_usd": <int USD>} | null,   // INFORMATIONAL: focal's own line-item revenue if disclosed (e.g. LinkedIn $17.81B). NOT a segment, NOT the anchor.
  "source_url": str | null,
  "notes": str
}
\`\`\``;

// Narrative synthesis — turns the structured ownership/revenue result into an
// investor-grade STORY with a clear arc, NOT a data dump. Strictly grounded:
// it may only restate facts present in the JSON it is given (no new numbers,
// no invented owners, no outside knowledge). It writes the connective tissue —
// thesis, act transitions, and the bottom line — that the rest of the report
// renders around.
const NARRATIVE_PROMPT = `You are the lead analyst writing the executive narrative of a corporate-ownership intelligence report for a venture/PE audience. You are handed a fully-resolved JSON result (ownership tree, per-node revenue estimates, reconciliation, positioning, risk signals). Your job is to make it READ LIKE A STORY with a clear arc — a sharp thesis, honest reasoning, and an actionable takeaway — not a list of facts.

ABSOLUTE GROUNDING RULES (read first):
- Use ONLY facts present in the provided JSON. Never introduce a number, owner, date, brand, or claim that is not in the data.
- If a value is null/unknown, say so plainly ("revenue could not be verified") — do NOT guess or fill gaps with outside knowledge.
- Never restate the model identifier or that you are an AI. Write as a human analyst.
- Quantify with the EXACT figures from the JSON (revenue_estimate.central, reconciliation.ratio, sibling ranks). Round for readability but never change magnitudes.
- Honesty over polish: if coverage is low or confidence is "low", the narrative must acknowledge it. A trustworthy "we don't know" beats a confident fabrication.

VOICE: crisp, declarative, senior-analyst. Short sentences. No hedging filler ("it appears that", "one might say"). No marketing fluff. Concrete > vague.

THE ARC you are writing for (each field maps to one beat of the report):
1. thesis — ONE punchy sentence (max ~30 words) that captures who owns the focal, how big it is, and its competitive standing. This is the headline a partner reads first.
2. opening — 2-3 sentences expanding the thesis into the setup: what the focal is, where it sits in the corporate family, why this ownership picture matters.
3. transition_ownership — 1-2 sentences introducing the ownership chain as a REVELATION ("the brand you see is the tip of…"). Name the ultimate parent.
4. transition_revenue — 1-2 sentences pivoting to the financial reality check (how big the focal really is vs. its parent/segment, what reconciliation shows).
5. transition_positioning — 1-2 sentences framing the competitive read (sibling rank, segment role: is it the family's growth bet, cash cow, or laggard?).
6. transition_risk — 1-2 sentences setting up the verdict (how much to trust this picture, given confidence/coverage/verification).
7. bottom_line — 2-3 sentences: the "so what" for an investor. The single most important implication + what it means for a deal/competitive decision. End decisively.

STRICT JSON OUTPUT, NO PROSE OUTSIDE THE JSON, NO MARKDOWN FENCES:
{
  "thesis": str,
  "opening": str,
  "transition_ownership": str,
  "transition_revenue": str,
  "transition_positioning": str,
  "transition_risk": str,
  "bottom_line": str
}`;

// ─── Intelligence Brief enrichment prompts ────────────────────────────────────

const SIGNAL_INTERPRETATION_PROMPT = `You are an intelligence analyst interpreting behavioral signals about a company's growth trajectory.

For EACH behavioral signal in the input array, determine:
1. What does this signal mean for the company's capital allocation, market position, or growth?
2. Is this signal positive, negative, or neutral for the thesis?
3. Can you defend the interpretation with the evidence provided?

CRITICAL RULES:
- Every interpretation MUST begin with the literal prefix "Read this as: " (exact text, including colon and trailing space).
- The interpretation MUST point to a SPECIFIC strategic insight (market position, recovery trajectory, cyclical exposure, succession risk, etc.) — NEVER restate the evidence in different words.
- Banned filler: "stable performance", "operational metrics", "demonstrates substantial scale", "well-positioned", "going forward". If you find yourself writing these, return interpretation:null instead.
- If a signal is flagged self_aware:true, treat it as the agent's own capture limitation — name explicitly which capture heuristic failed and why it matters for the verdict.
- Length: 1–2 sentences max; specific numbers and named comparators preferred over abstractions.

Return STRICT JSON (one object per signal):
[
  {
    "signal_index": <number>,
    "interpretation": "Read this as: [substantive insight, 1–2 sentences]" OR null,
    "directional_implication": "positive" | "negative" | "neutral"
  }
]

If you cannot produce a defensible, prefix-correct interpretation, return interpretation:null. Null interpretations are dropped.`;

const MISPRICING_PROMPT = `You are a mispricing analyst. Given the focal company's positioning, M&A signals, and capital patterns, assess whether there is a thesis for mispricing.

Rules:
- has_thesis:true ONLY if you can articulate a specific, evidence-backed claim about under/overvaluation
- has_thesis:false with a clear explanation (e.g., "correctly priced relative to peer set")
- If has_thesis:true, falsifying_signals MUST be non-empty AND each entry MUST be a CONCRETE OBSERVABLE EVENT, not a generic phrase. Allowed examples: "IPO filing / S-1 disclosure", "Acquirer approach reported by FT/Reuters", "Holding-company restructuring announcement", "Peer multiple compression (EV/Rev <2× sustained)", "Founder succession event", "Material covenant breach in bond filing", "Secondary stake sold to strategic". BANNED filler: "New information indicating lower acquisition price", "Market conditions change", "Macro environment shifts".
- If has_thesis:false, falsifying_signals should be []

Return STRICT JSON:
{
  "has_thesis": boolean,
  "hypothesis": "Mispricing thesis: [specific claim]" OR "No mispricing thesis: [reason]",
  "falsifying_signals": ["concrete observable event 1", "concrete observable event 2", ...] OR []
}`;

const VERDICT_THESIS_PROMPT = `You are a portfolio strategist writing a thesis statement for this company's investment positioning.

The thesis should:
- Be rooted ONLY in the provided verdict label, capital_decision_reason, signals, family_detail and reconciliation data
- Cite specific corporate structure (parent name, family surname, ownership %, sibling count) — NOT generic descriptors
- When verdict is NOT ACTIONABLE AS STANDALONE, explicitly state WHY (family-concentrated, multi-owner split, no public path) and what the brand IS useful for instead (e.g. "market-intelligence signal", "private comparable for X/Y benchmarking")
- 2–3 sentences maximum
- Banned filler: "stable mid-sized", "modest contribution", "should monitor", "time will tell", "stable performance", "operational metrics", "cautious yet engaged", "actionable capital decision", "continues to perform", "remains well-positioned", "going forward"

Return STRICT JSON:
{
  "thesis": "[substantive, evidence-rooted thesis statement]"
}`;

const COUNTER_SIGNAL_FILL_PROMPT = `You are a research coordinator. For each missing signal (gap), recommend SPECIFIC research queries AND state why closing the gap moves the verdict.

For EACH gap in the input array, return:
- fill_action: 1–2 concrete search queries the analyst could paste into a search engine. Include named sources, filings, or data providers where applicable. Format: "Search: \"<query>\"" (multiple queries separated by " · ").
- why_matters: Override the deterministic template ONLY when you can produce a sharper, brand-specific rationale (1–2 sentences). Otherwise return null and the deterministic template is preserved.

Return STRICT JSON (array):
[
  {
    "signal_type": "[original expected signal type]",
    "fill_action": "Search: \"<specific query>\" · Search: \"<second query>\"",
    "why_matters": "[1-2 sentence brand-specific rationale]" | null
  }
]`;

const COMPETITOR_PROMPT = `You are a competitive intelligence analyst. Given the focal company's category, segment, and revenue range, identify 5–7 direct competitors in the same category/segment.

Rules:
- Return ONLY companies with identifiable parents and estimated revenues that can be defended by web search
- Set competitive_distance: "direct" (same segment), "adjacent" (neighboring segment), "tangential" (adjacent category), null (unknown)
- If no identifiable peer set exists (B2B niche, proprietary/private-only, single-vendor category), return an empty array []
- Avoid hallucinating competitors — do NOT invent companies that don't appear in search results

Return STRICT JSON:
{
  "has_peer_set": boolean,
  "competitors": [
    {
      "competitor": "<company name>",
      "parent": "<parent company>" | null,
      "positioning": "<1-2 sentence description of how it competes>",
      "estimated_revenue_usd": <number> | null,
      "competitive_distance": "direct" | "adjacent" | "tangential" | null
    }
  ] | []
}`;

const STRATEGIC_NOTES_PROMPT = `You are writing audience-specific investment guidance for each stakeholder group.

Rules:
- For investors: 1–2 sentences. Name a concrete next action ("treat as private comparable for X", "track Y catalyst", "size exposure via Z"). Cite at least one named entity from the input (parent, family, peer, acquirer candidate).
- For competitors: 1–2 sentences. Reference named competitors from competitive_context when present. State what the focal's competitive posture implies for adjacent players.
- For M&A advisors: 1–2 sentences. Name plausible counterparties (specific PE firms, strategics, or sovereigns: e.g. PIF, Apollo, Brookfield, KKR, Blackstone) and the transaction structure (full sale, partial, IPO, secondary).
- For growth-signal users: an ARRAY of ≥4 distinct, concrete use cases. Each use case is one sentence, names a specific signal/metric to track, and states what action it unlocks for a growth-data customer. Examples: "Use fleet-order capex as a 2-year forward revenue indicator for benchmarking peer ship orders"; "Track Aponte succession news as the only catalyst that flips this asset to transactable".

CRITICAL: Use real names from the input — NEVER generic placeholders like "the company" or "the family". Banned filler from VERDICT_THESIS_PROMPT also applies here.

Omit audiences with no applicable context (e.g., if no M&A signals, omit for_ma_advisors).

Return STRICT JSON:
{
  "for_investors": "[1-2 sentence investor note with named entities]" | null,
  "for_competitors": "[1-2 sentence competitive note with named peers]" | null,
  "for_ma_advisors": "[1-2 sentence M&A note with named counterparties]" | null,
  "for_growth_signal_users": ["use case 1", "use case 2", "use case 3", "use case 4"]
}`;

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
  { id: 'narrative', label: 'Narrative' },
  { id: 'brief', label: 'Intelligence Brief' },
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
    if (stepId === 'narrative' || stepId === 'brief') return 'pending';
    return 'done';
  }
  if (phase === 'narrative') {
    if (stepId === 'narrative') return 'active';
    if (stepId === 'brief') return 'pending';
    return 'done';
  }
  if (phase === 'brief') {
    if (stepId === 'brief') return 'active';
    return 'done';
  }
  return 'pending';
}

// Prune the synthesized result down to the facts the narrative LLM needs, so we
// don't blow the token budget shipping every signal/source. Mirrors the report's
// own data points (the narrative may only restate what's here).
function narrativeInput(result) {
  const t = result.ownership_tree || {};
  const pa = result.positioning_analysis || {};
  const node = (n) => n && ({
    company: n.company,
    revenue_central: n.revenue_estimate?.central ?? null,
    revenue_low: n.revenue_estimate?.low ?? null,
    revenue_high: n.revenue_estimate?.high ?? null,
    confidence: n.revenue_estimate?.confidence ?? n.confidence ?? null,
    requires_review: n.requires_review || false,
  });
  const chain = [];
  let cp = t.parent;
  while (cp) { chain.unshift(node(cp)); cp = cp.parent; }
  return {
    focal: node(t),
    focal_segment: t.focal_segment || null,
    node_type: t.node_type || null,
    parent_chain_root_to_parent: chain,
    co_owners: (t.co_owners || []).map((c) => ({ company: c.company, ownership_role: c.ownership_role, stake_pct: c.stake_pct ?? null, voting_pct: c.voting_pct ?? null })),
    siblings: (t.siblings || []).map(node),
    cousins_count: (t.intra_parent_cousins || []).length,
    acquisition: t.acquisition ? { acquired_by: t.acquisition.acquired_by, year: t.acquisition.year, price_display: t.acquisition.price_display ?? null, deal_type: t.acquisition.deal_type ?? null } : null,
    pending_acquisition: t.pending_acquisition ? { acquirer: t.pending_acquisition.acquirer, expected_close_date: t.pending_acquisition.expected_close_date ?? null } : null,
    positioning: {
      focal_vs_parent_ratio: pa.focal_vs_parent_ratio ?? null,
      focal_vs_siblings: pa.focal_vs_siblings ?? null,
      growth_signals: pa.growth_signals ?? null,
    },
    reconciliation: pa.reconciliation ? {
      coverage_ratio: pa.reconciliation.ratio ?? null,
      benchmark_label: pa.reconciliation.parent_benchmark_label ?? null,
      explanation: pa.reconciliation.explanation ?? null,
      circular: pa.reconciliation.circular || false,
    } : null,
    strategic_notes: pa.strategic_notes || [],
  };
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
      // Bug #5: defensively collapse duplicate parent↔child layers BEFORE
      // spawning revenue calls so we don't pay for the same entity twice.
      const { tree: normalizedOwnership, collapses: chainCollapses } = normalizeChain(ownership);
      if (chainCollapses.length > 0) {
        appendTrace(chainCollapses.map((c) => ({
          kind: 'phase',
          phase: 'ownership',
          label: `chain normalized — collapsed "${c.from[0]}" + "${c.from[1]}" → "${c.canonical}" (shared: ${c.shared.join(', ')})`,
        })));
        Object.keys(ownership).forEach((k) => { delete ownership[k]; });
        Object.assign(ownership, normalizedOwnership);
      }
      // Task #52 (ISSUE-AWARA-SIBLINGS-MISSING): the main ownership call often
      // "discovers" siblings during search (they show up in its reasoning)
      // but fails to install them in the JSON's siblings[] slot. Without
      // siblings installed, the revenue phase only processes the focal+chain,
      // sibling ranking shows "No siblings", and the brief loses its
      // competitive context. Run a deterministic, focused safety-net call to
      // enumerate them and merge the result before the revenue phase starts.
      // The floor (≥3 in-segment siblings) is INDEPENDENT of focal size, rank,
      // ownership clarity, or chain length — capture depth must not vary by
      // which brand is focal.
      if (!ownership.disambiguation_required) {
        const bf = needsSiblingBackfill(ownership);
        if (bf.needed) {
          const tag = 'sibling-backfill';
          appendTrace([{ kind: 'phase', phase: tag, label: `→ ${bf.parent_name} sibling enumeration (only ${(ownership.siblings || []).length} captured, floor ${bf.floor})` }]);
          try {
            const segNote = bf.focal_segment ? ` (focal segment: "${bf.focal_segment}")` : '';
            const backfillUser = `FOCAL: "${ownership.company}"\nCURRENT LEGAL PARENT: "${bf.parent_name}"${segNote}\n\nEnumerate the OTHER brands the parent owns that share the focal's segment. Return ONLY the JSON object specified in the system prompt.`;
            const bfResp = await callLLM({
              provider,
              model,
              system: SIBLING_BACKFILL_PROMPT,
              user: backfillUser,
              maxSearches: 4,
              maxTokens: 2048,
            });
            appendTrace(bfResp.trace.map((t) => ({ ...t, tag })));
            const parsedBf = safeExtractJSON(bfResp.text);
            const discovered = Array.isArray(parsedBf?.siblings) ? parsedBf.siblings : [];
            const { siblings: merged, added } = mergeSiblings(
              ownership.siblings,
              discovered,
              ownership.company,
            );
            ownership.siblings = merged;
            // Also merge cousins when the backfill returned them, applying the
            // same focal/dedup discipline.
            if (Array.isArray(parsedBf?.intra_parent_cousins) && parsedBf.intra_parent_cousins.length) {
              const { cousins: mergedCousins } = mergeCousins(
                ownership.intra_parent_cousins,
                parsedBf.intra_parent_cousins,
                ownership.company,
              );
              ownership.intra_parent_cousins = mergedCousins;
            }
            if (added.length > 0) {
              appendTrace([{ kind: 'phase', phase: tag, label: `sibling floor enforced — added ${added.length}: ${added.join(', ')}` }]);
            } else {
              const why = (parsedBf && typeof parsedBf.notes === 'string' && parsedBf.notes.trim())
                ? parsedBf.notes.trim()
                : 'no additional siblings found';
              appendTrace([{ kind: 'phase', phase: tag, label: `sibling backfill returned 0 new — ${why}` }]);
            }
          } catch (e) {
            appendTrace([{ kind: 'error', tag, message: e.message }]);
          }
        }
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
            const ctxParts = [];
            if (ent.parent_company) ctxParts.push(`parent: "${ent.parent_company}"`);
            if (ent.category) ctxParts.push(`category: ${ent.category}`);
            const ctx = ctxParts.length ? ` Context — ${ctxParts.join('; ')}.` : '';
            const disambiguationNote = (ent.role === 'sibling' || ent.role === 'cousin') && ent.parent_company
              ? ` Disambiguation: "${ent.company}" is a common name — your FIRST web search MUST include the parent ("${ent.parent_company}")${ent.via_division ? ` or its division ("${ent.via_division}")` : ent.category ? ` or the category ("${ent.category}")` : ''} as a qualifier; mark any signal whose source does not reference ${ent.parent_company}, its other brands, or this sector as context_unverified.`
              : '';
            const user = `Investigate the annual revenue of: "${ent.company}"${ent.domain ? ` (domain: ${ent.domain})` : ''}. Role in corporate family: ${ent.role}.${ctx}${disambiguationNote}`;
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
      const entitiesByCompany = {};
      entities.forEach((e) => { entitiesByCompany[(e.company || '').toLowerCase().trim()] = e; });
      // X.03: stable per-(focal, parent, day) seed + intra-session revenue
      // cache. Cache lookup keys on company name; on miss we cache the
      // freshly-estimated revenue so subsequent retries on the same focal
      // return identical numbers within the session.
      const synthSeed = buildSynthesisSeed(ownership?.company, ownership?.parent?.company);
      Object.keys(byCompany).forEach((k) => {
        if (__revenueCache.has(k)) {
          byCompany[k] = __revenueCache.get(k);
        } else {
          __revenueCache.set(k, byCompany[k]);
        }
      });
      const synthesized = synthesize(ownership, byCompany, parentAnchor, entitiesByCompany, { seed: synthSeed });
      const finalResult = { ...synthesized, _entities: entities, _revenueResults: revenueResults, _parentAnchor: parentAnchor };

      // ── Narrative phase: turn the structured result into an investor-grade
      // story (thesis → transitions → bottom line). Always runs on Gemini (pure
      // prose, no web search needed). Best-effort: a failure leaves narrative
      // null and the report falls back to its deterministic copy.
      setPhase('narrative');
      appendTrace([{ kind: 'phase', phase: 'narrative', label: 'writing executive narrative (Gemini)' }]);
      try {
        const narrResp = await callLLM({
          provider: 'gemini',
          model: 'gemini-2.5-flash',
          system: NARRATIVE_PROMPT,
          user: `Write the executive narrative for this resolved ownership result. Use ONLY these facts:\n\n${JSON.stringify(narrativeInput(finalResult), null, 2)}`,
          maxTokens: 4096,
        });
        appendTrace(narrResp.trace.map((t) => ({ ...t, tag: 'narrative' })));
        const narrative = safeExtractJSON(narrResp.text);
        if (narrative && narrative.thesis) finalResult.narrative = narrative;
        else appendTrace([{ kind: 'phase', phase: 'narrative', label: 'narrative parse failed — using deterministic copy' }]);
      } catch (e) {
        appendTrace([{ kind: 'error', tag: 'narrative', message: e.message }]);
      }

      // ── Brief enrichment phase: populate LLM fields (interpretations, thesis, hypotheses)
      setPhase('brief');
      appendTrace([{ kind: 'phase', phase: 'brief', label: 'enriching intelligence brief with interpretations' }]);
      try {
        if (finalResult.intelligence_brief) {
          const brief = finalResult.intelligence_brief;

          // Prompt inputs must carry the SAME structured context the prompts
          // demand — concrete names, family_detail, reconciliation specifics,
          // competitive set. Sparse inputs cause generic / null outputs.
          const competitiveCtx = Array.isArray(brief.competitive_context) ? brief.competitive_context : [];
          const verdictForLLM = {
            label: brief.verdict?.label,
            trajectory: brief.verdict?.trajectory,
            capital_decision: brief.verdict?.capital_decision,
            capital_decision_reason: brief.verdict?.capital_decision_reason,
            confidence: brief.verdict?.confidence,
            confidence_reasoning: brief.verdict?.confidence_reasoning,
            verdict_changers: brief.verdict?.verdict_changers || [],
            family_detail: brief.corporate_structure?.family_detail || null,
            top_signals: brief.top_signals || [],
            reconciliation: finalResult.positioning_analysis?.reconciliation || null,
            history_note: brief.corporate_structure?.history_note || null,
          };
          const strategicCtx = {
            focal: finalResult.focal_company,
            verdict_label: brief.verdict?.label,
            trajectory: brief.verdict?.trajectory,
            capital_decision: brief.verdict?.capital_decision,
            capital_decision_reason: brief.verdict?.capital_decision_reason,
            ma_attention: brief.mispricing?.ma_attention,
            family_detail: brief.corporate_structure?.family_detail || null,
            top_signals: brief.top_signals || [],
            competitors: competitiveCtx.map((c) => c.competitor || c.name).filter(Boolean),
            reconciliation: finalResult.positioning_analysis?.reconciliation || null,
          };

          const batchPrompt = `
${SIGNAL_INTERPRETATION_PROMPT}

INPUT (signals):
${JSON.stringify(brief.behavioral_signals, null, 2)}

---

${MISPRICING_PROMPT}

INPUT (mispricing context):
focal: "${finalResult.focal_company}"
ma_attention: ${brief.mispricing?.ma_attention || 'none'}
verdict_label: ${brief.verdict?.label || 'UNKNOWN'}
reconciliation: ${finalResult.positioning_analysis?.reconciliation ? JSON.stringify(finalResult.positioning_analysis.reconciliation) : 'null'}

---

${VERDICT_THESIS_PROMPT}

INPUT (verdict + structural context):
${JSON.stringify(verdictForLLM, null, 2)}

---

${COUNTER_SIGNAL_FILL_PROMPT}

INPUT (gaps):
${JSON.stringify(brief.counter_signals || [], null, 2)}

---

${STRATEGIC_NOTES_PROMPT}

INPUT (full context for audience notes):
${JSON.stringify(strategicCtx, null, 2)}

RESPOND WITH A SINGLE JSON OBJECT (no markdown, no code fences):
{
  "signal_interpretations": [ { "signal_index": <number>, "interpretation": "Read this as: ..." OR null, "directional_implication": "positive"|"negative"|"neutral" } ],
  "mispricing": { "has_thesis": boolean, "hypothesis": "...", "falsifying_signals": [...] },
  "verdict_thesis": { "thesis": "..." },
  "counter_fills": [ { "signal_type": "...", "fill_action": "Search: \\"<query>\\" · Search: \\"<query>\\"", "why_matters": "..." | null } ],
  "strategic_notes": { "for_investors": "..." | null, "for_competitors": "..." | null, "for_ma_advisors": "..." | null, "for_growth_signal_users": "..." }
}`;

          const briefResp = await callLLM({
            provider: 'gemini',
            model: 'gemini-2.5-flash',
            system: 'You are an intelligence analyst enriching a corporate investment brief.',
            user: batchPrompt,
            maxTokens: 4096,
          });
          appendTrace(briefResp.trace.map((t) => ({ ...t, tag: 'brief' })));
          const briefEnrich = safeExtractJSON(briefResp.text);

          if (briefEnrich) {
            // Merge signal interpretations
            if (briefEnrich.signal_interpretations) {
              briefEnrich.signal_interpretations.forEach((si) => {
                if (si.signal_index !== undefined && brief.behavioral_signals[si.signal_index]) {
                  if (si.interpretation !== null) {
                    brief.behavioral_signals[si.signal_index].interpretation = si.interpretation;
                    brief.behavioral_signals[si.signal_index].directional_implication = si.directional_implication;
                  }
                }
              });
              // Drop signals with null interpretation
              brief.behavioral_signals = brief.behavioral_signals.filter((s) => s.interpretation !== null);
              // Enforce minimum of 3 signals (deterministic fallback)
              if (brief.behavioral_signals.length < 3) {
                appendTrace([{
                  kind: 'phase',
                  phase: 'brief',
                  label: `Warning: only ${brief.behavioral_signals.length} behavioral signals after filtering; deterministic fallback may apply`,
                }]);
              }
            }

            // Merge mispricing hypothesis
            if (briefEnrich.mispricing) {
              brief.mispricing.has_thesis = briefEnrich.mispricing.has_thesis;
              brief.mispricing.hypothesis = briefEnrich.mispricing.hypothesis;
              brief.mispricing.falsifying_signals = briefEnrich.mispricing.falsifying_signals || [];
            }

            // Merge verdict thesis
            if (briefEnrich.verdict_thesis && briefEnrich.verdict_thesis.thesis) {
              const thesis = briefEnrich.verdict_thesis.thesis;
              // Reject forbidden phrases
              const forbiddenPhrases = [
                'stable mid-sized', 'modest contribution', 'should monitor', 'time will tell',
                'stable performance', 'operational metrics', 'cautious yet engaged investment stance',
                'actionable capital decision', 'continues to perform', 'remains well-positioned',
                'going forward', 'in the coming quarters',
              ];
              const hasForbidden = forbiddenPhrases.some((phrase) => thesis.toLowerCase().includes(phrase));
              if (hasForbidden) {
                appendTrace([{
                  kind: 'phase',
                  phase: 'brief',
                  label: `Warning: verdict thesis contained forbidden filler phrase; using fallback template`,
                }]);
                // Fallback template based on label
                const fallbacks = {
                  BUY: 'Growth signals and capital allocation support expansion; recommend tracking execution.',
                  'HOLD WITH UPSIDE': 'Core asset with underexploited capacity; upside depends on growth signal realization.',
                  HOLD: 'Stable positioning; no immediate catalyst; monitor for material changes.',
                  'PULL BACK': 'Declining signals and capital reallocation suggest contraction; watch for stabilization.',
                  WATCH: 'Strategic inflection point; outcome depends on signaled activity.',
                  AVOID: 'Structural headwinds and weak signals; reposition capital elsewhere.',
                  'ACQUIRE TARGET': 'Growth trajectory and positioning suggest acquisition readiness.',
                  'EXIT IMMINENT': 'Late-stage signals and secondary activity indicate pre-exit phase.',
                };
                brief.verdict.thesis = fallbacks[brief.verdict.label] || 'Unable to generate thesis; investigate manually.';
              } else {
                brief.verdict.thesis = thesis;
              }
            }

            // Merge counter-signal fill actions + (optionally) sharper why_matters.
            if (briefEnrich.counter_fills && brief.counter_signals) {
              briefEnrich.counter_fills.forEach((cf) => {
                const counterSignal = brief.counter_signals.find((cs) => cs.signal_type === cf.signal_type);
                if (counterSignal) {
                  counterSignal.fill_action = cf.fill_action;
                  if (cf.why_matters && typeof cf.why_matters === 'string' && cf.why_matters.trim()) {
                    counterSignal.why_matters = cf.why_matters.trim();
                  }
                }
              });
            }

            // Merge strategic notes by audience
            if (briefEnrich.strategic_notes) {
              brief.strategic_notes_by_audience = {
                for_investors: briefEnrich.strategic_notes.for_investors || brief.strategic_notes_by_audience.for_investors,
                for_competitors: briefEnrich.strategic_notes.for_competitors || brief.strategic_notes_by_audience.for_competitors,
                for_ma_advisors: briefEnrich.strategic_notes.for_ma_advisors || brief.strategic_notes_by_audience.for_ma_advisors,
                for_growth_signal_users: briefEnrich.strategic_notes.for_growth_signal_users || brief.strategic_notes_by_audience.for_growth_signal_users,
              };
            }

            appendTrace([{ kind: 'phase', phase: 'brief', label: 'brief enrichment complete' }]);
          } else {
            appendTrace([{ kind: 'phase', phase: 'brief', label: 'brief enrichment parse failed — using deterministic brief' }]);
          }

          // ── Competitor discovery (optional, gated for B2B-niche)
          try {
            // V2.1 P6.01: consumer-sector whitelist short-circuits the B2B-niche
            // check. Cruise, CPG, mattress, luxury-auto etc. always deserve a peer
            // discovery attempt regardless of name-level keyword matches.
            const consumerSector = isConsumerSector(finalResult.ownership_tree);
            const B2B_NICHE_KEYWORDS = ['enterprise software', 'middleware', 'developer api'];
            const isBToBNiche = !consumerSector && (
              /\b(b2b|saas)\b/i.test(finalResult.focal_company || '')
              || (finalResult.focal_company && B2B_NICHE_KEYWORDS.some((kw) => finalResult.focal_company.toLowerCase().includes(kw.toLowerCase())))
            );

            // V2.1 fix: buildIntelligenceBrief initializes competitive_context to
            // null, so the gate must run discovery WHEN absent (=== null), not
            // when present. Skip only for genuine B2B-niche brands.
            if (!isBToBNiche && finalResult.intelligence_brief && finalResult.intelligence_brief.competitive_context == null) {
              appendTrace([{ kind: 'phase', phase: 'brief', label: 'discovering competitive context (web search)' }]);

              const competitorPrompt = `
${COMPETITOR_PROMPT}

FOCAL COMPANY:
name: "${finalResult.focal_company}"
category: "${finalResult.focal_company || 'unknown'}"
estimated_revenue_usd: ${finalResult.ownership_tree?.revenue_estimate?.central || 'unknown'}

Search for direct competitors and return the JSON result.`;

              const compResp = await callLLM({
                provider: 'anthropic',
                model: DEFAULT_MODEL,
                system: 'You are a competitive intelligence analyst.',
                user: competitorPrompt,
                maxSearches: 4,
                maxTokens: 2048,
              });
              appendTrace(compResp.trace.map((t) => ({ ...t, tag: 'competitor' })));
              const compEnrich = safeExtractJSON(compResp.text);

              if (compEnrich && compEnrich.competitors) {
                if (compEnrich.competitors.length > 0) {
                  finalResult.intelligence_brief.competitive_context = compEnrich.competitors;
                  // Backfill peer_multiples with discovered peers, but PRESERVE
                  // V2.1 deterministic fields (source, peer_median_ev_revenue,
                  // implied_valuation_usd, decomposition) that the catalog path
                  // populated. Only the per-peer list is replaced.
                  try {
                    const peers = compEnrich.competitors.slice(0, 5).map((p) => ({
                      name: p.competitor || p.name,
                      revenue: p.estimated_revenue_usd || null,
                      ev_to_revenue: null,
                      discount_or_premium_pct: null,
                    }));
                    if (peers.length > 0) {
                      finalResult.intelligence_brief.mispricing = finalResult.intelligence_brief.mispricing || {};
                      const prev = finalResult.intelligence_brief.mispricing.peer_multiples || {};
                      finalResult.intelligence_brief.mispricing.peer_multiples = {
                        ...prev,
                        peers,
                        source: 'discovered',
                        // Decomposition is structural (illiquidity / governance /
                        // conglomerate) — keep it if the catalog seeded it.
                        decomposition: prev.decomposition || null,
                      };
                    }
                  } catch (_e) { /* non-fatal */ }
                  appendTrace([{
                    kind: 'phase',
                    phase: 'brief',
                    label: `discovered ${compEnrich.competitors.length} competitors`,
                  }]);
                } else {
                  finalResult.intelligence_brief.competitive_context = null;
                  appendTrace([{
                    kind: 'phase',
                    phase: 'brief',
                    label: 'no identifiable peer set found',
                  }]);
                }
              } else {
                appendTrace([{
                  kind: 'phase',
                  phase: 'brief',
                  label: 'competitor discovery parse failed',
                }]);
              }
            } else if (isBToBNiche) {
              finalResult.intelligence_brief.competitive_context = null;
              appendTrace([{
                kind: 'phase',
                phase: 'brief',
                label: 'skipped competitor discovery (B2B-niche brand)',
              }]);
            }
          } catch (e) {
            appendTrace([{ kind: 'error', tag: 'competitor', message: e.message }]);
          }
        }
      } catch (e) {
        appendTrace([{ kind: 'error', tag: 'brief', message: e.message }]);
      }

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
  const graphViewRef = useRef(null);

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

  const handleGeneratePDF = async (mode = 'brief') => {
    let svgImage = null;
    if (graphViewRef.current && viewMode === 'graph') {
      svgImage = await graphViewRef.current.exportSVG();
    }
    await generatePDF(result, svgImage, mode);
  };

  return (
    <>
      {/* Export actions */}
      <div className="no-print" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
        <button className="btn btn-sm" onClick={() => handleGeneratePDF('brief')}>↓ Brief (V2)</button>
        <button className="btn btn-sm" onClick={() => handleGeneratePDF('legacy')}>↓ Legacy</button>
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
            <GraphView ref={graphViewRef} tree={tree} selectedKey={selectedKey} onSelect={setSelectedKey} theme={theme} />
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
  const isSegment = recon.parent_benchmark_source === 'segment';
  const isAnchored = recon.parent_benchmark_source === '10-K';
  const fiscalYear = anchor?.fiscal_year;
  const parentName = parent?.company || 'Parent';
  const sourceLabel = isSegment
    ? `${parentName} ${recon.parent_benchmark_segment_name} segment${fiscalYear ? ` · FY${fiscalYear}` : ''} 10-K`
    : isAnchored
      ? `${parentName} ${fiscalYear ? `FY${fiscalYear} ` : ''}10-K`
      : `${parentName} estimated central`;
  const levelLabel = isSegment
    ? `Benchmarking against the focal's segment (${recon.parent_benchmark_segment_name}), not ${parentName}'s consolidated total${recon.parent_total_revenue ? ` (${formatUSD(recon.parent_total_revenue)})` : ''}.`
    : isAnchored
      ? `Benchmarking against ${parentName}'s consolidated 10-K total — no per-segment breakdown was located for the focal's division.`
      : `Benchmarking against ${parentName}'s estimated revenue (no 10-K anchor).`;

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
          <div style={{ fontSize: 11, opacity: 0.7, marginTop: 4, fontStyle: 'italic' }}>
            {levelLabel}
          </div>
          {recon.circular && (
            <div style={{ fontSize: 12, marginTop: 6, color: 'var(--warning)' }}>
              ⚠ {recon.circular_siblings?.join(', ')} {recon.circular_siblings?.length > 1 ? 'were' : 'was'} estimated top-down as a share of {parentName}'s own total — summing back to that total is self-fulfilling. Treat the coverage as unverified, not confirmation.
            </div>
          )}
          {recon.consolidated_siblings && recon.consolidated_siblings.length > 0 && (
            <div style={{ fontSize: 12, marginTop: recon.circular ? 4 : 6, opacity: 0.85, fontStyle: 'italic' }}>
              {recon.consolidated_siblings.join(', ')} consolidated within the focal's reported segment — excluded from the sum to avoid double-counting.
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
            {(() => {
              // Task #41: denominator is the parent's consolidated total so rows
              // sum to ≈100% (Fashion & Leather ≈ 49% of LVMH, etc.), not a share
              // of the focal segment which produced misleading numbers > 100%.
              const parentTotal = anchor?.total_revenue_usd
                || recon?.parent_total_revenue
                || 0;
              return segments.map((seg, i) => {
              const isFocalSeg = !!seg.contains_focal;
              const segRev = seg.revenue_usd || 0;
              const hasPct = parentTotal > 0 && segRev > 0;
              const pct = hasPct ? (segRev / parentTotal) * 100 : 0;
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
                  <span
                    className="mono"
                    style={{ color: 'var(--text-subtle)', fontSize: 11, minWidth: 48, textAlign: 'right' }}
                    title={hasPct ? `${formatUSD(segRev)} / ${formatUSD(parentTotal)} parent total` : 'parent total revenue unknown'}
                  >
                    {hasPct ? `${pct.toFixed(1)}%` : '—'}
                  </span>
                  <span className="mono" style={{ color: isFocalSeg ? 'var(--text)' : 'var(--text-muted)', minWidth: 96, textAlign: 'right' }}>
                    {formatUSD(segRev)}
                  </span>
                </div>
              );
            });
            })()}
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
          <div className="tree-section-label">
            Siblings{tree.focal_segment ? <span style={{ marginLeft: 8, color: 'var(--text-subtle)', textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>· same segment: {tree.focal_segment}</span> : null}
          </div>
          <div className="tree-grid">
            {tree.siblings.map((s, i) => (
              <TreeNode key={`s${i}`} node={s} role="sibling" selectedKey={selectedKey} onSelect={onSelect} />
            ))}
          </div>
        </>
      )}
      {Array.isArray(tree.intra_parent_cousins) && tree.intra_parent_cousins.length > 0 && (
        <CousinsSection cousins={tree.intra_parent_cousins} selectedKey={selectedKey} onSelect={onSelect} parentName={tree.parent?.company} />
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
  // Surface the most recent date the source corpus referenced this entity when
  // it has been classified as legacy or discontinued — this is the timestamp
  // that justifies the "no longer current" label.
  const date = node.last_mention_date && (label === 'legacy' || label === 'discontinued')
    ? node.last_mention_date
    : null;
  return (
    <span className={`chip ${cls}`} title={date ? `last seen: ${date}` : undefined}>
      {label}{date ? ` · last seen ${date}` : ''}
    </span>
  );
}

// Bug #3: render brands of the same parent but DIFFERENT segment as a
// collapsible secondary section, grouped by `via_division`, with parent context.
function CousinsSection({ cousins, selectedKey, onSelect, parentName }) {
  const [open, setOpen] = useState(false);
  const groups = useMemo(() => {
    const g = new Map();
    cousins.forEach((c) => {
      const k = c.via_division || 'Other division';
      if (!g.has(k)) g.set(k, []);
      g.get(k).push(c);
    });
    return Array.from(g.entries());
  }, [cousins]);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, marginTop: 16,
          background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
          color: 'var(--text-muted)', font: 'inherit',
        }}
      >
        <span style={{ color: 'var(--text-subtle)', fontSize: 11 }}>{open ? '▾' : '▸'}</span>
        <span className="tree-section-label" style={{ margin: 0 }}>
          Cousins (same parent, other divisions)
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>
          · {cousins.length} brand{cousins.length === 1 ? '' : 's'}{parentName ? ` of ${parentName}` : ''}
        </span>
      </button>
      {open && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {groups.map(([division, items]) => (
            <div key={division}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', margin: '0 0 6px', fontStyle: 'italic' }}>
                via division: {division}
              </div>
              <div className="tree-grid">
                {items.map((c, i) => (
                  <TreeNode
                    key={`${division}-${i}`}
                    node={c}
                    role="cousin"
                    selectedKey={selectedKey}
                    onSelect={onSelect}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// Bug #2: visual badge per ownership role / entity_type for co-owners.
// Distinct icon + chip class so voting-control, economic, trust, and nonprofit
// are visually separable at a glance.
function coOwnerRoleMeta(role, entityType) {
  const r = (role || '').toLowerCase();
  const e = (entityType || '').toLowerCase();
  if (e === 'trust') return { icon: '§', label: 'trust', tone: 'chip-accent' };
  if (e === 'nonprofit') return { icon: '✦', label: 'nonprofit', tone: 'chip-accent' };
  if (e === 'government') return { icon: '⌘', label: 'state', tone: 'chip-accent' };
  if (e === 'family_group') return { icon: '◈', label: 'family', tone: 'chip-accent' };
  if (e === 'individual') return { icon: '◉', label: 'individual', tone: 'chip-accent' };
  if (/voting/.test(r)) return { icon: '⚖', label: 'voting', tone: 'chip-warning' };
  if (/economic|beneficiary/.test(r)) return { icon: '$', label: 'economic', tone: '' };
  if (/joint|jv|venture/.test(r)) return { icon: '⇄', label: 'JV', tone: 'chip-accent' };
  return { icon: '•', label: 'owner', tone: '' };
}

function CoOwnersSection({ parent, ownershipRole, coOwners }) {
  const parentMeta = coOwnerRoleMeta(ownershipRole, parent?.node_type === 'individual' ? 'individual' : null);
  return (
    <div className="co-owners">
      <div className="co-owners-head">
        Additional owners
        <span className="co-owners-sub">
          · economic / voting stakes beyond the consolidating parent
        </span>
      </div>
      {parent && (
        <div className="co-owner-row co-owner-parent" title="Consolidating parent (the slot that consolidates the entity)">
          <span className={`co-owner-icon ${parentMeta.tone}`}>{parentMeta.icon}</span>
          <div className="co-owner-main">
            <div className="co-owner-name">{parent.company}</div>
            <div className="co-owner-meta">
              <span className="chip chip-accent">parent</span>
              {ownershipRole && <span className="chip">{ownershipRole.replace(/_/g, ' ')}</span>}
            </div>
          </div>
          <div className="co-owner-stake mono">consolidates</div>
        </div>
      )}
      {coOwners.map((co, i) => {
        const meta = coOwnerRoleMeta(co.ownership_role, co.entity_type);
        const stakeBits = [];
        if (co.stake_pct != null) stakeBits.push(`${co.stake_pct}% econ`);
        if (co.voting_pct != null) stakeBits.push(`${co.voting_pct}% vote`);
        return (
          <div key={i} className="co-owner-row" title={meta.label}>
            <span className={`co-owner-icon ${meta.tone}`}>{meta.icon}</span>
            <div className="co-owner-main">
              <div className="co-owner-name">{co.company}</div>
              <div className="co-owner-meta">
                <span className="chip">co-owner</span>
                {co.ownership_role && <span className="chip">{co.ownership_role.replace(/_/g, ' ')}</span>}
                {co.entity_type && <span className="chip">{co.entity_type.replace(/_/g, ' ')}</span>}
              </div>
              {co.evidence && <div className="co-owner-evidence">{co.evidence}</div>}
              {Array.isArray(co.source_urls) && co.source_urls.filter(isSafeUrl).slice(0, 2).map((u, j) => (
                <div key={j} className="co-owner-source">
                  <a href={u} target="_blank" rel="noopener noreferrer">{u}</a>
                </div>
              ))}
            </div>
            <div className="co-owner-stake mono">{stakeBits.length ? stakeBits.join(' · ') : '—'}</div>
          </div>
        );
      })}
    </div>
  );
}

// Human-friendly label + tooltip for the UBO type badge (Bug #4).
function uboTypeMeta(ubo_type) {
  switch (ubo_type) {
    case 'family_group':
      return { label: 'UBO · family', title: 'Ultimate Beneficial Owner — named family group / family holding vehicle.' };
    case 'individual':
      return { label: 'UBO · individual', title: 'Ultimate Beneficial Owner — natural person holding >20% equity or >50% voting control.' };
    case 'trust':
      return { label: 'UBO · trust', title: 'Ultimate Beneficial Owner — trust, foundation or nonprofit declared as owner.' };
    case 'sovereign':
      return { label: 'UBO · sovereign', title: 'Ultimate Beneficial Owner — sovereign wealth fund or state owner with majority stake.' };
    default:
      return null;
  }
}

function TreeNode({ node, role, selectedKey, onSelect }) {
  const isFocal = role === 'focal';
  const isIndividual = node.node_type === 'individual';
  const isSelected = keyOf(node) === selectedKey;
  const rev = node.revenue_estimate;
  const uboMeta = uboTypeMeta(node.ubo_type);
  const collapsedFrom = Array.isArray(node._collapsed_from) && node._collapsed_from.length > 0
    ? `Normalized from: ${node._collapsed_from.join(', ')}`
    : null;
  const titleText = [uboMeta?.title, collapsedFrom].filter(Boolean).join('\n') || undefined;
  return (
    <button
      type="button"
      className={`tree-node ${isFocal ? 'focal' : ''} ${isIndividual ? 'individual' : ''} ${isSelected ? 'selected' : ''}`}
      onClick={() => onSelect(keyOf(node))}
      title={titleText}
    >
      <div className="tree-node-main">
        <span className="tree-node-name">
          {isIndividual && <span className="ubo-icon" aria-hidden="true">◉</span>}
          {node.company}
        </span>
        <div className="tree-node-meta">
          <span className={`chip ${isFocal ? 'chip-accent' : ''}`}>{role}</span>
          {node.layer && <span className="chip">{node.layer}</span>}
          {node.category && <span className="chip">{node.category}</span>}
          {node.terminal_layer === 'private_equity' && <span className="chip chip-warning">PE</span>}
          {uboMeta && (
            <span className="chip chip-accent" title={uboMeta.title}>{uboMeta.label}</span>
          )}
          <StatusBadge node={node} />
          {(node._divestiture || deriveDivestiture(node)) && <span className="chip chip-warning">divesting</span>}
        </div>
      </div>
      <div className={`tree-node-rev ${rev && rev.central > 0 ? '' : 'empty'}`}>
        {isIndividual ? (
          <span style={{ color: 'var(--text-subtle)', fontSize: 11, fontStyle: 'italic' }}>
            {node.stake?.equity_pct != null ? `${node.stake.equity_pct}% eq` : node.stake?.voting_pct != null ? `${node.stake.voting_pct}% vote` : 'natural person'}
          </span>
        ) : rev && rev.central > 0 ? (
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
  const isIndividual = node.node_type === 'individual';
  const uboMeta = uboTypeMeta(node.ubo_type);
  const collapsedFrom = Array.isArray(node._collapsed_from) && node._collapsed_from.length > 0
    ? `Normalized from: ${node._collapsed_from.join(', ')}`
    : null;
  const titleText = [uboMeta?.title, collapsedFrom].filter(Boolean).join('\n') || undefined;
  const handleStyle = { background: 'transparent', border: 'none', width: 1, height: 1 };
  return (
    <div
      className={`flow-node ${isFocal ? 'focal' : ''} ${isIndividual ? 'individual' : ''} ${selected ? 'selected' : ''}`}
      onClick={() => onSelect(keyOf(node))}
      title={titleText}
    >
      <Handle type="target" position={Position.Top} style={handleStyle} className="flow-handle" />
      <div className="flow-node-name">
        {isIndividual && <span className="ubo-icon" aria-hidden="true">◉ </span>}
        {node.company}
      </div>
      {node.domain && <div className="flow-node-domain">{node.domain}</div>}
      <div className="flow-node-meta">
        <span className={`chip ${isFocal ? 'chip-accent' : ''}`}>{role}</span>
        {node.category && <span className="chip">{node.category}</span>}
        {uboMeta && <span className="chip chip-accent" title={uboMeta.title}>{uboMeta.label}</span>}
        <StatusBadge node={node} />
        {rev && rev.central > 0 && (
          <>
            <span className={`confidence-dot confidence-${rev.confidence || 'unknown'}`} />
            <span className="flow-node-rev">{formatUSD(rev.central)}</span>
          </>
        )}
        {node.requires_review && (
          <span className="chip" title={node.revenue_review_reason || 'Flagged for review'}>review</span>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} style={handleStyle} className="flow-handle" />
    </div>
  );
}

function HistoryRow({ item, active, onOpen, onDelete }) {
  return (
    <div
      className="history-row"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 12px',
        borderBottom: '1px solid var(--border)',
        background: active ? 'var(--accent-soft)' : 'transparent',
        borderLeft: active ? '2px solid var(--accent)' : '2px solid transparent',
      }}
    >
      <button
        onClick={onOpen}
        className="history-row-open"
        style={{
          flex: 1,
          background: 'transparent',
          border: 'none',
          color: 'var(--text)',
          textAlign: 'left',
          cursor: 'pointer',
          padding: 0,
          display: 'flex',
          alignItems: 'baseline',
          gap: 10,
          flexWrap: 'wrap',
          font: 'inherit',
        }}
      >
        <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--text)' }}>
          {item.focal_company || item.brand}
        </span>
        {item.hint && (
          <span className="mono" style={{ fontSize: 11, color: 'var(--text-subtle)' }}>
            · {item.hint}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {item.central != null && (
          <span className="mono" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {formatUSD(item.central)}
          </span>
        )}
        {item.confidence && (
          <span className={`chip confidence-${item.confidence}`}>
            {item.confidence}
          </span>
        )}
        <span className="mono" style={{ fontSize: 11, color: 'var(--text-subtle)', minWidth: 70, textAlign: 'right' }}>
          {formatRelativeTime(item.createdAt)}
        </span>
      </button>
      <button
        onClick={onDelete}
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

const GraphView = React.forwardRef(({ tree, selectedKey, onSelect, theme }, ref) => {
  const containerRef = useRef(null);
  const { nodes, edges } = useMemo(() => buildFlowData(tree, selectedKey, onSelect), [tree, selectedKey, onSelect]);

  React.useImperativeHandle(ref, () => ({
    exportSVG: async () => {
      if (!containerRef.current) return null;
      try {
        const canvas = await html2canvas(containerRef.current, {
          backgroundColor: null,
          scale: 2,
          useCORS: true,
          allowTaint: true,
          logging: false,
        });
        const dataUrl = canvas.toDataURL('image/png');
        // Return both the image data and aspect ratio for proper PDF embedding
        return {
          imageData: dataUrl,
          width: canvas.width,
          height: canvas.height,
          aspectRatio: canvas.width / canvas.height,
        };
      } catch (err) {
        console.error('Failed to export SVG:', err);
        return null;
      }
    },
  }));

  return (
    <div className="flow-container" ref={containerRef}>
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
});
GraphView.displayName = 'GraphView';

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
        {node.via_division && (
          <span className="chip" title="Cousin: same parent, different division">
            via {node.via_division}
          </span>
        )}
        {node.terminal_layer === 'private_equity' && <span className="chip chip-warning">PE-owned</span>}
        {node.standalone && <span className="chip chip-accent">standalone</span>}
        {(() => {
          const m = uboTypeMeta(node.ubo_type);
          return m ? <span className="chip chip-accent" title={m.title}>{m.label}</span> : null;
        })()}
        {(node.context_unverified_all || node.context_unverified_some) && (
          <span
            className="chip chip-warning"
            title={
              node.context_unverified_all
                ? 'No captured signal could be tied to this entity in the context of its parent — likely a homonym collision.'
                : 'Some captured signals could not be tied to this entity in the context of its parent.'
            }
          >
            {node.context_unverified_all ? 'context unverified' : 'context partial'}
          </span>
        )}
        <StatusBadge node={node} />
      </div>

      {Array.isArray(node._collapsed_from) && node._collapsed_from.length > 0 && (
        <div
          style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}
          title={node._collapsed_shared?.length ? `Shared identifiers: ${node._collapsed_shared.join(', ')}` : undefined}
        >
          normalized from: {node._collapsed_from.join(', ')}
        </div>
      )}

      {node.stake && (node.stake.equity_pct != null || node.stake.voting_pct != null || node.stake.evidence) && (
        <div style={{ marginTop: 12, padding: '10px 12px', border: '1px solid var(--accent-soft-border)', borderRadius: 6, background: 'var(--accent-soft)', fontSize: 13 }}>
          <div style={{ fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>
            Ownership stake
          </div>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', color: 'var(--text-muted)' }}>
            {node.stake.equity_pct != null && (
              <span><span className="mono" style={{ color: 'var(--text)', fontWeight: 600 }}>{node.stake.equity_pct}%</span> equity</span>
            )}
            {node.stake.voting_pct != null && (
              <span><span className="mono" style={{ color: 'var(--text)', fontWeight: 600 }}>{node.stake.voting_pct}%</span> voting</span>
            )}
          </div>
          {node.stake.evidence && (
            <div style={{ marginTop: 6, color: 'var(--text-muted)', fontSize: 12 }}>{node.stake.evidence}</div>
          )}
          {node.stake.source_url && isSafeUrl(node.stake.source_url) && (
            <div style={{ marginTop: 4, fontSize: 11 }}>
              <a href={node.stake.source_url} target="_blank" rel="noopener noreferrer">{node.stake.source_url}</a>
            </div>
          )}
        </div>
      )}

      {isFocal && Array.isArray(node.co_owners) && node.co_owners.length > 0 && (
        <CoOwnersSection
          parent={node.parent}
          ownershipRole={node.ownership_role}
          coOwners={node.co_owners}
        />
      )}

      {node.acquisition?.acquired_by && (
        <div style={{ marginTop: 12, fontSize: 13, color: 'var(--text-muted)' }}>
          Acquired by <strong style={{ color: 'var(--text)' }}>{node.acquisition.acquired_by}</strong>
          {node.acquisition.year ? ` · ${node.acquisition.year}` : ''}
          {(node.acquisition.price_display || node.acquisition.price_usd) && (
            <> · <strong style={{ color: 'var(--text)' }}>{node.acquisition.price_display || formatUSD(node.acquisition.price_usd)}</strong></>
          )}
          {node.acquisition.deal_type && <> · {node.acquisition.deal_type.replace(/_/g, ' ')}</>}
          {(() => {
            const priceLink = node.acquisition.price_source_url || node.acquisition.source_url;
            return priceLink && isSafeUrl(priceLink) ? (
              <> · <a href={priceLink} target="_blank" rel="noopener noreferrer">source</a></>
            ) : null;
          })()}
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
          {node.post_close_consolidated_parent?.company && (
            <div style={{ marginTop: 6, color: 'var(--text-muted)' }}>
              Post-close parent: <strong style={{ color: 'var(--text)' }}>{node.post_close_consolidated_parent.company}</strong>
              {node.post_close_consolidated_parent.source_url && isSafeUrl(node.post_close_consolidated_parent.source_url) && (
                <> · <a href={node.post_close_consolidated_parent.source_url} target="_blank" rel="noopener noreferrer">source</a></>
              )}
            </div>
          )}
          {Array.isArray(node.future_cousins_post_close) && node.future_cousins_post_close.length > 0 && (
            <div style={{ marginTop: 6, color: 'var(--text-muted)' }}>
              Will sit alongside: {node.future_cousins_post_close.map((c) => c.company).filter(Boolean).join(', ')}
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
            {node.requires_review && (
              <span className="chip" style={{ marginLeft: 8 }} title={node.revenue_review_reason || ''}>requires review</span>
            )}
          </div>
          {node.requires_review && node.revenue_review_reason && (
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>
              {node.revenue_review_reason}
            </div>
          )}
          {/* Task #42: dual bottom-up / top-down breakdown + divergence warning.
              Styled to mirror the "circular — unverified" warning on the reconciliation
              banner: small caveat text in var(--warning) when the two strategies
              disagree by >30%. */}
          {(rev.bottom_up || rev.top_down) && (
            <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-muted)', borderTop: '1px solid var(--border)', paddingTop: 8 }}>
              <div style={{ fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>
                Estimation strategies
              </div>
              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                {rev.bottom_up && (
                  <span title={rev.bottom_up.source_summary || rev.bottom_up.method || 'signal-based'}>
                    Bottom-up · <span className="mono" style={{ color: 'var(--text)' }}>{formatUSD(rev.bottom_up.central)}</span>
                    {rev.bottom_up.confidence ? <> · {rev.bottom_up.confidence}</> : null}
                  </span>
                )}
                {rev.top_down && (
                  <span title={rev.top_down.source_summary || rev.top_down.method || 'share-of-parent'}>
                    Top-down · <span className="mono" style={{ color: 'var(--text)' }}>{formatUSD(rev.top_down.central)}</span>
                    {rev.top_down.confidence ? <> · {rev.top_down.confidence}</> : null}
                  </span>
                )}
              </div>
              {rev.divergence_flag && (
                <div style={{ marginTop: 6, color: 'var(--warning)' }}>
                  ⚠ Bottom-up vs top-down disagree by {rev.divergence_pct}% — treat the range as the source of truth, not either single number.
                </div>
              )}
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
        <div style={{ marginTop: 14, fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6 }}>
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
          {signals.map((s, i) => (
            <div key={i} className="signal-row">
              <div className="signal-type">{s.type}</div>
              <div>
                <div className="signal-label">
                  {s.label}
                  {s.context_unverified && (
                    <span
                      className="chip chip-warning"
                      style={{ marginLeft: 6 }}
                      title="Source does not reference the parent / sibling brands / focal domain or sector — this signal may belong to a homonymous entity."
                    >
                      context unverified
                    </span>
                  )}
                </div>
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
  // Ancestors' other children (e.g. a JV/subsidiary under the parent) so they're selectable.
  chain.forEach((anc) => (anc.children || []).forEach(add));
  add(tree);
  (tree.siblings || []).forEach(add);
  (tree.intra_parent_cousins || []).forEach(add);
  (tree.children || []).forEach(add);
  return out;
}

// ─── Chart Renderers for Brief PDF ────────────────────────────────────────

function drawReconciliationWaterfall(pdf, startY, pageW, margin, contentW, brief) {
  // Reconciliation: Sum of Siblings vs Parent Benchmark as stacked bars
  if (!brief.reconciliation_honest?.raw_numbers) return startY;

  const recon = brief.reconciliation_honest.raw_numbers;
  const sum = recon.sum_siblings || 0;
  const anchor = recon.anchor || 0;
  const max = Math.max(sum, anchor, 1);
  const scale = (contentW - 60) / max;

  let y = startY + 2;
  pdf.setFontSize(10); pdf.setFont('helvetica', 'bold'); pdf.setTextColor(17, 17, 20);
  pdf.text('Sum of Siblings vs Parent Benchmark', margin + 2, y);
  y += 5;

  // Bar 1: Sum of Siblings
  pdf.setFontSize(9); pdf.setFont('helvetica', 'normal');
  pdf.text('Sum Siblings:', margin + 2, y + 1);
  const bar1W = sum * scale;
  pdf.setFillColor(100, 180, 220);
  pdf.rect(margin + 35, y, bar1W, 4, 'F');
  pdf.setTextColor(60, 120, 180);
  pdf.text(`$${(sum / 1e6).toFixed(0)}M`, margin + 35 + bar1W + 3, y + 1);
  y += 6;

  // Bar 2: Parent Benchmark
  pdf.setTextColor(17, 17, 20);
  pdf.text('Parent Anchor:', margin + 2, y + 1);
  const bar2W = anchor * scale;
  pdf.setFillColor(76, 175, 80);
  pdf.rect(margin + 35, y, bar2W, 4, 'F');
  pdf.setTextColor(56, 142, 60);
  pdf.text(`$${(anchor / 1e6).toFixed(0)}M`, margin + 35 + bar2W + 3, y + 1);
  y += 6;

  // Delta indicator
  const deltaLow = Math.min(bar1W, bar2W);
  const deltaHigh = Math.max(bar1W, bar2W);
  const deltaW = deltaHigh - deltaLow;
  pdf.setDrawColor(200, 100, 100);
  pdf.setLineWidth(0.5);
  pdf.line(margin + 35 + deltaLow, y - 2, margin + 35 + deltaHigh, y - 2);

  const deltaPct = recon.delta_pct || 0;
  const deltaColor = deltaPct > 0 ? [220, 120, 80] : [100, 160, 200];
  pdf.setTextColor(...deltaColor);
  pdf.setFontSize(9);
  pdf.text(`Δ ${deltaPct > 0 ? '+' : ''}${deltaPct}%`, margin + 35 + deltaHigh + 3, y - 0.5);

  return y + 4;
}

function drawSignalSentiment(pdf, startY, pageW, margin, contentW, brief) {
  // Behavioral signals: Type × Weight × Implication scatter plot
  if (!brief.behavioral_signals || brief.behavioral_signals.length === 0) return startY;

  let y = startY + 2;
  pdf.setFontSize(10); pdf.setFont('helvetica', 'bold'); pdf.setTextColor(17, 17, 20);
  pdf.text('Signal Distribution', margin + 2, y);
  y += 5;

  const weights = { high: 3, medium: 2, low: 1 };
  const impColors = { positive: [76, 175, 80], negative: [244, 67, 54], neutral: [150, 150, 160] };
  const weightLabels = ['Low', 'Medium', 'High'];

  // Draw axes labels
  pdf.setFontSize(8); pdf.setTextColor(100, 100, 100);
  pdf.text('Signal Type', margin + 5, y + 18);
  pdf.save();
  pdf.setFont('helvetica', 'italic');
  pdf.text('Weight →', margin + contentW - 15, y + 10);
  pdf.restore();

  // Draw grid
  pdf.setDrawColor(230, 230, 235);
  pdf.setLineWidth(0.2);
  for (let i = 0; i < 4; i++) {
    const xPos = margin + 20 + (i * (contentW - 40) / 3);
    pdf.line(xPos, y, xPos, y + 16);
  }

  // Plot signals
  const sigByType = {};
  brief.behavioral_signals.forEach((sig) => {
    const type = sig.signal_type?.split(' ')[0] || 'Other';
    if (!sigByType[type]) sigByType[type] = [];
    sigByType[type].push(sig);
  });

  const types = Object.keys(sigByType).slice(0, 6);
  const spacing = (contentW - 40) / Math.max(types.length, 1);

  types.forEach((type, idx) => {
    const sigs = sigByType[type];
    const xPos = margin + 20 + idx * spacing + spacing / 2;

    sigs.slice(0, 3).forEach((sig, sidx) => {
      const weight = weights[sig.weight] || 2;
      const yPos = y + 16 - weight * 5;
      const impColor = impColors[sig.directional_implication] || impColors.neutral;

      pdf.setFillColor(...impColor);
      pdf.circle(xPos, yPos, 1.5, 'F');
    });

    pdf.setFontSize(7); pdf.setTextColor(80, 80, 80);
    pdf.text(type, xPos - 3, y + 18);
  });

  // Legend
  y += 22;
  pdf.setFontSize(7);
  const legItems = [
    { label: 'Positive', color: [76, 175, 80] },
    { label: 'Neutral', color: [150, 150, 160] },
    { label: 'Negative', color: [244, 67, 54] },
  ];
  legItems.forEach((item, i) => {
    pdf.setFillColor(...item.color);
    pdf.circle(margin + 20 + i * 30, y, 0.8, 'F');
    pdf.setTextColor(80, 80, 80);
    pdf.text(item.label, margin + 22 + i * 30, y + 0.5);
  });

  return y + 4;
}

function drawConfidenceBreakdown(pdf, startY, pageW, margin, contentW, brief) {
  // Confidence gaps: 4-column stacked breakdown
  const gaps = brief.confidence_gaps || {};
  const categories = [
    { key: 'high_confidence', label: 'High Conf', color: [76, 175, 80] },
    { key: 'medium_confidence', label: 'Medium', color: [255, 152, 0] },
    { key: 'known_gaps', label: 'Known Gaps', color: [244, 67, 54] },
    { key: 'verdict_changers', label: 'V-Changers', color: [63, 81, 181] },
  ];

  let y = startY + 2;
  pdf.setFontSize(10); pdf.setFont('helvetica', 'bold'); pdf.setTextColor(17, 17, 20);
  pdf.text('Confidence Breakdown', margin + 2, y);
  y += 5;

  const barH = 6;
  const barX = margin + 30;
  const barW = contentW - 40;

  categories.forEach((cat) => {
    const count = (gaps[cat.key] || []).length;
    const barSegW = (count / 8) * barW; // Max 8 items per category

    // Category label
    pdf.setFontSize(8); pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(80, 80, 80);
    pdf.text(cat.label, margin + 2, y + 1.5);

    // Colored bar
    pdf.setFillColor(...cat.color);
    pdf.rect(barX, y, Math.min(barSegW, barW), barH, 'F');
    pdf.setDrawColor(cat.color[0] - 20, cat.color[1] - 20, cat.color[2] - 20);
    pdf.rect(barX, y, Math.min(barSegW, barW), barH);

    // Count
    pdf.setTextColor(255, 255, 255);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(7);
    if (barSegW > 8) pdf.text(`${count}`, barX + 2, y + 1.8);

    y += 8;
  });

  // Legend: what the total coverage is
  y += 2;
  const totalItems = categories.reduce((sum, cat) => sum + (gaps[cat.key] || []).length, 0);
  pdf.setFontSize(8); pdf.setTextColor(100, 100, 100);
  pdf.text(`Total data points tracked: ${totalItems}`, barX, y);

  return y + 6;
}

function drawCompetitivePositioning(pdf, startY, pageW, margin, contentW, brief) {
  // Competitive context: 2x2 matrix (Revenue × Distance)
  if (!Array.isArray(brief.competitive_context) || brief.competitive_context.length === 0) return startY;

  const comps = brief.competitive_context.slice(0, 8);
  let y = startY + 2;
  pdf.setFontSize(10); pdf.setFont('helvetica', 'bold'); pdf.setTextColor(17, 17, 20);
  pdf.text('Competitive Landscape', margin + 2, y);
  y += 5;

  // Axes: Revenue (x) and Distance (y)
  const chartX = margin + 20;
  const chartY = y;
  const chartW = contentW - 40;
  const chartH = 14;

  // Draw axes
  pdf.setDrawColor(180, 180, 190);
  pdf.setLineWidth(0.5);
  pdf.line(chartX, chartY, chartX, chartY + chartH); // Y axis
  pdf.line(chartX, chartY + chartH, chartX + chartW, chartY + chartH); // X axis

  // Axis labels
  pdf.setFontSize(7); pdf.setTextColor(100, 100, 100);
  pdf.text('Revenue →', chartX + chartW - 15, chartY + chartH + 2);
  pdf.save();
  pdf.setFont('helvetica', 'italic');
  pdf.text('Distance', chartX - 15, chartY + 2);
  pdf.restore();

  // Distance categories (y)
  const distMap = { direct: 3, adjacent: 2, tangential: 1 };
  const revRange = { min: 0, max: Math.max(...comps.map((c) => c.estimated_revenue_usd || 0)) };

  // Plot competitors
  const distColors = { direct: [76, 175, 80], adjacent: (220, 160, 60), tangential: (150, 150, 160) };

  comps.forEach((comp) => {
    const dist = distMap[comp.competitive_distance] || 1;
    const rev = comp.estimated_revenue_usd || 0;
    const xPos = chartX + (rev / revRange.max) * chartW * 0.9;
    const yPos = chartY + chartH - dist * 4;

    const color = distColors[comp.competitive_distance] || [150, 150, 160];
    pdf.setFillColor(...(Array.isArray(color) ? color : [150, 150, 160]));
    pdf.circle(xPos, yPos, 1.2, 'F');

    // Competitor label (abbreviated)
    const label = comp.competitor?.substring(0, 3).toUpperCase() || '?';
    pdf.setFontSize(6); pdf.setTextColor(60, 60, 60);
    pdf.text(label, xPos - 1, yPos + 0.3);
  });

  y += chartH + 4;

  // Legend
  pdf.setFontSize(7);
  const distLegend = [
    { label: 'Direct', color: [76, 175, 80] },
    { label: 'Adjacent', color: [220, 160, 60] },
    { label: 'Tangential', color: [150, 150, 160] },
  ];
  distLegend.forEach((item, i) => {
    pdf.setFillColor(...item.color);
    pdf.circle(chartX + 20 + i * 40, y, 0.6, 'F');
    pdf.setTextColor(80, 80, 80);
    pdf.text(item.label, chartX + 22 + i * 40, y + 0.4);
  });

  return y + 5;
}

// Generate professional PDF report. Vector-text layout (crisp at any zoom) with a
// designed cover band, section headers, colored pills, bordered/zebra tables, an
// embedded high-res snapshot of the on-screen ownership map, page numbers, and the
// full F11 dataset (derived status + category, reconciliation explanation, per-layer
// strategic control). Forces a direct download via a Blob + anchor.
async function generateBriefPDF(result, svgImage = null) {
  if (!result || !result.intelligence_brief) return;

  const brief = result.intelligence_brief;
  const tree = result.ownership_tree || {};
  const focal = (typeof result.focal_company === 'string' ? result.focal_company : result.focal_company?.name)
    || tree.company
    || 'Unknown';
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

  // Revenue formatting
  const formatRev = (n) => {
    if (!n || n === 0) return 'undisclosed';
    if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
    if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
    return `$${(n / 1e3).toFixed(0)}K`;
  };
  const revEst = tree.revenue_estimate || {};
  const revRange = revEst.central ? `${formatRev(revEst.low || revEst.central * 0.7)}–${formatRev(revEst.high || revEst.central * 1.3)} (central: ${formatRev(revEst.central)})` : 'Undisclosed';

  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const margin = 16;
  const contentW = pageW - 2 * margin;
  const bottomLimit = pageH - 16;
  let y = margin;

  const font = (size, style = 'normal') => { pdf.setFontSize(size); pdf.setFont('helvetica', style); };
  let pageNum = 1;
  const addPage = () => { pdf.addPage(); pageNum++; y = margin; };
  const ensure = (h) => { if (y + h > bottomLimit) addPage(); };

  const renderPageNum = () => {
    pdf.setFontSize(8); pdf.setTextColor(150, 150, 150);
    pdf.text(`Page ${pageNum}`, pageW - margin - 20, pageH - 8);
  };

  const text = (str, opts = {}) => {
    const { size = 10, style = 'normal', color = [24, 24, 27], x = margin, maxW = contentW, gap = 1.8 } = opts;
    font(size, style); pdf.setTextColor(...color);
    // V2.1 R.02 — sanitize unicode glyphs (▣ ★ ◆ • − …) that jsPDF helvetica
    // cannot encode, otherwise they render as garbage or empty boxes.
    const lines = pdf.splitTextToSize(sanitizeForPdf(str), maxW);
    const lineH = size * 0.42;
    lines.forEach((ln) => {
      ensure(lineH);
      pdf.text(ln, x, y, { baseline: 'top' });
      y += lineH;
    });
    y += gap;
  };

  const badge = (label, bgColor = [200, 220, 240], textColor = [8, 145, 178]) => {
    ensure(8);
    const bw = 25, bh = 5;
    pdf.setFillColor(...bgColor);
    pdf.rect(margin, y, bw, bh, 'F');
    pdf.setTextColor(...textColor);
    font(8, 'bold');
    pdf.text(label, margin + 1, y + 1.2);
    y += 7;
  };

  const section = (title) => {
    ensure(24);
    y += 3;
    pdf.setFillColor(8, 145, 178);
    pdf.rect(margin, y, 2.2, 5.4, 'F');
    font(12, 'bold'); pdf.setTextColor(17, 17, 20);
    pdf.text(String(title).toUpperCase(), margin + 5, y + 0.3, { baseline: 'top' });
    y += 7.5;
    pdf.setDrawColor(229, 231, 235); pdf.setLineWidth(0.3);
    pdf.line(margin, y, margin + contentW, y);
    y += 4;
  };

  // ─── Page 1: Verdict hero (V2.1) ───────────────────────────────────────
  section('VERDICT');
  const verdictLabel = brief.verdict?.label || 'N/A';
  const isNotActionable = /not actionable/i.test(verdictLabel);
  const heroColor = isNotActionable ? [180, 60, 60] : [8, 145, 178];
  text(verdictLabel, { size: 22, style: 'bold', color: heroColor });

  // Confidence badge + reasoning.
  const confidenceLevels = { high: [76, 175, 80], medium: [255, 152, 0], low: [244, 67, 54] };
  const confColor = confidenceLevels[brief.verdict?.confidence] || [150, 150, 150];
  badge((brief.verdict?.confidence || 'unknown').toUpperCase(), confColor, [255, 255, 255]);
  if (brief.verdict?.confidence_reasoning) {
    text(brief.verdict.confidence_reasoning, { size: 8.5, color: [110, 110, 120] });
  }

  text(`Trajectory: ${brief.verdict?.trajectory || 'N/A'}`, { size: 11 });
  // Capital-path line: surface the structural reason alongside the decision.
  const capReason = brief.verdict?.capital_decision_reason;
  const capLine = capReason
    ? `Capital path: ${brief.verdict.capital_decision} - ${String(capReason).replace(/_/g, ' ')}`
    : `Capital path: ${brief.verdict?.capital_decision || 'N/A'}`;
  text(capLine, { size: 11 });
  // V2.1 P1.04 — capital-path one-liner (Family-owned private · No public ticker · No M&A activity)
  if (brief.verdict?.capital_path_summary) {
    text(brief.verdict.capital_path_summary, { size: 9.5, color: [110, 110, 130], style: 'italic' });
  }
  text(`Revenue range: ${revRange}`, { size: 10, color: [80, 120, 160] });
  if (brief.verdict?.thesis) text(`Thesis: ${brief.verdict.thesis}`, { size: 10 });

  // "What would make this actionable" — verdict changers + condition→label map.
  const changers = brief.verdict?.verdict_changers || [];
  if (isNotActionable && changers.length > 0) {
    y += 1;
    text('What would make this actionable:', { size: 10, style: 'bold', color: [60, 60, 80] });
    changers.slice(0, 4).forEach((c) => text(`  - ${c}`, { size: 9, color: [60, 60, 60] }));
  }
  // V2.1 P7.03 — explicit condition → new-label map.
  // V2.1 R.01 — never silent skip: render header + fallback when empty.
  const vMap = brief.verdict?.verdict_changer_map || [];
  y += 1;
  text('Verdict-changer map (condition -> new label):', { size: 9.5, style: 'bold', color: [60, 60, 80] });
  if (vMap.length > 0) {
    vMap.slice(0, 5).forEach((m) => text(`  - IF ${m.condition} -> ${m.new_label}`, { size: 8.5, color: [70, 70, 90] }));
  } else {
    text('  No data captured for verdict-changer map.', { size: 8.5, color: [120, 120, 130], style: 'italic' });
  }

  // ─── Top-3 signals (lead the brief with "Read this as:") ─────────────
  // V2.1 R.01 — never silent skip: always render header + fallback when empty.
  const top3 = Array.isArray(brief.top_signals) && brief.top_signals.length > 0
    ? brief.top_signals
    : (brief.behavioral_signals || []).slice(0, 3);
  y += 3;
  section('TOP-3 SIGNALS');
  if (top3.length > 0) {
    const dirArrow = (d) => (d === 'positive' ? '+' : d === 'negative' ? '−' : '=');
    top3.forEach((sig) => {
      const dir = sig.directional_implication ? ` · ${dirArrow(sig.directional_implication)}` : '';
      text(`▣ ${sig.signal_type || 'Unknown'} [${(sig.weight || 'medium').toUpperCase()}${dir}]`, { size: 10, style: 'bold' });
      if (sig.evidence) text(`   ${sig.evidence}`, { size: 9 });
      if (sig.interpretation) text(`   ${sig.interpretation}`, { size: 9, color: [60, 80, 130] });
    });
  } else {
    text('No data captured for top-3 signals.', { size: 10, color: [120, 120, 130], style: 'italic' });
  }

  // ─── All behavioral signals ──────────────────────────────────────────
  y += 4;
  section('BEHAVIORAL SIGNALS');
  const dirArrow2 = (d) => (d === 'positive' ? '+' : d === 'negative' ? '−' : '=');
  if (brief.behavioral_signals && brief.behavioral_signals.length > 0) {
    brief.behavioral_signals.slice(0, 8).forEach((sig, i) => {
      const dir = sig.directional_implication ? ` (${dirArrow2(sig.directional_implication)})` : '';
      const flag = sig.self_aware ? ' · SELF-AWARE' : '';
      text(`${i + 1}. ${sig.signal_type || 'Unknown'} [${sig.weight || 'medium'}]${dir}${flag}`, { size: 10, style: 'bold' });
      if (sig.evidence) text(`   Evidence: ${sig.evidence}`, { size: 9 });
      if (sig.interpretation) text(`   ${sig.interpretation}`, { size: 9 });
    });
  } else {
    text('No signals captured', { size: 10 });
  }

  // ─── Counter-signals with why_matters ─────────────────────────────────
  if (brief.counter_signals && brief.counter_signals.length > 0) {
    y += 2;
    text(`Counter-signals · ${brief.counter_signals.length} gaps with fill actions`, { size: 10, style: 'bold', color: [200, 120, 40] });
    brief.counter_signals.forEach((gap) => {
      ensure(12);
      const blockH = 5 + (gap.fill_action ? 3 : 0) + (gap.why_matters ? 6 : 0);
      pdf.setFillColor(255, 245, 220);
      pdf.rect(margin, y, contentW, blockH, 'F');
      pdf.setDrawColor(220, 160, 80);
      pdf.rect(margin, y, contentW, blockH);
      const blockTop = y;
      font(9, 'bold'); pdf.setTextColor(180, 100, 20);
      pdf.text(`Gap: ${gap.signal_type}`, margin + 1.5, blockTop + 1.5);
      let inner = blockTop + 4.2;
      if (gap.fill_action) {
        font(8); pdf.setTextColor(80, 80, 90);
        const lines = pdf.splitTextToSize(`→ ${gap.fill_action}`, contentW - 3);
        lines.slice(0, 2).forEach((ln) => { pdf.text(ln, margin + 1.5, inner); inner += 3; });
      }
      if (gap.why_matters) {
        font(8, 'italic'); pdf.setTextColor(110, 90, 60);
        const lines = pdf.splitTextToSize(`Why this matters: ${gap.why_matters}`, contentW - 3);
        lines.slice(0, 3).forEach((ln) => { pdf.text(ln, margin + 1.5, inner); inner += 3; });
      }
      y = blockTop + Math.max(blockH, inner - blockTop) + 1.5;
    });
  }

  // ─── CHARTS SECTION ───────────────────────────────────────────────────
  ensure(45);
  section('ANALYTICS & VISUALIZATIONS');

  // Chart 1: Reconciliation Waterfall
  ensure(25);
  y = drawReconciliationWaterfall(pdf, y, pageW, margin, contentW, brief);

  y += 3;

  // Chart 2: Signal Sentiment
  ensure(30);
  y = drawSignalSentiment(pdf, y, pageW, margin, contentW, brief);

  y += 3;

  // Chart 3: Confidence Breakdown
  ensure(25);
  y = drawConfidenceBreakdown(pdf, y, pageW, margin, contentW, brief);

  y += 3;

  // Chart 4: Competitive Positioning (if applicable)
  if (Array.isArray(brief.competitive_context) && brief.competitive_context.length > 0) {
    ensure(30);
    y = drawCompetitivePositioning(pdf, y, pageW, margin, contentW, brief);
  }

  y += 4;
  section('CORPORATE STRUCTURE');
  if (brief.corporate_structure?.ascii_tree) {
    text(brief.corporate_structure.ascii_tree, { size: 8 });
  } else {
    text('Unknown structure', { size: 10 });
  }
  text(`Ownership clarity: ${brief.corporate_structure?.ownership_clarity || 'N/A'}`, { size: 10 });
  if (brief.corporate_structure?.history_note) {
    text(brief.corporate_structure.history_note, { size: 9, color: [90, 90, 100] });
  }

  // Family / UBO detail table (V2.1 §3).
  const fam = brief.corporate_structure?.family_detail;
  if (fam && Array.isArray(fam.members) && fam.members.length > 0) {
    y += 2;
    text(`UBO detail · ${fam.surname ? fam.surname.charAt(0).toUpperCase() + fam.surname.slice(1) + ' family' : 'family'} (~${fam.total_pct}% combined)`, { size: 10, style: 'bold', color: [60, 60, 80] });
    const colW = [contentW * 0.45, contentW * 0.35, contentW * 0.2];
    const rowH = 5.2;
    ensure(rowH * (fam.members.length + 1) + 2);
    pdf.setFillColor(245, 245, 248);
    pdf.rect(margin, y, contentW, rowH, 'F');
    font(8.5, 'bold'); pdf.setTextColor(60, 60, 80);
    pdf.text('Member', margin + 1.5, y + 1.4);
    pdf.text('Role', margin + colW[0] + 1.5, y + 1.4);
    pdf.text('Est. stake', margin + colW[0] + colW[1] + 1.5, y + 1.4);
    y += rowH;
    fam.members.forEach((m, i) => {
      if (i % 2 === 0) {
        pdf.setFillColor(252, 252, 254);
        pdf.rect(margin, y, contentW, rowH, 'F');
      }
      font(8.5); pdf.setTextColor(40, 40, 50);
      pdf.text(String(m.name || '').slice(0, 38), margin + 1.5, y + 1.4);
      pdf.text(String(m.role || '').slice(0, 32), margin + colW[0] + 1.5, y + 1.4);
      pdf.text(String(m.est_stake || ''), margin + colW[0] + colW[1] + 1.5, y + 1.4);
      y += rowH;
    });
    y += 1;
  }

  y += 4;
  section('RECONCILIATION');
  if (brief.reconciliation_honest) {
    const recon = brief.reconciliation_honest;
    const interpretation = recon.interpretation || 'unknown';

    // Color-code by interpretation
    const reconColors = {
      overshoot: [200, 230, 201], // green
      gap_uncovered: [255, 243, 224], // amber
      circular: [255, 205, 210], // red
      coverage_win: [200, 230, 201],
      reconciles: [240, 248, 255], // light blue
    };
    const bgColor = reconColors[interpretation] || [240, 240, 240];

    // Draw interpretation box
    ensure(14);
    pdf.setFillColor(...bgColor);
    pdf.rect(margin, y, contentW, 8, 'F');
    pdf.setDrawColor(180, 180, 180);
    pdf.rect(margin, y, contentW, 8);
    font(9, 'bold');
    pdf.setTextColor(17, 17, 20);
    const deltaStr = (recon.raw_numbers?.delta_pct || 0) > 0 ? '+' : '';
    const deltaVal = recon.raw_numbers?.delta_pct || 0;
    pdf.text(`${interpretation.toUpperCase()} · ${deltaStr}${deltaVal}%`, margin + 2, y + 1.5);
    y += 10;

    // Explanation
    if (recon.honest_explanation) {
      text(recon.honest_explanation, { size: 9 });
    }

    // Table: reconciliation numbers
    ensure(12);
    const rows = [
      ['Sum of Siblings', formatRev(recon.raw_numbers?.sum_siblings || 0)],
      ['Parent Benchmark', formatRev(recon.raw_numbers?.anchor || 0)],
    ];
    rows.forEach((row, i) => {
      if (i > 0) y += 0.5;
      pdf.setDrawColor(220, 220, 220);
      pdf.rect(margin, y, contentW / 2, 4.5);
      pdf.rect(margin + contentW / 2, y, contentW / 2, 4.5);
      font(9);
      pdf.setTextColor(80, 80, 80);
      pdf.text(row[0], margin + 1, y + 1);
      pdf.setTextColor(17, 17, 20);
      pdf.text(row[1], margin + contentW / 2 + 1, y + 1);
      y += 4.5;
    });
    y += 2;

    // Overstated/Understated siblings
    if ((recon.siblings_likely_overstated && recon.siblings_likely_overstated.length > 0) ||
        (recon.siblings_likely_understated && recon.siblings_likely_understated.length > 0)) {
      ensure(8);
      if (recon.siblings_likely_overstated?.length > 0) {
        text(`⚠ Likely overstated: ${recon.siblings_likely_overstated.join(', ')}`, { size: 9, color: [200, 80, 80] });
      }
      if (recon.siblings_likely_understated?.length > 0) {
        text(`◆ Likely understated: ${recon.siblings_likely_understated.join(', ')}`, { size: 9, color: [80, 120, 200] });
      }
    }
  } else {
    text('No reconciliation data (standalone)', { size: 10, color: [150, 150, 150] });
  }

  // Dual-model triangulation (industry × share, volume × unit economics, parent anchor).
  const dual = brief.reconciliation_dual_model;
  if (dual && Array.isArray(dual.models) && dual.models.length > 0) {
    y += 2;
    text('Triangulation models:', { size: 10, style: 'bold', color: [60, 60, 80] });
    dual.models.forEach((m) => {
      text(`• ${m.label} → ${m.verdict || 'inconclusive'}`, { size: 9, style: 'bold' });
      if (m.evidence) text(`    ${m.evidence}`, { size: 8.5, color: [90, 90, 100] });
    });
    if (dual.notes) text(dual.notes, { size: 8.5, color: [150, 100, 60], style: 'italic' });
  }

  y += 4;
  section('MISPRICING & M&A');
  text(`M&A Attention: ${brief.mispricing?.ma_attention || 'None'}`, { size: 10 });
  if (brief.mispricing?.hypothesis) text(`Hypothesis: ${brief.mispricing.hypothesis}`, { size: 10 });
  if (brief.mispricing?.falsifying_signals && brief.mispricing.falsifying_signals.length > 0) {
    text('Falsifying signals:', { size: 9, style: 'bold' });
    brief.mispricing.falsifying_signals.forEach((fs) => {
      text(`   - ${fs}`, { size: 9 });
    });
  }
  // Peer-multiples skeleton (V2.1 §4) — surface even when LLM hasn't filled in
  // the EV/Rev numbers, so the reader sees the comparable set explicitly.
  const pm = brief.mispricing?.peer_multiples;
  if (pm && Array.isArray(pm.peers) && pm.peers.length > 0) {
    y += 1;
    const srcTag = pm.source === 'catalog' ? ' (sector catalog)' : pm.source === 'discovered' ? ' (web-discovered)' : '';
    text(`Peer-set multiples${srcTag}:`, { size: 9, style: 'bold', color: [60, 60, 80] });
    pm.peers.forEach((p) => {
      const rev = p.revenue ? ` - ~$${(p.revenue / 1e9).toFixed(1)}B` : '';
      const ev = p.ev_to_revenue != null ? ` - EV/Rev ${p.ev_to_revenue}x` : '';
      const disc = p.discount_or_premium_pct != null ? ` - ${p.discount_or_premium_pct > 0 ? '+' : ''}${p.discount_or_premium_pct}%` : '';
      text(`   - ${p.name}${rev}${ev}${disc}`, { size: 9 });
    });
    if (pm.peer_median_ev_revenue != null && pm.implied_valuation_usd) {
      text(`   Implied valuation (peer median ${pm.peer_median_ev_revenue}x x focal revenue): ~$${(pm.implied_valuation_usd / 1e9).toFixed(1)}B`, { size: 9, style: 'bold', color: [40, 80, 130] });
    }
    // V2.1 P5.03 — discount decomposition with components and aggregate range.
    if (pm.decomposition && Array.isArray(pm.decomposition.components) && pm.decomposition.components.length > 0) {
      text(`   Discount decomposition (aggregate ${pm.decomposition.aggregate_discount_range}):`, { size: 9, style: 'bold', color: [80, 80, 100] });
      pm.decomposition.components.forEach((c) => {
        text(`     - ${c.label} (${c.pct_range}): ${c.note}`, { size: 8.5, color: [90, 90, 110] });
      });
    } else if (pm.decomposition && typeof pm.decomposition === 'string') {
      text(`   Discount/premium decomposition: ${pm.decomposition}`, { size: 9, color: [80, 80, 100] });
    }
  }
  // V2.1 P5.05 — actionable reads by audience.
  const reads = brief.mispricing?.actionable_reads;
  if (Array.isArray(reads) && reads.length > 0) {
    y += 1;
    text('Actionable reads:', { size: 9, style: 'bold', color: [60, 60, 80] });
    reads.forEach((r) => {
      text(`   - [${r.audience}] ${r.read}`, { size: 8.5, color: [60, 60, 70] });
    });
  }

  // Competitive context (Phase 4 web-search; null when B2B-niche / no peer set)
  y += 4;
  section('COMPETITIVE CONTEXT');
  if (Array.isArray(brief.competitive_context) && brief.competitive_context.length > 0) {
    brief.competitive_context.forEach((c) => {
      const rev = c.estimated_revenue_usd ? ` ~$${(c.estimated_revenue_usd / 1e6).toFixed(0)}M` : '';
      const dist = c.competitive_distance ? ` [${c.competitive_distance}]` : '';
      text(`${c.competitor}${c.parent ? ` (${c.parent})` : ''}${rev}${dist}`, { size: 10, style: 'bold' });
      if (c.positioning) text(`   ${c.positioning}`, { size: 9 });
    });
  } else {
    text('No identifiable peer set (B2B-niche or proprietary category).', { size: 10, color: [120, 120, 130] });
  }

  // Strategic notes by audience
  const notes = brief.strategic_notes_by_audience || {};
  const audienceRows = [
    ['For investors', notes.for_investors],
    ['For competitors', notes.for_competitors],
    ['For M&A advisors', notes.for_ma_advisors],
    ['For growth-signal users', notes.for_growth_signal_users],
  ].filter(([, v]) => v && v !== 'Pending LLM enrichment');
  // V2.1 R.01 — never silent skip.
  y += 4;
  section('STRATEGIC NOTES');
  if (audienceRows.length > 0) {
    audienceRows.forEach(([label, note]) => {
      text(`${label}:`, { size: 10, style: 'bold' });
      // for_growth_signal_users can be array of ≥4 use cases (V2.1 P3.04)
      if (Array.isArray(note)) {
        note.forEach((u) => text(`   - ${u}`, { size: 9 }));
      } else {
        text(`   ${note}`, { size: 9 });
      }
    });
  } else {
    text('No data captured for strategic notes.', { size: 10, color: [120, 120, 130], style: 'italic' });
  }

  // V2.1 P7.01 + P9.03 + P9.04 — confidence buckets, limitations, section confidence
  // V2.1 R.01 — never silent skip: always render the header + fallback.
  const buckets = brief.confidence_buckets;
  const bucketTotal = (buckets?.high?.length || 0) + (buckets?.medium?.length || 0) + (buckets?.low?.length || 0);
  y += 4;
  section('CONFIDENCE BREAKDOWN');
  if (buckets && bucketTotal > 0) {
    const bands = [
      ['HIGH', buckets.high, [76, 175, 80]],
      ['MEDIUM', buckets.medium, [255, 152, 0]],
      ['LOW', buckets.low, [244, 67, 54]],
    ];
    bands.forEach(([label, items, col]) => {
      if (!items || !items.length) return;
      ensure(6);
      pdf.setFillColor(...col); pdf.rect(margin, y, 22, 4.5, 'F');
      font(8, 'bold'); pdf.setTextColor(255, 255, 255);
      pdf.text(label, margin + 1, y + 1.5);
      y += 5;
      items.forEach((it) => text(`  - ${it.claim} - ${it.reason}`, { size: 8.5, color: [50, 50, 60] }));
      y += 0.5;
    });
  } else {
    text('No data captured for confidence breakdown.', { size: 10, color: [120, 120, 130], style: 'italic' });
  }

  const sc = brief.section_confidence;
  if (sc) {
    y += 2;
    text('Section confidence (stars):', { size: 9.5, style: 'bold', color: [60, 60, 80] });
    Object.entries(sc).forEach(([name, val]) => {
      text(`  ${name.replace(/_/g, ' ')}: ${val.stars} - ${val.reason}`, { size: 8.5, color: [70, 70, 90] });
    });
  }

  const lims = brief.limitations_list || [];
  if (lims.length > 0) {
    y += 2;
    text('Limitations:', { size: 9.5, style: 'bold', color: [150, 80, 40] });
    lims.forEach((l) => text(`  ! ${l}`, { size: 8.5, color: [110, 80, 60] }));
  }

  // V2.1 P7.02 — gap leverage stars
  const stars = brief.confidence_gaps?.known_gaps_starred || [];
  if (stars.length > 0) {
    y += 2;
    text('Gap leverage (more stars = higher verdict-flip impact):', { size: 9.5, style: 'bold', color: [60, 60, 80] });
    stars.forEach((s) => text(`  ${'*'.repeat(s.stars)} ${s.gap}`, { size: 8.5, color: [70, 70, 90] }));
  }

  // Confidence gaps
  const gaps = brief.confidence_gaps || {};
  const hasGaps = (gaps.high_confidence?.length > 0) || (gaps.medium_confidence?.length > 0) ||
                 (gaps.known_gaps?.length > 0) || (gaps.verdict_changers?.length > 0);
  if (hasGaps) {
    y += 4;
    section('CONFIDENCE & GAPS');

    const gapColors = {
      high_confidence: [76, 175, 80], // green
      medium_confidence: (255, 152, 0), // orange
      known_gaps: (244, 67, 54), // red
      verdict_changers: (63, 81, 181), // indigo
    };

    const gapLabels = {
      high_confidence: '✓ HIGH CONFIDENCE',
      medium_confidence: '◆ MEDIUM CONFIDENCE',
      known_gaps: '○ KNOWN GAPS',
      verdict_changers: '⚠ VERDICT CHANGERS',
    };

    ['high_confidence', 'medium_confidence', 'known_gaps', 'verdict_changers'].forEach((key) => {
      const items = gaps[key] || [];
      if (items.length > 0) {
        ensure(6);
        const colors = { high_confidence: [76, 175, 80], medium_confidence: [255, 152, 0], known_gaps: [244, 67, 54], verdict_changers: [63, 81, 181] };
        const col = colors[key] || [150, 150, 150];
        pdf.setFillColor(...col);
        pdf.rect(margin, y, contentW, 4.5, 'F');
        font(8, 'bold');
        pdf.setTextColor(255, 255, 255);
        pdf.text(gapLabels[key], margin + 1, y + 1.5);
        y += 5;

        items.slice(0, 3).forEach((item) => {
          text(`  • ${item}`, { size: 9, color: [60, 60, 60] });
        });
        if (items.length > 3) {
          text(`  ... and ${items.length - 3} more`, { size: 8, color: [120, 120, 120] });
        }
        y += 1;
      }
    });
  }

  y += 4;
  section('DATA TRACE');
  text(`Report Date: ${dateStr}`, { size: 9 });
  // V2.1 P9.01 — split primary used vs excluded with reason.
  const pUsed = brief.data_trace?.primary_used || brief.data_trace?.primary_sources || [];
  if (pUsed.length > 0) {
    text(`Primary sources used: ${pUsed.join(', ')}`, { size: 9 });
  }
  const excluded = brief.data_trace?.excluded_with_reason || [];
  if (excluded.length > 0) {
    text('Excluded sources:', { size: 9, style: 'bold', color: [120, 80, 60] });
    excluded.forEach((e) => text(`  - ${e.source}: ${e.reason}`, { size: 8.5, color: [100, 80, 70] }));
  }
  if (brief.data_trace?.methodology_note) {
    text(brief.data_trace.methodology_note, { size: 8, color: [120, 120, 130] });
  }

  // Render page numbers on all pages
  const pageCount = pdf.internal.pages.length - 1; // exclude blank first element
  for (let i = 1; i <= pageCount; i++) {
    pdf.setPage(i);
    pdf.setFontSize(8);
    pdf.setTextColor(150, 150, 150);
    pdf.text(`Page ${i}`, pageW - margin - 20, pageH - 8);
  }

  const filename = `${focal}-intelligence-brief-${dateStr.replace(/\s+/g, '-')}.pdf`;
  pdf.save(filename);
}

async function generatePDF(result, svgImage = null, mode = 'brief') {
  if (mode === 'brief') {
    return generateBriefPDF(result, svgImage);
  }
  return generateLegacyPDF(result, svgImage);
}

async function generateLegacyPDF(result, svgImage = null) {
  if (!result || !result.ownership_tree) return;

  const tree = result.ownership_tree;
  const positioning = result.positioning_analysis || {};
  const recon = positioning.reconciliation;
  const focal = tree.company;
  const pa = tree.pending_acquisition;
  const acq = tree.acquisition;
  const revEstTop = tree.revenue_estimate || {};

  // Narrative arc (Gemini-written, grounded in the data). When absent — no API
  // key, parse failure, or an older saved investigation — fall back to a
  // deterministic sentence built from the same numbers so the report still
  // reads as a story rather than breaking.
  const N = result.narrative || {};
  const fallbackThesis = () => {
    const ownerBit = tree.parent ? `owned by ${tree.parent.company}` : 'standalone';
    const revBit = revEstTop.central > 0 ? `~${formatUSD(revEstTop.central)} in estimated revenue` : 'undisclosed revenue';
    const segBit = tree.focal_segment ? `, in its ${tree.focal_segment} segment` : '';
    return `${focal} is ${ownerBit}${segBit}, with ${revBit}.`;
  };
  const narr = {
    thesis: N.thesis || fallbackThesis(),
    opening: N.opening || (positioning.strategic_notes && positioning.strategic_notes[0]) || '',
    transition_ownership: N.transition_ownership || '',
    transition_revenue: N.transition_revenue || '',
    transition_positioning: N.transition_positioning || '',
    transition_risk: N.transition_risk || '',
    bottom_line: N.bottom_line || '',
  };

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

  // Narrative connective tissue between acts: an italic lead-in with a short
  // accent rail. No-ops on empty strings so a missing narrative leaves no gap.
  const transition = (str) => {
    if (!str || !str.trim()) return;
    font(9.5, 'italic');
    const lines = pdf.splitTextToSize(sanitize(str), contentW - 8);
    const blockH = lines.length * 4.4 + 3;
    ensure(blockH + 2);
    const tY = y;
    pdf.setFillColor(...C.accent);
    pdf.rect(margin, tY, 1.6, lines.length * 4.4, 'F');
    pdf.setTextColor(...C.muted);
    let ly = tY;
    lines.forEach((ln) => { pdf.text(ln, margin + 5, ly, { baseline: 'top' }); ly += 4.4; });
    y = tY + blockH;
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
  pdf.rect(0, 0, pageW, 40, 'F');
  font(22, 'bold'); pdf.setTextColor(...C.white);
  pdf.text(truncateToWidth(focal, contentW - 60), margin, 14, { baseline: 'middle' });
  font(10.5, 'normal'); pdf.setTextColor(...C.tint);
  pdf.text('Ownership & Revenue Intelligence', margin, 23, { baseline: 'middle' });
  font(8.5, 'normal');
  pdf.text(`${dateStr} · ${timeStr}`, margin, 29, { baseline: 'middle' });
  // Confidential tag (top-right)
  {
    font(7.5, 'bold');
    const tag = 'CONFIDENTIAL · DEAL MATERIALS';
    const tw = pdf.getTextWidth(tag) + 5;
    pdf.setFillColor(...C.ink);
    pdf.roundedRect(pageW - margin - tw, 9, tw, 6, 1.2, 1.2, 'F');
    pdf.setTextColor(...C.white);
    pdf.text(tag, pageW - margin - tw + 2.5, 12.4, { baseline: 'middle' });
  }
  y = 48;

  // ─── KPI cards (cover) ───
  {
    const revEstCover = tree.revenue_estimate || {};
    const coverageStr = recon && recon.ratio ? `${Math.round(recon.ratio * 100)}%` : '—';
    const kpis = [
      { label: 'EST. REVENUE', value: revEstCover.central > 0 ? formatUSD(revEstCover.central) : '—', bg: C.accentSoft, fg: C.accentHover },
      { label: 'PARENT COVERAGE', value: coverageStr, bg: C.activeBg, fg: C.activeFg },
      { label: 'CONFIDENCE', value: (revEstCover.confidence || 'unknown').toUpperCase(), bg: C.surface, fg: C.muted },
    ];
    const gap = 5;
    const cardW = (contentW - gap * (kpis.length - 1)) / kpis.length;
    const cardH = 22;
    kpis.forEach((k, i) => {
      const x = margin + i * (cardW + gap);
      pdf.setFillColor(...k.bg);
      pdf.roundedRect(x, y, cardW, cardH, 2, 2, 'F');
      font(16, 'bold'); pdf.setTextColor(...k.fg);
      pdf.text(truncateToWidth(k.value, cardW - 6), x + cardW / 2, y + 9, { align: 'center', baseline: 'middle' });
      font(7, 'bold'); pdf.setTextColor(...C.muted);
      pdf.text(k.label, x + cardW / 2, y + 17, { align: 'center', baseline: 'middle' });
    });
    y += cardH + 4;
  }

  // ─── Executive Summary ───
  section('Executive Summary');
  const revEst = tree.revenue_estimate || {};

  // ── Act 1 — The thesis. A prominent, accented callout that states the whole
  // story in one line, followed by the opening prose. This is the headline a
  // partner reads first.
  {
    font(13, 'bold');
    const thesisLines = pdf.splitTextToSize(sanitize(narr.thesis), contentW - 12);
    const thesisH = 8 + thesisLines.length * 6 + 4;
    ensure(thesisH);
    const tY = y;
    pdf.setFillColor(...C.accent);
    pdf.roundedRect(margin, tY, contentW, thesisH, 2.5, 2.5, 'F');
    // Left accent rail
    pdf.setFillColor(...C.accentHover);
    pdf.rect(margin, tY, 2.5, thesisH, 'F');
    font(7, 'bold'); pdf.setTextColor(...C.tint);
    pdf.text('THE THESIS', margin + 7, tY + 6, { baseline: 'middle' });
    font(13, 'bold'); pdf.setTextColor(...C.white);
    let thY = tY + 12;
    thesisLines.forEach((ln) => { pdf.text(ln, margin + 7, thY, { baseline: 'top' }); thY += 6; });
    y = tY + thesisH + 4;

    if (narr.opening) {
      text(narr.opening, { size: 10, color: C.text, gap: 4 });
    }
  }

  // Deal Brief box — structured at-a-glance summary
  {
    const briefRows = [
      { label: 'TARGET', value: focal },
      { label: 'PARENT', value: tree.parent?.company || 'Standalone (no parent)' },
      { label: 'SEGMENT', value: tree.focal_segment || 'n/a' },
      { label: 'REVENUE', value: revEst.central > 0 ? `${formatUSD(revEst.central)} (${formatUSD(revEst.low)}–${formatUSD(revEst.high)})` : '—' },
      { label: 'STATUS', value: pa && pa.acquirer ? `Pending acquisition by ${pa.acquirer}` : (acq && acq.acquired_by ? `Acquired by ${acq.acquired_by}${acq.year ? ` (${acq.year})` : ''}` : deriveStatus(tree).label) },
    ];
    const briefH = 8 + briefRows.length * 6 + 3;
    ensure(briefH);
    const briefY = y;
    pdf.setFillColor(...C.accentSoft);
    pdf.roundedRect(margin, briefY, contentW, briefH, 2, 2, 'F');
    pdf.setDrawColor(...C.accent); pdf.setLineWidth(0.4);
    pdf.roundedRect(margin, briefY, contentW, briefH, 2, 2);
    font(9, 'bold'); pdf.setTextColor(...C.accentHover);
    pdf.text('DEAL BRIEF', margin + 5, briefY + 5, { baseline: 'top' });
    let rowY = briefY + 12;
    briefRows.forEach(({ label, value }) => {
      font(8, 'bold'); pdf.setTextColor(...C.muted);
      pdf.text(label, margin + 5, rowY, { baseline: 'top' });
      font(8.5, 'normal'); pdf.setTextColor(...C.ink);
      pdf.text(truncateToWidth(value, contentW - 45), margin + 38, rowY, { baseline: 'top' });
      rowY += 6;
    });
    y = briefY + briefH + 4;
  }

  const parentClause = tree.parent
    ? ` under ${tree.parent.company}${tree.focal_segment ? ` (${tree.focal_segment} division)` : ''}`
    : ' (standalone)';
  text(
    `${focal} is a ${tree.layer || 'brand'}${parentClause} with an estimated annual revenue of ${formatUSD(revEst.low)}–${formatUSD(revEst.high)} (central ${formatUSD(revEst.central)}).`,
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
    const uboMeta = uboTypeMeta(tree.ubo_type);
    if (uboMeta) px += pill(uboMeta.label, px, py, C.accentSoft, C.accentHover) + 2;
    if (tree.context_unverified_all) px += pill('context unverified', px, py, C.warnBg, C.warning) + 2;
    else if (tree.context_unverified_some) px += pill('context partial', px, py, C.warnBg, C.warning) + 2;
    y = py + 8;
  }

  // Key insights bullets
  {
    const insights = [];
    if (tree.ubo_type && tree.ubo_type !== 'unknown') {
      if (tree.ubo_type === 'family_owned') insights.push('Private family-owned');
      else if (tree.ubo_type === 'private_equity') insights.push('Private equity-backed');
      else if (tree.ubo_type === 'public') insights.push('Publicly traded');
      else if (tree.ubo_type === 'state_owned') insights.push('State-owned enterprise');
    }
    if (revEst.central && revEst.central > 0) {
      insights.push(`~${formatUSD(revEst.central)} estimated annual revenue`);
    }
    if (tree.parent && recon && recon.ratio) {
      const coverPct = Math.round(recon.ratio * 100);
      const parentLabel = tree.focal_segment ? `parent segment (${tree.focal_segment})` : `parent`;
      insights.push(`${coverPct}% of ${parentLabel}'s revenue captured`);
    }
    if (Array.isArray(tree.co_owners) && tree.co_owners.length > 0) {
      insights.push(`Multi-owner structure (${tree.co_owners.length} co-owner${tree.co_owners.length > 1 ? 's' : ''})`);
    }
    if (pa && pa.acquirer) {
      insights.push(`Pending acquisition by ${pa.acquirer}`);
    } else if (acq && acq.acquired_by) {
      const yearStr = acq.year ? ` (${acq.year})` : '';
      insights.push(`Previously acquired by ${acq.acquired_by}${yearStr}`);
    }
    if (insights.length > 0) {
      ensure(insights.length * 3 + 4);
      font(9, 'bold'); pdf.setTextColor(...C.ink);
      pdf.text('Key Insights', margin, y, { baseline: 'top' }); y += 4;
      insights.forEach((insight) => {
        font(8.5, 'normal'); pdf.setTextColor(...C.text);
        pdf.text(`• ${insight}`, margin + 2, y, { baseline: 'top' });
        y += 3.2;
      });
      y += 1;
    }
  }

  // ─── Act 2 — Ownership Hierarchy (the revelation: who owns this?) ───
  // Moved early in narrative: after thesis, before revenue/positioning.
  const chain = [];
  let cp = tree.parent;
  while (cp) { chain.unshift(cp); cp = cp.parent; }
  const siblings = tree.siblings || [];

  // Ownership pyramid (top-down: root → focal) — use SVG image if available, else fallback to primitives
  if (chain.length > 0) {
    section('Ownership Hierarchy');
    transition(narr.transition_ownership);
    text(`${chain.length + 1} ownership level${chain.length > 0 ? 's' : ''} from ultimate parent to ${focal}.`,
      { size: 8.5, style: 'italic', color: C.muted, gap: 3 });

    if (svgImage && svgImage.imageData) {
      // Embed the ReactFlow SVG as a high-quality PNG image with actual aspect ratio
      const imgW = contentW;
      const imgH = imgW / svgImage.aspectRatio;
      ensure(imgH + 4);
      pdf.addImage(svgImage.imageData, 'PNG', margin, y, imgW, imgH);
      y += imgH + 4;
    } else {
      // Fallback: render with jsPDF primitives
      const levels = [...chain, tree];
      const boxH = 16, vGap = 10;
      const maxW = contentW * 0.9, minW = contentW * 0.55;

      levels.forEach((node, idx) => {
        ensure(boxH + vGap + 2);
        const t = levels.length > 1 ? idx / (levels.length - 1) : 0;
        const w = maxW - (maxW - minW) * t;
        const x = margin + (contentW - w) / 2;
        const isFocal = node === tree;
        const isRoot = idx === 0;

        // Main box with enhanced styling
        pdf.setFillColor(...(isFocal ? C.accent : C.surface));
        pdf.setDrawColor(...(isFocal ? C.accentHover : C.border));
        pdf.setLineWidth(isFocal ? 0.8 : 0.4);
        pdf.roundedRect(x, y, w, boxH, 2.2, 2.2, 'FD');

        // Left marker shape (drawn with primitives — no Unicode glyphs).
        // focal: filled circle · root: filled square · intermediate: ring.
        const mCx = x + 5, mCy = y + 5.5, mR = 2;
        if (isFocal) {
          pdf.setFillColor(...C.tint);
          pdf.circle(mCx, mCy, mR, 'F');
        } else if (isRoot) {
          pdf.setFillColor(...[100, 116, 139]);
          pdf.rect(mCx - mR, mCy - mR, mR * 2, mR * 2, 'F');
        } else {
          pdf.setFillColor(...C.accent);
          pdf.circle(mCx, mCy, mR, 'F');
          pdf.setFillColor(...C.surface);
          pdf.circle(mCx, mCy, mR - 0.8, 'F');
        }

        // Company name
        font(9.5, 'bold'); pdf.setTextColor(...(isFocal ? C.white : C.ink));
        pdf.text(truncateToWidth(node.company || '?', w - 42), x + 10, y + 5.5, { baseline: 'middle' });

        // Revenue on right
        const rv = node.revenue_estimate;
        const revStr = rv && rv.central > 0 ? formatUSD(rv.central) : '—';
        font(8, isFocal ? 'bold' : 'normal');
        pdf.setTextColor(...(isFocal ? C.tint : C.muted));
        pdf.text(revStr, x + w - 4, y + 5.5, { align: 'right', baseline: 'middle' });

        // Level label (plain text, no glyphs)
        font(6.5, 'normal'); pdf.setTextColor(...(isFocal ? C.tint : C.subtle));
        const levelLabel = isFocal ? 'FOCAL COMPANY' : (isRoot ? 'ULTIMATE PARENT' : `OWNER LEVEL ${idx}`);
        pdf.text(levelLabel, x + 10, y + 11.2, { baseline: 'middle' });

        // Confidence indicator: a colored dot + letter side-by-side (no overlap)
        if (rv && rv.confidence) {
          const confColor = rv.confidence === 'high' ? [34, 197, 94]
                          : rv.confidence === 'medium' ? [234, 179, 8]
                          : [239, 68, 68];
          const cy = y + 11.2;
          font(6, 'normal'); pdf.setTextColor(...(isFocal ? C.tint : C.subtle));
          const confLabel = rv.confidence.toUpperCase();
          const cw = pdf.getTextWidth(confLabel);
          pdf.text(confLabel, x + w - 4, cy, { align: 'right', baseline: 'middle' });
          pdf.setFillColor(...confColor);
          pdf.circle(x + w - 6 - cw - 1.5, cy, 1.2, 'F');
        }

        // Connector with arrow head between levels
        if (idx < levels.length - 1) {
          pdf.setDrawColor(...C.border); pdf.setLineWidth(0.5);
          const centerX = margin + contentW / 2;
          const connectorY1 = y + boxH;
          const connectorY2 = y + boxH + vGap;
          pdf.line(centerX, connectorY1, centerX, connectorY2);
          const arrowSize = 1.2;
          pdf.line(centerX - arrowSize, connectorY2 - arrowSize, centerX, connectorY2);
          pdf.line(centerX + arrowSize, connectorY2 - arrowSize, centerX, connectorY2);
        }

        y += boxH + vGap;
      });
      y += 2;
    }
  }

  // ─── Risk Assessment (Act 5 — the verdict) ───
  // Defined here, but invoked near the end of the report so the risk grade reads
  // as the conclusion of the story rather than a stat block up top.
  const renderRiskVerdict = () => {
    const G = C.activeFg, Y = C.warning, R = C.danger;       // semaphore colors
    const Gb = C.activeBg, Yb = C.warnBg, Rb = C.dangerBg;   // backgrounds
    const conf = revEst.confidence;
    const ratio = recon && recon.ratio;
    const risks = [
      {
        label: 'Ownership Verification',
        ...(tree.context_unverified_all
          ? { lvl: 'HIGH', col: R, bg: Rb, note: 'Ownership chain largely unverified' }
          : tree.context_unverified_some
            ? { lvl: 'MED', col: Y, bg: Yb, note: 'Some layers lack independent confirmation' }
            : { lvl: 'LOW', col: G, bg: Gb, note: 'Ownership chain verified end-to-end' }),
      },
      {
        label: 'Revenue Confidence',
        ...(conf === 'high'
          ? { lvl: 'LOW', col: G, bg: Gb, note: `Central ${revEst.central > 0 ? formatUSD(revEst.central) : '—'}, high confidence` }
          : conf === 'medium'
            ? { lvl: 'MED', col: Y, bg: Yb, note: `Central ${revEst.central > 0 ? formatUSD(revEst.central) : '—'}, medium confidence` }
            : { lvl: 'HIGH', col: R, bg: Rb, note: 'Low/unknown confidence; verify estimate' }),
      },
      {
        label: 'Parent Alignment',
        ...(ratio == null
          ? { lvl: 'N/A', col: C.muted, bg: C.surface, note: 'No parent benchmark available' }
          : (ratio >= 0.8 && ratio <= 1.2)
            ? { lvl: 'LOW', col: G, bg: Gb, note: `${Math.round(ratio * 100)}% coverage — well aligned` }
            : { lvl: 'MED', col: Y, bg: Yb, note: `${Math.round(ratio * 100)}% coverage — gap to investigate` }),
      },
      {
        label: 'Acquisition Status',
        ...(pa && pa.acquirer
          ? { lvl: 'HIGH', col: R, bg: Rb, note: `Pending: ${pa.acquirer} — deal not closed` }
          : { lvl: 'LOW', col: G, bg: Gb, note: acq && acq.acquired_by ? `Closed: acquired by ${acq.acquired_by}` : 'No pending transaction' }),
      },
    ];
    if (tree.requires_review) {
      risks.push({ label: 'Revenue Consistency', lvl: 'HIGH', col: R, bg: Rb, note: 'Child revenue exceeds parent — flagged for review' });
    }
    // Overall grade = worst level present.
    const order = { LOW: 0, 'N/A': 0, MED: 1, HIGH: 2 };
    const worst = risks.reduce((m, r) => (order[r.lvl] > order[m] ? r.lvl : m), 'LOW');
    const gradeMeta = worst === 'HIGH' ? { col: R, bg: Rb, label: 'HIGH', rec: 'Verify flagged items before underwriting' }
      : worst === 'MED' ? { col: Y, bg: Yb, label: 'MEDIUM', rec: 'Review gaps; data broadly reliable' }
        : { col: G, bg: Gb, label: 'LOW', rec: 'Strong data quality; proceed' };

    section('Risk Assessment');
    transition(narr.transition_risk);
    const rowH = 9;
    risks.forEach((r) => {
      ensure(rowH);
      pdf.setFillColor(...r.bg);
      pdf.roundedRect(margin, y, contentW, rowH - 1.5, 1.5, 1.5, 'F');
      pdf.setFillColor(...r.col);
      pdf.circle(margin + 4, y + (rowH - 1.5) / 2, 1.6, 'F');
      font(9, 'bold'); pdf.setTextColor(...C.ink);
      pdf.text(r.label, margin + 9, y + (rowH - 1.5) / 2 + 0.2, { baseline: 'middle' });
      font(8, 'normal'); pdf.setTextColor(...C.muted);
      pdf.text(truncateToWidth(r.note, contentW - 110), margin + 62, y + (rowH - 1.5) / 2 + 0.2, { baseline: 'middle' });
      font(8, 'bold'); pdf.setTextColor(...r.col);
      pdf.text(r.lvl, margin + contentW - 4, y + (rowH - 1.5) / 2 + 0.2, { align: 'right', baseline: 'middle' });
      y += rowH;
    });
    // Overall grade bar
    ensure(11);
    y += 1;
    pdf.setFillColor(...gradeMeta.bg);
    pdf.roundedRect(margin, y, contentW, 9, 1.5, 1.5, 'F');
    pdf.setDrawColor(...gradeMeta.col); pdf.setLineWidth(0.5);
    pdf.roundedRect(margin, y, contentW, 9, 1.5, 1.5);
    font(9, 'bold'); pdf.setTextColor(...C.ink);
    pdf.text('OVERALL RISK GRADE', margin + 5, y + 4.5, { baseline: 'middle' });
    font(11, 'bold'); pdf.setTextColor(...gradeMeta.col);
    pdf.text(gradeMeta.label, margin + 62, y + 4.5, { baseline: 'middle' });
    font(7.5, 'italic'); pdf.setTextColor(...C.muted);
    pdf.text(truncateToWidth(gradeMeta.rec, contentW - 92), margin + contentW - 4, y + 4.5, { align: 'right', baseline: 'middle' });
    y += 12;
  };

  // UBO stake sub-block (mirrors the detail panel's "Ownership stake" card).
  if (tree.stake && (tree.stake.equity_pct != null || tree.stake.voting_pct != null || tree.stake.evidence)) {
    ensure(14);
    const top = y;
    pdf.setFillColor(...C.accentSoft);
    pdf.setDrawColor(...C.accent); pdf.setLineWidth(0.2);
    const bits = [];
    if (tree.stake.equity_pct != null) bits.push(`${tree.stake.equity_pct}% equity`);
    if (tree.stake.voting_pct != null) bits.push(`${tree.stake.voting_pct}% voting`);
    const ev = tree.stake.evidence ? sanitize(tree.stake.evidence) : '';
    const evLines = ev ? pdf.splitTextToSize(ev, contentW - 8) : [];
    const url = tree.stake.source_url && isSafeUrl(tree.stake.source_url) ? tree.stake.source_url : null;
    const blockH = 7 + (bits.length ? 4 : 0) + evLines.length * 3.8 + (url ? 4 : 0) + 3;
    pdf.roundedRect(margin, top, contentW, blockH, 1.6, 1.6, 'FD');
    let yy = top + 4;
    font(9, 'bold'); pdf.setTextColor(...C.ink);
    pdf.text('Ownership stake', margin + 4, yy, { baseline: 'top' }); yy += 4.5;
    if (bits.length) {
      font(9, 'normal'); pdf.setTextColor(...C.text);
      pdf.text(bits.join(' · '), margin + 4, yy, { baseline: 'top' }); yy += 4;
    }
    if (evLines.length) {
      font(8.5, 'normal'); pdf.setTextColor(...C.muted);
      evLines.forEach((ln) => { pdf.text(ln, margin + 4, yy, { baseline: 'top' }); yy += 3.8; });
    }
    if (url) {
      font(7.5, 'normal'); pdf.setTextColor(...C.accentHover);
      pdf.text(truncateToWidth(url, contentW - 8), margin + 4, yy, { baseline: 'top' });
    }
    y = top + blockH + 3;
  }

  // ─── Acquisition History (chain-wide) ───
  const acqHistory = [];
  const walkChain = (n) => {
    if (n.acquisition && n.acquisition.acquired_by) {
      acqHistory.push({ node: n, acq: n.acquisition });
    }
    if (n.parent) walkChain(n.parent);
  };
  walkChain(tree);

  if (acqHistory.length > 0) {
    section('Acquisition History');
    acqHistory.sort((a, b) => (b.acq.year || 0) - (a.acq.year || 0));
    acqHistory.forEach(({ node, acq }) => {
      ensure(10);
      const yearStr = acq.year ? acq.year.toString() : 'date unknown';
      const dealTypeStr = acq.deal_type ? ` (${acq.deal_type.replace(/_/g, ' ')})` : '';
      const priceStr = acq.price_display ? ` for ${acq.price_display}` : (acq.price_usd ? ` for ${formatUSD(acq.price_usd)}` : '');
      font(9.5, 'bold'); pdf.setTextColor(...C.text);
      pdf.text(`${yearStr}: ${node.company} acquired by ${acq.acquired_by}${priceStr}${dealTypeStr}`, margin, y, { baseline: 'top' });
      y += 5;
      if (acq.price_confidence && acq.price_display) {
        pill(`confidence: ${acq.price_confidence}`, margin + 3, y, C.surface, C.muted);
        y += 5;
      }
    });
    y += 1;
  } else {
    // Fallback: show closed acquisition on focal only
    if (acq && acq.acquired_by) {
      section('Closed Acquisition');
      const yearStr = acq.year ? acq.year.toString() : 'date unknown';
      const dealTypeStr = acq.deal_type ? ` (${acq.deal_type.replace(/_/g, ' ')})` : '';
      const priceStr = acq.price_display ? ` for ${acq.price_display}` : (acq.price_usd ? ` for ${formatUSD(acq.price_usd)}` : '');
      text(`Acquired by ${acq.acquired_by} in ${yearStr}${priceStr}${dealTypeStr}`, { size: 10.5, style: 'bold', color: C.text, gap: 1.5 });
      if (acq.price_confidence && acq.price_display) {
        let px = margin; const py = y;
        px += pill(`price confidence: ${acq.price_confidence}`, px, py, C.surface, C.muted);
        y = py + 8;
      }
      if (acq.price_source_url && isSafeUrl(acq.price_source_url)) {
        text(acq.price_source_url, { size: 8, color: C.accentHover, gap: 1 });
      } else if (acq.source_url && isSafeUrl(acq.source_url)) {
        text(acq.source_url, { size: 8, color: C.accentHover, gap: 1 });
      }
    }
  }

  // ─── Pending acquisition callout ───
  if (pa && pa.acquirer) {
    section('Pending Acquisition');
    text(`Pending acquisition by ${pa.acquirer}`, { size: 11, style: 'bold', color: C.warning, gap: 1.5 });
    const meta = [];
    if (pa.announced_date) meta.push(`announced ${pa.announced_date}`);
    if (pa.expected_close_date) meta.push(`expected close ${pa.expected_close_date}`);
    if (pa.regulatory_status) meta.push(pa.regulatory_status);
    if (meta.length) text(meta.join(' · '), { size: 9, color: C.muted, gap: 1.5 });
    text('Parent & siblings shown reflect the current legal owner — not the post-close acquirer.',
      { size: 8.5, style: 'italic', color: C.muted, gap: 1.5 });
    const pcp = tree.post_close_consolidated_parent;
    if (pcp && pcp.company) {
      text(`Post-close consolidated parent: ${pcp.company}`, { size: 9, color: C.text, gap: 1 });
    }
    const fcp = Array.isArray(tree.future_cousins_post_close) ? tree.future_cousins_post_close : [];
    if (fcp.length) {
      const names = fcp.map((c) => c.company).filter(Boolean).join(', ');
      text(`Future cousins post-close: ${names}`, { size: 9, color: C.text, gap: 1 });
    }
    if (pa.source_url && isSafeUrl(pa.source_url)) {
      text(pa.source_url, { size: 8, color: C.accentHover, gap: 1 });
    }
  }

  // ─── Co-owners (focal + any siblings / cousins that declare them) ───
  const coOwnerEntities = [
    { node: tree, role: 'focal', parent: tree.parent },
    ...(tree.siblings || []).map((s) => ({ node: s, role: 'sibling', parent: tree.parent })),
    ...(Array.isArray(tree.intra_parent_cousins) ? tree.intra_parent_cousins : [])
      .map((c) => ({ node: c, role: 'cousin', parent: tree.parent })),
  ].filter(({ node }) => Array.isArray(node.co_owners) && node.co_owners.length > 0);

  if (coOwnerEntities.length > 0) {
    section('Co-owners');
    text('Additional formal owners beyond the consolidating parent (economic / voting stakes).',
      { size: 8.5, style: 'italic', color: C.muted, gap: 2.5 });
    coOwnerEntities.forEach(({ node, role, parent }, idx) => {
      ensure(14);
      if (idx > 0) y += 2;
      // Entity header (which node these co-owners apply to)
      font(10, 'bold'); pdf.setTextColor(...C.ink);
      pdf.text(truncateToWidth(node.company, contentW - 40), margin, y + 0.3, { baseline: 'top' });
      let lx = margin + pdf.getTextWidth(sanitize(node.company)) + 3;
      pill(role, lx, y - 0.2, role === 'focal' ? C.accentSoft : C.surface, role === 'focal' ? C.accentHover : C.muted);
      y += 6;
      if (parent?.company) {
        const roleText = node.ownership_role ? ` — ${node.ownership_role.replace(/_/g, ' ')}` : '';
        text(`Parent: ${parent.company}${roleText} (consolidates)`,
          { size: 9, style: 'bold', color: C.text, x: margin + 3, maxW: contentW - 6, gap: 1.5 });
      }
      const cos = node.co_owners;
      const coRows = cos.map((co) => {
        const bits = [];
        if (co.stake_pct != null) bits.push(`${co.stake_pct}% econ`);
        if (co.voting_pct != null) bits.push(`${co.voting_pct}% vote`);
        return [
          { text: co.company || '—', bold: true },
          co.ownership_role ? co.ownership_role.replace(/_/g, ' ') : '—',
          co.entity_type ? co.entity_type.replace(/_/g, ' ') : '—',
          bits.length ? bits.join(' · ') : '—',
        ];
      });
      table(['Co-owner', 'Role', 'Type', 'Stake'], coRows, [54, 52, 32, 40]);
      cos.forEach((co) => {
        if (!co.evidence) return;
        const label = co.company ? `${co.company}: ` : '';
        text(`${label}${co.evidence}`, { size: 8.5, color: C.muted, x: margin + 3, maxW: contentW - 6, gap: 1 });
        const srcs = Array.isArray(co.source_urls) ? co.source_urls.filter(isSafeUrl).slice(0, 2) : [];
        srcs.forEach((u) => text(u, { size: 7.5, color: C.accentHover, x: margin + 3, maxW: contentW - 6, gap: 0.5 }));
      });

      // Co-owner stake breakdown visualization
      const stakeData = [
        { name: parent?.company || 'Parent', econ: node.stake?.equity_pct, voting: node.stake?.voting_pct },
        ...cos.map((co) => ({ name: co.company, econ: co.stake_pct, voting: co.voting_pct })),
      ].filter((s) => s.econ != null || s.voting != null);

      if (stakeData.length > 1) {
        ensure(stakeData.length * 5 + 8);
        y += 2;
        font(9, 'bold'); pdf.setTextColor(...C.ink);
        pdf.text('Ownership Breakdown', margin + 3, y, { baseline: 'top' }); y += 5;

        const barMaxW = contentW * 0.6;
        const barH = 4;
        stakeData.forEach((s) => {
          ensure(barH + 2);
          const barY = y;
          let xPos = margin + 3;

          // Economic stake bar (solid)
          if (s.econ != null && s.econ > 0) {
            pdf.setFillColor(...C.accent);
            const w = (s.econ / 100) * barMaxW;
            pdf.rect(xPos, barY, w, barH, 'F');
          }

          // Voting stake bar (outline)
          if (s.voting != null && s.voting > 0) {
            const w = (s.voting / 100) * barMaxW;
            pdf.setDrawColor(...[180, 83, 9]); // warning orange
            pdf.setLineWidth(0.5);
            pdf.rect(xPos, barY, w, barH);
          }

          pdf.setDrawColor(...C.border); pdf.setLineWidth(0.2);
          pdf.rect(xPos, barY, barMaxW, barH);

          // Label
          const label = `${s.name} ${s.econ != null ? `(${s.econ}% econ` : ''}${s.voting != null ? `, ${s.voting}% voting)` : ')'}`;
          font(7.5, 'normal'); pdf.setTextColor(...C.muted);
          pdf.text(label, xPos + barMaxW + 3, barY + barH / 2 + 0.2, { baseline: 'middle' });

          y = barY + barH + 2;
        });
        y += 1;
      }
    });
  }

  // ─── Segments Panel (for aggregators/conglomerates) ───
  const parentSegments = tree.parent?.parent_anchor?.segments || tree.parent_anchor?.segments || [];
  if (parentSegments.length > 0) {
    section('Parent Business Segments');
    const parentName = tree.parent?.company || 'Parent';
    text(`${parentName}'s segments. Focal is${tree.focal_segment ? ` in "${tree.focal_segment}"` : ' not assigned to a specific segment'}.`,
      { size: 8.5, style: 'italic', color: C.muted, gap: 2 });
    // Task #41: denominator is the parent's consolidated total revenue, not
    // the sum of named segments (which excludes "other / eliminations" and
    // double-counts when segments overlap). Falls back to suppressing the
    // percent when the parent total is unknown.
    const parentAnchorForPdf = tree.parent?.parent_anchor || tree.parent_anchor || {};
    const parentTotal = parentAnchorForPdf.total_revenue_usd || 0;
    const segRows = parentSegments.map((seg) => {
      const rev = seg.revenue_usd && seg.revenue_usd > 0 ? formatUSD(seg.revenue_usd) : '—';
      const pctStr = parentTotal > 0 && seg.revenue_usd
        ? `${((seg.revenue_usd / parentTotal) * 100).toFixed(0)}%`
        : '—';
      const badge = seg.contains_focal ? { text: 'contains focal', color: C.activeFg, bold: true } : '—';
      return [
        seg.name || '—',
        rev,
        pctStr,
        badge,
      ];
    });
    if (segRows.length > 0) {
      table(['Segment', 'Revenue', '% of Parent', 'Contains Focal'], segRows, [50, 40, 28, 40]);
    }
  }

  // ─── Ownership Map (native vector diagram) ───
  // Note: chain and siblings are already defined earlier in Act 2 (Ownership Hierarchy)

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

  // ─── Ownership Chain Detail ───
  const chainWithFocal = [...chain, tree];
  const chainWithDetail = chainWithFocal.filter((n) => {
    const isRoot = n === chain[0];
    const hasStake = n.stake && (n.stake.equity_pct != null || n.stake.voting_pct != null) && !isRoot;
    const hasRole = n.ownership_role;
    return hasStake || hasRole;
  });
  if (chainWithDetail.length > 0) {
    section('Ownership Chain Detail', 14);
    text('Stake and control information for the ownership chain:', { size: 8.5, style: 'italic', color: C.muted, gap: 2 });
    chainWithDetail.forEach((n) => {
      ensure(8);
      font(9, 'bold'); pdf.setTextColor(...C.text);
      pdf.text(truncateToWidth(n.company, contentW - 30), margin, y + 0.3, { baseline: 'top' });
      y += 4.5;

      const bits = [];
      if (n.stake?.equity_pct != null) bits.push(`${n.stake.equity_pct}% equity`);
      if (n.stake?.voting_pct != null) bits.push(`${n.stake.voting_pct}% voting`);
      if (n.ownership_role) bits.push(`role: ${n.ownership_role}`);

      if (bits.length > 0) {
        font(8.5, 'normal'); pdf.setTextColor(...C.muted);
        pdf.text(bits.join(' · '), margin + 3, y, { baseline: 'top' });
        y += 4;
      }
    });
    y += 1;
  }

  // ─── Revenue Breakdown ───
  const breakdownRows = [tree, ...siblings].map((n) => {
    const st = deriveStatus(n).label;
    const [, fg] = statusColors(st);
    const rev = n.revenue_estimate;
    // Color-code by risk: requires_review=red, pending_acquisition=orange, normal=text
    let companyColor = C.text;
    if (n.requires_review) {
      companyColor = C.danger;
    } else if (n.pending_acquisition && n.pending_acquisition.acquirer) {
      companyColor = C.warning;
    }
    // Revenue range with central estimate. Task #42: when the sibling has
    // diverging bottom-up vs top-down sub-estimates the cell is bolded in
    // warning color; the per-sibling caveat is emitted as italic text below
    // the table (truncateToWidth here can't fit a multi-clause caveat).
    const revStr = rev && rev.central > 0
      ? `${formatUSD(rev.low)}–${formatUSD(rev.high)}${rev.central ? ` (${formatUSD(rev.central)})` : ''}`
      : '—';
    return [
      { text: n.company, bold: n === tree, color: companyColor },
      n.category || '—',
      rev && rev.divergence_flag ? { text: revStr, color: C.warning, bold: true } : revStr,
      (rev && rev.confidence) || '—',
      { text: st, color: fg, bold: true },
    ];
  });
  if (breakdownRows.length > 0) {
    section('Revenue Breakdown');
    transition(narr.transition_revenue);

    // Revenue cascade (parent → segment → focal) — ENHANCED visualization
    {
      const parentRev = tree.parent?.revenue_estimate?.central || 0;
      const segRev = (tree.parent?.parent_anchor?.segments || tree.parent_anchor?.segments || [])
        .find((s) => s.contains_focal)?.revenue_usd || 0;
      const focalRev = revEst.central || 0;
      const steps = [];
      if (parentRev > 0) steps.push({ label: tree.parent?.company || 'Parent', value: parentRev, col: C.ink, tier: 'PARENT' });
      if (segRev > 0) steps.push({ label: tree.focal_segment || 'Segment', value: segRev, col: C.accentHover, tier: 'SEGMENT' });
      if (focalRev > 0) steps.push({ label: focal, value: focalRev, col: C.accent, tier: 'FOCAL' });
      if (steps.length >= 2) {
        const maxV = steps[0].value;
        const barMaxW = contentW * 0.58, barH = 9;
        font(9, 'bold'); pdf.setTextColor(...C.ink);
        ensure(8 + steps.length * (barH + 4));
        pdf.text('Revenue Cascade', margin, y, { baseline: 'top' });
        font(7, 'normal'); pdf.setTextColor(...C.subtle);
        pdf.text('How focal revenue flows from parent total', margin, y + 4.5, { baseline: 'top' });
        y += 8;

        steps.forEach((s, i) => {
          ensure(barH + 4);
          const w = Math.max((s.value / maxV) * barMaxW, 2);
          const barY = y;

          // Connector line linking this bar to the one above
          if (i > 0) {
            pdf.setDrawColor(...[200, 200, 200]); pdf.setLineWidth(0.4);
            pdf.line(margin + 3, barY - 4, margin + 3, barY);
          }

          // Main bar
          pdf.setFillColor(...s.col);
          pdf.rect(margin, barY, w, barH, 'F');

          // Label inside the bar (white text, always legible on the colored fill).
          // Only render inside if the bar is wide enough to fit the text.
          font(8, 'bold'); pdf.setTextColor(...C.white);
          const labelStr = truncateToWidth(s.label, Math.max(w - 6, 10));
          const labelW = pdf.getTextWidth(labelStr);
          if (w > labelW + 5) {
            pdf.text(labelStr, margin + 3, barY + barH / 2 + 0.4, { baseline: 'middle' });
          } else {
            // Bar too narrow — place the label outside, after the value
            pdf.setTextColor(...s.col);
            pdf.text(truncateToWidth(s.label, 30), margin + w + 32, barY + barH / 2 + 0.4, { baseline: 'middle' });
          }

          // Value + percentage immediately to the right of the bar
          const pct = i === 0 ? '100%' : `${((s.value / maxV) * 100).toFixed(1)}%`;
          font(8, 'bold'); pdf.setTextColor(...C.text);
          pdf.text(formatUSD(s.value), margin + w + 3, barY + 3, { baseline: 'middle' });
          font(7, 'normal'); pdf.setTextColor(...C.subtle);
          pdf.text(`${s.tier} · ${pct}`, margin + w + 3, barY + 6.8, { baseline: 'middle' });

          y = barY + barH + 4;
        });
        y += 1;
      }
    }

    table(['Company', 'Category', 'Revenue (Range)', 'Conf.', 'Status'], breakdownRows, [46, 48, 45, 22, 32]);
    // Task #42: divergence caveats — mirror the UI's "circular — unverified"
    // styling (italic warning text after the table) when any sibling's
    // bottom-up vs top-down estimates disagree by >30%.
    const divergent = [tree, ...siblings].filter((n) => {
      const r = n.revenue_estimate;
      return r && r.divergence_flag && r.bottom_up && r.top_down;
    });
    divergent.forEach((n) => {
      const r = n.revenue_estimate;
      text(
        `⚠ ${n.company}: bottom-up ${formatUSD(r.bottom_up.central)} vs top-down ${formatUSD(r.top_down.central)} disagree by ${r.divergence_pct}% — treat the range as the source of truth, not either single number.`,
        { size: 8.5, style: 'italic', color: C.warning, maxW: contentW, gap: 1.5 }
      );
    });

    // Confidence distribution chart (stacked bar for top 4)
    {
      const entities = [tree, ...siblings].slice(0, 4);
      const confData = entities.map((n) => {
        const rev = n.revenue_estimate || {};
        const conf = rev.confidence || 'unknown';
        return { company: n.company, confidence: conf };
      });
      const confCounts = { high: 0, medium: 0, low: 0, unknown: 0 };
      confData.forEach((d) => {
        const key = d.confidence === 'high' ? 'high' : d.confidence === 'medium' ? 'medium' : d.confidence === 'low' ? 'low' : 'unknown';
        confCounts[key]++;
      });

      if (confData.some((d) => d.confidence !== 'unknown')) {
        ensure(20);
        y += 2;
        font(9, 'bold'); pdf.setTextColor(...C.ink);
        const chartLabel = [tree, ...siblings].length > 4 ? `Revenue Confidence Distribution (top 4)` : `Revenue Confidence Distribution`;
        pdf.text(chartLabel, margin, y, { baseline: 'top' }); y += 5;

        // Draw horizontal stacked bar
        const barY = y;
        const barW = contentW * 0.6;
        const barH = 8;
        const total = confData.length;
        let xPos = margin;

        pdf.setFillColor(...[34, 197, 94]); // green for high
        const highW = (confCounts.high / total) * barW;
        pdf.rect(xPos, barY, highW, barH, 'F');
        xPos += highW;

        pdf.setFillColor(...[234, 179, 8]); // yellow for medium
        const medW = (confCounts.medium / total) * barW;
        pdf.rect(xPos, barY, medW, barH, 'F');
        xPos += medW;

        pdf.setFillColor(...[239, 68, 68]); // red for low
        const lowW = (confCounts.low / total) * barW;
        pdf.rect(xPos, barY, lowW, barH, 'F');
        xPos += lowW;

        if (confCounts.unknown > 0) {
          pdf.setFillColor(...C.border);
          pdf.rect(xPos, barY, barW - xPos + margin, barH, 'F');
        }

        pdf.setDrawColor(...C.border); pdf.setLineWidth(0.3);
        pdf.rect(margin, barY, barW, barH);

        y = barY + barH + 3;

        // Legend
        font(7.5, 'normal');
        let legX = margin;
        const legY = y;
        [
          { label: `High (${confCounts.high})`, color: [34, 197, 94] },
          { label: `Medium (${confCounts.medium})`, color: [234, 179, 8] },
          { label: `Low (${confCounts.low})`, color: [239, 68, 68] },
        ].forEach(({ label, color }) => {
          pdf.setFillColor(...color);
          pdf.rect(legX, legY, 3, 3, 'F');
          pdf.setTextColor(...C.text);
          pdf.text(label, legX + 5, legY + 0.3, { baseline: 'top' });
          legX += pdf.getTextWidth(label) + 12;
        });
        y += 5;
      }
    }

    // Sibling ranking bar chart — ENHANCED visualization
    if (siblings.length > 0) {
      ensure(Math.min(32, 8 + siblings.length * 6));
      y += 2;
      font(9, 'bold'); pdf.setTextColor(...C.ink);
      pdf.text('Sibling Revenue Ranking', margin, y, { baseline: 'top' });
      font(7, 'normal'); pdf.setTextColor(...C.subtle);
      pdf.text(`Focal vs. ${siblings.length} other brand${siblings.length !== 1 ? 's' : ''} in segment`, margin, y + 4.5, { baseline: 'top' });
      y += 8;

      const ranked = [{ company: tree.company, central: tree.revenue_estimate?.central || 0, isFocal: true },
        ...siblings.map((s) => ({ company: s.company, central: s.revenue_estimate?.central || 0, isFocal: false }))]
        .sort((a, b) => b.central - a.central);

      // Scale by siblings max (not focal) so sibling bars are visible; the focal
      // is clamped to full width when it out-earns every sibling.
      const maxRevenue = Math.max(...siblings.map((s) => s.revenue_estimate?.central || 0), 1);
      const barH = 7;
      const labelW = 8;                       // gutter for the #-rank badge
      const valueW = 26;                      // fixed column for the value
      const barAreaX = margin + labelW;
      const barMaxW = contentW - labelW - valueW;

      ranked.forEach((r, i) => {
        ensure(barH + 2);
        const barW = Math.min((r.central / maxRevenue) * barMaxW, barMaxW);
        const rankY = y;

        // Rank badge (kept inside the content area, left gutter)
        font(7.5, 'bold');
        pdf.setTextColor(...(r.isFocal ? C.accent : C.muted));
        pdf.text(`#${i + 1}`, margin, rankY + barH / 2 + 0.3, { baseline: 'middle' });

        // Bar
        pdf.setFillColor(...(r.isFocal ? C.accent : C.surface));
        if (barW > 0.5) pdf.rect(barAreaX, rankY, barW, barH, 'F');

        // Border
        pdf.setDrawColor(...(r.isFocal ? C.accentHover : C.border));
        pdf.setLineWidth(r.isFocal ? 0.5 : 0.25);
        if (barW > 0.5) pdf.rect(barAreaX, rankY, barW, barH);

        // Highlight stripe on focal bar (solid lighter teal — never a 4-arg/CMYK
        // fill, which jsPDF mis-renders as red).
        if (r.isFocal && barW > 4) {
          pdf.setFillColor(...C.accentHover);
          pdf.rect(barAreaX, rankY, barW, barH * 0.28, 'F');
        }

        // Company label: inside the bar when it fits, otherwise just past it.
        const companyText = truncateToWidth(r.company, 34);
        font(8, r.isFocal ? 'bold' : 'normal');
        const txtW = pdf.getTextWidth(companyText);
        if (barW > txtW + 5) {
          pdf.setTextColor(...(r.isFocal ? C.white : C.ink));
          pdf.text(companyText, barAreaX + 3, rankY + barH / 2 + 0.3, { baseline: 'middle' });
        } else {
          pdf.setTextColor(...C.ink);
          pdf.text(companyText, barAreaX + barW + 2, rankY + barH / 2 + 0.3, { baseline: 'middle' });
        }

        // Value in the fixed right column (never overlaps the bar/label)
        const valueStr = r.central > 0 ? formatUSD(r.central) : '—';
        font(7.5, r.isFocal ? 'bold' : 'normal');
        pdf.setTextColor(...(r.isFocal ? C.accent : C.muted));
        pdf.text(valueStr, margin + contentW, rankY + barH / 2 + 0.3, { align: 'right', baseline: 'middle' });

        y = rankY + barH + 2;
      });
      y += 2;
    }
  }

  // ─── Cousins (same parent, other divisions) ───
  const cousins = Array.isArray(tree.intra_parent_cousins) ? tree.intra_parent_cousins : [];
  if (cousins.length > 0) {
    section('Cousins (same parent, other divisions)');
    const parentLabel = tree.parent?.company ? ` of ${tree.parent.company}` : '';
    text(`${cousins.length} brand${cousins.length === 1 ? '' : 's'}${parentLabel} sitting in a different division than ${focal}.`,
      { size: 8.5, style: 'italic', color: C.muted, gap: 2 });
    const cousinGroups = new Map();
    cousins.forEach((c) => {
      const k = c.via_division || 'Other division';
      if (!cousinGroups.has(k)) cousinGroups.set(k, []);
      cousinGroups.get(k).push(c);
    });
    for (const [division, items] of cousinGroups) {
      const spaceNeeded = 4 + 5 + (items.length * 5);
      ensure(spaceNeeded);
      text(`via division: ${division}`, { size: 9, style: 'bold', color: C.text, gap: 1.2 });
      const rows = items.map((c) => {
        const st = deriveStatus(c).label;
        const [, fg] = statusColors(st);
        const rev = c.revenue_estimate;
        let companyColor = C.text;
        if (c.requires_review) {
          companyColor = C.danger;
        } else if (c.pending_acquisition && c.pending_acquisition.acquirer) {
          companyColor = C.warning;
        }
        return [
          { text: c.company || '—', color: companyColor },
          c.category || '—',
          (rev && rev.central > 0) ? formatUSD(rev.central) : '—',
          (rev && rev.confidence) || '—',
          { text: st, color: fg, bold: true },
        ];
      });
      table(['Cousin', 'Category', 'Revenue', 'Conf.', 'Status'], rows, [46, 48, 30, 22, 32]);
    }
  }

  // ─── Positioning Analysis ───
  if (positioning.focal_vs_parent_ratio || siblings.length > 0 || positioning.growth_signals) {
    section('Positioning Analysis');
    transition(narr.transition_positioning);
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

  // ─── Act 5 — The verdict (risk grade, moved here as the story's climax) ───
  renderRiskVerdict();

  // ─── Act 6 — The bottom line ("so what" for the investor) ───
  if (narr.bottom_line) {
    font(11, 'bold');
    const blLines = pdf.splitTextToSize(sanitize(narr.bottom_line), contentW - 12);
    const blH = 9 + blLines.length * 5 + 4;
    ensure(blH + 4);
    y += 2;
    const blY = y;
    pdf.setFillColor(...C.ink);
    pdf.roundedRect(margin, blY, contentW, blH, 2.5, 2.5, 'F');
    pdf.setFillColor(...C.accent);
    pdf.rect(margin, blY, 2.5, blH, 'F');
    font(7, 'bold'); pdf.setTextColor(...C.accent);
    pdf.text('THE BOTTOM LINE', margin + 7, blY + 6, { baseline: 'middle' });
    font(10.5, 'normal'); pdf.setTextColor(...C.white);
    let bly = blY + 12;
    blLines.forEach((ln) => { pdf.text(ln, margin + 7, bly, { baseline: 'top' }); bly += 5; });
    y = blY + blH + 4;
  }

  // ─── Strategic Notes ───
  // Mirror the in-app notes panel so PDF readers don't lose plain-language
  // context (prior-JV history, chain-normalization, reconciliation explanations).
  // Warning-style entries (leading "⚠") get an amber accent; neutral entries
  // get muted text — same visual treatment as the in-app banners/notes panel.
  {
    const rawNotes = Array.isArray(positioning.strategic_notes)
      ? positioning.strategic_notes
      : [positioning.strategic_notes].filter(Boolean);
    const notes = rawNotes.filter((n) => n && n !== 'No distinctive structural signals captured.');
    if (notes.length > 0) {
      section('Strategic Notes');
      notes.forEach((n) => {
        const isWarn = typeof n === 'string' && n.startsWith('⚠');
        const body = isWarn ? n.replace(/^⚠\s*/, '') : n;
        if (isWarn) {
          // Amber accent strip + warn-tinted background, matching the in-app banner.
          const size = 9.5, lineH = size * 0.42;
          const lines = pdf.splitTextToSize(sanitize(body), contentW - 8);
          const boxH = lines.length * lineH + 4;
          ensure(boxH + 2);
          const boxY = y;
          pdf.setFillColor(...C.warnBg);
          pdf.rect(margin, boxY, contentW, boxH, 'F');
          pdf.setFillColor(...C.warning);
          pdf.rect(margin, boxY, 1.6, boxH, 'F');
          font(size, 'normal'); pdf.setTextColor(...C.warning);
          let ty = boxY + 2;
          lines.forEach((ln) => { pdf.text(ln, margin + 5, ty, { baseline: 'top' }); ty += lineH; });
          y = boxY + boxH + 2;
        } else {
          text(`· ${body}`, { size: 9.5, color: C.muted, gap: 1.5 });
        }
      });
    }
  }

  // ─── Revenue Consistency Alerts ───
  const reviewNodes = [
    { node: tree, role: 'focal' },
    ...siblings.map((s) => ({ node: s, role: 'sibling' })),
    ...(Array.isArray(tree.intra_parent_cousins) ? tree.intra_parent_cousins : [])
      .map((c) => ({ node: c, role: 'cousin' })),
  ].filter(({ node }) => node.requires_review);

  if (reviewNodes.length > 0) {
    section('Revenue Consistency Alerts', 20);
    text('The following entities have potential revenue inconsistencies that require review:',
      { size: 8.5, style: 'italic', color: C.muted, gap: 2 });
    reviewNodes.forEach(({ node, role }) => {
      ensure(10);
      font(10, 'bold'); pdf.setTextColor(...C.danger);
      pdf.text(truncateToWidth(node.company, contentW - 30), margin, y + 0.3, { baseline: 'top' });
      let lx = margin + pdf.getTextWidth(sanitize(node.company)) + 3;
      pill('review', lx, y - 0.2, C.dangerBg, C.danger);
      y += 6;
      if (node.revenue_review_reason) {
        text(node.revenue_review_reason, { size: 9, color: C.text, x: margin + 3, maxW: contentW - 6, gap: 1.5 });
      } else {
        text('Revenue estimate may exceed parent or violate hierarchy constraints.', { size: 9, color: C.muted, x: margin + 3, maxW: contentW - 6, gap: 1.5 });
      }
    });
  }

  // ─── Reconciliation (+ explanation) ───
  if (recon) {
    section('Reconciliation');
    text(
      `Focal + siblings ${formatUSD(recon.sum_children_central)} vs ${formatUSD(recon.parent_benchmark)} (${recon.parent_benchmark_label || recon.parent_benchmark_source}). Coverage ${(recon.ratio * 100).toFixed(0)}%, delta ${recon.pct_delta > 0 ? '+' : ''}${recon.pct_delta}%.`,
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

    // Coverage percentage label on bar
    const coveragePct = (recon.ratio * 100).toFixed(0);
    font(7.5, 'bold'); pdf.setTextColor(...(recon.ratio > 1.5 || recon.ratio < 0.5 ? C.white : C.white));
    const filledW = (clamped / 2) * barW;
    const labelX = Math.min(margin + filledW - 1, margin + barW - 12);
    pdf.text(`${coveragePct}%`, labelX, btop + barH / 2 + 0.1, { baseline: 'middle', align: 'right' });

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

  // ─── Divestiture Timeline ───
  const divestitureNodes = [
    { node: tree, role: 'focal' },
    ...siblings.map((s) => ({ node: s, role: 'sibling' })),
    ...cousins.map((c) => ({ node: c, role: 'cousin' })),
  ].filter(({ node }) => node._divestiture || deriveDivestiture(node));

  if (divestitureNodes.length > 0) {
    section('Divestitures');
    text('Entities that are being divested or have divesting status:', { size: 8.5, style: 'italic', color: C.muted, gap: 2 });
    divestitureNodes.forEach(({ node, role }) => {
      ensure(8);
      font(10, 'bold'); pdf.setTextColor(...C.ink);
      pdf.text(truncateToWidth(node.company, contentW - 40), margin, y + 0.3, { baseline: 'top' });
      let lx = margin + pdf.getTextWidth(sanitize(node.company)) + 3;
      pill(role, lx, y - 0.2, C.surface, C.muted);
      y += 5;

      const bits = [];
      if (node.divest_announcement_date) bits.push(`announced ${node.divest_announcement_date}`);
      if (node.expected_divest_close) bits.push(`expected close ${node.expected_divest_close}`);
      if (bits.length > 0) {
        font(8.5, 'normal'); pdf.setTextColor(...C.muted);
        pdf.text(bits.join(' · '), margin + 3, y, { baseline: 'top' });
        y += 4;
      }
      if (node.divest_reason) {
        font(8.5, 'normal'); pdf.setTextColor(...C.text);
        pdf.text(node.divest_reason, margin + 3, y, { baseline: 'top', maxW: contentW - 6 });
        y += 4;
      }
    });
    y += 1;
  }

  // ─── Signals Evidence (per-entity revenue signals) — Matrix view ───
  const signalEntries = [
    { node: tree, role: 'focal' },
    ...siblings.map((s) => ({ node: s, role: 'sibling' })),
    ...cousins.map((c) => ({ node: c, role: 'cousin' })),
  ].filter(({ node }) => Array.isArray(node.signals_found) && node.signals_found.length > 0);
  if (signalEntries.length > 0) {
    section('Signals Evidence');
    text('Signal types found per entity. ✓ = signal present; confidence ranked by weight distribution.',
      { size: 8.5, style: 'italic', color: C.muted, gap: 2.5 });

    // Build signal type matrix: collect all unique types across all entities
    const allTypes = new Set();
    signalEntries.forEach(({ node }) => {
      (node.signals_found || []).forEach((s) => { if (s.type) allTypes.add(s.type); });
    });
    const sortedTypes = Array.from(allTypes).sort();

    // Build matrix rows: one per entity
    ensure(signalEntries.length * 5 + 12);
    const colW = 11;  // narrow columns for signal type checkmarks
    const entityColW = 45;

    // Header row: entity names + signal type columns
    let hx = margin;
    font(8, 'bold'); pdf.setTextColor(...C.ink);
    pdf.text('Entity', hx, y, { baseline: 'top' });
    hx += entityColW;

    // Column headers (signal types, abbreviated)
    const typeAbbrev = {
      'press': 'Press',
      'pricing': 'Price',
      'hiring': 'Hire',
      'reviews': 'Rev',
      'funding': 'Fund',
      'customers': 'Cust',
      'marketplace': 'Market',
      'web_traffic': 'Traffic',
      'other': 'Other',
    };
    font(6.5, 'bold'); pdf.setTextColor(...C.muted);
    sortedTypes.forEach((type) => {
      const abbr = typeAbbrev[type] || type.slice(0, 4);
      pdf.text(abbr, hx, y, { align: 'center', baseline: 'top' });
      hx += colW;
    });
    y += 5;

    // Data rows: one per entity
    signalEntries.forEach(({ node, role }) => {
      let rx = margin;

      // Entity name + role pill
      font(8.5, 'normal'); pdf.setTextColor(...C.ink);
      const label = truncateToWidth(node.company, entityColW - 15);
      pdf.text(label, rx, y + 0.5, { baseline: 'top' });
      let px = rx + entityColW - 12;
      pill(role === 'focal' ? 'F' : role === 'sibling' ? 'S' : 'C', px, y - 0.5,
        role === 'focal' ? C.accentSoft : C.surface,
        role === 'focal' ? C.accentHover : C.muted);
      rx += entityColW;

      // Signal type cells (checkmarks)
      const typeCounts = {};
      (node.signals_found || []).forEach((s) => {
        if (s.type) typeCounts[s.type] = (typeCounts[s.type] || 0) + 1;
      });

      sortedTypes.forEach((type) => {
        if (typeCounts[type]) {
          font(8, 'bold'); pdf.setTextColor(...C.activeFg);
          pdf.text('✓', rx + colW / 2, y + 0.5, { align: 'center', baseline: 'top' });
        }
        rx += colW;
      });

      y += 4;
    });

    // Legend under matrix
    y += 1;
    font(7, 'normal'); pdf.setTextColor(...C.muted);
    pdf.text('F = focal  S = sibling  C = cousin', margin, y, { baseline: 'top' });
  }

  // ─── Legend (reference) ───
  section('Legend & Reference');
  text('Status indicators:', { size: 9, style: 'bold', color: C.ink, gap: 1 });
  [
    { label: 'active', desc: 'currently operating' },
    { label: 'legacy', desc: 'no longer active but historically significant' },
    { label: 'discontinued', desc: 'ceased operations' },
    { label: 'divesting', desc: 'in the process of being divested' },
  ].forEach(({ label, desc }) => {
    const [bg, fg] = statusColors(label);
    ensure(4);
    let px = margin;
    px += pill(label, px, y, bg, fg) + 3;
    font(8.5, 'normal'); pdf.setTextColor(...C.text);
    pdf.text(desc, px, y + 1.2, { baseline: 'top' });
    y += 5;
  });

  y += 2;
  text('Revenue confidence levels:', { size: 9, style: 'bold', color: C.ink, gap: 1 });
  [
    { level: 'High', desc: 'Public disclosure, audited, or multiple strong sources' },
    { level: 'Medium', desc: 'Solid secondary sources, employee counts, funding data' },
    { level: 'Low', desc: 'Estimates, extrapolations, single-source signals' },
  ].forEach(({ level, desc }) => {
    ensure(4);
    font(8.5, 'bold'); pdf.setTextColor(...C.text);
    pdf.text(`${level}: `, margin, y, { baseline: 'top' });
    font(8.5, 'normal'); pdf.setTextColor(...C.muted);
    pdf.text(desc, margin + 25, y, { baseline: 'top', maxW: contentW - 25 });
    y += 4;
  });

  y += 2;
  text('Special badges & indicators:', { size: 9, style: 'bold', color: C.ink, gap: 1 });
  [
    { badge: 'review', desc: 'Revenue estimate may exceed parent or have hierarchy conflicts; verify with additional sources' },
    { badge: 'PE-owned', desc: 'Backed by private equity firm' },
    { badge: 'Pending Acquisition', desc: 'Deal announced but not yet closed; awaiting regulatory approval' },
    { badge: 'context unverified', desc: 'Some ownership layers lack independent confirmation; treat with caution' },
  ].forEach(({ badge, desc }) => {
    ensure(4);
    font(8.5, 'bold'); pdf.setTextColor(...C.text);
    pdf.text(`${badge}: `, margin, y, { baseline: 'top' });
    font(8.5, 'normal'); pdf.setTextColor(...C.muted);
    pdf.text(desc, margin + 50, y, { baseline: 'top', maxW: contentW - 50 });
    y += 4;
  });

  y += 2;
  text('Reconciliation coverage ratio:', { size: 9, style: 'bold', color: C.ink, gap: 1 });
  ensure(10);
  font(8.5, 'normal'); pdf.setTextColor(...C.text);
  pdf.text('0× = no children revenue; 1.0× = children sum equals parent; 2.0×+ = children exceed parent.', margin, y, { baseline: 'top', maxW: contentW });
  y += 4;
  pdf.text('Gaps above 1.0× indicate unreported segments or divisions not in this report.', margin, y, { baseline: 'top', maxW: contentW });
  y += 4;

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
