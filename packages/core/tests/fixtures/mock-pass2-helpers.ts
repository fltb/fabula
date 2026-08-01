// ============================================================================
// Test Helpers — Mock Pass 2 Fixture Factory
// ============================================================================
//
// Factory functions for creating MockPass2Entry objects in tests.
// Entries carry the full current AnalysisResult contract: eventId, protocol,
// observations (one per active analysis field) and the dynamic analysis
// payload. Evidence quotes are always exact substrings of the entry prose so
// the exact-quote validation hook passes when the parser is given prose.

import type { MockPass2Entry } from '../../src/ai/providers/mock-pass2.js';
import { sha256Canonical } from '../../src/cache/render-cache.js';
import { validationKeySchema } from '../../src/schemas/discourse.js';
import type {
  AnalysisContent,
  AnalysisObservation,
  AnalysisResult,
} from '../../src/types/analysis.js';
import type { ValidationKey } from '../../src/types/discourse.js';

/**
 * Build a protocol object matching the CURRENT ValidationKey schema shape
 * (fields are derived from the live schema), so fixture entries parse under
 * whatever protocol schema is active. proseHash is the canonical SHA-256 of
 * the prose, matching the pipeline's protocol construction.
 */
export function makeProtocol(prose: string): ValidationKey {
  const values: Record<string, string> = {
    proseHash: sha256Canonical(prose),
    analysisSchema: 'mock-analysis-contract',
    model: 'mock-pass2',
    provider: 'mock-pass2',
    analysisPromptHash: '0'.repeat(64),
    samplingConfigHash: 'mock-sampling-config',
    validatorPolicy: 'mock-validator-policy',
    referencePolicy: 'mock-reference-policy',
  };
  const protocol: Record<string, string> = {};
  for (const key of Object.keys(validationKeySchema.shape)) {
    protocol[key] = values[key] ?? `mock-${key}`;
  }
  return protocol as ValidationKey;
}

/**
 * Extract an exact substring of the prose to use as evidence. The quote is a
 * contiguous slice of the prose, so it always satisfies the substring check.
 */
function exactQuote(prose: string): string {
  const trimmed = prose.trim();
  return trimmed.length > 24 ? trimmed.slice(0, 24) : trimmed;
}

/**
 * Build a `produced` observation for every active analysis field.
 */
export function makeObservations(
  analysis: Record<string, unknown>,
  prose: string,
): Record<string, AnalysisObservation> {
  const observations: Record<string, AnalysisObservation> = {};
  for (const field of Object.keys(analysis)) {
    observations[field] = {
      disposition: 'produced',
      evidence: [exactQuote(prose)],
    };
  }
  return observations;
}

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
  const prose = `This is test prose for event ${eventId}.`;
  const content: Record<string, unknown> = {
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
    tenseDetected: 'past',
    conflictAnalysis: { primaryType: '', resolutionAchieved: false },
    ruleChecks: [],
    knowledgeChecks: [],
    checklistResults: [],
    ...overrides,
  };

  const analysis: AnalysisResult = {
    eventId,
    protocol: makeProtocol(prose),
    observations: makeObservations(content, prose),
    analysis: content,
  };

  return {
    prose,
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
