// ============================================================================
// Comprehensive Unit Tests — All 11 Validators + ResultAggregator
// ============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import type {
  NarrativeEvent,
  Entity,
  EntityRegistry,
  WorldState,
  ValidatorContext,
  ForeshadowEntry,
} from '../src/types/index.js';
import {
  TimelineValidator,
  CharacterStateValidator,
  KnowledgeValidator,
  WorldRuleValidator,
  CausalityValidator,
  ForeshadowingValidator,
  POVValidator,
  FactualDetailValidator,
  VoiceDriftDetector,
  BranchMergeValidator,
  ReachabilityValidator,
  ResultAggregator,
} from '../src/validator/index.js';
import { InMemoryEntityRegistry } from '../src/entity/index.js';

// ============================================================================
// Shared Helpers & Fixtures
// ============================================================================

/** Inline factory for a minimal NarrativeEvent */
function makeEvent(overrides: Partial<NarrativeEvent> = {}): NarrativeEvent {
  return {
    id: 'evt_test',
    event: 'evt_test',
    narrativeOrder: 10,
    title: 'Test Scene',
    storyTime: { type: 'absolute', value: 'day_5' },
    sceneType: 'linear',
    pov: { character: 'jinx', type: 'third_person_limited' },
    sceneBrief: 'A test scene.',
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

/** Build a ValidatorContext from minimal pieces */
function buildContext(
  event: NarrativeEvent,
  overrides: Partial<ValidatorContext> = {},
): ValidatorContext {
  const defaultState: WorldState = {
    entities: {},
    relationships: {},
    knowledge: {},
    threads: {},
    rules: {},
    facts: [],
  };

  const defaultRegistry: EntityRegistry = new InMemoryEntityRegistry();

  return {
    worldState: defaultState,
    events: [event],
    entityRegistry: defaultRegistry,
    currentEvent: event,
    currentChapter: 1,
    narrativeOrder: event.narrativeOrder,
    queryState: (_entityId: string, _attribute: string) => undefined,
    getKnowledge: (_characterId: string) => ({
      worldTruth: [],
      characterKnowledge: {},
      readerKnowledge: [],
      narratorKnowledge: [],
    }),
    getThreadProgress: (_threadId: string) => ({ progress: 0, total: 0 }),
    getRuleEvidence: (_ruleId: string) => [],
    ...overrides,
  };
}

/** Register a character entity in the registry */
function registerCharacter(
  registry: EntityRegistry,
  id: string,
  extraState: Record<string, unknown> = {},
): void {
  const entity: Entity = {
    id,
    kind: 'character',
    name: id.charAt(0).toUpperCase() + id.slice(1),
    definitionFile: `definitions/characters/${id}.yaml`,
    state: { status: 'alive', alive: true, condition: 'healthy', ...extraState },
  };
  registry.register(entity);
}

// ============================================================================
// 1. TimelineValidator Tests
// ============================================================================

describe('TimelineValidator', () => {
  const validator = new TimelineValidator();

  it('should detect story time going backwards in linear scenes', () => {
    const prevEvent = makeEvent({
      id: 'evt_prev',
      narrativeOrder: 5,
      storyTime: { type: 'absolute', value: 'day_10' },
      sceneType: 'linear',
    });
    const currentEvent = makeEvent({
      id: 'evt_current',
      narrativeOrder: 10,
      storyTime: { type: 'absolute', value: 'day_5' },
      sceneType: 'linear',
    });
    const ctx = buildContext(currentEvent, {
      events: [prevEvent, currentEvent],
    });

    const issues = validator.validate(currentEvent, ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('error');
    expect(issues[0].validator).toBe('timeline');
    expect(issues[0].message).toContain('before previous event');
  });

  it('should not flag flashback scenes with backward time', () => {
    const prevEvent = makeEvent({
      id: 'evt_prev',
      narrativeOrder: 5,
      storyTime: { type: 'absolute', value: 'day_10' },
      sceneType: 'linear',
    });
    const flashbackEvent = makeEvent({
      id: 'evt_flashback',
      narrativeOrder: 10,
      storyTime: { type: 'absolute', value: 'day_3' },
      sceneType: 'flashback',
    });
    const ctx = buildContext(flashbackEvent, {
      events: [prevEvent, flashbackEvent],
    });

    const issues = validator.validate(flashbackEvent, ctx);
    // Flashback scenes should not trigger the time-backwards error
    const backwardsIssues = issues.filter((i) => i.message.includes('before previous event'));
    expect(backwardsIssues).toHaveLength(0);
  });

  it('should warn when non-linear scene has no narrationTime', () => {
    const event = makeEvent({
      sceneType: 'flashback',
      narrationTime: undefined,
    });
    const ctx = buildContext(event);
    const issues = validator.validate(event, ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].message).toContain('no narration_time');
  });

  it('should pass for scenes with correct time ordering', () => {
    const prevEvent = makeEvent({
      id: 'evt_prev',
      narrativeOrder: 5,
      storyTime: { type: 'absolute', value: 'day_1' },
      sceneType: 'linear',
    });
    const currentEvent = makeEvent({
      id: 'evt_current',
      narrativeOrder: 10,
      storyTime: { type: 'absolute', value: 'day_5' },
      sceneType: 'linear',
    });
    const ctx = buildContext(currentEvent, {
      events: [prevEvent, currentEvent],
    });

    const issues = validator.validate(currentEvent, ctx);
    const timeBackwardIssues = issues.filter((i) => i.message.includes('before previous event'));
    expect(timeBackwardIssues).toHaveLength(0);
  });

  it('should pass for linear scenes with narrationTime set', () => {
    const event = makeEvent({
      sceneType: 'linear',
    });
    const ctx = buildContext(event);
    const issues = validator.validate(event, ctx);
    // No warning about missing narrationTime for linear scenes
    const missingNarrationIssues = issues.filter((i) => i.message.includes('no narration_time'));
    expect(missingNarrationIssues).toHaveLength(0);
  });
});

// ============================================================================
// 2. CharacterStateValidator Tests
// ============================================================================

describe('CharacterStateValidator', () => {
  const validator = new CharacterStateValidator();

  it('should error when dead character appears in scene', () => {
    const registry = new InMemoryEntityRegistry();
    registerCharacter(registry, 'jinx', { status: 'dead', alive: false });
    const event = makeEvent({
      preconditions: [{ id: 'jinx.status', entityId: 'jinx', attribute: 'status', value: 'dead', validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } } }],
    });
    const ctx = buildContext(event, {
      entityRegistry: registry,
      queryState: (_id, _attr) => {
        if (_attr === 'status') return 'dead';
        if (_attr === 'alive') return false;
        return undefined;
      },
    });

    const issues = validator.validate(event, ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('error');
    expect(issues[0].message).toContain('dead');
    expect(issues[0].entity).toBe('jinx');
  });

  it('should pass for normal state transitions', () => {
    const registry = new InMemoryEntityRegistry();
    registerCharacter(registry, 'jinx', { condition: 'injured' });
    const event = makeEvent({
      postconditions: [{ id: 'jinx.condition', entityId: 'jinx', attribute: 'condition', value: 'healthy', validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } } }],
    });
    const ctx = buildContext(event, {
      entityRegistry: registry,
      queryState: (_id, _attr) => {
        if (_id === 'jinx' && _attr === 'condition') return 'injured';
        return undefined;
      },
    });

    const issues = validator.validate(event, ctx);
    expect(issues).toHaveLength(0);
  });

  it('should error when dead character appears in scene preconditions', () => {
    const registry = new InMemoryEntityRegistry();
    registerCharacter(registry, 'vi', { status: 'dead', alive: false });
    const event = makeEvent({
      preconditions: [
        {
          id: 'vi.status',
          entityId: 'vi',
          attribute: 'status',
          value: 'dead',
          validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
        },
      ],
      participants: { entities: ['vi'] },
    });
    const ctx = buildContext(event, {
      entityRegistry: registry,
      queryState: (_id, _attr) => {
        if (_attr === 'status') return 'dead';
        if (_attr === 'alive') return false;
        return undefined;
      },
    });

    const issues = validator.validate(event, ctx);
    const deadIssues = issues.filter((i) => i.severity === 'error' && i.message.includes('dead'));
    expect(deadIssues).toHaveLength(1);
    expect(deadIssues[0].entity).toBe('vi');
  });
});

