/**
 * Workbench configuration contract: versioned, secret-free Host configuration
 * wire shapes plus the safe setup/admin read views and error codes.
 *
 * This module is the wire contract for the Host's single configuration source
 * of truth (`workbench.yaml`): the validated in-memory shape
 * {@link WorkbenchConfigurationV1}, the revision-CAS change request
 * {@link ConfigChangeRequestV1}, and the typed application receipt
 * {@link ConfigOperationReceiptV1}. Configuration never contains secrets —
 * API keys, owner passwords, session/capability tokens, invite redemption
 * secrets and MCP device credentials live in the provider credential store or
 * typed persistence and are never part of any configuration payload.
 *
 * BOUNDARY: `contracts/index.ts` re-exports only the browser-safe subset of
 * this module. {@link WorkbenchConfigurationV1} (carries project `root`
 * filesystem paths), {@link ConfigChangeRequestV1} (wraps it), and the
 * one-way setup/admin mutation inputs (carry absolute project paths or
 * provider API keys) are host-only wire types: the Host resolves paths and
 * secrets server-side and never echoes them in any read DTO. Read views
 * expose only display labels, validation status, `configured` booleans and
 * masked endpoint/model values — never roots, paths, tokens or keys.
 */

import { BROWSER_API_BASE_PATH } from './browser-api.js';
/** Canonical project membership roles. Owner is a Host identity override, not a membership role. */
export const PROJECT_ACCESS_ROLES = ['reader', 'author', 'maintainer'] as const;
export type ProjectAccessRole = (typeof PROJECT_ACCESS_ROLES)[number];

/** Canonical hierarchy and MCP scope grants for every project role. */
export const PROJECT_ACCESS_ROLE_GRANTS = {
  reader: { rank: 1, scopes: ['mcp:read', 'mcp:render'] },
  author: { rank: 2, scopes: ['mcp:read', 'mcp:render', 'mcp:author'] },
  maintainer: {
    rank: 3,
    scopes: ['mcp:read', 'mcp:render', 'mcp:author', 'mcp:submit'],
  },
} as const satisfies Readonly<
  Record<ProjectAccessRole, { readonly rank: number; readonly scopes: readonly string[] }>
>;

/** Canonical Host configuration additions introduced by the V2 source contract. */
export type {
  WorkbenchConfigurationInput,
  WorkbenchConfigurationV2,
  WorkbenchProjectConfigurationV2,
  WorkbenchReferenceLimitsV2,
  WorkbenchRevisionMirrorConfigurationV2,
} from '@novalistically/workbench-protocol';
export {
  DEFAULT_WORKBENCH_REFERENCE_LIMITS_V2,
  normalizeWorkbenchConfiguration,
  WORKBENCH_CONFIGURATION_VERSION_V2,
} from '@novalistically/workbench-protocol';

/** Version of the Workbench configuration contract. */
export const WORKBENCH_CONFIGURATION_VERSION = 1 as const;
export type WorkbenchConfigurationVersion = typeof WORKBENCH_CONFIGURATION_VERSION;

// ─── Host-only configuration source of truth ────────────────────────────────

/** One registered project in the versioned configuration. Host-only: `root` is a filesystem path. */
export interface WorkbenchProjectConfigurationV1 {
  readonly projectId: string;
  readonly displayName: string;
  /** Absolute project root on the Host filesystem. Never crosses the browser boundary. */
  readonly root: string;
}

/** Provider endpoint/model configuration. Never carries an API key. */
export interface WorkbenchProviderConfigurationV1 {
  readonly kind: 'ai-sdk';
  readonly baseUrl: string | null;
  readonly model: string | null;
}

/** HTTP listener policy of the Host. Host-only: `unixSocket` is a filesystem path. */
export interface WorkbenchNetworkConfigurationV1 {
  readonly mode: 'loopback' | 'lan' | 'unix';
  readonly port: number;
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
  /** Absolute unix socket path when `mode` is `unix`; Host-only. */
  readonly unixSocket: string | null;
}

/**
 * The validated, secret-free Host configuration — the exact wire shape from
 * the Workbench plan. Host-only: `projects[].root` and `network.unixSocket`
 * are filesystem paths and this DTO is never re-exported through the browser
 * contract barrel.
 */
export interface WorkbenchConfigurationV1 {
  readonly version: 1;
  readonly projects: readonly WorkbenchProjectConfigurationV1[];
  readonly defaultProjectId: string | null;
  readonly provider: WorkbenchProviderConfigurationV1 | null;
  readonly network: WorkbenchNetworkConfigurationV1;
}

