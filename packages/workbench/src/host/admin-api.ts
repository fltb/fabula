/**
 * Host-only owner dashboard surface: precise `/api/v1/admin/*` routes over
 * the configuration change service, credential store, auth, MCP device
 * pairing and project runtime.
 *
 * Every handler re-resolves the session principal from the raw request and
 * enforces `role === 'owner'` before any read or mutation (non-owner = 403,
 * missing/expired session = 401). The actor for every effect is the
 * server-derived principal userId — request bodies never carry userId,
 * capability tokens, Git parameters, filesystem roots (except the one-way
 * project save/validate input) or unknown fields, and any such field is
 * rejected before a side effect. Read DTOs expose only display labels,
 * validation status, configured booleans and masked values; provider API keys
 * are handed once to the credential store and never echoed.
 */

import { randomUUID } from 'node:crypto';
import type { Context, Handler } from 'hono';
import type { BrowserSessionPrincipalV1 } from '../contracts/browser-api.js';
import {
  type AdminDevicePairRequestV1,
  type AdminInviteCreateRequestV1,
  type AdminNetworkUpdateRequestV1,
  type AdminProjectSaveRequestV1,
  type AdminProviderUpdateRequestV1,
  type AdminSetCredentialRequestV1,
  BROWSER_ADMIN_BASE_PATH,
  BROWSER_ADMIN_DEVICES_PATH,
  BROWSER_ADMIN_INVITES_PATH,
  BROWSER_ADMIN_NETWORK_PATH,
  BROWSER_ADMIN_OPERATIONS_PATH,
  BROWSER_ADMIN_OVERVIEW_PATH,
  BROWSER_ADMIN_PROJECTS_PATH,
  BROWSER_ADMIN_PROVIDER_PATH,
  type ConfigOperationReceiptV1,
  WORKBENCH_CONFIGURATION_VERSION,
  type WorkbenchAdminErrorCode,
  type WorkbenchAdminOverviewV1,
  type WorkbenchConfigurationV2,
  type WorkbenchConfigurationV1,
  type WorkbenchDeviceSafeViewV1,
  type WorkbenchInviteSafeViewV1,
  type WorkbenchProjectSafeViewV1,
} from '../contracts/configuration.js';
import { PROJECT_ACCESS_ROLES } from '../contracts/configuration.js';
import type { ProjectAccessRole } from '../contracts/configuration.js';

import type {
  AuditRecord,
  ConfigurationOperationRecord,
  McpDeviceVerifierReadState,
} from '../contracts/persistence.js';
import type { LocalAuthService } from './auth/index.js';
import type { BrowserPrincipalResolver } from './browser-read-api.js';
import type { ConfigurationChangeService } from './configuration-service.js';
import type { HostListenerMode, MutationHttpMethod } from './listener.js';
import type { ProviderCredentialStore } from './providers/credential-store.js';
import { isValidProviderId } from './providers/credential-store.js';
import type { HostListenerEnv, HostServer } from './server.js';
import {
  maskEndpoint,
  maskModel,
  resolveNetworkRequest,
  type SetupStatusBuilder,
} from './setup-api.js';
import type { RuntimeAdminPort } from './workbench-runtime.js';

/** `/api/v1/admin/projects/validate` — one-way project root validation. */
export const BROWSER_ADMIN_PROJECTS_VALIDATE_PATH = `${BROWSER_ADMIN_PROJECTS_PATH}/validate`;
/** `POST /api/v1/admin/projects/:projectId/open` — open a configured project. */
export const BROWSER_ADMIN_PROJECTS_OPEN_PATH = `${BROWSER_ADMIN_PROJECTS_PATH}/:projectId/open`;
/** `POST /api/v1/admin/projects/:projectId/close` — close a configured project. */
export const BROWSER_ADMIN_PROJECTS_CLOSE_PATH = `${BROWSER_ADMIN_PROJECTS_PATH}/:projectId/close`;
/** `POST /api/v1/admin/providers/ai-sdk/test` — provider credential validation. */
export const BROWSER_ADMIN_PROVIDER_TEST_PATH = `${BROWSER_ADMIN_PROVIDER_PATH}/test`;
/** `POST|DELETE /api/v1/admin/providers/ai-sdk/credential` — one-way key write/clear. */
export const BROWSER_ADMIN_PROVIDER_CREDENTIAL_PATH = `${BROWSER_ADMIN_PROVIDER_PATH}/credential`;
/** `DELETE /api/v1/admin/sessions/:sessionId` — revoke one session. */
export const BROWSER_ADMIN_SESSIONS_PATH = `${BROWSER_ADMIN_BASE_PATH}/sessions`;
/** `POST /api/v1/admin/mcp-devices/issue` — issue a one-time pairing code. */
export const BROWSER_ADMIN_DEVICES_ISSUE_PATH = `${BROWSER_ADMIN_DEVICES_PATH}/issue`;
/** `GET /api/v1/admin/memberships` — owner-only project membership list. */
export const BROWSER_ADMIN_MEMBERSHIPS_PATH = `${BROWSER_ADMIN_BASE_PATH}/memberships`;

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

function adminError(code: WorkbenchAdminErrorCode, message: string, status?: number): Response {
  return json({ error: { code, message } }, status ?? ADMIN_ERROR_STATUS[code]);
}

