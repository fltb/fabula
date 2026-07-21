// ============================================================================
// Catalog-Driven Validator Checks (STATE-3b)
// ============================================================================
// Verifies:
// 1. Catalog helper functions return correct values
// 2. World-rule validator does NOT flag marital_status changes (mutable/lifecycle)
// 3. World-rule validator DOES flag immutable attribute changes (e.g. gender)
// 4. Character-state validator uses semanticRole: 'lifecycle' to detect dead chars
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  getAttributeSemanticRole,
  getAttributeWritePolicy,
  getAttributesBySemanticRole,
} from '../../src/validator/base.js';
import { WorldRuleValidator } from '../../src/validator/world-rule.js';
import { CharacterStateValidator } from '../../src/validator/character-state.js';
import { defaultEntityTypeCatalog } from '../../src/entity/index.js';
import type {
  NarrativeEvent,
  PreRenderInput,
  EntityRegistry,
  Entity,
  EntityKind,
} from '../../src/types/index.js';

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
    register: (e: Entity) => { map.set(e.id, e); },
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
    preconditions: [],
    postconditions: [],
    threadProgress: [],
    foreshadowing: [],
    relationshipEffects: [],
    ruleEffects: [],
    source: 'genesis',
    branchExistence: { type: 'all' },
    participants: { entities: [] },
    ...overrides,
  };
}

// ─── Tests ───

describe('Catalog helpers', () => {
  it('getAttributeSemanticRole returns correct role for known attributes', () => {
    expect(getAttributeSemanticRole('character', 'marital_status')).toBe('lifecycle');
    expect(getAttributeSemanticRole('character', 'gender')).toBe('identity');
    expect(getAttributeSemanticRole('character', 'location')).toBe('location');
    expect(getAttributeSemanticRole('character', 'knows')).toBe('knowledge');
    expect(getAttributeSemanticRole('character', 'mood')).toBe('emotional');
    expect(getAttributeSemanticRole('character', 'pronoun')).toBe('narrative');
    expect(getAttributeSemanticRole('character', 'appearance')).toBe('appearance');
    expect(getAttributeSemanticRole('character', 'time_period')).toBeUndefined();
  });

  it('getAttributeWritePolicy returns correct write policy', () => {
    expect(getAttributeWritePolicy('character', 'marital_status')).toBe('mutable');
    expect(getAttributeWritePolicy('character', 'gender')).toBe('immutable');
    expect(getAttributeWritePolicy('character', 'location')).toBe('mutable');
    expect(getAttributeWritePolicy('character', 'lifeStatus')).toBe('mutable');
  });

  it('getAttributesBySemanticRole returns attribute IDs for a role', () => {
    const lifecycleAttrs = getAttributesBySemanticRole('character', 'lifecycle');
    expect(lifecycleAttrs).toContain('marital_status');
    expect(lifecycleAttrs).toContain('status');
    expect(lifecycleAttrs).toContain('alive');
    expect(lifecycleAttrs).toContain('character_state');

    const identityAttrs = getAttributesBySemanticRole('character', 'identity');
    expect(identityAttrs).toContain('gender');
    expect(identityAttrs).toContain('traits');
    expect(identityAttrs).toContain('aliases');

    const narrativeAttrs = getAttributesBySemanticRole('character', 'narrative');
    expect(narrativeAttrs).toContain('pronoun');
    expect(narrativeAttrs).toContain('pacing');

    const locationAttrs = getAttributesBySemanticRole('character', 'location');
    expect(locationAttrs).toContain('location');
  });

  it('returns undefined for unknown kind', () => {
    expect(getAttributeSemanticRole('unknown_kind' as EntityKind, 'test')).toBeUndefined();
    expect(getAttributeWritePolicy('unknown_kind' as EntityKind, 'test')).toBeUndefined();
    expect(getAttributesBySemanticRole('unknown_kind' as EntityKind, 'test')).toEqual([]);
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
      postconditions: [{
        id: 'F1',
        entityId: charEntity.id,
        attribute: 'marital_status',
        value: 'remarried',
        validity: {
          temporal: { start: { type: 'absolute', value: 'day_0' }, end: null },
          branches: { type: 'all' },
        },
      }],
    });

    const input: PreRenderInput = {
      event,
      worldState: { entities: {}, relationships: {}, knowledge: {}, threads: {}, rules: {}, facts: [] },
      events: [event],
      entityRegistry: registry,
      chapter: 1,
      queryState: () => undefined,
      getKnowledge: () => ({
        worldTruth: [],
        characterKnowledge: {},
        readerKnowledge: [],
        narratorKnowledge: [],
      }),
      getThreadProgress: () => ({ progress: 0, total: 0 }),
    };

    const issues = validator.validatePre(input);
    // marital_status is mutable/lifecycle — changing it is NOT a world rule violation
    expect(issues.filter(i => i.validator === 'world_rule')).toHaveLength(0);
  });

  it('DOES flag immutable attribute changes (e.g. gender)', () => {
    const charEntity = makeEntity('character', {
      name: 'Test Char',
      gender: 'female',
    });
    const registry = makeRegistry([charEntity]);

    const event = makeEvent({
      id: 'E2',
      postconditions: [{
        id: 'F2',
        entityId: charEntity.id,
        attribute: 'gender',
        value: 'male',
        validity: {
          temporal: { start: { type: 'absolute', value: 'day_0' }, end: null },
          branches: { type: 'all' },
        },
      }],
    });

    const input: PreRenderInput = {
      event,
      worldState: { entities: {}, relationships: {}, knowledge: {}, threads: {}, rules: {}, facts: [] },
      events: [event],
      entityRegistry: registry,
      chapter: 1,
      queryState: () => undefined,
      getKnowledge: () => ({
        worldTruth: [],
        characterKnowledge: {},
        readerKnowledge: [],
        narratorKnowledge: [],
      }),
      getThreadProgress: () => ({ progress: 0, total: 0 }),
    };

    const issues = validator.validatePre(input);
    // gender is immutable — changing it IS a world rule violation
    expect(issues.filter(i => i.validator === 'world_rule')).toHaveLength(1);
    expect(issues[0].attribute).toBe('gender');
  });

  it('does NOT flag changes for unknown attributes or entities', () => {
    // Entity without marital_status or gender in state
    const charEntity = makeEntity('character', { name: 'Test' });
    const registry = makeRegistry([charEntity]);

    const event = makeEvent({
      id: 'E3',
      postconditions: [{
        id: 'F3',
        entityId: charEntity.id,
        attribute: 'unknown_attr',
        value: 'some_value',
        validity: {
          temporal: { start: { type: 'absolute', value: 'day_0' }, end: null },
          branches: { type: 'all' },
        },
      }],
    });

    const input: PreRenderInput = {
      event,
      worldState: { entities: {}, relationships: {}, knowledge: {}, threads: {}, rules: {}, facts: [] },
      events: [event],
      entityRegistry: registry,
      chapter: 1,
      queryState: () => undefined,
      getKnowledge: () => ({
        worldTruth: [],
        characterKnowledge: {},
        readerKnowledge: [],
        narratorKnowledge: [],
      }),
      getThreadProgress: () => ({ progress: 0, total: 0 }),
    };

    const issues = validator.validatePre(input);
    expect(issues.filter(i => i.validator === 'world_rule')).toHaveLength(0);
  });
});

