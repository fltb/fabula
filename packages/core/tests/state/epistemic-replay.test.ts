// ============================================================================
// epistemic-replay.test.ts — EpistemicLedger initialized during replay,
// legacy knowledge shim removed, replay works without KnowledgeState types.
//
// Every replay supplies an explicit synthetic catalog context: hero/king are
// declared 'character' and event-introduced, and each test includes the
// canonical system:introduction transition that activates its participant
// (day_0) before the authored write (day_1+).
// ============================================================================

import { describe, expect, it } from 'vitest';
import { compileEntityTypeCatalog } from '../../src/entity/entity-catalog-compiler.js';
import { ReplayEngine } from '../../src/state/replay.js';
import type {
  EntityCatalogContext,
  EntityDeclarationCatalog,
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
    status: {
      attributeId: 'status',
      valueType: 'string',
      requiredAt: 'never',
      writePolicy: 'mutable',
      unsetAllowed: false,
    },
    knows: {
      attributeId: 'knows',
      valueType: 'string',
      requiredAt: 'never',
      writePolicy: 'mutable',
      unsetAllowed: false,
    },
    knowledge: {
      attributeId: 'knowledge',
      valueType: 'string',
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

/** Catalog context whose declarations match the test's introduction event id. */
function makeCatalogContext(introducedBy: string): EntityCatalogContext {
  const declarations: EntityDeclarationCatalog = {
    declarations: {
      hero: {
        entityId: 'hero',
        typeRef: { typeId: 'character', schemaVersion: 1 },
        immutableMetadata: { name: 'Hero', definitionFile: 'hero.yaml' },
        introduction: { type: 'event', eventId: introducedBy },
      },
      king: {
        entityId: 'king',
        typeRef: { typeId: 'character', schemaVersion: 1 },
        immutableMetadata: { name: 'King', definitionFile: 'king.yaml' },
        introduction: { type: 'event', eventId: introducedBy },
      },
    },
    version: 1,
  };
  return { entityDeclarationCatalog: declarations, entityTypeCatalog: TYPE_CATALOG };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

let counter = 0;
function makeFact(overrides: Partial<Fact> & { entityId: string; attribute: string }): Fact {
  return {
    id: `fact_${++counter}`,
    value: 'default',
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
    id: `E_${narrativeOrder}_${daySuffix}`,
    event: `E_${narrativeOrder}_${daySuffix}`,
    narrativeOrder,
    title: 'Test Event',
    storyTime: { type: 'absolute', value: `day_${daySuffix}` },
    sceneType: 'linear',
    pov: { character: 'narrator', type: 'first_person' },
    sceneBrief: 'Test scene',
    beats: ['Test scene'],
    branchExistence: { type: 'all' },
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

/** Canonical introduction transition: activates the entity at day_0. */
function introductionTransition(
  entityId: string,
  targetEventId: string,
  initialState: Record<string, unknown>,
): NarrativeEvent {
  const id = `system:introduction:${targetEventId}:${entityId}`;
  return makeEvent(1.5, 0, {
    id,
    event: id,
    storyTime: { type: 'absolute', value: 'day_0' },
    source: 'system',
    participants: { entities: [entityId] },
    postconditions: Object.entries(initialState).map(([attribute, value]) =>
      makeFact({ entityId, attribute, value }),
    ),
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('EpistemicLedger wiring during replay', () => {
  it('initializes epistemicLedger after replay of empty events', () => {
    const engine = new ReplayEngine(makeCatalogContext('E_1_1'));
    const state = engine.replay([]);

    expect(state.epistemicLedger).toBeDefined();
    expect(state.epistemicLedger?.claims).toEqual({});
    expect(state.epistemicLedger?.bySubject).toEqual({});
    expect(state.epistemicLedger?.byProposition).toEqual({});
    expect(state.epistemicLedger?.actLog).toEqual([]);
  });

  it('initializes propositionCatalog after replay of empty events', () => {
    const engine = new ReplayEngine(makeCatalogContext('E_1_1'));
    const state = engine.replay([]);

    expect(state.propositionCatalog).toBeDefined();
    expect(state.propositionCatalog?.version).toBe(1);
    expect(state.propositionCatalog?.propositions).toEqual({});
    expect(state.propositionCatalog?.dependencyGraph).toEqual({});
  });

  it('replay works end-to-end without the legacy knowledge shim', () => {
    const engine = new ReplayEngine(makeCatalogContext('E_1_1'));

    // The hero is live-activated by its canonical introduction transition
    // (day_0) before the authored write (day_1).
    const activation = introductionTransition('hero', 'E_1_1', { name: 'Hero' });

    // An event with a "knows" postcondition — the old shim used to populate
    // state.knowledge[entityId].knownFacts for this; now the epistemic ledger
    // handles it and replay should not crash.
    const knowsPostcondition = makeFact({
      entityId: 'hero',
      attribute: 'knows',
      value: 'fact_secret',
    });

    const event = makeEvent(1, 1, {
      postconditions: [knowsPostcondition],
    });

    const state = engine.replay([activation, event]);

    // Base state fields should be intact
    expect(state.entities).toBeDefined();
    expect(state.entities.hero).toBeDefined();
    // The "knows" attribute was written as an entity attribute (standard set path)
    expect(state.entities.hero.knows).toBe('fact_secret');
    // The epistemic ledger was initialized (not undefined)
    expect(state.epistemicLedger).toBeDefined();
    // The proposition catalog was initialized
    expect(state.propositionCatalog).toBeDefined();
    // No crash from missing state.knowledge shim: exactly the activation
    // write plus the knows postcondition
    expect(state.facts).toHaveLength(2);
  });

  it('replay with "knowledge" postcondition attribute does not crash', () => {
    const engine = new ReplayEngine(makeCatalogContext('E_2_1'));
    const activation = introductionTransition('hero', 'E_2_1', { name: 'Hero' });
    const knowledgePostcondition = makeFact({
      entityId: 'hero',
      attribute: 'knowledge',
      value: 'secret_origin',
    });

    const event = makeEvent(2, 1, {
      postconditions: [knowledgePostcondition],
    });

    const state = engine.replay([activation, event]);
    expect(state.entities.hero.knowledge).toBe('secret_origin');
    expect(state.epistemicLedger).toBeDefined();
    expect(state.propositionCatalog).toBeDefined();
  });

  it('replay with narrativeHint-only postcondition does not crash', () => {
    const engine = new ReplayEngine(makeCatalogContext('E_3_1'));
    const activation = introductionTransition('hero', 'E_3_1', { name: 'Hero' });
    const hintFact = makeFact({
      entityId: 'hero',
      attribute: 'status',
      value: undefined,
      narrativeHint: 'Hero should appear mysterious',
    });

    const event = makeEvent(3, 1, {
      postconditions: [hintFact],
    });

    const state = engine.replay([activation, event]);
    expect(state.epistemicLedger).toBeDefined();
    expect(state.propositionCatalog).toBeDefined();
    // Activation write + hint fact (hint facts carry no entity write)
    expect(state.facts).toHaveLength(2);
  });

  it('both epistemicLedger and propositionCatalog are available after multi-event replay', () => {
    const engine = new ReplayEngine(makeCatalogContext('E_1_1'));
    const kingActivation = introductionTransition('king', 'E_1_1', { name: 'King' });
    const e1 = makeEvent(1, 1, {
      postconditions: [makeFact({ entityId: 'king', attribute: 'status', value: 'alive' })],
    });
    const e2 = makeEvent(2, 2, {
      preconditions: [makeFact({ entityId: 'king', attribute: 'status', value: 'alive' })],
      postconditions: [makeFact({ entityId: 'king', attribute: 'status', value: 'dead' })],
    });

    const state = engine.replay([kingActivation, e1, e2]);
    expect(state.epistemicLedger).toBeDefined();
    expect(state.propositionCatalog).toBeDefined();
    expect(state.entities.king.status).toBe('dead');
  });
});
