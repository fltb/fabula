import { createEmptyBranchPath, includesPath } from '../branch/index.js';
import { canonicalizeFactValue } from '../entity/fact-value.js';
import { ConfigError, PreconditionMismatchError } from '../errors.js';
import { canonicalJson } from '../render/scene-contract.ts';
import type {
  BranchPath,
  EntityCatalogContext,
  EntityRuntimeState,
  Fact,
  NarrativeEvent,
  SceneStoryCoordinate,
  WorldState,
} from '../types/index.js';
import { applyClaimTransaction, recordInformationAct } from './knowledge-replay.js';
import {
  applyRelationshipIdentityTransitionGroup,
  applyRelationshipTransaction,
  type RelationshipReplayContext,
} from './relationship-replay.js';
import { applyRuleTransaction } from './rule-replay.js';
import { applyThreadTransaction } from './thread-replay.js';

/** Synthetic event prefix for entity activation transitions. */
export const INTRODUCTION_EVENT_PREFIX = 'system:introduction:';

/** Parse `system:introduction:<targetEventId>:<entityId>`; null for any other event id. */
export function parseIntroductionTransition(
  eventId: string,
): { targetEventId: string; entityId: string } | null {
  if (!eventId.startsWith(INTRODUCTION_EVENT_PREFIX)) return null;
  const rest = eventId.slice(INTRODUCTION_EVENT_PREFIX.length);
  const separator = rest.lastIndexOf(':');
  if (separator <= 0 || separator === rest.length - 1) return null;
  return { targetEventId: rest.slice(0, separator), entityId: rest.slice(separator + 1) };
}

export interface EventApplicationOptions {
  /** The one shared catalog pair; required, no optional fallback. */
  catalogs: EntityCatalogContext;
  /**
   * Relationship replay context (declarations + type catalog). Required:
   * replay fails closed whenever an event carries relationship effects and
   * this context is absent — there is no default relationship handling.
   */
  relationshipReplayContext?: RelationshipReplayContext;
  branchPath?: BranchPath;
  lifecycleChangesByCoordinate?: Map<string, Set<string>>;
  storyCoordinate?: SceneStoryCoordinate;
  phase?: string;
}

export interface InitialFactApplicationOptions {
  /** The one shared catalog pair; required, no optional fallback. */
  catalogs: EntityCatalogContext;
  branchPath?: BranchPath;
}

/** Diagnostic context for catalog write validation; never part of rule messages. */
export interface CatalogWritePhaseContext {
  phase: string;
  eventId?: string;
  storyCoordinate?: SceneStoryCoordinate;
  lifecycleChangesByCoordinate?: Map<string, Set<string>>;
}

function writeError(
  _policy: string,
  message: string,
  phaseContext: CatalogWritePhaseContext,
  path: string,
): ConfigError {
  return new ConfigError(message, {
    path,
    eventId: phaseContext.eventId,
    phase: phaseContext.phase,
  });
}

/**
 * The single write-policy rule engine. Source preflight and every replay path
 * call this function, so one rule set applies everywhere. It is pure: it never
 * mutates state or catalogs and throws ConfigError on the first violation.
 *
 * Rule messages are source-neutral: they name the violated policy and the
 * `entity.attribute` target. The phase context only changes the diagnostic
 * context attached to the error.
 *
 * Enforced policies: unknown declaration/type/attribute, value schema, typed
 * reference kind/type, initial-vs-event activation source, live write timing,
 * introduction transition identity, immutable / write_once / mutable /
 * lifecycle_managed, allowed lifecycle states and transitions, same-coordinate
 * lifecycle conflicts, and unset allowed/existing. `typedInvariants` stay
 * unexecuted (always empty in the current contract).
 */
