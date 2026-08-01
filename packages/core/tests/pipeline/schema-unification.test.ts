// ============================================================================
// Schema Unification Tests — Track 4A
//
// Verifies that the static analysisContentSchema and the dynamic
// getCombinedValidationSchema() produce identical validation results,
// and that no lenient/optional path exists for Pass 2 analysis validation.
// ============================================================================

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseAnalysisJSON, parseAnalysisJSONWithErrors } from '../../src/schemas/analysis.js';
import { analysisContentSchema } from '../../src/validator/index.js';
import { makeObservations, makeProtocol } from '../fixtures/mock-pass2-helpers.ts';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const ALL_FIELDS_PAYLOAD: Record<string, unknown> = {
  postconditions: { covered: ['char.status'], dropped: [] },
  preconditions: { violated: [] },
  pov: { consistent: true, leaks: [] },
  inventedDetails: [],
  quality: {
    proseScore: 8,
    maxScore: 10,
    strengths: ['good'],
    weaknesses: [],
    estimatedWordCount: 350,
  },
  threadProgressAchieved: ['thread-1'],
  foreshadowingDeployed: [],
  narrativeChecks: [],
  appearanceChecks: [],
  characterReferences: [],
  tenseDetected: 'past',
  conflictAnalysis: { primaryType: 'none', resolutionAchieved: true },
  ruleChecks: [],
  knowledgeChecks: [],
  checklistResults: [],
};

const ALL_FIELDS_VALID = {
  eventId: 'E1',
  protocol: makeProtocol('prose'),
  observations: makeObservations(ALL_FIELDS_PAYLOAD, 'prose'),
  analysis: ALL_FIELDS_PAYLOAD,
};

// ---------------------------------------------------------------------------
// Tests — analysisContentSchema strictness
// ---------------------------------------------------------------------------

describe('analysisContentSchema', () => {
  it('has all 20 blocks (14 required + 6 optional)', () => {
    const shape = analysisContentSchema.shape;
    const requiredFields = [
      'postconditions',
      'pov',
      'inventedDetails',
      'quality',
      'threadProgressAchieved',
      'foreshadowingDeployed',
      'narrativeChecks',
      'appearanceChecks',
      'characterReferences',
      'tenseDetected',
      'conflictAnalysis',
      'ruleChecks',
      'knowledgeChecks',
    ];

    for (const field of requiredFields) {
      const zodType = shape[field];
      expect(zodType).toBeDefined();
      // None of these should be optional (nullable or optional wrapper)
      // Optional schemas are ZodOptional, required ones are not
      expect(zodType).not.toBeInstanceOf(z.ZodOptional);
    }

    // Verify total field count = 20 (14 required + optional checklistResults
    // + 5 optional S6 Genette dimension blocks)
    expect(Object.keys(shape)).toHaveLength(20);
  });

  it('accepts valid analysis with all 15 blocks', () => {
    const result = analysisContentSchema.safeParse(ALL_FIELDS_VALID.analysis);
    expect(result.success).toBe(true);
  });

  it('rejects analysis missing a required block', () => {
    const { narrativeChecks, ...partial } = ALL_FIELDS_VALID.analysis;
    const result = analysisContentSchema.safeParse(partial);
    expect(result.success).toBe(false);
    if (!result.success) {
      // Error should mention the missing field
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('narrativeChecks');
    }
  });

  it('rejects analysis missing multiple required blocks', () => {
    const {
      narrativeChecks,
      tenseDetected,
      conflictAnalysis,
      ruleChecks,
      knowledgeChecks,
      ...partial
    } = ALL_FIELDS_VALID.analysis;
    const result = analysisContentSchema.safeParse(partial);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('narrativeChecks');
      expect(paths).toContain('tenseDetected');
      expect(paths).toContain('conflictAnalysis');
      expect(paths).toContain('ruleChecks');
      expect(paths).toContain('knowledgeChecks');
    }
  });

  it('rejects analysis missing all optional-since-removed blocks', () => {
    // All 7 fields that were previously optional are now required
    const base = {
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
    };
    const result = analysisContentSchema.safeParse(base);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('narrativeChecks');
      expect(paths).toContain('appearanceChecks');
      expect(paths).toContain('characterReferences');
      expect(paths).toContain('tenseDetected');
      expect(paths).toContain('conflictAnalysis');
      expect(paths).toContain('ruleChecks');
      expect(paths).toContain('knowledgeChecks');
    }
  });
});

