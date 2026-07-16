// ============================================================================
// Plugin System — Conflict Resolution
// ============================================================================

import type { PluginManifest, ArbitrationStrategy } from '../types/index.js';
import type { ResolutionResult } from './types.js';

export function resolveConflict(
  plugins: Map<string, PluginManifest>,
  pluginA: string,
  pluginB: string,
  strategy: ArbitrationStrategy,
): ResolutionResult {
  switch (strategy) {
    case 'priority': {
      const a = plugins.get(pluginA);
      const b = plugins.get(pluginB);
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
