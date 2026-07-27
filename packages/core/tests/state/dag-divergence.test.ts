// ============================================================================
// dag-divergence.test.ts — Proves getStateAtOptimized diverges from replay()
// when causal order != narrativeOrder.
//
// Fixture:
//   Event B: narrativeOrder=1, storyTime=day_9  → writes hero.status="first"
//   Event A: narrativeOrder=2, storyTime=day_1  → writes hero.status="second"
//   Event C: narrativeOrder=3, storyTime=day_5  → writes hero.location="end"
//
// Causal order (storyTime):   A(day_1) → C(day_5) → B(day_9)
// Narrative order:            B(1) → A(2) → C(3)
//
// replay() sorts ALL events without storyTime anchors → localeCompare tiebreaker:
//   alphabetical order A → B → C. B writes "first" last → status="first".
//
// getStateAtOptimized() uses storyTime-day anchors for tiebreaking on
// post-snapshot events only:
//   snapshot at B (narrativeOrder=1) captures status="first".
//   Post-snapshot [A(day_1), C(day_5)] sorted by day: A then C.
//   A writes "second" → overwrites snapshot's "first" → status="second".
//
// Result: replay says "first", optimized says "second" — PROVEN DIVERGENCE.
// ============================================================================

import { describe, expect, it } from 'vitest';
import { ReplayEngine } from '../../src/state/replay.ts';
import type { Fact, NarrativeEvent, Snapshot } from '../../src/types/index.ts';

// ─── Helpers ────────────────────────────────────────────────────────────────

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

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('DAG divergence: snapshot-based optimization vs full replay', () => {
  it('replay() produces causally-correct state (B is latest at day_9)', () => {
    const engine = new ReplayEngine();
    // B is causally latest (day_9) and writes last in alphabetical sort → status="first"
    const B = event('B', 9, 1, [], [fact('hero', 'status', 'first')]);
    const A = event('A', 1, 2, [], [fact('hero', 'status', 'second')]);
    const C = event('C', 5, 3, [], [fact('hero', 'location', 'end')]);

    const state = engine.replay([B, A, C]);
    // B (day_9) is causally latest → status="first" overrides A's "second"
    expect(state.entities['hero']?.['status']).toBe('first');
    expect(state.entities['hero']?.['location']).toBe('end');
  });

  it('getStateAt with position produces consistent state', () => {
    // After DAG-5b: getStateAtOptimized is deleted, getStateAt uses
    // DAG-position-based filtering. This test verifies the unified path.
    const engine = new ReplayEngine();
    const B = event('B', 9, 1, [], [fact('hero', 'status', 'first')]);
    const A = event('A', 1, 2, [], [fact('hero', 'status', 'second')]);
    const C = event('C', 5, 3, [], [fact('hero', 'location', 'end')]);

    // Causal order: A(1) → C(5) → B(9)
    // Position 0 = empty, 1 = after A, 2 = after A+C, 3 = after A+C+B
    const state0 = engine.getStateAt([B, A, C], 0);
    expect(state0.entities).toEqual({});

    const state3 = engine.getStateAt([B, A, C], 3);
    expect(state3.entities['hero']?.['status']).toBe('first');
    expect(state3.entities['hero']?.['location']).toBe('end');

    // getStateAt matches replay() for full position
    const fullReplay = engine.replay([B, A, C]);
    expect(state3.entities['hero']?.['status']).toBe(fullReplay.entities['hero']?.['status']);
  });
});
