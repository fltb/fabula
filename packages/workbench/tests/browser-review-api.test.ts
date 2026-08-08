import type { ReviewGateV1, ReviewProjectionV1 } from '@novalistically/core';
import type { ReleaseGateResolutionV1 } from '@novalistically/core/editorial';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createBrowserReviewClient } from '../src/client/browser-review-api.js';
import {
  BROWSER_API_VERSION,
  BROWSER_SESSION_HEADER,
  type BrowserReviewAddRequestV1,
  type BrowserReviewCommentV1,
  type BrowserReviewGateDecisionResultV1,
  type BrowserReviewGateListV1,
  type BrowserReviewGateV1,
  type BrowserReviewHistoryV1,
  type BrowserReviewListV1,
  type BrowserSessionPrincipalV1,
} from '../src/contracts/browser-api.js';
import {
  type BrowserReviewApiOptions,
  createBrowserReviewApi,
} from '../src/host/browser-review-api.js';
import type {
  HostNewReviewCommentV1,
  HostReviewCommentV1,
  HostReviewService,
} from '../src/host/review/review-service.js';
import type { HostServer } from '../src/host/server.js';

const NOW = '2099-01-01T00:00:00.000Z';

const principal: BrowserSessionPrincipalV1 = {
  version: 1,
  userId: 'owner-1',
  role: 'owner',
  displayName: 'Owner',
  capabilityVersion: 3,
  expiresAt: NOW,
};

const authHeaders = { [BROWSER_SESSION_HEADER]: 'session-1' };

const openComment: HostReviewCommentV1 = {
  id: 'comment-1',
  author: 'human',
  actorId: 'owner-1',
  target: { type: 'scene', id: 'E1' },
  severity: 'suggestion',
  category: 'reader_experience',
  content: 'Consider tightening this beat.',
  status: 'open',
  applications: [
    {
      eventId: 'E1',
      revisionId: 'rev-3',
      operationId: 'op-3',
      appliedAt: NOW,
    },
  ],
  createdAt: NOW,
};

const supersededComment: HostReviewCommentV1 = {
  ...openComment,
  id: 'comment-0',
  status: 'superseded',
  resolvedAt: NOW,
  resolvedBy: 'owner-1',
};

const openGate: ReviewGateV1 = {
  gateId: 'gate-1',
  sourceHash: 'source-hash',
  eventId: 'E2',
  proseHash: 'prose-hash',
  scopeHash: 'scope-hash',
  validationIdentity: 'validator-v1',
  warningFingerprints: ['warn-1'],
  revisionId: 'rev-9',
  openedAt: NOW,
  openedBy: 'system',
  status: 'open',
  decision: null,
};

const decidedGate: ReviewGateV1 = {
  ...openGate,
  status: 'decided',
  decision: {
    gateId: 'gate-1',
    decision: 'accepted',
    revisionId: 'rev-9',
    capabilityVersion: 3,
    reason: 'LGTM',
    actorId: 'owner-1',
    createdAt: NOW,
  },
};

const resolution: ReleaseGateResolutionV1 = {
  version: 1,
  projectId: 'proj-a',
  gateId: 'gate-1',
  eventId: 'E2',
  candidateRevisionId: 'rev-9',
  outcome: 'accepted',
  acceptedRevisionId: 'rev-9',
  decision: {
    status: 'accepted',
    scopeHash: 'scope-hash',
    validationIdentity: 'validator-v1',
    reasons: [],
  },
  reason: 'LGTM',
  actorId: 'owner-1',
  capabilityVersion: 3,
  decidedAt: NOW,
};

