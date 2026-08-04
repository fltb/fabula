// ============================================================================
// entity-lifecycle.test.ts — catalog-driven write enforcement + lifecycle
// transitions through the canonical ReplayEngine/applicator.
//
// Every test uses an explicit synthetic catalog compiled via
// compileEntityTypeCatalog — no built-in/default catalog, no fallback.
// Each enforced policy has at least one negative case, and the source
// preflight (validateProjectOntology) / phase-'source' applicator run emits
// the exact same rule text as replay, differing only in the diagnostic phase.
// ============================================================================

import { describe, expect, it } from 'vitest';
import { compileEntityTypeCatalog } from '../../src/entity/entity-catalog-compiler.js';
import { InMemoryEntityRegistry } from '../../src/entity/index.js';
import { validateProjectOntology } from '../../src/entity/ontology.js';
import type { CanonicalProjectIR } from '../../src/entity/project-runtime.js';
import type { ProjectData } from '../../src/entity/types.js';
import { ConfigError } from '../../src/errors.js';
import { applyInitialFacts, applyNarrativeEvent } from '../../src/state/event-application.js';
import { ReplayEngine } from '../../src/state/replay.js';
import { compileStoryBoundaries, emptyWorldState } from '../../src/state/story-boundaries.js';
import type {
  EntityCatalogContext,
  EntityDeclarationCatalog,
  EntityTypeCatalog,
  EntityTypeCatalogSource,
  EntityTypeDefinitionSource,
  Fact,
  NarrativeEvent,
} from '../../src/types/index.js';

// ─── Synthetic compiled catalog (explicit; no default-catalog import) ──────

const LIFECYCLE_TRANSITIONS: Array<
  ['active' | 'inactive' | 'retired', 'active' | 'inactive' | 'retired']
> = [
  ['active', 'inactive'],
  ['active', 'retired'],
  ['inactive', 'active'],
  ['inactive', 'retired'],
];

const CHARACTER_SOURCE: EntityTypeDefinitionSource = {
  typeId: 'character',
  kind: 'character',
  attributes: {
    name: {
      attributeId: 'name',
      valueType: 'string',
      requiredAt: 'introduction',
      writePolicy: 'immutable',
      unsetAllowed: false,
    },
    status: {
      attributeId: 'status',
      valueType: 'string',
      requiredAt: 'never',
      writePolicy: 'mutable',
      unsetAllowed: true,
    },
    age: {
      attributeId: 'age',
      valueType: 'number',
      requiredAt: 'never',
      writePolicy: 'write_once',
      unsetAllowed: false,
    },
    gender: {
      attributeId: 'gender',
      valueType: 'string',
      requiredAt: 'never',
      writePolicy: 'immutable',
      unsetAllowed: false,
    },
    mentor: {
      attributeId: 'mentor',
      valueType: 'string',
      requiredAt: 'never',
      writePolicy: 'mutable',
      unsetAllowed: true,
      typedReferenceConstraint: { targetKind: 'character' },
    },
    bonded_weapon: {
      attributeId: 'bonded_weapon',
      valueType: 'string',
      requiredAt: 'never',
      writePolicy: 'mutable',
      unsetAllowed: true,
      typedReferenceConstraint: { targetKind: 'item', targetTypeId: 'weapon' },
    },
    lifecycle: {
      attributeId: 'lifecycle',
      valueType: 'string',
      requiredAt: 'never',
      writePolicy: 'lifecycle_managed',
      allowedLifecycleStates: ['active', 'inactive', 'retired'],
      unsetAllowed: false,
    },
    char_state: {
      attributeId: 'char_state',
      valueType: 'string',
      requiredAt: 'never',
      writePolicy: 'lifecycle_managed',
      unsetAllowed: false,
    },
  },
  lifecyclePolicy: { allowedTransitions: LIFECYCLE_TRANSITIONS },
  referenceCapabilities: { defaultEligibility: 'live' },
  typedInvariants: [],
};

const LOCATION_SOURCE: EntityTypeDefinitionSource = {
  typeId: 'location',
  kind: 'location',
  attributes: {
    name: {
      attributeId: 'name',
      valueType: 'string',
      requiredAt: 'introduction',
      writePolicy: 'immutable',
      unsetAllowed: false,
    },
    alive: {
      attributeId: 'alive',
      valueType: 'string',
      requiredAt: 'activation',
      writePolicy: 'mutable',
      unsetAllowed: true,
    },
    lifecycle: {
      attributeId: 'lifecycle',
      valueType: 'string',
      requiredAt: 'never',
      writePolicy: 'lifecycle_managed',
      allowedLifecycleStates: ['active', 'inactive', 'retired'],
      unsetAllowed: false,
    },
  },
  lifecyclePolicy: { allowedTransitions: LIFECYCLE_TRANSITIONS },
  referenceCapabilities: { defaultEligibility: 'live' },
  typedInvariants: [],
};

