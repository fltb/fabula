import { createEmptyBranchPath, includesPath } from '../branch/index.js';
import { canonicalizeFactValue } from '../entity/fact-value.js';
import { ConfigError, PreconditionMismatchError } from '../errors.js';
import type {
  BranchPath,
  EntityDeclarationCatalog,
  EntityRuntimeState,
  EntityTypeCatalog,
  EpochId,
  Fact,
  NarrativeEvent,
  RelationshipChange,
  RelationshipRuntimeState,
  RelationshipTransaction,
  ThreadTransaction,
  WorldState,
} from '../types/index.js';
import { convertRelationshipChange } from '../types/relationship.js';
import { applyRelationshipTransaction } from './relationship-replay.js';
import {
  applyRuleTransaction,
  convertLegacyRuleEffect,
  isLegacyRuleEffect,
} from './rule-replay.js';
import {
  applyThreadTransaction,
  convertLegacyThreadProgress,
  isLegacyThreadProgress,
} from './thread-replay.js';

const LIFECYCLE_STATES: Record<string, true> = { active: true, inactive: true, retired: true };

const DEFAULT_LIFECYCLE_TRANSITIONS: Array<[EntityRuntimeState, EntityRuntimeState]> = [
  ['active', 'inactive'],
  ['active', 'retired'],
  ['inactive', 'active'],
  ['inactive', 'retired'],
];

export interface EventApplicationOptions {
  branchPath?: BranchPath;
  entityDeclarationCatalog?: EntityDeclarationCatalog;
  entityTypeCatalog?: EntityTypeCatalog;
  lifecycleChangesByStoryTime?: Map<string, Set<string>>;
  phase?: string;
}

export interface InitialFactApplicationOptions {
  branchPath?: BranchPath;
}

function preconditionMatches(operator: NonNullable<Fact['operator']>, stateValue: unknown, factValue: unknown): boolean {
  switch (operator) {
    case 'eq':
      return stateValue === factValue;
    case 'neq':
      return stateValue !== undefined && stateValue !== factValue;
    case 'gt':
      return typeof stateValue === 'number' && typeof factValue === 'number' && stateValue > factValue;
    case 'gte':
      return typeof stateValue === 'number' && typeof factValue === 'number' && stateValue >= factValue;
    case 'lt':
      return typeof stateValue === 'number' && typeof factValue === 'number' && stateValue < factValue;
    case 'lte':
      return typeof stateValue === 'number' && typeof factValue === 'number' && stateValue <= factValue;
    case 'contains':
      return (
        (typeof stateValue === 'string' && typeof factValue === 'string' && stateValue.includes(factValue)) ||
        (Array.isArray(stateValue) && stateValue.some((value) => value === factValue))
      );
    case 'not_contains':
      return (
        (typeof stateValue === 'string' && typeof factValue === 'string' && !stateValue.includes(factValue)) ||
        (Array.isArray(stateValue) && !stateValue.some((value) => value === factValue)) ||
        stateValue === undefined
      );
    case 'exists':
      return stateValue !== undefined;
    case 'not_exists':
      return stateValue === undefined;
  }
}

function validatePreconditions(state: WorldState, event: NarrativeEvent, branchPath: BranchPath, phase: string): void {
  for (const fact of event.preconditions) {
    if (!includesPath(fact.validity.branches, branchPath)) continue;

    const stateValue = state.entities[fact.entityId]?.[fact.attribute];
    const operator = fact.operator ?? 'eq';
    if (fact.value === undefined && operator !== 'exists' && operator !== 'not_exists') continue;

    if (!preconditionMatches(operator, stateValue, fact.value)) {
      throw new PreconditionMismatchError(
        `Precondition ${operator} fails for ${fact.entityId}.${fact.attribute}`,
        { eventId: event.id, stateKey: `${fact.entityId}.${fact.attribute}`, phase },
      );
    }
  }
}

