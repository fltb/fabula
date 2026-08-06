import { BROWSER_SESSION_HEADER } from '../../contracts/browser-api.js';
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
  type ConfigOperationReceiptV1,
  type ProjectAccessRole,
  WORKBENCH_CONFIGURATION_VERSION,
  type WorkbenchAdminErrorCode,
  type WorkbenchAdminOverviewV1,
  type WorkbenchConfigurationVersion,
  type WorkbenchDeviceSafeViewV1,
  type WorkbenchInviteSafeViewV1,
  type WorkbenchNetworkReadViewV1,
  type WorkbenchProjectSafeViewV1,
  type WorkbenchProjectValidationV1,
  type WorkbenchProviderReadViewV1,
} from '../../contracts/configuration.js';

const BROWSER_ADMIN_PROJECTS_VALIDATE_PATH = `${BROWSER_ADMIN_PROJECTS_PATH}/validate`;
const BROWSER_ADMIN_PROVIDER_CREDENTIAL_PATH = `${BROWSER_ADMIN_PROVIDER_PATH}/credential`;
const BROWSER_ADMIN_PROVIDER_TEST_PATH = `${BROWSER_ADMIN_PROVIDER_PATH}/test`;
const BROWSER_ADMIN_PROVIDERS_PATH = `${BROWSER_ADMIN_BASE_PATH}/providers`;
const BROWSER_ADMIN_CONFIG_ADVANCED_PATH = `${BROWSER_ADMIN_BASE_PATH}/config/advanced`;
const BROWSER_ADMIN_CONFIG_PREVIEW_PATH = `${BROWSER_ADMIN_BASE_PATH}/config/preview`;
const BROWSER_ADMIN_SESSIONS_PATH = '/api/v1/admin/sessions';
const BROWSER_ADMIN_DEVICES_ISSUE_PATH = `${BROWSER_ADMIN_DEVICES_PATH}/issue`;

/** A browser-native Fetch signature, injectable for deterministic client tests. */
export type AdminFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Authorization state known to the browser without storing a session credential. */
export type AdminAuthorizationState = 'unknown' | 'owner' | 'user' | 'unauthorized';

/** One safe project write. `root` is consumed once by the Host and never read back. */
export type AdminProjectInput = Omit<AdminProjectSaveRequestV1, 'version'>;
/** One safe provider endpoint/model write; it never includes an API key. */
export type AdminProviderInput = Omit<AdminProviderUpdateRequestV1, 'version'>;
/** One listener policy write; unixSocketName is a name, not a filesystem path. */
export type AdminNetworkInput = Omit<AdminNetworkUpdateRequestV1, 'version'>;
/** One invite write; the Host creates and stores any redemption material. */
export type AdminInviteInput = Omit<AdminInviteCreateRequestV1, 'version'>;
/** One MCP device pairing issue; project and admin bindings are explicit. */
export type AdminDevicePairingInput =
  | {
      readonly kind: 'project';
      readonly projectId: string;
      readonly role?: ProjectAccessRole;
      readonly ttlMs?: number;
    }
  | {
      readonly kind: 'admin';
      readonly ttlMs?: number;
    };

/** One MCP device claim; the returned credential is displayed only once by the UI. */
export type AdminDeviceClaimInput = Omit<AdminDevicePairRequestV1, 'version'>;

/** Safe operation metadata returned by the owner-only operations endpoint. */
export interface AdminConfigurationOperationViewV1 {
  readonly operationId: string;
  readonly origin: string;
  readonly status: string;
  readonly activeRevision?: string;
  readonly candidateRevision?: string;
  readonly changedFields: readonly string[];
  readonly diagnostics: readonly { readonly code: string; readonly message: string }[];
  readonly actorId?: string;
  readonly at: string;
}

/** Safe audit metadata returned by the owner-only operations endpoint. */
export interface AdminAuditViewV1 {
  readonly auditId: string;
  readonly at: string;
  readonly actorId?: string;
  readonly surface: string;
  readonly operationKind: string;
  readonly outcome: string;
  readonly projectId?: string;
  readonly documentScope?: string;
  readonly capabilityVersion?: number;
  readonly baseSourceHash?: string;
  readonly resultSourceHash?: string;
  readonly workspaceDigest?: string;
  readonly submitId?: string;
  readonly gitReceiptHash?: string;
  readonly detail?: string;
}

