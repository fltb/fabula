import type { MessagePort } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { start } from '../src/persistence/worker.js';
import { PersistenceWorkerClient } from '../src/persistence/worker-client.js';

type Listener = (event: { data: unknown }) => void;
function port() {
  let listener: Listener | undefined;
  return {
    addEventListener(_type: 'message', next: Listener) {
      listener = next;
    },
    removeEventListener() {
      listener = undefined;
    },
    postMessage(request: unknown) {
      if (
        request === null ||
        typeof request !== 'object' ||
        !('correlationId' in request) ||
        typeof request.correlationId !== 'string' ||
        !('operation' in request) ||
        typeof request.operation !== 'string' ||
        !('payload' in request)
      ) {
        return;
      }
      queueMicrotask(() =>
        listener?.({
          data: {
            correlationId: request.correlationId,
            ok: true,
            operation: request.operation,
            result: request.payload,
          },
        }),
      );
    },
  };
}

describe('persistence worker client contract', () => {
  it('correlates concurrent responses in order-independent fashion', async () => {
    const p = port();
    const client = new PersistenceWorkerClient(p);
    const first = client.request('loadSession', { sessionId: 'a' });
    const second = client.request('loadSession', { sessionId: 'b' });
    await expect(first).resolves.toEqual({ sessionId: 'a' });
    await expect(second).resolves.toEqual({ sessionId: 'b' });
  });
  it('serializes abort at a task boundary', async () => {
    const p = port();
    const client = new PersistenceWorkerClient(p);
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.request('loadSession', { sessionId: 'x' }, controller.signal),
    ).rejects.toMatchObject({ code: 'ABORTED' });
  });
  it('does not expose SQL or DatabaseSync through the client source', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../src/persistence/worker-client.ts', import.meta.url), 'utf8'),
    );
    expect(source).not.toMatch(/DatabaseSync|node:sqlite|\bsql\b/i);
  });
});

describe('persistence worker project operations', () => {
  function worker() {
    const listeners = new Set<(message: unknown) => void>();
    const pending = new Map<string, (message: unknown) => void>();
    const workerPort = {
      addListener(_type: 'message', listener: (message: unknown) => void) {
        listeners.add(listener);
      },
      removeListener(_type: 'message', listener: (message: unknown) => void) {
        listeners.delete(listener);
      },
      postMessage(message: unknown) {
        if (
          message != null &&
          typeof message === 'object' &&
          'correlationId' in message &&
          typeof message.correlationId === 'string'
        ) {
          pending.get(message.correlationId)?.(message);
        }
      },
      close() {},
    };
    const disposer = start(workerPort as unknown as MessagePort, { databasePath: ':memory:' });
    let sequence = 0;
    const request = (operation: string, payload: unknown): Promise<unknown> => {
      const correlationId = `op-${++sequence}`;
      const { promise, resolve } = Promise.withResolvers<unknown>();
      pending.set(correlationId, resolve);
      for (const listener of [...listeners]) listener({ correlationId, operation, payload });
      return promise.finally(() => pending.delete(correlationId));
    };
    return { disposer, request };
  }

  it('enforces status transitions and idempotency on the wire', async () => {
    const { disposer, request } = worker();
    try {
      const base = {
        version: 1,
        projectId: 'p',
        operationId: 'op-1',
        idempotencyKey: 'k-1',
        kind: 'render',
        status: 'queued',
        actorId: 'actor-1',
        capabilityVersion: 1,
        sourceHash: null,
        acceptedRevisionId: null,
        progress: null,
        resultRef: null,
        errorCode: null,
        createdAt: '2026-08-06T00:00:00.000Z',
        updatedAt: '2026-08-06T00:00:00.000Z',
      };
      const created = await request('upsertProjectOperation', { record: base });
      expect(created).toMatchObject({ ok: true, result: { created: true, applied: true } });

      // Illegal transition: queued -> succeeded.
      await expect(
        request('upsertProjectOperation', {
          record: { ...base, status: 'succeeded', updatedAt: '2026-08-06T00:00:01.000Z' },
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'ILLEGAL_OPERATION_TRANSITION', retryable: false },
      });

      // A second operation claiming the same idempotency key is refused and
      // the original row is still found by key lookup.
      await expect(
        request('upsertProjectOperation', {
          record: { ...base, operationId: 'op-2', updatedAt: '2026-08-06T00:00:01.000Z' },
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'IDEMPOTENCY_CONFLICT' } });
      await expect(
        request('getProjectOperationByIdempotencyKey', {
          projectId: 'p',
          kind: 'render',
          idempotencyKey: 'k-1',
        }),
      ).resolves.toMatchObject({ ok: true, result: { operationId: 'op-1', status: 'queued' } });

      // Restart sweep through the wire marks queued/running work interrupted.
      await expect(
        request('markProjectOperationsInterrupted', {
          projectId: 'p',
          at: '2026-08-06T00:00:02.000Z',
        }),
      ).resolves.toMatchObject({ ok: true, result: { updated: 1 } });
      await expect(
        request('getProjectOperation', { projectId: 'p', operationId: 'op-1' }),
      ).resolves.toMatchObject({ ok: true, result: { status: 'interrupted' } });
    } finally {
      await disposer.dispose();
    }
  });
});