export function validateCatalogWrite(
  state: WorldState,
  fact: Fact,
  phaseContext: CatalogWritePhaseContext,
  catalogs: EntityCatalogContext,
): void {
  const { entityDeclarationCatalog, entityTypeCatalog } = catalogs;
  const target = `${fact.entityId}.${fact.attribute}`;

  const declaration = entityDeclarationCatalog.declarations[fact.entityId];
  if (!declaration) {
    throw writeError(
      'unknown_declaration',
      `Unknown entity declaration "${fact.entityId}"`,
      phaseContext,
      target,
    );
  }

  const typeDefinition = entityTypeCatalog.types[declaration.typeRef.typeId];
  if (!typeDefinition) {
    throw writeError(
      'unknown_type',
      `Unknown entity type "${declaration.typeRef.typeId}" for declaration "${fact.entityId}"`,
      phaseContext,
      target,
    );
  }

  const attributeDefinition = typeDefinition.attributes[fact.attribute];
  if (!attributeDefinition) {
    throw writeError(
      'unknown_attribute',
      `Write to unknown attribute "${target}"`,
      phaseContext,
      target,
    );
  }

  // ——— Activation source + live write timing ———
  const isLive = fact.entityId in state.entities;
  const isIntroductionWrite =
    phaseContext.phase === 'initial' || phaseContext.eventId?.startsWith(INTRODUCTION_EVENT_PREFIX);

  if (phaseContext.phase === 'initial') {
    if (declaration.introduction.type !== 'initial') {
      throw writeError(
        'initial_vs_event_activation',
        `Initial fact cannot activate event-introduced entity "${fact.entityId}" (introduced by event "${declaration.introduction.eventId}")`,
        phaseContext,
        target,
      );
    }
  } else if (!isLive) {
    if (declaration.introduction.type === 'event') {
      const expectedEventId = `${INTRODUCTION_EVENT_PREFIX}${declaration.introduction.eventId}:${fact.entityId}`;
      if (phaseContext.eventId !== expectedEventId) {
        const actor = phaseContext.eventId ?? 'initial facts';
        throw writeError(
          'introduction_transition_identity',
          `Write to "${target}" before activation: entity "${fact.entityId}" is introduced by event "${declaration.introduction.eventId}" and can only be activated by introduction transition "${expectedEventId}", not "${actor}"`,
          phaseContext,
          target,
        );
      }
    } else {
      throw writeError(
        'live_write_timing',
        `Write to "${target}" before activation: entity "${fact.entityId}" is initial-activated and must be activated by initial facts`,
        phaseContext,
        target,
      );
    }
  }

  // Narrative-hint facts carry no state write; declaration/attribute/timing
  // checks above already cover their references.
  if (fact.value === undefined && fact.operation !== 'unset') return;

  if (fact.operation === 'unset') {
    if (fact.attribute === 'lifecycle') {
      throw writeError(
        'lifecycle_unset',
        `Cannot unset lifecycle attribute "${target}"`,
        phaseContext,
        target,
      );
    }
    if (!attributeDefinition.unsetAllowed) {
      throw writeError(
        'unset_not_allowed',
        `Unset is not allowed for attribute "${target}"`,
        phaseContext,
        target,
      );
    }
    if (!isLive || !(fact.attribute in state.entities[fact.entityId])) {
      throw writeError(
        'unset_absent',
        `Cannot unset absent attribute "${target}"`,
        phaseContext,
        target,
      );
    }
    return;
  }

  if (fact.value === undefined) return;

  // ——— Value schema ———
  const parsed = attributeDefinition.valueSchema.safeParse(fact.value);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => issue.message).join('; ');
    throw writeError(
      'value_schema',
      `Value for "${target}" violates value schema${detail ? `: ${detail}` : ''}`,
      phaseContext,
      target,
    );
  }

  // ——— Typed reference kind/type ———
  if (attributeDefinition.typedReferenceConstraint) {
    const constraint = attributeDefinition.typedReferenceConstraint;
    if (typeof fact.value !== 'string') {
      throw writeError(
        'typed_reference_format',
        `Reference value for "${target}" must be an entity id string`,
        phaseContext,
        target,
      );
    }
    const refDeclaration = entityDeclarationCatalog.declarations[fact.value];
    if (!refDeclaration) {
      throw writeError(
        'typed_reference_undeclared',
        `Reference "${fact.value}" for "${target}" is not a declared entity`,
        phaseContext,
        target,
      );
    }
    const refType = entityTypeCatalog.types[refDeclaration.typeRef.typeId];
    if (!refType || refType.kind !== constraint.targetKind) {
      throw writeError(
        'typed_reference_kind',
        `Reference "${fact.value}" for "${target}" must target kind "${constraint.targetKind}" (declared kind: ${refType?.kind ?? 'unknown'})`,
        phaseContext,
        target,
      );
    }
    if (
      constraint.targetTypeId !== undefined &&
      refDeclaration.typeRef.typeId !== constraint.targetTypeId
    ) {
      throw writeError(
        'typed_reference_type',
        `Reference "${fact.value}" for "${target}" must target type "${constraint.targetTypeId}" (declared type: "${refDeclaration.typeRef.typeId}")`,
        phaseContext,
        target,
      );
    }
  }

  const currentEntity = state.entities[fact.entityId];
  const attributePresent = isLive && fact.attribute in currentEntity;

  if (isLive && currentEntity.lifecycle === 'retired' && fact.attribute !== 'lifecycle') {
    throw writeError(
      'lifecycle_retired',
      `Cannot modify retired entity "${fact.entityId}" (write to "${target}")`,
      phaseContext,
      target,
    );
  }

  // ——— Write policy ———
  switch (attributeDefinition.writePolicy) {
    case 'immutable':
      if (!isIntroductionWrite) {
        throw writeError('immutable', `Attribute "${target}" is immutable`, phaseContext, target);
      }
      break;
    case 'write_once':
      if (attributePresent) {
        throw writeError(
          'write_once',
          `Attribute "${target}" is write-once and has already been written`,
          phaseContext,
          target,
        );
      }
      break;
    case 'mutable':
      break;
    case 'lifecycle_managed': {
      if (fact.attribute !== 'lifecycle') {
        throw writeError(
          'lifecycle_managed',
          `Attribute "${target}" is lifecycle-managed but is not the lifecycle attribute`,
          phaseContext,
          target,
        );
      }
      if (typeof fact.value !== 'string') {
        throw writeError(
          'lifecycle_state',
          `Lifecycle value for "${target}" must be a string state`,
          phaseContext,
          target,
        );
      }
      if (
        attributeDefinition.allowedLifecycleStates !== undefined &&
        !attributeDefinition.allowedLifecycleStates.includes(fact.value as EntityRuntimeState)
      ) {
        throw writeError(
          'lifecycle_state',
          `Invalid lifecycle state "${fact.value}" for "${target}"`,
          phaseContext,
          target,
        );
      }
      if (!isIntroductionWrite && isLive) {
        const current = currentEntity.lifecycle as EntityRuntimeState | undefined;
        const next = fact.value as EntityRuntimeState;
        if (
          current !== undefined &&
          !typeDefinition.lifecyclePolicy.allowedTransitions.some(
            ([from, to]) => from === current && to === next,
          )
        ) {
          throw writeError(
            'lifecycle_transition',
            `Invalid lifecycle transition ${current} → ${next} for "${target}"`,
            phaseContext,
            target,
          );
        }
        const coordinate = phaseContext.storyCoordinate;
        const changes = phaseContext.lifecycleChangesByCoordinate;
        if (coordinate && coordinate.kind === 'point' && changes) {
          const coordinateKey = canonicalJson(coordinate);
          const changedEntities = changes.get(coordinateKey) ?? new Set<string>();
          if (changedEntities.has(fact.entityId)) {
            throw writeError(
              'lifecycle_coordinate_conflict',
              `Same coordinate lifecycle conflict: multiple events at ${coordinateKey} modify lifecycle of "${fact.entityId}"`,
              phaseContext,
              target,
            );
          }
          changedEntities.add(fact.entityId);
          changes.set(coordinateKey, changedEntities);
        }
      }
      break;
    }
  }
}

