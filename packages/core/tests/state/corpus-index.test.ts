// ============================================================================
// Novalistically — CORPUS-2: Work Index, Anchors & Source Manifests — Tests
// ============================================================================

import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CandidateEventIndex,
  ChapterLocation,
  CharacterAnchor,
  DiscourseNodeAnchor,
  FreezeInput,
  LocationAnchor,
  NarrativeNodeAnchor,
  SourceManifest,
  ThreadAnchor,
} from '../../src/state/corpus-index.ts';
import {
  ANCHORED_WORKS,
  detectDoubleCounting,
  freezeWorkIndex,
  getAnchoredWorkTitle,
  isAllowedInPublicCI,
  isAnchoredWork,
  validateCoverage,
} from '../../src/state/corpus-index.ts';

// ═════════════════════════════════════════════════════════════════════════════
// Fixtures
// ═════════════════════════════════════════════════════════════════════════════

const sampleChapters: ChapterLocation[] = [
  { chapterId: 'ch1', title: 'Chapter 1', startByte: 0, endByte: 5000, wordCount: 1200 },
  { chapterId: 'ch2', title: 'Chapter 2', startByte: 5000, endByte: 10500, wordCount: 1350 },
  { chapterId: 'ch3', title: 'Chapter 3', startByte: 10500, endByte: 16000, wordCount: 1100 },
];

const sampleManifest: SourceManifest = {
  workId: 'dream-of-red-chamber',
  editionId: 'cheng-gao-1791',
  language: 'zh',
  legalMode: 'public_domain',
  jurisdiction: 'CN',
  sourceHash: 'abc123def456',
  cleaningVersion: '1.0.0',
  adapterVersion: '1.0.0',
  schemaVersion: '1.0.0',
  chapters: sampleChapters,
};

const sampleCharacters: CharacterAnchor[] = [
  {
    entityId: 'char_jia_baoyu',
    primaryName: 'Jia Baoyu',
    aliases: ['Baoyu', 'Precious Jade'],
    firstAppearance: { chapterId: 'ch1', byteOffset: 120 },
  },
  {
    entityId: 'char_lin_daiyu',
    primaryName: 'Lin Daiyu',
    aliases: ['Daiyu'],
    firstAppearance: { chapterId: 'ch1', byteOffset: 500 },
  },
  {
    entityId: 'char_xue_baochai',
    primaryName: 'Xue Baochai',
    aliases: ['Baochai'],
    firstAppearance: { chapterId: 'ch2', byteOffset: 200 },
  },
];

const sampleLocations: LocationAnchor[] = [
  { locationId: 'loc_rongguo_mansion', name: 'Rongguo Mansion', chapters: ['ch1', 'ch2', 'ch3'] },
  { locationId: 'loc_daguanyuan', name: 'Grand View Garden', chapters: ['ch2', 'ch3'] },
];

const sampleThreads: ThreadAnchor[] = [
  { threadId: 'thread_main', name: 'Main Plot', type: 'main', chapters: ['ch1', 'ch2', 'ch3'] },
  { threadId: 'thread_love', name: 'Love Triangle', type: 'sub', chapters: ['ch1', 'ch2'] },
];

const sampleNarrativeNodes: NarrativeNodeAnchor[] = [
  {
    nodeId: 'n1',
    type: 'scene',
    chapterId: 'ch1',
    sourceRange: { startByte: 100, endByte: 800 },
    preconditions: [],
    postconditions: ['e_intro_baoyu'],
  },
  {
    nodeId: 'n2',
    type: 'scene',
    chapterId: 'ch2',
    sourceRange: { startByte: 5200, endByte: 6200 },
    preconditions: ['e_intro_baoyu'],
    postconditions: ['e_intro_daiyu'],
  },
  {
    nodeId: 'n3',
    type: 'scene',
    chapterId: 'ch3',
    sourceRange: { startByte: 11000, endByte: 12500 },
    preconditions: ['e_intro_daiyu'],
    postconditions: ['e_meeting'],
  },
  {
    nodeId: 'n4',
    type: 'ellipsis',
    chapterId: 'ch1',
    sourceRange: { startByte: 800, endByte: 1200 },
    preconditions: ['e_intro_baoyu'],
    postconditions: [],
  },
];

