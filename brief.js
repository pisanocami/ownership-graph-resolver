// Intelligence Brief V2 — Deterministic synthesis layer
// Classifies and interprets ownership, signals, reconciliation into structured brief sections

// ─── Signal Type Mapping ───────────────────────────────────────────────────
const signalTypeMap = {
  hiring: (sig) => sig.label.toLowerCase().includes('layoff') || sig.label.toLowerCase().includes('reduction')
    ? 'Workforce reduction'
    : 'Hiring acceleration',
  funding: () => 'Funding activity',
  press: (sig) => {
    const lbl = (sig.label || '').toLowerCase();
    if (lbl.includes('revenue') || lbl.includes('sales')) return 'Revenue signal';
    if (lbl.includes('acquisition') || lbl.includes('acquired') || lbl.includes('m&a')) return 'M&A activity';
    if (lbl.includes('pricing') || lbl.includes('price')) return 'Pricing action';
    return 'Media coverage';
  },
  capacity_investment: () => 'Capacity expansion',
  pricing: () => 'Pricing strategy change',
  m_and_a: (sig) => sig.label.toLowerCase().includes('acquisition') ? 'Acquisition interest' : 'M&A signal',
  sustainability: () => 'Sustainability commitment',
  direct_to_consumer: () => 'Direct-to-consumer expansion',
  operational: (sig) => {
    const lbl = (sig.label || '').toLowerCase();
    if (lbl.includes('challenge') || lbl.includes('restructure')) return 'Operational restructuring';
    return 'Operational signal';
  },
};

function mapSignalType(sig) {
  const mapper = signalTypeMap[sig.type] || (() => sig.type.replace(/_/g, ' '));
  return typeof mapper === 'function' ? mapper(sig) : mapper;
}

// ─── Reconciliation Classification ────────────────────────────────────────
export function classifyReconciliation(recon, tree) {
  if (!recon) return null;

  let interpretation = 'reconciles';
  let honest_explanation = null;

  if (recon.circular) {
    interpretation = 'circular';
    honest_explanation = `Reconciliation may be circular: ${(recon.circular_siblings || []).join(', ')} were estimated top-down as a share of ${tree.parent?.company || 'parent'}'s own total, so summing back is self-fulfilling.`;
  } else if (recon.pct_delta > 50) {
    interpretation = 'overshoot';
    honest_explanation = `Focal + siblings sum ${recon.pct_delta > 0 ? '+' : ''}${recon.pct_delta}% above parent benchmark — sibling estimates likely overstated or sibling set is over-broad.`;
  } else if (recon.pct_delta < -50) {
    interpretation = 'gap_uncovered';
    honest_explanation = `Focal + siblings cover only ${Math.round((recon.ratio || 0) * 100)}% of parent benchmark — likely missing siblings or underestimated revenues.`;
  } else if (recon.pct_delta > 20) {
    interpretation = 'overshoot';
    honest_explanation = `Focal + siblings sum ${recon.pct_delta}% above parent benchmark.`;
  } else if (recon.pct_delta < -20) {
    interpretation = 'gap_uncovered';
    honest_explanation = `Focal + siblings cover ${Math.round((recon.ratio || 0) * 100)}% of parent benchmark.`;
  } else if (recon.pct_delta > 0) {
    interpretation = 'coverage_win';
    honest_explanation = `Focal + siblings sum ${recon.pct_delta}% above parent benchmark — minor overshoot within confidence range.`;
  } else {
    interpretation = 'reconciles';
    honest_explanation = `Focal + siblings reconcile within ${Math.abs(recon.pct_delta)}% of parent benchmark.`;
  }

  const siblings_likely_overstated = (tree.siblings || [])
    .filter((s) => {
      const hasLowConfidence = s.revenue_estimate?.confidence === 'low';
      const isCircular = recon.circular_siblings?.includes(s.company);
      const isLegacy = s.status === 'legacy' || s.status === 'discontinued';
      return hasLowConfidence || isCircular || isLegacy;
    })
    .map((s) => s.company);

  const siblings_likely_understated = (tree.siblings || [])
    .filter((s) => {
      const inCurrentSources = s.in_current_sources === true;
      const noEstimate = !s.revenue_estimate?.central;
      return inCurrentSources && noEstimate;
    })
    .map((s) => s.company);

  return {
    raw_numbers: {
      sum_siblings: recon.sum_children_central,
      anchor: recon.parent_benchmark,
      delta_pct: recon.pct_delta,
    },
    interpretation,
    honest_explanation,
    siblings_likely_overstated,
    siblings_likely_understated,
    missing_siblings_hypothesis: recon.explanation?.likely_causes?.[0] || null,
  };
}