const projection: ReviewProjectionV1 = {
  version: 1,
  events: [
    {
      version: 1,
      sequence: 1,
      projectId: 'proj-a',
      kind: 'comment_added',
      commentId: 'comment-1',
      payload: { comment: { id: 'comment-1' } },
      actorId: 'owner-1',
      createdAt: NOW,
    },
    {
      version: 1,
      sequence: 2,
      projectId: 'proj-a',
      kind: 'comment_status_changed',
      commentId: 'comment-1',
      payload: { to: 'resolved' },
      actorId: 'owner-1',
      createdAt: NOW,
    },
    {
      version: 1,
      sequence: 3,
      projectId: 'proj-a',
      kind: 'comment_applied',
      commentId: 'comment-1',
      payload: {
        application: {
          eventId: 'E1',
          revisionId: 'rev-3',
          operationId: 'op-3',
          appliedAt: NOW,
        },
        addressed: true,
      },
      actorId: 'owner-1',
      createdAt: NOW,
    },
    {
      version: 1,
      sequence: 4,
      projectId: 'proj-a',
      kind: 'gate_opened',
      gateId: 'gate-1',
      payload: { gate: { gateId: 'gate-1', eventId: 'E2' } },
      actorId: 'system',
      createdAt: NOW,
    },
    {
      version: 1,
      sequence: 5,
      projectId: 'proj-a',
      kind: 'gate_decided',
      gateId: 'gate-1',
      payload: {
        decision: {
          gateId: 'gate-1',
          decision: 'accepted',
          revisionId: 'rev-9',
          capabilityVersion: 3,
          reason: 'LGTM',
          actorId: 'owner-1',
          createdAt: NOW,
        },
      },
      actorId: 'owner-1',
      createdAt: NOW,
    },
  ],
  comments: [openComment],
  gates: [openGate],
};

/** The default mock service; tests override per-call behavior through it. */
function mockReviewService(overrides: Partial<HostReviewService> = {}): HostReviewService {
  return {
    projectId: 'proj-a',
    listComments: vi.fn(async () => [openComment]),
    getComment: vi.fn(async (commentId: string) =>
      commentId === openComment.id ? openComment : null,
    ),
    addComment: vi.fn(async (input: HostNewReviewCommentV1) => ({
      ...openComment,
      id: 'comment-new',
      target: input.target,
      severity: input.severity,
      category: input.category,
      content: input.content,
    })),
    updateComment: vi.fn(async (input) => {
      const base = { ...openComment, id: input.commentId };
      if (input.action === 'resolve') return { ...base, status: 'resolved', resolvedAt: NOW };
      if (input.action === 'wontfix') return { ...base, status: 'wontfix', resolvedAt: NOW };
      if (input.action === 'reopen') return { ...base, status: 'open' };
      if (input.action === 'escalate') return { ...base, status: 'open', severity: 'blocking' };
      return {
        ...base,
        content: input.input.content,
        severity: input.input.severity,
        category: input.input.category,
      };
    }),
    listGates: vi.fn(async () => [openGate]),
    decideGate: vi.fn(async () => resolution),
    reviewProjection: vi.fn(async () => projection),
    workflowReviewProjection: vi.fn(async () => ({ open: 1, blocking: 0, pendingGates: 1 })),
    ...overrides,
  };
}

