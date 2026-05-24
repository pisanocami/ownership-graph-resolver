// Entity schema — runtime layer (Ticket #59 v2, Stream A1 + A6).
// schemas/entity.ts is the typed source of truth; this file is the runtime
// counterpart imported by synth.js. Keep the two in sync.

export const NODE_TYPES = [
  'individual',
  'family',
  'private_equity_firm',
  'public_company',
  'private_company',
  'divisional_aggregator',
  'house_of_brands_aggregator',
  'operating_brand',
];

export const LAYERS = ['root', 'parent', 'aggregator', 'brand', 'focal'];

export const SECONDARY_RELATIONSHIP_TYPES = [
  'brand_authority',
  'geographic_alias',
  'acquisition_history',
  'co_brand',
  'controlling_shareholder',
  'stewardship',
  'internal_launch_by',
];

// Fields the ownership MODEL is allowed to emit (the input contract, mirrored
// from the OWNERSHIP_PROMPT JSON schema) plus the additive relationship-model
// fields introduced in Tickets #57/#59. enforceSchema() strips anything outside
// this set — that is how a model-improvised field like Gemini's
// `_divisional_aggregators` gets rejected (NEW.35) while aggregation flows
// through the deterministic code path in synth.js instead.
export const MODEL_ENTITY_FIELDS = new Set([
  // core identity / structure
  'company', 'domain', 'node_type', 'layer', 'standalone', 'terminal_layer',
  'category', 'focal_segment', 'origin_event', 'parent', 'children',
  // ownership / control
  'ubo_type', 'stake', 'family_members', 'ownership_role', 'co_owners',
  'strategic_control', 'strategic_control_note',
  // relatives
  'siblings', 'intra_parent_cousins', 'cousins', 'future_cousins_post_close',
  // deals
  'pending_acquisition', 'post_close_consolidated_parent', 'acquisition',
  // presence / provenance
  'in_current_sources', 'in_historical_sources', 'last_mention_date',
  'confidence', 'sources', 'notes', 'source_urls',
  'disambiguation_required', 'disambiguation_candidates',
  // sibling / cousin sub-fields
  'revenue_model', 'via_division',
  // co_owner sub-fields
  'stake_pct', 'voting_pct', 'evidence', 'entity_type',
  // additive relationship model (Ticket #57/#59)
  'primary_parent_id', 'secondary_relationships', 'ticker',
]);

// Keys whose values are arrays/objects of further entities — enforceSchema
// recurses into these. Everything else (family_members, strategic_control,
// stake, acquisition, …) is kept opaque so its sub-fields are never stripped.
const ENTITY_ARRAY_KEYS = [
  'children', 'siblings', 'intra_parent_cousins', 'cousins',
  'co_owners', 'future_cousins_post_close',
];

const LEGAL_SUFFIX_RE = /\b(inc|incorporated|corp|corporation|co|company|ltd|limited|llc|lp|llp|plc|sa|ag|nv|gmbh|kg|spa|pty|holdings?|group)\b/i;

function lc(s) {
  return (s || '').toString().toLowerCase();
}

function hasInvestorControl(node) {
  const sc = Array.isArray(node?.strategic_control) ? node.strategic_control : [];
  return sc.some((c) => /investor|shareholder|sponsor|backer|partner|fund/i.test(c?.role_description || c?.relationship || ''));
}

// Deterministic PE-firm detector (NEW.13 / NEW.17). A private-equity firm's
// own revenue is management-fee income, NOT ownership-chain revenue of its
// portfolio, so callers use this to skip reconciliation and to populate
// founder co_owners.
export function isPrivateEquityFirm(node) {
  if (!node) return false;
  if (node.node_type === 'private_equity_firm') return true;
  if (node.ubo_type === 'pe_firm') return true;
  if (node.terminal_layer === 'private_equity') return true;
  const cat = lc(node.category);
  if (/private equity|buyout|\blbo\b|leveraged buyout|investment firm/.test(cat)) return true;
  const name = lc(node.company);
  const nameLooksPE = /\bcapital\b|\bpartners\b|\bequity\b|\bventures?\b|\bmanagement l\.?p\.?\b/.test(name);
  return nameLooksPE && hasInvestorControl(node);
}

