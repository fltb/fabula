// ============================================================================
// Catalog-Driven Validator Checks (STATE-3b)
// ============================================================================
// Verifies:
// 1. Catalog helper functions return correct values
// 2. World-rule validator does NOT flag marital_status changes (mutable/lifecycle)
// 3. World-rule validator DOES flag immutable attribute changes (e.g. gender)
// 4. Character-state validator uses semanticRole: 'lifecycle' to detect dead chars
//
// Every validator input carries an explicit compiled entityTypeCatalog — no
// built-in/default catalog, no fallback (helpers return undefined without one).
// ============================================================================

import { describe, expect, it } from 'vitest';
import { compileEntityTypeCatalog } from '../../src/entity/entity-catalog-compiler.js';
import type {
  AttributeDefinitionSource,
  Entity,
  EntityKind,
  EntityRegistry,
  EntityTypeCatalog,
  EntityTypeCatalogSource,
  EntityTypeDefinitionSource,
  NarrativeEvent,
  PreRenderInput,
} from '../../src/types/index.js';
import {
  getAttributeSemanticRole,
  getAttributesBySemanticRole,
  getAttributeWritePolicy,
} from '../../src/validator/base.js';
import { CharacterStateValidator } from '../../src/validator/character-state.js';
import { WorldRuleValidator } from '../../src/validator/world-rule.js';

// ─── Explicit compiled catalog (mirrors the removed built-in default) ───────

function sourceAttr(
  attributeId: string,
  overrides?: Partial<AttributeDefinitionSource>,
): AttributeDefinitionSource {
  return {
    attributeId,
    valueType: 'string',
    requiredAt: 'never',
    writePolicy: 'mutable',
    unsetAllowed: true,
    ...overrides,
  };
}

function immutableSourceAttr(
  attributeId: string,
  overrides?: Partial<AttributeDefinitionSource>,
): AttributeDefinitionSource {
  return sourceAttr(attributeId, { writePolicy: 'immutable', ...overrides });
}

const CHARACTER_SOURCE: EntityTypeDefinitionSource = {
  typeId: 'character',
  kind: 'character',
  attributes: {
    // Identity (immutable)
    gender: immutableSourceAttr('gender', { semanticRole: 'identity' }),
    // Lifecycle (mutable)
    lifeStatus: sourceAttr('lifeStatus', { semanticRole: 'lifecycle' }),
    status: sourceAttr('status', { semanticRole: 'lifecycle' }),
    alive: sourceAttr('alive', { valueType: 'boolean', semanticRole: 'lifecycle' }),
    marital_status: sourceAttr('marital_status', { semanticRole: 'lifecycle' }),
    character_state: sourceAttr('character_state', { semanticRole: 'lifecycle' }),
    // Identity/Profile (mutable)
    age: sourceAttr('age', { semanticRole: 'identity' }),
    profession: sourceAttr('profession', { semanticRole: 'identity' }),
    traits: sourceAttr('traits', { valueType: 'string_list', semanticRole: 'identity' }),
    aliases: sourceAttr('aliases', { valueType: 'string_list', semanticRole: 'identity' }),
    appearance: sourceAttr('appearance', { semanticRole: 'appearance' }),
    // Location
    location: sourceAttr('location', { semanticRole: 'location' }),
    // Emotional
    mood: sourceAttr('mood', { semanticRole: 'emotional' }),
    // Knowledge
    knows: sourceAttr('knows', { semanticRole: 'knowledge' }),
    // Narrative
    pov: sourceAttr('pov', { semanticRole: 'narrative' }),
    pronoun: sourceAttr('pronoun', { semanticRole: 'narrative' }),
    pronoun_consistency: sourceAttr('pronoun_consistency', { semanticRole: 'narrative' }),
    'voice_*': sourceAttr('voice_*', { semanticRole: 'narrative' }),
    pacing: sourceAttr('pacing', { semanticRole: 'narrative' }),
    discourse_balance: sourceAttr('discourse_balance', { semanticRole: 'narrative' }),
    discourseMode: sourceAttr('discourseMode', { semanticRole: 'narrative' }),
  },
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
};

