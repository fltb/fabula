import {
  BROWSER_PROJECT_PUBLICATION_CONTENT_PATH,
  BROWSER_PROJECT_PUBLICATION_PATH,
  BROWSER_PROJECT_PUBLICATIONS_PATH,
  BROWSER_PUBLICATION_CONTENT_LIMIT_QUERY,
  BROWSER_PUBLICATION_CONTENT_OFFSET_QUERY,
  BROWSER_SESSION_HEADER,
} from '../contracts/browser-api.js';
import type {
  BrowserApiErrorCode,
  BrowserApiErrorV1,
  BrowserPublicationGetResultV1,
  BrowserPublicationListV1,
  BrowserPublicationReadQueryV1,
  BrowserPublicationReadResultV1,
  BrowserPublishRequestV1,
  BrowserPublishResultV1,
} from '../contracts/index.js';
import { isRecord } from './authoring-client.js';
import type { BrowserFetch } from './browser-read-client.js';

/** Error codes the Host publication surface is allowed to produce. */
const PUBLICATION_ERROR_CODES: Readonly<Record<BrowserApiErrorCode, true>> = {
  SESSION_NOT_FOUND: true,
  SESSION_EXPIRED: true,
  PROJECT_MISMATCH: true,
  PROJECT_NOT_FOUND: true,
  INVALID_ROUTE_SELECTOR: true,
  GRAPH_UNAVAILABLE: true,
  SOURCE_UNAVAILABLE: true,
  REFERENCE_NOT_FOUND: true,
  REFERENCE_INVALID: true,
  REFERENCE_UNAVAILABLE: true,
  REFERENCE_CONFLICT: true,
  REFERENCE_IMPORT_FAILED: true,
  REFERENCE_SIZE_EXCEEDED: true,
  REVIEW_COMMENT_NOT_FOUND: true,
  REVIEW_INVALID: true,
  REVIEW_UNAVAILABLE: true,
  GATE_NOT_FOUND: true,
  GATE_NOT_OPEN: true,
  GATE_DECISION_INVALID: true,
  PUBLICATION_NOT_FOUND: true,
  PUBLICATION_INVALID: true,
  PUBLICATION_UNAVAILABLE: true,
  PUBLICATION_CONFLICT: true,
  AGENT_CHAT_UNAVAILABLE: true,
  AGENT_CHAT_CONVERSATION_NOT_FOUND: true,
  AGENT_CHAT_RUN_NOT_FOUND: true,
  AGENT_CHAT_INVALID: true,
  AGENT_CHAT_RUN_TERMINAL: true,
  AGENT_CHAT_QUEUE_FULL: true,
  SCENE_ADOPTION_NOT_FOUND: true,
  SCENE_ADOPTION_INVALID: true,
  SCENE_ADOPTION_UNAVAILABLE: true,
  SCENE_NOT_FOUND: true,
  SCENE_RENDER_INVALID: true,
  SCENE_RENDER_QUEUE_FULL: true,
  SCENE_RENDER_UNAVAILABLE: true,
  SCENE_MAP_UNAVAILABLE: true,
  PROJECT_IMPORT_NOT_FOUND: true,
  PROJECT_IMPORT_INVALID: true,
  PROJECT_IMPORT_CONFLICT: true,
};

/** Typed non-2xx failure from the guarded Host publication surface. */
export class BrowserPublicationApiError extends Error {
  readonly status: number;
  readonly code: BrowserApiErrorV1['error']['code'] | null;

  constructor(status: number, code: BrowserApiErrorV1['error']['code'] | null, message: string) {
    super(message);
    this.name = 'BrowserPublicationApiError';
    this.status = status;
    this.code = code;
  }
}

export interface BrowserPublicationClient {
  /** Publication catalog (canonical + custom branches) for one project. */
  list(projectId: string): Promise<BrowserPublicationListV1>;
  get(projectId: string, publicationId: string): Promise<BrowserPublicationGetResultV1>;
  /** Bounded markdown slice of one publication artifact. */
  read(
    projectId: string,
    publicationId: string,
    query?: BrowserPublicationReadQueryV1,
  ): Promise<BrowserPublicationReadResultV1>;
  /** Publish the canonical novel or a custom branch artifact. */
  publish(request: BrowserPublishRequestV1): Promise<BrowserPublishResultV1>;
}

