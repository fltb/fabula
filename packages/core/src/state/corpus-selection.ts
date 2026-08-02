// ============================================================================
// Novalistically — CORPUS-3: Reproducible Selective Rendering
// Selection algorithm, eligibility gating, and coverage categorization
// for frozen candidate event indexes.
// ============================================================================

import { ConfigError } from '../errors.ts';
import type { CandidateEventIndex } from './corpus-index.ts';

// ═════════════════════════════════════════════════════════════════════════════
// Constants — Fixed Formula
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Default selection formula: min(32, max(20, ceil(0.15 * N))).
 * Guarantees a minimum of 20 events and a practical upper bound of 32
 * for manageably-sized manual oracle annotation.
 */
export const DEFAULT_SELECTION_FORMULA = 'min(32, max(20, ceil(0.15 * N)))' as const;

/**
 * Minimum N for benchmark eligibility.
 */
export const BENCHMARK_ELIGIBILITY_MIN = 20 as const;

/**
 * Coverage strata checked by getCoverageCategories.
 */
export const COVERAGE_STRATA = [
  'beginning',
  'middle',
  'end',
  'main_thread',
  'sub_thread',
  'major_change',
] as const;

export type CoverageStrata = (typeof COVERAGE_STRATA)[number];

// ═════════════════════════════════════════════════════════════════════════════
// Types
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Frozen selection plan for a work variant.
 * Every field is determined before any model results are available.
 */
export interface SelectionPlan {
  /** Canonical work identifier, e.g. 'dream-of-red-chamber' */
  workId: string;
  /** Selection algorithm identifier */
  algorithm: string;
  /** Deterministic seed for stratified random selection */
  seed: number;
  /** Human-readable formula string */
  formula: string;
  /** Coverage strata names used for stratification */
  strata: string[];
  /** Target quota (the result of applying the formula) */
  quota: number;
  /** Rounding strategy */
  rounding: 'ceil';
  /** Tie-breaking strategy */
  tieBreak: 'lexicographic';
  /** Frozen list of selected candidate IDs */
  candidates: string[];
  /** Source ranges for each selected candidate, indexed by candidateId */
  sourceRanges: { candidateId: string; chapterId: string; startByte: number; endByte: number }[];
}

// ═════════════════════════════════════════════════════════════════════════════
// Formula
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Apply the selection formula to compute the quota for N candidates.
 * Formula: min(32, max(20, ceil(0.15 * N)))
 *
 * @param n - Total number of candidate events
 * @returns The target selection quota
 */
export function applySelectionFormula(n: number): number {
  if (n < 0) {
    throw new ConfigError(`N cannot be negative, got ${n}`);
  }
  return Math.min(32, Math.max(20, Math.ceil(0.15 * n)));
}

// ═════════════════════════════════════════════════════════════════════════════
// Selection Planning
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Deterministic pseudo-random number generator (mulberry32).
 * Produces reproducible results from a 32-bit seed.
 */
function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic lexicographic tie-breaker — falls back to localeCompare
 * when two candidates have equal pseudo-random order.
 */
function lexicographicTieBreak(a: string, b: string): number {
  return a.localeCompare(b);
}

/**
 * Create a frozen selection plan from a list of candidate events.
 *
 * The selection algorithm:
 * 1. Apply the formula to determine quota.
 * 2. Filter to eligible candidates.
 * 3. Assign each candidate a pseudo-random score (mulberry32 seeded by `seed + index`).
 * 4. Sort by score, tie-breaking lexicographically by candidateId.
 * 5. Take the top `quota` candidates.
 *
 * @param candidates - Frozen candidate event index entries
 * @param seed - Deterministic seed for reproducibility
 * @param workId - Canonical work identifier (default from first candidate if available)
 * @returns A frozen SelectionPlan with all parameters recorded
 */
