import { describe, expect, it } from 'vitest';
import type { AnalysisResult, NarrativeEvent, PostRenderInput } from '../../src/types/index.js';
import { ConflictValidator } from '../../src/validator/conflict.js';

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

function makeAnalysis(conflictAnalysis: {
  primaryType: string;
  resolutionAchieved: boolean;
}): AnalysisResult {
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
      conflictAnalysis,
    },
  };
}

describe('ConflictValidator', () => {
  it('should report nothing when resolutionType matches analysis', () => {
    const event = makeEvent({
      id: 'E1',
      resolutionType: 'character_growth',
      conflictType: 'internal',
    });
    const analysis = makeAnalysis({
      primaryType: 'internal',
      resolutionAchieved: true,
    });
    const input = makeInput(event, analysis);
    const issues = new ConflictValidator().validatePost(input);
    const conflictIssues = issues.filter((i) => i.validator === 'conflict');
    expect(conflictIssues).toHaveLength(0);
  });

  it('should report error when resolution type is declared but not achieved', () => {
    const event = makeEvent({
      id: 'E1',
      resolutionType: 'character_growth',
      conflictType: 'internal',
    });
    const analysis = makeAnalysis({
      primaryType: 'internal',
      resolutionAchieved: false,
    });
    const input = makeInput(event, analysis);
    const issues = new ConflictValidator().validatePost(input);
    const conflictIssues = issues.filter((i) => i.validator === 'conflict');
    expect(conflictIssues.length).toBeGreaterThanOrEqual(1);
    expect(conflictIssues[0].message).toContain('resolution was NOT achieved');
    expect(conflictIssues[0].severity).toBe('error');
  });

  it('should report info when conflictType mismatches analysis primaryType', () => {
    const event = makeEvent({
      id: 'E1',
      resolutionType: 'character_growth',
      conflictType: 'internal',
    });
    const analysis = makeAnalysis({
      primaryType: 'external',
      resolutionAchieved: true,
    });
    const input = makeInput(event, analysis);
    const issues = new ConflictValidator().validatePost(input);
    const mismatchIssues = issues.filter((i) => i.message.includes('declares conflict type'));
    expect(mismatchIssues.length).toBeGreaterThanOrEqual(1);
    expect(mismatchIssues[0].severity).toBe('info');
  });

  it('should NOT error when resolutionType is "setup" and Pass 2 says resolutionAchieved=false', () => {
    const event = makeEvent({
      id: 'E1',
      resolutionType: 'setup',
      conflictType: 'person_vs_fate',
    });
    const analysis = makeAnalysis({
      primaryType: 'person_vs_fate',
      resolutionAchieved: false,
    });
    const input = makeInput(event, analysis);
    const issues = new ConflictValidator().validatePost(input);
    const errorIssues = issues.filter((i) => i.severity === 'error');
    // setup is non-resolving — no error about resolution not achieved
    expect(errorIssues).toHaveLength(0);
  });

  it('should NOT error when resolutionType is "ongoing" and Pass 2 says resolutionAchieved=false', () => {
    const event = makeEvent({
      id: 'E1',
      resolutionType: 'ongoing',
      conflictType: 'person_vs_society',
    });
    const analysis = makeAnalysis({
      primaryType: 'person_vs_society',
      resolutionAchieved: false,
    });
    const input = makeInput(event, analysis);
    const issues = new ConflictValidator().validatePost(input);
    const errorIssues = issues.filter((i) => i.severity === 'error');
    expect(errorIssues).toHaveLength(0);
  });

  it('should still error when a declared resolving resolutionType has resolutionAchieved=false', () => {
    const event = makeEvent({
      id: 'E1',
      resolutionType: 'character_growth',
      conflictType: 'internal',
    });
    const analysis = makeAnalysis({
      primaryType: 'internal',
      resolutionAchieved: false,
    });
    const input = makeInput(event, analysis);
    const issues = new ConflictValidator().validatePost(input);
    const errorIssues = issues.filter((i) => i.severity === 'error');
    expect(errorIssues.length).toBeGreaterThanOrEqual(1);
    expect(errorIssues[0].message).toContain('resolution was NOT achieved');
  });
});
