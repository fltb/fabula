import { describe, expect, it } from 'vitest';
import type { CacheDiagnostics } from '../src/cache/render-cache.ts';
import {
  buildAttemptKeyMaterial,
  buildLogicalKeyMaterial,
  buildSurfaceKeyMaterial,
  buildValidationKeyMaterial,
  canonicalJson,
  clearEventCache,
  clearRenderCache,
  computeFlatCacheKey,
  computeSourceContentHash,
  getCachedRender,
  setCachedRender,
  sha256Canonical,
} from '../src/cache/render-cache.ts';
import { MemoryStorage } from '../src/storage/memory-storage.ts';

const cacheDir = '/project/.nova/render-cache';
const eventId = 'E0';
const renderData = { prose: 'scene text', analysis: { blocks: [] }, tokens: 42 };

// ─── Layered Key Computation ──────────────────────────────────────────────────

describe('layered cache key computation', () => {
  it('buildLogicalKeyMaterial produces deterministic SHA-256 hex', () => {
    const input = {
      sourceContentHash: 'source-hash-abc',
      sceneContractHash: 'abc123',
      worldStateHash: 'def456',
      plannedDiscourseHash: 'ghi789',
      branchDiscourseScopeHash: 'branch-scope-xyz',
      catalogVersionHashes: { char: 'v1', rule: 'v2' },
      graphHash: 'jkl012',
      styleProfileHash: 'mno345',
      promptProviderId: 'gpt-4',
      promptProviderVersion: '1.0',
      language: 'en',
      targetLengthWords: 400,
    };
    const key1 = buildLogicalKeyMaterial(input);
    expect(key1).toMatch(/^[a-f0-9]{64}$/);

    // Same input -> same key
    const key2 = buildLogicalKeyMaterial(input);
    expect(key1).toBe(key2);
  });

  it('buildLogicalKeyMaterial changes when any field differs', () => {
    const base = {
      sourceContentHash: 'src-hash',
      sceneContractHash: 'abc',
      worldStateHash: 'def',
      plannedDiscourseHash: 'ghi',
      branchDiscourseScopeHash: 'br-scope',
      catalogVersionHashes: { char: 'v1' },
      graphHash: 'jkl',
      styleProfileHash: 'mno',
      promptProviderId: 'gpt-4',
      language: 'en',
      targetLengthWords: 400,
    };
    const baseKey = buildLogicalKeyMaterial(base);

    const changedHash = buildLogicalKeyMaterial({ ...base, sceneContractHash: 'xyz' });
    expect(changedHash).not.toBe(baseKey);

    const changedProvider = buildLogicalKeyMaterial({ ...base, promptProviderId: 'claude-3' });
    expect(changedProvider).not.toBe(baseKey);
  });

  it('buildSurfaceKeyMaterial chains logical key + surface inputs', () => {
    const input = {
      logicalKeyString: 'logical-key-123',
      groupManifestHash: 'manifest-abc',
      surfacePolicyHash: 'policy-def',
      sourceProseHashes: ['prose-hash-1'],
      extractorVersion: 'v1',
    };
    const key1 = buildSurfaceKeyMaterial(input);
    expect(key1).toMatch(/^[a-f0-9]{64}$/);

    // Changing source prose hashes changes the key
    const changed = buildSurfaceKeyMaterial({ ...input, sourceProseHashes: ['prose-hash-2'] });
    expect(changed).not.toBe(key1);
  });

  it('buildValidationKeyMaterial includes prose hash + Pass 2 schema + protocol dims', () => {
    const input = {
      surfaceKeyString: 'surface-key-abc',
      proseHash: 'prose-hash-xyz',
      pass2SchemaModelId: 'gpt-4',
      validatorPolicyVersion: '1.0',
      provider: 'provider-a',
      analysisPromptHash: 'prompt-hash-1',
      samplingConfigHash: 'sampling-hash-1',
      validatorPolicy: 'policy-1',
      referencePolicy: 'ref-1',
    };
    const key1 = buildValidationKeyMaterial(input);
    expect(key1).toMatch(/^[a-f0-9]{64}$/);

    // Different prose hash -> different key
    const changed = buildValidationKeyMaterial({ ...input, proseHash: 'different-prose' });
    expect(changed).not.toBe(key1);

    // Different prompt/sampling protocol -> different key
    const changedPrompt = buildValidationKeyMaterial({ ...input, analysisPromptHash: 'prompt-2' });
    expect(changedPrompt).not.toBe(key1);
  });

  it('buildAttemptKeyMaterial mutates with attempt number and feedback', () => {
    const base = {
      validationKeyString: 'val-key',
      attemptNumber: 1,
    };
    const key1 = buildAttemptKeyMaterial(base);
    // Different attempt number -> different key
    const key2 = buildAttemptKeyMaterial({ ...base, attemptNumber: 2 });
    expect(key2).not.toBe(key1);

    // Adding retry guidance changes the key
    const key3 = buildAttemptKeyMaterial({
      ...base,
      retryGuidanceHash: sha256Canonical(['fix the tense']),
    });
    expect(key3).not.toBe(key1);
  });

  it('computeFlatCacheKey combines all four layers', () => {
    const layers = {
      logical: 'a'.repeat(64),
      surface: 'b'.repeat(64),
      validation: 'c'.repeat(64),
      attempt: 'd'.repeat(64),
    };
    const flat1 = computeFlatCacheKey(layers);
    expect(flat1).toMatch(/^[a-f0-9]{64}$/);

    // Same inputs produce same key
    const flat2 = computeFlatCacheKey(layers);
    expect(flat2).toBe(flat1);

    // Different attempt -> different flat key
    const flat3 = computeFlatCacheKey({ ...layers, attempt: 'e'.repeat(64) });
    expect(flat3).not.toBe(flat1);
  });
});

