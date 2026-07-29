// ============================================================================
// EditorialWorkspace — Read-only query facade for editorial data.
//
// Provides: source/revision queries, scene inspection, operation/review
// listing, publication status, legacy migration inspection.
//
// All methods are read-only — no storage writes occur through this facade.
// Every query/result survives JSON stringify/parse.
// ============================================================================

import * as path from 'node:path';
import YAML from 'yaml';
import { DEFAULT_CONFIG } from '../config/index.ts';
import { ReviewManager } from '../review/manager.ts';
import {
  editorialOperationV1Schema,
  publicationManifestV1Schema,
  sceneMetadataV1Schema,
  sceneRevisionEnvelopeV1Schema,
} from '../schemas/editorial.ts';
import { FsStorage } from '../storage/fs-storage.ts';
import { computeContentHash, computeFileHash } from '../storage/hash.ts';
import type { Storage, TransactionReadExpectation } from '../storage/types.ts';
import type {
  Clock,
  EditorialError,
  EditorialOperationV1,
  EditorialWorkspaceSnapshotV1,
  PublicationManifestV1,
  SceneInspection,
  SourceDocumentV1,
  SourceHeadV1,
  SourceRevisionV1,
} from '../types/editorial.ts';
import type { GameDialogueChoice } from '../types/game-dialogue.ts';
import type { ReviewComment } from '../types/review.ts';
import { EditorialOperationError } from './errors.ts';
import { OperationStore } from './operation-store.ts';
import { type ProjectPaths, resolveProjectPaths } from './paths.ts';
import { SceneRevisionStore } from './scene-store.ts';
import { SourceRevisionStore } from './source-store.ts';
import { SourceWorkspace } from './source-workspace.ts';
import { ProjectTransactionCoordinator } from './transaction.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────

const CHAPTER_DIR_RE = /^chapter[_-](\d+)/i;

/** Extract chapter number from a scenes/ directory name like "chapter-01". */
function chapterFromDir(dirName: string): number {
  const m = CHAPTER_DIR_RE.exec(dirName);
  return m ? parseInt(m[1], 10) : 0;
}

