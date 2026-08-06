/**
 * Dependency-free Workbench configuration contracts.
 *
 * These values are configuration-source DTOs, not runtime objects. In
 * particular, normalizing a legacy configuration only creates an in-memory
 * V3 value; it never reads or writes the configuration file.
 */

export const WORKBENCH_CONFIGURATION_VERSION_V1 = 1 as const;
export const WORKBENCH_CONFIGURATION_VERSION_V2 = 2 as const;
export const WORKBENCH_CONFIGURATION_VERSION_V3 = 3 as const;
export type WorkbenchConfigurationVersion =
  | typeof WORKBENCH_CONFIGURATION_VERSION_V1
  | typeof WORKBENCH_CONFIGURATION_VERSION_V2
  | typeof WORKBENCH_CONFIGURATION_VERSION_V3;

export interface WorkbenchProjectConfigurationV1 {
  readonly projectId: string;
  readonly displayName: string;
  readonly root: string;
}

export type WorkbenchRevisionMirrorConfigurationV2 =
  | { readonly mode: 'disabled' }
  | { readonly mode: 'git-best-effort'; readonly ref: 'refs/heads/workbench' };

export interface WorkbenchProjectConfigurationV2 {
  readonly projectId: string;
  readonly displayName: string;
  readonly root: string;
  readonly revisionMirror: WorkbenchRevisionMirrorConfigurationV2;
}

/**
 * Owner-trusted local plugin pinned by exact identity. `required` plugins
 * must load or the project render surface reports a blocking diagnostic;
 * optional plugins that fail to load are disabled and recorded.
 */
export interface WorkbenchTrustedPluginConfigurationV3 {
  readonly name: string;
  readonly version: string;
  readonly moduleHash: string;
  readonly required: boolean;
}

/** Canonical V3 project: every project binds an explicit provider profile. */
export interface WorkbenchProjectConfigurationV3 extends WorkbenchProjectConfigurationV2 {
  readonly providerProfile: string;
  readonly trustedPlugins: readonly WorkbenchTrustedPluginConfigurationV3[];
}

/** Host-wide operation scheduling limits introduced by the V3 source contract. */
export interface WorkbenchOperationLimitsV3 {
  readonly maxQueuedPerProject: number;
  readonly maxConcurrentRendersPerProject: 1;
  readonly maxConcurrentRendersPerHost: number;
}

/** Built-in Agent limits introduced by the V3 source contract. */
export interface WorkbenchAgentConfigurationV3 {
  readonly enabled: boolean;
  readonly maxTurns: number;
  readonly maxToolCalls: number;
}

export interface WorkbenchProviderConfigurationV1 {
  readonly kind: 'ai-sdk';
  readonly baseUrl: string | null;
  readonly model: string | null;
}
export type WorkbenchProviderConfigurationV2 = WorkbenchProviderConfigurationV1;

export interface WorkbenchNetworkConfigurationV1 {
  readonly mode: 'loopback' | 'lan' | 'unix';
  readonly port: number;
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly unixSocket: string | null;
}
export type WorkbenchNetworkConfigurationV2 = WorkbenchNetworkConfigurationV1;

/** Host-wide reference-library quotas. All limits are finite non-negative integers. */
export interface WorkbenchReferenceLimitsV2 {
  readonly enabled: boolean;
  readonly maxFileBytes: number;
  readonly maxBytesPerProject: number;
  readonly maxItemsPerProject: number;
  readonly maxPendingJobsPerProject: number;
  readonly maxChunksPerProject: number;
  readonly maxExtractedCharactersPerProject: number;
  readonly maxChunkCharacters: number;
  readonly chunkOverlapCharacters: number;
  readonly extractionTimeoutMs: number;
  readonly mcpImportChunkBytes: number;
}

