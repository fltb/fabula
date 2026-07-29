// ============================================================================
// Release-Aware Assembly — canonical and custom novel assembly from
// publication-manifest revision IDs, immutable envelopes, and materialised
// scene hashes.  Every scene is validated against its accepted revision
// envelope before assembly.
// ============================================================================

import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { compileGameDialogueTree } from '../branch/game-dialogue-tree.ts';
import { includesPath } from '../branch/set.ts';
import { EditorialOperationError, PublicationError } from '../editorial/errors.ts';
import { OperationStore } from '../editorial/operation-store.ts';
import { type ProjectPaths, resolveProjectPaths } from '../editorial/paths.ts';
import {
  buildNovelDocument,
  EditorialPublisher,
  type PromoteCandidateInput,
  type ScopeEventData,
  type VerifiedHeadData,
} from '../editorial/publisher.ts';
import { SceneRevisionStore } from '../editorial/scene-store.ts';
import { ProjectTransactionCoordinator, stableJson } from '../editorial/transaction.ts';
import { loadProjectConfig } from '../entity/index.ts';
import { EntityMapper } from '../entity/mapper.ts';
import {
  editorialOperationV1Schema,
  publicationManifestV1Schema,
  sceneMetadataV1Schema,
} from '../schemas/editorial.ts';
import { computeContentHash } from '../storage/hash.ts';
import type { Storage, TransactionReadExpectation } from '../storage/types.ts';
import type { BranchPath, BranchSet } from '../types/branch.ts';
import type {
  AssembleRequestV1,
  EditorialAssembleResult,
  EditorialError,
  EditorialErrorCode,
  EditorialOperationV1,
  PublicationManifestV1,
  SceneEditHistoryEntryV1,
  SceneProseSource,
  SceneRevisionEnvelopeV1,
} from '../types/editorial.ts';
import type { GameDialogueChoice } from '../types/index.ts';
import { loadChapterMetadata } from './chapter.ts';

// ─── Error Helpers ──────────────────────────────────────────────────────────

function assembleError(
  code: EditorialErrorCode,
  message: string,
  meta?: Record<string, string>,
): EditorialError {
  return { code, message, ...meta };
}

// ─── Head Validation ────────────────────────────────────────────────────────

export interface VerifiedAssemblyScene {
  eventId: string;
  chapterNumber: number;
  narrativeOrder: number;
  head: VerifiedHeadData;
  prose: string;
  branchExistence: BranchSet;
  playerChoices?: readonly GameDialogueChoice[];
  proseSource: SceneProseSource;
  modelUsed?: string;
  renderedAt: string;
  wordCount: number;
  editHistory: readonly SceneEditHistoryEntryV1[];
}

/**
 * Determine whether a BranchSet includes a given branch path (all branches,
 * a specific path in the set, etc.).  Returns `true` for `type: 'all'`,
 * and for `type: 'paths'` when the branch path matches any entry.
 * Complex `condition` and `except` types default to `true` (inclusive).
 */
function isEventInBranch(branchExistence: BranchSet, branchPath: BranchPath): boolean {
  switch (branchExistence.type) {
    case 'all':
      return true;
    case 'paths':
      return branchExistence.paths.some((p) => {
        if (p.decisions.length !== branchPath.decisions.length) return false;
        return p.decisions.every((d, i) => {
          const bd = branchPath.decisions[i];
          return bd && d.atEventId === bd.atEventId && d.choiceId === bd.choiceId;
        });
      });
    case 'except':
      // except branches: the event exists on all branches except those listed
      return !isEventInBranch(branchExistence.branches, branchPath);
    case 'condition':
      // Condition-based sets: conservatively include (would need runtime evaluation)
      return true;
  }
}

