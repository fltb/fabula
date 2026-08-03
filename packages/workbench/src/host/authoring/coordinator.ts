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
} from '../../contracts/authoring.js';
import type { AuthoringStateRecord } from '../../contracts/persistence.js';
import type { SourceRefreshResult } from '../project-session.js';
import type { AuthoringCandidateStore } from './filesystem-observer.js';
import type {
  AuthoringCoordinator,
  AuthoringCoordinatorOptions,
  AuthoringReconcileInput,
  AuthoringRevisionContentStore,
  AuthoringSubmitInput,
} from './types.js';
import type { AuthoringWorkingDocumentStore } from './document-store.js';

const MAX_RETAINED_OPERATIONS = 64;
const KIND_SUBMIT: AuthoringOperationKindV1 = 'submit';
const KIND_RECONCILE: AuthoringOperationKindV1 = 'reconcile-external';
const KIND_RESOLVE_CONFLICT: AuthoringOperationKindV1 = 'resolve-conflict';
const EMPTY_DIAGNOSTICS: readonly AuthoringDiagnosticV1[] = [];

type NativeStateRecord = AuthoringStateRecord & {
  readonly acceptedRevisionId?: string;
};

type SubmissionRunResult =
  | { readonly status: 'accepted'; readonly operationId: string; readonly revisionId: string; readonly sourceHash: string; readonly receiptHash: string; readonly treeHash: string }
  | { readonly status: 'stale'; readonly reason: string }
  | { readonly status: 'conflict'; readonly reason: string }
  | { readonly status: 'invalid'; readonly code: string }
  | { readonly status: 'recovery'; readonly message: string }
  | { readonly status: 'adopt-failed'; readonly message: string };

