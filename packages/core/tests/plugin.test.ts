// ============================================================================
// Comprehensive Unit Tests — Plugin System
// ============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import {
  PluginLoader,
  detectConflicts,
  resolveConflict,
  ValidatorRegistry,
} from '../src/plugin/index.js';
import type { PluginManifest } from '../src/types/index.js';
import * as realSwearFilter from './plugins/swear-filter/index.js';

// ============================================================================
// Test Fixtures
// ============================================================================

const manifestA: PluginManifest = {
  name: 'plugin-a',
  version: '1.0.0',
  priority: 10,
  provides: ['feature-a'],
  requires: [],
  conflicts: ['plugin-b'],
  authority: { dimensions: ['dim-x'], exclusive: true },
  observes: { eventTypes: [], stateDomains: [] },
};

const manifestB: PluginManifest = {
  name: 'plugin-b',
  version: '1.0.0',
  priority: 20,
  provides: ['feature-b'],
  requires: [],
  conflicts: [],
  authority: { dimensions: ['dim-x'], exclusive: true },
  observes: { eventTypes: [], stateDomains: [] },
};

const manifestC: PluginManifest = {
  name: 'plugin-c',
  version: '1.0.0',
  priority: 5,
  provides: ['feature-c'],
  requires: [],
  conflicts: [],
  authority: { dimensions: ['dim-y'], exclusive: false },
  observes: { eventTypes: [], stateDomains: [] },
};

// ============================================================================
// 1. PluginLoader Tests
// ============================================================================

describe('PluginLoader', () => {
  let loader: PluginLoader;

  beforeEach(() => {
    loader = new PluginLoader();
  });

  it('should register and retrieve a plugin', () => {
    loader.register(manifestA);
    expect(loader.get('plugin-a')).toBe(manifestA);
  });

  it('should list all registered plugins', () => {
    loader.register(manifestA);
    loader.register(manifestB);
    expect(loader.list()).toHaveLength(2);
    expect(loader.list()).toContain(manifestA);
    expect(loader.list()).toContain(manifestB);
  });

  it('should throw when registering a duplicate plugin', () => {
    loader.register(manifestA);
    expect(() => loader.register(manifestA)).toThrow('already registered');
  });

  it('should unregister a plugin', () => {
    loader.register(manifestA);
    expect(loader.unregister('plugin-a')).toBe(true);
    expect(loader.get('plugin-a')).toBeUndefined();
  });

  it('should clear all plugins', () => {
    loader.register(manifestA);
    loader.register(manifestB);
    loader.clear();
    expect(loader.list()).toHaveLength(0);
  });
});

// ============================================================================
// 2. detectConflicts Tests
// ============================================================================

describe('detectConflicts', () => {
  it('detects explicit conflicts entries', () => {
    const conflicts = detectConflicts([manifestA, manifestB]);
    expect(conflicts.length).toBeGreaterThanOrEqual(1);
    expect(conflicts.some(c => c.reason.includes('explicitly declares conflict'))).toBe(true);
  });

  it('detects overlapping exclusive dimensions', () => {
    const conflicts = detectConflicts([manifestA, manifestB]);
    const dimConflict = conflicts.find(c => c.dimension === 'dim-x');
    expect(dimConflict).toBeDefined();
    expect(dimConflict!.reason).toContain('exclusive authority');
  });

  it('returns empty when no conflicts exist', () => {
    const conflicts = detectConflicts([manifestA, manifestC]);
    // manifestA conflicts with manifestB, not C; different dimensions, C not exclusive
    expect(conflicts).toHaveLength(0);
  });
});

// ============================================================================
// 3. resolveConflict Tests
// ============================================================================

describe('resolveConflict', () => {
  it('priority picks higher priority plugin', () => {
    const plugins = new Map<string, PluginManifest>([
      ['plugin-a', manifestA],
      ['plugin-b', manifestB],
    ]);
    // manifestB has priority 20 > manifestA priority 10
    expect(resolveConflict(plugins, 'plugin-a', 'plugin-b', 'priority')).toBe('plugin-b');
  });

  it('first_writer_wins returns pluginA', () => {
    const plugins = new Map<string, PluginManifest>();
    expect(resolveConflict(plugins, 'plugin-a', 'plugin-b', 'first_writer_wins')).toBe('plugin-a');
  });

  it('merge strategy returns both plugin names comma-separated', () => {
    const plugins = new Map<string, PluginManifest>();
    expect(resolveConflict(plugins, 'plugin-a', 'plugin-b', 'merge')).toBe(
      'plugin-a,plugin-b',
    );
  });

  it('human_arbitration strategy throws an error', () => {
    const plugins = new Map<string, PluginManifest>();
    expect(() =>
      resolveConflict(plugins, 'plugin-a', 'plugin-b', 'human_arbitration'),
    ).toThrow('requires human arbitration');
  });

  it('priority returns null for unknown plugins', () => {
    const plugins = new Map<string, PluginManifest>();
    expect(resolveConflict(plugins, 'unknown-a', 'unknown-b', 'priority')).toBeNull();
  });
});

// ============================================================================
// 4. ValidatorRegistry Tests
// ============================================================================

describe('ValidatorRegistry', () => {
  it('should register a validator', () => {
    const registry = new ValidatorRegistry();
    const validator = {
      name: 'test-validator',
      validate: () => ({ passed: true, errors: [], warnings: [], infos: [] }),
    };
    expect(() => registry.register(validator)).not.toThrow();
  });

  it('runAll invokes each registered validator', () => {
    const registry = new ValidatorRegistry();
    let called = false;
    const validator = {
      name: 'test-validator',
      validate: () => {
        called = true;
        return { passed: true, errors: [], warnings: [], infos: [] };
      },
    };
    registry.register(validator);
    const results = registry.runAll({} as any);
    expect(called).toBe(true);
    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(true);
  });

  it('empty registry returns empty array', () => {
    const registry = new ValidatorRegistry();
    expect(registry.runAll({} as any)).toEqual([]);
  });
});

// ============================================================================
// 5. Real Plugin Integration Test
// ============================================================================

describe('Real Plugin — swear-filter', () => {
  it('loader.register accepts real manifest and detectConflicts returns []', () => {
    const loader = new PluginLoader();
    loader.register(realSwearFilter.manifest);
    expect(loader.get('swear-filter')).toBe(realSwearFilter.manifest);
    expect(loader.detectConflicts()).toEqual([]);
  });

  it('validateCommentText detects placeholder words', () => {
    const result = realSwearFilter.validateCommentText('foo sailor_pirate_vocab_1 bar');
    expect(result).toEqual({
      hasSwears: true,
      matches: ['sailor_pirate_vocab_1'],
    });
  });

  it('validateCommentText returns empty for clean text', () => {
    const result = realSwearFilter.validateCommentText('this is perfectly clean text');
    expect(result.hasSwears).toBe(false);
    expect(result.matches).toEqual([]);
  });
});
