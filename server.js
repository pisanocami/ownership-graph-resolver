import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = parseInt(process.env.PORT || '3002', 10);

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const API_KEY = process.env.ANTHROPIC_API_KEY || process.env.VITE_ANTHROPIC_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
if (!API_KEY) console.warn('WARN: ANTHROPIC_API_KEY not set — Claude provider will be unavailable.');
if (!GEMINI_API_KEY) console.warn('WARN: GEMINI_API_KEY not set — Gemini provider will be unavailable.');

app.post('/api/anthropic', async (req, res) => {
  if (!API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set on server.' });
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: errorText });
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/gemini', async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not set on server.' });
  try {
    const { model, ...body } = req.body || {};
    if (!model) return res.status(400).json({ error: 'model required' });
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: errorText });
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Investigation persistence ───────────────────────────────────────────────
// Lightweight JSON-file store. Each investigation stored under a stable id
// derived from brand+hint so re-opening is instant and dedupes by default.

const DATA_DIR = path.join(__dirname, '.data');
const STORE_PATH = path.join(DATA_DIR, 'investigations.json');

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_PATH)) fs.writeFileSync(STORE_PATH, '[]', 'utf8');
}

function readStore() {
  ensureStore();
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStore(items) {
  ensureStore();
  fs.writeFileSync(STORE_PATH, JSON.stringify(items, null, 2), 'utf8');
}

function cacheKey(brand, hint) {
  return `${(brand || '').toLowerCase().trim()}::${(hint || '').toLowerCase().trim()}`;
}

function summarize(item) {
  const tree = item.result?.ownership_tree || {};
  const rev = tree.revenue_estimate || {};
  return {
    id: item.id,
    brand: item.brand,
    hint: item.hint,
    createdAt: item.createdAt,
    focal_company: item.result?.focal_company || tree.company || item.brand,
    central: rev.central ?? null,
    confidence: rev.confidence || null,
  };
}

app.get('/api/investigations', (_req, res) => {
  const items = readStore();
  res.json(items.map(summarize).sort((a, b) => b.createdAt - a.createdAt));
});

app.get('/api/investigations/lookup', (req, res) => {
  const { brand, hint } = req.query;
  if (!brand) return res.status(400).json({ error: 'brand required' });
  const key = cacheKey(brand, hint || '');
  const items = readStore();
  const hit = items.find((it) => cacheKey(it.brand, it.hint) === key);
  if (!hit) return res.status(404).json({ error: 'not found' });
  res.json(hit);
});

app.get('/api/investigations/:id', (req, res) => {
  const items = readStore();
  const hit = items.find((it) => it.id === req.params.id);
  if (!hit) return res.status(404).json({ error: 'not found' });
  res.json(hit);
});

app.post('/api/investigations', (req, res) => {
  const { brand, hint, result } = req.body || {};
  if (!brand || !result) return res.status(400).json({ error: 'brand and result required' });
  const items = readStore();
  const key = cacheKey(brand, hint || '');
  const existingIdx = items.findIndex((it) => cacheKey(it.brand, it.hint) === key);
  const id = existingIdx >= 0 ? items[existingIdx].id : crypto.randomBytes(6).toString('hex');
  const record = {
    id,
    brand: brand.trim(),
    hint: (hint || '').trim(),
    createdAt: Date.now(),
    result,
  };
  if (existingIdx >= 0) items[existingIdx] = record;
  else items.push(record);
  writeStore(items);
  res.json({ id, createdAt: record.createdAt });
});

app.delete('/api/investigations/:id', (req, res) => {
  const items = readStore();
  const next = items.filter((it) => it.id !== req.params.id);
  if (next.length === items.length) return res.status(404).json({ error: 'not found' });
  writeStore(next);
  res.json({ ok: true });
});

const distDir = path.join(__dirname, 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
