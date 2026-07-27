// ============================================================================
// Context Helper — build PreRenderInput for performance benchmarks
// ============================================================================

import type {
  EntityRegistry,
  EpistemicLedger,
  GoalLifecycle,
  MilestoneLifecycle,
  NarrativeEvent,
  PreRenderInput,
  ThreadId,
  ThreadRunId,
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
  registry: EntityRegistry,
  events: NarrativeEvent[],
): PreRenderInput {
  return {
    event,
    worldState: state,
    events,
    entityRegistry: registry,
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
        threadId: threadId as ThreadId,
        status: 'active',
        currentRunId: `bench-${threadId}` as ThreadRunId,
        phase: 'default',
        bindings: {},
        goalStates: {} as Record<string, GoalLifecycle>,
        milestoneStates: {} as Record<string, MilestoneLifecycle>,
        semanticStateHash: 'benchmark-stub',
      };
      return state;
    },
  };
}
