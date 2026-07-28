import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { logger } from '../observability/logger.ts';
import { FsStorage, type Storage } from '../storage/index.ts';
import { filterScenesByBranchPath } from './branch-filter.js';
import { loadChapterMetadata } from './chapter.js';
import { SceneCollector } from './collector.js';
import { ProseConcatenator } from './concatenator.js';
import { countWords } from './count.js';
import { NarrativeSorter } from './sorter.js';
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
 *   4. Sort scenes by narrativeOrder ascending
 *   5. Filter by branch path (optional)
 *   6. Concatenate into a markdown document with chapter headings
 *   7. Write to `output/novel.md` (or custom path)
 *   8. Return the markdown, word count, and scene metadata
 */
export function assembleNovel(options: AssembleOptions): AssembleResult {
  const { projectDir, outputPath, title, branchPath, storage, language = 'en' } = options;
  const st = storage ?? new FsStorage();

  // ── Resolve paths ──────────────────────────────────────────────
  const scenesDir = path.join(projectDir, 'scenes');
  const resolvedOutputPath = outputPath ?? path.join(projectDir, 'output', 'novel.md');

  // ── Load chapter metadata ──────────────────────────────────────
  const chapterMetadata = loadChapterMetadata(projectDir, st);

  // ── Collect scenes (strict: fails on missing/invalid metadata) ─
  const collector = new SceneCollector();
  const collected = collector.collectFrom(scenesDir, st);

  // ── Sort ───────────────────────────────────────────────────────
  const sorter = new NarrativeSorter();
  let sorted = sorter.sortByOrder(collected);

  // ── Branch-path filter ─────────────────────────────────────────
  if (branchPath) {
    const before = sorted.length;
    sorted = filterScenesByBranchPath(sorted, branchPath);
    if (sorted.length < before) {
      logger.info('Branch filter removed scenes', { module: 'assembler', eventId: undefined });
    }
  }

  // ── Validate no duplicate narrativeOrders ──────────────────────
  const seenOrders = new Set<number>();
  for (const scene of sorted) {
    if (seenOrders.has(scene.narrativeOrder)) {
      throw new AssemblyError(
        AssemblyErrorCode.DUPLICATE_NARRATIVE_ORDER,
        `Duplicate narrativeOrder ${scene.narrativeOrder} in scene ${scene.eventId}`,
      );
    }
    seenOrders.add(scene.narrativeOrder);
  }

  // ── Resolve title ──────────────────────────────────────────────
  const novelTitle = title ?? readProjectTitle(projectDir, st);

  // ── Concatenate ────────────────────────────────────────────────
  const concatenator = new ProseConcatenator();
  const markdown = concatenator.concatenate(sorted, chapterMetadata, novelTitle);

  const outputDir = path.dirname(resolvedOutputPath);
  if (!st.exists(outputDir)) {
    st.mkdirp(outputDir);
  }
  st.write(resolvedOutputPath, markdown);

  return {
    markdown,
    wordCount: sorted.reduce((total, scene) => total + countWords(scene.prose, language), 0),
    sceneCount: sorted.length,
    scenes: sorted.map((scene) => ({
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