const CATALOG_SOURCE: EntityTypeCatalogSource = {
  types: { character: CHARACTER_SOURCE },
};

/** Compiled fresh — no shared Zod schema instances, no default fallback. */
const CATALOG: EntityTypeCatalog = compileEntityTypeCatalog(CATALOG_SOURCE);

// ─── Helpers ───

function makeEntity(kind: EntityKind, state: Record<string, unknown> = {}): Entity {
  return {
    id: 'char_test_' + kind,
    kind,
    name: 'Test ' + kind,
    definitionFile: `/definitions/${kind}s/test.yml`,
    lifecycle: 'active',
    typeRef: { typeId: kind, schemaVersion: 1 },
    state,
  };
}

function makeRegistry(entities: Entity[]): EntityRegistry {
  const map = new Map<string, Entity>();
  for (const e of entities) map.set(e.id, e);
  return {
    load: () => {},
    resolve: (id: string) => map.get(id) ?? null,
    findByKind: (kind: EntityKind) => entities.filter((e) => e.kind === kind),
    findByAttribute: () => [],
    resolveRefs: () => new Map(),
    register: (e: Entity) => {
      map.set(e.id, e);
    },
    updateState: () => {},
    getAll: () => entities,
  };
}

function makeEvent(overrides: Partial<NarrativeEvent> & { id: string }): NarrativeEvent {
  return {
    event: overrides.id,
    narrativeOrder: 1,
    title: 'Test Scene',
    storyTime: { type: 'relative', anchor: 'day_1', offset: 0 },
    sceneType: 'linear',
    pov: { character: 'char_hero', type: 'third_person_limited' },
    sceneBrief: 'A test scene.',
    beats: ['A test scene.'],
    preconditions: [],
    postconditions: [],
    threadProgress: [],
    foreshadowing: [],
    relationshipEffects: [],
    ruleEffects: [],
    source: 'event_file',
    branchExistence: { type: 'all' },
    participants: { entities: [] },
    ...overrides,
  };
}

function makeInput(overrides: Partial<PreRenderInput>): PreRenderInput {
  return {
    event: makeEvent({ id: 'E0' }),
    worldState: {
      entities: {},
      relationships: {},
      knowledge: {},
      threads: {},
      rules: {},
      facts: [],
    },
    events: [],
    entities: makeRegistry([]),
    entityTypeCatalog: CATALOG,
    chapter: 1,
    queryState: () => undefined,
    getKnowledge: () => ({
      worldTruth: [],
      characterKnowledge: {},
      readerKnowledge: [],
      narratorKnowledge: [],
    }),
    getThreadProgress: () => null,
    ...overrides,
  };
}

// ─── Tests ───

