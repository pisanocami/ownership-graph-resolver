# Ownership & Revenue Agent

Single-page agent that, given a brand, returns a unified competitive positioning report: the corporate ownership tree (parent → root, siblings, children, strategic control) with a revenue estimate attached to each entity, plus a positioning read on the focal company.

## Stack
- React 18 + Vite
- Express proxy server (CORS bypass for Anthropic API)
- Claude Sonnet 4 with `web_search` tool

## Pipeline
1. **Ownership resolution** — single LLM call with the ownership system prompt (depth/fan-out capped to 2–3 generations) returning the tree.
2. **Revenue inference (parallel)** — one LLM call per entity (focal + parent chain + capped siblings/children), each limited to 4 web searches, using the revenue inference prompt.
3. **Synthesis** — deterministic local merge. Positioning math (focal-vs-parent ratio, sibling ranking) is mechanical; doing it locally avoids a third LLM call, its token cost, and JSON-parse risk.

## Setup
```bash
npm install
cp .env.example .env   # then put your real key in ANTHROPIC_API_KEY
```

## Run
The Replit workflow `Project` starts both processes (`Backend` on :3002 and `Start application` / Vite on :5000). Locally:
```bash
npm run server   # Express proxy on :3002
npm run dev      # Vite on :5000
```
Open http://localhost:5000/

## Files
- `app.jsx` — integrated agent UI (3-phase pipeline + result view)
- `server.js` — Express proxy at `:3002`
- `main.jsx` — React entry point
