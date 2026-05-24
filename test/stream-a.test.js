import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  synthesize,
  detectHoldingPattern,
  promoteToAggregator,
  categoriesAreSimilar,
  classifyRelative,
  selectReconciliationBenchmark,
  installSiblings,
  generateAggregatorsFromSegments,
  applyCanonicalNodeTypes,
  populatePeCoOwners,
  enforceSchema,
} from '../synth.js';
import {
  normalizeNodeType,
  shouldKeepTicker,
  isPrivateEquityFirm,
  validateEntity,
  NODE_TYPES,
} from '../schemas/entity.js';

// ─── A1: canonical node_type + ticker hygiene + PE co_owners ────────────────

test('A1: legacy legal_entity + ticker → public_company', () => {
  assert.equal(normalizeNodeType({ node_type: 'legal_entity', ticker: 'QSR' }), 'public_company');
});

test('A1: legacy legal_entity without ticker → private_company', () => {
  assert.equal(normalizeNodeType({ node_type: 'legal_entity' }), 'private_company');
});

test('A1: 3G Capital classified as private_equity_firm', () => {
  const tg = { node_type: 'legal_entity', company: '3G Capital', category: 'private equity firm' };
  assert.ok(isPrivateEquityFirm(tg));
  assert.equal(normalizeNodeType(tg), 'private_equity_firm');
});

test('A1: ticker does not inherit up to a PE/UBO parent (NEW.14)', () => {
  const tree = {
    company: 'Burger King', node_type: 'operating_brand', category: 'fast food',
    revenue_estimate: { central: 1e9 },
    parent: {
      company: 'Restaurant Brands International', node_type: 'legal_entity', ticker: 'QSR',
      revenue_estimate: { central: 7e9 },
      parent: {
        company: '3G Capital', node_type: 'legal_entity', category: 'private equity firm',
        ticker: 'QSR', // leaked — must be cleared
        strategic_control: [
          { entity: 'Jorge Paulo Lemann', role_description: 'Co-founder & Managing Partner' },
        ],
      },
    },
  };
  applyCanonicalNodeTypes(tree);
  assert.equal(tree.parent.node_type, 'public_company');
  assert.equal(tree.parent.ticker, 'QSR', 'RBI keeps QSR');
  assert.equal(tree.parent.parent.node_type, 'private_equity_firm');
  assert.equal(tree.parent.parent.ticker, null, '3G must not carry QSR');
});

test('A1b: PE-firm founders promoted into co_owners (NEW.17)', () => {
  const pe = {
    company: '3G Capital', node_type: 'private_equity_firm',
    strategic_control: [
      { entity: 'Jorge Paulo Lemann', role_description: 'Co-founder' },
      { entity: 'Carlos Alberto Sicupira', role_description: 'Co-founder' },
      { entity: 'Marcel Herrmann Telles', role_description: 'Co-founder' },
      { entity: 'Alexandre Behring', role_description: 'Managing Partner' },
      { entity: 'Daniel Schwartz', role_description: 'Managing Partner' },
      { entity: 'Some Analyst', role_description: 'Vice President' }, // not a founder/MP
    ],
  };
  populatePeCoOwners(pe);
  assert.equal(pe.co_owners.length, 5, 'cap 5 founders/managing partners');
  assert.ok(pe.co_owners.some((c) => c.company === 'Jorge Paulo Lemann'));
  assert.ok(!pe.co_owners.some((c) => c.company === 'Some Analyst'));
});

test('A1: validateEntity flags ticker on non-public node', () => {
  const r = validateEntity({ company: 'X', node_type: 'private_company', ticker: 'ABC' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /ticker/.test(e)));
  assert.ok(NODE_TYPES.includes('house_of_brands_aggregator'));
  assert.equal(shouldKeepTicker({ node_type: 'public_company', ticker: 'ABC' }), true);
});

// ─── A2: aggregator detection + promotion ───────────────────────────────────

test('A2: house-of-brands focal promotes siblings to children (NEW.33/34)', () => {
  const focal = {
    company: 'Resident Home', node_type: 'operating_brand',
    category: 'house of direct-to-consumer mattress brands',
    siblings: [
      { company: 'Nectar', category: 'mattress', primary_parent_id: 'Resident Home' },
      { company: 'DreamCloud', category: 'mattress', acquisition: { acquired_by: 'Resident Home' } },
      { company: 'Awara', category: 'mattress', notes: 'owned by resident home' },
      { company: 'Ashley Manufacturing', category: 'furniture manufacturing' }, // a peer, not a child
    ],
    children: [],
  };
  assert.ok(detectHoldingPattern(focal));
  promoteToAggregator(focal);
  assert.equal(focal.node_type, 'house_of_brands_aggregator');
  assert.equal(focal.layer, 'aggregator');
  const childNames = focal.children.map((c) => c.company);
  assert.deepEqual(childNames.sort(), ['Awara', 'DreamCloud', 'Nectar']);
  assert.deepEqual(focal.siblings.map((s) => s.company), ['Ashley Manufacturing']);
});

// ─── A3: sibling vs cousin via token overlap ────────────────────────────────

test('A3: categoriesAreSimilar token overlap', () => {
  assert.ok(categoriesAreSimilar('luxury cruise line', 'ocean cruise line'));
  assert.ok(!categoriesAreSimilar('furniture manufacturing', 'mattress bedding'));
  assert.ok(categoriesAreSimilar('', 'anything'), 'missing category → similar (no forced split)');
});