function authoredRequiredEvents(
  projectDir: string,
  storage: Storage,
  branchPath?: BranchPath,
): { events: Map<string, number>; errors: EditorialError[] } {
  const mapper = new EntityMapper(projectDir, storage);
  const data = mapper.loadProject();
  const eventFiles = [...data.chapters.values()].flatMap((chapter) => chapter.events);
  const events = eventFiles.map((event) => mapper.mapToNarrativeEvent(event));
  const anchors = new Map(data.timeAnchors.map((anchor) => [anchor.id, anchor.day]));
  const tree = compileGameDialogueTree(eventFiles, anchors);
  if (tree && tree.choicesByEventId.size > 0 && !branchPath) {
    return {
      events: new Map(),
      errors: [
        {
          code: 'SCENE_NOT_IN_BRANCH',
          message: 'A complete branch path is required to assemble a game-dialogue project',
        },
      ],
    };
  }
  const required = new Map<string, number>();
  for (const event of events) {
    if (event.source !== 'event_file') continue;
    const scope = tree?.eventScopes.get(event.id) ?? event.branchExistence;
    const included = branchPath ? includesPath(scope, branchPath) : scope.type === 'all';
    if (included) required.set(event.id, event.narrativeOrder);
  }
  return { events: required, errors: [] };
}

/**
 * Validate that every event in the manifest's revision_ids has an accepted
 * revision envelope whose hashes match the materialised scene on disk.
 *
 * When a `branchPath` is supplied, only events belonging to that branch are
 * validated; off-branch events are silently skipped.  This ensures that
 * off-branch bad siblings do not block the selected branch's assembly.
 *
 * @param manifest    The current publication manifest.
 * @param sceneStore  Revision store for envelope lookup.
 * @param storage     Storage backend.
 * @param paths       Project paths.
 * @param branchPath  Optional branch filter — off-branch events are skipped.
 * @returns Validated scenes keyed by eventId, or a set of errors.
 */
