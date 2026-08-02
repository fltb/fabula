// ============================================================================
// Novalistically — CORPUS-3: Reproducible Selective Rendering — Tests
// Frozen selection plans are clock-independent: identical candidate inputs
// and seed produce a deep-equal SelectionPlan at any wall-clock time.
// ============================================================================

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CandidateEventIndex } from '../../src/state/corpus-index.ts';
import {
  applySelectionFormula,
  planSelection,
  validateSelectionAgainstEvents,
} from '../../src/state/corpus-selection.ts';

// ═════════════════════════════════════════════════════════════════════════════
// Fixtures
// ═════════════════════════════════════════════════════════════════════════════

const sampleCandidates: CandidateEventIndex[] = Array.from({ length: 40 }, (_, i) => {
  const id = i + 1;
  return {
    candidateId: `cand_${String(id).padStart(3, '0')}`,
    eligibility: 'eligible',
    sourceRange: { chapterId: `ch${(id % 3) + 1}`, startByte: id * 1000, endByte: id * 1000 + 900 },
    narrativeCoverage: [`entity_${id % 5}`],
    discourseCoverage: [`n_${id}`],
  };
});

// ═════════════════════════════════════════════════════════════════════════════
// planSelection — clock-independent determinism
// ═════════════════════════════════════════════════════════════════════════════

describe('planSelection — clock-independent determinism', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('produces a deep-equal plan at different wall-clock settings', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    const first = planSelection(sampleCandidates, 20260701, 'dream-of-red-chamber');

    vi.setSystemTime(new Date('2026-06-15T12:00:00Z'));
    const second = planSelection(sampleCandidates, 20260701, 'dream-of-red-chamber');

    // Identical inputs must yield the identical frozen plan — no clock-derived metadata.
    expect(second).toEqual(first);
  });

  it('preserves selection semantics while the clock varies', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    const plan = planSelection(sampleCandidates, 20260701, 'dream-of-red-chamber');

    expect(plan.workId).toBe('dream-of-red-chamber');
    expect(plan.algorithm).toBe('stratified_random');
    expect(plan.formula).toBe('min(32, max(20, ceil(0.15 * N)))');
    expect(plan.rounding).toBe('ceil');
    expect(plan.tieBreak).toBe('lexicographic');
    expect(plan.quota).toBe(applySelectionFormula(sampleCandidates.length));
    expect(plan.candidates).toHaveLength(plan.quota);

    // Source ranges align 1:1 with the selected candidate IDs and stay valid.
    expect(plan.sourceRanges.map((r) => r.candidateId)).toEqual(plan.candidates);
    for (const range of plan.sourceRanges) {
      expect(range.startByte).toBeLessThan(range.endByte);
    }

    // Every selected ID resolves back to the candidate list.
    expect(validateSelectionAgainstEvents(plan, plan.candidates).valid).toBe(true);
  });

  it('is reproducible for one seed and distinct across seeds', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    const first = planSelection(sampleCandidates, 42, 'dream-of-red-chamber');

    vi.setSystemTime(new Date('2026-06-15T12:00:00Z'));
    const sameSeed = planSelection(sampleCandidates, 42, 'dream-of-red-chamber');
    const otherSeed = planSelection(sampleCandidates, 43, 'dream-of-red-chamber');

    expect(sameSeed.candidates).toEqual(first.candidates);
    expect(otherSeed.candidates).not.toEqual(first.candidates);
  });
});
