// ============================================================================
// PostRenderValidator — verify LLM-rendered prose against source event
// ============================================================================

import { describe, it, expect } from 'vitest';
import { PostRenderValidator } from '../../src/validator/post-render.ts';
import type { NarrativeEvent, WorldState } from '../../src/types/index.js';

function makeEvent(overrides: Partial<NarrativeEvent> = {}): NarrativeEvent {
  return {
    id: 'E0',
    event: 'E0',
    narrativeOrder: 1,
    title: 'Test event',
    storyTime: { type: 'absolute', value: 'night_0' },
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

describe('PostRenderValidator', () => {
  it('passes on clean prose with no preconditions or postconditions', () => {
    const v = new PostRenderValidator();
    const event = makeEvent();
    const result = v.validate('The deck rose and fell beneath them.', event, emptyState);
    expect(result.passed).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it('flags postcondition_missing when a fact is not stated in prose', () => {
    const v = new PostRenderValidator();
    const event = makeEvent({
      postconditions: [
        {
          id: 'rainsford.location',
          entityId: 'rainsford',
          attribute: 'location',
          value: 'overboard',
          confidence: 1.0,
          validity: { temporal: { start: { type: 'absolute', value: 'night_0' }, end: null }, branches: { type: 'all' } },
        },
      ],
    });
    const result = v.validate('The deck was steady under his feet.', event, emptyState);
    const pcIssues = result.issues.filter((i) => i.rule === 'postcondition_missing');
    expect(pcIssues).toHaveLength(1);
    expect(pcIssues[0].expected).toBe('rainsford.location = overboard');
    expect(result.coverage.postconditionsStated).toBe(0);
    expect(result.coverage.postconditionsTotal).toBe(1);
  });

  it('passes postcondition when value tokens appear in prose', () => {
    const v = new PostRenderValidator();
    const event = makeEvent({
      postconditions: [
        {
          id: 'rainsford.location',
          entityId: 'rainsford',
          attribute: 'location',
          value: 'overboard',
          confidence: 1.0,
          validity: { temporal: { start: { type: 'absolute', value: 'night_0' }, end: null }, branches: { type: 'all' } },
        },
      ],
    });
    const result = v.validate('Rainsford tumbled overboard into the black sea.', event, emptyState);
    const pcIssues = result.issues.filter((i) => i.rule === 'postcondition_missing');
    expect(pcIssues).toHaveLength(0);
    expect(result.coverage.postconditionsStated).toBe(1);
  });

  it('flags precondition_contradicted when alive character dies in prose', () => {
    const v = new PostRenderValidator();
    const event = makeEvent({
      preconditions: [
        {
          id: 'rainsford.status',
          entityId: 'rainsford',
          attribute: 'status',
          value: 'alive',
          confidence: 1.0,
          validity: { temporal: { start: { type: 'absolute', value: 'night_0' }, end: null }, branches: { type: 'all' } },
        },
      ],
    });
    const result = v.validate('Rainsford died that night on the rocks.', event, emptyState);
    const issues = result.issues.filter((i) => i.rule === 'precondition_contradicted');
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('error');
  });

  it('does not flag preconditions when prose says nothing about death', () => {
    const v = new PostRenderValidator();
    const event = makeEvent({
      preconditions: [
        {
          id: 'rainsford.status',
          entityId: 'rainsford',
          attribute: 'status',
          value: 'alive',
          confidence: 1.0,
          validity: { temporal: { start: { type: 'absolute', value: 'night_0' }, end: null }, branches: { type: 'all' } },
        },
      ],
    });
    const result = v.validate('Rainsford smoked his pipe and listened to Whitney.', event, emptyState);
    const issues = result.issues.filter((i) => i.rule === 'precondition_contradicted');
    expect(issues).toHaveLength(0);
  });

  it('flags POV leak when prose enters other characters thoughts in 3rd-person limited', () => {
    const v = new PostRenderValidator({
      povLeakPatterns: {
        third_person_limited: [
          /\b(Whitney|Ivan|Zaroff) (thought|felt|knew|remembered|wanted|wished)\b/gi,
        ],
      },
    });
    const event = makeEvent({
      pov: { character: 'rainsford', type: 'third_person_limited' },
    });
    const result = v.validate('Whitney thought to himself that Rainsford was mad.', event, emptyState);
    const issues = result.issues.filter((i) => i.rule === 'pov_leak');
    expect(issues).toHaveLength(1);
  });

  it('flags name typos via Levenshtein against canonical names', () => {
    const v = new PostRenderValidator({ canonicalNames: ['Rainsford', 'Whitney', 'Zaroff'] });
    const event = makeEvent();
    const result = v.validate('Rainsforde and Whitny talked.', event, emptyState);
    const typos = result.issues.filter((i) => i.rule === 'name_typo');
    expect(typos.length).toBeGreaterThan(0);
    // Should suggest Rainsford for Rainsforde
    const rainsfordTypo = typos.find((t) => t.actual === 'Rainsforde');
    expect(rainsfordTypo?.expected).toBe('Rainsford');
  });

  it('does not flag correct names', () => {
    const v = new PostRenderValidator({ canonicalNames: ['Rainsford', 'Whitney', 'Zaroff'] });
    const event = makeEvent();
    const result = v.validate('Rainsford spoke to Whitney about Zaroff.', event, emptyState);
    const typos = result.issues.filter((i) => i.rule === 'name_typo');
    expect(typos).toHaveLength(0);
  });

  it('flags forbidden phrases (system tokens, etc.)', () => {
    const v = new PostRenderValidator();
    const event = makeEvent();
    const result = v.validate('The prose contained [SYSTEM] tokens in it.', event, emptyState);
    const issues = result.issues.filter((i) => i.rule === 'forbidden_phrase');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].severity).toBe('error');
  });

  it('computes confidence correctly: high coverage + no issues = 1.0', () => {
    const v = new PostRenderValidator();
    const event = makeEvent({
      postconditions: [
        {
          id: 'x',
          entityId: 'rainsford',
          attribute: 'location',
          value: 'yacht',
          confidence: 1.0,
          validity: { temporal: { start: { type: 'absolute', value: 'night_0' }, end: null }, branches: { type: 'all' } },
        },
      ],
    });
    const result = v.validate('Rainsford was on the yacht.', event, emptyState);
    expect(result.confidence).toBeCloseTo(1.0, 2);
    expect(result.passed).toBe(true);
  });

  it('confidence drops with each error and warning', () => {
    const v = new PostRenderValidator();
    const event = makeEvent({
      pov: { character: 'rainsford', type: 'third_person_limited' },
      preconditions: [
        {
          id: 'x',
          entityId: 'rainsford',
          attribute: 'status',
          value: 'alive',
          confidence: 1.0,
          validity: { temporal: { start: { type: 'absolute', value: 'night_0' }, end: null }, branches: { type: 'all' } },
        },
      ],
    });
    const clean = v.validate('Rainsford spoke.', event, emptyState);
    const dirty = v.validate(
      'Rainsford died. Whitney thought about the past.',
      event,
      emptyState,
    );
    expect(dirty.confidence).toBeLessThan(clean.confidence);
    expect(dirty.passed).toBe(false);
  });

  it('honors minConfidence threshold', () => {
    const v = new PostRenderValidator({ minConfidence: 0.99 });
    const event = makeEvent({
      postconditions: [
        {
          id: 'x',
          entityId: 'rainsford',
          attribute: 'location',
          value: 'jungle', // not in prose
          confidence: 1.0,
          validity: { temporal: { start: { type: 'absolute', value: 'night_0' }, end: null }, branches: { type: 'all' } },
        },
      ],
    });
    const result = v.validate('The yacht rocked gently.', event, emptyState);
    expect(result.confidence).toBeLessThan(0.99);
    expect(result.passed).toBe(false);
  });
});
