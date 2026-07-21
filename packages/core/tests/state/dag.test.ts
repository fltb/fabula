import { describe, expect, it } from 'vitest';
import type { Fact, NarrativeEvent } from '../../src/types/index.ts';
import { DagCycleError, DagProviderError } from '../../src/errors.ts';
import { buildCausalEdges, topologicalSort } from '../../src/state/dag.ts';

function fact(entityId: string, attribute: string, value: unknown): Fact {
  return { id: `${entityId}.${attribute}`, entityId, attribute, value, validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } } };
}
function event(id: string, day: number, preconditions: Fact[] = [], postconditions: Fact[] = []): NarrativeEvent {
  return { id, event: id, narrativeOrder: Number(id.slice(1)), title: id, storyTime: { type: 'absolute', value: `day_${day}` }, sceneType: 'linear', pov: { character: 'narrator', type: 'first_person' }, sceneBrief: id, preconditions, postconditions, threadProgress: [], foreshadowing: [], relationshipEffects: [], ruleEffects: [], source: 'event_file', branchExistence: { type: 'all' }, participants: { entities: [] } };
}

describe('strict causal compiler', () => {
  it('uses strictly earlier story-time providers, not narrative order', () => {
    const e2 = event('E2', 1, [], [fact('wife', 'status', 'alive')]);
    const e1 = event('E1', 2, [fact('wife', 'status', 'alive')]);
    const graph = buildCausalEdges([e1, e2]);
    expect(graph.edges.get('E2')).toEqual(['E1']);
    expect(topologicalSort([e1, e2], graph.edges, graph.inDegree)).toEqual(['E2', 'E1']);
  });

  it('rejects missing, ambiguous, and future providers', () => {
    const needed = fact('wife', 'status', 'alive');
    expect(() => buildCausalEdges([event('E1', 2, [needed])])).toThrow(DagProviderError);
    expect(() => buildCausalEdges([event('E1', 2, [needed]), event('E2', 3, [], [needed])])).toThrow(DagProviderError);
    expect(() => buildCausalEdges([event('E1', 2, [needed]), event('E2', 1, [], [needed]), event('E3', 1, [], [needed])])).toThrow(DagProviderError);
  });

  it('does not mutate indegree and rejects cycles', () => {
    const a = event('E1', 1);
    const b = event('E2', 2);
    const edges = new Map([['E1', ['E2']], ['E2', ['E1']]]);
    const inDegree = new Map([['E1', 1], ['E2', 1]]);
    expect(() => topologicalSort([a, b], edges, inDegree)).toThrow(DagCycleError);
    expect(inDegree).toEqual(new Map([['E1', 1], ['E2', 1]]));
  });
});