function harness(
  input: {
    readonly service?: HostReviewService | null;
    readonly sessionPrincipal?: BrowserSessionPrincipalV1;
    readonly principal?: BrowserReviewApiOptions['principal'];
    readonly access?: BrowserReviewApiOptions['access'];
    readonly authorization?: BrowserReviewApiOptions['authorization'];
    readonly catalog?: BrowserReviewApiOptions['catalog'];
    readonly capabilities?: BrowserReviewApiOptions['capabilities'] | null;
  } = {},
) {
  const service = input.service === undefined ? mockReviewService() : input.service;
  // Mirrors the launch wiring: the issued grant carries exactly the scope the
  // surface asked for (`mcp:author` for comments, `mcp:submit` for gates).
  const resolveCapability = vi.fn(async (input: { scope: string }) => ({
    capabilityId: 'server-capability',
    userId: 'owner-1',
    projectId: 'proj-a',
    scopes: [input.scope],
    version: 3,
    expiresAt: NOW,
  }));
  const options: BrowserReviewApiOptions = {
    principal:
      input.principal ??
      ({
        resolve: async () => ({ ok: true, principal: input.sessionPrincipal ?? principal }),
      } as BrowserReviewApiOptions['principal']),
    ...(input.access === undefined ? {} : { access: input.access }),
    authorization:
      input.authorization ??
      ({ canAccessProject: async () => true } as BrowserReviewApiOptions['authorization']),
    catalog:
      input.catalog ??
      ({
        listProjects: async () => [
          {
            version: 1,
            projectId: 'proj-a',
            displayName: 'Project A',
            createdAt: NOW,
            updatedAt: NOW,
            open: true,
          },
        ],
      } as BrowserReviewApiOptions['catalog']),
    reviews: { get: async () => service },
    ...(input.capabilities === undefined
      ? { capabilities: { resolve: resolveCapability } }
      : input.capabilities === null
        ? { capabilities: null }
        : { capabilities: input.capabilities }),
    now: () => NOW,
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
  createBrowserReviewApi(options).register(host);
  const app = new Hono();
  for (const [path, handler] of registered.reads) app.get(path, handler as never);
  for (const [path, handler] of registered.mutations) app.post(path, handler as never);
  return { app, service, resolveCapability };
}

async function expectError(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  const body = (await response.json()) as { error: { code: string } };
  expect(body.error.code).toBe(code);
}

describe('browser review API routes', () => {
  it('lists review comments as browser-safe DTOs and drops superseded ones', async () => {
    const service = mockReviewService({
      listComments: vi.fn(async () => [openComment, supersededComment]),
    });
    const { app } = harness({ service });
    const response = await app.request('/api/v1/projects/proj-a/reviews', {
      headers: authHeaders,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as BrowserReviewListV1;
    expect(body.version).toBe(BROWSER_API_VERSION);
    expect(body.projectId).toBe('proj-a');
    expect(body.generatedAt).toBe(NOW);
    expect(body.comments).toHaveLength(1);
    const comment = body.comments[0] as BrowserReviewCommentV1;
    expect(comment.commentId).toBe('comment-1');
    expect(comment.eventId).toBe('E1');
    expect(comment.targetType).toBe('scene');
    expect(comment.severity).toBe('suggestion');
    expect(comment.category).toBe('reader_experience');
    expect(comment.content).toBe('Consider tightening this beat.');
    expect(comment.status).toBe('open');
    expect(comment.author).toBe('human');
    expect(comment.resolvedAt).toBeNull();
    expect(comment.supersedesId).toBeNull();
    expect(comment.applications).toEqual([
      { eventId: 'E1', revisionId: 'rev-3', operationId: 'op-3', appliedAt: NOW },
    ]);
    // Boundary rule: no actor identity crosses the browser surface.
    expect(comment).not.toHaveProperty('actorId');
    expect(JSON.stringify(body)).not.toContain('owner-1');
  });

  it('passes the eventId filter through to the review service', async () => {
    const { app, service } = harness();
    const response = await app.request('/api/v1/projects/proj-a/reviews?eventId=E2', {
      headers: authHeaders,
    });
    expect(response.status).toBe(200);
    expect(service.listComments).toHaveBeenCalledWith({ eventId: 'E2' });
  });

  it('rejects an unbounded eventId filter', async () => {
    const { app, service } = harness();
    const response = await app.request(
      `/api/v1/projects/proj-a/reviews?eventId=${'x'.repeat(5000)}`,
      { headers: authHeaders },
    );
    await expectError(response, 400, 'REVIEW_INVALID');
    expect(service.listComments).not.toHaveBeenCalled();
  });

  it('gets one comment by id', async () => {
    const { app } = harness();
    const response = await app.request('/api/v1/projects/proj-a/reviews/comment-1', {
      headers: authHeaders,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { comment: BrowserReviewCommentV1 };
    expect(body.comment.commentId).toBe('comment-1');
    expect(body.comment.eventId).toBe('E1');
  });

  it('returns REVIEW_COMMENT_NOT_FOUND for missing and superseded comments', async () => {
    const { app } = harness();
    const missing = await app.request('/api/v1/projects/proj-a/reviews/comment-nope', {
      headers: authHeaders,
    });
    await expectError(missing, 404, 'REVIEW_COMMENT_NOT_FOUND');
    const service = mockReviewService({
      getComment: vi.fn(async () => supersededComment),
    });
    const superseded = await harness({ service }).app.request(
      '/api/v1/projects/proj-a/reviews/comment-0',
      { headers: authHeaders },
    );
    await expectError(superseded, 404, 'REVIEW_COMMENT_NOT_FOUND');
  });

  it('renders the safe review event trail in sequence order', async () => {
    const { app } = harness();
    const response = await app.request('/api/v1/projects/proj-a/reviews/history', {
      headers: authHeaders,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as BrowserReviewHistoryV1;
    expect(body.projectId).toBe('proj-a');
    expect(body.entries).toHaveLength(5);
    expect(body.entries.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(body.entries[0]).toMatchObject({
      kind: 'comment_added',
      commentId: 'comment-1',
      gateId: null,
      revisionId: null,
      at: NOW,
    });
    // comment_applied carries the native revision linkage; nothing else does.
    expect(body.entries[2]?.kind).toBe('comment_applied');
    expect(body.entries[2]?.revisionId).toBe('rev-3');
    expect(body.entries[2]?.summary).toContain('applied');
    // Gate events carry their gate id and a rendered summary, never payloads.
    expect(body.entries[3]?.gateId).toBe('gate-1');
    expect(body.entries[3]?.summary).toContain('opened');
    expect(body.entries[4]?.summary).toContain('accepted');
    expect(JSON.stringify(body)).not.toContain('payload');
  });

  it('narrows the history trail to one event', async () => {
    const { app } = harness();
    const response = await app.request('/api/v1/projects/proj-a/reviews/history?eventId=E2', {
      headers: authHeaders,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as BrowserReviewHistoryV1;
    expect(body.entries.map((entry) => entry.sequence)).toEqual([4, 5]);
  });

  it('adds a comment under the author role and an mcp:author grant', async () => {
    const { app, service, resolveCapability } = harness();
    const request: BrowserReviewAddRequestV1 = {
      version: BROWSER_API_VERSION,
      projectId: 'proj-a',
      eventId: 'E1',
      severity: 'blocking',
      category: 'plot_logic',
      content: 'This scene contradicts the established timeline.',
    };
    const response = await app.request('/api/v1/projects/proj-a/reviews', {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { comment: BrowserReviewCommentV1 };
    expect(body.comment.commentId).toBe('comment-new');
    expect(body.comment.eventId).toBe('E1');
    expect(body.comment.severity).toBe('blocking');
    const addCall = (service.addComment as ReturnType<typeof vi.fn>).mock.calls[0] as [
      HostNewReviewCommentV1,
      { userId: string; grant: { scopes: string[] } },
    ];
    expect(addCall[0].target).toEqual({ type: 'scene', id: 'E1' });
    expect(addCall[1].userId).toBe('owner-1');
    expect(addCall[1].grant.scopes).toContain('mcp:author');
    expect(resolveCapability).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'mcp:author' }),
    );
  });

  it('denies comment add to a reader', async () => {
    const access = {
      authorize: async ({ requiredRole }: { requiredRole: string }) => ({
        ok: requiredRole === 'reader',
      }),
    } as BrowserReviewApiOptions['access'];
    const { app, service } = harness({ access });
    const response = await app.request('/api/v1/projects/proj-a/reviews', {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        version: BROWSER_API_VERSION,
        projectId: 'proj-a',
        eventId: 'E1',
        severity: 'nit',
        category: 'style',
        content: 'Typo.',
      }),
    });
    await expectError(response, 403, 'PROJECT_MISMATCH');
    expect(service.addComment).not.toHaveBeenCalled();
  });

  it('fails comment add closed when the capability resolver is absent', async () => {
    const { app, service } = harness({ capabilities: null });
    const response = await app.request('/api/v1/projects/proj-a/reviews', {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        version: BROWSER_API_VERSION,
        projectId: 'proj-a',
        eventId: 'E1',
        severity: 'nit',
        category: 'style',
        content: 'Typo.',
      }),
    });
    await expectError(response, 503, 'REVIEW_UNAVAILABLE');
    expect(service.addComment).not.toHaveBeenCalled();
  });

  it('rejects malformed add requests without touching the service', async () => {
    const { app, service } = harness();
    const cases = [
      {
        version: 2,
        projectId: 'proj-a',
        eventId: 'E1',
        severity: 'nit',
        category: 'style',
        content: 'x',
      },
      {
        version: 1,
        projectId: 'proj-b',
        eventId: 'E1',
        severity: 'nit',
        category: 'style',
        content: 'x',
      },
      {
        version: 1,
        projectId: 'proj-a',
        eventId: 'E1',
        severity: 'loud',
        category: 'style',
        content: 'x',
      },
      { version: 1, projectId: 'proj-a', eventId: 'E1', severity: 'nit', category: 'style' },
      {
        version: 1,
        projectId: 'proj-a',
        eventId: 'E1',
        severity: 'nit',
        category: 'style',
        content: '',
      },
    ];
    for (const request of cases) {
      const response = await app.request('/api/v1/projects/proj-a/reviews', {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
      await expectError(response, 400, 'REVIEW_INVALID');
    }
    expect(service.addComment).not.toHaveBeenCalled();
  });

  it('updates a comment lifecycle status under the author role', async () => {
    const { app, service } = harness();
    const response = await app.request('/api/v1/projects/proj-a/reviews/comment-1', {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        version: BROWSER_API_VERSION,
        projectId: 'proj-a',
        commentId: 'comment-1',
        action: 'resolve',
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { comment: BrowserReviewCommentV1 };
    expect(body.comment.status).toBe('resolved');
    const updateCall = (service.updateComment as ReturnType<typeof vi.fn>).mock.calls[0] as [
      { action: string; commentId: string },
      unknown,
    ];
    expect(updateCall[0]).toEqual({ action: 'resolve', commentId: 'comment-1' });
  });

  it('replaces a comment reusing the original target and fallback severity/category', async () => {
    const { app, service } = harness();
    const response = await app.request('/api/v1/projects/proj-a/reviews/comment-1', {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        version: BROWSER_API_VERSION,
        projectId: 'proj-a',
        commentId: 'comment-1',
        action: 'replace',
        content: 'Rewritten note.',
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { comment: BrowserReviewCommentV1 };
    expect(body.comment.content).toBe('Rewritten note.');
    expect(body.comment.severity).toBe('suggestion');
    const updateCall = (service.updateComment as ReturnType<typeof vi.fn>).mock.calls[0] as [
      { action: 'replace'; commentId: string; input: HostNewReviewCommentV1 },
      unknown,
    ];
    expect(updateCall[0].input.target).toEqual({ type: 'scene', id: 'E1' });
    expect(updateCall[0].input.severity).toBe('suggestion');
    expect(updateCall[0].input.category).toBe('reader_experience');
    expect(updateCall[0].input.content).toBe('Rewritten note.');
  });

  it('rejects non-replace updates carrying replace-only fields', async () => {
    const { app, service } = harness();
    const response = await app.request('/api/v1/projects/proj-a/reviews/comment-1', {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        version: BROWSER_API_VERSION,
        projectId: 'proj-a',
        commentId: 'comment-1',
        action: 'reopen',
        content: 'nope',
      }),
    });
    await expectError(response, 400, 'REVIEW_INVALID');
    expect(service.updateComment).not.toHaveBeenCalled();
  });

  it('maps a missing comment to REVIEW_COMMENT_NOT_FOUND', async () => {
    const service = mockReviewService({
      updateComment: vi.fn(async () => {
        throw Object.assign(new Error('Comment comment-nope not found'), {
          code: 'INVALID_OPERATION',
        });
      }),
    });
    const { app } = harness({ service });
    const response = await app.request('/api/v1/projects/proj-a/reviews/comment-nope', {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        version: BROWSER_API_VERSION,
        projectId: 'proj-a',
        commentId: 'comment-nope',
        action: 'resolve',
      }),
    });
    await expectError(response, 404, 'REVIEW_COMMENT_NOT_FOUND');
  });

  it('maps a raced review ledger to REVIEW_INVALID', async () => {
    const service = mockReviewService({
      updateComment: vi.fn(async () => {
        throw Object.assign(new Error('Expected review ledger hash does not match'), {
          code: 'STORAGE_CONFLICT',
        });
      }),
    });
    const { app } = harness({ service });
    const response = await app.request('/api/v1/projects/proj-a/reviews/comment-1', {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        version: BROWSER_API_VERSION,
        projectId: 'proj-a',
        commentId: 'comment-1',
        action: 'resolve',
      }),
    });
    await expectError(response, 400, 'REVIEW_INVALID');
  });

  it('lists release gates as browser-safe DTOs', async () => {
    const { app, service } = harness();
    const response = await app.request('/api/v1/projects/proj-a/gates', {
      headers: authHeaders,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as BrowserReviewGateListV1;
    expect(body.projectId).toBe('proj-a');
    expect(body.gates).toHaveLength(1);
    const gate = body.gates[0] as BrowserReviewGateV1;
    expect(gate.gateId).toBe('gate-1');
    expect(gate.eventId).toBe('E2');
    expect(gate.sourceHash).toBe('source-hash');
    expect(gate.proseHash).toBe('prose-hash');
    expect(gate.scopeHash).toBe('scope-hash');
    expect(gate.validationIdentity).toBe('validator-v1');
    expect(gate.warningFingerprints).toEqual(['warn-1']);
    expect(gate.revisionId).toBe('rev-9');
    expect(gate.status).toBe('open');
    expect(gate.decision).toBeNull();
    expect(gate.openedAt).toBe(NOW);
    expect(gate.supersededAt).toBeNull();
    // Boundary rule: no actor identity crosses the browser surface.
    expect(gate).not.toHaveProperty('openedBy');
    const filtered = await app.request('/api/v1/projects/proj-a/gates?eventId=E2', {
      headers: authHeaders,
    });
    expect(filtered.status).toBe(200);
    expect(service.listGates).toHaveBeenCalledWith('E2');
  });

  it('decides an open gate under the maintainer role and an mcp:submit grant', async () => {
    const { app, service, resolveCapability } = harness();
    const response = await app.request('/api/v1/projects/proj-a/gates/gate-1/decision', {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        version: BROWSER_API_VERSION,
        projectId: 'proj-a',
        gateId: 'gate-1',
        decision: 'accept',
        reason: 'Warnings are waived.',
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as BrowserReviewGateDecisionResultV1;
    expect(body.version).toBe(BROWSER_API_VERSION);
    expect(body.projectId).toBe('proj-a');
    expect(body.gateId).toBe('gate-1');
    expect(body.eventId).toBe('E2');
    expect(body.outcome).toBe('accepted');
    expect(body.decisionStatus).toBe('accepted');
    expect(body.decidedAt).toBe(NOW);
    const decideCall = (service.decideGate as ReturnType<typeof vi.fn>).mock.calls[0] as [
      { eventId: string; candidateRevisionId: string; decision: string; reason: string },
      { userId: string; grant: { scopes: string[] } },
    ];
    expect(decideCall[0]).toEqual({
      eventId: 'E2',
      candidateRevisionId: 'rev-9',
      decision: 'accept',
      reason: 'Warnings are waived.',
    });
    expect(decideCall[1].userId).toBe('owner-1');
    expect(decideCall[1].grant.scopes).toContain('mcp:submit');
    expect(resolveCapability).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'mcp:submit' }),
    );
  });

  it('surfaces a stale gate decision as a typed result', async () => {
    const service = mockReviewService({
      decideGate: vi.fn(async () => ({
        ...resolution,
        outcome: 'stale' as const,
        acceptedRevisionId: null,
      })),
    });
    const { app } = harness({ service });
    const response = await app.request('/api/v1/projects/proj-a/gates/gate-1/decision', {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        version: BROWSER_API_VERSION,
        projectId: 'proj-a',
        gateId: 'gate-1',
        decision: 'accept',
        reason: 'Retry.',
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as BrowserReviewGateDecisionResultV1;
    expect(body.outcome).toBe('stale');
  });

  it('denies gate decision to an author', async () => {
    const access = {
      authorize: async ({ requiredRole }: { requiredRole: string }) => ({
        ok: requiredRole === 'reader' || requiredRole === 'author',
      }),
    } as BrowserReviewApiOptions['access'];
    const { app, service } = harness({ access });
    const response = await app.request('/api/v1/projects/proj-a/gates/gate-1/decision', {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        version: BROWSER_API_VERSION,
        projectId: 'proj-a',
        gateId: 'gate-1',
        decision: 'reject',
        reason: 'Not ready.',
      }),
    });
    await expectError(response, 403, 'PROJECT_MISMATCH');
    expect(service.decideGate).not.toHaveBeenCalled();
  });

  it('returns GATE_NOT_FOUND for an unlisted gate', async () => {
    const { app, service } = harness();
    const response = await app.request('/api/v1/projects/proj-a/gates/gate-nope/decision', {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        version: BROWSER_API_VERSION,
        projectId: 'proj-a',
        gateId: 'gate-nope',
        decision: 'accept',
        reason: 'x',
      }),
    });
    await expectError(response, 404, 'GATE_NOT_FOUND');
    expect(service.decideGate).not.toHaveBeenCalled();
  });

  it('returns GATE_NOT_OPEN for an already-decided gate', async () => {
    const service = mockReviewService({ listGates: vi.fn(async () => [decidedGate]) });
    const { app } = harness({ service });
    const response = await app.request('/api/v1/projects/proj-a/gates/gate-1/decision', {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        version: BROWSER_API_VERSION,
        projectId: 'proj-a',
        gateId: 'gate-1',
        decision: 'accept',
        reason: 'x',
      }),
    });
    await expectError(response, 409, 'GATE_NOT_OPEN');
  });

  it('maps an archived-candidate miss to GATE_NOT_FOUND', async () => {
    const service = mockReviewService({
      decideGate: vi.fn(async () => {
        throw Object.assign(new Error('Candidate revision rev-9 is not archived'), {
          code: 'REVISION_NOT_FOUND',
        });
      }),
    });
    const { app } = harness({ service });
    const response = await app.request('/api/v1/projects/proj-a/gates/gate-1/decision', {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        version: BROWSER_API_VERSION,
        projectId: 'proj-a',
        gateId: 'gate-1',
        decision: 'accept',
        reason: 'x',
      }),
    });
    await expectError(response, 404, 'GATE_NOT_FOUND');
  });

  it('rejects malformed gate decision requests', async () => {
    const { app, service } = harness();
    const cases = [
      { version: 1, projectId: 'proj-a', gateId: 'gate-1', decision: 'maybe', reason: 'x' },
      { version: 1, projectId: 'proj-a', gateId: 'gate-1', decision: 'accept' },
      { version: 1, projectId: 'proj-a', gateId: 'gate-1', decision: 'accept', reason: '' },
      { version: 1, projectId: 'proj-b', gateId: 'gate-1', decision: 'accept', reason: 'x' },
      { version: 1, projectId: 'proj-a', gateId: 'gate-other', decision: 'accept', reason: 'x' },
    ];
    for (const request of cases) {
      const response = await app.request('/api/v1/projects/proj-a/gates/gate-1/decision', {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
      await expectError(response, 400, 'GATE_DECISION_INVALID');
    }
    expect(service.decideGate).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when the review service is absent', async () => {
    const { app } = harness({ service: null });
    const list = await app.request('/api/v1/projects/proj-a/reviews', { headers: authHeaders });
    await expectError(list, 503, 'REVIEW_UNAVAILABLE');
    const decide = await app.request('/api/v1/projects/proj-a/gates/gate-1/decision', {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        version: BROWSER_API_VERSION,
        projectId: 'proj-a',
        gateId: 'gate-1',
        decision: 'accept',
        reason: 'x',
      }),
    });
    await expectError(decide, 503, 'REVIEW_UNAVAILABLE');
  });

  it('denies a project that is not in the session catalogue', async () => {
    const catalog = {
      listProjects: async () => [],
    } as unknown as BrowserReviewApiOptions['catalog'];
    const { app } = harness({ catalog });
    const response = await app.request('/api/v1/projects/proj-b/reviews', {
      headers: authHeaders,
    });
    await expectError(response, 404, 'PROJECT_NOT_FOUND');
  });

  it('rejects unknown or missing sessions with 401', async () => {
    const { app, service } = harness({
      principal: {
        resolve: async () => ({ ok: false as const, failure: 'SESSION_NOT_FOUND' as const }),
      },
    });
    const response = await app.request('/api/v1/projects/proj-a/reviews');
    await expectError(response, 401, 'SESSION_NOT_FOUND');
    expect(service.listComments).not.toHaveBeenCalled();
  });
});