// ─── Signal Classification ────────────────────────────────────────────────
export function classifySignal(sig) {
  if (!sig) return null;

  let weight = sig.weight || 'medium';
  if (sig.context_unverified === true) {
    weight = 'low';
  }

  return {
    signal_type: mapSignalType(sig),
    weight,
    evidence: sig.value || sig.label || null,
    evidence_source: sig.source || null,
    interpretation: null, // filled by LLM
    directional_implication: 'neutral', // filled by LLM
  };
}

// ─── Counter Signals (gaps where expected signal types are missing) ────────
export function detectCounterSignals(tree) {
  const signals = tree.signals_found || [];
  const capturedTypes = new Set(signals.map((s) => s.type));

  const expectedSignalTypes = [];
  const revenue = tree.revenue_estimate?.central || 0;

  // Higher revenue brands should have more signals captured
  if (revenue > 5e9) {
    expectedSignalTypes.push('press', 'funding', 'hiring', 'capacity_investment');
  } else if (revenue > 1e9) {
    expectedSignalTypes.push('press', 'hiring');
  }

  // If has parent and revenue is significant, should have strategic signals
  if (tree.parent && revenue > 500e6) {
    expectedSignalTypes.push('capacity_investment', 'pricing');
  }

  const signalTypeNames = {
    press: 'Media coverage',
    funding: 'Funding activity',
    hiring: 'Hiring acceleration',
    capacity_investment: 'Capacity expansion',
    pricing: 'Pricing strategy change',
  };

  const gaps = [];
  expectedSignalTypes.forEach((type) => {
    if (!capturedTypes.has(type)) {
      gaps.push({
        signal_type: signalTypeNames[type] || type,
        gap_flag: true,
        fill_action: null, // filled by LLM
      });
    }
  });

  return gaps;
}

// ─── Ownership Clarity Classification ────────────────────────────────────
export function deriveOwnershipClarity(tree) {
  if (!tree) return 'confused';

  // Clean: single clear parent, no co-owners
  if (tree.parent && (!tree.co_owners || tree.co_owners.length === 0) && (!tree.strategic_control || tree.strategic_control.length <= 1)) {
    return 'clean';
  }

  // Multi-owner: co-owners or split voting/economic
  if (tree.co_owners && tree.co_owners.length > 0) {
    return 'multi_owner';
  }

  // Confused: strategic_control with many actors, or unclear parent
  if (!tree.parent) {
    return tree.strategic_control && tree.strategic_control.length > 3 ? 'confused' : 'clean';
  }

  if (tree.strategic_control && tree.strategic_control.length > 4) {
    return 'historical_complexity';
  }

  return 'clean';
}

// ─── M&A Attention Detection ────────────────────────────────────────────
export function detectMaAttention(tree) {
  if (tree.pending_acquisition?.acquirer) return 'recent_activity';
  if (tree.acquisition?.year && new Date().getFullYear() - tree.acquisition.year <= 3) return 'recent_activity';
  if (tree.acquisition?.status === 'rumored') return 'rumored';
  if (tree.pending_acquisition) return 'recent_activity';
  return 'none';
}

// ─── ASCII Tree Builder (compact, ≤8 lines) ────────────────────────────
export function buildAsciiTree(tree) {
  if (!tree) return '';

  const lines = [];
  lines.push(`${tree.company} (${tree.type || tree.layer || 'Brand'})`);

  if (tree.parent) {
    lines.push(`|- Parent: ${tree.parent.company}`);
  }

  if (tree.co_owners && tree.co_owners.length > 0) {
    const coOwnerLabels = tree.co_owners.slice(0, 2).map((c) => c.company).join(', ');
    lines.push(`|- Co-owners: ${coOwnerLabels}${tree.co_owners.length > 2 ? ` (+${tree.co_owners.length - 2})` : ''}`);
  }

  if (tree.children && tree.children.length > 0) {
    const childLabels = tree.children.slice(0, 2).map((c) => c.company).join(', ');
    lines.push(`|- Acquisitions: ${childLabels}${tree.children.length > 2 ? ` (+${tree.children.length - 2})` : ''}`);
  }

  const sibCount = (tree.siblings || []).length;
  if (sibCount > 0) {
    lines.push(`|- Siblings: ${sibCount} brand${sibCount === 1 ? '' : 's'}`);
  }

  if (tree.strategic_control && tree.strategic_control.length > 0) {
    const validControllers = tree.strategic_control.filter((s) => s.company || s.relationship);
    if (validControllers.length > 0) {
      const controlLabels = validControllers.slice(0, 2).map((s) => s.company || s.relationship).join(', ');
      lines.push(`'- Key stakeholders: ${controlLabels}${validControllers.length > 2 ? ` (+${validControllers.length - 2})` : ''}`);
    }
  }

  return lines.slice(0, 8).join('\n');
}

