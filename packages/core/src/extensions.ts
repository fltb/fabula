// ============================================================================
// Extensions — scoped public entry: plugin extension contracts.
// Published as `@novalistically/core/extensions`. Type-only entry.
// ============================================================================

export type {
  BuildPromptInput,
  PluginContext,
  PluginHooks,
  PluginLogger,
  PromptDecoration,
  ProviderRegistry,
} from './plugin/types.ts';
export type { ValidatorRegistrar } from './plugin/validator-registry.ts';
export type { PluginManifest } from './types/plugin.ts';
