import { describe, expect, it } from 'vitest';
import type {
  AnalysisResult,
  NarrativeEvent,
  PostRenderInput,
  PreRenderInput,
} from '../../src/types/index.js';
import { TenseConsistencyValidator } from '../../src/validator/tense-consistency.js';

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
      ...overrides,
    },
  };
}

describe('TenseConsistencyValidator', () => {
  it('should report nothing when tenseDetected matches declared tense', () => {
    const event = makeEvent({ id: 'E1', tense: 'past' });
    const analysis = makeAnalysis({ tenseDetected: 'past' });
    const input = makeInput(event, analysis);

    const issues = new TenseConsistencyValidator().validatePost(input);
    const tenseIssues = issues.filter((i) => i.validator === 'tense_consistency');
    expect(tenseIssues).toHaveLength(0);
  });

  it('should report issue when tenseDetected mismatches declared tense', () => {
    const event = makeEvent({ id: 'E1', tense: 'past' });
    const analysis = makeAnalysis({ tenseDetected: 'present' });
    const input = makeInput(event, analysis);

    const issues = new TenseConsistencyValidator().validatePost(input);
    const tenseIssues = issues.filter((i) => i.validator === 'tense_consistency');
    expect(tenseIssues.length).toBeGreaterThanOrEqual(1);
    expect(tenseIssues[0].message).toContain('past');
    expect(tenseIssues[0].message).toContain('present');
    expect(tenseIssues[0].severity).toBe('warning');
  });

  it('should report nothing when analysis is null', () => {
    const event = makeEvent({ id: 'E1', tense: 'past' });
    const input = makeInput(event, null);

    const issues = new TenseConsistencyValidator().validatePost(input);
    expect(issues).toHaveLength(0);
  });
});

describe('instance state (no leakage)', () => {
  it('should not carry state between validatePre calls with different event sets', () => {
    const validator = new TenseConsistencyValidator();

    // Set A: past-tense events
    const eA1 = makeEvent({ id: 'E1', narrativeOrder: 1, tense: 'past' });
    const eA2 = makeEvent({ id: 'E2', narrativeOrder: 2, tense: 'past' });
    const issuesA = validator.validatePre(makePreInput(eA2, [eA1, eA2]));
    expect(issuesA.filter((i) => i.validator === 'tense_consistency')).toHaveLength(0);

    // Set B: present-tense events (no tense conflict within set)
    const eB1 = makeEvent({ id: 'E3', narrativeOrder: 1, tense: 'present' });
    const eB2 = makeEvent({ id: 'E4', narrativeOrder: 2, tense: 'present' });
    const issuesB = validator.validatePre(makePreInput(eB2, [eB1, eB2]));
    expect(issuesB.filter((i) => i.validator === 'tense_consistency')).toHaveLength(0);
  });

  it('should not carry state between validatePost calls with different events', () => {
    const validator = new TenseConsistencyValidator();

    // Call with past-tense event + matching analysis
    const input1 = makeInput(
      makeEvent({ id: 'E1', tense: 'past' }),
      makeAnalysis({ tenseDetected: 'past' }),
    );
    const issues1 = validator.validatePost(input1);
    expect(issues1.filter((i) => i.validator === 'tense_consistency')).toHaveLength(0);

    // Call with present-tense event + matching analysis (should NOT be affected by first call)
    const input2 = makeInput(
      makeEvent({ id: 'E2', tense: 'present' }),
      makeAnalysis({ eventId: 'E2', tenseDetected: 'present' }),
    );
    const issues2 = validator.validatePost(input2);
    expect(issues2.filter((i) => i.validator === 'tense_consistency')).toHaveLength(0);
  });
});
