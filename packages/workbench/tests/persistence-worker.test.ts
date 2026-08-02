import { describe, expect, it } from 'vitest';
import { PersistenceWorkerClient } from '../src/persistence/worker-client.js';

type Listener = (event: { data: any }) => void;
function port() {
  let listener: Listener | undefined;
  return {
    addEventListener(_type: 'message', next: Listener) { listener = next; },
    removeEventListener() { listener = undefined; },
    postMessage(request: any) { queueMicrotask(() => listener?.({ data: { correlationId: request.correlationId, ok: true, operation: request.operation, result: request.payload } })); },
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
    const p = port(); const client = new PersistenceWorkerClient(p); const controller = new AbortController();
    controller.abort();
    await expect(client.request('loadSession', { sessionId: 'x' }, controller.signal)).rejects.toMatchObject({ code: 'ABORTED' });
  });
  it('does not expose SQL or DatabaseSync through the client source', async () => {
    const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../src/persistence/worker-client.ts', import.meta.url), 'utf8'));
    expect(source).not.toMatch(/DatabaseSync|node:sqlite|\bsql\b/i);
  });
});
