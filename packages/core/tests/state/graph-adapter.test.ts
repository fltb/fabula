import { describe, expect, it } from 'vitest';
import { compilePlannedDiscourseLedger } from '../../src/state/discourse-ledger.ts';
import {
  compileNarrativeGraphs,
  storyGraphToEventAdjacency,
} from '../../src/state/graph-adapter.ts';
import type { Fact, NarrativeEvent } from '../../src/types/index.ts';

function fact(id: string, entityId: string, attribute: string, value: unknown): Fact {
  return {
    id,
    entityId,
    attribute,
    value,
    validity: {
      temporal: { start: { type: 'absolute', value: 'day_0' }, end: null },
      branches: { type: 'all' },
    },
  };
}

function event(id: string, day: number, postconditions: Fact[] = []): NarrativeEvent {
  return {
    id,
    event: id,
    narrativeOrder: day,
    title: id,
    storyTime: { type: 'absolute', value: `day_${day}` },
    sceneType: 'linear',
    pov: { character: 'narrator', type: 'omniscient' },
    sceneBrief: id,
    preconditions: [],
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

describe('compileNarrativeGraphs', () => {
  it('compiles universal story and empty-action discourse graphs from the same selected events', () => {
    const events = [event('E1', 1, [fact('f1', 'hero', 'status', 'alive')]), event('E2', 2)];
    const ledger = compilePlannedDiscourseLedger({
      id: 'reader-order',
      chapters: [
        { branch: 'main', chapter: 1, sceneIds: ['E2'] },
        { branch: 'main', chapter: 2, sceneIds: ['E1'] },
      ],
      entries: [],
    });

    const graphs = compileNarrativeGraphs({
      events,
      initialFacts: [fact('initial-status', 'world', 'season', 'winter')],
      timeAnchors: new Map(),
      branchPath: { decisions: [] },
      discourseBranch: 'main',
      ledger,
      assertions: {},
    });

    expect(graphs.storyGraph.type).toBe('story');
    expect(graphs.storyGraph.outputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outputId: 'E1:postcondition:0',
          branchScope: 'Linear',
        }),
        expect.objectContaining({ branchScope: '' }),
      ]),
    );
    expect(graphs.discourseGraph.sceneSequence).toEqual([
      { sceneId: 'E2', sequence: 0, chapter: 1 },
      { sceneId: 'E1', sequence: 1, chapter: 2 },
    ]);
    expect(graphs.discourseGraph.outputs).toEqual([]);
    expect(graphs.storyAdjacency.get('E1')).toEqual([]);
    expect(graphs.storyAdjacency.get('E2')).toEqual([]);
  });

  it('projects only event-to-event replay edges', () => {
    const graph = compileNarrativeGraphs({
      events: [
        { ...event('E1', 1), causalPredecessors: [] },
        { ...event('E2', 2), causalPredecessors: ['E1'] },
      ],
      initialFacts: [],
      timeAnchors: new Map(),
      branchPath: { decisions: [] },
      discourseBranch: 'main',
      ledger: compilePlannedDiscourseLedger({
        id: 'reader-order',
        chapters: [{ branch: 'main', chapter: 1, sceneIds: ['E1', 'E2'] }],
        entries: [],
      }),
      assertions: {},
    });

    expect(storyGraphToEventAdjacency(graph.storyGraph, ['E1', 'E2']).get('E1')).toEqual(['E2']);
    expect(graph.storyAdjacency.get('E2')).toEqual([]);
  });
});
