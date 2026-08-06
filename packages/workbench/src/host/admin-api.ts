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

import type { Context, Handler } from 'hono';
import type { BrowserSessionPrincipalV1 } from '../contracts/browser-api.js';
import type { ProjectAccessRole } from '../contracts/configuration.js';
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
  BROWSER_ADMIN_PLUGINS_DISCOVERED_PATH,
  BROWSER_ADMIN_PROJECTS_PATH,
  BROWSER_ADMIN_PROVIDER_PATH,
  type ConfigOperationDiagnosticV1,
  type ConfigOperationReceiptV1,
  normalizeWorkbenchConfiguration,
  PROJECT_ACCESS_ROLES,
  WORKBENCH_CONFIGURATION_VERSION,
  type WorkbenchAdminErrorCode,
  type WorkbenchAdminOverviewV1,
  type WorkbenchConfigurationInput,
  type WorkbenchConfigurationV3,
  type WorkbenchConfigurationVersion,
  type WorkbenchDeviceSafeViewV1,
  type WorkbenchInviteSafeViewV1,
  type WorkbenchProjectSafeViewV1,
  type WorkbenchProjectValidationV1,
  type WorkbenchTrustedPluginConfigurationV3,
} from '../contracts/configuration.js';
import type {
  AuditRecord,
  ConfigurationOperationRecord,
  McpDeviceVerifierReadState,
} from '../contracts/persistence.js';
import type { LocalAuthService } from './auth/index.js';
import type { BrowserPrincipalResolver } from './browser-read-api.js';
import type { ConfigurationChangeService } from './configuration-service.js';
import { computeChangedFields, requiresRestart } from './configuration-service.js';
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
/** `GET|PUT|DELETE /api/v1/admin/providers` — V3 provider profile management base. */
export const BROWSER_ADMIN_PROVIDERS_PATH = `${BROWSER_ADMIN_BASE_PATH}/providers`;
/** `GET|PUT /api/v1/admin/config/advanced` — V3 config domains (profiles/bindings/limits/plugins/agent). */
export const BROWSER_ADMIN_CONFIG_ADVANCED_PATH = `${BROWSER_ADMIN_BASE_PATH}/config/advanced`;
/** `POST /api/v1/admin/config/preview` — validate a V3-domain patch without applying it. */
export const BROWSER_ADMIN_CONFIG_PREVIEW_PATH = `${BROWSER_ADMIN_BASE_PATH}/config/preview`;

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
  PLUGIN_NOT_DISCOVERED: 400,
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
  return typeof value === 'string' && (PROJECT_ACCESS_ROLES as readonly string[]).includes(value);
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
  list(input?: { projectId?: string }): Promise<
    readonly {
      userId: string;
      projectId: string;
      role: ProjectAccessRole;
      capabilityVersion?: number;
    }[]
  >;
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

/**
 * Browser-safe identity of one plugin the Host discovered on disk. Mirrors
 * the node-host `DiscoveredNodePlugin` shape: name/version/hashes/hook names
 * only — never a filesystem path, module code, or remote source.
 */
export interface DiscoveredPluginAdminViewV1 {
  readonly name: string;
  readonly version: string;
  readonly manifestHash: string;
  /** SHA-256 of the plugin `index.js`, or null when the module file is missing. */
  readonly moduleHash: string | null;
  readonly hookNames: readonly string[];
}

/**
 * Host-side plugin discovery port. The owner admin surface reads the
 * discovered set through this seam; only discovered triples (name/version/
 * moduleHash) may ever enter a trustedPlugin allowlist. The port throws a
 * `Project "<id>" is not registered.` error for unknown projects.
 */
