import { Buffer } from 'node:buffer';
import { buildSourceSnapshot, computeSourceDocumentHash } from '@novalistically/core/source';
import type { ProjectSourceSnapshotV1 } from '@novalistically/core';
import type { PersistenceWorkerClient } from '../../persistence/worker-client.js';
import { type AgentCapabilityService } from '../agent/capability-service.js';
import type { ProjectSession } from '../project-session.js';
import {
  GitBootstrap,
  GitBootstrapDirtyError,
} from '../git/bootstrap.js';
import { probeGitCapability } from '../git/capability.js';
import { AuthoringManifest } from '../git/manifest.js';
import { ControlledGitRunner, WORKBENCH_AUTHORING_REF } from '../git/runner.js';
import { GitAuthoringSubmitService } from '../git/submit-service.js';
import {
  createYjsPersistencePort,
  type YjsWorkingDocumentCore,
} from '../yjs/gateway.js';
import {
  createAuthoringCoordinator,
  type AuthoringCoordinatorPersistence,
} from './coordinator.js';
import {
  createAuthoringDocumentStore,
  type AuthoringWorkingDocumentStore,
} from './document-store.js';
import {
  createAuthoringFilesystemObserver,
  createFileCandidateStore,
  createFileTreeLoader,
  type AuthoringFilesystemObserver,
} from './filesystem-observer.js';
import type {
  AuthoringCoordinator,
  AuthoringEventPublisher,
  AuthoringGitSubmitPort,
  AuthoringSessionOperationPort,
} from './types.js';

/**
 * Per-project production assembly of the one accepted session, one shared Yjs
 * working layer, one coordinator and the controlled Git authoring service.
 * The caller owns transports and filesystem-watch handles; no path or Git
 * handle crosses this Host-only boundary.
 */
export interface ProjectAuthoringRuntime {
  readonly projectId: string;
  readonly documents: AuthoringWorkingDocumentStore;
  readonly coordinator: AuthoringCoordinator;
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
  /** One Host-wide Yjs core shared with the authenticated gateway. */
  readonly yjsCore: YjsWorkingDocumentCore;
  readonly events: AuthoringEventPublisher;
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
    for (const diagnostic of document.diagnostics) {
      diagnostics.push({
        code: diagnostic.code,
        severity: diagnostic.severity,
        message: diagnostic.message,
        logicalPath: diagnostic.logicalPath,
      });
    }
    if (document.parseResult.status !== 'parsed') {
      diagnostics.push({
        code: 'source.parse_failed',
        severity: 'error',
        message: `Document ${document.logicalPath} did not parse.`,
        logicalPath: document.logicalPath,
      });
    }
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
  return diagnostics;
}

/**
 * Assemble all Host-private authoring services for an already-open accepted
 * ProjectSession. A handwritten dirty primary can be opened as an external
 * candidate; it never bypasses the later exact reconciliation preflight.
 */
