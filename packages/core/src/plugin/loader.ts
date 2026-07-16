// ============================================================================
// Plugin System — Plugin Loader
// ============================================================================

import type { PluginManifest, ArbitrationStrategy } from '../types/index.js';
import type { ConflictReport, ResolutionResult } from './types.js';
import { detectConflicts } from './conflicts.js';
import { resolveConflict } from './resolve.js';

export class PluginLoader {
  private plugins: Map<string, PluginManifest> = new Map();

  /** Register a plugin manifest */
  register(manifest: PluginManifest): void {
    if (this.plugins.has(manifest.name)) {
      throw new Error(`Plugin "${manifest.name}" is already registered`);
    }
    this.plugins.set(manifest.name, manifest);
  }

  /** Get a registered plugin */
  get(name: string): PluginManifest | undefined {
    return this.plugins.get(name);
  }

  /** List all registered plugins */
  list(): PluginManifest[] {
    return [...this.plugins.values()];
  }

  /** Unregister a plugin by name */
  unregister(name: string): boolean {
    return this.plugins.delete(name);
  }

  /** Clear all registered plugins */
  clear(): void {
    this.plugins.clear();
  }

  /** Detect conflicts between registered plugins */
  detectConflicts(): ConflictReport[] {
    return detectConflicts(this.list());
  }

  /**
   * Resolve a conflict between two plugins using the given strategy.
   */
  resolveConflict(
    pluginA: string,
    pluginB: string,
    strategy: ArbitrationStrategy,
  ): ResolutionResult {
    return resolveConflict(this.plugins, pluginA, pluginB, strategy);
  }

  /** Load plugins from a directory */
  async loadFromDirectory(_dirPath: string): Promise<void> {
    // Placeholder for filesystem plugin loading
    // In MVP, plugins are registered programmatically
  }
}
