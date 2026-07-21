// ============================================================================
// entity-lifecycle.test.ts — Replay lifecycle transitions: introduce/retire,
// active↔inactive, terminal enforcement, same-storyTime conflicts.
// ============================================================================

import { describe, it, expect } from 'vitest';
import { compileStoryBoundaries } from '../../src/state/story-boundaries.js';
import { ReplayEngine } from '../../src/state/replay.js';
import { ConfigError } from '../../src/errors.js';
import type { NarrativeEvent, Fact, EntityDeclarationCatalog, EntityTypeCatalog } from '../../src/types/index.js';

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
    id: `E_${narrativeOrder}`,
    event: `E_${narrativeOrder}`,
    narrativeOrder,
    title: 'Test',
    storyTime: { type: 'absolute' as const, value: `day_${daySuffix}` },
    sceneType: 'linear',
    pov: { character: 'narrator' as const, type: 'first_person' as const },
    sceneBrief: 'Test scene',
    branchExistence: { type: 'all' as const },
    preconditions: [],
    postconditions: [],
    threadProgress: [],
    relationshipEffects: [],
    ruleEffects: [],
    source: 'event_file',
    participants: { entities: [] },
    ...overrides,
  };
}

// ─── Mock declaration catalog ────────────────────────────────────────────────

const mockDeclarationCatalog: EntityDeclarationCatalog = {
  declarations: {
    hero: { entityId: 'hero', typeRef: { typeId: 'character', schemaVersion: 1 }, immutableMetadata: { name: 'Hero', definitionFile: 'hero.yaml' } },
    sidekick: { entityId: 'sidekick', typeRef: { typeId: 'character', schemaVersion: 1 }, immutableMetadata: { name: 'Sidekick', definitionFile: 'sidekick.yaml' } },
    world: { entityId: 'world', typeRef: { typeId: 'location', schemaVersion: 1 }, immutableMetadata: { name: 'World', definitionFile: 'world.yaml' } },
    sword: { entityId: 'sword', typeRef: { typeId: 'item', schemaVersion: 1 }, immutableMetadata: { name: 'Sword', definitionFile: 'sword.yaml' } },
  },
  version: 1,
};

