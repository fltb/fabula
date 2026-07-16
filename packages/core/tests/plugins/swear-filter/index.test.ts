// ============================================================================
// Swear-Filter Plugin — Unit Tests
// ============================================================================

import { describe, it, expect } from 'vitest';
import * as swearFilter from './index.js';
import { PluginLoader } from '../../../src/plugin/index.js';

describe('swear-filter plugin', () => {
  it('manifest matches yaml fields', () => {
    expect(swearFilter.manifest.name).toBe('swear-filter');
    expect(swearFilter.manifest.version).toBe('0.1.0');
    expect(swearFilter.manifest.priority).toBe(50);
    expect(swearFilter.manifest.provides).toEqual(['profanity-detection']);
    expect(swearFilter.manifest.authority.dimensions).toEqual(['comment-text']);
    expect(swearFilter.manifest.authority.exclusive).toBe(false);
    expect(swearFilter.manifest.observes.eventTypes).toEqual(['review.comment.added']);
  });

  it('validateCommentText detects placeholder words', () => {
    const result = swearFilter.validateCommentText('this contains sailor_pirate_vocab_1');
    expect(result.hasSwears).toBe(true);
    expect(result.matches).toEqual(['sailor_pirate_vocab_1']);
  });

  it('validateCommentText returns empty for clean text', () => {
    const result = swearFilter.validateCommentText('this is clean text');
    expect(result.hasSwears).toBe(false);
    expect(result.matches).toEqual([]);
  });

  it('register adds to loader', () => {
    const loader = new PluginLoader();
    swearFilter.register(loader);
    expect(loader.get('swear-filter')).toBe(swearFilter.manifest);
  });

  it('end-to-end: load manifest + register + run validateCommentText', () => {
    const loader = new PluginLoader();
    loader.register(swearFilter.manifest);
    expect(loader.detectConflicts()).toEqual([]);
    expect(swearFilter.validateCommentText('foo sailor_pirate_vocab_1 bar')).toEqual({
      hasSwears: true,
      matches: ['sailor_pirate_vocab_1'],
    });
  });
});