const WEAPON_SOURCE: EntityTypeDefinitionSource = {
  typeId: 'weapon',
  kind: 'item',
  attributes: {
    name: {
      attributeId: 'name',
      valueType: 'string',
      requiredAt: 'introduction',
      writePolicy: 'immutable',
      unsetAllowed: false,
    },
    condition: {
      attributeId: 'condition',
      valueType: 'string',
      requiredAt: 'never',
      writePolicy: 'mutable',
      unsetAllowed: true,
    },
    lifecycle: {
      attributeId: 'lifecycle',
      valueType: 'string',
      requiredAt: 'never',
      writePolicy: 'lifecycle_managed',
      allowedLifecycleStates: ['active', 'inactive', 'retired'],
      unsetAllowed: false,
    },
  },
  lifecyclePolicy: { allowedTransitions: LIFECYCLE_TRANSITIONS },
  referenceCapabilities: { defaultEligibility: 'live' },
  typedInvariants: [],
};

const POTION_SOURCE: EntityTypeDefinitionSource = {
  typeId: 'potion',
  kind: 'item',
  attributes: {
    name: {
      attributeId: 'name',
      valueType: 'string',
      requiredAt: 'introduction',
      writePolicy: 'immutable',
      unsetAllowed: false,
    },
    lifecycle: {
      attributeId: 'lifecycle',
      valueType: 'string',
      requiredAt: 'never',
      writePolicy: 'lifecycle_managed',
      allowedLifecycleStates: ['active', 'inactive', 'retired'],
      unsetAllowed: false,
    },
  },
  lifecyclePolicy: { allowedTransitions: LIFECYCLE_TRANSITIONS },
  referenceCapabilities: { defaultEligibility: 'live' },
  typedInvariants: [],
};

const SYNTHETIC_SOURCE: EntityTypeCatalogSource = {
  types: {
    character: CHARACTER_SOURCE,
    location: LOCATION_SOURCE,
    weapon: WEAPON_SOURCE,
    potion: POTION_SOURCE,
  },
};

const TYPE_CATALOG: EntityTypeCatalog = compileEntityTypeCatalog(SYNTHETIC_SOURCE);

function makeDeclarationCatalog(): EntityDeclarationCatalog {
  return {
    declarations: {
      hero: {
        entityId: 'hero',
        typeRef: { typeId: 'character', schemaVersion: 1 },
        immutableMetadata: { name: 'Hero', definitionFile: 'hero.yaml' },
        introduction: { type: 'event', eventId: 'E1' },
      },
      sidekick: {
        entityId: 'sidekick',
        typeRef: { typeId: 'character', schemaVersion: 1 },
        immutableMetadata: { name: 'Sidekick', definitionFile: 'sidekick.yaml' },
        introduction: { type: 'event', eventId: 'E2' },
      },
      world: {
        entityId: 'world',
        typeRef: { typeId: 'location', schemaVersion: 1 },
        immutableMetadata: { name: 'World', definitionFile: 'world.yaml' },
        introduction: { type: 'initial' },
      },
      sword: {
        entityId: 'sword',
        typeRef: { typeId: 'weapon', schemaVersion: 1 },
        immutableMetadata: { name: 'Sword', definitionFile: 'sword.yaml' },
        introduction: { type: 'event', eventId: 'E1' },
      },
      potion: {
        entityId: 'potion',
        typeRef: { typeId: 'potion', schemaVersion: 1 },
        immutableMetadata: { name: 'Potion', definitionFile: 'potion.yaml' },
        introduction: { type: 'event', eventId: 'E1' },
      },
    },
    version: 1,
  };
}

const DECLARATION_CATALOG = makeDeclarationCatalog();

const CATALOG_CONTEXT: EntityCatalogContext = {
  entityDeclarationCatalog: DECLARATION_CATALOG,
  entityTypeCatalog: TYPE_CATALOG,
};

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
  daySuffix: number | string,
  overrides: Partial<NarrativeEvent> = {},
): NarrativeEvent {
  return {
    kind: 'event',
    id: `E_${narrativeOrder}`,
    event: `E_${narrativeOrder}`,
    narrativeOrder,
    title: 'Test',
    storyTime: { type: 'absolute' as const, value: `day_${daySuffix}` },
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

/**
 * Synthetic `system:introduction:<targetEventId>:<entityId>` transition,
 * mirroring the canonical kernel's shape: lifecycle:'active' first, then the
 * authored initialState writes, same branch scope as the target event,
 * narrativeOrder = target + 0.5. The story time is fixed at day_0 so the
 * temporal graph orders the activation strictly before every authored write
 * (which all use day_1+), matching the kernel's causal edge from transition
 * to target event.
 */
function introductionTransition(
  entityId: string,
  targetEventId: string,
  initialState: Record<string, unknown>,
  storyTime: { type: 'absolute'; value: string } = { type: 'absolute', value: 'day_0' },
): NarrativeEvent {
  const storyTimeOverride = { type: 'absolute' as const, value: storyTime.value };
  const postconditions: Fact[] = [
    makeFact({ entityId, attribute: 'lifecycle', value: 'active' }),
    ...Object.entries(initialState).map(([attribute, value]) =>
      makeFact({ entityId, attribute, value }),
    ),
  ];
  const id = `system:introduction:${targetEventId}:${entityId}`;
  return makeEvent(1.5, 1, {
    id,
    event: id,
    storyTime: storyTimeOverride,
    source: 'system',
    participants: { entities: [entityId] },
    postconditions,
  });
}

/** Activate the event-introduced hero with its canonical transition. */
function heroActivation(): NarrativeEvent {
  return introductionTransition('hero', 'E1', {
    name: 'Aragorn',
    status: 'alive',
  });
}

function replay(
  events: NarrativeEvent[],
  initialFacts: Fact[] = [],
  catalogs: EntityCatalogContext = CATALOG_CONTEXT,
) {
  return new ReplayEngine(catalogs).replay(events, {
    initialFacts,
    initialThreads: [],
    timeAnchors: [],
  });
}

/** Capture the ConfigError raised by `fn`, or fail the test. */
function catchConfigError(fn: () => void): ConfigError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return err as ConfigError;
  }
  throw new Error('expected a ConfigError, but none was raised');
}