const ADMIN_ERROR_STATUS: Readonly<Record<WorkbenchAdminErrorCode, number>> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  PROJECT_NOT_FOUND: 404,
  PROJECT_BUSY: 409,
  PROJECT_PENDING_RECOVERY: 409,
  INVITE_INVALID: 400,
  DEVICE_NOT_FOUND: 404,
  SESSION_NOT_FOUND: 404,
  CREDENTIAL_INVALID: 400,
  PROVIDER_VALIDATION_FAILED: 400,
  NETWORK_INVALID: 400,
  CONFIG_INVALID: 400,
  CONFIG_STALE: 409,
  UNKNOWN_FIELD: 400,
  INTERNAL: 500,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Strict body parse: reject unknown fields and non-1 versions before any effect. */
function parseRequest(
  body: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> | null {
  if (!isRecord(body) || body.version !== WORKBENCH_CONFIGURATION_VERSION) return null;
  for (const key of Object.keys(body)) {
    if (key !== 'version' && !expectedKeys.includes(key)) return null;
  }
  return body;
}
function isProjectAccessRole(value: unknown): value is ProjectAccessRole {
  return (
    typeof value === 'string' &&
    (PROJECT_ACCESS_ROLES as readonly string[]).includes(value)
  );
}


/** MCP device pairing port; structurally identical to the 1D pairing service. */
export interface McpDeviceAdminPort {
  createPairing(
    input:
      | {
          ownerUserId: string;
          kind: 'project';
          projectId: string;
          role?: ProjectAccessRole;
          ttlMs?: number;
        }
      | {
          ownerUserId: string;
          kind: 'admin';
          projectId?: never;
          role?: never;
          ttlMs?: number;
        },
  ): Promise<{ pairingCode: string; expiresAt: string }>;
  claim(input: {
    pairingCode: string;
    label: string;
    scopes: readonly string[];
    ttlMs: number;
  }): Promise<McpDeviceClaimResult>;
  listDevices(): Promise<McpDeviceVerifierReadState[]>;
  revoke(deviceId: string, revokedAt?: string): Promise<void>;
}

export interface MembershipAdminPort {
  list(input?: { projectId?: string }): Promise<readonly {
    userId: string;
    projectId: string;
    role: ProjectAccessRole;
    capabilityVersion?: number;
  }[]>;
  upsert(input: { userId: string; projectId: string; role: ProjectAccessRole }): Promise<{
    userId: string;
    projectId: string;
    role: ProjectAccessRole;
    capabilityVersion?: number;
  }>;
  revoke(input: { userId: string; projectId: string }): Promise<void>;
}

export type McpDeviceClaimResult =
  | { ok: true; credential: string; label: string; device: McpDeviceVerifierReadState }
  | {
      ok: false;
      code:
        | 'PAIRING_NOT_FOUND'
        | 'PAIRING_EXPIRED'
        | 'PAIRING_USED'
        | 'SCOPE_INVALID'
        | 'INVALID_INPUT';
    };

/** Durable operation/audit reads for the Operations page. */
export interface OperationsAdminPort {
  list(input: { limit: number }): Promise<{
    configuration: ConfigurationOperationRecord[];
    audit: AuditRecord[];
  }>;
}

/** Cancellable provider credential validation; absent = provider not testable. */
export interface ProviderTestPort {
  test(input: {
    baseUrl: string | null;
    model: string | null;
    apiKey: string | null;
  }): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
}

/** Running listener policy, used to derive `restart-required`. */
export interface ListenerPolicyStatus {
  readonly mode: HostListenerMode;
  readonly port: number | null;
}

export interface AdminApiOptions {
  readonly resolver: BrowserPrincipalResolver;
  readonly configuration: ConfigurationChangeService;
  readonly auth: LocalAuthService;
  readonly credentials: ProviderCredentialStore;
  readonly devices: McpDeviceAdminPort;
  /** Owner-only membership administration; absent only for legacy wiring. */
  readonly memberships?: MembershipAdminPort;
  readonly operations: OperationsAdminPort;
  readonly runtime: RuntimeAdminPort;
  readonly status: SetupStatusBuilder;
  readonly loadOwnerProfile: () => Promise<{
    displayName: string;
    capabilityVersion: number;
  } | null>;
  /** Running listener policy for restart-required derivation. */
  readonly listenerStatus: () => ListenerPolicyStatus;
  readonly providerTest?: ProviderTestPort | null;
  /** Directory that resolves `unixSocketName` into an absolute socket path. */
  readonly unixSocketDir?: string;
  readonly workerReady?: boolean;
  readonly now?: () => string;
}

export interface AdminApiSurface {
  register(host: HostServer): void;
}

function deviceSafeView(device: McpDeviceVerifierReadState): WorkbenchDeviceSafeViewV1 {
  return {
    deviceId: device.deviceId,
    scopes: [...device.scopes],
    createdAt: device.createdAt,
    expiresAt: device.expiresAt,
    revokedAt: device.revokedAt ?? null,
  };
}

function inviteSafeView(invite: {
  inviteId: string;
  projectId?: string;
  role: ProjectAccessRole;
  expiresAt: string;
  consumedAt?: string;
}): WorkbenchInviteSafeViewV1 {
  return {
    inviteId: invite.inviteId,
    projectId: invite.projectId ?? null,
    role: invite.role,
    expiresAt: invite.expiresAt,
    consumedAt: invite.consumedAt ?? null,
  };
}

/** Derive whether the running listener already honors the configured policy. */
async function restartRequiredFor(api: AdminApiImpl): Promise<boolean> {
  const active = await api.options.configuration.readActive();
  if (active === null) return false;
  const net = active.configuration.network;
  const listener = api.options.listenerStatus();
  if (net.mode !== listener.mode) return true;
  if (net.mode === 'loopback' && listener.port !== null && net.port !== listener.port) return true;
  if (net.mode === 'lan' && listener.port !== null && net.port !== listener.port) return true;
  return false;
}

class AdminApiImpl {
  constructor(readonly options: AdminApiOptions) {}

  async requireOwner(c: Context<HostListenerEnv>): Promise<Response | BrowserSessionPrincipalV1> {
    const resolution = await this.options.resolver.resolve(c.req.raw);
    if (!resolution.ok) {
      return adminError(
        'UNAUTHORIZED',
        resolution.failure === 'SESSION_EXPIRED'
          ? 'The session has expired.'
          : 'The session is missing, revoked, or unknown.',
      );
    }
    if (resolution.principal.role !== 'owner') {
      return adminError('FORBIDDEN', 'The owner role is required for admin operations.');
    }
    return resolution.principal;
  }

  /** Load the current configuration or return a typed CONFIG_INVALID response. */
  async requireConfiguration(): Promise<
    | { ok: true; active: { configuration: WorkbenchConfigurationV2; revision: string } }
    | { ok: false; response: Response }
  > {
    const active = await this.options.configuration.readActive();
    if (active === null) {
      return {
        ok: false,
        response: adminError('CONFIG_INVALID', 'The Host is not configured yet.', 400),
      };
    }
    return { ok: true, active };
  }
}

// ─── Handlers ────────────────────────────────────────────────────────────────

function overviewHandler(api: AdminApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const owner = await api.requireOwner(c);
    if (owner instanceof Response) return owner;
    const ownerProfile = await api.options.loadOwnerProfile();
    const restartRequired = await restartRequiredFor(api);
    const overview = await api.options.status.overview({
      restartRequired,
      workerReady: api.options.workerReady ?? true,
      ownerProfile,
    });
    return c.json(overview);
  };
}

