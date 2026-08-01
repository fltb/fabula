// ============================================================================
// Novalistically — CORPUS-2: Work Index, Anchors & Source Manifests
// Versioned frozen index for each work variant with source provenance,
// character/location/thread anchors, candidate event indexing,
// and double-counting prevention.
// ============================================================================

// ═════════════════════════════════════════════════════════════════════════════
// Source Manifest
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Location of a chapter within the source text, identified by UTF-8 byte offsets.
 */
export interface ChapterLocation {
  /** Unique chapter identifier within the work */
  chapterId: string;
  /** Human-readable chapter title */
  title: string;
  /** UTF-8 byte offset where the chapter begins in the source text */
  startByte: number;
  /** UTF-8 byte offset where the chapter ends (exclusive) */
  endByte: number;
  /** Word count for this chapter (Chinese: CJK char count; English: content word count) */
  wordCount: number;
}

/**
 * Legal mode for a source text.
 * - `public_domain`: Free to use in any context
 * - `local_external`: Available locally but not redistributable
 * - `restricted`: Limited-use license or rights-managed
 */
export type LegalMode = 'public_domain' | 'local_external' | 'restricted';

/**
 * Immutable source manifest for a work variant.
 * Records the edition, legal status, hashes, and schema/cleaning versions
 * so every index is fully auditable.
 */
export interface SourceManifest {
  /** Canonical work identifier, e.g. 'dream-of-red-chamber' */
  workId: string;
  /** Edition identifier, e.g. 'cheng-gao-1791' */
  editionId: string;
  /** Language of the source text */
  language: 'zh' | 'en';
  /** Legal mode governing use of this source */
  legalMode: LegalMode;
  /** Applicable legal jurisdiction */
  jurisdiction: string;
  /** URL where the source was obtained */
  sourceUrl?: string;
  /** ISO date when the source was downloaded */
  downloadDate?: string;
  /** SHA-256 hash of the source text for integrity verification */
  sourceHash: string;
  /** Version string for the cleaning rules applied */
  cleaningVersion: string;
  /** Version string for the adapter that produced the index */
  adapterVersion: string;
  /** Version string for the index schema */
  schemaVersion: string;
  /** ISO date of the last legal review */
  legalReviewDate?: string;
  /** Chapter locations within the source text */
  chapters: ChapterLocation[];
}

// ═════════════════════════════════════════════════════════════════════════════
// Anchor Types
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Anchored character with primary name, aliases, and first appearance.
 */
export interface CharacterAnchor {
  /** Entity ID referencing the character in the entity catalog */
  entityId: string;
  /** Primary display name */
  primaryName: string;
  /** Alternative names / aliases */
  aliases: string[];
  /** First appearance location in the source */
  firstAppearance: { chapterId: string; byteOffset: number };
}

/**
 * Anchored location with the chapters it appears in.
 */
export interface LocationAnchor {
  /** Location identifier in the entity catalog */
  locationId: string;
  /** Display name */
  name: string;
  /** Chapter IDs where this location appears */
  chapters: string[];
}

/**
 * Anchored narrative thread (main or sub).
 */
export interface ThreadAnchor {
  /** Thread identifier */
  threadId: string;
  /** Human-readable name */
  name: string;
  /** Whether this is the main plot or a subplot */
  type: 'main' | 'sub';
  /** Chapter IDs covered by this thread */
  chapters: string[];
}

/**
 * Anchored narrative node within the source text.
 * References event/ellipsis IDs and their causal pre/postconditions.
 */
export interface NarrativeNodeAnchor {
  /** Node identifier matching a NarrativeEvent or NarrativeEllipsis id */
  nodeId: string;
  /** Discriminant: renderable scene vs non-renderable ellipsis */
  type: 'scene' | 'ellipsis';
  /** Chapter containing this node */
  chapterId: string;
  /** Byte range in the source text */
  sourceRange: { startByte: number; endByte: number };
  /** Event IDs this node depends on as preconditions */
  preconditions: string[];
  /** Event IDs this node establishes as postconditions */
  postconditions: string[];
}

/**
 * Anchored discourse node — positions the narrative node in discourse order.
 */
export interface DiscourseNodeAnchor {
  /** Node identifier matching a NarrativeEvent or NarrativeEllipsis id */
  nodeId: string;
  /** Chapter containing this node */
  chapterId: string;
  /** Position in the discourse order (1-based sequence) */
  narrativeOrder: number;
  /** Type of narrator for this discourse node */
  narratorType: string;
}

// ═════════════════════════════════════════════════════════════════════════════
// Candidate Event Index
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Eligibility status for a candidate event.
 */
export type CandidateEligibility =
  | 'eligible'
  | 'too_short'
  | 'overlap'
  | 'no_conflict'
  | 'insufficient_context';

