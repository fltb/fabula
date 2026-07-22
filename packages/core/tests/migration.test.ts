// ============================================================================
// Schema Migration — Tests
// ============================================================================

import { describe, it, expect } from 'vitest';
import { migrateToLatest, CURRENT_SCHEMA_VERSION } from '../src/migration/index.js';
import { loadProjectConfig } from '../src/entity/yaml-loader.js';
import { projectConfigSchema } from '../src/schemas/project.js';
import { MemoryStorage } from '../src/storage/index.ts';

// ============================================================================
// 1. migrateToLatest
// ============================================================================

describe('migrateToLatest', () => {
  it('returns data unchanged when currentVersion equals targetVersion', () => {
    const data = { project: 'test', schemaVersion: 1 };
    const result = migrateToLatest(data, 1, 1);
    expect(result.schemaVersion).toBe(1);
    expect(result.project).toBe('test');
  });

  it('throws when currentVersion exceeds targetVersion', () => {
    const data = { project: 'test', schemaVersion: 999 };
    expect(() => migrateToLatest(data, 999, 1)).toThrow(
      /schema version 999 is newer than supported 1/,
    );
  });

  it('migrates from version 0 to CURRENT_SCHEMA_VERSION', () => {
    const data = { project: 'test', title: 'Test', author: 'Tester' };
    const result = migrateToLatest(data, 0, CURRENT_SCHEMA_VERSION);
    expect(result.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(result.project).toBe('test');
  });

  it('preserves extra fields through migration', () => {
    const data = { project: 'test', customField: 'preserved' };
    const result = migrateToLatest(data, 0, 1);
    expect(result.schemaVersion).toBe(1);
    expect(result.customField).toBe('preserved');
  });

  it('does not mutate the original data object', () => {
    const data = { project: 'test' };
    const result = migrateToLatest(data, 0, 1);
    expect(result.schemaVersion).toBe(1);
    // Original should still be unchanged
    expect(data).not.toHaveProperty('schemaVersion');
  });
});

// ============================================================================
// 2. Project Config schemaVersion default
// ============================================================================

describe('projectConfigSchema schemaVersion', () => {
  it('defaults schemaVersion to 1 when omitted', () => {
    const data = {
      project: 'test',
      title: 'Test Project',
      author: 'Author',
    };
    const parsed = projectConfigSchema.safeParse(data);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.schemaVersion).toBe(1);
    }
  });

  it('accepts schemaVersion when explicitly provided', () => {
    const data = {
      project: 'test',
      title: 'Test Project',
      author: 'Author',
      schemaVersion: 1,
    };
    const parsed = projectConfigSchema.safeParse(data);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.schemaVersion).toBe(1);
    }
  });

  it('rejects non-number schemaVersion', () => {
    const data = {
      project: 'test',
      title: 'Test Project',
      author: 'Author',
      schemaVersion: 'one',
    };
    const parsed = projectConfigSchema.safeParse(data);
    expect(parsed.success).toBe(false);
  });
});

// ============================================================================
// 3. loadProjectConfig
// ============================================================================

describe('loadProjectConfig', () => {
  it('loads config without schemaVersion and defaults to 1', () => {
    const storage = new MemoryStorage();
    storage.write('/nova.yaml', 'project: test\ntitle: "Test"\nauthor: "A"\n');

    const config = loadProjectConfig('/nova.yaml', storage);
    expect(config).not.toBeNull();
    expect(config!.schemaVersion).toBe(1);
  });

  it('loads config with explicit schemaVersion: 1', () => {
    const storage = new MemoryStorage();
    storage.write(
      '/nova.yaml',
      'project: test\ntitle: "Test"\nauthor: "A"\nschemaVersion: 1\n',
    );

    const config = loadProjectConfig('/nova.yaml', storage);
    expect(config).not.toBeNull();
    expect(config!.schemaVersion).toBe(1);
  });

  it('throws on future schemaVersion', () => {
    const storage = new MemoryStorage();
    storage.write(
      '/nova.yaml',
      'project: test\ntitle: "Test"\nauthor: "A"\nschemaVersion: 999\n',
    );

    expect(() => loadProjectConfig('/nova.yaml', storage)).toThrow(
      /schema version 999 is newer than supported/,
    );
  });

  it('returns null for missing file', () => {
    const storage = new MemoryStorage();
    const result = loadProjectConfig('/nonexistent.yaml', storage);
    expect(result).toBeNull();
  });
});
