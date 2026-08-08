/**
 * Host-only versioned `workbench.yaml` file store.
 *
 * This module is the ONLY reader/writer of the secret-free Host configuration
 * source of truth. It owns the file path resolution under the resolved
 * `WORKBENCH_HOME`, the strict schema validation of the version-1 YAML shape,
 * the content-hash revision identity, the atomic 0600 temp-write + rename, and
 * the debounced external-change watcher. It deliberately holds no SQLite, no
 * `.env` access, and no credential material: configuration content never
 * crosses into persistence, and secrets never enter this file.
 *
 * The pure validation here accepts only the exact `WorkbenchConfigurationV1`
 * wire shape (rejecting unknown fields anywhere), so a hand-edited file that
 * adds a stray key is reported as `UNKNOWN_FIELD` instead of being silently
 * re-serialized into a different document.
 */

import { createHash, randomBytes } from 'node:crypto';
import { type FSWatcher, mkdirSync, watch } from 'node:fs';
import {
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  WORKBENCH_CONFIGURATION_VERSION,
  type WorkbenchAgentConfigurationV1,
  type WorkbenchConfigurationVersion,
  type WorkbenchConfigurationV1,
  type WorkbenchNetworkConfigurationV1,
  type WorkbenchOperationLimitsV1,
  type WorkbenchProjectConfigurationV1,
  type WorkbenchProviderConfigurationV1,
  type WorkbenchReferenceLimitsV1,
  type WorkbenchRenderPolicyV1,
  type WorkbenchRevisionMirrorConfigurationV1,
  type WorkbenchTrustedPluginConfigurationV1,
} from '@novalistically/workbench-protocol';
import YAML from 'yaml';
import { type ConfigOperationDiagnosticV1 } from '../contracts/configuration.js';

// ─── Host home resolution ────────────────────────────────────────────────────

/** Environment inputs used to resolve the Host home directory. */
export interface WorkbenchHomeEnv {
  readonly WORKBENCH_HOME?: string;
  readonly XDG_STATE_HOME?: string;
  readonly HOME?: string;
}

/**
 * Resolve the Host home directory: `WORKBENCH_HOME` when set, otherwise
 * `$XDG_STATE_HOME/fabula/workbench`, otherwise `$HOME/.local/state/fabula/workbench`.
 * Returns null when no source is available; the caller decides whether an
 * unresolvable home blocks process startup.
 */
export function resolveWorkbenchHome(env: WorkbenchHomeEnv = process.env): string | null {
  const override = env.WORKBENCH_HOME;
  if (override !== undefined && override.trim() !== '') return resolve(override.trim());
  const xdg = env.XDG_STATE_HOME;
  if (xdg !== undefined && xdg.trim() !== '') {
    return resolve(xdg.trim(), 'fabula', 'workbench');
  }
  const home = env.HOME;
  if (home === undefined || home.trim() === '') return null;
  return resolve(home.trim(), '.local', 'state', 'fabula', 'workbench');
}
const NETWORK_KEYS = ['mode', 'port', 'allowedHosts', 'allowedOrigins', 'unixSocket'] as const;
const PROVIDER_KEYS = [
  'kind',
  'baseUrl',
  'model',
  'reasoning',
  'contextWindow',
  'maxTokens',
  'headers',
] as const;
const PROJECT_KEYS = [
  'projectId',
  'displayName',
  'revisionMirror',
  'providerProfile',
  'trustedPlugins',
] as const;
const TRUSTED_PLUGIN_KEYS = ['name', 'version', 'moduleHash', 'required'] as const;
const OPERATION_LIMIT_KEYS = [
  'maxQueuedPerProject',
  'maxConcurrentRendersPerProject',
  'maxConcurrentRendersPerHost',
] as const;
const AGENT_KEYS = ['enabled', 'maxTurns', 'maxToolCalls'] as const;
const REFERENCE_LIMIT_KEYS = [
  'enabled',
  'maxFileBytes',
  'maxBytesPerProject',
  'maxItemsPerProject',
  'maxPendingJobsPerProject',
  'maxChunksPerProject',
  'maxExtractedCharactersPerProject',
  'maxChunkCharacters',
  'chunkOverlapCharacters',
  'extractionTimeoutMs',
  'mcpImportChunkBytes',
] as const;
const CONFIGURATION_KEYS = [
  'version',
  'projects',
  'defaultProjectId',
  'providers',
  'network',
  'referenceLimits',
  'operationLimits',
  'agent',
  'renderPolicy',
] as const;
const RENDER_POLICY_KEYS = ['pass1', 'pass2'] as const;
const RENDER_PASS_KEYS = ['temperature', 'maxTokens'] as const;
const RENDER_PASS2_KEYS = ['temperature', 'maxTokens', 'seed'] as const;

