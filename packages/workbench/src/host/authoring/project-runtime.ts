import { createHash, randomUUID } from 'node:crypto';
import type { PluginExtensionSchemaRegistrar, ProjectSourceSnapshotV1 } from '@novalistically/core';
import {
  buildSourceSnapshot,
  computeSourceDocumentHash,
  extensionDiagnosticsForSnapshot,
} from '@novalistically/core/source';
import type {
  FileProjectStatusReporter,
  ProjectAuthorityTokenV1,
  ProjectWriteCoordinator,
} from '@novalistically/node-host';
import type { WorkbenchRevisionMirrorConfigurationV2 } from '@novalistically/workbench-protocol';
import type { SourceRevisionReceipt } from '../../contracts/persistence.js';
import {
  createProjectOperationStore,
  type ProjectOperationStore,
} from '../../persistence/project-operation-store.js';
import type { PersistenceWorkerClient } from '../../persistence/worker-client.js';
import type { AgentCapabilityService } from '../agent/capability-service.js';
import { createGitRevisionMirror } from '../git/revision-mirror.js';
import { ControlledGitRunner } from '../git/runner.js';
import { buildWorkflowStatusForSession } from '../mcp/registry.js';
import type { ProjectSession } from '../project-session.js';
import type { YjsWorkingDocumentCore } from '../yjs/gateway.js';
import { type AuthoringCoordinatorPersistence, createAuthoringCoordinator } from './coordinator.js';
import {
  type AuthoringWorkingDocumentStore,
  createAuthoringDocumentStore,
} from './document-store.js';
import {
  type AuthoringFilesystemObserver,
  createAuthoringFilesystemObserver,
  createFileCandidateStore,
  createFileTreeLoader,
} from './filesystem-observer.js';
import { createFileRevisionContentStore } from './native-revision-content-store.js';
import { createFileSourceViewMaterializer } from './source-view-materializer.js';
import type {
  AuthoringCoordinator,
  AuthoringCoordinatorEvent,
  AuthoringEventPublisher,
  AuthoringRevisionPort,
  AuthoringSessionOperationPort,
} from './types.js';

export interface ProjectAuthoringRuntime {
  readonly projectId: string;
  readonly documents: AuthoringWorkingDocumentStore;
  readonly coordinator: AuthoringCoordinator;
  readonly revision: AuthoringRevisionPort;
  readonly observer: AuthoringFilesystemObserver;
  dispose(): Promise<void>;
}

export interface CreateProjectAuthoringRuntimeOptions {
  readonly projectId: string;
  readonly projectRoot: string;
  readonly hostStagingRoot: string;
  readonly session: ProjectSession;
  readonly capabilities: AgentCapabilityService;
  readonly persistence: PersistenceWorkerClient;
  readonly revisionMirror?: WorkbenchRevisionMirrorConfigurationV2;
  readonly yjsCore: YjsWorkingDocumentCore;
  readonly events: AuthoringEventPublisher;
  /**
   * Project authority lease. When present (production launch), every accepted
   * source materialization runs under {@link authorityToken}; a lost lease
   * surfaces as `recovery-required` instead of a tree write. Absent
   * (standalone/tests) the materializer behaves exactly as before.
   */
  readonly coordinator?: ProjectWriteCoordinator;
  readonly authorityToken?: ProjectAuthorityTokenV1;
  /**
   * Best-effort derived status writer for `PROJECT_STATUS.md`. Refreshed after
   * every accepted submit; a write failure only marks the reporter degraded
   * and never rolls back the accepted revision. Absent (tests/standalone)
   * skips the refresh entirely.
   */
  readonly statusReporter?: FileProjectStatusReporter;
  /**
   * Durable per-project operation queue. Absent (tests/standalone) the
   * runtime derives one from {@link persistence} so the coordinator's
   * operation surface is always durable in production.
   */
  readonly operationStore?: ProjectOperationStore;
  /**
   * Enabled-plugin extension gate (plan 7.5). When present, working-layer
   * candidate diagnostics include unknown/disabled EventFile `extensions`
   * namespaces as error-severity source diagnostics; absent → legacy.
   */
  readonly extensionRegistrar?: PluginExtensionSchemaRegistrar;
  readonly now?: () => string;
}