/**
 * Enforce requiredAt (introduction/activation) attributes after an entity's
 * introduction writes complete: every declared attribute with a non-`never`
 * requiredAt must be present in the live state at that point.
 */
export function validateIntroductionRequirements(
  state: WorldState,
  entityId: string,
  phaseContext: CatalogWritePhaseContext,
  catalogs: EntityCatalogContext,
): void {
  const declaration = catalogs.entityDeclarationCatalog.declarations[entityId];
  if (!declaration) return;
  const typeDefinition = catalogs.entityTypeCatalog.types[declaration.typeRef.typeId];
  if (!typeDefinition) return;

  const entity = state.entities[entityId];
  for (const [attributeId, attributeDefinition] of Object.entries(typeDefinition.attributes)) {
    if (attributeDefinition.requiredAt === 'never') continue;
    if (!entity || !(attributeId in entity)) {
      throw writeError(
        'required_at',
        `Required attribute "${entityId}.${attributeId}" (requiredAt: ${attributeDefinition.requiredAt}) missing after activation`,
        phaseContext,
        `${entityId}.${attributeId}`,
      );
    }
  }
}

function preconditionMatches(
  operator: NonNullable<Fact['operator']>,
  stateValue: unknown,
  factValue: unknown,
): boolean {
  switch (operator) {
    case 'eq':
      return stateValue === factValue;
    case 'neq':
      return stateValue !== undefined && stateValue !== factValue;
    case 'gt':
      return (
        typeof stateValue === 'number' && typeof factValue === 'number' && stateValue > factValue
      );
    case 'gte':
      return (
        typeof stateValue === 'number' && typeof factValue === 'number' && stateValue >= factValue
      );
    case 'lt':
      return (
        typeof stateValue === 'number' && typeof factValue === 'number' && stateValue < factValue
      );
    case 'lte':
      return (
        typeof stateValue === 'number' && typeof factValue === 'number' && stateValue <= factValue
      );
    case 'contains':
      return (
        (typeof stateValue === 'string' &&
          typeof factValue === 'string' &&
          stateValue.includes(factValue)) ||
        (Array.isArray(stateValue) && stateValue.some((value) => value === factValue))
      );
    case 'not_contains':
      return (
        (typeof stateValue === 'string' &&
          typeof factValue === 'string' &&
          !stateValue.includes(factValue)) ||
        (Array.isArray(stateValue) && !stateValue.some((value) => value === factValue)) ||
        stateValue === undefined
      );
    case 'exists':
      return stateValue !== undefined;
    case 'not_exists':
      return stateValue === undefined;
  }
}

