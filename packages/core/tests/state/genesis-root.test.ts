// ============================================================================
// genesis-root.test.ts — initialFacts applied as the baseline initial state.
// (Terminology: "initial state"/"baseline" — initialFacts are plain baseline
// state input.)
//
// world/villain are declared initial-introduced (activated by baseline facts);
// hero is declared event-introduced by E1 and activated by its canonical
// system:introduction transition at day_0 (before E1 at day_1).
// ============================================================================

import { describe, expect, it } from 'vitest';
import { compileEntityTypeCatalog } from '../../src/entity/entity-catalog-compiler.ts';
import { compileStoryBoundaries } from '../../src/state/story-boundaries.ts';
import type {
  EntityCatalogContext,
  EntityTypeCatalog,
  EntityTypeCatalogSource,
  EntityTypeDefinitionSource,
  Fact,
  NarrativeEvent,
} from '../../src/types/index.ts';

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
  preconditions: Fact[] = [],
  postconditions: Fact[] = [],
): NarrativeEvent {
  return {
    kind: 'event',
    id,
    event: id,
    narrativeOrder: Number(id.replace(/\D/g, '') || 0),
    title: id,
    storyTime: { type: 'absolute', value: `day_${day}` },
    sceneType: 'linear',
    pov: { character: 'narrator', type: 'first_person' },
    sceneBrief: id,
    beats: [id],
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

// ─── Synthetic catalog (explicit; no default catalog) ───────────────────────

const LOCATION_SOURCE: EntityTypeDefinitionSource = {
  typeId: 'location',
  kind: 'location',
  attributes: {
    status: {
      attributeId: 'status',
      valueType: 'string',
      requiredAt: 'never',
      writePolicy: 'mutable',
      unsetAllowed: false,
    },
    era: {
      attributeId: 'era',
      valueType: 'string',
      requiredAt: 'never',
      writePolicy: 'immutable',
      unsetAllowed: false,
    },
  },
  lifecyclePolicy: { allowedTransitions: [] },
  referenceCapabilities: { defaultEligibility: 'live' },
  typedInvariants: [],
};

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
  },
  lifecyclePolicy: { allowedTransitions: [] },
  referenceCapabilities: { defaultEligibility: 'live' },
  typedInvariants: [],
};

const SYNTHETIC_SOURCE: EntityTypeCatalogSource = {
  types: { location: LOCATION_SOURCE, character: CHARACTER_SOURCE },
};

const TYPE_CATALOG: EntityTypeCatalog = compileEntityTypeCatalog(SYNTHETIC_SOURCE);

const CATALOG_CONTEXT: EntityCatalogContext = {
  entityDeclarationCatalog: {
    declarations: {
      world: {
        entityId: 'world',
        typeRef: { typeId: 'location', schemaVersion: 1 },
        immutableMetadata: { name: 'World', definitionFile: 'world.yaml' },
        introduction: { type: 'initial' },
      },
      villain: {
        entityId: 'villain',
        typeRef: { typeId: 'character', schemaVersion: 1 },
        immutableMetadata: { name: 'Villain', definitionFile: 'villain.yaml' },
        introduction: { type: 'initial' },
      },
      hero: {
        entityId: 'hero',
        typeRef: { typeId: 'character', schemaVersion: 1 },
        immutableMetadata: { name: 'Hero', definitionFile: 'hero.yaml' },
        introduction: { type: 'event', eventId: 'E1' },
      },
    },
    version: 1,
  },
  entityTypeCatalog: TYPE_CATALOG,
};

/** Canonical introduction transition: activates hero at day_0, before E1(day_1). */
function heroIntroduction(): NarrativeEvent {
  const transition = event('system:introduction:E1:hero', 0, [], [fact('hero', 'name', 'Hero')]);
  return { ...transition, participants: { entities: ['hero'] } };
}

/** Explicit adjacency edge: the hero introduction precedes E1. */
const HERO_ACTIVATION_ADJACENCY: Map<string, string[]> = new Map([
  ['system:introduction:E1:hero', ['E1']],
]);

describe('initial state — initialFacts applied as baseline', () => {
  it('initialFacts provide baseline state before the first event', () => {
    const initialFacts = [fact('world', 'status', 'created')];
    const activation = heroIntroduction();
    const e1 = event('E1', 1, [], [fact('hero', 'status', 'awake')]);

    const boundaries = compileStoryBoundaries(
      [activation, e1],
      initialFacts,
      HERO_ACTIVATION_ADJACENCY,
      CATALOG_CONTEXT,
    );
    // Baseline fact should be in the initial state before E1
    expect(boundaries.stateBeforeByEventId.get('E1')?.entities['world']?.['status']).toBe(
      'created',
    );
  });

  it('event postcondition overrides baseline initialFact for same entity+attribute', () => {
    // Baseline sets world.status = "created"
    // E1 sets world.status = "changed" — verifies E1's write applies ON TOP of
    // the baseline, and the baseline is not double-applied (which would either
    // no-op idempotently or corrupt state)
    const initialFacts = [fact('world', 'status', 'created')];
    const activation = heroIntroduction();
    const e1 = event('E1', 1, [], [fact('world', 'status', 'changed')]);

    const boundaries = compileStoryBoundaries(
      [activation, e1],
      initialFacts,
      HERO_ACTIVATION_ADJACENCY,
      CATALOG_CONTEXT,
    );
    // Before E1: baseline value
    expect(boundaries.stateBeforeByEventId.get('E1')?.entities['world']?.['status']).toBe(
      'created',
    );
    // After E1 (finalState): E1's value overrides
    expect(boundaries.finalState.entities['world']?.['status']).toBe('changed');
  });

  it('no initial facts → empty baseline state', () => {
    // No baseline facts and no event writes: the pre-event state stays empty.
    // (An event write to the event-introduced hero would require its
    // introduction transition, which itself would populate the pre-event state.)
    const e1 = event('E1', 1);
    const boundaries = compileStoryBoundaries([e1], [], new Map(), CATALOG_CONTEXT);
    expect(boundaries.stateBeforeByEventId.get('E1')?.entities).toEqual({});
  });

  it('multiple initial facts all appear in baseline state', () => {
    const initialFacts = [
      fact('world', 'status', 'created'),
      fact('world', 'era', 'ancient'),
      fact('villain', 'name', 'darklord'),
    ];
    const activation = heroIntroduction();
    const e1 = event('E1', 1, [], [fact('hero', 'status', 'awake')]);

    const boundaries = compileStoryBoundaries(
      [activation, e1],
      initialFacts,
      HERO_ACTIVATION_ADJACENCY,
      CATALOG_CONTEXT,
    );
    const beforeState = boundaries.stateBeforeByEventId.get('E1')!;
    expect(beforeState.entities['world']?.['status']).toBe('created');
    expect(beforeState.entities['world']?.['era']).toBe('ancient');
    expect(beforeState.entities['villain']?.['name']).toBe('darklord');
  });
});
