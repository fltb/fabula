// ============================================================================
// Novalistically — Relationship Transaction Replay
// Applies RelationshipTransaction to WorldState for STATE-2 n-ary relationships.
// ============================================================================

import { ConfigError } from '../errors.js';
import type {
  DimensionScope,
  DimensionState,
  EpochLifecycle,
  EpochRuntimeState,
  RelationshipId,
  RelationshipRuntimeState,
  RelationshipTransaction,
} from '../types/index.js';

// ============================================================================
// Public API
// ============================================================================

/**
 * applyRelationshipTransaction — Apply a single RelationshipTransaction to
 * the WorldState's relationships map. Handles both first-time establishment
 * and subsequent epoch modifications.
 *
 * @returns the active epoch's lifecycle (for downstream use)
 */
export function applyRelationshipTransaction(
  relationships: Record<RelationshipId, RelationshipRuntimeState>,
  tx: RelationshipTransaction,
): void {
  const relId = tx.relationshipId;
  let relState = relationships[relId];

  // ── First establishment ──
  if (!relState) {
    if (!tx.epochId && !tx.lifecycleAfter) {
      throw new ConfigError(
        `First establishment for ${relId} requires epochId and lifecycleAfter`,
        { path: relId, eventId: tx.effectId, phase: 'replay' },
      );
    }
    const epochId = tx.epochId ?? `${relId}_epoch_1`;
    const lifecycle = tx.lifecycleAfter ?? 'active';

    const epoch: EpochRuntimeState = {
      epochId,
      lifecycle,
      memberships: {},
      dimensions: {},
    };

    // Populate memberships
    for (const m of tx.membershipAfter) {
      if (epoch.memberships[m.membershipId]) {
        throw new ConfigError(
          `Duplicate membershipId ${m.membershipId} in transaction ${tx.effectId}`,
          { path: relId, eventId: tx.effectId, phase: 'replay' },
        );
      }
      epoch.memberships[m.membershipId] = m;
    }

    // Apply dimensionSet
    applyDimensionSet(epoch, tx);

    relState = {
      relationshipId: relId,
      typeId: 'default', // will be refined by catalog validation
      epochs: { [epochId]: epoch },
      activeEpochId: lifecycle === 'active' ? epochId : undefined,
    };
    relationships[relId] = relState;
    return;
  }

  // ── Existing relationship ──
  const epochId = tx.epochId ?? relState.activeEpochId;
  if (!epochId) {
    throw new ConfigError(
      `No epochId for transaction ${tx.effectId} on ${relId} (no active epoch)`,
      { path: relId, eventId: tx.effectId, phase: 'replay' },
    );
  }

  let epoch = relState.epochs[epochId];
  if (!epoch) {
    // New epoch — create it
    const lifecycle = tx.lifecycleAfter ?? 'active';
    epoch = {
      epochId,
      lifecycle,
      memberships: {},
      dimensions: {},
    };
    relState.epochs[epochId] = epoch;
  }

  // ── Lifecycle transition ──
  if (tx.lifecycleAfter && tx.lifecycleAfter !== epoch.lifecycle) {
    // Validate transition
    validateLifecycleTransition(epoch.lifecycle, tx.lifecycleAfter, tx.effectId);
    epoch.lifecycle = tx.lifecycleAfter;

    if (tx.lifecycleAfter === 'active') {
      relState.activeEpochId = epochId;
    } else if (tx.lifecycleAfter === 'dissolved') {
      if (relState.activeEpochId === epochId) {
        relState.activeEpochId = undefined;
      }
    }
    // suspended keeps activeEpochId
  }

  // ── Full membership replacement (per spec: complete membershipAfter) ──
  // Validate no duplicate membershipIds
  const membershipIds = new Set<string>();
  for (const m of tx.membershipAfter) {
    if (membershipIds.has(m.membershipId)) {
      throw new ConfigError(
        `Duplicate membershipId ${m.membershipId} in transaction ${tx.effectId}`,
        { path: relId, eventId: tx.effectId, phase: 'replay' },
      );
    }
    membershipIds.add(m.membershipId);
  }

  // Replace memberships
  epoch.memberships = {};
  for (const m of tx.membershipAfter) {
    epoch.memberships[m.membershipId] = m;
  }

  // ── Dimension removal ──
  if (tx.dimensionUnset) {
    for (const du of tx.dimensionUnset) {
      const key = dimensionKey(du.dimensionId, du.scope, du.roleId, du.memberId, du.position);
      if (!epoch.dimensions[key]) {
        throw new ConfigError(
          `Cannot unset absent dimension ${du.dimensionId} (scope=${du.scope}) on ${relId}`,
          { path: relId, eventId: tx.effectId, phase: 'replay' },
        );
      }
      delete epoch.dimensions[key];
    }
  }

  // ── Dimension writes ──
  applyDimensionSet(epoch, tx);

  // Update active epoch if new one was created
  if (epoch.lifecycle === 'active') {
    relState.activeEpochId = epochId;
  }
}

