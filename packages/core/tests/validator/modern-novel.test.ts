import { describe, expect, it } from 'vitest';
import type {
  AnalysisResult,
  NarrativeEvent,
  PostRenderInput,
  PreRenderInput,
} from '../../src/types/index.js';
import { AntiCausalEdgeValidator } from '../../src/validator/anti-causal.js';
import { CausalOverloadValidator } from '../../src/validator/causal-overload.js';
import { ChapterOrderValidator } from '../../src/validator/chapter-order.js';
import { SurfaceModeValidator } from '../../src/validator/surface-mode.js';

// ── Helpers ───────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<NarrativeEvent> & { id: string }): NarrativeEvent {
  return {
    event: overrides.id,
    narrativeOrder: 1,
    title: 'Test Scene',
    storyTime: { type: 'relative' as const, anchor: 'day_1', offset: 0 },
    sceneType: 'linear' as const,
    pov: { character: 'char_hero', type: 'third_person_limited' as const },
    sceneBrief: 'A test scene.',
    preconditions: [],
    postconditions: [],
    threadProgress: [],
    foreshadowing: [],
    relationshipEffects: [],
    ruleEffects: [],
    source: 'genesis' as const,
    branchExistence: { type: 'all' as const },
    participants: { entities: [] },
    ...overrides,
  };
}

function makePreInput(
  event: NarrativeEvent,
  overrides: Partial<PreRenderInput> = {},
): PreRenderInput {
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
    events: [],
    entityRegistry: { entities: {}, types: {} },
    chapter: 1,
    queryState: () => undefined,
    getKnowledge: () => ({
      propositions: {},
      beliefs: {},
      claims: {},
      evaluations: {},
    }),
    getThreadProgress: () => null,
    ...overrides,
  };
}

function makePostInput(
  event: NarrativeEvent,
  analysis: AnalysisResult | null = null,
  overrides: Partial<PostRenderInput> = {},
): PostRenderInput {
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
    prose: 'Some rendered prose.',
    analysis,
    chapter: 1,
    ...overrides,
  };
}

function makeAnalysis(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
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
    },
    ...overrides,
  };
}

// ── AntiCausalEdgeValidator ──────────────────────────────────────────────

describe('AntiCausalEdgeValidator', () => {
  it('should emit info issue when anti-causal edge detection is enabled', () => {
    const validator = new AntiCausalEdgeValidator();
    const event = makeEvent({
      id: 'E1',
      modernNovel: {
        antiCausalEdge: { enabled: true, threshold: 0.5 },
      },
    });
    const input = makePostInput(event);
    const issues = validator.validatePost(input);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      validator: 'antiCausalEdge',
      severity: 'info',
    });
    expect(issues[0].message).toContain('threshold=0.5');
  });

  it('should return no issues when anti-causal edge is not enabled', () => {
    const validator = new AntiCausalEdgeValidator();
    const event = makeEvent({ id: 'E2' });
    const input = makePostInput(event);
    expect(validator.validatePost(input)).toEqual([]);
  });
});

// ── ChapterOrderValidator ────────────────────────────────────────────────

