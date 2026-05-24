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

  // P-NEW.8: when the parent benchmark is itself an estimate range (private
  // parent, no 10-K), express the coverage gap as a range rather than a single
  // false-precision number.
  if (Array.isArray(recon.pct_delta_range) && recon.pct_delta_range.length === 2) {
    const [lo, hi] = recon.pct_delta_range;
    honest_explanation = `${honest_explanation} Parent benchmark is an estimate range, so the true gap spans ${lo > 0 ? '+' : ''}${lo}% to ${hi > 0 ? '+' : ''}${hi}%.`;
  }

  let siblings_likely_overstated = (tree.siblings || [])
    .filter((s) => {
      const hasLowConfidence = s.revenue_estimate?.confidence === 'low';
      const isCircular = recon.circular_siblings?.includes(s.company);
      const isLegacy = s.status === 'legacy' || s.status === 'discontinued';
      return hasLowConfidence || isCircular || isLegacy;
    })
    .map((s) => s.company);

  let siblings_likely_understated = (tree.siblings || [])
    .filter((s) => {
      const inCurrentSources = s.in_current_sources === true;
      const noEstimate = !s.revenue_estimate?.central;
      return inCurrentSources && noEstimate;
    })
    .map((s) => s.company);

  // P-NEW.6: when a MATERIAL gap exists but the strong rules above flagged
  // nobody, surface the likeliest culprits so the gap is never left unexplained.
  // Overshoot → the largest-estimate siblings dominate the sum; shortfall →
  // siblings carrying weak/missing estimates are the likeliest to be understated.
  const delta = recon.pct_delta || 0;
  if (delta > 20 && siblings_likely_overstated.length === 0) {
    siblings_likely_overstated = (tree.siblings || [])
      .filter((s) => (s.revenue_estimate?.central || 0) > 0)
      .sort((a, b) => (b.revenue_estimate.central || 0) - (a.revenue_estimate.central || 0))
      .slice(0, 2)
      .map((s) => s.company);
  }
  if (delta < -20 && siblings_likely_understated.length === 0) {
    siblings_likely_understated = (tree.siblings || [])
      .filter((s) => !s.revenue_estimate?.central || s.revenue_estimate?.confidence === 'low')
      .map((s) => s.company);
  }

  return {
    raw_numbers: {
      sum_siblings: recon.sum_children_central,
      anchor: recon.parent_benchmark,
      anchor_range: recon.benchmark_range || null,
      delta_pct: recon.pct_delta,
      delta_pct_range: recon.pct_delta_range || null,
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

  // Walk the parent chain — the UBO may sit several layers up (focal → opco →
  // group → family). Collect any individual / family_group node along the way.
  const chain = [];
  for (let p = tree.parent; p; p = p.parent) chain.push(p);

  // Case A: any node in the chain is an individual UBO, or a legal_entity
  // marked as a family_group / family_office (e.g. "Walton Enterprises").
  const familyNode = chain.find((n) =>
    n.node_type === 'individual'
    || n.ubo_type === 'family_group'
    || n.ubo_type === 'family_office'
    || /\b(family|familia|trust|enterprises|holdings)\b/i.test(n.company || '') && /\b(family|familia)\b/i.test(n.company || '')
  );
  if (familyNode) {
    const pct = Number(familyNode.ownership_pct) || 100;
    let members;
    // P3.01: prefer the LLM-enumerated family_members list when present, so the
    // detail table shows the individual members (Gianluigi/Rafaela/Diego/Alexa
    // Aponte) rather than a single "X Family" row.
    if (Array.isArray(familyNode.family_members) && familyNode.family_members.length > 0) {
      members = familyNode.family_members.map((m) => ({
        name: m.name || m.company || 'Family member',
        role: m.role || m.ownership_role || 'Family member',
        est_stake: m.est_stake || (m.est_stake_pct != null ? `${m.est_stake_pct}%` : (m.ownership_pct != null ? `${m.ownership_pct}%` : 'undisclosed')),
      }));
    } else {
      // Gather other individuals along the chain or in co_owners that share the
      // dominant surname — gives us a multi-member detail table (Aponte 4).
      const candidates = [familyNode, ...chain.filter((n) => n.node_type === 'individual'), ...co.filter((c) => c.node_type === 'individual')]
        .filter((n, i, arr) => arr.findIndex((m) => m.company === n.company) === i);
      const snLocal = surnameOf(familyNode.company);
      const sameSurname = candidates.filter((c) => snLocal && surnameOf(c.company) === snLocal);
      members = (sameSurname.length >= 2 ? sameSurname : [familyNode]).map((c) => ({
        name: c.company,
        role: c.role || c.ownership_role || (c === familyNode ? 'Founder / Owner' : 'Family member'),
        est_stake: c.ownership_pct ? `${c.ownership_pct}%` : (c === familyNode ? `${pct}%` : 'undisclosed'),
      }));
    }
    const sn = surnameOf(familyNode.company) || (members[0] ? surnameOf(members[0].name) : null);
    return {
      is_family: true,
      total_pct: pct,
      members,
      surname: sn,
    };
  }

  // Case B: co_owners are individuals that share a surname (no allowlist).
  if (co.length > 0) {
    const individuals = co.filter((c) => c.node_type === 'individual');
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

// ─── Public-ancestor detection (P-NEW.1) ──────────────────────────────────
// The nearest publicly-traded entity at or above the focal. Its ticker may sit
// on a tree node (tree.parent.ticker) OR — more commonly — only in the parent
// 10-K anchor (e.g. Doritos: "PEP" lives in parentAnchor, not on any node).
// Returns null when nothing in the chain is public.
export function derivePublicAncestor(tree, parentAnchor = null) {
  if (!tree) return null;
  let node = tree.parent;
  while (node) {
    if (node.ticker || node.public_listing) {
      return { company: node.company, ticker: node.ticker || null, source: 'node' };
    }
    node = node.parent;
  }
  if (parentAnchor && parentAnchor.is_public) {
    let top = tree.parent;
    while (top && top.parent) top = top.parent;
    return {
      company: top?.company || tree.parent?.company || 'parent company',
      ticker: parentAnchor.ticker || null,
      source: 'anchor',
    };
  }
  return null;
}

// ─── Capital Decision Derivation (full taxonomy) ──────────────────────────
// Perfect Brief V2.1 §1: capital_decision drives the verdict label. Family-only
// 100% with no public path → "NOT ACTIONABLE AS STANDALONE". A brand embedded in
// a public conglomerate with no ticker of its own is "Embedded in parent ticker"
// — held/comparable, not separately tradeable (P-NEW.1).
export function deriveCapitalDecision(tree, parentAnchor = null) {
  if (!tree) return { decision: 'Watch', reason: 'no_tree' };
  const family = detectFamilyConcentrated(tree);
  const focalOwnTicker = !!(tree.ticker || tree.public_listing);
  const publicAncestor = derivePublicAncestor(tree, parentAnchor);
  const hasPendingMA = !!tree.pending_acquisition?.acquirer;
  const isPE = tree.terminal_layer === 'private_equity' || tree.parent?.terminal_layer === 'private_equity';

  if (hasPendingMA) return { decision: 'Watch', reason: 'pending_acquisition' };
  if (focalOwnTicker) return { decision: 'Actionable', reason: 'public_listing' };
  if (family.is_family && family.total_pct >= 95) {
    return { decision: 'Not actionable as standalone', reason: 'family_concentrated_100pct' };
  }
  if (isPE) return { decision: 'Actionable via sponsor', reason: 'pe_owned' };
  if (publicAncestor) {
    return { decision: 'Embedded in parent ticker', reason: 'brand_in_public' };
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
export function buildVerdictChangers(tree, capitalDecision, publicAncestor = null) {
  const out = [];
  const family = detectFamilyConcentrated(tree);
  if (capitalDecision?.reason === 'family_concentrated_100pct' && family.surname) {
    const surname = family.surname.charAt(0).toUpperCase() + family.surname.slice(1);
    out.push(`${surname} family announces partial sale or IPO of the operating division.`);
    out.push(`Holding-company restructuring that separates the focal segment from the wider group.`);
    out.push(`Recent acquisitions by the holding of competing assets in the focal category.`);
  } else if (capitalDecision?.reason === 'brand_in_public') {
    const pname = publicAncestor?.company || tree.parent?.company || 'the parent';
    const tk = publicAncestor?.ticker ? ` (${publicAncestor.ticker})` : '';
    const seg = tree.focal_segment || tree.category || 'focal';
    out.push(`${pname}${tk} carves out or spins off ${tree.company} as a standalone listing.`);
    out.push(`${pname} divests the ${seg} business to a strategic or PE buyer.`);
    out.push(`Activist campaign pushes ${pname} to separate the segment for a pure-play re-rating.`);
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

  const cap = deriveCapitalDecision(tree, positioning?.parent_anchor);
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
  // When no competitive_context is supplied, fall back to the sector catalog so
  // a peer set still appears for known consumer/CPG categories.
  let peer_multiples = Array.isArray(competitive_context) && competitive_context.length > 0
    ? {
        peers: competitive_context.slice(0, 5).map((p) => ({
          name: p.competitor,
          revenue: p.estimated_revenue_usd || null,
          ev_to_revenue: null, // LLM-fill
          discount_or_premium_pct: null, // LLM-fill
        })),
        decomposition: null,
        source: 'discovered',
      }
    : null;
  if (!peer_multiples) {
    const catalogPeers = buildPeerMultiplesFromCatalog(tree);
    if (catalogPeers) peer_multiples = catalogPeers;
  }
  if (peer_multiples) {
    // Compute implied valuation if we have the focal's revenue and at least one
    // peer multiple — gives the brief a concrete number even pre-LLM.
    const central = tree.revenue_estimate?.central;
    const multiples = peer_multiples.peers.map((p) => p.ev_to_revenue).filter((v) => typeof v === 'number');
    if (central && multiples.length) {
      const med = multiples.slice().sort((a, b) => a - b)[Math.floor(multiples.length / 2)];
      peer_multiples.implied_valuation_usd = Math.round(central * med);
      peer_multiples.peer_median_ev_revenue = med;
    }
    // Discount decomposition (deterministic ranges; LLM may override).
    if (!peer_multiples.decomposition) {
      peer_multiples.decomposition = buildDiscountDecomposition(tree, derivePublicAncestor(tree, positioning?.parent_anchor));
    }
  }

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
  const publicAncestor = derivePublicAncestor(tree, positioning?.parent_anchor);
  const verdict_changers_list = buildVerdictChangers(tree, capDecisionObj, publicAncestor);

  // P5.04: the mispricing section should be self-contained — cross-reference the
  // verdict-changer events as deterministic falsifying signals when the LLM has
  // not supplied sharper ones. (LLM enrichment may override downstream.)
  if (!Array.isArray(mispricing.falsifying_signals) || mispricing.falsifying_signals.length === 0) {
    mispricing.falsifying_signals = verdict_changers_list.slice(0, 4);
  }

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

  // V2.1 enrichment: confidence buckets, verdict-changer condition→label map,
  // gap leverage stars, section-confidence breakdown, sources split, and the
  // capital-path one-liner for the hero. All deterministic seeds — LLM may
  // augment but the brief renders correctly even without enrichment.
  const verdict_changer_map = buildVerdictChangerMap(tree, capDecisionObj, family_detail, publicAncestor);
  const confidence_buckets = buildConfidenceBuckets(tree, positioning, escalated.triggers);
  const known_gaps_starred = buildGapLeverageStars(confidence_gaps.known_gaps, family_detail);
  const section_confidence = buildSectionConfidence(tree, positioning, mispricing, family_detail);
  const limitations_list = buildLimitationsList(tree, positioning, escalated.triggers);
  const data_trace_split = splitDataSources(tree);
  const capital_path_summary = buildCapitalPathSummaryText(tree, family_detail, capDecisionObj, publicAncestor);
  const actionable_reads = buildActionableReads(tree, verdict, mispricing, family_detail);

  return {
    verdict: {
      ...verdict,
      confidence_reasoning: escalated.confidence_reasoning,
      thesis: null,
      verdict_changers: verdict_changers_list,
      verdict_changer_map,
      capital_path_summary,
    },
    behavioral_signals,
    top_signals,
    counter_signals,
    corporate_structure,
    mispricing: { ...mispricing, actionable_reads },
    competitive_context: null,
    reconciliation_honest,
    reconciliation_dual_model,
    confidence_gaps: { ...confidence_gaps, known_gaps_starred },
    confidence_buckets,
    section_confidence,
    limitations_list,
    strategic_notes_by_audience: {
      for_investors: verdict.capital_decision === 'Not actionable as standalone'
        ? `Treat ${tree.company} as a market-intelligence signal and private comparable, not a transactable target.`
        : capDecisionObj.reason === 'brand_in_public'
          ? `Treat ${tree.company} as a pure-play comparable embedded in ${publicAncestor?.company || 'its public parent'}${publicAncestor?.ticker ? ` (${publicAncestor.ticker})` : ''}; exposure is only available via the parent or a future carve-out.`
          : 'Pending LLM enrichment',
      for_competitors: 'N/A - competitive reads are summarized in the Competitive Context section.',
      for_ma_advisors: mispricing.ma_attention !== 'none'
        ? 'Pending LLM enrichment'
        : capDecisionObj.reason === 'brand_in_public'
          ? `N/A - no standalone M&A path; a deal would require ${publicAncestor?.company || 'the parent'} to carve out or divest the brand.`
          : 'N/A - no active M&A signals; no live transaction path.',
      for_growth_signal_users: 'Pending LLM enrichment',
    },
    data_trace: { ...data_trace, ...data_trace_split },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// V2.1 Perfect-Brief enrichment helpers (added in Task #58)
// ═══════════════════════════════════════════════════════════════════════════

// ─── Consumer sector whitelist + B2B-niche guard (P6.01) ──────────────────
// The previous B2B-niche classifier was too aggressive — DTC mattress, cruise,
// and chocolate brands ended up with `competitive_context = null`. Surface a
// whitelist of consumer categories that ALWAYS deserve a peer set discovery
// attempt, even when their name contains words like "platform".
export const CONSUMER_SECTOR_KEYWORDS = [
  'cruise', 'cruises', 'crucero', 'cruceros', 'cruise line',
  'cpg', 'consumer goods', 'food', 'snack', 'chocolate', 'confectionery',
  'beverage', 'drink', 'alcohol', 'spirits', 'wine', 'beer',
  'apparel', 'fashion', 'luxury', 'jewelry', 'watch', 'eyewear',
  'auto', 'automotive', 'vehicle', 'motorcycle', 'aviation',
  'mattress', 'sleep', 'bedding', 'furniture', 'home goods',
  'retail', 'dtc', 'direct-to-consumer', 'ecommerce',
  'hospitality', 'hotel', 'restaurant', 'qsr',
  'pharma', 'biotech', 'medical device', 'health',
  'media', 'entertainment', 'streaming', 'studio', 'music', 'gaming',
  'fintech', 'banking', 'insurance', 'payments',
  'telecom', 'wireless', 'mobile',
];

export function isConsumerSector(tree) {
  if (!tree) return false;
  const haystack = [
    tree.company, tree.focal_segment, tree.category, tree.industry,
    ...(tree.signals_found || []).map((s) => `${s.label || ''} ${s.value || ''}`),
  ].join(' ').toLowerCase();
  return CONSUMER_SECTOR_KEYWORDS.some((kw) => haystack.includes(kw));
}

// ─── Peer multiples catalog (P5.02) ───────────────────────────────────────
// Static catalog keyed by sector — concrete EV/Revenue ranges from public
// comparables so the brief shows a peer set even when web search returns nothing.
export const PEER_MULTIPLES_CATALOG = {
  cruise: {
    peers: [
      { name: 'Carnival Corp (CCL)', revenue: 21.6e9, ev_to_revenue: 2.4 },
      { name: 'Royal Caribbean (RCL)', revenue: 13.9e9, ev_to_revenue: 3.8 },
      { name: 'Norwegian Cruise Line (NCLH)', revenue: 8.5e9, ev_to_revenue: 3.0 },
      { name: 'Viking Holdings (VIK)', revenue: 4.7e9, ev_to_revenue: 4.5 },
    ],
    keywords: ['cruise', 'cruises', 'crucero', 'cruceros', 'cruise line'],
  },
  chocolate_cpg: {
    peers: [
      { name: 'Mondelez (MDLZ)', revenue: 36.0e9, ev_to_revenue: 3.5 },
      { name: 'Hershey (HSY)', revenue: 11.2e9, ev_to_revenue: 3.6 },
      { name: 'Nestlé (NESN)', revenue: 100.0e9, ev_to_revenue: 3.2 },
      { name: 'Lindt & Sprüngli', revenue: 5.5e9, ev_to_revenue: 4.0 },
    ],
    keywords: ['chocolate', 'confectionery', 'candy', 'snack'],
  },
  luxury_auto: {
    peers: [
      { name: 'Ferrari (RACE)', revenue: 6.8e9, ev_to_revenue: 11.5 },
      { name: 'Porsche AG (P911)', revenue: 41.0e9, ev_to_revenue: 1.8 },
      { name: 'Bentley (private, VW)', revenue: 3.4e9, ev_to_revenue: null },
      { name: 'Aston Martin Lagonda (AML.L)', revenue: 1.6e9, ev_to_revenue: 1.4 },
    ],
    keywords: ['luxury auto', 'sports car', 'supercar', 'aston martin', 'ferrari'],
  },
  outdoor_apparel: {
    peers: [
      { name: 'VF Corporation (VFC, The North Face)', revenue: 10.9e9, ev_to_revenue: 0.9 },
      { name: 'Columbia Sportswear (COLM)', revenue: 3.4e9, ev_to_revenue: 1.0 },
      { name: 'Yeti Holdings (YETI)', revenue: 1.7e9, ev_to_revenue: 1.8 },
      { name: 'Canada Goose (GOOS)', revenue: 0.95e9, ev_to_revenue: 1.5 },
    ],
    keywords: ['outdoor', 'patagonia', 'north face', 'apparel'],
  },
  dtc_mattress: {
    peers: [
      { name: 'Sleep Number (SNBR)', revenue: 1.9e9, ev_to_revenue: 0.5 },
      { name: 'Purple Innovation (PRPL)', revenue: 0.49e9, ev_to_revenue: 0.6 },
      { name: 'Tempur Sealy (TPX)', revenue: 5.0e9, ev_to_revenue: 1.6 },
    ],
    keywords: ['mattress', 'sleep', 'bedding', 'nectar', 'awara', 'casper'],
  },
  fintech_banking: {
    peers: [
      { name: 'SoFi Technologies (SOFI)', revenue: 2.1e9, ev_to_revenue: 7.0 },
      { name: 'Block (SQ)', revenue: 23.5e9, ev_to_revenue: 1.8 },
      { name: 'Marqeta (MQ)', revenue: 0.68e9, ev_to_revenue: 1.6 },
    ],
    keywords: ['fintech', 'banking', 'neobank', 'mercury'],
  },
  salty_snacks: {
    peers: [
      { name: 'Mondelez (MDLZ)', revenue: 36.0e9, ev_to_revenue: 3.5 },
      { name: 'Kellanova (K)', revenue: 13.0e9, ev_to_revenue: 2.6 },
      { name: 'General Mills (GIS)', revenue: 20.0e9, ev_to_revenue: 2.5 },
      { name: 'Campbell Soup (CPB)', revenue: 9.6e9, ev_to_revenue: 2.0 },
      { name: 'Utz Brands (UTZ)', revenue: 1.4e9, ev_to_revenue: 1.6 },
    ],
    keywords: ['tortilla', 'chips', 'potato chip', 'corn chip', 'pretzel', 'popcorn', 'doritos', 'salty snack'],
  },
};

export function detectSector(tree) {
  if (!tree) return null;
  const hay = [tree.company, tree.focal_segment, tree.category, tree.industry]
    .filter(Boolean).join(' ').toLowerCase();
  for (const [key, def] of Object.entries(PEER_MULTIPLES_CATALOG)) {
    if (def.keywords.some((k) => hay.includes(k))) return key;
  }
  return null;
}

export function buildPeerMultiplesFromCatalog(tree) {
  const sector = detectSector(tree);
  if (!sector) return null;
  const entry = PEER_MULTIPLES_CATALOG[sector];
  return {
    sector,
    peers: entry.peers.map((p) => ({
      name: p.name,
      revenue: p.revenue || null,
      ev_to_revenue: p.ev_to_revenue,
      discount_or_premium_pct: null,
    })),
    decomposition: null,
    source: 'catalog',
  };
}

// P6.02: best-effort EV/Revenue lookup for a web-discovered competitor by
// matching its name against the focal's sector peer-multiples catalog. Returns
// a number or null (discovered peers carry no multiple of their own).
export function lookupPeerEvToRevenue(tree, peerName) {
  const sector = detectSector(tree);
  if (!sector) return null;
  const entry = PEER_MULTIPLES_CATALOG[sector];
  if (!entry) return null;
  const norm = (s) => String(s || '').toLowerCase().replace(/\([^)]*\)/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const target = norm(peerName);
  if (!target) return null;
  const targetHead = target.split(' ')[0];
  const hit = entry.peers.find((p) => {
    const pn = norm(p.name);
    if (!pn) return false;
    return pn.includes(target) || target.includes(pn) || pn.split(' ')[0] === targetHead;
  });
  return hit && typeof hit.ev_to_revenue === 'number' ? hit.ev_to_revenue : null;
}

// ─── Discount decomposition (P5.03) ───────────────────────────────────────
// Deterministic % ranges for illiquidity, conglomerate, governance discounts.
// LLM may overwrite with sharper numbers when peer comps differ.
export function buildDiscountDecomposition(tree, publicAncestor = null) {
  const components = [];
  const isPublic = !!(tree?.ticker || tree?.parent?.ticker || tree?.public_listing);
  const family = detectFamilyConcentrated(tree);
  const hasConglomerateParent = tree?.parent && !tree?.parent?.ticker && (tree?.parent?.revenue_estimate?.central || 0) > 5 * (tree?.revenue_estimate?.central || 1e9);

  // A brand embedded in a PUBLIC conglomerate is not illiquid — the discount is
  // that you cannot buy the brand directly, only the parent or a carve-out
  // (P-NEW.2). Otherwise apply the standard private illiquidity discount.
  if (publicAncestor) {
    const tk = publicAncestor.ticker ? ` (${publicAncestor.ticker})` : '';
    components.push({ label: 'Conglomerate embed / not separately tradeable', pct_range: '15–25%', note: `Embedded in ${publicAncestor.company}${tk} — capital accessible only via parent shares or a carve-out, not a direct stake in ${tree?.company}.` });
  } else if (!isPublic) {
    components.push({ label: 'Illiquidity', pct_range: '20–30%', note: 'Private-company discount applied to public-peer multiples.' });
  }
  if (!publicAncestor && hasConglomerateParent) components.push({ label: 'Conglomerate / segment-mix', pct_range: '10–20%', note: `Embedded in ${tree.parent.company} — capital not directly accessible to focal-only acquirers.` });
  if (family.is_family && family.total_pct >= 95) {
    components.push({ label: 'Governance / family control', pct_range: '10–15%', note: 'Family-concentrated 100% with no public path — no monetization mechanism absent succession event.' });
  } else if (tree?.co_owners?.length > 1) {
    components.push({ label: 'Governance / split control', pct_range: '5–10%', note: 'Multi-owner structure limits unilateral capital decisions.' });
  }
  if (!components.length) return null;
  const totalLow = components.reduce((a, c) => a + parseInt(c.pct_range, 10), 0);
  const totalHigh = components.reduce((a, c) => a + parseInt(c.pct_range.split('–')[1], 10), 0);
  return {
    components,
    aggregate_discount_range: `${totalLow}–${totalHigh}%`,
  };
}

// ─── Actionable reads (P5.05) ─────────────────────────────────────────────
// Translates the thesis into PE / comparables / competitive-intel takeaways.
export function buildActionableReads(tree, verdict, mispricing, family) {
  const reads = [];
  if (verdict?.capital_decision === 'Not actionable as standalone') {
    reads.push({ audience: 'PE / direct-acquirers', read: `No direct transaction path. Hold a watch list for ${family?.surname ? family.surname.charAt(0).toUpperCase() + family.surname.slice(1) + ' family' : 'controlling owner'} succession or holding-company restructuring announcements.` });
    reads.push({ audience: 'Public-market comparables', read: `Use ${tree?.company} as a private benchmark when modeling public peers in the same category — useful for sanity-checking peer growth rates and unit economics.` });
    reads.push({ audience: 'Competitive intelligence', read: `Track capex, fleet/asset orders, and hiring as the only reliable forward indicators given the absence of quarterly disclosures.` });
  } else if (mispricing?.peer_multiples) {
    reads.push({ audience: 'PE / direct-acquirers', read: `Peer EV/Rev range ${mispricing.peer_multiples.peer_median_ev_revenue ? `~${mispricing.peer_multiples.peer_median_ev_revenue}×` : 'see peer table'} sets a reference for entry pricing; combine with the discount decomposition to bracket bid range.` });
    reads.push({ audience: 'Public-market comparables', read: `Trade triangulation against the listed peers in the catalog; private discount inferred ${mispricing.peer_multiples.decomposition?.aggregate_discount_range || 'unknown range'}.` });
  } else {
    reads.push({ audience: 'Competitive intelligence', read: `Treat the captured behavioral signals as the primary read on capital posture; verdict-changers list the events that would flip the thesis.` });
  }
  return reads;
}

// ─── Verdict-changer condition→label map (P7.03) ──────────────────────────
export function buildVerdictChangerMap(tree, capDecision, family, publicAncestor = null) {
  const map = [];
  if (capDecision?.reason === 'family_concentrated_100pct' && family?.surname) {
    const surname = family.surname.charAt(0).toUpperCase() + family.surname.slice(1);
    map.push({ condition: `${surname} family announces partial sale or IPO of operating division`, new_label: 'ACQUIRE TARGET' });
    map.push({ condition: 'Holding-company restructuring separates focal segment from group', new_label: 'WATCH (transactability path opens)' });
    map.push({ condition: 'Founder succession event triggers governance review', new_label: 'WATCH' });
  } else if (capDecision?.reason === 'brand_in_public') {
    const pname = publicAncestor?.company || tree?.parent?.company || 'Parent';
    map.push({ condition: `${pname} carves out / spins off ${tree?.company} as a standalone listing`, new_label: 'ACQUIRE TARGET (pure-play emerges)' });
    map.push({ condition: `${pname} divests the segment to a strategic or PE buyer`, new_label: 'WATCH (transaction path opens)' });
    map.push({ condition: 'Activist pressure forces a segment separation', new_label: 'WATCH' });
  } else if (capDecision?.reason === 'pe_owned') {
    map.push({ condition: 'Sponsor files S-1 / announces dual-track', new_label: 'ACQUIRE TARGET (window opens)' });
    map.push({ condition: 'Secondary stake sold to strategic acquirer', new_label: 'WATCH' });
  } else if (capDecision?.reason === 'default_subsidiary') {
    map.push({ condition: 'Parent divests focal as standalone', new_label: 'ACQUIRE TARGET' });
    map.push({ condition: 'Reconciliation gap widens >50% (likely missing segments)', new_label: 'HOLD with caveat (estimate quality drops)' });
  }
  if (tree?.pending_acquisition || tree?.acquisition?.status === 'rumored') {
    map.push({ condition: 'Pending or rumored M&A confirmed / closes', new_label: 'WATCH (post-close consolidation)' });
  }
  return map;
}

// ─── Confidence buckets HIGH/MED/LOW with one-line reasons (P7.01) ────────
export function buildConfidenceBuckets(tree, positioning, escalatedTriggers = []) {
  const high = [];
  const medium = [];
  const low = [];
  const rev = tree?.revenue_estimate || {};
  const recon = positioning?.reconciliation || null;

  if (rev.confidence === 'high') high.push({ claim: 'Revenue central estimate', reason: rev.source ? `Anchored to ${rev.source}` : 'Single defensible anchor' });
  if (tree?.parent?.ticker) high.push({ claim: 'Parent identity / public listing', reason: `Verifiable via ${tree.parent.ticker} filings` });
  if (positioning?.parent_anchor?.is_public && positioning.parent_anchor.fiscal_year) {
    high.push({ claim: 'Parent revenue benchmark', reason: `${positioning.parent_anchor.fiscal_year} 10-K segment data` });
  }

  if (rev.confidence === 'medium') medium.push({ claim: 'Revenue central estimate', reason: rev.source ? `Triangulated from ${rev.source}` : 'Multiple weak anchors' });
  const verifiedSig = (tree?.signals_found || []).filter((s) => !s.context_unverified).length;
  if (verifiedSig > 0) medium.push({ claim: `${verifiedSig} verified behavioral signal${verifiedSig === 1 ? '' : 's'}`, reason: 'Source attributed and cross-checked' });
  if (recon && Math.abs(recon.pct_delta || 0) <= 30 && positioning?.parent_anchor?.is_public) {
    medium.push({ claim: 'Sibling-set sum vs parent anchor', reason: `Within ${Math.abs(recon.pct_delta)}% of 10-K segment` });
  }

  if (rev.confidence === 'low' || (rev.high && rev.low && rev.low > 0 && rev.high / rev.low >= 2)) {
    low.push({ claim: 'Revenue central estimate', reason: `Range spread ${rev.high && rev.low ? `${(rev.high / rev.low).toFixed(1)}×` : 'wide'}` });
  }
  escalatedTriggers.forEach((t) => low.push({ claim: 'Confidence escalation trigger', reason: t }));
  if (tree?.parent && !positioning?.parent_anchor?.is_public) {
    low.push({ claim: 'Parent revenue benchmark', reason: 'No public 10-K available; benchmark uses estimates only' });
  }

  return { high, medium, low };
}

// ─── Gap leverage stars (P7.02) ───────────────────────────────────────────
// ★★★ family succession / IPO; ★★ M&A; ★ everything else.
export function buildGapLeverageStars(knownGaps = [], family = null) {
  return knownGaps.map((g) => {
    let stars = 1;
    const t = String(g).toLowerCase();
    if (family?.is_family && /succession|family|founder/.test(t)) stars = 3;
    else if (/ipo|partial sale|spin-off|m&a|acquisition|divest/.test(t)) stars = 3;
    else if (/anchor|10-k|benchmark|reconciliation/.test(t)) stars = 2;
    return { gap: g, stars };
  });
}

// ─── Section confidence (per-section star) (P9.04) ────────────────────────
export function buildSectionConfidence(tree, positioning, mispricing, family, competitiveContext = null) {
  const score = (cond, low, mid, high) => (cond === 'high' ? high : cond === 'low' ? low : mid);
  const rev = tree?.revenue_estimate || {};
  const stars = (n) => '*'.repeat(Math.max(1, Math.min(3, n)));
  // competitiveContext is sourced from brief-level (passed in from caller); fall
  // back to tree.competitive_context for backwards compat.
  const ctx = competitiveContext || tree?.competitive_context;
  const hasCtx = Array.isArray(ctx) && ctx.length > 0;
  return {
    verdict: { stars: stars(score(rev.confidence, 1, 2, 3)), reason: rev.confidence === 'high' ? 'Anchored estimate' : 'Estimate-driven' },
    behavioral_signals: { stars: stars((tree?.signals_found || []).filter((s) => !s.context_unverified).length >= 3 ? 3 : 2), reason: `${(tree?.signals_found || []).length} captured` },
    corporate_structure: { stars: stars(family?.is_family || tree?.parent?.ticker ? 3 : 2), reason: family?.is_family ? 'Family UBO identified' : (tree?.parent ? 'Parent identified' : 'Standalone') },
    reconciliation: { stars: stars(positioning?.parent_anchor?.is_public ? 3 : positioning?.reconciliation ? 2 : 1), reason: positioning?.parent_anchor?.is_public ? '10-K anchored' : 'Triangulated only' },
    mispricing: { stars: stars(mispricing?.peer_multiples?.source === 'discovered' ? 3 : mispricing?.peer_multiples ? 2 : 1), reason: mispricing?.peer_multiples?.source === 'discovered' ? 'Web-discovered peers' : mispricing?.peer_multiples ? 'Catalog peers' : 'No peer set' },
    competitive_context: { stars: stars(hasCtx ? 3 : 1), reason: hasCtx ? 'Peer set identified' : 'Discovery phase' },
  };
}

// ─── Section-confidence refresh after competitive discovery (P-NEW.3) ─────
// buildSectionConfidence runs at brief-build time, when competitive_context is
// still null (discovery is a later async web-search phase). Once the app
// attaches the discovered peer set, call this to recompute the two entries that
// depend on it so they no longer read a permanent 1-star "Discovery phase".
export function refreshCompetitiveSectionConfidence(brief) {
  if (!brief || !brief.section_confidence) return brief;
  const stars = (n) => '*'.repeat(Math.max(1, Math.min(3, n)));
  const ctx = brief.competitive_context;
  const hasCtx = Array.isArray(ctx) && ctx.length > 0;
  brief.section_confidence.competitive_context = {
    stars: stars(hasCtx ? 3 : 1),
    reason: hasCtx ? 'Peer set identified' : 'Discovery phase',
  };
  const pm = brief.mispricing && brief.mispricing.peer_multiples;
  brief.section_confidence.mispricing = {
    stars: stars(pm && pm.source === 'discovered' ? 3 : pm ? 2 : 1),
    reason: pm && pm.source === 'discovered' ? 'Web-discovered peers' : pm ? 'Catalog peers' : 'No peer set',
  };
  return brief;
}

// ─── Limitations list (P9.03) ─────────────────────────────────────────────
export function buildLimitationsList(tree, positioning, escalatedTriggers = []) {
  const out = [];
  if (tree?.parent && !positioning?.parent_anchor?.is_public) out.push(`${tree.parent.company} is private — no 10-K anchor; reconciliation uses estimates only.`);
  if (tree?.revenue_estimate?.high && tree?.revenue_estimate?.low && tree.revenue_estimate.high / tree.revenue_estimate.low >= 2) {
    out.push(`Revenue range spread ${(tree.revenue_estimate.high / tree.revenue_estimate.low).toFixed(1)}× — central is a midpoint, not a single defensible number.`);
  }
  const sibs = tree?.siblings || [];
  if (sibs.some((s) => !s.revenue_estimate?.central)) out.push(`${sibs.filter((s) => !s.revenue_estimate?.central).length} of ${sibs.length} captured siblings lack revenue estimates.`);
  if (escalatedTriggers.length) out.push('Confidence forced to LOW (see triggers in confidence buckets).');
  if (!tree?.signals_found?.length) out.push('No behavioral signals captured — verdict trajectory inferred from structure alone.');
  return out;
}

// ─── Sources split: primary used vs excluded with reason (P9.01) ──────────
export function splitDataSources(tree) {
  const primary_used = new Set();
  const excluded = [];
  if (tree?.revenue_estimate?.source) primary_used.add(tree.revenue_estimate.source);
  (tree?.signals_found || []).forEach((s) => { if (s.source) primary_used.add(s.source); });
  (tree?.strategic_control || []).forEach((s) => { if (s.source) primary_used.add(s.source); });

  // Common exclusions: SimilarWeb (web-traffic-only, misleading for offline categories);
  // PitchBook / S&P Capital IQ (subscription-walled).
  const sector = detectSector(tree);
  if (sector === 'cruise' || sector === 'luxury_auto' || sector === 'dtc_mattress') {
    excluded.push({ source: 'SimilarWeb', reason: 'Web-traffic proxy under-represents revenue for offline/asset-heavy categories.' });
  }
  excluded.push({ source: 'PitchBook / S&P Capital IQ', reason: 'Subscription-walled; not used in this run.' });
  return {
    primary_used: Array.from(primary_used),
    excluded_with_reason: excluded,
  };
}

// ─── Capital-path one-line summary (P1.04) ────────────────────────────────
export function buildCapitalPathSummaryText(tree, family, capDecision, publicAncestor = null) {
  const parts = [];
  if (capDecision?.reason === 'brand_in_public' && publicAncestor) {
    const tk = publicAncestor.ticker ? ` (${publicAncestor.ticker})` : '';
    const maSig = (tree?.signals_found || []).some((s) => s.type === 'm_and_a');
    return [`Brand within ${publicAncestor.company}${tk}`, 'Not separately tradeable', maSig ? 'Recent M&A activity' : 'No standalone M&A path'].join(' · ');
  }
  if (family?.is_family && family.total_pct >= 95) parts.push('Family-owned private');
  else if (capDecision?.reason === 'pe_owned') parts.push('PE-owned');
  else if (tree?.parent?.ticker) parts.push(`Subsidiary of ${tree.parent.ticker}`);
  else if (tree?.parent) parts.push(`Subsidiary of ${tree.parent.company}`);
  else if (tree?.ticker) parts.push(`Public (${tree.ticker})`);
  else parts.push('Standalone private');

  if (!tree?.ticker && !tree?.parent?.ticker) parts.push('No public ticker');
  const maSig = (tree?.signals_found || []).some((s) => s.type === 'm_and_a');
  parts.push(maSig ? 'Recent M&A activity' : 'No M&A activity');
  return parts.join(' · ');
}

// ─── PDF unicode → ASCII sanitizer (R.02, P.PDF polish) ───────────────────
// jsPDF's standard helvetica font is WinAnsi only — many glyphs in the brief
// (▣ ★ ◆ ▣ • − …) render as garbage or fall back to (""). Map them explicitly.
export function sanitizeForPdf(s) {
  return String(s ?? '')
    .replace(/[▣■▪]/g, '#')
    .replace(/[◆◇]/g, '*')
    .replace(/[★☆]/g, '*')
    .replace(/[•·●]/g, '-')
    .replace(/[—–]/g, '-')
    .replace(/[−]/g, '-')
    .replace(/[…]/g, '...')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[⚠]/g, '!')
    .replace(/[✓✔]/g, 'OK')
    .replace(/[○◯]/g, 'o')
    .replace(/[→➔➜]/g, '->')
    .replace(/[←]/g, '<-')
    .replace(/[\u{2265}\u{2267}\u{2A7E}]/gu, '>=')
    .replace(/[\u{2264}\u{2266}\u{2A7D}]/gu, '<=')
    .replace(/[\u{00D7}]/gu, 'x')
    .replace(/[\u{20AC}]/gu, 'EUR')
    .replace(/[\u{1F000}-\u{1FAFF}]/gu, '')
    .replace(/[\u{2190}-\u{21FF}]/gu, '')
    .replace(/[\u{2300}-\u{27BF}]/gu, '')
    .replace(/[\u{2B00}-\u{2BFF}]/gu, '')
    // Safety net: any remaining code point > U+00FF makes jsPDF switch the whole
    // string to 2-byte encoding — garbled glyphs plus a blank inserted before
    // every letter, so the line renders ~2x wide and overflows the margin. Strip
    // them so one stray glyph can never poison a whole line again.
    .replace(/[^\u{0000}-\u{00FF}]/gu, '')
    .replace(/\uFE0F/g, '');
}
