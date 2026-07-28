// ============================================================================
// Plugin System — Local Types
// ============================================================================

import type { LLMProvider } from '../ai/types.ts';
import type { Logger } from '../observability/logger.ts';
import type { Storage } from '../storage/types.js';
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
 * Registry for plugins to register AND retrieve custom LLM providers.
 */
export interface ProviderRegistry {
  register(name: string, provider: LLMProvider): void;
  /**
   * Retrieve a registered provider by name.
   * Returns undefined if no provider with that name was registered.
   */
  getProvider(name: string): LLMProvider | undefined;
}

// ——— Prompt Decoration ———

/**
 * A non-authoritative prompt decoration produced by a plugin hook.
 * Core inserts it into a clearly marked section and never allows it
 * to override authoritative narrative context, scene contract, or YAML.
 * Content MUST be ≤ 4096 bytes; id MUST be unique within the producing plugin.
 */
export interface PromptDecoration {
  /** Unique decoration id WITHIN the producing plugin */
  id: string;
  /** Decoration text content (max 4096 bytes) */
  content: string;
  /** Deterministic cache key for this decoration (SHA-256 hex recommended) */
  cacheKey: string;
}

// ——— Build Prompt Input ———

/**
 * Frozen read-only input provided to plugin prompt-decoration hooks.
 * Plugins receive this exact shape — they cannot modify the event, contract,
 * messages, or any other field. Every property is readonly.
 */
export interface BuildPromptInput {
  readonly phase: 'pass1' | 'pass2';
  readonly eventId: string;
  readonly chapter: number;
  readonly attempt: number;
  readonly pass2Attempt?: number;
  readonly contractHash: string;
  readonly messages: readonly Readonly<{ role: string; content: string }>[];
}

// ——— Plugin Hooks ———

/**
 * Lifecycle hooks a plugin can implement.
 * Each hook receives a read-only PluginContext — plugins cannot mutate core state.
 * Transform hooks (onBuildPass1Prompt/onBuildPass2Prompt) throw on error
 * as a hard scene failure — non-transform hooks are observation-only.
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
   * Non-authoritative observation only — plugin cannot modify core state.
   * Errors are collected (non-fatal).
   */
  beforeRender?(ctx: PluginContext): Promise<void>;

  /**
   * Called after rendering a scene.
   * Non-authoritative observation only — plugin cannot modify core state.
   * Errors are collected (non-fatal).
   */
  afterRender?(ctx: PluginContext): Promise<void>;

  /**
   * Build non-authoritative decorations for the Pass 1 prompt.
   * Receives a frozen BuildPromptInput — plugin cannot mutate core prompt, event, or state.
   * Returns readonly PromptDecoration[] to be merged in plugin-name order.
   * Exceptions are treated as hard scene failures (not collected).
   */
  onBuildPass1Prompt?(input: BuildPromptInput): Promise<readonly PromptDecoration[]>;

  /**
   * Build non-authoritative decorations for the Pass 2 prompt.
   * Same contract as onBuildPass1Prompt — applies to Pass 2 analysis prompts.
   * Exceptions are treated as hard scene failures.
   */
  onBuildPass2Prompt?(input: BuildPromptInput): Promise<readonly PromptDecoration[]>;
}
