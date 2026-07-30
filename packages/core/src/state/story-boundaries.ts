// ============================================================================
// StoryBoundaries — Semantic state-before / state-after via proven-before order
// ============================================================================

import { createEmptyBranchPath } from '../branch/index.js';
import type { BranchPath } from '../types/branch.js';
import type {
  Fact,
  NarrativeEvent,
  SceneStoryCoordinate,
  ThreadId,
  ThreadLifecycle,
  ThreadRunId,
  WorldState,
} from '../types/index.js';
import type { AdjacencyList } from './dag.ts';
import { buildStoryOrderIndex, isProvenBefore } from './dag.ts';
import { applyInitialFacts, applyNarrativeEvent } from './event-application.ts';

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface StoryBoundaries {
  orderedEventIds: string[];
  stateBeforeByEventId: Map<string, WorldState>;
  stateAfterByEventId: Map<string, WorldState>;
  finalState: WorldState;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function applyBaseline(
  state: WorldState,
  initialFacts: readonly Fact[],
  initialThreads: readonly { id: string }[],
  branchPath: BranchPath,
): Map<string, Set<string>> {
  const lifecycleChangesByCoordinate = new Map<string, Set<string>>();

  applyInitialFacts(state, initialFacts, { branchPath });
  for (const thread of initialThreads) {
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

  return lifecycleChangesByCoordinate;
}

// ---------------------------------------------------------------------------
// Boundary compilation
// ---------------------------------------------------------------------------

/**
 * Produces the canonical state-before and state-after snapshot for each authored
 * event using the compiled story adjacency. Each target event is computed with
 * a fresh lifecycle guard: apply baseline, replay all proven-before events in
 * topological order, clone as stateBefore, apply the target, clone as stateAfter.
 *
 * @param events - Ordinary events (already branch-filtered).
 * @param initialFacts - Baseline facts applied before any ordinary event.
 * @param storyAdjacency - Graph-derived event-to-event adjacency.
 * @param branchPath - Active branch path.
 * @param initialThreads - Baseline thread declarations.
 */
export function compileStoryBoundaries(
  events: NarrativeEvent[],
  initialFacts: readonly Fact[],
  storyAdjacency: AdjacencyList,
  branchPath?: BranchPath,
  initialThreads?: Array<{ id: string }>,
  coordinatesByEventId?: ReadonlyMap<string, SceneStoryCoordinate>,
): StoryBoundaries {
  const selectedBranch = branchPath ?? createEmptyBranchPath();
  const threadList = initialThreads ?? [];

  // Build canonical order index from the provided adjacency.
  const order = buildStoryOrderIndex(
    /* initialRootId */ null,
    events.map((e) => e.id),
    storyAdjacency,
    coordinatesByEventId ?? new Map(),
  );

  const eventsById = new Map(events.map((event) => [event.id, event]));
  const stateBeforeByEventId = new Map<string, WorldState>();
  const stateAfterByEventId = new Map<string, WorldState>();

  // Per-target computation
  for (const targetId of order.topologicalOrder) {
    const event = eventsById.get(targetId)!;
    const state = emptyWorldState();
    const lifecycleGuard = applyBaseline(state, initialFacts, threadList, selectedBranch);

    // Replay all events that are proven-before this target, in topological order
    for (const candidateId of order.topologicalOrder) {
      if (candidateId === targetId) break;
      if (isProvenBefore(candidateId, targetId, order)) {
        applyNarrativeEvent(state, eventsById.get(candidateId)!, {
          branchPath: selectedBranch,
          lifecycleChangesByCoordinate: lifecycleGuard,
          storyCoordinate: coordinatesByEventId?.get(candidateId),
          phase: 'story-boundaries',
        });
      }
    }

    stateBeforeByEventId.set(targetId, copyState(state));

    applyNarrativeEvent(state, event, {
      branchPath: selectedBranch,
      lifecycleChangesByCoordinate: lifecycleGuard,
      storyCoordinate: coordinatesByEventId?.get(event.id),
      phase: 'story-boundaries',
    });

    stateAfterByEventId.set(targetId, copyState(state));
  }

  // Final state: replay all ordinary events after baseline
  const finalState = emptyWorldState();
  const finalLifecycleGuard = applyBaseline(finalState, initialFacts, threadList, selectedBranch);
  for (const eventId of order.topologicalOrder) {
    applyNarrativeEvent(finalState, eventsById.get(eventId)!, {
      branchPath: selectedBranch,
      lifecycleChangesByCoordinate: finalLifecycleGuard,
      storyCoordinate: coordinatesByEventId?.get(eventId),
      phase: 'story-boundaries',
    });
  }

  return {
    orderedEventIds: [...order.topologicalOrder],
    stateBeforeByEventId,
    stateAfterByEventId,
    finalState,
  };
}

/**
 * Convenience alias that delegates to compileStoryBoundaries.
 * Both signatures converged after the removal of the numeric anchor map.
 * Events must already be branch-filtered; use the adjacency returned by
 * compileStoryRuntimeGraph / storyGraphToEventAdjacency.
 */
export function compileStoryBoundariesFromGraph(
  events: NarrativeEvent[],
  initialFacts: readonly Fact[],
  storyAdjacency: AdjacencyList,
  branchPath?: BranchPath,
  initialThreads?: Array<{ id: string }>,
  coordinatesByEventId?: ReadonlyMap<string, SceneStoryCoordinate>,
): StoryBoundaries {
  return compileStoryBoundaries(events, initialFacts, storyAdjacency, branchPath, initialThreads, coordinatesByEventId);
}
