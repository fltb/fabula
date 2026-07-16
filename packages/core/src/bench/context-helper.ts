// ============================================================================
// Context Helper — build ValidatorContext for performance benchmarks
// ============================================================================

import type { NarrativeEvent, WorldState, EntityRegistry } from '../types/index.js';

/**
 * Build a ValidatorContext for use in benchmarks.
 * Mirrors src/validator/base.ts buildContext but avoids circularities.
 */
export function makeCtx(
  event: NarrativeEvent,
  state: WorldState,
  registry: EntityRegistry,
  events: NarrativeEvent[],
) {
  return {
    worldState: state,
    events,
    entityRegistry: registry,
    currentEvent: event,
    currentChapter: 1,
    narrativeOrder: event.narrativeOrder,
    queryState: (entityId: string, attribute: string) =>
      state.entities[entityId]?.[attribute],
    getKnowledge: () => ({
      worldTruth: state.facts,
      characterKnowledge: {},
      readerKnowledge: [],
      narratorKnowledge: [],
    }),
    getThreadProgress: (threadId: string) =>
      state.threads[threadId] ?? { progress: 0, total: 0 },
    getRuleEvidence: () => [],
  };
}