// ============================================================================
// 3. KnowledgeValidator Tests
// ============================================================================

describe('KnowledgeValidator', () => {
  const validator = new KnowledgeValidator();

  it('should info when character already knows a fact', () => {
    const event = makeEvent({
      postconditions: [
        {
          id: 'jinx.knows',
          entityId: 'jinx',
          attribute: 'knows',
          value: 'hextech_secret',
          validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
        },
      ],
    });
    const ctx = buildContext(event, {
      getKnowledge: (_charId: string) => ({
        worldTruth: [],
        characterKnowledge: {
          jinx: {
            knownFacts: [
              {
                fact: { id: 'jinx.knows', entityId: 'jinx', attribute: 'knows', value: 'hextech_secret', validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } } },
                acquiredAt: { type: 'absolute', value: 'day_0' },
                source: { type: 'direct_experience', eventId: 'evt_prev' },
                confidence: 1,
              },
            ],
            unknownFacts: [],
            misbeliefs: [],
          },
        },
        readerKnowledge: [],
        narratorKnowledge: [],
      }),
    });

    const issues = validator.validate(event, ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('info');
    expect(issues[0].message).toContain('already knows');
  });

  it('should error when character knows fact from future event', () => {
    const futureEvent = makeEvent({
      id: 'evt_future',
      narrativeOrder: 20,
      postconditions: [
        {
          id: 'jinx.knows',
          entityId: 'jinx',
          attribute: 'knows',
          value: 'hextech_secret',
          validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
        },
      ],
    });
    const currentEvent = makeEvent({
      id: 'evt_current',
      narrativeOrder: 10,
      postconditions: [
        {
          id: 'jinx.knows',
          entityId: 'jinx',
          attribute: 'knows',
          value: 'hextech_secret',
          validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
        },
      ],
    });

    const ctx = buildContext(currentEvent, {
      events: [currentEvent, futureEvent],
      getKnowledge: (_charId: string) => ({
        worldTruth: [],
        characterKnowledge: { jinx: { knownFacts: [], unknownFacts: [], misbeliefs: [] } },
        readerKnowledge: [],
        narratorKnowledge: [],
      }),
    });

    const issues = validator.validate(currentEvent, ctx);
    const futureIssues = issues.filter((i) => i.message.includes('before it is established'));
    expect(futureIssues).toHaveLength(1);
    expect(futureIssues[0].severity).toBe('error');
  });

  it('should pass for normal knowledge acquisition', () => {
    const event = makeEvent({
      postconditions: [
        {
          id: 'jinx.knows',
          entityId: 'jinx',
          attribute: 'knows',
          value: 'hextech_secret',
          validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
        },
      ],
    });
    const ctx = buildContext(event, {
      getKnowledge: (_charId: string) => ({
        worldTruth: [],
        characterKnowledge: { jinx: { knownFacts: [], unknownFacts: [], misbeliefs: [] } },
        readerKnowledge: [],
        narratorKnowledge: [],
      }),
    });

    const issues = validator.validate(event, ctx);
    const infoIssues = issues.filter((i) => i.message.includes('already knows'));
    expect(infoIssues).toHaveLength(0);
  });
});

