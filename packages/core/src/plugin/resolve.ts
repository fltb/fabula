// ============================================================================
// Plugin System — Conflict Resolution
import { logger } from '../observability/logger.ts';
// ============================================================================

import type { ArbitrationStrategy, PluginManifest } from '../types/index.js';
import type { ResolutionResult } from './types.js';

/**
 * Resolve a conflict between two plugins using the given strategy.
 * - `priority`: higher priority wins (default if strategy unknown)
 * - `first_writer_wins`: first registered plugin wins
 * - `merge`: returns both plugin names comma-separated for caller to apply both
 * - `human_arbitration`: throws because manual resolution is required
 */
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
    case 'merge': {
      // Return both plugin names — caller should apply both results
      return `${pluginA},${pluginB}`;
    }
    case 'human_arbitration':
      throw new Error(
        `Conflict between "${pluginA}" and "${pluginB}" requires human arbitration. ` +
          'Resolve manually and re-run with an explicit strategy.',
      );
    default: {
      logger.warn('Unknown conflict resolution strategy', { module: 'plugin' });
      return resolveConflict(plugins, pluginA, pluginB, 'priority');
    }
  }
}