export interface AdminOperationsResponseV1 {
  readonly version: WorkbenchConfigurationVersion;
  readonly configurationOperations: readonly AdminConfigurationOperationViewV1[];
  readonly audit: readonly AdminAuditViewV1[];
  readonly generatedAt: string;
}

export interface AdminProjectValidationResponseV1 {
  readonly version: WorkbenchConfigurationVersion;
  readonly projectId: string;
  readonly validation: WorkbenchProjectValidationV1;
  readonly code?: string;
}

export interface AdminProjectMutationResponseV1 {
  readonly version: WorkbenchConfigurationVersion;
  readonly project?: WorkbenchProjectSafeViewV1 | null;
  readonly projectId?: string;
  readonly removed?: boolean;
  readonly open?: boolean;
  readonly receipt?: ConfigOperationReceiptV1;
}

export interface AdminProviderMutationResponseV1 {
  readonly version: WorkbenchConfigurationVersion;
  readonly provider: WorkbenchProviderReadViewV1;
  readonly receipt: ConfigOperationReceiptV1;
}

export interface AdminProviderTestResponseV1 {
  readonly version: WorkbenchConfigurationVersion;
  readonly validation: WorkbenchProjectValidationV1;
  readonly code?: string;
  readonly lastValidatedAt: string;
}

export interface AdminCredentialResponseV1 {
  readonly version: WorkbenchConfigurationVersion;
  readonly providerId: 'ai-sdk';
  readonly configured: boolean;
}

export interface AdminNetworkMutationResponseV1 {
  readonly version: WorkbenchConfigurationVersion;
  readonly network: WorkbenchNetworkReadViewV1;
  readonly receipt: ConfigOperationReceiptV1;
}

export interface AdminInviteResponseV1 {
  readonly version: WorkbenchConfigurationVersion;
  readonly invite: WorkbenchInviteSafeViewV1;
}

export interface AdminDeviceListResponseV1 {
  readonly version: WorkbenchConfigurationVersion;
  readonly devices: readonly WorkbenchDeviceSafeViewV1[];
}

export interface AdminDeviceIssueResponseV1 {
  readonly version: WorkbenchConfigurationVersion;
  /** One-time pairing code. It is never retained by the client after claim/dismissal. */
  readonly pairingCode: string;
  readonly expiresAt: string;
}

export interface AdminDeviceClaimResponseV1 {
  readonly version: WorkbenchConfigurationVersion;
  /** Opaque credential shown once; no read method returns it again. */
  readonly credential: string;
  readonly device: WorkbenchDeviceSafeViewV1;
}

export interface AdminDeviceRevokeResponseV1 {
  readonly version: WorkbenchConfigurationVersion;
  readonly deviceId: string;
  readonly revoked: true;
}

export interface AdminSessionRevokeResponseV1 {
  readonly version: WorkbenchConfigurationVersion;
  readonly sessionId: string;
  readonly revoked: true;
}

// ─── V3 configuration domains (browser-safe DTOs) ───────────────────────────

/** Masked provider profile view; credentials never cross this boundary. */
export interface AdminProviderProfileViewV1 {
  readonly profileId: string;
  readonly kind: 'ai-sdk';
  readonly configured: boolean;
  readonly endpoint: string | null;
  readonly model: string | null;
  readonly lastValidation: WorkbenchProjectValidationV1;
  readonly lastValidatedAt: string | null;
}

/** One trusted plugin allowlist entry; only identity fields, never module code. */
export interface AdminTrustedPluginViewV1 {
  readonly name: string;
  readonly version: string;
  readonly moduleHash: string;
  readonly required: boolean;
}

/** One Host-discovered plugin identity; only hashes/hook names, never paths or code. */
export interface AdminDiscoveredPluginViewV1 {
  readonly name: string;
  readonly version: string;
  readonly manifestHash: string;
  readonly moduleHash: string | null;
  readonly hookNames: readonly string[];
}