/** Stable plain-object projection; key order is the canonical V1 YAML order. */
function toPlain(configuration: WorkbenchConfigurationV1): Record<string, unknown> {
  return {
    version: WORKBENCH_CONFIGURATION_VERSION,
    projects: configuration.projects.map((project) => ({
      projectId: project.projectId,
      displayName: project.displayName,
      revisionMirror:
        project.revisionMirror.mode === 'git-best-effort'
          ? { mode: project.revisionMirror.mode, ref: project.revisionMirror.ref }
          : { mode: project.revisionMirror.mode },
      providerProfile: project.providerProfile,
      trustedPlugins: project.trustedPlugins.map((plugin) => ({
        name: plugin.name,
        version: plugin.version,
        moduleHash: plugin.moduleHash,
        required: plugin.required,
      })),
    })),
    defaultProjectId: configuration.defaultProjectId,
    providers: Object.fromEntries(
      Object.entries(configuration.providers).map(([profileId, provider]) => [
        profileId,
        {
          kind: provider.kind,
          baseUrl: provider.baseUrl,
          model: provider.model,
          ...(provider.reasoning === undefined ? {} : { reasoning: provider.reasoning }),
          ...(provider.contextWindow === undefined
            ? {}
            : { contextWindow: provider.contextWindow }),
          ...(provider.maxTokens === undefined ? {} : { maxTokens: provider.maxTokens }),
          ...(provider.headers === undefined ? {} : { headers: { ...provider.headers } }),
        },
      ]),
    ),
    network: {
      mode: configuration.network.mode,
      port: configuration.network.port,
      allowedHosts: [...configuration.network.allowedHosts],
      allowedOrigins: [...configuration.network.allowedOrigins],
      unixSocket: configuration.network.unixSocket,
    },
    referenceLimits: {
      enabled: configuration.referenceLimits.enabled,
      maxFileBytes: configuration.referenceLimits.maxFileBytes,
      maxBytesPerProject: configuration.referenceLimits.maxBytesPerProject,
      maxItemsPerProject: configuration.referenceLimits.maxItemsPerProject,
      maxPendingJobsPerProject: configuration.referenceLimits.maxPendingJobsPerProject,
      maxChunksPerProject: configuration.referenceLimits.maxChunksPerProject,
      maxExtractedCharactersPerProject:
        configuration.referenceLimits.maxExtractedCharactersPerProject,
      maxChunkCharacters: configuration.referenceLimits.maxChunkCharacters,
      chunkOverlapCharacters: configuration.referenceLimits.chunkOverlapCharacters,
      extractionTimeoutMs: configuration.referenceLimits.extractionTimeoutMs,
      mcpImportChunkBytes: configuration.referenceLimits.mcpImportChunkBytes,
    },
    operationLimits: {
      maxQueuedPerProject: configuration.operationLimits.maxQueuedPerProject,
      maxConcurrentRendersPerProject: configuration.operationLimits.maxConcurrentRendersPerProject,
      maxConcurrentRendersPerHost: configuration.operationLimits.maxConcurrentRendersPerHost,
    },
    agent: {
      enabled: configuration.agent.enabled,
      maxTurns: configuration.agent.maxTurns,
      maxToolCalls: configuration.agent.maxToolCalls,
    },
    renderPolicy: {
      pass1: {
        temperature: configuration.renderPolicy.pass1.temperature,
        maxTokens: configuration.renderPolicy.pass1.maxTokens,
      },
      pass2: {
        temperature: configuration.renderPolicy.pass2.temperature,
        maxTokens: configuration.renderPolicy.pass2.maxTokens,
        seed: configuration.renderPolicy.pass2.seed,
      },
    },
  };
}

/** Serialize the canonical configuration to YAML; this never writes to disk. */
export function serializeConfigurationYaml(configuration: WorkbenchConfigurationV1): string {
  return YAML.stringify(toPlain(configuration), { lineWidth: 0 });
}

/** Content-hash revision of a configuration's canonical YAML bytes. */
export function configurationRevision(configuration: WorkbenchConfigurationV1): string {
  return createHash('sha256')
    .update(serializeConfigurationYaml(configuration), 'utf8')
    .digest('hex');
}

// ─── Strict shape validation ─────────────────────────────────────────────────

const PROJECT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const LOOPBACK_MODES: readonly string[] = ['loopback', 'lan', 'unix'];

export type ConfigurationShapeResult =
  | { readonly ok: true; readonly configuration: WorkbenchConfigurationV1 }
  | { readonly ok: false; readonly diagnostics: readonly ConfigOperationDiagnosticV1[] };

function diagnostic(code: string, message: string): ConfigOperationDiagnosticV1 {
  return { code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
  diagnostics: ConfigOperationDiagnosticV1[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      diagnostics.push(diagnostic('UNKNOWN_FIELD', `Unknown field "${key}" in ${where}.`));
    }
  }
}

function stringField(
  value: Record<string, unknown>,
  key: string,
  where: string,
  diagnostics: ConfigOperationDiagnosticV1[],
): string | null {
  const raw = value[key];
  if (typeof raw !== 'string') {
    diagnostics.push(diagnostic('CONFIG_INVALID', `Field "${where}.${key}" must be a string.`));
    return null;
  }
  return raw;
}