describe('ChapterOrderValidator', () => {
  it('should warn when orderContested is true but fewer than 2 variants', () => {
    const validator = new ChapterOrderValidator();
    const event = makeEvent({
      id: 'E1',
      modernNovel: {
        chapterOrder: {
          orderContested: true,
          renderingVariants: ['version-a'],
        },
      },
    });
    const input = makePreInput(event);
    const issues = validator.validatePre(input);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      validator: 'chapterOrder',
      severity: 'warning',
    });
    expect(issues[0].message).toContain('1 rendering variant');
  });

  it('should warn when orderContested is true and variants is empty', () => {
    const validator = new ChapterOrderValidator();
    const event = makeEvent({
      id: 'E2',
      modernNovel: {
        chapterOrder: {
          orderContested: true,
        },
      },
    });
    const input = makePreInput(event);
    const issues = validator.validatePre(input);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('0 rendering variant');
  });

  it('should pass when orderContested is true with 2+ variants', () => {
    const validator = new ChapterOrderValidator();
    const event = makeEvent({
      id: 'E3',
      modernNovel: {
        chapterOrder: {
          orderContested: true,
          renderingVariants: ['version-a', 'version-b', 'version-c'],
        },
      },
    });
    const input = makePreInput(event);
    expect(validator.validatePre(input)).toEqual([]);
  });

  it('should pass when orderContested is false', () => {
    const validator = new ChapterOrderValidator();
    const event = makeEvent({
      id: 'E4',
      modernNovel: {
        chapterOrder: {
          orderContested: false,
        },
      },
    });
    const input = makePreInput(event);
    expect(validator.validatePre(input)).toEqual([]);
  });

  it('should pass when chapterOrder is not configured', () => {
    const validator = new ChapterOrderValidator();
    const event = makeEvent({ id: 'E5' });
    const input = makePreInput(event);
    expect(validator.validatePre(input)).toEqual([]);
  });
});

// ── SurfaceModeValidator ─────────────────────────────────────────────────

describe('SurfaceModeValidator', () => {
  it('should warn when surfaceMode enabled and Pass 2 detects internal POV', () => {
    const validator = new SurfaceModeValidator();
    const event = makeEvent({
      id: 'E1',
      modernNovel: {
        surfaceMode: { enabled: true },
      },
    });
    const analysis = makeAnalysis({
      analysis: {
        ...makeAnalysis().analysis,
        narrativeChecks: [
          {
            entityId: 'E1',
            attribute: 'internal_pov',
            hint: 'Character introspection detected',
            evidence: 'She wondered if...',
            matchLevel: 'exact' as const,
          },
        ],
      },
    });
    const input = makePostInput(event, analysis);
    const issues = validator.validatePost(input);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      validator: 'surfaceMode',
      severity: 'warning',
    });
    expect(issues[0].message).toContain('internal_pov');
  });

  it('should warn when surfaceMode enabled and Pass 2 detects psychological markers', () => {
    const validator = new SurfaceModeValidator();
    const event = makeEvent({
      id: 'E2',
      modernNovel: {
        surfaceMode: { enabled: true },
      },
    });
    const analysis = makeAnalysis({
      analysis: {
        ...makeAnalysis().analysis,
        narrativeChecks: [
          {
            entityId: 'E2',
            attribute: 'psychological_activity',
            hint: 'Emotional reaction described',
            evidence: 'He felt a surge of anger',
            matchLevel: 'exact' as const,
          },
        ],
      },
    });
    const input = makePostInput(event, analysis);
    const issues = validator.validatePost(input);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('psychological_activity');
  });

  it('should pass when surfaceMode enabled but no internal markers in Pass 2', () => {
    const validator = new SurfaceModeValidator();
    const event = makeEvent({
      id: 'E3',
      modernNovel: {
        surfaceMode: { enabled: true },
      },
    });
    const analysis = makeAnalysis({
      analysis: {
        ...makeAnalysis().analysis,
        narrativeChecks: [
          {
            entityId: 'E3',
            attribute: 'setting_description',
            hint: 'Describe the room layout',
            evidence: 'The room was bare except for a wooden table',
            matchLevel: 'exact' as const,
          },
        ],
      },
    });
    const input = makePostInput(event, analysis);
    expect(validator.validatePost(input)).toEqual([]);
  });

  it('should pass when surfaceMode is not enabled', () => {
    const validator = new SurfaceModeValidator();
    const event = makeEvent({ id: 'E4' });
    const analysis = makeAnalysis({
      analysis: {
        ...makeAnalysis().analysis,
        narrativeChecks: [
          {
            entityId: 'E4',
            attribute: 'internal_pov',
            hint: 'Character introspection detected',
            evidence: 'She wondered...',
            matchLevel: 'exact' as const,
          },
        ],
      },
    });
    const input = makePostInput(event, analysis);
    expect(validator.validatePost(input)).toEqual([]);
  });

  it('should pass when surfaceMode is enabled but no analysis available', () => {
    const validator = new SurfaceModeValidator();
    const event = makeEvent({
      id: 'E5',
      modernNovel: {
        surfaceMode: { enabled: true },
      },
    });
    const input = makePostInput(event, null);
    expect(validator.validatePost(input)).toEqual([]);
  });
});

