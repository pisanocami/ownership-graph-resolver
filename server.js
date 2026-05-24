import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import crypto from 'node:crypto';

const app = express();
const PORT = 3002;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ─── Investigations store (file-backed) ───────────────────────────────────────
const DATA_FILE = '.data/investigations.json';
function loadInvestigations() {
  try {
    if (!existsSync(DATA_FILE)) return [];
    const raw = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch (e) {
    console.error('Failed to load investigations:', e.message);
    return [];
  }
}
function saveInvestigations(items) {
  try {
    if (!existsSync(dirname(DATA_FILE))) mkdirSync(dirname(DATA_FILE), { recursive: true });
    writeFileSync(DATA_FILE, JSON.stringify(items, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save investigations:', e.message);
    throw e;
  }
}
function norm(s) { return String(s || '').toLowerCase().trim(); }

app.get('/api/investigations', (_req, res) => {
  const items = loadInvestigations();
  res.json(items.map(({ id, brand, hint, createdAt }) => ({ id, brand, hint, createdAt })));
});

app.get('/api/investigations/lookup', (req, res) => {
  const brand = norm(req.query.brand);
  const hint = norm(req.query.hint);
  if (!brand) return res.status(400).json({ error: 'brand required' });
  const items = loadInvestigations();
  const match = items
    .filter((it) => norm(it.brand) === brand && norm(it.hint) === hint)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
  if (!match) return res.status(404).json({ error: 'not found' });
  res.json(match);
});

app.get('/api/investigations/:id', (req, res) => {
  const items = loadInvestigations();
  const item = items.find((it) => it.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  res.json(item);
});

app.post('/api/investigations', (req, res) => {
  const { brand, hint, result } = req.body || {};
  if (!brand || !result) return res.status(400).json({ error: 'brand and result required' });
  const items = loadInvestigations();
  const record = {
    id: crypto.randomBytes(6).toString('hex'),
    brand: String(brand),
    hint: String(hint || ''),
    createdAt: Date.now(),
    result,
  };
  items.unshift(record);
  saveInvestigations(items);
  res.json({ id: record.id, createdAt: record.createdAt });
});

app.delete('/api/investigations/:id', (req, res) => {
  const items = loadInvestigations();
  const next = items.filter((it) => it.id !== req.params.id);
  saveInvestigations(next);
  res.json({ ok: true });
});

const API_KEY = process.env.ANTHROPIC_API_KEY || process.env.VITE_ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error('ERROR: ANTHROPIC_API_KEY not set in .env');
  process.exit(1);
}

app.post('/api/anthropic', async (req, res) => {
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

app.listen(PORT, () => {
  console.log(`Proxy server running on http://localhost:${PORT}`);
});
