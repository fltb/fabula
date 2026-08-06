// ============================================================================
// Host ProjectPublicationService (plan Step 6.4-6.6)
// ----------------------------------------------------------------------------
// The single authority for durable publication artifacts. `publish()` enqueues
// a `publish` operation through the injected ProjectOperationService (kind
// 'publish'); its runner re-reads ALL required accepted artifacts, verifies
// them through Core `assembleRelease` (missing / blocked / old-source /
// mixed-scope manifests return `manifest_invalid`), writes the exact bytes via
// FilePublicationWriter, and only then CAS-updates the durable publication
// row (`expectedStatus` guard). Any invalid manifest or CAS conflict marks the
// operation (and, for canonical, the stored record) `stale` — the last
// current novel file is NEVER overwritten by a partial or superseded artifact.
//
// Auto-refresh (plan 6.5): `refreshCanonical()` is the best-effort hook fired
// after accepted scene commits, release-gate resolutions and review-driven
// revisions. When the full set is not ready it only demotes the canonical
// record to `stale` (no partial novel write); failures are swallowed and the
// service degrades, never rolling back an accepted revision.
//
// Reads (`get` / `list` / `read`) never leak an absolute Host path: records
// carry only `relativeOutputPath` and `read()` returns bounded markdown
// slices, so external Agents and the browser never need Host filesystem
// access. The status projection (`workflowPublicationProjection`) reflects
// the store: `current` when the canonical record's novelHash matches the
// current accepted source assembly, `stale` when a newer accepted source
// exists or the manifest is invalid, `missing` when no record exists.
// ============================================================================

import { createHash } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type BranchPath,
  type CoreExecutionRepository,
  compileProject,
  type JsonObject,
  type ProjectSourceSnapshotV1,
  type StyleGuidance,
  type WorkflowPublicationProjectionV1,
} from '@novalistically/core';
import {
  type AssembleReleaseOutcomeV1,
  type AssembleRequestV1,
  assembleRelease,
  type EditorialError,
  type EditorialRuntime,
  type SceneRevisionEnvelopeV1,
  sceneRevisionEnvelopeV1Schema,
} from '@novalistically/core/editorial';
import {
  assertSafePublicationRelativePath,
  CANONICAL_PUBLICATION_ID,
  derivePublicationRelativePath,
  FilePublicationWriter,
} from '@novalistically/node-host';
import type { BrowserPublicationStaleReasonV1 } from '../../contracts/browser-api.js';
import type {
  ProjectPublicationRecordV1,
  PublicationKindV1,
  PublicationStatusV1,
} from '../../contracts/persistence.js';
import type { ProjectPublicationStore } from '../../persistence/project-publication-store.js';
import type { McpAuthorizedCaller } from '../mcp/auth.js';
import type {
  ProjectOperationEnqueueResult,
  ProjectOperationRunner,
  ProjectOperationService,
} from '../operation-service.js';
import type { ProjectSession } from '../project-session.js';

// The Core assembly types are not all part of the public Core surface, so the
// semantic input shape is mirrored here; it is structurally identical to Core
// `AssemblySemanticInput` and flows through `assembleRelease` unchanged.

/** Wire mirror of Core `ChapterMetadata` (only `title` feeds the novel). */
interface PublicationChapterMetadata {
  readonly chapter: number;
  readonly title: string;
  readonly summary: string;
  readonly intent: string;
  readonly plannedScenes: number;
  readonly styleGuidance?: StyleGuidance;
}

interface PublicationSemanticInput {
  readonly projectId: string;
  readonly sourceHash: string;
  readonly manifest: {
    version: 1;
    status: 'current' | 'stale';
    branch_scope_hash: string;
    novel_hash: string | null;
    revision_ids: Record<string, string>;
    last_assembled_at: string | null;
    active_operation_id?: string;
    reasons: EditorialError[];
  };
  readonly revisions: ReadonlyMap<string, SceneRevisionEnvelopeV1>;
  readonly scenes: ReadonlyMap<
    string,
    { readonly prose: string; readonly chapterNumber: number; readonly metadata: JsonObject }
  >;
  readonly discourseSequence: readonly { sceneId: string; sequence: number; chapter: number }[];
  readonly chapterTitles?: ReadonlyMap<number, PublicationChapterMetadata>;
}

