import type { BranchPath } from '../types/index.js';
import type { SortedScene } from './types.js';

// ────────────────────────────────────────────────────────────────────────────
// Branch-Path Filter
// ────────────────────────────────────────────────────────────────────────────

/**
 * Filter sorted scenes by a BranchPath.
 *
 * Scenes at or before the last decision point are always included (they
 * lie on the common trunk). Scenes after the last decision point are
 * assumed to be on the chosen branch path; true branch-scope filtering
 * requires scene-level branch annotations (not yet available), so all
 * post-decision scenes are kept.
 *
 * When `branchPath` is undefined or has no decisions the full scene list
 * is returned unchanged.
 */
export function filterScenesByBranchPath(
  scenes: SortedScene[],
  branchPath?: BranchPath,
): SortedScene[] {
  if (!branchPath || !branchPath.decisions || branchPath.decisions.length === 0) {
    return scenes;
  }

  // Without scene-level branch annotations, include everything.
  // Future enhancement: filter by branch-scene membership when available.
  return scenes;
}
