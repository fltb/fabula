import { describe, expect, it } from 'vitest';
import type {
  AnalysisResult,
  NarrativeEvent,
  PostRenderInput,
  PreRenderInput,
} from '../../src/types/index.js';
import { FocalizationConsistencyValidator } from '../../src/validator/focalization-consistency.js';

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

function makeInput(event: NarrativeEvent, analysis: AnalysisResult | null): PostRenderInput {
  return {
    event,
    worldState: {
      entities: {},
      relationships: {},
      knowledge: {},
      threads: {},
      rules: {},
      facts: [],
    },
    prose: 'Some prose.',
    analysis,
    chapter: 1,
  };
}

function makePreInput(event: NarrativeEvent, events: NarrativeEvent[]): PreRenderInput {
  return {
    event,
    events,
    worldState: {
      entities: {},
      relationships: {},
      knowledge: {},
      threads: {},
      rules: {},
      facts: [],
    },
    entityRegistry: {
      load: () => {},
      resolve: () => null,
      findByKind: () => [],
      findByAttribute: () => [],
      resolveRefs: () => new Map(),
      register: () => {},
      updateState: () => {},
      getAll: () => [],
    },
    chapter: 1,
    queryState: () => undefined,
    getKnowledge: () => ({ claims: {}, bySubject: {}, byProposition: {}, actLog: [] }),
    getThreadProgress: () => null,
  };
}

function makeAnalysis(overrides?: Partial<AnalysisResult['analysis']>): AnalysisResult {
  return {
    eventId: 'E1',
    analysis: {
      postconditions: { covered: [], dropped: [] },
      preconditions: { violated: [] },
      pov: { consistent: true, leaks: [] },
      inventedDetails: [],
      quality: {
        proseScore: 8,
        maxScore: 10,
        strengths: [],
        weaknesses: [],
        estimatedWordCount: 300,
      },
      threadProgressAchieved: [],
      foreshadowingDeployed: [],
      tenseDetected: 'past',
      focalizationDetected: 'internal',
      ...overrides,
    },
  };
}

describe('FocalizationConsistencyValidator', () => {
  it('validatePre: should report issue when multiple internal focalization has characterSequence < 2', () => {
    const event = makeEvent({
      id: 'E1',
      focalization: {
        type: 'internal',
        variation: 'multiple',
        characterSequence: [{ character: 'char_hero', scope: 'scene' }],
      },
    });
    const input = makePreInput(event, [event]);

    const issues = new FocalizationConsistencyValidator().validatePre(input);
    const focalizationIssues = issues.filter((i) => i.validator === 'focalization_consistency');
    expect(focalizationIssues.length).toBeGreaterThanOrEqual(1);
    expect(focalizationIssues[0].message).toContain('fewer than 2 entries');
    expect(focalizationIssues[0].severity).toBe('warning');
  });

  it('validatePre: should report nothing when multiple internal focalization has characterSequence >= 2', () => {
    const event = makeEvent({
      id: 'E1',
      focalization: {
        type: 'internal',
        variation: 'multiple',
        characterSequence: [
          { character: 'char_hero', scope: 'scene' },
          { character: 'char_other', scope: 'scene' },
        ],
      },
    });
    const input = makePreInput(event, [event]);

    const issues = new FocalizationConsistencyValidator().validatePre(input);
    const focalizationIssues = issues.filter((i) => i.validator === 'focalization_consistency');
    expect(focalizationIssues).toHaveLength(0);
  });

  it('validatePre: should report nothing when focalization is not declared', () => {
    const event = makeEvent({ id: 'E1' });
    const input = makePreInput(event, [event]);

    const issues = new FocalizationConsistencyValidator().validatePre(input);
    expect(issues).toHaveLength(0);
  });

  it('validatePost: should report nothing when focalizationDetected matches declared focalization', () => {
    const event = makeEvent({
      id: 'E1',
      focalization: { type: 'internal' },
    });
    const analysis = makeAnalysis({ focalizationDetected: 'internal' });
    const input = makeInput(event, analysis);

    const issues = new FocalizationConsistencyValidator().validatePost(input);
    const focalizationIssues = issues.filter((i) => i.validator === 'focalization_consistency');
    expect(focalizationIssues).toHaveLength(0);
  });

  it('validatePost: should report issue when focalizationDetected mismatches declared focalization', () => {
    const event = makeEvent({
      id: 'E1',
      focalization: { type: 'internal' },
    });
    const analysis = makeAnalysis({ focalizationDetected: 'external' });
    const input = makeInput(event, analysis);

    const issues = new FocalizationConsistencyValidator().validatePost(input);
    const focalizationIssues = issues.filter((i) => i.validator === 'focalization_consistency');
    expect(focalizationIssues.length).toBeGreaterThanOrEqual(1);
    expect(focalizationIssues[0].message).toContain('internal');
    expect(focalizationIssues[0].message).toContain('external');
    expect(focalizationIssues[0].severity).toBe('warning');
  });

  it('validatePost: should report nothing when analysis is null', () => {
    const event = makeEvent({
      id: 'E1',
      focalization: { type: 'internal' },
    });
    const input = makeInput(event, null);

    const issues = new FocalizationConsistencyValidator().validatePost(input);
    expect(issues).toHaveLength(0);
  });

  it('validatePost: should report nothing when focalization is not declared', () => {
    const event = makeEvent({ id: 'E1' });
    const analysis = makeAnalysis({ focalizationDetected: 'internal' });
    const input = makeInput(event, analysis);

    const issues = new FocalizationConsistencyValidator().validatePost(input);
    expect(issues).toHaveLength(0);
  });
});

describe('FocalizationConsistencyValidator: instance state (no leakage)', () => {
  it('should not carry state between validatePre calls with different event sets', () => {
    const validator = new FocalizationConsistencyValidator();

    // Set A: internal focalization with multiple variation and < 2 entries
    const eA1 = makeEvent({
      id: 'E1',
      narrativeOrder: 1,
      focalization: {
        type: 'internal',
        variation: 'multiple',
        characterSequence: [{ character: 'char_hero', scope: 'scene' }],
      },
    });
    const issuesA = validator.validatePre(makePreInput(eA1, [eA1]));
    expect(
      issuesA.filter((i) => i.validator === 'focalization_consistency').length,
    ).toBeGreaterThanOrEqual(1);

    // Set B: no focalization field
    const eB1 = makeEvent({ id: 'E2', narrativeOrder: 2 });
    const issuesB = validator.validatePre(makePreInput(eB1, [eB1]));
    expect(issuesB.filter((i) => i.validator === 'focalization_consistency')).toHaveLength(0);
  });

  it('should not carry state between validatePost calls with different events', () => {
    const validator = new FocalizationConsistencyValidator();

    // Call with internal focalization + matching analysis
    const input1 = makeInput(
      makeEvent({ id: 'E1', focalization: { type: 'internal' } }),
      makeAnalysis({ focalizationDetected: 'internal' }),
    );
    const issues1 = validator.validatePost(input1);
    expect(issues1.filter((i) => i.validator === 'focalization_consistency')).toHaveLength(0);

    // Call with external focalization + matching analysis (should NOT be affected by first call)
    const input2 = makeInput(
      makeEvent({ id: 'E2', focalization: { type: 'external' } }),
      makeAnalysis({ eventId: 'E2', focalizationDetected: 'external' }),
    );
    const issues2 = validator.validatePost(input2);
    expect(issues2.filter((i) => i.validator === 'focalization_consistency')).toHaveLength(0);
  });
});
