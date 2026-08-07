/**
 * Host-only pre-start setup wizard surface.
 *
 * The surface mounts exact `/api/v1/setup/*` routes through the listener's
 * pre-start setup seam and is usable ONLY while the Host is unconfigured
 * (no `workbench.yaml`) AND the running listener is loopback. Every mutation
 * re-checks both conditions at request time; a configured or network-exposed
 * Host answers `SETUP_ALREADY_CONFIGURED` / `SETUP_DISABLED`. The wizard
 * accumulates a secret-free draft candidate in memory (never in YAML, never
 * in SQLite); `finish` validates the assembled candidate and applies it under
 * the revision CAS (`expectedRevision: null`, first setup). Secrets (owner
 * password, provider API key) are handed to their single-purpose stores and
 * never enter the draft, responses, or configuration.
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Handler } from 'hono';
import {
  type AdminNetworkUpdateRequestV1,
  BROWSER_SETUP_BASE_PATH,
  BROWSER_SETUP_STATUS_PATH,
  type ConfigOperationReceiptV1,
  type SetupFinishRequestV1,
  type SetupSaveCredentialRequestV1,
  DEFAULT_WORKBENCH_AGENT_CONFIGURATION,
  DEFAULT_WORKBENCH_NETWORK,
  DEFAULT_WORKBENCH_OPERATION_LIMITS,
  DEFAULT_WORKBENCH_REFERENCE_LIMITS,
  DEFAULT_WORKBENCH_RENDER_POLICY,
  type SetupSaveProjectRequestV1,
  WORKBENCH_CONFIGURATION_VERSION,
  type WorkbenchAdminOverviewV1,
  type WorkbenchConfigurationV1,
  type WorkbenchNetworkReadViewV1,
  type WorkbenchProjectSafeViewV1,
  type WorkbenchProviderReadViewV1,
  type WorkbenchSetupErrorCode,
  type WorkbenchSetupPhaseV1,
  type WorkbenchSetupStatusV1,
} from '../contracts/configuration.js';
import type { LocalAuthService } from './auth/index.js';
import type { ConfigurationChangeService } from './configuration-service.js';
import type { HostListenerMode, SetupHttpMethod } from './listener.js';
import type { ProviderCredentialStore } from './providers/credential-store.js';
import {
  DEFAULT_PROVIDER_PROFILE,
  isValidProviderId,
  providerCredentialKey,
} from './providers/credential-store.js';
import type { HostListenerEnv, HostServer } from './server.js';
import type { RuntimeAdminPort } from './workbench-runtime.js';

/** `/api/v1/setup/owner` — first-run owner account creation. */
export const BROWSER_SETUP_OWNER_PATH = `${BROWSER_SETUP_BASE_PATH}/owner`;
/** `/api/v1/setup/projects/validate` — one-way project root validation. */
export const BROWSER_SETUP_PROJECTS_VALIDATE_PATH = `${BROWSER_SETUP_BASE_PATH}/projects/validate`;
/** `/api/v1/setup/projects` — register a project into the setup draft. */
export const BROWSER_SETUP_PROJECTS_PATH = `${BROWSER_SETUP_BASE_PATH}/projects`;
/** `/api/v1/setup/providers/validate` — provider endpoint/model shape check. */
export const BROWSER_SETUP_PROVIDERS_VALIDATE_PATH = `${BROWSER_SETUP_BASE_PATH}/providers/validate`;
/** `/api/v1/setup/providers/credential` — one-way provider API key write. */
export const BROWSER_SETUP_PROVIDERS_CREDENTIAL_PATH = `${BROWSER_SETUP_BASE_PATH}/providers/credential`;
/** `/api/v1/setup/network` — listener policy step (restart-required at finish). */
export const BROWSER_SETUP_NETWORK_PATH = `${BROWSER_SETUP_BASE_PATH}/network`;
/** `/api/v1/setup/finish` — validate and apply the assembled draft. */
export const BROWSER_SETUP_FINISH_PATH = `${BROWSER_SETUP_BASE_PATH}/finish`;

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

function setupError(code: WorkbenchSetupErrorCode, message: string, status: number): Response {
  return json({ error: { code, message } }, status);
}