/** Publish request: absent branch identity publishes the canonical novel. */
export interface PublishPublicationRequestV1 {
  readonly branchPath?: BranchPath;
  readonly discourseBranch?: string;
  readonly title?: string;
}

/** Publish enqueue outcome: the operation result plus the resolved id/kind. */
export interface PublishEnqueueResultV1 {
  readonly enqueue: ProjectOperationEnqueueResult;
  readonly publicationId: string;
  readonly kind: PublicationKindV1;
}

/** Bounded markdown slice of one written publication artifact. */
export interface PublicationReadResultV1 {
  readonly publicationId: string;
  readonly offset: number;
  readonly limit: number;
  readonly content: string;
  readonly byteLength: number;
  readonly totalByteLength: number;
}

/** Projected browser-safe record fields derived from the artifact. */
export interface PublicationProjectionV1 {
  readonly status: PublicationStatusV1;
  readonly staleReasons: readonly BrowserPublicationStaleReasonV1[];
  readonly sceneCount: number;
  readonly wordCount: number;
}

/** Stored-artifact read/verify failures (typed, nonsecret). */
export class PublicationServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PublicationServiceError';
  }
}

export interface ProjectPublicationService {
  readonly projectId: string;
  /**
   * Enqueue a durable `publish` operation. Idempotency is keyed on
   * `publicationId + sourceHash` so re-publishing the same artifact replays,
   * while a new accepted source always creates fresh work.
   */
  publish(
    input: PublishPublicationRequestV1,
    caller: McpAuthorizedCaller,
  ): Promise<PublishEnqueueResultV1>;
  /** Read one durable row; null when absent. */
  get(publicationId: string): Promise<ProjectPublicationRecordV1 | null>;
  /** Page a project's publications newest-updated first. */
  list(limit?: number): Promise<readonly ProjectPublicationRecordV1[]>;
  /** Bounded markdown slice of one artifact; fails closed on missing/tampered files. */
  read(publicationId: string, offset: number, limit: number): Promise<PublicationReadResultV1>;
  /** Projected browser-safe record fields (status/staleReasons/sceneCount/wordCount). */
  projectRecord(record: ProjectPublicationRecordV1): Promise<PublicationProjectionV1>;
  /**
   * Best-effort canonical refresh (plan 6.5): publish when the full set is
   * ready, otherwise only demote the canonical record to `stale`. Never
   * throws; failures degrade the service without rolling back accepted state.
   */
  refreshCanonical(input?: {
    readonly actorId?: string;
    readonly operationId?: string;
  }): Promise<void>;
  /** Status projection for `nova_status`: current/stale/missing. */
  workflowPublicationProjection(): Promise<WorkflowPublicationProjectionV1>;
}

export interface CreateProjectPublicationServiceOptions {
  readonly projectId: string;
  /** The one project session; its runtime carries the Core execution services. */
  readonly session: ProjectSession;
  /** Project root; the writer derives only project-relative output paths from it. */
  readonly projectRoot: string;
  /** Durable per-project publication repository. */
  readonly publicationStore: ProjectPublicationStore;
  /** Durable operation queue; `publish` operations run through it. */
  readonly operations: ProjectOperationService;
  readonly now?: () => string;
}

/** Deterministic custom publication id: sha256 of the branch identity. */
export function computeCustomPublicationId(
  branchPath: BranchPath | undefined,
  discourseBranch: string | undefined,
  title: string | undefined,
): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        branchPath: branchPath ?? null,
        discourseBranch: discourseBranch ?? null,
        title: title ?? null,
      }),
      'utf8',
    )
    .digest('hex');
}

/**
 * Canonical JSON serialization (sorted keys, arrays keep order, `undefined`
 * omitted) — the same algorithm Core uses for editorial identity hashing, so
 * the custom publication id is stable across processes and Hosts.
 */
