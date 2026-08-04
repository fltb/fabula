// ============================================================================
// ReplayEngine — Reconstructs WorldState in causal order
// ============================================================================

import { createEmptyBranchPath } from '../branch/index.js';
import { ConfigError } from '../errors.js';
import type {
  BranchPath,
  EntityCatalogContext,
  Fact,
  NarrativeEvent,
  ThreadId,
  ThreadLifecycle,
  ThreadRunId,
  TimeAnchor,
  WorldState,
} from '../types/index.js';
import { applyInitialFacts, applyNarrativeEvent } from './event-application.ts';
import type { CompiledStoryRuntimeGraph } from './graph-adapter.ts';
import { compileStoryRuntimeGraph } from './graph-adapter.ts';
import { emptyWorldState } from './story-boundaries.ts';

export interface ReplayOptions {
  branchPath?: BranchPath;
  initialFacts?: readonly Fact[];
  initialThreads?: readonly { id: string }[];
  timeAnchors?: readonly TimeAnchor[];
}

function requireCompiledEvent(
  eventsById: ReadonlyMap<string, NarrativeEvent>,
  eventId: string,
): NarrativeEvent {
  const event = eventsById.get(eventId);
  if (event === undefined) {
    throw new ConfigError(`Compiled story order references unknown event "${eventId}"`, {
      eventId,
      phase: 'replay',
    });
  }
  return event;
}

export class ReplayEngine {
  private readonly catalogs: EntityCatalogContext;

  constructor(catalogContext: EntityCatalogContext) {
    this.catalogs = catalogContext;
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
  getStateAt(events: NarrativeEvent[], position: number, options: ReplayOptions = {}): WorldState {
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
    applyInitialFacts(state, compiled.initialFacts, {
      branchPath,
      catalogs: this.catalogs,
    });
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
      applyNarrativeEvent(state, requireCompiledEvent(eventsById, eventId), {
        catalogs: this.catalogs,
        branchPath,
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
    applyInitialFacts(state, compiled.initialFacts, {
      branchPath,
      catalogs: this.catalogs,
    });
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
      applyNarrativeEvent(state, requireCompiledEvent(eventsById, eventId), {
        catalogs: this.catalogs,
        branchPath,
        lifecycleChangesByCoordinate,
        storyCoordinate: compiled.temporalContext.coordinatesByEventId.get(eventId),
        phase: 'replay',
      });
    }

    return state;
  }
}
