import { describe, expect, it, vi } from 'vitest';
import {
  BrowserAuthoringApiError,
  type BrowserAuthoringClient,
  type BrowserAuthoringOperationsV1,
} from '../../src/client/authoring-client.js';
import {
  createProjectEventClient,
  type ProjectEventClientSnapshot,
} from '../../src/client/project-event-client.js';
import type {
  AuthoringOperationReceiptV1,
  AuthoringStateV1,
} from '../../src/contracts/authoring.js';

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
      cancelOperation: async () => receipt,
      listRevisions: async () => ({
        version: 2 as const,
        projectId: 'project-a',
        revisions: [],
        generatedAt: state.generatedAt,
      }),
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
      createDocument: async () => ({
        status: 'applied',
        operationId: 'op-lifecycle',
        documentId: 'doc-new',
        logicalPath: 'scenes/E1.md',
        workspaceDigest: 'workspace-hash-2',
      }),
      moveDocument: async () => ({
        status: 'applied',
        operationId: 'op-lifecycle',
        documentId: 'doc-new',
        logicalPath: 'scenes/E2.md',
        workspaceDigest: 'workspace-hash-2',
      }),
      deleteDocument: async () => ({
        status: 'applied',
        operationId: 'op-lifecycle',
        documentId: 'doc-new',
        logicalPath: 'scenes/E1.md',
        workspaceDigest: 'workspace-hash-2',
      }),
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

  it('reads durable store state and operations before resuming the stream on connect', async () => {
    const order: string[] = [];
    const client: BrowserAuthoringClient = {
      getState: async () => {
        order.push('getState');
        return state;
      },
      listOperations: async () => {
        order.push('listOperations');
        return operations();
      },
      getOperation: async () => receipt,
      cancelOperation: async () => receipt,
      listRevisions: async () => ({
        version: 2 as const,
        projectId: 'project-a',
        revisions: [],
        generatedAt: state.generatedAt,
      }),
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
      createDocument: async () => ({
        status: 'applied',
        operationId: 'op-lifecycle',
        documentId: 'doc-new',
        logicalPath: 'scenes/E1.md',
        workspaceDigest: 'workspace-hash-2',
      }),
      moveDocument: async () => ({
        status: 'applied',
        operationId: 'op-lifecycle',
        documentId: 'doc-new',
        logicalPath: 'scenes/E2.md',
        workspaceDigest: 'workspace-hash-2',
      }),
      deleteDocument: async () => ({
        status: 'applied',
        operationId: 'op-lifecycle',
        documentId: 'doc-new',
        logicalPath: 'scenes/E1.md',
        workspaceDigest: 'workspace-hash-2',
      }),
      subscribeEvents: () => {
        order.push('subscribeEvents');
        return { ready: Promise.resolve(), close: () => undefined };
      },
    };
    const events = createProjectEventClient({ projectId: 'project-a', client });
    await events.start();
    // Reconnect shape: the client first reads the durable store (state +
    // operations) and only then attaches the live stream, so a dropped SSE
    // connection never starts from a stale in-memory view.
    expect(order).toEqual(['getState', 'listOperations', 'subscribeEvents']);
    expect(events.snapshot().operations).toEqual([receipt]);
    events.stop();
  });

  it('renders every durable kind live: render/publish events reduce into the store-first list', async () => {
    // Durable render op already in the store when the client connects
    // (reconnect: read the store FIRST, then resume the stream).
    const renderQueued: AuthoringOperationReceiptV1 = {
      version: 2,
      operationId: 'render-1',
      projectId: 'project-a',
      kind: 'render',
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
    const captured: {
      handlers?: Parameters<BrowserAuthoringClient['subscribeEvents']>[1];
    } = {};
    const client: BrowserAuthoringClient = {
      getState: async () => state,
      listOperations: async () => ({
        version: 2 as const,
        projectId: 'project-a',
        operations: [renderQueued],
        generatedAt: '2099-01-01T00:00:00.000Z',
      }),
      getOperation: async () => renderQueued,
      cancelOperation: async () => renderQueued,
      listRevisions: async () => ({
        version: 2 as const,
        projectId: 'project-a',
        revisions: [],
        generatedAt: state.generatedAt,
      }),
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
      createDocument: async () => ({
        status: 'applied',
        operationId: 'op-lifecycle',
        documentId: 'doc-new',
        logicalPath: 'scenes/E1.md',
        workspaceDigest: 'workspace-hash-2',
      }),
      moveDocument: async () => ({
        status: 'applied',
        operationId: 'op-lifecycle',
        documentId: 'doc-new',
        logicalPath: 'scenes/E2.md',
        workspaceDigest: 'workspace-hash-2',
      }),
      deleteDocument: async () => ({
        status: 'applied',
        operationId: 'op-lifecycle',
        documentId: 'doc-new',
        logicalPath: 'scenes/E1.md',
        workspaceDigest: 'workspace-hash-2',
      }),
      subscribeEvents: (_projectId, handlers) => {
        captured.handlers = handlers;
        return { ready: Promise.resolve(), close: () => undefined };
      },
    };

    const events = createProjectEventClient({ projectId: 'project-a', client });
    await events.start();
    // Store-first hydration: the durable render receipt is already present.
    expect(events.snapshot().operations.map((op) => op.operationId)).toEqual(['render-1']);

    const handlers = captured.handlers;
    if (handlers === undefined) throw new Error('Event handlers were not registered.');
    // Live render transition: queued → running (progress update).
    handlers.onEvent({
      type: 'operation-updated',
      version: 2,
      projectId: 'project-a',
      receipt: {
        ...renderQueued,
        status: 'running',
        pendingOperationId: 'render-1',
        progress: { completed: 1, total: 3 },
        updatedAt: '2099-01-01T00:00:01.000Z',
      },
      at: '2099-01-01T00:00:01.000Z',
    });
    // Live publish operation: brand-new receipt never seen by the store list.
    handlers.onEvent({
      type: 'operation-updated',
      version: 2,
      projectId: 'project-a',
      receipt: {
        version: 2,
        operationId: 'publish-1',
        projectId: 'project-a',
        kind: 'publish',
        status: 'queued',
        acceptedSourceHash: null,
        acceptedRevisionId: null,
        pendingOperationId: null,
        revisionId: null,
        receiptHash: null,
        errorCode: null,
        createdAt: '2099-01-01T00:00:02.000Z',
        updatedAt: '2099-01-01T00:00:02.000Z',
      },
      at: '2099-01-01T00:00:02.000Z',
    });
    // Live render terminal transition: running → completed (succeeded).
    handlers.onEvent({
      type: 'operation-updated',
      version: 2,
      projectId: 'project-a',
      receipt: {
        ...renderQueued,
        status: 'completed',
        pendingOperationId: null,
        resultRef: 'artifact-1',
        progress: { completed: 3, total: 3 },
        updatedAt: '2099-01-01T00:00:03.000Z',
      },
      at: '2099-01-01T00:00:03.000Z',
    });

    const operations = events.snapshot().operations;
    const renderOp = operations.find((op) => op.operationId === 'render-1');
    const publishOp = operations.find((op) => op.operationId === 'publish-1');
    expect(renderOp?.status).toBe('completed');
    expect(renderOp?.resultRef).toBe('artifact-1');
    expect(renderOp?.progress).toEqual({ completed: 3, total: 3 });
    expect(publishOp?.kind).toBe('publish');
    expect(publishOp?.status).toBe('queued');
    // The live update replaces the earlier row for the same operationId.
    expect(operations.filter((op) => op.operationId === 'render-1')).toHaveLength(1);
    events.stop();
  });
});

