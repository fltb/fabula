// ============================================================================
// Plugin System — Public API
// ============================================================================

export { detectConflicts } from './conflicts.js';
export type { PluginExtensionSchema } from './extension-registrar.js';
export { PluginExtensionSchemaRegistrar } from './extension-registrar.js';
export { PluginHooksManager } from './hooks-manager.js';
export { PluginLoader } from './loader.js';
export { resolveConflict } from './resolve.js';
export type {
  BuildPromptInput,
  ConflictReport,
  PluginContext,
  PluginHooks,
  PromptDecoration,
  ProviderRegistry,
  ResolutionResult,
} from './types.js';
export type { ValidatorRegistrar } from './validator-registry.js';
export { ValidatorRegistry } from './validator-registry.js';
