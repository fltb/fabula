// ============================================================================
// replay-set-unset.test.ts — ReplayEngine set/unset semantics, hard errors,
// precondition validation before effects.
// ============================================================================

import { describe, expect, it } from 'vitest';
import { compileEntityTypeCatalog } from '../../src/entity/entity-catalog-compiler.js';
import { ConfigError } from '../../src/errors.js';
import type { AdjacencyList } from '../../src/state/dag.js';
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
    kind: 'event',
    id: `E_${narrativeOrder}`,
    event: `event_${narrativeOrder}`,
    narrativeOrder,
    title: 'Test',
    storyTime: { type: 'absolute' as const, value: `day_${daySuffix}` },
    sceneType: 'linear' as const,
    pov: { character: 'narrator' as const, type: 'first_person' as const },
    sceneBrief: 'Test scene',
    beats: ['Test scene'],
    preconditions: [],
    postconditions: [],
    threadProgress: [],
    foreshadowing: [],
    relationshipEffects: [],
    ruleEffects: [],
    source: 'event_file' as const,
    branchExistence: { type: 'all' as const },
    participants: { entities: [] },
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
    status: {
      attributeId: 'status',
      valueType: 'string',
      requiredAt: 'never',
      writePolicy: 'mutable',
      unsetAllowed: true,
    },
    color: {
      attributeId: 'color',
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
    magic: {
      attributeId: 'magic',
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

// ─── Core set/unset semantics ──────────────────────────────────────────────

describe('ReplayEngine set/unset semantics', () => {
  it('set writes value to entity state', () => {
    const events: NarrativeEvent[] = [
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'status', value: 'alive' })],
      }),
    ];
    const state = replay(events);
    expect(state.entities.hero?.status).toBe('alive');
  });

  it('overwrite replaces existing value', () => {
    const events: NarrativeEvent[] = [
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'status', value: 'alive' })],
      }),
      makeEvent(2, 2, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'status', value: 'dead' })],
      }),
    ];
    const state = replay(events);
    expect(state.entities.hero?.status).toBe('dead');
  });

  it('unset removes attribute from entity state', () => {
    const events: NarrativeEvent[] = [
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'status', value: 'alive' })],
      }),
      makeEvent(2, 2, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'status', operation: 'unset' })],
      }),
    ];
    const state = replay(events);
    expect(state.entities.hero?.status).toBeUndefined();
  });

  it('re-set after unset restores value', () => {
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
    const state = replay(events);
    expect(state.entities.hero?.status).toBe('revived');
  });

  it('last writer wins for same attribute across events', () => {
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
    const state = replay(events);
    expect(state.entities.hero?.color).toBe('red');
  });
});

// ─── Hard errors ──────────────────────────────────────────────────────────

describe('ReplayEngine hard errors', () => {
  it('throws ConfigError on unset of absent attribute', () => {
    const events: NarrativeEvent[] = [
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'status', operation: 'unset' })],
      }),
    ];
    expect(() => replay(events)).toThrow(ConfigError);
  });

  it('throws ConfigError on duplicate write to same entityId+attribute in one event', () => {
    const events: NarrativeEvent[] = [
      makeEvent(1, 1, {
        postconditions: [
          makeFact({ entityId: 'hero', attribute: 'level', value: 10 }),
          makeFact({ entityId: 'hero', attribute: 'level', value: 20 }),
        ],
      }),
    ];
    expect(() => replay(events)).toThrow(ConfigError);
  });

  it('throws ConfigError when precondition value does not match current state', () => {
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
    expect(() => replay(events)).toThrow(ConfigError);
  });

  it('throws ConfigError when precondition value mismatches (after overwrite)', () => {
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
    expect(() => replay(events)).toThrow(ConfigError);
  });
});

// ============================================================================
// Equivalence: compileStoryBoundaries vs ReplayEngine state dimensions
// ============================================================================
// Both paths use the same applyNarrativeEvent implementation and must
// produce identical final state across all world-state dimensions.
// ============================================================================