function validateLifecycle(
  state: WorldState,
  event: NarrativeEvent,
  fact: Fact,
  options: EventApplicationOptions,
): void {
  const phase = options.phase ?? 'replay';
  const rawValue = fact.value === undefined ? undefined : String(fact.value);
  if (fact.attribute !== 'lifecycle' || rawValue === undefined || fact.operation === 'unset' || !LIFECYCLE_STATES[rawValue]) {
    return;
  }

  const currentLifecycle =
    (state.entities[fact.entityId]?.lifecycle as EntityRuntimeState | undefined) ?? 'active';
  const newLifecycle = rawValue as EntityRuntimeState;
  let allowedTransitions = DEFAULT_LIFECYCLE_TRANSITIONS;
  const declaration = options.entityDeclarationCatalog?.declarations[fact.entityId];
  const typeDefinition = declaration
    ? options.entityTypeCatalog?.types[declaration.typeRef.typeId]
    : undefined;
  if (typeDefinition) allowedTransitions = typeDefinition.lifecyclePolicy.allowedTransitions;

  if (!allowedTransitions.some(([from, to]) => from === currentLifecycle && to === newLifecycle)) {
    throw new ConfigError(
      `Invalid lifecycle transition: ${currentLifecycle} → ${newLifecycle} for entity ${fact.entityId}`,
      { path: fact.entityId, eventId: event.id, phase },
    );
  }

  if (!event.storyTime) return;
  const changes = options.lifecycleChangesByStoryTime;
  if (!changes) return;
  const storyTimeKey = JSON.stringify(event.storyTime);
  const changedEntities = changes.get(storyTimeKey) ?? new Set<string>();
  if (changedEntities.has(fact.entityId)) {
    throw new ConfigError(
      `Same storyTime lifecycle conflict: multiple events at ${storyTimeKey} modify lifecycle of ${fact.entityId}`,
      { path: fact.entityId, eventId: event.id, phase },
    );
  }
  changedEntities.add(fact.entityId);
  changes.set(storyTimeKey, changedEntities);
}

function applyPostconditions(
  state: WorldState,
  event: NarrativeEvent,
  branchPath: BranchPath,
  options: EventApplicationOptions,
): Set<string> {
  const phase = options.phase ?? 'replay';
  const writtenKeys = new Set<string>();
  const introducedThisEvent = new Set<string>();

  for (const fact of event.postconditions) {
    if (!includesPath(fact.validity.branches, branchPath)) continue;

    if (fact.value === undefined && fact.narrativeHint !== undefined && fact.operation !== 'unset') {
      state.facts.push(fact);
      continue;
    }

    if (!state.entities[fact.entityId]) {
      if (
        options.entityDeclarationCatalog &&
        !options.entityDeclarationCatalog.declarations[fact.entityId]
      ) {
        throw new ConfigError(`Unknown entity ${fact.entityId}: not found in declaration catalog`, {
          path: fact.entityId,
          eventId: event.id,
          phase,
        });
      }
      state.entities[fact.entityId] = { lifecycle: 'active' };
      introducedThisEvent.add(fact.entityId);
    }

    if (state.entities[fact.entityId]?.lifecycle === 'retired' && fact.attribute !== 'lifecycle') {
      throw new ConfigError(`Cannot modify retired entity ${fact.entityId}`, {
        path: fact.entityId,
        eventId: event.id,
        phase,
      });
    }
    if (fact.attribute === 'lifecycle' && fact.operation === 'unset') {
      throw new ConfigError(`Cannot unset lifecycle on ${fact.entityId}`, {
        path: fact.entityId,
        eventId: event.id,
        phase,
      });
    }

    const key = `${fact.entityId}::${fact.attribute}`;
    if (writtenKeys.has(key)) {
      throw new ConfigError(
        `Duplicate write to ${fact.entityId}.${fact.attribute} within event ${event.id}`,
        { path: fact.entityId, eventId: event.id, phase },
      );
    }
    writtenKeys.add(key);
    validateLifecycle(state, event, fact, options);

    if (fact.operation === 'unset') {
      if (!(fact.attribute in state.entities[fact.entityId])) {
        throw new ConfigError(`Cannot unset absent attribute ${fact.entityId}.${fact.attribute}`, {
          path: fact.entityId,
          eventId: event.id,
          phase,
        });
      }
      delete state.entities[fact.entityId][fact.attribute];
      state.facts.push(fact);
    } else if (fact.value !== undefined) {
      state.entities[fact.entityId][fact.attribute] = canonicalizeFactValue(fact.value);
      state.facts.push(fact);
    }
  }

  return introducedThisEvent;
}

function validateParticipants(
  state: WorldState,
  event: NarrativeEvent,
  introducedThisEvent: Set<string>,
  phase: string,
): void {
  for (const entityId of event.participants?.entities ?? []) {
    if (state.entities[entityId]?.lifecycle === 'retired' && !introducedThisEvent.has(entityId)) {
      throw new ConfigError(`Retired entity ${entityId} cannot participate in event ${event.id}`, {
        path: entityId,
        eventId: event.id,
        phase,
      });
    }
  }
}

