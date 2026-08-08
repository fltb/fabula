import type {
  BrowserGraphRouteSelectorV1,
  BrowserProjectCapabilitiesV1,
  BrowserProjectListV1,
  BrowserProjectOverviewV1,
  BrowserSessionPrincipalV1,
  ProjectAccessRole,
  SourceStudioStateV1,
  WorkbenchGraphProjectionV1,
} from '../contracts/index.js';
import { type AdminClient, createAdminClient } from './admin/admin-client.js';
import { type AgentChatClient, createAgentChatClient } from './agent-chat-client.js';
import { type BrowserAuthoringClient, createBrowserAuthoringClient } from './authoring-client.js';
import {
  type BrowserPublicationClient,
  createBrowserPublicationClient,
} from './browser-publication-api.js';
import {
  type BrowserFetch,
  BrowserReadApiError,
  type BrowserReadClient,
  createBrowserReadClient,
} from './browser-read-client.js';
import { type BrowserReviewClient, createBrowserReviewClient } from './browser-review-api.js';
import { createSetupClient, type SetupClient } from './setup-client.js';

export const AUTH_ENDPOINTS = Object.freeze({
  login: '/api/v1/auth/login',
  bootstrap: '/api/v1/auth/bootstrap',
} as const);

export type RuntimeState =
  | 'setup'
  | 'bootstrap-owner'
  | 'login'
  | 'project-picker'
  | 'workspace'
  | 'configuration-restart-required'
  | 'fatal-host-error';

export type RuntimeHealth =
  | 'loading'
  | 'empty'
  | 'disconnected'
  | 'unauthorized'
  | 'fatal'
  | 'ready';

export type RuntimeErrorCode =
  | 'DISCONNECTED'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'INVALID'
  | 'FATAL';

/**
 * Runtime failures are intentionally normalized at the browser boundary. No
 * response body is kept, and server messages are never interpolated into the
 * UI because auth/setup responses can contain attacker-controlled strings.
 */
export class RuntimeApiError extends Error {
  readonly status: number;
  readonly code: RuntimeErrorCode;

  constructor(status: number, code: RuntimeErrorCode, message: string) {
    super(message);
    this.name = 'RuntimeApiError';
    this.status = status;
    this.code = code;
  }
}

export interface LoginInput {
  readonly userId: string;
  readonly password: string;
}

export interface BootstrapInput {
  readonly displayName: string;
  readonly password: string;
}

export interface AuthClient {
  readonly hasSession: () => boolean;
  readonly getSessionId: () => string | null;
  readonly setSessionId: (sessionId: string | null) => void;
  login(input: LoginInput): Promise<BrowserSessionPrincipalV1>;
  bootstrap(input: BootstrapInput): Promise<BrowserSessionPrincipalV1>;
  getSession(): Promise<BrowserSessionPrincipalV1>;
  signOut(): void;
}

export interface RuntimeWorkspace {
  readonly overview: BrowserProjectOverviewV1;
  readonly source: SourceStudioStateV1;
  readonly graph: WorkbenchGraphProjectionV1;
  /** Host-derived feature gates; null only if the capabilities read failed. */
  readonly capabilities: BrowserProjectCapabilitiesV1 | null;
  /**
   * The caller's resolved project ACL role (owner normalized to `maintainer`
   * by the Host); null when the role route could not resolve one.
   */
  readonly projectRole: ProjectAccessRole | null;
}

export interface ProjectClient {
  list(): Promise<BrowserProjectListV1>;
  loadWorkspace(
    projectId: string,
    selector?: BrowserGraphRouteSelectorV1,
  ): Promise<RuntimeWorkspace>;
}

export interface RuntimeClient {
  readonly setup: SetupClient;
  readonly auth: AuthClient;
  readonly projects: ProjectClient;
  readonly read: BrowserReadClient;
  readonly admin: AdminClient;
  readonly authoring: BrowserAuthoringClient;
  readonly review: BrowserReviewClient;
  readonly publication: BrowserPublicationClient;
  /** Built-in Agent chat surface; the view renders only under the feature gate. */
  readonly agentChat: AgentChatClient;
}

/**
 * Decide whether the first-run setup wizard must show. The gate is
 * configuration- and owner-scoped only: a config is applied once `finish`
 * runs, and project/provider readiness is deliberately not part of it — an
 * author enters the (possibly empty) workspace and creates a project there.
 */
export function requiresSetup(status: {
  readonly configurationPresent: boolean;
  readonly ownerCreated: boolean;
}): boolean {
  return !status.configurationPresent || !status.ownerCreated;
}

const RUNTIME_ERROR_MESSAGES: Readonly<Record<RuntimeErrorCode, string>> = {
  DISCONNECTED: 'The Workbench Host is unavailable. Check the connection and try again.',
  UNAUTHORIZED: 'Your session is no longer authorized. Sign in again.',
  FORBIDDEN: 'This account is not allowed to open that Workbench surface.',
  NOT_FOUND: 'The requested Workbench resource is not available.',
  INVALID: 'The Host rejected this request.',
  FATAL: 'The Workbench Host returned an unexpected error.',
};

function runtimeCode(status: number): RuntimeErrorCode {
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status >= 400 && status < 500) return 'INVALID';
  return status >= 500 ? 'FATAL' : 'DISCONNECTED';
}

function fromStatus(status: number): RuntimeApiError {
  const code = runtimeCode(status);
  return new RuntimeApiError(status, code, RUNTIME_ERROR_MESSAGES[code]);
}

function fromBrowserError(error: BrowserReadApiError): RuntimeApiError {
  return fromStatus(error.status);
}

