import { describe, expect, it } from 'vitest';
import {
  type CacheDiagnostics,
  computeEvidenceHash,
  getCachedRender,
  setCachedRender,
  sha256Canonical,
  verifyEvidenceChain,
} from '../../src/cache/render-cache.ts';
import type {
  LayeredCacheKey,
  RenderCacheRecord,
} from '../../src/ports/render-cache-repository.ts';
import { MemoryRenderCacheRepository } from '../../src/testing/memory-repositories.ts';
import type { Fact } from '../../src/types/entity.js';

const cacheKey = (eventId: string, sourceHash = 'abc123def456'): LayeredCacheKey => ({
  version: 1,
  sourceHash,
  layers: { eventId, logical: 'l', surface: 's' },
});

function makeRecord(key: LayeredCacheKey, prose: string, evidenceHash?: string): RenderCacheRecord {
  const output: Record<string, unknown> = {
    prose,
    analysis: {
      eventId: key.layers.eventId ?? 'cache-event',
      protocol: { proseHash: 'cache-prose' },
      observations: {},
      analysis: { cache: true },
    },
  };
  if (evidenceHash !== undefined) output.evidenceHash = evidenceHash;
  return { version: 1, key, recordHash: sha256Canonical({ key, output }), output };
}

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
  it('cache miss when evidence hash mismatches (tampered)', async () => {
    const repository = new MemoryRenderCacheRepository();
    const eventId = 'E0';
    const pre = [makeFact('f1')];
    const post = [makeFact('f2')];

    // Write cache with one evidence hash
    const originalHash = computeEvidenceHash(eventId, pre, post);
    const key = cacheKey(eventId);
    await setCachedRender(repository, key, makeRecord(key, 'original', originalHash));

    // Read with different evidence hash (preconditions changed)
    const tamperedPre = [makeFact('f1_tampered')];
    const tamperedHash = computeEvidenceHash(eventId, tamperedPre, post);
    expect(tamperedHash).not.toBe(originalHash);
    expect(
      await getCachedRender(repository, { key, eventId, evidenceHash: tamperedHash }),
    ).toBeNull();
  });

  it('cache hit when evidence hash matches', async () => {
    const repository = new MemoryRenderCacheRepository();
    const eventId = 'E0';
    const hash = computeEvidenceHash(eventId, [makeFact('f1')], [makeFact('f2')]);
    const key = cacheKey(eventId);
    await setCachedRender(repository, key, makeRecord(key, 'valid scene', hash));

    const hit = await getCachedRender(repository, { key, eventId, evidenceHash: hash });
    expect(hit).not.toBeNull();
    expect(hit?.output).toMatchObject({ prose: 'valid scene' });
  });

  it('record without evidence hash hits when none expected and safely misses otherwise', async () => {
    const repository = new MemoryRenderCacheRepository();
    const eventId = 'E0';
    const key = cacheKey(eventId);

    await setCachedRender(repository, key, makeRecord(key, 'candidate'));

    expect(await getCachedRender(repository, { key, eventId })).toMatchObject({
      output: { prose: 'candidate' },
    });
    // A lookup that pins an evidence identity must never accept a record that
    // does not carry it — complete hits only.
    expect(
      await getCachedRender(repository, {
        key,
        eventId,
        evidenceHash: computeEvidenceHash(eventId, [makeFact('f1')], []),
      }),
    ).toBeNull();
  });

  it('corrupt record is treated as a safe miss, never a partial hit', async () => {
    const repository = new MemoryRenderCacheRepository();
    const eventId = 'E0';
    const hash = computeEvidenceHash(eventId, [makeFact('f1')], []);
    const key = cacheKey(eventId);

    // Malformed record: analysis output missing entirely.
    await repository.put({
      key,
      record: { ...makeRecord(key, 'test', hash), output: { prose: 'test', evidenceHash: hash } },
    });
    const diagnostics: CacheDiagnostics[] = [];
    expect(
      await getCachedRender(repository, { key, eventId, evidenceHash: hash }, diagnostics),
    ).toBeNull();
    expect(diagnostics[0]?.diagnosis).toBe('corrupt');
  });
});

