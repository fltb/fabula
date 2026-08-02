// ============================================================================
// Context Helper — build PreRenderInput for performance benchmarks
// ============================================================================

import type {
  EpistemicLedger,
  NarrativeEvent,
  PreRenderInput,
  ThreadRuntimeState,
  WorldState,
} from '@novalistically/core';

/**
 * Build a PreRenderInput for use in benchmarks.
 * Mirrors src/validator/base.ts buildContext but avoids circularities.
 */
export function makePreInput(
  event: NarrativeEvent,
  state: WorldState,
  entities: PreRenderInput['entities'],
  events: NarrativeEvent[],
): PreRenderInput {
  return {
    event,
    worldState: state,
    events,
    entities,
    chapter: Math.ceil(event.narrativeOrder / 3),
    queryState: (entityId: string, attribute: string) => state.entities[entityId]?.[attribute],
    getKnowledge: () =>
      ({
        claims: {},
        bySubject: {},
        byProposition: {},
        actLog: [],
      }) as EpistemicLedger,
    getThreadProgress: (threadId: string) => {
      const state: ThreadRuntimeState = {
        threadId: threadId as ThreadRuntimeState['threadId'],
        status: 'active',
        currentRunId: `bench-${threadId}` as ThreadRuntimeState['currentRunId'],
        phase: 'default',
        bindings: {},
        goalStates: {} as ThreadRuntimeState['goalStates'],
        milestoneStates: {} as ThreadRuntimeState['milestoneStates'],
        semanticStateHash: 'benchmark-stub',
      };
      return state;
    },
  };
}
