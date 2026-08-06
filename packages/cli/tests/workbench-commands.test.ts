import { spawn } from 'node:child_process';
import http from 'node:http';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const cliEntry = join(root, 'packages/cli/dist/index.js');

interface RecordedRequest {
  readonly name: string;
  readonly arguments: unknown;
}

interface CliRunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly requests: readonly RecordedRequest[];
}

type Handler = unknown | ((request: RecordedRequest) => unknown);

function mcpResponse(payload: unknown): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
  });
}

/**
 * Run the built CLI in via-workbench mode against an in-process fake Host MCP
 * endpoint. The child process is a real Node spawn, so loopback networking is
 * available to it even though the test process denies outbound connections.
 */
async function runViaWorkbench(
  args: readonly string[],
  handlers: Readonly<Record<string, Handler>>,
): Promise<CliRunResult> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const message = JSON.parse(body) as {
        params?: { name?: unknown; arguments?: unknown };
      };
      const name = typeof message.params?.name === 'string' ? message.params.name : '';
      const record: RecordedRequest = { name, arguments: message.params?.arguments };
      requests.push(record);
      const handler = handlers[name];
      const payload = typeof handler === 'function' ? handler(record) : handler;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(mcpResponse(payload));
    });
  });
  await new Promise<void>((listen) => server.listen(0, '127.0.0.1', listen));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Test server did not bind.');
  try {
    const { promise, resolve: resolveExit, reject } = Promise.withResolvers<CliRunResult>();
    const child = spawn(
      process.execPath,
      [
        cliEntry,
        '--mode',
        'via-workbench',
        '--project',
        'novel',
        '--host',
        `http://127.0.0.1:${address.port}`,
        ...args,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          NOVALISTICALLY_WORKBENCH_DEVICE_CREDENTIAL: 'opaque-device-token',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => reject(error));
    child.on('close', (code) => resolveExit({ status: code, stdout, stderr, requests }));
    return await promise;
  } finally {
    await new Promise<void>((close) => server.close(() => close()));
  }
}

const authoringStatusPayload = {
  version: 2,
  projectId: 'novel',
  state: {
    version: 2,
    projectId: 'novel',
    phase: 'dirty',
    acceptedRevisionId: null,
    acceptedSourceHash: 'accepted-hash',
    pendingOperationId: null,
    workingDirty: true,
    workspaceDigest: 'digest-1',
    externalCandidate: null,
    conflicts: [],
    diagnostics: [],
    canSubmit: true,
    submitBlockReason: 'none',
    generatedAt: '2026-08-06T00:00:00.000Z',
  },
  generatedAt: '2026-08-06T00:00:00.000Z',
};

const queuedReceipt = {
  version: 2,
  operationId: 'op-1',
  projectId: 'novel',
  kind: 'submit',
  status: 'queued',
  acceptedSourceHash: null,
  acceptedRevisionId: null,
  pendingOperationId: 'op-1',
  revisionId: null,
  receiptHash: null,
  errorCode: null,
  createdAt: '2026-08-06T00:00:00.000Z',
  updatedAt: '2026-08-06T00:00:00.000Z',
} as const;

