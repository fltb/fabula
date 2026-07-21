// ============================================================================
// Novalistically — STATE-2: n-ary Relationship Types
// Three-layer identity: RelationshipId / EpochId / MembershipId
// Epoch lifecycle: active | suspended | dissolved
// Five dimension scopes: global | role | member | subset | positional
// ============================================================================

import type { EntityId } from './entity.js';
// ============================================================================
// Legacy relationship types (first-class entity system, preserved for backward compat)
// ============================================================================

export interface RelationshipDefinition {
  id: string;
  type: string;             // 'friendship' | 'rivalry' | 'love' | 'fear' | 'hate' | 'professional' etc.
  participants: [EntityId, EntityId];  // exactly 2
  bidirectional: boolean;   // false = asymmetric (A→B different from B→A)
  initialState: {
    trust: number;            // -100 to 100
    emotionalDistance: number; // 0 = close, 100 = distant
    intensity: number;        // 0-100
    status: string;           // 'active' | 'dormant' | 'broken' | 'formed'
    notes?: string;
  };
  establishedEvent?: string;
  breakingEvent?: string;
}

// ——— Relationship Events ———

export type RelationshipEventType = 'strengthen' | 'weaken' | 'break' | 'form' | 'shift';

export interface RelationshipEvent {
  id: string;
  type: RelationshipEventType;
  relationshipId: string;
  delta: Partial<{
    trust: number;
    emotionalDistance: number;
    intensity: number;
    status: string;
  }>;
  sourceEvent: string;
}

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

// ============================================================================
// 2. Three-layer identity (opaque branded strings)
// ============================================================================

/** RelationshipId — permanent lineage, never reused */
export type RelationshipId = string & { readonly __brand: 'RelationshipId' };

/** EpochId — one establishment→dissolution incarnation */
export type EpochId = string & { readonly __brand: 'EpochId' };

/** MembershipId — one entity's continuous tenure in an epoch; rejoin = new ID */
export type MembershipId = string & { readonly __brand: 'MembershipId' };

// ============================================================================
// 3. Epoch lifecycle
// ============================================================================

export type EpochLifecycle = 'active' | 'suspended' | 'dissolved';

// ============================================================================
// 4. Dimension scopes
// ============================================================================

export type DimensionScope = 'global' | 'role' | 'member' | 'subset' | 'positional';

// ============================================================================
// 5. Membership
// ============================================================================

export interface Membership {
  membershipId: MembershipId;
  entityId: EntityId;
  /** roleId from RelationshipTypeDefinition, undefined for default binary */
  role?: string;
}

// ============================================================================
// 6. RelationshipTransaction (replaces RelationshipChange)
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
  effectId: string;
  relationshipId: RelationshipId;
  /** Omit for first establishment; required for subsequent writes */
  epochId?: EpochId;
  /** lifecycle transition: set to transition */
  lifecycleAfter?: EpochLifecycle;
  /** Complete membership set after this transaction */
  membershipAfter: Membership[];
  /** Dimension writes */
  dimensionSet?: DimensionWrite[];
  /** Dimension removal */
  dimensionUnset?: DimensionUnset[];
  /** Provenance / source info */
  provenance?: string;
}

// ============================================================================
// 7. RelationshipIdentityTransitionGroup
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
  /** Close these old epochs atomically */
  oldEpochClosures: Array<{
    relationshipId: RelationshipId;
    epochId: EpochId;
  }>;
  /** Establish these new relationships/epochs atomically */
  newTransactions: RelationshipTransaction[];
  /** Carry dimension values from old to new */
  carryMap?: IdentityTransitionCarryEntry[];
  provenance?: string;
}

// ============================================================================
// 8. Runtime state stored in WorldState
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

// ============================================================================
// 9. Backward-compat conversion result
// ============================================================================

/**
 * convertRelationshipChange — converts a binary RelationshipChange (old format)
 * into one or more RelationshipTransactions for the new system.
 */
export function convertRelationshipChange(
  change: {
    participants: [EntityId, EntityId];
    effect: string;
    direction: string;
    newState?: { type: string; intensity: number };
  },
  eventId: string,
  index: number,
): RelationshipTransaction {
  const p1 = change.participants[0];
  const p2 = change.participants[1];
  const sorted = [p1, p2].sort();
  const relId = `rel_${sorted[0]}_${sorted[1]}` as unknown as RelationshipId;
  const epochId = `epoch_${sorted[0]}_${sorted[1]}_1` as unknown as EpochId;
  const effectId = `${eventId}_rel_${index}`;

  const membershipAfter: Membership[] = [
    {
      membershipId: `mem_${p1}_${effectId}` as unknown as MembershipId,
      entityId: p1,
      role: 'member',
    },
    {
      membershipId: `mem_${p2}_${effectId}` as unknown as MembershipId,
      entityId: p2,
      role: 'member',
    },
  ];

  const dimSet: DimensionWrite[] = [
    { dimensionId: 'direction', scope: 'global', value: change.direction },
  ];

  if (change.newState?.type !== undefined) {
    dimSet.push({ dimensionId: 'type', scope: 'global', value: change.newState.type });
  }
  if (change.newState?.intensity !== undefined) {
    dimSet.push({ dimensionId: 'intensity', scope: 'global', value: change.newState.intensity });
  }

  let lifecycleAfter: EpochLifecycle = 'active';
  if (change.effect === 'dissolve') {
    lifecycleAfter = 'dissolved';
  }

  return {
    effectId,
    relationshipId: relId,
    epochId,
    lifecycleAfter,
    membershipAfter,
    dimensionSet: dimSet,
    provenance: `compat:RelationshipChange:${change.effect}`,
  };
}