const SETUP_ERROR_STATUS: Readonly<Record<WorkbenchSetupErrorCode, number>> = {
  SETUP_DISABLED: 403,
  SETUP_ALREADY_CONFIGURED: 409,
  SETUP_INVALID_INPUT: 400,
  OWNER_EXISTS: 409,
  PROJECT_INVALID_ROOT: 400,
  PROJECT_DUPLICATE_ID: 409,
  PROJECT_NOT_ACCESSIBLE: 400,
  PROVIDER_VALIDATION_FAILED: 400,
  CREDENTIAL_INVALID: 400,
  NETWORK_INVALID: 400,
  CONFIG_INVALID: 400,
  CONFIG_STALE: 409,
  UNKNOWN_FIELD: 400,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Strict body parse: reject unknown fields and non-1 versions. */
function parseRequest(
  body: unknown,
  expectedKeys: readonly string[],
  where: string,
): Record<string, unknown> | null {
  if (!isRecord(body)) return null;
  if (body.version !== WORKBENCH_CONFIGURATION_VERSION) return null;
  for (const key of Object.keys(body)) {
    if (key !== 'version' && !expectedKeys.includes(key)) return null;
  }
  void where;
  return body;
}

function _firstDiagnostic(diagnostics: readonly { code: string; message: string }[]): string {
  return diagnostics[0]?.code ?? 'CONFIG_INVALID';
}

function firstDiagnosticMessage(diagnostics: readonly { code: string; message: string }[]): string {
  return diagnostics[0]?.message ?? 'The configuration is invalid.';
}

// ─── Secret-free masking ─────────────────────────────────────────────────────

/** Mask a provider endpoint to its origin; never reveals paths/query/keys. */
export function maskEndpoint(baseUrl: string | null): string | null {
  if (baseUrl === null || baseUrl === '') return null;
  try {
    const url = new URL(baseUrl);
    const port = url.port === '' ? '' : `:${url.port}`;
    return `${url.protocol}//${url.hostname}${port}/***`;
  } catch {
    return '***';
  }
}

/** Mask a model name for read DTOs. */
export function maskModel(model: string | null): string | null {
  if (model === null || model === '') return null;
  if (model.length <= 4) return '*'.repeat(model.length);
  return `${model.slice(0, 2)}${'*'.repeat(Math.min(4, model.length - 3))}${model.slice(-1)}`;
}

// ─── Setup status builder (shared with the admin overview) ───────────────────

export interface SetupStatusBuilderOptions {
  readonly configuration: ConfigurationChangeService;
  readonly credentials: ProviderCredentialStore;
  readonly auth: LocalAuthService;
  readonly listenerMode: () => HostListenerMode;
  readonly runtime?: RuntimeAdminPort | null;
  readonly now?: () => string;
}

/** In-memory wizard draft override; absent for post-setup status reads. */
export interface SetupDraftView {
  readonly configuration: WorkbenchConfigurationV1;
  readonly networkApplied: boolean;
}

export interface SetupStatusBuilder {
  build(draft?: SetupDraftView | null): Promise<WorkbenchSetupStatusV1>;
  overview(input: {
    readonly draft?: SetupDraftView | null;
    readonly restartRequired: boolean;
    readonly workerReady: boolean;
    readonly ownerProfile: {
      readonly displayName: string;
      readonly capabilityVersion: number;
    } | null;
  }): Promise<WorkbenchAdminOverviewV1>;
}

function deriveSetupPhase(input: {
  readonly configurationPresent: boolean;
  readonly ownerCreated: boolean;
  readonly projects: readonly WorkbenchProjectSafeViewV1[];
  readonly providerConfigured: boolean;
  readonly draftActive: boolean;
  readonly networkApplied: boolean;
}): WorkbenchSetupPhaseV1 {
  if (!input.ownerCreated) return 'unconfigured';
  if (!input.configurationPresent) {
    if (!input.draftActive) return 'owner-pending';
    if (input.projects.length === 0) return 'project-pending';
    if (!input.providerConfigured) return 'provider-pending';
    return 'network-pending';
  }
  if (input.projects.length === 0) return 'project-pending';
  if (!input.providerConfigured) return 'provider-pending';
  if (input.draftActive && !input.networkApplied) return 'network-pending';
  return 'ready';
}

/**
 * Build the browser-safe setup/readiness status. Configuration, credential
 * readiness and auth state are re-derived on every call; the phase is derived
 * from the same facts so it cannot drift from the file.
 */
export function createSetupStatusBuilder(options: SetupStatusBuilderOptions): SetupStatusBuilder {
  const now = options.now ?? (() => new Date().toISOString());

  async function build(draft?: SetupDraftView | null): Promise<WorkbenchSetupStatusV1> {
    const active = await options.configuration.readActive();
    const configurationPresent = active !== null;
    const ownerCreated = (await options.auth.getAuthState()).ownerExists;
    const effective: WorkbenchConfigurationV1 | null =
      draft !== null && draft !== undefined ? draft.configuration : (active?.configuration ?? null);

    const projects: WorkbenchProjectSafeViewV1[] =
      effective === null
        ? []
        : effective.projects.map((project) => ({
            projectId: project.projectId,
            displayName: project.displayName,
            validation: 'valid' as const,
            open: options.runtime?.isOpen(project.projectId) ?? false,
            defaultProject: project.projectId === effective.defaultProjectId,
          }));

    const providerConfiguration =
      effective === null ? null : (effective.providers.default ?? null);
    const providerConfigured =
      providerConfiguration != null &&
      (await options.credentials.get(providerCredentialKey(DEFAULT_PROVIDER_PROFILE))) !== null;
    const provider: WorkbenchProviderReadViewV1 | null =
      providerConfiguration == null
        ? null
        : {
            kind: 'ai-sdk',
            configured: providerConfigured,
            endpoint: maskEndpoint(providerConfiguration.baseUrl),
            model: maskModel(providerConfiguration.model),
            lastValidation: providerConfigured ? 'valid' : 'unvalidated',
            lastValidatedAt: null,
          };

    const network = effective === null ? null : effective.network;
    const networkView: WorkbenchNetworkReadViewV1 = {
      mode: network?.mode ?? 'loopback',
      port: network?.port ?? 8787,
      allowedHosts: network === null ? [] : [...network.allowedHosts],
      allowedOrigins: network === null ? [] : [...network.allowedOrigins],
      unixSocket: network?.unixSocket != null,
      listenerActive: network === null ? true : options.listenerMode() === network.mode,
      restartRequired: false,
    };

    const draftActive = draft !== null && draft !== undefined;
    return {
      version: WORKBENCH_CONFIGURATION_VERSION,
      phase: deriveSetupPhase({
        configurationPresent,
        ownerCreated,
        projects,
        providerConfigured,
        draftActive,
        networkApplied: draftActive ? draft.networkApplied : true,
      }),
      configurationPresent,
      configurationRevision: active?.revision ?? null,
      ownerCreated,
      projects,
      defaultProjectId: effective?.defaultProjectId ?? null,
      provider,
      network: networkView,
      generatedAt: now(),
    };
  }

  async function overview(input: {
    readonly draft?: SetupDraftView | null;
    readonly restartRequired: boolean;
    readonly workerReady: boolean;
    readonly ownerProfile: {
      readonly displayName: string;
      readonly capabilityVersion: number;
    } | null;
  }): Promise<WorkbenchAdminOverviewV1> {
    const setup = await build(input.draft ?? null);
    const hostStatus: WorkbenchAdminOverviewV1['hostStatus'] = !setup.configurationPresent
      ? 'setup'
      : input.restartRequired
        ? 'restart-required'
        : 'ready';
    return {
      version: WORKBENCH_CONFIGURATION_VERSION,
      setup,
      hostStatus,
      owner: input.ownerProfile,
      workerReady: input.workerReady,
      openProjects: options.runtime?.listOpen().length ?? 0,
      restartRequired: input.restartRequired,
      generatedAt: now(),
    };
  }

  return { build, overview };
}

// ─── Setup surface ───────────────────────────────────────────────────────────

export interface SetupApiOptions extends SetupStatusBuilderOptions {
  readonly configuration: ConfigurationChangeService;
  readonly auth: LocalAuthService;
  readonly credentials: ProviderCredentialStore;
  readonly listenerMode: () => HostListenerMode;
  /** Directory that resolves `unixSocketName` into an absolute socket path. */
  readonly unixSocketDir?: string;
  readonly now?: () => string;
  readonly newId?: () => string;
}

export interface SetupApiSurface {
  readonly routes: readonly {
    readonly method: SetupHttpMethod;
    readonly path: string;
    readonly handler: Handler<HostListenerEnv>;
  }[];
  register(host: HostServer): void;
}

interface SetupDraftState {
  configuration: WorkbenchConfigurationV1;
  networkApplied: boolean;
}

const EMPTY_DRAFT: SetupDraftState = {
  configuration: {
    version: 1,
    projects: [],
    defaultProjectId: null,
    providers: {},
    network: { ...DEFAULT_WORKBENCH_NETWORK },
    referenceLimits: { ...DEFAULT_WORKBENCH_REFERENCE_LIMITS },
    operationLimits: { ...DEFAULT_WORKBENCH_OPERATION_LIMITS },
    agent: { ...DEFAULT_WORKBENCH_AGENT_CONFIGURATION },
    renderPolicy: { ...DEFAULT_WORKBENCH_RENDER_POLICY },
  },
  networkApplied: false,
};

const SOCKET_NAME_PATTERN = /^[a-zA-Z0-9._-]{1,128}$/;

function isLoopback(mode: HostListenerMode): boolean {
  return mode === 'loopback';
}

/**
 * Create the pre-start setup surface. `register` mounts every route through
 * the listener's setup seam; all gating (unconfigured + loopback) happens per
 * request, so an already-configured or LAN-exposed Host never serves setup
 * mutations even if a route was registered before start.
 */
export function createSetupApi(options: SetupApiOptions): SetupApiSurface {
  const statusBuilder = createSetupStatusBuilder(options);
  const _newId = options.newId ?? randomUUID;
  let draft: SetupDraftState | null = null;

  async function guardMutation(): Promise<Response | null> {
    if (!isLoopback(options.listenerMode())) {
      return setupError('SETUP_DISABLED', 'Setup is only available on the loopback listener.', 403);
    }
    const present = await options.configuration.readActive();
    if (present !== null) {
      return setupError(
        'SETUP_ALREADY_CONFIGURED',
        'The Host is already configured; setup is closed.',
        409,
      );
    }
    return null;
  }

  async function bodyObject(request: Request): Promise<unknown> {
    return request.json().catch(() => null);
  }

  function statusHandler(): Handler<HostListenerEnv> {
    return async (c) => {
      const status = await statusBuilder.build(draft);
      return c.json(status);
    };
  }

  function ownerHandler(): Handler<HostListenerEnv> {
    return async (c) => {
      const denied = await guardMutation();
      if (denied !== null) return denied;
      const body = await bodyObject(c.req.raw);
      const parsed = parseRequest(body, ['password', 'displayName'], 'owner');
      if (parsed === null || typeof parsed.password !== 'string' || parsed.password.length < 12) {
        return setupError(
          'SETUP_INVALID_INPUT',
          'owner requires a password of at least 12 characters and no unknown fields.',
          400,
        );
      }
      if (parsed.displayName !== undefined && typeof parsed.displayName !== 'string') {
        return setupError('SETUP_INVALID_INPUT', 'displayName must be a string.', 400);
      }
      try {
        const result = await options.auth.bootstrapOwner({
          password: parsed.password,
          displayName: typeof parsed.displayName === 'string' ? parsed.displayName : 'Owner',
        });
        return json({
          version: WORKBENCH_CONFIGURATION_VERSION,
          sessionId: result.session.sessionId,
          userId: result.user.userId,
          displayName: result.user.displayName,
        });
      } catch (error) {
        if ((error as { code?: string }).code === 'OWNER_EXISTS') {
          return setupError('OWNER_EXISTS', 'An owner account already exists.', 409);
        }
        return setupError('SETUP_INVALID_INPUT', 'The owner account could not be created.', 400);
      }
    };
  }

  function validateProjectHandler(): Handler<HostListenerEnv> {
    return async (c) => {
      const denied = await guardMutation();
      if (denied !== null) return denied;
      const body = await bodyObject(c.req.raw);
      const parsed = parseRequest(body, ['projectId', 'displayName', 'root'], 'projects/validate');
      if (parsed === null) {
        return setupError(
          'UNKNOWN_FIELD',
          'projects/validate accepts only projectId, displayName, root.',
          400,
        );
      }
      const projectId = typeof parsed.projectId === 'string' ? parsed.projectId : '';
      const displayName = typeof parsed.displayName === 'string' ? parsed.displayName : '';
      const root = typeof parsed.root === 'string' ? parsed.root : '';
      const candidate: WorkbenchConfigurationV1 = {
        ...(draft?.configuration ?? EMPTY_DRAFT.configuration),
        projects: [
          ...(draft?.configuration.projects ?? []),
          {
            projectId,
            displayName,
            root,
            revisionMirror: { mode: 'disabled' },
            providerProfile: DEFAULT_PROVIDER_PROFILE,
            trustedPlugins: [],
          },
        ],
        defaultProjectId: null,
      };
      const result = await options.configuration.validateCandidate(candidate);
      if (!result.ok) {
        const first = result.diagnostics[0];
        const code =
          first !== undefined && first.code in SETUP_ERROR_STATUS
            ? (first.code as WorkbenchSetupErrorCode)
            : 'CONFIG_INVALID';
        return setupError(
          code,
          firstDiagnosticMessage(result.diagnostics),
          SETUP_ERROR_STATUS[code],
        );
      }
      return json({
        version: WORKBENCH_CONFIGURATION_VERSION,
        projectId,
        validation: 'valid',
      });
    };
  }

  function saveProjectHandler(): Handler<HostListenerEnv> {
    return async (c) => {
      const denied = await guardMutation();
      if (denied !== null) return denied;
      const body = await bodyObject(c.req.raw);
      const parsed = parseRequest(body, ['projectId', 'displayName', 'root'], 'projects');
      if (parsed === null) {
        return setupError(
          'UNKNOWN_FIELD',
          'projects accepts only projectId, displayName, root.',
          400,
        );
      }
      const projectId = typeof parsed.projectId === 'string' ? parsed.projectId : '';
      const displayName = typeof parsed.displayName === 'string' ? parsed.displayName : '';
      const root = typeof parsed.root === 'string' ? parsed.root : '';
      const base = draft ?? structuredClone(EMPTY_DRAFT);
      if (base.configuration.projects.some((project) => project.projectId === projectId)) {
        return setupError(
          'PROJECT_DUPLICATE_ID',
          `Project "${projectId}" is already registered.`,
          409,
        );
      }
      const candidate: WorkbenchConfigurationV1 = {
        ...base.configuration,
        projects: [
          ...base.configuration.projects,
          {
            projectId,
            displayName,
            root,
            revisionMirror: { mode: 'disabled' },
            providerProfile: DEFAULT_PROVIDER_PROFILE,
            trustedPlugins: [],
          },
        ],
        defaultProjectId: base.configuration.defaultProjectId ?? projectId,
      };
      const result = await options.configuration.validateCandidate(candidate);
      if (!result.ok) {
        const first = result.diagnostics[0];
        const code =
          first !== undefined && first.code in SETUP_ERROR_STATUS
            ? (first.code as WorkbenchSetupErrorCode)
            : 'CONFIG_INVALID';
        return setupError(
          code,
          firstDiagnosticMessage(result.diagnostics),
          SETUP_ERROR_STATUS[code],
        );
      }
      draft = { ...base, configuration: candidate };
      return json({
        version: WORKBENCH_CONFIGURATION_VERSION,
        projectId,
        validation: 'valid',
        defaultProject: candidate.defaultProjectId === projectId,
      });
    };
  }

  function validateProviderHandler(): Handler<HostListenerEnv> {
    return async (c) => {
      const denied = await guardMutation();
      if (denied !== null) return denied;
      const body = await bodyObject(c.req.raw);
      const parsed = parseRequest(body, ['kind', 'baseUrl', 'model'], 'providers/validate');
      if (parsed === null || parsed.kind !== 'ai-sdk') {
        return setupError(
          'CONFIG_INVALID',
          'providers/validate accepts only kind "ai-sdk", baseUrl, model.',
          400,
        );
      }
      const baseUrl =
        parsed.baseUrl === null || typeof parsed.baseUrl === 'string' ? parsed.baseUrl : null;
      const model = parsed.model === null || typeof parsed.model === 'string' ? parsed.model : null;
      if (baseUrl !== null && baseUrl !== '' && !/^https?:\/\//.test(baseUrl)) {
        return setupError('CONFIG_INVALID', 'baseUrl must be an http(s) URL or null.', 400);
      }
      const base = draft ?? structuredClone(EMPTY_DRAFT);
      draft = {
        ...base,
        configuration: {
          ...base.configuration,
          providers: {
            ...base.configuration.providers,
            [DEFAULT_PROVIDER_PROFILE]: {
              kind: 'pi',
              baseUrl: baseUrl === '' ? null : baseUrl,
              model: model === '' ? null : model,
            },
          },
        },
      };
      return json({
        version: WORKBENCH_CONFIGURATION_VERSION,
        kind: 'ai-sdk',
        validation: 'valid',
      });
    };
  }

  function saveCredentialHandler(): Handler<HostListenerEnv> {
    return async (c) => {
      const denied = await guardMutation();
      if (denied !== null) return denied;
      const body = await bodyObject(c.req.raw);
      const parsed = parseRequest(body, ['providerId', 'apiKey'], 'providers/credential');
      if (parsed === null) {
        return setupError(
          'UNKNOWN_FIELD',
          'providers/credential accepts only providerId and apiKey.',
          400,
        );
      }
      const providerId = typeof parsed.providerId === 'string' ? parsed.providerId : '';
      const apiKey = typeof parsed.apiKey === 'string' ? parsed.apiKey : '';
      if (!isValidProviderId(providerId) || apiKey.length === 0) {
        return setupError(
          'CREDENTIAL_INVALID',
          'A valid providerId and a non-empty apiKey are required.',
          400,
        );
      }
      try {
        // The setup wizard configures the default provider profile; the legacy
        // `ai-sdk` wire id maps to the canonical `ai-sdk:default` key.
        const credentialKey =
          providerId === 'ai-sdk' ? providerCredentialKey(DEFAULT_PROVIDER_PROFILE) : providerId;
        await options.credentials.set(credentialKey, apiKey);
      } catch {
        return setupError('CREDENTIAL_INVALID', 'The credential could not be stored.', 400);
      }
      return json({
        version: WORKBENCH_CONFIGURATION_VERSION,
        providerId,
        configured: true,
      });
    };
  }

  function applyNetworkHandler(): Handler<HostListenerEnv> {
    return async (c) => {
      const denied = await guardMutation();
      if (denied !== null) return denied;
      const body = await bodyObject(c.req.raw);
      const parsed = parseRequest(
        body,
        ['mode', 'port', 'allowedHosts', 'allowedOrigins', 'unixSocketName'],
        'network',
      );
      if (parsed === null) {
        return setupError(
          'UNKNOWN_FIELD',
          'network accepts only mode, port, allowedHosts, allowedOrigins, unixSocketName.',
          400,
        );
      }
      const resolved = resolveNetworkRequest(parsed, options.unixSocketDir);
      if (!resolved.ok) return setupError('NETWORK_INVALID', resolved.message, 400);
      const base = draft ?? structuredClone(EMPTY_DRAFT);
      const network = resolved.network;
      const candidate: WorkbenchConfigurationV1 = { ...base.configuration, network };
      const result = await options.configuration.validateCandidate(candidate);
      if (!result.ok) {
        return setupError('NETWORK_INVALID', firstDiagnosticMessage(result.diagnostics), 400);
      }
      draft = { ...base, configuration: candidate, networkApplied: true };
      return json({
        version: WORKBENCH_CONFIGURATION_VERSION,
        mode: network.mode,
        port: network.port,
        restartRequired: true,
      });
    };
  }

  function finishHandler(): Handler<HostListenerEnv> {
    return async (c) => {
      const denied = await guardMutation();
      if (denied !== null) return denied;
      const body = await bodyObject(c.req.raw);
      const parsed = parseRequest(body, ['expectedRevision'], 'finish');
      if (parsed === null) {
        return setupError('UNKNOWN_FIELD', 'finish accepts only expectedRevision.', 400);
      }
      const expectedRevision =
        parsed.expectedRevision === null || typeof parsed.expectedRevision === 'string'
          ? parsed.expectedRevision
          : undefined;
      if (draft === null || !draft.networkApplied) {
        return setupError(
          'SETUP_INVALID_INPUT',
          'The setup draft is incomplete; complete every step before finishing.',
          400,
        );
      }
      const candidate = draft.configuration;
      const validated = await options.configuration.validateCandidate(candidate);
      if (!validated.ok) {
        const first = validated.diagnostics[0];
        const code =
          first !== undefined && first.code in SETUP_ERROR_STATUS
            ? (first.code as WorkbenchSetupErrorCode)
            : 'CONFIG_INVALID';
        return setupError(
          code,
          firstDiagnosticMessage(validated.diagnostics),
          SETUP_ERROR_STATUS[code],
        );
      }
      const receipt = await options.configuration.apply({
        candidate,
        expectedRevision: expectedRevision ?? null,
        origin: 'setup',
      });
      if (receipt.status === 'stale') {
        return setupError(
          'CONFIG_STALE',
          'The configuration changed during setup; re-read and retry.',
          409,
        );
      }
      if (receipt.status === 'invalid') {
        return setupError('CONFIG_INVALID', firstDiagnosticMessage(receipt.diagnostics), 400);
      }
      draft = null;
      return json({ version: WORKBENCH_CONFIGURATION_VERSION, receipt });
    };
  }

  const routes: SetupApiSurface['routes'] = [
    { method: 'GET', path: BROWSER_SETUP_STATUS_PATH, handler: statusHandler() },
    { method: 'POST', path: BROWSER_SETUP_OWNER_PATH, handler: ownerHandler() },
    {
      method: 'POST',
      path: BROWSER_SETUP_PROJECTS_VALIDATE_PATH,
      handler: validateProjectHandler(),
    },
    { method: 'POST', path: BROWSER_SETUP_PROJECTS_PATH, handler: saveProjectHandler() },
    {
      method: 'POST',
      path: BROWSER_SETUP_PROVIDERS_VALIDATE_PATH,
      handler: validateProviderHandler(),
    },
    {
      method: 'POST',
      path: BROWSER_SETUP_PROVIDERS_CREDENTIAL_PATH,
      handler: saveCredentialHandler(),
    },
    { method: 'POST', path: BROWSER_SETUP_NETWORK_PATH, handler: applyNetworkHandler() },
    { method: 'POST', path: BROWSER_SETUP_FINISH_PATH, handler: finishHandler() },
  ];

  return {
    routes,
    register(host: HostServer): void {
      for (const route of routes) {
        host.registerSetupRoute(route.method, route.path, route.handler);
      }
    },
  };
}

/** Resolve an `AdminNetworkUpdateRequestV1` into an absolute-policy configuration network. */
export function resolveNetworkRequest(
  request: Record<string, unknown>,
  unixSocketDir: string | undefined,
):
  | { readonly ok: true; readonly network: WorkbenchConfigurationV1['network'] }
  | {
      readonly ok: false;
      readonly message: string;
    } {
  const mode = request.mode;
  if (mode !== 'loopback' && mode !== 'lan' && mode !== 'unix') {
    return { ok: false, message: 'network.mode must be loopback, lan or unix.' };
  }
  const port = request.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) {
    return { ok: false, message: 'network.port must be an integer between 0 and 65535.' };
  }
  const allowedHosts = request.allowedHosts;
  const allowedOrigins = request.allowedOrigins;
  if (
    !Array.isArray(allowedHosts) ||
    allowedHosts.some((entry) => typeof entry !== 'string') ||
    !Array.isArray(allowedOrigins) ||
    allowedOrigins.some((entry) => typeof entry !== 'string')
  ) {
    return { ok: false, message: 'allowedHosts and allowedOrigins must be arrays of strings.' };
  }
  const unixSocketName = request.unixSocketName;
  if (unixSocketName !== null && typeof unixSocketName !== 'string') {
    return { ok: false, message: 'unixSocketName must be a string or null.' };
  }
  if (mode === 'unix') {
    if (typeof unixSocketName !== 'string' || !SOCKET_NAME_PATTERN.test(unixSocketName)) {
      return { ok: false, message: 'unixSocketName is required and must be a plain file name.' };
    }
    if (unixSocketDir === undefined) {
      return { ok: false, message: 'The Host does not accept unix socket configuration.' };
    }
    return {
      ok: true,
      network: {
        mode,
        port,
        allowedHosts: [...(allowedHosts as string[])],
        allowedOrigins: [...(allowedOrigins as string[])],
        unixSocket: join(unixSocketDir, unixSocketName),
      },
    };
  }
  if (unixSocketName !== null) {
    return { ok: false, message: 'unixSocketName must be null unless mode is "unix".' };
  }
  return {
    ok: true,
    network: {
      mode,
      port,
      allowedHosts: [...(allowedHosts as string[])],
      allowedOrigins: [...(allowedOrigins as string[])],
      unixSocket: null,
    },
  };
}

export type {
  AdminNetworkUpdateRequestV1 as SetupNetworkInput,
  ConfigOperationReceiptV1,
  SetupFinishRequestV1 as SetupFinishInput,
  SetupSaveCredentialRequestV1 as SetupCredentialInput,
  SetupSaveProjectRequestV1 as SetupProjectInput,
};
