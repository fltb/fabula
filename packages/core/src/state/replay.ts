// ============================================================================
// ReplayEngine — Reconstructs WorldState in causal order
// ============================================================================

import { createEmptyBranchPath } from '../branch/index.js';
import type {
  BranchPath,
  EntityDeclarationCatalog,
  EntityTypeCatalog,
  Fact,
  NarrativeEvent,
  ThreadId,
  ThreadLifecycle,
  ThreadRunId,
  TimeAnchor,
  WorldState,
} from '../types/index.js';
import type { CompiledStoryRuntimeGraph } from './graph-adapter.ts';
import { compileStoryRuntimeGraph } from './graph-adapter.ts';
import { applyInitialFacts, applyNarrativeEvent } from './event-application.ts';
import { emptyWorldState } from './story-boundaries.ts';

export interface ReplayOptions {
  branchPath?: BranchPath;
  initialFacts?: readonly Fact[];
  initialThreads?: readonly { id: string }[];
  timeAnchors?: readonly TimeAnchor[];
}

export class ReplayEngine {
  private entityDeclarationCatalog?: EntityDeclarationCatalog;
  private entityTypeCatalog?: EntityTypeCatalog;

  constructor(catalogs?: {
    entityDeclarationCatalog?: EntityDeclarationCatalog;
    entityTypeCatalog?: EntityTypeCatalog;
  }) {
    this.entityDeclarationCatalog = catalogs?.entityDeclarationCatalog;
    this.entityTypeCatalog = catalogs?.entityTypeCatalog;
  }

  /** Replay all events in canonical causal order, including baseline. */
  replay(events: NarrativeEvent[], options: ReplayOptions = {}): WorldState {
    const branchPath = options.branchPath ?? createEmptyBranchPath();
    const compiled = compileStoryRuntimeGraph({
      events,
      initialFacts: options.initialFacts ?? [],
      initialThreads: options.initialThreads ?? [],
      timeAnchors: options.timeAnchors ?? [],
      branchPath,
    });

    return this.buildFromCompiled(compiled, branchPath);
  }

  /** Get state after the first `position` causally ordered events (0 = baseline). */
  getStateAt(
    events: NarrativeEvent[],
    position: number,
    options: ReplayOptions = {},
  ): WorldState {
    const branchPath = options.branchPath ?? createEmptyBranchPath();
    const compiled = compileStoryRuntimeGraph({
      events,
      initialFacts: options.initialFacts ?? [],
      initialThreads: options.initialThreads ?? [],
      timeAnchors: options.timeAnchors ?? [],
      branchPath,
    });

    const state = emptyWorldState();
    const lifecycleChangesByCoordinate = new Map<string, Set<string>>();

    // Apply baseline
    applyInitialFacts(state, compiled.initialFacts, { branchPath });
    for (const thread of compiled.initialThreads) {
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

    // Replay up to position ordinary events
    const eventsById = new Map(compiled.selectedEvents.map((e) => [e.id, e]));
    for (const eventId of compiled.order.topologicalOrder.slice(0, position)) {
      applyNarrativeEvent(state, eventsById.get(eventId)!, {
        branchPath,
        entityDeclarationCatalog: this.entityDeclarationCatalog,
        entityTypeCatalog: this.entityTypeCatalog,
        lifecycleChangesByCoordinate,
        storyCoordinate: compiled.temporalContext.coordinatesByEventId.get(eventId),
        phase: 'replay',
      });
    }

    return state;
  }

  /** Full replay from compiled artifact. */
  private buildFromCompiled(
    compiled: CompiledStoryRuntimeGraph,
    branchPath: BranchPath,
  ): WorldState {
    const state = emptyWorldState();
    const lifecycleChangesByCoordinate = new Map<string, Set<string>>();

    // Apply baseline
    applyInitialFacts(state, compiled.initialFacts, { branchPath });
    for (const thread of compiled.initialThreads) {
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

    // Replay ordinary events in topological order
    const eventsById = new Map(compiled.selectedEvents.map((e) => [e.id, e]));
    for (const eventId of compiled.order.topologicalOrder) {
      applyNarrativeEvent(state, eventsById.get(eventId)!, {
        branchPath,
        entityDeclarationCatalog: this.entityDeclarationCatalog,
        entityTypeCatalog: this.entityTypeCatalog,
        lifecycleChangesByCoordinate,
        storyCoordinate: compiled.temporalContext.coordinatesByEventId.get(eventId),
        phase: 'replay',
      });
    }

    return state;
  }
}
