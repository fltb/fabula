import type { Fact, NarrativeEvent, WorldState, EntityRuntimeState, ThreadRuntimeState, ThreadLifecycle, ThreadId, ThreadRunId } from '../types/index.js';
import type { BranchPath } from '../types/branch.js';
import { compareFact } from '../entity/compare.js';
import { canonicalizeFactValue } from '../entity/fact-value.js';
import { ConfigError, PreconditionMismatchError } from '../errors.js';
import { buildCausalEdges, topologicalSort } from './dag.js';

// ——— Lifecycle transition defaults ———
const LIFECYCLE_STATES: Record<string, true> = { active: true, inactive: true, retired: true };

const DEFAULT_LIFECYCLE_TRANSITIONS: Array<[EntityRuntimeState, EntityRuntimeState]> = [
  ['active', 'inactive'],
  ['active', 'retired'],
  ['inactive', 'active'],
  ['inactive', 'retired'],
];

export interface StoryBoundaries {
  orderedEventIds: string[];
  stateBeforeByEventId: Map<string, WorldState>;
  finalState: WorldState;
}

export function emptyWorldState(): WorldState {
  return {
    entities: {},
    relationships: {},
    knowledge: {},
    epistemicLedger: { claims: {}, bySubject: {}, byProposition: {}, actLog: [] },
    propositionCatalog: { version: 0, propositions: {}, dependencyGraph: {} },
    threads: {},
    rules: {},
    facts: [],
  };
}

function copyState(state: WorldState): WorldState {
  return structuredClone(state);
}

function applyFacts(state: WorldState, facts: readonly Fact[]): void {
  for (const fact of facts) {
    // Initial facts with operation 'unset' are not allowed
    const op = fact.operation;
    if (op === 'unset') {
      throw new ConfigError(
        `Initial fact ${fact.id} has operation 'unset'; initial state must be deterministic sets`,
        { path: fact.entityId },
      );
    }
    // narrativeHint-only initial facts are allowed but produce no state write (documentation only)
    if (fact.value === undefined) continue;
    const entity = state.entities[fact.entityId] ?? { lifecycle: 'active' };
    entity[fact.attribute] = canonicalizeFactValue(fact.value);
    state.entities[fact.entityId] = entity;
    state.facts.push(fact);
  }
}

export function compileStoryBoundaries(
  events: NarrativeEvent[],
  initialFacts: readonly Fact[],
  anchors: Map<string, number>,
  branchPath?: BranchPath,
  initialThreads?: Array<{ id: string }>,
): StoryBoundaries {
  const { edges, inDegree } = buildCausalEdges(events, { anchors, initialFacts, branchPath });
  const selectedEvents = events.filter((event) => inDegree.has(event.id));
  const eventById = new Map(selectedEvents.map((event) => [event.id, event]));
  const orderedEventIds = topologicalSort(selectedEvents, edges, inDegree, anchors);
  const state = emptyWorldState();
  const stateBeforeByEventId = new Map<string, WorldState>();
  applyFacts(state, initialFacts);

  if (initialThreads) {
    for (const t of initialThreads) {
      state.threads[t.id] = {
        threadId: t.id as ThreadId,
        status: 'planned' as ThreadLifecycle,
        currentRunId: `init-${t.id}` as ThreadRunId,
        phase: '',
        bindings: {},
        goalStates: {},
        milestoneStates: {},
        semanticStateHash: '',
      };
    }
  }

  // Track lifecycle changes by storyTime for conflict detection across events
  const lifecycleChangesByStoryTime = new Map<string, Set<string>>();

  for (const eventId of orderedEventIds) {
    const event = eventById.get(eventId)!;
    stateBeforeByEventId.set(eventId, copyState(state));

    // Precondition validation
    for (const fact of event.preconditions) {
      if (fact.value === undefined) continue;
      if (compareFact(fact, state.entities[fact.entityId]?.[fact.attribute]) !== 'match') {
        throw new PreconditionMismatchError(`Deterministic precondition does not match compiled story state for ${eventId} at ${fact.entityId}.${fact.attribute}`, {
          eventId,
          stateKey: `${fact.entityId}.${fact.attribute}`,
          phase: 'story-boundaries',
        });
      }
    }

    // Track entities introduced in this event for participant check
    const introducedThisEvent = new Set<string>();

    // Validate lifecycle transitions BEFORE applyFacts
    for (const fact of event.postconditions) {
      if (fact.value === undefined) continue;

      // Track newly introduced entities
      if (!state.entities[fact.entityId]) {
        introducedThisEvent.add(fact.entityId);
      }

      // Retired entity guard (prevent writes to retired entities before they happen)
      if (state.entities[fact.entityId]?.lifecycle === 'retired' && fact.attribute !== 'lifecycle') {
        throw new ConfigError(
          `Cannot modify retired entity ${fact.entityId}`,
          { path: fact.entityId, eventId, phase: 'story-boundaries' },
        );
      }

      // Lifecycle transition validation
      const rawValue = String(fact.value);
      if (fact.attribute === 'lifecycle' && LIFECYCLE_STATES[rawValue]) {
        const currentLifecycle = (state.entities[fact.entityId]?.lifecycle as EntityRuntimeState) ?? 'active';
        const newLifecycle = rawValue as EntityRuntimeState;

        if (!DEFAULT_LIFECYCLE_TRANSITIONS.some(([from, to]) => from === currentLifecycle && to === newLifecycle)) {
          throw new ConfigError(
            `Invalid lifecycle transition: ${currentLifecycle} → ${newLifecycle} for entity ${fact.entityId}`,
            { path: fact.entityId, eventId, phase: 'story-boundaries' },
          );
        }

        // Same storyTime lifecycle conflict
        if (event.storyTime) {
          const stKey = JSON.stringify(event.storyTime);
          if (!lifecycleChangesByStoryTime.has(stKey)) {
            lifecycleChangesByStoryTime.set(stKey, new Set());
          }
          if (lifecycleChangesByStoryTime.get(stKey)!.has(fact.entityId)) {
            throw new ConfigError(
              `Same storyTime lifecycle conflict: multiple events at ${stKey} modify lifecycle of ${fact.entityId}`,
              { path: fact.entityId, eventId, phase: 'story-boundaries' },
            );
          }
          lifecycleChangesByStoryTime.get(stKey)!.add(fact.entityId);
        }
      }
    }

    // Apply postcondition effects (includes lifecycle write)
    applyFacts(state, event.postconditions);

    // Participant lifecycle check: retired entities cannot participate unless introduced this event
    if (event.participants) {
      for (const pid of event.participants.entities) {
        if (state.entities[pid]?.lifecycle === 'retired' && !introducedThisEvent.has(pid)) {
          throw new ConfigError(
            `Retired entity ${pid} cannot participate in event ${eventId}`,
            { path: pid, eventId, phase: 'story-boundaries' },
          );
        }
      }
    }
  }

  return { orderedEventIds, stateBeforeByEventId, finalState: state };
}
