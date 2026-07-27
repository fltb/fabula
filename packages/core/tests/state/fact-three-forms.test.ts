// ============================================================================
// fact-three-forms.test.ts — Three forms of postcondition facts:
// set (value + optional 'set'), unset (operation unset + no value/narrativeHint),
// narrativeHint-only. Schema validation + replay-level duplicate detection.
// ============================================================================

import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/errors.js';
import { postconditionSchema } from '../../src/schemas/primitives.js';
import { ReplayEngine } from '../../src/state/replay.js';
import type { Fact, NarrativeEvent, WorldState } from '../../src/types/index.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

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
  overrides: Partial<NarrativeEvent> = {},
): NarrativeEvent {
  return {
    id: `E_${narrativeOrder}`,
    narrativeOrder,
    title: 'Test',
    storyTime: { type: 'absolute' as const, value: 'day_1' },
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

const base = { entity: 'hero', attribute: 'status' };

// ─── Schema-level tests ────────────────────────────────────────────────────

describe('Postcondition three-form schema validation', () => {
  // Form 1: set (value present, operation omitted or 'set')
  it('accepts value + omitted operation (default set)', () => {
    expect(postconditionSchema.safeParse({ ...base, value: 'alive' }).success).toBe(true);
  });

  it('accepts value + explicit set operation', () => {
    expect(
      postconditionSchema.safeParse({ ...base, value: 'alive', operation: 'set' }).success,
    ).toBe(true);
  });

  // Form 2: unset (no value, no narrativeHint, operation: 'unset')
  it('accepts unset operation without value or narrativeHint', () => {
    expect(postconditionSchema.safeParse({ ...base, operation: 'unset' }).success).toBe(true);
  });

  // Form 3: narrativeHint only
  it('accepts narrativeHint only', () => {
    expect(postconditionSchema.safeParse({ ...base, narrativeHint: 'Hero is alive' }).success).toBe(
      true,
    );
  });

  // Rejections
  it('rejects unset with value', () => {
    const result = postconditionSchema.safeParse({ ...base, value: 'alive', operation: 'unset' });
    expect(result.success).toBe(false);
  });

  it('rejects unset with narrativeHint', () => {
    const result = postconditionSchema.safeParse({
      ...base,
      narrativeHint: 'alive',
      operation: 'unset',
    });
    expect(result.success).toBe(false);
  });

  it('rejects value + narrativeHint together', () => {
    const result = postconditionSchema.safeParse({
      ...base,
      value: 'alive',
      narrativeHint: 'alive',
    });
    expect(result.success).toBe(false);
  });

  it('rejects no value, no narrativeHint, no operation', () => {
    const result = postconditionSchema.safeParse({ ...base });
    expect(result.success).toBe(false);
  });
});

// ─── Replay-level duplicate detection ──────────────────────────────────────

describe('Replay-level duplicate write detection', () => {
  it('throws ConfigError on duplicate write to same entityId+attribute in one event', () => {
    const engine = new ReplayEngine();
    const events: NarrativeEvent[] = [
      makeEvent(1, {
        postconditions: [
          makeFact({ entityId: 'hero', attribute: 'health', value: 100 }),
          makeFact({ entityId: 'hero', attribute: 'health', value: 50 }),
        ],
      }),
    ];
    expect(() => engine.replay(events)).toThrow(ConfigError);
  });
});