/** Response of the owner-only Host-discovered plugin identity route. */
export interface AdminDiscoveredPluginsResponseV1 {
  readonly version: WorkbenchConfigurationVersion;
  readonly projectId: string;
  readonly plugins: readonly AdminDiscoveredPluginViewV1[];
}

/** Per-project V3 binding: provider profile + trusted plugin allowlist. */
export interface AdminProjectProfileBindingViewV1 {
  readonly projectId: string;
  readonly displayName: string;
  readonly providerProfile: string;
  readonly trustedPlugins: readonly AdminTrustedPluginViewV1[];
}

/** Operation limits read view; `maxConcurrentRendersPerProject` is fixed at 1. */
export interface AdminOperationLimitsViewV1 {
  readonly maxQueuedPerProject: number;
  readonly maxConcurrentRendersPerProject: 1;
  readonly maxConcurrentRendersPerHost: number;
}

/** Agent settings read view. */
export interface AdminAgentSettingsViewV1 {
  readonly enabled: boolean;
  readonly maxTurns: number;
  readonly maxToolCalls: number;
}

/** Aggregate read of every V3 configuration domain (single guarded route). */
export interface AdminAdvancedConfigResponseV1 {
  readonly version: WorkbenchConfigurationVersion;
  readonly providers: readonly AdminProviderProfileViewV1[];
  readonly projects: readonly AdminProjectProfileBindingViewV1[];
  readonly operationLimits: AdminOperationLimitsViewV1;
  readonly agent: AdminAgentSettingsViewV1;
  readonly generatedAt: string;
}

/** Non-applying validation result for a V3-domain patch. */
export interface AdminAdvancedConfigPreviewResponseV1 {
  readonly version: WorkbenchConfigurationVersion;
  readonly valid: boolean;
  readonly diagnostics: readonly { readonly code: string; readonly message: string }[];
  readonly changedFields: readonly string[];
  readonly restartRequired: boolean;
  readonly candidateRevision: string | null;
}

/** CAS apply result for a V3-domain patch. */
export interface AdminAdvancedConfigApplyResponseV1 {
  readonly version: WorkbenchConfigurationVersion;
  readonly receipt: ConfigOperationReceiptV1;
}

export interface AdminProviderProfileMutationResponseV1 {
  readonly version: WorkbenchConfigurationVersion;
  readonly profile: AdminProviderProfileViewV1;
  readonly receipt: ConfigOperationReceiptV1;
}

export interface AdminProviderProfileDeleteResponseV1 {
  readonly version: WorkbenchConfigurationVersion;
  readonly profileId: string;
  readonly removed: true;
  readonly receipt: ConfigOperationReceiptV1;
}

export interface AdminProviderProfileCredentialResponseV1 {
  readonly version: WorkbenchConfigurationVersion;
  readonly profileId: string;
  readonly configured: boolean;
}

export interface AdminProviderProfileTestResponseV1 {
  readonly version: WorkbenchConfigurationVersion;
  readonly validation: WorkbenchProjectValidationV1;
  readonly code?: string;
  readonly lastValidatedAt: string;
}

/** Provider profile endpoint/model write; it never includes an API key. */
export type AdminProviderProfileInput = {
  readonly kind: 'ai-sdk';
  readonly baseUrl: string | null;
  readonly model: string | null;
};

/** One trusted plugin allowlist write (identity fields only). */
export type AdminTrustedPluginInput = {
  readonly name: string;
  readonly version: string;
  readonly moduleHash: string;
  readonly required: boolean;
};

/**
 * V3-domain mutation/preview input. Any subset may be present; omitted
 * domains are left unchanged by the single revision-CAS apply.
 */
export interface AdminAdvancedConfigInput {
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
    readonly trustedPlugins?: readonly AdminTrustedPluginInput[];
  }[];
}