export function canonicalJson(value: unknown): string {
  if (typeof value !== 'object' || value === null) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

/** Scope identity of one assembly request, stored as the record scopeHash. */
function computePublicationScopeHash(
  branchPath: BranchPath | undefined,
  discourseBranch: string | undefined,
): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        branchPath: branchPath ?? null,
        discourseBranch: discourseBranch ?? null,
      }),
      'utf8',
    )
    .digest('hex');
}

function isCanonicalRequest(input: PublishPublicationRequestV1): boolean {
  return (
    input.branchPath === undefined &&
    input.discourseBranch === undefined &&
    input.title === undefined
  );
}

/**
 * Strict envelope parse with a lenient fallback. Some release decisions carry
 * `gateId`/`releasePolicy` (warning-driven accepts), which the strict Core
 * schema rejects even though the envelope is otherwise valid; the publish
 * path only needs the identity/decision fields, so those envelopes are
 * accepted structurally instead of being treated as unpublishable.
 */
function parseAcceptedEnvelope(value: unknown): SceneRevisionEnvelopeV1 | null {
  const parsed = sceneRevisionEnvelopeV1Schema.safeParse(value);
  if (parsed.success) return parsed.data;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const envelope = value as Record<string, unknown>;
  const decision = envelope.releaseDecision;
  const hasRequiredStrings =
    typeof envelope.revisionId === 'string' &&
    typeof envelope.proseHash === 'string' &&
    typeof envelope.sceneHash === 'string' &&
    typeof envelope.editorialBasisHash === 'string' &&
    typeof envelope.scopeHash === 'string' &&
    typeof envelope.validationIdentity === 'string' &&
    typeof envelope.createdAt === 'string';
  const hasDecision =
    typeof decision === 'object' &&
    decision !== null &&
    !Array.isArray(decision) &&
    ((decision as Record<string, unknown>).status === 'accepted' ||
      (decision as Record<string, unknown>).status === 'pending_waiver' ||
      (decision as Record<string, unknown>).status === 'blocked') &&
    typeof (decision as Record<string, unknown>).scopeHash === 'string';
  if (!hasRequiredStrings || !hasDecision || typeof envelope.released !== 'boolean') return null;
  return envelope as unknown as SceneRevisionEnvelopeV1;
}

function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.length > 0 ? code : 'INTERNAL_ERROR';
}

/**
 * Map a `manifest_invalid` assembly failure onto the browser stale-reason
 * codes (missing/blocked scenes, mixed scope, generic out-of-date).
 */
export function staleReasonsFromErrors(
  errors: readonly EditorialError[],
): readonly BrowserPublicationStaleReasonV1[] {
  const reasons = new Set<BrowserPublicationStaleReasonV1>();
  for (const error of errors) {
    if (error.code === 'SCENE_NOT_FOUND' || error.code === 'PUBLICATION_INCOMPLETE') {
      reasons.add('missing_scenes');
    } else if (error.code === 'REVISION_BLOCKED') {
      reasons.add('blocked_scenes');
    } else if (
      error.code === 'PUBLICATION_CONTENT_CONFLICT' ||
      error.code === 'REVISION_STALE' ||
      error.code === 'STORAGE_CONFLICT'
    ) {
      reasons.add('scope_mixed');
    } else {
      reasons.add('out_of_date');
    }
  }
  return [...reasons];
}