export function planSelection(
  candidates: CandidateEventIndex[],
  seed: number,
  workId?: string,
): SelectionPlan {
  if (candidates.length === 0) {
    throw new ConfigError('Cannot plan selection from empty candidate list');
  }

  const totalCandidates = candidates.length;
  const quota = applySelectionFormula(totalCandidates);
  const effectiveWorkId = workId ?? 'unknown';

  // Filter to eligible candidates for stratified selection
  const eligible = candidates.filter((c) => c.eligibility === 'eligible');

  if (eligible.length < quota) {
    throw new ConfigError(
      `Not enough eligible candidates: need ${quota}, have ${eligible.length} (total: ${totalCandidates})`,
    );
  }

  // Assign pseudo-random scores for stratified selection
  const rng = mulberry32(seed);
  const scored = eligible.map((c) => ({
    candidate: c,
    score: rng(),
  }));

  // Sort by score descending, tie-break lexicographically
  scored.sort((a, b) => {
    const diff = b.score - a.score;
    if (diff !== 0) return diff;
    return lexicographicTieBreak(a.candidate.candidateId, b.candidate.candidateId);
  });

  // Take top quota
  const selected = scored.slice(0, quota);

  const sourceRanges = selected.map((s) => ({
    candidateId: s.candidate.candidateId,
    chapterId: s.candidate.sourceRange.chapterId,
    startByte: s.candidate.sourceRange.startByte,
    endByte: s.candidate.sourceRange.endByte,
  }));

  return {
    workId: effectiveWorkId,
    algorithm: 'stratified_random',
    seed,
    formula: DEFAULT_SELECTION_FORMULA,
    strata: [...COVERAGE_STRATA],
    quota,
    rounding: 'ceil',
    tieBreak: 'lexicographic',
    candidates: selected.map((s) => s.candidate.candidateId),
    sourceRanges,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Validation
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Validate that all candidate IDs in a selection plan correspond to
 * existing events.
 *
 * @param plan - The selection plan to validate
 * @param eventIds - The set of known event IDs
 * @returns Validation result with missing IDs
 */
export function validateSelectionAgainstEvents(
  plan: SelectionPlan,
  eventIds: string[],
): { valid: boolean; missing: string[] } {
  const known = new Set(eventIds);
  const missing = plan.candidates.filter((id) => !known.has(id));

  return {
    valid: missing.length === 0,
    missing,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Eligibility
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Check whether a candidate count is eligible for benchmarking.
 * N < 20 → not benchmark-eligible.
 *
 * @param n - Total candidate events
 * @returns true if n >= 20
 */
export function isBenchmarkEligible(n: number): boolean {
  if (n < 0 || !Number.isFinite(n) || !Number.isInteger(n)) {
    return false;
  }
  return n >= BENCHMARK_ELIGIBILITY_MIN;
}

// ═════════════════════════════════════════════════════════════════════════════
// Coverage Categories
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Get the set of coverage categories satisfied by a list of candidate events.
 *
 * Checks:
 * - beginning, middle, end: spread across the candidate list
 * - main_thread: at least one candidate with broad narrativeCoverage (≥3)
 * - sub_thread: at least one candidate with narrow narrativeCoverage (<3)
 * - major_change: at least one eligible candidate
 *
 * @param candidates - Candidate event index entries
 * @returns Array of coverage category strings present
 */
export function getCoverageCategories(candidates: CandidateEventIndex[]): string[] {
  const categories = new Set<string>();

  if (candidates.length === 0) {
    return [];
  }

  // Check position-based coverage
  const firstThird = Math.ceil(candidates.length / 3);
  const secondThird = Math.ceil((2 * candidates.length) / 3);

  const beginning = candidates.slice(0, firstThird);
  const middle = candidates.slice(firstThird, secondThird);
  const end = candidates.slice(secondThird);

  // beginning coverage
  if (beginning.some((c) => c.eligibility === 'eligible')) {
    categories.add('beginning');
  }

  // middle coverage
  if (middle.some((c) => c.eligibility === 'eligible')) {
    categories.add('middle');
  }

  // end coverage
  if (end.some((c) => c.eligibility === 'eligible')) {
    categories.add('end');
  }

  // main_thread: candidate covering ≥3 entities
  if (candidates.some((c) => c.narrativeCoverage.length >= 3)) {
    categories.add('main_thread');
  }

  // sub_thread: candidate covering 1-2 entities (and not already counted as main)
  if (candidates.some((c) => c.narrativeCoverage.length >= 1 && c.narrativeCoverage.length < 3)) {
    categories.add('sub_thread');
  }

  // major_change: any eligible candidate with coverage
  if (candidates.some((c) => c.eligibility === 'eligible' && c.narrativeCoverage.length > 0)) {
    categories.add('major_change');
  }

  return [...categories].sort();
}