export async function createProjectAuthoringRuntime(
  options: CreateProjectAuthoringRuntimeOptions,
): Promise<ProjectAuthoringRuntime> {
  const source = options.session.source;
  if (source === null) {
    throw new TypeError('Project authoring runtime requires an accepted project source');
  }
  const now = options.now ?? (() => new Date().toISOString());
  const treeLoader = createFileTreeLoader(options.projectRoot, { now });
  const initialTree = await treeLoader.loadTree({ projectId: options.projectId });
  const initialManifest = new AuthoringManifest({
    pathsInHead: new Set(initialTree.entries.map((entry) => entry.logicalPath)),
  });
  const runner = new ControlledGitRunner();
  const capability = await probeGitCapability({ runner });
  let initialGitHead: string;
  let initialPrimaryWasDirty = false;
  try {
    const baseline = await new GitBootstrap({
      runner,
      projectRoot: options.projectRoot,
      projectId: options.projectId,
      manifest: initialManifest,
      entries: initialTree.entries.map((entry) => ({
        path: entry.logicalPath,
        bytes: Buffer.from(entry.content, 'utf8'),
      })),
      capability,
    }).bootstrap();
    initialGitHead = baseline.commit;
  } catch (error) {
    if (!(error instanceof GitBootstrapDirtyError)) throw error;
    initialPrimaryWasDirty = true;
    initialGitHead = (
      await runner.runStrict({
        args: ['rev-parse', WORKBENCH_AUTHORING_REF],
        cwd: options.projectRoot,
      })
    ).stdout.trim();
  }

  const documents = createAuthoringDocumentStore({
    projectId: options.projectId,
    core: options.yjsCore,
    presenceGeneration: () => options.session.presenceGeneration,
    now,
  });
  const coordinatorPersistence: AuthoringCoordinatorPersistence = {
    load: (input) => options.persistence.request('loadAuthoringState', input),
    save: (record) => options.persistence.request('saveAuthoringState', record).then(() => undefined),
  };
  const sessionPort: AuthoringSessionOperationPort = {
    async enqueue(input) {
      const result = await options.session.enqueueOperation({
        kind: input.kind,
        capabilityId: input.capabilityId,
        scope: input.scopes,
        payload: {},
        run: (context) => input.run({ operationId: context.operationId, now }),
      });
      if (result.status === 'completed') {
        return { status: 'completed', operationId: result.operationId };
      }
      if (result.status === 'denied') {
        return { status: 'denied', operationId: result.operationId, reason: result.reason };
      }
      return { status: 'failed', operationId: result.operationId, message: result.message };
    },
  };
  const submitService = new GitAuthoringSubmitService({
    runner,
    projectRoot: options.projectRoot,
    journal: {
      load: (submitId) => options.persistence.request('loadGitSubmission', { submitId }),
      checkpoint: (record) => options.persistence.request('checkpointGitSubmission', record),
      complete: (receipt) => options.persistence.request('completeGitSubmission', receipt),
    },
    confirmWorkingStateVector: async (request) => {
      const digest = await documents.workspaceDigest();
      return digest !== null && Buffer.from(request.expectedWorkingStateVector).toString('hex') === digest.digest
        ? { ok: true }
        : { ok: false, reason: 'working document vectors changed before Git submission' };
    },
    validateCandidate: async (request) => {
      const candidate = snapshotFromEntries({
        entries: request.entries.map((entry) => ({
          logicalPath: entry.path,
          content: Buffer.from(entry.bytes).toString('utf8'),
        })),
      });
      const diagnostics = diagnosticsFor(options.session, candidate);
      const failure = diagnostics.find((diagnostic) => diagnostic.severity === 'error');
      return failure === undefined
        ? { ok: true }
        : { ok: false, code: failure.code, reason: failure.message };
    },
    now,
  });
  const git: AuthoringGitSubmitPort = {
    async submit(input) {
      const digest = Buffer.from(input.expectedWorkspaceDigest, 'hex');
      if (digest.length !== 32) {
        return {
          status: 'invalid',
          code: 'WORKSPACE_STALE',
          reason: 'workspace digest is not a sha256 identity',
        };
      }
      const tree = await treeLoader.loadTree({ projectId: options.projectId });
      const manifest = new AuthoringManifest({
        pathsInHead: new Set(tree.entries.map((entry) => entry.logicalPath)),
      });
      const result = await submitService.submit({
        submitId: input.submitId,
        projectId: input.projectId,
        expectedGitHead: input.expectedGitHead,
        expectedWorkingStateVector: digest,
        manifest,
        entries: input.entries.map((entry) => ({
          path: entry.logicalPath,
          bytes: Buffer.from(entry.content, 'utf8'),
        })),
        sourceHash: input.sourceHash,
        provenance: {
          actorId: input.actorId,
          ...(input.capabilityId === undefined ? {} : { capabilityId: input.capabilityId }),
        },
        ...(input.externalReconciliation === true ? { externalReconciliation: true } : {}),
      });
      if (result.kind === 'accepted') return { status: 'accepted', receipt: result.receipt };
      if (result.kind === 'stale') return { status: 'stale', reason: result.reason };
      if (result.kind === 'conflict') return { status: 'conflict', reason: result.reason };
      return { status: 'invalid', code: result.code, reason: result.reason };
    },
  };
  const staging = createFileCandidateStore(options.hostStagingRoot);
  const coordinator = await createAuthoringCoordinator({
    projectId: options.projectId,
    materializer: documents,
    documents,
    staging,
    persistence: coordinatorPersistence,
    treeLoader,
    sessions: sessionPort,
    git,
    events: options.events,
    buildSnapshot: ({ entries }) => snapshotFromEntries({ entries }),
    validate: (candidate) => diagnosticsFor(options.session, candidate),
    adopt: async ({ candidate }) => options.session.adoptSourceWithinOperation(candidate),
    initialAccepted: source,
    initialGitHead,
    now,
  });
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
  if (initialPrimaryWasDirty) await observer.notify();

  return {
    projectId: options.projectId,
    documents,
    coordinator,
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