function snapshotFromEntries(input: {
  readonly entries: readonly { readonly logicalPath: string; readonly content: string }[];
}): ProjectSourceSnapshotV1 {
  return buildSourceSnapshot(
    input.entries.map((entry) => ({
      version: 1 as const,
      logicalPath: entry.logicalPath,
      content: entry.content,
      contentHash: computeSourceDocumentHash(entry.content),
      parseResult: { status: 'parsed' as const, value: null },
      diagnostics: [],
    })),
  );
}

function diagnosticsFor(
  session: ProjectSession,
  candidate: ProjectSourceSnapshotV1,
  extensionRegistrar?: PluginExtensionSchemaRegistrar,
): readonly {
  readonly code: string;
  readonly severity: 'error' | 'warning' | 'info';
  readonly message: string;
  readonly logicalPath: string | null;
}[] {
  const diagnostics: {
    code: string;
    severity: 'error' | 'warning' | 'info';
    message: string;
    logicalPath: string | null;
  }[] = [];
  for (const document of candidate.documents) {
    for (const diagnostic of document.diagnostics)
      diagnostics.push({
        code: diagnostic.code,
        severity: diagnostic.severity,
        message: diagnostic.message,
        logicalPath: diagnostic.logicalPath,
      });
    if (document.parseResult.status !== 'parsed')
      diagnostics.push({
        code: 'source.parse_failed',
        severity: 'error',
        message: `Document ${document.logicalPath} did not parse.`,
        logicalPath: document.logicalPath,
      });
  }
  try {
    session.runtime.compile(candidate);
  } catch {
    diagnostics.push({
      code: 'source.compile_failed',
      severity: 'error',
      message: 'The candidate cannot be compiled by the project runtime.',
      logicalPath: null,
    });
  }
  // Enabled-plugin extension gate (plan 7.5): unknown/disabled EventFile
  // `extensions` namespaces are source errors in the working layer too.
  if (extensionRegistrar !== undefined) {
    diagnostics.push(...extensionDiagnosticsForSnapshot(candidate, extensionRegistrar));
  }
  return diagnostics;
}