describe('Catalog helpers', () => {
  it('getAttributeSemanticRole returns correct role for known attributes', () => {
    expect(getAttributeSemanticRole(CATALOG, 'character', 'marital_status')).toBe('lifecycle');
    expect(getAttributeSemanticRole(CATALOG, 'character', 'gender')).toBe('identity');
    expect(getAttributeSemanticRole(CATALOG, 'character', 'location')).toBe('location');
    expect(getAttributeSemanticRole(CATALOG, 'character', 'knows')).toBe('knowledge');
    expect(getAttributeSemanticRole(CATALOG, 'character', 'mood')).toBe('emotional');
    expect(getAttributeSemanticRole(CATALOG, 'character', 'pronoun')).toBe('narrative');
    expect(getAttributeSemanticRole(CATALOG, 'character', 'appearance')).toBe('appearance');
    expect(getAttributeSemanticRole(CATALOG, 'character', 'time_period')).toBeUndefined();
  });

  it('getAttributeWritePolicy returns correct write policy', () => {
    expect(getAttributeWritePolicy(CATALOG, 'character', 'marital_status')).toBe('mutable');
    expect(getAttributeWritePolicy(CATALOG, 'character', 'gender')).toBe('immutable');
    expect(getAttributeWritePolicy(CATALOG, 'character', 'location')).toBe('mutable');
    expect(getAttributeWritePolicy(CATALOG, 'character', 'lifeStatus')).toBe('mutable');
  });

  it('getAttributesBySemanticRole returns attribute IDs for a role', () => {
    const lifecycleAttrs = getAttributesBySemanticRole(CATALOG, 'character', 'lifecycle');
    expect(lifecycleAttrs).toContain('marital_status');
    expect(lifecycleAttrs).toContain('status');
    expect(lifecycleAttrs).toContain('alive');
    expect(lifecycleAttrs).toContain('character_state');

    const identityAttrs = getAttributesBySemanticRole(CATALOG, 'character', 'identity');
    expect(identityAttrs).toContain('gender');
    expect(identityAttrs).toContain('traits');
    expect(identityAttrs).toContain('aliases');

    const narrativeAttrs = getAttributesBySemanticRole(CATALOG, 'character', 'narrative');
    expect(narrativeAttrs).toContain('pronoun');
    expect(narrativeAttrs).toContain('pacing');

    const locationAttrs = getAttributesBySemanticRole(CATALOG, 'character', 'location');
    expect(locationAttrs).toContain('location');
  });

  it('returns undefined for unknown kind', () => {
    expect(getAttributeSemanticRole(CATALOG, 'unknown_kind' as EntityKind, 'test')).toBeUndefined();
    expect(getAttributeWritePolicy(CATALOG, 'unknown_kind' as EntityKind, 'test')).toBeUndefined();
    expect(getAttributesBySemanticRole(CATALOG, 'unknown_kind' as EntityKind, 'test')).toEqual([]);
  });

  it('returns undefined when no catalog is supplied (no default fallback)', () => {
    expect(getAttributeSemanticRole(undefined, 'character', 'gender')).toBeUndefined();
    expect(getAttributeWritePolicy(undefined, 'character', 'gender')).toBeUndefined();
    expect(getAttributesBySemanticRole(undefined, 'character', 'identity')).toEqual([]);
  });
});

describe('WorldRuleValidator — catalog-driven immutable check (zhu-fu fix)', () => {
  const validator = new WorldRuleValidator();

  it('does NOT flag marital_status changes (mutable/lifecycle) — THE zhu-fu fix', () => {
    // Character with marital_status='widowed' in registry initial state
    const charEntity = makeEntity('character', {
      name: 'Zhu Fu',
      marital_status: 'widowed',
      gender: 'female',
    });
    const registry = makeRegistry([charEntity]);

    // Event that changes marital_status to 'remarried'
    const event = makeEvent({
      id: 'E1',
      postconditions: [
        {
          id: 'F1',
          entityId: charEntity.id,
          attribute: 'marital_status',
          value: 'remarried',
          validity: {
            temporal: { start: { type: 'absolute', value: 'day_0' }, end: null },
            branches: { type: 'all' },
          },
        },
      ],
    });

    const input = makeInput({ event, events: [event], entities: registry });

    const issues = validator.validatePre(input);
    // marital_status is mutable/lifecycle — changing it is NOT a world rule violation
    expect(issues.filter((i) => i.validator === 'world_rule')).toHaveLength(0);
  });

  it('DOES flag immutable attribute changes (e.g. gender)', () => {
    const charEntity = makeEntity('character', {
      name: 'Test Char',
      gender: 'female',
    });
    const registry = makeRegistry([charEntity]);

    const event = makeEvent({
      id: 'E2',
      postconditions: [
        {
          id: 'F2',
          entityId: charEntity.id,
          attribute: 'gender',
          value: 'male',
          validity: {
            temporal: { start: { type: 'absolute', value: 'day_0' }, end: null },
            branches: { type: 'all' },
          },
        },
      ],
    });

    const input = makeInput({ event, events: [event], entities: registry });

    const issues = validator.validatePre(input);
    // gender is immutable — changing it IS a world rule violation
    expect(issues.filter((i) => i.validator === 'world_rule')).toHaveLength(1);
    expect(issues[0].attribute).toBe('gender');
  });

  it('does NOT flag changes for unknown attributes or entities', () => {
    // Entity without marital_status or gender in state
    const charEntity = makeEntity('character', { name: 'Test' });
    const registry = makeRegistry([charEntity]);

    const event = makeEvent({
      id: 'E3',
      postconditions: [
        {
          id: 'F3',
          entityId: charEntity.id,
          attribute: 'unknown_attr',
          value: 'some_value',
          validity: {
            temporal: { start: { type: 'absolute', value: 'day_0' }, end: null },
            branches: { type: 'all' },
          },
        },
      ],
    });

    const input = makeInput({ event, events: [event], entities: registry });

    const issues = validator.validatePre(input);
    expect(issues.filter((i) => i.validator === 'world_rule')).toHaveLength(0);
  });
});