/**
 * Trusted plugin identities are exact-match keys into the Host-discovered
 * set; they must be non-empty and pathless. Rejects upload-style values, URLs
 * (scheme/authority) and arbitrary module paths in `name`, `version` or
 * `moduleHash` before any identity can enter an allowlist.
 */
function pluginIdentityString(
  value: string | null,
  where: string,
  diagnostics: ConfigOperationDiagnosticV1[],
): string | null {
  if (value === null) return null;
  if (value.trim() === '' || /[\\/:]/.test(value) || /\s/.test(value)) {
    diagnostics.push(
      diagnostic(
        'CONFIG_INVALID',
        `Field "${where}" must be a non-empty pathless plugin identity (no "/", "\\", ":", or whitespace).`,
      ),
    );
    return null;
  }
  return value;
}

function nullableStringField(
  value: Record<string, unknown>,
  key: string,
  where: string,
  diagnostics: ConfigOperationDiagnosticV1[],
): string | null {
  const raw = value[key];
  if (raw === null) return null;
  if (typeof raw !== 'string') {
    diagnostics.push(
      diagnostic('CONFIG_INVALID', `Field "${where}.${key}" must be a string or null.`),
    );
    return null;
  }
  return raw;
}

function stringArrayField(
  value: Record<string, unknown>,
  key: string,
  where: string,
  diagnostics: ConfigOperationDiagnosticV1[],
): readonly string[] | null {
  const raw = value[key];
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'string')) {
    diagnostics.push(
      diagnostic('CONFIG_INVALID', `Field "${where}.${key}" must be an array of strings.`),
    );
    return null;
  }
  return raw as string[];
}

/**
 * Finite number in [min, max]; render sampling temperatures are clamped to
 * [0, 2] and must not be NaN/Infinity (defensive: YAML cannot express them).
 */
function numberField(
  value: Record<string, unknown>,
  key: string,
  where: string,
  min: number,
  max: number,
  diagnostics: ConfigOperationDiagnosticV1[],
): number | null {
  const raw = value[key];
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < min || raw > max) {
    diagnostics.push(
      diagnostic(
        'CONFIG_INVALID',
        `Field "${where}.${key}" must be a finite number between ${min} and ${max}.`,
      ),
    );
    return null;
  }
  return raw;
}

/** Non-negative safe integer; used for render token budgets and seeds. */
function nonNegativeIntegerField(
  value: Record<string, unknown>,
  key: string,
  where: string,
  diagnostics: ConfigOperationDiagnosticV1[],
): number | null {
  const raw = value[key];
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
    diagnostics.push(
      diagnostic('CONFIG_INVALID', `Field "${where}.${key}" must be a non-negative integer.`),
    );
    return null;
  }
  return raw;
}

/**
 * Parse and strictly validate one YAML document into the canonical
 * configuration shape. Unknown keys anywhere, duplicate project
 * ids, non absolute roots, a default project id that is not registered,
 * malformed provider/listener values and any invalid listener policy are all
 * rejected with typed diagnostics; nothing is silently defaulted.
 */
export function parseConfigurationYaml(content: string): ConfigurationShapeResult {
  let value: unknown;
  try {
    value = YAML.parse(content);
  } catch {
    return {
      ok: false,
      diagnostics: [diagnostic('CONFIG_INVALID', 'workbench.yaml is not valid YAML.')],
    };
  }
  return validateConfigurationShape(value);
}

/**
 * Validate an already-parsed value against the version-1 shape. Exported for
 * the setup draft and admin candidates, which validate in-memory objects
 * before any file write.
 */
