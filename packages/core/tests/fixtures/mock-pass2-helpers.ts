// ============================================================================
// Test Helpers — Mock Pass 2 Fixture Factory
// ============================================================================
//
// Factory functions for creating MockPass2Entry objects in tests.

import type { MockPass2Entry } from '../../src/ai/providers/mock-pass2.js';
import type { AnalysisContent, AnalysisResult } from '../../src/types/analysis.js';

/**
 * Create a minimal MockPass2Entry with sensible defaults.
 *
 * @example
 * ```ts
 * const entry = makeAnalysisResult('E1');
 * provider = new MockPass2Provider({ entries: { E1: entry } });
 * ```
 */
export function makeAnalysisResult(
  eventId: string,
  overrides: Partial<AnalysisContent> = {},
): MockPass2Entry {
  const analysis: AnalysisResult = {
    eventId,
    analysis: {
      postconditions: { covered: [], dropped: [] },
      preconditions: { violated: [] },
      pov: { consistent: true, leaks: [] },
      inventedDetails: [],
      quality: {
        proseScore: 3,
        maxScore: 5,
        strengths: [],
        weaknesses: [],
        estimatedWordCount: 50,
      },
      threadProgressAchieved: [],
      foreshadowingDeployed: [],
      narrativeChecks: [],
      appearanceChecks: [],
      characterReferences: [],
      ...overrides,
    },
  };

  return {
    prose: `This is test prose for event ${eventId}.`,
    analysis,
  };
}

/**
 * Create a MockPass2Entry with a specific analysis result.
 * Useful when you need full control over the AnalysisResult shape.
 */
export function makeCustomEntry(
  eventId: string,
  prose: string,
  analysis: AnalysisResult,
): MockPass2Entry {
  return { prose, analysis };
}

/**
 * Create a set of entries keyed by eventId for multiple events.
 *
 * @example
 * ```ts
 * const entries = makeAnalysisEntries(['E1', 'E2', 'E3']);
 * provider = new MockPass2Provider({ entries });
 * ```
 */
export function makeAnalysisEntries(
  eventIds: string[],
  overrides?: Partial<AnalysisContent>,
): Record<string, MockPass2Entry> {
  const entries: Record<string, MockPass2Entry> = {};
  for (const eventId of eventIds) {
    entries[eventId] = makeAnalysisResult(eventId, overrides);
  }
  return entries;
}