function writeFails(
  events: NarrativeEvent[],
  initialFacts: Fact[] = [],
  messagePart: string,
): ConfigError {
  const error = catchConfigError(() => replay(events, initialFacts));
  expect(error.message).toContain(messagePart);
  return error;
}

/** Apply events through the same applicator with the source preflight phase. */
function sourceApplicatorRun(events: NarrativeEvent[], initialFacts: Fact[] = []): void {
  const state = emptyWorldState();
  applyInitialFacts(state, initialFacts, { catalogs: CATALOG_CONTEXT });
  for (const event of events) {
    applyNarrativeEvent(state, event, { catalogs: CATALOG_CONTEXT, phase: 'source' });
  }
}

function buildIR(
  events: NarrativeEvent[],
  initialFacts: Fact[] = [],
  declarations: EntityDeclarationCatalog = DECLARATION_CATALOG,
): CanonicalProjectIR {
  const data: ProjectData = {
    config: null,
    characters: [],
    relationships: [],
    rules: [],
    locations: [],
    items: [],
    factions: [],
    worldInitialState: null,
    chapters: new Map(),
    timeAnchors: [],
    narratorProfiles: {},
    discourseLedger: {
      id: 'synthetic',
      chapters: [{ branch: 'main', chapter: 1, sceneIds: ['E1'] }],
      entries: [],
      hash: 'synthetic',
    },
    narratorAssertions: {},
    entityTypeCatalogSource: SYNTHETIC_SOURCE,
  };
  return {
    sourceHash: 'synthetic',
    data,
    authoredEvents: events,
    runtimeEvents: events,
    initialFacts,
    initialThreads: [],
    registry: new InMemoryEntityRegistry(),
    entityDeclarations: declarations,
    entityTypes: TYPE_CATALOG,
    catalogContext: CATALOG_CONTEXT,
    gameDialogueTree: null,
    chapterByEventId: {},
  };
}
// ============================================================================
// Catalog-driven write enforcement — one negative case per policy
// ============================================================================

