import { describe, expect, it } from 'vitest';
import type {
  AnalysisResult,
  NarrativeEvent,
  PostRenderInput,
  PreRenderInput,
} from '../../src/types/index.js';
import { VoiceConsistencyValidator } from '../../src/validator/voice-consistency.js';

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
      voiceDetected: { level: 'extradiegetic', relation: 'heterodiegetic' },
      ...overrides,
    },
  };
}

describe('VoiceConsistencyValidator', () => {
  it('should report nothing when voiceDetected level and relation both match declared voice', () => {
    const event = makeEvent({
      id: 'E1',
      voice: { level: 'intradiegetic', relation: 'homodiegetic' },
    });
    const analysis = makeAnalysis({
      voiceDetected: { level: 'intradiegetic', relation: 'homodiegetic' },
    });
    const input = makeInput(event, analysis);

    const issues = new VoiceConsistencyValidator().validatePost(input);
    const voiceIssues = issues.filter((i) => i.validator === 'voice_consistency');
    expect(voiceIssues).toHaveLength(0);
  });

  it('should report issue when voiceDetected level mismatches declared voice', () => {
    const event = makeEvent({
      id: 'E1',
      voice: { level: 'extradiegetic', relation: 'heterodiegetic' },
    });
    const analysis = makeAnalysis({
      voiceDetected: { level: 'intradiegetic', relation: 'heterodiegetic' },
    });
    const input = makeInput(event, analysis);

    const issues = new VoiceConsistencyValidator().validatePost(input);
    const voiceIssues = issues.filter((i) => i.validator === 'voice_consistency');
    expect(voiceIssues.length).toBeGreaterThanOrEqual(1);
    const levelIssue = voiceIssues.find((i) => i.attribute === 'voice.level');
    expect(levelIssue).toBeDefined();
    if (levelIssue) {
      expect(levelIssue.message).toContain('extradiegetic');
      expect(levelIssue.message).toContain('intradiegetic');
      expect(levelIssue.severity).toBe('warning');
    }
  });

  it('should report issue when voiceDetected relation mismatches declared voice', () => {
    const event = makeEvent({
      id: 'E1',
      voice: { level: 'intradiegetic', relation: 'heterodiegetic' },
    });
    const analysis = makeAnalysis({
      voiceDetected: { level: 'intradiegetic', relation: 'homodiegetic' },
    });
    const input = makeInput(event, analysis);

    const issues = new VoiceConsistencyValidator().validatePost(input);
    const voiceIssues = issues.filter((i) => i.validator === 'voice_consistency');
    expect(voiceIssues.length).toBeGreaterThanOrEqual(1);
    const relationIssue = voiceIssues.find((i) => i.attribute === 'voice.relation');
    expect(relationIssue).toBeDefined();
    if (relationIssue) {
      expect(relationIssue.message).toContain('heterodiegetic');
      expect(relationIssue.message).toContain('homodiegetic');
      expect(relationIssue.severity).toBe('warning');
    }
  });

  it('should report issues when both level and relation mismatch declared voice', () => {
    const event = makeEvent({
      id: 'E1',
      voice: { level: 'extradiegetic', relation: 'heterodiegetic' },
    });
    const analysis = makeAnalysis({
      voiceDetected: { level: 'intradiegetic', relation: 'homodiegetic' },
    });
    const input = makeInput(event, analysis);

    const issues = new VoiceConsistencyValidator().validatePost(input);
    const voiceIssues = issues.filter((i) => i.validator === 'voice_consistency');
    expect(voiceIssues).toHaveLength(2);

    const levelIssue = voiceIssues.find((i) => i.attribute === 'voice.level');
    const relationIssue = voiceIssues.find((i) => i.attribute === 'voice.relation');
    expect(levelIssue).toBeDefined();
    expect(relationIssue).toBeDefined();
  });

  it('should report nothing when analysis is null', () => {
    const event = makeEvent({
      id: 'E1',
      voice: { level: 'intradiegetic', relation: 'homodiegetic' },
    });
    const input = makeInput(event, null);

    const issues = new VoiceConsistencyValidator().validatePost(input);
    expect(issues).toHaveLength(0);
  });

  it('should report nothing when event has no voice field', () => {
    const event = makeEvent({ id: 'E1' });
    const analysis = makeAnalysis({
      voiceDetected: { level: 'intradiegetic', relation: 'homodiegetic' },
    });
    const input = makeInput(event, analysis);

    const issues = new VoiceConsistencyValidator().validatePost(input);
    expect(issues).toHaveLength(0);
  });
});

describe('VoiceConsistencyValidator.validatePre', () => {
  it('should report nothing from validatePre', () => {
    const event = makeEvent({
      id: 'E1',
      voice: { level: 'extradiegetic', relation: 'heterodiegetic' },
    });
    const input = makePreInput(event, [event]);

    const issues = new VoiceConsistencyValidator().validatePre(input);
    expect(issues).toHaveLength(0);
  });
});

describe('instance state (no leakage)', () => {
  it('should not carry state between validatePost calls with different events', () => {
    const validator = new VoiceConsistencyValidator();

    const event1 = makeEvent({
      id: 'E1',
      voice: { level: 'extradiegetic', relation: 'heterodiegetic' },
    });
    const analysis1 = makeAnalysis({
      voiceDetected: { level: 'intradiegetic', relation: 'heterodiegetic' },
    });
    const input1 = makeInput(event1, analysis1);
    const issues1 = validator.validatePost(input1);

    const event2 = makeEvent({
      id: 'E2',
      voice: { level: 'extradiegetic', relation: 'heterodiegetic' },
    });
    const analysis2 = makeAnalysis({
      voiceDetected: { level: 'extradiegetic', relation: 'heterodiegetic' },
    });
    const input2 = makeInput(event2, analysis2);
    const issues2 = validator.validatePost(input2);

    expect(issues1.length).toBeGreaterThanOrEqual(1);
    expect(issues2).toHaveLength(0);
  });
});