export interface AdminClient {
  readonly getAuthorization: () => AdminAuthorizationState;
  getOverview(): Promise<WorkbenchAdminOverviewV1>;
  getOperations(): Promise<AdminOperationsResponseV1>;
  listDevices(): Promise<AdminDeviceListResponseV1>;
  validateProject(input: AdminProjectInput): Promise<AdminProjectValidationResponseV1>;
  createProject(input: AdminProjectInput): Promise<AdminProjectMutationResponseV1>;
  updateProject(input: AdminProjectInput): Promise<AdminProjectMutationResponseV1>;
  deleteProject(projectId: string): Promise<AdminProjectMutationResponseV1>;
  openProject(projectId: string): Promise<AdminProjectMutationResponseV1>;
  closeProject(projectId: string): Promise<AdminProjectMutationResponseV1>;
  updateProvider(input: AdminProviderInput): Promise<AdminProviderMutationResponseV1>;
  testProvider(): Promise<AdminProviderTestResponseV1>;
  setProviderCredential(apiKey: string): Promise<AdminCredentialResponseV1>;
  clearProviderCredential(): Promise<AdminCredentialResponseV1>;
  updateNetwork(input: AdminNetworkInput): Promise<AdminNetworkMutationResponseV1>;
  createInvite(input: AdminInviteInput): Promise<AdminInviteResponseV1>;
  revokeSession(sessionId: string): Promise<AdminSessionRevokeResponseV1>;
  issueDevicePairing(input: AdminDevicePairingInput): Promise<AdminDeviceIssueResponseV1>;
  claimDevice(input: AdminDeviceClaimInput): Promise<AdminDeviceClaimResponseV1>;
  revokeDevice(deviceId: string): Promise<AdminDeviceRevokeResponseV1>;
  getAdvancedConfig(): Promise<AdminAdvancedConfigResponseV1>;
  getDiscoveredPlugins(projectId: string): Promise<AdminDiscoveredPluginsResponseV1>;
  previewAdvancedConfig(
    input: AdminAdvancedConfigInput,
  ): Promise<AdminAdvancedConfigPreviewResponseV1>;
  applyAdvancedConfig(input: AdminAdvancedConfigInput): Promise<AdminAdvancedConfigApplyResponseV1>;
  upsertProviderProfile(
    profileId: string,
    input: AdminProviderProfileInput,
  ): Promise<AdminProviderProfileMutationResponseV1>;
  deleteProviderProfile(profileId: string): Promise<AdminProviderProfileDeleteResponseV1>;
  setProviderProfileCredential(
    profileId: string,
    apiKey: string,
  ): Promise<AdminProviderProfileCredentialResponseV1>;
  clearProviderProfileCredential(
    profileId: string,
  ): Promise<AdminProviderProfileCredentialResponseV1>;
  testProviderProfile(profileId: string): Promise<AdminProviderProfileTestResponseV1>;
}

export interface AdminClientOptions {
  /** Supplies the transient session only for the active request. */
  readonly getSessionId?: () => string | null | undefined;
  readonly fetch?: AdminFetch;
  /** Optional same-origin prefix for embedded or test Hosts. */
  readonly baseUrl?: string;
  /** Known auth from the state machine; unknown is intentionally conservative in UI. */
  readonly initialAuthorization?: AdminAuthorizationState;
}

