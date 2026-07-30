import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { EntityMapper } from '../entity/mapper.ts';
import { logger } from '../observability/logger.ts';
import { compileDiscourseSceneSequence } from '../state/discourse-sequence.ts';
import { FsStorage, type Storage } from '../storage/index.ts';
import { filterScenesByBranchPath } from './branch-filter.js';
import { loadChapterMetadata } from './chapter.js';
import { SceneCollector } from './collector.js';
import { ProseConcatenator } from './concatenator.js';
import { countWords } from './count.js';
import type { AssembleOptions, AssembleResult } from './types.js';
import { AssemblyError, AssemblyErrorCode } from './types.js';

// ────────────────────────────────────────────────────────────────────────────
// assembleNovel — Main Export
// ────────────────────────────────────────────────────────────────────────────

/**
 * Assemble the complete novel from committed scene files.
 *
 * Workflow:
 *   1. Resolve input/output paths
 *   2. Load chapter metadata (`chapters/chapter_NN/_chapter.yaml`)
 *   3. Collect all scene prose + metadata (`scenes/chapter-NN/E*`)
 *   4. Filter by branch path (optional)
 *   5. Compile discourse scene sequence from the project's ledger (defaults
 *      branch "main") to determine final scene order
 *   6. Concatenate into a markdown document with chapter headings
 *   7. Write to `output/novel.md` (or custom path)
 *   8. Return the markdown, word count, and scene metadata
 */
export function assembleNovel(options: AssembleOptions): AssembleResult {
  const { projectDir, outputPath, title, branchPath, discourseBranch, storage, language = 'en' } = options;
  const st = storage ?? new FsStorage();

  // ── Resolve paths ──────────────────────────────────────────────
  const scenesDir = path.join(projectDir, 'scenes');
  const resolvedOutputPath = outputPath ?? path.join(projectDir, 'output', 'novel.md');

  // ── Load chapter metadata ──────────────────────────────────────
  const chapterMetadata = loadChapterMetadata(projectDir, st);

  // ── Collect scenes (strict: fails on missing/invalid metadata) ─
  const collector = new SceneCollector();
  const collected = collector.collectFrom(scenesDir, st);

  // ── Convert collected scenes into a mutable array ───────────────
  let scenes = Array.from(collected, ([eventId, entry]) => ({
    eventId,
    prose: entry.prose,
    narrativeOrder: entry.narrativeOrder,
    chapter: entry.chapter,
    branchExistence: entry.branchExistence,
  }));

  // ── Branch-path filter ─────────────────────────────────────────
  if (branchPath) {
    const before = scenes.length;
    scenes = filterScenesByBranchPath(scenes, branchPath);
    if (scenes.length < before) {
      logger.info('Branch filter removed scenes', { module: 'assembler' });
    }
  }

  // ── Determine scene order via discourse scene sequence ─────────
  let orderedScenes: typeof scenes;
  try {
    // Load project data to get events and discourse ledger for the sequence compiler
    const mapper = new EntityMapper(projectDir, st);
    const data = mapper.loadProject();
    const eventFiles = [...data.chapters.values()].flatMap(
      (ch) => ch.events,
    );
    const events = eventFiles.map((ef) => mapper.mapToNarrativeEvent(ef));

    const branch = discourseBranch ?? 'main';
    const sequence = compileDiscourseSceneSequence({
      events,
      ledger: data.discourseLedger,
      branch,
    });

    // Index scenes by eventId
    const sceneById = new Map(scenes.map((s) => [s.eventId, s]));

    // Re-order according to the scene sequence; fail on missing entries
    orderedScenes = [];
    const seen = new Set<string>();
    for (const entry of sequence) {
      const scene = sceneById.get(entry.sceneId);
      if (!scene) {
        throw new AssemblyError(
          AssemblyErrorCode.MISSING_PROSE,
          `Scene "${entry.sceneId}" from discourse sequence has no matching collected scene`,
        );
      }
      if (seen.has(entry.sceneId)) {
        throw new AssemblyError(
          AssemblyErrorCode.MISSING_PROSE,
          `Duplicate scene "${entry.sceneId}" in discourse sequence`,
        );
      }
      seen.add(entry.sceneId);
      orderedScenes.push(scene);
    }

    // Every collected scene must be covered by the sequence
    for (const s of scenes) {
      if (!seen.has(s.eventId)) {
        throw new AssemblyError(
          AssemblyErrorCode.MISSING_PROSE,
          `Collected scene "${s.eventId}" is not covered by discourse sequence`,
        );
      }
    }
  } catch (err) {
    if (err instanceof AssemblyError) throw err;
    throw new AssemblyError(
      AssemblyErrorCode.MISSING_PROSE,
      `Cannot compile mandatory discourse scene sequence: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── Resolve title ──────────────────────────────────────────────
  const novelTitle = title ?? readProjectTitle(projectDir, st);

  // ── Concatenate ────────────────────────────────────────────────
  const concatenator = new ProseConcatenator();
  const markdown = concatenator.concatenate(orderedScenes, chapterMetadata, novelTitle);

  const outputDir = path.dirname(resolvedOutputPath);
  if (!st.exists(outputDir)) {
    st.mkdirp(outputDir);
  }
  st.write(resolvedOutputPath, markdown);

  return {
    markdown,
    wordCount: orderedScenes.reduce((total, scene) => total + countWords(scene.prose, language), 0),
    sceneCount: orderedScenes.length,
    scenes: orderedScenes.map((scene) => ({
      eventId: scene.eventId,
      chapter: scene.chapter,
      narrativeOrder: scene.narrativeOrder,
      branchExistence: scene.branchExistence,
    })),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Internal Helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Read the project title from the project config file (nova.yaml).
 */
function readProjectTitle(projectDir: string, storage?: Storage): string | undefined {
  const st = storage ?? new FsStorage();
  const configPath = path.join(projectDir, 'nova.yaml');
  if (!st.exists(configPath)) return undefined;

  try {
    const raw = st.read(configPath);
    const config = parseYaml(raw) as Record<string, unknown>;
    return (config.title as string | undefined) ?? undefined;
  } catch {
    return undefined;
  }
}