/** Fixed defaults used when a V1 configuration is normalized in memory. */
export const DEFAULT_WORKBENCH_REFERENCE_LIMITS_V2 = {
  enabled: true,
  maxFileBytes: 104_857_600,
  maxBytesPerProject: 5_368_709_120,
  maxItemsPerProject: 10_000,
  maxPendingJobsPerProject: 4,
  maxChunksPerProject: 1_000_000,
  maxExtractedCharactersPerProject: 2_147_483_648,
  maxChunkCharacters: 12_000,
  chunkOverlapCharacters: 400,
  extractionTimeoutMs: 120_000,
  mcpImportChunkBytes: 1_048_576,
} as const satisfies WorkbenchReferenceLimitsV2;

/** Fixed defaults used when a V1/V2 configuration is normalized in memory. */
export const DEFAULT_WORKBENCH_OPERATION_LIMITS_V3 = {
  maxQueuedPerProject: 64,
  maxConcurrentRendersPerProject: 1,
  maxConcurrentRendersPerHost: 2,
} as const satisfies WorkbenchOperationLimitsV3;

/** Fixed defaults used when a V1/V2 configuration is normalized in memory. */
export const DEFAULT_WORKBENCH_AGENT_CONFIGURATION_V3 = {
  enabled: false,
  maxTurns: 16,
  maxToolCalls: 64,
} as const satisfies WorkbenchAgentConfigurationV3;

/**
 * Legacy source shape. V1 had no per-project mirror policy or reference
 * limits; both are supplied by normalizeWorkbenchConfiguration().
 */
export interface WorkbenchConfigurationV1 {
  readonly version: 1;
  readonly projects: readonly WorkbenchProjectConfigurationV1[];
  readonly defaultProjectId: string | null;
  readonly provider: WorkbenchProviderConfigurationV1 | null;
  readonly network: WorkbenchNetworkConfigurationV1;
}

/**
 * Canonical V2 source shape. Property declaration order is the canonical JSON
 * order and must be retained by owners when serializing this value.
 */
export interface WorkbenchConfigurationV2 {
  readonly version: 2;
  readonly projects: readonly WorkbenchProjectConfigurationV2[];
  readonly defaultProjectId: string | null;
  readonly provider: WorkbenchProviderConfigurationV2 | null;
  readonly network: WorkbenchNetworkConfigurationV2;
  readonly referenceLimits: WorkbenchReferenceLimitsV2;
}

/**
 * Canonical V3 source shape. Property declaration order is the canonical JSON
 * order and must be retained by owners when serializing this value.
 *
 * V3 replaces the single `provider` with a per-profile `providers` map;
 * every project binds exactly one `providerProfile` and an explicit
 * `trustedPlugins` list. V1/V2 remain readable migration inputs and are
 * normalized to V3 by {@link normalizeWorkbenchConfiguration}.
 */
export interface WorkbenchConfigurationV3 {
  readonly version: 3;
  readonly projects: readonly WorkbenchProjectConfigurationV3[];
  readonly defaultProjectId: string | null;
  readonly providers: Readonly<Record<string, WorkbenchProviderConfigurationV2>>;
  readonly network: WorkbenchNetworkConfigurationV2;
  readonly referenceLimits: WorkbenchReferenceLimitsV2;
  readonly operationLimits: WorkbenchOperationLimitsV3;
  readonly agent: WorkbenchAgentConfigurationV3;
}

export type WorkbenchConfigurationInput =
  | WorkbenchConfigurationV1
  | WorkbenchConfigurationV2
  | WorkbenchConfigurationV3;

function copyProvider(
  provider: WorkbenchProviderConfigurationV1 | null,
): WorkbenchProviderConfigurationV2 | null {
  return provider === null
    ? null
    : { kind: provider.kind, baseUrl: provider.baseUrl, model: provider.model };
}

function copyNetwork(network: WorkbenchNetworkConfigurationV1): WorkbenchNetworkConfigurationV2 {
  return {
    mode: network.mode,
    port: network.port,
    allowedHosts: [...network.allowedHosts],
    allowedOrigins: [...network.allowedOrigins],
    unixSocket: network.unixSocket,
  };
}

