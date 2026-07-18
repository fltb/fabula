import { describe, it, expect } from 'vitest';
import { PronounValidator } from '../../src/validator/pronoun.js';
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
    participants: { entities: ['char_hero'] },
    ...overrides,
  };
}

function makeInput(
  event: NarrativeEvent,
  prose: string,
  worldEntities: Record<string, Record<string, unknown>>,
  analysis: AnalysisResult | null = null,
): PostRenderInput {
  return {
    event,
    worldState: {
      entities: worldEntities,
      relationships: {},
      knowledge: {},
      threads: {},
      rules: {},
      facts: [],
    },
    prose,
    analysis,
    chapter: 1,
  };
}

describe('PronounValidator', () => {
  it('should report nothing when pronouns match declared gender', () => {
    const event = makeEvent({ id: 'E1' });
    const prose = 'He walked to the door. His hand trembled as he reached for the handle.';
    const entities = {
      char_hero: { name: 'Hero', gender: 'male' },
    };
    const input = makeInput(event, prose, entities);
    const issues = new PronounValidator().validatePost(input);
    const pronounIssues = issues.filter(i => i.validator === 'pronoun');
    expect(pronounIssues).toHaveLength(0);
  });

  it('should report issue when pronouns mismatch declared gender', () => {
    const event = makeEvent({ id: 'E1' });
    const prose = 'She walked to the door. Her hand trembled as she reached for the handle.';
    const entities = {
      char_hero: { name: 'Hero', gender: 'male' },
    };
    const input = makeInput(event, prose, entities);
    const issues = new PronounValidator().validatePost(input);
    const pronounIssues = issues.filter(i => i.validator === 'pronoun');
    expect(pronounIssues.length).toBeGreaterThanOrEqual(1);
    expect(pronounIssues[0].message).toContain('male');
    expect(pronounIssues[0].message).toContain('female pronouns');
    expect(pronounIssues[0].severity).toBe('warning');
  });
});
