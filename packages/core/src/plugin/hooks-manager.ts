// ============================================================================
// PluginHooksManager — Register and invoke plugin lifecycle hooks
// ============================================================================

import type { LLMProvider } from '../ai/types.ts';
import type { ValidatorIdentity } from '../editorial/identity.ts';
import type { Validator } from '../types/index.js';
import type {
  BuildPromptInput,
  PluginContext,
  PluginHooks,
  PromptDecoration,
  ProviderRegistry,
} from './types.ts';
import type { ValidatorRegistry } from './validator-registry.ts';

// ——— Decoration Validation ———

const MAX_DECORATION_CONTENT_BYTES = 4096;
const MAX_DECORATIONS_PER_PLUGIN = 10;

function validateDecoration(pluginName: string, dec: PromptDecoration, seenIds: Set<string>): void {
  if (seenIds.has(dec.id)) {
    throw new Error(`Plugin "${pluginName}" produced duplicate decoration id "${dec.id}"`);
  }
  seenIds.add(dec.id);

  if (dec.id.length === 0) {
    throw new Error(`Plugin "${pluginName}" produced decoration with empty id`);
  }

  const contentBytes = new TextEncoder().encode(dec.content).length;
  if (contentBytes > MAX_DECORATION_CONTENT_BYTES) {
    throw new Error(
      `Plugin "${pluginName}" decoration "${dec.id}" content exceeds ${MAX_DECORATION_CONTENT_BYTES} bytes (${contentBytes})`,
    );
  }
}

// ——— Manager ———

/**
 * Manages plugin lifecycle hooks: load, unload, validator registration,
 * provider registration, pipeline observation, and prompt decoration hooks.
 *
 * Plugins receive a read-only PluginContext — no mutation of core state.
 * Transform hooks (onBuildPass1Prompt/onBuildPass2Prompt) throw on error
 * as hard scene failure; observation hooks collect errors.
 */
export class PluginHooksManager {
  private readonly hooks: PluginHooks[] = [];
  private readonly validatorRegistry: ValidatorRegistry;
  private readonly providerRegistry: ProviderRegistry;
  private readonly context: PluginContext;
  /** Internal provider map keyed by name, populated by ProviderRegistry.register */
  private readonly providers: Map<string, LLMProvider> = new Map();
  private readonly validatorNamesByPlugin = new Map<string, string[]>();

  constructor(
    context: PluginContext,
    validatorRegistry: ValidatorRegistry,
    providerRegistry: ProviderRegistry,
  ) {
    this.context = context;
    this.validatorRegistry = validatorRegistry;
    this.providerRegistry = providerRegistry;
  }

  /** Register a plugin's lifecycle hooks */
  register(hook: PluginHooks): void {
    if (this.hooks.find((h) => h.name === hook.name)) {
      return; // silent skip on duplicate
    }
    this.hooks.push(hook);
  }

  /** Unregister a plugin's lifecycle hooks */
  unregister(name: string): boolean {
    const idx = this.hooks.findIndex((h) => h.name === name);
    if (idx === -1) return false;
    this.hooks.splice(idx, 1);
    return true;
  }

  /** Get all registered hooks */
  list(): PluginHooks[] {
    return [...this.hooks];
  }

  /**
   * Initialize all registered plugins:
   * 1. Call onLoad for each plugin
   * 2. Call registerValidators for each plugin that provides them
   * 3. Call registerProvider for each plugin that provides one
   */
  async initialize(): Promise<void> {
    const registry: ProviderRegistry = {
      register: (name: string, provider: LLMProvider): void => {
        this.providers.set(name, provider);
        this.providerRegistry.register(name, provider);
      },
      getProvider: (name: string): LLMProvider | undefined => {
        return this.providers.get(name);
      },
    };

    for (const hook of this.hooks) {
      if (hook.onLoad) {
        await hook.onLoad(this.context);
      }
      const validatorsBefore = new Set(
        this.validatorRegistry.list().map((validator) => validator.name),
      );
      if (hook.registerValidators) {
        hook.registerValidators(this.validatorRegistry);
      }
      this.validatorNamesByPlugin.set(
        hook.name,
        this.validatorRegistry
          .list()
          .map((validator) => validator.name)
          .filter((name) => !validatorsBefore.has(name))
          .sort(),
      );
      if (hook.registerProvider) {
        hook.registerProvider(registry);
      }
    }
  }

  /**
   * Shut down all registered plugins by calling onUnload.
   * Runs all hooks even if some throw — errors are collected and returned.
   * Runs hooks in REVERSE registration order.
   */
  async shutdown(): Promise<string[]> {
    const errors: string[] = [];
    for (const hook of [...this.hooks].reverse()) {
      if (hook.onUnload) {
        try {
          await hook.onUnload(this.context);
        } catch (err) {
          errors.push(`Plugin "${hook.name}" onUnload failed: ${(err as Error).message}`);
        }
      }
    }
    this.hooks.length = 0;
    return errors;
  }

