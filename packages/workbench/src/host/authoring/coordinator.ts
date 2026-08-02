/**
 * Per-project AuthoringCoordinator: the single transformation point for
 * browser direct edits, in-browser Agents, external MCP tools, and the
 * filesystem watcher.
 *
 * The coordinator maintains the four non-interchangeable identities the
 * Phase-0 contract demands:
 *
 *  - accepted source hash — the validated `ProjectSession` source identity,
 *  - observed filesystem hash — the authoring tree the watcher last re-read,
 *  - workspace digest — the stable sorted `logicalPath + state vector`
 *    summary of the Yjs working layer (the submit precondition),
 *  - fixed Git head / submitId — the durable Git CAS identity.
 *
 * None of these may stand in for another: submit and reconcile CAS each of
 * them independently, and every surface reads them from the single
 * browser-safe state projection. The accepted source is only ever refreshed
 * through a capability-gated, queued session operation (the serial adoption
 * hook); the watcher only ever produces external candidates and never
 * accepts or commits anything.
 *
 * Write protocol (all entries funnel here):
 *
 *  1. External (filesystem) candidates arrive via `notifyExternalChange`
 *     (debounced full re-read). Working-clean → `external-pending`;
 *     working-dirty → `dual-conflict` (Agent edits pause); invalid trees →
 *     `candidate-invalid` with the last-valid accepted projection untouched.
 *     Same-path working-vs-external conflicts are surfaced as typed conflict
 *     entries and are NEVER auto-merged; a disjoint-path merge is only
 *     available as the explicit `apply-proposed-disjoint-merge` choice.
 *  2. Explicit submit freezes the accepted hash + workspace digest CAS,
 *     materializes the working candidate (working-or-accepted), validates
 *     it, and runs the exact-once Git port inside the capability-gated
 *     session operation; a Git acceptance is followed by a tree reload,
 *     source-hash verification, and serial adoption in the same operation.
 *  3. Reconcile/conflict resolution (keep-working, accept-external,
 *     apply-proposed-disjoint-merge) routes through the same Git acceptance
 *     path or discards the staged candidate, always under the actor's
 *     capability.
 *
 * This module holds no filesystem, Git, provider, or database handle; all
 * I/O is through the injected Phase-0 ports plus the host-internal
 * document-store/staging/validation/adoption assembly inputs below.
 */

import { randomUUID } from 'node:crypto';
import type { ProjectSourceSnapshotV1 } from '@novalistically/core';
import { compareLogicalPaths } from '@novalistically/core/source';
import {
  AUTHORING_CONTRACT_VERSION,
  AUTHORING_PHASE_VALUES,
  type AuthoringConflictV1,
  type AuthoringDiagnosticV1,
  type AuthoringExternalCandidateV1,
  type AuthoringOperationKindV1,
  type AuthoringOperationReceiptV1,
  type AuthoringPhaseV1,
  type AuthoringStateV1,
  type AuthoringSubmitBlockReasonV1,
  type AuthoringWorkspaceDigestV1,
} from '../../contracts/authoring.js';
import type { AuthoringStateRecord } from '../../contracts/persistence.js';
import type { SourceRefreshResult } from '../project-session.js';
import type { AuthoringCandidateStore } from './filesystem-observer.js';
import type {
  AuthoringCoordinator,
  AuthoringCoordinatorEvent,
  AuthoringCoordinatorOptions,
  AuthoringReconcileInput,
  AuthoringSubmitInput,
} from './types.js';
import type { AuthoringWorkingDocumentStore } from './document-store.js';

/** Maximum operation receipts retained per project (FIFO). */
const MAX_RETAINED_OPERATIONS = 64;

/** Capability-gated kinds the coordinator enqueues into the session queue. */
const KIND_SUBMIT = 'authoring.submit';
const KIND_RECONCILE = 'authoring.reconcile';
const KIND_ACCEPT = 'authoring.accept';

/**
 * Host-internal assembly inputs for the Phase-1 coordinator implementation.
 * Every Phase-0 {@link AuthoringCoordinatorOptions} field remains exactly as
 * typed and required; these extras are the wiring bridge to the production
 * document store, the private staging store, Core snapshot building, pure
 * candidate validation, and the session's serial adoption hook. They are
 * typed ports, never concrete host services, so the coordinator stays
 * dependency-free and deterministic under injected fakes.
 */
