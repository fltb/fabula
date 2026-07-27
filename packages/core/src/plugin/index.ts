// ============================================================================
// Plugin System — Public API
// ============================================================================

export { detectConflicts } from './conflicts.js';
export { PluginHooksManager } from './hooks-manager.js';
export { PluginLoader } from './loader.js';
export { resolveConflict } from './resolve.js';
export type {
  ConflictReport,
  PluginContext,
  PluginHooks,
  ProviderRegistry,
  ResolutionResult,
} from './types.js';
export type { PluginValidator } from './validator-registry.js';
export { ValidatorRegistry } from './validator-registry.js';
