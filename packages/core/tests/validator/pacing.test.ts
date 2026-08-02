import { describe, expect, it } from 'vitest';
import type { NarrativeEvent, PreRenderInput } from '../../src/types/index.js';
import { PacingValidator } from '../../src/validator/pacing.js';

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

function makeInput(event: NarrativeEvent, extraEvents: NarrativeEvent[] = []): PreRenderInput {
  const events = [event, ...extraEvents];
  return {
    event,
    events,
    worldState: {
      entities: {},
      relationships: {},
      knowledge: {},
      threads: {},
      rules: {},
      facts: [],
    },
    entities: {
      resolve: () => null,
      findByKind: () => [],
      getAll: () => [],
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
  };
}

describe('PacingValidator', () => {
  it('should report nothing when climax is correctly placed at ~70%', () => {
    // totalEvents = 11, position = 8 → fraction = (8-1)/(11-1) = 0.70 → within 0.6-0.85
    const event = makeEvent({ id: 'E8', narrativeOrder: 8, arcPosition: 'climax' });
    const others = Array.from({ length: 10 }, (_, i) => {
      const n = i + 1;
      if (n === 8) return null;
      const arc: string | undefined =
        n < 8
          ? n <= 2
            ? 'opening'
            : 'rising'
          : n === 8
            ? undefined
            : n <= 9
              ? 'falling'
              : 'denouement';
      return makeEvent({ id: `E${n}`, narrativeOrder: n, arcPosition: arc as any });
    }).filter(Boolean) as NarrativeEvent[];

    const input = makeInput(event, others);
    const issues = new PacingValidator().validatePre(input);
    const pacingIssues = issues.filter(
      (i) => i.validator === 'pacing' && i.attribute === 'arcPosition',
    );
    expect(pacingIssues).toHaveLength(0);
  });

  it('should report pacing issue when climax is at ~10%', () => {
    // totalEvents = 11, position = 2 → fraction = (2-1)/(11-1) = 0.10 → below 0.6
    const event = makeEvent({ id: 'E2', narrativeOrder: 2, arcPosition: 'climax' });
    const others = Array.from({ length: 10 }, (_, i) => {
      const n = i + 1;
      if (n === 2) return null;
      return makeEvent({ id: `E${n}`, narrativeOrder: n });
    }).filter(Boolean) as NarrativeEvent[];

    const input = makeInput(event, others);
    const issues = new PacingValidator().validatePre(input);
    const pacingIssues = issues.filter(
      (i) => i.validator === 'pacing' && i.attribute === 'arcPosition',
    );
    expect(pacingIssues.length).toBeGreaterThanOrEqual(1);
    expect(pacingIssues[0].message).toContain('Climax at position');
    expect(pacingIssues[0].severity).toBe('warning');
  });

  it('should report nothing when no arcPosition is set', () => {
    const event = makeEvent({ id: 'E5', narrativeOrder: 5 });
    const others = Array.from({ length: 5 }, (_, i) =>
      makeEvent({ id: `E${i + 1}`, narrativeOrder: i + 1 }),
    ).filter((e) => e.id !== 'E5');

    const input = makeInput(event, others);
    const issues = new PacingValidator().validatePre(input);
    const arcIssues = issues.filter((i) => i.attribute === 'arcPosition');
    expect(arcIssues).toHaveLength(0);
  });
});
