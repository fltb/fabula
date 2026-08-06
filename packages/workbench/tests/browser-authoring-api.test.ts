import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import {
  AUTHORING_CONTRACT_VERSION,
  type AuthoringOperationReceiptV1,
  type AuthoringStateV1,
} from '../src/contracts/authoring.js';
import type { BrowserSessionPrincipalV1 } from '../src/contracts/browser-api.js';
import { BROWSER_SESSION_HEADER } from '../src/contracts/browser-api.js';
import type { ProjectOperationRecordV1 } from '../src/contracts/persistence.js';
import type { BrowserAuthoringMutationPort } from '../src/host/authoring/mcp-adapter.js';
import type { AuthoringCoordinator } from '../src/host/authoring/types.js';
import type { BrowserOperationServicePort } from '../src/host/browser-authoring-api.js';
import {
  type BrowserAuthoringApiOptions,
  createBrowserAuthoringApi,
} from '../src/host/browser-authoring-api.js';
import { createProjectAccessService } from '../src/host/project-access-service.js';
import type { HostServer } from '../src/host/server.js';

const principal: BrowserSessionPrincipalV1 = {
  version: 1,
  userId: 'owner-1',
  role: 'owner',
  displayName: 'Owner',
  capabilityVersion: 3,
  expiresAt: '2099-01-01T00:00:00.000Z',
};

const state: AuthoringStateV1 = {
  version: AUTHORING_CONTRACT_VERSION,
  projectId: 'proj-a',
  phase: 'working-dirty',
  acceptedSourceHash: 'accepted-hash',
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
  version: AUTHORING_CONTRACT_VERSION,
  operationId: 'op-1',
  projectId: 'proj-a',
  kind: 'submit',
  status: 'queued',
  acceptedSourceHash: 'accepted-hash',
  workspaceDigest: 'workspace-hash',
  gitSubmitId: null,
  gitReceiptHash: null,
  errorCode: null,
  createdAt: '2099-01-01T00:00:00.000Z',
  updatedAt: '2099-01-01T00:00:00.000Z',
};

function harness(
  input: {
    readonly principal?: BrowserSessionPrincipalV1;
    readonly access?: BrowserAuthoringApiOptions['access'];
    readonly mutations?: BrowserAuthoringMutationPort | null;
    readonly operations?: BrowserOperationServicePort | null;
    readonly events?: { publish: (projectId: string, event: unknown) => void };
  } = {},
) {
  const currentPrincipal = input.principal ?? principal;
  const submit = vi.fn(async () => receipt);
  const reconcile = vi.fn(async () => ({ ...receipt, kind: 'reconcile-external' as const }));
  const resolveCapability = vi.fn(async () => ({
    capabilityId: 'server-capability',
    scopes: ['authoring:submit'],
  }));
  const lifecycleCreate = vi.fn(async () => ({
    status: 'applied' as const,
    operationId: 'lifecycle-op-1',
    documentId: 'doc-new',
    logicalPath: 'scenes/E1.md',
    workspaceDigest: 'workspace-hash-2',
  }));
  const lifecycleMove = vi.fn(async () => ({
    status: 'applied' as const,
    operationId: 'lifecycle-op-2',
    documentId: 'doc-1',
    logicalPath: 'scenes/E2.md',
    workspaceDigest: 'workspace-hash-2',
  }));
  const lifecycleDelete = vi.fn(async () => ({
    status: 'applied' as const,
    operationId: 'lifecycle-op-3',
    documentId: 'doc-1',
    logicalPath: 'scenes/E1.md',
    workspaceDigest: 'workspace-hash-2',
  }));
  const mutationsPort: BrowserAuthoringMutationPort =
    input.mutations ??
    ({
      createDocument: lifecycleCreate,
      moveDocument: lifecycleMove,
      deleteDocument: lifecycleDelete,
    } as BrowserAuthoringMutationPort);
  const coordinator = {
    projectId: 'proj-a',
    getState: () => state,
    listOperations: async () => [receipt],
    getOperation: async (operationId: string) =>
      operationId === receipt.operationId ? receipt : null,
    isAgentPaused: () => false,
    notifyExternalChange: async () => undefined,
    submit,
    reconcileExternal: reconcile,
    refreshAccepted: async () => undefined,
    dispose: async () => undefined,
  } satisfies AuthoringCoordinator;
  const options: BrowserAuthoringApiOptions = {
    principal: { resolve: async () => ({ ok: true, principal: currentPrincipal }) },
    ...(input.access === undefined ? {} : { access: input.access }),
    authorization: { canAccessProject: () => true },
    catalog: {
      listProjects: async () => [
        {
          version: 1,
          projectId: 'proj-a',
          displayName: 'Project A',
          createdAt: currentPrincipal.expiresAt,
          updatedAt: currentPrincipal.expiresAt,
          open: true,
        },
      ],
    },
    coordinators: { get: () => coordinator },
    ...(input.mutations === null ? {} : { mutations: { get: () => mutationsPort } }),
    ...(input.operations === undefined
      ? {}
      : input.operations === null
        ? { operations: null }
        : { operations: { get: () => input.operations } }),
    ...(input.events === undefined
      ? {}
      : { events: input.events as BrowserAuthoringApiOptions['events'] }),
    capabilities: { resolve: resolveCapability },
    now: () => '2099-01-01T00:00:00.000Z',
  };
  const registered = {
    reads: new Map<string, (context: unknown) => unknown>(),
    mutations: new Map<string, (context: unknown) => unknown>(),
  };
  const host = {
    registerReadRoute(path: string, handler: (context: unknown) => unknown) {
      registered.reads.set(path, handler);
    },
    registerMutationRoute(_method: string, path: string, handler: (context: unknown) => unknown) {
      registered.mutations.set(path, handler);
    },
  } as unknown as HostServer;
  createBrowserAuthoringApi(options).register(host);
  const app = new Hono();
  for (const [path, handler] of registered.reads) app.get(path, handler as never);
  for (const [path, handler] of registered.mutations) app.post(path, handler as never);
  return {
    app,
    submit,
    reconcile,
    resolveCapability,
    lifecycleCreate,
    lifecycleMove,
    lifecycleDelete,
  };
}