describe('catalog-driven write enforcement', () => {
  it('rejects a write to an undeclared entity', () => {
    const error = writeFails(
      [
        makeEvent(1, 1, {
          postconditions: [makeFact({ entityId: 'nobody', attribute: 'status', value: 'x' })],
        }),
      ],
      [],
      'Unknown entity declaration "nobody"',
    );
    expect(error.context.phase).toBe('replay');
  });

  it('rejects a write to an entity whose declared type is not in the catalog', () => {
    const declarations = makeDeclarationCatalog();
    declarations.declarations.hero = {
      ...declarations.declarations.hero,
      typeRef: { typeId: 'alien', schemaVersion: 1 },
    };
    const events = [
      heroActivation(),
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'status', value: 'x' })],
      }),
    ];
    const error = catchConfigError(() =>
      replay(events, [], {
        entityDeclarationCatalog: declarations,
        entityTypeCatalog: TYPE_CATALOG,
      }),
    );
    expect(error.message).toContain('Unknown entity type "alien" for declaration "hero"');
  });

  it('rejects a write to an unknown attribute', () => {
    const events = [
      heroActivation(),
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'nonexistent', value: 'x' })],
      }),
    ];
    writeFails(events, [], 'Write to unknown attribute "hero.nonexistent"');
  });

  it('rejects a domain value that violates the compiled value schema', () => {
    const events = [
      heroActivation(),
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'status', value: 42 })],
      }),
    ];
    const error = writeFails(events, [], 'Value for "hero.status" violates value schema');
    expect(error.message).toContain('Expected string');
  });

  it('rejects a second write to an immutable attribute after activation', () => {
    const events = [
      heroActivation(), // transition write of immutable `name` is allowed
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'name', value: 'Strider' })],
      }),
    ];
    writeFails(events, [], 'Attribute "hero.name" is immutable');
  });

  it('rejects a second write to a write-once attribute', () => {
    const events = [
      heroActivation(),
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'age', value: 25 })],
      }),
      makeEvent(2, 2, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'age', value: 26 })],
      }),
    ];
    writeFails(events, [], 'Attribute "hero.age" is write-once and has already been written');
  });

  it('rejects unsetting the lifecycle attribute', () => {
    const events = [
      heroActivation(),
      makeEvent(1, 1, {
        postconditions: [
          makeFact({ entityId: 'hero', attribute: 'lifecycle', operation: 'unset' }),
        ],
      }),
    ];
    writeFails(events, [], 'Cannot unset lifecycle attribute "hero.lifecycle"');
  });

  it('rejects unsetting an attribute whose policy forbids unset', () => {
    const events = [
      heroActivation(), // transition writes immutable `name`
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'name', operation: 'unset' })],
      }),
    ];
    writeFails(events, [], 'Unset is not allowed for attribute "hero.name"');
  });

  it('rejects unsetting an absent attribute even when unset is allowed', () => {
    const events = [
      heroActivation(), // `status` is written, `mentor` (unsetAllowed) is not
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'mentor', operation: 'unset' })],
      }),
    ];
    writeFails(events, [], 'Cannot unset absent attribute "hero.mentor"');
  });

  it('allows unsetting a present mutable attribute', () => {
    const events = [
      heroActivation(),
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'status', operation: 'unset' })],
      }),
    ];
    const state = replay(events);
    expect(state.entities.hero?.status).toBeUndefined();
  });

  it('rejects an introduction transition that omits a requiredAt:introduction attribute', () => {
    const events = [
      introductionTransition('hero', 'E1', { status: 'alive' }), // missing `name`
    ];
    const error = writeFails(
      events,
      [],
      'Required attribute "hero.name" (requiredAt: introduction) missing after activation',
    );
    expect(error.message).toContain('requiredAt: introduction');
  });

  it('rejects initial facts that omit a requiredAt:activation attribute', () => {
    const events = [
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'world', attribute: 'name', value: 'Midgard' })],
      }),
    ];
    const initialFacts = [
      makeFact({ entityId: 'world', attribute: 'name', value: 'Midgard' }),
      // `alive` (requiredAt: activation) is missing
    ];
    const error = writeFails(
      events,
      initialFacts,
      'Required attribute "world.alive" (requiredAt: activation) missing after activation',
    );
    expect(error.message).toContain('requiredAt: activation');
  });

  it('rejects a typed reference that is not an entity id string', () => {
    const events = [
      heroActivation(),
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'mentor', value: 42 })],
      }),
    ];
    writeFails(events, [], 'Value for "hero.mentor" violates value schema');
  });

  it('rejects a typed reference to an undeclared entity', () => {
    const events = [
      heroActivation(),
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'mentor', value: 'ghost' })],
      }),
    ];
    writeFails(events, [], 'Reference "ghost" for "hero.mentor" is not a declared entity');
  });

  it('rejects a typed reference whose target kind does not match', () => {
    const events = [
      heroActivation(),
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'mentor', value: 'world' })],
      }),
    ];
    writeFails(
      events,
      [],
      'Reference "world" for "hero.mentor" must target kind "character" (declared kind: location)',
    );
  });

  it('rejects a typed reference whose target type id does not match', () => {
    const events = [
      heroActivation(),
      makeEvent(1, 1, {
        postconditions: [
          makeFact({ entityId: 'hero', attribute: 'bonded_weapon', value: 'potion' }),
        ],
      }),
    ];
    writeFails(
      events,
      [],
      'Reference "potion" for "hero.bonded_weapon" must target type "weapon" (declared type: "potion")',
    );
  });

  it('accepts a typed reference that satisfies kind and type', () => {
    const events = [
      heroActivation(),
      makeEvent(1, 1, {
        postconditions: [
          makeFact({ entityId: 'hero', attribute: 'mentor', value: 'sidekick' }),
          makeFact({ entityId: 'hero', attribute: 'bonded_weapon', value: 'sword' }),
        ],
      }),
    ];
    const state = replay(events);
    expect(state.entities.hero?.mentor).toBe('sidekick');
    expect(state.entities.hero?.bonded_weapon).toBe('sword');
  });

  it('rejects an ordinary event write to an event-introduced entity before its transition', () => {
    const events = [
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'status', value: 'alive' })],
      }),
    ];
    writeFails(
      events,
      [],
      'Write to "hero.status" before activation: entity "hero" is introduced by event "E1" and can only be activated by introduction transition "system:introduction:E1:hero", not "E_1"',
    );
  });

  it('rejects an ordinary event write to an initial-activated entity before initial facts', () => {
    const events = [
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'world', attribute: 'name', value: 'Midgard' })],
      }),
    ];
    writeFails(
      events,
      [],
      'Write to "world.name" before activation: entity "world" is initial-activated and must be activated by initial facts',
    );
  });

  it('rejects an initial fact that activates an event-introduced entity', () => {
    const events = [
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'world', attribute: 'name', value: 'Midgard' })],
      }),
    ];
    const initialFacts = [makeFact({ entityId: 'hero', attribute: 'status', value: 'alive' })];
    const error = writeFails(
      events,
      initialFacts,
      'Initial fact cannot activate event-introduced entity "hero" (introduced by event "E1")',
    );
    expect(error.message).toContain('introduced by event "E1"');
  });

  it('rejects a duplicate activation (entity already live before a transition)', () => {
    const events = [
      heroActivation(),
      introductionTransition(
        'hero',
        'E2',
        { name: 'Aragorn', status: 'alive' },
        { type: 'absolute', value: 'day_1' },
      ),
    ];
    writeFails(
      events,
      [],
      'Duplicate activation: entity "hero" is already live before introduction transition "system:introduction:E2:hero"',
    );
  });

  it('rejects a lifecycle write with a value outside the allowed lifecycle states', () => {
    const events = [
      heroActivation(),
      makeEvent(1, 1, {
        postconditions: [
          makeFact({ entityId: 'hero', attribute: 'lifecycle', value: 'some_weird_state' }),
        ],
      }),
    ];
    writeFails(events, [], 'Invalid lifecycle state "some_weird_state" for "hero.lifecycle"');
  });

  it('rejects a non-string lifecycle value', () => {
    const events = [
      heroActivation(),
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'lifecycle', value: 7 })],
      }),
    ];
    writeFails(events, [], 'Value for "hero.lifecycle" violates value schema');
  });

  it('rejects a lifecycle transition not in the allowed transitions (terminal retired)', () => {
    const events = [
      heroActivation(),
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'lifecycle', value: 'retired' })],
      }),
      makeEvent(2, 2, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'lifecycle', value: 'active' })],
      }),
    ];
    writeFails(events, [], 'Invalid lifecycle transition retired → active for "hero.lifecycle"');
  });

  it('rejects a self-transition that is not allowed (active → active)', () => {
    const events = [
      heroActivation(),
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'lifecycle', value: 'active' })],
      }),
    ];
    writeFails(events, [], 'Invalid lifecycle transition active → active for "hero.lifecycle"');
  });

  it('rejects any write to a retired entity', () => {
    const events = [
      heroActivation(),
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'lifecycle', value: 'retired' })],
      }),
      makeEvent(2, 2, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'status', value: 'gone' })],
      }),
    ];
    writeFails(events, [], 'Cannot modify retired entity "hero" (write to "hero.status")');
  });

  it('rejects a lifecycle_managed write to a non-lifecycle attribute', () => {
    const events = [
      heroActivation(),
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'char_state', value: 'x' })],
      }),
    ];
    writeFails(
      events,
      [],
      'Attribute "hero.char_state" is lifecycle-managed but is not the lifecycle attribute',
    );
  });

  it('rejects two lifecycle changes for the same entity at the same story coordinate', () => {
    const events = [
      heroActivation(),
      makeEvent(1, 1, {
        storyTime: { type: 'absolute', value: 'day_1' },
        postconditions: [makeFact({ entityId: 'hero', attribute: 'lifecycle', value: 'inactive' })],
      }),
      makeEvent(2, 1, {
        storyTime: { type: 'absolute', value: 'day_1' },
        causalPredecessors: ['E_1'],
        postconditions: [makeFact({ entityId: 'hero', attribute: 'lifecycle', value: 'active' })],
      }),
    ];
    const error = writeFails(events, [], 'Same coordinate lifecycle conflict: multiple events at');
    expect(error.message).toContain('modify lifecycle of "hero"');
  });

  it('allows lifecycle changes for different entities at the same story coordinate', () => {
    const events = [
      heroActivation(),
      introductionTransition('sidekick', 'E2', { name: 'Sam', status: 'alive' }),
      makeEvent(1, 1, {
        storyTime: { type: 'absolute', value: 'day_1' },
        postconditions: [makeFact({ entityId: 'hero', attribute: 'lifecycle', value: 'inactive' })],
      }),
      makeEvent(2, 1, {
        storyTime: { type: 'absolute', value: 'day_1' },
        postconditions: [
          makeFact({ entityId: 'sidekick', attribute: 'lifecycle', value: 'inactive' }),
        ],
      }),
    ];
    const state = replay(events);
    expect(state.entities.hero?.lifecycle).toBe('inactive');
    expect(state.entities.sidekick?.lifecycle).toBe('inactive');
  });

  it('rejects a participant that is not live', () => {
    const events = [
      makeEvent(1, 1, {
        participants: { entities: ['hero'] },
        postconditions: [makeFact({ entityId: 'world', attribute: 'alive', value: 'yes' })],
      }),
    ];
    const error = writeFails(
      events,
      [
        makeFact({ entityId: 'world', attribute: 'name', value: 'Midgard' }),
        makeFact({ entityId: 'world', attribute: 'alive', value: 'yes' }),
      ],
      'Entity "hero" is not live; cannot participate in event E_1 (live reference before activation)',
    );
    expect(error.message).toContain('live reference before activation');
  });

  it('rejects a retired participant', () => {
    const events = [
      heroActivation(),
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'lifecycle', value: 'retired' })],
      }),
      makeEvent(2, 2, {
        participants: { entities: ['hero'] },
        postconditions: [makeFact({ entityId: 'world', attribute: 'alive', value: 'yes' })],
      }),
    ];
    const error = writeFails(
      events,
      [
        makeFact({ entityId: 'world', attribute: 'name', value: 'Midgard' }),
        makeFact({ entityId: 'world', attribute: 'alive', value: 'yes' }),
      ],
      'Retired entity hero cannot participate in event E_2',
    );
    expect(error.message).toContain('cannot participate');
  });

  it('rejects a precondition that reads an entity before activation', () => {
    const events = [
      makeEvent(1, 1, {
        preconditions: [makeFact({ entityId: 'hero', attribute: 'status', value: 'alive' })],
        postconditions: [],
      }),
    ];
    writeFails(
      events,
      [],
      'Live read before activation: precondition references entity "hero" which is not yet live',
    );
  });

  it('rejects every write when the declaration catalog is empty (missing catalog)', () => {
    const emptyContext: EntityCatalogContext = {
      entityDeclarationCatalog: { declarations: {}, version: 1 },
      entityTypeCatalog: TYPE_CATALOG,
    };
    const error = catchConfigError(() =>
      new ReplayEngine(emptyContext).replay(
        [
          makeEvent(1, 1, {
            postconditions: [makeFact({ entityId: 'hero', attribute: 'status', value: 'x' })],
          }),
        ],
        { initialFacts: [], initialThreads: [], timeAnchors: [] },
      ),
    );
    expect(error.message).toBe('Unknown entity declaration "hero"');
  });
});

