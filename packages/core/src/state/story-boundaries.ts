import { createEmptyBranchPath } from '../branch/index.js';
import type { BranchPath } from '../types/branch.js';
import type {
  Fact,
  NarrativeEvent,
  ThreadId,
  ThreadLifecycle,
  ThreadRunId,
  WorldState,
} from '../types/index.js';
import { buildCausalEdges, topologicalSort } from './dag.js';
import { applyInitialFacts, applyNarrativeEvent } from './event-application.ts';

export interface StoryBoundaries {
  orderedEventIds: string[];
  stateBeforeByEventId: Map<string, WorldState>;
  finalState: WorldState;
}

/** The common genesis state for replay and render-boundary compilation. */
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

/**
 * Produces the canonical state-before snapshot for each authored event. The
 * compiler intentionally applies only planned story effects; accepted prose
 * never participates in this state boundary.
 */
export function compileStoryBoundaries(
  events: NarrativeEvent[],
  initialFacts: readonly Fact[],
  anchors: Map<string, number>,
  branchPath?: BranchPath,
  initialThreads?: Array<{ id: string }>,
): StoryBoundaries {
  const selectedBranch = branchPath ?? createEmptyBranchPath();
  const { edges, inDegree } = buildCausalEdges(events, {
    anchors,
    initialFacts,
    branchPath: selectedBranch,
  });
  const selectedEvents = events.filter((event) => inDegree.has(event.id));
  const eventsById = new Map(selectedEvents.map((event) => [event.id, event]));
  const orderedEventIds = topologicalSort(selectedEvents, edges, inDegree, anchors);
  const state = emptyWorldState();
  const stateBeforeByEventId = new Map<string, WorldState>();
  const lifecycleChangesByStoryTime = new Map<string, Set<string>>();

  applyInitialFacts(state, initialFacts, { branchPath: selectedBranch });
  for (const thread of initialThreads ?? []) {
    state.threads[thread.id] = {
      threadId: thread.id as ThreadId,
      status: 'planned' as ThreadLifecycle,
      currentRunId: `init-${thread.id}` as ThreadRunId,
      phase: '',
      bindings: {},
      goalStates: {},
      milestoneStates: {},
      semanticStateHash: '',
    };
  }

  for (const eventId of orderedEventIds) {
    const event = eventsById.get(eventId)!;
    stateBeforeByEventId.set(eventId, copyState(state));
    applyNarrativeEvent(state, event, {
      branchPath: selectedBranch,
      lifecycleChangesByStoryTime,
      phase: 'story-boundaries',
    });
  }

  return { orderedEventIds, stateBeforeByEventId, finalState: state };
}
