import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { AssembleOptions, AssembleResult } from './types.js';
import { countWords } from './count.js';
import { loadChapterMetadata } from './chapter.js';
import { SceneCollector } from './collector.js';
import { NarrativeSorter } from './sorter.js';
import { ProseConcatenator } from './concatenator.js';
import { filterScenesByBranchPath } from './branch-filter.js';

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
 *   4. Cross-reference narrativeOrder from event files as needed
 *   5. Sort scenes by narrativeOrder ascending
 *   6. Filter by branch path (optional)
 *   7. Concatenate into a markdown document with chapter headings
 *   8. Write to `output/novel.md` (or custom path)
 *   9. Return the markdown, word count, and scene count
 */
export function assembleNovel(options: AssembleOptions): AssembleResult {
  const { projectDir, outputPath, title, branchPath } = options;

  // ── Resolve paths ──────────────────────────────────────────────
  const scenesDir = path.join(projectDir, 'scenes');
  const chaptersDir = path.join(projectDir, 'chapters');
  const resolvedOutputPath =
    outputPath ?? path.join(projectDir, 'output', 'novel.md');

  // ── Load chapter metadata ──────────────────────────────────────
  const chapterMetadata = loadChapterMetadata(projectDir);

  // ── Collect scenes ─────────────────────────────────────────────
  const collector = new SceneCollector();
  const collected = collector.collectFrom(scenesDir, chaptersDir);

  if (collected.size === 0) {
    console.warn('[Assembler] No scenes collected. Output will be empty.');
  }

  // ── Sort ───────────────────────────────────────────────────────
  const sorter = new NarrativeSorter();
  let sorted = sorter.sortByOrder(collected);

  // ── Branch-path filter ─────────────────────────────────────────
  if (branchPath) {
    const before = sorted.length;
    sorted = filterScenesByBranchPath(sorted, branchPath);
    if (sorted.length < before) {
      console.log(
        `[Assembler] Branch filter removed ${before - sorted.length} scene(s)`,
      );
    }
  }

  // ── Resolve title ──────────────────────────────────────────────
  const novelTitle = title ?? readProjectTitle(projectDir);

  // ── Concatenate ────────────────────────────────────────────────
  const concatenator = new ProseConcatenator();
  const markdown = concatenator.concatenate(
    sorted,
    chapterMetadata,
    novelTitle,
  );

  // ── Write output ───────────────────────────────────────────────
  const outputDir = path.dirname(resolvedOutputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  fs.writeFileSync(resolvedOutputPath, markdown, 'utf-8');
  console.log(`[Assembler] Novel written to ${resolvedOutputPath}`);

  // ── Return result ──────────────────────────────────────────────
  return {
    markdown,
    wordCount: countWords(markdown),
    sceneCount: sorted.length,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Internal Helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Read the project title from the project config file (nova.yaml).
 */
function readProjectTitle(projectDir: string): string | undefined {
  const configPath = path.join(projectDir, 'nova.yaml');
  if (!fs.existsSync(configPath)) return undefined;

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const config = parseYaml(raw) as Record<string, unknown>;
    return (config.title as string | undefined) ?? undefined;
  } catch {
    return undefined;
  }
}