function applyTransactions(state: WorldState, event: NarrativeEvent): void {
  for (const progress of event.threadProgress) {
    const transaction = isLegacyThreadProgress(progress)
      ? convertLegacyThreadProgress(progress, event.id)
      : (progress as unknown as ThreadTransaction);
    applyThreadTransaction(state.threads, transaction);
  }

  for (let index = 0; index < event.relationshipEffects.length; index += 1) {
    const relationship = event.relationshipEffects[index];
    const transaction: RelationshipTransaction =
      'participants' in relationship && !('effectId' in relationship)
        ? convertRelationshipChange(relationship as unknown as RelationshipChange, event.id, index)
        : relationship;

    // Legacy compat: a dissolved epoch must not be forced through an invalid
    // dissolved→active transition. When a legacy-converted transaction targets
    // a dissolved epoch with lifecycleAfter 'active', route to a new epoch
    // instead. Explicit transactions remain strictly validated.
    const finalTx =
      transaction.provenance?.startsWith('compat:') &&
      transaction.lifecycleAfter === 'active' &&
      transaction.epochId
        ? routeLegacyReestablishment(state.relationships, transaction)
        : transaction;

    applyRelationshipTransaction(state.relationships, finalTx);
  }

  for (const effect of event.ruleEffects) {
    if (isLegacyRuleEffect(effect)) {
      applyRuleTransaction(state.rules, convertLegacyRuleEffect(effect, event.id), { nodeId: event.id });
    } else {
      applyRuleTransaction(state.rules, effect as never, { nodeId: event.id });
    }
  }
}

/**
 * Route a legacy-converted transaction targeting a dissolved epoch to a new
 * epoch instead of attempting an invalid dissolved→active transition.
 * Returns the original transaction unchanged if no re-route is needed.
 * Explicit (non-legacy) transactions are never modified.
 */
function routeLegacyReestablishment(
  relationships: Record<string, RelationshipRuntimeState>,
  tx: RelationshipTransaction,
): RelationshipTransaction {
  const relState = relationships[tx.relationshipId];
  if (!relState || !tx.epochId) return tx;
  const existingEpoch = relState.epochs[tx.epochId];
  if (!existingEpoch || existingEpoch.lifecycle !== 'dissolved') return tx;

  // Legacy re-establishment after dissolution: create a new epoch with a
  // deterministically derived ID that is collision-free even with sparse epochs.
  const epochPrefix = tx.epochId.substring(0, tx.epochId.lastIndexOf('_'));
  // Parse existing numeric suffixes among epochs matching the same prefix pattern
  // to find the maximum value, then allocate max+1. This is deterministic
  // (order-independent, depends only on the set of existing IDs) and guarantees
  // no collision with any existing epoch for this relationship.
  let maxSuffix = 0;
  for (const key of Object.keys(relState.epochs)) {
    if (key.startsWith(`${epochPrefix}_`)) {
      const suffix = key.slice(epochPrefix.length + 1);
      const num = parseInt(suffix, 10);
      if (!isNaN(num) && num > maxSuffix) {
        maxSuffix = num;
      }
    }
  }
  const nextNum = maxSuffix + 1;
  return { ...tx, epochId: `${epochPrefix}_${nextNum}` as unknown as EpochId };
}

/**
 * Applies one story event to mutable state. This is the sole event-effect
 * implementation used by replay and story-boundary compilation.
 */
export function applyNarrativeEvent(
  state: WorldState,
  event: NarrativeEvent,
  options: EventApplicationOptions = {},
): void {
  const branchPath = options.branchPath ?? createEmptyBranchPath();
  const phase = options.phase ?? 'replay';
  if (!includesPath(event.branchExistence, branchPath)) return;

  validatePreconditions(state, event, branchPath, phase);
  const introducedThisEvent = applyPostconditions(state, event, branchPath, options);
  validateParticipants(state, event, introducedThisEvent, phase);
  applyTransactions(state, event);
}

/** Apply deterministic genesis facts before authored event replay. */
export function applyInitialFacts(
  state: WorldState,
  facts: readonly Fact[],
  options: InitialFactApplicationOptions = {},
): void {
  const branchPath = options.branchPath ?? createEmptyBranchPath();
  for (const fact of facts) {
    if (!includesPath(fact.validity.branches, branchPath)) continue;
    if (fact.operation === 'unset') {
      throw new ConfigError(
        `Initial fact ${fact.id} has operation 'unset'; initial state must be deterministic sets`,
        { path: fact.entityId },
      );
    }
    if (fact.value === undefined) continue;
    const entity = state.entities[fact.entityId] ?? { lifecycle: 'active' };
    entity[fact.attribute] = canonicalizeFactValue(fact.value);
    state.entities[fact.entityId] = entity;
    state.facts.push(fact);
  }
}