/** Origin of a configuration change, recorded in receipts and audit. */
export type ConfigChangeOriginV1 =
  | 'setup'
  | 'dashboard'
  | 'mcp'
  | 'filesystem'
  | 'dotenv-import';

/**
 * Revision-CAS configuration change request. `expectedRevision: null` is
 * allowed ONLY for the initial setup/dotenv import while `workbench.yaml`
 * does not exist yet; every dashboard, MCP and watcher apply must carry the
 * current content-hash revision. Host-only (wraps {@link WorkbenchConfigurationV1}).
 */
export interface ConfigChangeRequestV1 {
  readonly version: 1;
  readonly expectedRevision: string | null;
  readonly configuration: WorkbenchConfigurationV1;
}

// ─── Configuration operation receipt (browser-safe) ─────────────────────────

/** Typed application outcome of one configuration change. */
export type ConfigOperationStatusV1 = 'applied' | 'restart-required' | 'invalid' | 'stale';

/** One typed validation/application diagnostic. Never carries secrets or paths. */
export interface ConfigOperationDiagnosticV1 {
  readonly code: string;
  readonly message: string;
}

/**
 * Typed receipt for every configuration change, whichever adapter produced it
 * (setup wizard, dashboard, owner MCP, filesystem watcher, dotenv import).
 * Browser-safe: carries only revision hashes, status, changed field names and
 * diagnostics — never YAML content, secrets or filesystem paths.
 */
export interface ConfigOperationReceiptV1 {
  readonly status: ConfigOperationStatusV1;
  /** Content-hash revision of the configuration that remains active. */
  readonly activeRevision: string | null;
  /** Content-hash revision of the candidate that was applied or rejected. */
  readonly candidateRevision: string | null;
  /** Changed top-level/field paths (e.g. `network.port`), stable order. */
  readonly changedFields: readonly string[];
  readonly diagnostics: readonly ConfigOperationDiagnosticV1[];
}

// ─── Safe read views (browser-safe) ─────────────────────────────────────────

/** Wizard phase of a cold-start setup, derived from config DTO + credential readiness + auth state. */
export type WorkbenchSetupPhaseV1 =
  | 'unconfigured'
  | 'owner-pending'
  | 'project-pending'
  | 'provider-pending'
  | 'network-pending'
  | 'ready';

/** Validation status of one registered project (path validation is Host-side). */
export type WorkbenchProjectValidationV1 = 'valid' | 'invalid' | 'unvalidated';

/**
 * One project as the browser may see it: display label, validation status and
 * runtime flags only. `rootLabel`/paths are Host-internal and deliberately
 * absent.
 */
export interface WorkbenchProjectSafeViewV1 {
  readonly projectId: string;
  readonly displayName: string;
  readonly validation: WorkbenchProjectValidationV1;
  /** True while a ProjectSession is open for the project. */
  readonly open: boolean;
  /** True when this project is the configured default. */
  readonly defaultProject: boolean;
}

/**
 * Masked provider read view. `endpoint`/`model` are masked by the Host; the
 * API key never exists here (only the `configured` boolean does).
 */
export interface WorkbenchProviderReadViewV1 {
  readonly kind: 'ai-sdk';
  /** True when the Host credential store holds a validated key. */
  readonly configured: boolean;
  /** Masked endpoint, or null when unset. */
  readonly endpoint: string | null;
  /** Masked model, or null when unset. */
  readonly model: string | null;
  readonly lastValidation: WorkbenchProjectValidationV1;
  readonly lastValidatedAt: string | null;
}

/** Browser-safe listener policy view: the unix socket path is Host-only. */
export interface WorkbenchNetworkReadViewV1 {
  readonly mode: 'loopback' | 'lan' | 'unix';
  readonly port: number;
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
  /** True when the listener is configured to bind a unix socket (path never leaves the Host). */
  readonly unixSocket: boolean;
  /** True while the running listener already honors the configured policy. */
  readonly listenerActive: boolean;
  /** True when applying this policy requires a controlled restart. */
  readonly restartRequired: boolean;
}

/**
 * One MCP device as the browser may see it: label, scopes, expiry and
 * revocation only. The one-time pairing credential and its token hash are
 * never part of this view.
 */