// ─── Data Trace Builder ────────────────────────────────────────────────
export function buildDataTrace(tree) {
  const sources = new Set();
  if (tree.revenue_estimate?.source) sources.add(tree.revenue_estimate.source);
  (tree.signals_found || []).forEach((s) => {
    if (s.source) sources.add(s.source);
  });
  (tree.strategic_control || []).forEach((s) => {
    if (s.source) sources.add(s.source);
  });

  return {
    primary_sources: Array.from(sources),
    methodology_note: 'Deterministic synthesis: verdict + reconciliation classification from ownership structure, revenue estimates, and captured signals. LLM enrichment adds interpretations, thesis, and competitive discovery.',
  };
}

// ─── Verdict Derivation (deterministic) ────────────────────────────────
export function deriveVerdict(tree, positioning) {
  if (!tree || !positioning) {
    return {
      label: 'HOLD',
      trajectory: 'Stable',
      capital_decision: 'Watch',
      _inputs: {},
    };
  }

  // Extract key signals
  const signals = tree.signals_found || [];
  const capacitySignals = signals.filter((s) => s.type === 'capacity_investment' || s.type === 'hiring');
  const maSignals = signals.filter((s) => s.type === 'm_and_a');
  const declineSignals = signals.filter((s) => {
    const text = `${s.label || ''} ${s.value || ''}`.toLowerCase();
    return text.includes('closure') || text.includes('decline') || text.includes('discontinu');
  });

  // Detect trajectory
  let trajectory = 'Stable';
  if (capacitySignals.length > 1 || signals.some((s) => s.type === 'funding')) {
    trajectory = 'Growing';
  } else if (declineSignals.length > 0) {
    trajectory = 'Declining';
  } else if (tree.terminal_layer === 'private_equity') {
    trajectory = 'Re-investment cycle';
  }

  // Detect capital decision based on structure
  let capital_decision = 'Actionable';
  if (tree.co_owners && tree.co_owners.length > 0 && !tree.parent) {
    capital_decision = 'Not actionable as standalone';
  } else if (!tree.parent && tree.co_owners && tree.co_owners.length > 1) {
    capital_decision = 'Not actionable as standalone';
  }

  // Derive label based on trajectory + M&A + size
  let label = 'HOLD';
  if (trajectory === 'Declining') {
    label = maSignals.length > 0 ? 'WATCH' : 'PULL BACK';
  } else if (trajectory === 'Growing') {
    label = 'HOLD WITH UPSIDE';
  } else if (maSignals.length > 0) {
    label = 'WATCH';
  } else if (trajectory === 'Re-investment cycle') {
    label = 'WATCH';
  }

  return {
    label,
    trajectory,
    capital_decision,
    confidence: 'medium',
    _inputs: {
      trajectory_signals: capacitySignals.length,
      decline_signals: declineSignals.length,
      ma_signals: maSignals.length,
      terminal_layer: tree.terminal_layer,
      has_co_owners: tree.co_owners?.length > 0,
    },
  };
}

// ─── Mispricing Skeleton (deterministic; LLM fills hypothesis/falsifiers) ─
export function buildMispricingSkeleton(tree, positioning) {
  let current_pricing_internal = null;
  let current_pricing_external = null;
  let ma_attention = detectMaAttention(tree);

  if (tree.acquisition?.price) {
    current_pricing_internal = `Last transaction: ${tree.acquisition.price}`;
  } else if (tree.valuation_estimate) {
    current_pricing_internal = `Estimated valuation: ${tree.valuation_estimate}`;
  }

  const signals = tree.signals_found || [];
  if (signals.some((s) => s.type === 'm_and_a' && s.value)) {
    current_pricing_external = signals.find((s) => s.type === 'm_and_a')?.value || null;
  }

  return {
    current_pricing_internal,
    current_pricing_external,
    ma_attention,
    has_thesis: false, // gate: only if LLM identifies
    hypothesis: null,  // filled by LLM
    falsifying_signals: [],
  };
}

