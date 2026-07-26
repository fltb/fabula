import { describe, it, expect } from 'vitest';
import { FrequencyConsistencyValidator } from '../../src/validator/frequency-consistency.js';
import type {
  NarrativeEvent,
  PostRenderInput,
  PreRenderInput,
  AnalysisResult,
} from '../../src/types/index.js';

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

function makeInput(
  event: NarrativeEvent,
  analysis: AnalysisResult | null,
): PostRenderInput {
  return {
    event,
    worldState: { entities: {}, relationships: {}, knowledge: {}, threads: {}, rules: {}, facts: [] },
    prose: 'Some prose.',
    analysis,
    chapter: 1,
  };
}

function makePreInput(
  event: NarrativeEvent,
  events: NarrativeEvent[],
): PreRenderInput {
  return {
    event,
    events,
    worldState: { entities: {}, relationships: {}, knowledge: {}, threads: {}, rules: {}, facts: [] },
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
      quality: { proseScore: 8, maxScore: 10, strengths: [], weaknesses: [], estimatedWordCount: 300 },
      threadProgressAchieved: [],
      foreshadowingDeployed: [],
      frequencyDetected: 'singulative',
      ...overrides,
    },
  };
}

describe('FrequencyConsistencyValidator — validatePost', () => {
  it('should report nothing when frequencyDetected matches declared frequency', () => {
    const event = makeEvent({ id: 'E1', frequency: { type: 'singulative' } });
    const analysis = makeAnalysis({ frequencyDetected: 'singulative' });
    const input = makeInput(event, analysis);

    const issues = new FrequencyConsistencyValidator().validatePost(input);
    const freqIssues = issues.filter((i) => i.validator === 'frequency_consistency');
    expect(freqIssues).toHaveLength(0);
  });

  it('should report issue when frequencyDetected mismatches declared frequency', () => {
    const event = makeEvent({ id: 'E1', frequency: { type: 'singulative' } });
    const analysis = makeAnalysis({ frequencyDetected: 'repeating' });
    const input = makeInput(event, analysis);

    const issues = new FrequencyConsistencyValidator().validatePost(input);
    const freqIssues = issues.filter((i) => i.validator === 'frequency_consistency');
    expect(freqIssues.length).toBeGreaterThanOrEqual(1);
    expect(freqIssues[0].message).toContain('singulative');
    expect(freqIssues[0].message).toContain('repeating');
    expect(freqIssues[0].severity).toBe('warning');
  });

  it('should report nothing when analysis is null', () => {
    const event = makeEvent({ id: 'E1', frequency: { type: 'singulative' } });
    const input = makeInput(event, null);

    const issues = new FrequencyConsistencyValidator().validatePost(input);
    expect(issues).toHaveLength(0);
  });

  it('should report nothing when event.frequency is undefined', () => {
    const event = makeEvent({ id: 'E1' });
    const analysis = makeAnalysis({ frequencyDetected: 'singulative' });
    const input = makeInput(event, analysis);

    const issues = new FrequencyConsistencyValidator().validatePost(input);
    expect(issues).toHaveLength(0);
  });

  it('should report nothing when frequencyDetected cannot be parsed', () => {
    const event = makeEvent({ id: 'E1', frequency: { type: 'singulative' } });
    const analysis = makeAnalysis({ frequencyDetected: 'invalid_type' as unknown as string });
    const input = makeInput(event, analysis);

    const issues = new FrequencyConsistencyValidator().validatePost(input);
    expect(issues).toHaveLength(0);
  });
});

