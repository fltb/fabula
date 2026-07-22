// ============================================================================
// Summary Compiler & Surface Extractor Tests (Track 6A, D13)
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  LogicalDisclosureSummaryCompiler,
  SurfaceReferenceExtractor,
} from '../src/summary/index.ts';
import type {
  DiscourseState,
  DiscourseContextProjection,
} from '../src/types/discourse.ts';
import type {
  CompiledSceneContract,
  StyleProfile,
  ContinuityPacket,
} from '../src/types/render-surface.ts';

// ============================================================================
// Helpers — minimal compliant instances
// ============================================================================

const DEFAULT_STYLE: StyleProfile = {
  profileId: 'test_default',
  voice: 'neutral',
  diction: 'standard',
  rhythm: 'varied',
  paragraphing: 'standard',
  typography: 'standard',
  dialogue: 'standard',
  avoid: [],
};

const DEFAULT_CONTINUITY: ContinuityPacket = {
  transition: 'continuous',
  continuityNotes: [],
};

function makeDiscourseState(overrides: Partial<DiscourseState> = {}): DiscourseState {
  return {
    position: 0,
    reveals: [],
    openClaims: [],
    retractions: [],
    corrections: [],
    hints: [],
    activeWithholds: [],
    narratorProfiles: {},
    assertions: {},
    providerIndex: {},
    branch: 'main',
    ledgerHash: 'abc123',
    ...overrides,
  };
}

function makeDiscourseProjection(overrides: Partial<DiscourseContextProjection> = {}): DiscourseContextProjection {
  return {
    plannedReveals: [],
    openClaims: [],
    visibleHints: [],
    accessibleClaims: [],
    authorizedTargets: [],
    activeWithholdingPolicies: [],
    ...overrides,
  };
}

function makeSceneContract(overrides: Partial<CompiledSceneContract> = {}): CompiledSceneContract {
  return {
    sceneId: 'scene-1',
    branch: 'main',
    discoursePosition: 0,
    worldStateHash: 'hash-ws',
    knowledgeStateHash: 'hash-ks',
    narratorProfileHash: 'hash-np',
    plannedDiscourseHash: 'hash-pd',
    styleProfile: DEFAULT_STYLE,
    continuityPacket: DEFAULT_CONTINUITY,
    promptContractHash: 'hash-pc',
    ...overrides,
  };
}

// ============================================================================
// LogicalDisclosureSummaryCompiler
// ============================================================================