// ============================================================================
// 4. WorldRuleValidator Tests
// ============================================================================

describe('WorldRuleValidator', () => {
  const validator = new WorldRuleValidator();

  it('should pass for compliant state changes', () => {
    const registry = new InMemoryEntityRegistry();
    registerCharacter(registry, 'jayce', { traits: ['hextech_augmented'] });
    const event = makeEvent({
      postconditions: [
        {
          id: 'jayce.condition',
          entityId: 'jayce',
          attribute: 'condition',
          value: 'operational',
          validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
        },
        {
          id: 'jayce.status',
          entityId: 'jayce',
          attribute: 'status',
          value: 'healthy',
          validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
        },
      ],
    });
    const ctx = buildContext(event, {
      entityRegistry: registry,
      queryState: () => 'healthy',
    });

    const issues = validator.validate(event, ctx);
    expect(issues).toHaveLength(0);
  });
});

// ============================================================================
// 5. CausalityValidator Tests
// ============================================================================

describe('CausalityValidator', () => {
  const validator = new CausalityValidator();

  it('should warn when precondition is not satisfied in current state', () => {
    const event = makeEvent({
      preconditions: [
        {
          id: 'jinx.has_key',
          entityId: 'jinx',
          attribute: 'has_key',
          value: true,
          validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
        },
      ],
    });
    const ctx = buildContext(event, {
      queryState: (_id, _attr) => undefined, // not satisfied
    });

    const issues = validator.validate(event, ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].message).toContain('not satisfied');
  });

  it('should warn when postconditions match preconditions (no causal effect)', () => {
    const event = makeEvent({
      preconditions: [
        {
          id: 'jinx.status',
          entityId: 'jinx',
          attribute: 'status',
          value: 'injured',
          validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
        },
      ],
      postconditions: [
        {
          id: 'jinx.status',
          entityId: 'jinx',
          attribute: 'status',
          value: 'injured',
          validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
        },
      ],
    });
    const ctx = buildContext(event, {
      queryState: (_id, _attr) => 'injured',
    });

    const issues = validator.validate(event, ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].message).toContain('no causal effect');
  });

  it('should pass for meaningful state changes', () => {
    const event = makeEvent({
      preconditions: [
        {
          id: 'jinx.status',
          entityId: 'jinx',
          attribute: 'status',
          value: 'injured',
          validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
        },
      ],
      postconditions: [
        {
          id: 'jinx.health',
          entityId: 'jinx',
          attribute: 'health',
          value: 'cured',
          validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
        },
      ],
    });
    const ctx = buildContext(event, {
      queryState: (_id, _attr) => 'injured',
    });

    const issues = validator.validate(event, ctx);
    const noEffectIssues = issues.filter((i) => i.message.includes('no causal effect'));
    expect(noEffectIssues).toHaveLength(0);
  });
});

