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
    kind: 'event',
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
      initialThreads: [],
      timeAnchors: [],
      branchPath: { decisions: [] },
      discourseBranch: 'main',
      ledger,
      assertions: {},
    });

    expect(graphs.storyGraph.type).toBe('story');
    expect(graphs.storyGraph.outputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outputId: 'E1:fact:0',
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
    // Two distinct comparable story point buckets generate an internal temporal edge.
    expect(graphs.storyAdjacency.get('E1')).toEqual(['E2']);
    expect(graphs.storyAdjacency.get('E2')).toEqual([]);
    expect(graphs.techniquesByEventId).toBeInstanceOf(Map);
    expect(graphs.techniquesByEventId.size).toBe(0);
  });

  it('projects only event-to-event replay edges', () => {
    const graph = compileNarrativeGraphs({
      events: [
        { ...event('E1', 1), causalPredecessors: [] },
        { ...event('E2', 2), causalPredecessors: ['E1'] },
      ],
      initialFacts: [],
      initialThreads: [],
      timeAnchors: [],
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

  it('resolves surfaceMode technique contract for an event', () => {
    const events = [
      {
        ...event('E1', 1),
        surfaceMode: {
          instruction: 'Write in simple, declarative sentences',
          requiredEvidence: 'Prose uses short clauses',
        },
      },
      event('E2', 2),
    ];

    const ledger = compilePlannedDiscourseLedger({
      id: 'reader-order',
      chapters: [{ branch: 'main', chapter: 1, sceneIds: ['E1', 'E2'] }],
      entries: [],
    });

    const graphs = compileNarrativeGraphs({
      events,
      initialFacts: [],
      initialThreads: [],
      timeAnchors: [],
      branchPath: { decisions: [] },
      discourseBranch: 'main',
      ledger,
      assertions: {},
    });

    const e1Contracts = graphs.techniquesByEventId.get('E1');
    expect(e1Contracts).toHaveLength(1);
    expect(e1Contracts![0].kind).toBe('surfaceMode');
    expect(e1Contracts![0].instruction).toBe('Write in simple, declarative sentences');
    expect(e1Contracts![0].requiredEvidence).toBe('Prose uses short clauses');
    expect(graphs.techniquesByEventId.has('E2')).toBe(false);
  });

  it('permits absence when read predicate is absent (not_exists operator)', () => {
    const events = [
      {
        ...event('E1', 1),
        preconditions: [
          {
            id: 'p1',
            entityId: 'hero',
            attribute: 'status',
            value: undefined,
            operator: 'not_exists' as const,
            validity: {
              temporal: { start: { type: 'absolute', value: 'day_0' }, end: null },
              branches: { type: 'all' },
            },
          },
        ],
      },
    ];

    const ledger = compilePlannedDiscourseLedger({
      id: 'reader-order',
      chapters: [{ branch: 'main', chapter: 1, sceneIds: ['E1'] }],
      entries: [],
    });

    const graphs = compileNarrativeGraphs({
      events,
      initialFacts: [],
      initialThreads: [],
      timeAnchors: [],
      branchPath: { decisions: [] },
      discourseBranch: 'main',
      ledger,
      assertions: {},
    });

    // Closure must not throw: absent predicate absence is legal
    expect(graphs.storyGraph.resolutions.some((r) => r.type === 'absence')).toBe(true);
    expect(graphs.techniquesByEventId.size).toBe(0);
  });

  it('throws ConfigError for unclaimed exists predicate absence', () => {
    const events = [
      {
        ...event('E1', 1),
        preconditions: [
          {
            id: 'p1',
            entityId: 'hero',
            attribute: 'status',
            value: undefined,
            operator: 'exists' as const,
            validity: {
              temporal: { start: { type: 'absolute', value: 'day_0' }, end: null },
              branches: { type: 'all' },
            },
          },
        ],
      },
    ];

    const ledger = compilePlannedDiscourseLedger({
      id: 'reader-order',
      chapters: [{ branch: 'main', chapter: 1, sceneIds: ['E1'] }],
      entries: [],
    });

    expect(() =>
      compileNarrativeGraphs({
        events,
        initialFacts: [],
        initialThreads: [],
        timeAnchors: [],
        branchPath: { decisions: [] },
        discourseBranch: 'main',
        ledger,
        assertions: {},
      }),
    ).toThrow('Deterministic read');
  });

  it('permits absence when claimed by valid absentApparatus of the same event', () => {
    const events = [
      {
        ...event('E1', 1),
        preconditions: [
          {
            id: 'p1',
            entityId: 'hero',
            attribute: 'status',
            value: undefined,
            operator: 'exists' as const,
            validity: {
              temporal: { start: { type: 'absolute', value: 'day_0' }, end: null },
              branches: { type: 'all' },
            },
          },
        ],
        absentApparatus: {
          readId: 'E1:precondition:0',
          instruction: 'Treat the absence of hero.status as intentional narrative design',
          requiredEvidence: 'No graph provider exists for hero.status',
        },
      },
    ];

    const ledger = compilePlannedDiscourseLedger({
      id: 'reader-order',
      chapters: [{ branch: 'main', chapter: 1, sceneIds: ['E1'] }],
      entries: [],
    });

    const graphs = compileNarrativeGraphs({
      events,
      initialFacts: [],
      initialThreads: [],
      timeAnchors: [],
      branchPath: { decisions: [] },
      discourseBranch: 'main',
      ledger,
      assertions: {},
    });

    const e1Contracts = graphs.techniquesByEventId.get('E1');
    expect(e1Contracts).toBeDefined();
    expect(e1Contracts!.some((c) => c.kind === 'absentApparatus')).toBe(true);
  });

  it('throws ConfigError for cross-event absentApparatus readId at closure', () => {
    // E1 claims E2's precondition absence. The resolver passes because
    // E2:precondition:0 IS a valid GraphAbsenceWitness (E2 has an exists read
    // for hero.status that no one writes). The closure catches the
    // cross-event ownership violation.
    const events = [
      {
        ...event('E1', 1),
        absentApparatus: {
          readId: 'E2:precondition:0', // does not start with E1:precondition:
          instruction: 'Cross-event claim',
          requiredEvidence: 'Must be own precondition',
        },
      },
      {
        ...event('E2', 2),
        preconditions: [
          {
            id: 'p1',
            entityId: 'hero',
            attribute: 'status',
            value: undefined,
            operator: 'exists' as const,
            validity: {
              temporal: { start: { type: 'absolute', value: 'day_0' }, end: null },
              branches: { type: 'all' },
            },
          },
        ],
      },
    ];

    const ledger = compilePlannedDiscourseLedger({
      id: 'reader-order',
      chapters: [{ branch: 'main', chapter: 1, sceneIds: ['E1', 'E2'] }],
      entries: [],
    });

    expect(() =>
      compileNarrativeGraphs({
        events,
        initialFacts: [],
        initialThreads: [],
        timeAnchors: [],
        branchPath: { decisions: [] },
        discourseBranch: 'main',
        ledger,
        assertions: {},
      }),
    ).toThrow('must be an owning event precondition');
  });
});