const sampleDiscourseNodes: DiscourseNodeAnchor[] = [
  { nodeId: 'n1', chapterId: 'ch1', narrativeOrder: 1, narratorType: 'omniscient' },
  { nodeId: 'n2', chapterId: 'ch2', narrativeOrder: 2, narratorType: 'omniscient' },
  { nodeId: 'n3', chapterId: 'ch3', narrativeOrder: 3, narratorType: 'omniscient' },
  { nodeId: 'n4', chapterId: 'ch1', narrativeOrder: 4, narratorType: 'omniscient' },
];

const sampleCandidates: CandidateEventIndex[] = [
  {
    candidateId: 'cand_01',
    eligibility: 'eligible',
    sourceRange: { chapterId: 'ch1', startByte: 100, endByte: 800 },
    narrativeCoverage: ['char_jia_baoyu'],
    discourseCoverage: ['n1'],
  },
  {
    candidateId: 'cand_02',
    eligibility: 'eligible',
    sourceRange: { chapterId: 'ch2', startByte: 5200, endByte: 6200 },
    narrativeCoverage: ['char_lin_daiyu'],
    discourseCoverage: ['n2'],
  },
  {
    candidateId: 'cand_03',
    eligibility: 'too_short',
    sourceRange: { chapterId: 'ch3', startByte: 11000, endByte: 11050 },
    exclusionReason: 'Too short for a viable scene (< 200 bytes)',
    narrativeCoverage: ['char_xue_baochai'],
    discourseCoverage: [],
  },
];

const sampleFreezeInput: FreezeInput = {
  manifest: sampleManifest,
  characters: sampleCharacters,
  locations: sampleLocations,
  threads: sampleThreads,
  narrativeNodes: sampleNarrativeNodes,
  discourseNodes: sampleDiscourseNodes,
  candidateEvents: sampleCandidates,
};

// ═════════════════════════════════════════════════════════════════════════════
// freezeWorkIndex Tests
// ═════════════════════════════════════════════════════════════════════════════

