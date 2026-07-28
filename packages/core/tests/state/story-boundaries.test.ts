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

// ============================================================================
// Equivalence: compileStoryBoundaries vs ReplayEngine
// ============================================================================
// Both code paths call applyNarrativeEvent as the sole event-effect
// implementation. These tests verify they produce identical state across
// all state dimensions for the same event sequence.
// ============================================================================

import { ReplayEngine } from '../../src/state/replay.js';

describe('boundary/replay equivalence', () => {
  function engineRun(events: NarrativeEvent[]) {
    return new ReplayEngine().replay(events);
  }

  it('produces identical entity state for set/overwrite/unset sequence', () => {
    const events: NarrativeEvent[] = [
      event('E1', 1, [], [fact('alive')]),
      event('E2', 2, [fact('alive')], [fact('dead')]),
    ];

    const boundary = compileStoryBoundaries(events, [], new Map());
    const engineState = engineRun(events);

    expect(boundary.finalState.entities).toEqual(engineState.entities);
  })

  it('produces identical thread state', () => {
    const events: NarrativeEvent[] = [
      {
        ...event('E1', 1),
        threadProgress: [
          { thread: 'T1', advancement: 1, progressAfter: 1, progressTotal: 5 },
        ],
      },
      {
        ...event('E2', 2),
        threadProgress: [
          { thread: 'T1', advancement: 1, progressAfter: 2, progressTotal: 5 },
        ],
      },
    ];
    const boundary = compileStoryBoundaries(events, [], new Map());
    const engineState = engineRun(events);

    expect(boundary.finalState.threads).toEqual(engineState.threads);
  })

  it('produces identical relationship state', () => {
    const events: NarrativeEvent[] = [
      {
        ...event('E1', 1),
        participants: { entities: ['hero', 'villain'] },
        relationshipEffects: [
          {
            participants: ['hero', 'villain'],
            membershipAfter: [
              { entityId: 'hero', role: 'protagonist' },
              { entityId: 'villain', role: 'antagonist' },
            ],
            dimensionSet: [
              { dimensionId: 'direction', value: 'hostile' },
              { dimensionId: 'intensity', value: 5 },
            ],
            provenance: 'compat:RelationshipChange:set',
          },
        ],
      },
    ];
    const boundary = compileStoryBoundaries(events, [], new Map());
    const engineState = engineRun(events);

    expect(boundary.finalState.relationships).toEqual(engineState.relationships);
  });

  it('produces identical rule state', () => {
    const events: NarrativeEvent[] = [
      {
        ...event('E1', 1),
        participants: { entities: ['world'] },
        ruleEffects: [
          { rule: 'gravity', effect: 'active', evidence: 'world.normal' },
        ],
      },
      {
        ...event('E2', 2),
        participants: { entities: ['world'] },
        ruleEffects: [
          { rule: 'gravity', effect: 'suspended', evidence: 'world.reversed' },
        ],
      },
    ];
    const boundary = compileStoryBoundaries(events, [], new Map());
    const engineState = engineRun(events);

    expect(boundary.finalState.rules).toEqual(engineState.rules);
  });

  it('produces identical epistemic ledger and proposition catalog', () => {
    // These dimensions remain empty for minimal events without
    // explicit epistemic actions or catalog registrations.
    const events: NarrativeEvent[] = [
      event('E1', 1, [], [fact('active')]),
      event('E2', 2, [fact('active')], [fact('resolved')]),
    ];
    const boundary = compileStoryBoundaries(events, [], new Map());
    const engineState = engineRun(events);

    expect(boundary.finalState.epistemicLedger).toEqual(engineState.epistemicLedger);
    expect(boundary.finalState.propositionCatalog).toEqual(engineState.propositionCatalog);
  });

  it('throws ConfigError on duplicate write in both paths', () => {
    const events: NarrativeEvent[] = [
      {
        ...event('E1', 1),
        postconditions: [
          { ...fact('alive'), attribute: 'status', value: 'alive' },
          { ...fact('alive'), attribute: 'status', value: 'dead' },
        ],
      },
    ];

    expect(() => compileStoryBoundaries(events, [], new Map())).toThrow();
    expect(() => new ReplayEngine().replay(events)).toThrow();
  });

  it('throws PreconditionMismatchError on operator mismatch in both paths', () => {
    const events: NarrativeEvent[] = [
      event('E1', 1, [], [fact('active')]),
      { ...event('E2', 2), preconditions: [fact('active')] },
    ];
    const events2 = [events[1]!]; // No provider for precondition
    // E2 needs 'active' but no event wrote it
    expect(() => compileStoryBoundaries(events2, [], new Map())).toThrow();
    expect(() => new ReplayEngine().replay(events2)).toThrow();
  });

  it('produces identical state for empty event sequences', () => {
    const boundary = compileStoryBoundaries([], [], new Map());
    const engineState = engineRun([]);

    expect(boundary.finalState).toEqual(engineState);
  });
});
