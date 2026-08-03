import {
  AUTHORING_CONTRACT_VERSION,
  BROWSER_AUTHORING_EVENTS_PATH,
  BROWSER_AUTHORING_OPERATION_PATH,
  BROWSER_AUTHORING_OPERATIONS_PATH,
  BROWSER_AUTHORING_RECONCILE_PATH,
  BROWSER_AUTHORING_REVISION_DIFF_PATH,
  BROWSER_AUTHORING_REVISION_PATH,
  BROWSER_AUTHORING_REVISION_RESTORE_PATH,
  BROWSER_AUTHORING_REVISIONS_PATH,
  BROWSER_AUTHORING_STATE_PATH,
  BROWSER_AUTHORING_SUBMIT_PATH,
  type AuthoringActivityEventV1,
  type AuthoringFailureV1,
  type AuthoringOperationReceiptV1,
  type AuthoringStateV1,
  type BrowserAuthoringReconcileRequestV1,
  type BrowserAuthoringReconcileResultV1,
  type BrowserAuthoringRevisionDiffV1,
  type BrowserAuthoringRevisionListV1,
  type BrowserAuthoringRevisionRestoreRequestV1,
  type BrowserAuthoringRevisionRestoreResultV1,
  type BrowserAuthoringRevisionV1,
  type BrowserAuthoringSubmitRequestV1,
  type BrowserAuthoringSubmitResultV1,
} from '../contracts/authoring.js';
import type { BrowserFetch } from './browser-read-client.js';

/** Safe operation list returned by the browser authoring API. */
export interface BrowserAuthoringOperationsV1 {
  readonly version: typeof AUTHORING_CONTRACT_VERSION;
  readonly projectId: string;
  readonly operations: readonly AuthoringOperationReceiptV1[];
  readonly generatedAt: string;
}

/** Typed non-2xx failure from the guarded Host authoring surface. */
export class BrowserAuthoringApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.name = 'BrowserAuthoringApiError';
    this.status = status;
    this.code = code;
  }
}
export interface AuthoringEventSubscription {
  /** Resolves once the stream response is authenticated and readable. */
  readonly ready: Promise<void>;
  /** Abort the stream and detach the Host reader. */
  close(): void;
}

export interface BrowserAuthoringClient {
  getState(projectId: string): Promise<AuthoringStateV1>;
  listOperations(projectId: string): Promise<BrowserAuthoringOperationsV1>;
  getOperation(projectId: string, operationId: string): Promise<AuthoringOperationReceiptV1>;
  listRevisions(projectId: string, cursor?: string): Promise<BrowserAuthoringRevisionListV1>;
  getRevision(projectId: string, revisionId: string): Promise<{
    readonly version: typeof AUTHORING_CONTRACT_VERSION;
    readonly projectId: string;
    readonly revision: BrowserAuthoringRevisionV1;
    readonly generatedAt: string;
  }>;
  diffRevisions(
    projectId: string,
    fromRevisionId: string,
    toRevisionId: string,
  ): Promise<BrowserAuthoringRevisionDiffV1>;
  restoreRevision(
    request: BrowserAuthoringRevisionRestoreRequestV1,
  ): Promise<BrowserAuthoringRevisionRestoreResultV1>;
  submit(request: BrowserAuthoringSubmitRequestV1): Promise<BrowserAuthoringSubmitResultV1>;
  reconcile(request: BrowserAuthoringReconcileRequestV1): Promise<BrowserAuthoringReconcileResultV1>;
  subscribeEvents(
    projectId: string,
    handlers: {
      readonly onEvent: (event: AuthoringActivityEventV1) => void;
      readonly onError?: (error: BrowserAuthoringApiError) => void;
    },
  ): AuthoringEventSubscription;
}

