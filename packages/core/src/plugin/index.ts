// ============================================================================
// Plugin System — Public API
// ============================================================================

export { PluginLoader } from './loader.js';
export { detectConflicts } from './conflicts.js';
export { resolveConflict } from './resolve.js';
export { ValidatorRegistry } from './validator-registry.js';
export { PluginHooksManager } from './hooks-manager.js';
export type { PluginValidator } from './validator-registry.js';
export type { ConflictReport, ResolutionResult, PluginContext, ProviderRegistry, PluginHooks } from './types.js';