/**
 * A candidate event extracted from the source text, with eligibility and coverage metadata.
 */
export interface CandidateEventIndex {
  /** Unique candidate identifier */
  candidateId: string;
  /** Eligibility for rendering as a NarrativeEvent scene */
  eligibility: CandidateEligibility;
  /** Source range in the original text */
  sourceRange: { chapterId: string; startByte: number; endByte: number };
  /** Reason for exclusion if not eligible */
  exclusionReason?: string;
  /** Entity IDs covered by this candidate's narrative content */
  narrativeCoverage: string[];
  /** Discourse node IDs covered by this candidate's discourse content */
  discourseCoverage: string[];
}

// ═════════════════════════════════════════════════════════════════════════════
// Full Work Index
// ═════════════════════════════════════════════════════════════════════════════

/**
 * A complete, frozen index for one work variant.
 * Every field is immutable after creation — a new version supersedes the old.
 */
export interface WorkIndex {
  /** Canonical work identifier */
  workId: string;
  /** Semantic version of this index */
  version: string;
  /** ISO date when this index was frozen */
  frozenAt: string;
  /** Source manifest for provenance */
  manifest: SourceManifest;
  /** Character anchors */
  characters: CharacterAnchor[];
  /** Location anchors */
  locations: LocationAnchor[];
  /** Narrative thread anchors */
  threads: ThreadAnchor[];
  /** Narrative node anchors (scenes and ellipses) */
  narrativeNodes: NarrativeNodeAnchor[];
  /** Discourse node anchors */
  discourseNodes: DiscourseNodeAnchor[];
  /** Candidate event index entries */
  candidateEvents: CandidateEventIndex[];
}

// ═════════════════════════════════════════════════════════════════════════════
// Constants
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Hardcoded anchored works — the three canonical long-form corpora.
 *
 * - 《红楼梦》前 80 回: Dream of the Red Chamber, main model, first 80 chapters (public domain)
 * - David Copperfield: Fixed public-domain English edition (public domain)
 * - 《四世同堂》87 章 + 103 章 extension: local-external, excluded from default CI
 */
export const ANCHORED_WORKS: Record<
  string,
  {
    title: string;
    language: 'zh' | 'en';
    chapters: number;
    legalMode: LegalMode;
  }