export function validateConfigurationShape(value: unknown): ConfigurationShapeResult {
  if (!isRecord(value)) {
    return {
      ok: false,
      diagnostics: [
        diagnostic('CONFIG_INVALID', 'workbench.yaml must be a mapping at the top level.'),
      ],
    };
  }
  const diagnostics: ConfigOperationDiagnosticV1[] = [];
  rejectUnknownKeys(value, CONFIGURATION_KEYS, 'workbench.yaml', diagnostics);
  const expectedVersion: WorkbenchConfigurationVersion = WORKBENCH_CONFIGURATION_VERSION;
  if (value.version !== expectedVersion) {
    diagnostics.push(
      diagnostic(
        'CONFIG_INVALID',
        `Unsupported configuration version; expected ${expectedVersion}.`,
      ),
    );
  }

  const projects: WorkbenchProjectConfigurationV1[] = [];
  const seenIds = new Set<string>();
  if (!Array.isArray(value.projects)) {
    diagnostics.push(diagnostic('CONFIG_INVALID', 'Field "projects" must be an array.'));
  } else {
    value.projects.forEach((entry, index) => {
      const where = `projects[${index}]`;
      if (!isRecord(entry)) {
        diagnostics.push(diagnostic('CONFIG_INVALID', `Field "${where}" must be a mapping.`));
        return;
      }
      rejectUnknownKeys(entry, PROJECT_KEYS, where, diagnostics);
      const projectId = stringField(entry, 'projectId', where, diagnostics);
      const displayName = stringField(entry, 'displayName', where, diagnostics);
      const mirror = entry.revisionMirror;
      if (projectId === null || displayName === null || !isRecord(mirror)) {
        if (!isRecord(mirror))
          diagnostics.push(
            diagnostic('CONFIG_INVALID', `Field "${where}.revisionMirror" must be a mapping.`),
          );
        return;
      }
      rejectUnknownKeys(mirror, ['mode', 'ref'], `${where}.revisionMirror`, diagnostics);
      const mode = stringField(mirror, 'mode', `${where}.revisionMirror`, diagnostics);
      let revisionMirror: WorkbenchRevisionMirrorConfigurationV1 | null = null;
      if (mode === 'disabled') {
        if ('ref' in mirror)
          diagnostics.push(
            diagnostic(
              'CONFIG_INVALID',
              `${where}.revisionMirror.ref is not allowed when disabled.`,
            ),
          );
        revisionMirror = { mode: 'disabled' };
      } else if (mode === 'git-best-effort') {
        if (mirror.ref !== 'refs/heads/workbench') {
          diagnostics.push(
            diagnostic(
              'CONFIG_INVALID',
              `${where}.revisionMirror.ref must be refs/heads/workbench.`,
            ),
          );
        } else {
          revisionMirror = { mode: 'git-best-effort', ref: 'refs/heads/workbench' };
        }
      } else if (mode !== null) {
        diagnostics.push(
          diagnostic('CONFIG_INVALID', `${where}.revisionMirror.mode is unsupported.`),
        );
      }
      const providerProfile = stringField(entry, 'providerProfile', where, diagnostics);
      if (providerProfile !== null && providerProfile.trim() === '') {
        diagnostics.push(
          diagnostic('CONFIG_INVALID', `Field "${where}.providerProfile" must not be empty.`),
        );
      }
      const rawTrustedPlugins = entry.trustedPlugins;
      let trustedPlugins: WorkbenchTrustedPluginConfigurationV1[] | null = null;
      if (!Array.isArray(rawTrustedPlugins)) {
        diagnostics.push(
          diagnostic('CONFIG_INVALID', `Field "${where}.trustedPlugins" must be an array.`),
        );
      } else {
        trustedPlugins = [];
        rawTrustedPlugins.forEach((plugin, pluginIndex) => {
          const pluginWhere = `${where}.trustedPlugins[${pluginIndex}]`;
          if (!isRecord(plugin)) {
            diagnostics.push(
              diagnostic('CONFIG_INVALID', `Field "${pluginWhere}" must be a mapping.`),
            );
            return;
          }
          rejectUnknownKeys(plugin, TRUSTED_PLUGIN_KEYS, pluginWhere, diagnostics);
          const name = pluginIdentityString(
            stringField(plugin, 'name', pluginWhere, diagnostics),
            `${pluginWhere}.name`,
            diagnostics,
          );
          const version = pluginIdentityString(
            stringField(plugin, 'version', pluginWhere, diagnostics),
            `${pluginWhere}.version`,
            diagnostics,
          );
          const moduleHash = pluginIdentityString(
            stringField(plugin, 'moduleHash', pluginWhere, diagnostics),
            `${pluginWhere}.moduleHash`,
            diagnostics,
          );
          const required = plugin.required;
          if (typeof required !== 'boolean') {
            diagnostics.push(
              diagnostic('CONFIG_INVALID', `Field "${pluginWhere}.required" must be a boolean.`),
            );
          }
          if (
            name !== null &&
            version !== null &&
            moduleHash !== null &&
            typeof required === 'boolean'
          ) {
            trustedPlugins?.push({ name, version, moduleHash, required });
          }
        });
      }
      if (revisionMirror === null || providerProfile === null || trustedPlugins === null) return;
      if (!PROJECT_ID_PATTERN.test(projectId)) {
        diagnostics.push(
          diagnostic(
            'CONFIG_INVALID',
            `Field "${where}.projectId" contains characters that are not allowed.`,
          ),
        );
        return;
      }
      if (displayName.trim() === '') {
        diagnostics.push(
          diagnostic('CONFIG_INVALID', `Field "${where}.displayName" must not be empty.`),
        );
        return;
      }
      if (seenIds.has(projectId)) {
        diagnostics.push(
          diagnostic('PROJECT_DUPLICATE_ID', `Project id "${projectId}" is registered twice.`),
        );
        return;
      }
      seenIds.add(projectId);
      projects.push({
        projectId,
        displayName,
        revisionMirror,
        providerProfile,
        trustedPlugins,
      });
    });
  }

  let defaultProjectId: string | null = null;
  if (value.defaultProjectId !== undefined) {
    if (value.defaultProjectId === null) {
      defaultProjectId = null;
    } else if (typeof value.defaultProjectId === 'string') {
      if (!seenIds.has(value.defaultProjectId)) {
        diagnostics.push(
          diagnostic(
            'CONFIG_INVALID',
            `defaultProjectId "${value.defaultProjectId}" is not a registered project.`,
          ),
        );
      } else {
        defaultProjectId = value.defaultProjectId;
      }
    } else {
      diagnostics.push(
        diagnostic('CONFIG_INVALID', 'Field "defaultProjectId" must be a string or null.'),
      );
    }
  } else {
    diagnostics.push(
      diagnostic(
        'CONFIG_INVALID',
        'Field "defaultProjectId" is required; write null or a registered project id explicitly.',
      ),
    );
  }

  let parsedProviders: Record<string, WorkbenchProviderConfigurationV1> | null = null;
  if (!isRecord(value.providers)) {
    diagnostics.push(diagnostic('CONFIG_INVALID', 'Field "providers" must be a mapping.'));
  } else {
    const providers: Record<string, WorkbenchProviderConfigurationV1> = {};
    for (const [profileId, rawProvider] of Object.entries(value.providers)) {
      const providerWhere = `providers.${profileId}`;
      if (!isRecord(rawProvider)) {
        diagnostics.push(
          diagnostic('CONFIG_INVALID', `Field "${providerWhere}" must be a mapping.`),
        );
        continue;
      }
      rejectUnknownKeys(rawProvider, PROVIDER_KEYS, providerWhere, diagnostics);
      const kind = stringField(rawProvider, 'kind', providerWhere, diagnostics);
      const baseUrl = nullableStringField(rawProvider, 'baseUrl', providerWhere, diagnostics);
      const model = nullableStringField(rawProvider, 'model', providerWhere, diagnostics);
      const reasoning = rawProvider.reasoning;
      const contextWindow = rawProvider.contextWindow;
      const maxTokens = rawProvider.maxTokens;
      const headers = rawProvider.headers;
      if (reasoning !== undefined && typeof reasoning !== 'boolean') {
        diagnostics.push(
          diagnostic('CONFIG_INVALID', `Field "${providerWhere}.reasoning" must be a boolean.`),
        );
      }
      if (
        contextWindow !== undefined &&
        (typeof contextWindow !== 'number' ||
          !Number.isSafeInteger(contextWindow) ||
          contextWindow <= 0)
      ) {
        diagnostics.push(
          diagnostic(
            'CONFIG_INVALID',
            `Field "${providerWhere}.contextWindow" must be a positive integer.`,
          ),
        );
      }
      if (
        maxTokens !== undefined &&
        (typeof maxTokens !== 'number' || !Number.isSafeInteger(maxTokens) || maxTokens <= 0)
      ) {
        diagnostics.push(
          diagnostic(
            'CONFIG_INVALID',
            `Field "${providerWhere}.maxTokens" must be a positive integer.`,
          ),
        );
      }
      let parsedHeaders: Readonly<Record<string, string>> | null = null;
      if (headers !== undefined) {
        if (
          !isRecord(headers) ||
          Object.values(headers).some((value) => typeof value !== 'string')
        ) {
          diagnostics.push(
            diagnostic(
              'CONFIG_INVALID',
              `Field "${providerWhere}.headers" must be a mapping of string to string.`,
            ),
          );
        } else {
          parsedHeaders = headers as Readonly<Record<string, string>>;
        }
      }
      if (kind === 'pi' && baseUrl !== null && model !== null) {
        if (baseUrl.length > 0 && !/^https?:\/\//.test(baseUrl)) {
          diagnostics.push(
            diagnostic(
              'CONFIG_INVALID',
              `${providerWhere}.baseUrl must be an http(s) URL or null.`,
            ),
          );
        }
        const entry: WorkbenchProviderConfigurationV1 = {
          kind,
          baseUrl: baseUrl.length === 0 ? null : baseUrl,
          model: model.length === 0 ? null : model,
          ...(rawProvider.reasoning !== undefined && typeof rawProvider.reasoning === 'boolean'
            ? { reasoning: rawProvider.reasoning }
            : {}),
          ...(rawProvider.contextWindow !== undefined &&
          typeof rawProvider.contextWindow === 'number' &&
          Number.isSafeInteger(rawProvider.contextWindow) &&
          rawProvider.contextWindow > 0
            ? { contextWindow: rawProvider.contextWindow }
            : {}),
          ...(rawProvider.maxTokens !== undefined &&
          typeof rawProvider.maxTokens === 'number' &&
          Number.isSafeInteger(rawProvider.maxTokens) &&
          rawProvider.maxTokens > 0
            ? { maxTokens: rawProvider.maxTokens }
            : {}),
          ...(parsedHeaders === null ? {} : { headers: parsedHeaders }),
        };
        providers[profileId] = entry;
      } else if (kind !== 'pi' && kind !== null) {
        diagnostics.push(
          diagnostic(
            'CONFIG_INVALID',
            `Unsupported provider kind "${kind}"; only "pi" is valid.`,
          ),
        );
      }
    }
    parsedProviders = providers;
  }

  let network: WorkbenchNetworkConfigurationV1 | null = null;
  if (!isRecord(value.network)) {
    diagnostics.push(diagnostic('NETWORK_INVALID', 'Field "network" must be a mapping.'));
  } else {
    rejectUnknownKeys(value.network, NETWORK_KEYS, 'network', diagnostics);
    const mode = stringField(value.network, 'mode', 'network', diagnostics);
    const port = value.network.port;
    const allowedHosts = stringArrayField(value.network, 'allowedHosts', 'network', diagnostics);
    const allowedOrigins = stringArrayField(
      value.network,
      'allowedOrigins',
      'network',
      diagnostics,
    );
    const unixSocket = nullableStringField(value.network, 'unixSocket', 'network', diagnostics);
    if (mode !== null && port !== undefined && allowedHosts !== null && allowedOrigins !== null) {
      if (!LOOPBACK_MODES.includes(mode)) {
        diagnostics.push(
          diagnostic(
            'NETWORK_INVALID',
            `network.mode must be one of ${LOOPBACK_MODES.join(', ')}; got "${mode}".`,
          ),
        );
      } else if (!Number.isInteger(port) || (port as number) < 0 || (port as number) > 65535) {
        diagnostics.push(
          diagnostic('NETWORK_INVALID', 'network.port must be an integer between 0 and 65535.'),
        );
      } else if (mode === 'unix' && (unixSocket === null || !isAbsolute(unixSocket))) {
        diagnostics.push(
          diagnostic(
            'NETWORK_INVALID',
            'network.unixSocket must be an absolute path when network.mode is "unix".',
          ),
        );
      } else if (mode !== 'unix' && unixSocket !== null) {
        diagnostics.push(
          diagnostic(
            'NETWORK_INVALID',
            'network.unixSocket must be null unless network.mode is "unix".',
          ),
        );
      } else {
        network = {
          mode: mode as WorkbenchNetworkConfigurationV1['mode'],
          port: port as number,
          allowedHosts: [...allowedHosts],
          allowedOrigins: [...allowedOrigins],
          unixSocket,
        };
      }
    }
  }

  let parsedReferenceLimits: WorkbenchReferenceLimitsV1 | null = null;
  const limits = value.referenceLimits;
  if (!isRecord(limits)) {
    diagnostics.push(diagnostic('CONFIG_INVALID', 'Field "referenceLimits" must be a mapping.'));
  } else {
    rejectUnknownKeys(limits, REFERENCE_LIMIT_KEYS, 'referenceLimits', diagnostics);
    if (typeof limits.enabled !== 'boolean') {
      diagnostics.push(diagnostic('CONFIG_INVALID', 'referenceLimits.enabled must be a boolean.'));
    }
    for (const key of REFERENCE_LIMIT_KEYS) {
      if (key === 'enabled') continue;
      const item = limits[key];
      if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0) {
        diagnostics.push(
          diagnostic('CONFIG_INVALID', `referenceLimits.${key} must be a non-negative integer.`),
        );
      }
    }
    parsedReferenceLimits = {
      enabled: limits.enabled as boolean,
      maxFileBytes: limits.maxFileBytes as number,
      maxBytesPerProject: limits.maxBytesPerProject as number,
      maxItemsPerProject: limits.maxItemsPerProject as number,
      maxPendingJobsPerProject: limits.maxPendingJobsPerProject as number,
      maxChunksPerProject: limits.maxChunksPerProject as number,
      maxExtractedCharactersPerProject: limits.maxExtractedCharactersPerProject as number,
      maxChunkCharacters: limits.maxChunkCharacters as number,
      chunkOverlapCharacters: limits.chunkOverlapCharacters as number,
      extractionTimeoutMs: limits.extractionTimeoutMs as number,
      mcpImportChunkBytes: limits.mcpImportChunkBytes as number,
    };
  }

  let parsedOperationLimits: WorkbenchOperationLimitsV1 | null = null;
  const operationLimits = value.operationLimits;
  if (!isRecord(operationLimits)) {
    diagnostics.push(diagnostic('CONFIG_INVALID', 'Field "operationLimits" must be a mapping.'));
  } else {
    rejectUnknownKeys(operationLimits, OPERATION_LIMIT_KEYS, 'operationLimits', diagnostics);
    for (const key of OPERATION_LIMIT_KEYS) {
      const item = operationLimits[key];
      if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0) {
        diagnostics.push(
          diagnostic('CONFIG_INVALID', `operationLimits.${key} must be a non-negative integer.`),
        );
      }
    }
    if (operationLimits.maxConcurrentRendersPerProject !== 1) {
      diagnostics.push(
        diagnostic(
          'CONFIG_INVALID',
          'operationLimits.maxConcurrentRendersPerProject must be exactly 1.',
        ),
      );
    }
    parsedOperationLimits = {
      maxQueuedPerProject: operationLimits.maxQueuedPerProject as number,
      maxConcurrentRendersPerProject: operationLimits.maxConcurrentRendersPerProject as 1,
      maxConcurrentRendersPerHost: operationLimits.maxConcurrentRendersPerHost as number,
    };
  }

  let parsedAgent: WorkbenchAgentConfigurationV1 | null = null;
  const agent = value.agent;
  if (!isRecord(agent)) {
    diagnostics.push(diagnostic('CONFIG_INVALID', 'Field "agent" must be a mapping.'));
  } else {
    rejectUnknownKeys(agent, AGENT_KEYS, 'agent', diagnostics);
    if (typeof agent.enabled !== 'boolean') {
      diagnostics.push(diagnostic('CONFIG_INVALID', 'agent.enabled must be a boolean.'));
    }
    for (const key of ['maxTurns', 'maxToolCalls'] as const) {
      const item = agent[key];
      if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0) {
        diagnostics.push(
          diagnostic('CONFIG_INVALID', `agent.${key} must be a non-negative integer.`),
        );
      }
    }
    parsedAgent = {
      enabled: agent.enabled as boolean,
      maxTurns: agent.maxTurns as number,
      maxToolCalls: agent.maxToolCalls as number,
    };
  }

  let parsedRenderPolicy: WorkbenchRenderPolicyV1 | null = null;
  if (!isRecord(value.renderPolicy)) {
    diagnostics.push(diagnostic('CONFIG_INVALID', 'Field "renderPolicy" must be a mapping.'));
  } else {
    rejectUnknownKeys(value.renderPolicy, RENDER_POLICY_KEYS, 'renderPolicy', diagnostics);
    const pass1 = value.renderPolicy.pass1;
    const pass2 = value.renderPolicy.pass2;
    if (!isRecord(pass1)) {
      diagnostics.push(
        diagnostic('CONFIG_INVALID', 'Field "renderPolicy.pass1" must be a mapping.'),
      );
    } else {
      rejectUnknownKeys(pass1, RENDER_PASS_KEYS, 'renderPolicy.pass1', diagnostics);
    }
    if (!isRecord(pass2)) {
      diagnostics.push(
        diagnostic('CONFIG_INVALID', 'Field "renderPolicy.pass2" must be a mapping.'),
      );
    } else {
      rejectUnknownKeys(pass2, RENDER_PASS2_KEYS, 'renderPolicy.pass2', diagnostics);
    }
    if (isRecord(pass1) && isRecord(pass2)) {
      const pass1Temperature = numberField(
        pass1,
        'temperature',
        'renderPolicy.pass1',
        0,
        2,
        diagnostics,
      );
      const pass1MaxTokens = nonNegativeIntegerField(
        pass1,
        'maxTokens',
        'renderPolicy.pass1',
        diagnostics,
      );
      const pass2Temperature = numberField(
        pass2,
        'temperature',
        'renderPolicy.pass2',
        0,
        2,
        diagnostics,
      );
      const pass2MaxTokens = nonNegativeIntegerField(
        pass2,
        'maxTokens',
        'renderPolicy.pass2',
        diagnostics,
      );
      const pass2Seed = nonNegativeIntegerField(pass2, 'seed', 'renderPolicy.pass2', diagnostics);
      if (
        pass1Temperature !== null &&
        pass1MaxTokens !== null &&
        pass2Temperature !== null &&
        pass2MaxTokens !== null &&
        pass2Seed !== null
      ) {
        parsedRenderPolicy = {
          pass1: { temperature: pass1Temperature, maxTokens: pass1MaxTokens },
          pass2: { temperature: pass2Temperature, maxTokens: pass2MaxTokens, seed: pass2Seed },
        };
      }
    }
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  if (network === null) {
    return { ok: false, diagnostics: [diagnostic('NETWORK_INVALID', 'network is required.')] };
  }
  if (
    parsedProviders === null ||
    parsedReferenceLimits === null ||
    parsedOperationLimits === null ||
    parsedAgent === null ||
    parsedRenderPolicy === null
  ) {
    // Unreachable: every null parse path above already pushed a diagnostic.
    return { ok: false, diagnostics };
  }
  const configuration: WorkbenchConfigurationV1 = {
    version: WORKBENCH_CONFIGURATION_VERSION,
    projects,
    defaultProjectId,
    providers: parsedProviders,
    network,
    referenceLimits: parsedReferenceLimits,
    operationLimits: parsedOperationLimits,
    agent: parsedAgent,
    renderPolicy: parsedRenderPolicy,
  };
  return { ok: true, configuration };
}