function validatePreconditions(
  state: WorldState,
  event: NarrativeEvent,
  branchPath: BranchPath,
  phase: string,
  catalogs: EntityCatalogContext,
): void {
  for (const fact of event.preconditions) {
    if (!includesPath(fact.validity.branches, branchPath)) continue;

    const declaration = catalogs.entityDeclarationCatalog.declarations[fact.entityId];
    if (!declaration) {
      throw new ConfigError(`Unknown entity declaration "${fact.entityId}"`, {
        eventId: event.id,
        stateKey: `${fact.entityId}.${fact.attribute}`,
        phase,
      });
    }

    // Live read timing: any precondition reference to a not-yet-live entity is
    // a pre-activation reference (declarations always pre-exist compilation).
    if (!(fact.entityId in state.entities)) {
      throw new ConfigError(
        `Live read before activation: precondition references entity "${fact.entityId}" which is not yet live`,
        {
          eventId: event.id,
          stateKey: `${fact.entityId}.${fact.attribute}`,
          phase,
        },
      );
    }

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

    validateCatalogWrite(
      state,
      fact,
      {
        phase,
        eventId: event.id,
        storyCoordinate: options.storyCoordinate,
        lifecycleChangesByCoordinate: options.lifecycleChangesByCoordinate,
      },
      options.catalogs,
    );

    if (
      fact.value === undefined &&
      fact.narrativeHint !== undefined &&
      fact.operation !== 'unset'
    ) {
      state.facts.push(fact);
      continue;
    }

    if (!(fact.entityId in state.entities)) {
      // Approved introduction write: activation happens exactly here.
      state.entities[fact.entityId] = {};
      introducedThisEvent.add(fact.entityId);
    }

    const key = `${fact.entityId}::${fact.attribute}`;
    if (writtenKeys.has(key)) {
      throw new ConfigError(
        `Duplicate write to ${fact.entityId}.${fact.attribute} within event ${event.id}`,
        { path: fact.entityId, eventId: event.id, phase },
      );
    }
    writtenKeys.add(key);

    if (fact.operation === 'unset') {
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
    if (!(entityId in state.entities) && !introducedThisEvent.has(entityId)) {
      throw new ConfigError(
        `Entity "${entityId}" is not live; cannot participate in event ${event.id} (live reference before activation)`,
        { path: entityId, eventId: event.id, phase },
      );
    }
    if (state.entities[entityId]?.lifecycle === 'retired' && !introducedThisEvent.has(entityId)) {
      throw new ConfigError(`Retired entity ${entityId} cannot participate in event ${event.id}`, {
        path: entityId,
        eventId: event.id,
        phase,
      });
    }
  }
}

function requireKnownProposition(state: WorldState, propositionId: string, eventId: string): void {
  if (state.propositionCatalog.propositions[propositionId]) return;
  throw new ConfigError(`Unknown proposition "${propositionId}" in event ${eventId}`, {
    path: `knowledge:${propositionId}`,
    eventId,
    phase: 'knowledge',
  });
}

function applyKnowledgeTransactions(state: WorldState, event: NarrativeEvent): void {
  for (const transaction of event.knowledgeTransactions ?? []) {
    switch (transaction.type) {
      case 'claim_write':
        requireKnownProposition(state, transaction.propositionId, event.id);
        state.epistemicLedger = applyClaimTransaction(
          state.epistemicLedger,
          transaction.subject,
          transaction.propositionId,
          transaction.assessment,
          transaction.evidence,
        );
        break;
      case 'information_act':
        for (const propositionId of transaction.contentPropositions) {
          requireKnownProposition(state, propositionId, event.id);
        }
        state.epistemicLedger = recordInformationAct(state.epistemicLedger, {
          type: transaction.actType,
          actor: transaction.actor,
          recipients: transaction.recipients,
          contentPropositions: transaction.contentPropositions,
          timestamp: transaction.timestamp,
          eventId: transaction.eventId,
          storyBoundary: transaction.storyBoundary,
          inWorldSource: transaction.inWorldSource,
          corpusProvenance: transaction.corpusProvenance,
          warrantJustification: transaction.warrantJustification,
        });
        break;
      case 'common_ground':
        requireKnownProposition(state, transaction.propositionId, event.id);
        state.commonGround.push({
          propositionId: transaction.propositionId,
          participants: [...transaction.participants],
          establishedAt: transaction.establishedAt,
          establishedBy: transaction.establishedBy ?? transaction.provenance ?? event.id,
        });
        break;
    }
  }
}

function applyTransactions(
  state: WorldState,
  event: NarrativeEvent,
  options: EventApplicationOptions,
): void {
  for (const transaction of event.threadProgress) {
    applyThreadTransaction(state.threads, transaction);
  }

  if (event.relationshipEffects.length > 0) {
    const relationshipReplayContext = options.relationshipReplayContext;
    if (!relationshipReplayContext) {
      throw new ConfigError(
        `Event ${event.id} carries relationship effects but no relationship replay context was provided`,
        { eventId: event.id, phase: options.phase ?? 'replay' },
      );
    }

    for (const effect of event.relationshipEffects) {
      if (effect.type === 'identity_transition') {
        applyRelationshipIdentityTransitionGroup(
          state.relationships,
          effect,
          relationshipReplayContext,
        );
      } else {
        applyRelationshipTransaction(state.relationships, effect, relationshipReplayContext);
      }
    }
  }

  for (const transaction of event.ruleEffects) {
    applyRuleTransaction(state.rules, transaction, {
      nodeId: event.id,
    });
  }
  applyKnowledgeTransactions(state, event);
}

/**
 * Applies one story event to mutable state. This is the sole event-effect
 * implementation used by replay and story-boundary compilation.
 */
export function applyNarrativeEvent(
  state: WorldState,
  event: NarrativeEvent,
  options: EventApplicationOptions,
): void {
  const branchPath = options.branchPath ?? createEmptyBranchPath();
  const phase = options.phase ?? 'replay';
  if (!includesPath(event.branchExistence, branchPath)) return;

  // Introduction transition identity: a transition may only activate an entity
  // that is not already live — activation happens exactly once.
  const introductionTarget = parseIntroductionTransition(event.id);
  if (introductionTarget && introductionTarget.entityId in state.entities) {
    throw new ConfigError(
      `Duplicate activation: entity "${introductionTarget.entityId}" is already live before introduction transition "${event.id}"`,
      { eventId: event.id, path: introductionTarget.entityId, phase },
    );
  }

  validatePreconditions(state, event, branchPath, phase, options.catalogs);
  const introducedThisEvent = applyPostconditions(state, event, branchPath, options);
  validateParticipants(state, event, introducedThisEvent, phase);
  applyTransactions(state, event, options);

  // Required fields are checked after introduction writes complete.
  if (introductionTarget) {
    validateIntroductionRequirements(
      state,
      introductionTarget.entityId,
      { phase, eventId: event.id },
      options.catalogs,
    );
  }
}

/** Apply deterministic initial facts before authored event replay. */
export function applyInitialFacts(
  state: WorldState,
  facts: readonly Fact[],
  options: InitialFactApplicationOptions,
): void {
  const branchPath = options.branchPath ?? createEmptyBranchPath();
  const activated = new Set<string>();
  for (const fact of facts) {
    if (!includesPath(fact.validity.branches, branchPath)) continue;
    if (fact.operation === 'unset') {
      throw new ConfigError(
        `Initial fact ${fact.id} has operation 'unset'; initial state must be deterministic sets`,
        { path: fact.entityId, phase: 'initial' },
      );
    }
    if (fact.value === undefined) continue;
    const wasLive = fact.entityId in state.entities;
    validateCatalogWrite(state, fact, { phase: 'initial' }, options.catalogs);
    const entity = state.entities[fact.entityId] ?? {};
    entity[fact.attribute] = canonicalizeFactValue(fact.value);
    state.entities[fact.entityId] = entity;
    state.facts.push(fact);
    if (!wasLive) activated.add(fact.entityId);
  }

  // Required fields are checked after introduction writes complete.
  for (const entityId of activated) {
    validateIntroductionRequirements(state, entityId, { phase: 'initial' }, options.catalogs);
  }
}