// ============================================================================
// 6. ForeshadowingValidator Tests
// ============================================================================

describe('ForeshadowingValidator', () => {
  const validator = new ForeshadowingValidator();

  it('should warn when foreshadow is past its reveal chapter', () => {
    const event = makeEvent({
      foreshadowing: [
        { id: 'f_shadow_1', hint: 'The dark secret', targetRevealChapter: 2 },
      ],
    });
    // currentChapter is 3, targetRevealChapter is 2 → past due
    const ctx = buildContext(event, { currentChapter: 3 });

    const issues = validator.validate(event, ctx);
    const warnIssues = issues.filter((i) => i.severity === 'warning' && i.message.includes('was supposed to be revealed'));
    expect(warnIssues).toHaveLength(1);
    expect(warnIssues[0].entity).toBe('f_shadow_1');
  });

  it('should error when foreshadow is 2+ chapters past due', () => {
    // Put the overdue foreshadow on a *different* event so the first loop
    // (which checks event.foreshadowing) does not produce a warning that
    // would mark it as alreadyReported and skip the error.
    const otherEvent = makeEvent({
      id: 'evt_other',
      narrativeOrder: 1,
      foreshadowing: [
        { id: 'f_shadow_2', hint: 'The old wound', targetRevealChapter: 1 },
      ],
    });
    const currentEvent = makeEvent({
      id: 'evt_current',
      narrativeOrder: 10,
      foreshadowing: [],
    });
    // currentChapter is 5, targetRevealChapter is 1, diff = 4 which is > 2
    const ctx = buildContext(currentEvent, { currentChapter: 5, events: [otherEvent, currentEvent] });

    const issues = validator.validate(currentEvent, ctx);
    const errIssues = issues.filter((i) => i.severity === 'error' && i.message.includes('2+ chapters past'));
    expect(errIssues).toHaveLength(1);
    expect(errIssues[0].entity).toBe('f_shadow_2');
  });

  it('should pass for on-track foreshadows', () => {
    const event = makeEvent({
      foreshadowing: [
        { id: 'f_shadow_3', hint: 'The looming threat', targetRevealChapter: 5 },
      ],
    });
    const ctx = buildContext(event, { currentChapter: 3, events: [event] });

    const issues = validator.validate(event, ctx);
    const pastDueIssues = issues.filter((i) => i.message.includes('past'));
    expect(pastDueIssues).toHaveLength(0);
  });
});

// ============================================================================
// 7. POVValidator Tests
// ============================================================================

describe('POVValidator', () => {
  const validator = new POVValidator();

  it('should error when POV character does not exist in registry', () => {
    const registry = new InMemoryEntityRegistry();
    const event = makeEvent({ pov: { character: 'nonexistent', type: 'first_person' } });
    const ctx = buildContext(event, { entityRegistry: registry });

    const issues = validator.validate(event, ctx);
    const errorIssues = issues.filter((i) => i.severity === 'error' && i.message.includes('not defined'));
    expect(errorIssues).toHaveLength(1);
    expect(errorIssues[0].entity).toBe('nonexistent');
  });

  it('should warn when limited POV character is not a scene participant', () => {
    const registry = new InMemoryEntityRegistry();
    registerCharacter(registry, 'jinx');
    const event = makeEvent({
      pov: { character: 'jinx', type: 'third_person_limited' },
      participants: { entities: ['vi'] }, // jinx is not a participant
    });
    const ctx = buildContext(event, { entityRegistry: registry });

    const issues = validator.validate(event, ctx);
    const warnIssues = issues.filter((i) => i.severity === 'warning' && i.message.includes('not listed'));
    expect(warnIssues).toHaveLength(1);
    expect(warnIssues[0].entity).toBe('jinx');
  });

  it('should info for omniscient POV usage', () => {
    const registry = new InMemoryEntityRegistry();
    registerCharacter(registry, 'narrator');
    const event = makeEvent({
      pov: { character: 'narrator', type: 'omniscient' },
    });
    const ctx = buildContext(event, { entityRegistry: registry });

    const issues = validator.validate(event, ctx);
    const infoIssues = issues.filter((i) => i.severity === 'info' && i.message.includes('omniscient'));
    expect(infoIssues).toHaveLength(1);
  });

  it('should pass for valid POV setup', () => {
    const registry = new InMemoryEntityRegistry();
    registerCharacter(registry, 'jinx');
    const event = makeEvent({
      pov: { character: 'jinx', type: 'third_person_limited' },
      participants: { entities: ['jinx'] },
    });
    const ctx = buildContext(event, { entityRegistry: registry });

    const issues = validator.validate(event, ctx);
    expect(issues).toHaveLength(0);
  });
});

