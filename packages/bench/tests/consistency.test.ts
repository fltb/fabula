// ============================================================================
// Consistency Metrics — focused tests for every exported function
// ============================================================================

import { describe, expect, it } from 'vitest';
import {
  computeNCED,
  computeSCED,
  computeSpearmanRho,
  computeDisattenuatedRho,
  computeWordCountByLanguage,
  computePerValidatorBreakdown,
  computeSeverityLevelCED,
} from '../src/consistency.js';
import type { ValidationIssue } from '@novalistically/core';

// ============================================================================
// Helpers
// ============================================================================

function makeIssue(overrides: Partial<ValidationIssue> & { validator: string; severity: ValidationIssue['severity'] }): ValidationIssue {
  return {
    event: 'E0',
    entity: 'system',
    attribute: undefined,
    message: '',
    fixSuggestion: '',
    fixAction: 'add_knowledge',
    fixTarget: { file: 'test.yaml' },
    ...overrides,
  };
}

// ============================================================================
// N-CED
// ============================================================================

describe('computeNCED', () => {
  it('returns 0 for zero words', () => {
    expect(computeNCED(5, 0, 0, 0)).toBe(0);
  });

  it('computes correct density', () => {
    // 10 errors + 5 warnings + 3 info = 18 issues across 90000 words
    // 90000 / 10000 = 9 → 18 / 9 = 2
    expect(computeNCED(10, 5, 3, 90000)).toBeCloseTo(2, 10);
  });

  it('handles single issue in small text', () => {
    // 1 issue across 5000 words → 5000 / 10000 = 0.5 → 1 / 0.5 = 2
    expect(computeNCED(1, 0, 0, 5000)).toBeCloseTo(2, 10);
  });
});

// ============================================================================
// S-CED
// ============================================================================

describe('computeSCED', () => {
  it('computes raw and weighted SCED for known inputs', () => {
    // 3 errors + 2 warnings + 1 info = 6 raw issues across 5000 words
    // rawSCED = 6 / (5000/10000) = 6 / 0.5 = 12
    // weighted = (3*1.0 + 2*0.3 + 1*0.1) / 0.5 = (3 + 0.6 + 0.1) / 0.5 = 3.7 / 0.5 = 7.4
    const issues: ValidationIssue[] = [
      makeIssue({ validator: 'V1', severity: 'error', event: 'E0', entity: 'sys' }),
      makeIssue({ validator: 'V1', severity: 'error', event: 'E1', entity: 'sys' }),
      makeIssue({ validator: 'V1', severity: 'error', event: 'E2', entity: 'sys' }),
      makeIssue({ validator: 'V2', severity: 'warning', event: 'E0', entity: 'entityA' }),
      makeIssue({ validator: 'V2', severity: 'warning', event: 'E1', entity: 'entityA' }),
      makeIssue({ validator: 'V2', severity: 'info', event: 'E0', entity: 'entityA' }),
    ];

    const result = computeSCED(issues, 5000);
    expect(result.totalRawIssues).toBe(6);
    expect(result.totalWeightedIssues).toBeCloseTo(3.7, 10);
    expect(result.rawSCED).toBeCloseTo(12, 10);
    expect(result.weightedSCED).toBeCloseTo(7.4, 10);
  });

  it('deduplicates identical issues', () => {
    // 3 entries but only 2 unique (duplicate on validator+event+entity+attribute+severity)
    const issues: ValidationIssue[] = [
      makeIssue({ validator: 'V1', severity: 'error', event: 'E0', entity: 'sys' }),
      makeIssue({ validator: 'V1', severity: 'error', event: 'E0', entity: 'sys' }),
      makeIssue({ validator: 'V1', severity: 'error', event: 'E0', entity: 'sys' }),
    ];

    const result = computeSCED(issues, 10000);
    expect(result.totalRawIssues).toBe(1);
    expect(result.rawSCED).toBeCloseTo(1, 10);
  });

  it('preserves issues differing only by attribute', () => {
    const issues: ValidationIssue[] = [
      makeIssue({ validator: 'V1', severity: 'error', event: 'E0', entity: 'sys', attribute: 'attr1' }),
      makeIssue({ validator: 'V1', severity: 'error', event: 'E0', entity: 'sys', attribute: 'attr2' }),
    ];

    const result = computeSCED(issues, 10000);
    expect(result.totalRawIssues).toBe(2);
  });

  it('returns 0 for empty issue list', () => {
    const result = computeSCED([], 10000);
    expect(result.totalRawIssues).toBe(0);
    expect(result.totalWeightedIssues).toBe(0);
    expect(result.rawSCED).toBe(0);
    expect(result.weightedSCED).toBe(0);
  });

  it('returns 0 when wordCount is 0', () => {
    const issues: ValidationIssue[] = [
      makeIssue({ validator: 'V1', severity: 'error', event: 'E0', entity: 'sys' }),
    ];
    const result = computeSCED(issues, 0);
    expect(result.rawSCED).toBe(0);
    expect(result.weightedSCED).toBe(0);
  });

  it('accepts custom weights', () => {
    const issues: ValidationIssue[] = [
      makeIssue({ validator: 'V1', severity: 'error', event: 'E0', entity: 'sys' }),
      makeIssue({ validator: 'V1', severity: 'warning', event: 'E1', entity: 'sys' }),
    ];
    const customWeights = { error: 2.0, warning: 0.5, info: 0.05 };
    const result = computeSCED(issues, 10000, customWeights);
    expect(result.totalWeightedIssues).toBeCloseTo(2.5, 10);
  });
});

