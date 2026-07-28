import { describe, expect, it } from 'vitest';
import type {
  AnalysisResult,
  NarrativeEvent,
  PostRenderInput,
  PreRenderInput,
} from '../../src/types/index.js';
import { DiscourseValidator } from '../../src/validator/discourse.js';

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
  analysis: AnalysisResult | null,
  context?: unknown,
): PostRenderInput & { context?: unknown } {
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
    context,
  };
}

function makePreInput(event: NarrativeEvent, events: NarrativeEvent[]): PreRenderInput {
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
    entityRegistry: {
      load: () => {},
      resolve: () => null,
      findByKind: () => [],
      findByAttribute: () => [],
      resolveRefs: () => new Map(),
      register: () => {},
      updateState: () => {},
      getAll: () => [],
    },
    chapter: 1,
    queryState: () => undefined,
    getKnowledge: () => ({ claims: {}, bySubject: {}, byProposition: {}, actLog: [] }),
    getThreadProgress: () => null,
  };
}

describe('DiscourseValidator', () => {
  describe('validatePre', () => {
    it('should always return empty array (narrator data not available pre-render)', () => {
      const event = makeEvent({ id: 'E1', narratorProfileRef: 'narrator_wo' });
      const events = [event];
      const input = makePreInput(event, events);

      const issues = new DiscourseValidator().validatePre(input);
      expect(issues).toHaveLength(0);
    });
  });

  describe('validatePost', () => {
    it('should report nothing when no narratorProfileRef is set', () => {
      const event = makeEvent({ id: 'E1' });
      const input = makeInput(event, null);

      const issues = new DiscourseValidator().validatePost(input);
      expect(issues).toHaveLength(0);
    });

    it('should report nothing when narratorProfileRef is set and context.narratorProfile resolves', () => {
      const event = makeEvent({ id: 'E1', narratorProfileRef: 'narrator_wo' });
      const mockNarratorProfile = {
        id: 'narrator_wo',
        type: 'retrospective_entity' as const,
        fidelity: 'reliable' as const,
        sincerity: 'sincere' as const,
      };
      const context = { narratorProfile: mockNarratorProfile };
      const input = makeInput(event, null, context);

      const issues = new DiscourseValidator().validatePost(input);
      expect(issues).toHaveLength(0);
    });

    it('should report error when narratorProfileRef is set but context.narratorProfile is undefined', () => {
      const event = makeEvent({ id: 'E1', narratorProfileRef: 'narrator_wo' });
      const context = { narratorProfile: undefined };
      const input = makeInput(event, null, context);

      const issues = new DiscourseValidator().validatePost(input);
      const discourseIssues = issues.filter((i) => i.validator === 'discourse');
      expect(discourseIssues.length).toBeGreaterThanOrEqual(1);
      expect(discourseIssues[0].message).toContain('narrator_wo');
      expect(discourseIssues[0].message).toContain('did not resolve');
      expect(discourseIssues[0].severity).toBe('error');
      expect(discourseIssues[0].attribute).toBe('narratorProfileRef');
    });

    it('does not revive removed discourse replay fallback errors post-render', () => {
      const event = makeEvent({ id: 'E1' });
      const input = makeInput(
        event,
        null,
        { discourseReplayError: 'Truth boundary violation in entry_reveal_death' },
      );

      // Planned discourse failures are rejected during strict preflight, before
      // a post-render validator exists; this legacy context field is ignored.
      expect(new DiscourseValidator().validatePost(input)).toHaveLength(0);
    });

    it('reports only narrator resolution when legacy replay error is also present', () => {
      const event = makeEvent({ id: 'E1', narratorProfileRef: 'narrator_missing' });
      const input = makeInput(event, null, {
        narratorProfile: undefined,
        discourseReplayError: 'Hint lifecycle violation',
      });

      const discourseIssues = new DiscourseValidator()
        .validatePost(input)
        .filter((issue) => issue.validator === 'discourse');
      expect(discourseIssues).toHaveLength(1);
      expect(discourseIssues[0]?.attribute).toBe('narratorProfileRef');
      expect(discourseIssues[0]?.severity).toBe('error');
    });
  });

  describe('instance state (no leakage)', () => {
    it('should not carry state between validatePost calls with different events', () => {
      const validator = new DiscourseValidator();

      const event1 = makeEvent({ id: 'E1', narratorProfileRef: 'narrator_wo' });
      const context1 = { narratorProfile: undefined };
      const input1 = makeInput(event1, null, context1);
      const issues1 = validator.validatePost(input1);

      const event2 = makeEvent({ id: 'E2' });
      const input2 = makeInput(event2, null);
      const issues2 = validator.validatePost(input2);

      // E1 should have unresolved ref issue, E2 should have no issues
      expect(issues1.filter((i) => i.validator === 'discourse')).toHaveLength(1);
      expect(issues2).toHaveLength(0);
    });
  });
});