describe('via-workbench CLI command routing', () => {
  it('routes source validate --working through authoring status to working validation', async () => {
    const result = await runViaWorkbench(['source', 'validate', '--working'], {
      nova_authoring_status: authoringStatusPayload,
      nova_authoring_validate: {
        version: 2,
        layer: 'working',
        projectId: 'novel',
        workspaceDigest: 'digest-1',
        acceptedSourceHash: 'accepted-hash',
        candidateSourceHash: 'candidate-hash',
        passed: true,
        diagnostics: [],
        iss: { overall: 1, target: 1, dimensions: [] },
        results: {},
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.requests.map((request) => request.name)).toEqual([
      'nova_authoring_status',
      'nova_authoring_validate',
    ]);
    expect(result.requests[1].arguments).toMatchObject({
      version: 2,
      expectedWorkspaceDigest: 'digest-1',
      expectedAcceptedSourceHash: 'accepted-hash',
    });
    expect(result.stdout).toContain('"candidateSourceHash": "candidate-hash"');
    expect(result.stdout).toContain('"layer": "working"');
    expect(result.stdout).toContain('Next step: run "nova source submit"');
  });

  it('keeps source validate without --working on the accepted layer', async () => {
    const result = await runViaWorkbench(['source', 'validate'], {
      nova_validate: { layer: 'accepted', passed: true, results: {} },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.requests.map((request) => request.name)).toEqual(['nova_validate']);
    expect(result.stdout).toContain('"layer": "accepted"');
  });

  it('submits the working layer with the message and prints the operation next step', async () => {
    const result = await runViaWorkbench(['source', 'submit', '--message', 'hello'], {
      nova_authoring_status: authoringStatusPayload,
      nova_authoring_submit: { status: 'queued', receipt: queuedReceipt },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.requests.map((request) => request.name)).toEqual([
      'nova_authoring_status',
      'nova_authoring_submit',
    ]);
    expect(result.requests[1].arguments).toMatchObject({
      version: 2,
      expectedWorkspaceDigest: 'digest-1',
      message: 'hello',
    });
    expect(result.stdout).toContain('"status": "queued"');
    expect(result.stdout).toContain('Next step: run "nova operation wait op-1"');
  });

  it('waits on an operation until a terminal status', async () => {
    let polls = 0;
    const result = await runViaWorkbench(
      ['operation', 'wait', 'op-1', '--timeout', '5', '--interval', '20'],
      {
        nova_operation_get: () => {
          polls += 1;
          return {
            version: 2,
            operationId: 'op-1',
            receipt:
              polls === 1
                ? { ...queuedReceipt, status: 'running' }
                : { ...queuedReceipt, status: 'completed', revisionId: 'rev-1' },
          };
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(polls).toBeGreaterThanOrEqual(2);
    expect(result.requests.every((request) => request.name === 'nova_operation_get')).toBe(true);
    expect(result.stdout).toContain('"status": "completed"');
  });

  it('gives up on an operation after the bounded timeout', async () => {
    const result = await runViaWorkbench(
      ['operation', 'wait', 'op-1', '--timeout', '0.2', '--interval', '20'],
      {
        nova_operation_get: {
          version: 2,
          operationId: 'op-1',
          receipt: { ...queuedReceipt, status: 'running' },
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('did not reach a terminal state');
  });

  it('reports operation cancel as unsupported instead of inventing a tool', async () => {
    const result = await runViaWorkbench(['operation', 'cancel', 'op-1'], {});

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('no nova_operation_cancel tool');
    expect(result.requests).toHaveLength(0);
  });

  it('reads the conflict state with its proposed resolution', async () => {
    const result = await runViaWorkbench(['authoring', 'conflict'], {
      nova_authoring_conflict_read: {
        version: 2,
        conflicts: [
          {
            logicalPath: 'chapters/chapter_01/E1.yaml',
            kind: 'working-vs-external',
            baseSourceHash: 'base-hash',
            workingHash: 'working-hash',
            externalHash: 'external-hash',
            proposedDisjointMerge: true,
          },
        ],
        workspaceDigest: 'digest-1',
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.requests.map((request) => request.name)).toEqual([
      'nova_authoring_conflict_read',
    ]);
    expect(result.requests[0].arguments).toEqual({ version: 2 });
    expect(result.stdout).toContain('"proposedDisjointMerge": true');
    expect(result.stdout).toContain('nova authoring resolve --choice');
  });

  it('rejects an invalid resolve choice before any Host call', async () => {
    const result = await runViaWorkbench(['authoring', 'resolve', '--choice', 'bogus'], {});

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      '--choice must be keep-working, accept-external, or apply-proposed-disjoint-merge',
    );
    expect(result.requests).toHaveLength(0);
  });

  it('resolves a conflict with the selected choice and candidate hash', async () => {
    const result = await runViaWorkbench(
      ['authoring', 'resolve', '--choice', 'accept-external', '--candidate-hash', 'candidate-hash'],
      {
        nova_conflict_resolve: { status: 'queued', receipt: queuedReceipt },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.requests.map((request) => request.name)).toEqual(['nova_conflict_resolve']);
    expect(result.requests[0].arguments).toEqual({
      version: 2,
      choice: 'accept-external',
      candidateHash: 'candidate-hash',
    });
  });

  it('routes revise instruction and review ids to nova_revise', async () => {
    const result = await runViaWorkbench(
      ['revise', 'E1', '--instruction', 'Make it darker', '--review-ids', 'review-1, review-2'],
      {
        nova_revise: { status: 'queued', receipt: queuedReceipt },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.requests.map((request) => request.name)).toEqual(['nova_revise']);
    expect(result.requests[0].arguments).toMatchObject({
      sceneSelector: { type: 'events', eventIds: ['E1'] },
      instruction: 'Make it darker',
      reviewIds: ['review-1', 'review-2'],
    });
  });

  it('prints the before/after/changed world state for one event', async () => {
    const result = await runViaWorkbench(['event-diff', 'E1'], {
      nova_event_state_diff: {
        eventId: 'E1',
        before: { info: { currentEra: 'initial' } },
        after: { info: { currentEra: 'war' } },
        changed: ['info.currentEra'],
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.requests.map((request) => request.name)).toEqual(['nova_event_state_diff']);
    expect(result.requests[0].arguments).toEqual({ eventId: 'E1' });
    expect(result.stdout).toContain('"currentEra": "initial"');
    expect(result.stdout).toContain('"currentEra": "war"');
    expect(result.stdout).toContain('"changed"');
    expect(result.stdout).toContain('"info.currentEra"');
  });
});

describe('via-workbench review and gate command routing', () => {
  const commentPayload = {
    version: 1,
    comment: {
      id: 'review-1',
      author: 'human',
      actorId: 'actor-1',
      target: { type: 'scene', id: 'E1' },
      severity: 'suggestion',
      category: 'style',
      content: 'The prose is rushed.',
      status: 'open',
      applications: [],
      supersedesId: null,
      resolvedBy: null,
      createdAt: '2026-08-06T00:00:00.000Z',
      resolvedAt: null,
    },
  } as const;

  it('lists review comments with the optional event filter', async () => {
    const result = await runViaWorkbench(['review', 'list', '--event-id', 'E1'], {
      nova_review_list: {
        version: 1,
        items: [commentPayload.comment],
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.requests.map((request) => request.name)).toEqual(['nova_review_list']);
    expect(result.requests[0].arguments).toEqual({ version: 1, eventId: 'E1' });
    expect(result.stdout).toContain('"id": "review-1"');
  });

  it('lists all review comments without a filter', async () => {
    const result = await runViaWorkbench(['review', 'list'], {
      nova_review_list: { version: 1, items: [] },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.requests[0].arguments).toEqual({ version: 1 });
  });

  it('adds a review comment for a scene event with defaults', async () => {
    const result = await runViaWorkbench(
      ['review', 'add', '--event-id', 'E1', '--text', 'The prose is rushed.'],
      {
        nova_review_add: commentPayload,
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.requests.map((request) => request.name)).toEqual(['nova_review_add']);
    expect(result.requests[0].arguments).toEqual({
      version: 1,
      target: { type: 'scene', id: 'E1' },
      severity: 'suggestion',
      category: 'reader_experience',
      content: 'The prose is rushed.',
    });
  });

  it('adds a review comment with explicit severity and category', async () => {
    const result = await runViaWorkbench(
      [
        'review',
        'add',
        '--event-id',
        'E1',
        '--text',
        'Blocking plot hole.',
        '--severity',
        'blocking',
        '--category',
        'plot_logic',
      ],
      {
        nova_review_add: commentPayload,
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.requests[0].arguments).toMatchObject({
      target: { type: 'scene', id: 'E1' },
      severity: 'blocking',
      category: 'plot_logic',
      content: 'Blocking plot hole.',
    });
  });

  it('updates a comment status action without extra fields', async () => {
    const result = await runViaWorkbench(
      ['review', 'update', '--comment-id', 'review-1', '--action', 'resolve'],
      {
        nova_review_update: {
          version: 1,
          comment: { ...commentPayload.comment, status: 'resolved' },
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.requests.map((request) => request.name)).toEqual(['nova_review_update']);
    expect(result.requests[0].arguments).toEqual({
      version: 1,
      commentId: 'review-1',
      action: 'resolve',
    });
  });

  it('replaces comment text by resolving the current target first', async () => {
    const result = await runViaWorkbench(
      [
        'review',
        'update',
        '--comment-id',
        'review-1',
        '--action',
        'replace',
        '--text',
        'New text.',
      ],
      {
        nova_review_get: commentPayload,
        nova_review_update: {
          version: 1,
          comment: {
            ...commentPayload.comment,
            id: 'review-2',
            content: 'New text.',
            supersedesId: 'review-1',
          },
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.requests.map((request) => request.name)).toEqual([
      'nova_review_get',
      'nova_review_update',
    ]);
    expect(result.requests[1].arguments).toEqual({
      version: 1,
      commentId: 'review-1',
      action: 'replace',
      target: { type: 'scene', id: 'E1' },
      severity: 'suggestion',
      category: 'style',
      content: 'New text.',
    });
  });

  it('rejects an unknown update action before any Host call', async () => {
    const result = await runViaWorkbench(
      ['review', 'update', '--comment-id', 'review-1', '--action', 'addressed'],
      {},
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--action must be one of');
    expect(result.requests).toHaveLength(0);
  });

  it('prints the review history as the projected comment stream', async () => {
    const result = await runViaWorkbench(['review', 'history', '--event-id', 'E1'], {
      nova_review_list: { version: 1, items: [commentPayload.comment] },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.requests.map((request) => request.name)).toEqual(['nova_review_list']);
    expect(result.requests[0].arguments).toEqual({ version: 1, eventId: 'E1' });
    expect(result.stdout).toContain('"review-1"');
  });

  it('revises scenes from review ids through nova_revise', async () => {
    const result = await runViaWorkbench(
      ['review', 'revise', 'E1', '--ids', 'review-1, review-2'],
      {
        nova_revise: { status: 'queued', receipt: queuedReceipt },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.requests.map((request) => request.name)).toEqual(['nova_revise']);
    expect(result.requests[0].arguments).toMatchObject({
      sceneSelector: { type: 'events', eventIds: ['E1'] },
      reviewIds: ['review-1', 'review-2'],
    });
  });

  it('lists release gates with the optional event filter', async () => {
    const result = await runViaWorkbench(['gate', 'list', '--event-id', 'E1'], {
      nova_release_gate_list: {
        version: 1,
        items: [
          {
            gateId: 'gate-1',
            sourceHash: 'source-hash',
            eventId: 'E1',
            proseHash: 'prose-hash',
            scopeHash: 'scope-hash',
            validationIdentity: 'validation-id',
            warningFingerprints: ['warning-1'],
            revisionId: 'rev-1',
            openedAt: '2026-08-06T00:00:00.000Z',
            openedBy: 'actor-1',
            status: 'open',
            decision: null,
            supersededAt: null,
            supersededBy: null,
            supersedeReason: null,
          },
        ],
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.requests.map((request) => request.name)).toEqual(['nova_release_gate_list']);
    expect(result.requests[0].arguments).toEqual({ version: 1, eventId: 'E1' });
    expect(result.stdout).toContain('"gateId": "gate-1"');
  });

  it('decides a release gate with accept and reason', async () => {
    const result = await runViaWorkbench(
      [
        'gate',
        'decide',
        '--event-id',
        'E1',
        '--candidate-revision',
        'rev-1',
        '--decision',
        'accept',
        '--reason',
        'Warnings are acceptable.',
      ],
      {
        nova_release_gate_decide: {
          version: 1,
          resolution: {
            version: 1,
            projectId: 'novel',
            gateId: 'gate-1',
            eventId: 'E1',
            candidateRevisionId: 'rev-1',
            outcome: 'accepted',
            acceptedRevisionId: 'rev-1',
            decision: {
              status: 'accepted',
              scopeHash: 'scope-hash',
              validationIdentity: 'validation-id',
              reasons: ['Warnings are acceptable.'],
              waiverId: null,
              gateId: 'gate-1',
            },
            reason: 'Warnings are acceptable.',
            actorId: 'actor-1',
            capabilityVersion: 1,
            decidedAt: '2026-08-06T00:00:00.000Z',
          },
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.requests.map((request) => request.name)).toEqual(['nova_release_gate_decide']);
    expect(result.requests[0].arguments).toEqual({
      version: 1,
      eventId: 'E1',
      candidateRevisionId: 'rev-1',
      decision: 'accept',
      reason: 'Warnings are acceptable.',
    });
    expect(result.stdout).toContain('"outcome": "accepted"');
  });

  it('rejects an invalid gate decision before any Host call', async () => {
    const result = await runViaWorkbench(
      [
        'gate',
        'decide',
        '--event-id',
        'E1',
        '--candidate-revision',
        'rev-1',
        '--decision',
        'waive',
        '--reason',
        'no',
      ],
      {},
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--decision must be accept or reject');
    expect(result.requests).toHaveLength(0);
  });
});

describe('via-workbench publication command routing', () => {
  const publicationRecord = {
    version: 1,
    publication: {
      publicationId: 'canonical',
      kind: 'canonical',
      value: {
        sourceHash: 'source-hash',
        scopeHash: 'scope-hash',
        revisionIds: ['rev-1'],
        novelHash: 'novel-hash',
        relativeOutputPath: 'output/novel.md',
        byteLength: 1234,
        actorId: 'actor-1',
        operationId: 'op-pub-1',
        createdAt: '2026-08-06T00:00:00.000Z',
        status: 'current',
      },
      updatedAt: '2026-08-06T00:00:00.000Z',
    },
  } as const;

  it('publishes the canonical novel when no branch identity is supplied', async () => {
    const result = await runViaWorkbench(['publish'], {
      nova_publish: { status: 'queued', operationHandle: 'op-pub-1' },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.requests.map((request) => request.name)).toEqual(['nova_publish']);
    expect(result.requests[0].arguments).toEqual({ version: 1 });
    expect(result.stdout).toContain('"status": "queued"');
    expect(result.stdout).toContain('Next step: run "nova operation wait op-pub-1"');
  });

  it('publishes a custom branch with the structured route identity', async () => {
    const result = await runViaWorkbench(
      [
        'publish',
        '--branch',
        '{"decisions": [{"atEventId": "E1", "choiceId": "c1", "narrativeOrder": 1}]}',
        '--discourse-branch',
        'alternate',
        '--title',
        'Alternate Ending',
      ],
      {
        nova_publish: { status: 'queued', operationHandle: 'op-pub-2' },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.requests.map((request) => request.name)).toEqual(['nova_publish']);
    expect(result.requests[0].arguments).toEqual({
      version: 1,
      branchPath: {
        version: 1,
        branchPath: {
          decisions: [{ atEventId: 'E1', choiceId: 'c1', narrativeOrder: 1 }],
        },
      },
      discourseBranch: 'alternate',
      title: 'Alternate Ending',
    });
  });

  it('rejects a malformed publish branch path before any Host call', async () => {
    const result = await runViaWorkbench(['publish', '--branch', 'not-json'], {});

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('not valid JSON');
    expect(result.requests).toHaveLength(0);
  });

  it('reads the canonical publication status by default', async () => {
    const result = await runViaWorkbench(['publication', 'status'], {
      nova_publication_get: publicationRecord,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.requests.map((request) => request.name)).toEqual(['nova_publication_get']);
    expect(result.requests[0].arguments).toEqual({ version: 1, publicationId: 'canonical' });
    expect(result.stdout).toContain('"relativeOutputPath": "output/novel.md"');
  });

  it('reads one publication status by explicit id', async () => {
    const result = await runViaWorkbench(['publication', 'status', '--publication-id', 'pub-1'], {
      nova_publication_get: publicationRecord,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.requests[0].arguments).toEqual({ version: 1, publicationId: 'pub-1' });
  });

  it('prints a bounded markdown slice with default bounds', async () => {
    const result = await runViaWorkbench(['publication', 'read', 'canonical'], {
      nova_publication_read: {
        version: 1,
        publicationId: 'canonical',
        offset: 0,
        limit: 262144,
        content: '# Chapter One\n\nIt was a dark night.\n',
        byteLength: 34,
        totalByteLength: 1234,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.requests.map((request) => request.name)).toEqual(['nova_publication_read']);
    expect(result.requests[0].arguments).toEqual({
      version: 1,
      publicationId: 'canonical',
      offset: 0,
      limit: 262144,
    });
    expect(result.stdout).toContain('# Chapter One');
  });

  it('passes explicit read bounds through to the tool', async () => {
    const result = await runViaWorkbench(
      ['publication', 'read', 'pub-1', '--offset', '10', '--limit', '100'],
      {
        nova_publication_read: {
          version: 1,
          publicationId: 'pub-1',
          offset: 10,
          limit: 100,
          content: 'ark night.\n',
          byteLength: 12,
          totalByteLength: 1234,
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.requests[0].arguments).toEqual({
      version: 1,
      publicationId: 'pub-1',
      offset: 10,
      limit: 100,
    });
    expect(result.stdout).toContain('ark night.');
  });

  it('rejects out-of-bounds read limits before any Host call', async () => {
    const result = await runViaWorkbench(['publication', 'read', 'pub-1', '--limit', '999999'], {});

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--limit must be an integer between 1 and 262144');
    expect(result.requests).toHaveLength(0);
  });

  it('rejects a negative read offset before any Host call', async () => {
    const result = await runViaWorkbench(['publication', 'read', 'pub-1', '--offset', '-1'], {});

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--offset must be a non-negative integer');
    expect(result.requests).toHaveLength(0);
  });
});
