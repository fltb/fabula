import { describe, expect, it } from 'vitest';
import {
  type BrowserFetch,
  createBrowserAuthoringClient,
} from '../../src/client/authoring-client.js';
import { createProjectEventClient } from '../../src/client/project-event-client.js';
import type {
  AuthoringActivityEventV1,
  AuthoringOperationReceiptV1,
  AuthoringStateV1,
} from '../../src/contracts/authoring.js';

const state: AuthoringStateV1 = {
  version: 2,
  projectId: 'proj-a',
  phase: 'clean',
  acceptedRevisionId: null,
  acceptedSourceHash: 'accepted-hash',
  pendingOperationId: null,
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
  version: 2,
  projectId: 'proj-a',
  operationId: 'op-1',
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

const revision = {
  version: 2 as const,
  revisionId: 'revision-1',
  sourceHash: 'native-source-hash',
  createdAt: '2099-01-01T00:00:00.000Z',
  acceptedAt: '2099-01-01T00:00:00.000Z',
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
      version: 2,
      projectId: 'proj-a',
      expectedAcceptedRevisionId: null,
      expectedAcceptedSourceHash: 'accepted-hash',
      expectedWorkspaceDigest: 'workspace-hash',
    });
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      version: 2,
      projectId: 'proj-a',
      expectedAcceptedRevisionId: null,
      expectedAcceptedSourceHash: 'accepted-hash',
      expectedWorkspaceDigest: 'workspace-hash',
    });
    expect(body.actorId).toBeUndefined();
    expect(new Headers(calls[0]?.init?.headers).get('x-fabula-session')).toBe('transient-session');
  });

  it('reads native revision history and sends restore CAS fields', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetch: BrowserFetch = async (input, init) => {
      calls.push({ input, init });
      const url = String(input);
      if (url.includes('/revisions/restore')) {
        return json({
          version: 2,
          status: 'accepted',
          revisionId: 'revision-2',
          receiptHash: 'receipt-2',
        });
      }
      if (url.includes('/revisions?')) {
        return json({
          version: 2,
          projectId: 'proj-a',
          revisions: [revision],
          generatedAt: revision.createdAt,
        });
      }
      if (url.includes('/revisions/revision-1')) {
        return json({ version: 2, projectId: 'proj-a', revision, generatedAt: revision.createdAt });
      }
      return json({
        version: 2,
        projectId: 'proj-a',
        fromRevisionId: 'revision-1',
        toRevisionId: 'revision-2',
        changes: [],
        generatedAt: revision.createdAt,
      });
    };
    const client = createBrowserAuthoringClient({ fetch });
    await expect(client.listRevisions('proj-a', 'cursor-1')).resolves.toMatchObject({
      revisions: [revision],
    });
    await expect(client.getRevision('proj-a', revision.revisionId)).resolves.toMatchObject({
      revision,
    });
    await expect(client.diffRevisions('proj-a', 'revision-1', 'revision-2')).resolves.toMatchObject(
      {
        changes: [],
      },
    );
    await client.restoreRevision({
      version: 2,
      projectId: 'proj-a',
      revisionId: revision.revisionId,
      expectedAcceptedRevisionId: 'head-1',
      expectedSourceHash: 'native-source-hash',
    });
    const restore = calls.find((call) => String(call.input).includes('/revisions/restore'));
    expect(JSON.parse(String(restore?.init?.body))).toMatchObject({
      expectedAcceptedRevisionId: 'head-1',
      expectedSourceHash: 'native-source-hash',
    });
  });

  it('reduces safe SSE operation and presence events without HTTP on apply', async () => {
    const event: AuthoringActivityEventV1 = {
      type: 'presence-changed',
      version: 2,
      projectId: 'proj-a',
      generation: 4,
      presence: [{ actorId: 'owner-1', surface: 'browser', since: '2099-01-01T00:00:00.000Z' }],
      at: '2099-01-01T00:00:00.000Z',
    };
    const requests = 0;
    const fakeClient = {
      getState: async () => state,
      listOperations: async () => ({
        version: 2 as const,
        projectId: 'proj-a',
        operations: [],
        generatedAt: state.generatedAt,
      }),
      getOperation: async () => operation,
      submit: async () => ({ status: 'queued' as const, receipt: operation }),
      reconcile: async () => ({ status: 'queued' as const, receipt: operation }),
      subscribeEvents: () => ({ ready: Promise.resolve(), close: () => undefined }),
      listRevisions: async () => ({
        version: 2 as const,
        projectId: 'proj-a',
        revisions: [],
        generatedAt: state.generatedAt,
      }),
      getRevision: async () => ({
        version: 2 as const,
        projectId: 'proj-a',
        revision,
        generatedAt: state.generatedAt,
      }),
      diffRevisions: async () => ({
        version: 2 as const,
        projectId: 'proj-a',
        fromRevisionId: 'a',
        toRevisionId: 'b',
        changes: [],
        generatedAt: state.generatedAt,
      }),
      restoreRevision: async () => ({
        version: 2 as const,
        status: 'accepted' as const,
        revisionId: 'revision-2',
        receiptHash: 'receipt-2',
      }),
    };
    const client = createProjectEventClient({ projectId: 'proj-a', client: fakeClient });
    await client.start();
    client.apply(event);
    expect(client.snapshot().presenceGeneration).toBe(4);
    expect(client.snapshot().presence[0]?.actorId).toBe('owner-1');
    expect(requests).toBe(0);
  });
});
