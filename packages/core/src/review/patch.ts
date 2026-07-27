// ============================================================================
// Review System — Patch operations (pure functions)
// ============================================================================

import type { PatchChange, ReviewPatch } from '../types/index.js';

/** Create a patch from resolved comments and store it */
export function createPatch(
  patches: ReviewPatch[],
  sourceReviewIds: string[],
  changes: PatchChange[],
): ReviewPatch {
  const patch: ReviewPatch = { sourceReviewIds, description: '', changes };
  patches.push(patch);
  return patch;
}