const ADMIN_ERROR_CODES = new Set<WorkbenchAdminErrorCode>([
  'UNAUTHORIZED',
  'FORBIDDEN',
  'PROJECT_NOT_FOUND',
  'PROJECT_BUSY',
  'PROJECT_PENDING_RECOVERY',
  'INVITE_INVALID',
  'DEVICE_NOT_FOUND',
  'SESSION_NOT_FOUND',
  'CREDENTIAL_INVALID',
  'PROVIDER_VALIDATION_FAILED',
  'NETWORK_INVALID',
  'CONFIG_INVALID',
  'CONFIG_STALE',
  'UNKNOWN_FIELD',
  'PLUGIN_NOT_DISCOVERED',
  'INTERNAL',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodedAdminError(
  value: unknown,
): { code: WorkbenchAdminErrorCode; message: string } | null {
  if (!isRecord(value) || !isRecord(value.error)) return null;
  const code = value.error.code;
  const message = value.error.message;
  if (typeof code !== 'string' || !ADMIN_ERROR_CODES.has(code as WorkbenchAdminErrorCode))
    return null;
  if (typeof message !== 'string') return null;
  return { code: code as WorkbenchAdminErrorCode, message };
}

/** Typed failure from the guarded owner-only Host surface. Response bodies are never retained. */
export class AdminApiError extends Error {
  readonly status: number;
  readonly code: WorkbenchAdminErrorCode | null;

  constructor(status: number, code: WorkbenchAdminErrorCode | null, message: string) {
    super(message);
    this.name = 'AdminApiError';
    this.status = status;
    this.code = code;
  }
}

function pathSegment(value: string): string {
  return encodeURIComponent(value);
}

function fixedVersionBody(fields: Record<string, unknown>): Record<string, unknown> {
  return { version: WORKBENCH_CONFIGURATION_VERSION, ...fields };
}

/** Versioned body for a V3-domain patch; omitted domains never reach the wire. */
function advancedConfigBody(input: AdminAdvancedConfigInput): Record<string, unknown> {
  return fixedVersionBody({
    ...(input.operationLimits === undefined
      ? {}
      : {
          operationLimits: {
            maxQueuedPerProject: input.operationLimits.maxQueuedPerProject,
            maxConcurrentRendersPerHost: input.operationLimits.maxConcurrentRendersPerHost,
          },
        }),
    ...(input.agent === undefined
      ? {}
      : {
          agent: {
            enabled: input.agent.enabled,
            maxTurns: input.agent.maxTurns,
            maxToolCalls: input.agent.maxToolCalls,
          },
        }),
    ...(input.projects === undefined
      ? {}
      : {
          projects: input.projects.map((entry) => ({
            projectId: entry.projectId,
            ...(entry.providerProfile === undefined
              ? {}
              : { providerProfile: entry.providerProfile }),
            ...(entry.trustedPlugins === undefined
              ? {}
              : { trustedPlugins: entry.trustedPlugins.map((plugin) => ({ ...plugin })) }),
          })),
        }),
  });
}

function responseHasVersion(
  value: unknown,
): value is { readonly version: WorkbenchConfigurationVersion } {
  return isRecord(value) && value.version === WORKBENCH_CONFIGURATION_VERSION;
}

/**
 * Create the precise owner dashboard client. Every mutation builds a fixed
 * versioned body from named fields; callers cannot send generic patches or
 * smuggle roots, tokens, actor ids, Git values, or unknown fields.
 */
export function createAdminClient(options: AdminClientOptions = {}): AdminClient {
  const execute = options.fetch ?? globalThis.fetch;
  if (typeof execute !== 'function') throw new Error('Browser Fetch API is unavailable.');
  const prefix = options.baseUrl ?? '';
  let authorization = options.initialAuthorization ?? 'unknown';

  const request = async <T>(
    path: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
    body?: Record<string, unknown>,
  ): Promise<T> => {
    const headers = new Headers({ accept: 'application/json' });
    if (body !== undefined) headers.set('content-type', 'application/json');
    const sessionId = options.getSessionId?.();
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      headers.set(BROWSER_SESSION_HEADER, sessionId);
    }
    const response = await execute(`${prefix}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      credentials: 'same-origin',
    });
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = decodedAdminError(value);
      if (response.status === 401) authorization = 'unauthorized';
      else if (response.status === 403) authorization = 'user';
      throw new AdminApiError(
        response.status,
        error?.code ?? null,
        error?.message ?? `Owner dashboard request failed with HTTP ${response.status}.`,
      );
    }
    if (!responseHasVersion(value)) {
      throw new AdminApiError(502, 'INTERNAL', 'The Host returned an unsupported admin response.');
    }
    return value as T;
  };

  const assertMutationAllowed = (): void => {
    if (authorization === 'unauthorized') {
      throw new AdminApiError(401, 'UNAUTHORIZED', 'An owner session is required for this action.');
    }
    if (authorization === 'user') {
      throw new AdminApiError(403, 'FORBIDDEN', 'The owner role is required for this action.');
    }
  };

  return {
    getAuthorization: () => authorization,
    getOverview: async () => {
      const overview = await request<WorkbenchAdminOverviewV1>(BROWSER_ADMIN_OVERVIEW_PATH);
      authorization = 'owner';
      return overview;
    },
    getOperations: () => request<AdminOperationsResponseV1>(BROWSER_ADMIN_OPERATIONS_PATH),
    listDevices: () => request<AdminDeviceListResponseV1>(BROWSER_ADMIN_DEVICES_PATH),
    validateProject: (input) => {
      assertMutationAllowed();
      return request<AdminProjectValidationResponseV1>(
        BROWSER_ADMIN_PROJECTS_VALIDATE_PATH,
        'POST',
        fixedVersionBody({
          projectId: input.projectId,
          displayName: input.displayName,
          root: input.root,
        }),
      );
    },
    createProject: (input) => {
      assertMutationAllowed();
      return request<AdminProjectMutationResponseV1>(
        BROWSER_ADMIN_PROJECTS_PATH,
        'POST',
        fixedVersionBody({
          projectId: input.projectId,
          displayName: input.displayName,
          root: input.root,
        }),
      );
    },
    updateProject: (input) => {
      assertMutationAllowed();
      const path = `${BROWSER_ADMIN_PROJECTS_PATH}/${pathSegment(input.projectId)}`;
      return request<AdminProjectMutationResponseV1>(
        path,
        'PUT',
        fixedVersionBody({
          projectId: input.projectId,
          displayName: input.displayName,
          root: input.root,
        }),
      );
    },
    deleteProject: (projectId) => {
      assertMutationAllowed();
      return request<AdminProjectMutationResponseV1>(
        `${BROWSER_ADMIN_PROJECTS_PATH}/${pathSegment(projectId)}`,
        'DELETE',
      );
    },
    openProject: (projectId) => {
      assertMutationAllowed();
      return request<AdminProjectMutationResponseV1>(
        `${BROWSER_ADMIN_PROJECTS_PATH}/${pathSegment(projectId)}/open`,
        'POST',
      );
    },
    closeProject: (projectId) => {
      assertMutationAllowed();
      return request<AdminProjectMutationResponseV1>(
        `${BROWSER_ADMIN_PROJECTS_PATH}/${pathSegment(projectId)}/close`,
        'POST',
      );
    },
    updateProvider: (input) => {
      assertMutationAllowed();
      return request<AdminProviderMutationResponseV1>(
        BROWSER_ADMIN_PROVIDER_PATH,
        'PUT',
        fixedVersionBody({ kind: input.kind, baseUrl: input.baseUrl, model: input.model }),
      );
    },
    testProvider: () => {
      assertMutationAllowed();
      return request<AdminProviderTestResponseV1>(BROWSER_ADMIN_PROVIDER_TEST_PATH, 'POST');
    },
    setProviderCredential: (apiKey) => {
      assertMutationAllowed();
      return request<AdminCredentialResponseV1>(
        BROWSER_ADMIN_PROVIDER_CREDENTIAL_PATH,
        'POST',
        fixedVersionBody({ providerId: 'ai-sdk', apiKey }),
      );
    },
    clearProviderCredential: () => {
      assertMutationAllowed();
      return request<AdminCredentialResponseV1>(BROWSER_ADMIN_PROVIDER_CREDENTIAL_PATH, 'DELETE');
    },
    updateNetwork: (input) => {
      assertMutationAllowed();
      return request<AdminNetworkMutationResponseV1>(
        BROWSER_ADMIN_NETWORK_PATH,
        'PUT',
        fixedVersionBody({
          mode: input.mode,
          port: input.port,
          allowedHosts: [...input.allowedHosts],
          allowedOrigins: [...input.allowedOrigins],
          unixSocketName: input.unixSocketName,
        }),
      );
    },
    createInvite: (input) => {
      assertMutationAllowed();
      return request<AdminInviteResponseV1>(
        BROWSER_ADMIN_INVITES_PATH,
        'POST',
        fixedVersionBody({
          ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
          role: input.role,
          ttlMs: input.ttlMs,
        }),
      );
    },
    revokeSession: (sessionId) => {
      assertMutationAllowed();
      return request<AdminSessionRevokeResponseV1>(
        `${BROWSER_ADMIN_SESSIONS_PATH}/${pathSegment(sessionId)}`,
        'DELETE',
      );
    },
    issueDevicePairing: (input) => {
      assertMutationAllowed();
      return request<AdminDeviceIssueResponseV1>(
        BROWSER_ADMIN_DEVICES_ISSUE_PATH,
        'POST',
        fixedVersionBody({
          kind: input.kind,
          ...(input.kind === 'project'
            ? {
                projectId: input.projectId,
                ...(input.role === undefined ? {} : { role: input.role }),
              }
            : {}),
          ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
        }),
      );
    },
    claimDevice: (input) => {
      assertMutationAllowed();
      return request<AdminDeviceClaimResponseV1>(
        BROWSER_ADMIN_DEVICES_PATH,
        'POST',
        fixedVersionBody({
          pairingCode: input.pairingCode,
          label: input.label,
          scopes: [...input.scopes],
          ttlMs: input.ttlMs,
        }),
      );
    },
    revokeDevice: (deviceId) => {
      assertMutationAllowed();
      return request<AdminDeviceRevokeResponseV1>(
        `${BROWSER_ADMIN_DEVICES_PATH}/${pathSegment(deviceId)}`,
        'DELETE',
      );
    },
    getAdvancedConfig: () =>
      request<AdminAdvancedConfigResponseV1>(BROWSER_ADMIN_CONFIG_ADVANCED_PATH),
    getDiscoveredPlugins: async (projectId) => {
      const response = await request<AdminDiscoveredPluginsResponseV1>(
        `${BROWSER_ADMIN_PLUGINS_DISCOVERED_PATH}/${pathSegment(projectId)}`,
      );
      if (!Array.isArray(response.plugins)) {
        throw new AdminApiError(
          502,
          'INTERNAL',
          'The Host returned an unsupported plugin discovery response.',
        );
      }
      return response;
    },
    previewAdvancedConfig: (input) => {
      assertMutationAllowed();
      return request<AdminAdvancedConfigPreviewResponseV1>(
        BROWSER_ADMIN_CONFIG_PREVIEW_PATH,
        'POST',
        advancedConfigBody(input),
      );
    },
    applyAdvancedConfig: (input) => {
      assertMutationAllowed();
      return request<AdminAdvancedConfigApplyResponseV1>(
        BROWSER_ADMIN_CONFIG_ADVANCED_PATH,
        'PUT',
        advancedConfigBody(input),
      );
    },
    upsertProviderProfile: (profileId, input) => {
      assertMutationAllowed();
      return request<AdminProviderProfileMutationResponseV1>(
        `${BROWSER_ADMIN_PROVIDERS_PATH}/${pathSegment(profileId)}`,
        'PUT',
        fixedVersionBody({ kind: input.kind, baseUrl: input.baseUrl, model: input.model }),
      );
    },
    deleteProviderProfile: (profileId) => {
      assertMutationAllowed();
      return request<AdminProviderProfileDeleteResponseV1>(
        `${BROWSER_ADMIN_PROVIDERS_PATH}/${pathSegment(profileId)}`,
        'DELETE',
      );
    },
    setProviderProfileCredential: (profileId, apiKey) => {
      assertMutationAllowed();
      return request<AdminProviderProfileCredentialResponseV1>(
        `${BROWSER_ADMIN_PROVIDERS_PATH}/${pathSegment(profileId)}/credential`,
        'POST',
        fixedVersionBody({ apiKey }),
      );
    },
    clearProviderProfileCredential: (profileId) => {
      assertMutationAllowed();
      return request<AdminProviderProfileCredentialResponseV1>(
        `${BROWSER_ADMIN_PROVIDERS_PATH}/${pathSegment(profileId)}/credential`,
        'DELETE',
      );
    },
    testProviderProfile: (profileId) => {
      assertMutationAllowed();
      return request<AdminProviderProfileTestResponseV1>(
        `${BROWSER_ADMIN_PROVIDERS_PATH}/${pathSegment(profileId)}/test`,
        'POST',
      );
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
};
