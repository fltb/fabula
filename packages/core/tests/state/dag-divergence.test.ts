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
import type { Fact, NarrativeEvent, Snapshot } from '../../src/types/index.ts';
import { ReplayEngine } from '../../src/state/replay.ts';

// ─── Helpers ────────────────────────────────────────────────────────────────

function fact(entityId: string, attribute: string, value: unknown): Fact {
  return {
    id: `${entityId}.${attribute}`,
    entityId,
    attribute,
    value,
    validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
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

  it('snapshot at narrativeOrder=1 captures only B effects (status=first)', () => {
    const engine = new ReplayEngine();
    const B = event('B', 9, 1, [], [fact('hero', 'status', 'first')]);
    const A = event('A', 1, 2, [], [fact('hero', 'status', 'second')]);
    const C = event('C', 5, 3, [], [fact('hero', 'location', 'end')]);

    // Replay only B to get snapshot state
    const snapState = engine.replay([B]);
    expect(snapState.entities['hero']?.['status']).toBe('first');

    const snapshot: Snapshot = {
      narrativeOrder: 1,
      eventId: 'B',
      timestamp: '',
      state: snapState,
    };
    // getStateAtOptimized replays events with narrativeOrder > 1 && <= 3 = [A, C]
    // Sorted by storyTime day: A(1) then C(5).
    // A writes "second" — overwriting snapshot's "first"
    const optimized = engine.getStateAtOptimized([B, A, C], 3, snapshot);
    expect(optimized.entities['hero']?.['status']).toBe('second');
  });

  it('getStateAtOptimized diverges from replay() when causal != narrative order', () => {
    const engine = new ReplayEngine();
    const B = event('B', 9, 1, [], [fact('hero', 'status', 'first')]);
    const A = event('A', 1, 2, [], [fact('hero', 'status', 'second')]);
    const C = event('C', 5, 3, [], [fact('hero', 'location', 'end')]);

    const fullReplay = engine.replay([B, A, C]);
    const snapState = engine.replay([B]);
    const snapshot: Snapshot = { narrativeOrder: 1, eventId: 'B', timestamp: '', state: snapState };
    const optimized = engine.getStateAtOptimized([B, A, C], 3, snapshot);

    // Divergence: replay says "first" (B is causally latest), optimized says "second"
    // (A overwrites snapshot state's "first" since post-snapshot events sort by day)
    expect(fullReplay.entities['hero']?.['status']).not.toBe(
      optimized.entities['hero']?.['status'],
    );
    expect(fullReplay.entities['hero']?.['status']).toBe('first');
    expect(optimized.entities['hero']?.['status']).toBe('second');
  });
});
