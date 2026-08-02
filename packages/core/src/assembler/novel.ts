import type { ChapterMetadata } from '../types/chapter.ts';
import { filterScenesByBranchPath } from './branch-filter.js';
import { ProseConcatenator } from './concatenator.js';
import { countNarrativeText } from './count.js';
import type { AssembleOptions, AssembleResult, SortedScene } from './types.js';
import { AssemblyError, AssemblyErrorCode } from './types.js';

/** Assemble an immutable semantic source. Host code materializes output. */
export function assembleNovel(options: AssembleOptions): AssembleResult {
  const { source, branchPath, title, language = 'en' } = options;
  let scenes = [...source.scenes].map(([eventId, entry]) => ({
    eventId,
    prose: entry.prose,
    narrativeOrder: entry.narrativeOrder,
    chapter: entry.chapter,
    branchExistence: entry.branchExistence,
  }));
  if (branchPath) scenes = filterScenesByBranchPath(scenes, branchPath);
  if (scenes.length === 0)
    throw new AssemblyError(AssemblyErrorCode.NO_SCENES, 'No scenes to assemble');

  const byId = new Map(scenes.map((scene) => [scene.eventId, scene]));
  const orderedScenes: SortedScene[] = [];
  const seen = new Set<string>();
  for (const entry of source.discourseSequence) {
    const eventId = entry.sceneId;
    const scene = byId.get(eventId);
    if (!scene) {
      if (branchPath && source.scenes.has(eventId)) continue;
      throw new AssemblyError(
        AssemblyErrorCode.MISSING_PROSE,
        `Scene "${eventId}" has no matching prose`,
      );
    }
    if (seen.has(eventId))
      throw new AssemblyError(AssemblyErrorCode.MISSING_PROSE, `Duplicate scene "${eventId}"`);
    seen.add(eventId);
    if (entry.chapter !== scene.chapter)
      throw new AssemblyError(
        AssemblyErrorCode.MISSING_PROSE,
        `Scene "${eventId}" has mismatched chapter`,
      );
    orderedScenes.push(scene);
  }
  for (const scene of scenes) {
    if (!seen.has(scene.eventId))
      throw new AssemblyError(
        AssemblyErrorCode.MISSING_PROSE,
        `Scene "${scene.eventId}" is not in discourse sequence`,
      );
  }
  const chapterMetadata = new Map<number, ChapterMetadata>();
  for (const [chapter, metadata] of source.chapterTitles ?? [])
    chapterMetadata.set(chapter, metadata);
  const markdown = new ProseConcatenator().concatenate(
    orderedScenes,
    chapterMetadata,
    title ?? source.projectTitle,
  );
  return {
    markdown,
    wordCount: orderedScenes.reduce(
      (total, scene) => total + countNarrativeText(scene.prose, language),
      0,
    ),
    sceneCount: orderedScenes.length,
    scenes: orderedScenes.map(({ eventId, chapter, narrativeOrder, branchExistence }) => ({
      eventId,
      chapter,
      narrativeOrder,
      branchExistence,
    })),
    sourceHash: source.snapshot.sourceHash,
  };
}
