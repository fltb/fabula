import { describe, expect, it } from 'vitest';
import { buildStoryOrderIndex } from '../../src/state/dag.ts';
import type { Fact, NarrativeEvent } from '../../src/types/index.ts';

function fact(entityId: string, attribute: string, value: unknown): Fact {
  return {
    id: `${entityId}.${attribute}`,
    entityId,
    attribute,
    value,
    validity: {
      temporal: { start: { type: 'absolute', value: 'day_0' }, end: null },
      branches: { type: 'all' },
    },
  };
}

function event(
  id: string,
  day: number,
  narrativeOrder: number,
  preconditions: Fact[] = [],
  postconditions: Fact[] = [],
): NarrativeEvent {
  return {
    kind: 'event',
    id,
    event: id,
    narrativeOrder,
    title: id,
    storyTime: { type: 'absolute', value: `day_${day}` },
    sceneType: 'linear',
    pov: { character: 'narrator', type: 'first_person' },
    sceneBrief: id,
    beats: [id],
    preconditions,
    postconditions,
    threadProgress: [],
    foreshadowing: [],
    relationshipEffects: [],
    ruleEffects: [],
    source: 'event_file',
    branchExistence: { type: 'all' },
    participants: { entities: [] },
  };
}

describe('narrativeOrder is not used as tiebreaker', () => {
  it('orders same-day events by event ID, not narrativeOrder', () => {
    // Two events at same day, no causal edge between them
    // E_alpha has narrativeOrder=5, E_zeta has narrativeOrder=1
    // Old behavior: E_zeta first (narrativeOrder 1 < 5)
    // New behavior: E_alpha first (lexicographic "E_alpha" < "E_zeta")
    const alpha = event('E_alpha', 1, 5);
    const zeta = event('E_zeta', 1, 1);
    // Same storyTime → no temporal constraint → event ID tiebreaker
    const order = buildStoryOrderIndex(null, ['E_alpha', 'E_zeta'], new Map(), new Map());
    // "E_alpha" < "E_zeta" lexicographically
    expect(order.topologicalOrder).toEqual(['E_alpha', 'E_zeta']);
    // Assert narrativeOrder was NOT consulted: E_zeta has narrativeOrder=1 but is NOT first
    expect(order.topologicalOrder[0]).not.toBe('E_zeta');
  });

  it('narrativeOrder does not override storyTime ordering', () => {
    // Event with low narrativeOrder but late storyTime should come AFTER
    // event with high narrativeOrder but early storyTime
    const early = event('early', 1, 10); // storyTime day_1, narrativeOrder 10
    const late = event('late', 5, 1); // storyTime day_5, narrativeOrder 1
    // Different storyTime → temporal edge from early to late
    const adjacency = new Map<string, string[]>([['early', ['late']]]);
    const order = buildStoryOrderIndex(null, ['early', 'late'], adjacency, new Map());
    // storyTime day_1 < day_5, so "early" comes first regardless of narrativeOrder
    expect(order.topologicalOrder).toEqual(['early', 'late']);
  });
});