// ============================================================================
// 8. FactualDetailValidator Tests
// ============================================================================

describe('FactualDetailValidator', () => {
  const validator = new FactualDetailValidator();

  it('should info when trait is confirmed', () => {
    const registry = new InMemoryEntityRegistry();
    registerCharacter(registry, 'jayce', { traits: ['brilliant_inventor'] });
    const event = makeEvent({
      preconditions: [
        {
          id: 'jayce.traits',
          entityId: 'jayce',
          attribute: 'traits',
          value: 'brilliant_inventor',
          validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
        },
      ],
    });
    const ctx = buildContext(event, { entityRegistry: registry });

    const issues = validator.validate(event, ctx);
    const infoIssues = issues.filter((i) => i.severity === 'info' && i.message.includes('confirmed'));
    expect(infoIssues).toHaveLength(1);
    expect(infoIssues[0].entity).toBe('jayce');
  });

  it('should warn on placeholder values (changed, resolved, updated)', () => {
    for (const placeholder of ['changed', 'resolved', 'updated']) {
      const event = makeEvent({
        preconditions: [
          {
            id: `jinx.${placeholder}`,
            entityId: 'jinx',
            attribute: 'status',
            value: placeholder,
            validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
          },
        ],
      });
      const ctx = buildContext(event);

      const issues = validator.validate(event, ctx);
      const warnIssues = issues.filter((i) => i.severity === 'warning' && i.message.includes('Placeholder'));
      expect(warnIssues).toHaveLength(1);
    }
  });

  it('should pass for concrete facts', () => {
    const registry = new InMemoryEntityRegistry();
    registerCharacter(registry, 'jinx', { traits: ['chaotic'] });
    const event = makeEvent({
      preconditions: [
        {
          id: 'jinx.traits',
          entityId: 'jinx',
          attribute: 'traits',
          value: 'chaotic',
          validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
        },
      ],
    });
    const ctx = buildContext(event, { entityRegistry: registry });

    const issues = validator.validate(event, ctx);
    const placeholderIssues = issues.filter((i) => i.message.includes('Placeholder'));
    expect(placeholderIssues).toHaveLength(0);
  });
});

// ============================================================================
// 9. VoiceDriftDetector Tests
// ============================================================================

describe('VoiceDriftDetector', () => {
  const validator = new VoiceDriftDetector();

  it('should return no issues in validate() — voice drift checks occur in validateRender', () => {
    const event = makeEvent({
      styleGuidance: { avoid: 'suddenly,then,very' },
    });
    const ctx = buildContext(event);

    const issues = validator.validate(event, ctx);
    expect(issues).toHaveLength(0);
  });

  it('should return no issues in validate() regardless of style guidance', () => {
    const event = makeEvent({
      styleGuidance: { avoid: 'suddenly' },
    });
    const ctx = buildContext(event);

    const issues = validator.validate(event, ctx);
    expect(issues).toHaveLength(0);
  });

  it('should return no issues when no style guidance is present', () => {
    const event = makeEvent();
    const ctx = buildContext(event);

    const issues = validator.validate(event, ctx);
    expect(issues).toHaveLength(0);
  });

  it('should return no issues when avoid list is empty', () => {
    const event = makeEvent({
      styleGuidance: { avoid: '' },
    });
    const ctx = buildContext(event);

    const issues = validator.validate(event, ctx);
    expect(issues).toHaveLength(0);
  });
});

// ============================================================================
// 10. BranchMergeValidator Tests
// ============================================================================

