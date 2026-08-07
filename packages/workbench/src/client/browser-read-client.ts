import {
  BROWSER_GRAPH_ROUTE_QUERY,
  BROWSER_PROJECT_CAPABILITIES_PATH,
  BROWSER_PROJECT_GRAPHS_PATH,
  BROWSER_PROJECT_OVERVIEW_PATH,
  BROWSER_PROJECT_REFERENCE_CONTENT_PATH,
  BROWSER_PROJECT_REFERENCE_PATH,
  BROWSER_PROJECT_REFERENCES_IMPORT_PATH,
  BROWSER_PROJECT_REFERENCES_PATH,
  BROWSER_PROJECT_REFERENCE_RETRY_PATH,
  BROWSER_PROJECT_ROLE_PATH,
  BROWSER_PROJECT_SCENE_ADOPTION_PATH,
  BROWSER_PROJECTS_PATH,
  BROWSER_SESSION_HEADER,
  BROWSER_SESSION_PATH,
  BROWSER_SCENE_ADOPTION_EVENT_QUERY,
  BROWSER_SCENE_ADOPTION_REVISION_QUERY,
} from '../contracts/browser-api.js';
import type { BrowserProjectRoleV1 } from '../contracts/browser-api.js';
import type {
  BrowserApiErrorV1,
  BrowserGraphRouteSelectorV1,
  BrowserProjectCapabilitiesV1,
  BrowserProjectListV1,
  BrowserProjectOverviewV1,
  BrowserProjectReferenceDeleteResultV1,
  BrowserProjectReferenceGetResultV1,
  BrowserProjectReferenceImportResultV1,
  BrowserProjectReferenceListQueryV1,
  BrowserProjectReferenceListV1,
  BrowserProjectReferenceReadQueryV1,
  BrowserProjectReferenceReadResultV1,
  BrowserProjectReferenceRetryResultV1,
  BrowserSessionPrincipalV1,
  SceneAdoptionViewV1,
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
  /** One reference item; null when the reference does not exist. */
  getReference(projectId: string, referenceId: string): Promise<BrowserProjectReferenceGetResultV1>;
  /** One bounded content slice of a reference object. */
  getReferenceContent(
    projectId: string,
    referenceId: string,
    query: BrowserProjectReferenceReadQueryV1,
  ): Promise<BrowserProjectReferenceReadResultV1>;
  /** Multipart reference import; the returned job is terminal (succeeded or failed). */
  importReference(
    projectId: string,
    file: File,
    metadata?: { readonly displayName?: string },
  ): Promise<BrowserProjectReferenceImportResultV1>;
  /** Re-run one failed import job from its persisted chunks. */
  retryReference(projectId: string, jobId: string): Promise<BrowserProjectReferenceRetryResultV1>;
  /** Delete one reference; 404 when the reference does not exist. */
  deleteReference(
    projectId: string,
    referenceId: string,
  ): Promise<BrowserProjectReferenceDeleteResultV1>;
  getSceneAdoption(
    projectId: string,
    eventId: string,
    revisionId: string,
  ): Promise<SceneAdoptionViewV1>;
  getProjectRole(projectId: string): Promise<BrowserProjectRoleV1>;
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
  'REFERENCE_IMPORT_FAILED',
  'REFERENCE_SIZE_EXCEEDED',
  'SCENE_ADOPTION_NOT_FOUND',
  'SCENE_ADOPTION_INVALID',
  'SCENE_ADOPTION_UNAVAILABLE',
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
  const mutate = async <T>(
    path: string,
    method: 'POST' | 'DELETE',
    body?: BodyInit,
    headers?: HeadersInit,
  ): Promise<T> => {
    const sessionId = options.getSessionId?.();
    const combined = new Headers({ accept: 'application/json' });
    if (headers !== undefined) {
      new Headers(headers).forEach((value, key) => combined.set(key, value));
    }
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      combined.set(BROWSER_SESSION_HEADER, sessionId);
    }
    return decode<T>(
      await execute(`${prefix}${path}`, {
        method,
        headers: combined,
        body,
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
    getReference: (projectId, referenceId) =>
      request(
        BROWSER_PROJECT_REFERENCE_PATH.replace(':projectId', encodeURIComponent(projectId)).replace(
          ':referenceId',
          encodeURIComponent(referenceId),
        ),
      ),
    getReferenceContent: (projectId, referenceId, query) => {
      const path = BROWSER_PROJECT_REFERENCE_CONTENT_PATH.replace(
        ':projectId',
        encodeURIComponent(projectId),
      ).replace(':referenceId', encodeURIComponent(referenceId));
      const params = new URLSearchParams();
      params.set('offset', String(query.offset));
      params.set('limit', String(query.limit));
      return request(`${path}?${params.toString()}`);
    },
    importReference: (projectId, file, metadata) => {
      const form = new FormData();
      form.append('file', file);
      if (metadata?.displayName !== undefined && metadata.displayName.length > 0) {
        form.append('displayName', metadata.displayName);
      }
      return mutate(
        BROWSER_PROJECT_REFERENCES_IMPORT_PATH.replace(
          ':projectId',
          encodeURIComponent(projectId),
        ),
        'POST',
        form,
      );
    },
    retryReference: (projectId, jobId) => {
      const path = BROWSER_PROJECT_REFERENCE_RETRY_PATH.replace(
        ':projectId',
        encodeURIComponent(projectId),
      );
      return mutate<BrowserProjectReferenceRetryResultV1>(
        path,
        'POST',
        JSON.stringify({ version: 1, jobId }),
        { 'content-type': 'application/json' },
      );
    },
    deleteReference: (projectId, referenceId) =>
      mutate(
        BROWSER_PROJECT_REFERENCE_PATH.replace(':projectId', encodeURIComponent(projectId)).replace(
          ':referenceId',
          encodeURIComponent(referenceId),
        ),
        'DELETE',
      ),
    getSceneAdoption: (projectId, eventId, revisionId) => {
      const path = BROWSER_PROJECT_SCENE_ADOPTION_PATH.replace(
        ':projectId',
        encodeURIComponent(projectId),
      );
      const params = new URLSearchParams();
      params.set(BROWSER_SCENE_ADOPTION_EVENT_QUERY, eventId);
      params.set(BROWSER_SCENE_ADOPTION_REVISION_QUERY, revisionId);
      return request(`${path}?${params.toString()}`);
    },
    getProjectRole: (projectId) =>
      request(BROWSER_PROJECT_ROLE_PATH.replace(':projectId', encodeURIComponent(projectId))),
    getGraphs: (projectId, selector) => {
      const path = BROWSER_PROJECT_GRAPHS_PATH.replace(':projectId', encodeURIComponent(projectId));
      return request(
        `${path}?${BROWSER_GRAPH_ROUTE_QUERY}=${encodeURIComponent(JSON.stringify(selector))}`,
      );
    },
  };
}
