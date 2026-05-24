// Intelligence Brief V2 — Deterministic + LLM synthesis layer
// Attaches intelligence_brief object to synthesized result

export function buildIntelligenceBrief(tree, positioning, { collapses = {}, holdingFlags = {} } = {}) {
  return {
    verdict: {
      label: null,
      trajectory: null,
      capital_decision: null,
      confidence: 'low',
      confidence_reasoning: null,
      thesis: null,
      _inputs: {}
    },
    behavioral_signals: [],
    counter_signals: [],
    corporate_structure: {
      ascii_tree: '',
      ownership_clarity: null,
      history_note: null
    },
    mispricing: {
      current_pricing_internal: null,
      current_pricing_external: null,
      ma_attention: 'none',
      has_thesis: false,
      hypothesis: null,
      falsifying_signals: []
    },
    competitive_context: null,
    reconciliation_honest: tree.parent ? {
      raw_numbers: {},
      interpretation: null,
      honest_explanation: null,
      siblings_likely_overstated: [],
      siblings_likely_understated: [],
      missing_siblings_hypothesis: null
    } : null,
    confidence_gaps: {
      high_confidence: [],
      medium_confidence: [],
      known_gaps: [],
      verdict_changers: []
    },
    strategic_notes_by_audience: {
      for_investors: null,
      for_competitors: null,
      for_ma_advisors: null,
      for_growth_signal_users: null
    },
    data_trace: {
      primary_sources: [],
      methodology_note: null
    }
  };
}

export function deriveVerdict(tree, positioning) {
  return {
    label: null,
    trajectory: null,
    capital_decision: null,
    _inputs: {}
  };
}

export function classifyReconciliation(recon, tree) {
  if (!recon) return null;
  return {
    raw_numbers: {},
    interpretation: null,
    honest_explanation: null,
    siblings_likely_overstated: [],
    siblings_likely_understated: [],
    missing_siblings_hypothesis: null
  };
}

export function classifySignal(sig) {
  return {
    signal_type: null,
    weight: sig?.weight || 'medium',
    evidence: sig?.value || null,
    evidence_source: sig?.source || null,
    interpretation: null,
    directional_implication: 'neutral'
  };
}

export function detectCounterSignals(tree) {
  return [];
}

export function buildAsciiTree(tree) {
  return '';
}

export function deriveOwnershipClarity(tree) {
  return null;
}

export function detectMaAttention(tree) {
  return 'none';
}

export function buildDataTrace(tree) {
  return {
    primary_sources: [],
    methodology_note: null
  };
}