describe('BranchMergeValidator', () => {
  const validator = new BranchMergeValidator();

  it('should warn when merge precondition is not satisfied', () => {
    const prevEvent = makeEvent({
      id: 'evt_branch_a',
      narrativeOrder: 5,
      branchExistence: { type: 'paths', paths: [{ decisions: [{ atEventId: 'evt_1', choiceId: 'path_a', narrativeOrder: 1 }] }] },
    });
    const mergeEvent = makeEvent({
      id: 'evt_merge',
      narrativeOrder: 10,
      preconditions: [
        {
          id: 'jinx.has_key',
          entityId: 'jinx',
          attribute: 'has_key',
          value: true,
          validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
        },
      ],
    });
    const ctx = buildContext(mergeEvent, {
      events: [prevEvent, mergeEvent],
      queryState: (_id, _attr) => undefined, // not satisfied
    });

    const issues = validator.validate(mergeEvent, ctx);
    const warnIssues = issues.filter((i) => i.severity === 'warning' && i.message.includes('Merge precondition'));
    expect(warnIssues).toHaveLength(1);
    expect(warnIssues[0].entity).toBe('jinx');
  });

  it('should pass for satisfied merge preconditions', () => {
    const prevEvent = makeEvent({
      id: 'evt_branch_b',
      narrativeOrder: 5,
      branchExistence: { type: 'paths', paths: [{ decisions: [{ atEventId: 'evt_1', choiceId: 'path_b', narrativeOrder: 1 }] }] },
    });
    const mergeEvent = makeEvent({
      id: 'evt_merge',
      narrativeOrder: 10,
      preconditions: [
        {
          id: 'jinx.has_key',
          entityId: 'jinx',
          attribute: 'has_key',
          value: true,
          validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
        },
      ],
    });
    const ctx = buildContext(mergeEvent, {
      events: [prevEvent, mergeEvent],
      queryState: (_id, _attr) => true, // satisfied
    });

    const issues = validator.validate(mergeEvent, ctx);
    const mergeIssues = issues.filter((i) => i.message.includes('Merge precondition'));
    expect(mergeIssues).toHaveLength(0);
  });

  it('should return no issues when there are no incoming branches', () => {
    const event = makeEvent({
      preconditions: [
        {
          id: 'jinx.has_key',
          entityId: 'jinx',
          attribute: 'has_key',
          value: true,
          validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
        },
      ],
    });
    const ctx = buildContext(event, {
      queryState: (_id, _attr) => undefined,
    });

    const issues = validator.validate(event, ctx);
    expect(issues).toHaveLength(0);
  });
});

// ============================================================================
// 11. ReachabilityValidator Tests
// ============================================================================

describe('ReachabilityValidator', () => {
  const validator = new ReachabilityValidator();

  it('should warn when thread is behind schedule', () => {
    const event = makeEvent({ narrativeOrder: 5 });
    const ctx = buildContext(event, {
      worldState: {
        entities: {},
        relationships: {},
        knowledge: {},
        threads: {
          main_plot: { progress: 2, total: 10 },
        },
        rules: {},
        facts: [],
      },
      currentChapter: 7,
    });

    const issues = validator.validate(event, ctx);
    const threadIssues = issues.filter((i) => i.severity === 'warning' && i.message.includes('Thread'));
    expect(threadIssues).toHaveLength(1);
    expect(threadIssues[0].message).toContain('behind');
  });

  it('should error when foreshadow is unrevealed far past due', () => {
    const event = makeEvent({
      id: 'evt_early',
      narrativeOrder: 3,
      foreshadowing: [
        { id: 'f_ancient_evil', hint: 'Something stirs', targetRevealChapter: 1 },
      ],
    });
    const ctx = buildContext(event, {
      events: [event],
      currentChapter: 10,
    });

    const issues = validator.validate(event, ctx);
    const foreshadowIssues = issues.filter((i) => i.severity === 'error' && i.message.includes('unrevealed'));
    expect(foreshadowIssues).toHaveLength(1);
    expect(foreshadowIssues[0].entity).toBe('f_ancient_evil');
  });

  it('should warn when precondition is never established by any postcondition', () => {
    const event = makeEvent({
      id: 'evt_needs_key',
      narrativeOrder: 10,
      preconditions: [
        {
          id: 'jinx.magic_key',
          entityId: 'jinx',
          attribute: 'magic_key',
          value: true,
          validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
        },
      ],
      postconditions: [],
    });
    // No event establishes 'jinx.magic_key'
    const otherEvent = makeEvent({
      id: 'evt_other',
      narrativeOrder: 5,
      postconditions: [
        {
          id: 'jinx.other_attr',
          entityId: 'jinx',
          attribute: 'other_attr',
          value: 'something',
          validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
        },
      ],
    });
    const ctx = buildContext(event, {
      events: [otherEvent, event],
    });

    const issues = validator.validate(event, ctx);
    const precondIssues = issues.filter((i) => i.severity === 'warning' && i.message.includes('never established'));
    expect(precondIssues).toHaveLength(1);
    expect(precondIssues[0].message).toContain('magic_key');
  });

  it('should pass for healthy project state', () => {
    const event = makeEvent({ narrativeOrder: 10 });
    const ctx = buildContext(event, {
      worldState: {
        entities: {},
        relationships: {},
        knowledge: {},
        threads: {
          main_plot: { progress: 5, total: 10 },
        },
        rules: {},
        facts: [],
      },
      events: [event],
      currentChapter: 3,
    });

    const issues = validator.validate(event, ctx);
    expect(issues).toHaveLength(0);
  });
});

// ============================================================================
// 12. ResultAggregator Tests
// ============================================================================

