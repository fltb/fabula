// ============================================================================
// ResultAggregator — integration tests for validateRender/validatePost flow
// ============================================================================

import { describe, expect, it, vi } from 'vitest';
import type {
  EntityRegistry,
  NarrativeEvent,
  PostRenderInput,
  ValidationIssue,
  WorldState,
} from '../../src/types/index.js';
import { ResultAggregator } from '../../src/validator/aggregator.ts';

// ——— helpers ———

function makeEvent(overrides: Partial<NarrativeEvent> = {}): NarrativeEvent {
  return {
    id: 'E0',
    event: 'E0',
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
    ...overrides,
  };
}

function makeWorldState(overrides: Partial<WorldState> = {}): WorldState {
  return {
    entities: {},
    relationships: {},
    knowledge: {},
    threads: {},
    rules: {},
    facts: [],
    ...overrides,
  };
}

/** A minimal EntityRegistry stub for testing. */
function stubRegistry(): EntityRegistry {
  return {
    load: () => {},
    resolve: () => null,
    findByKind: () => [],
    findByAttribute: () => [],
    resolveRefs: () => new Map(),
    register: () => {},
    updateState: () => {},
    getAll: () => [],
  };
}

/** A validator that spies on the PostRenderInput it receives. */
function spyPostValidator(): {
  validator: {
    name: string;
    category: 'characterization';
    validatePost: (input: PostRenderInput) => ValidationIssue[];
  };
  received: PostRenderInput[];
} {
  const received: PostRenderInput[] = [];
  return {
    validator: {
      name: 'SpyPostValidator',
      category: 'characterization',
      validatePost(input: PostRenderInput) {
        received.push(input);
        return [];
      },
    },
    received,
  };
}

// ——— tests ———

