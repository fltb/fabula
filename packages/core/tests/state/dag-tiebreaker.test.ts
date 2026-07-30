import { describe, expect, it } from 'vitest';
import { buildCausalEdges, topologicalSort } from '../../src/state/dag.ts';
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
    const graph = buildCausalEdges([alpha, zeta]);
    const sorted = topologicalSort([alpha, zeta], graph.edges, graph.inDegree);
    // "E_alpha" < "E_zeta" lexicographically
    expect(sorted).toEqual(['E_alpha', 'E_zeta']);
    // Assert narrativeOrder was NOT consulted: E_zeta has narrativeOrder=1 but is NOT first
    expect(sorted[0]).not.toBe('E_zeta');
  });

  it('narrativeOrder does not override storyTime ordering', () => {
    // Event with low narrativeOrder but late storyTime should come AFTER
    // event with high narrativeOrder but early storyTime
    const early = event('early', 1, 10); // storyTime day_1, narrativeOrder 10
    const late = event('late', 5, 1); // storyTime day_5, narrativeOrder 1
    const graph = buildCausalEdges([early, late]);
    const sorted = topologicalSort([early, late], graph.edges, graph.inDegree);
    // storyTime day_1 < day_5, so "early" comes first regardless of narrativeOrder
    expect(sorted).toEqual(['early', 'late']);
  });
});