describe('CharacterStateValidator — catalog-driven lifecycle check', () => {
  const validator = new CharacterStateValidator();

  it('detects dead character via lifecycle attribute (status = dead)', () => {
    const charEntity = makeEntity('character', { name: 'Dead Char' });
    const registry = makeRegistry([charEntity]);

    const event = makeEvent({
      id: 'E4',
      preconditions: [{ id: 'F4', entityId: charEntity.id, attribute: 'status', value: 'some_value', validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } } }],
    });

    const worldState = {
      entities: { [charEntity.id]: { status: 'dead' } },
      relationships: {}, knowledge: {}, threads: {}, rules: {}, facts: [],
    };

    const input: PreRenderInput = {
      event,
      worldState,
      events: [event],
      entityRegistry: registry,
      chapter: 1,
      queryState: (id: string, attr: string) => worldState.entities[id]?.[attr],
      getKnowledge: () => ({
        worldTruth: [],
        characterKnowledge: {},
        readerKnowledge: [],
        narratorKnowledge: [],
      }),
      getThreadProgress: () => ({ progress: 0, total: 0 }),
    };

    const issues = validator.validatePre(input);
    expect(issues.filter(i => i.validator === 'character_state')).toHaveLength(1);
    expect(issues[0].message).toContain('is dead');
  });

  it('detects dead character via lifecycle attribute (alive = false)', () => {
    const charEntity = makeEntity('character', { name: 'Deceased Char' });
    const registry = makeRegistry([charEntity]);

    const event = makeEvent({
      id: 'E5',
      preconditions: [{ id: 'F5', entityId: charEntity.id, attribute: 'alive', value: false, validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } } }],
    });

    const worldState = {
      entities: { [charEntity.id]: { alive: false } },
      relationships: {}, knowledge: {}, threads: {}, rules: {}, facts: [],
    };

    const input: PreRenderInput = {
      event,
      worldState,
      events: [event],
      entityRegistry: registry,
      chapter: 1,
      queryState: (id: string, attr: string) => worldState.entities[id]?.[attr],
      getKnowledge: () => ({
        worldTruth: [],
        characterKnowledge: {},
        readerKnowledge: [],
        narratorKnowledge: [],
      }),
      getThreadProgress: () => ({ progress: 0, total: 0 }),
    };

    const issues = validator.validatePre(input);
    expect(issues.filter(i => i.validator === 'character_state')).toHaveLength(1);
    expect(issues[0].message).toContain('is dead');
  });

  it('does NOT flag living characters', () => {
    const charEntity = makeEntity('character', { name: 'Live Char' });
    const registry = makeRegistry([charEntity]);

    const event = makeEvent({
      id: 'E6',
      preconditions: [{ id: 'F6', entityId: charEntity.id, attribute: 'status', value: 'alive', validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } } }],
    });

    const worldState = {
      entities: { [charEntity.id]: { status: 'alive', alive: true } },
      relationships: {}, knowledge: {}, threads: {}, rules: {}, facts: [],
    };

    const input: PreRenderInput = {
      event,
      worldState,
      events: [event],
      entityRegistry: registry,
      chapter: 1,
      queryState: (id: string, attr: string) => worldState.entities[id]?.[attr],
      getKnowledge: () => ({
        worldTruth: [],
        characterKnowledge: {},
        readerKnowledge: [],
        narratorKnowledge: [],
      }),
      getThreadProgress: () => ({ progress: 0, total: 0 }),
    };

    const issues = validator.validatePre(input);
    expect(issues.filter(i => i.validator === 'character_state')).toHaveLength(0);
  });
});
