import { describe, expect, it } from 'vitest';
import {
  buildLogicalKeyMaterial,
  canonicalJson,
  computeEvidenceHash,
  computeSourceContentHash,
  getCachedRender,
  setCachedRender,
  sha256Canonical,
} from '../src/cache/render-cache.ts';
import type { LayeredCacheKey, RenderCacheRecord, RenderCacheRepository } from '../src/ports/render-cache-repository.ts';
import type { ProjectSourceSnapshotV1 } from '../src/contracts/source.ts';

const source = (sourceHash: string): ProjectSourceSnapshotV1 => ({ version: 1, documents: [], sourceHash });
const key = (sourceHash: string): LayeredCacheKey => ({ version: 1, sourceHash, layers: { logical: 'l', surface: 's', validation: 'v', attempt: 'a' } });
const record = (cacheKey: LayeredCacheKey): RenderCacheRecord => ({ version: 1, key: cacheKey, recordHash: sha256Canonical(cacheKey), output: { prose: 'scene text', analysis: { eventId: 'cache-event', protocol: { proseHash: 'cache-prose' }, observations: {}, analysis: { cache: true } } } });

class MemoryCache implements RenderCacheRepository {
  private readonly values = new Map<string, RenderCacheRecord>();
  async get(input: { key: LayeredCacheKey }): Promise<RenderCacheRecord | null> { return this.values.get(sha256Canonical(input.key)) ?? null; }
  async put(input: { key: LayeredCacheKey; record: RenderCacheRecord }): Promise<void> { this.values.set(sha256Canonical(input.key), input.record); }
  async remove(input: { key: LayeredCacheKey }): Promise<void> { this.values.delete(sha256Canonical(input.key)); }
}

describe('pure render cache identity', () => {
  it('canonicalizes object keys and evidence IDs only', () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(computeEvidenceHash('E0', [{ id: 'z', value: 'one' } as never], [{ id: 'a', value: 'two' } as never])).toBe(computeEvidenceHash('E0', [{ id: 'a', value: 'changed' } as never], [{ id: 'z', value: 'other' } as never]));
  });

  it('uses snapshot sourceHash and ignores provenance', () => {
    expect(computeSourceContentHash(source('a'.repeat(64)))).toBe('a'.repeat(64));
    expect(buildLogicalKeyMaterial({ sourceContentHash: 'a'.repeat(64), sceneContractHash: 'c', worldStateHash: 'w', plannedDiscourseHash: 'd', branchDiscourseScopeHash: 'b', catalogVersionHashes: {}, graphHash: 'g', styleProfileHash: 's', promptProviderId: 'p', language: 'en', targetLengthWords: 10 })).toBe(buildLogicalKeyMaterial({ sourceContentHash: 'a'.repeat(64), sceneContractHash: 'c', worldStateHash: 'w', plannedDiscourseHash: 'd', branchDiscourseScopeHash: 'b', catalogVersionHashes: {}, graphHash: 'g', styleProfileHash: 's', promptProviderId: 'p', language: 'en', targetLengthWords: 10 }));
  });

  it('hits same bytes and misses changed source', async () => {
    const repository = new MemoryCache();
    const first = key('a'.repeat(64));
    await setCachedRender(repository, first, record(first));
    expect(await getCachedRender(repository, { key: first })).not.toBeNull();
    expect(await getCachedRender(repository, { key: key('b'.repeat(64)) })).toBeNull();
  });

  it('treats partial and corrupt records as safe misses', async () => {
    const repository = new MemoryCache();
    const cacheKey = key('a'.repeat(64));
    await repository.put({ key: cacheKey, record: { ...record(cacheKey), output: { prose: 'text' } } });
    expect(await getCachedRender(repository, { key: cacheKey })).toBeNull();
    await repository.put({ key: cacheKey, record: { ...record(cacheKey), output: { prose: 'text', analysis: null } } });
    expect(await getCachedRender(repository, { key: cacheKey })).toBeNull();
  });
});