test('A3: classifyRelative — Ashley COUSIN, Explora SIBLING', () => {
  const ashley = { company: 'Ashley Manufacturing', category: 'furniture manufacturing', primary_parent_id: 'Resident Home' };
  const explora = { company: 'Explora Journeys', category: 'luxury cruise line', primary_parent_id: 'MSC Group' };
  const residentFocal = { company: 'Nectar', category: 'mattress bedding', primary_parent_id: 'Resident Home' };
  const mscFocal = { company: 'MSC Cruceros', category: 'ocean cruise line', primary_parent_id: 'MSC Group' };
  assert.equal(classifyRelative(ashley, residentFocal), 'COUSIN');
  assert.equal(classifyRelative(explora, mscFocal), 'SIBLING');
});

// ─── A4: divisional aggregators from 10-K segments ──────────────────────────

test('A4: RBI 10-K segments produce 4 divisional aggregators', () => {
  const tree = {
    company: 'Burger King', node_type: 'operating_brand', category: 'fast food burgers',
    focal_segment: 'Burger King', revenue_estimate: { central: 1e9 },
    parent: { company: 'Restaurant Brands International' },
    siblings: [
      { company: 'Tim Hortons', category: 'coffee', via_division: 'Tim Hortons' },
      { company: 'Popeyes', category: 'fast food chicken', via_division: 'Popeyes' },
      { company: 'Firehouse Subs', category: 'fast food subs', via_division: 'Firehouse' },
    ],
  };
  const segments = [
    { name: 'Tim Hortons', revenue_usd: 3e9 },
    { name: 'Burger King', revenue_usd: 2e9, contains_focal: true },
    { name: 'Popeyes', revenue_usd: 1.5e9 },
    { name: 'Firehouse', revenue_usd: 5e8 },
  ];
  const out = generateAggregatorsFromSegments(tree, segments);
  assert.ok(out._divisional_aggregators);
  assert.equal(out._divisional_aggregators.length, 4);
  const bk = out._divisional_aggregators.find((a) => a.company.startsWith('Burger King'));
  assert.ok(bk.children.some((c) => c.company === 'Burger King'), 'focal lands in its own segment');
});

// ─── A5: reconciliation benchmark policy ────────────────────────────────────

test('A5: PE-firm parent skips reconciliation (NEW.13)', () => {
  const focal = {
    company: 'Burger King', revenue_estimate: { central: 1e9 },
    parent: { company: '3G Capital', node_type: 'private_equity_firm', revenue_estimate: { central: 255e6 } },
  };
  const b = selectReconciliationBenchmark(focal);
  assert.equal(b.skip, true);
  assert.equal(b.benchmark_source, 'pe_firm_skip');
});

test('A5: house-of-brands focal anchors on its own revenue (NEW.28)', () => {
  const focal = {
    company: 'Resident Home', node_type: 'house_of_brands_aggregator',
    revenue_estimate: { central: 9e8 },
    siblings: [],
    parent: {
      company: 'Ashley Global', children: [
        { category: 'furniture manufacturing' },
        { category: 'logistics' },
      ],
    },
  };
  const b = selectReconciliationBenchmark(focal);
  assert.equal(b.benchmark_source, 'focal_self_anchor');
  assert.equal(b.benchmark_value, 9e8);
});

// ─── A6: schema enforcement at model boundary ───────────────────────────────

test('A6: enforceSchema strips improvised fields, keeps contract fields (NEW.35)', () => {
  const modelOutput = {
    company: 'Resident Home', node_type: 'operating_brand', category: 'mattress',
    _divisional_aggregators: [{ company: 'fake' }], // Gemini improvisation
    hallucinated_metric: 42,
    siblings: [{ company: 'Nectar', category: 'mattress', made_up_field: true }],
    parent: { company: 'Ashley', bogus: 'x' },
  };
  const { cleaned, rejected } = enforceSchema(modelOutput);
  assert.ok(rejected.includes('_divisional_aggregators'));
  assert.ok(rejected.includes('hallucinated_metric'));
  assert.equal(cleaned._divisional_aggregators, undefined);
  assert.equal(cleaned.company, 'Resident Home');
  assert.equal(cleaned.siblings[0].company, 'Nectar');
  assert.equal(cleaned.siblings[0].made_up_field, undefined);
  assert.equal(cleaned.parent.company, 'Ashley');
  assert.equal(cleaned.parent.bogus, undefined);
});

// ─── A7: sibling installation guarantee ─────────────────────────────────────

test('A7: installSiblings reinstalls processed-but-missing siblings (NEW.34)', () => {
  const focal = { company: 'Resident Home', siblings: [{ company: 'Nectar', revenue_estimate: { central: 4e8 } }], children: [] };
  const captured = [
    { company: 'Nectar', revenue_estimate: { central: 4e8 } },
    { company: 'DreamCloud', revenue_estimate: { central: 3e8 } }, // processed, fell out
    { company: 'Awara', revenue_estimate: { central: 1e8 } }, // processed, fell out
    { company: 'Siena', revenue_estimate: null }, // not completed → ignored
  ];
  installSiblings(focal, captured);
  const names = focal.siblings.map((s) => s.company).sort();
  assert.deepEqual(names, ['Awara', 'DreamCloud', 'Nectar']);
  assert.ok(!focal.siblings.some((s) => s.company === 'Siena'));
});