function projectValidateHandler(api: AdminApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const owner = await api.requireOwner(c);
    if (owner instanceof Response) return owner;
    const body = await c.req.raw.json().catch(() => null);
    const parsed = parseRequest(body, ['projectId', 'displayName', 'root']);
    if (parsed === null) {
      return adminError(
        'UNKNOWN_FIELD',
        'projects/validate accepts only projectId, displayName, root.',
      );
    }
    const projectId = typeof parsed.projectId === 'string' ? parsed.projectId : '';
    const displayName = typeof parsed.displayName === 'string' ? parsed.displayName : '';
    const root = typeof parsed.root === 'string' ? parsed.root : '';
    const config = await api.options.configuration.readActive();
    const candidate: WorkbenchConfigurationV1 = {
      version: 1,
      projects: [...(config?.configuration.projects ?? []), { projectId, displayName, root }],
      defaultProjectId: config?.configuration.defaultProjectId ?? null,
      provider: config?.configuration.provider ?? null,
      network: config?.configuration.network ?? {
        mode: 'loopback',
        port: 8787,
        allowedHosts: [],
        allowedOrigins: [],
        unixSocket: null,
      },
    };
    const result = await api.options.configuration.validateCandidate(candidate);
    if (!result.ok) {
      const first = result.diagnostics[0];
      return json(
        {
          version: WORKBENCH_CONFIGURATION_VERSION,
          projectId,
          validation: 'invalid',
          code: first?.code ?? 'CONFIG_INVALID',
        },
        200,
      );
    }
    return json({ version: WORKBENCH_CONFIGURATION_VERSION, projectId, validation: 'valid' });
  };
}

async function applyProjectChange(
  api: AdminApiImpl,
  mutate: (current: WorkbenchConfigurationV2) => WorkbenchConfigurationV2,
  projectId: string,
  actorId: string,
): Promise<Response> {
  const loaded = await api.requireConfiguration();
  if (!loaded.ok) return loaded.response;
  const candidate = mutate(loaded.active.configuration);
  const exists = candidate.projects.some((project) => project.projectId === projectId);
  if (!exists) {
    return adminError('PROJECT_NOT_FOUND', `Project "${projectId}" is not registered.`);
  }
  const receipt = await api.options.configuration.apply({
    candidate,
    expectedRevision: loaded.active.revision,
    origin: 'dashboard',
    actorId,
  });
  return projectReceiptResponse(api, projectId, receipt);
}

async function projectReceiptResponse(
  api: AdminApiImpl,
  projectId: string,
  receipt: ConfigOperationReceiptV1,
): Promise<Response> {
  if (receipt.status === 'stale') {
    return adminError('CONFIG_STALE', 'The configuration changed; re-read and retry.');
  }
  if (receipt.status === 'invalid') {
    const first = receipt.diagnostics[0];
    const code = (first?.code ?? 'CONFIG_INVALID') as WorkbenchAdminErrorCode;
    return adminError(
      code,
      first?.message ?? 'The configuration change was rejected.',
      ADMIN_ERROR_STATUS[code] ?? 400,
    );
  }
  const setup = await api.options.status.build();
  const view = setup.projects.find((project) => project.projectId === projectId) ?? null;
  return json({ version: WORKBENCH_CONFIGURATION_VERSION, project: view, receipt });
}

