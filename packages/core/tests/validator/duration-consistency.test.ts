import { describe, expect, it } from 'vitest';
import type {
  AnalysisResult,
  NarrativeEvent,
  PostRenderInput,
  PreRenderInput,
} from '../../src/types/index.js';
import { DurationConsistencyValidator } from '../../src/validator/duration-consistency.js';

function makeEvent(overrides: Partial<NarrativeEvent> & { id: string }): NarrativeEvent {
  return {
    id: 'E1',
    event: 'test_event',
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
      durationDetected: 'scene',
      ...overrides,
    },
  };
}

describe('DurationConsistencyValidator', () => {
  describe('validatePost — match/no-issue', () => {
    it('should report nothing when durationDetected matches declared duration', () => {
      const event = makeEvent({ id: 'E1', duration: { type: 'scene' } });
      const analysis = makeAnalysis({ durationDetected: 'scene' });
      const input = makeInput(event, analysis);

      const issues = new DurationConsistencyValidator().validatePost(input);
      const durationIssues = issues.filter((i) => i.validator === 'duration_consistency');
      expect(durationIssues).toHaveLength(0);
    });

    it('should report nothing when durationDetected matches declared ellipsis duration', () => {
      const event = makeEvent({
        id: 'E1',
        duration: { type: 'ellipsis', ellipsisClarity: 'explicit' },
      });
      const analysis = makeAnalysis({ durationDetected: 'ellipsis' });
      const input = makeInput(event, analysis);

      const issues = new DurationConsistencyValidator().validatePost(input);
      const durationIssues = issues.filter((i) => i.validator === 'duration_consistency');
      expect(durationIssues).toHaveLength(0);
    });
  });

  describe('validatePost — mismatch/issue', () => {
    it('should report issue when durationDetected mismatches declared duration', () => {
      const event = makeEvent({ id: 'E1', duration: { type: 'scene' } });
      const analysis = makeAnalysis({ durationDetected: 'summary' });
      const input = makeInput(event, analysis);

      const issues = new DurationConsistencyValidator().validatePost(input);
      const durationIssues = issues.filter((i) => i.validator === 'duration_consistency');
      expect(durationIssues.length).toBeGreaterThanOrEqual(1);
      expect(durationIssues[0].message).toContain('scene');
      expect(durationIssues[0].message).toContain('summary');
      expect(durationIssues[0].severity).toBe('warning');
    });

    it('should report issue when ellipsis declared but stretch detected', () => {
      const event = makeEvent({
        id: 'E1',
        duration: { type: 'ellipsis', ellipsisClarity: 'explicit' },
      });
      const analysis = makeAnalysis({ durationDetected: 'stretch' });
      const input = makeInput(event, analysis);

      const issues = new DurationConsistencyValidator().validatePost(input);
      const durationIssues = issues.filter((i) => i.validator === 'duration_consistency');
      expect(durationIssues.length).toBeGreaterThanOrEqual(1);
      expect(durationIssues[0].severity).toBe('warning');
    });
  });

  describe('validatePost — analysis===null/no-issue', () => {
    it('should report nothing when analysis is null', () => {
      const event = makeEvent({ id: 'E1', duration: { type: 'scene' } });
      const input = makeInput(event, null);

      const issues = new DurationConsistencyValidator().validatePost(input);
      expect(issues).toHaveLength(0);
    });

    it('should report nothing when event.duration is undefined', () => {
      const event = makeEvent({ id: 'E1' });
      const analysis = makeAnalysis({ durationDetected: 'scene' });
      const input = makeInput(event, analysis);

      const issues = new DurationConsistencyValidator().validatePost(input);
      expect(issues).toHaveLength(0);
    });
  });

  describe('validatePre — ellipsisClarity validation', () => {
    it('should report warning when ellipsis duration lacks ellipsisClarity', () => {
      const event = makeEvent({ id: 'E1', duration: { type: 'ellipsis' } });
      const input = makePreInput(event, [event]);

      const issues = new DurationConsistencyValidator().validatePre(input);
      const durationIssues = issues.filter((i) => i.validator === 'duration_consistency');
      expect(durationIssues.length).toBeGreaterThanOrEqual(1);
      expect(durationIssues[0].message).toContain('ellipsisClarity');
      expect(durationIssues[0].severity).toBe('warning');
    });

    it('should report nothing when ellipsis duration has ellipsisClarity set', () => {
      const event = makeEvent({
        id: 'E1',
        duration: { type: 'ellipsis', ellipsisClarity: 'explicit' },
      });
      const input = makePreInput(event, [event]);

      const issues = new DurationConsistencyValidator().validatePre(input);
      const durationIssues = issues.filter((i) => i.validator === 'duration_consistency');
      expect(durationIssues).toHaveLength(0);
    });

    it('should report nothing for non-ellipsis duration types without ellipsisClarity', () => {
      const event = makeEvent({ id: 'E1', duration: { type: 'scene' } });
      const input = makePreInput(event, [event]);

      const issues = new DurationConsistencyValidator().validatePre(input);
      const durationIssues = issues.filter((i) => i.validator === 'duration_consistency');
      expect(durationIssues).toHaveLength(0);
    });
  });
});