describe('browser authoring API', () => {
  it('rejects actor/capability/root/head fields before reaching the coordinator', async () => {
    const { app, submit } = harness();
    const response = await app.request('/api/v1/projects/proj-a/authoring/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: AUTHORING_CONTRACT_VERSION,
        projectId: 'proj-a',
        expectedAcceptedRevisionId: null,
        expectedAcceptedSourceHash: 'accepted-hash',
        expectedWorkspaceDigest: 'workspace-hash',
        actorId: 'spoofed',
        capabilityId: 'spoofed',
        root: '/secret',
        head: 'refs/heads/main',
      }),
    });
    expect(response.status).toBe(400);
    expect(submit).not.toHaveBeenCalled();
  });

  it('derives actor and capability only on the server and forwards safe CAS fields', async () => {
    const { app, submit } = harness();
    const response = await app.request('/api/v1/projects/proj-a/authoring/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: AUTHORING_CONTRACT_VERSION,
        projectId: 'proj-a',
        expectedAcceptedRevisionId: 'accepted-rev-1',
        expectedAcceptedSourceHash: 'accepted-hash',
        expectedWorkspaceDigest: 'workspace-hash',
      }),
    });
    expect(response.status).toBe(202);
    expect(submit).toHaveBeenCalledWith({
      expectedAcceptedRevisionId: 'accepted-rev-1',
      expectedAcceptedSourceHash: 'accepted-hash',
      expectedWorkspaceDigest: 'workspace-hash',
      actorId: 'owner-1',
      capabilityId: 'server-capability',
      capabilityScopes: ['authoring:submit'],
    });
  });
  it('forwards the reconcile revision CAS to the coordinator and queues the operation', async () => {
    const { app, reconcile } = harness();
    const response = await app.request('/api/v1/projects/proj-a/authoring/reconcile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: AUTHORING_CONTRACT_VERSION,
        projectId: 'proj-a',
        choice: 'keep-working',
        candidateHash: null,
        expectedAcceptedRevisionId: 'accepted-rev-1',
        expectedAcceptedSourceHash: 'accepted-hash',
      }),
    });
    expect(response.status).toBe(202);
    expect(reconcile).toHaveBeenCalledWith({
      choice: 'keep-working',
      candidateHash: null,
      expectedAcceptedRevisionId: 'accepted-rev-1',
      expectedAcceptedSourceHash: 'accepted-hash',
      actorId: 'owner-1',
      capabilityId: 'server-capability',
      capabilityScopes: ['authoring:submit'],
    });
  });
  it('keeps reader status access while denying authoring mutation and submit', async () => {
    const reader: BrowserSessionPrincipalV1 = {
      ...principal,
      userId: 'reader-1',
      role: 'user',
      displayName: 'Reader',
    };
    const access = createProjectAccessService({
      projects: [{ projectId: 'proj-a', displayName: 'Project A', open: true }],
      memberships: [{ projectId: 'proj-a', userId: 'reader-1', role: 'reader' }],
    });
    const {
      app,
      submit,
      reconcile,
      resolveCapability,
      lifecycleCreate,
      lifecycleMove,
      lifecycleDelete,
    } = harness({ principal: reader, access });

    const stateResponse = await app.request('/api/v1/projects/proj-a/authoring/state');
    expect(stateResponse.status).toBe(200);

    const ticketResponse = await app.request('/api/v1/projects/proj-a/source/doc-1/yjs-ticket', {
      headers: { [BROWSER_SESSION_HEADER]: 'reader-session' },
    });
    expect(ticketResponse.status).toBe(403);

    const submitResponse = await app.request('/api/v1/projects/proj-a/authoring/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: AUTHORING_CONTRACT_VERSION,
        projectId: 'proj-a',
        expectedAcceptedRevisionId: null,
        expectedAcceptedSourceHash: 'accepted-hash',
        expectedWorkspaceDigest: 'workspace-hash',
      }),
    });
    expect(submitResponse.status).toBe(403);

    const reconcileResponse = await app.request('/api/v1/projects/proj-a/authoring/reconcile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: AUTHORING_CONTRACT_VERSION,
        projectId: 'proj-a',
        choice: 'keep-working',
        candidateHash: null,
        expectedAcceptedRevisionId: null,
        expectedAcceptedSourceHash: 'accepted-hash',
      }),
    });
    expect(reconcileResponse.status).toBe(403);
    expect(submit).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    expect(resolveCapability).not.toHaveBeenCalled();

    const createResponse = await app.request('/api/v1/projects/proj-a/authoring/documents/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: AUTHORING_CONTRACT_VERSION,
        projectId: 'proj-a',
        logicalPath: 'scenes/E1.md',
        kind: 'prose',
        expectedAcceptedSourceHash: 'accepted-hash',
        expectedWorkspaceDigest: 'workspace-hash',
      }),
    });
    expect(createResponse.status).toBe(403);
    const moveResponse = await app.request('/api/v1/projects/proj-a/authoring/documents/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: AUTHORING_CONTRACT_VERSION,
        projectId: 'proj-a',
        documentId: 'doc-1',
        logicalPath: 'scenes/E2.md',
        expectedAcceptedSourceHash: 'accepted-hash',
        expectedWorkspaceDigest: 'workspace-hash',
      }),
    });
    expect(moveResponse.status).toBe(403);
    const deleteResponse = await app.request('/api/v1/projects/proj-a/authoring/documents/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: AUTHORING_CONTRACT_VERSION,
        projectId: 'proj-a',
        documentId: 'doc-1',
        expectedAcceptedSourceHash: 'accepted-hash',
        expectedWorkspaceDigest: 'workspace-hash',
      }),
    });
    expect(deleteResponse.status).toBe(403);
    expect(lifecycleCreate).not.toHaveBeenCalled();
    expect(lifecycleMove).not.toHaveBeenCalled();
    expect(lifecycleDelete).not.toHaveBeenCalled();
  });
});

