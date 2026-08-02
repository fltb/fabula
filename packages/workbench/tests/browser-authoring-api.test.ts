import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { AuthoringCoordinator } from '../src/host/authoring/types.js';
import type { AuthoringOperationReceiptV1, AuthoringStateV1 } from '../src/contracts/authoring.js';
import type { BrowserSessionPrincipalV1 } from '../src/contracts/browser-api.js';
import type { HostServer } from '../src/host/server.js';
import {
  createBrowserAuthoringApi,
  type BrowserAuthoringApiOptions,
} from '../src/host/browser-authoring-api.js';

const principal: BrowserSessionPrincipalV1 = {
  version: 1,
  userId: 'owner-1',
  role: 'owner',
  displayName: 'Owner',
  capabilityVersion: 3,
  expiresAt: '2099-01-01T00:00:00.000Z',
};

const state: AuthoringStateV1 = {
  version: 1,
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
  version: 1,
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

function harness() {
  const submit = vi.fn(async () => receipt);
  const reconcile = vi.fn(async () => ({ ...receipt, kind: 'reconcile-external' as const }));
  const coordinator = {
    projectId: 'proj-a',
    getState: () => state,
    listOperations: () => [receipt],
    getOperation: (operationId: string) => (operationId === receipt.operationId ? receipt : null),
    isAgentPaused: () => false,
    notifyExternalChange: async () => undefined,
    submit,
    reconcileExternal: reconcile,
    refreshAccepted: async () => undefined,
    dispose: async () => undefined,
  } satisfies AuthoringCoordinator;
  const options: BrowserAuthoringApiOptions = {
    principal: { resolve: async () => ({ ok: true, principal }) },
    authorization: { canAccessProject: () => true },
    catalog: {
      listProjects: async () => [
        {
          version: 1,
          projectId: 'proj-a',
          displayName: 'Project A',
          createdAt: principal.expiresAt,
          updatedAt: principal.expiresAt,
          open: true,
        },
      ],
    },
    coordinators: { get: () => coordinator },
    capabilities: {
      resolve: async () => ({ capabilityId: 'server-capability', scopes: ['authoring:submit'] }),
    },
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
  return { app, submit, reconcile };
}

describe('browser authoring API', () => {
  it('rejects actor/capability/root/head fields before reaching the coordinator', async () => {
    const { app, submit } = harness();
    const response = await app.request('/api/v1/projects/proj-a/authoring/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 1,
        projectId: 'proj-a',
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
        version: 1,
        projectId: 'proj-a',
        expectedAcceptedSourceHash: 'accepted-hash',
        expectedWorkspaceDigest: 'workspace-hash',
      }),
    });
    expect(response.status).toBe(202);
    expect(submit).toHaveBeenCalledWith({
      expectedAcceptedSourceHash: 'accepted-hash',
      expectedWorkspaceDigest: 'workspace-hash',
      actorId: 'owner-1',
      capabilityId: 'server-capability',
      capabilityScopes: ['authoring:submit'],
    });
  });
});