// ─── Main Orchestrator ──────────────────────────────────────────────────
export function buildIntelligenceBrief(tree, positioning, { collapses = {}, holdingFlags = {} } = {}) {
  if (!tree) {
    return {
      verdict: { label: null, trajectory: null, capital_decision: null, confidence: 'low', confidence_reasoning: null, thesis: null, _inputs: {} },
      behavioral_signals: [],
      counter_signals: [],
      corporate_structure: { ascii_tree: '', ownership_clarity: null, history_note: null },
      mispricing: { current_pricing_internal: null, current_pricing_external: null, ma_attention: 'none', has_thesis: false, hypothesis: null, falsifying_signals: [] },
      competitive_context: null,
      reconciliation_honest: null,
      confidence_gaps: { high_confidence: [], medium_confidence: [], known_gaps: [], verdict_changers: [] },
      strategic_notes_by_audience: { for_investors: null, for_competitors: null, for_ma_advisors: null, for_growth_signal_users: null },
      data_trace: { primary_sources: [], methodology_note: null },
    };
  }

  const verdict = deriveVerdict(tree, positioning);
  const reconciliation_honest = classifyReconciliation(positioning.reconciliation, tree);

  // Build behavioral signals from captured signals
  const behavioral_signals = (tree.signals_found || [])
    .slice(0, 10)
    .map((sig) => classifySignal(sig))
    .filter((s) => s !== null);

  // Ensure minimum 3 behavioral signals (fallback if empty)
  if (behavioral_signals.length < 3) {
    const fallbackSignal = {
      signal_type: 'Operational performance',
      weight: 'medium',
      evidence: positioning.focal_vs_siblings || 'Revenue position in family',
      evidence_source: 'positioning_analysis',
      interpretation: null,
      directional_implication: 'neutral',
    };
    while (behavioral_signals.length < 3) {
      behavioral_signals.push({ ...fallbackSignal });
    }
  }

  const counter_signals = detectCounterSignals(tree);

  const corporate_structure = {
    ascii_tree: buildAsciiTree(tree),
    ownership_clarity: deriveOwnershipClarity(tree),
    history_note: null, // filled by LLM
  };

  const mispricing = buildMispricingSkeleton(tree, positioning);
  const data_trace = buildDataTrace(tree);

  // Build confidence gaps
  const confidence_gaps = {
    high_confidence: [],
    medium_confidence: [],
    known_gaps: [],
    verdict_changers: [],
  };

  // High confidence: revenue estimate with high confidence + clear ownership
  if (tree.revenue_estimate?.confidence === 'high') {
    confidence_gaps.high_confidence.push(`Revenue estimate (${tree.revenue_estimate.source || 'source'})`);
  }
  if (tree.parent && !tree.co_owners) {
    confidence_gaps.high_confidence.push('Clear parent company ownership');
  }

  // Medium confidence: moderate confidence signals, signals with sources
  if (tree.revenue_estimate?.confidence === 'medium') {
    confidence_gaps.medium_confidence.push(`Revenue estimate (${tree.revenue_estimate.source || 'source'})`);
  }
  if (tree.signals_found?.length > 0) {
    const verifiedSignals = tree.signals_found.filter((s) => !s.context_unverified);
    if (verifiedSignals.length > 0) {
      confidence_gaps.medium_confidence.push(`${verifiedSignals.length} verified signal${verifiedSignals.length !== 1 ? 's' : ''}`);
    }
  }

  // Known gaps: missing parent anchor, missing acquisition details, no M&A signals for growth company
  if (tree.parent && !positioning.parent_benchmark) {
    confidence_gaps.known_gaps.push('Parent segment revenue anchor (10-K) not publicly available');
  }
  if (tree.parent && !tree.co_owners && tree.revenue_estimate?.central > 500e6 && !tree.signals_found?.some((s) => s.type === 'm_and_a')) {
    confidence_gaps.known_gaps.push('No M&A/strategic signals detected for large subsidiary');
  }
  if (tree.siblings && tree.siblings.length > 0 && tree.siblings.some((s) => !s.revenue_estimate?.central)) {
    confidence_gaps.known_gaps.push(`${tree.siblings.filter((s) => !s.revenue_estimate?.central).length} sibling(s) without revenue estimates`);
  }

  // Verdict changers: data that could flip the verdict
  if (tree.pending_acquisition || tree.acquisition?.status === 'rumored') {
    confidence_gaps.verdict_changers.push('Pending or rumored M&A could change trajectory');
  }
  if (tree.co_owners && tree.co_owners.length > 1) {
    confidence_gaps.verdict_changers.push('Multi-owner structure limits capital decisions');
  }
  if (positioning.reconciliation?.pct_delta > 30 || positioning.reconciliation?.pct_delta < -30) {
    confidence_gaps.verdict_changers.push('Reconciliation delta ±30%+ suggests missing siblings or estimate issues');
  }

  return {
    verdict: {
      ...verdict,
      confidence_reasoning: null, // filled by LLM
      thesis: null, // filled by LLM
    },
    behavioral_signals: behavioral_signals.slice(0, 10),
    counter_signals,
    corporate_structure,
    mispricing,
    competitive_context: null, // web-search Phase 4
    reconciliation_honest,
    confidence_gaps,
    strategic_notes_by_audience: {
      for_investors: verdict.capital_decision === 'Not actionable as standalone' ? null : 'Pending LLM enrichment',
      for_competitors: null, // web-search Phase 4
      for_ma_advisors: mispricing.ma_attention !== 'none' ? 'Pending LLM enrichment' : null,
      for_growth_signal_users: 'Pending LLM enrichment',
    },
    data_trace,
  };
}