// ── CausalOverloadValidator ──────────────────────────────────────────────

describe('CausalOverloadValidator', () => {
  it('should warn when outgoing edges exceed branching threshold', () => {
    const validator = new CausalOverloadValidator();
    const event = makeEvent({
      id: 'E1',
      preconditions: [],
      postconditions: [
        { entity: 'e1', attribute: 'a1', value: 'v1' },
        { entity: 'e1', attribute: 'a2', value: 'v2' },
        { entity: 'e1', attribute: 'a3', value: 'v3' },
        { entity: 'e1', attribute: 'a4', value: 'v4' },
        { entity: 'e1', attribute: 'a5', value: 'v5' },
        { entity: 'e2', attribute: 'b1', value: 'w1' },
        { entity: 'e2', attribute: 'b2', value: 'w2' },
      ],
      modernNovel: {
        causalOverload: { enabled: true, branchingThreshold: 5 },
      },
    });
    const input = makePreInput(event);
    const issues = validator.validatePre(input);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      validator: 'causalOverload',
      severity: 'warning',
    });
    expect(issues[0].message).toContain('7 outgoing edges');
    expect(issues[0].message).toContain('threshold of 5');
  });

  it('should pass when outgoing edges are within branching threshold', () => {
    const validator = new CausalOverloadValidator();
    const event = makeEvent({
      id: 'E2',
      preconditions: [],
      postconditions: [
        { entity: 'e1', attribute: 'a1', value: 'v1' },
        { entity: 'e1', attribute: 'a2', value: 'v2' },
        { entity: 'e1', attribute: 'a3', value: 'v3' },
      ],
      modernNovel: {
        causalOverload: { enabled: true, branchingThreshold: 5 },
      },
    });
    const input = makePreInput(event);
    expect(validator.validatePre(input)).toEqual([]);
  });

  it('should pass when causal overload is not enabled', () => {
    const validator = new CausalOverloadValidator();
    const event = makeEvent({
      id: 'E3',
      postconditions: [
        { entity: 'e1', attribute: 'a1', value: 'v1' },
        { entity: 'e1', attribute: 'a2', value: 'v2' },
        { entity: 'e1', attribute: 'a3', value: 'v3' },
        { entity: 'e1', attribute: 'a4', value: 'v4' },
        { entity: 'e1', attribute: 'a5', value: 'v5' },
        { entity: 'e2', attribute: 'b1', value: 'w1' },
        { entity: 'e2', attribute: 'b2', value: 'w2' },
      ],
    });
    const input = makePreInput(event);
    expect(validator.validatePre(input)).toEqual([]);
  });

  it('should use default branching threshold of 5', () => {
    const validator = new CausalOverloadValidator();
    const event = makeEvent({
      id: 'E4',
      postconditions: [
        { entity: 'e1', attribute: 'a1', value: 'v1' },
        { entity: 'e1', attribute: 'a2', value: 'v2' },
        { entity: 'e1', attribute: 'a3', value: 'v3' },
        { entity: 'e1', attribute: 'a4', value: 'v4' },
        { entity: 'e1', attribute: 'a5', value: 'v5' },
        { entity: 'e2', attribute: 'b1', value: 'w1' },
      ],
      modernNovel: {
        // enabled but no branchingThreshold set — should use default 5
        causalOverload: { enabled: true, branchingThreshold: 5 },
      },
    });
    const input = makePreInput(event);
    const issues = validator.validatePre(input);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('6 outgoing edges');
    expect(issues[0].message).toContain('threshold of 5');
  });

  it('should pass when causalOverload config is absent', () => {
    const validator = new CausalOverloadValidator();
    const event = makeEvent({ id: 'E5' });
    const input = makePreInput(event);
    expect(validator.validatePre(input)).toEqual([]);
  });
});