const mockTypeCatalog: EntityTypeCatalog = {
  types: {
    character: {
      typeRef: { typeId: 'character', schemaVersion: 1 },
      kind: 'character',
      attributes: {},
      lifecyclePolicy: {
        allowedTransitions: [
          ['active', 'inactive'],
          ['active', 'retired'],
          ['inactive', 'active'],
          ['inactive', 'retired'],
        ],
      },
      referenceCapabilities: { defaultEligibility: 'live' },
      typedInvariants: [],
    },
    location: {
      typeRef: { typeId: 'location', schemaVersion: 1 },
      kind: 'location',
      attributes: {},
      lifecyclePolicy: {
        allowedTransitions: [
          ['active', 'inactive'],
          ['active', 'retired'],
          ['inactive', 'active'],
          ['inactive', 'retired'],
        ],
      },
      referenceCapabilities: { defaultEligibility: 'live' },
      typedInvariants: [],
    },
    item: {
      typeRef: { typeId: 'item', schemaVersion: 1 },
      kind: 'item',
      attributes: {},
      lifecyclePolicy: {
        allowedTransitions: [
          ['active', 'inactive'],
          ['active', 'retired'],
          ['inactive', 'active'],
          ['inactive', 'retired'],
        ],
      },
      referenceCapabilities: { defaultEligibility: 'live' },
      typedInvariants: [],
    },
  },
  version: 1,
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Entity lifecycle — introduce', () => {
  it('introduce creates entity with lifecycle:active and applies writes', () => {
    const engine = new ReplayEngine({ entityDeclarationCatalog: mockDeclarationCatalog, entityTypeCatalog: mockTypeCatalog });
    const events: NarrativeEvent[] = [
      makeEvent(1, 1, {
        postconditions: [
          makeFact({ entityId: 'hero', attribute: 'status', value: 'alive' }),
          makeFact({ entityId: 'hero', attribute: 'name', value: 'Aragorn' }),
        ],
      }),
    ];
    const state = engine.replay(events);
    expect(state.entities['hero']?.lifecycle).toBe('active');
    expect(state.entities['hero']?.status).toBe('alive');
    expect(state.entities['hero']?.name).toBe('Aragorn');
  });

  it('introduce unknown entity (not in catalog) throws ConfigError', () => {
    const engine = new ReplayEngine({ entityDeclarationCatalog: mockDeclarationCatalog, entityTypeCatalog: mockTypeCatalog });
    const events: NarrativeEvent[] = [
      makeEvent(1, 1, {
        postconditions: [
          makeFact({ entityId: 'unknown_entity', attribute: 'status', value: 'present' }),
        ],
      }),
    ];
    expect(() => engine.replay(events)).toThrow(ConfigError);
  });

  it('auto-creates entity without catalog (backward compat)', () => {
    const engine = new ReplayEngine();
    const events: NarrativeEvent[] = [
      makeEvent(1, 1, {
        postconditions: [
          makeFact({ entityId: 'any_entity', attribute: 'color', value: 'blue' }),
        ],
      }),
    ];
    const state = engine.replay(events);
    expect(state.entities['any_entity']?.lifecycle).toBe('active');
    expect(state.entities['any_entity']?.color).toBe('blue');
  });

  it('introduce + multiple writes in same event are atomic', () => {
    const engine = new ReplayEngine({ entityDeclarationCatalog: mockDeclarationCatalog, entityTypeCatalog: mockTypeCatalog });
    const events: NarrativeEvent[] = [
      makeEvent(1, 1, {
        postconditions: [
          makeFact({ entityId: 'sword', attribute: 'name', value: 'Narsil' }),
          makeFact({ entityId: 'sword', attribute: 'durability', value: 100 }),
        ],
      }),
    ];
    const state = engine.replay(events);
    expect(state.entities['sword']?.lifecycle).toBe('active');
    expect(state.entities['sword']?.name).toBe('Narsil');
    expect(state.entities['sword']?.durability).toBe(100);
  });
});

describe('Entity lifecycle — active ↔ inactive', () => {
  it('active→inactive→active round trip', () => {
    const engine = new ReplayEngine({ entityDeclarationCatalog: mockDeclarationCatalog, entityTypeCatalog: mockTypeCatalog });
    const events: NarrativeEvent[] = [
      makeEvent(1, 1, {
        postconditions: [
          makeFact({ entityId: 'hero', attribute: 'status', value: 'alive' }),
        ],
      }),
      makeEvent(2, 2, {
        postconditions: [
          makeFact({ entityId: 'hero', attribute: 'lifecycle', value: 'inactive' }),
        ],
      }),
      makeEvent(3, 3, {
        postconditions: [
          makeFact({ entityId: 'hero', attribute: 'lifecycle', value: 'active' }),
        ],
      }),
    ];
    const state = engine.replay(events);
    expect(state.entities['hero']?.lifecycle).toBe('active');
    expect(state.entities['hero']?.status).toBe('alive');
  });

  it('inactive entities retain state', () => {
    const engine = new ReplayEngine({ entityDeclarationCatalog: mockDeclarationCatalog, entityTypeCatalog: mockTypeCatalog });
    const events: NarrativeEvent[] = [
      makeEvent(1, 1, {
        postconditions: [
          makeFact({ entityId: 'hero', attribute: 'name', value: 'Aragorn' }),
          makeFact({ entityId: 'hero', attribute: 'lifecycle', value: 'inactive' }),
        ],
      }),
    ];
    const state = engine.replay(events);
    expect(state.entities['hero']?.lifecycle).toBe('inactive');
    expect(state.entities['hero']?.name).toBe('Aragorn');
  });
});