// ============================================================================
// validateProjectOntology — pure source preflight (phase 'source')
// ============================================================================

describe('validateProjectOntology', () => {
  it('accepts a legal project and never mutates the IR', () => {
    const events = [
      heroActivation(),
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'status', value: 'alive' })],
      }),
    ];
    const initialFacts = [
      makeFact({ entityId: 'world', attribute: 'name', value: 'Midgard' }),
      makeFact({ entityId: 'world', attribute: 'alive', value: 'yes' }),
    ];
    const ir = buildIR(events, initialFacts);
    // The IR carries live Zod schemas (compiled catalog), which cannot be
    // structured-cloned — snapshot the mutable surfaces instead.
    const snapshot = {
      authoredEvents: structuredClone(ir.authoredEvents),
      initialFacts: structuredClone(ir.initialFacts),
      registryEntities: structuredClone(
        ir.registry.getAll().map((entity) => ({ id: entity.id, state: entity.state })),
      ),
    };
    expect(() => validateProjectOntology(ir)).not.toThrow();
    expect(ir.authoredEvents).toEqual(snapshot.authoredEvents);
    expect(ir.initialFacts).toEqual(snapshot.initialFacts);
    expect(ir.registry.getAll().map((entity) => ({ id: entity.id, state: entity.state }))).toEqual(
      snapshot.registryEntities,
    );
  });

  it('rejects an unknown declaration with phase source', () => {
    const ir = buildIR([
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'nobody', attribute: 'status', value: 'x' })],
      }),
    ]);
    const error = catchConfigError(() => validateProjectOntology(ir));
    expect(error.message).toBe('Unknown entity declaration "nobody"');
    expect(error.context.phase).toBe('source');
  });

  it('rejects a domain value violation with phase source', () => {
    const ir = buildIR([
      heroActivation(),
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'status', value: 42 })],
      }),
    ]);
    const error = catchConfigError(() => validateProjectOntology(ir));
    expect(error.message).toContain('Value for "hero.status" violates value schema');
    expect(error.context.phase).toBe('source');
  });

  it('rejects an initial fact activating an event-introduced entity with phase source', () => {
    const ir = buildIR(
      [makeEvent(1, 1, { postconditions: [] })],
      [makeFact({ entityId: 'hero', attribute: 'status', value: 'alive' })],
    );
    const error = catchConfigError(() => validateProjectOntology(ir));
    expect(error.message).toContain(
      'Initial fact cannot activate event-introduced entity "hero" (introduced by event "E1")',
    );
    expect(error.context.phase).toBe('source');
  });
});