describe('browser authoring document lifecycle', () => {
  it('creates a working document with server-derived identity and caller', async () => {
    const { app, lifecycleCreate } = harness();
    const response = await app.request('/api/v1/projects/proj-a/authoring/documents/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: AUTHORING_CONTRACT_VERSION,
        projectId: 'proj-a',
        logicalPath: 'scenes/E1.md',
        kind: 'prose',
        expectedAcceptedSourceHash: 'accepted-hash',
        expectedWorkspaceDigest: 'workspace-hash',
      }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: 'applied',
      operationId: 'lifecycle-op-1',
      documentId: 'doc-new',
      logicalPath: 'scenes/E1.md',
      workspaceDigest: 'workspace-hash-2',
    });
    expect(lifecycleCreate).toHaveBeenCalledWith(
      {
        version: AUTHORING_CONTRACT_VERSION,
        logicalPath: 'scenes/E1.md',
        kind: 'prose',
        expectedAcceptedSourceHash: 'accepted-hash',
        expectedWorkspaceDigest: 'workspace-hash',
      },
      { userId: 'owner-1' },
    );
  });

  it('moves and deletes with documentId and the same working-layer CAS fields', async () => {
    const { app, lifecycleMove, lifecycleDelete } = harness();
    const moveResponse = await app.request('/api/v1/projects/proj-a/authoring/documents/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: AUTHORING_CONTRACT_VERSION,
        projectId: 'proj-a',
        documentId: 'doc-1',
        logicalPath: 'scenes/E2.md',
        expectedAcceptedSourceHash: 'accepted-hash',
        expectedWorkspaceDigest: 'workspace-hash',
      }),
    });
    expect(moveResponse.status).toBe(200);
    expect(lifecycleMove).toHaveBeenCalledWith(
      {
        version: AUTHORING_CONTRACT_VERSION,
        documentId: 'doc-1',
        logicalPath: 'scenes/E2.md',
        expectedAcceptedSourceHash: 'accepted-hash',
        expectedWorkspaceDigest: 'workspace-hash',
      },
      { userId: 'owner-1' },
    );
    const deleteResponse = await app.request('/api/v1/projects/proj-a/authoring/documents/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: AUTHORING_CONTRACT_VERSION,
        projectId: 'proj-a',
        documentId: 'doc-1',
        expectedAcceptedSourceHash: 'accepted-hash',
        expectedWorkspaceDigest: 'workspace-hash',
      }),
    });
    expect(deleteResponse.status).toBe(200);
    expect(lifecycleDelete).toHaveBeenCalledWith(
      {
        version: AUTHORING_CONTRACT_VERSION,
        documentId: 'doc-1',
        expectedAcceptedSourceHash: 'accepted-hash',
        expectedWorkspaceDigest: 'workspace-hash',
      },
      { userId: 'owner-1' },
    );
  });

  it('rejects lifecycle requests that smuggle host fields before reaching the service', async () => {
    const { app, lifecycleCreate } = harness();
    const response = await app.request('/api/v1/projects/proj-a/authoring/documents/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: AUTHORING_CONTRACT_VERSION,
        projectId: 'proj-a',
        logicalPath: 'scenes/E1.md',
        kind: 'prose',
        expectedAcceptedSourceHash: 'accepted-hash',
        expectedWorkspaceDigest: 'workspace-hash',
        root: '/secret/tree',
        actorId: 'spoofed',
      }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'UNKNOWN_FIELD' } });
    expect(lifecycleCreate).not.toHaveBeenCalled();
  });

  it('requires the working-layer CAS fields and rejects malformed create input', async () => {
    const { app, lifecycleCreate } = harness();
    const missingDigest = await app.request('/api/v1/projects/proj-a/authoring/documents/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: AUTHORING_CONTRACT_VERSION,
        projectId: 'proj-a',
        logicalPath: 'scenes/E1.md',
        kind: 'prose',
        expectedAcceptedSourceHash: 'accepted-hash',
      }),
    });
    expect(missingDigest.status).toBe(400);
    await expect(missingDigest.json()).resolves.toMatchObject({
      error: { code: 'INVALID_INPUT' },
    });

    const wrongProject = await app.request('/api/v1/projects/proj-a/authoring/documents/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: AUTHORING_CONTRACT_VERSION,
        projectId: 'proj-other',
        logicalPath: 'scenes/E1.md',
        kind: 'prose',
        expectedAcceptedSourceHash: 'accepted-hash',
        expectedWorkspaceDigest: 'workspace-hash',
      }),
    });
    expect(wrongProject.status).toBe(400);

    const badKind = await app.request('/api/v1/projects/proj-a/authoring/documents/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: AUTHORING_CONTRACT_VERSION,
        projectId: 'proj-a',
        logicalPath: 'scenes/E1.md',
        kind: 'yaml',
        expectedAcceptedSourceHash: 'accepted-hash',
        expectedWorkspaceDigest: 'workspace-hash',
      }),
    });
    expect(badKind.status).toBe(400);
    expect(lifecycleCreate).not.toHaveBeenCalled();
  });

  it('maps stale/conflict outcomes to the MCP-identical failure codes', async () => {
    const stale: BrowserAuthoringMutationPort = {
      createDocument: vi.fn(async () => ({
        code: 'WORKSPACE_STALE',
        message: 'The working layer changed; re-read before mutating.',
      })),
      moveDocument: vi.fn(async () => ({
        code: 'ACCEPTED_HASH_MISMATCH',
        message: 'The accepted source changed; re-read before mutating.',
      })),
      deleteDocument: vi.fn(async () => ({
        code: 'DOCUMENT_NOT_FOUND',
        message: 'The working document is unavailable.',
      })),
    };
    const { app } = harness({ mutations: stale });
    const base = {
      version: AUTHORING_CONTRACT_VERSION,
      projectId: 'proj-a',
      expectedAcceptedSourceHash: 'accepted-hash',
      expectedWorkspaceDigest: 'workspace-hash',
    };
    const createResponse = await app.request('/api/v1/projects/proj-a/authoring/documents/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...base, logicalPath: 'scenes/E1.md', kind: 'prose' }),
    });
    expect(createResponse.status).toBe(409);
    await expect(createResponse.json()).resolves.toMatchObject({
      error: { code: 'WORKSPACE_STALE' },
    });
    const moveResponse = await app.request('/api/v1/projects/proj-a/authoring/documents/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...base, documentId: 'doc-1', logicalPath: 'scenes/E2.md' }),
    });
    expect(moveResponse.status).toBe(409);
    await expect(moveResponse.json()).resolves.toMatchObject({
      error: { code: 'ACCEPTED_HASH_MISMATCH' },
    });
    const deleteResponse = await app.request('/api/v1/projects/proj-a/authoring/documents/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...base, documentId: 'doc-1' }),
    });
    expect(deleteResponse.status).toBe(404);
    await expect(deleteResponse.json()).resolves.toMatchObject({
      error: { code: 'DOCUMENT_NOT_FOUND' },
    });
  });

  it('fails closed when the lifecycle service is not registered', async () => {
    const { app } = harness({ mutations: null });
    const response = await app.request('/api/v1/projects/proj-a/authoring/documents/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: AUTHORING_CONTRACT_VERSION,
        projectId: 'proj-a',
        logicalPath: 'scenes/E1.md',
        kind: 'prose',
        expectedAcceptedSourceHash: 'accepted-hash',
        expectedWorkspaceDigest: 'workspace-hash',
      }),
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'AUTHORING_UNAVAILABLE' },
    });
  });
});