export interface AuthoringCoordinatorAssembly extends AuthoringCoordinatorOptions {
  /** Production document store (implements the materializer + catalog/digest). */
  readonly documents: AuthoringWorkingDocumentStore;
  /** Private content-addressed staging for external candidates. */
  readonly staging: AuthoringCandidateStore;
  /** Durable metadata state; accepted/raw source and Yjs bytes never enter it. */
  readonly persistence: AuthoringCoordinatorPersistence;
  /** Build a Core snapshot from manifest entries (parse + diagnostics). */
  readonly buildSnapshot: (input: {
    readonly projectId: string;
    readonly entries: readonly { readonly logicalPath: string; readonly content: string }[];
  }) => ProjectSourceSnapshotV1;
  /** Pure candidate validation; an error-severity diagnostic makes a candidate invalid. */
  readonly validate: (candidate: ProjectSourceSnapshotV1) => readonly AuthoringDiagnosticV1[];
  /**
   * Host-internal serial adoption: runs the session's valid-compiled gate and
   * adopts the candidate. MUST only be called from inside a queued session
   * operation (the wiring's implementation calls
   * `ProjectSession.adoptSourceWithinOperation`).
   */
  readonly adopt: (input: {
    readonly projectId: string;
    readonly candidate: ProjectSourceSnapshotV1;
  }) => Promise<SourceRefreshResult>;
  /** Initial accepted source snapshot, or null before the first accepted load. */
  readonly initialAccepted?: ProjectSourceSnapshotV1 | null;
  /** Fixed Git authoring ref head known at assembly time (bootstrap head). */
  readonly initialGitHead?: string | null;
  /** Capability for coordinator-internal accept operations (wiring-chosen). */
  readonly acceptCapability?: { readonly capabilityId: string; readonly scopes: readonly string[] };
  /** Operation/submit id source; defaults to random UUIDs. */
  readonly newId?: () => string;
  /** Debounce window for watcher hints inside the coordinator; defaults to 25ms. */
  readonly notifyDebounceMs?: number;
}

/** Durable, metadata-only coordinator state storage over Phase-0 persistence. */
export interface AuthoringCoordinatorPersistence {
  load(input: { readonly projectId: string }): Promise<AuthoringStateRecord | null>;
  save(record: AuthoringStateRecord): Promise<void>;
}
/** Typed result of one Git submission run (captured by the queued closure). */
type SubmissionRunResult =
  | {
      readonly status: 'accepted';
      readonly submitId: string;
      readonly sourceHash: string;
      readonly gitHead: string;
      readonly gitReceiptHash: string;
      readonly treeHash: string;
    }
  | { readonly status: 'stale'; readonly reason: string }
  | { readonly status: 'conflict'; readonly reason: string }
  | { readonly status: 'invalid'; readonly code: string }
  | { readonly status: 'recovery'; readonly message: string }
  | { readonly status: 'adopt-failed'; readonly message: string };

const EMPTY_DIAGNOSTICS: readonly AuthoringDiagnosticV1[] = [];

function hasErrorSeverity(diagnostics: readonly AuthoringDiagnosticV1[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === 'error');
}

