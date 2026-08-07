/**
 * Dependency-free Workbench configuration contracts.
 *
 * These values are configuration-source DTOs, not runtime objects. There is
 * exactly one canonical source shape (`WorkbenchConfigurationV1`); owners
 * serialize it directly and no migration/normalization layer exists.
 *
 * Property declaration order is the canonical JSON order and must be
 * retained by owners when serializing this value.
 */

export const WORKBENCH_CONFIGURATION_VERSION = 1 as const;
export type WorkbenchConfigurationVersion = typeof WORKBENCH_CONFIGURATION_VERSION;

export interface WorkbenchProjectConfigurationV1 {
  readonly projectId: string;
  readonly displayName: string;
  readonly root: string;
  readonly revisionMirror: WorkbenchRevisionMirrorConfigurationV1;
  readonly providerProfile: string;
  readonly trustedPlugins: readonly WorkbenchTrustedPluginConfigurationV1[];
}

export type WorkbenchRevisionMirrorConfigurationV1 =
  | { readonly mode: 'disabled' }
  | { readonly mode: 'git-best-effort'; readonly ref: 'refs/heads/workbench' };

/**
 * Owner-trusted local plugin pinned by exact identity. `required` plugins
 * must load or the project render surface reports a blocking diagnostic;
 * optional plugins that fail to load are disabled and recorded.
 */
export interface WorkbenchTrustedPluginConfigurationV1 {
  readonly name: string;
  readonly version: string;
  readonly moduleHash: string;
  readonly required: boolean;
}

/** Host-wide operation scheduling limits. */
export interface WorkbenchOperationLimitsV1 {
  readonly maxQueuedPerProject: number;
  readonly maxConcurrentRendersPerProject: 1;
  readonly maxConcurrentRendersPerHost: number;
}

/** Built-in Agent limits. */
export interface WorkbenchAgentConfigurationV1 {
  readonly enabled: boolean;
  readonly maxTurns: number;
  readonly maxToolCalls: number;
}

/**
 * Provider profile bound to a project. `'ai-sdk'` is retained for
 * backward compatibility with existing workbench.yaml files; production
 * construction branches on `kind` and treats `'ai-sdk'` as `'pi'` with a
 * one-time warning. Unknown kinds are rejected at validation time.
 */
export interface WorkbenchProviderConfigurationV1 {
  readonly kind: 'ai-sdk' | 'pi';
  readonly baseUrl: string | null;
  readonly model: string | null;
}

export interface WorkbenchNetworkConfigurationV1 {
  readonly mode: 'loopback' | 'lan' | 'unix';
  readonly port: number;
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly unixSocket: string | null;
}

/** Host-wide reference-library quotas. All limits are finite non-negative integers. */
export interface WorkbenchReferenceLimitsV1 {
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

/** Rendering sampling policy applied to every render through the Host. */
export interface WorkbenchRenderPolicyV1 {
  readonly pass1: { readonly temperature: number; readonly maxTokens: number };
  readonly pass2: { readonly temperature: number; readonly maxTokens: number; readonly seed: number };
}

export interface WorkbenchConfigurationV1 {
  readonly version: 1;
  readonly projects: readonly WorkbenchProjectConfigurationV1[];
  readonly defaultProjectId: string | null;
  readonly providers: Readonly<Record<string, WorkbenchProviderConfigurationV1>>;
  readonly network: WorkbenchNetworkConfigurationV1;
  readonly referenceLimits: WorkbenchReferenceLimitsV1;
  readonly operationLimits: WorkbenchOperationLimitsV1;
  readonly agent: WorkbenchAgentConfigurationV1;
  readonly renderPolicy: WorkbenchRenderPolicyV1;
}

export const DEFAULT_WORKBENCH_REFERENCE_LIMITS: WorkbenchReferenceLimitsV1 = {
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
};

export const DEFAULT_WORKBENCH_OPERATION_LIMITS: WorkbenchOperationLimitsV1 = {
  maxQueuedPerProject: 64,
  maxConcurrentRendersPerProject: 1,
  maxConcurrentRendersPerHost: 2,
};

export const DEFAULT_WORKBENCH_AGENT_CONFIGURATION: WorkbenchAgentConfigurationV1 = {
  enabled: false,
  maxTurns: 16,
  maxToolCalls: 64,
};

export const DEFAULT_WORKBENCH_NETWORK: WorkbenchNetworkConfigurationV1 = {
  mode: 'loopback',
  port: 8787,
  allowedHosts: [],
  allowedOrigins: [],
  unixSocket: null,
};

/** Must stay in sync with core's hardcoded sampling defaults (see Stage 1.9/1.10). */
export const DEFAULT_WORKBENCH_RENDER_POLICY: WorkbenchRenderPolicyV1 = {
  pass1: { temperature: 0.8, maxTokens: 10_000 },
  pass2: { temperature: 0.3, maxTokens: 12_000, seed: 42 },
};

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