describe('verifyEvidenceChain', () => {
  it('all events valid when evidence hashes match', async () => {
    const repository = new MemoryRenderCacheRepository();
    const hashE0 = computeEvidenceHash('E0', [makeFact('f1')], []);
    const hashE1 = computeEvidenceHash('E1', [makeFact('f2')], []);
    const keyE0 = cacheKey('E0');
    const keyE1 = cacheKey('E1');

    await setCachedRender(repository, keyE0, makeRecord(keyE0, 'e0', hashE0));
    await setCachedRender(repository, keyE1, makeRecord(keyE1, 'e1', hashE1));
    const records = new Map<string, RenderCacheRecord | null>([
      ['E0', await repository.get({ key: keyE0 })],
      ['E1', await repository.get({ key: keyE1 })],
    ]);
    const keys = new Map<string, LayeredCacheKey>([
      ['E0', keyE0],
      ['E1', keyE1],
    ]);
    const result = verifyEvidenceChain(records, keys);

    expect(result.valid).toBe(2);
    expect(result.stale).toBe(0);
    expect(result.missing).toBe(0);
    expect(result.totalCached).toBe(2);
  });

  it('detects stale cache when record is malformed', () => {
    const keyE0 = cacheKey('E0');
    // Present but incomplete — analysis output missing.
    const malformed: RenderCacheRecord = {
      version: 1,
      key: keyE0,
      recordHash: sha256Canonical(keyE0),
      output: { prose: 'e0', evidenceHash: computeEvidenceHash('E0', [makeFact('f1')], []) },
    };
    const records = new Map<string, RenderCacheRecord | null>([['E0', malformed]]);
    const keys = new Map<string, LayeredCacheKey>([['E0', keyE0]]);
    const result = verifyEvidenceChain(records, keys);

    expect(result.valid).toBe(0);
    expect(result.stale).toBe(1);
    expect(result.totalCached).toBe(1);
    expect(result.details.find((d) => d.eventId === 'E0')?.status).toBe('corrupt');
  });

  it('detects missing events', async () => {
    const repository = new MemoryRenderCacheRepository();
    const hashE0 = computeEvidenceHash('E0', [makeFact('f1')], []);
    const keyE0 = cacheKey('E0');
    await setCachedRender(repository, keyE0, makeRecord(keyE0, 'e0', hashE0));

    const records = new Map<string, RenderCacheRecord | null>([
      ['E0', await repository.get({ key: keyE0 })],
      ['E1', null],
    ]);
    const keys = new Map<string, LayeredCacheKey>([
      ['E0', keyE0],
      ['E1', cacheKey('E1')],
    ]);
    const result = verifyEvidenceChain(records, keys);

    expect(result.valid).toBe(1);
    expect(result.missing).toBe(1);
    expect(result.details.find((d) => d.eventId === 'E1')?.status).toBe('missing');
  });

  it('handles an empty cache', () => {
    const records = new Map<string, RenderCacheRecord | null>([['E0', null]]);
    const keys = new Map<string, LayeredCacheKey>([['E0', cacheKey('E0')]]);
    const result = verifyEvidenceChain(records, keys);

    expect(result.valid).toBe(0);
    expect(result.missing).toBe(1);
    expect(result.totalCached).toBe(0);
  });

  it('detects corrupt cache metadata', () => {
    const keyE0 = cacheKey('E0');
    // Present but unparseable — only prose, no analysis block.
    const corrupt: RenderCacheRecord = {
      version: 1,
      key: keyE0,
      recordHash: sha256Canonical(keyE0),
      output: { prose: 'corrupt', analysis: null },
    };
    const records = new Map<string, RenderCacheRecord | null>([['E0', corrupt]]);
    const keys = new Map<string, LayeredCacheKey>([['E0', keyE0]]);
    const result = verifyEvidenceChain(records, keys);

    expect(result.missing).toBe(0);
    expect(result.stale).toBe(1);
    expect(result.details.find((d) => d.eventId === 'E0')?.status).toBe('corrupt');
    expect(result.details.find((d) => d.eventId === 'E0')?.reason).toBe('Invalid cache record');
  });

  it('tampered evidence is a safe miss and surfaces as missing in the chain', async () => {
    const repository = new MemoryRenderCacheRepository();
    const eventId = 'E0';
    const originalHash = computeEvidenceHash(eventId, [makeFact('f1')], [makeFact('f2')]);
    const key = cacheKey(eventId);

    // Write cache with original hash
    await setCachedRender(repository, key, makeRecord(key, 'original', originalHash));

    // A lookup pinned to the original evidence identity succeeds...
    const verified = await getCachedRender(repository, {
      key,
      eventId,
      evidenceHash: originalHash,
    });
    expect(verified).not.toBeNull();

    // ...but a tampered evidence identity yields a safe miss, so the chain
    // reports the event as missing rather than a partial hit.
    const tamperedHash = computeEvidenceHash(eventId, [makeFact('f1_tampered')], [makeFact('f2')]);
    const staleLookup = await getCachedRender(repository, {
      key,
      eventId,
      evidenceHash: tamperedHash,
    });
    expect(staleLookup).toBeNull();
    const result = verifyEvidenceChain(
      new Map<string, RenderCacheRecord | null>([[eventId, staleLookup]]),
      new Map<string, LayeredCacheKey>([[eventId, key]]),
    );
    expect(result.stale).toBe(0);
    expect(result.missing).toBe(1);
    const detail = result.details.find((d) => d.eventId === eventId);
    expect(detail?.status).toBe('missing');
  });
});