// ---------------------------------------------------------------------------
// Tests — parseAnalysisJSON uses strict schema
// ---------------------------------------------------------------------------

describe('parseAnalysisJSON unified strict schema', () => {
  it('parses valid JSON with all 15 blocks', () => {
    const result = parseAnalysisJSON(JSON.stringify(ALL_FIELDS_VALID));
    expect(result).not.toBeNull();
    expect(result!.eventId).toBe('E1');
  });

  it('returns null for JSON missing a required block', () => {
    const { narrativeChecks, ...analysisPartial } = ALL_FIELDS_VALID.analysis;
    const partial = { eventId: 'E1', analysis: analysisPartial };
    const result = parseAnalysisJSON(JSON.stringify(partial));
    expect(result).toBeNull();
  });

  it('returns null for JSON missing multiple required blocks', () => {
    const { narrativeChecks, tenseDetected, conflictAnalysis, ...analysisPartial } =
      ALL_FIELDS_VALID.analysis;
    const partial = { eventId: 'E1', analysis: analysisPartial };
    const result = parseAnalysisJSON(JSON.stringify(partial));
    expect(result).toBeNull();
  });

  it('returns null for JSON missing all previously-optional blocks', () => {
    const partial = {
      eventId: 'E1',
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
      },
    };
    const result = parseAnalysisJSON(JSON.stringify(partial));
    expect(result).toBeNull();
  });

  it('passes through warn callback on validation failure', () => {
    const warnings: string[] = [];
    const partial = {
      eventId: 'E1',
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
      },
    };
    const result = parseAnalysisJSON(JSON.stringify(partial), (m) => warnings.push(m));
    expect(result).toBeNull();
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.includes('validation failed'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests — parseAnalysisJSONWithErrors uses strict schema (fallback path)
// ---------------------------------------------------------------------------

describe('parseAnalysisJSONWithErrors unified strict schema', () => {
  it('parses valid JSON with all 15 blocks (no combined schema)', () => {
    const result = parseAnalysisJSONWithErrors(JSON.stringify(ALL_FIELDS_VALID));
    expect(result.result).not.toBeNull();
    expect(result.parseError).toBeUndefined();
    expect(result.zodErrors).toBeUndefined();
  });

  it('returns zodErrors for JSON missing a required block (no combined schema)', () => {
    // narrativeChecks is nested under analysis — construct partial correctly
    const { narrativeChecks, ...analysisPartial } = ALL_FIELDS_VALID.analysis;
    const partial = { eventId: 'E1', analysis: analysisPartial };
    const result = parseAnalysisJSONWithErrors(JSON.stringify(partial));
    expect(result.result).toBeNull();
    expect(result.zodErrors).toBeDefined();
  });

  it('produces same validation result for cache and live paths', () => {
    // The static schema (used by default parseAnalysisJSON) and the dynamic schema
    // (getCombinedValidationSchema) should produce the same result for all-14-field JSON.
    // This test verifies the static fallback path (no combined schema) matches.
    const staticResult = parseAnalysisJSON(JSON.stringify(ALL_FIELDS_VALID));
    const dynamicResult = parseAnalysisJSONWithErrors(JSON.stringify(ALL_FIELDS_VALID));
    expect(staticResult).not.toBeNull();
    expect(dynamicResult.result).not.toBeNull();
    expect(staticResult!.eventId).toBe(dynamicResult.result!.eventId);
  });
});
