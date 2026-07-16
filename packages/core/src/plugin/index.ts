// ============================================================================
// Plugin System — Manifest parsing, conflict detection, arbitration
// ============================================================================

import type {
  PluginManifest,
  ArbitrationStrategy,
} from '../types/index.js';

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

  /** Detect conflicts between registered plugins */
  detectConflicts(): Array<{
    pluginA: string;
    pluginB: string;
    reason: string;
    dimension?: string;
  }> {
    const conflicts: Array<{
      pluginA: string;
      pluginB: string;
      reason: string;
      dimension?: string;
    }> = [];
    const plugins = this.list();

    for (let i = 0; i < plugins.length; i++) {
      for (let j = i + 1; j < plugins.length; j++) {
        const a = plugins[i];
        const b = plugins[j];

        // Check explicit conflicts
        if (a.conflicts.includes(b.name) || b.conflicts.includes(a.name)) {
          conflicts.push({
            pluginA: a.name,
            pluginB: b.name,
            reason: `${a.name} explicitly declares conflict with ${b.name}`,
          });
        }

        // Check exclusive authority dimensions
        if (a.authority.exclusive && b.authority.exclusive) {
          for (const dim of a.authority.dimensions) {
            if (b.authority.dimensions.includes(dim)) {
              conflicts.push({
                pluginA: a.name,
                pluginB: b.name,
                reason: `Both claim exclusive authority over dimension "${dim}"`,
                dimension: dim,
              });
            }
          }
        }
      }
    }

    return conflicts;
  }

  /**
   * Resolve a conflict between two plugins using the given strategy.
   */
  resolveConflict(
    pluginA: string,
    pluginB: string,
    strategy: ArbitrationStrategy,
  ): string | null {
    switch (strategy) {
      case 'priority': {
        const a = this.plugins.get(pluginA);
        const b = this.plugins.get(pluginB);
        if (!a || !b) return null;
        return a.priority >= b.priority ? pluginA : pluginB;
      }
      case 'first_writer_wins':
        return pluginA; // First registered wins
      case 'merge':
        return null; // Both kept, caller merges
      case 'human_arbitration':
        return null; // Requires human decision
      default:
        return null;
    }
  }

  /** Load plugins from a directory */
  async loadFromDirectory(_dirPath: string): Promise<void> {
    // Placeholder for filesystem plugin loading
    // In MVP, plugins are registered programmatically
  }
}
