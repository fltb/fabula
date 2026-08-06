import { createHash } from 'node:crypto';
import { type Dirent, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  BuildPromptInput,
  PluginContext,
  PluginHooks,
  PluginManifest,
  PromptDecoration,
  ProviderRegistry,
  ValidatorRegistrar,
} from '@novalistically/core/extensions';
import * as yaml from 'yaml';

/**
 * A plugin hook record stamped with the exact identity of the module that
 * produced it. The stamps ride on the hook object so Core's cache-scoping
 * (`PluginHooksManager.getPluginIdentities`) sees them: any plugin change
 * changes the render cache key and validation identity.
 */
export interface StampedPluginHooks extends PluginHooks {
  readonly version: string;
  readonly manifestHash: string;
  readonly moduleHash: string;
}

export interface LoadedNodePlugin {
  readonly manifest: PluginManifest;
  /** SHA-256 (hex) of the exact manifest.yaml bytes read from disk. */
  readonly manifestHash: string;
  /** SHA-256 (hex) of the exact index.js bytes; null when the plugin has no module. */
  readonly moduleHash: string | null;
  readonly hooks: StampedPluginHooks | null;
}

/**
 * V3 trusted-plugin allowlist entry (structurally identical to
 * `WorkbenchTrustedPluginConfigurationV3`). node-host deliberately does not
 * depend on the workbench-protocol package.
 */
export interface TrustedNodePluginEntry {
  readonly name: string;
  readonly version: string;
  readonly moduleHash: string;
  readonly required: boolean;
}

/** Error code for trusted-plugin identity verification failures. */
export const PLUGIN_IDENTITY_MISMATCH = 'PLUGIN_IDENTITY_MISMATCH';
export type PluginIdentityMismatchCode = typeof PLUGIN_IDENTITY_MISMATCH;

/**
 * A plugin's discovered identity does not match its trusted allowlist entry.
 * This is a configuration/security error: never load the plugin.
 */
export class PluginIdentityMismatchError extends Error {
  readonly code: PluginIdentityMismatchCode;

