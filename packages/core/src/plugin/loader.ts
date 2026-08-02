// ============================================================================
// Plugin registry — pure manifest conflict and registration semantics.
//
// Host code discovers manifests and loads JavaScript modules, then passes the
// resulting values and hooks to this registry. Core never receives paths,
// storage adapters, or dynamic module-loading authority.
// ============================================================================

import type { ArbitrationStrategy, PluginManifest } from '../types/index.js';
import { detectConflicts } from './conflicts.js';
import { resolveConflict } from './resolve.js';
import type { ConflictReport, ResolutionResult } from './types.js';

export class PluginLoader {
  private readonly plugins = new Map<string, PluginManifest>();

  register(manifest: PluginManifest): void {
    if (this.plugins.has(manifest.name)) {
      throw new Error(`Plugin "${manifest.name}" is already registered`);
    }
    this.plugins.set(manifest.name, manifest);
  }

  get(name: string): PluginManifest | undefined {
    return this.plugins.get(name);
  }

  list(): PluginManifest[] {
    return [...this.plugins.values()];
  }

  unregister(name: string): boolean {
    return this.plugins.delete(name);
  }

  clear(): void {
    this.plugins.clear();
  }

  detectConflicts(): ConflictReport[] {
    return detectConflicts(this.list());
  }

  resolveConflict(
    pluginA: string,
    pluginB: string,
    strategy: ArbitrationStrategy,
  ): ResolutionResult {
    return resolveConflict(this.plugins, pluginA, pluginB, strategy);
  }
}