describe('CharacterStateValidator — catalog-driven lifecycle check', () => {
  const validator = new CharacterStateValidator();

  it('detects dead character via lifecycle attribute (status = dead)', () => {
    const charEntity = makeEntity('character', { name: 'Dead Char' });
    const registry = makeRegistry([charEntity]);

    const event = makeEvent({
      id: 'E4',
      preconditions: [
        {
          id: 'F4',
          entityId: charEntity.id,
          attribute: 'status',
          value: 'some_value',
          validity: {
            temporal: { start: { type: 'absolute', value: 'day_0' }, end: null },
            branches: { type: 'all' },
          },
        },
      ],
    });

    const worldState = {
      entities: { [charEntity.id]: { status: 'dead' } },
      relationships: {},
      knowledge: {},
      threads: {},
      rules: {},
      facts: [],
    };

    const input = makeInput({
      event,
      worldState,
      events: [event],
      entities: registry,
      queryState: (id: string, attr: string) => worldState.entities[id]?.[attr],
    });

    const issues = validator.validatePre(input);
    expect(issues.filter((i) => i.validator === 'character_state')).toHaveLength(1);
    expect(issues[0].message).toContain('is dead');
  });

  it('detects dead character via lifecycle attribute (alive = false)', () => {
    const charEntity = makeEntity('character', { name: 'Deceased Char' });
    const registry = makeRegistry([charEntity]);

    const event = makeEvent({
      id: 'E5',
      preconditions: [
        {
          id: 'F5',
          entityId: charEntity.id,
          attribute: 'alive',
          value: false,
          validity: {
            temporal: { start: { type: 'absolute', value: 'day_0' }, end: null },
            branches: { type: 'all' },
          },
        },
      ],
    });

    const worldState = {
      entities: { [charEntity.id]: { alive: false } },
      relationships: {},
      knowledge: {},
      threads: {},
      rules: {},
      facts: [],
    };

    const input = makeInput({
      event,
      worldState,
      events: [event],
      entities: registry,
      queryState: (id: string, attr: string) => worldState.entities[id]?.[attr],
    });

    const issues = validator.validatePre(input);
    expect(issues.filter((i) => i.validator === 'character_state')).toHaveLength(1);
    expect(issues[0].message).toContain('is dead');
  });

  it('does NOT flag living characters', () => {
    const charEntity = makeEntity('character', { name: 'Live Char' });
    const registry = makeRegistry([charEntity]);

    const event = makeEvent({
      id: 'E6',
      preconditions: [
        {
          id: 'F6',
          entityId: charEntity.id,
          attribute: 'status',
          value: 'alive',
          validity: {
            temporal: { start: { type: 'absolute', value: 'day_0' }, end: null },
            branches: { type: 'all' },
          },
        },
      ],
    });

    const worldState = {
      entities: { [charEntity.id]: { status: 'alive', alive: true } },
      relationships: {},
      knowledge: {},
      threads: {},
      rules: {},
      facts: [],
    };

    const input = makeInput({
      event,
      worldState,
      events: [event],
      entities: registry,
      queryState: (id: string, attr: string) => worldState.entities[id]?.[attr],
    });

    const issues = validator.validatePre(input);
    expect(issues.filter((i) => i.validator === 'character_state')).toHaveLength(0);
  });
});
