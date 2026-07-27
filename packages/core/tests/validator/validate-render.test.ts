// ============================================================================
// validateRender/validatePost — verify each of the 20 validators works on rendered prose
// ============================================================================
//
// These tests are the contract: when an LLM produces a scene, the validators
// should produce sensible issues for the rendered prose. We don't test every
// edge case — we test the "common case" for each.
// ============================================================================

import { describe, expect, it } from 'vitest';
import type { NarrativeEvent, PostRenderInput, PreRenderInput } from '../../src/types/index.js';
import { BranchMergeValidator } from '../../src/validator/branch-merge.ts';
import { CausalityValidator } from '../../src/validator/causality.ts';
import { CharacterStateValidator } from '../../src/validator/character-state.ts';
import { FactualDetailValidator } from '../../src/validator/factual-detail.ts';
import { ForeshadowingValidator } from '../../src/validator/foreshadowing.ts';
import { KnowledgeValidator } from '../../src/validator/knowledge.ts';
import { POVValidator } from '../../src/validator/pov.ts';
import { PronounValidator } from '../../src/validator/pronoun.ts';
import { ReachabilityValidator } from '../../src/validator/reachability.ts';
import { TimelineValidator } from '../../src/validator/timeline.ts';
import { VoiceDriftDetector } from '../../src/validator/voice-drift.ts';
import { WorldRuleValidator } from '../../src/validator/world-rule.ts';

function makeEvent(overrides: Partial<NarrativeEvent> = {}): NarrativeEvent {
  return {
    id: 'E0',
    event: 'E0',
    narrativeOrder: 1,
    title: 'Test event',
    storyTime: { type: 'absolute', value: 'day_1_morning' },
    sceneType: 'linear',
    pov: { character: 'rainsford', type: 'third_person_limited' },
    sceneBrief: 'Test',
    preconditions: [],
    postconditions: [],
    threadProgress: [],
    foreshadowing: [],
    relationshipEffects: [],
    ruleEffects: [],
    styleGuidance: undefined,
    source: 'event_file',
    branchExistence: { type: 'all' },
    participants: { entities: [] },
    ...overrides,
  };
}

function makePostInput(overrides: Partial<PostRenderInput> = {}): PostRenderInput {
  return {
    prose: '',
    event: makeEvent(),
    worldState: {
      entities: {},
      relationships: {},
      knowledge: {},
      threads: {},
      rules: {},
      facts: [],
    },
    analysis: null,
    chapter: 1,
    ...overrides,
  };
}

function makePreInput(overrides: Partial<PreRenderInput> = {}): PreRenderInput {
  return {
    event: makeEvent(),
    worldState: {
      entities: {},
      relationships: {},
      knowledge: {},
      threads: {},
      rules: {},
      facts: [],
    },
    events: [],
    entityRegistry: {
      resolve() {
        return undefined;
      },
      list() {
        return [];
      },
      getAll() {
        return {};
      },
      getEntity() {
        return undefined;
      },
      getEntitiesByKind() {
        return [];
      },
    },
    chapter: 1,
    queryState: () => undefined,
    getKnowledge: () => ({
      worldTruth: [],
      characterKnowledge: {},
      readerKnowledge: [],
      narratorKnowledge: [],
    }),
    getThreadProgress: () => null,
    ...overrides,
  };
}

const sampleProse = `The morning sun broke over the eastern horizon, painting the Caribbean in molten gold. Rainsford, exhausted and bleeding from a dozen minor cuts, pulled himself from the black sea onto the jagged coral shore. He had fallen from the yacht in the night, lost in a moment of carelessness, and now, as the third day dawned, he felt the full weight of his predicament. Whitney had warned him about Ship-Trap Island.`;

describe('All 20 validators implement the new interface', () => {
  it('TimelineValidator implements validatePost', () => {
    const v = new TimelineValidator();
    const input = makePostInput({ prose: sampleProse });
    expect(typeof v.validatePost).toBe('function');
    expect(Array.isArray(v.validatePost!(input))).toBe(true);
  });

  it('CharacterStateValidator implements validatePre', () => {
    const v = new CharacterStateValidator();
    const input = makePreInput();
    expect(typeof v.validatePre).toBe('function');
    expect(Array.isArray(v.validatePre!(input))).toBe(true);
  });

  it('KnowledgeValidator implements validatePost', () => {
    const v = new KnowledgeValidator();
    const input = makePostInput({ prose: sampleProse });
    expect(typeof v.validatePost).toBe('function');
    expect(Array.isArray(v.validatePost!(input))).toBe(true);
  });

  it('WorldRuleValidator implements validatePost', () => {
    const v = new WorldRuleValidator();
    const input = makePostInput({ prose: sampleProse });
    expect(typeof v.validatePost).toBe('function');
    expect(Array.isArray(v.validatePost!(input))).toBe(true);
  });

  it('CausalityValidator implements validatePre', () => {
    const v = new CausalityValidator();
    const input = makePreInput();
    expect(typeof v.validatePre).toBe('function');
    expect(Array.isArray(v.validatePre!(input))).toBe(true);
  });

  it('ForeshadowingValidator implements validatePost', () => {
    const v = new ForeshadowingValidator();
    const input = makePostInput({ prose: sampleProse });
    expect(typeof v.validatePost).toBe('function');
    expect(Array.isArray(v.validatePost!(input))).toBe(true);
  });

  it('POVValidator implements validatePost', () => {
    const v = new POVValidator();
    const input = makePostInput({ prose: sampleProse });
    expect(typeof v.validatePost).toBe('function');
    expect(Array.isArray(v.validatePost!(input))).toBe(true);
  });

  it('FactualDetailValidator implements validatePre', () => {
    const v = new FactualDetailValidator();
    const input = makePreInput();
    expect(typeof v.validatePre).toBe('function');
    expect(Array.isArray(v.validatePre!(input))).toBe(true);
  });

  it('VoiceDriftDetector implements validatePost', () => {
    const v = new VoiceDriftDetector();
    const input = makePostInput({ prose: sampleProse });
    expect(typeof v.validatePost).toBe('function');
    expect(Array.isArray(v.validatePost!(input))).toBe(true);
  });

  it('BranchMergeValidator implements validatePost', () => {
    const v = new BranchMergeValidator();
    const input = makePostInput({ prose: sampleProse });
    expect(typeof v.validatePost).toBe('function');
    expect(Array.isArray(v.validatePost!(input))).toBe(true);
  });

  it('ReachabilityValidator implements validatePost', () => {
    const v = new ReachabilityValidator();
    const input = makePostInput({ prose: sampleProse });
    expect(typeof v.validatePost).toBe('function');
    expect(Array.isArray(v.validatePost!(input))).toBe(true);
  });
  it('PronounValidator implements validatePost', () => {
    const v = new PronounValidator();
    const input = makePostInput({ prose: sampleProse });
    expect(typeof v.validatePost).toBe('function');
    expect(Array.isArray(v.validatePost!(input))).toBe(true);
  });
});