function projectCreateHandler(api: AdminApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const owner = await api.requireOwner(c);
    if (owner instanceof Response) return owner;
    const body = await c.req.raw.json().catch(() => null);
    const parsed = parseRequest(body, ['projectId', 'displayName', 'root']);
    if (parsed === null) {
      return adminError('UNKNOWN_FIELD', 'projects accepts only projectId, displayName, root.');
    }
    const projectId = typeof parsed.projectId === 'string' ? parsed.projectId : '';
    const displayName = typeof parsed.displayName === 'string' ? parsed.displayName : '';
    const root = typeof parsed.root === 'string' ? parsed.root : '';
    return applyProjectChange(
      api,
      (current) => {
        if (current.projects.some((project) => project.projectId === projectId)) return current;
        return {
          ...current,
          projects: [...current.projects, { projectId, displayName, root, revisionMirror: { mode: 'disabled' } }],
          defaultProjectId: current.defaultProjectId ?? projectId,
        };
      },
      projectId,
      owner.userId,
    );
  };
}

function projectUpdateHandler(api: AdminApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const owner = await api.requireOwner(c);
    if (owner instanceof Response) return owner;
    const projectId = c.req.param('projectId');
    if (projectId === undefined || projectId.length === 0) {
      return adminError('PROJECT_NOT_FOUND', 'A project id is required.');
    }
    const body = await c.req.raw.json().catch(() => null);
    const parsed = parseRequest(body, ['projectId', 'displayName', 'root']);
    if (parsed === null || parsed.projectId !== projectId) {
      return adminError('PROJECT_NOT_FOUND', `Project "${projectId}" is not registered.`);
    }
    const displayName = typeof parsed.displayName === 'string' ? parsed.displayName : '';
    const root = typeof parsed.root === 'string' ? parsed.root : '';
    return applyProjectChange(
      api,
      (current) => ({
        ...current,
        projects: current.projects.map((project) =>
          project.projectId === projectId ? { ...project, displayName, root } : project,
        ),
      }),
      projectId,
      owner.userId,
    );
  };
}

function projectDeleteHandler(api: AdminApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const owner = await api.requireOwner(c);
    if (owner instanceof Response) return owner;
    const projectId = c.req.param('projectId');
    if (projectId === undefined || projectId.length === 0) {
      return adminError('PROJECT_NOT_FOUND', 'A project id is required.');
    }
    const loaded = await api.requireConfiguration();
    if (!loaded.ok) return loaded.response;
    const configuredProject = loaded.active.configuration.projects.find(
      (project) => project.projectId === projectId,
    );
    if (configuredProject === undefined) {
      return adminError('PROJECT_NOT_FOUND', `Project "${projectId}" is not registered.`);
    }
    let closedRuntime = false;
    try {
      if (api.options.runtime.isOpen(projectId)) {
        closedRuntime = await api.options.runtime.close(projectId);
      }
    } catch (error) {
      if ((error as { code?: string }).code === 'PROJECT_BUSY') {
        return adminError(
          'PROJECT_BUSY',
          `Project "${projectId}" is busy; close it before removal.`,
        );
      }
      throw error;
    }
    const restoreClosedRuntime = async (): Promise<Response | null> => {
      if (!closedRuntime) return null;
      try {
        const active = await api.options.configuration.readActive();
        const projectToRestore = active?.configuration.projects.find(
          (project) => project.projectId === projectId,
        );
        if (projectToRestore !== undefined) await api.options.runtime.open(projectToRestore);
        return null;
      } catch {
        return adminError(
          'PROJECT_PENDING_RECOVERY',
          `Project "${projectId}" could not be restored after the configuration change was rejected.`,
        );
      }
    };
    let receipt: ConfigOperationReceiptV1;
    try {
      receipt = await api.options.configuration.apply({
        candidate: {
          ...loaded.active.configuration,
          projects: loaded.active.configuration.projects.filter(
            (project) => project.projectId !== projectId,
          ),
          defaultProjectId:
            loaded.active.configuration.defaultProjectId === projectId
              ? (loaded.active.configuration.projects.find((p) => p.projectId !== projectId)
                  ?.projectId ?? null)
              : loaded.active.configuration.defaultProjectId,
        },
        expectedRevision: loaded.active.revision,
        origin: 'dashboard',
        actorId: owner.userId,
      });
    } catch {
      const recovery = await restoreClosedRuntime();
      if (recovery !== null) return recovery;
      return adminError(
        'INTERNAL',
        `The configuration change for project "${projectId}" failed; its runtime was restored.`,
      );
    }
    if (receipt.status === 'stale' || receipt.status === 'invalid') {
      const recovery = await restoreClosedRuntime();
      if (recovery !== null) return recovery;
    }
    if (receipt.status === 'stale') {
      return adminError('CONFIG_STALE', 'The configuration changed; re-read and retry.');
    }
    if (receipt.status === 'invalid') {
      const first = receipt.diagnostics[0];
      return adminError(
        (first?.code ?? 'CONFIG_INVALID') as WorkbenchAdminErrorCode,
        first?.message ?? 'The configuration change was rejected.',
      );
    }
    return json({ version: WORKBENCH_CONFIGURATION_VERSION, removed: true, receipt });
  };
}

function projectOpenHandler(api: AdminApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const owner = await api.requireOwner(c);
    if (owner instanceof Response) return owner;
    const projectId = c.req.param('projectId');
    const loaded = await api.requireConfiguration();
    if (!loaded.ok) return loaded.response;
    const project = loaded.active.configuration.projects.find((p) => p.projectId === projectId);
    if (project === undefined) {
      return adminError('PROJECT_NOT_FOUND', `Project "${projectId}" is not registered.`);
    }
    try {
      await api.options.runtime.open(project);
    } catch {
      return adminError('INTERNAL', `Project "${projectId}" could not be opened.`);
    }
    return json({
      version: WORKBENCH_CONFIGURATION_VERSION,
      project: {
        projectId: project.projectId,
        displayName: project.displayName,
        validation: 'valid',
        open: true,
        defaultProject: projectId === loaded.active.configuration.defaultProjectId,
      } satisfies WorkbenchProjectSafeViewV1,
    });
  };
}

