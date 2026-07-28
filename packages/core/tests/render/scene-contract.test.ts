// ============================================================================
// Scene Contract — CompiledSceneContract Identity Tests (RENDER-SURFACE-1)
//
// Covers:
//   1. canonicalJson key-order independence (contract deterministic identity)
//   2. Every protected input field changes the promptContractHash
// ============================================================================

import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  clearStyleProfileRegistry,
  compileSceneContract,
  registerStyleProfile,
  type SceneContractInput,
} from '../../src/render/scene-contract.js';
import type { CompiledSceneContract, StyleProfile } from '../../src/types/render-surface.js';
const BASE_INPUT: SceneContractInput = {
  sceneId: 'S1',
  branch: 'main',
  discoursePosition: 3,
  worldStateHash: 'a1b2c3d4e5f6',
  knowledgeStateHash: 'f6e5d4c3b2a1',
  narratorProfileHash: 'narr_profile_v2',
  plannedDiscourseHash: 'disc_boundary_003',
  catalogHash: 'catalog_abc123',
  continuityDirectives: {
    transition: 'continuous',
    motifs: ['time', 'fate'],
    openCloseMode: 'open',
  },
  promptProviderId: 'gpt4',
  promptProviderVersion: '1.0.0',
};

function makeContract(overrides: Partial<SceneContractInput> = {}): CompiledSceneContract {
  return compileSceneContract({ ...BASE_INPUT, ...overrides });
}

// Register a non-default style profile for tests that change styleHints.
const TEST_STYLE: StyleProfile = {
  profileId: 'test_style_v1',
  resolutionPrecedence: {
    projectStyle: 'default_project_style_v1',
  },
  voice: 'lyrical',
  diction: 'formal',
  rhythm: 'slow',
};

// ============================================================================
// 1. canonicalJson key-order independence
// ============================================================================