  constructor(message: string) {
    super(message);
    this.name = 'PluginIdentityMismatchError';
    this.code = PLUGIN_IDENTITY_MISMATCH;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

const isCallback = (value: unknown): value is (...args: unknown[]) => unknown =>
  typeof value === 'function';

const isWithin = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

const assertSafeDirectory = async (root: string, directory: string): Promise<void> => {
  const lexicalRoot = path.resolve(root);
  const realRoot = await fs.realpath(lexicalRoot);
  if (!isWithin(lexicalRoot, directory)) {
    throw new Error('Plugin directory escapes project root');
  }
  const relative = path.relative(lexicalRoot, directory);
  let current = realRoot;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Plugin directory must be a real directory: ${current}`);
    }
  }
  if (!isWithin(realRoot, await fs.realpath(directory))) {
    throw new Error('Plugin directory resolves outside project root');
  }
};

const sha256hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const parseManifest = (value: unknown, manifestPath: string): PluginManifest => {
  if (
    !isObject(value) ||
    typeof value.name !== 'string' ||
    value.name.length === 0 ||
    typeof value.version !== 'string' ||
    value.version.length === 0 ||
    typeof value.priority !== 'number' ||
    !Number.isFinite(value.priority) ||
    !isStringArray(value.provides) ||
    !isStringArray(value.requires) ||
    !isStringArray(value.conflicts) ||
    !isObject(value.authority) ||
    !isStringArray(value.authority.dimensions) ||
    typeof value.authority.exclusive !== 'boolean' ||
    !isObject(value.observes) ||
    !isStringArray(value.observes.eventTypes) ||
    !isStringArray(value.observes.stateDomains)
  ) {
    throw new Error(`Invalid plugin manifest: ${manifestPath}`);
  }
  return {
    name: value.name,
    version: value.version,
    priority: value.priority,
    provides: [...value.provides],
    requires: [...value.requires],
    conflicts: [...value.conflicts],
    authority: {
      dimensions: [...value.authority.dimensions],
      exclusive: value.authority.exclusive,
    },
    observes: {
      eventTypes: [...value.observes.eventTypes],
      stateDomains: [...value.observes.stateDomains],
    },
  };
};

/** Hook function names present on a plugin hook record, sorted for determinism. */
export function pluginHookNames(hook: PluginHooks): readonly string[] {
  return (Object.keys(hook) as (keyof PluginHooks)[])
    .filter((key) => key !== 'name' && typeof hook[key] === 'function')
    .sort();
}

const toPromptDecorations = (value: unknown, pluginName: string): readonly PromptDecoration[] => {
  if (!Array.isArray(value)) {
    throw new Error(`Plugin ${pluginName} returned a non-array prompt decoration result`);
  }
  const decorations: PromptDecoration[] = [];
  for (const decoration of value) {
    if (
      !isObject(decoration) ||
      typeof decoration.id !== 'string' ||
      typeof decoration.content !== 'string' ||
      typeof decoration.cacheKey !== 'string'
    ) {
      throw new Error(`Plugin ${pluginName} returned an invalid prompt decoration`);
    }
    decorations.push({
      id: decoration.id,
      content: decoration.content,
      cacheKey: decoration.cacheKey,
    });
  }
  return decorations;
};

const toHooks = (
  value: unknown,
  manifest: PluginManifest,
  manifestHash: string,
  moduleHash: string,
): StampedPluginHooks | null => {
  if (!isObject(value) || typeof value.name !== 'string' || value.name !== manifest.name) {
    return null;
  }
  const onLoad = isCallback(value.onLoad) ? value.onLoad : null;
  const onUnload = isCallback(value.onUnload) ? value.onUnload : null;
  const registerValidators = isCallback(value.registerValidators) ? value.registerValidators : null;
  const registerProvider = isCallback(value.registerProvider) ? value.registerProvider : null;
  const beforeRender = isCallback(value.beforeRender) ? value.beforeRender : null;
  const afterRender = isCallback(value.afterRender) ? value.afterRender : null;
  const onBuildPass1Prompt = isCallback(value.onBuildPass1Prompt) ? value.onBuildPass1Prompt : null;
  const onBuildPass2Prompt = isCallback(value.onBuildPass2Prompt) ? value.onBuildPass2Prompt : null;

  return {
    name: value.name,
    version: manifest.version,
    manifestHash,
    moduleHash,
    ...(onLoad
      ? {
          onLoad: async (context: PluginContext) => {
            await onLoad(context);
          },
        }
      : {}),
    ...(onUnload
      ? {
          onUnload: async (context: PluginContext) => {
            await onUnload(context);
          },
        }
      : {}),
    ...(registerValidators
      ? {
          registerValidators: (registrar: ValidatorRegistrar) => {
            registerValidators(registrar);
          },
        }
      : {}),
    ...(registerProvider
      ? {
          registerProvider: (registry: ProviderRegistry) => {
            registerProvider(registry);
          },
        }
      : {}),
    ...(beforeRender
      ? {
          beforeRender: async (context: PluginContext) => {
            await beforeRender(context);
          },
        }
      : {}),
    ...(afterRender
      ? {
          afterRender: async (context: PluginContext) => {
            await afterRender(context);
          },
        }
      : {}),
    ...(onBuildPass1Prompt
      ? {
          onBuildPass1Prompt: async (input: BuildPromptInput) =>
            toPromptDecorations(await onBuildPass1Prompt(input), manifest.name),
        }
      : {}),
    ...(onBuildPass2Prompt
      ? {
          onBuildPass2Prompt: async (input: BuildPromptInput) =>
            toPromptDecorations(await onBuildPass2Prompt(input), manifest.name),
        }
      : {}),
  };
};

/**
 * Reason describing why a discovered plugin does not match its trusted
 * allowlist entry, or null when every identity field matches exactly.
 */
export function describeTrustedMismatch(
  plugin: LoadedNodePlugin,
  trusted: TrustedNodePluginEntry,
): string | null {
  if (plugin.manifest.name !== trusted.name) {
    return `manifest name "${plugin.manifest.name}" does not match trusted name "${trusted.name}"`;
  }
  if (plugin.manifest.version !== trusted.version) {
    return `manifest version "${plugin.manifest.version}" does not match trusted version "${trusted.version}"`;
  }
  if (plugin.moduleHash !== trusted.moduleHash) {
    return `module hash "${plugin.moduleHash ?? '(missing module)'}" does not match trusted module hash "${trusted.moduleHash}"`;
  }
  return null;
}

/** Host-owned, containment-checked plugin discovery and module loading. */
export class NodePluginCatalog {
  readonly #projectRoot: string;

  constructor(projectRoot: string) {
    this.#projectRoot = path.resolve(projectRoot);
  }

  /**
   * Verify a discovered plugin against a trusted allowlist entry. Throws
   * {@link PluginIdentityMismatchError} unless name, version and module hash
   * all match exactly.
   */
  verifyTrusted(plugin: LoadedNodePlugin, trusted: TrustedNodePluginEntry): void {
    const mismatch = describeTrustedMismatch(plugin, trusted);
    if (mismatch !== null) {
      throw new PluginIdentityMismatchError(
        `Trusted plugin verification failed for "${trusted.name}": ${mismatch}`,
      );
    }
  }

  async load(relativeDirectory = 'plugins'): Promise<readonly LoadedNodePlugin[]> {
    if (!relativeDirectory || path.isAbsolute(relativeDirectory)) {
      throw new Error('Plugin directory must be project-relative');
    }
    const directory = path.resolve(this.#projectRoot, relativeDirectory);
    if (!isWithin(this.#projectRoot, directory)) {
      throw new Error('Plugin directory escapes project root');
    }

    let entries: Dirent[];
    try {
      await assertSafeDirectory(this.#projectRoot, directory);
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isObject(error) && error.code === 'ENOENT') return [];
      throw error;
    }

    const plugins: LoadedNodePlugin[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isSymbolicLink()) {
        throw new Error(`Plugin directory must not be a symlink: ${entry.name}`);
      }
      if (!entry.isDirectory()) continue;
      const pluginDirectory = path.join(directory, entry.name);
      await assertSafeDirectory(this.#projectRoot, pluginDirectory);
      const manifestPath = path.join(pluginDirectory, 'manifest.yaml');
      const manifestStat = await fs.lstat(manifestPath).catch((error: unknown) => {
        if (isObject(error) && error.code === 'ENOENT') return null;
        throw error;
      });
      if (manifestStat === null) continue;
      if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
        throw new Error(`Plugin manifest must be a regular file: ${manifestPath}`);
      }
      const manifestBytes = await fs.readFile(manifestPath);
      const manifestHash = sha256hex(manifestBytes);
      const manifest = parseManifest(yaml.parse(manifestBytes.toString('utf8')), manifestPath);

      const modulePath = path.join(pluginDirectory, 'index.js');
      const moduleStat = await fs.lstat(modulePath).catch((error: unknown) => {
        if (isObject(error) && error.code === 'ENOENT') return null;
        throw error;
      });
      if (moduleStat === null) {
        plugins.push({ manifest, manifestHash, moduleHash: null, hooks: null });
        continue;
      }
      if (!moduleStat.isFile() || moduleStat.isSymbolicLink()) {
        throw new Error(`Plugin module must be a regular file: ${modulePath}`);
      }
      const moduleBytes = await fs.readFile(modulePath);
      const moduleHash = sha256hex(moduleBytes);
      const moduleValue: unknown = await import(pathToFileURL(modulePath).href);
      const hooks = toHooks(
        isObject(moduleValue) && 'hooks' in moduleValue ? moduleValue.hooks : undefined,
        manifest,
        manifestHash,
        moduleHash,
      );
      plugins.push({ manifest, manifestHash, moduleHash, hooks });
    }
    return plugins;
  }
}

/** Identity fields the owner admin needs to build a trusted allowlist. */
export interface DiscoveredNodePlugin {
  readonly name: string;
  readonly version: string;
  readonly manifestHash: string;
  readonly moduleHash: string | null;
  readonly hookNames: readonly string[];
}

/**
 * Discover plugins without making any trust decision: sorted by name with
 * manifest hash, module hash and hook names. Loading modules (to read hook
 * names) is acceptable because plugins are owner-installed Host code.
 */
export async function discoverNodePlugins(
  projectRoot: string,
  relativeDirectory = 'plugins',
): Promise<readonly DiscoveredNodePlugin[]> {
  const loaded = await new NodePluginCatalog(projectRoot).load(relativeDirectory);
  return loaded
    .map((plugin) => ({
      name: plugin.manifest.name,
      version: plugin.manifest.version,
      manifestHash: plugin.manifestHash,
      moduleHash: plugin.moduleHash,
      hookNames: plugin.hooks === null ? [] : pluginHookNames(plugin.hooks),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}