describe('browser operation center cancel', () => {
  const cancelledRecord: ProjectOperationRecordV1 = {
    version: 1,
    projectId: 'proj-a',
    operationId: 'render-1',
    idempotencyKey: 'render-1',
    kind: 'render',
    status: 'cancelled',
    actorId: 'owner-1',
    capabilityVersion: 3,
    sourceHash: 'accepted-hash',
    acceptedRevisionId: null,
    progress: { completed: 2, total: 5 },
    resultRef: null,
    errorCode: null,
    createdAt: '2099-01-01T00:00:00.000Z',
    updatedAt: '2099-01-01T00:00:00.000Z',
  };

  it('cancels a durable operation and broadcasts the receipt only after the record persisted', async () => {
    const published: unknown[] = [];
    const cancel = vi.fn(async () => ({
      status: 'cancelled' as const,
      record: cancelledRecord,
    }));
    const { app } = harness({
      operations: { cancel, get: async () => cancelledRecord },
      events: {
        publish: (_projectId, event) => {
          published.push(event);
        },
      },
    });
    const response = await app.request(
      '/api/v1/projects/proj-a/authoring/operations/render-1/cancel',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      },
    );
    expect(response.status).toBe(200);
    expect(cancel).toHaveBeenCalledWith('render-1');
    const body = (await response.json()) as {
      kind: string;
      status: string;
      progress: { completed: number } | null;
    };
    // The unified receipt DTO carries the record kind/status/progress.
    expect(body.kind).toBe('render');
    expect(body.status).toBe('cancelled');
    expect(body.progress).toEqual({ completed: 2, total: 5 });
    // The broadcast happened with the already-persisted record's receipt.
    expect(published).toHaveLength(1);
    const event = published[0] as {
      type: string;
      receipt: { operationId: string; status: string };
    };
    expect(event.type).toBe('operation-updated');
    expect(event.receipt).toMatchObject({ operationId: 'render-1', status: 'cancelled' });
  });

  it('reports unknown and already-terminal operations without mutating', async () => {
    const cancel = vi.fn(async (operationId: string) =>
      operationId === 'missing'
        ? { status: 'not-found' as const }
        : { status: 'terminal' as const },
    );
    const { app } = harness({ operations: { cancel, get: async () => null } });
    const missing = await app.request(
      '/api/v1/projects/proj-a/authoring/operations/missing/cancel',
      { method: 'POST', body: '{}' },
    );
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({
      error: { code: 'OPERATION_NOT_FOUND' },
    });
    const terminal = await app.request(
      '/api/v1/projects/proj-a/authoring/operations/done-1/cancel',
      { method: 'POST', body: '{}' },
    );
    expect(terminal.status).toBe(409);
    await expect(terminal.json()).resolves.toMatchObject({
      error: { code: 'OPERATION_TERMINAL' },
    });
  });

  it('fails closed when the operation service is not registered', async () => {
    const { app } = harness({ operations: null });
    const response = await app.request(
      '/api/v1/projects/proj-a/authoring/operations/render-1/cancel',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      },
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'AUTHORING_UNAVAILABLE' },
    });
  });
});
