// ============================================================================
// Plugin System — Local Types
// ============================================================================

import type { Storage } from '../storage/types.js';
import type { Logger } from '../observability/logger.ts';
import type { LLMProvider } from '../ai/types.ts';
import type { ValidatorRegistry } from './validator-registry.js';

// ——— Conflict Detection ———

export interface ConflictReport {
  pluginA: string;
  pluginB: string;
  reason: string;
  dimension?: string;
}

export type ResolutionResult = string | null;

// ——— Plugin Context ———

/**
 * Read-only context provided to plugin lifecycle hooks.
 * Plugins have read-only access — no mutation of core state.
 */
export interface PluginContext {
  readonly projectDir: string;
  readonly storage: Storage;
  readonly log: Logger;
}

// ——— Provider Registry ———

/**
 * Registry for plugins to register custom LLM providers.
 */
export interface ProviderRegistry {
  register(name: string, provider: LLMProvider): void;
}

// ——— Plugin Hooks ———

/**
 * Lifecycle hooks a plugin can implement.
 * Each hook receives a read-only PluginContext — plugins cannot mutate core state.
 */
export interface PluginHooks {
  /** Unique plugin name for identification in errors/logs */
  name: string;

  /** Called when the plugin is loaded */
  onLoad?(ctx: PluginContext): Promise<void>;

  /** Called when the plugin is unloaded */
  onUnload?(ctx: PluginContext): Promise<void>;

  /**
   * Register custom validators with the ValidatorRegistry.
   * Called during plugin initialization.
   */
  registerValidators?(registry: ValidatorRegistry): void;

  /**
   * Register a custom LLM provider.
   * Called during plugin initialization.
   */
  registerProvider?(registry: ProviderRegistry): void;

  /**
   * Called before rendering a scene.
   * Non-authoritative surface decoration only — plugin cannot modify core state.
   */
  beforeRender?(ctx: PluginContext): Promise<void>;

  /**
   * Called after rendering a scene.
   * Non-authoritative surface decoration only — plugin cannot modify core state.
   */
  afterRender?(ctx: PluginContext): Promise<void>;
}