/** Minimal working authoring client; reconnect tests override the stream hooks. */
function fakeClient(
  overrides: Partial<
    Pick<BrowserAuthoringClient, 'getState' | 'listOperations' | 'subscribeEvents'>
  > = {},
): BrowserAuthoringClient {
  return {
    getState: async () => state,
    listOperations: async () => operations(),
    getOperation: async () => receipt,
    cancelOperation: async () => receipt,
    listRevisions: async () => ({
      version: 2 as const,
      projectId: 'project-a',
      revisions: [],
      generatedAt: state.generatedAt,
    }),
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
    createDocument: async () => ({
      status: 'applied',
      operationId: 'op-lifecycle',
      documentId: 'doc-new',
      logicalPath: 'scenes/E1.md',
      workspaceDigest: 'workspace-hash-2',
    }),
    moveDocument: async () => ({
      status: 'applied',
      operationId: 'op-lifecycle',
      documentId: 'doc-new',
      logicalPath: 'scenes/E2.md',
      workspaceDigest: 'workspace-hash-2',
    }),
    deleteDocument: async () => ({
      status: 'applied',
      operationId: 'op-lifecycle',
      documentId: 'doc-new',
      logicalPath: 'scenes/E1.md',
      workspaceDigest: 'workspace-hash-2',
    }),
    subscribeEvents: () => ({ ready: Promise.resolve(), close: () => undefined }),
    ...overrides,
  };
}

