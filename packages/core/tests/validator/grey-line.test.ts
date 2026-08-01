import { describe, expect, it } from 'vitest';
import type { AnalysisResult, NarrativeEvent, PostRenderInput } from '../../src/types/index.js';
import { GreyLineValidator } from '../../src/validator/grey-line.js';

function makeEvent(overrides: Partial<NarrativeEvent> & { id: string }): NarrativeEvent {
  return {
    event: overrides.id,
    narrativeOrder: 1,
    title: 'Test Scene',
    storyTime: { type: 'relative' as const, anchor: 'day_1', offset: 0 },
    sceneType: 'linear',
    pov: { character: 'char_hero', type: 'third_person_limited' as const },
    sceneBrief: 'A test scene.',
    beats: ['A test scene.'],
    preconditions: [],
    postconditions: [],
    threadProgress: [],
    greyLines: [],
    foreshadowing: [],
    relationshipEffects: [],
    ruleEffects: [],
    source: 'event_file' as const,
    branchExistence: { type: 'all' as const },
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
    prose: 'The flower blooms in spring, a fragile beauty.',
    analysis,
    chapter: 1,
  };
}

function makeAnalysis(
  narrativeChecks: Array<{
    entityId: string;
    attribute: string;
    hint: string;
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
      narrativeChecks,
      appearanceChecks: [],
      characterReferences: [],
      tenseDetected: 'past',
      conflictAnalysis: { primaryType: 'none', resolutionAchieved: true },
      ruleChecks: [],
      knowledgeChecks: [],
    },
  };
}

describe('GreyLineValidator', () => {
  const validator = new GreyLineValidator();

  it('should pass when no grey lines are declared', () => {
    const event = makeEvent({ id: 'E1' });
    const input = makeInput(event, null);
    const issues = validator.validatePost(input);
    expect(issues).toHaveLength(0);
  });

  it('should pass when a valid grey line with imagery found in narrativeChecks', () => {
    const event = makeEvent({
      id: 'E1',
      greyLines: [
        {
          id: 'gl_flower',
          imagery: '花',
          nodes: [
            {
              eventId: 'E1',
              semanticAccumulation: 'Beauty fades but memory remains',
              narrativeOrder: 3,
            },
          ],
        },
      ],
    });
    const analysis = makeAnalysis([
      {
        entityId: 'char_hero',
        attribute: 'mood',
        hint: 'Contemplative',
        evidence: 'The old 花 blooms in spring, a fragile beauty.',
        matchLevel: 'exact',
      },
    ]);
    const input = makeInput(event, analysis);
    const issues = validator.validatePost(input);
    expect(issues).toHaveLength(0);
  });

  it('should warn when a node has an empty eventId', () => {
    const event = makeEvent({
      id: 'E1',
      greyLines: [
        {
          id: 'gl_flower',
          imagery: '花',
          nodes: [
            {
              eventId: '',
              semanticAccumulation: 'First encounter',
              narrativeOrder: 1,
            },
          ],
        },
      ],
    });
    const input = makeInput(event, null);
    const issues = validator.validatePost(input);
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].entity).toBe('gl_flower');
    expect(issues[0].message).toContain('empty');
  });

  it('should warn when duplicate eventId nodes exist in the same grey line', () => {
    const event = makeEvent({
      id: 'E1',
      greyLines: [
        {
          id: 'gl_flower',
          imagery: '花',
          nodes: [
            {
              eventId: 'E1',
              semanticAccumulation: 'First appearance',
              narrativeOrder: 1,
            },
            {
              eventId: 'E1',
              semanticAccumulation: 'Duplicate appearance',
              narrativeOrder: 2,
            },
          ],
        },
      ],
    });
    const input = makeInput(event, null);
    const issues = validator.validatePost(input);
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(
      issues.some((i) => i.message.includes('duplicate') || i.message.includes('multiple nodes')),
    ).toBe(true);
  });

  it('should warn when imagery text is not found in narrativeChecks evidence', () => {
    const event = makeEvent({
      id: 'E1',
      greyLines: [
        {
          id: 'gl_mirror',
          imagery: '镜',
          nodes: [
            {
              eventId: 'E1',
              semanticAccumulation: 'Self-reflection begins',
              narrativeOrder: 1,
            },
          ],
        },
      ],
    });
    // narrativeChecks evidence contains "flower" but not "镜"
    const analysis = makeAnalysis([
      {
        entityId: 'char_hero',
        attribute: 'mood',
        hint: 'Sad',
        evidence: 'The flower wilts under the rain.',
        matchLevel: 'exact',
      },
    ]);
    const input = makeInput(event, analysis);
    const issues = validator.validatePost(input);
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues.some((i) => i.message.includes('镜'))).toBe(true);
  });

  it('should handle missing analysis gracefully (no narrativeChecks)', () => {
    const event = makeEvent({
      id: 'E1',
      greyLines: [
        {
          id: 'gl_flower',
          imagery: '花',
          nodes: [
            {
              eventId: 'E1',
              semanticAccumulation: 'Blooming',
              narrativeOrder: 1,
            },
          ],
        },
      ],
    });
    const input = makeInput(event, null);
    // With no analysis, we skip the imagery check entirely
    const issues = validator.validatePost(input);
    // Only the eventId check may fire — E1 is non-empty so no issues
    expect(issues).toHaveLength(0);
  });

  it('should pass when multiple grey lines with different imagery are valid', () => {
    const event = makeEvent({
      id: 'E1',
      greyLines: [
        {
          id: 'gl_flower',
          imagery: '花',
          nodes: [
            {
              eventId: 'E1',
              semanticAccumulation: 'Beauty fades',
              narrativeOrder: 1,
            },
          ],
        },
        {
          id: 'gl_mirror',
          imagery: '镜',
          nodes: [
            {
              eventId: 'E2',
              semanticAccumulation: 'Self-reflection',
              narrativeOrder: 2,
            },
          ],
        },
      ],
    });
    const analysis = makeAnalysis([
      {
        entityId: 'char_hero',
        attribute: 'mood',
        hint: 'Contemplative',
        evidence: 'The old 花 blooms; a broken 镜 lies on the ground.',
        matchLevel: 'exact',
      },
    ]);
    const input = makeInput(event, analysis);
    const issues = validator.validatePost(input);
    expect(issues).toHaveLength(0);
  });
});