describe('FrequencyConsistencyValidator — validatePre', () => {
  it('should report nothing when singulative frequency (no iterationScope required)', () => {
    const event = makeEvent({ id: 'E1', frequency: { type: 'singulative' } });
    const input = makePreInput(event, [event]);

    const issues = new FrequencyConsistencyValidator().validatePre(input);
    const freqIssues = issues.filter((i) => i.validator === 'frequency_consistency');
    expect(freqIssues).toHaveLength(0);
  });

  it('should report issue when repeating frequency without iterationScope', () => {
    const event = makeEvent({ id: 'E1', frequency: { type: 'repeating' } });
    const input = makePreInput(event, [event]);

    const issues = new FrequencyConsistencyValidator().validatePre(input);
    const freqIssues = issues.filter((i) => i.validator === 'frequency_consistency');
    expect(freqIssues).toHaveLength(1);
    expect(freqIssues[0].message).toContain('repeating');
    expect(freqIssues[0].message).toContain('iterationScope');
    expect(freqIssues[0].severity).toBe('warning');
  });

  it('should report issue when iterative frequency without iterationScope', () => {
    const event = makeEvent({ id: 'E1', frequency: { type: 'iterative' } });
    const input = makePreInput(event, [event]);

    const issues = new FrequencyConsistencyValidator().validatePre(input);
    const freqIssues = issues.filter((i) => i.validator === 'frequency_consistency');
    expect(freqIssues).toHaveLength(1);
    expect(freqIssues[0].message).toContain('iterative');
    expect(freqIssues[0].message).toContain('iterationScope');
    expect(freqIssues[0].severity).toBe('warning');
  });

  it('should report nothing when repeating frequency with iterationScope', () => {
    const event = makeEvent({
      id: 'E1',
      frequency: {
        type: 'repeating',
        iterationScope: { start: 'day_1', end: 'day_5' },
      },
    });
    const input = makePreInput(event, [event]);

    const issues = new FrequencyConsistencyValidator().validatePre(input);
    const freqIssues = issues.filter((i) => i.validator === 'frequency_consistency');
    expect(freqIssues).toHaveLength(0);
  });

  it('should report nothing when iterative frequency with iterationScope', () => {
    const event = makeEvent({
      id: 'E1',
      frequency: {
        type: 'iterative',
        iterationScope: { start: 'day_1', end: 'day_5' },
      },
    });
    const input = makePreInput(event, [event]);

    const issues = new FrequencyConsistencyValidator().validatePre(input);
    const freqIssues = issues.filter((i) => i.validator === 'frequency_consistency');
    expect(freqIssues).toHaveLength(0);
  });

  it('should report nothing when frequency is undefined', () => {
    const event = makeEvent({ id: 'E1' });
    const input = makePreInput(event, [event]);

    const issues = new FrequencyConsistencyValidator().validatePre(input);
    expect(issues).toHaveLength(0);
  });
});

describe('FrequencyConsistencyValidator — instance state (no leakage)', () => {
  it('should not carry state between validatePre calls with different event sets', () => {
    const validator = new FrequencyConsistencyValidator();

    // Set A: repeating without iterationScope (should report issue)
    const eA1 = makeEvent({
      id: 'E1',
      narrativeOrder: 1,
      frequency: { type: 'repeating' },
    });
    const issuesA = validator.validatePre(makePreInput(eA1, [eA1]));
    expect(issuesA.filter((i) => i.validator === 'frequency_consistency')).toHaveLength(1);

    // Set B: singulative (should not report issue)
    const eB1 = makeEvent({
      id: 'E2',
      narrativeOrder: 2,
      frequency: { type: 'singulative' },
    });
    const issuesB = validator.validatePre(makePreInput(eB1, [eB1]));
    expect(issuesB.filter((i) => i.validator === 'frequency_consistency')).toHaveLength(0);
  });

  it('should not carry state between validatePost calls with different events', () => {
    const validator = new FrequencyConsistencyValidator();

    // Call with singulative + matching analysis
    const input1 = makeInput(
      makeEvent({ id: 'E1', frequency: { type: 'singulative' } }),
      makeAnalysis({ frequencyDetected: 'singulative' }),
    );
    const issues1 = validator.validatePost(input1);
    expect(issues1.filter((i) => i.validator === 'frequency_consistency')).toHaveLength(0);

    // Call with repeating + matching analysis (should NOT be affected by first call)
    const input2 = makeInput(
      makeEvent({ id: 'E2', frequency: { type: 'repeating', iterationScope: { start: 'day_1', end: 'day_5' } } }),
      makeAnalysis({ eventId: 'E2', frequencyDetected: 'repeating' }),
    );
    const issues2 = validator.validatePost(input2);
    expect(issues2.filter((i) => i.validator === 'frequency_consistency')).toHaveLength(0);
  });
});