describe('ResultAggregator', () => {
  it('validate() should run all validators and separate errors/warnings/infos', () => {
    const registry = new InMemoryEntityRegistry();
    registerCharacter(registry, 'jinx');
    const event = makeEvent({
      id: 'evt_aggregator_test',
      sceneType: 'flashback',
      preconditions: [
        {
          id: 'jinx.missing_attr',
          entityId: 'jinx',
          attribute: 'missing_attr',
          value: 'should_exist',
          validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
        },
      ],
    });
    const state: WorldState = {
      entities: {},
      relationships: {},
      knowledge: {},
      threads: {},
      rules: {},
      facts: [],
    };

    const aggregator = new ResultAggregator();
    const result = aggregator.validate(event, state, registry, [event], 1);

    expect(result).toHaveProperty('passed');
    expect(result).toHaveProperty('errors');
    expect(result).toHaveProperty('warnings');
    expect(result).toHaveProperty('infos');
    expect(Array.isArray(result.errors)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(Array.isArray(result.infos)).toBe(true);
  });

  it('validateAll() should validate all events', () => {
    const registry = new InMemoryEntityRegistry();
    registerCharacter(registry, 'jinx');
    const evt1 = makeEvent({
      id: 'evt_all_1',
      narrativeOrder: 5,
      preconditions: [
        {
          id: 'jinx.missing',
          entityId: 'jinx',
          attribute: 'missing',
          value: true,
          validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
        },
      ],
    });
    const evt2 = makeEvent({
      id: 'evt_all_2',
      narrativeOrder: 10,
      preconditions: [],
    });
    const state: WorldState = {
      entities: {},
      relationships: {},
      knowledge: {},
      threads: {},
      rules: {},
      facts: [],
    };

    const aggregator = new ResultAggregator();
    const results = aggregator.validateAll([evt1, evt2], state, registry);

    expect(results).toBeInstanceOf(Map);
    expect(results.size).toBe(2);
    expect(results.has('evt_all_1')).toBe(true);
    expect(results.has('evt_all_2')).toBe(true);
  });

  it('passed should be true when no errors', () => {
    const registry = new InMemoryEntityRegistry();
    registerCharacter(registry, 'jinx');
    const event = makeEvent({
      id: 'evt_clean',
      pov: { character: 'jinx', type: 'third_person_limited' },
      participants: { entities: ['jinx'] },
    });
    const state: WorldState = {
      entities: {},
      relationships: {},
      knowledge: {},
      threads: {},
      rules: {},
      facts: [],
    };

    const aggregator = new ResultAggregator();
    const result = aggregator.validate(event, state, registry, [event], 1);

    expect(result.passed).toBe(true);
  });

  it('should respect validator overrides (off/warning/error)', () => {
    const registry = new InMemoryEntityRegistry();
    registerCharacter(registry, 'jinx');
    const event = makeEvent({
      id: 'evt_override',
      sceneType: 'flashback',
      narrationTime: undefined, // should normally trigger a warning from TimelineValidator
    });
    const state: WorldState = {
      entities: {},
      relationships: {},
      knowledge: {},
      threads: {},
      rules: {},
      facts: [],
    };

    const aggregator = new ResultAggregator();

    // Test 'off' override
    const resultOff = aggregator.validate(event, state, registry, [event], 1, { timeline: 'off' });
    const timelineIssuesOff = [...resultOff.warnings, ...resultOff.infos, ...resultOff.errors]
      .filter((i) => i.validator === 'timeline');
    expect(timelineIssuesOff).toHaveLength(0);

    // Test 'error' override (upgrade warning to error)
    const resultError = aggregator.validate(event, state, registry, [event], 1, { timeline: 'error' });
    const timelineIssuesError = resultError.errors.filter((i) => i.validator === 'timeline');
    // The flashback w/o narrationTime produces a warning → upgraded to error
    expect(timelineIssuesError.length).toBeGreaterThanOrEqual(1);
  });

  it('listValidators() should return all registered validators', () => {
    const aggregator = new ResultAggregator();
    const validators = aggregator.listValidators();

    expect(validators).toHaveLength(11);
    expect(validators.map((v) => v.name)).toEqual([
      'timeline',
      'character_state',
      'knowledge',
      'world_rule',
      'causality',
      'foreshadowing',
      'pov',
      'factual_detail',
      'voice_drift',
      'branch_merge',
      'reachability',
    ]);
  });

  it('should accept custom validators in constructor', () => {
    class MockValidator {
      name = 'mock';
      category = 'factual_detail' as const;
      requiresLLM = false;
      validate = () => [];
    }
    const aggregator = new ResultAggregator([new MockValidator() as any]);
    const validators = aggregator.listValidators();
    expect(validators).toHaveLength(1);
    expect(validators[0].name).toBe('mock');
  });

  it('validateAll should skip system:genesis events', () => {
    const registry = new InMemoryEntityRegistry();
    const genesis = makeEvent({
      id: 'system:genesis',
      narrativeOrder: 0,
    });
    const evt = makeEvent({
      id: 'evt_real',
      narrativeOrder: 5,
    });
    const state: WorldState = {
      entities: {},
      relationships: {},
      knowledge: {},
      threads: {},
      rules: {},
      facts: [],
    };

    const aggregator = new ResultAggregator();
    const results = aggregator.validateAll([genesis, evt], state, registry);
    expect(results.has('system:genesis')).toBe(false);
    expect(results.has('evt_real')).toBe(true);
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('Validator Edge Cases', () => {
  describe('TimelineValidator — edge cases', () => {
    const validator = new TimelineValidator();

    it('should handle genesis event gracefully', () => {
      const genesis = makeEvent({
        id: 'system:genesis',
        narrativeOrder: 0,
      });
      const nextEvent = makeEvent({
        id: 'evt_after_genesis',
        narrativeOrder: 5,
        storyTime: { type: 'absolute', value: 'day_0' },
      });
      const ctx = buildContext(nextEvent, {
        events: [genesis, nextEvent],
      });

      const issues = validator.validate(nextEvent, ctx);
      // Genesis is filtered out in comparison; should not error if times are same
      const backwardIssues = issues.filter((i) => i.message.includes('before previous event'));
      expect(backwardIssues).toHaveLength(0);
    });

    it('should handle relative timestamps correctly', () => {
      const prevEvent = makeEvent({
        id: 'evt_prev',
        narrativeOrder: 5,
        storyTime: { type: 'absolute', value: 'day_10' },
        sceneType: 'linear',
      });
      const currentEvent = makeEvent({
        id: 'evt_current',
        narrativeOrder: 10,
        storyTime: { type: 'relative', anchor: 'start', offset: { amount: 5, unit: 'day' } },
        sceneType: 'linear',
      });
      const ctx = buildContext(currentEvent, {
        events: [prevEvent, currentEvent],
      });

      const issues = validator.validate(currentEvent, ctx);
      // Relative timestamp resolves to 5 (anchor 'start' not in anchors → 0 + 5 = 5)
      // Prev is day_10 → cmp = 5 - 10 = -5 < 0 → error expected
      const backwardIssues = issues.filter((i) => i.message.includes('before previous event'));
      expect(backwardIssues).toHaveLength(1);
    });
  });

  describe('CharacterStateValidator — edge cases', () => {
    const validator = new CharacterStateValidator();

    it('should handle non-character entities without error', () => {
      const registry = new InMemoryEntityRegistry();
      const entity: Entity = {
        id: 'zaun',
        kind: 'location',
        name: 'Zaun',
        definitionFile: 'definitions/locations/zaun.yaml',
        state: {},
      };
      registry.register(entity);
      const event = makeEvent({
        preconditions: [
          {
            id: 'zaun.status',
            entityId: 'zaun',
            attribute: 'status',
            value: 'destroyed',
            validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
          },
        ],
      });
      const ctx = buildContext(event, {
        entityRegistry: registry,
        queryState: () => 'destroyed',
      });

      const issues = validator.validate(event, ctx);
      // Non-character entities should be skipped without error
      const deadIssues = issues.filter((i) => i.message.includes('dead'));
      expect(deadIssues).toHaveLength(0);
    });
  });

  describe('POVValidator — edge cases', () => {
    const validator = new POVValidator();

    it('should handle first_person POV same as limited', () => {
      const registry = new InMemoryEntityRegistry();
      registerCharacter(registry, 'jinx');
      const event = makeEvent({
        pov: { character: 'jinx', type: 'first_person' },
        participants: { entities: ['vi'] },
      });
      const ctx = buildContext(event, { entityRegistry: registry });

      const issues = validator.validate(event, ctx);
      const warnIssues = issues.filter((i) => i.severity === 'warning' && i.message.includes('not listed'));
      expect(warnIssues).toHaveLength(1);
    });
  });

  describe('ForeshadowingValidator — edge cases', () => {
    const validator = new ForeshadowingValidator();

    it('should handle foreshadows with targetRevealChapter of 0 (no deadline)', () => {
      const event = makeEvent({
        foreshadowing: [
          { id: 'f_free', hint: 'No deadline', targetRevealChapter: 0 },
        ],
      });
      const ctx = buildContext(event, { currentChapter: 100, events: [event] });

      const issues = validator.validate(event, ctx);
      const pastDueIssues = issues.filter((i) => i.message.includes('past'));
      expect(pastDueIssues).toHaveLength(0);
    });
  });

  describe('CausalityValidator — edge cases', () => {
    const validator = new CausalityValidator();

    it('should warn when empty pre/post conditions indicate no causal effect', () => {
      const event = makeEvent({ preconditions: [], postconditions: [] });
      const ctx = buildContext(event);

      const issues = validator.validate(event, ctx);
      expect(issues).toHaveLength(1);
      expect(issues[0].message).toContain('no causal effect');
    });
  });
});
