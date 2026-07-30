import { describe, expect, it } from 'vitest';
import { eventFileSchema } from '../../src/schemas/event.ts';
import { compileGameDialogueTree } from '../../src/branch/game-dialogue-tree.ts';
import { EntityMapper } from '../../src/entity/mapper.ts';
import { ConfigError } from '../../src/errors.ts';
import { parseStoryTimestamp, resolveTemporalContext } from '../../src/entity/timestamp.ts';
import { compileStoryRuntimeGraph } from '../../src/state/graph-adapter.ts';
import { ReplayEngine } from '../../src/state/replay.ts';
import { compileStoryBoundaries } from '../../src/state/story-boundaries.ts';
import { MemoryStorage } from '../../src/storage/memory-storage.ts';
import type {
  BranchPath,
  BranchSet,
  GameDialogueChoice,
  NarrativeEvent,
  TemporalContext,
} from '../../src/types/index.ts';
import type { TimeAnchor } from '../../src/types/entity.ts';
import type { Fact } from '../../src/types/entity.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function eventWithChoices(choices: unknown[]): unknown {
  return {
    event: 'E0',
    narrativeOrder: 0,
    title: 'The offer',
    storyTime: 'day_0',
    pov: { character: 'narrator', type: 'omniscient' },
    sceneBrief: 'The player receives an offer.',
    preconditions: [],
    expectedPostconditions: [],
    choices,
  };
}

function makeEvent(
  id: string,
  narrativeOrder: number,
  title: string,
  storyTimeStr: string,
  pov: { character: string; type: 'first_person' | 'third_person_limited' | 'omniscient' },
  sceneBrief: string,
  options?: {
    preconditions?: Array<{ entity: string; attribute: string; value?: unknown }>;
    choices?: GameDialogueChoice[];
    branchExistence?: BranchSet;
  },
): NarrativeEvent {
  const storyTime = parseStoryTimestamp(storyTimeStr);
  const mapFact = (pc: { entity: string; attribute: string; value?: unknown }): Fact => ({
    id: `${pc.entity}.${pc.attribute}`,
    entityId: pc.entity,
    attribute: pc.attribute,
    value: pc.value,
    validity: {
      temporal: { start: storyTime, end: null },
      branches: options?.branchExistence ?? ({ type: 'all' } satisfies BranchSet),
    },
  });

  return {
    kind: 'event',
    id,
    event: id,
    narrativeOrder,
    title,
    storyTime,
    sceneType: 'linear',
    pov: { character: pov.character, type: pov.type },
    sceneBrief,
    preconditions: (options?.preconditions ?? []).map(mapFact),
    postconditions: [],
    choices: options?.choices,
    threadProgress: [],
    foreshadowing: [],
    relationshipEffects: [],
    ruleEffects: [],
    source: 'event_file',
    branchExistence: options?.branchExistence ?? ({ type: 'all' } satisfies BranchSet),
    participants: { entities: [] },
  };
}