export function validateManifestHeads(
  manifest: PublicationManifestV1,
  sceneStore: SceneRevisionStore,
  storage: Storage,
  paths: ProjectPaths,
  branchPath?: BranchPath | null,
  requiredEvents?: ReadonlyMap<string, number>,
): { scenes: Map<string, VerifiedAssemblyScene>; errors: EditorialError[] } {
  const scenes = new Map<string, VerifiedAssemblyScene>();
  const errors: EditorialError[] = [];

  const eventEntries = requiredEvents
    ? [...requiredEvents].map(([eventId]) => [eventId, manifest.revision_ids[eventId]] as const)
    : Object.entries(manifest.revision_ids);
  for (const [eventId, revisionId] of eventEntries) {
    if (!revisionId) {
      errors.push(
        assembleError(
          'PUBLICATION_INCOMPLETE',
          `Required event ${eventId} has no published revision`,
          { eventId },
        ),
      );
      continue;
    }
    // ── 0. Determine branch membership from scene metadata ──────
    let offBranch = false;
    const chapterDir = findChapterDir(storage, paths.scenesDir, eventId);
    if (chapterDir !== null) {
      const metadataPath = path.join(chapterDir, `${eventId}.yaml`);
      const metadataRaw = storage.readOptional(metadataPath);
      if (metadataRaw !== null && branchPath) {
        try {
          const parsed = parseYaml(metadataRaw);
          const metadata = sceneMetadataV1Schema.parse(parsed);
          const be = metadata.branch_existence as BranchSet;
          offBranch = !isEventInBranch(be, branchPath);
        } catch {
          // Cannot parse metadata — proceed with validation (will catch errors below)
        }
      }
    }

    if (offBranch) {
      // Off-branch events are silently skipped — they do not block the branch.
      continue;
    }

    // ── 1. Read the envelope ──────────────────────────────────────
    let envelope: SceneRevisionEnvelopeV1;
    try {
      envelope = sceneStore.get(eventId, revisionId);
    } catch {
      errors.push(
        assembleError(
          'REVISION_NOT_FOUND',
          `Revision ${revisionId} for event ${eventId} not found`,
          { eventId },
        ),
      );
      continue;
    }

    // ── 2. Must be accepted ───────────────────────────────────────
    if (envelope.releaseDecision.status !== 'accepted' || !envelope.released) {
      errors.push(
        assembleError(
          'REVISION_BLOCKED',
          `Revision ${revisionId} for event ${eventId} is not accepted (${envelope.releaseDecision.status})`,
          { eventId },
        ),
      );
      continue;
    }

    // ── 3. Read materialised scene file ───────────────────────────
    if (chapterDir === null) {
      errors.push(
        assembleError('SCENE_NOT_FOUND', `Scene directory for event ${eventId} not found`, {
          eventId,
        }),
      );
      continue;
    }

    const scenePath = path.join(chapterDir, `${eventId}.md`);
    const sceneContent = storage.readOptional(scenePath);
    if (sceneContent === null) {
      errors.push(
        assembleError(
          'SCENE_NOT_FOUND',
          `Scene file for event ${eventId} not found at ${scenePath}`,
          { eventId },
        ),
      );
      continue;
    }

    const actualSceneHash = computeContentHash(sceneContent);
    if (actualSceneHash !== envelope.sceneHash) {
      errors.push(
        assembleError(
          'PUBLICATION_CONTENT_CONFLICT',
          `Scene hash mismatch for event ${eventId}: expected ${envelope.sceneHash}, got ${actualSceneHash}`,
          { eventId },
        ),
      );
      continue;
    }

    // ── 4. Read metadata for prose source and chapter info ──────
    const metadataPath = path.join(chapterDir, `${eventId}.yaml`);
    const metadataRaw = storage.readOptional(metadataPath);
    let chapterNumber = 1;
    let branchExistence: BranchSet = { type: 'all' };
    let playerChoices: readonly GameDialogueChoice[] | undefined;
    let proseSource: SceneProseSource = 'llm';
    let modelUsed: string | undefined;
    let renderedAt = envelope.createdAt;
    let wordCount = 0;
    let editHistory: readonly SceneEditHistoryEntryV1[] = [];

    if (metadataRaw === null) {
      errors.push(
        assembleError('PUBLICATION_INCOMPLETE', `Scene metadata for event ${eventId} is missing`, {
          eventId,
          path: metadataPath,
        }),
      );
      continue;
    }
    try {
      const parsed = parseYaml(metadataRaw);
      const metadata = sceneMetadataV1Schema.parse(parsed);
      if (
        metadata.event !== eventId ||
        metadata.revision_id !== envelope.revisionId ||
        metadata.prose_hash !== envelope.proseHash ||
        metadata.scene_hash !== envelope.sceneHash ||
        metadata.editorial_basis_hash !== envelope.editorialBasisHash ||
        metadata.scope_hash !== envelope.scopeHash ||
        metadata.validation_identity !== envelope.validationIdentity
      ) {
        errors.push(
          assembleError(
            'REVISION_STALE',
            `Scene metadata for event ${eventId} does not match its immutable revision`,
            { eventId, path: metadataPath },
          ),
        );
        continue;
      }
      chapterNumber = extractChapterNumber(chapterDir);
      branchExistence = metadata.branch_existence as BranchSet;
      playerChoices = metadata.player_choices;
      proseSource = metadata.prose_source;
      modelUsed = metadata.model_used;
      renderedAt = metadata.rendered_at;
      wordCount = metadata.word_count;
      editHistory = metadata.edit_history;
    } catch {
      errors.push(
        assembleError('REVISION_STALE', `Scene metadata for event ${eventId} is malformed`, {
          eventId,
          path: metadataPath,
        }),
      );
      continue;
    }

    // ── 5. Build verified head data ───────────────────────────────
    const head: VerifiedHeadData = {
      revisionId: envelope.revisionId,
      proseHash: envelope.proseHash,
      prose: envelope.prose,
      sceneHash: envelope.sceneHash,
      editorialBasisHash: envelope.editorialBasisHash,
      scopeHash: envelope.scopeHash,
      validationIdentity: envelope.validationIdentity,
      proseSource,
      modelUsed,
      renderedAt,
      wordCount,
      editHistory,
      playerChoices,
      branchExistence,
    };

    scenes.set(eventId, {
      eventId,
      chapterNumber,
      narrativeOrder: requiredEvents?.get(eventId) ?? 0,
      head,
      prose: sceneContent,
      branchExistence,
      playerChoices,
      proseSource,
      modelUsed,
      renderedAt,
      wordCount,
      editHistory,
    });
  }

  return { scenes, errors };
}

