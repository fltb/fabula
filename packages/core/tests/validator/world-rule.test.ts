import { describe, expect, it } from 'vitest';
import type { AnalysisResult, NarrativeEvent, PostRenderInput } from '../../src/types/index.js';
import { WorldRuleValidator } from '../../src/validator/world-rule.js';

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

function makeAnalysis(
  ruleChecks: Array<{
    ruleId: string;
    violated: boolean;
    evidence: string;
    severity: 'minor' | 'major';
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
      ruleChecks,
    },
  };
}

describe('WorldRuleValidator', () => {
  it('should report error when rule is violated with major severity', () => {
    const event = makeEvent({ id: 'E1' });
    const analysis = makeAnalysis([
      {
        ruleId: 'R1',
        violated: true,
        evidence: 'The character used magic freely.',
        severity: 'major',
      },
    ]);
    const input = makeInput(event, analysis);
    const issues = new WorldRuleValidator().validatePost(input);
    const ruleIssues = issues.filter((i) => i.validator === 'world_rule');
    expect(ruleIssues).toHaveLength(1);
    expect(ruleIssues[0].severity).toBe('error');
    expect(ruleIssues[0].entity).toBe('R1');
    expect(ruleIssues[0].message).toContain('World rule violation');
  });

  it('should report warning when rule is violated with minor severity', () => {
    const event = makeEvent({ id: 'E1' });
    const analysis = makeAnalysis([
      {
        ruleId: 'R2',
        violated: true,
        evidence: 'The character bent the rules slightly.',
        severity: 'minor',
      },
    ]);
    const input = makeInput(event, analysis);
    const issues = new WorldRuleValidator().validatePost(input);
    const ruleIssues = issues.filter((i) => i.validator === 'world_rule');
    expect(ruleIssues).toHaveLength(1);
    expect(ruleIssues[0].severity).toBe('warning');
    expect(ruleIssues[0].entity).toBe('R2');
    expect(ruleIssues[0].message).toContain('World rule violation');
  });

  it('should report nothing when rule is not violated', () => {
    const event = makeEvent({ id: 'E1' });
    const analysis = makeAnalysis([
      {
        ruleId: 'R1',
        violated: false,
        evidence: 'The character refrained from using magic.',
        severity: 'minor',
      },
    ]);
    const input = makeInput(event, analysis);
    const issues = new WorldRuleValidator().validatePost(input);
    const ruleIssues = issues.filter((i) => i.validator === 'world_rule');
    expect(ruleIssues).toHaveLength(0);
  });

  it('should return empty array when analysis is null', () => {
    const event = makeEvent({ id: 'E1' });
    const input = makeInput(event, null);
    const issues = new WorldRuleValidator().validatePost(input);
    expect(issues).toHaveLength(0);
  });

  it('should return empty array when ruleChecks is empty', () => {
    const event = makeEvent({ id: 'E1' });
    const analysis = makeAnalysis([]);
    const input = makeInput(event, analysis);
    const issues = new WorldRuleValidator().validatePost(input);
    expect(issues).toHaveLength(0);
  });
});