// ============================================================================
// Source/replay equivalence — identical rule text, different phase
// ============================================================================

describe('source/replay equivalence — identical rule text, different phase', () => {
  it('unknown declaration: preflight vs replay', () => {
    const events = [
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'nobody', attribute: 'status', value: 'x' })],
      }),
    ];
    const preflight = catchConfigError(() => validateProjectOntology(buildIR(events)));
    const replayError = catchConfigError(() => replay(events));
    expect(preflight.message).toBe(replayError.message);
    expect(preflight.context.phase).not.toBe(replayError.context.phase);
    expect(preflight.context.phase).toBe('source');
    expect(replayError.context.phase).toBe('replay');
  });

  it('unknown attribute: preflight vs replay', () => {
    const events = [
      heroActivation(),
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'nonexistent', value: 'x' })],
      }),
    ];
    const preflight = catchConfigError(() => validateProjectOntology(buildIR(events)));
    const replayError = catchConfigError(() => replay(events));
    expect(preflight.message).toBe(replayError.message);
    expect(preflight.message).toContain('Write to unknown attribute "hero.nonexistent"');
    expect(preflight.context.phase).toBe('source');
    expect(replayError.context.phase).toBe('replay');
  });

  it('value schema violation: preflight vs replay', () => {
    const events = [
      heroActivation(),
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'status', value: 42 })],
      }),
    ];
    const preflight = catchConfigError(() => validateProjectOntology(buildIR(events)));
    const replayError = catchConfigError(() => replay(events));
    expect(preflight.message).toBe(replayError.message);
    expect(preflight.message).toContain('violates value schema');
    expect(preflight.context.phase).toBe('source');
    expect(replayError.context.phase).toBe('replay');
  });

  it('typed reference kind mismatch: preflight vs replay', () => {
    const events = [
      heroActivation(),
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'mentor', value: 'world' })],
      }),
    ];
    const preflight = catchConfigError(() => validateProjectOntology(buildIR(events)));
    const replayError = catchConfigError(() => replay(events));
    expect(preflight.message).toBe(replayError.message);
    expect(preflight.message).toContain('must target kind "character" (declared kind: location)');
    expect(preflight.context.phase).toBe('source');
    expect(replayError.context.phase).toBe('replay');
  });

  it('initial-vs-event activation: preflight (source) vs initial-fact phase', () => {
    const events = [makeEvent(1, 1, { postconditions: [] })];
    const initialFacts = [makeFact({ entityId: 'hero', attribute: 'status', value: 'alive' })];
    const preflight = catchConfigError(() =>
      validateProjectOntology(buildIR(events, initialFacts)),
    );
    const replayError = catchConfigError(() => replay(events, initialFacts));
    expect(preflight.message).toBe(replayError.message);
    expect(preflight.message).toContain(
      'Initial fact cannot activate event-introduced entity "hero"',
    );
    expect(preflight.context.phase).toBe('source');
    expect(replayError.context.phase).toBe('initial');
  });

  it('immutable: phase-source applicator vs replay', () => {
    const events = [
      heroActivation(),
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'name', value: 'Strider' })],
      }),
    ];
    const sourceError = catchConfigError(() => sourceApplicatorRun(events));
    const replayError = catchConfigError(() => replay(events));
    expect(sourceError.message).toBe(replayError.message);
    expect(sourceError.message).toContain('Attribute "hero.name" is immutable');
    expect(sourceError.context.phase).toBe('source');
    expect(replayError.context.phase).toBe('replay');
  });

  it('write_once: phase-source applicator vs replay', () => {
    const events = [
      heroActivation(),
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'age', value: 25 })],
      }),
      makeEvent(2, 2, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'age', value: 26 })],
      }),
    ];
    const sourceError = catchConfigError(() => sourceApplicatorRun(events));
    const replayError = catchConfigError(() => replay(events));
    expect(sourceError.message).toBe(replayError.message);
    expect(sourceError.message).toContain('is write-once and has already been written');
    expect(sourceError.context.phase).toBe('source');
    expect(replayError.context.phase).toBe('replay');
  });

  it('unset policy: phase-source applicator vs replay', () => {
    const events = [
      heroActivation(),
      makeEvent(1, 1, {
        postconditions: [
          makeFact({ entityId: 'hero', attribute: 'lifecycle', operation: 'unset' }),
        ],
      }),
    ];
    const sourceError = catchConfigError(() => sourceApplicatorRun(events));
    const replayError = catchConfigError(() => replay(events));
    expect(sourceError.message).toBe(replayError.message);
    expect(sourceError.message).toContain('Cannot unset lifecycle attribute "hero.lifecycle"');
    expect(sourceError.context.phase).toBe('source');
    expect(replayError.context.phase).toBe('replay');
  });

  it('requiredAt: phase-source applicator vs replay', () => {
    const events = [
      introductionTransition('hero', 'E1', { status: 'alive' }),
      makeEvent(1, 1, { postconditions: [] }),
    ];
    const sourceError = catchConfigError(() => sourceApplicatorRun(events));
    const replayError = catchConfigError(() => replay(events));
    expect(sourceError.message).toBe(replayError.message);
    expect(sourceError.message).toContain(
      'Required attribute "hero.name" (requiredAt: introduction) missing after activation',
    );
    expect(sourceError.context.phase).toBe('source');
    expect(replayError.context.phase).toBe('replay');
  });

  it('lifecycle transition: phase-source applicator vs replay', () => {
    const events = [
      heroActivation(),
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'lifecycle', value: 'retired' })],
      }),
      makeEvent(2, 2, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'lifecycle', value: 'active' })],
      }),
    ];
    const sourceError = catchConfigError(() => sourceApplicatorRun(events));
    const replayError = catchConfigError(() => replay(events));
    expect(sourceError.message).toBe(replayError.message);
    expect(sourceError.message).toContain('Invalid lifecycle transition retired → active');
    expect(sourceError.context.phase).toBe('source');
    expect(replayError.context.phase).toBe('replay');
  });

  it('activation timing: phase-source applicator vs replay', () => {
    const events = [
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'status', value: 'alive' })],
      }),
    ];
    const sourceError = catchConfigError(() => sourceApplicatorRun(events));
    const replayError = catchConfigError(() => replay(events));
    expect(sourceError.message).toBe(replayError.message);
    expect(sourceError.message).toContain('can only be activated by introduction transition');
    expect(sourceError.context.phase).toBe('source');
    expect(replayError.context.phase).toBe('replay');
  });
});

