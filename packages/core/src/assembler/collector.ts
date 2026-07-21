import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { BranchSet, SceneMetadata } from '../types/index.js';
import type { SceneEntry } from './types.js';
import { AssemblyError, AssemblyErrorCode } from './types.js';
import { FsStorage, type Storage } from '../storage/index.ts';
import { NARRATIVE_TEXT_COUNT_VERSION } from './count.ts';

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
  collectFrom(
    scenesDir: string,
    storage?: Storage,
  ): Map<string, SceneEntry> {
    const st = storage ?? new FsStorage();
    const collected = new Map<string, SceneEntry>();

    if (!st.exists(scenesDir)) {
      throw new AssemblyError(AssemblyErrorCode.NO_SCENES, `Scenes directory not found: ${scenesDir}`);
    }

    const chapterDirs = this._listChapterDirs(scenesDir, st);
    if (chapterDirs.length === 0) {
      throw new AssemblyError(AssemblyErrorCode.NO_SCENES, `No chapter directories found in ${scenesDir}`);
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

        // ── 1. Parse metadata ────────────────────────────────────
        const rawMetadata = st.read(metadataPath);
        const metadataRaw = isJson
          ? (JSON.parse(rawMetadata) as Record<string, unknown>)
          : (parseYaml(rawMetadata) as Record<string, unknown>);

        // ── 2. Validate text count version ───────────────────────
        const countVersion = (metadataRaw.text_count_version ?? metadataRaw.textCountVersion) as number | undefined;
        if (countVersion === undefined) {
          throw new AssemblyError(AssemblyErrorCode.UNKNOWN_COUNT_VERSION,
            `Scene ${eventId} is missing text count version, expected ${NARRATIVE_TEXT_COUNT_VERSION}`);
        }
        if (countVersion !== NARRATIVE_TEXT_COUNT_VERSION) {
          throw new AssemblyError(AssemblyErrorCode.UNKNOWN_COUNT_VERSION,
            `Scene ${eventId} has unknown count version ${countVersion}, expected ${NARRATIVE_TEXT_COUNT_VERSION}`);
        }

        // ── 3. Extract narrativeOrder ────────────────────────────
        const narrativeOrder = (metadataRaw.narrativeOrder ?? metadataRaw.narrative_order) as number | undefined;
        if (narrativeOrder === undefined || typeof narrativeOrder !== 'number' || !Number.isFinite(narrativeOrder)) {
          throw new AssemblyError(AssemblyErrorCode.MISSING_NARRATIVE_ORDER,
            `Scene ${eventId} is missing or has invalid narrativeOrder`);
        }

        // ── 4. Extract and validate branchExistence ──────────────
        const rawBranch = metadataRaw.branchExistence as Record<string, unknown> | undefined;
        if (!rawBranch || typeof rawBranch !== 'object' || !rawBranch.type) {
          throw new AssemblyError(AssemblyErrorCode.MISSING_BRANCH_EXISTENCE,
            `Scene ${eventId} is missing branchExistence`);
        }
        const branchType = String(rawBranch.type);
        if (!['all', 'paths', 'condition', 'except'].includes(branchType)) {
          throw new AssemblyError(AssemblyErrorCode.INVALID_BRANCH_EXISTENCE,
            `Scene ${eventId} has invalid branchExistence type "${branchType}"`);
        }
        const branchExistence = rawBranch as unknown as BranchSet;

        // ── 5. Require prose file ────────────────────────────────
        const prosePath = path.join(chapterDir, `${eventId}.md`);
        if (!st.exists(prosePath)) {
          throw new AssemblyError(AssemblyErrorCode.MISSING_PROSE,
            `Scene ${eventId} has no committed prose file at ${prosePath}`);
        }
        const prose = st.read(prosePath);
        if (prose.trim().length === 0) {
          throw new AssemblyError(AssemblyErrorCode.EMPTY_PROSE,
            `Scene ${eventId} has empty prose content`);
        }

        // ── 6. Normalise metadata to SceneMetadata type ──────────
        const sceneMetadata = this._normaliseMetadata(metadataRaw, eventId);

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
