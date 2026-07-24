// ============================================================================
// Novalistically — S8: Narrative Planner Tests
//
// Tests import directly from new module files, not from barrel exports.
// ============================================================================

import { describe, expect, it } from 'vitest';
import type { EventFile } from '../../src/types/event.js';
import type { WorldState } from '../../src/types/world.js';
import type {
  ActionDefinition,
  NarrativeGoal,
  Precondition,
  Effect,
} from '../../src/types/planner.js';
import {
  validatePreconditions,
  suggestEvents,
} from '../../src/state/narrative-planner.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Create a minimal WorldState with the given entity attributes. */
function makeWorldState(
  entities: Record<string, Record<string, unknown>> = {},
): WorldState {
  return {
    entities: entities as Record<string, Record<string, unknown>>,
    relationships: {},
    knowledge: {},
    threads: {},
    rules: {},
    facts: [],
  };
}

/** Create a minimal event for precondition validation testing. */
function makeEvent(
  eventId: string,
  preconditions: EventFile['preconditions'],
): EventFile {
  return {
    event: eventId,
    narrativeOrder: 1,
    title: `Test event ${eventId}`,
    storyTime: 't1',
    pov: { character: 'hero', type: 'third_person_limited' },
    sceneBrief: 'Test scene',
    preconditions,
    expectedPostconditions: [],
  };
}

/** Create an ActionDefinition for suggestion testing. */
function makeActionDef(
  actionId: string,
  overrides: Partial<ActionDefinition> = {},
): ActionDefinition {
  return {
    actionId,
    name: actionId,
    description: `Action ${actionId}`,
    preconditions: [],
    effects: [] as Effect[],
    narrativeTags: [],
    typicalDuration: 1,
    typicalArcPositions: [],
    ...overrides,
  };
}

/** Create a NarrativeGoal for suggestion testing. */
function makeGoal(
  goalId: string,
  threadId: string,
  priority: number,
  overrides: Partial<NarrativeGoal> = {},
): NarrativeGoal {
  return {
    goalId,
    threadId,
    description: `Goal ${goalId}`,
    type: 'achieve',
    priority,
    successCondition: {
      entity: 'hero',
      attribute: 'status',
      operator: 'eq',
      value: 'victorious',
    },
    ...overrides,
  };
}

// ─── Manual Mode: validatePreconditions ─────────────────────────────────────-

describe('validatePreconditions (manual mode)', () => {
  it('returns no issues when all preconditions are satisfied', () => {
    const world = makeWorldState({ hero: { level: 10, health: 100 } });
    const event = makeEvent('E1', [
      { entity: 'hero', attribute: 'level', value: 10 },
      { entity: 'hero', attribute: 'health', value: 100 },
    ]);

    const issues = validatePreconditions(event, world);
    expect(issues).toHaveLength(0);
  });

  it('returns warnings for unsatisfied eq preconditions', () => {
    const world = makeWorldState({ hero: { level: 5 } });
    const event = makeEvent('E1', [
      { entity: 'hero', attribute: 'level', value: 10 },
    ]);

    const issues = validatePreconditions(event, world);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].event).toBe('E1');
    expect(issues[0].entity).toBe('hero');
    expect(issues[0].attribute).toBe('level');
    expect(issues[0].message).toContain('level');
  });

  it('returns warnings for unsatisfied neq preconditions', () => {
    const world = makeWorldState({ hero: { status: 'dead' } });
    const event = makeEvent('E2', [
      { entity: 'hero', attribute: 'status', value: 'dead', operator: 'neq' },
    ]);

    const issues = validatePreconditions(event, world);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('neq');
  });

  it('validates gt/lt numeric preconditions', () => {
    const world = makeWorldState({ hero: { level: 5 } });
    const event = makeEvent('E3', [
      { entity: 'hero', attribute: 'level', value: 10, operator: 'gt' },
    ]);

    const issues = validatePreconditions(event, world);
    expect(issues).toHaveLength(1);
  });

  it('passes numeric comparisons when they hold', () => {
    const world = makeWorldState({ hero: { level: 15 } });
    const event = makeEvent('E3', [
      { entity: 'hero', attribute: 'level', value: 10, operator: 'gt' },
    ]);

    const issues = validatePreconditions(event, world);
    expect(issues).toHaveLength(0);
  });

  it('validates exists/not_exists preconditions', () => {
    const world = makeWorldState({ hero: { title: 'Champion' } });
    const event = makeEvent('E4', [
      { entity: 'hero', attribute: 'title', operator: 'exists' },
      { entity: 'hero', attribute: 'inventory', operator: 'not_exists' },
    ]);

    const issues = validatePreconditions(event, world);
    expect(issues).toHaveLength(0);
  });

  it('reports missing entity for exists precondition', () => {
    const world = makeWorldState({});
    const event = makeEvent('E5', [
      { entity: 'villain', attribute: 'power', operator: 'exists' },
    ]);

    const issues = validatePreconditions(event, world);
    expect(issues).toHaveLength(1);
  });

  it('skips narrativeHint-only preconditions (no value)', () => {
    const world = makeWorldState({ hero: { level: 1 } });
    const event = makeEvent('E6', [
      { entity: 'hero', attribute: 'mood', narrativeHint: 'hero is confident' },
    ]);

    const issues = validatePreconditions(event, world);
    // narrativeHint without value cannot be checked — accept as satisfied
    expect(issues).toHaveLength(0);
  });

  it('returns multiple warnings for multiple failures', () => {
    const world = makeWorldState({ hero: { level: 1 } });
    const event = makeEvent('E7', [
      { entity: 'hero', attribute: 'level', value: 10 },
      { entity: 'hero', attribute: 'hasSword', operator: 'exists' },
      { entity: 'villain', attribute: 'status', value: 'alive' },
    ]);

    const issues = validatePreconditions(event, world);
    expect(issues).toHaveLength(3);
    issues.forEach((issue) => {
      expect(issue.severity).toBe('warning');
      expect(issue.validator).toBe('narrative-planner');
    });
  });
});