// ============================================================================
// Entity lifecycle — allowed transitions and domain-write independence
// ============================================================================

describe('entity lifecycle transitions', () => {
  it('activates an event-introduced entity with lifecycle active and required fields', () => {
    const state = replay([heroActivation(), makeEvent(1, 1, { postconditions: [] })]);
    expect(state.entities.hero?.lifecycle).toBe('active');
    expect(state.entities.hero?.name).toBe('Aragorn');
    expect(state.entities.hero?.status).toBe('alive');
  });

  it('active → inactive → active round trip', () => {
    const events = [
      heroActivation(),
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'lifecycle', value: 'inactive' })],
      }),
      makeEvent(2, 2, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'lifecycle', value: 'active' })],
      }),
    ];
    const state = replay(events);
    expect(state.entities.hero?.lifecycle).toBe('active');
    expect(state.entities.hero?.status).toBe('alive');
  });

  it('inactive entities retain their state', () => {
    const events = [
      heroActivation(),
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'lifecycle', value: 'inactive' })],
      }),
    ];
    const state = replay(events);
    expect(state.entities.hero?.lifecycle).toBe('inactive');
    expect(state.entities.hero?.name).toBe('Aragorn');
  });

  it('active → retired is allowed and terminal', () => {
    const events = [
      heroActivation(),
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'lifecycle', value: 'retired' })],
      }),
    ];
    const state = replay(events);
    expect(state.entities.hero?.lifecycle).toBe('retired');
  });

  it('inactive → retired is allowed', () => {
    const events = [
      heroActivation(),
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'lifecycle', value: 'inactive' })],
      }),
      makeEvent(2, 2, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'lifecycle', value: 'retired' })],
      }),
    ];
    const state = replay(events);
    expect(state.entities.hero?.lifecycle).toBe('retired');
  });

  it('domain writes (e.g. status: dead) do not touch lifecycle', () => {
    const events = [
      heroActivation(),
      makeEvent(1, 1, {
        postconditions: [makeFact({ entityId: 'hero', attribute: 'status', value: 'dead' })],
      }),
    ];
    const state = replay(events);
    expect(state.entities.hero?.status).toBe('dead');
    expect(state.entities.hero?.lifecycle).toBe('active');
  });
});

