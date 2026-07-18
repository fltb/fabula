import { describe, it, expect } from 'vitest';
import { DiscourseBalanceValidator } from '../../src/validator/discourse-balance.js';
import type { NarrativeEvent, PreRenderInput } from '../../src/types/index.js';

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
  events: NarrativeEvent[],
): PreRenderInput {
  return {
    event,
    events,
    worldState: { entities: {}, relationships: {}, knowledge: {}, threads: {}, rules: {}, facts: [] },
    entityRegistry: { entities: {} } as any,
    chapter: 1,
    queryState: () => undefined,
    getKnowledge: () => ({ worldTruth: [], characterKnowledge: {}, readerKnowledge: [], narratorKnowledge: [] }),
    getThreadProgress: () => ({ progress: 0, total: 0 }),
  };
}

describe('DiscourseBalanceValidator', () => {
  it('should report nothing when modes are balanced', () => {
    // 5 events with different discourse modes, < 80% per mode
    const events = [
      makeEvent({ id: 'E1', narrativeOrder: 1, discourseMode: 'action' }),
      makeEvent({ id: 'E2', narrativeOrder: 2, discourseMode: 'dialogue' }),
      makeEvent({ id: 'E3', narrativeOrder: 3, discourseMode: 'description' }),
      makeEvent({ id: 'E4', narrativeOrder: 4, discourseMode: 'exposition' }),
      makeEvent({ id: 'E5', narrativeOrder: 5, discourseMode: 'reflection' }),
    ];

    const input = makeInput(events[0], events);
    const issues = new DiscourseBalanceValidator().validatePre(input);
    const dominanceIssues = issues.filter(i => i.message.includes('dominates'));
    expect(dominanceIssues).toHaveLength(0);
  });

  it('should report dominance issue when one mode is >80% of scenes', () => {
    // 6 events, 5 of them 'action' → 5/6 = 83% > 80%
    const events = [
      makeEvent({ id: 'E1', narrativeOrder: 1, discourseMode: 'action' }),
      makeEvent({ id: 'E2', narrativeOrder: 2, discourseMode: 'action' }),
      makeEvent({ id: 'E3', narrativeOrder: 3, discourseMode: 'action' }),
      makeEvent({ id: 'E4', narrativeOrder: 4, discourseMode: 'action' }),
      makeEvent({ id: 'E5', narrativeOrder: 5, discourseMode: 'action' }),
      makeEvent({ id: 'E6', narrativeOrder: 6, discourseMode: 'dialogue' }),
    ];

    const input = makeInput(events[0], events);
    const issues = new DiscourseBalanceValidator().validatePre(input);
    const dominanceIssues = issues.filter(i => i.message.includes('dominates'));
    expect(dominanceIssues.length).toBeGreaterThanOrEqual(1);
    expect(dominanceIssues[0].message).toContain('action');
    expect(dominanceIssues[0].message).toContain('83%');
    expect(dominanceIssues[0].severity).toBe('warning');
  });
});
