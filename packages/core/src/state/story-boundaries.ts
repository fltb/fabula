// ============================================================================
// StoryBoundaries — Semantic state-before / state-after via proven-before order
// ============================================================================

import { createEmptyBranchPath } from '../branch/index.js';
import { ConfigError } from '../errors.js';
import type { BranchPath } from '../types/branch.js';
import type {
  EntityCatalogContext,
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
import type { RelationshipReplayContext } from './relationship-replay.js';

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface StoryBoundaries {
  orderedEventIds: string[];
  stateBeforeByEventId: Map<string, WorldState>;
  stateAfterByEventId: Map<string, WorldState>;
  finalState: WorldState;
}

/** Fully materialized non-entity domains present before the first story event. */
export interface NarrativeStateBaseline {
  readonly epistemicLedger: WorldState['epistemicLedger'];
  readonly propositionCatalog: WorldState['propositionCatalog'];
  readonly commonGround: WorldState['commonGround'];
  readonly threads: WorldState['threads'];
  readonly relationships: WorldState['relationships'];
  readonly rules: WorldState['rules'];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The common empty state for replay and render-boundary compilation. */
export function emptyWorldState(): WorldState {
  return {
    entities: {},
    relationships: {},
    epistemicLedger: { claims: {}, bySubject: {}, byProposition: {}, actLog: [] },
    propositionCatalog: { version: 1, propositions: {}, dependencyGraph: {} },
    commonGround: [],
    threads: {},
    rules: {},
    facts: [],
  };
}

function copyState(state: WorldState): WorldState {
  return structuredClone(state);
}

function requireCompiledEvent(
  eventsById: ReadonlyMap<string, NarrativeEvent>,
  eventId: string,
): NarrativeEvent {
  const event = eventsById.get(eventId);
  if (event === undefined) {
    throw new ConfigError(`Compiled story order references unknown event "${eventId}"`, {
      eventId,
      phase: 'story-boundaries',
    });
  }
  return event;
}

export function applyNarrativeBaseline(
  state: WorldState,
  initialFacts: readonly Fact[],
  initialThreads: readonly { id: string }[],
  branchPath: BranchPath,
  catalogs: EntityCatalogContext,
  baseline?: NarrativeStateBaseline,
): Map<string, Set<string>> {
  const lifecycleChangesByCoordinate = new Map<string, Set<string>>();

  if (baseline) {
    state.epistemicLedger = structuredClone(baseline.epistemicLedger);
    state.propositionCatalog = structuredClone(baseline.propositionCatalog);
    state.commonGround = structuredClone(baseline.commonGround);
    state.threads = structuredClone(baseline.threads);
    state.relationships = structuredClone(baseline.relationships);
    state.rules = structuredClone(baseline.rules);
  }
  applyInitialFacts(state, initialFacts, { branchPath, catalogs });
  for (const thread of initialThreads) {
    if (state.threads[thread.id]) continue;
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
  events: readonly NarrativeEvent[],
  initialFacts: readonly Fact[],
  storyAdjacency: AdjacencyList,
  catalogs: EntityCatalogContext,
  branchPath?: BranchPath,
  initialThreads?: readonly { id: string }[],
  coordinatesByEventId?: ReadonlyMap<string, SceneStoryCoordinate>,
  relationshipReplayContext?: RelationshipReplayContext,
  baseline?: NarrativeStateBaseline,
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
    const event = requireCompiledEvent(eventsById, targetId);
    const state = emptyWorldState();
    const lifecycleGuard = applyNarrativeBaseline(
      state,
      initialFacts,
      threadList,
      selectedBranch,
      catalogs,
      baseline,
    );
    for (const candidateId of order.topologicalOrder) {
      if (candidateId === targetId) break;
      if (isProvenBefore(candidateId, targetId, order)) {
        applyNarrativeEvent(state, requireCompiledEvent(eventsById, candidateId), {
          catalogs,
          relationshipReplayContext,
          branchPath: selectedBranch,
          lifecycleChangesByCoordinate: lifecycleGuard,
          storyCoordinate: coordinatesByEventId?.get(candidateId),
          phase: 'story-boundaries',
        });
      }
    }

    stateBeforeByEventId.set(targetId, copyState(state));

    applyNarrativeEvent(state, event, {
      catalogs,
      relationshipReplayContext,
      branchPath: selectedBranch,
      lifecycleChangesByCoordinate: lifecycleGuard,
      storyCoordinate: coordinatesByEventId?.get(event.id),
      phase: 'story-boundaries',
    });

    stateAfterByEventId.set(targetId, copyState(state));
  }

  const finalState = emptyWorldState();
  // Final state: replay all ordinary events after baseline
  const finalLifecycleGuard = applyNarrativeBaseline(
    finalState,
    initialFacts,
    threadList,
    selectedBranch,
    catalogs,
    baseline,
  );
  for (const eventId of order.topologicalOrder) {
    applyNarrativeEvent(finalState, requireCompiledEvent(eventsById, eventId), {
      catalogs,
      relationshipReplayContext,
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
  events: readonly NarrativeEvent[],
  initialFacts: readonly Fact[],
  storyAdjacency: AdjacencyList,
  catalogs: EntityCatalogContext,
  branchPath?: BranchPath,
  initialThreads?: readonly { id: string }[],
  coordinatesByEventId?: ReadonlyMap<string, SceneStoryCoordinate>,
  relationshipReplayContext?: RelationshipReplayContext,
  baseline?: NarrativeStateBaseline,
): StoryBoundaries {
  return compileStoryBoundaries(
    events,
    initialFacts,
    storyAdjacency,
    catalogs,
    branchPath,
    initialThreads,
    coordinatesByEventId,
    relationshipReplayContext,
    baseline,
  );
}
