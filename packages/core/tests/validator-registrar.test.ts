// ============================================================================
// ValidatorRegistrar — validator extension migration contract
// ============================================================================
//
// External/plugin validators register through the narrow ValidatorRegistrar
// surface, flow through ValidatorRegistry.list(), and run inside the explicit
// merged ResultAggregator array alongside the builtins. There is no separate
// plugin dispatch path: the merged array is the one dispatch route for both
// builtin and registered validators.
// ============================================================================

import { describe, expect, it } from 'vitest';
import { InMemoryEntityRegistry } from '../src/entity/registry.ts';
import type { ValidatorRegistrar } from '../src/plugin/validator-registry.ts';
import { ValidatorRegistry } from '../src/plugin/validator-registry.ts';
import type {
  EntityLookup,
  NarrativeEvent,
  PostRenderInput,
  PreRenderInput,
  ValidationIssue,
  Validator,
  WorldState,
} from '../src/types/index.js';
import { ResultAggregator } from '../src/validator/aggregator.ts';
import { createBuiltInValidators } from '../src/validator/builtins.ts';

// ——— helpers ———

function makeEvent(id: string): NarrativeEvent {
  return {
    id,
    event: id,
    narrativeOrder: 1,
    title: 'Test event',
    storyTime: { type: 'absolute', value: 'day_1_morning' },
    sceneType: 'linear',
    pov: { character: 'rainsford', type: 'third_person_limited' },
    sceneBrief: 'Test',
    beats: ['Test'],
    preconditions: [],
    postconditions: [],
    threadProgress: [],
    foreshadowing: [],
    relationshipEffects: [],
    ruleEffects: [],
    styleGuidance: undefined,
    source: 'event_file',
    branchExistence: { type: 'all' },
    participants: { entities: [] },
  };
}

function makeWorldState(): WorldState {
  return {
    entities: {},
    relationships: {},
    knowledge: {},
    threads: {},
    rules: {},
    facts: [],
  };
}

function makeIssue(
  validator: string,
  message: string,
  severity: 'error' | 'warning' | 'info' = 'error',
): ValidationIssue {
  return {
    validator,
    severity,
    kind: 'compiler_invariant',
    event: 'E0',
    entity: '',
    message,
    fixSuggestion: '',
    fixAction: 'manual',
    fixTarget: { file: '' },
  };
}

// ——— external-style validators ———

const extPreValidator: Validator = {
  name: 'ExtPreValidator',
  category: 'prose_quality',
  validatePre(input: PreRenderInput): ValidationIssue[] {
    if (input.event.id === 'TRIGGER') {
      return [makeIssue('ExtPreValidator', 'trigger event detected pre-render')];
    }
    return [];
  },
};

const extPostValidator: Validator = {
  name: 'ExtPostValidator',
  category: 'prose_quality',
  validatePost(input: PostRenderInput): ValidationIssue[] {
    if (input.prose.includes('banana')) {
      return [makeIssue('ExtPostValidator', 'banana mentioned in prose')];
    }
    return [];
  },
};

// ——— tests ———

describe('validator extension registration (ValidatorRegistrar)', () => {
  it('registers external validators through the registrar and lists them', () => {
    const registry = new ValidatorRegistry();
    const registrar: ValidatorRegistrar = registry;
    registrar.register(extPreValidator);
    registrar.register(extPostValidator);

    const listed = registry.list();
    expect(listed).toHaveLength(2);
    expect(listed.map((v) => v.name)).toEqual(['ExtPreValidator', 'ExtPostValidator']);
  });

  it('runs registered validators through the explicit merged aggregator array', () => {
    const registry = new ValidatorRegistry();
    const registrar: ValidatorRegistrar = registry;
    registrar.register(extPreValidator);
    registrar.register(extPostValidator);

    const agg = new ResultAggregator([...createBuiltInValidators(), ...registry.list()], undefined);
    const entities: EntityLookup = new InMemoryEntityRegistry();
    const worldState = makeWorldState();
    const triggerEvent = makeEvent('TRIGGER');
    const otherEvent = makeEvent('E0');

    // validatePre: the registered pre validator fires on the trigger event.
    const preResult = agg.validatePre(triggerEvent, worldState, entities, [triggerEvent], 1);
    expect(preResult.errors.some((issue) => issue.validator === 'ExtPreValidator')).toBe(true);

    // validatePost: the registered post validator fires on banana prose.
    const postResult = agg.validatePost(
      'hello banana',
      otherEvent,
      worldState,
      undefined,
      undefined,
      entities,
    );
    const postIssues = [...postResult.errors, ...postResult.warnings, ...postResult.infos];
    expect(postIssues.some((issue) => issue.validator === 'ExtPostValidator')).toBe(true);

    // Builtins still run through the same merged array.
    const names = agg.listValidators().map((v) => v.name);
    expect(names).toContain('timeline');
    expect(names).toContain('ExtPreValidator');
    expect(names).toContain('ExtPostValidator');
  });
  it('ignores legacy-shaped validators without lifecycle fallbacks', () => {
    const legacy = {
      name: 'LegacyValidator',
      category: 'prose_quality',
      validate: () => [makeIssue('LegacyValidator', 'must not run')],
      validateRender: () => [makeIssue('LegacyValidator', 'must not run')],
    } as unknown as Validator;
    const agg = new ResultAggregator([legacy]);
    const entities: EntityLookup = new InMemoryEntityRegistry();
    const state = makeWorldState();
    const event = makeEvent('E0');
    const pre = agg.validatePre(event, state, entities, [event], 1);
    const post = agg.validatePost('prose', event, state, undefined, undefined, entities);
    expect(pre.errors).toHaveLength(0);
    expect(pre.warnings).toHaveLength(0);
    expect(pre.infos).toHaveLength(0);
    expect(post.errors).toHaveLength(0);
    expect(post.warnings).toHaveLength(0);
    expect(post.infos).toHaveLength(0);
  });

  it('ResultAggregator defaults to the full builtin set when no validators are passed', () => {
    const agg = new ResultAggregator();
    expect(agg.listValidators().length).toBe(createBuiltInValidators().length);
  });
});
