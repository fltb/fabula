import type {
  PersistenceOperation,
  PersistencePayloads,
  PersistenceResults,
} from '../contracts/persistence.js';
import {
  type PersistenceMessagePort,
  type PersistenceRequest,
  type PersistenceResponse,
  serializePersistenceError,
} from './messages.js';

/** Async-only domain client. It never imports the database driver, Kysely, or a worker implementation. */
export class PersistenceWorkerClient {
  readonly #port: PersistenceMessagePort;
  #sequence = 0;
  readonly #pending = new Map<
    string,
    { resolve(value: unknown): void; reject(error: unknown): void }
  >();
  constructor(port: PersistenceMessagePort) {
    this.#port = port;
    port.addEventListener('message', this.#onMessage);
  }
  #onMessage = (event: { data: PersistenceResponse }): void => {
    const response = event.data;
    const pending = this.#pending.get(response.correlationId);
    if (!pending) return;
    this.#pending.delete(response.correlationId);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(response.error);
  };
  request<O extends PersistenceOperation>(
    operation: O,
    payload: PersistencePayloads[O],
    signal?: AbortSignal,
  ): Promise<PersistenceResults[O]> {
    const correlationId = `p${++this.#sequence}`;
    if (signal?.aborted)
      return Promise.reject({
        code: 'ABORTED',
        message: 'Persistence task aborted before its next task boundary',
        retryable: false,
      });
    return new Promise((resolve, reject) => {
      const abort = (): void => {
        if (this.#pending.delete(correlationId))
          reject({
            code: 'ABORTED',
            message: 'Persistence task aborted before its next task boundary',
            retryable: false,
          });
      };
      this.#pending.set(correlationId, { resolve, reject });
      signal?.addEventListener('abort', abort, { once: true });
      const request: PersistenceRequest<O> = { correlationId, operation, payload };
      this.#port.postMessage(request);
    }) as Promise<PersistenceResults[O]>;
  }
  dispose(): void {
    this.#port.removeEventListener?.('message', this.#onMessage);
    for (const pending of this.#pending.values())
      pending.reject(
        serializePersistenceError({
          code: 'CLIENT_DISPOSED',
          message: 'Persistence client disposed',
        }),
      );
    this.#pending.clear();
  }
}