// ─── Suggest Mode: suggestEvents ─────────────────────────────────────────────

describe('suggestEvents (suggest mode)', () => {
  it('returns empty list when no action definitions exist', () => {
    const world = makeWorldState();
    const goals: NarrativeGoal[] = [];
    const actions: ActionDefinition[] = [];

    const result = suggestEvents(world, goals, actions);
    expect(result).toHaveLength(0);
  });

  it('includes actions whose preconditions all match', () => {
    const world = makeWorldState({ hero: { level: 10 } });
    const goals: NarrativeGoal[] = [];
    const actions = [
      makeActionDef('level10_action', {
        preconditions: [
          { entity: 'hero', attribute: 'level', value: 10 },
        ],
      }),
      makeActionDef('level5_action', {
        preconditions: [
          { entity: 'hero', attribute: 'level', value: 5 },
        ],
      }),
    ];

    const result = suggestEvents(world, goals, actions);
    expect(result).toHaveLength(1);
    expect(result[0].actionId).toBe('level10_action');
  });

  it('excludes actions with unsatisfied preconditions', () => {
    const world = makeWorldState({ hero: { level: 3 } });
    const goals: NarrativeGoal[] = [];
    const actions = [
      makeActionDef('high_level_only', {
        preconditions: [
          { entity: 'hero', attribute: 'level', value: 10, operator: 'gt' },
        ],
      }),
    ];

    const result = suggestEvents(world, goals, actions);
    expect(result).toHaveLength(0);
  });

  it('ranks arcPosition-matched actions higher', () => {
    const world = makeWorldState({ hero: { level: 10 } });
    const goals: NarrativeGoal[] = [];
    const actions = [
      makeActionDef('climax_battle', {
        preconditions: [
          { entity: 'hero', attribute: 'level', value: 10 },
        ],
        typicalArcPositions: ['climax'],
      }),
      makeActionDef('opening_encounter', {
        preconditions: [
          { entity: 'hero', attribute: 'level', value: 10 },
        ],
        typicalArcPositions: ['opening'],
      }),
    ];

    const result = suggestEvents(world, goals, actions, 'climax');
    expect(result).toHaveLength(2);
    // climax_battle matches arcPosition, should be first
    expect(result[0].actionId).toBe('climax_battle');
  });

  it('boosts priority-related actions when goals match', () => {
    const world = makeWorldState({ hero: { level: 5 } });
    const goals = [
      makeGoal('g1', 'revenge_thread', 10),
      makeGoal('g2', 'romance_thread', 1),
    ];
    const actions = [
      makeActionDef('revenge_action', {
        preconditions: [
          { entity: 'hero', attribute: 'level', value: 5 },
        ],
        relatedThreadTypes: ['revenge_thread'],
      }),
      makeActionDef('romance_action', {
        preconditions: [
          { entity: 'hero', attribute: 'level', value: 5 },
        ],
        relatedThreadTypes: ['romance_thread'],
      }),
    ];

    const result = suggestEvents(world, goals, actions);
    expect(result).toHaveLength(2);
    // revenge_thread has priority 10, romance_thread has 1
    expect(result[0].actionId).toBe('revenge_action');
  });

  it('returns at most top-K candidates', () => {
    const world = makeWorldState({ hero: { level: 1 } });
    const goals: NarrativeGoal[] = [];
    // Create 10 actions that all pass (no preconditions)
    const actions = Array.from({ length: 10 }, (_, i) =>
      makeActionDef(`action_${i}`),
    );

    const result = suggestEvents(world, goals, actions);
    // Default top-K is 5
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it('returns actions sorted by score descending', () => {
    const world = makeWorldState({ hero: { level: 10 } });
    const goals = [
      makeGoal('g1', 'main_thread', 5),
      makeGoal('g2', 'side_thread', 1),
    ];
    const actions = [
      makeActionDef('side_only', {
        preconditions: [],
        relatedThreadTypes: ['side_thread'],
      }),
      makeActionDef('main_plus_arc', {
        preconditions: [
          { entity: 'hero', attribute: 'level', value: 10 },
        ],
        relatedThreadTypes: ['main_thread'],
        typicalArcPositions: ['rising'],
      }),
      makeActionDef('no_match', {
        preconditions: [],
      }),
    ];

    const result = suggestEvents(world, goals, actions, 'rising');
    // main_plus_arc should be first (arc match + high priority),
    // then side_only (low priority), then no_match (0 score)
    expect(result[0].actionId).toBe('main_plus_arc');
    expect(result[1].actionId).toBe('side_only');
    expect(result[2].actionId).toBe('no_match');
  });

  it('includes actions with no preconditions (always available)', () => {
    const world = makeWorldState();
    const goals: NarrativeGoal[] = [];
    const actions = [makeActionDef('always_available')];

    const result = suggestEvents(world, goals, actions);
    expect(result).toHaveLength(1);
    expect(result[0].actionId).toBe('always_available');
  });

  it('accepts narrativeHint preconditions as satisfied', () => {
    const world = makeWorldState({ hero: { level: 1 } });
    const goals: NarrativeGoal[] = [];
    const actions = [
      makeActionDef('narrative_checked', {
        preconditions: [
          {
            entity: 'hero',
            attribute: 'resolve',
            narrativeHint: 'hero feels determined',
          },
        ],
      }),
    ];

    const result = suggestEvents(world, goals, actions);
    expect(result).toHaveLength(1);
  });
});
