// ============================================================================
// Novalistically — Relationship Transaction Replay
// Applies RelationshipTransaction to WorldState for STATE-2 n-ary relationships.
// ============================================================================

import { ConfigError } from '../errors.js';
import type {
  DimensionScope,
  EpochLifecycle,
  EpochRuntimeState,
  RelationshipDeclaration,
  RelationshipId,
  RelationshipIdentityTransitionGroup,
  RelationshipRuntimeState,
  RelationshipTransaction,
  RelationshipTypeCatalog,
} from '../types/relationship.js';

export interface RelationshipReplayContext {
  readonly relationshipDeclarations: readonly RelationshipDeclaration[];
  readonly relationshipTypeCatalog: RelationshipTypeCatalog;
}

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
  context: RelationshipReplayContext,
): void {
  const relId = tx.relationshipId;
  const declaration = context.relationshipDeclarations.find(
    (candidate) => candidate.relationshipId === relId,
  );
  if (!declaration) {
    throw new ConfigError(`Unknown relationship declaration ${relId}`, {
      path: relId,
      eventId: tx.effectId,
      phase: 'replay',
    });
  }
  if (!context.relationshipTypeCatalog.types[declaration.typeId]) {
    throw new ConfigError(`Unknown relationship type ${declaration.typeId}`, {
      path: relId,
      eventId: tx.effectId,
      phase: 'replay',
    });
  }
  let relState = relationships[relId];
  if (relState && relState.typeId !== declaration.typeId) {
    throw new ConfigError(
      `Relationship ${relId} has type ${relState.typeId}, expected ${declaration.typeId}`,
      { path: relId, eventId: tx.effectId, phase: 'replay' },
    );
  }

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
    const declaredEpoch = declaration.initialEpoch;
    if (epochId !== declaredEpoch.epochId) {
      throw new ConfigError(
        `First establishment epoch ${epochId} does not match declaration epoch ${declaredEpoch.epochId}`,
        { path: relId, eventId: tx.effectId, phase: 'replay' },
      );
    }

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
      typeId: declaration.typeId,
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

  const epoch = relState.epochs[epochId];
  if (!epoch) {
    // Unknown epoch — never synthesize a new epoch silently.
    const knownEpochIds = [declaration.initialEpoch.epochId, ...Object.keys(relState.epochs)];
    throw new ConfigError(
      `Unknown epoch ${epochId} for ${relId}; known: ${knownEpochIds.join(', ')}`,
      { path: relId, eventId: tx.effectId, phase: 'replay' },
    );
  }
  if (tx.lifecycleAfter && tx.lifecycleAfter !== epoch.lifecycle) {
    if (epoch.lifecycle === 'dissolved' && tx.lifecycleAfter === 'active') {
      // Retrospective scenes can restate an already-terminal relationship. They
      // may not silently revive it: its membership identity must be unchanged,
      // and the terminal lifecycle remains authoritative. A genuine revival
      // must be expressed as an identity transition with a new epoch.
      if (!sameMemberships(epoch, tx.membershipAfter)) {
        throw new ConfigError(
          `Re-establishing dissolved relationship ${relId} requires an identity transition`,
          { path: relId, eventId: tx.effectId, phase: 'replay' },
        );
      }
    } else {
      validateLifecycleTransition(epoch.lifecycle, tx.lifecycleAfter, tx.effectId);
      epoch.lifecycle = tx.lifecycleAfter;

      if (tx.lifecycleAfter === 'active') {
        relState.activeEpochId = epochId;
      } else if (tx.lifecycleAfter === 'dissolved' && relState.activeEpochId === epochId) {
        relState.activeEpochId = undefined;
      }
    }
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
 * Atomically closes declared epochs and establishes a fresh epoch where the
 * relationship type explicitly permits it. Direct transactions never revive a
 * terminal epoch.
 */
export function applyRelationshipIdentityTransitionGroup(
  relationships: Record<RelationshipId, RelationshipRuntimeState>,
  group: RelationshipIdentityTransitionGroup,
  context: RelationshipReplayContext,
): void {
  const candidate = structuredClone(relationships) as Record<
    RelationshipId,
    RelationshipRuntimeState
  >;
  const closedSourceEpochs: EpochRuntimeState[] = [];

  for (const closure of group.oldEpochClosures) {
    const relationship = candidate[closure.relationshipId];
    const epoch = relationship?.epochs[closure.epochId];
    if (!relationship || !epoch) {
      throw new ConfigError(
        `Identity transition closes unknown epoch ${closure.epochId} on ${closure.relationshipId}`,
        { path: closure.relationshipId, phase: 'replay' },
      );
    }
    closedSourceEpochs.push(structuredClone(epoch));
    applyRelationshipTransaction(
      candidate,
      {
        type: 'relationship_transaction',
        effectId: `${group.provenance ?? 'identity-transition'}:close:${closure.relationshipId}:${closure.epochId}`,
        relationshipId: closure.relationshipId,
        epochId: closure.epochId,
        lifecycleAfter: 'dissolved',
        membershipAfter: Object.values(epoch.memberships),
      },
      context,
    );
  }

  for (const transaction of group.newTransactions) {
    const declaration = context.relationshipDeclarations.find(
      (entry) => entry.relationshipId === transaction.relationshipId,
    );
    const type = declaration && context.relationshipTypeCatalog.types[declaration.typeId];
    if (!declaration || !type) {
      throw new ConfigError(
        `Identity transition targets unknown relationship ${transaction.relationshipId}`,
        {
          path: transaction.relationshipId,
          eventId: transaction.effectId,
          phase: 'replay',
        },
      );
    }
    const existing = candidate[transaction.relationshipId];
    if (!existing) {
      if (type.continuityImpact !== 'new_relationship') {
        throw new ConfigError(
          `Relationship ${transaction.relationshipId} does not permit a new relationship transition`,
          { path: transaction.relationshipId, eventId: transaction.effectId, phase: 'replay' },
        );
      }
      applyRelationshipTransaction(candidate, transaction, context);
      continue;
    }
    if (!transaction.epochId || existing.epochs[transaction.epochId]) {
      throw new ConfigError(
        `Identity transition must establish a new epoch for ${transaction.relationshipId}`,
        { path: transaction.relationshipId, eventId: transaction.effectId, phase: 'replay' },
      );
    }
    if (type.continuityImpact !== 'new_epoch') {
      throw new ConfigError(
        `Relationship ${transaction.relationshipId} does not permit a new epoch transition`,
        { path: transaction.relationshipId, eventId: transaction.effectId, phase: 'replay' },
      );
    }
    if (!transaction.lifecycleAfter) {
      throw new ConfigError(
        `Identity transition requires lifecycleAfter for ${transaction.relationshipId}`,
        { path: transaction.relationshipId, eventId: transaction.effectId, phase: 'replay' },
      );
    }
    const memberships: EpochRuntimeState['memberships'] = {};
    for (const membership of transaction.membershipAfter) {
      if (memberships[membership.membershipId]) {
        throw new ConfigError(
          `Duplicate membershipId ${membership.membershipId} in transaction ${transaction.effectId}`,
          { path: transaction.relationshipId, eventId: transaction.effectId, phase: 'replay' },
        );
      }
      memberships[membership.membershipId] = structuredClone(membership);
    }
    const epoch: EpochRuntimeState = {
      epochId: transaction.epochId,
      lifecycle: transaction.lifecycleAfter,
      memberships,
      dimensions: {},
    };
    applyDimensionSet(epoch, transaction);
    existing.epochs[transaction.epochId] = epoch;
    if (epoch.lifecycle === 'active') existing.activeEpochId = transaction.epochId;
  }

  if (group.carryMap?.length) {
    if (group.newTransactions.length !== 1) {
      throw new ConfigError('Identity transition carryMap requires exactly one new transaction', {
        phase: 'replay',
      });
    }
    const targetTx = group.newTransactions[0];
    const targetEpoch = candidate[targetTx.relationshipId]?.epochs[targetTx.epochId ?? ''];
    if (!targetEpoch) {
      throw new ConfigError('Identity transition carryMap has no target epoch', {
        phase: 'replay',
      });
    }
    for (const carry of group.carryMap) {
      const sourceKey = dimensionKey(carry.fromDimensionId, carry.fromScope);
      const matches = closedSourceEpochs
        .map((epoch) => epoch.dimensions[sourceKey])
        .filter((dimension): dimension is NonNullable<typeof dimension> => dimension !== undefined);
      if (matches.length !== 1) {
        throw new ConfigError(
          `Identity transition carry source "${sourceKey}" must resolve exactly once`,
          { phase: 'replay' },
        );
      }
      const targetKey = dimensionKey(carry.toDimensionId, carry.toScope);
      targetEpoch.dimensions[targetKey] = {
        ...structuredClone(matches[0]),
        scope: carry.toScope,
        lastUpdatedEffectId: targetTx.effectId,
      };
    }
  }

  for (const relationshipId of Object.keys(relationships) as RelationshipId[]) {
    delete relationships[relationshipId];
  }
  Object.assign(relationships, candidate);
}

function sameMemberships(
  epoch: EpochRuntimeState,
  memberships: RelationshipTransaction['membershipAfter'],
): boolean {
  const existing = Object.values(epoch.memberships);
  return (
    existing.length === memberships.length &&
    memberships.every((membership) => {
      const current = epoch.memberships[membership.membershipId];
      return current?.entityId === membership.entityId && current.role === membership.role;
    })
  );
}

/**
 * applyDimensionSet — writes dimensionSet entries to an epoch runtime state.
 */
function applyDimensionSet(epoch: EpochRuntimeState, tx: RelationshipTransaction): void {
  if (!tx.dimensionSet) return;

  for (const dimension of tx.dimensionSet) {
    const key = dimensionKey(
      dimension.dimensionId,
      dimension.scope,
      dimension.roleId,
      dimension.memberId,
      dimension.position,
    );
    const scopeKey =
      dimension.scope === 'role'
        ? dimension.roleId
        : dimension.scope === 'member'
          ? dimension.memberId
          : dimension.scope === 'positional'
            ? dimension.position
            : undefined;
    epoch.dimensions[key] = {
      value: dimension.value,
      scope: dimension.scope,
      lastUpdatedEffectId: tx.effectId,
      ...(scopeKey === undefined ? {} : { scopeKey }),
    };
  }
}

export function dimensionKey(
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
  if (!valid?.includes(to)) {
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
