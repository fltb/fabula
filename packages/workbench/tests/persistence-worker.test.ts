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
