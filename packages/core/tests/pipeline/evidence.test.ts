import { describe, expect, it } from 'vitest';
import {
  clearEventCache,
  computeEvidenceHash,
  getCachedRender,
  setCachedRender,
  verifyEvidenceChain,
} from '../../src/cache/render-cache.ts';
import { MemoryStorage } from '../../src/storage/memory-storage.ts';
import type { Fact } from '../../src/types/entity.js';

const cacheDir = '/project/.nova/render-cache';
const cacheKey = 'novalistically-scene:chapter-01:E0:abc123def456';

function makeFact(id: string, entityId = 'char:alice', attribute = 'mood'): Fact {
  return {
    id,
    entityId,
    attribute,
    value: 'happy',
    validity: {
      temporal: { start: { type: 'absolute' as const, value: 'day_0' }, end: null },
      branches: { type: 'all' as const },
    },
  };
}

describe('evidence hash computation', () => {
  it('produces deterministic hash for same inputs', () => {
    const pre = [makeFact('f1'), makeFact('f2')];
    const post = [makeFact('f3')];
    const hash1 = computeEvidenceHash('E0', pre, post);
    const hash2 = computeEvidenceHash('E0', pre, post);
    expect(hash1).toBe(hash2);
  });

  it('different eventId produces different hash', () => {
    const pre = [makeFact('f1')];
    const post = [makeFact('f2')];
    const hash1 = computeEvidenceHash('E0', pre, post);
    const hash2 = computeEvidenceHash('E1', pre, post);
    expect(hash1).not.toBe(hash2);
  });

  it('different preconditions produce different hash', () => {
    const post = [makeFact('f3')];
    const hash1 = computeEvidenceHash('E0', [makeFact('f1'), makeFact('f2')], post);
    const hash2 = computeEvidenceHash('E0', [makeFact('f1')], post);
    expect(hash1).not.toBe(hash2);
  });

  it('fact sort order does not affect hash', () => {
    const pre1 = [makeFact('f1'), makeFact('f2')];
    const pre2 = [makeFact('f2'), makeFact('f1')];
    const post = [makeFact('f3')];
    const hash1 = computeEvidenceHash('E0', pre1, post);
    const hash2 = computeEvidenceHash('E0', pre2, post);
    expect(hash1).toBe(hash2);
  });

  it('empty preconditions and postconditions produce stable hash', () => {
    const hash = computeEvidenceHash('E0', [], []);
    expect(hash).toBeTruthy();
    expect(hash.length).toBe(64); // SHA-256 hex
  });
});

describe('cache evidence verification', () => {
  it('cache miss when evidence hash mismatches (tampered)', () => {
    const storage = new MemoryStorage();
    const eventId = 'E0';
    const pre = [makeFact('f1')];
    const post = [makeFact('f2')];

    // Write cache with one evidence hash
    const originalHash = computeEvidenceHash(eventId, pre, post);
    setCachedRender(cacheDir, eventId, cacheKey, { prose: 'original' }, storage, originalHash);

    // Read with different evidence hash (preconditions changed)
    const tamperedPre = [makeFact('f1_tampered')];
    const tamperedHash = computeEvidenceHash(eventId, tamperedPre, post);
    expect(tamperedHash).not.toBe(originalHash);
    expect(getCachedRender(cacheDir, eventId, cacheKey, storage, tamperedHash)).toBeNull();
  });

  it('cache hit when evidence hash matches', () => {
    const storage = new MemoryStorage();
    const eventId = 'E0';
    const pre = [makeFact('f1')];
    const post = [makeFact('f2')];

    const hash = computeEvidenceHash(eventId, pre, post);
    setCachedRender(
      cacheDir,
      eventId,
      cacheKey,
      { prose: 'valid scene', analysis: { blocks: [] } },
      storage,
      hash,
    );

    expect(getCachedRender(cacheDir, eventId, cacheKey, storage, hash)).toMatchObject({
      prose: 'valid scene',
    });
  });

  it('v2 candidate supports an absent optional evidence hash', () => {
    const storage = new MemoryStorage();
    const eventId = 'E0';

    setCachedRender(
      cacheDir,
      eventId,
      cacheKey,
      { prose: 'candidate', analysis: { blocks: [] } },
      storage,
    );

    expect(getCachedRender(cacheDir, eventId, cacheKey, storage)).toMatchObject({
      prose: 'candidate',
    });
    expect(
      getCachedRender(
        cacheDir,
        eventId,
        cacheKey,
        storage,
        computeEvidenceHash(eventId, [makeFact('f1')], []),
      ),
    ).toMatchObject({ prose: 'candidate' });
  });

  it('corrupt evidence hash in meta is treated as stale', () => {
    const storage = new MemoryStorage();
    const eventId = 'E0';
    const hash = computeEvidenceHash(eventId, [makeFact('f1')], []);

    setCachedRender(cacheDir, eventId, cacheKey, { prose: 'test' }, storage, hash);
    // Directly corrupt meta.json evidenceHash
    const metaRaw = storage.read(`${cacheDir}/${eventId}/cache.meta.json`);
    const meta = JSON.parse(metaRaw);
    meta.evidenceHash = 'not-a-valid-hash';
    storage.write(`${cacheDir}/${eventId}/cache.meta.json`, JSON.stringify(meta));

    expect(getCachedRender(cacheDir, eventId, cacheKey, storage, hash)).toBeNull();
  });
});

