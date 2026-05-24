// Intelligence Brief V2.1 — Deterministic synthesis layer
// Classifies and interprets ownership, signals, reconciliation into structured brief sections.
// Many fields are LLM-fillable but every one has a deterministic seed so the brief
// is renderable even when enrichment fails. Reference: Perfect Brief V2.1 (MSC Cruceros).

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
    if (lbl.includes('market share')) return 'Market share signal';
    if (lbl.includes('passenger') || lbl.includes('volume') || lbl.includes('users') || lbl.includes('subscribers')) return 'Volume signal';
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

// ─── Why-this-matters templates for counter-signals (gaps) ────────────────
// Spec §4.3 of Perfect Brief V2.1: each counter-signal pairs a search query with a
// reader-facing rationale for WHY closing the gap would move the verdict.
const WHY_MATTERS_TEMPLATES = {
  'Funding activity': "Private companies don't disclose; bond issuances and credit-facility filings are the rare public window into capital structure and leverage trajectory.",
  'Capacity expansion': 'Capex is the highest-conviction revenue commitment signal. 2–4 year forward order book predicts growth trajectory better than any current operational metric.',
  'Hiring acceleration': 'Hiring trends precede revenue by 6–12 months. Strong functional/operational hiring indicates capacity coming online ahead of demand.',
  'Media coverage': 'Press cadence anchors the public narrative and surfaces strategic priorities management chooses to disclose; absence in a brand this size is itself a signal.',
  'Pricing strategy change': 'Pricing moves reveal whether management is defending share (volume play) or harvesting (margin play) — the single biggest tell on capital posture.',
  'M&A signal': 'M&A activity is the clearest forward indicator of capital deployment intent and strategic gaps the company perceives in its own portfolio.',
  'Governance / succession': 'Family or founder transition events trigger restructures, partial sales, and IPOs — usually the only path to transactability for closely-held assets.',
};

function whyMattersFor(signalType) {
  return WHY_MATTERS_TEMPLATES[signalType] || `Closing this gap would materially sharpen the verdict on ${signalType.toLowerCase()}.`;
}