// ─── Format v2 Cache Read/Write ──────────────────────────────────────────────

describe('v2 cache with layered keys', () => {
  it('stores and retrieves with format v2 flat key', () => {
    const storage = new MemoryStorage();
    const flatKey = 'v2-flat-key-123';
    const layeredKeys = {
      logicalKeyStr: 'lkey',
      surfaceKeyStr: 'skey',
      validationKeyStr: 'vkey',
      attemptKeyStr: 'akey',
    };
    setCachedRender(cacheDir, eventId, flatKey, renderData, storage, undefined, layeredKeys);
    expect(getCachedRender(cacheDir, eventId, flatKey, storage)).toEqual(renderData);
  });

  it('v2 stale flat key returns null with diagnostics', () => {
    const storage = new MemoryStorage();
    const diagnostics: CacheDiagnostics[] = [];
    const oldFlatKey = 'old-flat-key';
    const newFlatKey = 'new-flat-key';
    setCachedRender(cacheDir, eventId, oldFlatKey, renderData, storage);

    expect(
      getCachedRender(cacheDir, eventId, newFlatKey, storage, undefined, diagnostics),
    ).toBeNull();
    expect(diagnostics.some((d) => d.diagnosis === 'stale')).toBe(true);
  });

  it('corrupt payload returns null as safe miss, not throw', () => {
    const storage = new MemoryStorage();
    const diagnostics: CacheDiagnostics[] = [];
    const flatKey = 'flat-key';
    const layeredKeys = {
      logicalKeyStr: 'lkey',
      surfaceKeyStr: 'skey',
      validationKeyStr: 'vkey',
      attemptKeyStr: 'akey',
    };
    setCachedRender(cacheDir, eventId, flatKey, renderData, storage, undefined, layeredKeys);
    storage.write(`${cacheDir}/${eventId}/data.render.json`, 'not-json');

    const result = getCachedRender(cacheDir, eventId, flatKey, storage, undefined, diagnostics);
    expect(result).toBeNull();
    expect(diagnostics.some((d) => d.diagnosis === 'corrupt')).toBe(true);
  });

  it('missing analysis in cached payload returns null (no partial hit)', () => {
    const storage = new MemoryStorage();
    const diagnostics: CacheDiagnostics[] = [];
    const flatKey = 'flat-key-missing-analysis';
    const layeredKeys = {
      logicalKeyStr: 'lkey',
      surfaceKeyStr: 'skey',
      validationKeyStr: 'vkey',
      attemptKeyStr: 'akey',
    };
    setCachedRender(
      cacheDir,
      eventId,
      flatKey,
      { prose: 'text without analysis' },
      storage,
      undefined,
      layeredKeys,
    );

    const result = getCachedRender(cacheDir, eventId, flatKey, storage, undefined, diagnostics);
    expect(result).toBeNull();
    expect(diagnostics.some((d) => d.diagnosis === 'stale' && d.detail?.includes('analysis'))).toBe(
      true,
    );
  });

  it('evidence hash mismatch returns null as stale miss', () => {
    const storage = new MemoryStorage();
    const diagnostics: CacheDiagnostics[] = [];
    const flatKey = 'evidence-test-key';
    setCachedRender(cacheDir, eventId, flatKey, renderData, storage, 'stored-hash');

    expect(
      getCachedRender(cacheDir, eventId, flatKey, storage, 'current-hash', diagnostics),
    ).toBeNull();
    expect(diagnostics.some((d) => d.diagnosis === 'stale')).toBe(true);
  });
});

