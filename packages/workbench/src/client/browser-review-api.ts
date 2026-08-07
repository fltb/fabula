import {
  BROWSER_PROJECT_GATE_DECISION_PATH,
  BROWSER_PROJECT_GATES_PATH,
  BROWSER_PROJECT_REVIEW_HISTORY_PATH,
  BROWSER_PROJECT_REVIEW_PATH,
  BROWSER_PROJECT_REVIEWS_PATH,
  BROWSER_SESSION_HEADER,
} from '../contracts/browser-api.js';
import type {
  BrowserApiErrorCode,
  BrowserApiErrorV1,
  BrowserReviewAddRequestV1,
  BrowserReviewCommentResultV1,
  BrowserReviewGateDecideRequestV1,
  BrowserReviewGateDecisionResultV1,
  BrowserReviewGateListV1,
  BrowserReviewHistoryV1,
  BrowserReviewListV1,
  BrowserReviewUpdateRequestV1,
} from '../contracts/index.js';
import { isRecord } from './authoring-client.js';
import type { BrowserFetch } from './browser-read-client.js';

/** Error codes the Host review surface is allowed to produce. */
const REVIEW_ERROR_CODES: Readonly<Record<BrowserApiErrorCode, true>> = {
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
};

/** Typed non-2xx failure from the guarded Host review surface. */
export class BrowserReviewApiError extends Error {
  readonly status: number;
  readonly code: BrowserApiErrorV1['error']['code'] | null;

  constructor(status: number, code: BrowserApiErrorV1['error']['code'] | null, message: string) {
    super(message);
    this.name = 'BrowserReviewApiError';
    this.status = status;
    this.code = code;
  }
}

export interface BrowserReviewListQueryV1 {
  /** Narrow the review list/history to one scene event. */
  readonly eventId?: string;
}

export interface BrowserReviewClient {
  /** Project review comments with their revision linkage. */
  list(projectId: string, query?: BrowserReviewListQueryV1): Promise<BrowserReviewListV1>;
  get(projectId: string, commentId: string): Promise<BrowserReviewCommentResultV1>;
  add(request: BrowserReviewAddRequestV1): Promise<BrowserReviewCommentResultV1>;
  update(request: BrowserReviewUpdateRequestV1): Promise<BrowserReviewCommentResultV1>;
  /** Safe review event trail; never raw event payloads. */
  history(projectId: string, query?: BrowserReviewListQueryV1): Promise<BrowserReviewHistoryV1>;
  /** Release gates for the project. */
  gateList(projectId: string, query?: BrowserReviewListQueryV1): Promise<BrowserReviewGateListV1>;
  gateDecide(request: BrowserReviewGateDecideRequestV1): Promise<BrowserReviewGateDecisionResultV1>;
}

export interface BrowserReviewClientOptions {
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
    throw new BrowserReviewApiError(
      response.status,
      code !== undefined && REVIEW_ERROR_CODES[code as BrowserApiErrorCode] === true
        ? (code as BrowserApiErrorCode)
        : null,
      failure?.message ?? `Host review request failed with HTTP ${response.status}.`,
    );
  }
  return value as T;
}

/**
 * Create a same-origin review client. Identity comes from the transient
 * session header; the client never sends an actor, capability token, review
 * bytes, or Host path, and mutations are enforced server-side by scope.
 */
export function createBrowserReviewClient(
  options: BrowserReviewClientOptions = {},
): BrowserReviewClient {
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

  const reviewPath = (projectId: string, commentId: string): string =>
    pathFor(BROWSER_PROJECT_REVIEW_PATH, projectId).replace(
      ':commentId',
      encodeURIComponent(commentId),
    );

  const withEventQuery = (path: string, query?: BrowserReviewListQueryV1): string =>
    query?.eventId === undefined ? path : `${path}?eventId=${encodeURIComponent(query.eventId)}`;

  return {
    list: (projectId, query) =>
      get<BrowserReviewListV1>(
        withEventQuery(pathFor(BROWSER_PROJECT_REVIEWS_PATH, projectId), query),
      ),
    get: (projectId, commentId) =>
      get<BrowserReviewCommentResultV1>(reviewPath(projectId, commentId)),
    add: (request) =>
      post<BrowserReviewCommentResultV1>(
        pathFor(BROWSER_PROJECT_REVIEWS_PATH, request.projectId),
        request,
      ),
    update: (request) =>
      post<BrowserReviewCommentResultV1>(reviewPath(request.projectId, request.commentId), request),
    history: (projectId, query) =>
      get<BrowserReviewHistoryV1>(
        withEventQuery(pathFor(BROWSER_PROJECT_REVIEW_HISTORY_PATH, projectId), query),
      ),
    gateList: (projectId, query) =>
      get<BrowserReviewGateListV1>(
        withEventQuery(pathFor(BROWSER_PROJECT_GATES_PATH, projectId), query),
      ),
    gateDecide: (request) =>
      post<BrowserReviewGateDecisionResultV1>(
        pathFor(BROWSER_PROJECT_GATE_DECISION_PATH, request.projectId).replace(
          ':gateId',
          encodeURIComponent(request.gateId),
        ),
        request,
      ),
  };
}