export interface WorkbenchDeviceSafeViewV1 {
  readonly deviceId: string;
  readonly scopes: readonly string[];
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

/** One invite as the browser may see it (role, expiry, consumption). */
export interface WorkbenchInviteSafeViewV1 {
  readonly inviteId: string;
  readonly projectId: string | null;
  readonly role: ProjectAccessRole;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
}

/** Derived setup/readiness status consumed by the setup wizard and System page. */
export interface WorkbenchSetupStatusV1 {
  readonly version: WorkbenchConfigurationVersion;
  readonly phase: WorkbenchSetupPhaseV1;
  /** True once `workbench.yaml` exists. */
  readonly configurationPresent: boolean;
  readonly configurationRevision: string | null;
  /** Owner account exists (derived from LocalAuthService, never a credential). */
  readonly ownerCreated: boolean;
  readonly projects: readonly WorkbenchProjectSafeViewV1[];
  readonly defaultProjectId: string | null;
  readonly provider: WorkbenchProviderReadViewV1 | null;
  readonly network: WorkbenchNetworkReadViewV1;
  readonly generatedAt: string;
}

/**
 * Owner dashboard overview: host runtime status, setup phase and the safe
 * aggregate views of every management domain. Never carries roots, paths,
 * secrets, tokens, Git internals or database material.
 */
export interface WorkbenchAdminOverviewV1 {
  readonly version: WorkbenchConfigurationVersion;
  readonly setup: WorkbenchSetupStatusV1;
  readonly hostStatus: 'setup' | 'ready' | 'restart-required';
  /** Non-secret owner identity for the System page. */
  readonly owner: { readonly displayName: string; readonly capabilityVersion: number } | null;
  /** Persistence worker readiness (true = Host is not running SQLite inline). */
  readonly workerReady: boolean;
  /** Number of ProjectSessions currently open. */
  readonly openProjects: number;
  readonly restartRequired: boolean;
  readonly generatedAt: string;
}

// ─── Browser-safe admin mutation requests ───────────────────────────────────

/** Provider endpoint/model update from the dashboard. Never carries an API key. */
export interface AdminProviderUpdateRequestV1 {
  readonly version: WorkbenchConfigurationVersion;
  readonly kind: 'ai-sdk';
  readonly baseUrl: string | null;
  readonly model: string | null;
}

/**
 * Listener policy update from the dashboard/setup. `unixSocketName` is a
 * validated name (never a path); the Host resolves the actual socket path.
 */
export interface AdminNetworkUpdateRequestV1 {
  readonly version: WorkbenchConfigurationVersion;
  readonly mode: 'loopback' | 'lan' | 'unix';
  readonly port: number;
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly unixSocketName: string | null;
}

/** Invite creation from the dashboard. No redemption secret crosses this boundary. */
export interface AdminInviteCreateRequestV1 {
  readonly version: WorkbenchConfigurationVersion;
  readonly projectId: string;
  readonly role: ProjectAccessRole;
  readonly ttlMs: number;
}

/**
 * MCP device pairing claim. The one-time pairing code is consumed by the Host
 * and the returned opaque device credential is shown exactly once; nothing in
 * this request or any later view carries the credential.
 */
export interface AdminDevicePairRequestV1 {
  readonly version: WorkbenchConfigurationVersion;
  readonly pairingCode: string;
  readonly label: string;
  readonly scopes: readonly string[];
  readonly ttlMs: number;
}

// ─── Host-only one-way setup/admin mutation inputs ──────────────────────────

/**
 * Project registration input from the setup wizard / Projects page. `root` is
 * a one-way input: it is validated Host-side and never echoed in any read DTO.
 * Host-only wire type (not re-exported through the browser barrel).
 */
export interface SetupSaveProjectRequestV1 {
  readonly version: WorkbenchConfigurationVersion;
  readonly projectId: string;
  readonly displayName: string;
  /** Absolute project root; one-way input, never returned. */
  readonly root: string;
}

/** Project registration used by the owner dashboard; same one-way `root` rule. */
export type AdminProjectSaveRequestV1 = SetupSaveProjectRequestV1;

/**
 * Provider API key write from setup/dashboard. The secret is read once by the
 * Host and handed to the ProviderCredentialStore immediately; it never enters
 * configuration YAML, SQLite, audit, Git or any response. Host-only wire type.
 */
export interface SetupSaveCredentialRequestV1 {
  readonly version: WorkbenchConfigurationVersion;
  readonly providerId: string;
  /** Provider API key; one-way input, never echoed. */
  readonly apiKey: string;
}

/** Alias used by the owner dashboard; same one-way secret rule. */
export type AdminSetCredentialRequestV1 = SetupSaveCredentialRequestV1;

/** Setup wizard listener-policy step; identical to the dashboard network update. */
export type SetupApplyNetworkRequestV1 = AdminNetworkUpdateRequestV1;

/** Setup finish: apply the assembled candidate under a revision CAS. */
export interface SetupFinishRequestV1 {
  readonly version: WorkbenchConfigurationVersion;
  readonly expectedRevision: string | null;
}

// ─── Error codes ────────────────────────────────────────────────────────────

/** Typed setup-API failure codes (pre-start, allowlisted, loopback-only surface). */
export type WorkbenchSetupErrorCode =
  | 'SETUP_DISABLED'
  | 'SETUP_ALREADY_CONFIGURED'
  | 'SETUP_INVALID_INPUT'
  | 'OWNER_EXISTS'
  | 'PROJECT_INVALID_ROOT'
  | 'PROJECT_DUPLICATE_ID'
  | 'PROJECT_NOT_ACCESSIBLE'
  | 'PROVIDER_VALIDATION_FAILED'
  | 'CREDENTIAL_INVALID'
  | 'NETWORK_INVALID'
  | 'CONFIG_INVALID'
  | 'CONFIG_STALE'
  | 'UNKNOWN_FIELD';

/** Typed owner-dashboard failure codes (owner-only, guarded mutation seams). */
export type WorkbenchAdminErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'PROJECT_NOT_FOUND'
  | 'PROJECT_BUSY'
  | 'PROJECT_PENDING_RECOVERY'
  | 'INVITE_INVALID'
  | 'DEVICE_NOT_FOUND'
  | 'SESSION_NOT_FOUND'
  | 'CREDENTIAL_INVALID'
  | 'PROVIDER_VALIDATION_FAILED'
  | 'NETWORK_INVALID'
  | 'CONFIG_INVALID'
  | 'CONFIG_STALE'
  | 'UNKNOWN_FIELD'
  | 'INTERNAL';

/** All configuration/setup/admin error codes, shared by every adapter. */
export type WorkbenchConfigErrorCode = WorkbenchSetupErrorCode | WorkbenchAdminErrorCode;

// ─── Route constants ────────────────────────────────────────────────────────

/** Base path of the pre-start, allowlisted setup surface. */
export const BROWSER_SETUP_BASE_PATH = `${BROWSER_API_BASE_PATH}/setup`;
/** `GET /api/v1/setup/status` — setup wizard status. */
export const BROWSER_SETUP_STATUS_PATH = `${BROWSER_SETUP_BASE_PATH}/status`;

/** Base path of the owner-only admin surface. */
export const BROWSER_ADMIN_BASE_PATH = `${BROWSER_API_BASE_PATH}/admin`;
/** `GET /api/v1/admin/overview` — owner dashboard overview. */
export const BROWSER_ADMIN_OVERVIEW_PATH = `${BROWSER_ADMIN_BASE_PATH}/overview`;
/** `POST|PUT|DELETE /api/v1/admin/projects/:projectId` — project management. */
export const BROWSER_ADMIN_PROJECTS_PATH = `${BROWSER_ADMIN_BASE_PATH}/projects`;
/** `PUT /api/v1/admin/providers/ai-sdk` — provider endpoint/model. */
export const BROWSER_ADMIN_PROVIDER_PATH = `${BROWSER_ADMIN_BASE_PATH}/providers/ai-sdk`;
/** `PUT /api/v1/admin/network` — listener policy. */
export const BROWSER_ADMIN_NETWORK_PATH = `${BROWSER_ADMIN_BASE_PATH}/network`;
/** `POST /api/v1/admin/invites` — access invites. */
export const BROWSER_ADMIN_INVITES_PATH = `${BROWSER_ADMIN_BASE_PATH}/invites`;
/** `POST|GET|DELETE /api/v1/admin/mcp-devices` — MCP device pairing. */
export const BROWSER_ADMIN_DEVICES_PATH = `${BROWSER_ADMIN_BASE_PATH}/mcp-devices`;
/** `GET /api/v1/admin/operations` — audit/pending recovery/Git receipts. */
export const BROWSER_ADMIN_OPERATIONS_PATH = `${BROWSER_ADMIN_BASE_PATH}/operations`;

// ─── Owner-scoped MCP admin tools ───────────────────────────────────────────

/** Scope granted only to owner-issued MCP devices; never implicit with author/submit. */
export const MCP_ADMIN_SCOPE = 'mcp:admin';
/** `nova_admin_config_preview` — owner MCP config preview (no secrets, no paths). */
export const MCP_TOOL_ADMIN_CONFIG_PREVIEW = 'nova_admin_config_preview';
/** `nova_admin_config_apply` — owner MCP config apply with revision CAS. */
export const MCP_TOOL_ADMIN_CONFIG_APPLY = 'nova_admin_config_apply';
