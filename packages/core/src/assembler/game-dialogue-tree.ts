import * as path from 'node:path';
import { ConfigError } from '../errors.ts';
import type { Storage } from '../storage/index.ts';
import type { NarrativeEvent } from '../types/index.ts';
import type { CompiledGameDialogueTree } from '../branch/game-dialogue-tree.ts';

export interface AssembleGameDialogueTreeOptions {
  projectDir: string;
  storage: Storage;
  tree: CompiledGameDialogueTree;
  eventsById: ReadonlyMap<string, NarrativeEvent>;
  chapterByEventId: ReadonlyMap<string, number>;
  title?: string;
}

export interface AssembleGameDialogueTreeResult {
  outputPath: string;
  markdown: string;
}

function anchorFor(eventId: string): string {
  return `event-${encodeURIComponent(eventId)}`;
}

function orderedEventIds(tree: CompiledGameDialogueTree): string[] {
  const roots = [...tree.eventScopes.entries()]
    .filter(([, scope]) => scope.type === 'all')
    .map(([eventId]) => eventId);
  if (roots.length !== 1) {
    throw new ConfigError(`Game dialogue tree requires exactly one root; found ${roots.length}`, {
      phase: 'game_dialogue_assembly',
    });
  }

  const ordered: string[] = [];
  const visit = (eventId: string): void => {
    ordered.push(eventId);
    for (const choice of tree.choicesByEventId.get(eventId) ?? []) visit(choice.targetEvent);
  };
  visit(roots[0]!);
  return ordered;
}

/**
 * Assemble only fully released game-tree scene documents. A missing, malformed,
 * or rejected response causes a no-op so an incomplete tree is never delivered.
 */
export function assembleGameDialogueTree(
  options: AssembleGameDialogueTreeOptions,
): AssembleGameDialogueTreeResult | null {
  const { projectDir, storage, tree, eventsById, chapterByEventId, title } = options;
  const eventIds = orderedEventIds(tree);
  const scenePaths = new Map<string, string>();

  for (const eventId of eventIds) {
    const responsePath = path.join(projectDir, '.nova', 'responses', `${eventId}.json`);
    if (!storage.exists(responsePath)) return null;
    try {
      const response = JSON.parse(storage.read(responsePath)) as { released?: unknown };
      if (response.released !== true) return null;
    } catch {
      return null;
    }

    const chapter = chapterByEventId.get(eventId);
    if (chapter === undefined) {
      throw new ConfigError(`Missing chapter for game dialogue event '${eventId}'`, {
        eventId,
        phase: 'game_dialogue_assembly',
      });
    }
    const scenePath = path.join(
      projectDir,
      'scenes',
      `chapter-${String(chapter).padStart(2, '0')}`,
      `${eventId}.md`,
    );
    if (!storage.exists(scenePath)) return null;
    scenePaths.set(eventId, scenePath);
  }

  const sections = eventIds.map((eventId) => {
    const event = eventsById.get(eventId);
    if (!event) {
      throw new ConfigError(`Missing game dialogue event '${eventId}'`, {
        eventId,
        phase: 'game_dialogue_assembly',
      });
    }
    const choices = tree.choicesByEventId.get(eventId) ?? [];
    const choiceLinks =
      choices.length === 0
        ? ''
        : `\n\n### Choices\n\n${choices
            .map(
              (choice) =>
                `- [${choice.label}](#${anchorFor(choice.targetEvent)}) — ${choice.description}`,
            )
            .join('\n')}`;
    return [
      `<a id="${anchorFor(eventId)}"></a>`,
      `## ${event.title}`,
      '',
      storage.read(scenePaths.get(eventId)!).trim(),
      choiceLinks,
    ]
      .filter((part) => part !== '')
      .join('\n');
  });

  const markdown = [`# ${title ?? 'Dialogue Tree'}`, '', ...sections, ''].join('\n\n');
  const outputPath = path.join(projectDir, 'output', 'dialogue-tree.md');
  storage.mkdirp(path.dirname(outputPath));
  storage.write(outputPath, markdown);
  return { outputPath, markdown };
}
