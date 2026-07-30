import { describe, expect, it } from 'vitest';
import { PreconditionMismatchError } from '../../src/errors.ts';
import { compileStoryRuntimeGraph } from '../../src/state/graph-adapter.ts';
import { ReplayEngine } from '../../src/state/index.ts';
import type { NarrativeEvent } from '../../src/types/index.ts';

const laneA = { decisions: [{ atEventId: 'E1', choiceId: 'a', narrativeOrder: 1 }] };
const laneB = { decisions: [{ atEventId: 'E1', choiceId: 'b', narrativeOrder: 1 }] };
function event(
  id: string,
  order: number,
  branchExistence: NarrativeEvent['branchExistence'],
): NarrativeEvent {
  return {
    kind: 'event',
    id,
    event: id,
    narrativeOrder: order,
    title: id,
    storyTime: { type: 'absolute', value: `day_${order}` },
    sceneType: 'linear',
    pov: { character: 'narrator', type: 'first_person' },
    sceneBrief: id,
    preconditions: [],
    postconditions: [],
    threadProgress: [],
    foreshadowing: [],
    relationshipEffects: [],
    ruleEffects: [],
    source: 'event_file',
    branchExistence,
    participants: { entities: [] },
  };
}

describe('minimal branch diamond', () => {
  it('keeps trunk and only the selected lane in the causal render set', () => {
    const events = [
      event('E1', 1, { type: 'all' }),
      event('E2a', 2, { type: 'paths', paths: [laneA] }),
      event('E2b', 2, { type: 'paths', paths: [laneB] }),
      event('E3', 3, { type: 'all' }),
    ];

    const compiledA = compileStoryRuntimeGraph({
      events,
      initialFacts: [],
      initialThreads: [],
      timeAnchors: [],
      branchPath: laneA,
    });
    expect(compiledA.order.topologicalOrder).toEqual(['E1', 'E2a', 'E3']);

    const compiledB = compileStoryRuntimeGraph({
      events,
      initialFacts: [],
      initialThreads: [],
      timeAnchors: [],
      branchPath: laneB,
    });
    expect(compiledB.order.topologicalOrder).toEqual(['E1', 'E2b', 'E3']);
  });

  it('rejects a scoped provider when compiling the other lane', () => {
    const writer = event('E2a', 2, { type: 'paths', paths: [laneA] });
    writer.postconditions = [
      {
        id: 'hero.key',
        entityId: 'hero',
        attribute: 'key',
        value: 'a',
        validity: {
          temporal: { start: { type: 'absolute', value: 'day_2' }, end: null },
          branches: { type: 'all' },
        },
      },
    ];
    const reader = event('E3', 3, { type: 'all' });
    reader.preconditions = [{ ...writer.postconditions[0], id: 'hero.key.required' }];
    // E3 requires hero.key = 'a', which only E2a provides on laneA.
    // Compiling with laneB succeeds (absence witness recorded), but
    // replay fails because the precondition can never be satisfied.
    const engine = new ReplayEngine();
    expect(() =>
      engine.replay(
        [event('E1', 1, { type: 'all' }), writer, reader],
        { branchPath: laneB },
      ),
    ).toThrow(PreconditionMismatchError);
  });
});