// ============================================================================
// Spearman rho
// ============================================================================

describe('computeSpearmanRho', () => {
  it('computes rho = 1 for perfectly correlated rankings', () => {
    const rankings = [1, 2, 3, 4, 5];
    const result = computeSpearmanRho(rankings, rankings);
    expect(result.rho).toBeCloseTo(1, 10);
    expect(result.pValue).toBeCloseTo(0, 10);
  });

  it('computes rho = -1 for perfectly inversely correlated rankings', () => {
    const a = [1, 2, 3, 4, 5];
    const b = [5, 4, 3, 2, 1];
    const result = computeSpearmanRho(a, b);
    expect(result.rho).toBeCloseTo(-1, 10);
    expect(result.pValue).toBeCloseTo(0, 5);
  });

  it('computes correct rho for known example', () => {
    // Example from plan: [1,2,3,4,5] vs [2,1,3,5,4]
    const severity = [1, 2, 3, 4, 5];
    const priority = [2, 1, 3, 5, 4];
    const result = computeSpearmanRho(severity, priority);
    // d = [-1, 1, 0, -1, 1], sum d^2 = 1+1+0+1+1 = 4
    // n=5, denom = 5*(25-1) = 5*24 = 120
    // rho = 1 - 6*4/120 = 1 - 24/120 = 1 - 0.2 = 0.8
    expect(result.rho).toBeCloseTo(0.8, 10);
  });

  it('handles ties with midrank', () => {
    // Rankings with ties: [1, 2, 2, 4] vs [1, 2, 3, 4]
    // midrank for [1, 2, 2, 4] → [1, 2.5, 2.5, 4]
    // midrank for [1, 2, 3, 4] → [1, 2, 3, 4]
    // d = [0, 0.5, -0.5, 0], sum d^2 = 0 + 0.25 + 0.25 + 0 = 0.5
    // n=4, denom = 4*(16-1) = 4*15 = 60
    // rho = 1 - 6*0.5/60 = 1 - 3/60 = 1 - 0.05 = 0.95
    const a = [1, 2, 2, 4];
    const b = [1, 2, 3, 4];
    const result = computeSpearmanRho(a, b);
    expect(result.rho).toBeCloseTo(0.95, 8);
  });

  it('returns NaN for fewer than 3 pairs', () => {
    const a = [1, 2];
    const b = [2, 1];
    const result = computeSpearmanRho(a, b);
    expect(result.rho).toBeNaN();
    expect(result.pValue).toBeNaN();
  });

  it('returns NaN for mismatched lengths', () => {
    const result = computeSpearmanRho([1, 2, 3], [1, 2]);
    expect(result.rho).toBeNaN();
    expect(result.pValue).toBeNaN();
  });

  it('accepts non-integer values (midrank handles them)', () => {
    const a = [1.5, 2.5, 3.0, 4.2, 5.1];
    const b = [5.0, 4.0, 3.0, 2.0, 1.0];
    const result = computeSpearmanRho(a, b);
    expect(result.rho).toBeCloseTo(-1, 8);
  });
});

// ============================================================================
// Disattenuated rho
// ============================================================================

