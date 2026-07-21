import { describe, expect, it } from 'vitest';
import type { Fact, NarrativeEvent } from '../../src/types/index.ts';
import { compileStoryBoundaries } from '../../src/state/story-boundaries.ts';

function fact(entityId: string, attribute: string, value: unknown): Fact {
  return {
    id: `${entityId}.${attribute}`, entityId, attribute, value,
    validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
  };
}

function event(id: string, day: number, preconditions: Fact[] = [], postconditions: Fact[] = []): NarrativeEvent {
  return {
    id, event: id, narrativeOrder: Number(id.replace(/\D/g, '') || 0), title: id,
    storyTime: { type: 'absolute', value: `day_${day}` },
    sceneType: 'linear',
    pov: { character: 'narrator', type: 'first_person' },
    sceneBrief: id,
    preconditions, postconditions,
    threadProgress: [], foreshadowing: [],
    relationshipEffects: [], ruleEffects: [],
    source: 'event_file',
    branchExistence: { type: 'all' },
    participants: { entities: [] },
  };
}

describe('genesis root — initialFacts applied as initialState', () => {
  it('initialFacts provide genesis postconditions in state before first event', () => {
    const genesisFacts = [fact('world', 'status', 'created')];
    const e1 = event('E1', 1, [], [fact('hero', 'status', 'awake')]);

    const boundaries = compileStoryBoundaries([e1], genesisFacts, new Map());
    // Genesis fact should be in the initial state before E1
    expect(boundaries.stateBeforeByEventId.get('E1')?.entities['world']?.['status']).toBe('created');
  });

  it('event postcondition overrides genesis initialFact for same entity+attribute', () => {
    // Genesis sets world.status = "created"
    // E1 sets world.status = "changed" — verifies E1's write applies ON TOP of genesis,
    // and genesis is not double-applied (which would either no-op idempotently or corrupt state)
    const genesisFacts = [fact('world', 'status', 'created')];
    const e1 = event('E1', 1, [], [fact('world', 'status', 'changed')]);

    const boundaries = compileStoryBoundaries([e1], genesisFacts, new Map());
    // Before E1: genesis value
    expect(boundaries.stateBeforeByEventId.get('E1')?.entities['world']?.['status']).toBe('created');
    // After E1 (finalState): E1's value overrides
    expect(boundaries.finalState.entities['world']?.['status']).toBe('changed');
  });

  it('no genesis facts → empty initial state', () => {
    const e1 = event('E1', 1, [], [fact('hero', 'status', 'awake')]);
    const boundaries = compileStoryBoundaries([e1], [], new Map());
    expect(boundaries.stateBeforeByEventId.get('E1')?.entities).toEqual({});
  });

  it('multiple genesis facts all appear in initial state', () => {
    const genesisFacts = [
      fact('world', 'status', 'created'),
      fact('world', 'era', 'ancient'),
      fact('villain', 'name', 'darklord'),
    ];
    const e1 = event('E1', 1, [], [fact('hero', 'status', 'awake')]);
    const boundaries = compileStoryBoundaries([e1], genesisFacts, new Map());
    const beforeState = boundaries.stateBeforeByEventId.get('E1')!;
    expect(beforeState.entities['world']?.['status']).toBe('created');
    expect(beforeState.entities['world']?.['era']).toBe('ancient');
    expect(beforeState.entities['villain']?.['name']).toBe('darklord');
  });
});