describe('ResultAggregator.validateRender', () => {
  it('passes entityRegistry to validatePost when registry is provided', () => {
    const { validator, received } = spyPostValidator();
    const aggregator = new ResultAggregator([validator]);
    const registry = stubRegistry();

    aggregator.validateRender(
      'Some prose.',
      makeEvent(),
      makeWorldState(),
      undefined,
      undefined,
      registry,
    );

    expect(received).toHaveLength(1);
    expect(received[0].entityRegistry).toBe(registry);
  });

  it('passes entityRegistry as undefined when no registry is provided', () => {
    const { validator, received } = spyPostValidator();
    const aggregator = new ResultAggregator([validator]);

    aggregator.validateRender('Some prose.', makeEvent(), makeWorldState());

    expect(received).toHaveLength(1);
    expect(received[0].entityRegistry).toBeUndefined();
  });

  it('calls validatePost exactly once per validator', () => {
    const v1 = spyPostValidator();
    const v2 = spyPostValidator();
    const aggregator = new ResultAggregator([v1.validator, v2.validator]);

    aggregator.validateRender('Prose.', makeEvent(), makeWorldState());

    expect(v1.received).toHaveLength(1);
    expect(v2.received).toHaveLength(1);
  });

  it('applies severity overrides to issues from validatePost', () => {
    const validator: {
      name: string;
      category: 'characterization';
      validatePost: (input: PostRenderInput) => ValidationIssue[];
    } = {
      name: 'OverrideTester',
      category: 'characterization',
      validatePost() {
        return [
          {
            validator: 'OverrideTester',
            severity: 'info' as const,
            event: 'E0',
            entity: '',
            message: 'An info issue',
            fixSuggestion: '',
            fixAction: 'manual',
            fixTarget: { file: '' },
          },
          {
            validator: 'OverrideTester',
            severity: 'warning' as const,
            event: 'E0',
            entity: '',
            message: 'A warning issue',
            fixSuggestion: '',
            fixAction: 'manual',
            fixTarget: { file: '' },
          },
          {
            validator: 'OverrideTester',
            severity: 'error' as const,
            event: 'E0',
            entity: '',
            message: 'An error issue',
            fixSuggestion: '',
            fixAction: 'manual',
            fixTarget: { file: '' },
          },
        ];
      },
    };

    const aggregator = new ResultAggregator([validator]);

    const result = aggregator.validateRender('Prose.', makeEvent(), makeWorldState(), undefined, {
      OverrideTester: 'error',
    });

    // All three should now be errors
    expect(result.errors).toHaveLength(3);
    expect(result.warnings).toHaveLength(0);
    expect(result.infos).toHaveLength(0);
  });

  it('groups issues into errors/warnings/infos', () => {
    const validator: {
      name: string;
      category: 'characterization';
      validatePost: (input: PostRenderInput) => ValidationIssue[];
    } = {
      name: 'MultiIssue',
      category: 'characterization',
      validatePost() {
        return [
          {
            validator: 'MultiIssue',
            severity: 'error',
            event: 'E0',
            entity: '',
            message: 'E1',
            fixSuggestion: '',
            fixAction: 'manual',
            fixTarget: { file: '' },
          },
          {
            validator: 'MultiIssue',
            severity: 'warning',
            event: 'E0',
            entity: '',
            message: 'W1',
            fixSuggestion: '',
            fixAction: 'manual',
            fixTarget: { file: '' },
          },
          {
            validator: 'MultiIssue',
            severity: 'info',
            event: 'E0',
            entity: '',
            message: 'I1',
            fixSuggestion: '',
            fixAction: 'manual',
            fixTarget: { file: '' },
          },
        ];
      },
    };

    const aggregator = new ResultAggregator([validator]);
    const result = aggregator.validateRender('Prose.', makeEvent(), makeWorldState());

    expect(result.passed).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.infos).toHaveLength(1);
  });

  it('skips a validator when override is off', () => {
    const { validator, received } = spyPostValidator();
    const aggregator = new ResultAggregator([validator]);

    aggregator.validateRender('Prose.', makeEvent(), makeWorldState(), undefined, {
      SpyPostValidator: 'off',
    });

    expect(received).toHaveLength(0);
  });

  it('preserves existing validateRender (old-path) validators', () => {
    let oldPathCalled = false;
    const oldValidator = {
      name: 'OldPathValidator',
      category: 'characterization' as const,
      validateRender: (_prose: string, _event: NarrativeEvent, _state: WorldState) => {
        oldPathCalled = true;
        return [] as ValidationIssue[];
      },
    };
    const aggregator = new ResultAggregator([oldValidator]);

    aggregator.validateRender('Prose.', makeEvent(), makeWorldState());

    expect(oldPathCalled).toBe(true);
  });

  it('passes explicit chapter value to validatePost PostRenderInput', () => {
    const { validator, received } = spyPostValidator();
    const aggregator = new ResultAggregator([validator]);

    aggregator.validateRender(
      'Some prose.',
      makeEvent(),
      makeWorldState(),
      undefined,
      undefined,
      undefined,
      5,
    );

    expect(received).toHaveLength(1);
    expect(received[0].chapter).toBe(5);
  });

  it('defaults chapter to 1 when not supplied', () => {
    const { validator, received } = spyPostValidator();
    const aggregator = new ResultAggregator([validator]);

    aggregator.validateRender('Some prose.', makeEvent(), makeWorldState());

    expect(received).toHaveLength(1);
    expect(received[0].chapter).toBe(1);
  });
});

describe('ResultAggregator.getValidatorCategory', () => {
  it('returns the category of a known validator', () => {
    const validator = {
      name: 'TestValidator',
      category: 'timeline_plot' as const,
      validatePost: () => [],
    };
    const aggregator = new ResultAggregator([validator]);

    expect(aggregator.getValidatorCategory('TestValidator')).toBe('timeline_plot');
  });

  it('throws for an unknown validator name', () => {
    const aggregator = new ResultAggregator();

    expect(() => aggregator.getValidatorCategory('NonExistentValidator')).toThrow(
      'Unknown validator: "NonExistentValidator"',
    );
  });
});
