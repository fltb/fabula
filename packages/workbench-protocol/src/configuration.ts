/**
 * Dependency-free Workbench configuration contracts.
 *
 * These values are configuration-source DTOs, not runtime objects. In
 * particular, normalizing a legacy configuration only creates an in-memory
 * V2 value; it never reads or writes the configuration file.
 */

export const WORKBENCH_CONFIGURATION_VERSION_V1 = 1 as const;
export const WORKBENCH_CONFIGURATION_VERSION_V2 = 2 as const;
export type WorkbenchConfigurationVersion =
  | typeof WORKBENCH_CONFIGURATION_VERSION_V1
  | typeof WORKBENCH_CONFIGURATION_VERSION_V2;

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

export type WorkbenchConfigurationInput = WorkbenchConfigurationV1 | WorkbenchConfigurationV2;

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

/**
 * Normalize either persisted configuration version to canonical V2.
 * This function is pure: it performs no validation, I/O, CAS, or persistence.
 */
export function normalizeWorkbenchConfiguration(
  configuration: WorkbenchConfigurationInput,
): WorkbenchConfigurationV2 {
  const projects =
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
          revisionMirror:
            project.revisionMirror.mode === 'git-best-effort'
              ? { mode: 'git-best-effort' as const, ref: project.revisionMirror.ref }
              : ({ mode: 'disabled' } as const),
        }));

  return {
    version: 2,
    projects,
    defaultProjectId: configuration.defaultProjectId,
    provider: copyProvider(configuration.provider),
    network: copyNetwork(configuration.network),
    referenceLimits:
      configuration.version === 1
        ? { ...DEFAULT_WORKBENCH_REFERENCE_LIMITS_V2 }
        : { ...configuration.referenceLimits },
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
