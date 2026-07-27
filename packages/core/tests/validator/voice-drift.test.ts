import { describe, expect, it } from 'vitest';
import type {
  AnalysisResult,
  NarrativeCheck,
  NarrativeEvent,
  PostRenderInput,
} from '../../src/types/index.js';
import { VoiceDriftDetector } from '../../src/validator/voice-drift.js';

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

function makeAnalysis(narrativeChecks: NarrativeCheck[]): AnalysisResult {
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
      narrativeChecks,
    },
  };
}

describe('VoiceDriftDetector', () => {
  it('should report issue when voice_formality is absent', () => {
    const event = makeEvent({ id: 'E1' });
    const analysis = makeAnalysis([
      {
        entityId: 'char_hero',
        attribute: 'voice_formality',
        hint: 'Expected formal register',
        evidence: 'The narration uses casual contractions and slang.',
        matchLevel: 'absent',
      },
    ]);
    const input = makeInput(event, analysis);
    const issues = new VoiceDriftDetector().validatePost(input);
    const driftIssues = issues.filter((i) => i.validator === 'voice_drift');
    expect(driftIssues).toHaveLength(1);
    expect(driftIssues[0].message).toContain('Voice drift detected');
    expect(driftIssues[0].severity).toBe('info');
  });

  it('should report issue when voice_anachronism is contradicted', () => {
    const event = makeEvent({ id: 'E1' });
    const analysis = makeAnalysis([
      {
        entityId: 'char_sidekick',
        attribute: 'voice_anachronism',
        hint: 'Expected period-appropriate speech',
        evidence: 'Character uses modern slang like "lol" in a medieval setting.',
        matchLevel: 'contradicted',
      },
    ]);
    const input = makeInput(event, analysis);
    const issues = new VoiceDriftDetector().validatePost(input);
    const driftIssues = issues.filter((i) => i.validator === 'voice_drift');
    expect(driftIssues).toHaveLength(1);
    expect(driftIssues[0].message).toContain('Voice drift detected');
    expect(driftIssues[0].severity).toBe('warning');
  });

  it('should report issue when voice_action_verbs is absent', () => {
    const event = makeEvent({ id: 'E1' });
    const analysis = makeAnalysis([
      {
        entityId: 'char_villain',
        attribute: 'voice_action_verbs',
        hint: 'Expected forceful active verbs',
        evidence: 'The villain speaks with passive, tentative language.',
        matchLevel: 'absent',
      },
    ]);
    const input = makeInput(event, analysis);
    const issues = new VoiceDriftDetector().validatePost(input);
    const driftIssues = issues.filter((i) => i.validator === 'voice_drift');
    expect(driftIssues).toHaveLength(1);
    expect(driftIssues[0].message).toContain('Voice drift detected');
    expect(driftIssues[0].severity).toBe('info');
  });

  it('should report nothing when no voice_ attributes are present', () => {
    const event = makeEvent({ id: 'E1' });
    const analysis = makeAnalysis([
      {
        entityId: 'char_hero',
        attribute: 'pacing',
        hint: 'Expected moderate pacing',
        evidence: 'Scene moves at a steady pace.',
        matchLevel: 'exact',
      },
    ]);
    const input = makeInput(event, analysis);
    const issues = new VoiceDriftDetector().validatePost(input);
    const driftIssues = issues.filter((i) => i.validator === 'voice_drift');
    expect(driftIssues).toHaveLength(0);
  });

  it('should report multiple issues when multiple voice_ checks fail', () => {
    const event = makeEvent({ id: 'E1' });
    const analysis = makeAnalysis([
      {
        entityId: 'char_hero',
        attribute: 'voice_formality',
        hint: 'Expected formal register',
        evidence: 'Uses casual contractions.',
        matchLevel: 'absent',
      },
      {
        entityId: 'char_sidekick',
        attribute: 'voice_anachronism',
        hint: 'Expected period-appropriate speech',
        evidence: 'Modern slang detected.',
        matchLevel: 'contradicted',
      },
      {
        entityId: 'char_villain',
        attribute: 'voice_vocabulary',
        hint: 'Expected sophisticated vocabulary',
        evidence: 'Simple words used throughout.',
        matchLevel: 'absent',
      },
      {
        entityId: 'char_hero',
        attribute: 'voice_action_verbs',
        hint: 'Expected forceful verbs',
        evidence: 'Passive voice dominates.',
        matchLevel: 'contradicted',
      },
    ]);
    const input = makeInput(event, analysis);
    const issues = new VoiceDriftDetector().validatePost(input);
    const driftIssues = issues.filter((i) => i.validator === 'voice_drift');
    expect(driftIssues).toHaveLength(4);
  });

  it('should return empty when analysis is null', () => {
    const event = makeEvent({ id: 'E1' });
    const input = makeInput(event, null);
    const issues = new VoiceDriftDetector().validatePost(input);
    expect(issues).toHaveLength(0);
  });

  it('should return empty when narrativeChecks is undefined', () => {
    const event = makeEvent({ id: 'E1' });
    const analysis = makeAnalysis([]);
    const input = makeInput(event, analysis);
    const issues = new VoiceDriftDetector().validatePost(input);
    expect(issues).toHaveLength(0);
  });

  it('should not report issues for voice_ checks with exact or similar matchLevel', () => {
    const event = makeEvent({ id: 'E1' });
    const analysis = makeAnalysis([
      {
        entityId: 'char_hero',
        attribute: 'voice_formality',
        hint: 'Expected formal register',
        evidence: 'Uses formal vocabulary throughout.',
        matchLevel: 'exact',
      },
      {
        entityId: 'char_sidekick',
        attribute: 'voice_vocabulary',
        hint: 'Expected casual vocabulary',
        evidence: 'Mostly casual with occasional formal words.',
        matchLevel: 'similar',
      },
    ]);
    const input = makeInput(event, analysis);
    const issues = new VoiceDriftDetector().validatePost(input);
    const driftIssues = issues.filter((i) => i.validator === 'voice_drift');
    expect(driftIssues).toHaveLength(0);
  });
});
