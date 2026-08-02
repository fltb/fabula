import { describe, expect, it } from 'vitest';
import type {
  AnalysisResult,
  NarrativeEvent,
  PostRenderInput,
  PreRenderInput,
} from '../../src/types/index.js';
import { AnachronyConsistencyValidator } from '../../src/validator/anachrony-consistency.js';

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
    entities: {
      resolve: () => null,
      findByKind: () => [],
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
      anachronyDetected: 'none',
      ...overrides,
    },
  };
}

describe('AnachronyConsistencyValidator', () => {
  it('should report nothing when anachronyDetected matches declared anachrony type', () => {
    const event = makeEvent({
      id: 'E1',
      anachrony: {
        type: 'analepsis',
        scope: 'external',
        function: 'completing',
        distance: '2 years earlier',
      },
    });
    const analysis = makeAnalysis({ anachronyDetected: 'analepsis' });
    const input = makeInput(event, analysis);

    const issues = new AnachronyConsistencyValidator().validatePost(input);
    const anachronyIssues = issues.filter((i) => i.validator === 'anachrony_consistency');
    expect(anachronyIssues).toHaveLength(0);
  });

  it('should report issue when anachronyDetected mismatches declared anachrony type', () => {
    const event = makeEvent({
      id: 'E1',
      anachrony: {
        type: 'analepsis',
        scope: 'external',
        function: 'completing',
        distance: '2 years earlier',
      },
    });
    const analysis = makeAnalysis({ anachronyDetected: 'prolepsis' });
    const input = makeInput(event, analysis);

    const issues = new AnachronyConsistencyValidator().validatePost(input);
    const anachronyIssues = issues.filter((i) => i.validator === 'anachrony_consistency');
    expect(anachronyIssues.length).toBeGreaterThanOrEqual(1);
    expect(anachronyIssues[0].message).toContain('analepsis');
    expect(anachronyIssues[0].message).toContain('prolepsis');
    expect(anachronyIssues[0].severity).toBe('warning');
  });

  it('should report nothing when analysis is null', () => {
    const event = makeEvent({
      id: 'E1',
      anachrony: {
        type: 'analepsis',
        scope: 'external',
        function: 'completing',
        distance: '2 years earlier',
      },
    });
    const input = makeInput(event, null);

    const issues = new AnachronyConsistencyValidator().validatePost(input);
    expect(issues).toHaveLength(0);
  });

  it('should report nothing when event.anachrony is undefined (early return path)', () => {
    const event = makeEvent({ id: 'E1' }); // no anachrony field
    const analysis = makeAnalysis({ anachronyDetected: 'analepsis' });
    const input = makeInput(event, analysis);

    const issues = new AnachronyConsistencyValidator().validatePost(input);
    expect(issues).toHaveLength(0);
  });

  it('should report warning in validatePre when anachrony type is set but distance is missing', () => {
    const event = makeEvent({
      id: 'E1',
      anachrony: {
        type: 'analepsis',
        scope: 'external',
        function: 'completing',
        distance: '', // empty distance
      },
    });
    const input = makePreInput(event, [event]);

    const issues = new AnachronyConsistencyValidator().validatePre(input);
    const anachronyIssues = issues.filter((i) => i.validator === 'anachrony_consistency');
    expect(anachronyIssues.length).toBeGreaterThanOrEqual(1);
    expect(anachronyIssues[0].message).toContain('analepsis');
    expect(anachronyIssues[0].message).toContain('distance');
    expect(anachronyIssues[0].severity).toBe('warning');
  });

  it('should report warning in validatePre for prolepsis without distance', () => {
    const event = makeEvent({
      id: 'E1',
      anachrony: {
        type: 'prolepsis',
        scope: 'external',
        function: 'completing',
        distance: '', // empty distance
      },
    });
    const input = makePreInput(event, [event]);

    const issues = new AnachronyConsistencyValidator().validatePre(input);
    const anachronyIssues = issues.filter((i) => i.validator === 'anachrony_consistency');
    expect(anachronyIssues.length).toBeGreaterThanOrEqual(1);
    expect(anachronyIssues[0].message).toContain('prolepsis');
    expect(anachronyIssues[0].severity).toBe('warning');
  });

  it('should report nothing in validatePre when anachrony has distance', () => {
    const event = makeEvent({
      id: 'E1',
      anachrony: {
        type: 'analepsis',
        scope: 'external',
        function: 'completing',
        distance: '2 years earlier',
      },
    });
    const input = makePreInput(event, [event]);

    const issues = new AnachronyConsistencyValidator().validatePre(input);
    const anachronyIssues = issues.filter((i) => i.validator === 'anachrony_consistency');
    expect(anachronyIssues).toHaveLength(0);
  });
});

describe('AnachronyConsistencyValidator instance state (no leakage)', () => {
  it('should not carry state between validatePost calls with different events', () => {
    const validator = new AnachronyConsistencyValidator();

    // Call 1: analepsis event + matching analysis
    const input1 = makeInput(
      makeEvent({
        id: 'E1',
        anachrony: {
          type: 'analepsis',
          scope: 'external',
          function: 'completing',
          distance: '2 years earlier',
        },
      }),
      makeAnalysis({ anachronyDetected: 'analepsis' }),
    );
    const issues1 = validator.validatePost(input1);
    expect(issues1.filter((i) => i.validator === 'anachrony_consistency')).toHaveLength(0);

    // Call 2: prolepsis event + matching analysis (should NOT be affected by first call)
    const input2 = makeInput(
      makeEvent({
        id: 'E2',
        anachrony: {
          type: 'prolepsis',
          scope: 'external',
          function: 'completing',
          distance: '3 months later',
        },
      }),
      makeAnalysis({ eventId: 'E2', anachronyDetected: 'prolepsis' }),
    );
    const issues2 = validator.validatePost(input2);
    expect(issues2.filter((i) => i.validator === 'anachrony_consistency')).toHaveLength(0);
  });

  it('should not carry state between validatePre calls with different event sets', () => {
    const validator = new AnachronyConsistencyValidator();

    // Set A: analepsis with distance (no issue)
    const eA1 = makeEvent({
      id: 'E1',
      narrativeOrder: 1,
      anachrony: {
        type: 'analepsis',
        scope: 'external',
        function: 'completing',
        distance: '2 years earlier',
      },
    });
    const issuesA = validator.validatePre(makePreInput(eA1, [eA1]));
    expect(issuesA.filter((i) => i.validator === 'anachrony_consistency')).toHaveLength(0);

    // Set B: prolepsis without distance (should issue, independent of Set A)
    const eB1 = makeEvent({
      id: 'E2',
      narrativeOrder: 1,
      anachrony: {
        type: 'prolepsis',
        scope: 'external',
        function: 'completing',
        distance: '', // missing
      },
    });
    const issuesB = validator.validatePre(makePreInput(eB1, [eB1]));
    expect(
      issuesB.filter((i) => i.validator === 'anachrony_consistency').length,
    ).toBeGreaterThanOrEqual(1);
  });
});
