import { describe, it, expect } from 'vitest';
import { TenseConsistencyValidator } from '../../src/validator/tense-consistency.js';
import type { NarrativeEvent, PostRenderInput, AnalysisResult } from '../../src/types/index.js';

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
    const tenseIssues = issues.filter(i => i.validator === 'tense_consistency');
    expect(tenseIssues).toHaveLength(0);
  });

  it('should report issue when tenseDetected mismatches declared tense', () => {
    const event = makeEvent({ id: 'E1', tense: 'past' });
    const analysis = makeAnalysis({ tenseDetected: 'present' });
    const input = makeInput(event, analysis);

    const issues = new TenseConsistencyValidator().validatePost(input);
    const tenseIssues = issues.filter(i => i.validator === 'tense_consistency');
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
