import { describe, expect, it } from 'vitest';
import type { AnalysisResult, NarrativeEvent, PostRenderInput } from '../../src/types/index.js';
import { AppearanceValidator } from '../../src/validator/appearance.js';

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

function makeInput(
  event: NarrativeEvent,
  analysis: AnalysisResult | null,
  worldEntities?: Record<string, Record<string, unknown>>,
): PostRenderInput {
  return {
    event,
    worldState: {
      entities: worldEntities ?? {},
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

function makeAnalysis(
  appearanceChecks: Array<{
    entityId: string;
    feature: string;
    declared: string;
    evidence: string;
    matchLevel: 'exact' | 'similar' | 'absent' | 'contradicted';
  }>,
): AnalysisResult {
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
      appearanceChecks,
    },
  };
}

describe('AppearanceValidator', () => {
  it('should report nothing when matchLevel is exact', () => {
    const event = makeEvent({ id: 'E1' });
    const analysis = makeAnalysis([
      {
        entityId: 'char_hero',
        feature: 'eye_color',
        declared: 'blue',
        evidence: 'His blue eyes gleamed in the firelight.',
        matchLevel: 'exact',
      },
    ]);
    const worldEntities = {
      char_hero: { name: 'Hero' },
    };
    const input = makeInput(event, analysis, worldEntities);
    const issues = new AppearanceValidator().validatePost(input);
    const appIssues = issues.filter((i) => i.validator === 'appearance');
    expect(appIssues).toHaveLength(0);
  });

  it('should report issue when matchLevel is contradicted', () => {
    const event = makeEvent({ id: 'E1' });
    const analysis = makeAnalysis([
      {
        entityId: 'char_hero',
        feature: 'eye_color',
        declared: 'blue',
        evidence: 'His brown eyes gleamed in the firelight.',
        matchLevel: 'contradicted',
      },
    ]);
    const worldEntities = {
      char_hero: { name: 'Hero' },
    };
    const input = makeInput(event, analysis, worldEntities);
    const issues = new AppearanceValidator().validatePost(input);
    const appIssues = issues.filter((i) => i.validator === 'appearance');
    expect(appIssues.length).toBeGreaterThanOrEqual(1);
    expect(appIssues[0].message).toContain('Contradicted');
    expect(appIssues[0].severity).toBe('error');
  });
});
