import { describe, expect, it } from 'vitest';
import { compileStoryBoundaries } from '../../src/state/story-boundaries.ts';
import type { Fact, NarrativeEvent } from '../../src/types/index.ts';

function fact(value: string): Fact {
  return {
    id: 'wife.status',
    entityId: 'wife',
    attribute: 'status',
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
  preconditions: Fact[] = [],
  postconditions: Fact[] = [],
): NarrativeEvent {
  return {
    id,
    event: id,
    narrativeOrder: Number(id.slice(1)),
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

describe('compileStoryBoundaries', () => {
  it('creates state-before snapshots in causal order without a genesis event', () => {
    const e2 = event('E2', 2, [fact('arrived')], [fact('departed')]);
    const e1 = event('E1', 1, [fact('alive')], [fact('arrived')]);
    const result = compileStoryBoundaries([e2, e1], [fact('alive')], new Map());
    expect(result.orderedEventIds).toEqual(['E1', 'E2']);
    expect(result.stateBeforeByEventId.get('E1')?.entities.wife.status).toBe('alive');
    expect(result.stateBeforeByEventId.get('E2')?.entities.wife.status).toBe('arrived');
    expect(result.finalState.entities.wife.status).toBe('departed');
  });

  it('uses storyTime as deterministic tiebreaker without violating causal edges', () => {
    // Two independent DAG roots: E2 (day 2) and E1 (day 1)
    // Should appear in day-order: E1 before E2
    const a = event('E2', 2);
    const b = event('E1', 1);
    const result1 = compileStoryBoundaries([a, b], [], new Map());
    expect(result1.orderedEventIds).toEqual(['E1', 'E2']);

    // Same story-time → id localeCompare tiebreaker
    const c = event('C', 1);
    const a_same = event('A', 1);
    const b_same = event('B', 1);
    const result2 = compileStoryBoundaries([c, a_same, b_same], [], new Map());
    expect(result2.orderedEventIds).toEqual(['A', 'B', 'C']);

    // Causal edge preserved even when storyTime reverses natural order:
    // early (day 1) writes X=1, late (day 3) reads X=1 → edge early→late.
    // indep (day 2) has no deps, separate root.
    const early = event('early', 1, [], [fact('value')]);
    const late = event('late', 3, [fact('value')], []);
    const indep = event('indep', 2);
    // Kahn: ready = [early (day 1), indep (day 2)] → pick early (earlier day)
    // After early, late becomes ready.
    // Ready set = [indep (day 2), late (day 3)] → pick indep (earlier day)
    // Then late (day 3)
    const result3 = compileStoryBoundaries([early, late, indep], [], new Map());
    expect(result3.orderedEventIds).toEqual(['early', 'indep', 'late']);
    // Verify causal state is correct:
    expect(result3.stateBeforeByEventId.get('early')?.entities.wife?.status).toBeUndefined();
    // indep runs after early so it sees early's effects
    expect(result3.stateBeforeByEventId.get('indep')?.entities.wife?.status).toBe('value');
    // late also runs after early
    expect(result3.stateBeforeByEventId.get('late')?.entities.wife?.status).toBe('value');
  });
});