function resolveContext(
  events: readonly NarrativeEvent[],
  anchorDefs: Array<{ id: string; at: string; description?: string }>,
): TemporalContext {
  return resolveTemporalContext(
    events,
    anchorDefs.map(
      (entry) =>
        ({
          id: entry.id,
          at: parseStoryTimestamp(entry.at),
          description: entry.description,
        }) as TimeAnchor,
    ),
  );
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

const ALL_BRANCH: BranchSet = { type: 'all' };

const ROOT_POV = { character: 'narrator', type: 'omniscient' as const };
const BRANCH_POV = { character: 'hero', type: 'third_person_limited' as const };

const CHOOSE_HUNT: GameDialogueChoice[] = [
  {
    id: 'accept_hunt',
    label: 'Accept the hunt',
    description: 'Enter the jungle.',
    targetEvent: 'E1a',
    effects: [{ entity: 'hero', attribute: 'chose_hunt', value: true }],
  },
  {
    id: 'refuse_hunt',
    label: 'Refuse the hunt',
    description: 'Remain in the chateau.',
    targetEvent: 'E1b',
    effects: [{ entity: 'hero', attribute: 'chose_hunt', value: false }],
  },
];

const DEFAULT_ANCHORS: Array<{ id: string; at: string; description?: string }> = [
  { id: 'day_0', at: 'day 0', description: 'Day 0' },
  { id: 'day_1', at: 'day 1', description: 'Day 1' },
];

function gameTreeEvents(): NarrativeEvent[] {
  return [
    makeEvent('E0', 0, 'The offer', 'day_0', ROOT_POV, 'The player receives an offer.', {
      choices: CHOOSE_HUNT,
    }),
    makeEvent(
      'E1a',
      1,
      'The jungle',
      'day_1',
      BRANCH_POV,
      'The hunt begins.',
      {
        preconditions: [{ entity: 'hero', attribute: 'chose_hunt', value: true }],
      },
    ),
    makeEvent(
      'E1b',
      1,
      'The chateau',
      'day_1',
      BRANCH_POV,
      'The hero refuses.',
      {
        preconditions: [{ entity: 'hero', attribute: 'chose_hunt', value: false }],
      },
    ),
  ];
}

/** Default temporal context for the standard gameTreeEvents data. */
function defaultContext(): TemporalContext {
  return resolveContext(gameTreeEvents(), DEFAULT_ANCHORS);
}

// ---------------------------------------------------------------------------
// YAML-backed integration constants
// ---------------------------------------------------------------------------

const PROJECT_DIR = '/game-dialogue-tree';

function setupGameDialogueProject(storage: MemoryStorage): void {
  storage.write(
    `${PROJECT_DIR}/nova.yaml`,
    ['project: game-dialogue-tree', 'title: Game Dialogue Tree', 'author: Test Author'].join('\n'),
  );
  storage.write(
    `${PROJECT_DIR}/definitions/state_initial.yaml`,
    [
      'info:',
      '  currentEra: beginning',
      '  politicalSituation: stable',
      'timeAnchors:',
      '  - { id: day_0, at: "day 0", description: "Day 0" }',
      '  - { id: day_1, at: "day 1", description: "Day 1" }',
      'threads: []',
      'worldFacts: []',
    ].join('\n'),
  );
  storage.write(
    `${PROJECT_DIR}/definitions/discourse-ledger.yaml`,
    [
      'id: game_dialogue_tree_test_ledger',
      'chapters:',
      '  - branch: accept_hunt',
      '    chapter: 1',
      '    sceneIds:',
      '      - E0',
      '      - E1a',
      '  - branch: refuse_hunt',
      '    chapter: 1',
      '    sceneIds:',
      '      - E0',
      '      - E1b',
      'entries: []',
    ].join('\n'),
  );
  storage.write(
    `${PROJECT_DIR}/chapters/chapter_01/_chapter.yaml`,
    [
      'chapter: 1',
      'title: Chapter One',
      'summary: Branches begin.',
      'intent: Present a choice.',
      'plannedScenes: 3',
    ].join('\n'),
  );
  storage.write(
    `${PROJECT_DIR}/chapters/chapter_01/E0.yaml`,
    [
      'event: E0',
      'narrativeOrder: 0',
      'title: The offer',
      'storyTime: day_0',
      'pov:',
      '  character: narrator',
      '  type: omniscient',
      'sceneBrief: The player receives an offer.',
      'preconditions: []',
      'expectedPostconditions: []',
      'choices:',
      '  - id: accept_hunt',
      '    label: Accept the hunt',
      '    description: Enter the jungle.',
      '    targetEvent: E1a',
      '    effects:',
      '      - entity: hero',
      '        attribute: chose_hunt',
      '        value: true',
      '  - id: refuse_hunt',
      '    label: Refuse the hunt',
      '    description: Remain in the chateau.',
      '    targetEvent: E1b',
      '    effects:',
      '      - entity: hero',
      '        attribute: chose_hunt',
      '        value: false',
    ].join('\n'),
  );
  storage.write(
    `${PROJECT_DIR}/chapters/chapter_01/E1a.yaml`,
    [
      'event: E1a',
      'narrativeOrder: 1',
      'title: The jungle',
      'storyTime: day_1',
      'pov:',
      '  character: hero',
      '  type: third_person_limited',
      'sceneBrief: The hunt begins.',
      'preconditions:',
      '  - entity: hero',
      '    attribute: chose_hunt',
      '    value: true',
      'expectedPostconditions: []',
    ].join('\n'),
  );
  storage.write(
    `${PROJECT_DIR}/chapters/chapter_01/E1b.yaml`,
    [
      'event: E1b',
      'narrativeOrder: 1',
      'title: The chateau',
      'storyTime: day_1',
      'pov:',
      '  character: hero',
      '  type: third_person_limited',
      'sceneBrief: The hero refuses.',
      'preconditions:',
      '  - entity: hero',
      '    attribute: chose_hunt',
      '    value: false',
      'expectedPostconditions: []',
    ].join('\n'),
  );
}

function event(
  id: string,
  narrativeOrder: number,
  branchExistence: NarrativeEvent['branchExistence'],
): NarrativeEvent {
  return {
    kind: 'event',
    id,
    event: id,
    narrativeOrder,
    title: id,
    storyTime: { type: 'absolute', value: `day_${narrativeOrder}` },
    sceneType: 'linear',
    pov: { character: 'narrator', type: 'omniscient' },
    sceneBrief: id,
    preconditions: [],
    postconditions: [],
    threadProgress: [],
    foreshadowing: [],
    relationshipEffects: [],
    ruleEffects: [],
    source: 'event_file',
    branchExistence,
    participants: { entities: [] },
  };
}

// ===========================================================================
// event-local game dialogue contract (schema validation)
// ===========================================================================

describe('event-local game dialogue contract', () => {
  it('accepts strict choices and defaults omitted effects', () => {
    const result = eventFileSchema.parse(
      eventWithChoices([
        {
          id: 'accept_hunt',
          label: 'Accept the hunt',
          description: 'Enter the jungle with a knife and three hours head start.',
          targetEvent: 'E1a',
        },
      ]),
    );

    expect(result.choices).toEqual([
      {
        id: 'accept_hunt',
        label: 'Accept the hunt',
        description: 'Enter the jungle with a knife and three hours head start.',
        targetEvent: 'E1a',
        effects: [],
      },
    ]);
  });

  it('rejects empty or duplicate choice identifiers during EventFile parsing', () => {
    expect(eventFileSchema.safeParse(eventWithChoices([])).success).toBe(false);
    expect(
      eventFileSchema.safeParse(
        eventWithChoices([
          { id: 'hunt', label: 'Hunt', description: 'Go.', targetEvent: 'E1a' },
          { id: 'hunt', label: 'Hide', description: 'Hide.', targetEvent: 'E1b' },
        ]),
      ).success,
    ).toBe(false);
  });

  it('rejects legacy and snake_case choice grammar', () => {
    expect(
      eventFileSchema.safeParse({
        ...eventWithChoices([]),
        branchPoint: { id: 'legacy' },
      }).success,
    ).toBe(false);
    expect(
      eventFileSchema.safeParse(
        eventWithChoices([
          {
            id: 'hunt',
            label: 'Hunt',
            description: 'Go.',
            target_event: 'E1a',
          },
        ]),
      ).success,
    ).toBe(false);
  });
});

// ===========================================================================
// compileGameDialogueTree
// ===========================================================================

describe('compileGameDialogueTree()', () => {
  it('derives leaf paths, exact scopes, representative paths, and transitions', () => {
    const events = gameTreeEvents();
    const temporalContext = defaultContext();
    const tree = compileGameDialogueTree(events, temporalContext);
    const huntPath = {
      decisions: [{ atEventId: 'E0', choiceId: 'accept_hunt', narrativeOrder: 0 }],
    };
    const refusePath = {
      decisions: [{ atEventId: 'E0', choiceId: 'refuse_hunt', narrativeOrder: 0 }],
    };

    expect(tree).not.toBeNull();
    expect(tree!.leafPaths).toEqual([huntPath, refusePath]);
    expect(tree!.eventScopes.get('E0')).toEqual({ type: 'all' });
    expect(tree!.eventScopes.get('E1a')).toEqual({ type: 'paths', paths: [huntPath] });
    expect(tree!.eventScopes.get('E1b')).toEqual({ type: 'paths', paths: [refusePath] });
    expect(tree!.representativePathByEventId.get('E0')).toEqual(huntPath);
    expect(tree!.transitionEvents).toMatchObject([
      {
        id: 'system:branch-choice:E0:accept_hunt',
        branchExistence: { type: 'paths', paths: [huntPath] },
        causalPredecessors: ['E0'],
      },
      {
        id: 'system:branch-choice:E0:refuse_hunt',
        branchExistence: { type: 'paths', paths: [refusePath] },
        causalPredecessors: ['E0'],
      },
    ]);
    expect(tree!.transitionEvents[0]!.postconditions[0]).toMatchObject({
      id: 'hero.chose_hunt',
      value: true,
      validity: { branches: { type: 'paths', paths: [huntPath] } },
    });
  });

  it('returns null when authored events are linear', () => {
    const events = gameTreeEvents();
    events[0]!.choices = undefined;
    const temporalContext = resolveContext(events, DEFAULT_ANCHORS);
    expect(compileGameDialogueTree(events, temporalContext)).toBeNull();
  });

  it('uses project time anchors for named choice timestamps', () => {
    const events = gameTreeEvents();
    // Re-define events with story_beginning as the anchor reference
    const contextEvents: NarrativeEvent[] = [
      makeEvent('E0', 0, 'The offer', 'story_beginning', ROOT_POV, 'The player receives an offer.', {
        choices: CHOOSE_HUNT,
      }),
      makeEvent('E1a', 1, 'The jungle', 'story_beginning + 1 day', BRANCH_POV, 'The hunt begins.', {
        preconditions: [{ entity: 'hero', attribute: 'chose_hunt', value: true }],
      }),
      makeEvent('E1b', 1, 'The chateau', 'story_beginning + 1 day', BRANCH_POV, 'The hero refuses.', {
        preconditions: [{ entity: 'hero', attribute: 'chose_hunt', value: false }],
      }),
    ];
    const temporalContext = resolveContext(contextEvents, [
      { id: 'story_beginning', at: 'day 0', description: 'Beginning' },
    ]);
    expect(compileGameDialogueTree(contextEvents, temporalContext)).not.toBeNull();
  });

  it('rejects invalid targets, topology, and chronology before rendering', () => {
    const invalidCases: Array<() => NarrativeEvent[]> = [
      // Missing target event
      () => {
        const events = gameTreeEvents();
        // Copy choices to avoid mutating the shared CHOOSE_HUNT constant
        events[0] = {
          ...events[0],
          choices: [
            { ...events[0]!.choices![0]!, targetEvent: 'missing' },
            events[0]!.choices![1]!,
          ],
        };
        return events;
      },
      // Self-targeting choice
      () => {
        const events = gameTreeEvents();
        events[0] = {
          ...events[0],
          choices: [
            { ...events[0]!.choices![0]!, targetEvent: 'E0' },
            events[0]!.choices![1]!,
          ],
        };
        return events;
      },
      // Multiple incoming edges to the same target
      () => {
        const events = gameTreeEvents();
        events[0]!.choices = [
          {
            id: 'to_a',
            label: 'To A',
            description: 'Continue.',
            targetEvent: 'E1a',
            effects: [],
          },
          {
            id: 'to_b',
            label: 'To B',
            description: 'Continue.',
            targetEvent: 'E1b',
            effects: [],
          },
        ];
        events[1]!.choices = [
          {
            id: 'merge',
            label: 'Merge',
            description: 'Merge.',
            targetEvent: 'E1b',
            effects: [],
          },
        ];
        return events;
      },
      // Unreachable node
      () => {
        const events = gameTreeEvents();
        const e2 = makeEvent(
          'E2',
          2,
          'Unreachable',
          'day_2',
          BRANCH_POV,
          'This node is disconnected.',
        );
        events.push(e2);
        return events;
      },
      // Cycle
      () => {
        const events = gameTreeEvents();
        events[0]!.choices = [
          {
            id: 'to_a',
            label: 'To A',
            description: 'Continue.',
            targetEvent: 'E1a',
            effects: [],
          },
        ];
        events[1]!.choices = [
          {
            id: 'loop',
            label: 'Loop',
            description: 'Return.',
            targetEvent: 'E0',
            effects: [],
          },
        ];
        return events;
      },
      // Same-clock backward target (E1a storyTime before E0)
      () => {
        const events = gameTreeEvents();
        // Replace E1a with one whose storyTime is day_-1 (earlier than day_0)
        const e1aBackward = makeEvent(
          'E1a',
          1,
          'The jungle',
          'day_-1',
          BRANCH_POV,
          'The hunt begins.',
          {
            preconditions: [{ entity: 'hero', attribute: 'chose_hunt', value: true }],
          },
        );
        events[1] = e1aBackward;
        return events;
      },
    ];

    for (const invalidEvents of invalidCases) {
      const evts = invalidEvents();
      const tc = resolveContext(evts, DEFAULT_ANCHORS);
      expect(() => compileGameDialogueTree(evts, tc)).toThrow(ConfigError);
    }
  });

  // -----------------------------------------------------------------------
  // New contract tests
  // -----------------------------------------------------------------------

  it('accepts unlocated transition when target has unlocated storyTime', () => {
    const events = gameTreeEvents();
    // Replace E1a with one that has indeterminate storyTime
    events[1] = {
      ...makeEvent('E1a', 1, 'The jungle', 'day_1', BRANCH_POV, 'The hunt begins.', {
        preconditions: [{ entity: 'hero', attribute: 'chose_hunt', value: true }],
      }),
      storyTime: { type: 'indeterminate', mode: 'unspecified' },
    };
    const temporalContext = resolveContext(events, DEFAULT_ANCHORS);
    expect(() => compileGameDialogueTree(events, temporalContext)).not.toThrow();
    const tree = compileGameDialogueTree(events, temporalContext);
    expect(tree).not.toBeNull();
  });

  it('rejects same-clock backward target when choice target is chronologically earlier than source', () => {
    const events = gameTreeEvents();
    // Replace E1a with one whose storyTime is earlier on the same clock
    events[1] = makeEvent('E1a', 1, 'The jungle', 'day_-1', BRANCH_POV, 'The hunt begins.', {
      preconditions: [{ entity: 'hero', attribute: 'chose_hunt', value: true }],
    });
    const temporalContext = resolveContext(events, DEFAULT_ANCHORS);
    expect(() => compileGameDialogueTree(events, temporalContext)).toThrow(ConfigError);
  });
});

// ===========================================================================
// game dialogue replay integration
// ===========================================================================

describe('game dialogue replay integration', () => {
  const acceptPath: BranchPath = {
    decisions: [{ atEventId: 'E0', choiceId: 'accept_hunt', narrativeOrder: 0 }],
  };
  const refusePath: BranchPath = {
    decisions: [{ atEventId: 'E0', choiceId: 'refuse_hunt', narrativeOrder: 0 }],
  };

  it('maps scopes and replays each selected transition before its target', () => {
    const storage = new MemoryStorage();
    setupGameDialogueProject(storage);
    const mapper = new EntityMapper(PROJECT_DIR, storage);
    const data = mapper.loadProject();
    const events = mapper.loadAllEvents(data.chapters);
    const target = events.find((item) => item.id === 'E1a')!;
    const transition = events.find((item) => item.id === 'system:branch-choice:E0:accept_hunt')!;

    expect(target.branchExistence).toEqual({ type: 'paths', paths: [acceptPath] });
    expect(target.preconditions[0]!.validity.branches).toEqual({
      type: 'paths',
      paths: [acceptPath],
    });
    expect(target.causalPredecessors).toEqual(['system:branch-choice:E0:accept_hunt']);
    expect(transition.branchExistence).toEqual({ type: 'paths', paths: [acceptPath] });

    const replayEvents = events.filter((item) => item.id !== 'system:genesis');

    // Build story graph to obtain adjacency, then compile boundaries from it
    const compiled = compileStoryRuntimeGraph({
      events,
      initialFacts: [],
      initialThreads: [],
      timeAnchors: data.timeAnchors,
      branchPath: acceptPath,
    });
    const boundaries = compileStoryBoundaries(
      replayEvents,
      [],
      compiled.storyAdjacency,
      acceptPath,
    );
    const replayed = new ReplayEngine().replay(events, {
      branchPath: acceptPath,
      timeAnchors: data.timeAnchors,
    });

    expect(boundaries.stateBeforeByEventId.get('E1a')!.entities.hero!.chose_hunt).toBe(true);
    expect(replayed).toEqual(boundaries.finalState);
    expect(
      new ReplayEngine().replay(events, {
        branchPath: refusePath,
        timeAnchors: data.timeAnchors,
      }).entities.hero!.chose_hunt,
    ).toBe(false);
  });

  it('rejects explicit predecessors absent from the selected branch', () => {
    const laneA: BranchPath = {
      decisions: [{ atEventId: 'E0', choiceId: 'a', narrativeOrder: 0 }],
    };
    const laneB: BranchPath = {
      decisions: [{ atEventId: 'E0', choiceId: 'b', narrativeOrder: 0 }],
    };
    const laneAEvent = event('lane-a', 1, { type: 'paths', paths: [laneA] });
    const consumer = event('consumer', 2, { type: 'all' });
    consumer.causalPredecessors = ['lane-a'];

    expect(() =>
      compileStoryRuntimeGraph({
        events: [laneAEvent, consumer],
        initialFacts: [],
        initialThreads: [],
        timeAnchors: [],
        branchPath: laneB,
      }),
    ).toThrow(ConfigError);
  });

  it('does not use a fact whose scope excludes the selected branch', () => {
    const laneA: BranchPath = {
      decisions: [{ atEventId: 'E0', choiceId: 'a', narrativeOrder: 0 }],
    };
    const laneB: BranchPath = {
      decisions: [{ atEventId: 'E0', choiceId: 'b', narrativeOrder: 0 }],
    };
    const writer = event('writer', 1, { type: 'all' });
    writer.postconditions = [
      {
        id: 'hero.route',
        entityId: 'hero',
        attribute: 'route',
        value: 'a',
        validity: {
          temporal: { start: writer.storyTime, end: null },
          branches: { type: 'paths', paths: [laneA] },
        },
      },
    ];
    const consumer = event('consumer', 2, { type: 'all' });
    consumer.preconditions = [
      {
        id: 'hero.route.required',
        entityId: 'hero',
        attribute: 'route',
        value: 'a',
        validity: {
          temporal: { start: consumer.storyTime, end: null },
          branches: { type: 'paths', paths: [laneB] },
        },
      },
    ];

    // compileStoryRuntimeGraph handles branch-excluded writes gracefully.
    // The writer's fact (scoped to laneA) is excluded from laneB's branch,
    // so the consumer's precondition (scoped to laneB) resolves to an absence
    // witness rather than an error.
    expect(() =>
      compileStoryRuntimeGraph({
        events: [writer, consumer],
        initialFacts: [],
        initialThreads: [],
        timeAnchors: [],
        branchPath: laneB,
      }),
    ).not.toThrow();
  });
});