export interface AuthoringCoordinatorAssembly extends AuthoringCoordinatorOptions {
  readonly documents: AuthoringWorkingDocumentStore;
  readonly staging: AuthoringCandidateStore;
  readonly revisionContentStore: AuthoringRevisionContentStore;
  readonly persistence: AuthoringCoordinatorPersistence;
  readonly buildSnapshot: (input: { readonly projectId: string; readonly entries: readonly { readonly logicalPath: string; readonly content: string }[] }) => ProjectSourceSnapshotV1;
  readonly validate: (candidate: ProjectSourceSnapshotV1) => readonly AuthoringDiagnosticV1[];
  readonly adopt: (input: { readonly projectId: string; readonly candidate: ProjectSourceSnapshotV1 }) => Promise<SourceRefreshResult>;
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
function hashBundle(entries: readonly { readonly logicalPath: string; readonly content: string }[]): string {
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

export async function createAuthoringCoordinator(assembly: AuthoringCoordinatorAssembly): Promise<AuthoringCoordinator> {
  const {
    projectId, materializer, treeLoader, sessions, revision, sourceViewMaterializer, events,
    documents, staging, revisionContentStore, persistence, buildSnapshot, validate, adopt,
  } = assembly;
  if (typeof projectId !== 'string' || projectId.length === 0) throw new TypeError('AuthoringCoordinator requires a non-empty projectId');
  for (const [name, port] of [
    ['materializer', materializer], ['treeLoader', treeLoader], ['sessions', sessions], ['revision', revision],
    ['sourceViewMaterializer', sourceViewMaterializer], ['events', events], ['documents', documents],
    ['staging', staging], ['revisionContentStore', revisionContentStore], ['persistence', persistence],
    ['buildSnapshot', buildSnapshot], ['validate', validate], ['adopt', adopt],
  ] as const) {
    if (port === null || port === undefined || (typeof port !== 'object' && typeof port !== 'function')) throw new TypeError(`AuthoringCoordinator requires an injected ${name} port`);
  }
  if (materializer !== documents) throw new TypeError('AuthoringCoordinator materializer must be the same instance as documents');
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
  const operations = new Map<string, AuthoringOperationReceiptV1>();
  let lockTail: Promise<void> = Promise.resolve();
  let notifyTimer: ReturnType<typeof setTimeout> | null = null;
  const notifyWaiters: (() => void)[] = [];

  if (assembly.initialAccepted !== undefined && assembly.initialAccepted !== null) await documents.seedFromAccepted(assembly.initialAccepted);
  if (acceptedRevisionId === null) {
    const loaded = await revision.loadAccepted(projectId);
    if (loaded !== null) { acceptedRevisionId = loaded.revisionId; acceptedSourceHash = loaded.sourceHash; }
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
      else candidate = { candidateHash: native.candidateHash, detectedAt: native.updatedAt, valid: native.candidateValid, changedLogicalPaths: [], diagnostics: [] };
    }
    recoveryPhase ??= native.recoveryPhase ?? null;
    if (pendingOperationId !== null) recoveryPhase ??= 'operation-recovery-required';
    if (native.phase === 'stale' || native.phase === 'conflict') { restoredTerminalPhase = native.phase; phase = native.phase; }
    else if (AUTHORING_PHASE_VALUES.includes(native.phase as AuthoringPhaseV1) && native.phase === 'recovery-required') recoveryPhase ??= native.recoveryPhase ?? 'persisted-recovery-required';
  }
  await captureWorkingIdentity();
  recomputePhase();

  function locked<T>(run: () => Promise<T>): Promise<T> {
    const slot = lockTail.then(run, run); lockTail = slot.then(() => undefined, () => undefined); return slot;
  }
  function newReceipt(kind: AuthoringOperationKindV1, status: AuthoringOperationReceiptV1['status'], operationId: string, createdAt: string): AuthoringOperationReceiptV1 {
    const receipt: AuthoringOperationReceiptV1 = { version: AUTHORING_CONTRACT_VERSION, operationId, projectId, kind, status, acceptedSourceHash, acceptedRevisionId, pendingOperationId, revisionId: null, receiptHash: null, errorCode: null, createdAt, updatedAt: createdAt };
    operations.set(operationId, receipt);
    while (operations.size > MAX_RETAINED_OPERATIONS) { const oldest = operations.keys().next().value; if (oldest === undefined) break; operations.delete(oldest); }
    return receipt;
  }
  function updateReceipt(receipt: AuthoringOperationReceiptV1, patch: Partial<AuthoringOperationReceiptV1>): AuthoringOperationReceiptV1 {
    const updated = { ...receipt, ...patch, updatedAt: now() };
    operations.set(receipt.operationId, updated);
    events.publish({ type: 'operation-updated', projectId, receipt: updated, at: updated.updatedAt });
    return updated;
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
    return { version: AUTHORING_CONTRACT_VERSION, projectId, phase, acceptedSourceHash, acceptedRevisionId, pendingOperationId, workingDirty, workspaceDigest, externalCandidate: candidate, conflicts, diagnostics: candidate?.diagnostics ?? EMPTY_DIAGNOSTICS, canSubmit: reason === 'none', submitBlockReason: reason, generatedAt: now() };
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
  async function persistState(): Promise<void> { await persistence.save(persistenceRecord()); }
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
    if (recoveryPhase !== null) { phase = 'recovery-required'; return; }
    if (restoredTerminalPhase !== null) { phase = restoredTerminalPhase; return; }
    if (candidate === null) { phase = workingDirty ? 'working-dirty' : cleanPhase; return; }
    phase = !candidate.valid ? 'candidate-invalid' : workingDirty ? 'dual-conflict' : 'external-pending';
  }
  async function captureWorkingIdentity(): Promise<void> { workingDirty = await documents.isWorkingDirty(); const digest = await documents.workspaceDigest(); workspaceDigest = digest?.digest ?? null; }
  async function changedLogicalPaths(entries: readonly { readonly logicalPath: string; readonly content: string }[]): Promise<readonly string[]> {
    const changed = new Set<string>(); const paths = new Set(entries.map((entry) => entry.logicalPath));
    for (const path of await documents.acceptedPaths()) if (!paths.has(path)) changed.add(path);
    for (const entry of entries) { const accepted = documents.acceptedContent(entry.logicalPath); if (accepted === null || accepted !== entry.content) changed.add(entry.logicalPath); }
    return [...changed].sort(compareLogicalPaths);
  }
  async function computeConflicts(entries: readonly { readonly logicalPath: string; readonly content: string }[]): Promise<readonly AuthoringConflictV1[]> {
    const external = new Map(entries.map((entry) => [entry.logicalPath, entry.content])); const found: AuthoringConflictV1[] = [];
    for (const descriptor of documents.descriptors()) {
      const content = external.get(descriptor.logicalPath); if (content === undefined) continue;
      const working = await documents.workingContentHash(descriptor.documentId); const accepted = documents.acceptedContentHash(descriptor.logicalPath);
      if (working === null || working === accepted) continue; const externalHash = hashEntry(content);
      if (externalHash === accepted || externalHash === working) continue;
      found.push({ logicalPath: descriptor.logicalPath, kind: 'working-vs-external', baseSourceHash: acceptedSourceHash ?? '', workingHash: working, externalHash, proposedDisjointMerge: false });
    }
    return found;
  }
  async function processExternalHint(): Promise<void> {
    await locked(async () => {
      if (disposed) return; const snapshot = await treeLoader.loadTree({ projectId }); observedFilesystemHash = snapshot.treeHash;
      if (candidate !== null && snapshot.treeHash === candidate.candidateHash) { await emitState(); return; }
      if (snapshot.treeHash === acceptedSourceHash) {
        if (candidate !== null) { await staging.delete({ projectId, candidateHash: candidate.candidateHash }).catch(() => undefined); candidate = null; conflicts = []; }
        recomputePhase(); await emitState(); return;
      }
      await staging.put({ projectId, candidateHash: snapshot.treeHash, entries: snapshot.entries });
      candidate = { candidateHash: snapshot.treeHash, detectedAt: now(), valid: !hasErrorSeverity(snapshot.diagnostics), changedLogicalPaths: await changedLogicalPaths(snapshot.entries), diagnostics: snapshot.diagnostics };
      conflicts = await computeConflicts(snapshot.entries); recomputePhase(); await emitState();
    });
  }

  async function runNativeSubmission(input: { readonly kind: AuthoringOperationKindV1; readonly operationId: string; readonly capabilityId: string; readonly scopes: readonly string[]; readonly actorId: string; readonly entries: readonly { readonly logicalPath: string; readonly content: string }[]; readonly sourceHash: string }): Promise<SubmissionRunResult> {
    let outcome: SubmissionRunResult = { status: 'recovery', message: 'submission did not run' };
    const result = await sessions.enqueue({ projectId, capabilityId: input.capabilityId, scopes: input.scopes, kind: input.kind, run: async () => {
      const inspected = await sourceViewMaterializer.inspect(projectId); const bundleHash = hashBundle(input.entries);
      try { await revisionContentStore.put({ projectId, bundleHash, entries: input.entries }); } catch (error) { outcome = { status: 'recovery', message: error instanceof Error ? error.message : 'revision bundle persistence failed' }; return; }
      pendingOperationId = input.operationId; await persistState();
      const accepted = await revision.submit({ projectId, candidate: { entries: input.entries, sourceHash: input.sourceHash, bundleHash }, expectedRevisionId: acceptedRevisionId, expectedSourceHash: acceptedSourceHash, operationId: input.operationId, actorId: input.actorId });
      if (accepted.status === 'stale' || accepted.status === 'conflict') { pendingOperationId = null; await persistState(); outcome = { status: accepted.status, reason: accepted.reason }; return; }
      if (accepted.status === 'invalid') { pendingOperationId = null; await persistState(); outcome = { status: 'invalid', code: accepted.code }; return; }
      const materialized = await sourceViewMaterializer.materialize({ projectId, expectedMaterializedRevisionId: inspected.materializedRevisionId, expectedTreeHash: inspected.treeHash, bundle: { bundleHash, entries: input.entries } });
      if (materialized.status !== 'completed') { outcome = { status: 'recovery', message: materialized.reason }; return; }
      const tree = await treeLoader.loadTree({ projectId }); const aligned = buildSnapshot({ projectId, entries: tree.entries });
      if (aligned.sourceHash !== input.sourceHash || materialized.treeHash !== input.sourceHash) { outcome = { status: 'recovery', message: `Materialized source hash ${aligned.sourceHash} does not match revision ${input.sourceHash}` }; return; }
      const adopted = await adopt({ projectId, candidate: aligned });
      if (adopted.status === 'rejected') { outcome = { status: 'adopt-failed', message: adopted.diagnostics.map((diagnostic) => diagnostic.message).join('; ') }; return; }
      await documents.seedFromAccepted(aligned); acceptedRevisionId = accepted.revisionId; acceptedSourceHash = aligned.sourceHash; pendingOperationId = null; observedFilesystemHash = materialized.treeHash;
      outcome = { status: 'accepted', operationId: input.operationId, revisionId: accepted.revisionId, sourceHash: aligned.sourceHash, receiptHash: accepted.receiptHash, treeHash: materialized.treeHash }; await persistState();
    } });
    if (result.status === 'denied') return { status: 'stale', reason: `capability denied: ${result.reason}` };
    if (result.status === 'failed') return { status: 'recovery', message: result.message };
    return outcome;
  }
  async function acceptSubmission(outcome: Extract<SubmissionRunResult, { status: 'accepted' }>): Promise<void> {
    acceptedRevisionId = outcome.revisionId; acceptedSourceHash = outcome.sourceHash; pendingOperationId = null; observedFilesystemHash = outcome.treeHash; restoredTerminalPhase = null;
    if (candidate !== null) { await staging.delete({ projectId, candidateHash: candidate.candidateHash }).catch(() => undefined); candidate = null; conflicts = []; }
    await captureWorkingIdentity(); recomputePhase('accepted'); await persistState();
    events.publish({ type: 'submit-receipt', projectId, operationId: outcome.operationId, receiptHash: outcome.receiptHash, acceptedSourceHash: outcome.sourceHash, at: now() });
  }
  function receiptFromOutcome(receipt: AuthoringOperationReceiptV1, outcome: SubmissionRunResult): AuthoringOperationReceiptV1 {
    if (outcome.status === 'accepted') return updateReceipt(receipt, { status: 'completed', acceptedSourceHash: outcome.sourceHash, acceptedRevisionId: outcome.revisionId, pendingOperationId: null, revisionId: outcome.revisionId, receiptHash: outcome.receiptHash, errorCode: null });
    if (outcome.status === 'stale') { phase = 'stale'; return updateReceipt(receipt, { status: 'stale', errorCode: 'WORKSPACE_STALE' }); }
    if (outcome.status === 'conflict') { phase = 'conflict'; return updateReceipt(receipt, { status: 'conflict', errorCode: 'CONFLICT_REQUIRES_RESOLUTION' }); }
    if (outcome.status === 'invalid') { phase = 'candidate-invalid'; return updateReceipt(receipt, { status: 'failed', errorCode: outcome.code }); }
    phase = 'recovery-required'; recoveryPhase = outcome.message; return updateReceipt(receipt, { status: 'failed', errorCode: 'INTERNAL' });
  }

  const submit = async (input: AuthoringSubmitInput): Promise<AuthoringOperationReceiptV1> => locked(async () => {
    const operationId = newId(); let receipt = newReceipt('submit', 'queued', operationId, now());
    if (disposed) return updateReceipt(receipt, { status: 'failed', errorCode: 'INTERNAL' });
    const reason = submitBlockReason();
    if (reason !== 'none') return updateReceipt(receipt, { status: 'failed', errorCode: reason === 'conflict-requires-resolution' ? 'CONFLICT_REQUIRES_RESOLUTION' : reason === 'candidate-invalid' ? 'CANDIDATE_INVALID' : 'SUBMIT_BLOCKED' });
    if (input.expectedAcceptedSourceHash !== acceptedSourceHash) return updateReceipt(receipt, { status: 'failed', errorCode: 'ACCEPTED_HASH_MISMATCH' });
    const digest = await documents.workspaceDigest(); if (digest === null || digest.digest !== input.expectedWorkspaceDigest) return updateReceipt(receipt, { status: 'failed', errorCode: 'WORKSPACE_STALE' });
    phase = 'submitting'; pendingOperationId = operationId; await emitState(); receipt = updateReceipt(receipt, { status: 'running', pendingOperationId: operationId });
    const descriptors = documents.descriptors(); const materialized = await documents.materialize({ projectId, documents: descriptors.map((descriptor) => ({ documentId: descriptor.documentId, logicalPath: descriptor.logicalPath })) });
    const snapshot = buildSnapshot({ projectId, entries: materialized.entries });
    if (hasErrorSeverity(validate(snapshot))) { pendingOperationId = null; phase = 'candidate-invalid'; await persistState(); return updateReceipt(receipt, { status: 'failed', errorCode: 'CANDIDATE_INVALID', pendingOperationId: null }); }
    const outcome = await runNativeSubmission({ kind: KIND_SUBMIT, operationId, capabilityId: input.capabilityId, scopes: input.capabilityScopes, actorId: input.actorId, entries: materialized.entries, sourceHash: snapshot.sourceHash });
    if (outcome.status === 'accepted') await acceptSubmission(outcome); else await captureWorkingIdentity(); receipt = receiptFromOutcome(receipt, outcome); await emitState(); return receipt;
  });

  const reconcileExternal = async (input: AuthoringReconcileInput): Promise<AuthoringOperationReceiptV1> => locked(async () => {
    const operationId = newId(); let receipt = newReceipt(input.choice === 'keep-working' ? 'reconcile-external' : 'resolve-conflict', 'queued', operationId, now());
    if (disposed || candidate === null) return updateReceipt(receipt, { status: 'failed', errorCode: 'INVALID_INPUT' });
    if (input.candidateHash !== null && input.candidateHash !== candidate.candidateHash) return updateReceipt(receipt, { status: 'failed', errorCode: 'WORKSPACE_STALE' });
    if (input.expectedAcceptedSourceHash !== acceptedSourceHash) return updateReceipt(receipt, { status: 'failed', errorCode: 'ACCEPTED_HASH_MISMATCH' });
    if (input.choice === 'keep-working') {
      const result = await sessions.enqueue({ projectId, capabilityId: input.capabilityId, scopes: input.capabilityScopes, kind: KIND_RECONCILE, run: async () => undefined });
      if (result.status !== 'completed') return updateReceipt(receipt, { status: 'failed', errorCode: 'SUBMIT_BLOCKED' });
      await staging.delete({ projectId, candidateHash: candidate.candidateHash }).catch(() => undefined); observedFilesystemHash = candidate.candidateHash; candidate = null; conflicts = []; recomputePhase(); await emitState(); return updateReceipt(receipt, { status: 'completed' });
    }
    const staged = await staging.get({ projectId, candidateHash: candidate.candidateHash }); if (staged === null) return updateReceipt(receipt, { status: 'failed', errorCode: 'INTERNAL' });
    let entries = staged.entries;
    if (input.choice === 'apply-proposed-disjoint-merge') { if (conflicts.length > 0) return updateReceipt(receipt, { status: 'failed', errorCode: 'CONFLICT_REQUIRES_RESOLUTION' }); const merged = await buildDisjointMerge(staged.entries); if (merged === null) return updateReceipt(receipt, { status: 'failed', errorCode: 'CONFLICT_REQUIRES_RESOLUTION' }); entries = merged; }
    const snapshot = buildSnapshot({ projectId, entries }); if (hasErrorSeverity(validate(snapshot))) { phase = 'candidate-invalid'; await emitState(); return updateReceipt(receipt, { status: 'failed', errorCode: 'CANDIDATE_INVALID' }); }
    const digest = await documents.workspaceDigest(); if (digest === null) return updateReceipt(receipt, { status: 'failed', errorCode: 'WORKSPACE_STALE' });
    phase = 'submitting'; receipt = updateReceipt(receipt, { status: 'running', pendingOperationId: operationId });
    const outcome = await runNativeSubmission({ kind: input.choice === 'apply-proposed-disjoint-merge' ? KIND_RESOLVE_CONFLICT : KIND_RECONCILE, operationId, capabilityId: input.capabilityId, scopes: input.capabilityScopes, actorId: input.actorId, entries, sourceHash: snapshot.sourceHash });
    if (outcome.status === 'accepted') await acceptSubmission(outcome); else await captureWorkingIdentity(); receipt = receiptFromOutcome(receipt, outcome); await emitState(); return receipt;
  });

  const refreshAccepted = async (input: { readonly expectedSourceHash: string }): Promise<void> => locked(async () => {
    if (disposed) return; const loaded = await revision.loadAccepted(projectId);
    if (loaded === null || loaded.sourceHash !== input.expectedSourceHash) { recoveryPhase = 'refresh-mismatch'; recomputePhase(); await emitState(); return; }
    const tree = await treeLoader.loadTree({ projectId }); const snapshot = buildSnapshot({ projectId, entries: tree.entries });
    if (snapshot.sourceHash !== loaded.sourceHash) { recoveryPhase = 'refresh-tree-mismatch'; recomputePhase(); await emitState(); return; }
    const result = await sessions.enqueue({ projectId, capabilityId: acceptCapability.capabilityId, scopes: acceptCapability.scopes, kind: KIND_RECONCILE, run: async () => { const adopted = await adopt({ projectId, candidate: snapshot }); if (adopted.status === 'rejected') throw new Error('accepted source adoption failed'); await documents.seedFromAccepted(snapshot); } });
    if (result.status !== 'completed') { recoveryPhase = 'adoption-failed'; recomputePhase(); await emitState(); return; }
    acceptedRevisionId = loaded.revisionId; acceptedSourceHash = loaded.sourceHash; observedFilesystemHash = tree.treeHash; recoveryPhase = null; await captureWorkingIdentity(); recomputePhase('accepted'); await emitState();
  });

  async function buildDisjointMerge(externalEntries: readonly { readonly logicalPath: string; readonly content: string }[]): Promise<readonly { readonly logicalPath: string; readonly content: string }[] | null> {
    const externalByPath = new Map(externalEntries.map((entry) => [entry.logicalPath, entry.content])); const externalChanged = new Set<string>();
    for (const entry of externalEntries) { const accepted = documents.acceptedContent(entry.logicalPath); if (accepted === null || accepted !== entry.content) externalChanged.add(entry.logicalPath); }
    for (const path of await documents.acceptedPaths()) if (!externalByPath.has(path)) externalChanged.add(path);
    const workingChanged = new Set<string>(); const workingByPath = new Map<string, string>();
    for (const descriptor of documents.descriptors()) { const content = await documents.materializeDocument(descriptor.documentId); if (content === null) continue; const accepted = documents.acceptedContent(descriptor.logicalPath); if (accepted === null || accepted !== content) { workingChanged.add(descriptor.logicalPath); workingByPath.set(descriptor.logicalPath, content); } }
    if (!workingDirty || workingChanged.size === 0) return null;
    for (const path of workingChanged) if (externalChanged.has(path) && workingByPath.get(path) !== externalByPath.get(path)) return null;
    const merged: { logicalPath: string; content: string }[] = []; const paths = new Set<string>([...externalByPath.keys(), ...(await documents.acceptedPaths())]);
    for (const path of [...paths].sort(compareLogicalPaths)) { if (externalChanged.has(path) && externalByPath.has(path)) merged.push({ logicalPath: path, content: externalByPath.get(path) as string }); else if (workingChanged.has(path)) merged.push({ logicalPath: path, content: workingByPath.get(path) as string }); else { const accepted = documents.acceptedContent(path); if (accepted !== null) merged.push({ logicalPath: path, content: accepted }); } }
    return merged;
  }

  return {
    projectId,
    getState: state,
    listOperations: () => [...operations.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)),
    getOperation: (operationId) => operations.get(operationId) ?? null,
    isAgentPaused: () => phase === 'dual-conflict' || phase === 'candidate-invalid' || phase === 'recovery-required' || phase === 'submitting',
    refreshWorkingState: async () => locked(async () => { if (disposed) return; await captureWorkingIdentity(); recomputePhase(); await emitState(); }),
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
      operations.clear();
    },
    submit,
    reconcileExternal,
    refreshAccepted,
  };
}