/**
 * Find the chapter directory for a given event ID by scanning scenes/.
 */
function findChapterDir(storage: Storage, scenesDir: string, eventId: string): string | null {
  if (!storage.exists(scenesDir)) return null;
  for (const entry of storage.list(scenesDir)) {
    if (!entry.isDirectory()) continue;
    const candidatePath = path.join(scenesDir, entry.name);
    const scenePath = path.join(candidatePath, `${eventId}.md`);
    if (storage.exists(scenePath)) return candidatePath;
  }
  return null;
}

function extractChapterNumber(chapterDir: string): number {
  const match = path.basename(chapterDir).match(/chapter-(\d+)/i);
  return match ? parseInt(match[1], 10) : 1;
}

// ─── Scope Event Data Builder ───────────────────────────────────────────────

function buildScopeEventData(eventId: string, narrativeOrder: number): ScopeEventData {
  return {
    eventId,
    narrativeOrder,
    threadProgress: [],
    foreshadowing: [],
    relationshipEffects: [],
    ruleEffects: [],
  };
}

// ─── Release Assembly ───────────────────────────────────────────────────────

/**
 * Canonical novel assembly from the publication manifest's revision IDs.
 *
 * 1. Validates every required head exists, is accepted, and matches its
 *    materialised scene hash.
 * 2. Reads the current publication manifest.
 * 3. Builds the novel document from validated scenes.
 * 4. Compares the canonical novel file's current bytes against the manifest.
 * 5. Commits the new novel (and updated manifest) via
 *    EditorialPublisher (which uses ProjectTransactionCoordinator).
 *
 * Missing, unreleased, hash-mismatched, or untracked heads cause the entire
 * assembly to fail closed.  Off-branch bad siblings do not block the
 * selected branch.
 */
