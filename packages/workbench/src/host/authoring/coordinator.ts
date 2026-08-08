/**
 * Per-project native authoring coordinator.
 *
 * Working documents are materialized into a complete candidate, validated, and
 * accepted through the immutable native revision CAS. The source view is then
 * updated through its own tree/revision CAS before the accepted snapshot is
 * adopted by ProjectSession. Filesystem observation only creates candidates;
 * it never accepts source.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  type PluginExtensionSchemaRegistrar,
  type ProjectSourceSnapshotV1,
  validateNovel,
} from '@novalistically/core';
import { compareLogicalPaths } from '@novalistically/core/source';
import {
  AUTHORING_CONTRACT_VERSION,
  AUTHORING_PHASE_VALUES,
  type AuthoringConflictV1,
  type AuthoringDiagnosticV1,
  type AuthoringExternalCandidateV1,
  type AuthoringOperationKindV1,
  type AuthoringOperationReceiptV1,
  type AuthoringOperationStatusV1,
  type AuthoringPhaseV1,
  type AuthoringStateV1,
  type AuthoringSubmitBlockReasonV1,
  type WorkingValidationResultV1,
} from '../../contracts/authoring.js';
import type {
  AuthoringStateRecord,
  ProjectOperationKindV1,
  ProjectOperationRecordV1,
  ProjectOperationStatusV1,
} from '../../contracts/persistence.js';
import type { ProjectOperationStore } from '../../persistence/project-operation-store.js';
import type { SourceRefreshResult } from '../project-session.js';
import type { AuthoringWorkingDocumentStore } from './document-store.js';
import type { AuthoringCandidateStore } from './filesystem-observer.js';
import type {
  AuthoringCoordinator,
  AuthoringCoordinatorOptions,
  AuthoringReconcileInput,
  AuthoringRevisionContentStore,
  AuthoringSubmitInput,
} from './types.js';

const KIND_SUBMIT: AuthoringOperationKindV1 = 'submit';
const KIND_RECONCILE: AuthoringOperationKindV1 = 'reconcile-external';
const KIND_RESOLVE_CONFLICT: AuthoringOperationKindV1 = 'resolve-conflict';
/** Durable queue kind for every coordinator mutation (submit/reconcile/resolve). */
const RECORD_KIND_AUTHORING: ProjectOperationKindV1 = 'authoring-submit';
const EMPTY_DIAGNOSTICS: readonly AuthoringDiagnosticV1[] = [];

type NativeStateRecord = AuthoringStateRecord & {
  readonly acceptedRevisionId?: string;
};

type SubmissionRunResult =
  | {
      readonly status: 'accepted';
      readonly operationId: string;
      readonly revisionId: string;
      readonly sourceHash: string;
      readonly receiptHash: string;
      readonly treeHash: string;
    }
  | { readonly status: 'stale'; readonly reason: string }
  | { readonly status: 'conflict'; readonly reason: string }
  | { readonly status: 'invalid'; readonly code: string }
  | { readonly status: 'recovery'; readonly message: string }
  | { readonly status: 'adopt-failed'; readonly message: string };

/** Typed failure for a working-layer validation that cannot proceed. */
export class WorkingValidationFailure extends Error {
  override readonly name = 'WorkingValidationFailure';
  readonly code: 'ACCEPTED_HASH_MISMATCH' | 'WORKSPACE_STALE' | 'INTERNAL';
  constructor(code: WorkingValidationFailure['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export interface AuthoringCoordinatorAssembly extends AuthoringCoordinatorOptions {
  readonly documents: AuthoringWorkingDocumentStore;
  readonly staging: AuthoringCandidateStore;
  readonly revisionContentStore: AuthoringRevisionContentStore;
  readonly persistence: AuthoringCoordinatorPersistence;
  readonly operationStore: ProjectOperationStore;
  readonly buildSnapshot: (input: {
    readonly projectId: string;
    readonly entries: readonly { readonly logicalPath: string; readonly content: string }[];
  }) => ProjectSourceSnapshotV1;
  readonly validate: (candidate: ProjectSourceSnapshotV1) => readonly AuthoringDiagnosticV1[];
  /**
   * Enabled-plugin extension gate (plan 7.5). When present, working-layer
   * validation reports unknown/disabled EventFile `extensions` namespaces as
   * error-severity source diagnostics; absent → legacy behavior.
   */
  readonly extensionRegistrar?: PluginExtensionSchemaRegistrar;
  readonly adopt: (input: {
    readonly projectId: string;
    readonly candidate: ProjectSourceSnapshotV1;
  }) => Promise<SourceRefreshResult>;
  readonly initialAccepted?: ProjectSourceSnapshotV1 | null;
  readonly initialAcceptedRevisionId?: string | null;
  readonly acceptCapability?: { readonly capabilityId: string; readonly scopes: readonly string[] };
  readonly newId?: () => string;
  readonly notifyDebounceMs?: number;
}

export interface AuthoringCoordinatorPersistence {
  load(input: { readonly projectId: string }): Promise<AuthoringStateRecord | null>;
  save(record: AuthoringStateRecord): Promise<void>;
}

function hasErrorSeverity(diagnostics: readonly AuthoringDiagnosticV1[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === 'error');
}
function hashEntry(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
function hashBundle(
  entries: readonly { readonly logicalPath: string; readonly content: string }[],
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        entries: [...entries]
          .sort((left, right) => compareLogicalPaths(left.logicalPath, right.logicalPath))
          .map((entry) => ({ logicalPath: entry.logicalPath, content: entry.content })),
      }),
      'utf8',
    )
    .digest('hex');
}

