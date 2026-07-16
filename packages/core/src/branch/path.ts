// ============================================================================
// Novalistically — Branch Path Utilities
// ============================================================================

import type { BranchPath } from './types.ts';

/**
 * Creates an empty branch path with no decisions, representing a purely linear
 * narrative where the reader has not yet taken any branches.
 */
export function createEmptyBranchPath(): BranchPath {
  return { decisions: [] };
}

/**
 * Deep equality comparison of two BranchPath objects.
 * Compares every decision field individually to avoid reference pitfalls.
 */
export function branchPathsEqual(a: BranchPath, b: BranchPath): boolean {
  if (a.decisions.length !== b.decisions.length) return false;
  for (let i = 0; i < a.decisions.length; i++) {
    const da = a.decisions[i];
    const db = b.decisions[i];
    if (da.atEventId !== db.atEventId) return false;
    if (da.choiceId !== db.choiceId) return false;
    if (da.narrativeOrder !== db.narrativeOrder) return false;
  }
  return true;
}

/**
 * Human-readable string representation of a BranchPath.
 * Format: `BP1:trust_seraphine → BP2:attack`
 * Linear paths (no decisions) produce `"Linear"`.
 */
export function branchPathToString(bp: BranchPath): string {
  if (bp.decisions.length === 0) return 'Linear';
  return bp.decisions
    .map(d => `BP${d.narrativeOrder}:${d.choiceId}`)
    .join(' → ');
}

/**
 * Returns `true` when the branch path has no decisions, meaning the story has
 * followed a purely linear sequence so far.
 */
export function isLinearNarrative(bp: BranchPath): boolean {
  return bp.decisions.length === 0;
}