describe('verifyEvidenceChain', () => {
  it('all events valid when evidence hashes match', () => {
    const storage = new MemoryStorage();
    const hashE0 = computeEvidenceHash('E0', [makeFact('f1')], []);
    const hashE1 = computeEvidenceHash('E1', [makeFact('f2')], []);

    setCachedRender(cacheDir, 'E0', 'key-e0', { prose: 'e0' }, storage, hashE0);
    setCachedRender(cacheDir, 'E1', 'key-e1', { prose: 'e1' }, storage, hashE1);

    const hashes = new Map([
      ['E0', hashE0],
      ['E1', hashE1],
    ]);
    const result = verifyEvidenceChain(cacheDir, hashes, storage);

    expect(result.valid).toBe(2);
    expect(result.stale).toBe(0);
    expect(result.missing).toBe(0);
    expect(result.totalCached).toBe(2);
  });

  it('detects stale cache when evidence hash mismatches', () => {
    const storage = new MemoryStorage();
    const hashE0 = computeEvidenceHash('E0', [makeFact('f1')], []);

    setCachedRender(cacheDir, 'E0', 'key-e0', { prose: 'e0' }, storage, hashE0);

    // Current hash is different (preconditions changed)
    const changedHash = computeEvidenceHash('E0', [makeFact('f1_changed')], []);
    const hashes = new Map([['E0', changedHash]]);
    const result = verifyEvidenceChain(cacheDir, hashes, storage);

    expect(result.valid).toBe(0);
    expect(result.stale).toBe(1);
    expect(result.totalCached).toBe(1);
  });

  it('detects missing events', () => {
    const storage = new MemoryStorage();
    const hashE0 = computeEvidenceHash('E0', [makeFact('f1')], []);

    // Only E0 is cached, but we also look for E1
    setCachedRender(cacheDir, 'E0', 'key-e0', { prose: 'e0' }, storage, hashE0);

    const hashE1 = computeEvidenceHash('E1', [makeFact('f2')], []);
    const hashes = new Map([
      ['E0', hashE0],
      ['E1', hashE1],
    ]);
    const result = verifyEvidenceChain(cacheDir, hashes, storage);

    expect(result.valid).toBe(1);
    expect(result.missing).toBe(1);
    expect(result.details.find((d) => d.eventId === 'E1')?.status).toBe('missing');
  });

  it('handles empty cache directory', () => {
    const storage = new MemoryStorage();
    const hashes = new Map([['E0', computeEvidenceHash('E0', [makeFact('f1')], [])]]);
    const result = verifyEvidenceChain(cacheDir, hashes, storage);

    expect(result.valid).toBe(0);
    expect(result.missing).toBe(1);
    expect(result.totalCached).toBe(0);
  });

  it('detects corrupt cache metadata', () => {
    const storage = new MemoryStorage();
    const eventId = 'E0';

    // Create cache directory with no meta.json
    storage.mkdirp(`${cacheDir}/${eventId}`);
    storage.write(`${cacheDir}/${eventId}/data.render.json`, JSON.stringify({ prose: 'corrupt' }));

    const hash = computeEvidenceHash(eventId, [makeFact('f1')], []);
    const hashes = new Map([[eventId, hash]]);
    const result = verifyEvidenceChain(cacheDir, hashes, storage);

    expect(result.missing).toBe(1);
    expect(result.details.find((d) => d.eventId === eventId)?.reason).toBe('No meta.json');
  });

  it('tampered cache detected via verifyEvidenceChain', () => {
    const storage = new MemoryStorage();
    const eventId = 'E0';
    const originalHash = computeEvidenceHash(eventId, [makeFact('f1')], [makeFact('f2')]);

    // Write cache with original hash
    setCachedRender(cacheDir, eventId, cacheKey, { prose: 'original' }, storage, originalHash);

    // Tamper with evidence hash in meta
    const metaRaw = storage.read(`${cacheDir}/${eventId}/cache.meta.json`);
    const meta = JSON.parse(metaRaw);
    meta.evidenceHash = 'tampered-hash-12345';
    storage.write(`${cacheDir}/${eventId}/cache.meta.json`, JSON.stringify(meta));

    // verifyEvidenceChain should detect the tampering
    const hashes = new Map([[eventId, originalHash]]);
    const result = verifyEvidenceChain(cacheDir, hashes, storage);

    expect(result.stale).toBe(1);
    expect(result.valid).toBe(0);
    const detail = result.details.find((d) => d.eventId === eventId);
    expect(detail?.status).toBe('stale');
    expect(detail?.reason).toBe('Evidence hash mismatch');
  });
});
