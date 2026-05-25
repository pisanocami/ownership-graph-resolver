import { test } from 'node:test';
import assert from 'node:assert/strict';
import { synthesize } from '../synth.js';

// ─── TC-1: Resident Home (A2 promotion + A5 self-anchor + A7 install) ────────

test('TC-1: Resident Home synthesizes as a house-of-brands aggregator', () => {
  const ownership = {
    company: 'Resident Home', node_type: 'operating_brand', layer: 'brand',
    category: 'house of direct-to-consumer mattress brands', in_current_sources: true,
    siblings: [
      { company: 'Nectar', category: 'mattress', notes: 'owned by Resident Home', in_current_sources: true },
      { company: 'DreamCloud', category: 'mattress', notes: 'owned by Resident Home', in_current_sources: true },
      { company: 'Awara', category: 'mattress', notes: 'owned by Resident Home', in_current_sources: true },
      { company: 'Siena', category: 'mattress', notes: 'owned by Resident Home', in_current_sources: true },
      { company: 'Cloverlane', category: 'mattress', notes: 'owned by Resident Home', in_current_sources: true },
      { company: 'Ashley Manufacturing', category: 'furniture manufacturing', in_current_sources: true },
    ],
    parent: {
      company: 'Ashley Global Holdings', node_type: 'legal_entity', category: 'furniture conglomerate',
      in_current_sources: true,
      children: [{ category: 'furniture manufacturing' }, { category: 'logistics services' }],
    },
  };
  const revenueByCompany = {
    'resident home': { revenue_estimate: { central: 9e8, low: 8e8, high: 1.1e9, confidence: 'medium' } },
    nectar: { revenue_estimate: { central: 4e8, low: 3e8, high: 5e8, confidence: 'medium' } },
    dreamcloud: { revenue_estimate: { central: 2e8, low: 1e8, high: 3e8, confidence: 'medium' } },
    awara: { revenue_estimate: { central: 9.2e6, low: 8e6, high: 1e7, confidence: 'medium' } },
    'ashley manufacturing': { revenue_estimate: { central: 9e9, low: 8e9, high: 1e10, confidence: 'high' } },
  };

  const capturedSiblings = ['Nectar', 'DreamCloud', 'Awara', 'Siena', 'Cloverlane'].map((c) => ({
    company: c, revenue_estimate: revenueByCompany[c.toLowerCase()]?.revenue_estimate || { central: 1e8 },
    revenue_estimate_completed: true, notes: 'owned by Resident Home',
  }));

  const out = synthesize(ownership, revenueByCompany, null, {}, { capturedSiblings });
  const tree = out.ownership_tree;

  assert.equal(tree.node_type, 'house_of_brands_aggregator', 'focal promoted to aggregator');
  assert.equal(tree.layer, 'aggregator');
  const childNames = (tree.children || []).map((c) => c.company);
  ['Nectar', 'DreamCloud', 'Awara', 'Siena', 'Cloverlane'].forEach((b) =>
    assert.ok(childNames.includes(b), `${b} is a child (A2/A7)`));
  assert.ok(!(tree.siblings || []).some((s) => ['Nectar', 'DreamCloud', 'Awara'].includes(s.company)), 'sub-brands not siblings');
  assert.ok((tree.siblings || []).some((s) => s.company === 'Ashley Manufacturing'), 'Ashley stays a sibling/peer');

  // A5: reconciliation anchors on the focal's own revenue, not the parent total.
  const recon = out.positioning_analysis.reconciliation;
  assert.ok(recon, 'reconciliation computed');
  assert.equal(recon.parent_benchmark_source, 'focal_self_anchor');
});

// ─── TC-3: Burger King chain (A1 canonical types + ticker hygiene + PE) ──────

test('TC-3: Burger King chain — QSR on RBI, 3G is PE with founder co_owners', () => {
  const ownership = {
    company: 'Burger King', node_type: 'operating_brand', category: 'fast food burgers',
    in_current_sources: true,
    revenue_estimate: undefined,
    siblings: [
      { company: 'Tim Hortons', category: 'coffee', in_current_sources: true },
      { company: 'Popeyes', category: 'fast food chicken', in_current_sources: true },
    ],
    parent: {
      company: 'Restaurant Brands International', node_type: 'legal_entity', ticker: 'QSR',
      category: 'fast food holding', in_current_sources: true,
      parent: {
        company: '3G Capital', node_type: 'legal_entity', category: 'private equity firm',
        ticker: 'QSR', in_current_sources: true,
        strategic_control: [
          { entity: 'Jorge Paulo Lemann', role_description: 'Co-founder' },
          { entity: 'Carlos Alberto Sicupira', role_description: 'Co-founder' },
          { entity: 'Marcel Herrmann Telles', role_description: 'Co-founder' },
          { entity: 'Alexandre Behring', role_description: 'Managing Partner' },
          { entity: 'Daniel Schwartz', role_description: 'Managing Partner' },
        ],
      },
    },
  };
  const revenueByCompany = {
    'burger king': { revenue_estimate: { central: 1.8e9, low: 1.5e9, high: 2e9, confidence: 'high' } },
    'tim hortons': { revenue_estimate: { central: 3.4e9, low: 3e9, high: 3.8e9, confidence: 'high' } },
    popeyes: { revenue_estimate: { central: 1.5e9, low: 1.3e9, high: 1.7e9, confidence: 'high' } },
    'restaurant brands international': { revenue_estimate: { central: 7e9, low: 6.8e9, high: 7.2e9, confidence: 'high' } },
    '3g capital': { revenue_estimate: { central: 255e6, low: 2e8, high: 3e8, confidence: 'low' } },
  };

  const out = synthesize(ownership, revenueByCompany, null, {});
  const rbi = out.ownership_tree.parent;
  const tg = rbi.parent;

  assert.equal(rbi.node_type, 'public_company', 'RBI is public_company');
  assert.equal(rbi.ticker, 'QSR', 'RBI keeps QSR');
  assert.equal(tg.node_type, 'private_equity_firm', '3G is a PE firm');
  assert.equal(tg.ticker, null, '3G must NOT carry QSR (NEW.14)');
  assert.ok(Array.isArray(tg.co_owners) && tg.co_owners.length === 5, '3G has 5 founder co_owners (NEW.17)');
});
