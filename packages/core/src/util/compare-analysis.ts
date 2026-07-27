// ============================================================================
// Compare Analysis Blocks — field-by-field comparison for double-run verification
// ============================================================================
//
// Used by RenderPipeline.doubleRunVerification (dev-only) to detect
// non-deterministic Pass 2 analysis output at the block level.
// ============================================================================

/**
 * Compare two AnalysisContent objects field-by-field using JSON serialization.
 * Returns a list of block names that differ between the two.
 * Skips `eventId` if present (not part of AnalysisContent, but defensive).
 */
export function compareAnalysisBlocks(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): string[] {
  const diffs: string[] = [];
  const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of allKeys) {
    const aVal = a[key];
    const bVal = b[key];
    if (JSON.stringify(aVal) !== JSON.stringify(bVal)) {
      diffs.push(key as string);
    }
  }
  return diffs;
}