export function canonicalAssemble(
  request: AssembleRequestV1,
  storage: Storage,
  runtime?: { clock?: { now(): number } },
): EditorialAssembleResult {
  const config = loadProjectConfig(path.join(request.projectDir, 'nova.yaml'), storage);
  const paths = resolveProjectPaths(request.projectDir, config?.outputDir);
  const coordinator = new ProjectTransactionCoordinator(storage, paths);
  const sceneStore = new SceneRevisionStore(coordinator, paths);
  const workerId = request.mutation.actorId;
  const operationStore = new OperationStore(
    coordinator,
    paths,
    runtime?.clock ?? { now: () => Date.now() },
  );

  const operationId = request.mutation.operationId;
  const requestHash = computeContentHash(
    stableJson({
      kind: 'canonicalAssemble',
      projectDir: request.projectDir,
      branchPath: request.branchPath,
    }),
  );

  // ── 0. Register operation ──────────────────────────────────────
  const operation = operationStore.register({
    operationId,
    kind: 'assemble',
    actorId: request.mutation.actorId,
    requestHash,
  });
  if (operation.status === 'succeeded' && operation.result !== null) {
    return operation.result as EditorialAssembleResult;
  }

  // ── 1. Load publication manifest ───────────────────────────────
  const manifestRaw = storage.readOptional(paths.publicationPath);
  const manifest: PublicationManifestV1 =
    manifestRaw !== null
      ? (publicationManifestV1Schema.parse(JSON.parse(manifestRaw)) as PublicationManifestV1)
      : {
          version: 1,
          status: 'stale',
          branch_scope_hash: '',
          novel_hash: null,
          revision_ids: {},
          last_assembled_at: null,
          reasons: [],
        };

  // ── 2. Validate heads from manifest ────────────────────────────
  const required = authoredRequiredEvents(request.projectDir, storage, request.branchPath);
  const { scenes: validatedScenes, errors: validationErrors } = validateManifestHeads(
    manifest,
    sceneStore,
    storage,
    paths,
    request.branchPath,
    required.events,
  );
  const headErrors = [...required.errors, ...validationErrors];
  if (headErrors.length > 0) {
    operationStore.fail(operationId, workerId, headErrors);
    throw new PublicationError('Canonical assembly inputs are incomplete', headErrors);
  }

  // ── 3. Scope events: all events in manifest ────────────────────
  const scopeEvents = buildScopeEvents(manifest, validatedScenes);
  const scopeEventIds = scopeEvents.map((e) => e.eventId);

  if (scopeEventIds.length === 0) {
    const errors: EditorialError[] = [
      {
        code: 'PUBLICATION_INCOMPLETE',
        message: 'No scenes to assemble — publication manifest has no tracked revision IDs',
      },
    ];
    operationStore.fail(operationId, workerId, errors);
    throw new PublicationError('Canonical assembly inputs are incomplete', errors);
  }

  // ── 4. Build publication read set ──────────────────────────────
  const publicationReadSet = captureAssemblyReadSet(storage, paths, validatedScenes);

  // ── 5. Build candidates ────────────────────────────────────────
  const candidates = buildAssemblyCandidates(manifest, validatedScenes);

  // ── 6. Load chapter metadata ───────────────────────────────────
  const chapterMetas = loadChapterMetadata(request.projectDir, storage);
  const chapterTitleMap = new Map<number, { title: string }>();
  for (const [ch, meta] of chapterMetas) {
    chapterTitleMap.set(ch, { title: meta.title || `Chapter ${ch}` });
  }

  // ── 7. Build novel document ────────────────────────────────────
  const novelContent = buildNovelDocument(candidates, chapterTitleMap, request.title ?? 'Untitled');
  const novelHash = computeContentHash(novelContent);

  // ── 8. Check for direct edit on canonical novel ────────────────
  const currentNovelRaw = storage.readOptional(paths.novelPath);
  const currentNovelHash = currentNovelRaw === null ? null : computeContentHash(currentNovelRaw);
  if (currentNovelHash !== manifest.novel_hash) {
    const errors: EditorialError[] = [
      {
        code: 'PUBLICATION_CONTENT_CONFLICT',
        message: 'Canonical novel bytes do not match the publication manifest',
        path: paths.novelPath,
        operationId,
      },
    ];
    if (currentNovelRaw !== null) {
      const conflictPath = path.join(paths.conflictsDir, `novel-${operationId}.md`);
      coordinator.commit({
        transactionId: `${operationId}-novel-conflict`,
        readSet: [
          {
            kind: 'file',
            path: paths.novelPath,
            expectedHash: currentNovelHash,
          },
          { kind: 'file', path: conflictPath, expectedHash: null },
        ],
        writes: [
          {
            type: 'put',
            path: conflictPath,
            content: currentNovelRaw,
            expectedHash: null,
          },
        ],
      });
    }
    operationStore.fail(operationId, workerId, errors);
    throw new PublicationError('Canonical novel has untracked edits', errors);
  }

  // ── 9. Publish via EditorialPublisher ──────────────────────────
  const previousManifestHash = manifestRaw !== null ? computeContentHash(manifestRaw) : null;
  const publisher = new EditorialPublisher(coordinator, paths);
  const publication = publisher.publish({
    scope: {
      projectDir: request.projectDir,
      branchScopeHash: manifest.branch_scope_hash,
      scopeEventIds,
      scopeEvents,
      mutationContext: request.mutation,
    },
    candidates,
    previousManifest: manifest,
    previousManifestHash,
    novelContent,
    novelHash,
    reasons: [],
    readSet: publicationReadSet,
  });

  // ── 10. Finalize operation ─────────────────────────────────────
  const result: EditorialAssembleResult = {
    operationId,
    markdown: novelContent,
    wordCount: countNovelWords(novelContent),
    sceneCount: candidates.length,
    publication,
  };
  operationStore.succeed(operationId, workerId, result);
  return result;
}

// ─── Custom Assembly ─────────────────────────────────────────────────────────

/**
 * Custom (non-canonical) novel assembly.  Validates the same publication
 * manifest heads but writes only to the custom output path, never touching
 * the canonical novel, manifest, or derived data.
 *
 * A terminal `assemble` operation is recorded so the custom output is
 * traceable.  Custom output/title never mutate canonical files.
 */
