import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { renderGameDialogueTree, renderNovel } from '../../src/api.ts';
import { MockPass2Provider } from '../../src/ai/providers/mock-pass2.ts';
import { MemoryStorage } from '../../src/storage/memory-storage.ts';
import type { MockPass2Entry } from '../../src/ai/providers/mock-pass2.ts';
import type { BranchPath } from '../../src/types/index.ts';

const PROJECT_DIR = '/game-dialogue-render';
const PROSE =
  'Dawn pressed silver through the high windows as the stranger placed the knife beside the map. ' +
  'The hero listened to the offer without moving, perhaps measuring the distance to every door and the certainty in the strangers voice. ' +
  'Outside, rain began to tick against the glass, patient as a clock.';

function makeEntry(eventId: string): MockPass2Entry {
  return {
    prose: `${eventId}: ${PROSE}`,
    analysis: {
      eventId,
      analysis: {
        postconditions: { covered: [], dropped: [] },
        preconditions: { violated: [] },
        pov: { consistent: true, leaks: [] },
        inventedDetails: [],
        quality: {
          proseScore: 5,
          maxScore: 5,
          strengths: ['concrete scene work'],
          weaknesses: [],
          estimatedWordCount: 80,
        },
        threadProgressAchieved: [],
        foreshadowingDeployed: [],
        narrativeChecks: [],
        appearanceChecks: [],
        characterReferences: [],
        tenseDetected: 'past',
        conflictAnalysis: { primaryType: 'none', resolutionAchieved: true },
        ruleChecks: [],
        knowledgeChecks: [],
      },
    },
  };
}

function provider(): MockPass2Provider {
  return new MockPass2Provider({
    entries: {
      E0: makeEntry('E0'),
      E1a: makeEntry('E1a'),
      E1b: makeEntry('E1b'),
    },
  });
}

