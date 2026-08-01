// ============================================================================
// presence-aware-preconditions.test.ts — Preconditions with exists/not_exists
// operators, comparison operators on absent/null/present values, narrativeHint
// returning deferred from compareFact.
// ============================================================================

import { describe, expect, it } from 'vitest';
import { compareFact } from '../../src/entity/compare.js';
import { compileEntityTypeCatalog } from '../../src/entity/entity-catalog-compiler.js';
import { ConfigError, PreconditionMismatchError } from '../../src/errors.js';
import { preconditionSchema } from '../../src/schemas/primitives.js';
import { ReplayEngine } from '../../src/state/replay.js';
import type {
  EntityCatalogContext,
  EntityTypeCatalog,
  EntityTypeDefinitionSource,
  Fact,
  NarrativeEvent,
  WorldState,
} from '../../src/types/index.js';

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
    beats: ['Test scene'],
    branchExistence: { type: 'all' as const },
    preconditions: [],
    postconditions: [],
    threadProgress: [],
    relationshipEffects: [],
    ruleEffects: [],
    ...overrides,
  };
}

// ─── Synthetic catalog + activation (current contract) ────────────────────
// Explicit synthetic catalog compiled via compileEntityTypeCatalog — no
// default/optional catalog, no fallback. hero is initial-introduced and
// activated by baseline initial facts, so every replay below sees a live
// entity before the first authored write.

const CHARACTER_SOURCE: EntityTypeDefinitionSource = {
  typeId: 'character',
  kind: 'character',
  attributes: {
    lifecycle: {
      attributeId: 'lifecycle',
      valueType: 'string',
      requiredAt: 'never',
      writePolicy: 'lifecycle_managed',
      allowedLifecycleStates: ['active', 'inactive', 'retired'],
      unsetAllowed: false,
    },
    name: {
      attributeId: 'name',
      valueType: 'string',
      requiredAt: 'never',
      writePolicy: 'mutable',
      unsetAllowed: false,
    },
    status: {
      attributeId: 'status',
      valueType: 'string',
      requiredAt: 'never',
      writePolicy: 'mutable',
      unsetAllowed: false,
    },
    other: {
      attributeId: 'other',
      valueType: 'string',
      requiredAt: 'never',
      writePolicy: 'mutable',
      unsetAllowed: false,
    },
    secret: {
      attributeId: 'secret',
      valueType: 'string',
      requiredAt: 'never',
      writePolicy: 'mutable',
      unsetAllowed: false,
    },
    level: {
      attributeId: 'level',
      valueType: 'number',
      requiredAt: 'never',
      writePolicy: 'mutable',
      unsetAllowed: false,
    },
  },
  lifecyclePolicy: { allowedTransitions: [] },
  referenceCapabilities: { defaultEligibility: 'live' },
  typedInvariants: [],
};

const TYPE_CATALOG: EntityTypeCatalog = compileEntityTypeCatalog({
  types: { character: CHARACTER_SOURCE },
});

const CATALOG_CONTEXT: EntityCatalogContext = {
  entityDeclarationCatalog: {
    version: 1,
    declarations: {
      hero: {
        entityId: 'hero',
        typeRef: { typeId: 'character', schemaVersion: 1 },
        immutableMetadata: { name: 'Hero', definitionFile: 'hero.yaml' },
        introduction: { type: 'initial' },
      },
    },
  },
  entityTypeCatalog: TYPE_CATALOG,
};

/** Baseline activation: hero is live from day_0 with lifecycle 'active'. */
const ACTIVATION_FACTS: Fact[] = [
  {
    id: 'hero.activation',
    entityId: 'hero',
    attribute: 'lifecycle',
    value: 'active',
    confidence: 1,
    validity: {
      temporal: { start: { type: 'absolute', value: 'day_0' }, end: null },
      branches: { type: 'all' },
    },
  },
];

function replay(events: NarrativeEvent[]): WorldState {
  return new ReplayEngine(CATALOG_CONTEXT).replay(events, { initialFacts: ACTIVATION_FACTS });
}

// ─── Schema-level tests ────────────────────────────────────────────────────

const base = { entity: 'hero', attribute: 'status' };