export interface BrowserPublicationClientOptions {
  /** Supplies the transient session only for each request; never persisted. */
  readonly getSessionId?: () => string | null | undefined;
  readonly fetch?: BrowserFetch;
  /** Optional same-origin prefix for embedded hosts and tests. */
  readonly baseUrl?: string;
}

function failureFrom(value: unknown): { readonly code: string; readonly message: string } | null {
  if (!isRecord(value)) return null;
  const nested = value.error;
  if (isRecord(nested) && typeof nested.code === 'string' && typeof nested.message === 'string') {
    return { code: nested.code, message: nested.message };
  }
  const failure = value.failure;
  if (
    isRecord(failure) &&
    typeof failure.code === 'string' &&
    typeof failure.message === 'string'
  ) {
    return { code: failure.code, message: failure.message };
  }
  return null;
}

async function decode<T>(response: Response): Promise<T> {
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = failureFrom(value);
    const code = failure?.code;
    throw new BrowserPublicationApiError(
      response.status,
      code !== undefined && PUBLICATION_ERROR_CODES[code as BrowserApiErrorCode] === true
        ? (code as BrowserApiErrorCode)
        : null,
      failure?.message ?? `Host publication request failed with HTTP ${response.status}.`,
    );
  }
  return value as T;
}

/**
 * Create a same-origin publication client. Identity comes from the transient
 * session header; the client never sends an actor, capability token, Host
 * path, or unpublished bytes, and mutations are enforced server-side by
 * scope. All content is read through the bounded content route.
 */
export function createBrowserPublicationClient(
  options: BrowserPublicationClientOptions = {},
): BrowserPublicationClient {
  const execute = options.fetch ?? globalThis.fetch;
  if (typeof execute !== 'function') throw new Error('Browser Fetch API is unavailable.');
  const prefix = options.baseUrl ?? '';

  const headersFor = (accept: string): Headers => {
    const headers = new Headers({ accept });
    const sessionId = options.getSessionId?.();
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      headers.set(BROWSER_SESSION_HEADER, sessionId);
    }
    return headers;
  };

  const pathFor = (template: string, projectId: string): string =>
    template.replace(':projectId', encodeURIComponent(projectId));

  const publicationPath = (projectId: string, publicationId: string): string =>
    pathFor(BROWSER_PROJECT_PUBLICATION_PATH, projectId).replace(
      ':publicationId',
      encodeURIComponent(publicationId),
    );

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

  const withReadQuery = (path: string, query?: BrowserPublicationReadQueryV1): string => {
    if (query === undefined) return path;
    const params = new URLSearchParams();
    if (query.offset !== undefined) {
      params.set(BROWSER_PUBLICATION_CONTENT_OFFSET_QUERY, String(query.offset));
    }
    if (query.limit !== undefined) {
      params.set(BROWSER_PUBLICATION_CONTENT_LIMIT_QUERY, String(query.limit));
    }
    const encoded = params.toString();
    return encoded.length === 0 ? path : `${path}?${encoded}`;
  };

  return {
    list: (projectId) =>
      get<BrowserPublicationListV1>(pathFor(BROWSER_PROJECT_PUBLICATIONS_PATH, projectId)),
    get: (projectId, publicationId) =>
      get<BrowserPublicationGetResultV1>(publicationPath(projectId, publicationId)),
    read: (projectId, publicationId, query) =>
      get<BrowserPublicationReadResultV1>(
        withReadQuery(
          pathFor(BROWSER_PROJECT_PUBLICATION_CONTENT_PATH, projectId).replace(
            ':publicationId',
            encodeURIComponent(publicationId),
          ),
          query,
        ),
      ),
    publish: (request) =>
      post<BrowserPublishResultV1>(
        pathFor(BROWSER_PROJECT_PUBLICATIONS_PATH, request.projectId),
        request,
      ),
  };
}
