# Ownership Graph Resolver

Resolve corporate ownership chains via Claude AI with live web search. Identifies parent companies, subsidiaries, and brand relationships with verified sources.

## Stack
- React 18 + Vite
- React Flow (interactive ownership diagram)
- Express proxy server (CORS bypass for Anthropic API)
- Claude Sonnet 4 with `web_search` tool

## Setup

```bash
npm install
```

Create a `.env` file:

```
VITE_ANTHROPIC_API_KEY=sk-ant-your-key-here
```

Edit `server.js` and replace `API_KEY` with your Anthropic API key.

## Run

Two terminals:

```bash
# Terminal 1 - backend proxy
npm run server

# Terminal 2 - frontend dev server
npm run dev
```

Open http://localhost:5173/

## Features
- Ownership chain resolution (parent → root)
- Siblings and children detection
- Source verification with Tier A/B/C confidence scoring
- Disambiguation handling for ambiguous entities
- Two view modes: **List** (vertical chain cards) and **Graph** (interactive React Flow diagram)
- Live agent logs panel

## Architecture
- `app.jsx` — Main React component (`OwnershipResolver`)
- `server.js` — Express proxy at `:3002`
- `main.jsx` — React entry point
- System prompts: full + compact retry fallback for JSON parsing failures
