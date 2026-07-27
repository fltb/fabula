// ============================================================================
// Swear-Filter Plugin — Real working plugin proving the system works
// ============================================================================

import type { PluginLoader } from '../../../src/plugin/index.js';
import type { PluginManifest } from '../../../src/types/index.js';

export const manifest: PluginManifest = {
  name: 'swear-filter',
  version: '0.1.0',
  priority: 50,
  provides: ['profanity-detection'],
  requires: [],
  conflicts: [],
  authority: {
    dimensions: ['comment-text'],
    exclusive: false,
  },
  observes: {
    eventTypes: ['review.comment.added'],
    stateDomains: [],
  },
};

const BAD_WORDS = ['sailor_pirate_vocab_1', 'sailor_pirate_vocab_2'];

export function validateCommentText(text: string): { hasSwears: boolean; matches: string[] } {
  const matches = BAD_WORDS.filter((word) => text.includes(word));
  return {
    hasSwears: matches.length > 0,
    matches,
  };
}

export function register(loader: PluginLoader): void {
  loader.register(manifest);
}
