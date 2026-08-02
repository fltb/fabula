import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileRenderCacheRepository } from '../src/cache/file-render-cache-repository.js';
import { cacheKey, cacheRecord, withTempProject } from './cache-fixtures.js';

describe('FileRenderCacheRepository', () => {
  it('round trips complete records and isolates keys', async () => {
    await withTempProject(async (root) => {
      const repository = new FileRenderCacheRepository(root);
      const key = cacheKey();
      const record = cacheRecord(key);
      await repository.put({ key, record });
      expect(await repository.get({ key })).toEqual(record);
      expect(await repository.get({ key: cacheKey('c'.repeat(64)) })).toBeNull();
    });
  });

  it('preserves plugin-contributed analysis fields through persistence', async () => {
    await withTempProject(async (root) => {
      const repository = new FileRenderCacheRepository(root);
      const key = cacheKey();
      const record = {
        ...cacheRecord(key),
        output: {
          prose: 'derived output',
          analysis: {
            eventId: 'cache-event',
            protocol: { proseHash: 'c'.repeat(64) },
            observations: { quality: { disposition: 'produced', evidence: ['derived output'] } },
            analysis: {
              quality: { proseScore: 4 },
              pluginNarrativeSignal: { level: 'high', evidence: 'derived output' },
            },
          },
        },
      };
      await repository.put({ key, record });
      expect(await repository.get({ key })).toEqual(record);
    });
  });

  it('round trips keys whose serialized form exceeds filename limits', async () => {
    await withTempProject(async (root) => {
      const repository = new FileRenderCacheRepository(root);
      const key = {
        ...cacheKey(),
        layers: { logical: 'x'.repeat(1_024) },
      };
      await repository.put({ key, record: cacheRecord(key) });
      expect(await repository.get({ key })).toEqual(cacheRecord(key));

      const [file] = await fs.readdir(path.join(root, '.nova', 'render-cache'));
      expect(file).toMatch(/^[a-f0-9]{64}\.json$/);
    });
  });

  it('treats corrupt and partial records as safe misses', async () => {
    await withTempProject(async (root) => {
      const repository = new FileRenderCacheRepository(root);
      const key = cacheKey();
      await repository.put({ key, record: cacheRecord(key) });
      const [file] = await fs.readdir(path.join(root, '.nova', 'render-cache'));
      const fullPath = path.join(root, '.nova', 'render-cache', file);
      await fs.writeFile(fullPath, '{"version":1,"key":{},"output":null}', 'utf8');
      expect(await repository.get({ key })).toBeNull();
      await fs.writeFile(fullPath, '{not-json', 'utf8');
      expect(await repository.get({ key })).toBeNull();
    });
  });

  it('rejects records whose embedded key differs from requested key', async () => {
    await withTempProject(async (root) => {
      const repository = new FileRenderCacheRepository(root);
      const key = cacheKey();
      await repository.put({ key, record: cacheRecord(key) });
      const [file] = await fs.readdir(path.join(root, '.nova', 'render-cache'));
      const fullPath = path.join(root, '.nova', 'render-cache', file);
      const mismatched = cacheRecord(cacheKey('d'.repeat(64)));
      await fs.writeFile(fullPath, JSON.stringify(mismatched), 'utf8');
      expect(await repository.get({ key })).toBeNull();
    });
  });

  it('removes a complete record and is idempotent for missing records', async () => {
    await withTempProject(async (root) => {
      const repository = new FileRenderCacheRepository(root);
      const key = cacheKey();
      await repository.put({ key, record: cacheRecord(key) });
      await repository.remove({ key });
      expect(await repository.get({ key })).toBeNull();
      await repository.remove({ key });
    });
  });

  it('fails closed when removing through a symlinked cache directory', async () => {
    await withTempProject(async (root) => {
      const repository = new FileRenderCacheRepository(root);
      const key = cacheKey();
      await repository.put({ key, record: cacheRecord(key) });

      const outside = path.join(root, 'outside');
      await fs.mkdir(outside);
      await fs.writeFile(path.join(outside, 'victim.json'), 'outside bytes', 'utf8');
      await fs.rm(path.join(root, '.nova', 'render-cache'), { recursive: true, force: true });
      await fs.symlink(outside, path.join(root, '.nova', 'render-cache'), 'dir');

      await expect(repository.remove({ key })).rejects.toThrow(/escapes project root|not a directory/);
      expect(await fs.readdir(outside)).toEqual(['victim.json']);
      expect(await fs.readFile(path.join(outside, 'victim.json'), 'utf8')).toBe('outside bytes');
    });
  });

  it('removes nothing when the cache directory has never been created', async () => {
    await withTempProject(async (root) => {
      const repository = new FileRenderCacheRepository(root);
      await expect(repository.remove({ key: cacheKey() })).resolves.toBeUndefined();
      await expect(repository.get({ key: cacheKey() })).resolves.toBeNull();
    });
  });
});
