import { describe, expect, it } from 'vitest';
import { eventFileSchema } from '../../src/schemas/event.ts';
import { compileGameDialogueTree } from '../../src/branch/game-dialogue-tree.ts';
import { EntityMapper } from '../../src/entity/mapper.ts';
import { DagProviderError } from '../../src/errors.ts';
import { buildCausalEdges } from '../../src/state/dag.ts';
import { ReplayEngine } from '../../src/state/replay.ts';
import { compileStoryBoundaries } from '../../src/state/story-boundaries.ts';
import { MemoryStorage } from '../../src/storage/memory-storage.ts';
import type { EventFile } from '../../src/types/index.ts';
import type { BranchPath, NarrativeEvent } from '../../src/types/index.ts';

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

function gameTreeEvents(): EventFile[] {
  return [
    {
      event: 'E0',
      narrativeOrder: 0,
      title: 'The offer',
      storyTime: 'day_0',
      pov: { character: 'narrator', type: 'omniscient' },
      sceneBrief: 'The player receives an offer.',
      preconditions: [],
      expectedPostconditions: [],
      choices: [
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
      ],
    },
    {
      event: 'E1a',
      narrativeOrder: 1,
      title: 'The jungle',
      storyTime: 'day_1',
      pov: { character: 'hero', type: 'third_person_limited' },
      sceneBrief: 'The hunt begins.',
      preconditions: [{ entity: 'hero', attribute: 'chose_hunt', value: true }],
      expectedPostconditions: [],
    },
    {
      event: 'E1b',
      narrativeOrder: 1,
      title: 'The chateau',
      storyTime: 'day_1',
      pov: { character: 'hero', type: 'third_person_limited' },
      sceneBrief: 'The hero refuses.',
      preconditions: [{ entity: 'hero', attribute: 'chose_hunt', value: false }],
      expectedPostconditions: [],
    },
  ];
}

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
      '  - { id: day_0, day: 0, description: "Day 0" }',
      '  - { id: day_1, day: 1, description: "Day 1" }',
      'threads: []',
      'worldFacts: []',
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
  const [root, hunt, refuse] = gameTreeEvents();
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
  for (const event of [hunt!, refuse!]) {
    storage.write(
      `${PROJECT_DIR}/chapters/chapter_01/${event.event}.yaml`,
      [
        `event: ${event.event}`,
        `narrativeOrder: ${event.narrativeOrder}`,
        `title: ${event.title}`,
        `storyTime: ${event.storyTime}`,
        'pov:',
        `  character: ${event.pov.character}`,
        `  type: ${event.pov.type}`,
        `sceneBrief: ${event.sceneBrief}`,
        'preconditions:',
        `  - entity: ${event.preconditions[0]!.entity}`,
        `    attribute: ${event.preconditions[0]!.attribute}`,
        `    value: ${String(event.preconditions[0]!.value)}`,
        'expectedPostconditions: []',
      ].join('\n'),
    );
  }
  void root;
}

function event(
  id: string,
  narrativeOrder: number,
  branchExistence: NarrativeEvent['branchExistence'],
): NarrativeEvent {
  return {
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

describe('compileGameDialogueTree()', () => {
  it('derives leaf paths, exact scopes, representative paths, and transitions', () => {
    const tree = compileGameDialogueTree(gameTreeEvents());
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
    expect(compileGameDialogueTree(events)).toBeNull();
  });

  it('uses project time anchors for named choice timestamps', () => {
    const events = gameTreeEvents();
    events[0]!.storyTime = 'story_beginning';
    events[1]!.storyTime = 'story_beginning + 1 day';
    events[2]!.storyTime = 'story_beginning + 1 day';

    expect(
      compileGameDialogueTree(events, new Map([['story_beginning', 0]])),
    ).not.toBeNull();
  });

  it('rejects invalid targets, topology, and chronology before rendering', () => {
    const invalidCases: Array<() => EventFile[]> = [
      () => {
        const events = gameTreeEvents();
        events[0]!.choices![0]!.targetEvent = 'missing';
        return events;
      },
      () => {
        const events = gameTreeEvents();
        events[0]!.choices![0]!.targetEvent = 'E0';
        return events;
      },
      () => {
        const events = gameTreeEvents();
        events[2]!.storyTime = 'day_2';
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
      () => {
        const events = gameTreeEvents();
        events.push({
          event: 'E2',
          narrativeOrder: 2,
          title: 'Unreachable',
          storyTime: 'day_2',
          pov: { character: 'hero', type: 'third_person_limited' },
          sceneBrief: 'This node is disconnected.',
          preconditions: [],
          expectedPostconditions: [],
        });
        return events;
      },
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
      () => {
        const events = gameTreeEvents();
        events[1]!.storyTime = 'day_0';
        return events;
      },
    ];

    for (const invalidEvents of invalidCases) {
      expect(() => compileGameDialogueTree(invalidEvents())).toThrow();
    }
  });
});

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
    const anchors = new Map(data.timeAnchors.map((anchor) => [anchor.id, anchor.day]));
    const boundaries = compileStoryBoundaries(replayEvents, [], anchors, acceptPath);
    const replayed = new ReplayEngine().replay(events, acceptPath);

    expect(boundaries.stateBeforeByEventId.get('E1a')!.entities.hero!.chose_hunt).toBe(true);
    expect(replayed).toEqual(boundaries.finalState);
    expect(new ReplayEngine().replay(events, refusePath).entities.hero!.chose_hunt).toBe(false);
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

    expect(() => buildCausalEdges([laneAEvent, consumer], { branchPath: laneB })).toThrow(
      DagProviderError,
    );
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

    expect(() => buildCausalEdges([writer, consumer], { branchPath: laneB })).toThrow(
      DagProviderError,
    );
  });
});