describe('browser review client wire shape', () => {
  it('drives every route through the real client and typed error envelope', async () => {
    const { app, service } = harness();
    const client = createBrowserReviewClient({
      baseUrl: 'http://localhost',
      fetch: (input, init) => app.request(String(input), init),
      getSessionId: () => 'session-1',
    });

    const list = await client.list('proj-a');
    expect(list.comments).toHaveLength(1);
    expect(list.comments[0]?.commentId).toBe('comment-1');

    const one = await client.get('proj-a', 'comment-1');
    expect(one.comment.eventId).toBe('E1');

    const added = await client.add({
      version: BROWSER_API_VERSION,
      projectId: 'proj-a',
      eventId: 'E1',
      severity: 'blocking',
      category: 'plot_logic',
      content: 'Timeline contradiction.',
    });
    expect(added.comment.commentId).toBe('comment-new');

    const updated = await client.update({
      version: BROWSER_API_VERSION,
      projectId: 'proj-a',
      commentId: 'comment-1',
      action: 'replace',
      content: 'Rewritten.',
    });
    expect(updated.comment.content).toBe('Rewritten.');

    const history = await client.history('proj-a');
    expect(history.entries).toHaveLength(5);

    const gates = await client.gateList('proj-a');
    expect(gates.gates[0]?.gateId).toBe('gate-1');

    const decision = await client.gateDecide({
      version: BROWSER_API_VERSION,
      projectId: 'proj-a',
      gateId: 'gate-1',
      decision: 'accept',
      reason: 'LGTM',
    });
    expect(decision.outcome).toBe('accepted');
    expect(decision.decisionStatus).toBe('accepted');

    // The typed error envelope round-trips through the client's code map.
    const missing = await client.get('proj-a', 'comment-nope').catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(Error);
    const typed = missing as { status: number; code: string };
    expect(typed.status).toBe(404);
    expect(typed.code).toBe('REVIEW_COMMENT_NOT_FOUND');
  });

  it('round-trips the eventId query through the client', async () => {
    const { app, service } = harness();
    const client = createBrowserReviewClient({
      baseUrl: 'http://localhost',
      fetch: (input, init) => app.request(String(input), init),
      getSessionId: () => 'session-1',
    });
    await client.list('proj-a', { eventId: 'E2' });
    expect(service.listComments).toHaveBeenCalledWith({ eventId: 'E2' });
  });
});