describe('Entity lifecycle — retire (terminal)', () => {
  it('active→retired is allowed', () => {
    const engine = new ReplayEngine({ entityDeclarationCatalog: mockDeclarationCatalog, entityTypeCatalog: mockTypeCatalog });
    const events: NarrativeEvent[] = [
      makeEvent(1, 1, {
        postconditions: [
          makeFact({ entityId: 'hero', attribute: 'lifecycle', value: 'retired' }),
        ],
      }),
    ];
    const state = engine.replay(events);
    expect(state.entities['hero']?.lifecycle).toBe('retired');
  });

  it('inactive→retired is allowed', () => {
    const engine = new ReplayEngine({ entityDeclarationCatalog: mockDeclarationCatalog, entityTypeCatalog: mockTypeCatalog });
    const events: NarrativeEvent[] = [
      makeEvent(1, 1, {
        postconditions: [
          makeFact({ entityId: 'hero', attribute: 'lifecycle', value: 'inactive' }),
        ],
      }),
      makeEvent(2, 2, {
        postconditions: [
          makeFact({ entityId: 'hero', attribute: 'lifecycle', value: 'retired' }),
        ],
      }),
    ];
    const state = engine.replay(events);
    expect(state.entities['hero']?.lifecycle).toBe('retired');
  });

  it('retired→active throws ConfigError (terminal)', () => {
    const engine = new ReplayEngine({ entityDeclarationCatalog: mockDeclarationCatalog, entityTypeCatalog: mockTypeCatalog });
    const events: NarrativeEvent[] = [
      makeEvent(1, 1, {
        postconditions: [
          makeFact({ entityId: 'hero', attribute: 'lifecycle', value: 'retired' }),
        ],
      }),
      makeEvent(2, 2, {
        postconditions: [
          makeFact({ entityId: 'hero', attribute: 'lifecycle', value: 'active' }),
        ],
      }),
    ];
    expect(() => engine.replay(events)).toThrow(ConfigError);
  });

  it('retired→inactive throws ConfigError (terminal)', () => {
    const engine = new ReplayEngine({ entityDeclarationCatalog: mockDeclarationCatalog, entityTypeCatalog: mockTypeCatalog });
    const events: NarrativeEvent[] = [
      makeEvent(1, 1, {
        postconditions: [
          makeFact({ entityId: 'hero', attribute: 'lifecycle', value: 'retired' }),
        ],
      }),
      makeEvent(2, 2, {
        postconditions: [
          makeFact({ entityId: 'hero', attribute: 'lifecycle', value: 'inactive' }),
        ],
      }),
    ];
    expect(() => engine.replay(events)).toThrow(ConfigError);
  });

  it('write to retired entity throws ConfigError', () => {
    const engine = new ReplayEngine({ entityDeclarationCatalog: mockDeclarationCatalog, entityTypeCatalog: mockTypeCatalog });
    const events: NarrativeEvent[] = [
      makeEvent(1, 1, {
        postconditions: [
          makeFact({ entityId: 'hero', attribute: 'lifecycle', value: 'retired' }),
        ],
      }),
      makeEvent(2, 2, {
        postconditions: [
          makeFact({ entityId: 'hero', attribute: 'status', value: 'gone' }),
        ],
      }),
    ];
    expect(() => engine.replay(events)).toThrow(ConfigError);
  });

  it('lifecycle write to retired entity also throws (not an escape hatch for unretire)', () => {
    const engine = new ReplayEngine({ entityDeclarationCatalog: mockDeclarationCatalog, entityTypeCatalog: mockTypeCatalog });
    const events: NarrativeEvent[] = [
      makeEvent(1, 1, {
        postconditions: [
          makeFact({ entityId: 'hero', attribute: 'lifecycle', value: 'retired' }),
        ],
      }),
      makeEvent(2, 2, {
        postconditions: [
          // Trying to change lifecycle on a retired entity — should fall through
          // to the transition validator (which blocks retired→anything)
          makeFact({ entityId: 'hero', attribute: 'lifecycle', value: 'active' }),
        ],
      }),
    ];
    expect(() => engine.replay(events)).toThrow(ConfigError);
  });
});