function hashBundle(
  entries: readonly { readonly logicalPath: string; readonly content: string }[],
): string {
  const canonical = JSON.stringify({
    entries: [...entries]
      .sort((left, right) =>
        left.logicalPath < right.logicalPath ? -1 : left.logicalPath > right.logicalPath ? 1 : 0,
      )
      .map((entry) => ({ logicalPath: entry.logicalPath, content: entry.content })),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function createNativeRevisionPort(options: {
  readonly projectId: string;
  readonly persistence: PersistenceWorkerClient;
  readonly contentStore: ReturnType<typeof createFileRevisionContentStore>;
  readonly treeLoader: ReturnType<typeof createFileTreeLoader>;
  readonly sourceViewMaterializer: ReturnType<typeof createFileSourceViewMaterializer>;
  readonly now: () => string;
}): AuthoringRevisionPort {
  const { persistence, contentStore, treeLoader, sourceViewMaterializer, now } = options;
  const headFor = async (
    id: string,
  ): Promise<{
    readonly revisionId: string;
    readonly sourceHash: string;
    readonly bundleHash: string;
  } | null> => {
    const head = await persistence.request('getSourceHead', { projectId: id });
    if (head?.acceptedRevisionId === undefined || head.acceptedSourceHash === undefined)
      return null;
    const revision = await persistence.request('getSourceRevision', {
      revisionId: head.acceptedRevisionId,
    });
    return revision === null
      ? null
      : {
          revisionId: revision.revisionId,
          sourceHash: revision.sourceHash,
          bundleHash: revision.bundleHash,
        };
  };
  const receiptResult = (
    receipt: SourceRevisionReceipt,
  ): Awaited<ReturnType<AuthoringRevisionPort['submit']>> => {
    if (receipt.phase === 'stale')
      return { status: 'stale', reason: 'native revision operation was already stale' };
    if (receipt.phase === 'conflict')
      return { status: 'conflict', reason: 'native revision operation was already conflicted' };
    if (receipt.revisionId === undefined)
      return {
        status: 'invalid',
        code: 'RECOVERY_REQUIRED',
        reason: 'native operation has no revision receipt',
      };
    return { status: 'accepted', revisionId: receipt.revisionId, receiptHash: receipt.receiptHash };
  };
  const submit: AuthoringRevisionPort['submit'] = async (input) => {
    const canonicalBundleHash = hashBundle(input.candidate.entries);
    const existing = await persistence.request('loadSourceRevisionOperation', {
      operationId: input.operationId,
    });
    if (
      existing !== null &&
      existing.revisionId !== undefined &&
      (existing.phase === 'accepted' ||
        existing.phase === 'materializing' ||
        existing.phase === 'materialized' ||
        existing.phase === 'completed')
    ) {
      if (existing.receiptHash === undefined)
        return {
          status: 'invalid',
          code: 'RECOVERY_REQUIRED',
          reason: 'native operation has no receipt hash',
        };
      return {
        status: 'accepted',
        revisionId: existing.revisionId,
        receiptHash: existing.receiptHash,
      };
    }
    const replay = await persistence.request('replaySourceRevisionReceipt', {
      operationId: input.operationId,
    });
    if (replay !== null) return receiptResult(replay);
    const current = await persistence.request('getSourceHead', { projectId: input.projectId });
    const currentRevision = current?.acceptedRevisionId ?? null;
    const currentHash = current?.acceptedSourceHash ?? null;
    if (currentRevision !== input.expectedRevisionId || currentHash !== input.expectedSourceHash)
      return { status: 'stale', reason: 'accepted native revision changed' };
    const createdAt = now();
    await persistence.request('createSourceRevisionOperation', {
      operationId: input.operationId,
      projectId: input.projectId,
      expectedRevisionId: input.expectedRevisionId ?? undefined,
      expectedSourceHash: input.expectedSourceHash ?? undefined,
      phase: 'prepared',
      createdAt,
      updatedAt: createdAt,
    });
    const revisionId = randomUUID();
    await persistence.request('createSourceRevision', {
      revisionId,
      projectId: input.projectId,
      parentRevisionId: input.expectedRevisionId ?? undefined,
      operationId: input.operationId,
      sourceHash: input.candidate.sourceHash,
      bundleHash: canonicalBundleHash,
      actorId: input.actorId,
      origin: 'authoring',
      createdAt,
      acceptedAt: createdAt,
    });
    const cas = await persistence.request('casSourceHead', {
      projectId: input.projectId,
      expectedAcceptedRevisionId: input.expectedRevisionId ?? undefined,
      expectedAcceptedSourceHash: input.expectedSourceHash ?? undefined,
      acceptedRevisionId: revisionId,
      acceptedSourceHash: input.candidate.sourceHash,
      updatedAt: createdAt,
    });
    if (!cas.applied) {
      await persistence.request('checkpointSourceRevisionOperation', {
        operationId: input.operationId,
        projectId: input.projectId,
        expectedRevisionId: input.expectedRevisionId ?? undefined,
        expectedSourceHash: input.expectedSourceHash ?? undefined,
        revisionId,
        phase: 'stale',
        diagnostic: 'accepted native revision changed',
        createdAt,
        updatedAt: now(),
      });
      return { status: 'stale', reason: 'accepted native revision changed' };
    }
    const receiptHash = createHash('sha256')
      .update(`${input.operationId}:${revisionId}:${input.candidate.sourceHash}`, 'utf8')
      .digest('hex');
    await persistence.request('checkpointSourceRevisionOperation', {
      operationId: input.operationId,
      projectId: input.projectId,
      expectedRevisionId: input.expectedRevisionId ?? undefined,
      expectedSourceHash: input.expectedSourceHash ?? undefined,
      revisionId,
      phase: 'accepted',
      receiptHash,
      createdAt,
      updatedAt: now(),
    });
    return { status: 'accepted', revisionId, receiptHash };
  };
  const revision: AuthoringRevisionPort = {
    async loadAccepted(id) {
      return headFor(id);
    },
    submit,
    async recover(id) {
      const current = await headFor(id);
      const tree = await treeLoader.loadTree({ projectId: id });
      const inspected = await sourceViewMaterializer.inspect(id);
      if (current !== null) {
        if (tree.treeHash !== current.sourceHash)
          return {
            status: 'recovery-required',
            reason: 'materialized source differs from accepted native revision',
          };
        if (inspected.materializedRevisionId === current.revisionId)
          return {
            status: 'completed',
            revisionId: current.revisionId,
            materializedRevisionId: current.revisionId,
          };
        const bundle = await contentStore.get({ projectId: id, bundleHash: current.bundleHash });
        if (bundle === null)
          return {
            status: 'recovery-required',
            reason: 'accepted native revision bundle is missing',
          };
        const outcome = await sourceViewMaterializer.materialize({
          projectId: id,
          expectedMaterializedRevisionId: inspected.materializedRevisionId,
          expectedTreeHash: inspected.treeHash,
          bundle: { bundleHash: current.bundleHash, entries: bundle.entries },
        });
        if (outcome.status !== 'completed')
          return { status: 'recovery-required', reason: outcome.reason };
        return {
          status: 'completed',
          revisionId: current.revisionId,
          materializedRevisionId: current.revisionId,
        };
      }
      const baseline = {
        entries: tree.entries.map((entry) => ({
          logicalPath: entry.logicalPath,
          content: entry.content,
        })),
      };
      const hash = hashBundle(baseline.entries);
      await contentStore.put({ projectId: id, bundleHash: hash, entries: baseline.entries });
      const accepted = await submit({
        projectId: id,
        candidate: { entries: baseline.entries, sourceHash: tree.treeHash, bundleHash: hash },
        expectedRevisionId: null,
        expectedSourceHash: null,
        operationId: `initial-load-${randomUUID()}`,
        actorId: 'system',
      });
      if (accepted.status !== 'accepted')
        return {
          status: 'recovery-required',
          reason: 'initial native baseline could not be accepted',
        };
      const outcome = await sourceViewMaterializer.materialize({
        projectId: id,
        expectedMaterializedRevisionId: inspected.materializedRevisionId,
        expectedTreeHash: inspected.treeHash,
        bundle: { bundleHash: hash, entries: baseline.entries },
      });
      if (outcome.status !== 'completed')
        return { status: 'recovery-required', reason: outcome.reason };
      return { status: 'initial-load', revisionId: accepted.revisionId, sourceHash: tree.treeHash };
    },
    async list(id, cursor) {
      const rows = await persistence.request('listSourceRevisions', {
        projectId: id,
        cursor,
        limit: 100,
      });
      return {
        revisions: rows.map((row) => ({
          revisionId: row.revisionId,
          sourceHash: row.sourceHash,
          bundleHash: row.bundleHash,
          createdAt: row.createdAt,
          acceptedAt: row.acceptedAt ?? row.createdAt,
        })),
      };
    },
    async get(id, revisionId) {
      const row = await persistence.request('getSourceRevision', { revisionId });
      if (row === null || row.projectId !== id) return null;
      return {
        revisionId: row.revisionId,
        sourceHash: row.sourceHash,
        bundleHash: row.bundleHash,
        createdAt: row.createdAt,
        acceptedAt: row.acceptedAt ?? row.createdAt,
      };
    },
    async diff(id, fromRevisionId, toRevisionId) {
      const [from, to] = await Promise.all([
        persistence.request('getSourceRevision', { revisionId: fromRevisionId }),
        persistence.request('getSourceRevision', { revisionId: toRevisionId }),
      ]);
      if (from === null || to === null) return { changes: [] };
      const [before, after] = await Promise.all([
        contentStore.get({ projectId: id, bundleHash: from.bundleHash }),
        contentStore.get({ projectId: id, bundleHash: to.bundleHash }),
      ]);
      if (before === null || after === null) return { changes: [] };
      const b = new Map(before.entries.map((entry) => [entry.logicalPath, hashBundle([entry])])),
        a = new Map(after.entries.map((entry) => [entry.logicalPath, hashBundle([entry])]));
      const paths = [...new Set([...b.keys(), ...a.keys()])].sort();
      return {
        changes: paths
          .filter((path) => b.get(path) !== a.get(path))
          .map((path) => ({
            logicalPath: path,
            beforeHash: b.get(path) ?? null,
            afterHash: a.get(path) ?? null,
          })),
      };
    },
    async restore(input) {
      const source = await persistence.request('getSourceRevision', {
        revisionId: input.revisionId,
      });
      if (source === null)
        return { status: 'invalid', code: 'REVISION_NOT_FOUND', reason: 'revision does not exist' };
      const bundle = await contentStore.get({
        projectId: input.projectId,
        bundleHash: source.bundleHash,
      });
      if (bundle === null)
        return {
          status: 'invalid',
          code: 'RECOVERY_REQUIRED',
          reason: 'revision bundle is missing',
        };
      return submit({
        projectId: input.projectId,
        candidate: {
          entries: bundle.entries,
          sourceHash: source.sourceHash,
          bundleHash: source.bundleHash,
        },
        expectedRevisionId: input.expectedAcceptedRevisionId,
        expectedSourceHash: input.expectedSourceHash,
        operationId: input.operationId,
        actorId: input.actorId,
      });
    },
  };
  return revision;
}

export async function createProjectAuthoringRuntime(
  options: CreateProjectAuthoringRuntimeOptions,
): Promise<ProjectAuthoringRuntime> {
  const source = options.session.source;
  if (source === null)
    throw new TypeError('Project authoring runtime requires an accepted project source');
  const now = options.now ?? (() => new Date().toISOString());
  const treeLoader = createFileTreeLoader(options.projectRoot, { now });
  const sourceViewMaterializer = createFileSourceViewMaterializer({
    projectRoot: options.projectRoot,
    now,
    coordinator: options.coordinator,
    authorityToken: options.authorityToken,
  });
  const revisionContentStore = createFileRevisionContentStore({
    basePath: options.hostStagingRoot,
  });
  const revision = createNativeRevisionPort({
    projectId: options.projectId,
    persistence: options.persistence,
    contentStore: revisionContentStore,
    treeLoader,
    sourceViewMaterializer,
    now,
  });
  const recovery = await revision.recover(options.projectId);
  if (recovery.status === 'recovery-required' || recovery.status === 'stale')
    throw new Error(`Native authoring recovery failed: ${recovery.reason}`);
  const mirror =
    options.revisionMirror?.mode === 'git-best-effort'
      ? createGitRevisionMirror({
          runner: new ControlledGitRunner(),
          projectRoot: options.projectRoot,
          persistence: options.persistence,
          ref: options.revisionMirror.ref,
          now,
        })
      : null;
  const mirrorAccepted = async (acceptedSourceHash: string): Promise<void> => {
    if (mirror === null) return;
    const accepted = await revision.loadAccepted(options.projectId);
    if (accepted === null || accepted.sourceHash !== acceptedSourceHash) return;
    const bundle = await revisionContentStore.get({
      projectId: options.projectId,
      bundleHash: accepted.bundleHash,
    });
    if (bundle === null) {
      const diagnostic = 'accepted native revision bundle is missing for mirror export';
      await options.persistence
        .request('createRevisionMirrorExport', {
          projectId: options.projectId,
          revisionId: accepted.revisionId,
          backend: 'git-best-effort',
          state: 'pending',
          updatedAt: now(),
        })
        .catch(() => undefined);
      await options.persistence
        .request('checkpointRevisionMirrorExport', {
          projectId: options.projectId,
          revisionId: accepted.revisionId,
          backend: 'git-best-effort',
          state: 'failed',
          diagnostic,
          updatedAt: now(),
        })
        .catch(() => undefined);
      return;
    }
    await mirror.export({
      projectId: options.projectId,
      revisionId: accepted.revisionId,
      bundle: { bundleHash: accepted.bundleHash, entries: bundle.entries },
    });
  };
  /**
   * Best-effort per-project derived status refresh. Runs after every accepted
   * submit (submit-receipt) outside the authoring commit lane: the status is
   * a derived artifact, so a failure only marks the reporter degraded and
   * never rolls back the accepted revision.
   */
  const statusSources: { coordinator: AuthoringCoordinator | null } = {
    coordinator: null,
  };
  const refreshProjectStatusFile = async (): Promise<void> => {
    const reporter = options.statusReporter;
    const coordinator = statusSources.coordinator;
    if (reporter === undefined || coordinator === null) return;
    const status = await buildWorkflowStatusForSession(options.session, {
      coordinator,
      revision,
      extensionRegistrar: options.extensionRegistrar,
    });
    if (status !== null) await reporter.refresh(status);
  };
  // Remaining PROJECT_STATUS.md refresh points (render completion, review
  // decision, publication completion) have no durable hook until plan Steps
  // 4-6 land their operation/review/publication services; this submit hook is
  // the only accepted-layer mutation that exists at this step.
  const events: AuthoringEventPublisher = {
    publish(event: AuthoringCoordinatorEvent): void {
      options.events.publish(event);
      if (event.type === 'submit-receipt') {
        void mirrorAccepted(event.acceptedSourceHash).catch(() => undefined);
        void refreshProjectStatusFile().catch(() => undefined);
      }
    },
  };
  const initialAccepted = source;
  const documents = createAuthoringDocumentStore({
    projectId: options.projectId,
    core: options.yjsCore,
    catalog: {
      list: (projectId) =>
        options.persistence.request('listAuthoringWorkingDocuments', { projectId }),
      upsert: (record) => options.persistence.request('upsertAuthoringWorkingDocument', record),
    },
    presenceGeneration: () => options.session.presenceGeneration,
    now,
  });
  const coordinatorPersistence: AuthoringCoordinatorPersistence = {
    load: (input) => options.persistence.request('loadAuthoringState', input),
    save: (record) =>
      options.persistence.request('saveAuthoringState', record).then(() => undefined),
  };
  const sessionPort: AuthoringSessionOperationPort = {
    async enqueue(input) {
      const result = await options.session.enqueueOperation({
        kind: input.kind,
        capabilityId: input.capabilityId,
        scope: input.scopes,
        ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
        payload: {},
        run: (context) => input.run({ operationId: context.operationId, now }),
      });
      if (result.status === 'completed')
        return { status: 'completed', operationId: result.operationId };
      if (result.status === 'denied')
        return { status: 'denied', operationId: result.operationId, reason: result.reason };
      return { status: 'failed', operationId: result.operationId, message: result.message };
    },
  };
  const staging = createFileCandidateStore(options.hostStagingRoot);
  const operationStore = options.operationStore ?? createProjectOperationStore(options.persistence);
  const coordinator = await createAuthoringCoordinator({
    projectId: options.projectId,
    materializer: documents,
    documents,
    staging,
    persistence: coordinatorPersistence,
    operationStore,
    treeLoader,
    sessions: sessionPort,
    revision,
    sourceViewMaterializer,
    revisionContentStore,
    events,
    buildSnapshot: ({ entries }) => snapshotFromEntries({ entries }),
    validate: (candidate) => diagnosticsFor(options.session, candidate, options.extensionRegistrar),
    adopt: async ({ candidate }) => options.session.adoptSourceWithinOperation(candidate),
    initialAccepted,
    initialAcceptedRevisionId: (await revision.loadAccepted(options.projectId))?.revisionId ?? null,
    extensionRegistrar: options.extensionRegistrar,
    now,
  });
  statusSources.coordinator = coordinator;
  if (mirror !== null) void mirrorAccepted(initialAccepted.sourceHash).catch(() => undefined);
  const observer = createAuthoringFilesystemObserver({
    projectId: options.projectId,
    loader: treeLoader,
    staging,
    now,
  });
  const unsubscribeCandidate = observer.onCandidate(() => {
    void coordinator.notifyExternalChange({});
  });
  const unsubscribeWorking = documents.onChange(() => {
    void coordinator.refreshWorkingState();
  });
  return {
    projectId: options.projectId,
    documents,
    coordinator,
    revision,
    observer,
    async dispose() {
      unsubscribeWorking();
      unsubscribeCandidate();
      observer.dispose();
      documents.dispose();
      await coordinator.dispose();
    },
  };
}