function projectCloseHandler(api: AdminApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const owner = await api.requireOwner(c);
    if (owner instanceof Response) return owner;
    const projectId = c.req.param('projectId');
    if (projectId === undefined || projectId.length === 0) {
      return adminError('PROJECT_NOT_FOUND', 'A project id is required.');
    }
    try {
      const closed = await api.options.runtime.close(projectId);
      if (!closed) {
        return adminError('PROJECT_NOT_FOUND', `Project "${projectId}" is not open.`);
      }
    } catch (error) {
      if ((error as { code?: string }).code === 'PROJECT_BUSY') {
        return adminError('PROJECT_BUSY', `Project "${projectId}" is busy and cannot be closed.`);
      }
      throw error;
    }
    return json({ version: WORKBENCH_CONFIGURATION_VERSION, projectId, open: false });
  };
}

function providerUpdateHandler(api: AdminApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const owner = await api.requireOwner(c);
    if (owner instanceof Response) return owner;
    const body = await c.req.raw.json().catch(() => null);
    const parsed = parseRequest(body, ['kind', 'baseUrl', 'model']);
    if (parsed === null || parsed.kind !== 'ai-sdk') {
      return adminError(
        'UNKNOWN_FIELD',
        'providers/ai-sdk accepts only kind "ai-sdk", baseUrl, model.',
      );
    }
    const baseUrl =
      parsed.baseUrl === null || typeof parsed.baseUrl === 'string' ? parsed.baseUrl : null;
    const model = parsed.model === null || typeof parsed.model === 'string' ? parsed.model : null;
    const loaded = await api.requireConfiguration();
    if (!loaded.ok) return loaded.response;
    const receipt = await api.options.configuration.apply({
      candidate: {
        ...loaded.active.configuration,
        provider: { kind: 'ai-sdk', baseUrl, model },
      },
      expectedRevision: loaded.active.revision,
      origin: 'dashboard',
      actorId: owner.userId,
    });
    if (receipt.status === 'stale') {
      return adminError('CONFIG_STALE', 'The configuration changed; re-read and retry.');
    }
    if (receipt.status === 'invalid') {
      const first = receipt.diagnostics[0];
      return adminError(
        (first?.code ?? 'CONFIG_INVALID') as WorkbenchAdminErrorCode,
        first?.message ?? 'The configuration change was rejected.',
      );
    }
    const setup = await api.options.status.build();
    return json({ version: WORKBENCH_CONFIGURATION_VERSION, provider: setup.provider, receipt });
  };
}

function providerTestHandler(api: AdminApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const owner = await api.requireOwner(c);
    if (owner instanceof Response) return owner;
    const test = api.options.providerTest;
    if (test == null) {
      return adminError(
        'PROVIDER_VALIDATION_FAILED',
        'Provider validation is not available on this Host.',
      );
    }
    const loaded = await api.requireConfiguration();
    if (!loaded.ok) return loaded.response;
    const provider = loaded.active.configuration.provider;
    const apiKey = provider === null ? null : await api.options.credentials.get('ai-sdk');
    const result = await test.test({
      baseUrl: provider?.baseUrl ?? null,
      model: provider?.model ?? null,
      apiKey,
    });
    const at = api.options.now?.() ?? new Date().toISOString();
    if (!result.ok) {
      return json(
        {
          version: WORKBENCH_CONFIGURATION_VERSION,
          validation: 'invalid',
          code: result.code,
          lastValidatedAt: at,
        },
        200,
      );
    }
    return json({
      version: WORKBENCH_CONFIGURATION_VERSION,
      validation: 'valid',
      lastValidatedAt: at,
    });
  };
}

function credentialSetHandler(api: AdminApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const owner = await api.requireOwner(c);
    if (owner instanceof Response) return owner;
    const body = await c.req.raw.json().catch(() => null);
    const parsed = parseRequest(body, ['providerId', 'apiKey']);
    if (parsed === null || parsed.providerId !== 'ai-sdk') {
      return adminError(
        'UNKNOWN_FIELD',
        'providers/ai-sdk/credential accepts only providerId "ai-sdk" and apiKey.',
      );
    }
    const apiKey = typeof parsed.apiKey === 'string' ? parsed.apiKey : '';
    if (apiKey.length === 0) {
      return adminError('CREDENTIAL_INVALID', 'A non-empty apiKey is required.');
    }
    try {
      await api.options.credentials.set('ai-sdk', apiKey);
    } catch {
      return adminError('CREDENTIAL_INVALID', 'The credential could not be stored.');
    }
    return json({
      version: WORKBENCH_CONFIGURATION_VERSION,
      providerId: 'ai-sdk',
      configured: true,
    });
  };
}

function credentialClearHandler(api: AdminApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const owner = await api.requireOwner(c);
    if (owner instanceof Response) return owner;
    await api.options.credentials.remove('ai-sdk');
    return json({
      version: WORKBENCH_CONFIGURATION_VERSION,
      providerId: 'ai-sdk',
      configured: false,
    });
  };
}