/** Map an authoring receipt status onto the durable queue status vocabulary. */
function _recordStatusFor(status: AuthoringOperationStatusV1): ProjectOperationStatusV1 {
  switch (status) {
    case 'queued':
      return 'queued';
    case 'running':
      return 'running';
    case 'completed':
      return 'succeeded';
    case 'conflict':
      // The durable queue has no dedicated conflict status; a conflict is
      // represented as `stale` with the CONFLICT_REQUIRES_RESOLUTION error
      // code so the receipt derivation can restore the client-facing
      // `conflict` status unchanged.
      return 'stale';
    case 'stale':
      return 'stale';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'interrupted':
      return 'interrupted';
  }
}

/** Map a durable record status back onto the client-facing receipt status. */
function receiptStatusFor(
  status: ProjectOperationStatusV1,
  errorCode: string | null,
): AuthoringOperationStatusV1 {
  switch (status) {
    case 'queued':
      return 'queued';
    case 'running':
      return 'running';
    case 'succeeded':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'interrupted':
      return 'interrupted';
    case 'stale':
      return errorCode === 'CONFLICT_REQUIRES_RESOLUTION' ? 'conflict' : 'stale';
  }
}

/** Map a durable queue kind onto the client-facing receipt kind. */
function receiptKindFor(kind: ProjectOperationKindV1): AuthoringOperationKindV1 {
  return kind === RECORD_KIND_AUTHORING ? 'submit' : kind;
}

/**
 * Derive the client-facing receipt from one durable record. The record is the
 * single source of truth: the receipt never carries identity fields
 * (actor/capability version/idempotency key) and never contradicts the stored
 * status. `acceptedSourceHash` is the immutable base source the operation was
 * CAS-bound to at creation (the post-submit hash travels via the separate
 * `submit-receipt` event and the authoring state).
 */
export function receiptFromRecord(record: ProjectOperationRecordV1): AuthoringOperationReceiptV1 {
  const active = record.status === 'queued' || record.status === 'running';
  return {
    version: AUTHORING_CONTRACT_VERSION,
    operationId: record.operationId,
    projectId: record.projectId,
    kind: receiptKindFor(record.kind),
    status: receiptStatusFor(record.status, record.errorCode),
    acceptedSourceHash: record.sourceHash,
    acceptedRevisionId: record.acceptedRevisionId,
    pendingOperationId: active ? record.operationId : null,
    revisionId: record.status === 'succeeded' ? record.acceptedRevisionId : null,
    receiptHash: record.status === 'succeeded' ? record.resultRef : null,
    errorCode: record.errorCode,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    progress: record.progress,
    resultRef: record.resultRef,
  };
}