export interface BrowserAuthoringClientOptions {
  /** Supplies the transient session only for each request; never persisted. */
  readonly getSessionId?: () => string | null | undefined;
  readonly fetch?: BrowserFetch;
  /** Optional same-origin prefix for embedded hosts and tests. */
  readonly baseUrl?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failureFrom(value: unknown): { readonly code: string; readonly message: string } | null {
  if (!isRecord(value)) return null;
  const nested = value.error;
  if (isRecord(nested) && typeof nested.code === 'string' && typeof nested.message === 'string') {
    return { code: nested.code, message: nested.message };
  }
  const failure = value.failure;
  if (isRecord(failure) && typeof failure.code === 'string' && typeof failure.message === 'string') {
    return { code: failure.code, message: failure.message };
  }
  return null;
}

async function decode<T>(response: Response): Promise<T> {
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = failureFrom(value);
    throw new BrowserAuthoringApiError(
      response.status,
      failure?.code ?? null,
      failure?.message ?? `Host authoring request failed with HTTP ${response.status}.`,
    );
  }
  return value as T;
}

function eventType(value: unknown): value is AuthoringActivityEventV1['type'] {
  return (
    value === 'state-changed' ||
    value === 'operation-updated' ||
    value === 'submit-receipt' ||
    value === 'external-candidate' ||
    value === 'presence-changed'
  );
}

/**
 * Narrow the SSE payload before it reaches UI state. The detailed nested
 * contracts are Host-owned; this guard still rejects arbitrary JSON, wrong
 * versions, wrong project streams and unknown event types.
 */
function parseEvent(value: unknown, projectId: string): AuthoringActivityEventV1 | null {
  if (!isRecord(value)) return null;
  if (value.version !== AUTHORING_CONTRACT_VERSION || value.projectId !== projectId) return null;
  if (!eventType(value.type)) return null;
  if (typeof value.at !== 'string' || value.at.length === 0) return null;
  return value as unknown as AuthoringActivityEventV1;
}

function parseSseBlock(block: string, projectId: string): AuthoringActivityEventV1 | null {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (data.length === 0) return null;
  try {
    return parseEvent(JSON.parse(data) as unknown, projectId);
  } catch {
    return null;
  }
}

/**
 * Create a same-origin authoring client. Ordinary editor typing never calls
 * this client: only explicit submit/reconcile and initial/event reads use
 * Fetch. The Yjs editor has its own authenticated WebSocket transport.
 */
