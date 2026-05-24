// Search-strategy whitelist (Ticket #59 v2, Stream D3 — NEW.36).
//
// For each entity category we declare the searches that MUST be attempted,
// regardless of whether the model independently decides to run them. This is
// what levels the playing field across models and kills the 8× revenue variance
// (Awara $8.5M vs $65M): Awara's revenue always anchors to the same data
// sources (Grips Intelligence / Semrush) because those queries are always run.
//
// Precedence (open-question #3, confirmed): post-hoc append. The model may run
// its own searches; the whitelist is ALSO always attempted and merged in.

export const SEARCH_STRATEGIES = {
  'operating_brand:mattress': [
    '{brand} Grips Intelligence revenue',
    '{brand} Similarweb traffic',
    '{brand} Semrush traffic monthly visits',
    '{brand} LeadIQ revenue',
    '{brand} ZoomInfo company profile',
  ],
  'operating_brand:saas': [
    '{brand} ARR',
    '{brand} customer count',
    '{brand} Builtwith adoption',
    '{brand} pricing tiers',
  ],
  'operating_brand:cruise': [
    '{brand} fleet capacity lower berths',
    '{brand} passengers carried annual',
    '{brand} per diem revenue',
    '{brand} occupancy rate',
  ],
  'operating_brand:cpg': [
    '{brand} retail sales dollars Nielsen',
    '{brand} market share category',
    '{brand} IRI scan data',
    '{brand} parent 10-K segment revenue',
  ],
  'private_equity_firm': [
    '{brand} assets under management',
    '{brand} ADV filing',
    '{brand} portfolio companies',
    '{brand} founders managing partners',
  ],
};

const CATEGORY_KEYWORDS = [
  ['mattress', /mattress|bedding|sleep|sheets/i],
  ['cruise', /cruise|cruceros|ocean liner|cruise line/i],
  ['saas', /saas|software|platform|cloud|b2b software|app/i],
  ['cpg', /\bcpg\b|consumer packaged|food|beverage|snack|grocery|household|personal care|toothpaste|laundry/i],
];

// Map a free-text category onto a known bucket token, or '' when uncovered.
export function normalizeCategoryKey(category) {
  const c = (category || '').toLowerCase();
  for (const [bucket, re] of CATEGORY_KEYWORDS) if (re.test(c)) return bucket;
  return '';
}

// Build the strategy key for an entity: PE firms are category-agnostic; others
// key off node_type:categoryBucket.
export function strategyKeyFor(entity) {
  if (!entity) return '';
  const nt = entity.node_type || 'operating_brand';
  if (nt === 'private_equity_firm') return 'private_equity_firm';
  const bucket = normalizeCategoryKey(entity.category);
  if (!bucket) return '';
  return `operating_brand:${bucket}`;
}

// The required search queries (already brand-substituted) for an entity. Empty
// for uncovered categories (long tail — acceptable for v2.2, expand in v2.3).
export function requiredQueriesFor(entity) {
  const key = strategyKeyFor(entity);
  const templates = SEARCH_STRATEGIES[key] || [];
  const brand = entity?.company || entity?.name || '';
  return templates.map((t) => t.replace(/\{brand\}/g, brand));
}

// Execute the whitelist searches via an injected `runSearch(query) -> signal[]`.
// Pure/testable: with no runner it just returns the planned queries.
export async function fetchRequiredSignals(entity, runSearch) {
  const queries = requiredQueriesFor(entity);
  if (typeof runSearch !== 'function') return { queries, signals: [] };
  const signals = [];
  for (const q of queries) {
    const res = await runSearch(q);
    if (Array.isArray(res)) signals.push(...res);
    else if (res) signals.push(res);
  }
  return { queries, signals };
}
