// ============================================================================
// Plugin System — Conflict Detection
// ============================================================================

import type { PluginManifest } from '../types/index.js';
import type { ConflictReport } from './types.js';

export function detectConflicts(plugins: PluginManifest[]): ConflictReport[] {
  const conflicts: ConflictReport[] = [];

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
      if (a.authority.exclusive || b.authority.exclusive) {
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
