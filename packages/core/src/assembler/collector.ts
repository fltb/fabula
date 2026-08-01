import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { NARRATIVE_TEXT_COUNT_VERSION } from '../assembler/count.ts';
import { sceneMetadataV1Schema } from '../schemas/editorial.ts';
import { FsStorage, type Storage } from '../storage/index.ts';
import type { SceneMetadataV1 } from '../types/editorial.ts';
import type { BranchSet } from '../types/index.js';
import type { SceneEntry } from './types.js';
import { AssemblyError, AssemblyErrorCode } from './types.js';

// ────────────────────────────────────────────────────────────────────────────
// SceneCollector
// ────────────────────────────────────────────────────────────────────────────

/**
 * Scans a `scenes/` directory for committed scene prose and metadata.
 *
 * Expected layout:
 *   scenes/chapter-01/
 *     E1a.md            – prose
 *     E1a.yaml          – scene metadata (event, proseSource, editHistory,
 *                          narrativeOrder, branchExistence, textCountVersion, …)
 *     E1a_render_request.yaml  – ignored
 *   scenes/chapter-02/
 *     …
 */
export class SceneCollector {
  /**
   * Collect all committed scenes from `scenesDir`.
   *
   * Every scene MUST have:
   *   - A YAML/JSON metadata file with narrativeOrder, branchExistence,
   *     and textCountVersion matching the current NARRATIVE_TEXT_COUNT_VERSION.
   *   - A corresponding `.md` prose file with non-empty content.
   *
   * @param scenesDir  Path to the `scenes/` directory
   * @param storage    Optional storage backend (defaults to FsStorage)
   */
  collectFrom(scenesDir: string, storage?: Storage): Map<string, SceneEntry> {
    const st = storage ?? new FsStorage();
    const collected = new Map<string, SceneEntry>();

    if (!st.exists(scenesDir)) {
      throw new AssemblyError(
        AssemblyErrorCode.NO_SCENES,
        `Scenes directory not found: ${scenesDir}`,
      );
    }

    const chapterDirs = this._listChapterDirs(scenesDir, st);
    if (chapterDirs.length === 0) {
      throw new AssemblyError(
        AssemblyErrorCode.NO_SCENES,
        `No chapter directories found in ${scenesDir}`,
      );
    }

    for (const chapterDir of chapterDirs) {
      const chapterName = path.basename(chapterDir);
      const chapterMatch = chapterName.match(/chapter[_-](\d+)/i);
      if (!chapterMatch) continue;
      const chapterNumber = Number.parseInt(chapterMatch[1], 10);

      // Gather scene metadata YAMLs (E*.yaml, skipping *render_request* etc.)
      const metadataFiles = this._listSceneMetadataFiles(chapterDir, st);

      for (const metadataPath of metadataFiles) {
        const metadataBaseName = path.basename(metadataPath);
        // Accept both .yaml and .render.json — strip the right suffix
        const isJson = metadataBaseName.endsWith('.render.json');
        const eventId = isJson
          ? metadataBaseName.replace(/\.render\.json$/i, '')
          : metadataBaseName.replace(/\.yaml$/i, '');

        // ── 1. Parse and validate strict V1 metadata ─────────────
        const rawMetadata = st.read(metadataPath);
        let metadataInput: unknown;
        try {
          metadataInput = isJson ? JSON.parse(rawMetadata) : parseYaml(rawMetadata);
        } catch (error) {
          throw new AssemblyError(
            AssemblyErrorCode.MISSING_METADATA,
            `Scene ${eventId} metadata cannot be parsed: ${(error as Error).message}`,
          );
        }
        const parsedMetadata = sceneMetadataV1Schema.safeParse(metadataInput);
        if (!parsedMetadata.success) {
          const paths = parsedMetadata.error.issues.map((issue) => issue.path[0]);
          const code = paths.includes('narrative_order')
            ? AssemblyErrorCode.MISSING_NARRATIVE_ORDER
            : paths.includes('branch_existence')
              ? AssemblyErrorCode.MISSING_BRANCH_EXISTENCE
              : paths.includes('text_count_version')
                ? AssemblyErrorCode.UNKNOWN_COUNT_VERSION
                : AssemblyErrorCode.MISSING_METADATA;
          throw new AssemblyError(
            code,
            `Scene ${eventId} has invalid V1 metadata: ${parsedMetadata.error.message}`,
          );
        }
        const metadata = parsedMetadata.data as SceneMetadataV1;
        if (metadata.event !== eventId) {
          throw new AssemblyError(
            AssemblyErrorCode.MISSING_METADATA,
            `Scene metadata event ${metadata.event} does not match file ${eventId}`,
          );
        }

        // ── 2. Validate text count version ───────────────────────
        if (metadata.text_count_version !== NARRATIVE_TEXT_COUNT_VERSION) {
          throw new AssemblyError(
            AssemblyErrorCode.UNKNOWN_COUNT_VERSION,
            `Scene ${eventId} has unknown count version ${metadata.text_count_version}, expected ${NARRATIVE_TEXT_COUNT_VERSION}`,
          );
        }

        // ── 3. Extract narrative order and branch existence ─────
        const narrativeOrder = metadata.narrative_order;
        const branchExistence = metadata.branch_existence as BranchSet;

        // ── 5. Require prose file ────────────────────────────────
        const prosePath = path.join(chapterDir, `${eventId}.md`);
        if (!st.exists(prosePath)) {
          throw new AssemblyError(
            AssemblyErrorCode.MISSING_PROSE,
            `Scene ${eventId} has no committed prose file at ${prosePath}`,
          );
        }
        const prose = st.read(prosePath);
        if (prose.trim().length === 0) {
          throw new AssemblyError(
            AssemblyErrorCode.EMPTY_PROSE,
            `Scene ${eventId} has empty prose content`,
          );
        }

        // ── 5. Preserve validated V1 metadata ────────────────────
        const sceneMetadata = metadata;

        collected.set(eventId, {
          prose,
          metadata: sceneMetadata,
          narrativeOrder,
          chapter: chapterNumber,
          branchExistence,
        });
      }
    }

    if (collected.size === 0) {
      throw new AssemblyError(AssemblyErrorCode.NO_SCENES, 'No committed scenes found');
    }

    return collected;
  }

  // ── private helpers ────────────────────────────────────────────────────

  private _listChapterDirs(scenesDir: string, st: Storage): string[] {
    const entries = st.list(scenesDir);
    return entries
      .filter((e) => e.isDirectory() && /^chapter[_-]\d+/i.test(e.name))
      .map((e) => path.join(scenesDir, e.name))
      .sort();
  }

  /**
   * List scene-metadata YAML files inside a chapter directory.
   * Matches E<anything>.yaml but excludes *render_request* files.
   */
  private _listSceneMetadataFiles(dir: string, st: Storage): string[] {
    if (!st.exists(dir)) return [];
    const entries = st.list(dir);
    return entries
      .filter(
        (e) =>
          e.isFile() &&
          (/^E[\w-]+\.yaml$/i.test(e.name) || /^E[\w-]+\.render\.json$/i.test(e.name)) &&
          !/render_request/i.test(e.name),
      )
      .map((e) => path.join(dir, e.name))
      .sort();
  }
}
