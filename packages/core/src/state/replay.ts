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
  TimeAnchor,
  WorldState,
} from '../types/index.js';
import { applyNarrativeEvent } from './event-application.ts';
import type { CompiledStoryRuntimeGraph } from './graph-adapter.ts';
import { compileStoryRuntimeGraph } from './graph-adapter.ts';
import type { RelationshipReplayContext } from './relationship-replay.js';
import {
  applyNarrativeBaseline,
  emptyWorldState,
  type NarrativeStateBaseline,
} from './story-boundaries.ts';

export interface ReplayOptions {
  branchPath?: BranchPath;
  initialFacts?: readonly Fact[];
  initialThreads?: readonly { id: string }[];
  timeAnchors?: readonly TimeAnchor[];
  relationshipReplayContext?: RelationshipReplayContext;
  baseline?: NarrativeStateBaseline;
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
  private readonly relationshipReplayContext?: RelationshipReplayContext;

  constructor(
    catalogContext: EntityCatalogContext,
    relationshipReplayContext?: RelationshipReplayContext,
  ) {
    this.catalogs = catalogContext;
    this.relationshipReplayContext = relationshipReplayContext;
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

    return this.buildFromCompiled(compiled, branchPath, options);
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
    const lifecycleChangesByCoordinate = applyNarrativeBaseline(
      state,
      compiled.initialFacts,
      compiled.initialThreads,
      branchPath,
      this.catalogs,
      options.baseline,
    );

    // Replay up to position ordinary events
    const eventsById = new Map(compiled.selectedEvents.map((e) => [e.id, e]));
    for (const eventId of compiled.order.topologicalOrder.slice(0, position)) {
      applyNarrativeEvent(state, requireCompiledEvent(eventsById, eventId), {
        catalogs: this.catalogs,
        relationshipReplayContext:
          options.relationshipReplayContext ?? this.relationshipReplayContext,
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
    options: ReplayOptions,
  ): WorldState {
    const state = emptyWorldState();
    const lifecycleChangesByCoordinate = applyNarrativeBaseline(
      state,
      compiled.initialFacts,
      compiled.initialThreads,
      branchPath,
      this.catalogs,
      options.baseline,
    );

    // Replay ordinary events in topological order
    const eventsById = new Map(compiled.selectedEvents.map((e) => [e.id, e]));
    for (const eventId of compiled.order.topologicalOrder) {
      applyNarrativeEvent(state, requireCompiledEvent(eventsById, eventId), {
        catalogs: this.catalogs,
        relationshipReplayContext:
          options.relationshipReplayContext ?? this.relationshipReplayContext,
        branchPath,
        lifecycleChangesByCoordinate,
        storyCoordinate: compiled.temporalContext.coordinatesByEventId.get(eventId),
        phase: 'replay',
      });
    }

    return state;
  }
}