describe('LogicalDisclosureSummaryCompiler', () => {
  const compiler = new LogicalDisclosureSummaryCompiler();

  describe('compile', () => {
    it('produces a non-empty summary from empty discourse state', () => {
      const ds = makeDiscourseState();
      const contract = makeSceneContract();
      const proj = makeDiscourseProjection();

      const result = compiler.compile(ds, contract, proj);

      expect(result).toBeTruthy();
      expect(result).toContain('[PIN:');
      expect(result).toContain('Scene scene-1');
    });

    it('includes hash pin for cache verification', () => {
      const ds = makeDiscourseState();
      const contract = makeSceneContract();
      const proj = makeDiscourseProjection();

      const result = compiler.compile(ds, contract, proj);
      const pinMatch = result.match(/\[PIN:([a-f0-9]+)\]/);

      expect(pinMatch).not.toBeNull();
      expect(pinMatch![1].length).toBe(12);
    });

    it('reports reveals when present', () => {
      const ds = makeDiscourseState({
        reveals: ['assertion-1', 'assertion-2'],
      });
      const contract = makeSceneContract();
      const proj = makeDiscourseProjection();

      const result = compiler.compile(ds, contract, proj);

      expect(result).toContain('Revealed disclosures: 2');
    });

    it('reports open claims when present', () => {
      const ds = makeDiscourseState({
        openClaims: ['claim-1'],
      });
      const contract = makeSceneContract();
      const proj = makeDiscourseProjection();

      const result = compiler.compile(ds, contract, proj);

      expect(result).toContain('Open assertions: 1');
    });

    it('reports active hints (excluding retracted)', () => {
      const ds = makeDiscourseState({
        hints: [
          {
            hintId: 'hint-1',
            surfaceProposition: 'surface A',
            targetPropositionId: 'target-1',
            state: 'contract_planted',
            discoursePosition: 0,
            branch: 'main',
          },
          {
            hintId: 'hint-2',
            surfaceProposition: 'surface B',
            targetPropositionId: 'target-2',
            state: 'retracted',
            discoursePosition: 0,
            branch: 'main',
          },
          {
            hintId: 'hint-3',
            surfaceProposition: 'surface C',
            targetPropositionId: 'target-3',
            state: 'contract_fulfilled',
            discoursePosition: 1,
            branch: 'main',
          },
        ],
      });
      const contract = makeSceneContract();
      const proj = makeDiscourseProjection();

      const result = compiler.compile(ds, contract, proj);

      expect(result).toContain('Active hints: 2');
    });

    it('reports active withholding policies', () => {
      const ds = makeDiscourseState({
        activeWithholds: [
          { id: 'w-1', active: true, scope: ['topic-a'] },
          { id: 'w-2', active: false, scope: ['topic-b'] },
          { id: 'w-3', active: true, scope: ['topic-c'] },
        ],
      });
      const contract = makeSceneContract();
      const proj = makeDiscourseProjection();

      const result = compiler.compile(ds, contract, proj);

      expect(result).toContain('Withholding policies: 2');
    });

    it('includes narrator type in the summary', () => {
      const ds = makeDiscourseState({
        narratorProfiles: {
          main: {
            type: 'omniscient',
            name: 'Omniscient Narrator',
            access: 'full',
            assertionCapability: 'full',
            truthCapability: 'full_knowledge',
            fidelity: 'reliable',
            sincerity: 'sincere',
          },
        },
      });
      const contract = makeSceneContract();
      const proj = makeDiscourseProjection();

      const result = compiler.compile(ds, contract, proj);

      expect(result).toContain('omniscient');
    });

    // ── Safety: must not leak ───────────────────────────────────────

    it('does NOT leak raw state diffs', () => {
      const ds = makeDiscourseState({
        reveals: ['secret-reveal-42', 'classified-info'],
        openClaims: ['claim-with-proposition'],
        assertions: {
          'secret-reveal-42': {
            id: 'secret-reveal-42',
            narrator: 'narrator',
            type: 'authoritative_reveal',
            proposition: 'The butler did it',
            polarity: 'affirmative',
            truthBoundary: true,
            narrationBoundary: { access: 'full', reason: 'omniscient' },
            evidence: null,
          },
        },
      });
      const contract = makeSceneContract();
      const proj = makeDiscourseProjection();

      const result = compiler.compile(ds, contract, proj);

      // Should reveal count but NOT proposition content
      expect(result).not.toContain('butler');
      expect(result).not.toContain('classified');
      expect(result).not.toContain('secret-reveal-42');
      expect(result).not.toContain('claim-with-proposition');
    });

    it('does NOT leak n-ary relationship internals', () => {
      // Summary operates on discourse state — relationship internals are
      // part of WorldState, not DiscourseState. Verify the summary does
      // not contain relationship-like data.
      const ds = makeDiscourseState();
      const contract = makeSceneContract();
      const proj = makeDiscourseProjection();

      const result = compiler.compile(ds, contract, proj);

      expect(result).not.toMatch(/relationship|Relation/);
    });

    it('does NOT leak thread numeric progress', () => {
      const contract = makeSceneContract({ sceneId: 'test-scene' });
      const result = compiler.compile(
        makeDiscourseState(),
        contract,
        makeDiscourseProjection(),
      );
      // Thread progress is part of WorldState/ContextPackage, not the
      // discourse summary — verify no progress-like patterns leak.
      expect(result).not.toMatch(/\d+\/\d+/);
      expect(result).not.toMatch(/progress/i);
    });

    it('does NOT contain causal predecessor prose', () => {
      const result = compiler.compile(
        makeDiscourseState(),
        makeSceneContract(),
        makeDiscourseProjection(),
      );

      expect(result).not.toMatch(/because|therefore|as a result/i);
    });

    it('does NOT leak ellipsis summaries', () => {
      const result = compiler.compile(
        makeDiscourseState(),
        makeSceneContract(),
        makeDiscourseProjection(),
      );

      expect(result).not.toContain('…');
      expect(result).not.toMatch(/ellipsis|skip|omitted/i);
    });

    it('does NOT leak Knowledge entries', () => {
      const ds = makeDiscourseState({
        assertions: {
          'know-1': {
            id: 'know-1',
            narrator: 'narrator',
            type: 'authoritative_reveal',
            proposition: 'The hero knows the truth',
            polarity: 'affirmative',
            truthBoundary: true,
            narrationBoundary: { access: 'full', reason: 'omniscient' },
            evidence: null,
          },
        },
      });
      const result = compiler.compile(
        ds,
        makeSceneContract(),
        makeDiscourseProjection(),
      );

      // Must not contain the actual proposition text
      expect(result).not.toContain('hero knows');
    });
  });

  // ── Determinism ──────────────────────────────────────────────────

  describe('determinism', () => {
    it('same inputs produce identical output', () => {
      const ds = makeDiscourseState({
        reveals: ['r1', 'r2'],
        openClaims: ['c1'],
        branch: 'main',
      });
      const contract = makeSceneContract({
        sceneId: 'scene-42',
        discoursePosition: 3,
        promptContractHash: 'hash-v2',
      });
      const proj = makeDiscourseProjection({
        plannedReveals: ['r1', 'r2'],
        openClaims: ['c1'],
      });

      const a = compiler.compile(ds, contract, proj);
      const b = compiler.compile(ds, contract, proj);

      expect(a).toBe(b);
    });

    it('different inputs produce different output', () => {
      const dsA = makeDiscourseState({ reveals: ['r1'] });
      const dsB = makeDiscourseState({ reveals: ['r1', 'r2'] });

      const a = compiler.compile(dsA, makeSceneContract(), makeDiscourseProjection());
      const b = compiler.compile(dsB, makeSceneContract(), makeDiscourseProjection());

      expect(a).not.toBe(b);
    });
  });

  // ── computeInputHash ─────────────────────────────────────────────

  describe('computeInputHash', () => {
    it('returns a 64-char hex string', () => {
      const hash = compiler.computeInputHash(
        makeDiscourseState(),
        makeSceneContract(),
        makeDiscourseProjection(),
      );
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('same inputs produce same hash', () => {
      const ds = makeDiscourseState({ branch: 'feature-x' });
      const contract = makeSceneContract({ sceneId: 'scene-99' });
      const proj = makeDiscourseProjection({ plannedReveals: ['r1'] });

      const a = compiler.computeInputHash(ds, contract, proj);
      const b = compiler.computeInputHash(ds, contract, proj);

      expect(a).toBe(b);
    });

    it('different inputs produce different hash', () => {
      const hash1 = compiler.computeInputHash(
        makeDiscourseState({ branch: 'a' }),
        makeSceneContract(),
        makeDiscourseProjection(),
      );
      const hash2 = compiler.computeInputHash(
        makeDiscourseState({ branch: 'b' }),
        makeSceneContract(),
        makeDiscourseProjection(),
      );

      expect(hash1).not.toBe(hash2);
    });
  });
});

// ============================================================================
// SurfaceReferenceExtractor
// ============================================================================

describe('SurfaceReferenceExtractor', () => {
  const extractor = new SurfaceReferenceExtractor(500);

  const SAMPLE_PROSE =
    'The morning sun cast long shadows across the cobblestone street. ' +
    'Eleanor pulled her cloak tighter and stepped into the crowd. ' +
    '"Excuse me," she murmured as she passed a merchant hawking silverware. ' +
    'The air smelled of fresh bread and sea salt. ' +
    'Somewhere a church bell tolled nine.';

  describe('extract', () => {
    it('returns a complete SurfaceReferencePacket', () => {
      const packet = extractor.extract('scene-1', SAMPLE_PROSE);

      expect(packet).toBeDefined();
      expect(packet.sceneId).toBe('scene-1');
      expect(packet.excerpt).toBeTruthy();
      expect(packet.styleMetrics).toBeDefined();
      expect(packet.sourceProseHash).toMatch(/^[a-f0-9]{64}$/);
      expect(packet.accepted).toBe(false);
      expect(packet.extractorVersion).toBe('v1.0');
    });

    it('uses full mode when prose fits budget', () => {
      const shortProse = 'Short scene.';
      const shortExtractor = new SurfaceReferenceExtractor(500);

      const packet = shortExtractor.extract('scene-1', shortProse);

      expect(packet.excerptMode).toBe('full');
      expect(packet.excerpt).toBe(shortProse);
    });

    it('uses tail mode when prose exceeds budget', () => {
      // Create prose longer than 40 chars
      const longProse = 'A '.repeat(100);
      const tinyExtractor = new SurfaceReferenceExtractor(40);

      const packet = tinyExtractor.extract('scene-1', longProse);

      expect(packet.excerptMode).toBe('tail');
      expect(packet.excerpt.length).toBeLessThanOrEqual(41); // 40 + ellipsis char
      expect(packet.excerpt.startsWith('…')).toBe(true);
    });

    it('uses authored_anchor mode when anchor is provided', () => {
      const anchor = 'cloak tighter';
      const packet = extractor.extract('scene-1', SAMPLE_PROSE, anchor);

      expect(packet.excerptMode).toBe('authored_anchor');
      expect(packet.authoredAnchor).toBe(anchor);
      expect(packet.excerpt).toContain('cloak tighter');
    });
    it('falls back to tail when anchor not found in prose', () => {
      const longProse = 'A '.repeat(300);
      const tinyExtractor = new SurfaceReferenceExtractor(50);
      const packet = tinyExtractor.extract('scene-1', longProse, 'nonexistent anchor');

      expect(packet.excerptMode).toBe('tail');
      expect(packet.excerpt.startsWith('\u2026')).toBe(true);
      expect(packet.excerpt.length).toBeLessThanOrEqual(51);
    });
    it('appends truncation marker when auth anchor excerpt is truncated', () => {
      const prose =
        'The beginning of a very long scene. '.repeat(200);
      const tinyExtractor = new SurfaceReferenceExtractor(50);
      const anchor = 'beginning';

      const packet = tinyExtractor.extract('scene-1', prose, anchor);

      expect(packet.excerptMode).toBe('authored_anchor');
      expect(packet.excerpt).toContain('[… truncated]');
    });

    it('respects custom budget parameter', () => {
      const prose = 'Word. '.repeat(200);
      const packet = extractor.extract('scene-1', prose, undefined, 100);

      expect(packet.excerpt.length).toBeLessThanOrEqual(101);
    });
  });

  // ── Style Metrics ────────────────────────────────────────────────

  describe('style metrics', () => {
    it('computes avgSentenceLength', () => {
      const packet = extractor.extract('scene-1', SAMPLE_PROSE);

      expect(packet.styleMetrics.avgSentenceLength).toBeGreaterThan(0);
    });

    it('computes tokenCount', () => {
      const packet = extractor.extract('scene-1', SAMPLE_PROSE);

      expect(packet.styleMetrics.tokenCount).toBeGreaterThan(0);
    });

    it('computes lexicalDiversity', () => {
      const packet = extractor.extract('scene-1', SAMPLE_PROSE);

      expect(packet.styleMetrics.lexicalDiversity).toBeGreaterThan(0);
      expect(packet.styleMetrics.lexicalDiversity).toBeLessThanOrEqual(1);
    });

    it('computes dialogueRatio for text with dialogue', () => {
      const packet = extractor.extract('scene-1', SAMPLE_PROSE);

      expect(packet.styleMetrics.dialogueRatio).toBeGreaterThan(0);
    });

    it('computes dialogueRatio as 0 for text without dialogue', () => {
      const noDialogue = 'The cat sat on the mat. It was a very comfortable mat.';
      const packet = extractor.extract('scene-1', noDialogue);

      expect(packet.styleMetrics.dialogueRatio).toBe(0);
    });
  });

  // ── Determinism ──────────────────────────────────────────────────

  describe('determinism', () => {
    it('same inputs produce identical packet', () => {
      const a = extractor.extract('scene-1', SAMPLE_PROSE, 'cloak');
      const b = extractor.extract('scene-1', SAMPLE_PROSE, 'cloak');

      expect(a.excerpt).toBe(b.excerpt);
      expect(a.styleMetrics).toEqual(b.styleMetrics);
      expect(a.sourceProseHash).toBe(b.sourceProseHash);
    });
  });

  // ── Non-authoritative label ──────────────────────────────────────

  it('marks packet as not accepted (non-authoritative)', () => {
    const packet = extractor.extract('scene-1', SAMPLE_PROSE);

    expect(packet.accepted).toBe(false);
  });
});

// ============================================================================
// Module Exports — verify barrel
// ============================================================================

describe('Summary module exports', () => {
  it('exports LogicalDisclosureSummaryCompiler', () => {
    expect(LogicalDisclosureSummaryCompiler).toBeDefined();
  });

  it('exports SurfaceReferenceExtractor', () => {
    expect(SurfaceReferenceExtractor).toBeDefined();
  });
});