describe('freezeWorkIndex', () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  it('produces a valid WorkIndex with correct metadata', () => {
    const index = freezeWorkIndex(sampleFreezeInput, '1.0.0');
    expect(index.workId).toBe('dream-of-red-chamber');
    expect(index.version).toBe('1.0.0');
  });
  it('is clock-independent: identical inputs freeze to a deep-equal index', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    const first = freezeWorkIndex(sampleFreezeInput, '1.0.0');

    vi.setSystemTime(new Date('2026-06-15T12:00:00Z'));
    const second = freezeWorkIndex(sampleFreezeInput, '1.0.0');

    expect(second).toEqual(first);
  });

  it('returns frozen copies of arrays (immutable)', () => {
    const index = freezeWorkIndex(sampleFreezeInput, '1.0.0');
    // The frozen index's arrays are new copies: mutating them doesn't affect originals
    const origCandidateCount = sampleCandidates.length;
    const indexCandidates = index.candidateEvents;
    // Mutate the frozen index's array (it's a copy, not the original)
    indexCandidates.push({} as CandidateEventIndex);
    expect(indexCandidates.length).toBe(origCandidateCount + 1);
    // Original input arrays are unchanged
    expect(sampleCandidates.length).toBe(origCandidateCount);

    // Shallow-freeze check: arrays are new copies
    expect(index.characters).not.toBe(sampleFreezeInput.characters);
    expect(index.locations).not.toBe(sampleFreezeInput.locations);
    expect(index.threads).not.toBe(sampleFreezeInput.threads);
    expect(index.narrativeNodes).not.toBe(sampleFreezeInput.narrativeNodes);
    expect(index.discourseNodes).not.toBe(sampleFreezeInput.discourseNodes);
    expect(index.candidateEvents).not.toBe(sampleFreezeInput.candidateEvents);
    expect(index.manifest.chapters).not.toBe(sampleFreezeInput.manifest.chapters);
  });

  it('preserves all data through freeze round-trip', () => {
    const index = freezeWorkIndex(sampleFreezeInput, '2.0.0');
    expect(index.manifest.workId).toBe('dream-of-red-chamber');
    expect(index.characters.length).toBe(3);
    expect(index.locations.length).toBe(2);
    expect(index.threads.length).toBe(2);
    expect(index.narrativeNodes.length).toBe(4);
    expect(index.discourseNodes.length).toBe(4);
    expect(index.candidateEvents.length).toBe(3);
    expect(index.manifest.chapters.length).toBe(3);
  });

  it('includes the manifest unchanged', () => {
    const index = freezeWorkIndex(sampleFreezeInput, '1.0.0');
    expect(index.manifest.legalMode).toBe('public_domain');
    expect(index.manifest.language).toBe('zh');
    expect(index.manifest.sourceHash).toBe('abc123def456');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// validateCoverage Tests
// ═════════════════════════════════════════════════════════════════════════════

describe('validateCoverage', () => {
  it('returns valid=true when all chapters have narrative nodes', () => {
    const index = freezeWorkIndex(sampleFreezeInput, '1.0.0');
    const result = validateCoverage(index);
    expect(result.valid).toBe(true);
    expect(result.gaps).toHaveLength(0);
  });

  it('detects a chapter with no narrative nodes', () => {
    const input: FreezeInput = {
      ...sampleFreezeInput,
      narrativeNodes: sampleNarrativeNodes.filter((n) => n.chapterId !== 'ch2'),
    };
    const index = freezeWorkIndex(input, '1.0.0');
    const result = validateCoverage(index);
    expect(result.valid).toBe(false);
    expect(
      result.gaps.some((g) => g.type === 'missing_chapter' && g.description.includes('ch2')),
    ).toBe(true);
  });

  it('detects character first appearance in unknown chapter', () => {
    const badChar: CharacterAnchor = {
      entityId: 'char_ghost',
      primaryName: 'Ghost',
      aliases: [],
      firstAppearance: { chapterId: 'ch99', byteOffset: 0 },
    };
    const input: FreezeInput = {
      ...sampleFreezeInput,
      characters: [...sampleCharacters, badChar],
    };
    const index = freezeWorkIndex(input, '1.0.0');
    const result = validateCoverage(index);
    expect(result.valid).toBe(false);
    expect(result.gaps.some((g) => g.type === 'missing_character_first_appearance')).toBe(true);
  });

  it('detects narrative node referencing unknown chapter', () => {
    const badNode: NarrativeNodeAnchor = {
      nodeId: 'n_bad',
      type: 'scene',
      chapterId: 'ch99',
      sourceRange: { startByte: 0, endByte: 100 },
      preconditions: [],
      postconditions: [],
    };
    const input: FreezeInput = {
      ...sampleFreezeInput,
      narrativeNodes: [...sampleNarrativeNodes, badNode],
    };
    const index = freezeWorkIndex(input, '1.0.0');
    const result = validateCoverage(index);
    expect(result.valid).toBe(false);
    expect(
      result.gaps.some((g) => g.type === 'orphan_node' && g.description.includes('n_bad')),
    ).toBe(true);
  });

  it('detects discourse node referencing unknown chapter', () => {
    const badNode: DiscourseNodeAnchor = {
      nodeId: 'n_bad_disc',
      chapterId: 'ch99',
      narrativeOrder: 99,
      narratorType: 'omniscient',
    };
    const input: FreezeInput = {
      ...sampleFreezeInput,
      discourseNodes: [...sampleDiscourseNodes, badNode],
    };
    const index = freezeWorkIndex(input, '1.0.0');
    const result = validateCoverage(index);
    expect(result.valid).toBe(false);
    expect(
      result.gaps.some((g) => g.type === 'orphan_node' && g.description.includes('n_bad_disc')),
    ).toBe(true);
  });

  it('detects candidate referencing unknown chapter', () => {
    const badCandidate: CandidateEventIndex = {
      candidateId: 'cand_bad',
      eligibility: 'eligible',
      sourceRange: { chapterId: 'ch99', startByte: 0, endByte: 100 },
      narrativeCoverage: [],
      discourseCoverage: [],
    };
    const input: FreezeInput = {
      ...sampleFreezeInput,
      candidateEvents: [...sampleCandidates, badCandidate],
    };
    const index = freezeWorkIndex(input, '1.0.0');
    const result = validateCoverage(index);
    expect(result.valid).toBe(false);
    expect(result.gaps.some((g) => g.type === 'missing_candidate_source_range')).toBe(true);
  });

  it('returns valid=true for an index with only ellipsis in a chapter', () => {
    // A chapter covered only by ellipsis nodes should still be valid
    const ellipsisOnlyChapters: ChapterLocation[] = [
      { chapterId: 'ch1', title: 'Ch1', startByte: 0, endByte: 1000, wordCount: 100 },
      {
        chapterId: 'ch_only_ellipsis',
        title: 'Ellipsis Only',
        startByte: 1000,
        endByte: 2000,
        wordCount: 100,
      },
    ];
    const input: FreezeInput = {
      manifest: { ...sampleManifest, chapters: ellipsisOnlyChapters },
      characters: [],
      locations: [],
      threads: [],
      narrativeNodes: [
        {
          nodeId: 'e1',
          type: 'ellipsis',
          chapterId: 'ch1',
          sourceRange: { startByte: 10, endByte: 200 },
          preconditions: [],
          postconditions: [],
        },
        {
          nodeId: 'e2',
          type: 'ellipsis',
          chapterId: 'ch_only_ellipsis',
          sourceRange: { startByte: 1050, endByte: 1500 },
          preconditions: [],
          postconditions: [],
        },
      ],
      discourseNodes: [
        { nodeId: 'e1', chapterId: 'ch1', narrativeOrder: 1, narratorType: 'omniscient' },
      ],
      candidateEvents: [],
    };
    const index = freezeWorkIndex(input, '1.0.0');
    const result = validateCoverage(index);
    expect(result.valid).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// detectDoubleCounting Tests
// ═════════════════════════════════════════════════════════════════════════════

describe('detectDoubleCounting', () => {
  it('returns no duplicates for non-overlapping candidates', () => {
    const candidates: CandidateEventIndex[] = [
      {
        candidateId: 'cand_a',
        eligibility: 'eligible',
        sourceRange: { chapterId: 'ch1', startByte: 0, endByte: 1000 },
        narrativeCoverage: [],
        discourseCoverage: [],
      },
      {
        candidateId: 'cand_b',
        eligibility: 'eligible',
        sourceRange: { chapterId: 'ch1', startByte: 2000, endByte: 3000 },
        narrativeCoverage: [],
        discourseCoverage: [],
      },
      {
        candidateId: 'cand_c',
        eligibility: 'eligible',
        sourceRange: { chapterId: 'ch2', startByte: 0, endByte: 1000 },
        narrativeCoverage: [],
        discourseCoverage: [],
      },
    ];
    const result = detectDoubleCounting(candidates);
    expect(result.hasDuplicate).toBe(false);
    expect(result.overlapping).toHaveLength(0);
  });

  it('detects overlapping candidates in the same chapter', () => {
    const candidates: CandidateEventIndex[] = [
      {
        candidateId: 'cand_a',
        eligibility: 'eligible',
        sourceRange: { chapterId: 'ch1', startByte: 100, endByte: 1000 },
        narrativeCoverage: [],
        discourseCoverage: [],
      },
      {
        candidateId: 'cand_b',
        eligibility: 'eligible',
        sourceRange: { chapterId: 'ch1', startByte: 500, endByte: 1500 },
        narrativeCoverage: [],
        discourseCoverage: [],
      },
      {
        candidateId: 'cand_c',
        eligibility: 'eligible',
        sourceRange: { chapterId: 'ch2', startByte: 0, endByte: 500 },
        narrativeCoverage: [],
        discourseCoverage: [],
      },
    ];
    const result = detectDoubleCounting(candidates);
    expect(result.hasDuplicate).toBe(true);
    expect(result.overlapping.length).toBeGreaterThanOrEqual(1);
    expect(result.overlapping[0]).toContain('cand_a');
    expect(result.overlapping[0]).toContain('cand_b');
  });

  it('detects multi-group overlaps correctly', () => {
    const candidates: CandidateEventIndex[] = [
      {
        candidateId: 'cand_a',
        eligibility: 'eligible',
        sourceRange: { chapterId: 'ch1', startByte: 0, endByte: 100 },
        narrativeCoverage: [],
        discourseCoverage: [],
      },
      {
        candidateId: 'cand_b',
        eligibility: 'eligible',
        sourceRange: { chapterId: 'ch1', startByte: 50, endByte: 150 },
        narrativeCoverage: [],
        discourseCoverage: [],
      },
      {
        candidateId: 'cand_c',
        eligibility: 'eligible',
        sourceRange: { chapterId: 'ch2', startByte: 0, endByte: 100 },
        narrativeCoverage: [],
        discourseCoverage: [],
      },
      {
        candidateId: 'cand_d',
        eligibility: 'eligible',
        sourceRange: { chapterId: 'ch2', startByte: 50, endByte: 150 },
        narrativeCoverage: [],
        discourseCoverage: [],
      },
    ];
    const result = detectDoubleCounting(candidates);
    expect(result.hasDuplicate).toBe(true);
    expect(result.overlapping.length).toBe(2); // Two separate overlap groups
  });

  it('handles edge-adjacent ranges (not overlapping)', () => {
    const candidates: CandidateEventIndex[] = [
      {
        candidateId: 'cand_a',
        eligibility: 'eligible',
        sourceRange: { chapterId: 'ch1', startByte: 0, endByte: 1000 },
        narrativeCoverage: [],
        discourseCoverage: [],
      },
      {
        candidateId: 'cand_b',
        eligibility: 'eligible',
        sourceRange: { chapterId: 'ch1', startByte: 1000, endByte: 2000 },
        narrativeCoverage: [],
        discourseCoverage: [],
      },
    ];
    // startByte_a(0) < endByte_b(2000) is true
    // startByte_b(1000) < endByte_a(1000) is false (1000 < 1000)
    // So they do NOT overlap
    const result = detectDoubleCounting(candidates);
    expect(result.hasDuplicate).toBe(false);
  });

  it('returns no duplicates for a single candidate', () => {
    const result = detectDoubleCounting([
      {
        candidateId: 'cand_only',
        eligibility: 'eligible',
        sourceRange: { chapterId: 'ch1', startByte: 0, endByte: 100 },
        narrativeCoverage: [],
        discourseCoverage: [],
      },
    ]);
    expect(result.hasDuplicate).toBe(false);
    expect(result.overlapping).toHaveLength(0);
  });

  it('returns no duplicates for empty array', () => {
    const result = detectDoubleCounting([]);
    expect(result.hasDuplicate).toBe(false);
    expect(result.overlapping).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// ANCHORED_WORKS Tests
// ═════════════════════════════════════════════════════════════════════════════

describe('ANCHORED_WORKS', () => {
  it('has exactly 3 entries', () => {
    expect(Object.keys(ANCHORED_WORKS)).toHaveLength(3);
  });

  it('includes Dream of the Red Chamber with correct metadata', () => {
    const entry = ANCHORED_WORKS['dream-of-red-chamber'];
    expect(entry).toBeDefined();
    expect(entry.title).toContain('Dream of the Red Chamber');
    expect(entry.language).toBe('zh');
    expect(entry.chapters).toBe(80);
    expect(entry.legalMode).toBe('public_domain');
  });

  it('includes David Copperfield with correct metadata', () => {
    const entry = ANCHORED_WORKS['david-copperfield'];
    expect(entry).toBeDefined();
    expect(entry.title).toContain('David Copperfield');
    expect(entry.language).toBe('en');
    expect(entry.chapters).toBe(64);
    expect(entry.legalMode).toBe('public_domain');
  });

  it('includes Four Generations with correct metadata', () => {
    const entry = ANCHORED_WORKS['four-generations'];
    expect(entry).toBeDefined();
    expect(entry.title).toContain('Four Generations');
    expect(entry.language).toBe('zh');
    expect(entry.chapters).toBe(87);
    expect(entry.legalMode).toBe('local_external');
  });

  it('Four Generations is NOT in default public CI', () => {
    expect(isAllowedInPublicCI('four-generations')).toBe(false);
  });

  it('public-domain works ARE in default public CI', () => {
    expect(isAllowedInPublicCI('dream-of-red-chamber')).toBe(true);
    expect(isAllowedInPublicCI('david-copperfield')).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Helper Function Tests
// ═════════════════════════════════════════════════════════════════════════════

describe('isAnchoredWork', () => {
  it('returns true for known work IDs', () => {
    expect(isAnchoredWork('dream-of-red-chamber')).toBe(true);
    expect(isAnchoredWork('david-copperfield')).toBe(true);
    expect(isAnchoredWork('four-generations')).toBe(true);
  });

  it('returns false for unknown work IDs', () => {
    expect(isAnchoredWork('unknown-work')).toBe(false);
    expect(isAnchoredWork('')).toBe(false);
  });
});

describe('getAnchoredWorkTitle', () => {
  it('returns the title for known work IDs', () => {
    expect(getAnchoredWorkTitle('dream-of-red-chamber')).toContain('Dream of the Red Chamber');
    expect(getAnchoredWorkTitle('david-copperfield')).toContain('David Copperfield');
    expect(getAnchoredWorkTitle('four-generations')).toContain('Four Generations');
  });

  it('returns undefined for unknown work IDs', () => {
    expect(getAnchoredWorkTitle('unknown-work')).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SourceManifest Legal Mode Tests
// ═════════════════════════════════════════════════════════════════════════════

describe('SourceManifest legal modes', () => {
  it('accepts public_domain variant', () => {
    const manifest: SourceManifest = {
      workId: 'dream-of-red-chamber',
      editionId: 'cheng-gao-1791',
      language: 'zh',
      legalMode: 'public_domain',
      jurisdiction: 'CN',
      sourceHash: 'a',
      cleaningVersion: '1.0.0',
      adapterVersion: '1.0.0',
      schemaVersion: '1.0.0',
      chapters: [],
    };
    expect(manifest.legalMode).toBe('public_domain');
  });

  it('accepts local_external variant', () => {
    const manifest: SourceManifest = {
      workId: 'four-generations',
      editionId: 'renmin-wenxue-1979',
      language: 'zh',
      legalMode: 'local_external',
      jurisdiction: 'CN',
      sourceHash: 'b',
      cleaningVersion: '1.0.0',
      adapterVersion: '1.0.0',
      schemaVersion: '1.0.0',
      chapters: [],
    };
    expect(manifest.legalMode).toBe('local_external');
  });

  it('accepts restricted variant', () => {
    const manifest: SourceManifest = {
      workId: 'restricted-work',
      editionId: 'limited-ed-2024',
      language: 'en',
      legalMode: 'restricted',
      jurisdiction: 'US',
      sourceHash: 'c',
      cleaningVersion: '1.0.0',
      adapterVersion: '1.0.0',
      schemaVersion: '1.0.0',
      chapters: [],
    };
    expect(manifest.legalMode).toBe('restricted');
  });

  it('rejects invalid legal mode at the type level (compile-time check)', () => {
    // @ts-expect-error — 'invalid' is not a LegalMode
    const bad: SourceManifest['legalMode'] = 'invalid';
    expect(bad).toBeDefined(); // never reached at runtime if TS catches it
  });

  it('supports optional fields in SourceManifest', () => {
    const manifest: SourceManifest = {
      workId: 'dream-of-red-chamber',
      editionId: 'cheng-gao-1791',
      language: 'zh',
      legalMode: 'public_domain',
      jurisdiction: 'CN',
      sourceHash: 'a1b2c3',
      cleaningVersion: '1.0.0',
      adapterVersion: '1.0.0',
      schemaVersion: '1.0.0',
      chapters: [],
    };
    // Optional fields should be undefined when not set
    expect(manifest.sourceUrl).toBeUndefined();
    expect(manifest.downloadDate).toBeUndefined();
    expect(manifest.legalReviewDate).toBeUndefined();
  });
});