function copyRevisionMirror(
  mirror: WorkbenchRevisionMirrorConfigurationV2,
): WorkbenchRevisionMirrorConfigurationV2 {
  return mirror.mode === 'git-best-effort'
    ? { mode: 'git-best-effort', ref: mirror.ref }
    : { mode: 'disabled' };
}

/**
 * Normalize any persisted configuration version to canonical V3.
 * This function is pure: it performs no validation, I/O, CAS, or persistence.
 *
 * Migration rules:
 * - The single V1/V2 `provider` becomes `providers.default` (absent when null).
 * - Every legacy project is bound to `providerProfile: 'default'` with no
 *   trusted plugins.
 * - `operationLimits` and `agent` are filled with fixed defaults.
 */
export function normalizeWorkbenchConfiguration(
  configuration: WorkbenchConfigurationInput,
): WorkbenchConfigurationV3 {
  if (configuration.version === 3) {
    return {
      version: 3,
      projects: configuration.projects.map((project) => ({
        projectId: project.projectId,
        displayName: project.displayName,
        root: project.root,
        revisionMirror: copyRevisionMirror(project.revisionMirror),
        providerProfile: project.providerProfile,
        trustedPlugins: project.trustedPlugins.map((plugin) => ({ ...plugin })),
      })),
      defaultProjectId: configuration.defaultProjectId,
      providers: Object.fromEntries(
        Object.entries(configuration.providers).map(([profileId, provider]) => [
          profileId,
          { kind: provider.kind, baseUrl: provider.baseUrl, model: provider.model },
        ]),
      ),
      network: copyNetwork(configuration.network),
      referenceLimits: { ...configuration.referenceLimits },
      operationLimits: { ...configuration.operationLimits },
      agent: { ...configuration.agent },
    };
  }
  const projects = (
    configuration.version === 1
      ? configuration.projects.map((project) => ({
          projectId: project.projectId,
          displayName: project.displayName,
          root: project.root,
          revisionMirror: { mode: 'disabled' } as const,
        }))
      : configuration.projects.map((project) => ({
          projectId: project.projectId,
          displayName: project.displayName,
          root: project.root,
          revisionMirror: copyRevisionMirror(project.revisionMirror),
        }))
  ).map((project) => ({
    ...project,
    providerProfile: 'default' as const,
    trustedPlugins: [],
  }));
  const provider = copyProvider(configuration.provider);
  return {
    version: 3,
    projects,
    defaultProjectId: configuration.defaultProjectId,
    providers: provider === null ? {} : { default: provider },
    network: copyNetwork(configuration.network),
    referenceLimits:
      configuration.version === 1
        ? { ...DEFAULT_WORKBENCH_REFERENCE_LIMITS_V2 }
        : { ...configuration.referenceLimits },
    operationLimits: { ...DEFAULT_WORKBENCH_OPERATION_LIMITS_V3 },
    agent: { ...DEFAULT_WORKBENCH_AGENT_CONFIGURATION_V3 },
  };
}

/** Public mode names shared by nova's standalone and Host client dispatch. */
export const NOVA_EXECUTION_MODE_VALUES = ['standalone', 'via-workbench'] as const;
export type NovaExecutionModeV1 = (typeof NOVA_EXECUTION_MODE_VALUES)[number];

/** Standalone mode carries no Host connection information. */
export interface NovaStandaloneModeV1 {
  readonly mode: 'standalone';
}

/**
 * Explicit Workbench client mode. Credentials are read from the environment
 * by the CLI and therefore never appear in this JSON-safe contract.
 */
export interface NovaViaWorkbenchModeV1 {
  readonly mode: 'via-workbench';
  readonly projectId: string;
  readonly host?: string;
}

export type NovaModeV1 = NovaStandaloneModeV1 | NovaViaWorkbenchModeV1;
export type ViaWorkbenchModeV1 = NovaViaWorkbenchModeV1;
export const WORKBENCH_DEVICE_CREDENTIAL_ENV =
  'NOVALISTICALLY_WORKBENCH_DEVICE_CREDENTIAL' as const;