describe('Entity lifecycle — invalid transitions', () => {
  it('nonexistent lifecycle value passes through as regular attribute', () => {
    const engine = new ReplayEngine();
    const events: NarrativeEvent[] = [
      makeEvent(1, 1, {
        postconditions: [
          makeFact({ entityId: 'hero', attribute: 'lifecycle', value: 'some_weird_state' }),
        ],
      }),
    ];
    // Not a valid lifecycle state, so it's treated as a regular attribute write
    const state = engine.replay(events);
    expect(state.entities['hero']?.lifecycle).toBe('some_weird_state');
  });
});

describe('Entity lifecycle — unset lifecycle', () => {
  it('unset lifecycle throws ConfigError', () => {
    const engine = new ReplayEngine();
    const events: NarrativeEvent[] = [
      makeEvent(1, 1, {
        postconditions: [
          makeFact({ entityId: 'hero', attribute: 'lifecycle', value: 'active' }),
        ],
      }),
      makeEvent(2, 2, {
        postconditions: [
          makeFact({ entityId: 'hero', attribute: 'lifecycle', operation: 'unset' }),
        ],
      }),
    ];
    expect(() => engine.replay(events)).toThrow(ConfigError);
  });
});

describe('Entity lifecycle — same storyTime conflict', () => {
  it('two events at same storyTime changing same entity lifecycle throws ConfigError', () => {
    const engine = new ReplayEngine({ entityDeclarationCatalog: mockDeclarationCatalog, entityTypeCatalog: mockTypeCatalog });
    const events: NarrativeEvent[] = [
      makeEvent(1, 1, {
        storyTime: { type: 'absolute', value: 'day_1' },
        postconditions: [
          makeFact({ entityId: 'hero', attribute: 'lifecycle', value: 'inactive' }),
        ],
      }),
      makeEvent(2, 1, {
        storyTime: { type: 'absolute', value: 'day_1' },
        postconditions: [
          makeFact({ entityId: 'hero', attribute: 'lifecycle', value: 'active' }),
        ],
      }),
    ];
    expect(() => engine.replay(events)).toThrow(ConfigError);
  });

  it('same storyTime, different entity lifecycle changes are allowed', () => {
    const engine = new ReplayEngine({ entityDeclarationCatalog: mockDeclarationCatalog, entityTypeCatalog: mockTypeCatalog });
    const events: NarrativeEvent[] = [
      makeEvent(1, 1, {
        storyTime: { type: 'absolute', value: 'day_1' },
        postconditions: [
          makeFact({ entityId: 'hero', attribute: 'lifecycle', value: 'inactive' }),
        ],
      }),
      makeEvent(2, 1, {
        storyTime: { type: 'absolute', value: 'day_1' },
        postconditions: [
          makeFact({ entityId: 'sidekick', attribute: 'lifecycle', value: 'inactive' }),
        ],
      }),
    ];
    const state = engine.replay(events);
    expect(state.entities['hero']?.lifecycle).toBe('inactive');
    expect(state.entities['sidekick']?.lifecycle).toBe('inactive');
  });

  it('different storyTime, same entity allowed', () => {
    const engine = new ReplayEngine();
    const events: NarrativeEvent[] = [
      makeEvent(1, 1, {
        storyTime: { type: 'absolute', value: 'day_1' },
        postconditions: [
          makeFact({ entityId: 'hero', attribute: 'lifecycle', value: 'inactive' }),
        ],
      }),
      makeEvent(2, 2, {
        storyTime: { type: 'absolute', value: 'day_2' },
        postconditions: [
          makeFact({ entityId: 'hero', attribute: 'lifecycle', value: 'active' }),
        ],
      }),
    ];
    const state = engine.replay(events);
    expect(state.entities['hero']?.lifecycle).toBe('active');
  });
});