/**
 * Validate every configured project as one topology before any project can be
 * opened or registered. All project roots are Host-managed
 * (`$WORKBENCH_HOME/projects/<projectId>`), so each root is unique by
 * construction and no filesystem probe is needed here.
 */
export async function validateConfigurationTopology(
  _configuration: WorkbenchConfigurationV1,
): Promise<readonly ConfigOperationDiagnosticV1[]> {
  return [];
}

// ─── File store ──────────────────────────────────────────────────────────────

export interface ConfigurationFileStoreOptions {
  /** Resolved absolute path of `workbench.yaml` (see {@link resolveConfigurationFilePath}). */
  readonly filePath: string;
  /** Debounce window for external-change events; default 250ms. */
  readonly debounceMs?: number;
}

export interface StoredConfigurationFile {
  readonly configuration: WorkbenchConfigurationV1;
  /** Content-hash revision of the canonical serialization. */
  readonly revision: string;
}

export interface ConfigurationFileWatcher {
  dispose(): void;
}

/**
 * Versioned configuration file store. `read()` returns null when the file
 * does not exist yet (first setup); `write()` performs an atomic 0600
 * temp-write + rename and records the written revision for self-write
 * suppression. `watch()` observes the containing directory (the file is
 * replaced by rename, so a file-scoped watcher would silently detach) and
 * emits a debounced callback for external changes.
 */