> = {
  'dream-of-red-chamber': {
    title: 'Dream of the Red Chamber (红楼梦)',
    language: 'zh',
    chapters: 80,
    legalMode: 'public_domain',
  },
  'david-copperfield': {
    title: 'David Copperfield',
    language: 'en',
    chapters: 64,
    legalMode: 'public_domain',
  },
  'four-generations': {
    title: 'Four Generations Under One Roof (四世同堂)',
    language: 'zh',
    chapters: 87,
    legalMode: 'local_external',
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// Functions
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Input type for freezeWorkIndex — groups the mutable parts that become
 * the frozen WorkIndex.
 */
export interface FreezeInput {
  /** Source manifest */
  manifest: SourceManifest;
  /** Character anchors */
  characters: CharacterAnchor[];
  /** Location anchors */
  locations: LocationAnchor[];
  /** Narrative thread anchors */
  threads: ThreadAnchor[];
  /** Narrative node anchors */
  narrativeNodes: NarrativeNodeAnchor[];
  /** Discourse node anchors */
  discourseNodes: DiscourseNodeAnchor[];
  /** Candidate event index entries */
  candidateEvents: CandidateEventIndex[];
}

/**
 * Freeze a work index — creates a versioned, immutable snapshot.
 * The `version` is derived from the manifest schema & adapter versions.
 * The `frozenAt` timestamp is set to the current ISO date.
 *
 * @param input  - The manifest and all anchor/candidate data
 * @param version - Semantic version for this index freeze
 * @returns A frozen WorkIndex
 */
export function freezeWorkIndex(input: FreezeInput, version: string): WorkIndex {
  const now = new Date().toISOString().slice(0, 10);
  return {
    workId: input.manifest.workId,
    version,
    frozenAt: now,
    manifest: { ...input.manifest, chapters: [...input.manifest.chapters] },
    characters: [...input.characters],
    locations: [...input.locations],
    threads: [...input.threads],
    narrativeNodes: [...input.narrativeNodes],
    discourseNodes: [...input.discourseNodes],
    candidateEvents: [...input.candidateEvents],
  };
}

/**
 * Coverage gap description.
 */
export interface CoverageGap {
  /** Type of coverage gap */
  type:
    | 'missing_chapter'
    | 'missing_character_first_appearance'
    | 'orphan_node'
    | 'missing_candidate_source_range'
    | 'chapter_not_in_range';
  /** Description of the gap */
  description: string;
}

/**
 * Result of a coverage validation.
 */
export interface CoverageResult {
  /** Whether the index passes coverage validation */
  valid: boolean;
  /** List of coverage gaps found */
  gaps: CoverageGap[];
}

/**
 * Validate index completeness — ensures coverage of all chapters declared
 * in the manifest.
 *
 * Checks performed:
 * - Every chapter in the manifest has at least one narrative node
 * - Every character anchor has a firstAppearance in a valid chapter
 * - Every narrative node references a chapter in the manifest
 * - Every discourse node references a chapter in the manifest
 * - Every candidate event references a valid chapter
 *
 * @param index - The WorkIndex to validate
 * @returns Coverage validation result with any gaps found
 */
export function validateCoverage(index: WorkIndex): CoverageResult {
  const gaps: CoverageGap[] = [];
  const manifestChapterIds = new Set(index.manifest.chapters.map((c) => c.chapterId));

  // Check that every chapter in the manifest has at least one narrative node
  const nodeChapterIds = new Set(index.narrativeNodes.map((n) => n.chapterId));
  for (const chapterId of manifestChapterIds) {
    if (!nodeChapterIds.has(chapterId)) {
      gaps.push({
        type: 'missing_chapter',
        description: `Chapter "${chapterId}" has no narrative nodes`,
      });
    }
  }

  // Check that every character anchor has a firstAppearance in a valid chapter
  for (const char of index.characters) {
    if (!manifestChapterIds.has(char.firstAppearance.chapterId)) {
      gaps.push({
        type: 'missing_character_first_appearance',
        description: `Character "${char.entityId}" firstAppearance references unknown chapter "${char.firstAppearance.chapterId}"`,
      });
    }
  }

  // Check that every narrative node references a chapter in the manifest
  for (const node of index.narrativeNodes) {
    if (!manifestChapterIds.has(node.chapterId)) {
      gaps.push({
        type: 'orphan_node',
        description: `Narrative node "${node.nodeId}" references unknown chapter "${node.chapterId}"`,
      });
    }
  }

  // Check that every discourse node references a chapter in the manifest
  for (const node of index.discourseNodes) {
    if (!manifestChapterIds.has(node.chapterId)) {
      gaps.push({
        type: 'orphan_node',
        description: `Discourse node "${node.nodeId}" references unknown chapter "${node.chapterId}"`,
      });
    }
  }

  // Check that every candidate event references a valid chapter
  for (const candidate of index.candidateEvents) {
    if (!manifestChapterIds.has(candidate.sourceRange.chapterId)) {
      gaps.push({
        type: 'missing_candidate_source_range',
        description: `Candidate "${candidate.candidateId}" references unknown chapter "${candidate.sourceRange.chapterId}"`,
      });
    }
  }

  return { valid: gaps.length === 0, gaps };
}

/**
 * Result of a double-counting detection.
 */
export interface DoubleCountingResult {
  /** Whether any duplicate/overlapping ranges were found */
  hasDuplicate: boolean;
  /** Groups of overlapping candidate IDs */
  overlapping: string[][];
}

/**
 * Check for double-counting in candidate events.
 * Two candidates are considered overlapping if they share the same chapter
 * and their byte ranges intersect.
 *
 * @param candidates - Array of candidate event index entries
 * @returns Detection result with overlapping groups
 */
export function detectDoubleCounting(candidates: CandidateEventIndex[]): DoubleCountingResult {
  const overlapping: string[][] = [];
  const checked = new Set<number>();

  for (let i = 0; i < candidates.length; i++) {
    if (checked.has(i)) continue;
    const group: string[] = [candidates[i].candidateId];
    checked.add(i);

    for (let j = i + 1; j < candidates.length; j++) {
      if (checked.has(j)) continue;
      const a = candidates[i].sourceRange;
      const b = candidates[j].sourceRange;

      // Only check candidates in the same chapter
      if (a.chapterId === b.chapterId) {
        // Check if ranges intersect: startA < endB && startB < endA
        if (a.startByte < b.endByte && b.startByte < a.endByte) {
          group.push(candidates[j].candidateId);
          checked.add(j);
        }
      }
    }

    if (group.length > 1) {
      overlapping.push(group);
    }
  }

  return {
    hasDuplicate: overlapping.length > 0,
    overlapping,
  };
}

/**
 * Get a human-readable title for an anchored work.
 * Returns undefined for unknown work IDs.
 */
export function getAnchoredWorkTitle(workId: string): string | undefined {
  return ANCHORED_WORKS[workId]?.title;
}

/**
 * Check whether a work ID corresponds to an anchored work.
 */
export function isAnchoredWork(workId: string): boolean {
  return workId in ANCHORED_WORKS;
}

/**
 * Check whether a work ID is allowed in public CI.
 * Only public_domain works are included in default CI runs.
 */
export function isAllowedInPublicCI(workId: string): boolean {
  const entry = ANCHORED_WORKS[workId];
  return entry?.legalMode === 'public_domain';
}
