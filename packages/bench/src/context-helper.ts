// ============================================================================
// Context Helper — build PreRenderInput for performance benchmarks
// ============================================================================

import type { NarrativeEvent, WorldState, EntityRegistry, PreRenderInput, KnowledgeState } from '@novalistically/core';

/**
 * Build a PreRenderInput for use in benchmarks.
 * Mirrors src/validator/base.ts buildContext but avoids circularities.
 */
export function makePreInput(
  event: NarrativeEvent,
  state: WorldState,
  registry: EntityRegistry,
  events: NarrativeEvent[],
): PreRenderInput {
  return {
    event,
    worldState: state,
    events,
    entityRegistry: registry,
    chapter: Math.ceil(event.narrativeOrder / 3),
    queryState: (entityId: string, attribute: string) =>
      state.entities[entityId]?.[attribute],
    getKnowledge: () => ({
      worldTruth: state.facts,
      characterKnowledge: {},
      readerKnowledge: [],
      narratorKnowledge: [],
    } as KnowledgeState),
    getThreadProgress: () => ({ progress: 0, total: 0 }),
    getRuleEvidence: () => [],
  };
}