// Map any node onto the canonical 8-value node_type enum (non-destructive read).
// Legacy values emitted by the model — "legal_entity", "operating_brand",
// "individual" — and older cached investigations all resolve here so callers
// (synth canonical pass, frontend selectNodeType, validation) speak one enum.
export function normalizeNodeType(node) {
  if (!node) return 'operating_brand';
  const raw = node.node_type;

  // Already canonical (and not a legacy alias) → pass through.
  if (raw && NODE_TYPES.includes(raw) && raw !== 'operating_brand') return raw;

  if (raw === 'individual') return 'individual';
  if (isPrivateEquityFirm(node)) return 'private_equity_firm';

  if (raw === 'legal_entity' || raw === 'public_company' || raw === 'private_company') {
    if (node.ubo_type === 'family_group') return 'family';
    if (node.ticker || node.public_listing === true || node.standalone === false && node.ticker) return 'public_company';
    if (node.ticker) return 'public_company';
    return 'private_company';
  }

  if (raw === 'operating_brand') return 'operating_brand';

  // Unknown / missing: infer from shape.
  if (node.ubo_type === 'family_group') return 'family';
  if (node.ticker) return 'public_company';
  const hasPortfolio = (node.children?.length || 0) > 0 || (node.siblings?.length || 0) > 0;
  if (hasPortfolio && LEGAL_SUFFIX_RE.test(node.company || '')) return 'private_company';
  return 'operating_brand';
}

// A ticker only legitimately lives on a public_company. It must NOT inherit up
// the chain to a PE-firm/UBO parent (NEW.14: QSR belongs on RBI, not 3G).
export function shouldKeepTicker(node) {
  return normalizeNodeType(node) === 'public_company';
}

// Validate a (possibly post-synthesis) entity. Returns { valid, errors }.
export function validateEntity(node) {
  const errors = [];
  if (!node || typeof node !== 'object') return { valid: false, errors: ['not an object'] };
  if (!node.company) errors.push('missing company');
  const canon = normalizeNodeType(node);
  if (!NODE_TYPES.includes(canon)) errors.push(`invalid node_type: ${canon}`);
  if (node.layer != null && !LAYERS.includes(node.layer)) {
    errors.push(`invalid layer: ${node.layer}`);
  }
  if (node.ticker != null && !shouldKeepTicker(node)) {
    errors.push(`ticker present on non-public node (${canon})`);
  }
  if (Array.isArray(node.secondary_relationships)) {
    node.secondary_relationships.forEach((r, i) => {
      if (r && r.relationship_type && !SECONDARY_RELATIONSHIP_TYPES.includes(r.relationship_type)) {
        errors.push(`secondary_relationships[${i}] invalid type: ${r.relationship_type}`);
      }
    });
  }
  return { valid: errors.length === 0, errors };
}

// A6 — schema enforcement at the model boundary (NEW.35).
// Recursively strip undeclared keys from raw ownership-model output and report
// what was rejected. Run this on the parsed ownership JSON BEFORE synthesis so
// improvised fields never enter the pipeline; deterministic code (A4) generates
// the legitimate derived fields afterward.
export function enforceSchema(modelOutput, _rejectedAcc = null) {
  const topLevel = _rejectedAcc === null;
  const rejected = _rejectedAcc || new Set();

  const cleanNode = (node) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
    const cleaned = {};
    for (const [k, v] of Object.entries(node)) {
      if (!MODEL_ENTITY_FIELDS.has(k)) {
        rejected.add(k);
        continue;
      }
      if (k === 'parent') {
        cleaned[k] = cleanNode(v);
      } else if (ENTITY_ARRAY_KEYS.includes(k) && Array.isArray(v)) {
        cleaned[k] = v.map((child) => cleanNode(child));
      } else {
        cleaned[k] = v;
      }
    }
    return cleaned;
  };

  const cleaned = cleanNode(modelOutput);
  if (topLevel) {
    const rejectedList = [...rejected];
    if (rejectedList.length > 0) {
      console.warn(`[schema] Model improvised fields rejected: ${rejectedList.join(', ')}`);
    }
    return { cleaned, rejected: rejectedList };
  }
  return cleaned;
}
