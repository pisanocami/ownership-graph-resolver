// Signal-level cache (Ticket #59 v2, Stream D2 — NEW.36/37/38).
//
// Persists captured signals at the (entity_id, signal_label) grain so that a
// family member surfaced in run 1 (Chuck Vogel) or a revenue anchor found once
// (Awara → Grips Intelligence) is RETAINED in later runs even when the model
// does not re-surface it. Subsequent runs use cached signals + supplement with
// new searches, deduped by signal_label.
//
// Browser-safe: the core store is an in-memory Map with optional localStorage
// persistence (same approach as createRevenueCache). Node file persistence is
// exposed as async load/flush helpers so it never pulls `node:fs` into the
// browser bundle.

const normKey = (entityId, label) => `${String(entityId || '').toLowerCase().trim()}::${String(label || '').toLowerCase().trim()}`;

/**
 * @typedef {Object} CachedSignal
 * @property {string} entity_id
 * @property {string} signal_label   e.g. "Awara 2024 DTC revenue"
 * @property {string} [signal_type]
 * @property {string} [evidence_value]
 * @property {string} [source]
 * @property {'high'|'medium'|'low'} [weight]
 * @property {number} [captured_at]
 * @property {string} [captured_in_run_id]
 */

export function createSignalCache(options = {}) {
  const {
    persist = false,
    storageKey = 'ogr_signal_cache_v1',
    ttlMs = 0, // 0 = never auto-expire (open-question #2: mark, don't expire)
  } = options;
  const store = new Map(); // key → CachedSignal
  const ls = persist && typeof localStorage !== 'undefined' ? localStorage : null;

  if (ls) {
    try {
      const raw = ls.getItem(storageKey);
      if (raw) {
        const now = Date.now();
        Object.entries(JSON.parse(raw)).forEach(([k, sig]) => {
          if (!ttlMs || !sig.captured_at || now - sig.captured_at < ttlMs) store.set(k, sig);
        });
      }
    } catch (_e) { /* corrupt cache — start clean */ }
  }

  const flush = () => {
    if (!ls) return;
    try {
      const obj = {};
      store.forEach((v, k) => { obj[k] = v; });
      ls.setItem(storageKey, JSON.stringify(obj));
    } catch (_e) { /* quota — non-fatal */ }
  };

  const set = (signal) => {
    if (!signal || !signal.entity_id || !signal.signal_label) return signal;
    const entry = { captured_at: Date.now(), ...signal };
    store.set(normKey(signal.entity_id, signal.signal_label), entry);
    flush();
    return entry;
  };

  const getByEntity = (entityId) => {
    const prefix = `${String(entityId || '').toLowerCase().trim()}::`;
    const out = [];
    store.forEach((v, k) => { if (k.startsWith(prefix)) out.push(v); });
    return out;
  };

  return {
    has: (entityId, label) => store.has(normKey(entityId, label)),
    get: (entityId, label) => store.get(normKey(entityId, label)),
    getByEntity,
    set,
    setMany: (signals) => (signals || []).map(set),
    size: () => store.size,
    clear: () => { store.clear(); if (ls) { try { ls.removeItem(storageKey); } catch (_e) { /* ignore */ } } },
    snapshot: () => Object.fromEntries(store),

    // Node-only persistence. Lazy-imports node:fs so the browser bundle is clean.
    async loadFromFile(filePath) {
      const fs = await import('node:fs');
      if (!fs.existsSync(filePath)) return 0;
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      let n = 0;
      const now = Date.now();
      Object.entries(parsed).forEach(([k, sig]) => {
        if (!ttlMs || !sig.captured_at || now - sig.captured_at < ttlMs) { store.set(k, sig); n++; }
      });
      return n;
    },
    async flushToFile(filePath) {
      const fs = await import('node:fs');
      fs.writeFileSync(filePath, JSON.stringify(Object.fromEntries(store), null, 2));
      return store.size;
    },
  };
}

// Merge cached signals with freshly-searched ones, deduped by `dedupBy`
// (default signal_label). Fresh entries win on conflict (newer evidence), but a
// cached signal with no fresh counterpart is always retained — that is the
// retention guarantee (NEW.37/38).
export function mergeSignals(cached = [], fresh = [], { dedupBy = 'signal_label' } = {}) {
  const out = new Map();
  const key = (s) => String(s?.[dedupBy] || '').toLowerCase().trim();
  for (const s of cached) if (key(s)) out.set(key(s), s);
  for (const s of fresh) if (key(s)) out.set(key(s), { ...out.get(key(s)), ...s });
  return [...out.values()];
}

// Run-level helper: return cached signals for an entity merged with the result
// of a fresh search function. `runSearches` is injected (the LLM/search layer),
// keeping this module pure and testable offline.
export async function getOrFetchSignals(cache, entity, runSearches, { runId = null } = {}) {
  const entityId = entity?.id || entity?.company;
  const cached = cache.getByEntity(entityId);
  const fresh = typeof runSearches === 'function' ? (await runSearches(entity)) || [] : [];
  const stamped = fresh.map((s) => ({
    entity_id: entityId,
    captured_in_run_id: runId,
    ...s,
  }));
  cache.setMany(stamped);
  return mergeSignals(cached, stamped);
}
