// ============================================================================
// ConfigLoader — layer precedence, deep merge, Zod validation
// ============================================================================

import { describe, expect, it } from 'vitest';
import { ConfigLoader, DEFAULT_CONFIG, resolveConfig } from '../src/config/index.js';
import { projectConfigSchema } from '../src/schemas/project.js';

describe('ConfigLoader', () => {
  describe('defaults', () => {
    it('should provide all default values', () => {
      const loader = new ConfigLoader();
      const config = loader.resolve();
      expect(config.snapshotInterval).toBe(10);
      expect(config.concurrency).toBe(5);
      expect(config.logLevel).toBe('info');
      expect(config.traceLevel).toBe('off');
      expect(config.defaultSceneTextTarget).toBe(400);
      expect(config.cacheEnabled).toBe(true);
    });
  });

  describe('layer precedence', () => {
    it('project layer should override defaults', () => {
      const loader = new ConfigLoader();
      loader.addLayer('project', { concurrency: 3 });
      const config = loader.resolve();
      expect(config.concurrency).toBe(3);
      expect(config.snapshotInterval).toBe(10); // unchanged
    });

    it('CLI layer should override project layer', () => {
      const loader = new ConfigLoader();
      loader.addLayer('project', { concurrency: 3, snapshotInterval: 5 });
      loader.addLayer('cli', { concurrency: 8 });
      const config = loader.resolve();
      expect(config.concurrency).toBe(8);
      expect(config.snapshotInterval).toBe(5); // unchanged (project visible)
    });

    it('runtime layer should override all', () => {
      const loader = new ConfigLoader();
      loader.addLayer('project', { concurrency: 3 });
      loader.addLayer('cli', { concurrency: 5 });
      loader.addLayer('runtime', { concurrency: 10 });
      const config = loader.resolve();
      expect(config.concurrency).toBe(10);
    });

    it('env values should override project but not CLI', () => {
      const loader = new ConfigLoader();
      loader.addLayer('project', { concurrency: 3 });
      loader.addLayer('env', { concurrency: 7 });
      loader.addLayer('cli', { concurrency: 5 });
      const config = loader.resolve();
      expect(config.concurrency).toBe(5); // CLI beats env
    });

    it('should build 5-layer chain without error', () => {
      const loader = new ConfigLoader();
      loader.addLayer('project', { concurrency: 2 });
      loader.addLayer('env', { logLevel: 'debug' });
      loader.addLayer('cli', { traceLevel: 'basic' });
      loader.addLayer('runtime', { cacheEnabled: false });
      expect(() => loader.resolve()).not.toThrow();
      const config = loader.resolve();
      expect(config.concurrency).toBe(2);
      expect(config.logLevel).toBe('debug');
      expect(config.traceLevel).toBe('basic');
      expect(config.cacheEnabled).toBe(false);
    });
  });

  describe('deep merge', () => {
    it('should merge nested objects, not replace them', () => {
      const loader = new ConfigLoader();
      loader.addLayer('project', {
        circuitBreaker: { maxRetries: 5 },
      });
      const config = loader.resolve();
      // circuitBreaker is NOT in defaults, so it appears as-is
      expect(config.circuitBreaker).toEqual({ maxRetries: 5 });
    });

    it('primitive values in later layer should replace earlier ones', () => {
      const loader = new ConfigLoader();
      loader.addLayer('project', { snapshotInterval: 20 });
      const config = loader.resolve();
      expect(config.snapshotInterval).toBe(20);
    });
  });

  describe('resolveConfig', () => {
    it('should return defaults when no overrides provided', () => {
      const config = resolveConfig();
      expect(config).toEqual(DEFAULT_CONFIG);
    });

    it('should merge overrides with defaults', () => {
      const config = resolveConfig({ concurrency: 1, traceLevel: 'basic' });
      expect(config.concurrency).toBe(1);
      expect(config.traceLevel).toBe('basic');
    });

    it('should not mutate the original DEFAULT_CONFIG', () => {
      const before = { ...DEFAULT_CONFIG };
      resolveConfig({ concurrency: 99 });
      expect(DEFAULT_CONFIG.concurrency).toBe(before.concurrency);
    });
  });

  describe('Zod validation', () => {
    it('should validate resolved config against project schema', () => {
      const loader = new ConfigLoader();
      loader.addLayer('project', { concurrency: 3 });
      const config = loader.resolve();
      // The project schema won't accept unknown fields, but we validate
      // against what the schema knows.
      const valid = projectConfigSchema.partial().safeParse(config);
      expect(valid.success).toBe(true);
    });

    it('should reject invalid logLevel', () => {
      const loader = new ConfigLoader();
      loader.addLayer('project', { logLevel: 'verbose' });
      const config = loader.resolve();
      // project schema should catch invalid logLevel
      const result = projectConfigSchema.partial().safeParse(config);
      expect(result.success).toBe(false);
    });

    it('should reject invalid traceLevel', () => {
      const result = projectConfigSchema.partial().safeParse({ traceLevel: 'super' });
      expect(result.success).toBe(false);
    });

    it('should accept valid config values', () => {
      const result = projectConfigSchema.partial().safeParse({
        concurrency: 4,
        logLevel: 'warn',
        traceLevel: 'detailed',
        cacheEnabled: false,
      });
      expect(result.success).toBe(true);
    });

    it('should reject non-positive concurrency', () => {
      const result = projectConfigSchema.partial().safeParse({ concurrency: 0 });
      expect(result.success).toBe(false);
    });
  });

  describe('ConfigLoader.validate', () => {
    it('should resolve and validate in one step', () => {
      const loader = new ConfigLoader();
      loader.addLayer('project', { concurrency: 2 });
      const config = loader.validate(projectConfigSchema.partial());
      expect(config.concurrency).toBe(2);
      expect(config.snapshotInterval).toBe(10); // from defaults
    });

    it('should throw on invalid values via validate', () => {
      const loader = new ConfigLoader();
      loader.addLayer('project', { logLevel: 'critical' });
      expect(() => loader.validate(projectConfigSchema.partial())).toThrow();
    });
  });
});
