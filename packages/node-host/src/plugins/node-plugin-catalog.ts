import { promises as fs, type Dirent } from 'node:fs';
import { pathToFileURL } from 'node:url';
import * as path from 'node:path';
import * as yaml from 'yaml';
import type {
  BuildPromptInput,
  PluginContext,
  PluginHooks,
  PluginManifest,
  PromptDecoration,
  ProviderRegistry,
  ValidatorRegistrar,
} from '@novalistically/core/extensions';

export interface LoadedNodePlugin {
  readonly manifest: PluginManifest;
  readonly hooks: PluginHooks | null;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

const isCallback = (value: unknown): value is ((...args: unknown[]) => unknown) =>
  typeof value === 'function';

const isWithin = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

const assertSafeDirectory = async (root: string, directory: string): Promise<void> => {
  const realRoot = await fs.realpath(root);
  if (!isWithin(realRoot, directory)) {
    throw new Error('Plugin directory escapes project root');
  }
  const relative = path.relative(realRoot, directory);
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

const toHooks = (value: unknown, manifest: PluginManifest): PluginHooks | null => {
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
    ...(onLoad ? { onLoad: async (context: PluginContext) => { await onLoad(context); } } : {}),
    ...(onUnload ? { onUnload: async (context: PluginContext) => { await onUnload(context); } } : {}),
    ...(registerValidators ? { registerValidators: (registrar: ValidatorRegistrar) => { registerValidators(registrar); } } : {}),
    ...(registerProvider ? { registerProvider: (registry: ProviderRegistry) => { registerProvider(registry); } } : {}),
    ...(beforeRender ? { beforeRender: async (context: PluginContext) => { await beforeRender(context); } } : {}),
    ...(afterRender ? { afterRender: async (context: PluginContext) => { await afterRender(context); } } : {}),
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

/** Host-owned, containment-checked plugin discovery and module loading. */
export class NodePluginCatalog {
  readonly #projectRoot: string;

  constructor(projectRoot: string) {
    this.#projectRoot = path.resolve(projectRoot);
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
      const manifest = parseManifest(yaml.parse(await fs.readFile(manifestPath, 'utf8')), manifestPath);

      const modulePath = path.join(pluginDirectory, 'index.js');
      const moduleStat = await fs.lstat(modulePath).catch((error: unknown) => {
        if (isObject(error) && error.code === 'ENOENT') return null;
        throw error;
      });
      if (moduleStat === null) {
        plugins.push({ manifest, hooks: null });
        continue;
      }
      if (!moduleStat.isFile() || moduleStat.isSymbolicLink()) {
        throw new Error(`Plugin module must be a regular file: ${modulePath}`);
      }
      const moduleValue: unknown = await import(pathToFileURL(modulePath).href);
      const hooks = toHooks(
        isObject(moduleValue) && 'hooks' in moduleValue ? moduleValue.hooks : undefined,
        manifest,
      );
      plugins.push({ manifest, hooks });
    }
    return plugins;
  }
}