export function createBrowserAuthoringClient(
  options: BrowserAuthoringClientOptions = {},
): BrowserAuthoringClient {
  const execute = options.fetch ?? globalThis.fetch;
  if (typeof execute !== 'function') throw new Error('Browser Fetch API is unavailable.');
  const prefix = options.baseUrl ?? '';

  const headersFor = (accept: string): Headers => {
    const headers = new Headers({ accept });
    const sessionId = options.getSessionId?.();
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      headers.set('x-fabula-session', sessionId);
    }
    return headers;
  };

  const pathFor = (template: string, projectId: string): string =>
    template.replace(':projectId', encodeURIComponent(projectId));

  const get = async <T>(path: string): Promise<T> =>
    decode<T>(
      await execute(`${prefix}${path}`, {
        method: 'GET',
        headers: headersFor('application/json'),
        credentials: 'same-origin',
      }),
    );

  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const headers = headersFor('application/json');
    headers.set('content-type', 'application/json');
    return decode<T>(
      await execute(`${prefix}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        credentials: 'same-origin',
      }),
    );
  };

  return {
    getState: (projectId) =>
      get<AuthoringStateV1>(pathFor(BROWSER_AUTHORING_STATE_PATH, projectId)),
    listOperations: (projectId) =>
      get<BrowserAuthoringOperationsV1>(pathFor(BROWSER_AUTHORING_OPERATIONS_PATH, projectId)),
    getOperation: (projectId, operationId) =>
      get<AuthoringOperationReceiptV1>(
        pathFor(BROWSER_AUTHORING_OPERATION_PATH, projectId).replace(
          ':operationId',
          encodeURIComponent(operationId),
        ),
      ),
    listRevisions: (projectId, cursor) => {
      const path = pathFor(BROWSER_AUTHORING_REVISIONS_PATH, projectId);
      return get<BrowserAuthoringRevisionListV1>(
        cursor === undefined ? path : `${path}?cursor=${encodeURIComponent(cursor)}`,
      );
    },
    getRevision: (projectId, revisionId) =>
      get<{
        readonly version: typeof AUTHORING_CONTRACT_VERSION;
        readonly projectId: string;
        readonly revision: BrowserAuthoringRevisionV1;
        readonly generatedAt: string;
      }>(
        pathFor(BROWSER_AUTHORING_REVISION_PATH, projectId).replace(
          ':revisionId',
          encodeURIComponent(revisionId),
        ),
      ),
    diffRevisions: (projectId, fromRevisionId, toRevisionId) => {
      const path = pathFor(BROWSER_AUTHORING_REVISION_DIFF_PATH, projectId);
      return get<BrowserAuthoringRevisionDiffV1>(
        `${path}?fromRevisionId=${encodeURIComponent(fromRevisionId)}&toRevisionId=${encodeURIComponent(toRevisionId)}`,
      );
    },
    restoreRevision: (request) =>
      post<BrowserAuthoringRevisionRestoreResultV1>(
        pathFor(BROWSER_AUTHORING_REVISION_RESTORE_PATH, request.projectId),
        request,
      ),
    submit: (request) =>
      post<BrowserAuthoringSubmitResultV1>(
        pathFor(BROWSER_AUTHORING_SUBMIT_PATH, request.projectId),
        request,
      ),
    reconcile: (request) =>
      post<BrowserAuthoringReconcileResultV1>(
        pathFor(BROWSER_AUTHORING_RECONCILE_PATH, request.projectId),
        request,
      ),
    subscribeEvents(projectId, handlers) {
      const controller = new AbortController();
      let settled = false;
      let closed = false;
      let resolveReady!: () => void;
      let rejectReady!: (error: unknown) => void;
      const ready = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });

      const finishError = (error: unknown): void => {
        const typed = error instanceof BrowserAuthoringApiError
          ? error
          : new BrowserAuthoringApiError(0, null, 'The authoring event stream stopped unexpectedly.');
        if (!settled) {
          settled = true;
          rejectReady(typed);
        }
        if (!closed) handlers.onError?.(typed);
      };

      void (async () => {
        try {
          const response = await execute(
            `${prefix}${pathFor(BROWSER_AUTHORING_EVENTS_PATH, projectId)}`,
            {
              method: 'GET',
              headers: headersFor('text/event-stream'),
              credentials: 'same-origin',
              signal: controller.signal,
            },
          );
          if (!response.ok) {
            const value: unknown = await response.json().catch(() => null);
            const failure = failureFrom(value);
            throw new BrowserAuthoringApiError(
              response.status,
              failure?.code ?? null,
              failure?.message ?? `Host authoring event stream failed with HTTP ${response.status}.`,
            );
          }
          if (response.body === null) {
            throw new BrowserAuthoringApiError(503, 'AUTHORING_UNAVAILABLE', 'The authoring event stream has no body.');
          }
          settled = true;
          resolveReady();
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          while (!closed) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            let boundary = buffer.indexOf('\n\n');
            while (boundary >= 0) {
              const block = buffer.slice(0, boundary).replace(/\r\n/g, '\n');
              buffer = buffer.slice(boundary + 2);
              const event = parseSseBlock(block, projectId);
              if (event !== null) handlers.onEvent(event);
              boundary = buffer.indexOf('\n\n');
            }
          }
          if (!closed) finishError(new BrowserAuthoringApiError(0, null, 'The authoring event stream closed.'));
        } catch (error) {
          if (!closed) finishError(error);
        }
      })();

      return {
        ready,
        close(): void {
          if (closed) return;
          closed = true;
          controller.abort();
          if (!settled) {
            settled = true;
            rejectReady(new BrowserAuthoringApiError(0, null, 'The authoring event stream was closed.'));
          }
        },
      };
    },
  };
}

export type {
  AuthoringActivityEventV1,
  AuthoringFailureV1,
  AuthoringOperationReceiptV1,
  AuthoringStateV1,
  BrowserAuthoringReconcileRequestV1,
  BrowserAuthoringReconcileResultV1,
  BrowserAuthoringRevisionDiffV1,
  BrowserAuthoringRevisionListV1,
  BrowserAuthoringRevisionRestoreRequestV1,
  BrowserAuthoringRevisionRestoreResultV1,
  BrowserAuthoringRevisionV1,
  BrowserAuthoringSubmitRequestV1,
  BrowserAuthoringSubmitResultV1,
  BrowserFetch,
};