// ─── v2 Source Identity — computeSourceContentHash ────────────────────────────

describe('v2 source content hash', () => {
  it('computeSourceContentHash is deterministic and content-dependent', () => {
    const storage = new MemoryStorage();
    storage.write('/project/events/E0.yaml', 'id: E0\ntitle: Scene 1');
    storage.write('/project/events/E1.yaml', 'id: E1\ntitle: Scene 2');
    storage.write('/project/definitions/char.yaml', 'name: Alice');
    storage.mkdirp('/project/definitions/sub');
    storage.write('/project/definitions/sub/rule.yaml', 'id: R1');

    const hash1 = computeSourceContentHash(
      ['/project/events/E0.yaml', '/project/events/E1.yaml'],
      '/project/definitions',
      { branchDiscourseScopeHash: 'scope-main' },
      '/project',
      storage,
    );
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);

    // Same content -> same hash
    const hash2 = computeSourceContentHash(
      ['/project/events/E0.yaml', '/project/events/E1.yaml'],
      '/project/definitions',
      { branchDiscourseScopeHash: 'scope-main' },
      '/project',
      storage,
    );
    expect(hash2).toBe(hash1);

    // Different event content -> different hash
    storage.write('/project/events/E0.yaml', 'id: E0\ntitle: Modified');
    const hash3 = computeSourceContentHash(
      ['/project/events/E0.yaml', '/project/events/E1.yaml'],
      '/project/definitions',
      { branchDiscourseScopeHash: 'scope-main' },
      '/project',
      storage,
    );
    expect(hash3).not.toBe(hash1);
  });

  it('different scope produces different hash for same files', () => {
    const storage = new MemoryStorage();
    storage.write('/project/events/E0.yaml', 'id: E0');
    const hashMain = computeSourceContentHash(
      ['/project/events/E0.yaml'],
      undefined,
      { branchDiscourseScopeHash: 'scope-main' },
      '/project',
      storage,
    );
    const hashAlt = computeSourceContentHash(
      ['/project/events/E0.yaml'],
      undefined,
      { branchDiscourseScopeHash: 'scope-alt' },
      '/project',
      storage,
    );
    expect(hashAlt).not.toBe(hashMain);
  });

  it('sorted paths produce same hash regardless of argument order', () => {
    const storage = new MemoryStorage();
    storage.write('/project/events/E0.yaml', 'id: E0');
    storage.write('/project/events/E1.yaml', 'id: E1');
    const hashForward = computeSourceContentHash(
      ['/project/events/E0.yaml', '/project/events/E1.yaml'],
      undefined,
      { branchDiscourseScopeHash: 'scope' },
      '/project',
      storage,
    );
    const hashReverse = computeSourceContentHash(
      ['/project/events/E1.yaml', '/project/events/E0.yaml'],
      undefined,
      { branchDiscourseScopeHash: 'scope' },
      '/project',
      storage,
    );
    expect(hashReverse).toBe(hashForward);
  });

  it('storage read error throws — not silently skipped', () => {
    const storage = new MemoryStorage();
    expect(() =>
      computeSourceContentHash(
        ['/project/events/NONEXISTENT.yaml'],
        undefined,
        { branchDiscourseScopeHash: 'scope' },
        '/project',
        storage,
      ),
    ).toThrow();
  });

  it('definitions directory read error throws', () => {
    const storage = new MemoryStorage();
    storage.write('/project/events/E0.yaml', 'id: E0');
    expect(() =>
      computeSourceContentHash(
        ['/project/events/E0.yaml'],
        '/project/definitions',
        { branchDiscourseScopeHash: 'scope' },
        '/project',
        storage,
      ),
    ).toThrow();
  });

  it('same content at different root paths produces same hash', () => {
    const storageA = new MemoryStorage();
    storageA.write('/project/events/E0.yaml', 'id: E0\ntitle: Hello');
    storageA.mkdirp('/project/definitions');
    storageA.write('/project/definitions/char.yaml', 'name: Alice');

    const storageB = new MemoryStorage();
    storageB.write('/other/events/E0.yaml', 'id: E0\ntitle: Hello');
    storageB.mkdirp('/other/definitions');
    storageB.write('/other/definitions/char.yaml', 'name: Alice');

    const hashA = computeSourceContentHash(
      ['/project/events/E0.yaml'],
      '/project/definitions',
      { branchDiscourseScopeHash: 'scope-main' },
      '/project',
      storageA,
    );
    const hashB = computeSourceContentHash(
      ['/other/events/E0.yaml'],
      '/other/definitions',
      { branchDiscourseScopeHash: 'scope-main' },
      '/other',
      storageB,
    );
    expect(hashA).toBe(hashB);
  });

  it('legacy v1 cache records cannot be hits — format version mismatch', () => {
    const storage = new MemoryStorage();
    const v2Key = 'v2-flat-key-456';
    const diagnostics: CacheDiagnostics[] = [];

    // Simulate a v1 cache record by writing meta with formatVersion: 1
    storage.mkdirp(`${cacheDir}/${eventId}`);
    storage.write(
      `${cacheDir}/${eventId}/cache.meta.json`,
      JSON.stringify({ flatKey: 'v1-key', formatVersion: 1 }),
    );
    storage.write(
      `${cacheDir}/${eventId}/data.render.json`,
      JSON.stringify({ prose: 'v1 prose', analysis: { blocks: [] } }),
    );

    // v2 lookup rejects v1 format
    const result = getCachedRender(cacheDir, eventId, v2Key, storage, undefined, diagnostics);
    expect(result).toBeNull();
    expect(diagnostics.some((d) => d.diagnosis === 'stale' || d.diagnosis === 'miss')).toBe(true);
  });

  it('missing or corrupt cache input cannot cause partial hit', () => {
    const storage = new MemoryStorage();
    const diagnostics: CacheDiagnostics[] = [];

    // No cache files at all = clean miss
    const result = getCachedRender(cacheDir, eventId, 'any-key', storage, undefined, diagnostics);
    expect(result).toBeNull();

    // Stored payload without analysis = miss (no partial hit with null analysis)
    const flatKey = 'no-analysis-key';
    const layeredKeys = {
      logicalKeyStr: 'lkey',
      surfaceKeyStr: 'skey',
      validationKeyStr: 'vkey',
      attemptKeyStr: 'akey',
    };
    setCachedRender(
      cacheDir,
      eventId,
      flatKey,
      { prose: 'no analysis', chunks: [] },
      storage,
      undefined,
      layeredKeys,
    );
    const result2 = getCachedRender(cacheDir, eventId, flatKey, storage, undefined, diagnostics);
    expect(result2).toBeNull();
    expect(diagnostics.some((d) => d.diagnosis === 'stale' && d.detail?.includes('analysis'))).toBe(
      true,
    );
  });
});

// ─── canonicalJson / sha256Canonical Utility ──────────────────────────────

describe('canonical JSON utilities', () => {
  it('canonicalJson sorts object keys lexicographically', () => {
    const result = canonicalJson({ z: 1, a: 2, m: 3 });
    expect(result).toBe('{"a":2,"m":3,"z":1}');
  });

  it('canonicalJson omits undefined values', () => {
    const result = canonicalJson({ a: 1, b: undefined, c: 3 });
    expect(result).toBe('{"a":1,"c":3}');
  });

  it('canonicalJson preserves array order', () => {
    const result = canonicalJson({ items: ['c', 'a', 'b'] });
    expect(result).toBe('{"items":["c","a","b"]}');
  });

  it('sha256Canonical is deterministic', () => {
    const obj = { hello: 'world', num: 42 };
    const h1 = sha256Canonical(obj);
    const h2 = sha256Canonical(obj);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[a-f0-9]{64}$/);
  });

  it('sha256Canonical differs for different inputs', () => {
    const h1 = sha256Canonical({ a: 1 });
    const h2 = sha256Canonical({ a: 2 });
    expect(h1).not.toBe(h2);
  });
});