describe('computeDisattenuatedRho', () => {
  it('corrects observed rho for measurement error', () => {
    // observed=0.6, reliabilityA=0.8, reliabilityB=0.9
    // divisor = sqrt(0.8*0.9) = sqrt(0.72) ≈ 0.8485
    // disattenuated = 0.6 / 0.8485 ≈ 0.7071
    const result = computeDisattenuatedRho(0.6, 0.8, 0.9);
    expect(result.applicable).toBe(true);
    expect(result.value).toBeCloseTo(0.7071, 4);
  });

  it('clamps value to [-1, 1] when corrected exceeds range', () => {
    // observed=0.95, reliabilityA=0.5, reliabilityB=0.5
    // divisor = sqrt(0.25) = 0.5
    // raw = 0.95 / 0.5 = 1.9 → clamped to 1
    const result = computeDisattenuatedRho(0.95, 0.5, 0.5);
    expect(result.applicable).toBe(true);
    expect(result.value).toBe(1);
  });

  it('returns null when observedRho is out of range', () => {
    const result = computeDisattenuatedRho(1.5, 0.8, 0.8);
    expect(result.applicable).toBe(false);
    expect(result.value).toBeNull();
    expect(result.reason).toBeDefined();
  });

  it('returns null when reliabilityA is zero', () => {
    const result = computeDisattenuatedRho(0.5, 0, 0.8);
    expect(result.applicable).toBe(false);
    expect(result.value).toBeNull();
    expect(result.reason).toContain('reliabilityA');
  });

  it('returns null when reliabilityB is negative', () => {
    const result = computeDisattenuatedRho(0.5, 0.8, -0.1);
    expect(result.applicable).toBe(false);
    expect(result.value).toBeNull();
  });

  it('returns null when reliabilityA > 1', () => {
    const result = computeDisattenuatedRho(0.5, 1.2, 0.8);
    expect(result.applicable).toBe(false);
    expect(result.value).toBeNull();
  });

  it('returns null for non-finite observedRho', () => {
    const result = computeDisattenuatedRho(NaN, 0.8, 0.8);
    expect(result.applicable).toBe(false);
    expect(result.value).toBeNull();
  });
});

// ============================================================================
// Word count by language
// ============================================================================

describe('computeWordCountByLanguage — zh', () => {
  it('counts CJK characters as individual words', () => {
    // "你好" = 2 CJK chars
    expect(computeWordCountByLanguage('你好', 'zh')).toBe(2);
  });

  it('counts Latin runs as single words', () => {
    // "hello world" = 2 Latin runs
    expect(computeWordCountByLanguage('hello world', 'zh')).toBe(2);
  });

  it('counts mixed CJK and Latin runs', () => {
    // "你好 world 测试" → 4 CJK chars + 1 Latin run = 5
    expect(computeWordCountByLanguage('你好 world 测试', 'zh')).toBe(5);
  });

  it('counts numbers as part of Latin runs', () => {
    // "abc123 def" = 2 runs
    expect(computeWordCountByLanguage('abc123 def', 'zh')).toBe(2);
  });

  it('handles empty string', () => {
    expect(computeWordCountByLanguage('', 'zh')).toBe(0);
  });

  it('handles prose with only punctuation', () => {
    expect(computeWordCountByLanguage('！？，。！', 'zh')).toBe(0);
  });
});

describe('computeWordCountByLanguage — en', () => {
  it('counts simple English prose', () => {
    const text = 'The quick brown fox jumps over the lazy dog';
    expect(computeWordCountByLanguage(text, 'en')).toBe(9);
  });

  it('strips punctuation and counts only content', () => {
    const text = 'Hello, world! This is a test.';
    expect(computeWordCountByLanguage(text, 'en')).toBe(6);
  });

  it('handles hyphenated words', () => {
    const text = 'well-known fact-finding mission';
    expect(computeWordCountByLanguage(text, 'en')).toBe(3);
  });

  it('handles apostrophes in contractions', () => {
    const text = "don't can't it's";
    expect(computeWordCountByLanguage(text, 'en')).toBe(3);
  });

  it('handles empty string', () => {
    expect(computeWordCountByLanguage('', 'en')).toBe(0);
  });

  it('excludes tokens without letters (pure numbers)', () => {
    const text = 'The year 2024 was great';
    expect(computeWordCountByLanguage(text, 'en')).toBe(4); // "2024" excluded, "The", "year", "was", "great"
  });

  it('handles prose with only punctuation', () => {
    expect(computeWordCountByLanguage('!!! ??? ---', 'en')).toBe(0);
  });
});