function networkUpdateHandler(api: AdminApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const owner = await api.requireOwner(c);
    if (owner instanceof Response) return owner;
    const body = await c.req.raw.json().catch(() => null);
    const parsed = parseRequest(body, [
      'mode',
      'port',
      'allowedHosts',
      'allowedOrigins',
      'unixSocketName',
    ]);
    if (parsed === null) {
      return adminError(
        'UNKNOWN_FIELD',
        'network accepts only mode, port, allowedHosts, allowedOrigins, unixSocketName.',
      );
    }
    const resolved = resolveNetworkRequest(parsed, api.options.unixSocketDir);
    if (!resolved.ok) return adminError('NETWORK_INVALID', resolved.message);
    const loaded = await api.requireConfiguration();
    if (!loaded.ok) return loaded.response;
    const receipt = await api.options.configuration.apply({
      candidate: { ...loaded.active.configuration, network: resolved.network },
      expectedRevision: loaded.active.revision,
      origin: 'dashboard',
      actorId: owner.userId,
    });
    if (receipt.status === 'stale') {
      return adminError('CONFIG_STALE', 'The configuration changed; re-read and retry.');
    }
    if (receipt.status === 'invalid') {
      const first = receipt.diagnostics[0];
      return adminError(
        (first?.code ?? 'CONFIG_INVALID') as WorkbenchAdminErrorCode,
        first?.message ?? 'The configuration change was rejected.',
      );
    }
    const setup = await api.options.status.build();
    return json({
      version: WORKBENCH_CONFIGURATION_VERSION,
      network: { ...setup.network, restartRequired: true },
      receipt,
    });
  };
}

function inviteCreateHandler(api: AdminApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const owner = await api.requireOwner(c);
    if (owner instanceof Response) return owner;
    const body = await c.req.raw.json().catch(() => null);
    const parsed = parseRequest(body, ['projectId', 'role', 'ttlMs']);
    if (parsed === null) {
      return adminError('UNKNOWN_FIELD', 'invites accepts only projectId, role, ttlMs.');
    }
    const role = parsed.role;
    if (!isProjectAccessRole(role)) {
      return adminError(
        'INVITE_INVALID',
        'invites require one of the reader, author or maintainer project roles.',
      );
    }
    const ttlMs = parsed.ttlMs;
    if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) {
      return adminError('INVITE_INVALID', 'ttlMs must be a positive number of milliseconds.');
    }
    if (typeof parsed.projectId !== 'string' || parsed.projectId.length === 0) {
      return adminError('INVITE_INVALID', 'projectId is required.');
    }
    const projectId = parsed.projectId;
    const loaded = await api.requireConfiguration();
    if (!loaded.ok) return loaded.response;
    if (!loaded.active.configuration.projects.some((project) => project.projectId === projectId)) {
      return adminError('PROJECT_NOT_FOUND', 'The project is not registered.');
    }
    const invite = await api.options.auth.createInvite({ projectId, role, ttlMs });
    return json({ version: WORKBENCH_CONFIGURATION_VERSION, invite: inviteSafeView(invite) });
  };
}

function sessionDeleteHandler(api: AdminApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const sessionId = c.req.param('sessionId');
    if (sessionId === undefined || sessionId.length === 0) {
      return adminError('SESSION_NOT_FOUND', 'A session id is required.');
    }
    const session = await api.options.auth.getSession(sessionId);
    if (session === null) {
      return adminError('SESSION_NOT_FOUND', 'The session does not exist.');
    }
    await api.options.auth.revokeSession(sessionId, 'revoked by owner');
    return json({ version: WORKBENCH_CONFIGURATION_VERSION, sessionId, revoked: true });
  };
}

function devicesListHandler(api: AdminApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const owner = await api.requireOwner(c);
    if (owner instanceof Response) return owner;
    const devices = await api.options.devices.listDevices();
    return json({
      version: WORKBENCH_CONFIGURATION_VERSION,
      devices: devices.map(deviceSafeView),
    });
  };
}

function devicesIssueHandler(api: AdminApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const owner = await api.requireOwner(c);
    if (owner instanceof Response) return owner;
    const body = await c.req.raw.json().catch(() => null);
    const parsed = parseRequest(body, ['kind', 'projectId', 'role', 'ttlMs']);
    if (parsed === null) {
      return adminError('UNKNOWN_FIELD', 'device issue accepts only kind, projectId, role, ttlMs.');
    }
    const kind = parsed.kind;
    const projectId = typeof parsed.projectId === 'string' ? parsed.projectId : undefined;
    const role = isProjectAccessRole(parsed.role) ? parsed.role : undefined;
    if (kind !== 'project' && kind !== 'admin') {
      return adminError('CREDENTIAL_INVALID', 'kind must be project or admin.');
    }
    if (
      (kind === 'project' && (typeof projectId !== 'string' || projectId.length === 0)) ||
      (kind === 'project' && parsed.role !== undefined && role === undefined) ||
      (kind === 'admin' && (projectId !== undefined || parsed.role !== undefined))
    ) {
      return adminError('CREDENTIAL_INVALID', 'The device binding is invalid.');
    }
    if (kind === 'project') {
      const loaded = await api.requireConfiguration();
      if (!loaded.ok) return loaded.response;
      if (!loaded.active.configuration.projects.some((project) => project.projectId === projectId)) {
        return adminError('PROJECT_NOT_FOUND', 'The project is not registered.');
      }
    }
    const ttlMs = parsed.ttlMs;
    if (
      ttlMs !== undefined &&
      (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0)
    ) {
      return adminError('CREDENTIAL_INVALID', 'ttlMs must be a positive number of milliseconds.');
    }
    const pairing =
      kind === 'project'
        ? await api.options.devices.createPairing({
            ownerUserId: owner.userId,
            kind: 'project',
            projectId: projectId as string,
            ...(role === undefined ? {} : { role }),
            ...(typeof ttlMs === 'number' ? { ttlMs } : {}),
          })
        : await api.options.devices.createPairing({
            ownerUserId: owner.userId,
            kind: 'admin',
            ...(typeof ttlMs === 'number' ? { ttlMs } : {}),
          });
    return json({
      version: WORKBENCH_CONFIGURATION_VERSION,
      pairingCode: pairing.pairingCode,
      expiresAt: pairing.expiresAt,
    });
  };
}