export class ConfigurationFileStore {
  readonly #filePath: string;
  readonly #debounceMs: number;
  /** Revision of the most recent successful self-write; watcher callbacks compare against it. */
  #lastWrittenRevision: string | null = null;
  #watcher: FSWatcher | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #disposed = false;

  constructor(options: ConfigurationFileStoreOptions) {
    if (
      typeof options.filePath !== 'string' ||
      options.filePath.length === 0 ||
      !isAbsolute(options.filePath)
    ) {
      throw new TypeError('ConfigurationFileStore requires an absolute filePath');
    }
    this.#filePath = options.filePath;
    this.#debounceMs = options.debounceMs ?? 250;
  }

  get filePath(): string {
    return this.#filePath;
  }

  /** Revision of the most recent self-write, or null before the first write. */
  lastWrittenRevision(): string | null {
    return this.#lastWrittenRevision;
  }

  /** Read and parse the current file; null when the file does not exist yet. */
  async read(): Promise<StoredConfigurationFile | null> {
    let content: string;
    try {
      content = await readFile(this.#filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const parsed = parseConfigurationYaml(content);
    if (!parsed.ok) {
      throw new ConfigurationFileParseError(parsed.diagnostics);
    }
    const configuration = parsed.configuration;
    return {
      configuration,
      revision: configurationRevision(configuration),
    };
  }

  /**
   * Read the raw file content and its byte revision. Used by the watcher path
   * so an invalid document still yields a candidate revision for the receipt
   * without losing the user's hand-edited bytes.
   */
  async readRaw(): Promise<{ readonly content: string; readonly revision: string } | null> {
    let content: string;
    try {
      content = await readFile(this.#filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    return { content, revision: createHash('sha256').update(content, 'utf8').digest('hex') };
  }

  /**
   * Atomically persist a configuration: write the canonical document to a
   * fresh 0600 temporary file in the same directory, fsync-free by design
   * (rename is atomic on POSIX), then rename over the target. A failed write
   * never leaves a partial `workbench.yaml`.
   */
  async write(configuration: WorkbenchConfigurationV1): Promise<string> {
    const revision = configurationRevision(configuration);
    const dir = dirname(this.#filePath);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temporary = join(dir, `.workbench.yaml.tmp-${randomBytes(8).toString('hex')}`);
    try {
      await writeFile(temporary, serializeConfigurationYaml(configuration), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      await chmod(temporary, 0o600);
      await rename(temporary, this.#filePath);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    this.#lastWrittenRevision = revision;
    return revision;
  }

  /** Ensure the config directory exists (e.g. before watching an absent file). */
  async ensureDirectory(): Promise<void> {
    await mkdir(dirname(this.#filePath), { recursive: true, mode: 0o700 });
  }

  /**
   * Watch for external file changes. The callback fires after a debounce;
   * callers compare the re-read revision against {@link lastWrittenRevision}
   * to suppress their own writes. The watcher is best-effort: a missing or
   * temporarily unavailable directory yields no watcher, and `dispose()` is
   * always safe. Directory creation and watcher registration are synchronous:
   * when this method returns, a following external write cannot race setup.
   */
  watch(onExternalChange: () => void | Promise<void>): ConfigurationFileWatcher {
    const dir = dirname(this.#filePath);
    const name = basename(this.#filePath);
    const schedule = (): void => {
      if (this.#disposed) return;
      clearTimeout(this.#timer ?? undefined);
      this.#timer = setTimeout(() => {
        this.#timer = null;
        if (!this.#disposed) void onExternalChange();
      }, this.#debounceMs);
    };
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      this.#watcher = watch(dir, (_event, filename) => {
        if (filename === name) schedule();
      });
    } catch {
      // Best-effort: the next write or an explicit re-watch re-arms.
    }
    return {
      dispose: () => {
        this.#disposed = true;
        clearTimeout(this.#timer ?? undefined);
        this.#timer = null;
        this.#watcher?.close();
        this.#watcher = null;
      },
    };
  }
  async exists(): Promise<boolean> {
    try {
      const info = await stat(this.#filePath);
      return info.isFile();
    } catch {
      return false;
    }
  }
}

/** Typed parse/shape failure of a stored file; diagnostics never carry content. */
export class ConfigurationFileParseError extends Error {
  override readonly name = 'ConfigurationFileParseError';
  readonly diagnostics: readonly ConfigOperationDiagnosticV1[];

  constructor(diagnostics: readonly ConfigOperationDiagnosticV1[]) {
    super('workbench.yaml failed schema validation');
    this.diagnostics = diagnostics;
  }
}
