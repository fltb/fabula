// ============================================================================
// Novalistically — Assembler Module
// Collects committed scene prose, sorts by narrativeOrder, and concatenates
// into a readable novel.md file. This is the module that produces the final
// book output.
// ============================================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { BranchPath, ChapterMetadata, SceneMetadata } from '../types/index.js';

// ────────────────────────────────────────────────────────────────────────────
// countWords — Utility
// ────────────────────────────────────────────────────────────────────────────

/**
 * Counts words in a text string, stripping common markdown formatting
 * so the count more closely reflects the actual prose word count.
 */
export function countWords(text: string): number {
  const cleaned = text
    // Remove markdown headings markers, list markers, blockquotes, separators
    .replace(/^[#*\-_~`>|]+\s*/gm, '')
    // Remove inline links: keep the displayed text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Remove image tags
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '')
    // Remove HTML tags
    .replace(/<[^>]+>/g, '')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return 0;
  return cleaned.split(/\s+/).filter(Boolean).length;
}

// ────────────────────────────────────────────────────────────────────────────
// SceneCollector
// ────────────────────────────────────────────────────────────────────────────

export interface SceneEntry {
  prose: string;
  metadata: SceneMetadata;
  narrativeOrder: number;
  chapter: number;
}

/**
 * Scans a `scenes/` directory for committed scene prose and metadata.
 *
 * Expected layout:
 *   scenes/chapter-01/
 *     E1a.md            – prose
 *     E1a.yaml          – scene metadata (event, proseSource, editHistory, …)
 *     E1a_render_request.yaml  – ignored
 *   scenes/chapter-02/
 *     …
 *
 * narrativeOrder is read from the metadata YAML if present (as an extra
 * field beyond the typed SceneMetadata), otherwise it falls back to
 * reading the corresponding event file from the parallel `chapters/`
 * directory (e.g. chapters/chapter_01/E1a.yaml → narrative_order).
 */
export class SceneCollector {
  /**
   * Collect all committed scenes from `scenesDir`.
   *
   * @param scenesDir    Path to the `scenes/` directory
   * @param chaptersDir  Optional path to the `chapters/` directory for
   *                     narrativeOrder cross-referencing
   */
  collectFrom(
    scenesDir: string,
    chaptersDir?: string,
  ): Map<string, SceneEntry> {
    const collected = new Map<string, SceneEntry>();

    if (!fs.existsSync(scenesDir)) {
      console.warn(`[Assembler] Scenes directory not found: ${scenesDir}`);
      return collected;
    }

    const chapterDirs = this._listChapterDirs(scenesDir);

    for (const chapterDir of chapterDirs) {
      const chapterName = path.basename(chapterDir);
      const chapterMatch = chapterName.match(/chapter[_-](\d+)/i);
      if (!chapterMatch) continue;
      const chapterNumber = Number.parseInt(chapterMatch[1], 10);

      // Gather scene metadata YAMLs (E*.yaml, skipping *render_request* etc.)
      const metadataFiles = this._listSceneMetadataFiles(chapterDir);

      for (const yamlPath of metadataFiles) {
        const yamlBaseName = path.basename(yamlPath);
        const eventId = yamlBaseName.replace(/\.yaml$/i, '');

        try {
          const rawYaml = fs.readFileSync(yamlPath, 'utf-8');
          const metadataRaw = parseYaml(rawYaml) as Record<string, unknown>;

          // — narrativeOrder —
          let narrativeOrder: number | undefined =
            (metadataRaw.narrativeOrder as number | undefined) ??
            (metadataRaw.narrative_order as number | undefined);

          if (narrativeOrder === undefined && chaptersDir) {
            narrativeOrder = this._extractNarrativeOrder(
              chaptersDir,
              chapterNumber,
              eventId,
            );
          }

          if (narrativeOrder === undefined) {
            console.warn(
              `[Assembler] No narrativeOrder found for ${eventId} ` +
              `(chapter ${chapterNumber}), using fallback default`,
            );
            // Fallback: chapter-relative ordering from directory listing
            narrativeOrder = chapterNumber * 100;
          }

          // — Prose (.md) —
          const prosePath = path.join(chapterDir, `${eventId}.md`);
          let prose = '';
          if (fs.existsSync(prosePath)) {
            prose = fs.readFileSync(prosePath, 'utf-8');
          } else {
            console.warn(
              `[Assembler] Prose file not found: ${prosePath}, skipping ${eventId}`,
            );
            continue;
          }

          // — Normalise metadata to SceneMetadata type —
          const sceneMetadata = this._normaliseMetadata(
            metadataRaw,
            eventId,
          );

          collected.set(eventId, {
            prose,
            metadata: sceneMetadata,
            narrativeOrder,
            chapter: chapterNumber,
          });
        } catch (err) {
          console.warn(
            `[Assembler] Error processing scene ${yamlBaseName}: ` +
            `${(err as Error).message}`,
          );
        }
      }
    }

    return collected;
  }

  // ── private helpers ────────────────────────────────────────────────────

  private _listChapterDirs(scenesDir: string): string[] {
    const entries = fs.readdirSync(scenesDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && /^chapter[_-]\d+/i.test(e.name))
      .map((e) => path.join(scenesDir, e.name))
      .sort();
  }

  /**
   * List scene-metadata YAML files inside a chapter directory.
   * Matches E<anything>.yaml but excludes *render_request* files.
   */
  private _listSceneMetadataFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries
      .filter(
        (e) =>
          e.isFile() &&
          /^E[\w-]+\.yaml$/i.test(e.name) &&
          !/render_request/i.test(e.name),
      )
      .map((e) => path.join(dir, e.name))
      .sort();
  }

  private _extractNarrativeOrder(
    chaptersDir: string,
    chapterNumber: number,
    eventId: string,
  ): number | undefined {
    // chapters dir uses underscore-separated naming
    const chapterDirName = `chapter_${String(chapterNumber).padStart(2, '0')}`;
    const eventFilePath = path.join(
      chaptersDir,
      chapterDirName,
      `${eventId}.yaml`,
    );

    if (!fs.existsSync(eventFilePath)) return undefined;

    try {
      const raw = fs.readFileSync(eventFilePath, 'utf-8');
      const parsed = parseYaml(raw) as Record<string, unknown>;
      return (parsed.narrative_order ?? parsed.narrativeOrder) as
        | number
        | undefined;
    } catch {
      return undefined;
    }
  }

  private _normaliseMetadata(
    raw: Record<string, unknown>,
    fallbackEventId: string,
  ): SceneMetadata {
    const editHistory = raw.editHistory as
      | SceneMetadata['editHistory']
      | undefined;

    return {
      event: (raw.event as string) ?? fallbackEventId,
      proseSource: (raw.proseSource as SceneMetadata['proseSource']) ?? 'llm',
      editHistory: editHistory ?? [],
      ...(raw.modelUsed != null && { modelUsed: raw.modelUsed as string }),
      ...(raw.renderedAt != null && {
        renderedAt: raw.renderedAt as string,
      }),
      ...(raw.wordCount != null && { wordCount: raw.wordCount as number }),
      ...(raw.quality != null && { quality: raw.quality as SceneMetadata['quality'] }),
    };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// NarrativeSorter
// ────────────────────────────────────────────────────────────────────────────

export interface SortedScene {
  eventId: string;
  prose: string;
  narrativeOrder: number;
  chapter: number;
}

/**
 * Sorts collected scenes by narrativeOrder ascending.
 * Grouping by chapter is preserved when two scenes share the same
 * chapter value (extracted from the directory during collection).
 */
export class NarrativeSorter {
  /**
   * Sort collected scenes by narrativeOrder ascending.
   */
  sortByOrder(collected: Map<string, SceneEntry>): SortedScene[] {
    const scenes: SortedScene[] = [];

    for (const [eventId, entry] of collected) {
      scenes.push({
        eventId,
        prose: entry.prose,
        narrativeOrder: entry.narrativeOrder,
        chapter: entry.chapter,
      });
    }

    scenes.sort((a, b) => a.narrativeOrder - b.narrativeOrder);

    return scenes;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// ProseConcatenator
// ────────────────────────────────────────────────────────────────────────────

/**
 * Produces the final novel markdown by concatenating sorted scenes with
 * chapter headings, scene separators, and optional chapter summaries.
 *
 * Output format:
 *
 *   # Novel Title
 *
 *   ## Chapter 1: Chapter Title
 *
 *   > Chapter summary (if available)
 *
 *   (scene prose)
 *
 *   ---
 *
 *   (next scene prose)
 *
 *   ## Chapter 2: Chapter Title
 *
 *   ...
 */
export class ProseConcatenator {
  /**
   * Concatenate sorted scenes into a full novel markdown document.
   *
   * @param sorted           Scenes sorted by narrativeOrder ascending
   * @param chapterMetadata  Optional map of chapter number → metadata
   * @param title            Optional novel title (default: "Untitled")
   */
  concatenate(
    sorted: SortedScene[],
    chapterMetadata?: Map<number, ChapterMetadata>,
    title?: string,
  ): string {
    if (sorted.length === 0) {
      if (title) {
        return `# ${title}\n\n_No scenes have been committed yet._\n`;
      }
      return '';
    }

    const blocks: string[] = [];

    // ── Title ────────────────────────────────────────────────────
    if (title) {
      blocks.push(`# ${title}`, '');
    }

    let currentChapter = -1;

    for (let i = 0; i < sorted.length; i++) {
      const scene = sorted[i];

      if (scene.chapter !== currentChapter) {
        // Close previous chapter if we were in one (no extra blank line
        // needed because the separator already provides spacing)
        currentChapter = scene.chapter;

        const meta = chapterMetadata?.get(currentChapter);
        let heading = `## Chapter ${currentChapter}`;
        if (meta?.title) {
          heading += `: ${meta.title}`;
        }
        blocks.push(heading, '');

        if (meta?.summary) {
          const quoted = meta.summary
            .trim()
            .split('\n')
            .map((l) => `> ${l}`)
            .join('\n');
          blocks.push(quoted, '');
        }
      }

      // Scene prose
      const prose = scene.prose.trim();
      if (prose) {
        blocks.push(prose, '');
      }

      // Separator between scenes (not after the last scene)
      if (i < sorted.length - 1) {
        blocks.push('---', '');
      }
    }

    return blocks.join('\n').trimEnd() + '\n';
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Chapter Metadata Loader
// ────────────────────────────────────────────────────────────────────────────

/**
 * Load chapter metadata from the `chapters/chapter_NN/_chapter.yaml` files.
 */
export function loadChapterMetadata(
  projectDir: string,
): Map<number, ChapterMetadata> {
  const map = new Map<number, ChapterMetadata>();
  const chaptersDir = path.join(projectDir, 'chapters');

  if (!fs.existsSync(chaptersDir)) {
    console.warn(`[Assembler] Chapters directory not found: ${chaptersDir}`);
    return map;
  }

  const dirs = fs
    .readdirSync(chaptersDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^chapter_\d+/i.test(e.name))
    .map((e) => path.join(chaptersDir, e.name))
    .sort();

  for (const dir of dirs) {
    const metaPath = path.join(dir, '_chapter.yaml');
    if (!fs.existsSync(metaPath)) continue;

    try {
      const raw = fs.readFileSync(metaPath, 'utf-8');
      const parsed = parseYaml(raw) as Record<string, unknown>;

      const metadata: ChapterMetadata = {
        chapter: parsed.chapter as number,
        title: (parsed.title as string) ?? '',
        summary: (parsed.summary as string) ?? '',
        intent: (parsed.intent as string) ?? '',
        plannedScenes:
          ((parsed.planned_scenes ?? parsed.plannedScenes) as number) ?? 0,
        ...(parsed.style_guidance
          ? { styleGuidance: parsed.style_guidance as ChapterMetadata['styleGuidance'] }
          : {}),
      };

      map.set(metadata.chapter, metadata);
    } catch (err) {
      console.warn(
        `[Assembler] Error reading chapter metadata ${metaPath}: ` +
        `${(err as Error).message}`,
      );
    }
  }

  return map;
}

// ────────────────────────────────────────────────────────────────────────────
// Branch-Path Filter
// ────────────────────────────────────────────────────────────────────────────

/**
 * Filter sorted scenes by a BranchPath.
 *
 * Scenes at or before the last decision point are always included (they
 * lie on the common trunk). Scenes after the last decision point are
 * assumed to be on the chosen branch path; true branch-scope filtering
 * requires scene-level branch annotations (not yet available), so all
 * post-decision scenes are kept.
 *
 * When `branchPath` is undefined or has no decisions the full scene list
 * is returned unchanged.
 */
export function filterScenesByBranchPath(
  scenes: SortedScene[],
  branchPath?: BranchPath,
): SortedScene[] {
  if (!branchPath || !branchPath.decisions || branchPath.decisions.length === 0) {
    return scenes;
  }

  // Without scene-level branch annotations, include everything.
  // Future enhancement: filter by branch-scene membership when available.
  return scenes;
}

// ────────────────────────────────────────────────────────────────────────────
// assembleNovel — Main Export
// ────────────────────────────────────────────────────────────────────────────

export interface AssembleOptions {
  /** Root directory of the novel project (must contain scenes/ and chapters/) */
  projectDir: string;
  /** Custom output path; defaults to <projectDir>/output/novel.md */
  outputPath?: string;
  /** Novel title (overrides the title in nova.yaml) */
  title?: string;
  /** Optional branch path for branch-filtered assembly */
  branchPath?: BranchPath;
}

export interface AssembleResult {
  /** Full novel markdown content */
  markdown: string;
  /** Word count of the assembled novel (excluding headings and separators) */
  wordCount: number;
  /** Number of scenes included */
  sceneCount: number;
}

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