// ============================================================================
// Story-boundary integration — catalogs are the required 4th argument
// ============================================================================

describe('story-boundaries integration', () => {
  /**
   * Run compileStoryBoundaries with an adjacency map derived from
   * causalPredecessors (the kernel wires its introduction transitions the
   * same way: transition → target event → successors).
   */
  function boundaryRun(events: NarrativeEvent[]): StoryBoundaries {
    const adjacency = new Map<string, string[]>();
    for (const event of events) {
      for (const pred of event.causalPredecessors ?? []) {
        const deps = adjacency.get(pred) ?? [];
        deps.push(event.id);
        adjacency.set(pred, deps);
      }
    }
    return compileStoryBoundaries(events, [], adjacency, CATALOG_CONTEXT);
  }

  it('compileStoryBoundaries applies lifecycle transitions with the catalog context', () => {
    const events = [
      heroActivation(),
      makeEvent(1, 1, {
        causalPredecessors: ['system:introduction:E1:hero'],
        postconditions: [makeFact({ entityId: 'hero', attribute: 'lifecycle', value: 'inactive' })],
      }),
    ];
    const result = boundaryRun(events);
    expect(result.finalState.entities.hero?.lifecycle).toBe('inactive');
    expect(result.finalState.entities.hero?.status).toBe('alive');
  });

  it('produces identical lifecycle state to ReplayEngine for introduce/retire sequences', () => {
    const events = [
      heroActivation(),
      makeEvent(1, 1, {
        id: 'E_intro',
        causalPredecessors: ['system:introduction:E1:hero'],
        postconditions: [makeFact({ entityId: 'hero', attribute: 'status', value: 'alive' })],
      }),
      makeEvent(2, 2, {
        id: 'E_retire',
        causalPredecessors: ['E_intro'],
        postconditions: [makeFact({ entityId: 'hero', attribute: 'lifecycle', value: 'retired' })],
      }),
    ];
    const boundary = boundaryRun(events);
    const engineState = replay(events);
    expect(boundary.finalState.entities.hero?.lifecycle).toBe('retired');
    expect(engineState.entities.hero?.lifecycle).toBe('retired');
    expect(boundary.finalState.entities.hero).toEqual(engineState.entities.hero);
  });

  it('rejects retired-entity modification identically in both paths', () => {
    const events = [
      heroActivation(),
      makeEvent(1, 1, {
        id: 'E_retire',
        causalPredecessors: ['system:introduction:E1:hero'],
        postconditions: [makeFact({ entityId: 'hero', attribute: 'lifecycle', value: 'retired' })],
      }),
      makeEvent(2, 2, {
        id: 'E_modify',
        causalPredecessors: ['E_retire'],
        postconditions: [makeFact({ entityId: 'hero', attribute: 'status', value: 'dead' })],
      }),
    ];
    const boundaryError = catchConfigError(() => boundaryRun(events));
    const replayError = catchConfigError(() => replay(events));
    expect(boundaryError.message).toBe(replayError.message);
    expect(boundaryError.message).toContain('Cannot modify retired entity "hero"');
  });
});