/**
 * applyDimensionSet — writes dimensionSet entries to an epoch runtime state.
 */
function applyDimensionSet(epoch: EpochRuntimeState, tx: RelationshipTransaction): void {
  if (!tx.dimensionSet) return;

  for (const dw of tx.dimensionSet) {
    const key = dimensionKey(dw.dimensionId, dw.scope, dw.roleId, dw.memberId, dw.position);
    epoch.dimensions[key] = {
      value: dw.value,
      scope: dw.scope,
      lastUpdatedEffectId: tx.effectId,
      scopeKey: dw.roleId ?? dw.memberId ?? dw.position,
    };
  }
}

/**
 * dimensionKey — stable string key for dimension state in epoch.
 */
function dimensionKey(
  dimensionId: string,
  scope: DimensionScope,
  roleId?: string,
  memberId?: string,
  position?: string,
): string {
  let key = `${scope}::${dimensionId}`;
  if (roleId) key += `::role=${roleId}`;
  if (memberId) key += `::member=${memberId}`;
  if (position) key += `::pos=${position}`;
  return key;
}

/**
 * validateLifecycleTransition — enforces valid epoch lifecycle transitions.
 * active ↔ suspended, active → dissolved, suspended → dissolved
 */
function validateLifecycleTransition(
  from: EpochLifecycle,
  to: EpochLifecycle,
  effectId: string,
): void {
  const allowed: Record<EpochLifecycle, EpochLifecycle[]> = {
    active: ['suspended', 'dissolved'],
    suspended: ['active', 'dissolved'],
    dissolved: [], // terminal
  };

  const valid = allowed[from];
  if (!valid || !valid.includes(to)) {
    throw new ConfigError(
      `Invalid epoch lifecycle transition: ${from} → ${to} (effect ${effectId})`,
      { eventId: effectId, phase: 'replay' },
    );
  }
}

// ============================================================================
// Lookup helpers
// ============================================================================

/**
 * getEntityIdsInEpoch — returns all entity IDs participating in a given epoch.
 */
export function getEntityIdsInEpoch(epoch: EpochRuntimeState): string[] {
  return Object.values(epoch.memberships).map((m) => m.entityId);
}

/**
 * findEpochsForEntity — returns epoch IDs for all epochs containing the entity.
 */
export function findEpochsForEntity(
  relState: RelationshipRuntimeState,
  entityId: string,
): string[] {
  const result: string[] = [];
  for (const [epochId, epoch] of Object.entries(relState.epochs)) {
    const hasEntity = Object.values(epoch.memberships).some((m) => m.entityId === entityId);
    if (hasEntity) result.push(epochId);
  }
  return result;
}

/**
 * getDimensionValue — looks up a dimension value from the active epoch.
 */
export function getDimensionValue(
  relState: RelationshipRuntimeState,
  dimensionId: string,
  scope: DimensionScope = 'global',
  scopeKey?: string,
): unknown | undefined {
  const epochId = relState.activeEpochId;
  if (!epochId) return undefined;
  const epoch = relState.epochs[epochId];
  if (!epoch) return undefined;
  const key = dimensionKey(dimensionId, scope, scopeKey);
  return epoch.dimensions[key]?.value;
}