  /**
   * Run all beforeRender hooks with the stored PluginContext.
   * Collects errors without throwing — returns error messages.
   */
  async runBeforeRender(): Promise<string[]> {
    const errors: string[] = [];
    for (const hook of this.hooks) {
      if (hook.beforeRender) {
        try {
          await hook.beforeRender(this.context);
        } catch (err) {
          errors.push(`Plugin "${hook.name}" beforeRender failed: ${(err as Error).message}`);
        }
      }
    }
    return errors;
  }

  /**
   * Run all afterRender hooks with the stored PluginContext.
   * Collects errors without throwing — returns error messages.
   */
  async runAfterRender(): Promise<string[]> {
    const errors: string[] = [];
    for (const hook of this.hooks) {
      if (hook.afterRender) {
        try {
          await hook.afterRender(this.context);
        } catch (err) {
          errors.push(`Plugin "${hook.name}" afterRender failed: ${(err as Error).message}`);
        }
      }
    }
    return errors;
  }

  // ——— Prompt Decoration Hooks ———

  /**
   * Run all onBuildPass1Prompt hooks, validate decorations, and merge
   * in plugin-name (registration) order.
   * Exceptions propagate as hard scene failures — caller must catch.
   */
  async runOnBuildPass1Prompt(input: BuildPromptInput): Promise<readonly PromptDecoration[]> {
    return this.collectDecorations('onBuildPass1Prompt', input);
  }

  /**
   * Run all onBuildPass2Prompt hooks, validate decorations, and merge
   * in plugin-name (registration) order.
   * Exceptions propagate as hard scene failures — caller must catch.
   */
  async runOnBuildPass2Prompt(input: BuildPromptInput): Promise<readonly PromptDecoration[]> {
    return this.collectDecorations('onBuildPass2Prompt', input);
  }

  private async collectDecorations(
    hookName: 'onBuildPass1Prompt' | 'onBuildPass2Prompt',
    input: BuildPromptInput,
  ): Promise<readonly PromptDecoration[]> {
    const allDecorations: PromptDecoration[] = [];

    for (const hook of this.hooks) {
      const fn = hook[hookName];
      if (!fn) continue;

      // Hard-fail on transform exceptions — propagate up
      const result = await fn(input);

      if (!Array.isArray(result)) {
        throw new Error(`Plugin "${hook.name}" ${hookName} did not return an array`);
      }

      if (result.length > MAX_DECORATIONS_PER_PLUGIN) {
        throw new Error(
          `Plugin "${hook.name}" ${hookName} returned ${result.length} decorations, max ${MAX_DECORATIONS_PER_PLUGIN}`,
        );
      }

      const seenIds = new Set<string>();
      for (const dec of result) {
        validateDecoration(hook.name, dec, seenIds);
        allDecorations.push(dec);
      }
    }

    return Object.freeze(allDecorations);
  }

  // ——— Provider Access ———

  /**
   * Get the names of all providers registered by plugins.
   */
  getProviderNames(): string[] {
    return [...this.providers.keys()];
  }

  /**
   * Get a provider by name, as registered by a plugin.
   * Returns undefined if no provider with that name was registered.
   */
  getProvider(name: string): LLMProvider | undefined {
    return this.providers.get(name);
  }

  // ——— Validator Access ———

  /**
   * All validators registered by plugins (not the built-in set).
   * Merge these into the pipeline validator set when the manager is active.
   */
  getValidators(): readonly Validator[] {
    return this.validatorRegistry.list();
  }

  /**
   * Deterministic name/version identities for one plugin's registered
   * validators. Version defaults to the validator's own `version` when
   * declared, else the plugin's manifest version, else '1'.
   */
  getPluginValidatorIdentities(pluginName: string): ValidatorIdentity[] {
    const names = [...(this.validatorNamesByPlugin.get(pluginName) ?? [])];
    const byName = new Map(this.validatorRegistry.list().map((v) => [v.name, v]));
    const plugin = this.hooks.find((hook) => hook.name === pluginName);
    return names.map((name) => {
      const validator = byName.get(name);
      const declared = (validator as (Validator & { version?: string }) | undefined)?.version;
      return { name, version: declared ?? plugin?.version ?? '1' };
    });
  }

  // ——— Plugin Identity for Cache Scoping ———

  /**
   * Returns deterministic identities for all registered plugins.
   * Used to scope cache keys: plugin name/version/manifestHash/moduleHash +
   * present hooks + registered validator names impact prompt identity and
   * the editorial validation identity. Optional identity fields are omitted
   * when the host loader did not stamp them (canonicalJson drops undefined).
   */
  getPluginIdentities(): Array<{
    name: string;
    version: string | undefined;
    manifestHash: string | undefined;
    moduleHash: string | undefined;
    hooks: string[];
    validators: string[];
  }> {
    return this.hooks
      .map((hook) => ({
        name: hook.name,
        version: hook.version,
        manifestHash: hook.manifestHash,
        moduleHash: hook.moduleHash,
        hooks: (Object.keys(hook) as (keyof PluginHooks)[])
          .filter((key) => key !== 'name' && typeof hook[key] === 'function')
          .sort(),
        validators: [...(this.validatorNamesByPlugin.get(hook.name) ?? [])],
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }
}