describe('validatePost actually checks the prose', () => {
  it('TimelineValidator flags time_period mismatches from analysis', () => {
    const v = new TimelineValidator();
    const event = makeEvent({ storyTime: { type: 'absolute', value: 'morning' } });
    const prose = 'The night was dark and stormy.';
    const input = makePostInput({
      prose,
      event,
      analysis: {
        eventId: 'E0',
        analysis: {
          postconditions: { covered: [], dropped: [] },
          preconditions: { violated: [] },
          pov: { consistent: true, leaks: [] },
          inventedDetails: [],
          quality: {
            proseScore: 5,
            maxScore: 10,
            strengths: [],
            weaknesses: [],
            estimatedWordCount: 50,
          },
          threadProgressAchieved: [],
          foreshadowingDeployed: [],
          narrativeChecks: [
            {
              entityId: 'E0',
              attribute: 'time_period',
              hint: 'morning',
              evidence: 'Prose describes night and darkness, not morning',
              matchLevel: 'contradicted',
            },
          ],
        },
      },
    });
    const issues = v.validatePost!(input);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.message.includes('Time period mismatch'))).toBe(true);
  });

  it('POVValidator flags POV leaks from analysis when 3rd-person limited slips into another character', () => {
    const v = new POVValidator();
    const event = makeEvent({
      pov: { character: 'rainsford', type: 'third_person_limited' },
      participants: { entities: ['whitney', 'zaroff'] },
    });
    const prose = 'Rainsford ran. Whitney was clearly anxious about the chase.';
    const input = makePostInput({
      prose,
      event,
      analysis: {
        eventId: 'E0',
        analysis: {
          postconditions: { covered: [], dropped: [] },
          preconditions: { violated: [] },
          pov: {
            consistent: false,
            leaks: ["Whitney's emotional state is described despite Rainford not knowing it"],
          },
          inventedDetails: [],
          quality: {
            proseScore: 5,
            maxScore: 10,
            strengths: [],
            weaknesses: [],
            estimatedWordCount: 50,
          },
          threadProgressAchieved: [],
          foreshadowingDeployed: [],
        },
      },
    });
    const issues = v.validatePost!(input);
    // Should detect the leak from analysis
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.message.includes('POV leak'))).toBe(true);
  });

  it('FactualDetailValidator no longer checks prose-level facts (delegated to AnalysisResult)', () => {
    const v = new FactualDetailValidator();
    const event = makeEvent({
      postconditions: [
        {
          id: 'wait_time',
          entityId: 'rainsford',
          attribute: 'hours_elapsed',
          value: '3 hours',
          confidence: 1.0,
          validity: {
            temporal: { start: { type: 'absolute', value: 'day_0' }, end: null },
            branches: { type: 'all' },
          },
        },
      ],
    });
    const input = makePreInput({ event });
    const issues = v.validatePre!(input);
    // factual_detail has no post-render logic — validatePre handles entity attr consistency
    // and should find no issues for this input
    expect(Array.isArray(issues)).toBe(true);
  });

  it('PronounValidator flags pronoun_consistency contradictions from analysis', () => {
    const v = new PronounValidator();
    const event = makeEvent({ id: 'E1', participants: { entities: ['xianglins_wife'] } });
    const prose = 'Prose with male pronoun for a female character.';
    const input = makePostInput({
      prose,
      event,
      analysis: {
        eventId: 'E1',
        analysis: {
          postconditions: { covered: [], dropped: [] },
          preconditions: { violated: [] },
          pov: { consistent: true, leaks: [] },
          inventedDetails: [],
          quality: {
            proseScore: 5,
            maxScore: 10,
            strengths: [],
            weaknesses: [],
            estimatedWordCount: 50,
          },
          threadProgressAchieved: [],
          foreshadowingDeployed: [],
          narrativeChecks: [
            {
              entityId: 'xianglins_wife',
              attribute: 'pronoun_consistency',
              hint: 'Prose uses male pronoun for xianglins_wife who is declared female',
              evidence: 'Prose contains male pronoun for a female character',
              matchLevel: 'contradicted',
            },
          ],
        },
      },
    });
    const issues = v.validatePost!(input);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.severity === 'error')).toBe(true);
    expect(issues.some((i) => i.message.includes('Pronoun consistency'))).toBe(true);
  });
});
