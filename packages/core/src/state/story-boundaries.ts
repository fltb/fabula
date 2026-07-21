import type { Fact, NarrativeEvent, WorldState } from '../types/index.js';
import type { BranchPath } from '../types/branch.js';
import { compareFact } from '../entity/compare.js';
import { PreconditionMismatchError } from '../errors.js';
import { buildCausalEdges, topologicalSort } from './dag.js';

export interface StoryBoundaries {
  orderedEventIds: string[];
  stateBeforeByEventId: Map<string, WorldState>;
  finalState: WorldState;
}

function emptyState(): WorldState {
  return { entities: {}, relationships: {}, knowledge: {}, threads: {}, rules: {}, facts: [] };
}

function copyState(state: WorldState): WorldState {
  return structuredClone(state);
}

function applyFacts(state: WorldState, facts: readonly Fact[]): void {
  for (const fact of facts) {
    if (fact.value === undefined) continue;
    const entity = state.entities[fact.entityId] ?? {};
    entity[fact.attribute] = fact.value;
    state.entities[fact.entityId] = entity;
    state.facts.push(fact);
  }
}

export function compileStoryBoundaries(
  events: NarrativeEvent[],
  initialFacts: readonly Fact[],
  anchors: Map<string, number>,
  branchPath?: BranchPath,
  initialThreads?: Array<{ id: string; progress: number; total: number }>,
): StoryBoundaries {
  const { edges, inDegree } = buildCausalEdges(events, { anchors, initialFacts, branchPath });
  const selectedEvents = events.filter((event) => inDegree.has(event.id));
  const eventById = new Map(selectedEvents.map((event) => [event.id, event]));
  const orderedEventIds = topologicalSort(selectedEvents, edges, inDegree, anchors);
  const state = emptyState();
  const stateBeforeByEventId = new Map<string, WorldState>();
  applyFacts(state, initialFacts);

  if (initialThreads) {
    for (const t of initialThreads) {
      state.threads[t.id] = { progress: t.progress, total: t.total };
    }
  }

  for (const eventId of orderedEventIds) {
    const event = eventById.get(eventId)!;
    stateBeforeByEventId.set(eventId, copyState(state));
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
    applyFacts(state, event.postconditions);
  }

  return { orderedEventIds, stateBeforeByEventId, finalState: state };
}
