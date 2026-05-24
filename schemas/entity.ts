// Entity schema — typed source of truth (Ticket #59 v2, Stream A1).
// The runtime counterpart lives in schemas/entity.js (imported by synth.js).
// Keep the two in sync: this file documents the contract and gives editors /
// `tsc --noEmit` a dev-time check; the .js file does the enforcement at runtime.

export type NodeType =
  | 'individual'
  | 'family'
  | 'private_equity_firm'
  | 'public_company'
  | 'private_company'
  | 'divisional_aggregator'
  | 'house_of_brands_aggregator'
  | 'operating_brand';

export type Layer = 'root' | 'parent' | 'aggregator' | 'brand' | 'focal';

export type SecondaryRelationshipType =
  | 'brand_authority'
  | 'geographic_alias'
  | 'acquisition_history'
  | 'co_brand'
  | 'controlling_shareholder'
  | 'stewardship'
  | 'internal_launch_by';

export interface SecondaryRelationship {
  related_entity_id: string;
  relationship_type: SecondaryRelationshipType;
  evidence: string;
  source_url?: string;
}

export interface RevenueEstimate {
  central: number;
  low: number;
  high: number;
  confidence: 'high' | 'medium' | 'low';
  source?: string;
}

export interface Entity {
  id?: string;
  // The codebase keys entities by `company`; `name` is the ticket-facing alias.
  name?: string;
  company: string;
  domain?: string | null;
  node_type: NodeType;
  layer?: Layer;
  category?: string;
  // Only a public_company carries a ticker. It must NOT inherit up the chain.
  ticker?: string | null;
  primary_parent_id?: string | null; // exactly one; null only for root
  children?: Entity[]; // direct subordinates
  siblings?: Entity[]; // same primary_parent_id, similar category
  cousins?: Entity[]; // same primary_parent_id, different category
  secondary_relationships?: SecondaryRelationship[];
  revenue_estimate?: RevenueEstimate | null;
}

export const NODE_TYPES: readonly NodeType[] = [
  'individual',
  'family',
  'private_equity_firm',
  'public_company',
  'private_company',
  'divisional_aggregator',
  'house_of_brands_aggregator',
  'operating_brand',
];

export const LAYERS: readonly Layer[] = [
  'root',
  'parent',
  'aggregator',
  'brand',
  'focal',
];

export const SECONDARY_RELATIONSHIP_TYPES: readonly SecondaryRelationshipType[] = [
  'brand_authority',
  'geographic_alias',
  'acquisition_history',
  'co_brand',
  'controlling_shareholder',
  'stewardship',
  'internal_launch_by',
];
