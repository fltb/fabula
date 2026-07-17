// ============================================================================
// Plugin System — Plugin Loader
// ============================================================================

import * as path from 'node:path';
import * as yaml from 'yaml';
import type { PluginManifest, ArbitrationStrategy } from '../types/index.js';
import type { ConflictReport, ResolutionResult } from './types.js';
import type { Storage } from '../storage/types.js';
import { detectConflicts } from './conflicts.js';
import { resolveConflict } from './resolve.js';

export class PluginLoader {
  private plugins: Map<string, PluginManifest> = new Map();
  private storage: Storage;

  constructor(storage: Storage) {
    this.storage = storage;
  }

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
  async loadFromDirectory(dirPath: string): Promise<void> {
    try {
      const entries = this.storage.list(dirPath);
      if (!entries || entries.length === 0) return;

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const pluginDir = path.join(dirPath, entry.name);
        const manifestPath = path.join(pluginDir, 'manifest.yaml');

        try {
          const manifestContent = this.storage.readOptional(manifestPath);
          if (!manifestContent) continue;

          const manifest = yaml.parse(manifestContent) as PluginManifest;
          if (!manifest || !manifest.name) {
            console.warn(`[PluginLoader] Invalid manifest in ${manifestPath}`);
            continue;
          }

          this.register(manifest);
          console.log(`[PluginLoader] Loaded plugin "${manifest.name}" v${manifest.version}`);
        } catch (err) {
          console.warn(`[PluginLoader] Failed to load plugin from ${pluginDir}: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      // Directory may not exist yet — not an error
      if ((err as { code?: string }).code !== 'ENOENT') {
        throw err;
      }
    }
  }
}
