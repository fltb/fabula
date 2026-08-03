import { describe, expect, it, vi } from 'vitest';
import type {
  AuthoringActivityEventV1,
  AuthoringOperationReceiptV1,
  AuthoringStateV1,
} from '../../src/contracts/authoring.js';
import {
  createProjectEventClient,
  type ProjectEventClientSnapshot,
} from '../../src/client/project-event-client.js';
import type {
  BrowserAuthoringClient,
  BrowserAuthoringOperationsV1,
} from '../../src/client/authoring-client.js';

const state: AuthoringStateV1 = {
  version: 2,
  projectId: 'project-a',
  phase: 'working-dirty',
  acceptedRevisionId: null,
  acceptedSourceHash: 'accepted-hash',
  pendingOperationId: null,
  workingDirty: true,
  workspaceDigest: 'workspace-hash',
  externalCandidate: null,
  conflicts: [],
  diagnostics: [],
  canSubmit: true,
  submitBlockReason: 'none',
  generatedAt: '2099-01-01T00:00:00.000Z',
};

const receipt: AuthoringOperationReceiptV1 = {
  version: 2,
  operationId: 'operation-1',
  projectId: 'project-a',
  kind: 'submit',
  status: 'queued',
  acceptedSourceHash: 'accepted-hash',
  acceptedRevisionId: null,
  pendingOperationId: null,
  revisionId: null,
  receiptHash: null,
  errorCode: null,
  createdAt: '2099-01-01T00:00:00.000Z',
  updatedAt: '2099-01-01T00:00:00.000Z',
};

function operations(): BrowserAuthoringOperationsV1 {
  return {
    version: 2,
    projectId: 'project-a',
    operations: [receipt],
    generatedAt: '2099-01-01T00:00:00.000Z',
  };
}

describe('project authoring event client', () => {
  it('hydrates safe state, reduces events, and stops its sole stream', async () => {
    const captured: {
      handlers?: Parameters<BrowserAuthoringClient['subscribeEvents']>[1];
    } = {};
    const close = vi.fn();
    const snapshots: ProjectEventClientSnapshot[] = [];
    const client: BrowserAuthoringClient = {
      getState: async () => state,
      listOperations: async () => operations(),
      getOperation: async () => receipt,
      listRevisions: async () => ({ version: 2 as const, projectId: 'project-a', revisions: [], generatedAt: state.generatedAt }),
      getRevision: async () => ({
        version: 2 as const,
        projectId: 'project-a',
        revision: {
          version: 2 as const,
          revisionId: 'revision-1',
          sourceHash: 'source-1',
          createdAt: state.generatedAt,
          acceptedAt: state.generatedAt,
        },
        generatedAt: state.generatedAt,
      }),
      diffRevisions: async () => ({
        version: 2 as const,
        projectId: 'project-a',
        fromRevisionId: 'revision-1',
        toRevisionId: 'revision-2',
        changes: [],
        generatedAt: state.generatedAt,
      }),
      restoreRevision: async () => ({
        version: 2 as const,
        status: 'accepted' as const,
        revisionId: 'revision-2',
        receiptHash: 'receipt-2',
      }),
      submit: async () => ({ status: 'queued', receipt }),
      reconcile: async () => ({ status: 'queued', receipt }),
      subscribeEvents: (_projectId, handlers) => {
        captured.handlers = handlers;
        return { ready: Promise.resolve(), close };
      },
    };

    const events = createProjectEventClient({
      projectId: 'project-a',
      client,
      onChange: (snapshot) => snapshots.push(snapshot),
    });

    const started = await events.start();
    expect(started.connected).toBe(true);
    expect(started.state).toEqual(state);
    expect(started.operations).toEqual([receipt]);
    const handlers = captured.handlers;
    if (handlers === undefined) throw new Error('Event handlers were not registered.');
    handlers.onEvent({
      type: 'presence-changed',
      version: 2,
      projectId: 'project-a',
      generation: 4,
      presence: [{ actorId: 'author-1', surface: 'yjs', since: '2099-01-01T00:00:01.000Z' }],
      at: '2099-01-01T00:00:01.000Z',
    });
    handlers.onEvent({
      type: 'external-candidate',
      version: 2,
      projectId: 'project-a',
      candidate: {
        candidateHash: 'external-hash',
        detectedAt: '2099-01-01T00:00:02.000Z',
        valid: true,
        changedLogicalPaths: ['nova.yaml'],
        diagnostics: [],
      },
      at: '2099-01-01T00:00:02.000Z',
    });

    const current = events.snapshot();
    expect(current.presenceGeneration).toBe(4);
    expect(current.presence).toHaveLength(1);
    expect(current.state?.externalCandidate?.candidateHash).toBe('external-hash');
    expect(current.state?.submitBlockReason).toBe('external-candidate-pending');
    expect(snapshots).not.toHaveLength(0);

    events.stop();
    expect(close).toHaveBeenCalledOnce();
    expect(events.snapshot().connected).toBe(false);
  });
});