export function customAssemble(
  request: AssembleRequestV1,
  storage: Storage,
  runtime?: { clock?: { now(): number } },
): EditorialAssembleResult {
  const config = loadProjectConfig(path.join(request.projectDir, 'nova.yaml'), storage);
  const paths = resolveProjectPaths(request.projectDir, config?.outputDir);
  const coordinator = new ProjectTransactionCoordinator(storage, paths);
  const sceneStore = new SceneRevisionStore(coordinator, paths);
  const operationId = request.mutation.operationId;
  const requestHash = computeContentHash(
    stableJson({
      kind: 'customAssemble',
      projectDir: request.projectDir,
      branchPath: request.branchPath,
      outputPath: request.outputPath,
      title: request.title,
    }),
  );
  const operationPath = path.join(paths.operationsDir, `${operationId}.json`);
  const existingRaw = storage.readOptional(operationPath);
  if (existingRaw !== null) {
    const existing = editorialOperationV1Schema.parse(
      JSON.parse(existingRaw),
    ) as EditorialOperationV1;
    if (
      existing.requestHash === requestHash &&
      existing.status === 'succeeded' &&
      existing.result !== null
    ) {
      return existing.result as EditorialAssembleResult;
    }
    throw new EditorialOperationError(
      'INVALID_OPERATION',
      `Operation ${operationId} already exists with a different request`,
      { operationId },
    );
  }

  const manifestRaw = storage.readOptional(paths.publicationPath);
  const manifest =
    manifestRaw === null
      ? {
          version: 1 as const,
          status: 'stale' as const,
          branch_scope_hash: '',
          novel_hash: null,
          revision_ids: {},
          last_assembled_at: null,
          reasons: [],
        }
      : (publicationManifestV1Schema.parse(JSON.parse(manifestRaw)) as PublicationManifestV1);
  const required = authoredRequiredEvents(request.projectDir, storage, request.branchPath);
  const { scenes: validatedScenes, errors: validationErrors } = validateManifestHeads(
    manifest,
    sceneStore,
    storage,
    paths,
    request.branchPath,
    required.events,
  );
  const errors = [...required.errors, ...validationErrors];
  if (required.events.size === 0 && errors.length === 0) {
    errors.push({
      code: 'PUBLICATION_INCOMPLETE',
      message: 'No branch-required scenes are available for assembly',
    });
  }
  if (errors.length > 0) {
    const now = new Date(runtime?.clock?.now() ?? Date.now()).toISOString();
    const failed: EditorialOperationV1 = {
      version: 1,
      operationId,
      kind: 'assemble',
      actorId: request.mutation.actorId,
      requestHash,
      status: 'failed',
      startedAt: now,
      heartbeatAt: now,
      leaseExpiresAt: now,
      completedAt: now,
      result: null,
      errors,
    };
    coordinator.commit({
      transactionId: operationId,
      readSet: [{ kind: 'file', path: operationPath, expectedHash: null }],
      writes: [
        {
          type: 'put',
          path: operationPath,
          content: stableJson(failed),
          expectedHash: null,
        },
      ],
    });
    throw new PublicationError('Custom assembly inputs are incomplete', errors);
  }

  const candidates = buildAssemblyCandidates(manifest, validatedScenes);
  const chapterTitleMap = new Map<number, { title: string }>();
  for (const [chapter, metadata] of loadChapterMetadata(request.projectDir, storage)) {
    chapterTitleMap.set(chapter, {
      title: metadata.title || `Chapter ${chapter}`,
    });
  }
  const novelContent = buildNovelDocument(candidates, chapterTitleMap, request.title ?? 'Untitled');
  const resolvedOutputPath = request.outputPath ?? path.join(paths.outputDir, 'custom-novel.md');
  if (
    resolvedOutputPath === paths.novelPath ||
    resolvedOutputPath === paths.publicationPath ||
    resolvedOutputPath.startsWith(`${paths.workDir}${path.sep}`)
  ) {
    throw new EditorialOperationError(
      'INVALID_OPERATION',
      'Custom output path must not target canonical editorial artifacts',
      { path: resolvedOutputPath, operationId },
    );
  }
  const result: EditorialAssembleResult = {
    operationId,
    markdown: novelContent,
    wordCount: countNovelWords(novelContent),
    sceneCount: candidates.length,
    publication: {
      status: 'unchanged',
      outputPath: resolvedOutputPath,
      novelHash: computeContentHash(novelContent),
      reasons: [],
    },
  };
  const now = new Date(runtime?.clock?.now() ?? Date.now()).toISOString();
  const operation: EditorialOperationV1 = {
    version: 1,
    operationId,
    kind: 'assemble',
    actorId: request.mutation.actorId,
    requestHash,
    status: 'succeeded',
    startedAt: now,
    heartbeatAt: now,
    leaseExpiresAt: now,
    completedAt: now,
    result,
    errors: [],
  };
  coordinator.commit({
    transactionId: operationId,
    readSet: [
      ...captureAssemblyReadSet(storage, paths, validatedScenes),
      {
        kind: 'file',
        path: resolvedOutputPath,
        expectedHash:
          storage.readOptional(resolvedOutputPath) === null
            ? null
            : computeContentHash(storage.read(resolvedOutputPath)),
      },
      { kind: 'file', path: operationPath, expectedHash: null },
    ],
    writes: [
      {
        type: 'put',
        path: resolvedOutputPath,
        content: novelContent,
        expectedHash:
          storage.readOptional(resolvedOutputPath) === null
            ? null
            : computeContentHash(storage.read(resolvedOutputPath)),
      },
      {
        type: 'put',
        path: operationPath,
        content: stableJson(operation),
        expectedHash: null,
      },
    ],
  });
  return result;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildScopeEvents(
  manifest: PublicationManifestV1,
  scenes: Map<string, VerifiedAssemblyScene>,
): ScopeEventData[] {
  const result: ScopeEventData[] = [];
  for (const [eventId] of Object.entries(manifest.revision_ids)) {
    const vs = scenes.get(eventId);
    if (!vs) continue;
    result.push(buildScopeEventData(vs.eventId, vs.narrativeOrder));
  }
  return result;
}

function buildAssemblyCandidates(
  _manifest: PublicationManifestV1,
  scenes: ReadonlyMap<string, VerifiedAssemblyScene>,
): PromoteCandidateInput[] {
  return [...scenes.values()]
    .sort(
      (left, right) =>
        left.narrativeOrder - right.narrativeOrder || left.eventId.localeCompare(right.eventId),
    )
    .map((scene) => ({
      promote: false,
      eventId: scene.eventId,
      chapterNumber: scene.chapterNumber,
      head: scene.head,
      event: buildScopeEventData(scene.eventId, scene.narrativeOrder),
      scene: { prose: scene.prose },
    }));
}

function captureAssemblyReadSet(
  storage: Storage,
  paths: ProjectPaths,
  scenes: ReadonlyMap<string, VerifiedAssemblyScene> = new Map(),
): TransactionReadExpectation[] {
  const expectations: TransactionReadExpectation[] = [];
  const add = (filePath: string): void => {
    const content = storage.readOptional(filePath);
    expectations.push({
      kind: 'file',
      path: filePath,
      expectedHash: content !== null ? computeContentHash(content) : null,
    });
  };
  add(paths.publicationPath);
  add(paths.novelPath);
  add(paths.sourceHeadPath);
  for (const name of ['threads.yaml', 'foreshadowing.yaml', 'relationships.yaml', 'rules.yaml']) {
    add(path.join(paths.derivedDir, name));
  }
  for (const scene of scenes.values()) {
    const chapterDir = path.join(
      paths.scenesDir,
      `chapter-${String(scene.chapterNumber).padStart(2, '0')}`,
    );
    add(path.join(chapterDir, `${scene.eventId}.md`));
    add(path.join(chapterDir, `${scene.eventId}.yaml`));
    add(path.join(paths.sceneRevisionsDir, scene.eventId, `${scene.head.revisionId}.json`));
  }
  return expectations;
}

function countNovelWords(markdown: string): number {
  // Strip markdown headings, separators, and count remaining words
  const text = markdown
    .replace(/^#+\s+.*$/gm, '')
    .replace(/^---+$/gm, '')
    .replace(/^>.*$/gm, '')
    .trim();
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
}
