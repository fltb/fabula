import {
  BROWSER_GRAPH_ROUTE_QUERY,
  BROWSER_PROJECT_CAPABILITIES_PATH,
  BROWSER_PROJECT_GRAPHS_PATH,
  BROWSER_PROJECT_OVERVIEW_PATH,
  BROWSER_PROJECT_REFERENCES_PATH,
  BROWSER_PROJECTS_PATH,
  BROWSER_SESSION_HEADER,
  BROWSER_SESSION_PATH,
} from '../contracts/browser-api.js';
import type {
  BrowserApiErrorV1,
  BrowserGraphRouteSelectorV1,
  BrowserProjectCapabilitiesV1,
  BrowserProjectListV1,
  BrowserProjectOverviewV1,
  BrowserProjectReferenceListQueryV1,
  BrowserProjectReferenceListV1,
  BrowserSessionPrincipalV1,
  SourceStudioStateV1,
  WorkbenchGraphProjectionV1,
} from '../contracts/index.js';
import { BROWSER_PROJECT_SOURCE_PATH } from '../contracts/source-studio.js';

/** A browser-native Fetch signature, injectable for deterministic component tests. */
export type BrowserFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * A typed failure from the Host's browser read surface. No response body is
 * retained beyond its public error code/message, so credentials and headers
 * cannot accidentally reach a component.
 */
export class BrowserReadApiError extends Error {
  readonly status: number;
  readonly code: BrowserApiErrorV1['error']['code'] | null;

  constructor(status: number, code: BrowserApiErrorV1['error']['code'] | null, message: string) {
    super(message);
    this.name = 'BrowserReadApiError';
    this.status = status;
    this.code = code;
  }
}

export interface BrowserReadClient {
  getSession(): Promise<BrowserSessionPrincipalV1>;
  listProjects(): Promise<BrowserProjectListV1>;
  getOverview(projectId: string): Promise<BrowserProjectOverviewV1>;
  loadCapabilities(projectId: string): Promise<BrowserProjectCapabilitiesV1>;
  getSourceStudio(projectId: string): Promise<SourceStudioStateV1>;
  listReferences(
    projectId: string,
    query?: BrowserProjectReferenceListQueryV1,
  ): Promise<BrowserProjectReferenceListV1>;
  getGraphs(
    projectId: string,
    selector: BrowserGraphRouteSelectorV1,
  ): Promise<WorkbenchGraphProjectionV1>;
}

export interface BrowserReadClientOptions {
  /** Supplies the session only for the active request; callers must not persist it. */
  readonly getSessionId?: () => string | null | undefined;
  readonly fetch?: BrowserFetch;
  /** Optional same-origin prefix for embedded or test hosts. */
  readonly baseUrl?: string;
}

const BROWSER_ERROR_CODES = new Set<BrowserApiErrorV1['error']['code']>([
  'SESSION_NOT_FOUND',
  'SESSION_EXPIRED',
  'PROJECT_MISMATCH',
  'PROJECT_NOT_FOUND',
  'INVALID_ROUTE_SELECTOR',
  'GRAPH_UNAVAILABLE',
  'SOURCE_UNAVAILABLE',
  'REFERENCE_NOT_FOUND',
  'REFERENCE_INVALID',
  'REFERENCE_UNAVAILABLE',
  'REFERENCE_CONFLICT',
]);

function browserError(value: unknown): BrowserApiErrorV1 | null {
  if (typeof value !== 'object' || value === null || !('error' in value)) return null;
  const error = value.error;
  if (
    typeof error !== 'object' ||
    error === null ||
    !('code' in error) ||
    !('message' in error) ||
    typeof error.code !== 'string' ||
    typeof error.message !== 'string'
  ) {
    return null;
  }
  if (!BROWSER_ERROR_CODES.has(error.code as BrowserApiErrorV1['error']['code'])) return null;
  return value as BrowserApiErrorV1;
}

async function decode<T>(response: Response): Promise<T> {
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = browserError(value);
    throw new BrowserReadApiError(
      response.status,
      error?.error.code ?? null,
      error?.error.message ?? `Host read request failed with HTTP ${response.status}.`,
    );
  }
  return value as T;
}

/**
 * Create a same-origin read client. The only mutable authority is the Host;
 * the client sends no actor, project root, capability, Git, or source bytes.
 */
export function createBrowserReadClient(options: BrowserReadClientOptions = {}): BrowserReadClient {
  const execute = options.fetch ?? globalThis.fetch;
  if (typeof execute !== 'function') {
    throw new Error('Browser Fetch API is unavailable.');
  }
  const prefix = options.baseUrl ?? '';
  const request = async <T>(path: string): Promise<T> => {
    const sessionId = options.getSessionId?.();
    const headers = new Headers({ accept: 'application/json' });
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      headers.set(BROWSER_SESSION_HEADER, sessionId);
    }
    return decode<T>(
      await execute(`${prefix}${path}`, {
        method: 'GET',
        headers,
        credentials: 'same-origin',
      }),
    );
  };
  return {
    getSession: () => request(BROWSER_SESSION_PATH),
    listProjects: () => request(BROWSER_PROJECTS_PATH),
    getOverview: (projectId) =>
      request(BROWSER_PROJECT_OVERVIEW_PATH.replace(':projectId', encodeURIComponent(projectId))),
    /** Same safe-read pattern as getOverview, for the Host-derived feature gates. */
    loadCapabilities: (projectId) =>
      request(
        BROWSER_PROJECT_CAPABILITIES_PATH.replace(':projectId', encodeURIComponent(projectId)),
      ),
    getSourceStudio: (projectId) =>
      request(BROWSER_PROJECT_SOURCE_PATH.replace(':projectId', encodeURIComponent(projectId))),
    listReferences: (projectId, query = {}) => {
      const path = BROWSER_PROJECT_REFERENCES_PATH.replace(
        ':projectId',
        encodeURIComponent(projectId),
      );
      const params = new URLSearchParams();
      if (query.pageSize !== undefined) params.set('pageSize', String(query.pageSize));
      if (query.cursor !== undefined) params.set('cursor', query.cursor);
      const suffix = params.size === 0 ? '' : `?${params.toString()}`;
      return request(`${path}${suffix}`);
    },
    getGraphs: (projectId, selector) => {
      const path = BROWSER_PROJECT_GRAPHS_PATH.replace(':projectId', encodeURIComponent(projectId));
      return request(
        `${path}?${BROWSER_GRAPH_ROUTE_QUERY}=${encodeURIComponent(JSON.stringify(selector))}`,
      );
    },
  };
}