describe('Entity lifecycle — death domain state vs retire', () => {
  it('character death writes lifeStatus:dead but lifecycle stays active', () => {
    const engine = new ReplayEngine({ entityDeclarationCatalog: mockDeclarationCatalog, entityTypeCatalog: mockTypeCatalog });
    const events: NarrativeEvent[] = [
      makeEvent(1, 1, {
        postconditions: [
          makeFact({ entityId: 'hero', attribute: 'lifeStatus', value: 'dead' }),
        ],
      }),
    ];
    const state = engine.replay(events);
    expect(state.entities['hero']?.lifeStatus).toBe('dead');
    // Lifecycle defaults to active on introduction
    expect(state.entities['hero']?.lifecycle).toBe('active');
  });

  it('death via status domain state does not trigger lifecycle transition', () => {
    const engine = new ReplayEngine();
    const events: NarrativeEvent[] = [
      makeEvent(1, 1, {
        postconditions: [
          makeFact({ entityId: 'hero', attribute: 'status', value: 'dead' }),
        ],
      }),
    ];
    const state = engine.replay(events);
    // status:dead is a regular domain attribute, not lifecycle
    expect(state.entities['hero']?.status).toBe('dead');
    expect(state.entities['hero']?.lifecycle).toBe('active');
  });

  it('retire is only for permanent departure - explicit lifecycle:retired', () => {
    const engine = new ReplayEngine({ entityDeclarationCatalog: mockDeclarationCatalog, entityTypeCatalog: mockTypeCatalog });
    const events: NarrativeEvent[] = [
      makeEvent(1, 1, {
        postconditions: [
          makeFact({ entityId: 'hero', attribute: 'lifecycle', value: 'retired' }),
        ],
      }),
    ];
    const state = engine.replay(events);
    expect(state.entities['hero']?.lifecycle).toBe('retired');
  });
});

describe('Entity lifecycle — participant check', () => {
  it('retired entity participating in event throws ConfigError', () => {
    const engine = new ReplayEngine({ entityDeclarationCatalog: mockDeclarationCatalog, entityTypeCatalog: mockTypeCatalog });
    const events: NarrativeEvent[] = [
      makeEvent(1, 1, {
        postconditions: [
          makeFact({ entityId: 'hero', attribute: 'lifecycle', value: 'retired' }),
        ],
      }),
      makeEvent(2, 2, {
        participants: { entities: ['hero'] },
        postconditions: [
          makeFact({ entityId: 'sidekick', attribute: 'status', value: 'present' }),
        ],
      }),
    ];
    expect(() => engine.replay(events)).toThrow(ConfigError);
  });


  it('active entity participating is allowed', () => {
    const engine = new ReplayEngine({ entityDeclarationCatalog: mockDeclarationCatalog, entityTypeCatalog: mockTypeCatalog });
    const events: NarrativeEvent[] = [
      makeEvent(1, 1, {
        participants: { entities: ['hero'] },
        postconditions: [
          makeFact({ entityId: 'hero', attribute: 'status', value: 'alive' }),
        ],
      }),
    ];
    const state = engine.replay(events);
    expect(state.entities['hero']?.lifecycle).toBe('active');
  });

  it('inactive entity participating is allowed', () => {
    const engine = new ReplayEngine({ entityDeclarationCatalog: mockDeclarationCatalog, entityTypeCatalog: mockTypeCatalog });
    const events: NarrativeEvent[] = [
      makeEvent(1, 1, {
        postconditions: [
          makeFact({ entityId: 'hero', attribute: 'lifecycle', value: 'inactive' }),
        ],
      }),
      makeEvent(2, 2, {
        participants: { entities: ['hero'] },
        postconditions: [
          makeFact({ entityId: 'sidekick', attribute: 'status', value: 'present' }),
        ],
      }),
    ];
    const state = engine.replay(events);
    expect(state.entities['hero']?.lifecycle).toBe('inactive');
  });
});

describe('Entity lifecycle — story-boundaries integration', () => {
  it('compileStoryBoundaries handles lifecycle transitions', () => {
    // Using imported compileStoryBoundaries (top-level import)
    const events: NarrativeEvent[] = [
      makeEvent(1, 1, {
        postconditions: [
          makeFact({ entityId: 'hero', attribute: 'lifecycle', value: 'inactive' }),
        ],
      }),
    ];
    const result = compileStoryBoundaries(events, [
      { id: 'init.status', entityId: 'hero', attribute: 'status', value: 'alive', validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } } },
    ], new Map());
    expect(result.finalState.entities['hero']?.lifecycle).toBe('inactive');
    expect(result.finalState.entities['hero']?.status).toBe('alive');
  });
});