describe('Precondition schema: exists/not_exists', () => {
  it('accepts exists without value', () => {
    const result = preconditionSchema.safeParse({ ...base, operator: 'exists' });
    expect(result.success).toBe(true);
  });

  it('accepts not_exists without value', () => {
    const result = preconditionSchema.safeParse({ ...base, operator: 'not_exists' });
    expect(result.success).toBe(true);
  });

  it('rejects exists with value', () => {
    const result = preconditionSchema.safeParse({ ...base, value: 'alive', operator: 'exists' });
    expect(result.success).toBe(false);
  });

  it('rejects not_exists with value', () => {
    const result = preconditionSchema.safeParse({
      ...base,
      value: 'alive',
      operator: 'not_exists',
    });
    expect(result.success).toBe(false);
  });
});

describe('Precondition schema: comparison operators', () => {
  it('accepts eq with value', () => {
    expect(preconditionSchema.safeParse({ ...base, value: 'alive', operator: 'eq' }).success).toBe(
      true,
    );
  });

  it('accepts neq with value', () => {
    expect(preconditionSchema.safeParse({ ...base, value: 'alive', operator: 'neq' }).success).toBe(
      true,
    );
  });

  it('accepts gt/gte/lt/lte with numeric value', () => {
    expect(
      preconditionSchema.safeParse({ entity: 'hero', attribute: 'level', value: 5, operator: 'gt' })
        .success,
    ).toBe(true);
    expect(
      preconditionSchema.safeParse({
        entity: 'hero',
        attribute: 'level',
        value: 5,
        operator: 'gte',
      }).success,
    ).toBe(true);
    expect(
      preconditionSchema.safeParse({ entity: 'hero', attribute: 'level', value: 5, operator: 'lt' })
        .success,
    ).toBe(true);
    expect(
      preconditionSchema.safeParse({
        entity: 'hero',
        attribute: 'level',
        value: 5,
        operator: 'lte',
      }).success,
    ).toBe(true);
  });

  it('accepts contains/not_contains with value', () => {
    expect(
      preconditionSchema.safeParse({ ...base, value: 'ali', operator: 'contains' }).success,
    ).toBe(true);
    expect(
      preconditionSchema.safeParse({ ...base, value: 'xyz', operator: 'not_contains' }).success,
    ).toBe(true);
  });

  it('rejects operator requiring value when value is missing', () => {
    expect(preconditionSchema.safeParse({ ...base, operator: 'neq' }).success).toBe(false);
    expect(preconditionSchema.safeParse({ ...base, operator: 'gt' }).success).toBe(false);
    expect(preconditionSchema.safeParse({ ...base, operator: 'contains' }).success).toBe(false);
  });

  it('allows narrativeHint-only precondition (deferred)', () => {
    expect(preconditionSchema.safeParse({ ...base, narrativeHint: 'status check' }).success).toBe(
      true,
    );
  });
});

// ─── Replay-level precondition evaluation ──────────────────────────────────