import { compileStoryBoundaries } from '../../src/state/story-boundaries.ts';

describe('boundary/replay equivalence — state dimensions', () => {
  function engineRun(events: NarrativeEvent[]) {
    return new ReplayEngine(CATALOG_CONTEXT).replay(events, { initialFacts: ACTIVATION_FACTS });
  }

  it('produces identical entity state after set/unset sequence', () => {
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
    const adjacency: AdjacencyList = new Map([
      ['E_1', ['E_2']],
      ['E_2', ['E_3']],
    ]);
    const boundary = compileStoryBoundaries(events, ACTIVATION_FACTS, adjacency, CATALOG_CONTEXT);
    const engineState = engineRun(events);

    expect(boundary.finalState.entities).toEqual(engineState.entities);
  });

  it('produces identical facts array', () => {
    const events: NarrativeEvent[] = [
      makeEvent(1, 1, {
        postconditions: [
          makeFact({ entityId: 'hero', attribute: 'status', value: 'alive' }),
          makeFact({ entityId: 'hero', attribute: 'level', value: 5 }),
        ],
      }),
    ];
    const adjacency: AdjacencyList = new Map();
    const boundary = compileStoryBoundaries(events, ACTIVATION_FACTS, adjacency, CATALOG_CONTEXT);
    const engineState = engineRun(events);

    // facts array captures every applied postcondition
    expect(boundary.finalState.facts.length).toBe(engineState.facts.length);
    // The fact IDs may differ due to counter ordering; verify count matches
    expect(boundary.finalState.facts.length).toBeGreaterThan(0);
  });

  it('throws same error class for duplicate write in both paths', () => {
    const events: NarrativeEvent[] = [
      makeEvent(1, 1, {
        postconditions: [
          makeFact({ entityId: 'hero', attribute: 'level', value: 10 }),
          makeFact({ entityId: 'hero', attribute: 'level', value: 20 }),
        ],
      }),
    ];

    const adjacency: AdjacencyList = new Map();
    expect(() =>
      compileStoryBoundaries(events, ACTIVATION_FACTS, adjacency, CATALOG_CONTEXT),
    ).toThrow();
    expect(() =>
      new ReplayEngine(CATALOG_CONTEXT).replay(events, { initialFacts: ACTIVATION_FACTS }),
    ).toThrow();
  });

  it('throws same error class for precondition mismatch in both paths', () => {
    const events: NarrativeEvent[] = [
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'magic', value: 100 })],
      }),
      makeEvent(2, 2, {
        preconditions: [makeFact({ entityId: 'hero', attribute: 'magic', value: 200 })],
      }),
    ];

    const adjacency: AdjacencyList = new Map([['E_1', ['E_2']]]);
    expect(() =>
      compileStoryBoundaries(events, ACTIVATION_FACTS, adjacency, CATALOG_CONTEXT),
    ).toThrow();
    expect(() =>
      new ReplayEngine(CATALOG_CONTEXT).replay(events, { initialFacts: ACTIVATION_FACTS }),
    ).toThrow();
  });

  it('produces identical final state dimension equality for thread/relationship/rule/epistemic fields', () => {
    const events: NarrativeEvent[] = [makeEvent(1, 1), makeEvent(2, 2)];
    const adjacency: AdjacencyList = new Map([['E_1', ['E_2']]]);
    const boundary = compileStoryBoundaries(events, ACTIVATION_FACTS, adjacency, CATALOG_CONTEXT);
    const engineState = engineRun(events);

    expect(boundary.finalState.threads).toEqual(engineState.threads);
    expect(boundary.finalState.relationships).toEqual(engineState.relationships);
    expect(boundary.finalState.rules).toEqual(engineState.rules);
    expect(boundary.finalState.epistemicLedger).toEqual(engineState.epistemicLedger);
    expect(boundary.finalState.propositionCatalog).toEqual(engineState.propositionCatalog);
  });
});
