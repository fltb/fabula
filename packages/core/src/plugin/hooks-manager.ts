// ============================================================================
// PluginHooksManager — Register and invoke plugin lifecycle hooks
// ============================================================================

import type { PluginContext, PluginHooks, ProviderRegistry } from './types.ts';
import type { ValidatorRegistry } from './validator-registry.ts';

/**
 * Manages plugin lifecycle hooks: load, unload, validator registration,
 * provider registration, and pipeline observation points.
 *
 * Plugins receive a read-only PluginContext — no mutation of core state.
 */
export class PluginHooksManager {
  private readonly hooks: PluginHooks[] = [];
  private readonly validatorRegistry: ValidatorRegistry;
  private readonly providerRegistry: ProviderRegistry;
  private readonly context: PluginContext;

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
    for (const hook of this.hooks) {
      if (hook.onLoad) {
        await hook.onLoad(this.context);
      }
      if (hook.registerValidators) {
        hook.registerValidators(this.validatorRegistry);
      }
      if (hook.registerProvider) {
        hook.registerProvider(this.providerRegistry);
      }
    }
  }

  /**
   * Shut down all registered plugins by calling onUnload.
   * Runs all hooks even if some throw — errors are collected and returned.
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
}
