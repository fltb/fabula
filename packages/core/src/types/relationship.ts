// ============================================================================
// Novalistically — STATE-2: n-ary Relationship Types
// Three-layer identity: RelationshipId / EpochId / MembershipId
// Epoch lifecycle: active | suspended | dissolved
// Five dimension scopes: global | role | member | subset | positional
// ============================================================================

import type { EntityId } from './entity.js';
// ============================================================================

// ============================================================================
// 1. RelationshipTypeDefinition (catalog-level)
// ============================================================================

export interface RelationshipRoleDefinition {
  roleId: string;
  label: string;
  minCardinality: number;
  /** maxCardinality — Infinity for unbounded */
  maxCardinality: number;
  allowedEntityKinds: string[];
  /** Optional exclusive group — if set, only one role from this group may be occupied per epoch */
  exclusiveGroup?: string;
}

export interface RelationshipTypeDefinition {
  typeId: string;
  label: string;
  description?: string;
  roles: RelationshipRoleDefinition[];
  /**
   * continuityImpact:
   *   'preserve'           — re-occupy same role, same epoch
   *   'new_epoch'          — close current epoch, start new
   *   'new_relationship'   — create a new RelationshipId entirely
   */
  continuityImpact: 'preserve' | 'new_epoch' | 'new_relationship';
}
export interface RelationshipTypeCatalog {
  types: Record<string, RelationshipTypeDefinition>;
}

// ============================================================================
// 2. Relationship declaration (authoring source)
// ============================================================================

export interface RelationshipDeclaration {
  relationshipId: string;
  typeId: string;
  initialEpoch: {
    epochId: string;
    lifecycle: EpochLifecycle;
    memberships: Membership[];
    dimensions: DimensionWrite[];
  };
  provenance?: string;
}

// ============================================================================
// 3. Three-layer identity (opaque branded strings)
// ============================================================================

/** RelationshipId — permanent lineage, never reused */
export type RelationshipId = string & { readonly __brand: 'RelationshipId' };

/** EpochId — one establishment→dissolution incarnation */
export type EpochId = string & { readonly __brand: 'EpochId' };

/** MembershipId — one entity's continuous tenure in an epoch; rejoin = new ID */
export type MembershipId = string & { readonly __brand: 'MembershipId' };

// ============================================================================
// 4. Epoch lifecycle
// ============================================================================

export type EpochLifecycle = 'active' | 'suspended' | 'dissolved';

// ============================================================================
// 5. Dimension scopes
// ============================================================================

export type DimensionScope = 'global' | 'role' | 'member' | 'subset' | 'positional';

// ============================================================================
// 6. Membership
// ============================================================================
export interface Membership {
  membershipId: MembershipId;
  entityId: EntityId;
  /** Role identifier from RelationshipTypeDefinition. */
  role?: string;
}

// ============================================================================
// 7. RelationshipTransaction
// One per node per relationship.
// ============================================================================

export interface DimensionWrite {
  dimensionId: string;
  scope: DimensionScope;
  value: unknown;
  /** role-scoped: roleId */
  roleId?: string;
  /** member-scoped: MembershipId */
  memberId?: MembershipId;
  /** positional: position name or index string */
  position?: string;
}

export interface DimensionUnset {
  dimensionId: string;
  scope: DimensionScope;
  /** matching scopeKey for scoped dimensions */
  roleId?: string;
  memberId?: MembershipId;
  position?: string;
}

export interface RelationshipTransaction {
  type: 'relationship_transaction';
  effectId: string;
  relationshipId: RelationshipId;
  /** Omit for first establishment; required for subsequent writes. */
  epochId?: EpochId;
  /** Lifecycle transition: set to transition. */
  lifecycleAfter?: EpochLifecycle;
  /** Complete membership set after this transaction. */
  membershipAfter: Membership[];
  /** Dimension writes. */
  dimensionSet?: DimensionWrite[];
  /** Dimension removal. */
  dimensionUnset?: DimensionUnset[];
  /** Provenance / source info. */
  provenance?: string;
}

// ============================================================================
// 8. RelationshipIdentityTransitionGroup
// For continuityImpact new_epoch / new_relationship:
// atomic old closure + new establishment + memberships + dimensions + carry map
// ============================================================================

export interface IdentityTransitionCarryEntry {
  fromDimensionId: string;
  toDimensionId: string;
  fromScope: DimensionScope;
  toScope: DimensionScope;
}

export interface RelationshipIdentityTransitionGroup {
  type: 'identity_transition';
  /** Close these old epochs atomically. */
  oldEpochClosures: Array<{
    relationshipId: RelationshipId;
    epochId: EpochId;
  }>;
  /** Establish these new relationships/epochs atomically. */
  newTransactions: RelationshipTransaction[];
  /** Carry dimension values from old to new. */
  carryMap?: IdentityTransitionCarryEntry[];
  provenance?: string;
}

export type RelationshipEffect = RelationshipTransaction | RelationshipIdentityTransitionGroup;

// ============================================================================
// 9. Runtime state stored in WorldState
// ============================================================================

export interface DimensionState {
  value: unknown;
  scope: DimensionScope;
  lastUpdatedEffectId: string;
  /** For member-scoped: the membershipId; role-scoped: roleId; positional: position */
  scopeKey?: string;
}

export interface EpochRuntimeState {
  epochId: string;
  lifecycle: EpochLifecycle;
  memberships: Record<string, Membership>;
  dimensions: Record<string, DimensionState>;
}

export interface RelationshipRuntimeState {
  relationshipId: RelationshipId;
  typeId: string;
  epochs: Record<string, EpochRuntimeState>;
  activeEpochId?: string;
}
