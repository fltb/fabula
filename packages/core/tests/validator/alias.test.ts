import { describe, it, expect } from 'vitest';
import { AliasValidator } from '../../src/validator/alias.js';
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

function makeAnalysis(charRefs: Array<{ entityId: string; namesUsed: string[] }>): AnalysisResult {
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
      characterReferences: charRefs,
    },
  };
}

describe('AliasValidator', () => {
  it('should report nothing when namesUsed all match known names', () => {
    const event = makeEvent({ id: 'E1' });
    const analysis = makeAnalysis([
      { entityId: 'char_rainsford', namesUsed: ['Rainsford', 'rainsford'] },
    ]);
    const worldEntities = {
      char_rainsford: {
        name: 'Sanger Rainsford',
        aliases: ['Rainsford', 'Sanger'],
      },
    };
    const input = makeInput(event, analysis, worldEntities);
    const issues = new AliasValidator().validatePost(input);
    const aliasIssues = issues.filter(i => i.validator === 'alias');
    expect(aliasIssues).toHaveLength(0);
  });

  it('should report info issue when unknown name is used', () => {
    const event = makeEvent({ id: 'E1' });
    const analysis = makeAnalysis([
      { entityId: 'char_rainsford', namesUsed: ['Zargoth'] },
    ]);
    const worldEntities = {
      char_rainsford: {
        name: 'Sanger Rainsford',
        aliases: ['Rainsford', 'Sanger'],
      },
    };
    const input = makeInput(event, analysis, worldEntities);
    const issues = new AliasValidator().validatePost(input);
    const aliasIssues = issues.filter(i => i.validator === 'alias');
    expect(aliasIssues.length).toBeGreaterThanOrEqual(1);
    expect(aliasIssues[0].message).toContain('Zargoth');
    expect(aliasIssues[0].severity).toBe('info');
  });
});
