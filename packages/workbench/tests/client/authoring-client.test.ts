import { describe, expect, it } from 'vitest';
import type {
  AuthoringActivityEventV1,
  AuthoringOperationReceiptV1,
  AuthoringStateV1,
} from '../../src/contracts/authoring.js';
import {
  createBrowserAuthoringClient,
  type BrowserFetch,
} from '../../src/client/authoring-client.js';
import { createProjectEventClient } from '../../src/client/project-event-client.js';

const state: AuthoringStateV1 = {
  version: 1,
  projectId: 'proj-a',
  phase: 'clean',
  acceptedSourceHash: 'accepted-hash',
  workingDirty: false,
  workspaceDigest: 'workspace-hash',
  externalCandidate: null,
  conflicts: [],
  diagnostics: [],
  canSubmit: false,
  submitBlockReason: 'not-dirty',
  generatedAt: '2099-01-01T00:00:00.000Z',
};

const operation: AuthoringOperationReceiptV1 = {
  version: 1,
  projectId: 'proj-a',
  operationId: 'op-1',
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

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('browser authoring client', () => {
  it('sends only versioned CAS fields for explicit submit', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetch: BrowserFetch = async (input, init) => {
      calls.push({ input, init });
      return json({ status: 'queued', receipt: operation });
    };
    const client = createBrowserAuthoringClient({
      fetch,
      getSessionId: () => 'transient-session',
    });
    await client.submit({
      version: 1,
      projectId: 'proj-a',
      expectedAcceptedSourceHash: 'accepted-hash',
      expectedWorkspaceDigest: 'workspace-hash',
    });
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      version: 1,
      projectId: 'proj-a',
      expectedAcceptedSourceHash: 'accepted-hash',
      expectedWorkspaceDigest: 'workspace-hash',
    });
    expect(body.actorId).toBeUndefined();
    expect(new Headers(calls[0]?.init?.headers).get('x-fabula-session')).toBe('transient-session');
  });

  it('reduces safe SSE operation and presence events without HTTP on apply', async () => {
    const event: AuthoringActivityEventV1 = {
      type: 'presence-changed',
      version: 1,
      projectId: 'proj-a',
      generation: 4,
      presence: [{ actorId: 'owner-1', surface: 'browser', since: '2099-01-01T00:00:00.000Z' }],
      at: '2099-01-01T00:00:00.000Z',
    };
    let requests = 0;
    const fakeClient = {
      getState: async () => state,
      listOperations: async () => ({ version: 1 as const, projectId: 'proj-a', operations: [], generatedAt: state.generatedAt }),
      getOperation: async () => operation,
      submit: async () => ({ status: 'queued' as const, receipt: operation }),
      reconcile: async () => ({ status: 'queued' as const, receipt: operation }),
      subscribeEvents: () => ({ ready: Promise.resolve(), close: () => undefined }),
    };
    const client = createProjectEventClient({ projectId: 'proj-a', client: fakeClient });
    await client.start();
    client.apply(event);
    expect(client.snapshot().presenceGeneration).toBe(4);
    expect(client.snapshot().presence[0]?.actorId).toBe('owner-1');
    expect(requests).toBe(0);
  });
});
