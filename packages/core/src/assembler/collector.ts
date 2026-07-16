import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { SceneMetadata } from '../types/index.js';
import type { SceneEntry } from './types.js';

// ────────────────────────────────────────────────────────────────────────────
// SceneCollector
// ────────────────────────────────────────────────────────────────────────────

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