describe('persistence worker project publications', () => {
  function worker() {
    const listeners = new Set<(message: unknown) => void>();
    const pending = new Map<string, (message: unknown) => void>();
    const workerPort = {
      addListener(_type: 'message', listener: (message: unknown) => void) {
        listeners.add(listener);
      },
      removeListener(_type: 'message', listener: (message: unknown) => void) {
        listeners.delete(listener);
      },
      postMessage(message: unknown) {
        if (
          message != null &&
          typeof message === 'object' &&
          'correlationId' in message &&
          typeof message.correlationId === 'string'
        ) {
          pending.get(message.correlationId)?.(message);
        }
      },
      close() {},
    };
    const disposer = start(workerPort as unknown as MessagePort, { databasePath: ':memory:' });
    let sequence = 0;
    const request = (operation: string, payload: unknown): Promise<unknown> => {
      const correlationId = `pub-${++sequence}`;
      const { promise, resolve } = Promise.withResolvers<unknown>();
      pending.set(correlationId, resolve);
      for (const listener of [...listeners]) listener({ correlationId, operation, payload });
      return promise.finally(() => pending.delete(correlationId));
    };
    return { disposer, request };
  }

  const customId = 'a'.repeat(64);
  const base = (publicationId: string, kind: 'canonical' | 'custom') => ({
    version: 1,
    projectId: 'p',
    publicationId,
    kind,
    value: {
      sourceHash: 's'.repeat(64),
      scopeHash: 'c'.repeat(64),
      revisionIds: ['rev-1'],
      novelHash: 'n'.repeat(64),
      relativeOutputPath: kind === 'canonical' ? 'output/novel.md' : `output/${publicationId}.md`,
      byteLength: 42,
      actorId: 'actor-1',
      operationId: 'op-1',
      createdAt: '2026-08-06T00:00:00.000Z',
      status: 'current',
    },
    updatedAt: '2026-08-06T00:00:00.000Z',
  });

  it('creates canonical and custom rows and enforces the id/kind pairing', async () => {
    const { disposer, request } = worker();
    try {
      const canonical = await request('upsertProjectPublication', {
        record: base('canonical', 'canonical'),
      });
      expect(canonical).toMatchObject({
        ok: true,
        result: { created: true, applied: true, record: { publicationId: 'canonical' } },
      });

      const custom = await request('upsertProjectPublication', {
        record: base(customId, 'custom'),
      });
      expect(custom).toMatchObject({
        ok: true,
        result: {
          created: true,
          applied: true,
          record: {
            publicationId: customId,
            kind: 'custom',
            value: { relativeOutputPath: `output/${customId}.md` },
          },
        },
      });

      await expect(
        request('upsertProjectPublication', { record: base('other', 'canonical') }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'INVALID_INPUT', retryable: false },
      });
      await expect(
        request('upsertProjectPublication', { record: base('canonical', 'custom') }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'INVALID_INPUT', retryable: false },
      });
      await expect(
        request('upsertProjectPublication', { record: base('not-hex!', 'custom') }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'INVALID_INPUT', retryable: false },
      });
    } finally {
      await disposer.dispose();
    }
  });

  it('enforces the expectedStatus CAS, status transitions and immutable identity', async () => {
    const { disposer, request } = worker();
    try {
      await request('upsertProjectPublication', {
        record: base('canonical', 'canonical'),
      });

      // CAS mismatch: the row is current, not stale -> no-op with stored row.
      const mismatch = await request('upsertProjectPublication', {
        record: base('canonical', 'canonical'),
        expectedStatus: 'stale',
      });
      expect(mismatch).toMatchObject({
        ok: true,
        result: { created: false, applied: false, record: { publicationId: 'canonical' } },
      });

      // Demote with the correct CAS: value is replaced wholesale.
      const demoted = await request('upsertProjectPublication', {
        record: {
          ...base('canonical', 'canonical'),
          value: { ...base('canonical', 'canonical').value, status: 'stale' },
          updatedAt: '2026-08-06T00:00:01.000Z',
        },
        expectedStatus: 'current',
      });
      expect(demoted).toMatchObject({
        ok: true,
        result: { created: false, applied: true, record: { value: { status: 'stale' } } },
      });

      // Re-activation (idempotent re-publication) flips stale -> current.
      const reactivated = await request('upsertProjectPublication', {
        record: {
          ...base('canonical', 'canonical'),
          value: {
            ...base('canonical', 'canonical').value,
            novelHash: 'm'.repeat(64),
            byteLength: 99,
            createdAt: '2026-08-06T00:00:02.000Z',
          },
          updatedAt: '2026-08-06T00:00:02.000Z',
        },
        expectedStatus: 'stale',
      });
      expect(reactivated).toMatchObject({
        ok: true,
        result: {
          created: false,
          applied: true,
          record: { value: { status: 'current', novelHash: 'm'.repeat(64), byteLength: 99 } },
        },
      });

      // Identity fields are immutable on the update path: changing the kind
      // under the same publication id is refused by validation.
      await expect(
        request('upsertProjectPublication', {
          record: base('canonical', 'custom'),
          expectedStatus: 'current',
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'INVALID_INPUT', retryable: false },
      });

      // A never-written publication id reads back as null.
      await expect(
        request('getProjectPublication', { projectId: 'p', publicationId: 'missing' }),
      ).resolves.toMatchObject({ ok: true, result: null });
    } finally {
      await disposer.dispose();
    }
  });

  it('lists publications newest-updated first with a keyset cursor', async () => {
    const { disposer, request } = worker();
    try {
      for (let index = 0; index < 3; index += 1) {
        const id = (index + 1).toString(16).padStart(64, '0');
        await request('upsertProjectPublication', {
          record: {
            ...base(id, 'custom'),
            value: {
              ...base(id, 'custom').value,
              createdAt: `2026-08-06T00:00:0${index}.000Z`,
            },
            updatedAt: `2026-08-06T00:00:0${index}.000Z`,
          },
        });
      }
      const pageOne = await request('listProjectPublications', {
        projectId: 'p',
        limit: 2,
      });
      expect(pageOne).toMatchObject({
        ok: true,
        result: [
          { publicationId: '0'.repeat(62) + '03' },
          { publicationId: '0'.repeat(62) + '02' },
        ],
      });
      const pageOneResult = (pageOne as { result: { updatedAt: string; publicationId: string }[] })
        .result;
      const cursor = `${pageOneResult[1].updatedAt}|${pageOneResult[1].publicationId}`;
      const pageTwo = await request('listProjectPublications', {
        projectId: 'p',
        limit: 2,
        before: cursor,
      });
      expect(pageTwo).toMatchObject({
        ok: true,
        result: [{ publicationId: '0'.repeat(62) + '01' }],
      });
      await expect(
        request('listProjectPublications', {
          projectId: 'p',
          before: 'not-a-cursor',
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    } finally {
      await disposer.dispose();
    }
  });

  it('rejects unknown payload fields and bad record shapes on the wire', async () => {
    const { disposer, request } = worker();
    try {
      await expect(
        request('upsertProjectPublication', {
          record: base('canonical', 'canonical'),
          bogus: true,
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'UNKNOWN_FIELD' } });
      await expect(
        request('upsertProjectPublication', {
          record: { ...base('canonical', 'canonical'), version: 2 },
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      await expect(
        request('upsertProjectPublication', {
          record: {
            ...base('canonical', 'canonical'),
            value: { ...base('canonical', 'canonical').value, byteLength: -1 },
          },
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      await expect(
        request('upsertProjectPublication', {
          record: {
            ...base('canonical', 'canonical'),
            value: {
              ...base('canonical', 'canonical').value,
              relativeOutputPath: '../escape.md',
            },
          },
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    } finally {
      await disposer.dispose();
    }
  });
});

describe('persistence worker agent records', () => {
  function worker() {
    const listeners = new Set<(message: unknown) => void>();
    const pending = new Map<string, (message: unknown) => void>();
    const workerPort = {
      addListener(_type: 'message', listener: (message: unknown) => void) {
        listeners.add(listener);
      },
      removeListener(_type: 'message', listener: (message: unknown) => void) {
        listeners.delete(listener);
      },
      postMessage(message: unknown) {
        if (
          message != null &&
          typeof message === 'object' &&
          'correlationId' in message &&
          typeof message.correlationId === 'string'
        ) {
          pending.get(message.correlationId)?.(message);
        }
      },
      close() {},
    };
    const disposer = start(workerPort as unknown as MessagePort, { databasePath: ':memory:' });
    let sequence = 0;
    const request = (operation: string, payload: unknown): Promise<unknown> => {
      const correlationId = `agent-${++sequence}`;
      const { promise, resolve } = Promise.withResolvers<unknown>();
      pending.set(correlationId, resolve);
      for (const listener of [...listeners]) listener({ correlationId, operation, payload });
      return promise.finally(() => pending.delete(correlationId));
    };
    return { disposer, request };
  }

  const hash = 'a'.repeat(64);
  const conversation = (overrides: Record<string, unknown> = {}) => ({
    version: 1,
    conversationId: 'conv-1',
    projectId: 'p',
    principalUserId: 'user-1',
    role: 'maintainer',
    title: null,
    createdAt: '2026-08-06T00:00:00.000Z',
    updatedAt: '2026-08-06T00:00:00.000Z',
    ...overrides,
  });
  const run = (overrides: Record<string, unknown> = {}) => ({
    version: 1,
    runId: 'run-1',
    conversationId: 'conv-1',
    projectId: 'p',
    operationId: null,
    principalUserId: 'user-1',
    role: 'maintainer',
    status: 'queued',
    turn: 0,
    maxTurns: 16,
    toolCalls: 0,
    maxToolCalls: 64,
    createdAt: '2026-08-06T00:00:00.000Z',
    updatedAt: '2026-08-06T00:00:00.000Z',
    ...overrides,
  });
  const toolCall = (overrides: Record<string, unknown> = {}) => ({
    version: 1,
    runId: 'run-1',
    callIndex: 0,
    toolName: 'nova_status',
    sanitizedArgsHash: hash,
    resultRef: null,
    turn: 1,
    status: 'pending',
    createdAt: '2026-08-06T00:00:00.100Z',
    ...overrides,
  });

  it('creates, appends, lists and pages agent conversations on the wire', async () => {
    const { disposer, request } = worker();
    try {
      const created = await request('createAgentConversation', conversation());
      expect(created).toMatchObject({
        ok: true,
        result: { conversationId: 'conv-1', role: 'maintainer', title: null },
      });
      await expect(request('createAgentConversation', conversation())).resolves.toMatchObject({
        ok: false,
        error: { code: 'CONVERSATION_EXISTS' },
      });
      await expect(
        request('getAgentConversation', { conversationId: 'missing' }),
      ).resolves.toMatchObject({ ok: true, result: null });

      // Append bumps updatedAt and can set a title.
      const appended = await request('appendAgentConversation', {
        conversationId: 'conv-1',
        at: '2026-08-06T00:00:01.000Z',
        title: 'Chapter review',
      });
      expect(appended).toMatchObject({
        ok: true,
        result: { title: 'Chapter review', updatedAt: '2026-08-06T00:00:01.000Z' },
      });
      await expect(
        request('appendAgentConversation', {
          conversationId: 'missing',
          at: '2026-08-06T00:00:01.000Z',
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'CONVERSATION_NOT_FOUND' } });

      // Listing filters by project/principal and pages newest-updated first.
      await request(
        'createAgentConversation',
        conversation({
          conversationId: 'conv-2',
          principalUserId: 'user-2',
          createdAt: '2026-08-06T00:00:02.000Z',
          updatedAt: '2026-08-06T00:00:02.000Z',
        }),
      );
      await request(
        'createAgentConversation',
        conversation({
          conversationId: 'conv-3',
          createdAt: '2026-08-06T00:00:03.000Z',
          updatedAt: '2026-08-06T00:00:03.000Z',
        }),
      );
      const pageOne = await request('listAgentConversations', { projectId: 'p', limit: 2 });
      expect(pageOne).toMatchObject({
        ok: true,
        result: [{ conversationId: 'conv-3' }, { conversationId: 'conv-2' }],
      });
      // Wire response is `unknown`; listAgentConversations echoes the typed record array.
      const pageOneList = pageOne as {
        result: Array<{ updatedAt: string; conversationId: string }>;
      };
      const cursor = `${pageOneList.result[1].updatedAt}|${pageOneList.result[1].conversationId}`;
      const pageTwo = await request('listAgentConversations', {
        projectId: 'p',
        limit: 2,
        before: cursor,
      });
      expect(pageTwo).toMatchObject({ ok: true, result: [{ conversationId: 'conv-1' }] });
      const mine = await request('listAgentConversations', { principalUserId: 'user-2' });
      expect(mine).toMatchObject({ ok: true, result: [{ conversationId: 'conv-2' }] });
      await expect(
        request('listAgentConversations', { projectId: 'p', before: 'not-a-cursor' }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    } finally {
      await disposer.dispose();
    }
  });

  it('enforces run creation invariants and the status automaton on the wire', async () => {
    const { disposer, request } = worker();
    try {
      await request('createAgentConversation', conversation());
      const created = await request('createAgentRun', run());
      expect(created).toMatchObject({ ok: true, result: { runId: 'run-1', status: 'queued' } });

      // Creation invariants: queued only, zero counters, existing conversation
      // with a matching project, unique run id.
      await expect(request('createAgentRun', run({ status: 'running' }))).resolves.toMatchObject({
        ok: false,
        error: { code: 'INVALID_INPUT' },
      });
      await expect(request('createAgentRun', run({ turn: 1 }))).resolves.toMatchObject({
        ok: false,
        error: { code: 'INVALID_INPUT' },
      });
      await expect(
        request('createAgentRun', run({ conversationId: 'missing' })),
      ).resolves.toMatchObject({ ok: false, error: { code: 'CONVERSATION_NOT_FOUND' } });
      await expect(request('createAgentRun', run({ projectId: 'other' }))).resolves.toMatchObject({
        ok: false,
        error: { code: 'INVALID_INPUT' },
      });
      await expect(request('createAgentRun', run())).resolves.toMatchObject({
        ok: false,
        error: { code: 'RUN_EXISTS' },
      });

      // Legal lifecycle with monotonic counters.
      const started = await request('transitionAgentRun', {
        runId: 'run-1',
        status: 'running',
        expectedStatus: 'queued',
        turn: 1,
        at: '2026-08-06T00:00:01.000Z',
      });
      expect(started).toMatchObject({
        ok: true,
        result: { applied: true, record: { status: 'running', turn: 1 } },
      });
      const finished = await request('transitionAgentRun', {
        runId: 'run-1',
        status: 'succeeded',
        expectedStatus: 'running',
        turn: 2,
        toolCalls: 1,
        at: '2026-08-06T00:00:02.000Z',
      });
      expect(finished).toMatchObject({
        ok: true,
        result: { applied: true, record: { status: 'succeeded', turn: 2, toolCalls: 1 } },
      });

      // Terminal runs reject further mutations.
      await expect(
        request('transitionAgentRun', {
          runId: 'run-1',
          status: 'running',
          expectedStatus: 'succeeded',
          at: '2026-08-06T00:00:03.000Z',
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'ILLEGAL_RUN_TRANSITION' } });
      await expect(
        request('checkpointAgentRun', { runId: 'run-1', turn: 3, at: '2026-08-06T00:00:03.000Z' }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'ILLEGAL_RUN_TRANSITION' } });

      // Illegal transition queued -> succeeded is refused with a typed error.
      await request(
        'createAgentRun',
        run({ runId: 'run-2', updatedAt: '2026-08-06T00:00:00.000Z' }),
      );
      await expect(
        request('transitionAgentRun', {
          runId: 'run-2',
          status: 'succeeded',
          expectedStatus: 'queued',
          at: '2026-08-06T00:00:01.000Z',
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'ILLEGAL_RUN_TRANSITION' } });

      // CAS mismatch is a no-op returning the stored record.
      await request(
        'createAgentRun',
        run({ runId: 'run-3', updatedAt: '2026-08-06T00:00:00.000Z' }),
      );
      const mismatch = await request('transitionAgentRun', {
        runId: 'run-3',
        status: 'running',
        expectedStatus: 'succeeded',
        at: '2026-08-06T00:00:01.000Z',
      });
      expect(mismatch).toMatchObject({
        ok: true,
        result: { applied: false, record: { status: 'queued' } },
      });

      // Counters are monotonic and bounded by the stored limits.
      await request(
        'createAgentRun',
        run({ runId: 'run-4', updatedAt: '2026-08-06T00:00:00.000Z' }),
      );
      await request('transitionAgentRun', {
        runId: 'run-4',
        status: 'running',
        expectedStatus: 'queued',
        turn: 1,
        at: '2026-08-06T00:00:01.000Z',
      });
      await expect(
        request('transitionAgentRun', {
          runId: 'run-4',
          status: 'succeeded',
          expectedStatus: 'running',
          turn: 0,
          at: '2026-08-06T00:00:02.000Z',
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      await expect(
        request('checkpointAgentRun', {
          runId: 'run-4',
          turn: 100,
          at: '2026-08-06T00:00:02.000Z',
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });

      // The restart sweep marks queued/running work interrupted and retry is
      // explicit: interrupted -> queued with the matching CAS.
      await request(
        'createAgentRun',
        run({ runId: 'run-5', updatedAt: '2026-08-06T00:00:00.000Z' }),
      );
      // run-1 is terminal; run-2/run-3/run-5 are queued and run-4 is running.
      const swept = await request('markAgentRunsInterrupted', {
        projectId: 'p',
        at: '2026-08-06T00:00:03.000Z',
      });
      expect(swept).toMatchObject({ ok: true, result: { updated: 4 } });
      await expect(request('getAgentRun', { runId: 'run-2' })).resolves.toMatchObject({
        ok: true,
        result: { status: 'interrupted', updatedAt: '2026-08-06T00:00:03.000Z' },
      });
      await expect(request('getAgentRun', { runId: 'run-4' })).resolves.toMatchObject({
        ok: true,
        result: { status: 'interrupted' },
      });
      const retried = await request('transitionAgentRun', {
        runId: 'run-2',
        status: 'queued',
        expectedStatus: 'interrupted',
        at: '2026-08-06T00:00:04.000Z',
      });
      expect(retried).toMatchObject({
        ok: true,
        result: { applied: true, record: { status: 'queued' } },
      });
    } finally {
      await disposer.dispose();
    }
  });

  it('keeps tool calls append-only per run and completes pending calls on the wire', async () => {
    const { disposer, request } = worker();
    try {
      await request('createAgentConversation', conversation());
      await request('createAgentRun', run());

      // Appends require the run to be running.
      await expect(request('appendAgentToolCall', toolCall())).resolves.toMatchObject({
        ok: false,
        error: { code: 'ILLEGAL_RUN_TRANSITION' },
      });
      await request('transitionAgentRun', {
        runId: 'run-1',
        status: 'running',
        expectedStatus: 'queued',
        at: '2026-08-06T00:00:01.000Z',
      });

      const first = await request('appendAgentToolCall', toolCall());
      expect(first).toMatchObject({ ok: true, result: { callIndex: 0, status: 'pending' } });
      await expect(request('getAgentRun', { runId: 'run-1' })).resolves.toMatchObject({
        ok: true,
        result: { toolCalls: 1 },
      });
      await expect(
        request('appendAgentToolCall', toolCall({ callIndex: 1, toolName: 'nova_graph' })),
      ).resolves.toMatchObject({ ok: true, result: { callIndex: 1 } });

      // Strictly sequential: duplicates and gaps are refused.
      await expect(request('appendAgentToolCall', toolCall())).resolves.toMatchObject({
        ok: false,
        error: { code: 'TOOL_CALL_APPEND_VIOLATION' },
      });
      await expect(
        request('appendAgentToolCall', toolCall({ callIndex: 3 })),
      ).resolves.toMatchObject({ ok: false, error: { code: 'TOOL_CALL_APPEND_VIOLATION' } });

      // Non-pending appends are refused: completion is a separate update.
      await expect(
        request(
          'appendAgentToolCall',
          toolCall({ callIndex: 2, status: 'succeeded', resultRef: 'result://x' }),
        ),
      ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      await expect(
        request('appendAgentToolCall', toolCall({ callIndex: 2, turn: 99 })),
      ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      await request('appendAgentToolCall', toolCall({ callIndex: 2, toolName: 'nova_validate' }));

      // Completion requires a result ref on success.
      await expect(
        request('updateAgentToolCallStatus', {
          runId: 'run-1',
          callIndex: 0,
          status: 'succeeded',
          resultRef: null,
          at: '2026-08-06T00:00:02.000Z',
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      const completed = await request('updateAgentToolCallStatus', {
        runId: 'run-1',
        callIndex: 0,
        status: 'succeeded',
        resultRef: 'result://status',
        at: '2026-08-06T00:00:02.000Z',
      });
      expect(completed).toMatchObject({
        ok: true,
        result: { status: 'succeeded', resultRef: 'result://status' },
      });
      // A pending call may fail without a result ref (the run record carries the error).
      await expect(
        request('updateAgentToolCallStatus', {
          runId: 'run-1',
          callIndex: 1,
          status: 'failed',
          resultRef: null,
          at: '2026-08-06T00:00:02.000Z',
        }),
      ).resolves.toMatchObject({ ok: true, result: { status: 'failed' } });
      // Only pending calls may complete.
      await expect(
        request('updateAgentToolCallStatus', {
          runId: 'run-1',
          callIndex: 0,
          status: 'failed',
          resultRef: null,
          at: '2026-08-06T00:00:03.000Z',
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'ILLEGAL_TOOL_CALL_TRANSITION' } });
      await expect(
        request('updateAgentToolCallStatus', {
          runId: 'run-1',
          callIndex: 9,
          status: 'succeeded',
          resultRef: 'result://x',
          at: '2026-08-06T00:00:03.000Z',
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'TOOL_CALL_NOT_FOUND' } });

      // Listing is append-ordered with an `after` keyset.
      const all = await request('listAgentToolCalls', { runId: 'run-1' });
      expect(all).toMatchObject({
        ok: true,
        result: [
          { callIndex: 0, toolName: 'nova_status' },
          { callIndex: 1, toolName: 'nova_graph' },
          { callIndex: 2, toolName: 'nova_validate' },
        ],
      });
      const page = await request('listAgentToolCalls', { runId: 'run-1', after: 1, limit: 1 });
      expect(page).toMatchObject({ ok: true, result: [{ callIndex: 2 }] });

      // Bounds: maxToolCalls caps the appended ordinal.
      await request(
        'createAgentRun',
        run({ runId: 'run-max', maxToolCalls: 1, updatedAt: '2026-08-06T00:00:00.000Z' }),
      );
      await request('transitionAgentRun', {
        runId: 'run-max',
        status: 'running',
        expectedStatus: 'queued',
        at: '2026-08-06T00:00:01.000Z',
      });
      await expect(
        request('appendAgentToolCall', toolCall({ runId: 'run-max' })),
      ).resolves.toMatchObject({ ok: true, result: { callIndex: 0 } });
      await expect(
        request('appendAgentToolCall', toolCall({ runId: 'run-max', callIndex: 1 })),
      ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    } finally {
      await disposer.dispose();
    }
  });

  it('rejects unknown payload fields and malformed agent records on the wire', async () => {
    const { disposer, request } = worker();
    try {
      await expect(
        request('createAgentConversation', { ...conversation(), bogus: true }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'UNKNOWN_FIELD' } });
      await expect(
        request('createAgentConversation', conversation({ version: 2 })),
      ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      await expect(
        request('createAgentConversation', conversation({ role: 'owner' })),
      ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      await expect(request('createAgentRun', run({ maxTurns: 0 }))).resolves.toMatchObject({
        ok: false,
        error: { code: 'INVALID_INPUT' },
      });
      await expect(request('createAgentRun', run({ status: 'stale' }))).resolves.toMatchObject({
        ok: false,
        error: { code: 'INVALID_INPUT' },
      });
      await expect(
        request('appendAgentToolCall', toolCall({ sanitizedArgsHash: 'not-hex!' })),
      ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      await expect(
        request('appendAgentToolCall', toolCall({ callIndex: -1 })),
      ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    } finally {
      await disposer.dispose();
    }
  });
});

it('rejects verifier operations that omit their explicit store', async () => {
  const listeners = new Set<(message: unknown) => void>();
  const pending = new Map<string, (message: unknown) => void>();
  const workerPort = {
    addListener(_type: 'message', listener: (message: unknown) => void) {
      listeners.add(listener);
    },
    removeListener(_type: 'message', listener: (message: unknown) => void) {
      listeners.delete(listener);
    },
    postMessage(message: unknown) {
      if (
        message != null &&
        typeof message === 'object' &&
        'correlationId' in message &&
        typeof message.correlationId === 'string'
      ) {
        pending.get(message.correlationId)?.(message);
      }
    },
    close() {},
  };
  const disposer = start(workerPort as unknown as MessagePort, { databasePath: ':memory:' });
  try {
    let sequence = 0;
    const request = (operation: string, payload: unknown): Promise<unknown> => {
      const correlationId = `missing-store-${++sequence}`;
      const { promise, resolve } = Promise.withResolvers<unknown>();
      pending.set(correlationId, resolve);
      for (const listener of [...listeners]) listener({ correlationId, operation, payload });
      return promise.finally(() => pending.delete(correlationId));
    };
    const payload = {
      deviceId: 'device-1',
      tokenHash: 'a'.repeat(64),
      scope: ['mcp:read'],
      expiresAt: '2026-01-02T00:00:00.000Z',
      clientLabel: 'test',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    for (const [operation, operationPayload] of [
      ['createDeviceVerifier', payload],
      ['loadDeviceVerifierByTokenHash', { tokenHash: payload.tokenHash }],
      ['listDeviceVerifiers', undefined],
      ['revokeDeviceVerifier', { deviceId: payload.deviceId, revokedAt: payload.createdAt }],
    ] as const) {
      await expect(request(operation, operationPayload)).resolves.toMatchObject({
        ok: false,
        error: { code: 'INVALID_INPUT' },
      });
    }
  } finally {
    await disposer.dispose();
  }
});

describe('persistence worker serial execution', () => {
  it('keeps the serial queue alive when a response cannot be delivered', async () => {
    // The worker's side of the port: requests are injected directly. The
    // first response post fails (port closed mid-drain), later posts succeed.
    const listeners = new Set<(message: unknown) => void>();
    const delivered: unknown[] = [];
    let failuresRemaining = 1;
    let resolveSecond: (() => void) | undefined;
    const secondDelivered = new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });
    const port = {
      addListener(_type: 'message', listener: (message: unknown) => void) {
        listeners.add(listener);
      },
      removeListener(_type: 'message', listener: (message: unknown) => void) {
        listeners.delete(listener);
      },
      postMessage(message: unknown) {
        if (failuresRemaining > 0) {
          failuresRemaining -= 1;
          throw new Error('port closed');
        }
        delivered.push(message);
        if (
          message != null &&
          typeof message === 'object' &&
          'correlationId' in message &&
          message.correlationId === 'b'
        )
          resolveSecond?.();
      },
      close() {},
    };
    const disposer = start(port as unknown as MessagePort, { databasePath: ':memory:' });
    try {
      const inject = (message: unknown): void => {
        for (const listener of [...listeners]) listener(message);
      };
      inject({
        correlationId: 'a',
        operation: 'persistYjsUpdate',
        payload: { projectId: 'proj', documentId: 'doc', update: new Uint8Array([7, 8]) },
      });
      inject({
        correlationId: 'b',
        operation: 'loadWorkingDocument',
        payload: { projectId: 'proj', documentId: 'doc' },
      });
      // Await the second queued request's actual delivery instead of counting
      // microtask flushes: the serial queue runs 'a' first (its response post
      // fails), then 'b' — this promise resolves only once 'b' has executed and
      // its response reached the port. A wedged queue would hang here, which is
      // the failure this test exists to catch.
      await secondDelivered;

      // Request 'a' executed but its response could not be delivered. Request
      // 'b' must still run after it and deliver: it reads back the exact update
      // 'a' stored, proving the failed delivery did not wedge the serial queue
      // or misreport 'a' as a failed operation.
      expect(delivered).toHaveLength(1);
      const response = delivered[0] as {
        correlationId: string;
        ok: boolean;
        operation: string;
        result?: { update?: Uint8Array };
      };
      expect(response.correlationId).toBe('b');
      expect(response.ok).toBe(true);
      expect(response.operation).toBe('loadWorkingDocument');
      expect(
        Buffer.from(response.result?.update ?? new Uint8Array()).equals(
          Buffer.from(new Uint8Array([7, 8])),
        ),
      ).toBe(true);
    } finally {
      await disposer.dispose();
    }
  });
});
