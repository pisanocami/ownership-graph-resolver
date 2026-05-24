// Determinism helpers (Ticket #59 v2, Stream D4 + D5 — NEW.36).
//
// D4 detectCrossRunVariance: flag entities whose revenue moved >50% vs the most
// recent cached run for the same focal, so the brief (B9) can warn the reader.
// D5 computeModelParity: structural agreement between two model outputs of the
// same focal (Sonnet vs Gemini) — numbers may differ, structure must not.

// Walk a synthesized tree into a flat map of entity_id → { revenue.central,
// primary_parent_id, children_ids, siblings_ids }.
export function indexEntities(tree) {
  const out = {};
  const seen = new WeakSet();
  const idOf = (n) => n?.id || n?.company;
  const visit = (node) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    const id = idOf(node);
    if (id) {
      out[id] = {
        revenue: { central: node.revenue_estimate?.central ?? null },
        primary_parent_id: node.primary_parent_id ?? node.parent?.company ?? null,
        node_type: node.node_type || null,
        children_ids: (node.children || []).map(idOf).filter(Boolean).sort(),
        siblings_ids: (node.siblings || []).map(idOf).filter(Boolean).sort(),
      };
    }
    if (node.parent) visit(node.parent);
    (node.children || []).forEach(visit);
    (node.siblings || []).forEach(visit);
    (node.intra_parent_cousins || []).forEach(visit);
    (node.cousins || []).forEach(visit);
    (node.co_owners || []).forEach(visit);
    (node._divisional_aggregators || []).forEach((a) => (a.children || []).forEach(visit));
  };
  visit(tree);
  return out;
}

// Build a comparable run snapshot from a synthesized result.
export function buildRunSnapshot(result, { runId = null, model = null } = {}) {
  const tree = result?.ownership_tree || result?.tree || result;
  return {
    run_id: runId,
    model,
    timestamp: Date.now(),
    focal: tree?.company || null,
    entities: indexEntities(tree),
  };
}

// D4 — compare current run's revenue estimates against the most recent cached
// run for the same focal. Returns null when there is nothing to compare.
export function detectCrossRunVariance(currentRun, cachedRuns, { threshold = 0.5 } = {}) {
  if (!currentRun || !Array.isArray(cachedRuns) || cachedRuns.length === 0) return null;
  const latest = [...cachedRuns].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0];
  if (!latest) return null;
  const flags = [];
  for (const [id, cur] of Object.entries(currentRun.entities || {})) {
    const curRev = cur.revenue?.central;
    const prevRev = latest.entities?.[id]?.revenue?.central;
    if (!(curRev > 0) || !(prevRev > 0)) continue;
    const variance = Math.abs(curRev - prevRev) / prevRev;
    if (variance > threshold) {
      flags.push({
        entity: id,
        previous: prevRev,
        current: curRev,
        variance_pct: Math.round(((curRev - prevRev) / prevRev) * 100),
        previous_run_date: latest.timestamp,
        previous_run_id: latest.run_id || null,
      });
    }
  }
  return flags.length ? flags : null;
}

// D5 — structural parity between two model outputs of the same focal.
export function computeModelParity(outputA, outputB) {
  const a = indexEntities(outputA?.ownership_tree || outputA?.tree || outputA);
  const b = indexEntities(outputB?.ownership_tree || outputB?.tree || outputB);
  const ids = new Set([...Object.keys(a), ...Object.keys(b)]);
  const checks = [];

  // 1. entity_count
  checks.push(Object.keys(a).length === Object.keys(b).length);

  // 2–4. per-entity structural fields (primary_parent_id, children_ids, siblings_ids)
  let ppMatch = 0; let childMatch = 0; let sibMatch = 0; let compared = 0;
  for (const id of ids) {
    const ea = a[id];
    const eb = b[id];
    if (!ea || !eb) continue;
    compared++;
    if ((ea.primary_parent_id || null) === (eb.primary_parent_id || null)) ppMatch++;
    if (JSON.stringify(ea.children_ids) === JSON.stringify(eb.children_ids)) childMatch++;
    if (JSON.stringify(ea.siblings_ids) === JSON.stringify(eb.siblings_ids)) sibMatch++;
  }
  checks.push(compared === 0 ? false : ppMatch === compared);
  checks.push(compared === 0 ? false : childMatch === compared);
  checks.push(compared === 0 ? false : sibMatch === compared);

  const score = checks.filter(Boolean).length / checks.length;
  return {
    parity: Number(score.toFixed(3)),
    entity_count_match: checks[0],
    primary_parent_match: compared ? ppMatch / compared : 0,
    children_match: compared ? childMatch / compared : 0,
    siblings_match: compared ? sibMatch / compared : 0,
    compared_entities: compared,
  };
}