function devicesClaimHandler(api: AdminApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const owner = await api.requireOwner(c);
    if (owner instanceof Response) return owner;
    const body = await c.req.raw.json().catch(() => null);
    const parsed = parseRequest(body, ['pairingCode', 'label', 'scopes', 'ttlMs']);
    if (parsed === null) {
      return adminError(
        'UNKNOWN_FIELD',
        'mcp-devices accepts only pairingCode, label, scopes, ttlMs.',
      );
    }
    const pairingCode = typeof parsed.pairingCode === 'string' ? parsed.pairingCode : '';
    const label = typeof parsed.label === 'string' ? parsed.label : '';
    const scopes = parsed.scopes;
    const ttlMs = parsed.ttlMs;
    if (
      pairingCode.length === 0 ||
      label.length === 0 ||
      !Array.isArray(scopes) ||
      scopes.some((entry) => typeof entry !== 'string') ||
      typeof ttlMs !== 'number' ||
      !Number.isFinite(ttlMs) ||
      ttlMs <= 0
    ) {
      return adminError('CREDENTIAL_INVALID', 'pairingCode, label, scopes and ttlMs are required.');
    }
    const result = await api.options.devices.claim({
      pairingCode,
      label,
      scopes: scopes as string[],
      ttlMs,
    });
    if (!result.ok) {
      if (result.code === 'SCOPE_INVALID' || result.code === 'INVALID_INPUT') {
        return adminError('CREDENTIAL_INVALID', 'The device request is invalid.');
      }
      return adminError(
        'DEVICE_NOT_FOUND',
        'The pairing code is unknown, expired or already used.',
      );
    }
    // The opaque device credential is returned exactly once; no later read DTO carries it.
    return json({
      version: WORKBENCH_CONFIGURATION_VERSION,
      credential: result.credential,
      label: result.label,
      device: deviceSafeView(result.device),
    });
  };
}

function devicesRevokeHandler(api: AdminApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const owner = await api.requireOwner(c);
    if (owner instanceof Response) return owner;
    const deviceId = c.req.param('deviceId');
    if (deviceId === undefined || deviceId.length === 0) {
      return adminError('DEVICE_NOT_FOUND', 'A device id is required.');
    }
    const devices = await api.options.devices.listDevices();
    const device = devices.find((entry) => entry.deviceId === deviceId);
    if (device === undefined) {
      return adminError('DEVICE_NOT_FOUND', 'The device does not exist.');
    }
    await api.options.devices.revoke(deviceId, api.options.now?.() ?? new Date().toISOString());
    return json({ version: WORKBENCH_CONFIGURATION_VERSION, deviceId, revoked: true });
  };
}

function membershipsListHandler(api: AdminApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const owner = await api.requireOwner(c);
    if (owner instanceof Response) return owner;
    const memberships = api.options.memberships;
    if (memberships === undefined) return adminError('INTERNAL', 'Membership service unavailable.');
    const projectId = c.req.query('projectId');
    const listed = await memberships.list(projectId === undefined ? undefined : { projectId });
    return json({ version: WORKBENCH_CONFIGURATION_VERSION, memberships: listed });
  };
}

function membershipUpsertHandler(api: AdminApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const owner = await api.requireOwner(c);
    if (owner instanceof Response) return owner;
    const memberships = api.options.memberships;
    if (memberships === undefined) return adminError('INTERNAL', 'Membership service unavailable.');
    const body = await c.req.raw.json().catch(() => null);
    const parsed = parseRequest(body, ['userId', 'projectId', 'role']);
    const role = parsed?.role;
    if (
      parsed === null ||
      typeof parsed.userId !== 'string' ||
      parsed.userId.length === 0 ||
      typeof parsed.projectId !== 'string' ||
      parsed.projectId.length === 0 ||
      !isProjectAccessRole(role)
    ) {
      return adminError('INVITE_INVALID', 'userId, projectId and role are required.');
    }
    try {
      const membership = await memberships.upsert({
        userId: parsed.userId,
        projectId: parsed.projectId,
        role,
      });
      return json({ version: WORKBENCH_CONFIGURATION_VERSION, membership });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'PROJECT_NOT_FOUND') {
        return adminError('PROJECT_NOT_FOUND', 'The project is not registered.');
      }
      if (code === 'USER_NOT_FOUND' || code === 'INVALID_INPUT') {
        return adminError('INVITE_INVALID', 'The membership identity or role is invalid.');
      }
      throw error;
    }
  };
}

