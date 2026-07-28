// ============================================================================
// ReplayEngine — Reconstructs WorldState in causal order
// ============================================================================

import { createEmptyBranchPath, includesPath } from '../branch/index.js';
import type {
  BranchPath,
  EntityDeclarationCatalog,
  EntityTypeCatalog,
  NarrativeEvent,
  WorldState,
} from '../types/index.js';
import { buildCausalEdges, topologicalSort } from './dag.js';
import { applyNarrativeEvent } from './event-application.ts';
import { emptyWorldState } from './story-boundaries.js';

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

  /** Replay the branch-visible events in deterministic causal order. */
  replay(events: NarrativeEvent[], branchPath?: BranchPath): WorldState {
    const selectedBranch = branchPath ?? createEmptyBranchPath();
    const selectedEvents = events.filter((event) => includesPath(event.branchExistence, selectedBranch));
    const anchors = collectAnchors(selectedEvents);
    const { edges, inDegree } = buildCausalEdges(selectedEvents, {
      anchors,
      branchPath: selectedBranch,
    });
    const sortedIds = topologicalSort(selectedEvents, edges, inDegree, anchors);
    const eventsById = new Map(selectedEvents.map((event) => [event.id, event]));
    const state = emptyWorldState();
    const lifecycleChangesByStoryTime = new Map<string, Set<string>>();

    for (const eventId of sortedIds) {
      applyNarrativeEvent(state, eventsById.get(eventId)!, {
        branchPath: selectedBranch,
        entityDeclarationCatalog: this.entityDeclarationCatalog,
        entityTypeCatalog: this.entityTypeCatalog,
        lifecycleChangesByStoryTime,
        phase: 'replay',
      });
    }

    return state;
  }

  /** Get state after the first `position` causally ordered events. */
  getStateAt(events: NarrativeEvent[], position: number, branchPath?: BranchPath): WorldState {
    const selectedBranch = branchPath ?? createEmptyBranchPath();
    const selectedEvents = events.filter((event) => includesPath(event.branchExistence, selectedBranch));
    const anchors = collectAnchors(selectedEvents);
    const { edges, inDegree } = buildCausalEdges(selectedEvents, {
      anchors,
      branchPath: selectedBranch,
    });
    const sortedIds = topologicalSort(selectedEvents, edges, inDegree, anchors);
    const eventsById = new Map(selectedEvents.map((event) => [event.id, event]));
    const state = emptyWorldState();
    const lifecycleChangesByStoryTime = new Map<string, Set<string>>();

    for (const eventId of sortedIds.slice(0, position)) {
      applyNarrativeEvent(state, eventsById.get(eventId)!, {
        branchPath: selectedBranch,
        entityDeclarationCatalog: this.entityDeclarationCatalog,
        entityTypeCatalog: this.entityTypeCatalog,
        lifecycleChangesByStoryTime,
        phase: 'replay',
      });
    }

    return state;
  }
}

function collectAnchors(events: readonly NarrativeEvent[]): Map<string, number> {
  const anchors = new Map<string, number>();
  for (const { storyTime } of events) {
    if (storyTime.type !== 'absolute') continue;
    const match = storyTime.value.match(/^day[_\s]*(-?\d+)$/i);
    if (match) anchors.set(storyTime.value, Number.parseInt(match[1], 10));
  }
  return anchors;
}