async function createAuthoringCoordinatorImpl(
  assembly: AuthoringCoordinatorAssembly,
): Promise<AuthoringCoordinator> {
  const {
    projectId,
    materializer,
    treeLoader,
    sessions,
    git,
    events,
    documents,
    staging,
    persistence,
    buildSnapshot,
    validate,
    adopt,
  } = assembly;
  if (typeof projectId !== 'string' || projectId.length === 0) {
    throw new TypeError('AuthoringCoordinator requires a non-empty projectId');
  }
  for (const [name, port] of [
    ['materializer', materializer],
    ['treeLoader', treeLoader],
    ['sessions', sessions],
    ['git', git],
    ['events', events],
    ['documents', documents],
    ['staging', staging],
    ['persistence', persistence],
    ['buildSnapshot', buildSnapshot],
    ['validate', validate],
  ] as const) {
    if (
      port === null ||
      port === undefined ||
      (typeof port !== 'object' && typeof port !== 'function')
    ) {
      throw new TypeError(`AuthoringCoordinator requires an injected ${name} port`);
    }
  }
  if (materializer !== documents) {
    throw new TypeError(
      'AuthoringCoordinator materializer must be the same instance as documents (one working-layer store)',
    );
  }
  if (typeof buildSnapshot !== 'function' || typeof validate !== 'function' || typeof adopt !== 'function') {
    throw new TypeError('AuthoringCoordinator requires buildSnapshot, validate, and adopt functions');
  }
  const now = assembly.now ?? (() => new Date().toISOString());
  const newId = assembly.newId ?? randomUUID;
  const notifyDebounceMs = Math.max(0, assembly.notifyDebounceMs ?? 25);
  const acceptCapability = assembly.acceptCapability ?? { capabilityId: 'coordinator', scopes: [] };

  // ── Identity state (the four non-interchangeable domains) ─────────────
  let phase: AuthoringPhaseV1 = 'clean';
  let acceptedSourceHash: string | null = assembly.initialAccepted?.sourceHash ?? null;
  let observedFilesystemHash: string | null = null;
  let workingDirty = false;
  let workspaceDigest: string | null = null;
  let candidate: AuthoringExternalCandidateV1 | null = null;
  let conflicts: readonly AuthoringConflictV1[] = [];
  let gitHead: string | null = assembly.initialGitHead ?? null;
  let pendingSubmitId: string | null = null;
  let recoveryPhase: string | null = null;
  let disposed = false;
  let restoredTerminalPhase: Extract<AuthoringPhaseV1, 'stale' | 'conflict'> | null = null;

  const operations = new Map<string, AuthoringOperationReceiptV1>();
  let lockTail: Promise<void> = Promise.resolve();
  let notifyTimer: ReturnType<typeof setTimeout> | null = null;
  const notifyWaiters: (() => void)[] = [];

  if (assembly.initialAccepted !== undefined && assembly.initialAccepted !== null) {
    await documents.seedFromAccepted(assembly.initialAccepted);
  }

  // Restore durable identity metadata before this coordinator becomes visible.
  // A persisted candidate without its private staging bundle, an unresolved
  // submit, or an accepted-hash disagreement never becomes clean implicitly.
  const persisted = await persistence.load({ projectId });
  if (persisted !== null) {
    if (
      assembly.initialAccepted !== undefined &&
      assembly.initialAccepted !== null &&
      persisted.acceptedSourceHash !== undefined &&
      persisted.acceptedSourceHash !== assembly.initialAccepted.sourceHash
    ) {
      recoveryPhase = 'accepted-hash-mismatch';
    } else {
      acceptedSourceHash = persisted.acceptedSourceHash ?? acceptedSourceHash;
    }
    observedFilesystemHash = persisted.observedFilesystemHash ?? null;
    workspaceDigest = persisted.workspaceDigest ?? null;
    gitHead = persisted.fixedGitHead ?? gitHead;
    pendingSubmitId = persisted.pendingSubmitId ?? null;
    conflicts = persisted.conflicts.map((conflict) => ({
      ...conflict,
      proposedDisjointMerge: false,
    }));
    if (persisted.candidateHash !== undefined) {
      const bundle = await staging.get({ projectId, candidateHash: persisted.candidateHash });
      if (bundle === null) {
        recoveryPhase ??= 'candidate-staging-missing';
      } else {
        candidate = {
          candidateHash: persisted.candidateHash,
          detectedAt: persisted.updatedAt,
          valid: persisted.candidateValid,
          changedLogicalPaths: [],
          diagnostics: [],
        };
      }
    }
    recoveryPhase ??= persisted.recoveryPhase ?? null;
    if (pendingSubmitId !== null) recoveryPhase ??= 'submit-recovery-required';
    if (persisted.phase === 'stale' || persisted.phase === 'conflict') {
      restoredTerminalPhase = persisted.phase;
      phase = persisted.phase;
    } else if (
      AUTHORING_PHASE_VALUES.includes(persisted.phase as AuthoringPhaseV1) &&
      persisted.phase === 'recovery-required'
    ) {
      recoveryPhase ??= persisted.recoveryPhase ?? 'persisted-recovery-required';
    }
  }
  await captureWorkingIdentity();
  recomputePhase();

  // ── Locking / serialization ────────────────────────────────────────────

  /** Serialize coordinator-internal mutations (submit/reconcile/notify/refresh). */
  function locked<T>(run: () => Promise<T>): Promise<T> {
    const slot = lockTail.then(run, run);
    lockTail = slot.then(
      () => undefined,
      () => undefined,
    );
    return slot;
  }

  // ── Receipts ───────────────────────────────────────────────────────────

  function newReceipt(
    kind: AuthoringOperationKindV1,
    status: AuthoringOperationReceiptV1['status'],
    operationId: string,
    createdAt: string,
  ): AuthoringOperationReceiptV1 {
    const receipt: AuthoringOperationReceiptV1 = {
      version: AUTHORING_CONTRACT_VERSION,
      operationId,
      projectId,
      kind,
      status,
      acceptedSourceHash: acceptedSourceHash,
      workspaceDigest: workspaceDigest,
      gitSubmitId: null,
      gitCommit: null,
      gitReceiptHash: null,
      errorCode: null,
      createdAt,
      updatedAt: createdAt,
    };
    operations.set(operationId, receipt);
    while (operations.size > MAX_RETAINED_OPERATIONS) {
      const oldest = operations.keys().next().value;
      if (oldest === undefined) break;
      operations.delete(oldest);
    }
    return receipt;
  }

  function updateReceipt(
    receipt: AuthoringOperationReceiptV1,
    patch: Partial<AuthoringOperationReceiptV1>,
  ): AuthoringOperationReceiptV1 {
    const updated: AuthoringOperationReceiptV1 = {
      ...receipt,
      ...patch,
      updatedAt: now(),
    };
    operations.set(receipt.operationId, updated);
    events.publish({
      type: 'operation-updated',
      projectId,
      receipt: updated,
      at: updated.updatedAt,
    });
    return updated;
  }

  // ── State projection ───────────────────────────────────────────────────

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
      ...(gitHead === null ? {} : { fixedGitHead: gitHead }),
      ...(pendingSubmitId === null ? {} : { pendingSubmitId }),
      ...(recoveryPhase === null ? {} : { recoveryPhase }),
      updatedAt: now(),
    };
  }

  async function persistState(): Promise<void> {
    await persistence.save(persistenceRecord());
  }

  async function emitState(): Promise<void> {
    try {
      await persistState();
    } catch {
      recoveryPhase = 'persistence-failed';
      recomputePhase();
      events.publish({
        type: 'state-changed',
        projectId,
        state: state(),
        at: now(),
      });
      throw new Error('Authoring coordinator state persistence failed');
    }
    events.publish({
      type: 'state-changed',
      projectId,
      state: state(),
      at: now(),
    });
  }

  /**
   * Recompute the phase from the current (dirty, candidate, conflict)
   * material. `cleanPhase` is the phase used when the working layer is clean
   * and no candidate exists (default `clean`; `accepted` right after a
   * Git acceptance).
   */
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
    if (!candidate.valid) {
      phase = 'candidate-invalid';
      return;
    }
    phase = workingDirty ? 'dual-conflict' : 'external-pending';
  }
  /** Current workspace digest, always re-read from the working layer. */
  async function currentWorkspaceDigest(): Promise<AuthoringWorkspaceDigestV1 | null> {
    return documents.workspaceDigest();
  }

  /** External paths that differ from the accepted base, stable order. */
  async function changedLogicalPaths(
    snapshotEntries: readonly { readonly logicalPath: string; readonly content: string }[],
  ): Promise<readonly string[]> {
    const changed = new Set<string>();
    const snapshotPaths = new Set(snapshotEntries.map((entry) => entry.logicalPath));
    for (const path of await documents.acceptedPaths()) {
      if (!snapshotPaths.has(path)) changed.add(path);
    }
    for (const entry of snapshotEntries) {
      const accepted = documents.acceptedContent(entry.logicalPath);
      if (accepted === null || accepted !== entry.content) changed.add(entry.logicalPath);
    }
    return [...changed].sort(compareLogicalPaths);
  }

  /** Same-path working-vs-external conflicts; never auto-merged. */
  async function computeConflicts(
    snapshotEntries: readonly { readonly logicalPath: string; readonly content: string }[],
  ): Promise<readonly AuthoringConflictV1[]> {
    const externalByPath = new Map(snapshotEntries.map((entry) => [entry.logicalPath, entry.content]));
    const found: AuthoringConflictV1[] = [];
    for (const descriptor of documents.descriptors()) {
      const externalContent = externalByPath.get(descriptor.logicalPath);
      if (externalContent === undefined) continue;
      const working = await documents.workingContentHash(descriptor.documentId);
      if (working === null) continue;
      const accepted = documents.acceptedContentHash(descriptor.logicalPath);
      if (working === accepted) continue;
      const externalHash = computeEntryHash(externalContent);
      if (externalHash === accepted) continue;
      if (working === externalHash) continue;
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

  async function captureWorkingIdentity(): Promise<void> {
    workingDirty = await documents.isWorkingDirty();
    const digest = await documents.workspaceDigest();
    workspaceDigest = digest === null ? null : digest.digest;
  }

  // ── External candidates (watcher) ──────────────────────────────────────

  async function processExternalHint(): Promise<void> {
    await locked(async () => {
      if (disposed) return;
      const snapshot = await treeLoader.loadTree({ projectId });
      observedFilesystemHash = snapshot.treeHash;
      if (candidate !== null && snapshot.treeHash === candidate.candidateHash) {
        // The same candidate is already pending: refresh nothing, re-emit.
        await emitState();
        return;
      }
      if (snapshot.treeHash === acceptedSourceHash) {
        // The filesystem is aligned with the accepted source (a Host
        // self-write or an external revert): drop any pending candidate.
        if (candidate !== null) {
          await staging.delete({ projectId, candidateHash: candidate.candidateHash }).catch(() => undefined);
          candidate = null;
          conflicts = [];
        }
        recomputePhase();
        await emitState();
        return;
      }
      const changed = await changedLogicalPaths(snapshot.entries);
      const valid = !hasErrorSeverity(snapshot.diagnostics);
      candidate = {
        candidateHash: snapshot.treeHash,
        detectedAt: now(),
        valid,
        changedLogicalPaths: changed,
        diagnostics: snapshot.diagnostics,
      };
      conflicts = await computeConflicts(snapshot.entries);
      recomputePhase();
      await emitState();
    });
  }

  // ── Git submission (shared by submit and reconcile) ────────────────────

  /**
   * Run one capability-gated Git submission inside the session queue: the
   * closure materializes/validates (already done by the caller where needed),
   * submits byte-exact entries to the Git port, then — on acceptance —
   * reloads the tree, verifies the resulting source hash, and adopts the
   * aligned snapshot in the SAME serial operation. The outcome is captured
   * through a closure variable because the session port's result carries no
   * run return value.
   */
  async function runSubmission(input: {
    readonly kind: AuthoringOperationKindV1;
    readonly capabilityId: string;
    readonly scopes: readonly string[];
    readonly actorId: string;
    readonly expectedWorkspaceDigest: string;
    readonly entries: readonly { readonly logicalPath: string; readonly content: string }[];
    readonly sourceHash: string;
    readonly message: string;
    /** True only for a full filesystem candidate reconciliation. */
    readonly externalReconciliation: boolean;
  }): Promise<SubmissionRunResult> {
    let outcome: SubmissionRunResult = { status: 'recovery', message: 'submission did not run' };
    const result = await sessions.enqueue({
      projectId,
      capabilityId: input.capabilityId,
      scopes: input.scopes,
      kind: input.kind,
      run: async () => {
        const submitId = `submit-${newId()}`;
        const gitOutcome = await git.submit({
          projectId,
          submitId,
          expectedGitHead: gitHead ?? '',
          expectedWorkspaceDigest: input.expectedWorkspaceDigest,
          entries: input.entries,
          sourceHash: input.sourceHash,
          message: input.message,
          actorId: input.actorId,
          capabilityId: input.capabilityId,
          externalReconciliation: input.externalReconciliation,
        });
        if (gitOutcome.status === 'stale') {
          outcome = { status: 'stale', reason: gitOutcome.reason };
          return;
        }
        if (gitOutcome.status === 'conflict') {
          outcome = { status: 'conflict', reason: gitOutcome.reason };
          return;
        }
        if (gitOutcome.status === 'invalid') {
          outcome = { status: 'invalid', code: gitOutcome.code };
          return;
        }
        // Accepted: reload the primary tree, verify the resulting source
        // hash, and adopt inside the same serial operation. A hash mismatch
        // is a crash-consistency anomaly → recovery-required.
        const tree = await treeLoader.loadTree({ projectId });
        const aligned = buildSnapshot({ projectId, entries: tree.entries });
        if (aligned.sourceHash !== input.sourceHash) {
          outcome = {
            status: 'recovery',
            message: `Git accepted ${submitId} but the reloaded source hash ${aligned.sourceHash} does not match the submitted ${input.sourceHash}`,
          };
          return;
        }
        const adopted = await adopt({ projectId, candidate: aligned });
        if (adopted.status === 'rejected') {
          outcome = {
            status: 'adopt-failed',
            message: `Adoption rejected: ${adopted.diagnostics.map((d) => d.message).join('; ')}`,
          };
          return;
        }
        await documents.seedFromAccepted(aligned);
        outcome = {
          status: 'accepted',
          submitId,
          sourceHash: aligned.sourceHash,
          gitHead: gitOutcome.receipt.commit,
          gitReceiptHash: gitOutcome.receipt.receiptHash,
          treeHash: tree.treeHash,
        };
      },
    });
    if (result.status === 'denied') {
      return { status: 'stale', reason: `capability denied: ${result.reason}` };
    }
    if (result.status === 'failed') {
      return { status: 'recovery', message: result.message };
    }
    return outcome;
  }

  /** Shared post-acceptance bookkeeping for submit and reconcile. */
  async function acceptSubmission(
    outcome: Extract<SubmissionRunResult, { readonly status: 'accepted' }>,
  ): Promise<void> {
    acceptedSourceHash = outcome.sourceHash;
    restoredTerminalPhase = null;
    gitHead = outcome.gitHead;
    pendingSubmitId = null;
    observedFilesystemHash = outcome.treeHash;
    if (candidate !== null) {
      await staging.delete({ projectId, candidateHash: candidate.candidateHash }).catch(() => undefined);
      candidate = null;
      conflicts = [];
    }
    await captureWorkingIdentity();
    recomputePhase('accepted');
    await persistState();
    events.publish({
      type: 'submit-receipt',
      projectId,
      submitId: outcome.submitId,
      gitReceiptHash: outcome.gitReceiptHash,
      acceptedSourceHash: outcome.sourceHash,
      at: now(),
    });
  }

  /** Map a submission outcome onto a receipt and return it. */
  function receiptFromOutcome(
    receipt: AuthoringOperationReceiptV1,
    outcome: SubmissionRunResult,
  ): AuthoringOperationReceiptV1 {
    switch (outcome.status) {
      case 'accepted':
        return updateReceipt(receipt, {
          status: 'completed',
          acceptedSourceHash: outcome.sourceHash,
          workspaceDigest: workspaceDigest,
          gitSubmitId: outcome.submitId,
          gitCommit: outcome.gitHead,
          gitReceiptHash: outcome.gitReceiptHash,
          errorCode: null,
        });
      case 'stale':
        phase = 'stale';
        return updateReceipt(receipt, {
          status: 'stale',
          errorCode: 'WORKSPACE_STALE',
        });
      case 'conflict':
        phase = 'conflict';
        return updateReceipt(receipt, {
          status: 'conflict',
          errorCode: 'CONFLICT_REQUIRES_RESOLUTION',
        });
      case 'invalid':
        phase = 'candidate-invalid';
        return updateReceipt(receipt, {
          status: 'failed',
          errorCode: 'CANDIDATE_INVALID',
        });
      case 'recovery':
      case 'adopt-failed':
        phase = 'recovery-required';
        recoveryPhase = phase;
        return updateReceipt(receipt, {
          status: 'failed',
          errorCode: 'INTERNAL',
        });
    }
  }

  // ── Public surface ─────────────────────────────────────────────────────

  return {
    projectId,

    getState: state,

    listOperations() {
      return [...operations.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    },

    getOperation(operationId: string) {
      return operations.get(operationId) ?? null;
    },

    isAgentPaused(): boolean {
      return (
        phase === 'dual-conflict' ||
        phase === 'candidate-invalid' ||
        phase === 'recovery-required' ||
        phase === 'submitting'
      );
    },

    async refreshWorkingState(): Promise<void> {
      await locked(async () => {
        if (disposed) return;
        await captureWorkingIdentity();
        recomputePhase();
        await emitState();
      });
    },

    async notifyExternalChange(input = {}): Promise<void> {
      if (disposed) return;
      if (notifyTimer === null) {
        notifyTimer = setTimeout(() => {
          notifyTimer = null;
          void processExternalHint().finally(() => {
            for (const waiter of notifyWaiters.splice(0)) waiter();
          });
        }, notifyDebounceMs);
      }
      return new Promise<void>((resolve) => {
        notifyWaiters.push(resolve);
      });
    },

    async submit(input: AuthoringSubmitInput): Promise<AuthoringOperationReceiptV1> {
      return locked(async () => {
        const operationId = newId();
        const createdAt = now();
        let receipt = newReceipt('submit', 'queued', operationId, createdAt);
        events.publish({ type: 'operation-updated', projectId, receipt, at: createdAt });

        if (disposed) {
          receipt = updateReceipt(receipt, { status: 'failed', errorCode: 'INTERNAL' });
          return receipt;
        }

        // Preflight: block reasons, then the two CAS identities.
        const reason = submitBlockReason();
        if (reason !== 'none') {
          receipt = updateReceipt(receipt, {
            status: 'failed',
            errorCode: reason === 'conflict-requires-resolution'
              ? 'CONFLICT_REQUIRES_RESOLUTION'
              : reason === 'candidate-invalid'
                ? 'CANDIDATE_INVALID'
                : 'SUBMIT_BLOCKED',
          });
          return receipt;
        }
        if (input.expectedAcceptedSourceHash !== acceptedSourceHash) {
          receipt = updateReceipt(receipt, {
            status: 'failed',
            errorCode: 'ACCEPTED_HASH_MISMATCH',
          });
          return receipt;
        }
        const digest = await currentWorkspaceDigest();
        if (digest === null || input.expectedWorkspaceDigest !== digest.digest) {
          receipt = updateReceipt(receipt, {
            status: 'failed',
            errorCode: 'WORKSPACE_STALE',
          });
          return receipt;
        }

        phase = 'submitting';
        pendingSubmitId = null;
        await emitState();
        receipt = updateReceipt(receipt, { status: 'running' });

        // Materialize the working-or-accepted candidate inside the gate.
        let runOutcome: SubmissionRunResult = { status: 'recovery', message: 'submit did not run' };
        const sessionResult = await sessions.enqueue({
          projectId,
          capabilityId: input.capabilityId,
          scopes: input.capabilityScopes,
          kind: KIND_SUBMIT,
          run: async () => {
            const descriptors = documents.descriptors();
            const materialized = await documents.materialize({
              projectId,
              documents: descriptors.map((descriptor) => ({
                documentId: descriptor.documentId,
                logicalPath: descriptor.logicalPath,
              })),
            });
            const snapshot = buildSnapshot({ projectId, entries: materialized.entries });
            const diagnostics = validate(snapshot);
            if (hasErrorSeverity(diagnostics)) {
              runOutcome = {
                status: 'invalid',
                code: 'CANDIDATE_INVALID',
              };
              return;
            }
            // The run closure captures the submission outcome through the
            // session port's serialized slot; the port result itself carries
            // no return value.
            let submission: SubmissionRunResult = { status: 'recovery', message: 'git submit did not run' };
            const enqueued = await runSubmissionInternal(input, materialized.entries, snapshot.sourceHash, submission);
            submission = enqueued;
            runOutcome = submission;
          },
        });
        if (sessionResult.status === 'denied') {
          phase = 'clean';
          receipt = updateReceipt(receipt, {
            status: 'failed',
            errorCode: 'SUBMIT_BLOCKED',
          });
          await emitState();
          return receipt;
        }
        if (sessionResult.status === 'failed') {
          phase = 'clean';
          receipt = updateReceipt(receipt, {
            status: 'failed',
            errorCode: 'INTERNAL',
          });
          await emitState();
          return receipt;
        }
        const submissionOutcome = runOutcome as SubmissionRunResult;
        if (submissionOutcome.status === 'accepted') {
          await acceptSubmission(submissionOutcome);
          receipt = receiptFromOutcome(receipt, submissionOutcome);
          await emitState();
          return receipt;
        }
        if (submissionOutcome.status === 'stale' || submissionOutcome.status === 'conflict') {
          await captureWorkingIdentity();
          receipt = receiptFromOutcome(receipt, submissionOutcome);
          await emitState();
          return receipt;
        }
        // invalid / recovery / adopt-failed
        await captureWorkingIdentity();
        receipt = receiptFromOutcome(receipt, submissionOutcome);
        await emitState();
        return receipt;
      });

      /** The inner Git submission used inside the submit gate (single queued op). */
      async function runSubmissionInternal(
        submitInput: AuthoringSubmitInput,
        entries: readonly { readonly logicalPath: string; readonly content: string }[],
        sourceHash: string,
        capture: SubmissionRunResult,
      ): Promise<SubmissionRunResult> {
        const submitId = `submit-${newId()}`;
        pendingSubmitId = submitId;
        phase = 'submitting';
        await persistState();
        const gitOutcome = await git.submit({
          projectId,
          submitId,
          expectedGitHead: gitHead ?? '',
          expectedWorkspaceDigest: submitInput.expectedWorkspaceDigest,
          entries,
          sourceHash,
          message: submitInput.message ?? 'Authoring submit',
          actorId: submitInput.actorId,
          capabilityId: submitInput.capabilityId,
        });
        if (gitOutcome.status !== 'accepted') {
          pendingSubmitId = null;
          await persistState();
          if (gitOutcome.status === 'stale') return { status: 'stale', reason: gitOutcome.reason };
          if (gitOutcome.status === 'conflict') return { status: 'conflict', reason: gitOutcome.reason };
          return { status: 'invalid', code: gitOutcome.code };
        }
        const tree = await treeLoader.loadTree({ projectId });
        const aligned = buildSnapshot({ projectId, entries: tree.entries });
        if (aligned.sourceHash !== sourceHash) {
          return {
            status: 'recovery',
            message: `Git accepted ${submitId} but the reloaded source hash ${aligned.sourceHash} does not match the submitted ${sourceHash}`,
          };
        }
        const adopted = await adopt({ projectId, candidate: aligned });
        if (adopted.status === 'rejected') {
          return {
            status: 'adopt-failed',
            message: `Adoption rejected: ${adopted.diagnostics.map((d) => d.message).join('; ')}`,
          };
        }
        await documents.seedFromAccepted(aligned);
        return {
          status: 'accepted',
          submitId,
          sourceHash: aligned.sourceHash,
          gitHead: gitOutcome.receipt.commit,
          gitReceiptHash: gitOutcome.receipt.receiptHash,
          treeHash: tree.treeHash,
        };
      }
    },

    async reconcileExternal(input: AuthoringReconcileInput): Promise<AuthoringOperationReceiptV1> {
      return locked(async () => {
        const operationId = newId();
        const createdAt = now();
        let receipt = newReceipt(
          input.choice === 'keep-working' ? 'reconcile-external' : 'resolve-conflict',
          'queued',
          operationId,
          createdAt,
        );
        events.publish({ type: 'operation-updated', projectId, receipt, at: createdAt });

        if (disposed) {
          receipt = updateReceipt(receipt, { status: 'failed', errorCode: 'INTERNAL' });
          return receipt;
        }
        if (candidate === null) {
          receipt = updateReceipt(receipt, { status: 'failed', errorCode: 'INVALID_INPUT' });
          return receipt;
        }
        if (input.candidateHash !== null && input.candidateHash !== candidate.candidateHash) {
          receipt = updateReceipt(receipt, { status: 'failed', errorCode: 'WORKSPACE_STALE' });
          return receipt;
        }
        if (input.expectedAcceptedSourceHash !== acceptedSourceHash) {
          receipt = updateReceipt(receipt, {
            status: 'failed',
            errorCode: 'ACCEPTED_HASH_MISMATCH',
          });
          return receipt;
        }

        if (input.choice === 'keep-working') {
          const result = await sessions.enqueue({
            projectId,
            capabilityId: input.capabilityId,
            scopes: input.capabilityScopes,
            kind: KIND_RECONCILE,
            run: async () => {
              // Marker effect: the state transition happens under the
              // coordinator lock after the gate; nothing here touches Git.
            },
          });
          if (result.status === 'denied' || result.status === 'failed') {
            receipt = updateReceipt(receipt, { status: 'failed', errorCode: 'SUBMIT_BLOCKED' });
            return receipt;
          }
          await staging.delete({ projectId, candidateHash: candidate.candidateHash }).catch(() => undefined);
          observedFilesystemHash = candidate.candidateHash;
          candidate = null;
          conflicts = [];
          restoredTerminalPhase = null;
          recomputePhase();
          receipt = updateReceipt(receipt, { status: 'completed' });
          await emitState();
          return receipt;
        }

        // accept-external / apply-proposed-disjoint-merge → Git submission.
        const staged = await staging.get({ projectId, candidateHash: candidate.candidateHash });
        if (staged === null) {
          receipt = updateReceipt(receipt, { status: 'failed', errorCode: 'INTERNAL' });
          return receipt;
        }
        let entries = staged.entries;
        if (input.choice === 'apply-proposed-disjoint-merge') {
          if (conflicts.length > 0) {
            receipt = updateReceipt(receipt, {
              status: 'failed',
              errorCode: 'CONFLICT_REQUIRES_RESOLUTION',
            });
            return receipt;
          }
          const merged = await buildDisjointMerge(staged.entries);
          if (merged === null) {
            receipt = updateReceipt(receipt, {
              status: 'failed',
              errorCode: 'CONFLICT_REQUIRES_RESOLUTION',
            });
            return receipt;
          }
          entries = merged;
        }
        const snapshot = buildSnapshot({ projectId, entries });
        if (hasErrorSeverity(validate(snapshot))) {
          phase = 'candidate-invalid';
          receipt = updateReceipt(receipt, { status: 'failed', errorCode: 'CANDIDATE_INVALID' });
          await emitState();
          return receipt;
        }
        const digest = await currentWorkspaceDigest();
        if (digest === null) {
          receipt = updateReceipt(receipt, { status: 'failed', errorCode: 'WORKSPACE_STALE' });
          return receipt;
        }

        phase = 'submitting';
        await emitState();
        receipt = updateReceipt(receipt, { status: 'running' });

        const outcome = await runSubmission({
          kind: input.choice === 'apply-proposed-disjoint-merge' ? 'resolve-conflict' : 'reconcile-external',
          capabilityId: input.capabilityId,
          scopes: input.capabilityScopes,
          actorId: input.actorId,
          expectedWorkspaceDigest: digest.digest,
          entries,
          sourceHash: snapshot.sourceHash,
          message:
            input.choice === 'apply-proposed-disjoint-merge'
              ? `Apply proposed disjoint merge over external candidate ${candidate.candidateHash.slice(0, 12)}`
              : `Accept external candidate ${candidate.candidateHash.slice(0, 12)}`,
          externalReconciliation: true,
        });

        if (outcome.status === 'accepted') {
          await acceptSubmission(outcome);
          receipt = receiptFromOutcome(receipt, outcome);
          await emitState();
          return receipt;
        }
        if (outcome.status === 'stale' || outcome.status === 'conflict') {
          await captureWorkingIdentity();
          receipt = receiptFromOutcome(receipt, outcome);
          await emitState();
          return receipt;
        }
        await captureWorkingIdentity();
        receipt = receiptFromOutcome(receipt, outcome);
        await emitState();
        return receipt;
      });
    },

    async refreshAccepted(input: { readonly expectedSourceHash: string }): Promise<void> {
      return locked(async () => {
        if (disposed) return;
        const tree = await treeLoader.loadTree({ projectId });
        observedFilesystemHash = tree.treeHash;
        const snapshot = buildSnapshot({ projectId, entries: tree.entries });
        if (snapshot.sourceHash !== input.expectedSourceHash) {
          phase = 'recovery-required';
          recoveryPhase = 'refresh-mismatch';
          await emitState();
          return;
        }
        const result = await sessions.enqueue({
          projectId,
          capabilityId: acceptCapability.capabilityId,
          scopes: acceptCapability.scopes,
          kind: KIND_ACCEPT,
          run: async () => {
            const adopted = await adopt({ projectId, candidate: snapshot });
            if (adopted.status === 'rejected') {
              const error = new Error(
                `Adoption rejected: ${adopted.diagnostics.map((d) => d.message).join('; ')}`,
              ) as Error & { code?: string };
              error.code = 'CANDIDATE_INVALID';
              throw error;
            }
            await documents.seedFromAccepted(snapshot);
          },
        });
        if (result.status !== 'completed') {
          phase = 'recovery-required';
          recoveryPhase = 'adoption-failed';
          await emitState();
          return;
        }
        acceptedSourceHash = snapshot.sourceHash;
        recoveryPhase = null;
        if (candidate !== null) {
          await staging.delete({ projectId, candidateHash: candidate.candidateHash }).catch(() => undefined);
          candidate = null;
          conflicts = [];
        }
        await captureWorkingIdentity();
        recomputePhase();
        await emitState();
      });
    },

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      if (notifyTimer !== null) clearTimeout(notifyTimer);
      notifyTimer = null;
      for (const waiter of notifyWaiters.splice(0)) waiter();
      operations.clear();
    },
  };

  /** Build the proposed disjoint-path merge (working + external over accepted). */
  async function buildDisjointMerge(
    externalEntries: readonly { readonly logicalPath: string; readonly content: string }[],
  ): Promise<readonly { readonly logicalPath: string; readonly content: string }[] | null> {
    const externalByPath = new Map(externalEntries.map((entry) => [entry.logicalPath, entry.content]));
    const externalChanged = new Set<string>();
    for (const entry of externalEntries) {
      const accepted = documents.acceptedContent(entry.logicalPath);
      if (accepted === null || accepted !== entry.content) externalChanged.add(entry.logicalPath);
    }
    for (const path of await documents.acceptedPaths()) {
      if (!externalByPath.has(path)) externalChanged.add(path);
    }
    const workingChanged = new Set<string>();
    const workingByPath = new Map<string, string>();
    for (const descriptor of documents.descriptors()) {
      const working = await documents.materializeDocument(descriptor.documentId);
      if (working === null) continue;
      const accepted = documents.acceptedContent(descriptor.logicalPath);
      if (accepted === null || accepted !== working) {
        workingChanged.add(descriptor.logicalPath);
        workingByPath.set(descriptor.logicalPath, working);
      }
    }
    if (!workingDirty || workingChanged.size === 0) return null;
    // Any same-path difference that is not byte-identical rejects the merge.
    for (const path of workingChanged) {
      if (!externalChanged.has(path)) continue;
      const working = workingByPath.get(path);
      const external = externalByPath.get(path);
      if (working !== external) return null;
    }
    const merged: { logicalPath: string; content: string }[] = [];
    const paths = new Set<string>([...externalByPath.keys(), ...(await documents.acceptedPaths())]);
    for (const path of [...paths].sort(compareLogicalPaths)) {
      if (externalChanged.has(path) && externalByPath.has(path)) {
        merged.push({ logicalPath: path, content: externalByPath.get(path) as string });
      } else if (workingChanged.has(path)) {
        merged.push({ logicalPath: path, content: workingByPath.get(path) as string });
      } else {
        const accepted = documents.acceptedContent(path);
        if (accepted !== null) merged.push({ logicalPath: path, content: accepted });
      }
    }
    return merged;
  }
}

/** Content hash of one manifest entry (identical to the accepted document identity). */
function computeEntryHash(content: string): string {
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Create one per-project AuthoringCoordinator. Fails closed on malformed
 * assembly inputs: a coordinator without every port could never keep the
 * four identities straight or route all write entries through one point.
 */
export async function createAuthoringCoordinator(
  assembly: AuthoringCoordinatorAssembly,
): Promise<AuthoringCoordinator> {
  return createAuthoringCoordinatorImpl(assembly);
}