function membershipRevokeHandler(api: AdminApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const owner = await api.requireOwner(c);
    if (owner instanceof Response) return owner;
    const memberships = api.options.memberships;
    if (memberships === undefined) return adminError('INTERNAL', 'Membership service unavailable.');
    const body = await c.req.raw.json().catch(() => null);
    const parsed = parseRequest(body, ['userId', 'projectId']);
    if (
      parsed === null ||
      typeof parsed.userId !== 'string' ||
      parsed.userId.length === 0 ||
      typeof parsed.projectId !== 'string' ||
      parsed.projectId.length === 0
    ) {
      return adminError('INVITE_INVALID', 'userId and projectId are required.');
    }
    try {
      await memberships.revoke({ userId: parsed.userId, projectId: parsed.projectId });
      return json({
        version: WORKBENCH_CONFIGURATION_VERSION,
        userId: parsed.userId,
        projectId: parsed.projectId,
        revoked: true,
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'PROJECT_NOT_FOUND') {
        return adminError('PROJECT_NOT_FOUND', 'The project is not registered.');
      }
      if (code === 'USER_NOT_FOUND' || code === 'INVALID_INPUT') {
        return adminError('INVITE_INVALID', 'The membership identity is invalid.');
      }
      throw error;
    }
  };
}

function operationsHandler(api: AdminApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const owner = await api.requireOwner(c);
    if (owner instanceof Response) return owner;
    const listed = await api.options.operations.list({ limit: 50 });
    return c.json({
      version: WORKBENCH_CONFIGURATION_VERSION,
      configurationOperations: listed.configuration,
      audit: listed.audit,
      generatedAt: api.options.now?.() ?? new Date().toISOString(),
    });
  };
}

// ─── Surface ─────────────────────────────────────────────────────────────────

/**
 * Create the owner dashboard surface. `register` mounts the overview and
 * operations reads through the guarded read seam and every mutation through
 * the guarded mutation seam (Host/Origin allowlist) — all before start, so an
 * unconfigured Host never exposes a half-wired admin surface.
 */
export function createAdminApi(options: AdminApiOptions): AdminApiSurface {
  const api = new AdminApiImpl(options);
  const reads: readonly { readonly path: string; readonly handler: Handler<HostListenerEnv> }[] = [
    { path: BROWSER_ADMIN_OVERVIEW_PATH, handler: overviewHandler(api) },
    { path: BROWSER_ADMIN_OPERATIONS_PATH, handler: operationsHandler(api) },
    { path: BROWSER_ADMIN_DEVICES_PATH, handler: devicesListHandler(api) },
    { path: BROWSER_ADMIN_MEMBERSHIPS_PATH, handler: membershipsListHandler(api) },
  ];
  const mutations: readonly {
    readonly method: MutationHttpMethod;
    readonly path: string;
    readonly handler: Handler<HostListenerEnv>;
  }[] = [
    {
      method: 'POST',
      path: BROWSER_ADMIN_PROJECTS_VALIDATE_PATH,
      handler: projectValidateHandler(api),
    },
    { method: 'POST', path: BROWSER_ADMIN_PROJECTS_PATH, handler: projectCreateHandler(api) },
    {
      method: 'PUT',
      path: `${BROWSER_ADMIN_PROJECTS_PATH}/:projectId`,
      handler: projectUpdateHandler(api),
    },
    {
      method: 'DELETE',
      path: `${BROWSER_ADMIN_PROJECTS_PATH}/:projectId`,
      handler: projectDeleteHandler(api),
    },
    { method: 'POST', path: BROWSER_ADMIN_PROJECTS_OPEN_PATH, handler: projectOpenHandler(api) },
    { method: 'POST', path: BROWSER_ADMIN_PROJECTS_CLOSE_PATH, handler: projectCloseHandler(api) },
    { method: 'PUT', path: BROWSER_ADMIN_PROVIDER_PATH, handler: providerUpdateHandler(api) },
    { method: 'POST', path: BROWSER_ADMIN_PROVIDER_TEST_PATH, handler: providerTestHandler(api) },
    {
      method: 'POST',
      path: BROWSER_ADMIN_PROVIDER_CREDENTIAL_PATH,
      handler: credentialSetHandler(api),
    },
    {
      method: 'DELETE',
      path: BROWSER_ADMIN_PROVIDER_CREDENTIAL_PATH,
      handler: credentialClearHandler(api),
    },
    { method: 'POST', path: BROWSER_ADMIN_INVITES_PATH, handler: inviteCreateHandler(api) },
    { method: 'PUT', path: BROWSER_ADMIN_MEMBERSHIPS_PATH, handler: membershipUpsertHandler(api) },
    { method: 'DELETE', path: BROWSER_ADMIN_MEMBERSHIPS_PATH, handler: membershipRevokeHandler(api) },
    {
      method: 'DELETE',
      path: `${BROWSER_ADMIN_SESSIONS_PATH}/:sessionId`,
      handler: sessionDeleteHandler(api),
    },
    { method: 'POST', path: BROWSER_ADMIN_DEVICES_ISSUE_PATH, handler: devicesIssueHandler(api) },
    { method: 'POST', path: BROWSER_ADMIN_DEVICES_PATH, handler: devicesClaimHandler(api) },
    {
      method: 'DELETE',
      path: `${BROWSER_ADMIN_DEVICES_PATH}/:deviceId`,
      handler: devicesRevokeHandler(api),
    },
    { method: 'PUT', path: BROWSER_ADMIN_NETWORK_PATH, handler: networkUpdateHandler(api) },
  ];

  return {
    register(host: HostServer): void {
      for (const route of reads) host.registerReadRoute(route.path, route.handler);
      for (const route of mutations)
        host.registerMutationRoute(route.method, route.path, route.handler);
    },
  };
}

export type {
  AdminDevicePairRequestV1,
  AdminInviteCreateRequestV1,
  AdminNetworkUpdateRequestV1,
  AdminProjectSaveRequestV1,
  AdminProviderUpdateRequestV1,
  AdminSetCredentialRequestV1,
  WorkbenchAdminOverviewV1,
};
