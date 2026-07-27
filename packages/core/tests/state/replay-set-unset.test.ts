// ============================================================================
// replay-set-unset.test.ts — ReplayEngine set/unset semantics, hard errors,
// precondition validation before effects.
// ============================================================================

import { describe, expect, it } from 'vitest';
import { ConfigError, PreconditionMismatchError } from '../../src/errors.js';
import { ReplayEngine } from '../../src/state/replay.js';
import type { Fact, NarrativeEvent } from '../../src/types/index.js';

// ─── Helpers ────────────────────────────────────────────────────────────────
// Each event gets storyTime day_N so DAG builder can order and find providers.

let counter = 0;
function makeFact(overrides: Partial<Fact> & { entityId: string; attribute: string }): Fact {
  return {
    id: `fact_${++counter}`,
    value: 'default',
    confidence: 1,
    validity: {
      temporal: { start: { type: 'absolute', value: 'day_1' }, end: null },
      branches: { type: 'all' },
    },
    ...overrides,
  };
}

function makeEvent(
  narrativeOrder: number,
  daySuffix: number | string,
  overrides: Partial<NarrativeEvent> = {},
): NarrativeEvent {
  return {
    id: `E_${narrativeOrder}`,
    narrativeOrder,
    title: 'Test',
    storyTime: { type: 'absolute' as const, value: `day_${daySuffix}` },
    pov: { character: 'narrator' as const, type: 'first_person' as const },
    sceneBrief: 'Test scene',
    branchExistence: { type: 'all' as const },
    preconditions: [],
    postconditions: [],
    threadProgress: [],
    relationshipEffects: [],
    ruleEffects: [],
    ...overrides,
  };
}

// ─── Core set/unset semantics ──────────────────────────────────────────────

describe('ReplayEngine set/unset semantics', () => {
  it('set writes value to entity state', () => {
    const engine = new ReplayEngine();
    const events: NarrativeEvent[] = [
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'status', value: 'alive' })],
      }),
    ];
    const state = engine.replay(events);
    expect(state.entities.hero?.status).toBe('alive');
  });

  it('overwrite replaces existing value', () => {
    const engine = new ReplayEngine();
    const events: NarrativeEvent[] = [
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'status', value: 'alive' })],
      }),
      makeEvent(2, 2, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'status', value: 'dead' })],
      }),
    ];
    const state = engine.replay(events);
    expect(state.entities.hero?.status).toBe('dead');
  });

  it('unset removes attribute from entity state', () => {
    const engine = new ReplayEngine();
    const events: NarrativeEvent[] = [
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'status', value: 'alive' })],
      }),
      makeEvent(2, 2, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'status', operation: 'unset' })],
      }),
    ];
    const state = engine.replay(events);
    expect(state.entities.hero?.status).toBeUndefined();
  });

  it('re-set after unset restores value', () => {
    const engine = new ReplayEngine();
    const events: NarrativeEvent[] = [
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'status', value: 'alive' })],
      }),
      makeEvent(2, 2, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'status', operation: 'unset' })],
      }),
      makeEvent(3, 3, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'status', value: 'revived' })],
      }),
    ];
    const state = engine.replay(events);
    expect(state.entities.hero?.status).toBe('revived');
  });

  it('last writer wins for same attribute across events', () => {
    const engine = new ReplayEngine();
    const events: NarrativeEvent[] = [
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'color', value: 'red' })],
      }),
      makeEvent(2, 2, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'color', value: 'blue' })],
      }),
      makeEvent(3, 3, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'color', value: 'red' })],
      }),
    ];
    const state = engine.replay(events);
    expect(state.entities.hero?.color).toBe('red');
  });
});

// ─── Hard errors ──────────────────────────────────────────────────────────

describe('ReplayEngine hard errors', () => {
  it('throws ConfigError on unset of absent attribute', () => {
    const engine = new ReplayEngine();
    const events: NarrativeEvent[] = [
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'status', operation: 'unset' })],
      }),
    ];
    expect(() => engine.replay(events)).toThrow(ConfigError);
  });

  it('throws ConfigError on duplicate write to same entityId+attribute in one event', () => {
    const engine = new ReplayEngine();
    const events: NarrativeEvent[] = [
      makeEvent(1, 1, {
        postconditions: [
          makeFact({ entityId: 'hero', attribute: 'level', value: 10 }),
          makeFact({ entityId: 'hero', attribute: 'level', value: 20 }),
        ],
      }),
    ];
    expect(() => engine.replay(events)).toThrow(ConfigError);
  });

  it('throws PreconditionMismatchError when precondition value does not match current state', () => {
    const engine = new ReplayEngine();
    const events: NarrativeEvent[] = [
      // DAG provider: set magic=200
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'magic', value: 200 })],
      }),
      // Overwrite: magic is now 100
      makeEvent(2, 2, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'magic', value: 100 })],
      }),
      // Precondition expects 200 but state is 100 → mismatch
      makeEvent(3, 3, {
        preconditions: [makeFact({ entityId: 'hero', attribute: 'magic', value: 200 })],
      }),
    ];
    expect(() => engine.replay(events)).toThrow(PreconditionMismatchError);
  });

  it('throws PreconditionMismatchError when precondition value mismatches (after overwrite)', () => {
    const engine = new ReplayEngine();
    const events: NarrativeEvent[] = [
      // DAG provider: set status='dead'
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'status', value: 'dead' })],
      }),
      // Overwrite: status is now 'alive'
      makeEvent(2, 2, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'status', value: 'alive' })],
      }),
      // Precondition expects 'dead' but state is 'alive' → mismatch
      makeEvent(3, 3, {
        preconditions: [makeFact({ entityId: 'hero', attribute: 'status', value: 'dead' })],
      }),
    ];
    expect(() => engine.replay(events)).toThrow(PreconditionMismatchError);
  });
});