// ─── Directional implication heuristic (deterministic seed) ───────────────
// LLM enrichment may override; this guarantees signals aren't all "neutral" by
// default (Perfect Brief V2.1 §2 critique).
export function deriveSignalImplication(sig) {
  if (!sig) return 'neutral';
  const text = `${sig.label || ''} ${sig.value || ''} ${sig.signal_type || ''}`.toLowerCase();
  const type = sig.type || '';
  const negativeHits = ['layoff', 'reduction', 'closure', 'decline', 'discontinu', 'collapse', 'restructur', 'downturn', 'loss', 'shrink', 'pull back', 'exit', 'sell-off'];
  const positiveHits = ['growth', 'expansion', 'order book', 'new ship', 'new factory', 'capacity', 'acceleration', 'record', 'all-time', 'fleet expansion', 'launch', 'opening', 'investment', 'hiring', 'recovery'];
  if (negativeHits.some((h) => text.includes(h))) return 'negative';
  if (positiveHits.some((h) => text.includes(h))) return 'positive';
  if (type === 'capacity_investment' || type === 'funding') return 'positive';
  if (type === 'hiring' && !text.includes('layoff')) return 'positive';
  if (type === 'm_and_a') return 'positive';
  return 'neutral';
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

// ─── Dual-model reconciliation (industry-side + volume-side triangulation) ─
// Perfect Brief V2.1 §4: when no parent 10-K anchor exists, triangulate against
// (a) industry total × market share, and (b) volume × unit economics. Honest
// gap callouts when either model diverges from the agent's central estimate.
export function buildDualModelReconciliation(tree, positioning, competitive_context) {
  const rev = tree.revenue_estimate || {};
  const central = rev.central || 0;
  const signals = tree.signals_found || [];

  const models = [];

  // Model 1: industry × share. Triggered when we have either competitive_context
  // with an industry_total field, or a signal that mentions market share.
  const shareSignal = signals.find((s) => {
    const t = `${s.label || ''} ${s.value || ''}`.toLowerCase();
    return t.includes('market share') || t.includes('% of');
  });
  if (shareSignal) {
    models.push({
      name: 'industry_share',
      label: 'Industry total × market share',
      evidence: shareSignal.value || shareSignal.label,
      implied_central: null,
      vs_agent_pct: null,
      verdict: central > 0 ? 'see evidence string' : 'inconclusive',
    });
  }

  // Model 2: volume × unit economics. Triggered when a signal mentions passenger
  // counts, subscribers, users, units, etc.
  const volumeSignal = signals.find((s) => {
    const t = `${s.label || ''} ${s.value || ''}`.toLowerCase();
    return /\b(passenger|subscriber|user|customer|unit|guest|booking)s?\b/.test(t);
  });
  if (volumeSignal) {
    models.push({
      name: 'volume_unit_economics',
      label: 'Volume × estimated unit economics',
      evidence: volumeSignal.value || volumeSignal.label,
      implied_central: null,
      vs_agent_pct: null,
      verdict: 'requires unit-economics anchor; flag for fill',
    });
  }

  // Model 3: parent anchor (the existing classifyReconciliation). Triggered
  // only when parent_benchmark is present.
  const baseRecon = classifyReconciliation(positioning?.reconciliation, tree);
  if (baseRecon) {
    models.push({
      name: 'parent_anchor',
      label: 'Parent 10-K / segment anchor',
      evidence: `Sum siblings ${baseRecon.raw_numbers.sum_siblings || 0} vs anchor ${baseRecon.raw_numbers.anchor || 0}`,
      implied_central: baseRecon.raw_numbers.anchor || null,
      vs_agent_pct: baseRecon.raw_numbers.delta_pct ?? null,
      verdict: baseRecon.interpretation,
    });
  }

  if (models.length === 0) return null;

  const has_anchor = !!baseRecon;
  return {
    models,
    has_public_anchor: has_anchor,
    notes: has_anchor
      ? null
      : 'No public anchor (10-K) available; triangulation models above are best-effort and confidence is reduced accordingly.',
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
    interpretation: null, // filled by LLM ("Read this as: …")
    directional_implication: deriveSignalImplication(sig),
  };
}

// ─── Counter Signals (gaps where expected signal types are missing) ────────
export function detectCounterSignals(tree) {
  const signals = tree.signals_found || [];
  const capturedTypes = new Set(signals.map((s) => s.type));

  const expectedSignalTypes = [];
  const revenue = tree.revenue_estimate?.central || 0;

  if (revenue > 5e9) {
    expectedSignalTypes.push('press', 'funding', 'hiring', 'capacity_investment');
  } else if (revenue > 1e9) {
    expectedSignalTypes.push('press', 'hiring');
  }

  if (tree.parent && revenue > 500e6) {
    expectedSignalTypes.push('capacity_investment', 'pricing');
  }

  // Add governance/succession when ownership is family-concentrated — it's the
  // dominant catalyst for any transactability story (Perfect Brief V2.1 §3).
  const family = detectFamilyConcentrated(tree);
  if (family.is_family) {
    expectedSignalTypes.push('governance_succession');
  }

  const signalTypeNames = {
    press: 'Media coverage',
    funding: 'Funding activity',
    hiring: 'Hiring acceleration',
    capacity_investment: 'Capacity expansion',
    pricing: 'Pricing strategy change',
    governance_succession: 'Governance / succession',
  };

  const seenLabels = new Set();
  const gaps = [];
  expectedSignalTypes.forEach((type) => {
    if (type === 'governance_succession' || !capturedTypes.has(type)) {
      const label = signalTypeNames[type] || type;
      if (seenLabels.has(label)) return;
      seenLabels.add(label);
      gaps.push({
        signal_type: label,
        gap_flag: true,
        fill_action: null, // filled by LLM
        why_matters: whyMattersFor(label),
      });
    }
  });

  return gaps;
}

// ─── Ownership Clarity Classification ────────────────────────────────────
export function deriveOwnershipClarity(tree) {
  if (!tree) return 'confused';

  // Family / individual UBO with concentrated 100% ownership — surface this
  // distinctly so the verdict layer can flip to "not actionable" cleanly.
  const family = detectFamilyConcentrated(tree);
  if (family.is_family && family.total_pct >= 100) return 'family_concentrated_100pct';
  if (family.is_family) return 'family_concentrated';

  // Clean: single clear parent, no co-owners
  if (tree.parent && (!tree.co_owners || tree.co_owners.length === 0) && (!tree.strategic_control || tree.strategic_control.length <= 1)) {
    return 'clean';
  }

  if (tree.co_owners && tree.co_owners.length > 0) {
    return 'multi_owner';
  }

  if (!tree.parent) {
    return tree.strategic_control && tree.strategic_control.length > 3 ? 'confused' : 'clean';
  }

  if (tree.strategic_control && tree.strategic_control.length > 4) {
    return 'historical_complexity';
  }

  return 'clean';
}

// ─── Family / individual UBO detection ───────────────────────────────────
// Heuristic: co_owners (or parent.node_type==='individual') whose names share a
// surname or include "Family" / "Trust" with ownership_pct totalling ≥ 95.
// Falls back to single-owner detection when a parent is itself an individual UBO.
export function detectFamilyConcentrated(tree) {
  const empty = { is_family: false, total_pct: 0, members: [], surname: null };
  if (!tree) return empty;
  const co = Array.isArray(tree.co_owners) ? tree.co_owners : [];
  const parent = tree.parent || null;

  // Case A: parent is an individual UBO (e.g. founder holds 100%).
  if (parent && parent.node_type === 'individual') {
    const pct = Number(parent.ownership_pct) || 100;
    return {
      is_family: true,
      total_pct: pct,
      members: [{
        name: parent.company,
        role: parent.role || 'Founder / Owner',
        est_stake: `${pct}%`,
      }],
      surname: surnameOf(parent.company),
    };
  }

  // Case B: co_owners are individuals that share a surname or "Family" suffix.
  if (co.length > 0) {
    const individuals = co.filter((c) => c.node_type === 'individual' || /family|trust|aponte|walton|mars|ferrero/i.test(c.company || ''));
    const surnameCounts = new Map();
    individuals.forEach((c) => {
      const sn = surnameOf(c.company);
      if (sn) surnameCounts.set(sn, (surnameCounts.get(sn) || 0) + 1);
    });
    const dominantSurname = [...surnameCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (dominantSurname && dominantSurname[1] >= 2) {
      const members = individuals
        .filter((c) => surnameOf(c.company) === dominantSurname[0])
        .map((c) => ({
          name: c.company,
          role: c.role || 'Co-owner',
          est_stake: c.ownership_pct ? `${c.ownership_pct}%` : 'undisclosed',
        }));
      const total = members.reduce((acc, m) => {
        const n = parseFloat(m.est_stake);
        return acc + (isFinite(n) ? n : 0);
      }, 0);
      return {
        is_family: true,
        total_pct: total || 100,
        members,
        surname: dominantSurname[0],
      };
    }
  }
  return empty;
}

function surnameOf(name) {
  if (!name) return null;
  const cleaned = name.replace(/\b(family|trust|holding|holdings|group)\b/gi, '').trim();
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  return tokens[tokens.length - 1].toLowerCase();
}

// ─── M&A Attention Detection ────────────────────────────────────────────
export function detectMaAttention(tree) {
  if (tree.pending_acquisition?.acquirer) return 'recent_activity';
  if (tree.acquisition?.year && new Date().getFullYear() - tree.acquisition.year <= 3) return 'recent_activity';
  if (tree.acquisition?.status === 'rumored') return 'rumored';
  if (tree.pending_acquisition) return 'recent_activity';
  return 'none';
}

// ─── Capital Decision Derivation (full taxonomy) ──────────────────────────
// Perfect Brief V2.1 §1: capital_decision drives the verdict label. Family-only
// 100% with no public path → "NOT ACTIONABLE AS STANDALONE", no exceptions.
export function deriveCapitalDecision(tree) {
  if (!tree) return { decision: 'Watch', reason: 'no_tree' };
  const family = detectFamilyConcentrated(tree);
  const hasPublicTicker = !!(tree.ticker || tree.parent?.ticker || tree.public_listing);
  const hasPendingMA = !!tree.pending_acquisition?.acquirer;
  const isPE = tree.terminal_layer === 'private_equity' || tree.parent?.terminal_layer === 'private_equity';

  if (hasPendingMA) return { decision: 'Watch', reason: 'pending_acquisition' };
  if (hasPublicTicker) return { decision: 'Actionable', reason: 'public_listing' };
  if (isPE) return { decision: 'Actionable via sponsor', reason: 'pe_owned' };
  if (family.is_family && family.total_pct >= 95) {
    return { decision: 'Not actionable as standalone', reason: 'family_concentrated_100pct' };
  }
  if (tree.co_owners && tree.co_owners.length > 0 && !tree.parent) {
    return { decision: 'Not actionable as standalone', reason: 'multi_owner_no_parent' };
  }
  if (!tree.parent && tree.co_owners && tree.co_owners.length > 1) {
    return { decision: 'Not actionable as standalone', reason: 'split_control' };
  }
  return { decision: 'Actionable', reason: 'default_subsidiary' };
}

// ─── Verdict changers — "What would make this actionable" ─────────────────
// Perfect Brief V2.1 §1: when capital_decision is NOT actionable, surface 2–4
// concrete events that would flip it to actionable.
export function buildVerdictChangers(tree, capitalDecision) {
  const out = [];
  const family = detectFamilyConcentrated(tree);
  if (capitalDecision?.reason === 'family_concentrated_100pct' && family.surname) {
    const surname = family.surname.charAt(0).toUpperCase() + family.surname.slice(1);
    out.push(`${surname} family announces partial sale or IPO of the operating division.`);
    out.push(`Holding-company restructuring that separates the focal segment from the wider group.`);
    out.push(`Recent acquisitions by the holding of competing assets in the focal category.`);
  } else if (capitalDecision?.reason === 'multi_owner_no_parent' || capitalDecision?.reason === 'split_control') {
    out.push('Buy-out or consolidation that puts a single owner in control of >50% economics.');
    out.push('IPO filing or S-1 disclosure that creates a public capital path.');
  } else if (capitalDecision?.reason === 'pe_owned') {
    out.push('Sponsor announces dual-track (IPO + sale) or files an S-1.');
    out.push('Secondary stake sale to a strategic that signals partial liquidity.');
  }
  return out;
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
    methodology_note: 'Deterministic synthesis (V2.1): ownership clarity → capital decision → verdict label; reconciliation triangulated against parent anchor + (when available) industry-share and volume-unit-economics models. Confidence is escalated to LOW when sibling capture is incomplete, no public anchor exists, the revenue range spread ≥2×, parent gap ≥30%, or forward-catalyst data is missing. LLM enrichment adds signal interpretations ("Read this as:") and audience-specific notes; deterministic seeds are used as fallback.',
    generated_at: new Date().toISOString(),
  };
}

// ─── Self-aware sibling-capture signal ────────────────────────────────────
// When the sibling backfill heuristic fired but capture is still incomplete OR
// the tree is suspicious of geographic-only sibling variants, emit a signal
// that names the capture limitation explicitly (Perfect Brief V2.1 §2 #5).
export function buildSelfAwareCaptureSignal(tree, backfillInfo) {
  if (!tree) return null;
  const sibs = Array.isArray(tree.siblings) ? tree.siblings : [];
  const focal = (tree.company || '').toLowerCase();
  // Detect geographic-only variants: sibling names equal focal + locale token.
  const localeTokens = ['us', 'uk', 'eu', 'mexico', 'brasil', 'brazil', 'china', 'india', 'japan', 'cruceros', 'cruises', 'kreuzfahrten', 'crociere'];
  const geographicOnly = sibs.length > 0 && sibs.every((s) => {
    const sn = (s.company || '').toLowerCase();
    return localeTokens.some((tok) => sn === `${focal} ${tok}` || sn === `${focal}-${tok}` || sn.startsWith(`${focal} `));
  });
  const incomplete = backfillInfo?.needed === true;
  // Only emit when there is an actual capture concern. Sibling-count===0 alone
  // is NOT a concern (e.g. a true standalone), so do not fabricate a warning.
  if (!incomplete && !geographicOnly) return null;
  const note = geographicOnly
    ? `Sibling capture appears geographic-only (${sibs.length} variant${sibs.length === 1 ? '' : 's'} of "${tree.company}"). Geographic brand variants are not true siblings; product-tier variants ARE. The capture heuristic may be missing sister products under the same parent.`
    : `Sibling capture incomplete: parent "${tree.parent?.company || 'unknown'}" has fewer than ${backfillInfo?.floor || 3} discovered siblings. Brief reconciliation and competitive context are therefore lower-confidence.`;
  return {
    signal_type: 'Capture limitation',
    weight: 'medium',
    evidence: note,
    evidence_source: 'synth_self_aware',
    interpretation: `Read this as: the agent's own capture warning is structurally important — the sibling set is likely incomplete and any reconciliation against parent revenue will under-cover. Worth flagging to any downstream consumer of this brief.`,
    directional_implication: 'neutral',
    self_aware: true,
  };
}

// ─── Confidence escalation rule ──────────────────────────────────────────
// Perfect Brief V2.1 §1: force confidence to LOW when any of the listed
// structural conditions are met, and return a human-readable reasoning string.
export function escalateConfidence(tree, positioning, opts = {}) {
  const triggers = [];
  const rev = tree?.revenue_estimate || {};
  const recon = positioning?.reconciliation || null;

  // 1. Sibling capture incomplete.
  if (opts.backfillNeeded === true) triggers.push('sibling capture incomplete (warning fired)');

  // 2. No public anchor.
  if (tree?.parent && !positioning?.parent_benchmark) triggers.push('no parent 10-K segment anchor available');

  // 3. Revenue range spread ≥ 2×.
  if (rev.high && rev.low && rev.low > 0 && rev.high / rev.low >= 2) {
    triggers.push(`revenue range spread ${(rev.high / rev.low).toFixed(1)}× (low ${rev.low} vs high ${rev.high})`);
  }

  // 4. Parent gap ≥ 30% (sum siblings vs anchor).
  if (recon && typeof recon.pct_delta === 'number' && Math.abs(recon.pct_delta) >= 30) {
    triggers.push(`parent reconciliation gap ${recon.pct_delta > 0 ? '+' : ''}${recon.pct_delta}%`);
  }

  // 5. Forward-catalyst opacity (no signals at all on a brand large enough to expect them).
  const signalCount = (tree?.signals_found || []).length;
  if ((rev.central || 0) > 500e6 && signalCount < 2) {
    triggers.push('forward-catalyst opacity (≤1 behavioral signal captured on a brand >$500M)');
  }

  if (triggers.length === 0) {
    // Default: medium unless the underlying revenue estimate is itself high.
    const baseline = rev.confidence === 'high' ? 'high' : rev.confidence === 'low' ? 'low' : 'medium';
    return { confidence: baseline, confidence_reasoning: null, triggers: [] };
  }
  return {
    confidence: 'low',
    confidence_reasoning: `Confidence forced to LOW: ${triggers.join('; ')}.`,
    triggers,
  };
}

// ─── Top-3 signal picker ─────────────────────────────────────────────────
export function pickTopSignals(signals, n = 3) {
  if (!Array.isArray(signals)) return [];
  const weightScore = { high: 3, medium: 2, low: 1 };
  const implScore = { positive: 1, negative: 1, neutral: 0 };
  return signals
    .map((s, idx) => ({ s, idx, score: (weightScore[s.weight] || 2) + (implScore[s.directional_implication] || 0) }))
    .sort((a, b) => b.score - a.score || a.idx - b.idx)
    .slice(0, n)
    .map(({ s }) => s);
}

// ─── History note deterministic fallback ─────────────────────────────────
export function buildHistoryNoteFallback(tree) {
  if (!tree) return null;
  const parts = [];
  if (tree.founded_year) parts.push(`Founded ${tree.founded_year}`);
  if (tree.parent?.company && tree.acquisition?.year) {
    parts.push(`acquired by ${tree.parent.company} in ${tree.acquisition.year}`);
  } else if (tree.parent?.company) {
    parts.push(`currently owned by ${tree.parent.company}`);
  }
  const family = detectFamilyConcentrated(tree);
  if (family.is_family && family.surname) {
    const surname = family.surname.charAt(0).toUpperCase() + family.surname.slice(1);
    parts.push(`${surname} family retains control across generations`);
  }
  return parts.length ? `${parts.join('; ')}.` : null;
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

  const signals = tree.signals_found || [];
  const capacitySignals = signals.filter((s) => s.type === 'capacity_investment' || s.type === 'hiring');
  const maSignals = signals.filter((s) => s.type === 'm_and_a');
  const declineSignals = signals.filter((s) => {
    const text = `${s.label || ''} ${s.value || ''}`.toLowerCase();
    return text.includes('closure') || text.includes('decline') || text.includes('discontinu');
  });

  let trajectory = 'Stable';
  if (capacitySignals.length > 1 || signals.some((s) => s.type === 'funding')) {
    trajectory = 'Growing';
  } else if (declineSignals.length > 0) {
    trajectory = 'Declining';
  } else if (tree.terminal_layer === 'private_equity') {
    trajectory = 'Re-investment cycle';
  }

  const cap = deriveCapitalDecision(tree);
  const capital_decision = cap.decision;
  const capital_decision_reason = cap.reason;

  // Derive label. Capital-decision NOT-ACTIONABLE dominates everything.
  let label = 'HOLD';
  if (capital_decision === 'Not actionable as standalone') {
    label = 'NOT ACTIONABLE AS STANDALONE';
  } else if (trajectory === 'Declining') {
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
    capital_decision_reason,
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
export function buildMispricingSkeleton(tree, positioning, competitive_context = null) {
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

  // Peer multiples skeleton — LLM fills in actual multiples when peers exist.
  const peer_multiples = Array.isArray(competitive_context) && competitive_context.length > 0
    ? {
        peers: competitive_context.slice(0, 5).map((p) => ({
          name: p.competitor,
          revenue: p.estimated_revenue_usd || null,
          ev_to_revenue: null, // LLM-fill
          discount_or_premium_pct: null, // LLM-fill
        })),
        decomposition: null, // LLM-fill: how much of the discount is family/governance/segment-mix?
      }
    : null;

  return {
    current_pricing_internal,
    current_pricing_external,
    ma_attention,
    has_thesis: false,
    hypothesis: null,
    falsifying_signals: [],
    peer_multiples,
  };
}

// ─── Main Orchestrator ──────────────────────────────────────────────────
export function buildIntelligenceBrief(tree, positioning, opts = {}) {
  if (!tree) {
    return {
      verdict: { label: null, trajectory: null, capital_decision: null, capital_decision_reason: null, confidence: 'low', confidence_reasoning: null, thesis: null, verdict_changers: [], _inputs: {} },
      behavioral_signals: [],
      top_signals: [],
      counter_signals: [],
      corporate_structure: { ascii_tree: '', ownership_clarity: null, history_note: null, family_detail: null },
      mispricing: { current_pricing_internal: null, current_pricing_external: null, ma_attention: 'none', has_thesis: false, hypothesis: null, falsifying_signals: [], peer_multiples: null },
      competitive_context: null,
      reconciliation_honest: null,
      reconciliation_dual_model: null,
      confidence_gaps: { high_confidence: [], medium_confidence: [], known_gaps: [], verdict_changers: [] },
      strategic_notes_by_audience: { for_investors: null, for_competitors: null, for_ma_advisors: null, for_growth_signal_users: null },
      data_trace: { primary_sources: [], methodology_note: null, generated_at: null },
    };
  }

  const verdict = deriveVerdict(tree, positioning);
  const reconciliation_honest = classifyReconciliation(positioning.reconciliation, tree);
  const reconciliation_dual_model = buildDualModelReconciliation(tree, positioning, opts.competitive_context || null);

  // Build behavioral signals from captured signals.
  let behavioral_signals = (tree.signals_found || [])
    .slice(0, 10)
    .map((sig) => classifySignal(sig))
    .filter((s) => s !== null);

  // Inject self-aware capture signal at the top when capture is incomplete or
  // sibling set looks geographic-only.
  const selfAware = buildSelfAwareCaptureSignal(tree, opts.backfillInfo || null);
  if (selfAware) behavioral_signals.unshift(selfAware);

  // Ensure minimum 3 behavioral signals.
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

  behavioral_signals = behavioral_signals.slice(0, 10);
  const top_signals = pickTopSignals(behavioral_signals, 3);

  const counter_signals = detectCounterSignals(tree);

  const family_detail = detectFamilyConcentrated(tree);
  const corporate_structure = {
    ascii_tree: buildAsciiTree(tree),
    ownership_clarity: deriveOwnershipClarity(tree),
    history_note: buildHistoryNoteFallback(tree),
    family_detail: family_detail.is_family ? family_detail : null,
  };

  const mispricing = buildMispricingSkeleton(tree, positioning, opts.competitive_context || null);
  const data_trace = buildDataTrace(tree);

  // Confidence escalation + reasoning.
  const escalated = escalateConfidence(tree, positioning, { backfillNeeded: opts.backfillInfo?.needed });
  verdict.confidence = escalated.confidence;

  // Verdict-changers (what would make this actionable).
  const capDecisionObj = { decision: verdict.capital_decision, reason: verdict.capital_decision_reason };
  const verdict_changers_list = buildVerdictChangers(tree, capDecisionObj);

  // Confidence gaps buckets — existing logic preserved + verdict_changers from
  // capital-decision reasons folded in so the PDF surfaces them uniformly.
  const confidence_gaps = {
    high_confidence: [],
    medium_confidence: [],
    known_gaps: [],
    verdict_changers: [...verdict_changers_list],
  };

  if (tree.revenue_estimate?.confidence === 'high') {
    confidence_gaps.high_confidence.push(`Revenue estimate (${tree.revenue_estimate.source || 'source'})`);
  }
  if (tree.parent && !tree.co_owners) {
    confidence_gaps.high_confidence.push('Clear parent company ownership');
  }

  if (tree.revenue_estimate?.confidence === 'medium') {
    confidence_gaps.medium_confidence.push(`Revenue estimate (${tree.revenue_estimate.source || 'source'})`);
  }
  if (tree.signals_found?.length > 0) {
    const verifiedSignals = tree.signals_found.filter((s) => !s.context_unverified);
    if (verifiedSignals.length > 0) {
      confidence_gaps.medium_confidence.push(`${verifiedSignals.length} verified signal${verifiedSignals.length !== 1 ? 's' : ''}`);
    }
  }

  if (tree.parent && !positioning.parent_benchmark) {
    confidence_gaps.known_gaps.push('Parent segment revenue anchor (10-K) not publicly available');
  }
  if (tree.parent && !tree.co_owners && tree.revenue_estimate?.central > 500e6 && !tree.signals_found?.some((s) => s.type === 'm_and_a')) {
    confidence_gaps.known_gaps.push('No M&A/strategic signals detected for large subsidiary');
  }
  if (tree.siblings && tree.siblings.length > 0 && tree.siblings.some((s) => !s.revenue_estimate?.central)) {
    confidence_gaps.known_gaps.push(`${tree.siblings.filter((s) => !s.revenue_estimate?.central).length} sibling(s) without revenue estimates`);
  }
  if (escalated.triggers.length > 0) {
    escalated.triggers.forEach((t) => confidence_gaps.known_gaps.push(t));
  }

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
      confidence_reasoning: escalated.confidence_reasoning,
      thesis: null,
      verdict_changers: verdict_changers_list,
    },
    behavioral_signals,
    top_signals,
    counter_signals,
    corporate_structure,
    mispricing,
    competitive_context: null,
    reconciliation_honest,
    reconciliation_dual_model,
    confidence_gaps,
    strategic_notes_by_audience: {
      for_investors: verdict.capital_decision === 'Not actionable as standalone'
        ? `Treat ${tree.company} as a market-intelligence signal and private comparable, not a transactable target.`
        : 'Pending LLM enrichment',
      for_competitors: null,
      for_ma_advisors: mispricing.ma_attention !== 'none' ? 'Pending LLM enrichment' : null,
      for_growth_signal_users: 'Pending LLM enrichment',
    },
    data_trace,
  };
}
