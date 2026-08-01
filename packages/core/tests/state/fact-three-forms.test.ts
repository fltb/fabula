// ============================================================================
// fact-three-forms.test.ts — Three forms of postcondition facts:
// set (value + optional 'set'), unset (operation unset + no value/narrativeHint),
// narrativeHint-only. Schema validation + replay-level duplicate detection.
//
// The replay-level case supplies an explicit synthetic catalog context: hero
// is declared 'character', event-introduced by E_1, and the fixture includes
// the canonical system:introduction transition that activates it (day_0)
// before the authored duplicate write (day_1).
// ============================================================================

import { describe, expect, it } from 'vitest';
import { compileEntityTypeCatalog } from '../../src/entity/entity-catalog-compiler.js';
import { ConfigError } from '../../src/errors.js';
import { postconditionSchema } from '../../src/schemas/primitives.js';
import { ReplayEngine } from '../../src/state/replay.js';
import type {
  EntityCatalogContext,
  EntityTypeCatalog,
  EntityTypeCatalogSource,
  EntityTypeDefinitionSource,
  Fact,
  NarrativeEvent,
} from '../../src/types/index.js';

// ─── Synthetic catalog (explicit; no default catalog) ───────────────────────

const CHARACTER_SOURCE: EntityTypeDefinitionSource = {
  typeId: 'character',
  kind: 'character',
  attributes: {
    name: {
      attributeId: 'name',
      valueType: 'string',
      requiredAt: 'never',
      writePolicy: 'immutable',
      unsetAllowed: false,
    },
    health: {
      attributeId: 'health',
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

const SYNTHETIC_SOURCE: EntityTypeCatalogSource = {
  types: { character: CHARACTER_SOURCE },
};

const TYPE_CATALOG: EntityTypeCatalog = compileEntityTypeCatalog(SYNTHETIC_SOURCE);

function makeCatalogContext(): EntityCatalogContext {
  return {
    entityDeclarationCatalog: {
      declarations: {
        hero: {
          entityId: 'hero',
          typeRef: { typeId: 'character', schemaVersion: 1 },
          immutableMetadata: { name: 'Hero', definitionFile: 'hero.yaml' },
          introduction: { type: 'event', eventId: 'E_1' },
        },
      },
      version: 1,
    },
    entityTypeCatalog: TYPE_CATALOG,
  };
}

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
    kind: 'event',
    id: `E_${narrativeOrder}`,
    event: `E_${narrativeOrder}`,
    narrativeOrder,
    title: 'Test',
    storyTime: { type: 'absolute' as const, value: 'day_1' },
    sceneType: 'linear',
    pov: { character: 'narrator' as const, type: 'first_person' as const },
    sceneBrief: 'Test scene',
    beats: ['Test scene'],
    branchExistence: { type: 'all' as const },
    preconditions: [],
    postconditions: [],
    threadProgress: [],
    foreshadowing: [],
    relationshipEffects: [],
    ruleEffects: [],
    source: 'event_file',
    participants: { entities: [] },
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
    const engine = new ReplayEngine(makeCatalogContext());
    const activation = makeEvent(0.5, {
      id: 'system:introduction:E_1:hero',
      event: 'system:introduction:E_1:hero',
      storyTime: { type: 'absolute' as const, value: 'day_0' },
      source: 'system',
      participants: { entities: ['hero'] },
      postconditions: [makeFact({ entityId: 'hero', attribute: 'name', value: 'Hero' })],
    });
    const events: NarrativeEvent[] = [
      activation,
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
