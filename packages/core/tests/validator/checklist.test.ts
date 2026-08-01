import { describe, expect, it } from 'vitest';
import type { AnalysisResult, NarrativeEvent, PostRenderInput } from '../../src/types/index.js';
import { ChecklistValidator } from '../../src/validator/checklist.js';
import { makeObservations, makeProtocol } from '../fixtures/mock-pass2-helpers.ts';

const PROSE = 'Some prose about the scene.';

function makeEvent(overrides: Partial<NarrativeEvent> & { id: string }): NarrativeEvent {
  return {
    event: overrides.id,
    narrativeOrder: 1,
    title: 'Test Scene',
    storyTime: { type: 'relative' as const, anchor: 'day_1', offset: 0 },
    sceneType: 'linear' as const,
    pov: { character: 'char_hero', type: 'third_person_limited' as const },
    sceneBrief: 'A test scene.',
    beats: ['A test scene.'],
    preconditions: [],
    postconditions: [],
    threadProgress: [],
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
    prose: PROSE,
    analysis,
    chapter: 1,
  };
}

function makeAnalysis(overrides: Record<string, unknown> = {}): AnalysisResult {
  const payload: Record<string, unknown> = {
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
    narrativeChecks: [],
    appearanceChecks: [],
    characterReferences: [],
    tenseDetected: 'past' as const,
    conflictAnalysis: {
      present: false,
      type: 'none',
      intensity: 0,
      parties: [],
    },
    ruleChecks: [],
    knowledgeChecks: [],
    checklistResults: [],
    ...overrides,
  };
  return {
    eventId: 'E1',
    protocol: makeProtocol(PROSE),
    observations: makeObservations(payload, PROSE),
    analysis: payload,
  };
}

describe('ChecklistValidator', () => {
  it('should pass when all required checklist items are covered', () => {
    const event = makeEvent({
      id: 'E1',
      narrativeChecklist: {
        items: [
          {
            dimension: '诗词',
            description: 'Include classical poetry reference',
            required: true,
          },
          {
            dimension: '对话个性',
            description: 'Show distinctive dialogue voice',
            required: true,
          },
        ],
      },
    });

    const analysis = makeAnalysis({
      checklistResults: [
        { dimension: '诗词', covered: true, evidence: '“月落乌啼霜满天”' },
        { dimension: '对话个性', covered: true },
      ],
    });

    const input = makeInput(event, analysis);
    const issues = new ChecklistValidator().validatePost(input);
    const checklistIssues = issues.filter((i) => i.validator === 'checklist');
    expect(checklistIssues).toHaveLength(0);
  });

  it('should warn when a required item has no matching checklistResult', () => {
    const event = makeEvent({
      id: 'E1',
      narrativeChecklist: {
        items: [
          {
            dimension: '反讽距离',
            description: 'Maintain ironic distance in narration',
            required: true,
          },
        ],
      },
    });

    const analysis = makeAnalysis({
      // No checklistResults for '反讽距离'
      checklistResults: [{ dimension: '诗词', covered: true }],
    });

    const input = makeInput(event, analysis);
    const issues = new ChecklistValidator().validatePost(input);
    const checklistIssues = issues.filter((i) => i.validator === 'checklist');
    expect(checklistIssues).toHaveLength(1);
    expect(checklistIssues[0].message).toContain('反讽距离');
    expect(checklistIssues[0].message).toContain('not evaluated');
  });

  it('should warn when a required item has covered=false with evidence', () => {
    const event = makeEvent({
      id: 'E1',
      narrativeChecklist: {
        items: [
          {
            dimension: '草蛇灰线',
            description: 'Weave foreshadowing thread through description',
            required: true,
          },
        ],
      },
    });

    const analysis = makeAnalysis({
      checklistResults: [
        {
          dimension: '草蛇灰线',
          covered: false,
          evidence: 'No thread reference found in prose',
        },
      ],
    });

    const input = makeInput(event, analysis);
    const issues = new ChecklistValidator().validatePost(input);
    const checklistIssues = issues.filter((i) => i.validator === 'checklist');
    expect(checklistIssues).toHaveLength(1);
    expect(checklistIssues[0].message).toContain('草蛇灰线');
    expect(checklistIssues[0].message).toContain('not covered');
    expect(checklistIssues[0].message).toContain('No thread reference found');
  });

  it('should skip events without narrativeChecklist', () => {
    const event = makeEvent({ id: 'E1' });
    const analysis = makeAnalysis();
    const input = makeInput(event, analysis);
    const issues = new ChecklistValidator().validatePost(input);
    const checklistIssues = issues.filter((i) => i.validator === 'checklist');
    expect(checklistIssues).toHaveLength(0);
  });

  it('should skip events without analysis', () => {
    const event = makeEvent({
      id: 'E1',
      narrativeChecklist: {
        items: [
          {
            dimension: '诗词',
            description: 'Include poetry',
            required: true,
          },
        ],
      },
    });

    const input = makeInput(event, null);
    const issues = new ChecklistValidator().validatePost(input);
    const checklistIssues = issues.filter((i) => i.validator === 'checklist');
    expect(checklistIssues).toHaveLength(0);
  });

  it('should pass optional (non-required) items even when not covered', () => {
    const event = makeEvent({
      id: 'E1',
      narrativeChecklist: {
        items: [
          {
            dimension: '额外色彩',
            description: 'Add atmospheric detail',
            required: false,
          },
        ],
      },
    });

    const analysis = makeAnalysis({
      checklistResults: [],
    });

    const input = makeInput(event, analysis);
    const issues = new ChecklistValidator().validatePost(input);
    const checklistIssues = issues.filter((i) => i.validator === 'checklist');
    expect(checklistIssues).toHaveLength(0);
  });
});