describe('Replay precondition evaluation', () => {
  it('exists precondition: passes when attribute is present', () => {
    const events: NarrativeEvent[] = [
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'status', value: 'alive' })],
      }),
      makeEvent(2, 2, {
        preconditions: [
          makeFact({
            entityId: 'hero',
            attribute: 'status',
            value: undefined,
            operator: 'exists',
          } as unknown as Partial<Fact> & { entityId: string; attribute: string }),
        ],
      }),
    ];
    const state = replay(events);
    expect(state.entities.hero?.status).toBe('alive');
  });

  it('exists precondition: throws when attribute is absent', () => {
    const events: NarrativeEvent[] = [
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'other', value: 'present' })],
      }),
      makeEvent(2, 2, {
        preconditions: [
          makeFact({
            entityId: 'hero',
            attribute: 'nonexistent',
            value: undefined,
            operator: 'exists',
          } as unknown as Partial<Fact> & { entityId: string; attribute: string }),
        ],
      }),
    ];
    expect(() => replay(events)).toThrow(PreconditionMismatchError);
  });

  it('not_exists precondition: passes when attribute is absent', () => {
    const events: NarrativeEvent[] = [
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'other', value: 'present' })],
      }),
      makeEvent(2, 2, {
        preconditions: [
          makeFact({
            entityId: 'hero',
            attribute: 'secret',
            value: undefined,
            operator: 'not_exists',
          } as unknown as Partial<Fact> & { entityId: string; attribute: string }),
        ],
      }),
    ];
    expect(() => replay(events)).not.toThrow();
  });

  it('not_exists precondition: fails at compile time when attribute is present', () => {
    const events: NarrativeEvent[] = [
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'secret', value: 'hidden' })],
      }),
      makeEvent(2, 2, {
        preconditions: [
          makeFact({
            entityId: 'hero',
            attribute: 'secret',
            value: undefined,
            operator: 'not_exists',
          } as unknown as Partial<Fact> & { entityId: string; attribute: string }),
        ],
      }),
    ];
    // The graph compiler deterministically detects that a set provider
    // contradicts not_exists → compile-first ConfigError, not runtime error.
    expect(() => replay(events)).toThrow(ConfigError);
  });

  // Operator-based preconditions: the graph compiler resolves the key via
  // provider visibility without asserting exact value equality for non-eq
  // operators. The tests set a value in an earlier event, then check it with
  // the operator — runtime enforcement is delegated to applyNarrativeEvent.
  it('eq precondition: matches present value', () => {
    const events: NarrativeEvent[] = [
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'level', value: 5 })],
      }),
      makeEvent(2, 2, {
        preconditions: [
          makeFact({ entityId: 'hero', attribute: 'level', value: 5, operator: 'eq' }),
        ],
      }),
    ];
    expect(() => replay(events)).not.toThrow();
  });

  it('neq precondition: passes when current state is different from precondition value', () => {
    const events: NarrativeEvent[] = [
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'level', value: 5 })],
      }),
      makeEvent(2, 2, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'level', value: 10 })],
      }),
      makeEvent(3, 3, {
        preconditions: [
          makeFact({ entityId: 'hero', attribute: 'level', value: 5, operator: 'neq' }),
        ],
      }),
    ];
    expect(() => replay(events)).not.toThrow();
  });

  it('neq precondition: throws when current state equals precondition value', () => {
    const events: NarrativeEvent[] = [
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'level', value: 5 })],
      }),
      makeEvent(2, 2, {
        preconditions: [
          makeFact({ entityId: 'hero', attribute: 'level', value: 5, operator: 'neq' }),
        ],
      }),
    ];
    expect(() => replay(events)).toThrow(PreconditionMismatchError);
  });

  it('gt precondition: checks numeric ordering', () => {
    const events: NarrativeEvent[] = [
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'level', value: 5 })],
      }),
      makeEvent(2, 2, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'level', value: 10 })],
      }),
      makeEvent(3, 3, {
        preconditions: [
          makeFact({ entityId: 'hero', attribute: 'level', value: 5, operator: 'gt' }),
        ],
      }),
    ];
    expect(() => replay(events)).not.toThrow();
  });

  it('contains precondition: checks substring', () => {
    const events: NarrativeEvent[] = [
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'name', value: 'xand' })],
      }),
      makeEvent(2, 2, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'name', value: 'Alexander' })],
      }),
      makeEvent(3, 3, {
        preconditions: [
          makeFact({ entityId: 'hero', attribute: 'name', value: 'xand', operator: 'contains' }),
        ],
      }),
    ];
    expect(() => replay(events)).not.toThrow();
  });
});

// ─── compareFact: narrativeHint → deferred ─────────────────────────────────

describe('compareFact returns deferred for narrativeHint-only', () => {
  it('returns deferred when fact has only narrativeHint', () => {
    const fact = makeFact({
      entityId: 'hero',
      attribute: 'status',
      value: undefined,
      narrativeHint: 'Hero is alive',
    });
    const outcome = compareFact(fact, undefined);
    expect(outcome).toBe('deferred');
  });

  it('returns match for value facts', () => {
    const fact = makeFact({ entityId: 'hero', attribute: 'status', value: 'alive' });
    expect(compareFact(fact, 'alive')).toBe('match');
    expect(compareFact(fact, 'dead')).toBe('mismatch');
  });
});
