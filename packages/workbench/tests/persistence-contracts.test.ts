import { describe, expect, it } from 'vitest';
import { PersistenceClient } from '../src/persistence/client.js';
import { persistenceSchema } from '../src/persistence/schema.js';

type Message = { correlationId: string; operation: string; payload: unknown };
type Response = { correlationId: string; ok: true; operation: string; result: unknown };
type Listener = (event: { data: Response }) => void;
function portPair() {
  let listener: Listener | undefined;
  return {
    client: {
      postMessage(message: Message) {
        queueMicrotask(() =>
          listener?.({
            data: {
              correlationId: message.correlationId,
              ok: true,
              operation: message.operation,
              result: message.payload,
            },
          }),
        );
      },
      addEventListener(_type: 'message', next: Listener) {
        listener = next;
      },
    },
  };
}
describe('persistence contracts', () => {
  it('correlates domain messages', async () => {
    const pair = portPair();
    const client = new PersistenceClient(pair.client);
    await expect(client.request('getProject', { projectId: 'p' })).resolves.toEqual({
      projectId: 'p',
    });
  });
  it('serializes deterministic failures and aborts before task boundary', async () => {
    const pair = portPair();
    const client = new PersistenceClient(pair.client);
    const controller = new AbortController();
    const request = client.request('getProject', { projectId: 'p' }, controller.signal);
    controller.abort();
    await expect(request).rejects.toMatchObject({ code: 'ABORTED', retryable: false });
  });
  it('describes migrations as values and exposes no generic query', () => {
    expect(persistenceSchema[0]?.tables.map((table) => table.name)).toContain('projects');
    expect((PersistenceClient.prototype as Record<string, unknown>).query).toBeUndefined();
  });
});