function authResult(value: unknown): { readonly sessionId: string } {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('sessionId' in value) ||
    typeof value.sessionId !== 'string' ||
    value.sessionId.length === 0
  ) {
    throw new RuntimeApiError(502, 'FATAL', RUNTIME_ERROR_MESSAGES.FATAL);
  }
  return { sessionId: value.sessionId };
}

async function postAuth(
  execute: BrowserFetch,
  prefix: string,
  path: string,
  body: Record<string, unknown>,
): Promise<string> {
  let response: Response;
  try {
    response = await execute(`${prefix}${path}`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
  } catch {
    throw new RuntimeApiError(0, 'DISCONNECTED', RUNTIME_ERROR_MESSAGES.DISCONNECTED);
  }
  if (!response.ok) throw fromStatus(response.status);
  const value: unknown = await response.json().catch(() => null);
  return authResult(value).sessionId;
}

/** Create memory-only auth and project adapters over the safe browser APIs. */
export function createRuntimeClient(
  options: { readonly fetch?: BrowserFetch; readonly baseUrl?: string } = {},
): RuntimeClient {
  const execute = options.fetch ?? globalThis.fetch;
  if (typeof execute !== 'function') throw new Error('Browser Fetch API is unavailable.');
  const prefix = options.baseUrl ?? '';
  let sessionId: string | null = null;
  const read = createBrowserReadClient({
    fetch: execute,
    baseUrl: prefix,
    getSessionId: () => sessionId,
  });
  const setup = createSetupClient({ fetch: execute, baseUrl: prefix });
  const session = () => sessionId;
  const admin = createAdminClient({ fetch: execute, baseUrl: prefix, getSessionId: session });
  const authoring = createBrowserAuthoringClient({
    fetch: execute,
    baseUrl: prefix,
    getSessionId: session,
  });
  const review = createBrowserReviewClient({
    fetch: execute,
    baseUrl: prefix,
    getSessionId: session,
  });
  const publication = createBrowserPublicationClient({
    fetch: execute,
    baseUrl: prefix,
    getSessionId: session,
  });
  const agentChat = createAgentChatClient({
    fetch: execute,
    baseUrl: prefix,
    getSessionId: session,
  });

  const auth: AuthClient = {
    hasSession: () => sessionId !== null,
    getSessionId: () => sessionId,
    setSessionId: (next) => {
      sessionId = next;
    },
    async login(input) {
      const next = await postAuth(execute, prefix, AUTH_ENDPOINTS.login, {
        userId: input.userId,
        password: input.password,
      });
      sessionId = next;
      try {
        return await read.getSession();
      } catch (error) {
        sessionId = null;
        if (error instanceof BrowserReadApiError) throw fromBrowserError(error);
        throw error;
      }
    },
    async bootstrap(input) {
      const next = await postAuth(execute, prefix, AUTH_ENDPOINTS.bootstrap, {
        displayName: input.displayName,
        password: input.password,
      });
      sessionId = next;
      try {
        return await read.getSession();
      } catch (error) {
        sessionId = null;
        if (error instanceof BrowserReadApiError) throw fromBrowserError(error);
        throw error;
      }
    },
    async getSession() {
      if (sessionId === null)
        throw new RuntimeApiError(401, 'UNAUTHORIZED', RUNTIME_ERROR_MESSAGES.UNAUTHORIZED);
      try {
        return await read.getSession();
      } catch (error) {
        if (error instanceof BrowserReadApiError) {
          if (error.status === 401) sessionId = null;
          throw fromBrowserError(error);
        }
        throw error;
      }
    },
    signOut() {
      sessionId = null;
    },
  };

  const projects: ProjectClient = {
    list: async () => {
      try {
        return await read.listProjects();
      } catch (error) {
        if (error instanceof BrowserReadApiError) throw fromBrowserError(error);
        throw error;
      }
    },
    async loadWorkspace(projectId, selector = { version: 1, branchPath: { decisions: [] } }) {
      try {
        const [overview, source, graph, capabilities, roleResult] = await Promise.all([
          read.getOverview(projectId),
          read.getSourceStudio(projectId),
          read.getGraphs(projectId, selector),
          read.loadCapabilities(projectId).catch(() => null),
          // The role route never fails the workspace load: an unresolvable
          // role degrades to null and the mutation gates fall back to the
          // callback-wiring gate (same pattern as review/publication).
          read.getProjectRole(projectId).catch(() => null),
        ]);
        return {
          overview,
          source,
          graph,
          capabilities,
          projectRole: roleResult?.role ?? null,
        };
      } catch (error) {
        if (error instanceof BrowserReadApiError) {
          if (error.status === 401) sessionId = null;
          throw fromBrowserError(error);
        }
        throw error;
      }
    },
  };

  return { setup, auth, projects, read, admin, authoring, review, publication, agentChat };
}

export function runtimeErrorMessage(error: unknown): string {
  if (error instanceof RuntimeApiError) return error.message;
  if (error instanceof BrowserReadApiError)
    return RUNTIME_ERROR_MESSAGES[runtimeCode(error.status)];
  return RUNTIME_ERROR_MESSAGES.FATAL;
}

export function runtimeHealthForError(error: unknown): RuntimeHealth {
  if (error instanceof RuntimeApiError) {
    if (error.code === 'UNAUTHORIZED') return 'unauthorized';
    if (error.code === 'DISCONNECTED') return 'disconnected';
    if (error.code === 'FATAL') return 'fatal';
  }
  if (error instanceof BrowserReadApiError) {
    const code = runtimeCode(error.status);
    if (code === 'UNAUTHORIZED') return 'unauthorized';
    if (code === 'DISCONNECTED') return 'disconnected';
    if (code === 'FATAL') return 'fatal';
  }
  return 'fatal';
}

export { RUNTIME_ERROR_MESSAGES };