function setupProject(storage: MemoryStorage): void {
  storage.write(
    `${PROJECT_DIR}/nova.yaml`,
    [
      'project: game-dialogue-render',
      'title: Game Dialogue Render',
      'author: Test Author',
      'defaultModel: mock-pass2',
      'defaultLanguage: en',
    ].join('\n'),
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
    `${PROJECT_DIR}/definitions/characters/narrator.yaml`,
    [
      'id: narrator',
      'name: Narrator',
      'type: person',
      'description: The narrator.',
      'initialState: {}',
      'traits: []',
    ].join('\n'),
  );
  storage.write(
    `${PROJECT_DIR}/definitions/characters/hero.yaml`,
    [
      'id: hero',
      'name: Hero',
      'type: person',
      'description: The protagonist.',
      'initialState: {}',
      'traits: []',
    ].join('\n'),
  );
  storage.write(
    `${PROJECT_DIR}/chapters/chapter_01/_chapter.yaml`,
    [
      'chapter: 1',
      'title: Chapter One',
      'summary: A decision and two outcomes.',
      'intent: Present a decision.',
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
      '    description: Enter the jungle with a knife and three hours head start.',
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

const acceptPath: BranchPath = {
  decisions: [{ atEventId: 'E0', choiceId: 'accept_hunt', narrativeOrder: 0 }],
};
const refusePath: BranchPath = {
  decisions: [{ atEventId: 'E0', choiceId: 'refuse_hunt', narrativeOrder: 0 }],
};

describe('renderGameDialogueTree()', () => {
  it('renders every node once, appends deterministic choices, and assembles linked output', async () => {
    const storage = new MemoryStorage();
    setupProject(storage);

    const result = await renderGameDialogueTree({
      projectDir: PROJECT_DIR,
      storage,
      provider: provider(),
      model: 'mock-pass2',
      maxRounds: 1,
    });

    expect(result.errors).toEqual([]);
    expect(result.results.map((item) => item.eventId)).toEqual(['E0', 'E1a', 'E1b']);
    expect(result.results.every((item) => item.released)).toBe(true);
    expect(result.outputPath).toBe(`${PROJECT_DIR}/output/dialogue-tree.md`);

    const decisionScene = storage.read(`${PROJECT_DIR}/scenes/chapter-01/E0.md`);
    expect(decisionScene).toContain(`<!-- FABULA:PLAYER_CHOICES:v1 -->
\`\`\`yaml
playerChoices:
  - id: accept_hunt
    label: "Accept the hunt"
    description: "Enter the jungle with a knife and three hours head start."
    targetEvent: E1a`);
    expect(decisionScene).toContain('<!-- /FABULA:PLAYER_CHOICES -->');

    const response = JSON.parse(storage.read(`${PROJECT_DIR}/.nova/responses/E0.json`)) as {
      prose: string;
    };
    expect(response.prose).not.toContain('FABULA:PLAYER_CHOICES');
    const metadata = parseYaml(storage.read(`${PROJECT_DIR}/scenes/chapter-01/E0.yaml`)) as {
      playerChoices: Array<{ id: string; targetEvent: string }>;
    };
    expect(metadata.playerChoices).toEqual([
      expect.objectContaining({ id: 'accept_hunt', targetEvent: 'E1a' }),
      expect.objectContaining({ id: 'refuse_hunt', targetEvent: 'E1b' }),
    ]);

    const dialogueTree = storage.read(`${PROJECT_DIR}/output/dialogue-tree.md`);
    expect(dialogueTree).toContain('<a id="event-E0"></a>');
    expect(dialogueTree).toContain('[Accept the hunt](#event-E1a)');
    expect(dialogueTree).toContain('<a id="event-E1a"></a>');
    expect(dialogueTree).toContain('<a id="event-E1b"></a>');
    expect(storage.exists(`${PROJECT_DIR}/output/novel.md`)).toBe(false);

    storage.write(
      `${PROJECT_DIR}/chapters/chapter_01/E0.yaml`,
      storage
        .read(`${PROJECT_DIR}/chapters/chapter_01/E0.yaml`)
        .replace('Accept the hunt', 'Accept the dangerous hunt'),
    );
    const warmed = await renderGameDialogueTree({
      projectDir: PROJECT_DIR,
      storage,
      provider: provider(),
      model: 'mock-pass2',
      maxRounds: 1,
    });

    expect(warmed.results.find((item) => item.eventId === 'E0')!.cacheHit).toBe(false);
    expect(storage.read(`${PROJECT_DIR}/scenes/chapter-01/E0.md`)).toContain(
      'label: "Accept the dangerous hunt"',
    );
  });

  it('renders only the selected route and rejects invalid paths before provider work', async () => {
    for (const [branchPath, expectedEventIds, expectedChoice] of [
      [acceptPath, ['E0', 'E1a'], 'true'],
      [refusePath, ['E0', 'E1b'], 'false'],
    ] as const) {
      const storage = new MemoryStorage();
      setupProject(storage);
      const rendered = await renderNovel({
        projectDir: PROJECT_DIR,
        storage,
        provider: provider(),
        model: 'mock-pass2',
        branchPath,
        maxRounds: 1,
      });
      expect(rendered.errors).toEqual([]);
      expect(rendered.results.map((item) => item.eventId)).toEqual(expectedEventIds);
      const renderRequest = parseYaml(
        storage.read(
          `${PROJECT_DIR}/scenes/chapter-01/${expectedEventIds[1]}_render_request.yaml`,
        ),
      ) as { requests: Array<{ messages: Array<{ content: string }> }> };
      expect(renderRequest.requests[0]!.messages[1]!.content).toContain(
        `"chose_hunt": ${expectedChoice}`,
      );
    }

    const storage = new MemoryStorage();
    setupProject(storage);
    const invalidProvider = provider();
    let providerCalls = 0;
    const complete = invalidProvider.complete.bind(invalidProvider);
    invalidProvider.complete = async (request) => {
      providerCalls++;
      return complete(request);
    };
    for (const branchPath of [
      undefined,
      { decisions: [] },
      { decisions: [{ atEventId: 'E0', choiceId: 'unknown', narrativeOrder: 0 }] },
      { decisions: [{ atEventId: 'E1a', choiceId: 'late', narrativeOrder: 1 }] },
    ]) {
      const invalid = await renderNovel({
        projectDir: PROJECT_DIR,
        storage,
        provider: invalidProvider,
        model: 'mock-pass2',
        branchPath,
      });
      expect(invalid.results).toEqual([]);
      expect(invalid.errors).toContain('Game dialogue rendering requires one complete, ordered leaf branchPath.');
    }
    expect(providerCalls).toBe(0);
    expect(storage.exists(`${PROJECT_DIR}/.nova/render-cache`)).toBe(false);
  });
});
