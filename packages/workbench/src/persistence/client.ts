import type { PersistenceOperation, PersistencePayloads, PersistenceResults } from '../contracts/persistence.js';
import { serializePersistenceError, type PersistenceMessagePort, type PersistenceRequest, type PersistenceResponse } from './messages.js';

export class PersistenceClient {
  readonly #port: PersistenceMessagePort;
  #sequence = 0;
  readonly #pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
  constructor(port: PersistenceMessagePort) { this.#port = port; port.addEventListener('message', this.#onMessage); }
  #onMessage = (event: { data: PersistenceResponse }) => {
    const response = event.data;
    const pending = this.#pending.get(response.correlationId);
    if (!pending) return;
    this.#pending.delete(response.correlationId);
    if (response.ok) pending.resolve(response.result); else pending.reject(response.error);
  };
  request<O extends PersistenceOperation>(operation: O, payload: PersistencePayloads[O], signal?: AbortSignal): Promise<PersistenceResults[O]> {
    const correlationId = `p${++this.#sequence}`;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const abort = () => { if (this.#pending.delete(correlationId)) reject({ code: 'ABORTED', message: 'Persistence task aborted before its next task boundary', retryable: false }); };
    if (signal?.aborted) { reject({ code: 'ABORTED', message: 'Persistence task aborted before its next task boundary', retryable: false }); return promise as Promise<PersistenceResults[O]>; }
    this.#pending.set(correlationId, { resolve, reject });
    signal?.addEventListener('abort', abort, { once: true });
    const request: PersistenceRequest<O> = { correlationId, operation, payload };
    this.#port.postMessage(request);
    return promise as Promise<PersistenceResults[O]>;
  }
  dispose(): void { this.#port.removeEventListener?.('message', this.#onMessage); for (const pending of this.#pending.values()) pending.reject(serializePersistenceError({ code: 'CLIENT_DISPOSED', message: 'Persistence client disposed' })); this.#pending.clear(); }
}
