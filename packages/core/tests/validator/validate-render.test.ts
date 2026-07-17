// ============================================================================
// validateRender — verify each of the 11 validators works on rendered prose
// ============================================================================
//
// These tests are the contract: when an LLM produces a scene, the validators
// should produce sensible issues for the rendered prose. We don't test every
// edge case — we test the "common case" for each.
// ============================================================================

import { describe, it, expect } from 'vitest';
import { TimelineValidator } from '../../src/validator/timeline.ts';
import { CharacterStateValidator } from '../../src/validator/character-state.ts';
import { KnowledgeValidator } from '../../src/validator/knowledge.ts';
import { WorldRuleValidator } from '../../src/validator/world-rule.ts';
import { CausalityValidator } from '../../src/validator/causality.ts';
import { ForeshadowingValidator } from '../../src/validator/foreshadowing.ts';
import { POVValidator } from '../../src/validator/pov.ts';
import { FactualDetailValidator } from '../../src/validator/factual-detail.ts';
import { VoiceDriftDetector } from '../../src/validator/voice-drift.ts';
import { BranchMergeValidator } from '../../src/validator/branch-merge.ts';
import { ReachabilityValidator } from '../../src/validator/reachability.ts';
import type { NarrativeEvent, WorldState } from '../../src/types/index.js';

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

const emptyState: WorldState = {
  entities: {},
  relationships: {},
  knowledge: {},
  threads: {},
  rules: {},
  facts: [],
};

const sampleProse = `The morning sun broke over the eastern horizon, painting the Caribbean in molten gold. Rainsford, exhausted and bleeding from a dozen minor cuts, pulled himself from the black sea onto the jagged coral shore. He had fallen from the yacht in the night, lost in a moment of carelessness, and now, as the third day dawned, he felt the full weight of his predicament. Whitney had warned him about Ship-Trap Island.`;

describe('All 11 validators implement validateRender', () => {
  it('TimelineValidator.validateRender returns an array', () => {
    const v = new TimelineValidator();
    expect(Array.isArray(v.validateRender(sampleProse, makeEvent(), emptyState))).toBe(true);
  });

  it('CharacterStateValidator.validateRender returns an array', () => {
    const v = new CharacterStateValidator();
    expect(Array.isArray(v.validateRender(sampleProse, makeEvent(), emptyState))).toBe(true);
  });

  it('KnowledgeValidator.validateRender returns an array', () => {
    const v = new KnowledgeValidator();
    expect(Array.isArray(v.validateRender(sampleProse, makeEvent(), emptyState))).toBe(true);
  });

  it('WorldRuleValidator.validateRender returns an array', () => {
    const v = new WorldRuleValidator();
    expect(Array.isArray(v.validateRender(sampleProse, makeEvent(), emptyState))).toBe(true);
  });

  it('CausalityValidator.validateRender returns an array', () => {
    const v = new CausalityValidator();
    expect(Array.isArray(v.validateRender(sampleProse, makeEvent(), emptyState))).toBe(true);
  });

  it('ForeshadowingValidator.validateRender returns an array', () => {
    const v = new ForeshadowingValidator();
    expect(Array.isArray(v.validateRender(sampleProse, makeEvent(), emptyState))).toBe(true);
  });

  it('POVValidator.validateRender returns an array', () => {
    const v = new POVValidator();
    expect(Array.isArray(v.validateRender(sampleProse, makeEvent(), emptyState))).toBe(true);
  });

  it('FactualDetailValidator.validateRender returns an array', () => {
    const v = new FactualDetailValidator();
    expect(Array.isArray(v.validateRender(sampleProse, makeEvent(), emptyState))).toBe(true);
  });

  it('VoiceDriftDetector.validateRender returns an array', () => {
    const v = new VoiceDriftDetector();
    expect(Array.isArray(v.validateRender(sampleProse, makeEvent(), emptyState))).toBe(true);
  });

  it('BranchMergeValidator.validateRender returns an array', () => {
    const v = new BranchMergeValidator();
    expect(Array.isArray(v.validateRender(sampleProse, makeEvent(), emptyState))).toBe(true);
  });

  it('ReachabilityValidator.validateRender returns an array', () => {
    const v = new ReachabilityValidator();
    expect(Array.isArray(v.validateRender(sampleProse, makeEvent(), emptyState))).toBe(true);
  });
});

describe('validateRender actually checks the prose', () => {
  it('TimelineValidator flags missing time-of-day markers when storyTime is morning', () => {
    const v = new TimelineValidator();
    const event = makeEvent({ storyTime: { type: 'absolute', value: 'morning' } });
    // Prose with no morning markers
    const prose = 'The night was dark and stormy. He crept through the forest.';
    const issues = v.validateRender(prose, event, emptyState);
    // Should warn about missing morning markers
    expect(issues.some((i) => /morning|dawn|day/i.test(i.message))).toBe(true);
  });

  it('POVValidator flags POV leak when 3rd-person limited slips into another character', () => {
    const v = new POVValidator();
    const event = makeEvent({
      pov: { character: 'rainsford', type: 'third_person_limited' },
      participants: { entities: ['whitney', 'zaroff'] },
    });
    const prose = 'Rainsford ran. Whitney thought to himself that the chase was futile.';
    const issues = v.validateRender(prose, event, emptyState);
    // Should warn about Whitney's thoughts
    expect(issues.length).toBeGreaterThan(0);
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
          validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
        },
      ],
    });
    // Prose without "3 hours" — should no longer flag since prose-level
    // fact checking is delegated to AnalysisResult from LLM Pass 2
    const prose = 'He waited. Then he moved on.';
    const issues = v.validateRender(prose, event, emptyState);
    expect(issues).toHaveLength(0);
  });
});