const presenceEvent = {
  type: 'presence-changed',
  version: 2,
  projectId: 'project-a',
  generation: 4,
  presence: [{ actorId: 'author-1', surface: 'yjs', since: '2099-01-01T00:00:01.000Z' }],
  at: '2099-01-01T00:00:01.000Z',
} as const;

describe('project authoring event client reconnect', () => {
  it('reconnects after a failed first subscribe and resumes live events', async () => {
    const order: string[] = [];
    const captured: Parameters<BrowserAuthoringClient['subscribeEvents']>[1][] = [];
    let subscribeCalls = 0;
    const client = fakeClient({
      getState: async () => {
        order.push('getState');
        return state;
      },
      listOperations: async () => {
        order.push('listOperations');
        return operations();
      },
      subscribeEvents: (_projectId, handlers) => {
        subscribeCalls += 1;
        order.push('subscribeEvents');
        captured.push(handlers);
        if (subscribeCalls === 1) {
          return {
            ready: Promise.reject(
              new BrowserAuthoringApiError(
                503,
                'AUTHORING_UNAVAILABLE',
                'The event stream is temporarily unavailable.',
              ),
            ),
            close: () => undefined,
          };
        }
        return { ready: Promise.resolve(), close: () => undefined };
      },
    });

    const events = createProjectEventClient({
      projectId: 'project-a',
      client,
      reconnectBaseDelayMs: 5,
      reconnectMaxDelayMs: 25,
      maxReconnectAttempts: 3,
    });

    const first = await events.start();
    expect(first.connected).toBe(false);
    expect(first.error?.status).toBe(503);

    await vi.waitFor(() => expect(events.snapshot().connected).toBe(true));
    expect(subscribeCalls).toBeGreaterThanOrEqual(2);
    // Every reconnect re-runs the store-first read before the stream.
    expect(order.filter((step) => step === 'getState')).toHaveLength(2);
    expect(order.filter((step) => step === 'listOperations')).toHaveLength(2);

    const handlers = captured[1];
    if (handlers === undefined) throw new Error('Second subscription was not registered.');
    handlers.onEvent(presenceEvent);
    expect(events.snapshot().presenceGeneration).toBe(4);
    expect(events.snapshot().presence).toHaveLength(1);
    events.stop();
  });

  it('reconnects when an established stream drops and resumes on the fresh stream', async () => {
    const captured: Parameters<BrowserAuthoringClient['subscribeEvents']>[1][] = [];
    let subscribeCalls = 0;
    const client = fakeClient({
      subscribeEvents: (_projectId, handlers) => {
        subscribeCalls += 1;
        captured.push(handlers);
        return { ready: Promise.resolve(), close: () => undefined };
      },
    });

    const events = createProjectEventClient({
      projectId: 'project-a',
      client,
      reconnectBaseDelayMs: 5,
      reconnectMaxDelayMs: 25,
      maxReconnectAttempts: 3,
    });
    await events.start();
    expect(events.snapshot().connected).toBe(true);

    const firstHandlers = captured[0];
    if (firstHandlers === undefined) throw new Error('First subscription was not registered.');
    // The real stream error callback is always registered; the reconnect is
    // asserted below by the second subscription appearing.
    firstHandlers.onError?.(new BrowserAuthoringApiError(0, null, 'The event stream dropped.'));

    await vi.waitFor(() => expect(subscribeCalls).toBeGreaterThanOrEqual(2));
    await vi.waitFor(() => expect(events.snapshot().connected).toBe(true));
    expect(events.snapshot().error).toBeNull();

    const handlers = captured[1];
    if (handlers === undefined) throw new Error('Second subscription was not registered.');
    handlers.onEvent(presenceEvent);
    expect(events.snapshot().presenceGeneration).toBe(4);
    events.stop();
  });

  it('stays permanently disconnected after bounded retries are exhausted', async () => {
    let subscribeCalls = 0;
    const client = fakeClient({
      subscribeEvents: () => {
        subscribeCalls += 1;
        return {
          ready: Promise.reject(
            new BrowserAuthoringApiError(500, null, 'The Host is unreachable.'),
          ),
          close: () => undefined,
        };
      },
    });

    const events = createProjectEventClient({
      projectId: 'project-a',
      client,
      reconnectBaseDelayMs: 1,
      reconnectMaxDelayMs: 4,
      maxReconnectAttempts: 2,
    });

    await events.start();
    expect(events.snapshot().connected).toBe(false);
    expect(events.snapshot().error?.status).toBe(500);
    // One initial attempt plus two bounded retries; then the backoff is spent.
    await vi.waitFor(() => expect(subscribeCalls).toBe(3));
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(subscribeCalls).toBe(3);
    expect(events.snapshot().connected).toBe(false);
    events.stop();
  });
});