export async function createAuthoringCoordinator(
  assembly: AuthoringCoordinatorAssembly,
): Promise<AuthoringCoordinator> {
  const {
    projectId,
    materializer,
    treeLoader,
    sessions,
    revision,
    sourceViewMaterializer,
    events,
    documents,
    staging,
    revisionContentStore,
    persistence,
    operationStore,
    buildSnapshot,
    validate,
    adopt,
    extensionRegistrar,
  } = assembly;
  if (typeof projectId !== 'string' || projectId.length === 0)
    throw new TypeError('AuthoringCoordinator requires a non-empty projectId');
  for (const [name, port] of [
    ['materializer', materializer],
    ['treeLoader', treeLoader],
    ['sessions', sessions],
    ['revision', revision],
    ['sourceViewMaterializer', sourceViewMaterializer],
    ['events', events],
    ['documents', documents],
    ['staging', staging],
    ['revisionContentStore', revisionContentStore],
    ['persistence', persistence],
    ['operationStore', operationStore],
    ['buildSnapshot', buildSnapshot],
    ['validate', validate],
    ['adopt', adopt],
  ] as const) {
    if (
      port === null ||
      port === undefined ||
      (typeof port !== 'object' && typeof port !== 'function')
    )
      throw new TypeError(`AuthoringCoordinator requires an injected ${name} port`);
  }
  if (materializer !== documents)
    throw new TypeError('AuthoringCoordinator materializer must be the same instance as documents');
  const now = assembly.now ?? (() => new Date().toISOString());
  const newId = assembly.newId ?? randomUUID;
  const notifyDebounceMs = Math.max(0, assembly.notifyDebounceMs ?? 25);
  const acceptCapability = assembly.acceptCapability ?? { capabilityId: 'coordinator', scopes: [] };
  let phase: AuthoringPhaseV1 = 'clean';
  let acceptedRevisionId: string | null = assembly.initialAcceptedRevisionId ?? null;
  let acceptedSourceHash: string | null = assembly.initialAccepted?.sourceHash ?? null;
  let observedFilesystemHash: string | null = null;
  let workingDirty = false;
  let workspaceDigest: string | null = null;
  let candidate: AuthoringExternalCandidateV1 | null = null;
  let conflicts: readonly AuthoringConflictV1[] = [];
  let pendingOperationId: string | null = null;
  let recoveryPhase: string | null = null;
  let disposed = false;
  let restoredTerminalPhase: Extract<AuthoringPhaseV1, 'stale' | 'conflict'> | null = null;
  let lockTail: Promise<void> = Promise.resolve();
  let notifyTimer: ReturnType<typeof setTimeout> | null = null;
  const notifyWaiters: (() => void)[] = [];

  if (assembly.initialAccepted !== undefined && assembly.initialAccepted !== null)
    await documents.seedFromAccepted(assembly.initialAccepted);
  if (acceptedRevisionId === null) {
    const loaded = await revision.loadAccepted(projectId);
    if (loaded !== null) {
      acceptedRevisionId = loaded.revisionId;
      acceptedSourceHash = loaded.sourceHash;
    }
  }
  const persisted = await persistence.load({ projectId });
  if (persisted !== null) {
    const native = persisted as NativeStateRecord;
    if (native.acceptedRevisionId !== undefined) acceptedRevisionId = native.acceptedRevisionId;
    if (native.acceptedSourceHash !== undefined) acceptedSourceHash = native.acceptedSourceHash;
    observedFilesystemHash = native.observedFilesystemHash ?? null;
    workspaceDigest = native.workspaceDigest ?? null;
    pendingOperationId = native.pendingSubmitId ?? null;
    conflicts = native.conflicts.map((conflict) => ({ ...conflict, proposedDisjointMerge: false }));
    if (native.candidateHash !== undefined) {
      const staged = await staging.get({ projectId, candidateHash: native.candidateHash });
      if (staged === null) recoveryPhase ??= 'candidate-staging-missing';
      else
        candidate = {
          candidateHash: native.candidateHash,
          detectedAt: native.updatedAt,
          valid: native.candidateValid,
          changedLogicalPaths: [],
          diagnostics: [],
        };
    }
    recoveryPhase ??= native.recoveryPhase ?? null;
    if (pendingOperationId !== null) recoveryPhase ??= 'operation-recovery-required';
    if (native.phase === 'stale' || native.phase === 'conflict') {
      restoredTerminalPhase = native.phase;
      phase = native.phase;
    } else if (
      AUTHORING_PHASE_VALUES.includes(native.phase as AuthoringPhaseV1) &&
      native.phase === 'recovery-required'
    )
      recoveryPhase ??= native.recoveryPhase ?? 'persisted-recovery-required';
  }
  await captureWorkingIdentity();
  recomputePhase();

  function locked<T>(run: () => Promise<T>): Promise<T> {
    const slot = lockTail.then(run, run);
    lockTail = slot.then(
      () => undefined,
      () => undefined,
    );
    return slot;
  }
  /**
   * Create and persist a `queued` operation record. The durable row is the
   * single source of truth; the returned receipt is derived from it. No event
   * is broadcast for the creation (matching the previous in-memory behavior —
   * clients observe the operation through its first transition or the list).
   */
  async function createOperationRecord(input: {
    readonly operationId: string;
    readonly actorId: string;
    readonly capabilityVersion: number;
    readonly createdAt: string;
  }): Promise<ProjectOperationRecordV1> {
    const record: ProjectOperationRecordV1 = {
      version: 1,
      projectId,
      operationId: input.operationId,
      // Authoring operations are one-shot: the operation id itself is the
      // unique per-kind idempotency key, so a retry always enqueues a fresh
      // operation (exactly like the previous in-memory behavior).
      idempotencyKey: input.operationId,
      kind: RECORD_KIND_AUTHORING,
      status: 'queued',
      actorId: input.actorId,
      capabilityVersion: input.capabilityVersion,
      sourceHash: acceptedSourceHash,
      acceptedRevisionId,
      progress: null,
      resultRef: null,
      errorCode: null,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    };
    const persisted = await operationStore.upsert({ record });
    return persisted.record;
  }
  /**
   * Transition a persisted record and broadcast the derived receipt ONLY after
   * the transition is durably stored (plan 4.7: no receipt before its record).
   * On a CAS mismatch (`applied:false`) the stored record wins and is what gets
   * broadcast.
   */
  async function transitionRecord(
    record: ProjectOperationRecordV1,
    patch: {
      readonly status: ProjectOperationStatusV1;
      readonly errorCode?: string | null;
      readonly acceptedRevisionId?: string | null;
      readonly resultRef?: string | null;
    },
  ): Promise<ProjectOperationRecordV1> {
    const updated: ProjectOperationRecordV1 = {
      ...record,
      ...(patch.errorCode === undefined ? {} : { errorCode: patch.errorCode }),
      ...(patch.acceptedRevisionId === undefined
        ? {}
        : { acceptedRevisionId: patch.acceptedRevisionId }),
      ...(patch.resultRef === undefined ? {} : { resultRef: patch.resultRef }),
      status: patch.status,
      updatedAt: now(),
    };
    const result = await operationStore.upsert({
      record: updated,
      expectedStatus: record.status,
    });
    const persisted = result.record;
    events.publish({
      type: 'operation-updated',
      projectId,
      receipt: receiptFromRecord(persisted),
      at: persisted.updatedAt,
    });
    return persisted;
  }
  function submitBlockReason(): AuthoringSubmitBlockReasonV1 {
    if (recoveryPhase !== null) return 'recovery-required';
    if (phase === 'submitting') return 'submission-in-flight';
    if (candidate !== null && !candidate.valid) return 'candidate-invalid';
    if (conflicts.length > 0) return 'conflict-requires-resolution';
    if (candidate !== null) return 'external-candidate-pending';
    if (!workingDirty) return 'not-dirty';
    return 'none';
  }
  function state(): AuthoringStateV1 {
    const reason = submitBlockReason();
    return {
      version: AUTHORING_CONTRACT_VERSION,
      projectId,
      phase,
      acceptedSourceHash,
      acceptedRevisionId,
      pendingOperationId,
      workingDirty,
      workspaceDigest,
      externalCandidate: candidate,
      conflicts,
      diagnostics: candidate?.diagnostics ?? EMPTY_DIAGNOSTICS,
      canSubmit: reason === 'none',
      submitBlockReason: reason,
      generatedAt: now(),
    };
  }
  function persistenceRecord(): AuthoringStateRecord {
    return {
      projectId,
      phase,
      ...(acceptedSourceHash === null ? {} : { acceptedSourceHash }),
      ...(observedFilesystemHash === null ? {} : { observedFilesystemHash }),
      ...(workspaceDigest === null ? {} : { workspaceDigest }),
      ...(candidate === null ? {} : { candidateHash: candidate.candidateHash }),
      candidateValid: candidate?.valid ?? true,
      conflicts: conflicts.map(({ proposedDisjointMerge: _ignored, ...conflict }) => conflict),
      ...(pendingOperationId === null ? {} : { pendingSubmitId: pendingOperationId }),
      ...(recoveryPhase === null ? {} : { recoveryPhase }),
      updatedAt: now(),
    };
  }
  async function persistState(): Promise<void> {
    await persistence.save(persistenceRecord());
  }
  async function emitState(): Promise<void> {
    if (disposed) return;
    try {
      await persistState();
    } catch {
      if (disposed) return;
      recoveryPhase = 'persistence-failed';
      recomputePhase();
      throw new Error('Authoring coordinator state persistence failed');
    }
    if (!disposed) events.publish({ type: 'state-changed', projectId, state: state(), at: now() });
  }
  function recomputePhase(cleanPhase: 'clean' | 'accepted' = 'clean'): void {
    if (recoveryPhase !== null) {
      phase = 'recovery-required';
      return;
    }
    if (restoredTerminalPhase !== null) {
      phase = restoredTerminalPhase;
      return;
    }
    if (candidate === null) {
      phase = workingDirty ? 'working-dirty' : cleanPhase;
      return;
    }
    phase = !candidate.valid
      ? 'candidate-invalid'
      : workingDirty
        ? 'dual-conflict'
        : 'external-pending';
  }
  async function captureWorkingIdentity(): Promise<void> {
    workingDirty = await documents.isWorkingDirty();
    const digest = await documents.workspaceDigest();
    workspaceDigest = digest?.digest ?? null;
  }
  async function changedLogicalPaths(
    entries: readonly { readonly logicalPath: string; readonly content: string }[],
  ): Promise<readonly string[]> {
    const changed = new Set<string>();
    const paths = new Set(entries.map((entry) => entry.logicalPath));
    for (const path of await documents.acceptedPaths()) if (!paths.has(path)) changed.add(path);
    for (const entry of entries) {
      const accepted = documents.acceptedContent(entry.logicalPath);
      if (accepted === null || accepted !== entry.content) changed.add(entry.logicalPath);
    }
    return [...changed].sort(compareLogicalPaths);
  }
  async function computeConflicts(
    entries: readonly { readonly logicalPath: string; readonly content: string }[],
  ): Promise<readonly AuthoringConflictV1[]> {
    const external = new Map(entries.map((entry) => [entry.logicalPath, entry.content]));
    const found: AuthoringConflictV1[] = [];
    for (const descriptor of documents.descriptors()) {
      const content = external.get(descriptor.logicalPath);
      if (content === undefined) continue;
      const working = await documents.workingContentHash(descriptor.documentId);
      const accepted = documents.acceptedContentHash(descriptor.logicalPath);
      if (working === null || working === accepted) continue;
      const externalHash = hashEntry(content);
      if (externalHash === accepted || externalHash === working) continue;
      found.push({
        logicalPath: descriptor.logicalPath,
        kind: 'working-vs-external',
        baseSourceHash: acceptedSourceHash ?? '',
        workingHash: working,
        externalHash,
        proposedDisjointMerge: false,
      });
    }
    return found;
  }
  async function processExternalHint(): Promise<void> {
    await locked(async () => {
      if (disposed) return;
      const snapshot = await treeLoader.loadTree({ projectId });
      observedFilesystemHash = snapshot.treeHash;
      if (candidate !== null && snapshot.treeHash === candidate.candidateHash) {
        await emitState();
        return;
      }
      if (snapshot.treeHash === acceptedSourceHash) {
        if (candidate !== null) {
          await staging
            .delete({ projectId, candidateHash: candidate.candidateHash })
            .catch(() => undefined);
          candidate = null;
          conflicts = [];
        }
        recomputePhase();
        await emitState();
        return;
      }
      await staging.put({ projectId, candidateHash: snapshot.treeHash, entries: snapshot.entries });
      candidate = {
        candidateHash: snapshot.treeHash,
        detectedAt: now(),
        valid: !hasErrorSeverity(snapshot.diagnostics),
        changedLogicalPaths: await changedLogicalPaths(snapshot.entries),
        diagnostics: snapshot.diagnostics,
      };
      conflicts = await computeConflicts(snapshot.entries);
      recomputePhase();
      await emitState();
    });
  }

  async function runNativeSubmission(input: {
    readonly kind: AuthoringOperationKindV1;
    readonly operationId: string;
    readonly capabilityId: string;
    readonly scopes: readonly string[];
    readonly actorId: string;
    readonly entries: readonly { readonly logicalPath: string; readonly content: string }[];
    readonly sourceHash: string;
    readonly expectedVersion?: number;
  }): Promise<SubmissionRunResult> {
    let outcome: SubmissionRunResult = { status: 'recovery', message: 'submission did not run' };
    const result = await sessions.enqueue({
      projectId,
      capabilityId: input.capabilityId,
      scopes: input.scopes,
      expectedVersion: input.expectedVersion,
      kind: input.kind,
      run: async () => {
        const inspected = await sourceViewMaterializer.inspect(projectId);
        const bundleHash = hashBundle(input.entries);
        try {
          await revisionContentStore.put({ projectId, bundleHash, entries: input.entries });
        } catch (error) {
          outcome = {
            status: 'recovery',
            message: error instanceof Error ? error.message : 'revision bundle persistence failed',
          };
          return;
        }
        pendingOperationId = input.operationId;
        await persistState();
        const accepted = await revision.submit({
          projectId,
          candidate: { entries: input.entries, sourceHash: input.sourceHash, bundleHash },
          expectedRevisionId: acceptedRevisionId,
          expectedSourceHash: acceptedSourceHash,
          operationId: input.operationId,
          actorId: input.actorId,
        });
        if (accepted.status === 'stale' || accepted.status === 'conflict') {
          pendingOperationId = null;
          await persistState();
          outcome = { status: accepted.status, reason: accepted.reason };
          return;
        }
        if (accepted.status === 'invalid') {
          pendingOperationId = null;
          await persistState();
          outcome = { status: 'invalid', code: accepted.code };
          return;
        }
        const materialized = await sourceViewMaterializer.materialize({
          projectId,
          expectedMaterializedRevisionId: inspected.materializedRevisionId,
          expectedTreeHash: inspected.treeHash,
          bundle: { bundleHash, entries: input.entries },
        });
        if (materialized.status !== 'completed') {
          outcome = { status: 'recovery', message: materialized.reason };
          return;
        }
        const tree = await treeLoader.loadTree({ projectId });
        const aligned = buildSnapshot({ projectId, entries: tree.entries });
        if (aligned.sourceHash !== input.sourceHash || materialized.treeHash !== input.sourceHash) {
          outcome = {
            status: 'recovery',
            message: `Materialized source hash ${aligned.sourceHash} does not match revision ${input.sourceHash}`,
          };
          return;
        }
        const adopted = await adopt({ projectId, candidate: aligned });
        if (adopted.status === 'rejected') {
          outcome = {
            status: 'adopt-failed',
            message: adopted.diagnostics.map((diagnostic) => diagnostic.message).join('; '),
          };
          return;
        }
        await documents.seedFromAccepted(aligned);
        acceptedRevisionId = accepted.revisionId;
        acceptedSourceHash = aligned.sourceHash;
        pendingOperationId = null;
        observedFilesystemHash = materialized.treeHash;
        outcome = {
          status: 'accepted',
          operationId: input.operationId,
          revisionId: accepted.revisionId,
          sourceHash: aligned.sourceHash,
          receiptHash: accepted.receiptHash,
          treeHash: materialized.treeHash,
        };
        await persistState();
      },
    });
    if (result.status === 'denied')
      return { status: 'stale', reason: `capability denied: ${result.reason}` };
    if (result.status === 'failed') return { status: 'recovery', message: result.message };
    return outcome;
  }
  async function acceptSubmission(
    outcome: Extract<SubmissionRunResult, { status: 'accepted' }>,
  ): Promise<void> {
    acceptedRevisionId = outcome.revisionId;
    acceptedSourceHash = outcome.sourceHash;
    pendingOperationId = null;
    observedFilesystemHash = outcome.treeHash;
    restoredTerminalPhase = null;
    if (candidate !== null) {
      await staging
        .delete({ projectId, candidateHash: candidate.candidateHash })
        .catch(() => undefined);
      candidate = null;
      conflicts = [];
    }
    await captureWorkingIdentity();
    recomputePhase('accepted');
    await persistState();
  }
  /**
   * Publish the durable `submit-receipt` event. Called by submit/reconcile
   * ONLY after the operation record reached its terminal transition, so no
   * receipt is ever broadcast before its record persists.
   */
  function publishSubmitReceipt(
    outcome: Extract<SubmissionRunResult, { status: 'accepted' }>,
  ): void {
    events.publish({
      type: 'submit-receipt',
      projectId,
      operationId: outcome.operationId,
      receiptHash: outcome.receiptHash,
      acceptedSourceHash: outcome.sourceHash,
      at: now(),
    });
  }
  /**
   * Transition the operation record to the outcome's terminal status. The
   * durable queue has no `conflict` status, so a conflict is stored as `stale`
   * with the CONFLICT_REQUIRES_RESOLUTION code; the receipt derivation maps it
   * back to the client-facing `conflict` status unchanged.
   */
  async function recordFromOutcome(
    record: ProjectOperationRecordV1,
    outcome: SubmissionRunResult,
  ): Promise<ProjectOperationRecordV1> {
    if (outcome.status === 'accepted')
      return transitionRecord(record, {
        status: 'succeeded',
        acceptedRevisionId: outcome.revisionId,
        resultRef: outcome.receiptHash,
        errorCode: null,
      });
    if (outcome.status === 'stale') {
      phase = 'stale';
      return transitionRecord(record, { status: 'stale', errorCode: 'WORKSPACE_STALE' });
    }
    if (outcome.status === 'conflict') {
      phase = 'conflict';
      return transitionRecord(record, {
        status: 'stale',
        errorCode: 'CONFLICT_REQUIRES_RESOLUTION',
      });
    }
    if (outcome.status === 'invalid') {
      phase = 'candidate-invalid';
      return transitionRecord(record, { status: 'failed', errorCode: outcome.code });
    }
    phase = 'recovery-required';
    recoveryPhase = outcome.message;
    return transitionRecord(record, { status: 'failed', errorCode: 'INTERNAL' });
  }

  const submit = async (input: AuthoringSubmitInput): Promise<AuthoringOperationReceiptV1> =>
    locked(async () => {
      const operationId = newId();
      let record = await createOperationRecord({
        operationId,
        actorId: input.actorId,
        capabilityVersion: input.expectedVersion ?? 0,
        createdAt: now(),
      });
      if (disposed)
        return receiptFromRecord(
          await transitionRecord(record, { status: 'stale', errorCode: 'INTERNAL' }),
        );
      const reason = submitBlockReason();
      if (reason !== 'none')
        return receiptFromRecord(
          await transitionRecord(record, {
            status: 'stale',
            errorCode:
              reason === 'conflict-requires-resolution'
                ? 'CONFLICT_REQUIRES_RESOLUTION'
                : reason === 'candidate-invalid'
                  ? 'CANDIDATE_INVALID'
                  : 'SUBMIT_BLOCKED',
          }),
        );
      if (input.expectedAcceptedSourceHash !== acceptedSourceHash)
        return receiptFromRecord(
          await transitionRecord(record, {
            status: 'stale',
            errorCode: 'ACCEPTED_HASH_MISMATCH',
          }),
        );
      if (
        input.expectedAcceptedRevisionId !== undefined &&
        input.expectedAcceptedRevisionId !== acceptedRevisionId
      )
        return receiptFromRecord(
          await transitionRecord(record, {
            status: 'stale',
            errorCode: 'ACCEPTED_HASH_MISMATCH',
          }),
        );
      const digest = await documents.workspaceDigest();
      if (digest === null || digest.digest !== input.expectedWorkspaceDigest)
        return receiptFromRecord(
          await transitionRecord(record, { status: 'stale', errorCode: 'WORKSPACE_STALE' }),
        );
      phase = 'submitting';
      pendingOperationId = operationId;
      await emitState();
      record = await transitionRecord(record, { status: 'running' });
      const descriptors = documents.descriptors();
      const materialized = await documents.materialize({
        projectId,
        documents: descriptors.map((descriptor) => ({
          documentId: descriptor.documentId,
          logicalPath: descriptor.logicalPath,
        })),
      });
      const snapshot = buildSnapshot({ projectId, entries: materialized.entries });
      if (hasErrorSeverity(validate(snapshot))) {
        pendingOperationId = null;
        phase = 'candidate-invalid';
        await persistState();
        return receiptFromRecord(
          await transitionRecord(record, { status: 'failed', errorCode: 'CANDIDATE_INVALID' }),
        );
      }
      const outcome = await runNativeSubmission({
        kind: KIND_SUBMIT,
        operationId,
        capabilityId: input.capabilityId,
        scopes: input.capabilityScopes,
        actorId: input.actorId,
        entries: materialized.entries,
        sourceHash: snapshot.sourceHash,
        expectedVersion: input.expectedVersion,
      });
      if (outcome.status === 'accepted') await acceptSubmission(outcome);
      else await captureWorkingIdentity();
      record = await recordFromOutcome(record, outcome);
      await emitState();
      if (outcome.status === 'accepted') publishSubmitReceipt(outcome);
      return receiptFromRecord(record);
    });

  const reconcileExternal = async (
    input: AuthoringReconcileInput,
  ): Promise<AuthoringOperationReceiptV1> =>
    locked(async () => {
      const operationId = newId();
      let record = await createOperationRecord({
        operationId,
        actorId: input.actorId,
        capabilityVersion: input.expectedVersion ?? 0,
        createdAt: now(),
      });
      if (disposed || candidate === null)
        return receiptFromRecord(
          await transitionRecord(record, { status: 'stale', errorCode: 'INVALID_INPUT' }),
        );
      if (input.candidateHash !== null && input.candidateHash !== candidate.candidateHash)
        return receiptFromRecord(
          await transitionRecord(record, { status: 'stale', errorCode: 'WORKSPACE_STALE' }),
        );
      if (input.expectedAcceptedSourceHash !== acceptedSourceHash)
        return receiptFromRecord(
          await transitionRecord(record, {
            status: 'stale',
            errorCode: 'ACCEPTED_HASH_MISMATCH',
          }),
        );
      if (
        input.expectedAcceptedRevisionId !== undefined &&
        input.expectedAcceptedRevisionId !== acceptedRevisionId
      )
        return receiptFromRecord(
          await transitionRecord(record, {
            status: 'stale',
            errorCode: 'ACCEPTED_HASH_MISMATCH',
          }),
        );
      if (input.choice === 'keep-working') {
        // keep-working still runs inside the authoring session lane, so the
        // durable record moves through queued -> running -> succeeded/failed.
        record = await transitionRecord(record, { status: 'running' });
        const result = await sessions.enqueue({
          projectId,
          capabilityId: input.capabilityId,
          scopes: input.capabilityScopes,
          expectedVersion: input.expectedVersion,
          kind: KIND_RECONCILE,
          run: async () => undefined,
        });
        if (result.status !== 'completed')
          return receiptFromRecord(
            await transitionRecord(record, { status: 'failed', errorCode: 'SUBMIT_BLOCKED' }),
          );
        await staging
          .delete({ projectId, candidateHash: candidate.candidateHash })
          .catch(() => undefined);
        observedFilesystemHash = candidate.candidateHash;
        candidate = null;
        conflicts = [];
        recomputePhase();
        await emitState();
        return receiptFromRecord(await transitionRecord(record, { status: 'succeeded' }));
      }
      const staged = await staging.get({ projectId, candidateHash: candidate.candidateHash });
      if (staged === null)
        return receiptFromRecord(
          await transitionRecord(record, { status: 'stale', errorCode: 'INTERNAL' }),
        );
      let entries = staged.entries;
      if (input.choice === 'apply-proposed-disjoint-merge') {
        if (conflicts.length > 0)
          return receiptFromRecord(
            await transitionRecord(record, {
              status: 'stale',
              errorCode: 'CONFLICT_REQUIRES_RESOLUTION',
            }),
          );
        const merged = await buildDisjointMerge(staged.entries);
        if (merged === null)
          return receiptFromRecord(
            await transitionRecord(record, {
              status: 'stale',
              errorCode: 'CONFLICT_REQUIRES_RESOLUTION',
            }),
          );
        entries = merged;
      }
      const snapshot = buildSnapshot({ projectId, entries });
      if (hasErrorSeverity(validate(snapshot))) {
        phase = 'candidate-invalid';
        await emitState();
        return receiptFromRecord(
          await transitionRecord(record, { status: 'stale', errorCode: 'CANDIDATE_INVALID' }),
        );
      }
      const digest = await documents.workspaceDigest();
      if (digest === null)
        return receiptFromRecord(
          await transitionRecord(record, { status: 'stale', errorCode: 'WORKSPACE_STALE' }),
        );
      phase = 'submitting';
      record = await transitionRecord(record, { status: 'running' });
      const outcome = await runNativeSubmission({
        kind:
          input.choice === 'apply-proposed-disjoint-merge' ? KIND_RESOLVE_CONFLICT : KIND_RECONCILE,
        operationId,
        capabilityId: input.capabilityId,
        scopes: input.capabilityScopes,
        actorId: input.actorId,
        entries,
        sourceHash: snapshot.sourceHash,
        expectedVersion: input.expectedVersion,
      });
      if (outcome.status === 'accepted') await acceptSubmission(outcome);
      else await captureWorkingIdentity();
      record = await recordFromOutcome(record, outcome);
      await emitState();
      if (outcome.status === 'accepted') publishSubmitReceipt(outcome);
      return receiptFromRecord(record);
    });

  const refreshAccepted = async (input: { readonly expectedSourceHash: string }): Promise<void> =>
    locked(async () => {
      if (disposed) return;
      const loaded = await revision.loadAccepted(projectId);
      if (loaded === null || loaded.sourceHash !== input.expectedSourceHash) {
        recoveryPhase = 'refresh-mismatch';
        recomputePhase();
        await emitState();
        return;
      }
      const tree = await treeLoader.loadTree({ projectId });
      const snapshot = buildSnapshot({ projectId, entries: tree.entries });
      if (snapshot.sourceHash !== loaded.sourceHash) {
        recoveryPhase = 'refresh-tree-mismatch';
        recomputePhase();
        await emitState();
        return;
      }
      const result = await sessions.enqueue({
        projectId,
        capabilityId: acceptCapability.capabilityId,
        scopes: acceptCapability.scopes,
        kind: KIND_RECONCILE,
        run: async () => {
          const adopted = await adopt({ projectId, candidate: snapshot });
          if (adopted.status === 'rejected') throw new Error('accepted source adoption failed');
          await documents.seedFromAccepted(snapshot);
        },
      });
      if (result.status !== 'completed') {
        recoveryPhase = 'adoption-failed';
        recomputePhase();
        await emitState();
        return;
      }
      acceptedRevisionId = loaded.revisionId;
      acceptedSourceHash = loaded.sourceHash;
      observedFilesystemHash = tree.treeHash;
      recoveryPhase = null;
      await captureWorkingIdentity();
      recomputePhase('accepted');
      await emitState();
    });

  async function buildDisjointMerge(
    externalEntries: readonly { readonly logicalPath: string; readonly content: string }[],
  ): Promise<readonly { readonly logicalPath: string; readonly content: string }[] | null> {
    const externalByPath = new Map(
      externalEntries.map((entry) => [entry.logicalPath, entry.content]),
    );
    const externalChanged = new Set<string>();
    for (const entry of externalEntries) {
      const accepted = documents.acceptedContent(entry.logicalPath);
      if (accepted === null || accepted !== entry.content) externalChanged.add(entry.logicalPath);
    }
    for (const path of await documents.acceptedPaths())
      if (!externalByPath.has(path)) externalChanged.add(path);
    const workingChanged = new Set<string>();
    const workingByPath = new Map<string, string>();
    for (const descriptor of documents.descriptors()) {
      const content = await documents.materializeDocument(descriptor.documentId);
      if (content === null) continue;
      const accepted = documents.acceptedContent(descriptor.logicalPath);
      if (accepted === null || accepted !== content) {
        workingChanged.add(descriptor.logicalPath);
        workingByPath.set(descriptor.logicalPath, content);
      }
    }
    if (!workingDirty || workingChanged.size === 0) return null;
    for (const path of workingChanged)
      if (externalChanged.has(path) && workingByPath.get(path) !== externalByPath.get(path))
        return null;
    const merged: { logicalPath: string; content: string }[] = [];
    const paths = new Set<string>([...externalByPath.keys(), ...(await documents.acceptedPaths())]);
    for (const path of [...paths].sort(compareLogicalPaths)) {
      if (externalChanged.has(path) && externalByPath.has(path))
        merged.push({ logicalPath: path, content: externalByPath.get(path) as string });
      else if (workingChanged.has(path))
        merged.push({ logicalPath: path, content: workingByPath.get(path) as string });
      else {
        const accepted = documents.acceptedContent(path);
        if (accepted !== null) merged.push({ logicalPath: path, content: accepted });
      }
    }
    return merged;
  }

  const validateWorking = async (input: {
    readonly expectedWorkspaceDigest: string;
    readonly expectedAcceptedSourceHash: string | null;
  }): Promise<WorkingValidationResultV1> =>
    locked(async () => {
      if (disposed) {
        throw new WorkingValidationFailure('INTERNAL', 'The authoring coordinator is disposed.');
      }
      if (input.expectedAcceptedSourceHash !== acceptedSourceHash) {
        throw new WorkingValidationFailure(
          'ACCEPTED_HASH_MISMATCH',
          'The accepted source changed; re-read before validating the working layer.',
        );
      }
      const digest = await documents.workspaceDigest();
      if (digest === null || digest.digest !== input.expectedWorkspaceDigest) {
        throw new WorkingValidationFailure(
          'WORKSPACE_STALE',
          'The working layer changed; re-read before validating.',
        );
      }
      const descriptors = documents.descriptors();
      const materialized = await documents.materialize({
        projectId,
        documents: descriptors.map((descriptor) => ({
          documentId: descriptor.documentId,
          logicalPath: descriptor.logicalPath,
        })),
      });
      const snapshot = buildSnapshot({ projectId, entries: materialized.entries });
      const validation = await validateNovel(
        snapshot,
        undefined,
        extensionRegistrar === undefined ? undefined : { extensionRegistrar },
      );
      return {
        version: AUTHORING_CONTRACT_VERSION,
        layer: 'working',
        projectId,
        workspaceDigest: digest.digest,
        acceptedSourceHash,
        candidateSourceHash: snapshot.sourceHash,
        passed: validation.passed,
        diagnostics: validate(snapshot),
        iss: validation.iss,
        results: Object.fromEntries(validation.results),
      };
    });

  return {
    projectId,
    getState: state,
    listOperations: async () => {
      const records = await operationStore.list({ projectId, limit: 100 });
      return records.map(receiptFromRecord);
    },
    getOperation: async (operationId) => {
      const record = await operationStore.get(projectId, operationId);
      return record === null ? null : receiptFromRecord(record);
    },
    isAgentPaused: () =>
      phase === 'dual-conflict' ||
      phase === 'candidate-invalid' ||
      phase === 'recovery-required' ||
      phase === 'submitting',
    refreshWorkingState: async () =>
      locked(async () => {
        if (disposed) return;
        await captureWorkingIdentity();
        recomputePhase();
        await emitState();
      }),
    notifyExternalChange: async () => {
      if (disposed) return;
      if (notifyTimer === null) {
        notifyTimer = setTimeout(() => {
          notifyTimer = null;
          void processExternalHint()
            .catch(() => undefined)
            .finally(() => {
              for (const waiter of notifyWaiters.splice(0)) waiter();
            });
        }, notifyDebounceMs);
      }
      await new Promise<void>((resolve) => notifyWaiters.push(resolve));
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      if (notifyTimer !== null) clearTimeout(notifyTimer);
      notifyTimer = null;
      for (const waiter of notifyWaiters.splice(0)) waiter();
      await lockTail;
    },
    submit,
    reconcileExternal,
    validateWorking,
    refreshAccepted,
  };
}