/** Per-project async mutex: canonical writes (refresh + publish) never interleave. */
class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export function createProjectPublicationService(
  options: CreateProjectPublicationServiceOptions,
): ProjectPublicationService {
  const { projectId, session, projectRoot, publicationStore, operations } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const writer = new FilePublicationWriter(projectRoot);
  const mutex = new AsyncMutex();
  const runtime = session.runtime as unknown as EditorialRuntime;

  const execution = (): CoreExecutionRepository | null =>
    session.runtime.services?.execution ?? null;

  /**
   * Materialize the full semantic input for one publish request from the
   * accepted execution repository + the immutable source snapshot: manifest
   * revision ids and scene prose/metadata come only from accepted heads
   * scoped to the CURRENT sourceHash, so old-source heads never leak into an
   * assembly. Events without an accepted head are simply absent; the
   * discourse completeness check inside `assembleRelease` then fails the
   * manifest (missing scene) instead of assembling a partial novel.
   */
  async function buildSemanticInput(
    branchPath: BranchPath | undefined,
    discourseBranch: string | undefined,
  ): Promise<PublicationSemanticInput | null> {
    const source = session.source;
    const repository = execution();
    if (source === null || repository === null) return null;
    const compilation = compileProject(source);
    const events = compilation.events;
    const chapterByEventId = new Map<string, number>();
    const chapterTitles = new Map<number, PublicationChapterMetadata>();
    for (const [chapter, entry] of compilation.data.chapters) {
      if (entry.metadata !== null && entry.metadata !== undefined) {
        chapterTitles.set(chapter, entry.metadata);
      }
      for (const eventFile of entry.events) chapterByEventId.set(eventFile.event, chapter);
    }
    const revisions = new Map<string, SceneRevisionEnvelopeV1>();
    const scenes: Map<
      string,
      { readonly prose: string; readonly chapterNumber: number; readonly metadata: JsonObject }
    > = new Map();
    const revisionIds: Record<string, string> = {};
    for (const event of events) {
      const accepted = await repository.readAcceptedScene({
        projectId,
        eventId: event.id,
      });
      if (accepted === null || accepted.value.sourceHash !== source.sourceHash) continue;
      const envelope = parseAcceptedEnvelope(accepted.value.value);
      if (envelope === null) {
        // A corrupt/foreign accepted artifact is not publishable: skip it so
        // the discourse completeness check fails the manifest (stale).
        continue;
      }
      revisions.set(event.id, envelope);
      scenes.set(event.id, {
        prose: accepted.value.prose,
        chapterNumber: chapterByEventId.get(event.id) ?? 1,
        metadata: {
          narrative_order: event.narrativeOrder,
          branch_existence: JSON.parse(JSON.stringify(event.branchExistence)) as JsonObject,
          prose_source: 'llm',
          rendered_at: envelope.createdAt,
          word_count: 0,
          edit_history: [],
          ...(envelope.modelUsed === undefined ? {} : { model_used: envelope.modelUsed }),
        },
      });
      revisionIds[event.id] = envelope.revisionId;
    }
    return {
      projectId,
      sourceHash: source.sourceHash,
      manifest: {
        version: 1,
        status: 'current',
        branch_scope_hash: computePublicationScopeHash(branchPath, discourseBranch),
        novel_hash: null,
        revision_ids: revisionIds,
        last_assembled_at: null,
        reasons: [],
      },
      revisions,
      scenes,
      discourseSequence: events.map((event, sequence) => ({
        sceneId: event.id,
        sequence,
        chapter: chapterByEventId.get(event.id) ?? 1,
      })),
      ...(chapterTitles.size === 0 ? {} : { chapterTitles }),
    };
  }

  function assembleRequest(
    input: PublishPublicationRequestV1,
    mutation: { readonly operationId: string; readonly actorId: string },
  ): AssembleRequestV1 {
    return {
      version: 1,
      mutation,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.branchPath === undefined ? {} : { branchPath: input.branchPath }),
      ...(input.discourseBranch === undefined ? {} : { discourseBranch: input.discourseBranch }),
    };
  }

  /** Run the Core assembly; null when the session has no accepted source. */
  async function assembleOutcome(
    input: PublishPublicationRequestV1,
    mutation: { readonly operationId: string; readonly actorId: string },
  ): Promise<AssembleReleaseOutcomeV1 | null> {
    const semantic = await buildSemanticInput(input.branchPath, input.discourseBranch);
    if (semantic === null) return null;
    return assembleRelease(assembleRequest(input, mutation), semantic, runtime);
  }

  async function readArtifactBytes(record: ProjectPublicationRecordV1): Promise<Buffer | null> {
    const relativePath = record.value.relativeOutputPath;
    try {
      assertSafePublicationRelativePath(relativePath);
      return await readFile(join(projectRoot, ...relativePath.split('/')));
    } catch {
      return null;
    }
  }

  /**
   * Demote the canonical record to `stale` without touching the file. The
   * stored value keeps the last good artifact identity; only the status
   * flips, and a record that is already stale is left untouched.
   */
  async function demoteCanonical(): Promise<void> {
    const record = await publicationStore.get(projectId, CANONICAL_PUBLICATION_ID);
    if (record === null || record.value.status === 'stale') return;
    await publicationStore.upsert({
      record: {
        ...record,
        value: { ...record.value, status: 'stale' },
        updatedAt: now(),
      },
      expectedStatus: 'current',
    });
  }

  /**
   * Atomic publish core (plan 6.4 order): assemble → verify → bytes/hash →
   * write file → publication CAS → success. Any invalid manifest or CAS
   * conflict returns `stale` and the previous current file is restored so
   * the on-disk artifact always matches the still-current record.
   */
  async function publishNow(
    input: PublishPublicationRequestV1,
    caller: {
      readonly actorId: string;
      readonly operationId: string;
      readonly signal?: AbortSignal;
    },
  ): Promise<
    | { readonly status: 'ready'; readonly record: ProjectPublicationRecordV1 }
    | { readonly status: 'stale' }
    | { readonly status: 'cancelled' }
    | { readonly status: 'failed'; readonly errorCode: string; readonly message: string }
  > {
    if (caller.signal?.aborted === true) return { status: 'cancelled' };
    const source = session.source;
    if (source === null) {
      return {
        status: 'failed',
        errorCode: 'NO_ACCEPTED_SOURCE',
        message: 'The session has no accepted source to publish.',
      };
    }
    const canonical = isCanonicalRequest(input);
    const publicationId = canonical
      ? CANONICAL_PUBLICATION_ID
      : computeCustomPublicationId(input.branchPath, input.discourseBranch, input.title);
    const kind: PublicationKindV1 = canonical ? 'canonical' : 'custom';

    const outcome = await assembleOutcome(input, {
      operationId: caller.operationId,
      actorId: caller.actorId,
    });
    if (outcome === null) {
      return {
        status: 'failed',
        errorCode: 'NO_ACCEPTED_SOURCE',
        message: 'The session has no accepted source to publish.',
      };
    }
    if (outcome.status === 'manifest_invalid') {
      // A scene is missing/blocked/old-source or the scope is mixed: never
      // write a partial novel; demote the canonical record (custom records
      // are untouched — their last artifact stays authoritative).
      if (canonical) await demoteCanonical();
      return { status: 'stale' };
    }

    return mutex.run(async () => {
      if (caller.signal?.aborted === true) return { status: 'cancelled' };
      const existing = await publicationStore.get(projectId, publicationId);
      const previousBytes = existing === null ? null : await readArtifactBytes(existing);
      let writeResult;
      try {
        writeResult = await writer.write({ publicationId, markdown: outcome.markdown });
      } catch (error) {
        return {
          status: 'failed',
          errorCode: 'PUBLICATION_WRITE_FAILED',
          message: `The Host could not write the publication artifact: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      const record: ProjectPublicationRecordV1 = {
        version: 1,
        projectId,
        publicationId,
        kind,
        value: {
          sourceHash: source.sourceHash,
          scopeHash: outcome.scopeHash,
          revisionIds: [...outcome.revisionIds],
          novelHash: writeResult.sha256,
          relativeOutputPath: writeResult.relativeOutputPath,
          byteLength: writeResult.byteLength,
          actorId: caller.actorId,
          operationId: caller.operationId,
          createdAt: now(),
          status: 'current',
        },
        updatedAt: now(),
      };
      const applied = await publicationStore.upsert({
        record,
        ...(existing === null ? {} : { expectedStatus: existing.value.status }),
      });
      if (!applied.applied) {
        // CAS conflict: the row moved under us. Restore the previous file
        // bytes (or remove the orphaned new file) so the on-disk artifact
        // never contradicts the still-current record.
        if (previousBytes !== null) {
          await writer
            .write({ publicationId, markdown: previousBytes.toString('utf8') })
            .catch(() => undefined);
        } else {
          await unlink(
            join(projectRoot, ...derivePublicationRelativePath(publicationId).split('/')),
          ).catch(() => undefined);
        }
        return { status: 'stale' };
      }
      return { status: 'ready', record: applied.record };
    });
  }

  /** Operation-service runner for one publish request (kind 'publish'). */
  function publishRunner(input: PublishPublicationRequestV1): ProjectOperationRunner {
    return async (context) => {
      const result = await publishNow(input, {
        actorId: context.actorId,
        operationId: context.operationId,
        signal: context.signal,
      });
      switch (result.status) {
        case 'ready':
          return { status: 'succeeded', result: result.record };
        case 'stale':
          return { status: 'stale' };
        case 'cancelled':
          return { status: 'cancelled' };
        case 'failed':
          return { status: 'failed', errorCode: result.errorCode, message: result.message };
      }
    };
  }

  /** Word count of the written artifact, projected from the file itself. */
  async function artifactWordCount(record: ProjectPublicationRecordV1): Promise<number> {
    const bytes = await readArtifactBytes(record);
    if (bytes === null) return 0;
    return bytes.toString('utf8').split(/\s+/).filter(Boolean).length;
  }

  async function canonicalAssemblyForProjection(): Promise<
    | { readonly status: 'no-source' }
    | { readonly status: 'manifest_invalid'; readonly errors: readonly EditorialError[] }
    | { readonly status: 'ready'; readonly novelHash: string }
  > {
    const outcome = await assembleOutcome(
      {},
      { operationId: 'status-projection', actorId: 'workbench' },
    );
    if (outcome === null) return { status: 'no-source' };
    if (outcome.status !== 'ready') return { status: 'manifest_invalid', errors: outcome.errors };
    return { status: 'ready', novelHash: outcome.novelHash };
  }

  /**
   * Fingerprint of the publishable accepted state: source hash + the sorted
   * accepted revision ids scoped to that source. Identical state → the same
   * idempotency key replays; changed heads (a re-render or a scene losing
   * its head) or a newer source produce fresh publish work.
   */
  async function acceptedStateFingerprint(source: ProjectSourceSnapshotV1): Promise<string> {
    const repository = execution();
    if (repository === null) return 'no-execution';
    const compilation = compileProject(source);
    const revisionIds: string[] = [];
    for (const event of compilation.events) {
      const accepted = await repository.readAcceptedScene({
        projectId,
        eventId: event.id,
      });
      if (accepted === null || accepted.value.sourceHash !== source.sourceHash) continue;
      revisionIds.push(accepted.value.revisionId);
    }
    revisionIds.sort();
    return createHash('sha256')
      .update(canonicalJson({ sourceHash: source.sourceHash, revisionIds }), 'utf8')
      .digest('hex');
  }

  return {
    projectId,
    async publish(input, caller) {
      const canonical = isCanonicalRequest(input);
      const publicationId = canonical
        ? CANONICAL_PUBLICATION_ID
        : computeCustomPublicationId(input.branchPath, input.discourseBranch, input.title);
      const kind: PublicationKindV1 = canonical ? 'canonical' : 'custom';
      const source = session.source;
      if (source === null) {
        throw new PublicationServiceError(
          'NO_ACCEPTED_SOURCE',
          'The session has no accepted source to publish.',
        );
      }
      const stateFingerprint = await acceptedStateFingerprint(source);
      const requestHash = createHash('sha256')
        .update(
          canonicalJson({
            publicationId,
            branchPath: input.branchPath ?? null,
            discourseBranch: input.discourseBranch ?? null,
            title: input.title ?? null,
            stateFingerprint,
          }),
          'utf8',
        )
        .digest('hex');
      const enqueue = await operations.enqueue({
        kind: 'publish',
        idempotencyKey: `${publicationId}:${stateFingerprint}`,
        actorId: caller.grant.userId,
        capabilityVersion: caller.grant.version,
        sourceHash: source.sourceHash,
        acceptedRevisionId: null,
        requestHash,
        runner: publishRunner(input),
      });
      return { enqueue, publicationId, kind };
    },
    get: (publicationId) => publicationStore.get(projectId, publicationId),
    async list(limit) {
      return publicationStore.list({ projectId, limit });
    },
    async read(publicationId, offset, limit) {
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new PublicationServiceError(
          'PUBLICATION_INVALID',
          'offset must be a non-negative integer.',
        );
      }
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256 * 1024) {
        throw new PublicationServiceError(
          'PUBLICATION_INVALID',
          'limit must be an integer between 1 and 262144.',
        );
      }
      const record = await publicationStore.get(projectId, publicationId);
      if (record === null) {
        throw new PublicationServiceError(
          'PUBLICATION_NOT_FOUND',
          `No publication "${publicationId}".`,
        );
      }
      const bytes = await readArtifactBytes(record);
      if (bytes === null) {
        throw new PublicationServiceError(
          'PUBLICATION_FILE_MISSING',
          `The publication artifact for "${publicationId}" is missing from the Host.`,
        );
      }
      const actualHash = createHash('sha256').update(bytes).digest('hex');
      if (actualHash !== record.value.novelHash) {
        throw new PublicationServiceError(
          'PUBLICATION_FILE_MISMATCH',
          `The publication artifact for "${publicationId}" does not match its record.`,
        );
      }
      const content = bytes.toString('utf8');
      const characters = [...content];
      const slice = characters.slice(offset, offset + limit).join('');
      return {
        publicationId,
        offset,
        limit,
        content: slice,
        byteLength: Buffer.byteLength(slice, 'utf8'),
        totalByteLength: bytes.byteLength,
      };
    },
    async projectRecord(record) {
      const sceneCount = record.value.revisionIds.length;
      const wordCount = await artifactWordCount(record);
      let status: PublicationStatusV1 = record.value.status;
      let staleReasons: readonly BrowserPublicationStaleReasonV1[] = [];
      if (record.publicationId === CANONICAL_PUBLICATION_ID) {
        const projection = await canonicalAssemblyForProjection();
        if (projection.status === 'no-source') {
          status = 'stale';
          staleReasons = ['source_changed'];
        } else if (projection.status === 'manifest_invalid') {
          status = 'stale';
          staleReasons = staleReasonsFromErrors(projection.errors);
          if (staleReasons.length === 0) staleReasons = ['source_changed'];
        } else {
          status = projection.novelHash === record.value.novelHash ? 'current' : 'stale';
          staleReasons = status === 'stale' ? ['source_changed'] : [];
        }
      } else if (record.value.status === 'stale') {
        staleReasons = ['out_of_date'];
      }
      return { status, staleReasons, sceneCount, wordCount };
    },
    async refreshCanonical(input) {
      try {
        await publishNow(
          { branchPath: undefined, discourseBranch: undefined, title: undefined },
          {
            actorId: input?.actorId ?? 'workbench',
            operationId: input?.operationId ?? 'canonical-refresh',
          },
        );
      } catch {
        // Best-effort only: a failed refresh never rolls back accepted state
        // or surfaces to the triggering operation.
      }
    },
    async workflowPublicationProjection() {
      const record = await publicationStore.get(projectId, CANONICAL_PUBLICATION_ID);
      if (record === null) {
        return { status: 'missing', publicationId: null, novelHash: null };
      }
      const assembly = await canonicalAssemblyForProjection();
      const isCurrent =
        assembly.status === 'ready' && assembly.novelHash === record.value.novelHash;
      return {
        status: isCurrent ? 'current' : 'stale',
        publicationId: record.publicationId,
        novelHash: record.value.novelHash,
      };
    },
  };
}
