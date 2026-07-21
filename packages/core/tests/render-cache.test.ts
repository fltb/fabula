import { describe, expect, it } from 'vitest';
import { CacheCorruptionError } from '../src/errors.ts';
import { getCachedRender, setCachedRender, clearEventCache, clearRenderCache } from '../src/cache/render-cache.ts';
import { MemoryStorage } from '../src/storage/memory-storage.ts';

const cacheDir = '/project/.nova/render-cache';
const eventId = 'E0';
const cacheKey = 'novalistically-scene:chapter-01:E0:abc123def456';
const staleKey = 'novalistically-scene:chapter-01:E0:999999999999';
const renderData = { prose: 'scene text', tokens: 42 };

describe('render cache', () => {
  it('cold cache returns null when no prior data exists', () => {
    const storage = new MemoryStorage();
    expect(getCachedRender(cacheDir, eventId, cacheKey, storage)).toBeNull();
  });

  it('warm cache hit returns the stored record when key matches', () => {
    const storage = new MemoryStorage();
    setCachedRender(cacheDir, eventId, cacheKey, renderData, storage);
    expect(getCachedRender(cacheDir, eventId, cacheKey, storage)).toEqual(renderData);
  });

  it('stale cache returns null when cache key differs (hash mismatch)', () => {
    const storage = new MemoryStorage();
    setCachedRender(cacheDir, eventId, staleKey, renderData, storage);
    expect(getCachedRender(cacheDir, eventId, cacheKey, storage)).toBeNull();
  });

  it('corrupt meta.json throws CacheCorruptionError with safe context', () => {
    const storage = new MemoryStorage();
    setCachedRender(cacheDir, eventId, cacheKey, renderData, storage);
    storage.write(`${cacheDir}/${eventId}/cache.meta.json`, '{');

    expect(() => getCachedRender(cacheDir, eventId, cacheKey, storage)).toThrow(CacheCorruptionError);
    try {
      getCachedRender(cacheDir, eventId, cacheKey, storage);
    } catch (error) {
      expect(error).toBeInstanceOf(CacheCorruptionError);
      expect(error).toMatchObject({ code: 'CACHE_CORRUPT', context: { eventId, phase: 'cache-read' } });
      // Error message must be safe — no prompts, no prose
      expect(String(error)).not.toMatch(/prompt|prose|narrative|scene/i);
    }
  });

  it('corrupt data.render.json throws CacheCorruptionError and allows re-render', () => {
    const storage = new MemoryStorage();
    setCachedRender(cacheDir, eventId, cacheKey, renderData, storage);
    // Corrupt the data file
    storage.write(`${cacheDir}/${eventId}/data.render.json`, '{');

    // First access throws corruption error
    expect(() => getCachedRender(cacheDir, eventId, cacheKey, storage)).toThrow(CacheCorruptionError);

    // Clear the corrupt event cache and re-render
    clearEventCache(cacheDir, eventId, storage);
    expect(getCachedRender(cacheDir, eventId, cacheKey, storage)).toBeNull();

    // Re-render (set new value)
    setCachedRender(cacheDir, eventId, cacheKey, { prose: 're-rendered', tokens: 99 }, storage);
    expect(getCachedRender(cacheDir, eventId, cacheKey, storage)).toEqual({ prose: 're-rendered', tokens: 99 });
  });

  it('clearRenderCache removes all stored render data', () => {
    const storage = new MemoryStorage();
    setCachedRender(cacheDir, 'E0', cacheKey, renderData, storage);
    setCachedRender(cacheDir, 'E1', cacheKey, renderData, storage);
    clearRenderCache(cacheDir, storage);
    expect(getCachedRender(cacheDir, 'E0', cacheKey, storage)).toBeNull();
    expect(getCachedRender(cacheDir, 'E1', cacheKey, storage)).toBeNull();
  });

  it('multiple events with distinct keys each resolve independently', () => {
    const storage = new MemoryStorage();
    setCachedRender(cacheDir, 'E0', 'key-e0', { prose: 'e0' }, storage);
    setCachedRender(cacheDir, 'E1', 'key-e1', { prose: 'e1' }, storage);
    expect(getCachedRender(cacheDir, 'E0', 'key-e0', storage)).toEqual({ prose: 'e0' });
    expect(getCachedRender(cacheDir, 'E1', 'key-e1', storage)).toEqual({ prose: 'e1' });
    expect(getCachedRender(cacheDir, 'E0', 'key-e1', storage)).toBeNull();
  });
});