/** Stable JSON parse or return null for invalid content. */
function tryParseJson<T = unknown>(content: string | null): T | null {
  if (content === null) return null;
  try {
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

/** Stable YAML parse or return null for invalid content. */
function tryParseYaml<T = unknown>(content: string | null): T | null {
  if (content === null) return null;
  try {
    return YAML.parse(content) as T;
  } catch {
    return null;
  }
}

/** Look up the authored event file path for an event across chapters/. */
function findAuthoredEventPath(
  storage: Storage,
  projectDir: string,
  eventId: string,
): string | null {
  const chaptersDir = path.join(projectDir, 'chapters');
  if (!storage.exists(chaptersDir)) return null;
  const entries = storage.list(chaptersDir);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(chaptersDir, entry.name, `${eventId}.yaml`);
    if (storage.exists(candidate)) return candidate;
  }
  return null;
}

/** Read and parse the authored event definition for an eventId. */
function readAuthoredEventDefinition(
  storage: Storage,
  projectDir: string,
  eventId: string,
): { choices?: GameDialogueChoice[] } | null {
  const eventPath = findAuthoredEventPath(storage, projectDir, eventId);
  if (!eventPath) return null;
  const content = storage.readOptional(eventPath);
  if (!content) return null;
  const parsed = tryParseYaml<Record<string, unknown>>(content);
  if (!parsed) return null;
  const choices = parsed.choices;
  return {
    choices: Array.isArray(choices) ? (choices as GameDialogueChoice[]) : undefined,
  };
}

// ─── SystemClock ───────────────────────────────────────────────────────────

class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

// ─── LegacySceneInspection ─────────────────────────────────────────────────

export interface LegacySceneInspection {
  eventId: string;
  migratable: boolean;
  reason?: string;
  configuredResponse: { path: string; exists: boolean };
  historicalResponse: { path: string; exists: boolean };
  sceneMetadata: { path: string; exists: boolean };
  sceneProse: { path: string; exists: boolean };
  matchedProse: boolean;
  matchedChoices: boolean;
  hasAcceptedRelease: boolean;
}

// ─── EditorialWorkspace ────────────────────────────────────────────────────

export class EditorialWorkspace {
  readonly projectDir: string;
  readonly outputDir: string;
  readonly workDir: string;
  readonly paths: ProjectPaths;

  private readonly storage: Storage;
  private readonly coordinator: ProjectTransactionCoordinator;
  private readonly sourceW: SourceWorkspace;
  private readonly sourceRevStore: SourceRevisionStore;
  private readonly sceneRevStore: SceneRevisionStore;
  private readonly opStore: OperationStore;
  private readonly reviewMgr: ReviewManager;

  constructor(projectDir: string, outputDir?: string, storage?: Storage) {
    this.projectDir = projectDir;
    this.outputDir = outputDir ?? DEFAULT_CONFIG.outputDir;
    this.paths = resolveProjectPaths(projectDir, this.outputDir);
    this.workDir = this.paths.workDir;
    this.storage = storage ?? new FsStorage();
    this.coordinator = new ProjectTransactionCoordinator(this.storage, this.paths);
    this.sourceW = new SourceWorkspace(this.storage, this.paths);
    this.sourceRevStore = new SourceRevisionStore(this.coordinator, this.paths);
    this.sceneRevStore = new SceneRevisionStore(this.coordinator, this.paths);
    this.opStore = new OperationStore(this.coordinator, this.paths, new SystemClock());
    this.reviewMgr = new ReviewManager(this.storage, this.coordinator, this.paths.reviewLedgerPath);
  }

  // ── Source document queries ───────────────────────────────────────────────

  /** List all recognised source documents (YAML definitions). tracked=false always. */
  listSources(): SourceDocumentV1[] {
    return this.sourceW.list();
  }

  /** Get a single source document by relative project path. */
  getSource(relPath: string): SourceDocumentV1 | null {
    return this.sourceW.get(relPath);
  }

  // ── Source revision queries ───────────────────────────────────────────────

  /** List all source revisions, optionally filtered by path. */
  listSourceRevisions(pathFilter?: string): SourceRevisionV1[] {
    return this.sourceRevStore.list(pathFilter);
  }

  /** Get a specific source revision by ID. Throws EditorialOperationError if not found. */
  getSourceRevision(revisionId: string): SourceRevisionV1 {
    return this.sourceRevStore.get(revisionId);
  }

  /** Read the current source head, or null if none exists. */
  getSourceHead(): SourceHeadV1 | null {
    return this.sourceRevStore.getHead();
  }

  // ── Scene queries ─────────────────────────────────────────────────────────

  /**
   * List all recognised scenes by scanning the scenes/ directory.
   *
   * Each scene's metadata YAML and prose .md are read; the latest revision
   * envelope from the workDir responses directory is also inspected.
   *
   * Stable sort: by chapter then narrative order (from metadata).
   */
  listScenes(): SceneInspection[] {
    const all = this.collectAllSceneEventIds();
    const scenes: SceneInspection[] = [];
    for (const { eventId, chapterNum, chapterDir } of all) {
      scenes.push(this.buildSceneInspection(eventId, chapterNum, chapterDir));
    }
    return scenes;
  }

  /**
   * Inspect a single scene by eventId.
   *
   * Returns a complete SceneInspection — never throws.  Unknown scenes
   * return state='missing' with the configured response path still resolved.
   */
  inspectScene(eventId: string): SceneInspection {
    const sceneDir = this.findSceneDir(eventId);
    if (!sceneDir) {
      return this.missingSceneInspection(eventId);
    }
    const chapterNum = chapterFromDir(path.basename(sceneDir));
    return this.buildSceneInspection(eventId, chapterNum, sceneDir);
  }

  // ── Operation queries ─────────────────────────────────────────────────────

  /** List all operation records, sorted by startedAt ascending. */
  listOperations(): EditorialOperationV1[] {
    return this.opStore.list();
  }

  /** Get a single operation by ID. Throws EditorialOperationError if not found or malformed. */
  getOperation(operationId: string): EditorialOperationV1 {
    return this.opStore.get(operationId);
  }

  // ── Review queries ────────────────────────────────────────────────────────

  /** List all review comments from the review ledger. */
  listReviews(): ReviewComment[] {
    const comments = [...this.reviewMgr.readLedger().ledger.comments];
    comments.sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    );
    return comments;
  }

  /** Get a single review by ID, or null. */
  getReview(reviewId: string): ReviewComment | null {
    const snapshot = this.reviewMgr.readLedger();
    return snapshot.ledger.comments.find((c) => c.id === reviewId) ?? null;
  }

  // ── Publication queries ───────────────────────────────────────────────────

  /**
   * Read the publication manifest.
   *
   * If no manifest exists, returns a synthetic stale manifest so callers
   * always get a well-defined PublicationManifestV1 (never null).
   */
  getPublication(): PublicationManifestV1 {
    const content = this.storage.readOptional(this.paths.publicationPath);
    if (content !== null) {
      const parsed = publicationManifestV1Schema.safeParse(tryParseJson(content));
      if (parsed.success) return parsed.data as PublicationManifestV1;
    }
    const novel = this.storage.readOptional(this.paths.novelPath);
    return {
      version: 1,
      status: 'stale',
      branch_scope_hash: computeContentHash('unpublished'),
      novel_hash: novel === null ? null : computeContentHash(novel),
      revision_ids: {},
      last_assembled_at: null,
      reasons: [
        {
          code: 'PUBLICATION_INCOMPLETE',
          message:
            content === null ? 'No publication manifest found' : 'Publication manifest is invalid',
        },
      ],
    };
  }

  // ── Snapshot ──────────────────────────────────────────────────────────────

  /**
   * Build a complete workspace snapshot.
   *
   * The active operation is strict-parsed — invalid records fail closed
   * (thrown as EditorialOperationError).  All other fields degrade gracefully.
   */
  snapshot(): EditorialWorkspaceSnapshotV1 {
    const head = this.getSourceHead();
    const scenes = this.listScenes();
    const pub = this.getPublication();
    const reviews = this.listReviews();
    const activeOp = this.findActiveOperation();

    const openReviews = reviews.filter((r) => r.status === 'open');
    const addressedReviews = reviews.filter((r) => r.status === 'addressed');
    const blockingReviews = reviews.filter((r) => r.severity === 'blocking' && r.status === 'open');

    return {
      version: 1,
      projectSourceHash: head?.projectSourceHash ?? '',
      sourceTracked: head !== null,
      publication: pub,
      scenes,
      reviewSummary: {
        open: openReviews.length,
        addressed: addressedReviews.length,
        blocking: blockingReviews.length,
      },
      activeOperation: activeOp,
    };
  }

  // ── Legacy migration inspection ───────────────────────────────────────────

  /**
   * Inspect a scene for legacy migration from a pre-editorial .nova layout.
   *
   * Rules (read-only — never writes):
   *   - Configured response dir is checked first.
   *   - If custom workDir differs from .nova, a missing configured response
   *     falls back to the historical `.nova/responses/{eventId}.json`.
   *   - Only marks migratable when:
   *     1. Historical or configured response exists with accepted release.
   *     2. Raw prose from response exactly matches scene prose file content.
   *     3. Player choices from response exactly match event definition choices.
   */
  inspectLegacyScene(eventId: string): LegacySceneInspection {
    const configuredResponsePath = this.sceneRevStore.latestPath(eventId);
    const historicalResponsePath = path.join(
      this.projectDir,
      '.nova',
      'responses',
      `${eventId}.json`,
    );

    const configuredExists = this.storage.exists(configuredResponsePath);
    const historicalExists = this.storage.exists(historicalResponsePath);

    // Scene metadata and prose
    const sceneDir = this.findSceneDir(eventId);
    let metaPath = '';
    let prosePath = '';
    let metaExists = false;
    let proseExists = false;

    if (sceneDir) {
      metaPath = path.join(sceneDir, `${eventId}.yaml`);
      prosePath = path.join(sceneDir, `${eventId}.md`);
      metaExists = this.storage.exists(metaPath);
      proseExists = this.storage.exists(prosePath);
    }

    // Priority: configured response > historical .nova response
    const responsePath = configuredExists ? configuredResponsePath : historicalResponsePath;
    const responseContent = this.storage.readOptional(responsePath);
    const response = responseContent
      ? tryParseJson<Record<string, unknown>>(responseContent)
      : null;

    if (!response || !historicalExists) {
      return {
        eventId,
        migratable: false,
        reason: !historicalExists
          ? 'No historical .nova response found'
          : 'Response content is not valid JSON',
        configuredResponse: { path: configuredResponsePath, exists: configuredExists },
        historicalResponse: { path: historicalResponsePath, exists: historicalExists },
        sceneMetadata: { path: metaPath, exists: metaExists },
        sceneProse: { path: prosePath, exists: proseExists },
        matchedProse: false,
        matchedChoices: false,
        hasAcceptedRelease: false,
      };
    }

    // Check release decision
    const releaseDecision = response.releaseDecision as Record<string, unknown> | undefined;
    const hasAcceptedRelease = releaseDecision?.status === 'accepted';

    // Check prose match
    const responseProse = String(response.prose ?? '');
    const sceneProse = proseExists ? this.storage.read(prosePath) : '';
    const matchedProse = proseExists && responseProse === sceneProse;

    // Check choices match: response choices vs authored event definition choices
    let matchedChoices = false;
    if (hasAcceptedRelease) {
      const responseChoices = (response.playerChoices ?? []) as GameDialogueChoice[];
      const responseChoiceIds = responseChoices.map((c) => c.id).sort();

      const eventDef = readAuthoredEventDefinition(this.storage, this.projectDir, eventId);
      const authoredChoices = eventDef?.choices ?? [];
      const authChoiceIds = authoredChoices.map((c) => c.id).sort();

      matchedChoices =
        responseChoiceIds.length === authChoiceIds.length &&
        responseChoiceIds.every((id, i) => id === authChoiceIds[i]);
    }

    const migratable = hasAcceptedRelease && matchedProse && matchedChoices;

    return {
      eventId,
      migratable,
      reason: migratable
        ? undefined
        : !hasAcceptedRelease
          ? 'Response not accepted'
          : !matchedProse
            ? 'Response prose does not match scene prose file'
            : 'Response choices do not match event definition choices',
      configuredResponse: { path: configuredResponsePath, exists: configuredExists },
      historicalResponse: { path: historicalResponsePath, exists: historicalExists },
      sceneMetadata: { path: metaPath, exists: metaExists },
      sceneProse: { path: prosePath, exists: proseExists },
      matchedProse,
      matchedChoices,
      hasAcceptedRelease,
    };
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  /**
   * Collect all known scene event IDs by scanning the scenes/ directory.
   * Returns the eventId, chapter number, and chapter directory path.
   */
  private collectAllSceneEventIds(): Array<{
    eventId: string;
    chapterNum: number;
    chapterDir: string;
  }> {
    return this.sourceW
      .list()
      .filter((document) => document.kind === 'event')
      .map((document) => {
        const match = document.path.match(/^chapters\/chapter_(\d{2})\/(E[^/]*)\.yaml$/);
        if (!match) return null;
        const chapterNum = Number.parseInt(match[1], 10);
        return {
          eventId: match[2],
          chapterNum,
          chapterDir: path.join(
            this.paths.scenesDir,
            `chapter-${String(chapterNum).padStart(2, '0')}`,
          ),
        };
      })
      .filter(
        (
          entry,
        ): entry is {
          eventId: string;
          chapterNum: number;
          chapterDir: string;
        } => entry !== null,
      )
      .sort(
        (left, right) =>
          left.chapterNum - right.chapterNum || left.eventId.localeCompare(right.eventId),
      );
  }

  /**
   * Build a complete SceneInspection for a known event.
   *
   * Reads: scene metadata YAML, scene prose .md, latest response envelope,
   * authored event YAML, review ledger.
   */
  private buildSceneInspection(
    eventId: string,
    chapterNum: number,
    chapterDir: string,
  ): SceneInspection {
    const metadataPath = path.join(chapterDir, `${eventId}.yaml`);
    const scenePath = path.join(chapterDir, `${eventId}.md`);
    const latestResponsePath = this.sceneRevStore.latestPath(eventId);
    const metadataRaw = this.storage.readOptional(metadataPath);
    const metadataResult =
      metadataRaw === null ? null : sceneMetadataV1Schema.safeParse(tryParseYaml(metadataRaw));
    const metadata = metadataResult?.success === true ? metadataResult.data : null;
    const sceneContent = this.storage.readOptional(scenePath);
    const staleReasons: EditorialError[] = [];

    let head = null;
    if (metadata !== null) {
      try {
        const candidate = this.sceneRevStore.get(eventId, metadata.revision_id);
        const consistent =
          candidate.releaseDecision.status === 'accepted' &&
          candidate.released &&
          candidate.eventId === eventId &&
          candidate.proseHash === metadata.prose_hash &&
          candidate.sceneHash === metadata.scene_hash &&
          candidate.editorialBasisHash === metadata.editorial_basis_hash &&
          candidate.scopeHash === metadata.scope_hash &&
          candidate.validationIdentity === metadata.validation_identity;
        if (consistent) {
          head = candidate;
        } else {
          staleReasons.push({
            code: 'REVISION_STALE',
            message: 'Scene metadata does not match its immutable accepted revision',
            eventId,
          });
        }
      } catch {
        staleReasons.push({
          code: 'REVISION_NOT_FOUND',
          message: `Accepted scene revision ${metadata.revision_id} is missing or invalid`,
          eventId,
        });
      }
    } else if (metadataRaw !== null) {
      staleReasons.push({
        code: 'REVISION_STALE',
        message: 'Scene metadata is malformed',
        eventId,
      });
    }

    let latestCandidate = null;
    const latestRaw = this.storage.readOptional(latestResponsePath);
    if (latestRaw !== null) {
      const parsed = sceneRevisionEnvelopeV1Schema.safeParse(tryParseJson(latestRaw));
      if (parsed.success && parsed.data.revisionId !== head?.revisionId) {
        latestCandidate = {
          revisionId: parsed.data.revisionId,
          status: parsed.data.releaseDecision.status,
        };
      }
    }

    const materializedMatches =
      metadata !== null &&
      sceneContent !== null &&
      computeContentHash(sceneContent) === metadata.scene_hash;
    if (metadata !== null && sceneContent === null) {
      staleReasons.push({
        code: 'SCENE_CONTENT_CONFLICT',
        message: 'Materialized scene working copy is missing',
        eventId,
      });
    } else if (metadata !== null && sceneContent !== null && !materializedMatches) {
      staleReasons.push({
        code: 'SCENE_CONTENT_CONFLICT',
        message: 'Materialized scene bytes do not match accepted metadata',
        eventId,
      });
    }

    const sourceHead = this.sourceRevStore.getHead();
    if (head !== null && sourceHead?.revisionId) {
      try {
        const sourceRevision = this.sourceRevStore.get(sourceHead.revisionId);
        const sourceHeadExpectation = head.promotionReadSet.find(
          (expectation): expectation is Extract<TransactionReadExpectation, { kind: 'file' }> =>
            expectation.kind === 'file' && expectation.path === this.paths.sourceHeadPath,
        );
        const sourceChangedSinceHead = sourceHeadExpectation
          ? sourceHeadExpectation.expectedHash !==
            computeFileHash(this.storage, this.paths.sourceHeadPath)
          : sourceRevision.createdAt > head.createdAt;
        if (
          sourceChangedSinceHead &&
          sourceRevision.operationId !== head.operationId &&
          sourceRevision.affectedEventIds.includes(eventId)
        ) {
          staleReasons.push({
            code: metadata?.prose_source === 'human_locked' ? 'SCENE_LOCK_STALE' : 'SOURCE_CHANGED',
            message: 'Author source changed after this accepted scene revision',
            eventId,
          });
        }
      } catch {
        staleReasons.push({
          code: 'REVISION_STALE',
          message: 'Source head references a missing revision',
          eventId,
        });
      }
    }

    const ledger = this.reviewMgr.readLedger();
    const chapterId = `chapter:${chapterNum}`;
    const openReviewCount = ledger.ledger.comments.filter((comment) => {
      if (comment.status !== 'open') return false;
      if (comment.target.type === 'novel') return true;
      if (comment.target.type === 'chapter') return comment.target.id === chapterId;
      if (comment.target.type === 'scene' || comment.target.type === 'line') {
        return comment.target.id === eventId;
      }
      return false;
    }).length;

    let state: SceneInspection['state'];
    if (metadata === null || head === null) {
      state = sceneContent === null ? 'missing' : 'manual_change_untracked';
    } else if (!materializedMatches) {
      state = 'manual_change_untracked';
    } else if (staleReasons.length > 0) {
      state = 'stale';
    } else {
      state = 'current';
    }

    const relative = (artifactPath: string): string =>
      path.relative(this.projectDir, artifactPath).replace(/\\/g, '/');
    return {
      eventId,
      chapter: chapterNum,
      state,
      revisionId: head?.revisionId ?? null,
      proseSource: metadata?.prose_source ?? null,
      locked: metadata?.prose_source === 'human_locked',
      prose: head?.prose ?? null,
      sceneContent,
      proseHash: head?.proseHash ?? null,
      sceneHash: head?.sceneHash ?? null,
      ...(metadata?.player_choices ? { playerChoices: metadata.player_choices } : {}),
      staleReasons,
      latestCandidate,
      openReviewCount,
      artifactPaths: {
        scene: relative(scenePath),
        metadata: relative(metadataPath),
        latestResponse: relative(latestResponsePath),
        revision:
          head === null
            ? null
            : relative(this.sceneRevStore.revisionPath(eventId, head.revisionId)),
        novel: relative(this.paths.novelPath),
      },
    };
  }

  /**
   * Determine scene state from available artifacts.
   */

  /**
   * Compute stale reasons for non-current scenes.
   */

  /**
   * Find the scenes/ chapter directory containing an event's metadata file.
   */
  private findSceneDir(eventId: string): string | null {
    const authored = this.collectAllSceneEventIds().find((entry) => entry.eventId === eventId);
    return authored?.chapterDir ?? null;
  }

  /**
   * Create a SceneInspection for a scene that has no metadata file.
   */
  private missingSceneInspection(eventId: string): SceneInspection {
    const relative = (artifactPath: string): string =>
      path.relative(this.projectDir, artifactPath).replace(/\\/g, '/');
    return {
      eventId,
      chapter: 0,
      state: 'missing',
      revisionId: null,
      proseSource: null,
      locked: false,
      prose: null,
      sceneContent: null,
      proseHash: null,
      sceneHash: null,
      staleReasons: [
        {
          code: 'SCENE_NOT_FOUND',
          message: `Authored scene ${eventId} was not found`,
          eventId,
        },
      ],
      latestCandidate: null,
      openReviewCount: 0,
      artifactPaths: {
        scene: '',
        metadata: '',
        latestResponse: relative(this.sceneRevStore.latestPath(eventId)),
        revision: null,
        novel: relative(this.paths.novelPath),
      },
    };
  }

  /**
   * Find the single active (running) operation, strict-parsed.
   *
   * Invalid active operation records throw EditorialOperationError.
   * Returns null if no operation is running.
   */
  private findActiveOperation(): EditorialOperationV1 | null {
    const all = this.opStore.list();
    const running = all.find((op) => op.status === 'running');
    if (!running) return null;
    try {
      return editorialOperationV1Schema.parse(running) as EditorialOperationV1;
    } catch (err) {
      throw new EditorialOperationError(
        'INVALID_OPERATION',
        `Invalid active operation schema for ${running.operationId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { operationId: running.operationId },
      );
    }
  }
}

// ─── Factory ───────────────────────────────────────────────────────────────

/**
 * Create a read-only EditorialWorkspace for the given project.
 *
 * The workspace is a query facade only — no writes occur through this API.
 *
 * @param projectDir  Root path of the Novalistically project.
 * @param outputDir   Custom output directory name (default: .nova).
 * @param storage     Optional storage backend; defaults to FsStorage.
 */
export function getEditorialWorkspace(
  projectDir: string,
  outputDir?: string,
  storage?: Storage,
): EditorialWorkspace {
  return new EditorialWorkspace(projectDir, outputDir, storage);
}