// ============================================================================
// Per-validator breakdown
// ============================================================================

describe('computePerValidatorBreakdown', () => {
  it('groups by validator and computes counts and nCED', () => {
    const issues: ValidationIssue[] = [
      makeIssue({ validator: 'V1', severity: 'error', event: 'E0', entity: 'sys' }),
      makeIssue({ validator: 'V1', severity: 'error', event: 'E1', entity: 'sys' }),
      makeIssue({ validator: 'V1', severity: 'warning', event: 'E2', entity: 'sys' }),
      makeIssue({ validator: 'V2', severity: 'info', event: 'E0', entity: 'entityA' }),
      makeIssue({ validator: 'V2', severity: 'info', event: 'E1', entity: 'entityA' }),
    ];

    // 5000 words → div = 0.5
    const result = computePerValidatorBreakdown(issues, 5000);

    expect(result.size).toBe(2);

    const v1 = result.get('V1')!;
    expect(v1.errors).toBe(2);
    expect(v1.warnings).toBe(1);
    expect(v1.infos).toBe(0);
    expect(v1.nCED).toBeCloseTo(6, 10); // (2+1+0) / 0.5 = 6
    expect(v1.category).toBe('');

    const v2 = result.get('V2')!;
    expect(v2.errors).toBe(0);
    expect(v2.warnings).toBe(0);
    expect(v2.infos).toBe(2);
    expect(v2.nCED).toBeCloseTo(4, 10); // (0+0+2) / 0.5 = 4
  });

  it('returns empty map for no issues', () => {
    const result = computePerValidatorBreakdown([], 10000);
    expect(result.size).toBe(0);
  });
});

// ============================================================================
// Severity-level CED
// ============================================================================

describe('computeSeverityLevelCED', () => {
  it('computes per-severity raw and weighted CED', () => {
    // 3 errors + 2 warnings + 1 info across 5000 words
    // div = 0.5
    const issues: ValidationIssue[] = [
      makeIssue({ validator: 'V1', severity: 'error', event: 'E0', entity: 'sys' }),
      makeIssue({ validator: 'V1', severity: 'error', event: 'E1', entity: 'sys' }),
      makeIssue({ validator: 'V1', severity: 'error', event: 'E2', entity: 'sys' }),
      makeIssue({ validator: 'V1', severity: 'warning', event: 'E3', entity: 'sys' }),
      makeIssue({ validator: 'V1', severity: 'warning', event: 'E4', entity: 'sys' }),
      makeIssue({ validator: 'V1', severity: 'info', event: 'E5', entity: 'sys' }),
    ];

    const result = computeSeverityLevelCED(issues, 5000);

    // error: 3 / 0.5 = 6 (nCED), 3*1.0 / 0.5 = 6 (sCED)
    expect(result.error.nCED).toBeCloseTo(6, 10);
    expect(result.error.sCED).toBeCloseTo(6, 10);

    // warning: 2 / 0.5 = 4 (nCED), 2*0.3 / 0.5 = 1.2 (sCED)
    expect(result.warning.nCED).toBeCloseTo(4, 10);
    expect(result.warning.sCED).toBeCloseTo(1.2, 10);

    // info: 1 / 0.5 = 2 (nCED), 1*0.1 / 0.5 = 0.2 (sCED)
    expect(result.info.nCED).toBeCloseTo(2, 10);
    expect(result.info.sCED).toBeCloseTo(0.2, 10);
  });

  it('returns zeros for no issues', () => {
    const result = computeSeverityLevelCED([], 10000);

    expect(result.error.nCED).toBe(0);
    expect(result.error.sCED).toBe(0);
    expect(result.warning.nCED).toBe(0);
    expect(result.warning.sCED).toBe(0);
    expect(result.info.nCED).toBe(0);
    expect(result.info.sCED).toBe(0);
  });

  it('handles zero word count gracefully', () => {
    const issues: ValidationIssue[] = [
      makeIssue({ validator: 'V1', severity: 'error', event: 'E0', entity: 'sys' }),
    ];

    // With wordCount=0, div becomes 1 to avoid NaN/Infinity
    const result = computeSeverityLevelCED(issues, 0);
    expect(Number.isFinite(result.error.nCED)).toBe(true);
    expect(result.error.nCED).toBeCloseTo(1, 10);
  });
});