describe('canonicalJson key-order independence', () => {
  it('produces identical output for objects with different key insertion order', () => {
    // Two objects with identical key-value pairs but different insertion order
    const a: Record<string, unknown> = {};
    a.alpha = 'first';
    a.beta = 42;
    a.gamma = true;

    const b: Record<string, unknown> = {};
    b.gamma = true;
    b.beta = 42;
    b.alpha = 'first';

    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('sorts keys lexicographically', () => {
    const obj: Record<string, unknown> = { z: 1, a: 2, m: 3 };
    expect(canonicalJson(obj)).toBe('{"a":2,"m":3,"z":1}');
  });

  it('handles nested objects with key-order independence', () => {
    const a = { outer: { z: 1, a: 2 }, inner: { b: 3, c: 4 } };
    const b = { inner: { c: 4, b: 3 }, outer: { a: 2, z: 1 } };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('handles arrays without sorting (preserves order)', () => {
    const a = { items: [3, 1, 2], id: 'test' };
    const b = { id: 'test', items: [3, 1, 2] };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('omits undefined values', () => {
    const withUndef: Record<string, unknown> = { a: 1, b: undefined, c: 'x' };
    expect(canonicalJson(withUndef)).toBe('{"a":1,"c":"x"}');
  });

  it('produces identical contract hash for same inputs (compileSceneContract determinism)', () => {
    const c1 = makeContract();
    const c2 = makeContract();

    expect(c1.promptContractHash).toBe(c2.promptContractHash);
  });

  it('same contract data with reversed key insertion order produces same hash', () => {
    // Build inputs with different insertion order but same key-value pairs
    const inputA: SceneContractInput = {
      sceneId: 'S1',
      branch: 'main',
      discoursePosition: 3,
      worldStateHash: 'hash1',
      knowledgeStateHash: 'hash2',
      narratorProfileHash: 'hash3',
      plannedDiscourseHash: 'hash4',
      continuityDirectives: { transition: 'hard_cut' },
      promptProviderId: 'providerA',
    };

    // Same data but build in reverse key order
    const inputB = {} as SceneContractInput;
    inputB.promptProviderId = 'providerA';
    inputB.continuityDirectives = { transition: 'hard_cut' };
    inputB.plannedDiscourseHash = 'hash4';
    inputB.narratorProfileHash = 'hash3';
    inputB.knowledgeStateHash = 'hash2';
    inputB.worldStateHash = 'hash1';
    inputB.discoursePosition = 3;
    inputB.branch = 'main';
    inputB.sceneId = 'S1';

    const contractA = compileSceneContract(inputA);
    const contractB = compileSceneContract(inputB);

    expect(contractA.promptContractHash).toBe(contractB.promptContractHash);
  });
});

// ============================================================================
// 2. Every protected input change changes the contract identity
// ============================================================================

describe('protected input field changes', () => {
  beforeEach(() => {
    clearStyleProfileRegistry();
    registerStyleProfile(TEST_STYLE);
  });

  // ── sceneId ──────────────────────────────────────────────────────────

  it('sceneId changes the promptContractHash', () => {
    const hash1 = makeContract({ sceneId: 'S1' }).promptContractHash;
    const hash2 = makeContract({ sceneId: 'S2' }).promptContractHash;
    expect(hash1).not.toBe(hash2);
  });

  // ── branch ───────────────────────────────────────────────────────────

  it('branch changes the promptContractHash', () => {
    const hash1 = makeContract({ branch: 'main' }).promptContractHash;
    const hash2 = makeContract({ branch: 'feature' }).promptContractHash;
    expect(hash1).not.toBe(hash2);
  });

  // ── discoursePosition ────────────────────────────────────────────────

  it('discoursePosition changes the promptContractHash', () => {
    const hash1 = makeContract({ discoursePosition: 1 }).promptContractHash;
    const hash2 = makeContract({ discoursePosition: 99 }).promptContractHash;
    expect(hash1).not.toBe(hash2);
  });

  // ── worldStateHash ───────────────────────────────────────────────────

  it('worldStateHash changes the promptContractHash', () => {
    const hash1 = makeContract({ worldStateHash: 'ws_a' }).promptContractHash;
    const hash2 = makeContract({ worldStateHash: 'ws_b' }).promptContractHash;
    expect(hash1).not.toBe(hash2);
  });

  // ── knowledgeStateHash ───────────────────────────────────────────────

  it('knowledgeStateHash changes the promptContractHash', () => {
    const hash1 = makeContract({ knowledgeStateHash: 'k_a' }).promptContractHash;
    const hash2 = makeContract({ knowledgeStateHash: 'k_b' }).promptContractHash;
    expect(hash1).not.toBe(hash2);
  });

  // ── narratorProfileHash ──────────────────────────────────────────────

  it('narratorProfileHash changes the promptContractHash', () => {
    const hash1 = makeContract({ narratorProfileHash: 'narr_a' }).promptContractHash;
    const hash2 = makeContract({ narratorProfileHash: 'narr_b' }).promptContractHash;
    expect(hash1).not.toBe(hash2);
  });

  // ── plannedDiscourseHash ─────────────────────────────────────────────

  it('plannedDiscourseHash changes the promptContractHash', () => {
    const hash1 = makeContract({ plannedDiscourseHash: 'disc_a' }).promptContractHash;
    const hash2 = makeContract({ plannedDiscourseHash: 'disc_b' }).promptContractHash;
    expect(hash1).not.toBe(hash2);
  });

  // ── catalogHash ──────────────────────────────────────────────────────

  it('catalogHash changes the promptContractHash', () => {
    const hash1 = makeContract({ catalogHash: 'cat_a' }).promptContractHash;
    const hash2 = makeContract({ catalogHash: 'cat_b' }).promptContractHash;
    expect(hash1).not.toBe(hash2);
  });

  it('catalogHash present vs absent changes the promptContractHash', () => {
    const hash1 = makeContract({ catalogHash: 'cat_v1' }).promptContractHash;
    const hash2 = makeContract({ catalogHash: undefined }).promptContractHash;
    expect(hash1).not.toBe(hash2);
  });

  // ── styleProfile (via styleHints) ─────────────────────────────────────

  it('styleHints that change resolved profile change the promptContractHash', () => {
    const hash1 = makeContract({ styleHints: undefined }).promptContractHash;
    const hash2 = makeContract({
      styleHints: { sceneStyle: 'test_style_v1' },
    }).promptContractHash;
    expect(hash1).not.toBe(hash2);
  });

  it('different sceneStyle ID changes the promptContractHash', () => {
    const registered2: StyleProfile = {
      profileId: 'test_style_v2',
      resolutionPrecedence: { projectStyle: 'default_project_style_v1' },
      voice: 'dramatic',
    };
    registerStyleProfile(registered2);

    const hash1 = makeContract({
      styleHints: { sceneStyle: 'test_style_v1' },
    }).promptContractHash;
    const hash2 = makeContract({
      styleHints: { sceneStyle: 'test_style_v2' },
    }).promptContractHash;
    expect(hash1).not.toBe(hash2);
  });

  // ── continuity directives ────────────────────────────────────────────

  it('continuity transition changes the promptContractHash', () => {
    const hash1 = makeContract({
      continuityDirectives: { transition: 'continuous' },
    }).promptContractHash;
    const hash2 = makeContract({
      continuityDirectives: { transition: 'flashback' },
    }).promptContractHash;
    expect(hash1).not.toBe(hash2);
  });

  it('continuity motifs changes the promptContractHash', () => {
    const hash1 = makeContract({
      continuityDirectives: { transition: 'continuous', motifs: ['fate'] },
    }).promptContractHash;
    const hash2 = makeContract({
      continuityDirectives: { transition: 'continuous', motifs: ['time'] },
    }).promptContractHash;
    expect(hash1).not.toBe(hash2);
  });

  it('continuity openCloseMode changes the promptContractHash', () => {
    const hash1 = makeContract({
      continuityDirectives: { transition: 'continuous', openCloseMode: 'open' },
    }).promptContractHash;
    const hash2 = makeContract({
      continuityDirectives: { transition: 'continuous', openCloseMode: 'closed' },
    }).promptContractHash;
    expect(hash1).not.toBe(hash2);
  });

  // ── promptProviderId ─────────────────────────────────────────────────

  it('promptProviderId changes the promptContractHash', () => {
    const hash1 = makeContract({ promptProviderId: 'gpt4' }).promptContractHash;
    const hash2 = makeContract({ promptProviderId: 'claude' }).promptContractHash;
    expect(hash1).not.toBe(hash2);
  });

  // ── promptProviderVersion ────────────────────────────────────────────

  it('promptProviderVersion changes the promptContractHash', () => {
    const hash1 = makeContract({ promptProviderVersion: '1.0.0' }).promptContractHash;
    const hash2 = makeContract({ promptProviderVersion: '2.0.0' }).promptContractHash;
    expect(hash1).not.toBe(hash2);
  });

  it('promptProviderVersion present vs absent changes the promptContractHash', () => {
    const hash1 = makeContract({ promptProviderVersion: '1.0.0' }).promptContractHash;
    const hash2 = makeContract({ promptProviderVersion: undefined }).promptContractHash;
    expect(hash1).not.toBe(hash2);
  });

  // ── Multiple-field change ────────────────────────────────────────────

  it('changing every protected field produces unique hash per combination', () => {
    const hashA = makeContract({
      sceneId: 'S1',
      branch: 'main',
      discoursePosition: 1,
      worldStateHash: 'a',
      knowledgeStateHash: 'a',
      narratorProfileHash: 'a',
      plannedDiscourseHash: 'a',
      continuityDirectives: { transition: 'continuous' },
      promptProviderId: 'p1',
    }).promptContractHash;

    const hashB = makeContract({
      sceneId: 'S2',
      branch: 'alt',
      discoursePosition: 99,
      worldStateHash: 'b',
      knowledgeStateHash: 'b',
      narratorProfileHash: 'b',
      plannedDiscourseHash: 'b',
      continuityDirectives: { transition: 'hard_cut' },
      promptProviderId: 'p2',
    }).promptContractHash;

    expect(hashA).not.toBe(hashB);
  });

  // ── Output format ───────────────────────────────────────────────────

  it('promptContractHash is a 64-char lowercase hex string (SHA-256)', () => {
    const contract = makeContract();
    expect(contract.promptContractHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