export interface PluginDiscoveryAdminPort {
  discover(input: { readonly projectId: string }): Promise<readonly DiscoveredPluginAdminViewV1[]>;
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
  /**
   * Host-discovered plugin identities per project. When present, every
   * applied trustedPlugin entry must exactly match a discovered plugin;
   * absent (legacy wiring) skips that check. The owner UI reads discovery
   * through this port only — no upload, URL, or arbitrary module path.
   */
  readonly plugins?: PluginDiscoveryAdminPort | null;
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

// ─── V3 configuration domains (browser-safe views and mutation requests) ────

/** Masked provider profile read view; credentials never exist in this DTO. */
export interface WorkbenchProviderProfileReadViewV1 {
  readonly profileId: string;
  readonly kind: 'ai-sdk';
  /** True when the Host credential store holds a key for `ai-sdk:<profileId>`. */
  readonly configured: boolean;
  /** Masked endpoint, or null when unset. */
  readonly endpoint: string | null;
  /** Masked model, or null when unset. */
  readonly model: string | null;
  readonly lastValidation: WorkbenchProjectValidationV1;
  readonly lastValidatedAt: string | null;
}

/** One trusted plugin allowlist entry as the browser may see it (hash, never code). */
export interface WorkbenchTrustedPluginReadViewV1 {
  readonly name: string;
  readonly version: string;
  readonly moduleHash: string;
  readonly required: boolean;
}

/** Per-project V3 binding view: provider profile + trusted plugin allowlist. */
export interface WorkbenchProjectProfileBindingReadViewV1 {
  readonly projectId: string;
  readonly displayName: string;
  readonly providerProfile: string;
  readonly trustedPlugins: readonly WorkbenchTrustedPluginReadViewV1[];
}

/** Browser-safe operation limits read view (`maxConcurrentRendersPerProject` is fixed at 1). */
export interface WorkbenchOperationLimitsReadViewV1 {
  readonly maxQueuedPerProject: number;
  readonly maxConcurrentRendersPerProject: 1;
  readonly maxConcurrentRendersPerHost: number;
}

/** Browser-safe agent settings read view. */
export interface WorkbenchAgentSettingsReadViewV1 {
  readonly enabled: boolean;
  readonly maxTurns: number;
  readonly maxToolCalls: number;
}

/** Aggregate browser-safe read view of every V3 configuration domain. */
export interface WorkbenchAdvancedConfigReadViewV1 {
  readonly version: WorkbenchConfigurationVersion;
  readonly providers: readonly WorkbenchProviderProfileReadViewV1[];
  readonly projects: readonly WorkbenchProjectProfileBindingReadViewV1[];
  readonly operationLimits: WorkbenchOperationLimitsReadViewV1;
  readonly agent: WorkbenchAgentSettingsReadViewV1;
  readonly generatedAt: string;
}

/** Non-applying validation result for a V3-domain patch (preview). */
export interface WorkbenchAdvancedConfigPreviewViewV1 {
  readonly version: WorkbenchConfigurationVersion;
  readonly valid: boolean;
  readonly diagnostics: readonly ConfigOperationDiagnosticV1[];
  readonly changedFields: readonly string[];
  readonly restartRequired: boolean;
  readonly candidateRevision: string | null;
}

/**
 * Browser-safe V3-domain mutation request. Any subset of the domains may be
 * present; omitted domains are left unchanged by the single CAS apply.
 */
export interface AdminAdvancedConfigRequestV1 {
  readonly version: WorkbenchConfigurationVersion;
  readonly operationLimits?: {
    readonly maxQueuedPerProject: number;
    readonly maxConcurrentRendersPerHost: number;
  };
  readonly agent?: {
    readonly enabled: boolean;
    readonly maxTurns: number;
    readonly maxToolCalls: number;
  };
  readonly projects?: readonly {
    readonly projectId: string;
    readonly providerProfile?: string;
    readonly trustedPlugins?: readonly WorkbenchTrustedPluginReadViewV1[];
  }[];
}

/** Provider profile endpoint/model upsert from the dashboard. Never carries an API key. */
export interface AdminProviderProfileUpdateRequestV1 {
  readonly version: WorkbenchConfigurationVersion;
  readonly kind: 'ai-sdk';
  readonly baseUrl: string | null;
  readonly model: string | null;
}

/** One-way provider profile credential write; the secret never leaves the Host. */
export interface AdminProviderProfileCredentialRequestV1 {
  readonly version: WorkbenchConfigurationVersion;
  readonly apiKey: string;
}

/** Parsed V3-domain patch after strict request validation. */
interface AdvancedConfigProjectPatch {
  readonly projectId: string;
  readonly providerProfile?: string;
  readonly trustedPlugins?: readonly WorkbenchTrustedPluginConfigurationV3[];
}

interface AdvancedConfigPatch {
  readonly operationLimits?: {
    readonly maxQueuedPerProject: number;
    readonly maxConcurrentRendersPerHost: number;
  };
  readonly agent?: {
    readonly enabled: boolean;
    readonly maxTurns: number;
    readonly maxToolCalls: number;
  };
  readonly projects?: readonly AdvancedConfigProjectPatch[];
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPluginEntry(value: unknown): value is WorkbenchTrustedPluginConfigurationV3 {
  if (!isRecord(value)) return false;
  const { name, version, moduleHash, required } = value;
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    typeof version === 'string' &&
    version.length > 0 &&
    typeof moduleHash === 'string' &&
    moduleHash.length > 0 &&
    typeof required === 'boolean'
  );
}

/** Strict inner parsing of the V3-domain patch; null on any malformed field. */
function parseAdvancedConfigPatch(body: Record<string, unknown>): AdvancedConfigPatch | null {
  let operationLimits: AdvancedConfigPatch['operationLimits'] | undefined;
  if (body.operationLimits !== undefined) {
    if (!isRecord(body.operationLimits)) return null;
    const { maxQueuedPerProject, maxConcurrentRendersPerHost } = body.operationLimits;
    if (
      !isNonNegativeInteger(maxQueuedPerProject) ||
      !isNonNegativeInteger(maxConcurrentRendersPerHost)
    ) {
      return null;
    }
    operationLimits = { maxQueuedPerProject, maxConcurrentRendersPerHost };
  }
  let agent: AdvancedConfigPatch['agent'] | undefined;
  if (body.agent !== undefined) {
    if (!isRecord(body.agent)) return null;
    const { enabled, maxTurns, maxToolCalls } = body.agent;
    if (
      typeof enabled !== 'boolean' ||
      !isNonNegativeInteger(maxTurns) ||
      !isNonNegativeInteger(maxToolCalls)
    ) {
      return null;
    }
    agent = { enabled, maxTurns, maxToolCalls };
  }
  let projects: AdvancedConfigPatch['projects'] | undefined;
  if (body.projects !== undefined) {
    if (!Array.isArray(body.projects)) return null;
    const entries: AdvancedConfigProjectPatch[] = [];
    for (const entry of body.projects) {
      if (!isRecord(entry)) return null;
      const { projectId, providerProfile, trustedPlugins } = entry;
      if (typeof projectId !== 'string' || projectId.length === 0) return null;
      if (
        providerProfile !== undefined &&
        (typeof providerProfile !== 'string' || providerProfile.length === 0)
      ) {
        return null;
      }
      let plugins: WorkbenchTrustedPluginConfigurationV3[] | undefined;
      if (trustedPlugins !== undefined) {
        if (!Array.isArray(trustedPlugins) || trustedPlugins.some((item) => !isPluginEntry(item))) {
          return null;
        }
        plugins = trustedPlugins.map((item) => ({ ...item }));
      }
      entries.push({
        projectId,
        ...(providerProfile === undefined ? {} : { providerProfile }),
        ...(plugins === undefined ? {} : { trustedPlugins: plugins }),
      });
    }
    projects = entries;
  }
  return {
    ...(operationLimits === undefined ? {} : { operationLimits }),
    ...(agent === undefined ? {} : { agent }),
    ...(projects === undefined ? {} : { projects }),
  };
}

/** Apply a strict V3-domain patch onto the canonical configuration (pure). */
function buildAdvancedCandidate(
  current: WorkbenchConfigurationV3,
  patch: AdvancedConfigPatch,
): WorkbenchConfigurationV3 {
  let next = current;
  if (patch.operationLimits !== undefined) {
    next = {
      ...next,
      operationLimits: {
        maxQueuedPerProject: patch.operationLimits.maxQueuedPerProject,
        maxConcurrentRendersPerProject: 1,
        maxConcurrentRendersPerHost: patch.operationLimits.maxConcurrentRendersPerHost,
      },
    };
  }
  if (patch.agent !== undefined) {
    next = {
      ...next,
      agent: {
        enabled: patch.agent.enabled,
        maxTurns: patch.agent.maxTurns,
        maxToolCalls: patch.agent.maxToolCalls,
      },
    };
  }
  if (patch.projects !== undefined) {
    const patchById = new Map(patch.projects.map((entry) => [entry.projectId, entry]));
    next = {
      ...next,
      projects: next.projects.map((project) => {
        const entry = patchById.get(project.projectId);
        if (entry === undefined) return project;
        return {
          ...project,
          ...(entry.providerProfile === undefined
            ? {}
            : { providerProfile: entry.providerProfile }),
          ...(entry.trustedPlugins === undefined
            ? {}
            : { trustedPlugins: [...entry.trustedPlugins] }),
        };
      }),
    };
  }
  return next;
}

/**
 * Reject any trustedPlugin entry that does not exactly match a
 * Host-discovered plugin (name/version/moduleHash). Returns the first
 * offending entry, or null when the patch is clean. Skipped entirely when no
 * discovery port is wired. Entries for projects that are not in the active
 * configuration are not checked here: the candidate builder drops them and
 * the apply path rejects unknown projects with PROJECT_NOT_FOUND.
 */
async function firstUndiscoveredPlugin(
  api: AdminApiImpl,
  patch: AdvancedConfigPatch,
  configuration: WorkbenchConfigurationV3,
): Promise<WorkbenchTrustedPluginConfigurationV3 | null> {
  const discovery = api.options.plugins;
  if (discovery == null) return null;
  for (const entry of patch.projects ?? []) {
    if (entry.trustedPlugins === undefined) continue;
    if (!configuration.projects.some((project) => project.projectId === entry.projectId)) continue;
    const discovered = await discovery.discover({ projectId: entry.projectId });
    for (const plugin of entry.trustedPlugins) {
      const match = discovered.some(
        (candidate) =>
          candidate.moduleHash !== null &&
          candidate.name === plugin.name &&
          candidate.version === plugin.version &&
          candidate.moduleHash === plugin.moduleHash,
      );
      if (!match) return plugin;
    }
  }
  return null;
}

/** Build the masked read view of one provider profile. */
async function providerProfileView(
  api: AdminApiImpl,
  profileId: string,
  profile: {
    readonly kind: 'ai-sdk';
    readonly baseUrl: string | null;
    readonly model: string | null;
  },
): Promise<WorkbenchProviderProfileReadViewV1> {
  const configured = (await api.options.credentials.get(`ai-sdk:${profileId}`)) !== null;
  return {
    profileId,
    kind: profile.kind,
    configured,
    endpoint: maskEndpoint(profile.baseUrl),
    model: maskModel(profile.model),
    lastValidation: configured ? 'valid' : 'unvalidated',
    lastValidatedAt: null,
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
    | { ok: true; active: { configuration: WorkbenchConfigurationV3; revision: string } }
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
    const base = config === null ? null : normalizeWorkbenchConfiguration(config.configuration);
    const candidate: WorkbenchConfigurationInput =
      base === null
        ? {
            version: 1,
            projects: [{ projectId, displayName, root }],
            defaultProjectId: projectId,
            provider: null,
            network: {
              mode: 'loopback',
              port: 8787,
              allowedHosts: [],
              allowedOrigins: [],
              unixSocket: null,
            },
          }
        : {
            ...base,
            projects: [
              ...base.projects,
              {
                projectId,
                displayName,
                root,
                revisionMirror: { mode: 'disabled' } as const,
                providerProfile: 'default',
                trustedPlugins: [],
              },
            ],
            defaultProjectId: base.defaultProjectId ?? projectId,
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
  mutate: (current: WorkbenchConfigurationV3) => WorkbenchConfigurationV3,
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
          projects: [
            ...current.projects,
            {
              projectId,
              displayName,
              root,
              revisionMirror: { mode: 'disabled' },
              providerProfile: 'default',
              trustedPlugins: [],
            },
          ],
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
        'CONFIG_INVALID',
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
    const normalized = normalizeWorkbenchConfiguration(loaded.active.configuration);
    const receipt = await api.options.configuration.apply({
      candidate: {
        ...normalized,
        providers: {
          ...normalized.providers,
          default: { kind: 'ai-sdk' as const, baseUrl, model },
        },
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
    const normalized = normalizeWorkbenchConfiguration(loaded.active.configuration);
    const provider = normalized.providers.default ?? null;
    const apiKey = provider === null ? null : await api.options.credentials.get('ai-sdk:default');
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
      await api.options.credentials.set('ai-sdk:default', apiKey);
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
    await api.options.credentials.remove('ai-sdk:default');
    return json({
      version: WORKBENCH_CONFIGURATION_VERSION,
      providerId: 'ai-sdk',
      configured: false,
    });
  };
}

function pluginsDiscoveredHandler(api: AdminApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const owner = await api.requireOwner(c);
    if (owner instanceof Response) return owner;
    const projectId = c.req.param('projectId');
    if (projectId === undefined || projectId.length === 0) {
      return adminError('PROJECT_NOT_FOUND', 'A project id is required.');
    }
    const discovery = api.options.plugins;
    if (discovery == null) {
      return adminError('PROJECT_NOT_FOUND', 'Plugin discovery is not available on this Host.');
    }
    let plugins: readonly DiscoveredPluginAdminViewV1[];
    try {
      plugins = await discovery.discover({ projectId });
    } catch (error) {
      if (error instanceof Error && error.message === `Project "${projectId}" is not registered.`) {
        return adminError('PROJECT_NOT_FOUND', `Project "${projectId}" is not registered.`);
      }
      return adminError('INTERNAL', `Plugin discovery failed for project "${projectId}".`);
    }
    return json({ version: WORKBENCH_CONFIGURATION_VERSION, projectId, plugins });
  };
}

function advancedConfigReadHandler(api: AdminApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const owner = await api.requireOwner(c);
    if (owner instanceof Response) return owner;
    const loaded = await api.requireConfiguration();
    if (!loaded.ok) return loaded.response;
    const normalized = normalizeWorkbenchConfiguration(loaded.active.configuration);
    const providers: WorkbenchProviderProfileReadViewV1[] = [];
    for (const [profileId, profile] of Object.entries(normalized.providers)) {
      providers.push(await providerProfileView(api, profileId, profile));
    }
    const projects: WorkbenchProjectProfileBindingReadViewV1[] = normalized.projects.map(
      (project) => ({
        projectId: project.projectId,
        displayName: project.displayName,
        providerProfile: project.providerProfile,
        trustedPlugins: project.trustedPlugins.map((plugin) => ({
          name: plugin.name,
          version: plugin.version,
          moduleHash: plugin.moduleHash,
          required: plugin.required,
        })),
      }),
    );
    const view: WorkbenchAdvancedConfigReadViewV1 = {
      version: WORKBENCH_CONFIGURATION_VERSION,
      providers,
      projects,
      operationLimits: { ...normalized.operationLimits },
      agent: { ...normalized.agent },
      generatedAt: api.options.now?.() ?? new Date().toISOString(),
    };
    return c.json(view);
  };
}

function advancedConfigPreviewHandler(api: AdminApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const owner = await api.requireOwner(c);
    if (owner instanceof Response) return owner;
    const body = await c.req.raw.json().catch(() => null);
    const parsed = parseRequest(body, ['operationLimits', 'agent', 'projects']);
    const patch = parsed === null ? null : parseAdvancedConfigPatch(parsed);
    if (patch === null) {
      return adminError(
        'UNKNOWN_FIELD',
        'config/preview accepts only operationLimits, agent, projects.',
      );
    }
    const loaded = await api.requireConfiguration();
    if (!loaded.ok) return loaded.response;
    const normalized = normalizeWorkbenchConfiguration(loaded.active.configuration);
    const undiscovered = await firstUndiscoveredPlugin(api, patch, normalized);
    if (undiscovered !== null) {
      return adminError(
        'PLUGIN_NOT_DISCOVERED',
        `Plugin "${undiscovered.name}@${undiscovered.version}" is not discovered on this Host; only Host-discovered plugins can be trusted.`,
      );
    }
    const candidate = buildAdvancedCandidate(normalized, patch);
    const validated = await api.options.configuration.validateCandidate(candidate);
    if (!validated.ok) {
      return json({
        version: WORKBENCH_CONFIGURATION_VERSION,
        valid: false,
        diagnostics: validated.diagnostics,
        changedFields: [],
        restartRequired: false,
        candidateRevision: null,
      } satisfies WorkbenchAdvancedConfigPreviewViewV1);
    }
    const changedFields = computeChangedFields(normalized, candidate);
    return json({
      version: WORKBENCH_CONFIGURATION_VERSION,
      valid: true,
      diagnostics: [],
      changedFields,
      restartRequired: requiresRestart(changedFields),
      candidateRevision: validated.revision,
    } satisfies WorkbenchAdvancedConfigPreviewViewV1);
  };
}

function advancedConfigApplyHandler(api: AdminApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const owner = await api.requireOwner(c);
    if (owner instanceof Response) return owner;
    const body = await c.req.raw.json().catch(() => null);
    const parsed = parseRequest(body, ['operationLimits', 'agent', 'projects']);
    const patch = parsed === null ? null : parseAdvancedConfigPatch(parsed);
    if (patch === null) {
      return adminError(
        'UNKNOWN_FIELD',
        'config/advanced accepts only operationLimits, agent, projects.',
      );
    }
    const loaded = await api.requireConfiguration();
    if (!loaded.ok) return loaded.response;
    const normalized = normalizeWorkbenchConfiguration(loaded.active.configuration);
    for (const entry of patch.projects ?? []) {
      if (!normalized.projects.some((project) => project.projectId === entry.projectId)) {
        return adminError('PROJECT_NOT_FOUND', `Project "${entry.projectId}" is not registered.`);
      }
    }
    const undiscovered = await firstUndiscoveredPlugin(api, patch, normalized);
    if (undiscovered !== null) {
      return adminError(
        'PLUGIN_NOT_DISCOVERED',
        `Plugin "${undiscovered.name}@${undiscovered.version}" is not discovered on this Host; only Host-discovered plugins can be trusted.`,
      );
    }
    const candidate = buildAdvancedCandidate(normalized, patch);
    const receipt = await api.options.configuration.apply({
      candidate,
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
    return json({ version: WORKBENCH_CONFIGURATION_VERSION, receipt });
  };
}

function providerProfileUpsertHandler(api: AdminApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const owner = await api.requireOwner(c);
    if (owner instanceof Response) return owner;
    const profileId = c.req.param('profileId');
    if (profileId === undefined || profileId.length === 0 || !isValidProviderId(profileId)) {
      return adminError('CONFIG_INVALID', 'A valid provider profile id is required.');
    }
    const body = await c.req.raw.json().catch(() => null);
    const parsed = parseRequest(body, ['kind', 'baseUrl', 'model']);
    if (parsed === null || parsed.kind !== 'ai-sdk') {
      return adminError(
        'UNKNOWN_FIELD',
        'provider profiles accept only kind "ai-sdk", baseUrl, model.',
      );
    }
    const baseUrl =
      parsed.baseUrl === null || typeof parsed.baseUrl === 'string' ? parsed.baseUrl : null;
    const model = parsed.model === null || typeof parsed.model === 'string' ? parsed.model : null;
    const loaded = await api.requireConfiguration();
    if (!loaded.ok) return loaded.response;
    const normalized = normalizeWorkbenchConfiguration(loaded.active.configuration);
    const receipt = await api.options.configuration.apply({
      candidate: {
        ...normalized,
        providers: {
          ...normalized.providers,
          [profileId]: { kind: 'ai-sdk' as const, baseUrl, model },
        },
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
    const profile = await providerProfileView(api, profileId, {
      kind: 'ai-sdk',
      baseUrl,
      model,
    });
    return json({ version: WORKBENCH_CONFIGURATION_VERSION, profile, receipt });
  };
}

function providerProfileDeleteHandler(api: AdminApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const owner = await api.requireOwner(c);
    if (owner instanceof Response) return owner;
    const profileId = c.req.param('profileId');
    if (profileId === undefined || profileId.length === 0) {
      return adminError('CONFIG_INVALID', 'A provider profile id is required.');
    }
    const loaded = await api.requireConfiguration();
    if (!loaded.ok) return loaded.response;
    const normalized = normalizeWorkbenchConfiguration(loaded.active.configuration);
    if (normalized.providers[profileId] === undefined) {
      return adminError('CONFIG_INVALID', `Provider profile "${profileId}" does not exist.`);
    }
    const referencedBy = normalized.projects.find(
      (project) => project.providerProfile === profileId,
    );
    if (referencedBy !== undefined) {
      return adminError(
        'CONFIG_INVALID',
        `Provider profile "${profileId}" is used by project "${referencedBy.projectId}" and cannot be removed.`,
      );
    }
    const { [profileId]: _removed, ...remaining } = normalized.providers;
    const receipt = await api.options.configuration.apply({
      candidate: { ...normalized, providers: remaining },
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
    await api.options.credentials.remove(`ai-sdk:${profileId}`).catch(() => undefined);
    return json({ version: WORKBENCH_CONFIGURATION_VERSION, profileId, removed: true, receipt });
  };
}

function providerProfileCredentialSetHandler(api: AdminApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const owner = await api.requireOwner(c);
    if (owner instanceof Response) return owner;
    const profileId = c.req.param('profileId');
    if (profileId === undefined || profileId.length === 0) {
      return adminError('CONFIG_INVALID', 'A provider profile id is required.');
    }
    const body = await c.req.raw.json().catch(() => null);
    const parsed = parseRequest(body, ['apiKey']);
    const apiKey = parsed?.apiKey;
    if (parsed === null || typeof apiKey !== 'string' || apiKey.length === 0) {
      return adminError('CREDENTIAL_INVALID', 'A non-empty apiKey is required.');
    }
    try {
      await api.options.credentials.set(`ai-sdk:${profileId}`, apiKey);
    } catch {
      return adminError('CREDENTIAL_INVALID', 'The credential could not be stored.');
    }
    return json({ version: WORKBENCH_CONFIGURATION_VERSION, profileId, configured: true });
  };
}

function providerProfileCredentialClearHandler(api: AdminApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const owner = await api.requireOwner(c);
    if (owner instanceof Response) return owner;
    const profileId = c.req.param('profileId');
    if (profileId === undefined || profileId.length === 0) {
      return adminError('CONFIG_INVALID', 'A provider profile id is required.');
    }
    await api.options.credentials.remove(`ai-sdk:${profileId}`);
    return json({ version: WORKBENCH_CONFIGURATION_VERSION, profileId, configured: false });
  };
}

function providerProfileTestHandler(api: AdminApiImpl): Handler<HostListenerEnv> {
  return async (c) => {
    const owner = await api.requireOwner(c);
    if (owner instanceof Response) return owner;
    const profileId = c.req.param('profileId');
    if (profileId === undefined || profileId.length === 0) {
      return adminError('CONFIG_INVALID', 'A provider profile id is required.');
    }
    const test = api.options.providerTest;
    if (test == null) {
      return adminError(
        'PROVIDER_VALIDATION_FAILED',
        'Provider validation is not available on this Host.',
      );
    }
    const loaded = await api.requireConfiguration();
    if (!loaded.ok) return loaded.response;
    const normalized = normalizeWorkbenchConfiguration(loaded.active.configuration);
    const profile = normalized.providers[profileId];
    if (profile === undefined) {
      return adminError('CONFIG_INVALID', `Provider profile "${profileId}" does not exist.`);
    }
    const apiKey = await api.options.credentials.get(`ai-sdk:${profileId}`);
    const result = await test.test({
      baseUrl: profile.baseUrl,
      model: profile.model,
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
      if (
        !loaded.active.configuration.projects.some((project) => project.projectId === projectId)
      ) {
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
    { path: BROWSER_ADMIN_CONFIG_ADVANCED_PATH, handler: advancedConfigReadHandler(api) },
    {
      path: `${BROWSER_ADMIN_PLUGINS_DISCOVERED_PATH}/:projectId`,
      handler: pluginsDiscoveredHandler(api),
    },
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
    {
      method: 'DELETE',
      path: BROWSER_ADMIN_MEMBERSHIPS_PATH,
      handler: membershipRevokeHandler(api),
    },
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
    {
      method: 'POST',
      path: BROWSER_ADMIN_CONFIG_PREVIEW_PATH,
      handler: advancedConfigPreviewHandler(api),
    },
    {
      method: 'PUT',
      path: BROWSER_ADMIN_CONFIG_ADVANCED_PATH,
      handler: advancedConfigApplyHandler(api),
    },
    {
      method: 'PUT',
      path: `${BROWSER_ADMIN_PROVIDERS_PATH}/:profileId`,
      handler: providerProfileUpsertHandler(api),
    },
    {
      method: 'DELETE',
      path: `${BROWSER_ADMIN_PROVIDERS_PATH}/:profileId`,
      handler: providerProfileDeleteHandler(api),
    },
    {
      method: 'POST',
      path: `${BROWSER_ADMIN_PROVIDERS_PATH}/:profileId/credential`,
      handler: providerProfileCredentialSetHandler(api),
    },
    {
      method: 'DELETE',
      path: `${BROWSER_ADMIN_PROVIDERS_PATH}/:profileId/credential`,
      handler: providerProfileCredentialClearHandler(api),
    },
    {
      method: 'POST',
      path: `${BROWSER_ADMIN_PROVIDERS_PATH}/:profileId/test`,
      handler: providerProfileTestHandler(api),
    },
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
