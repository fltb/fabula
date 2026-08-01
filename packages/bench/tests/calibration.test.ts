// ============================================================================
// Measurement Calibration — focused tests
//
// (1) Metric arithmetic is exercised with clearly synthetic inline records.
//     Every record below carries source: 'synthetic' and the report labels
//     them NON-EMPIRICAL; none of these fixtures are human annotations.
// (2) The committed evidence artifact (packages/bench/reference/
//     calibration-evidence.json) is loaded and must yield calibrated: false
//     with explicit missing-human-evidence reasons.
// (3) The human path (two independent identified raters + human adjudication)
//     is exercised with fixture records so the gate logic is proven both ways.
// ============================================================================

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertCalibrationEvidence,
  buildCalibrationReport,
  CALIBRATION_THRESHOLDS,
  type CalibrationAdjudication,
  type CalibrationEvidence,
  CalibrationEvidenceError,
  type CalibrationRating,
  loadCalibrationEvidence,
} from '../src/calibration.ts';

// ─── Constants ──────────────────────────────────────────────────────────

const ARTIFACT_PATH = fileURLToPath(
  new URL('../reference/calibration-evidence.json', import.meta.url),
);

// ─── Fixture helpers (all records synthetic unless stated) ───────────────

function makeEvidence(overrides: Partial<CalibrationEvidence> = {}): CalibrationEvidence {
  return {
    kind: 'calibration-evidence',
    recordedAt: '2026-08-01T00:00:00.000Z',
    status: 'pending',
    summary: 'synthetic inline test fixture — NOT human evidence',
    raters: [],
    adjudication: null,
    ratings: [],
    adjudications: [],
    gold: null,
    ...overrides,
  };
}

function makeRating(
  field: string,
  raterId: string,
  score: number | null,
  extra: Partial<CalibrationRating> = {},
): CalibrationRating {
  return {
    field,
    raterId,
    source: 'synthetic',
    score,
    round: 0,
    perturbation: 'baseline',
    ...extra,
  };
}

function scoresFor(
  field: string,
  raterId: string,
  scores: number[],
  extra: Partial<CalibrationRating> = {},
): CalibrationRating[] {
  return scores.map((score) => makeRating(field, raterId, score, extra));
}

function makeAdjudication(
  field: string,
  verdict: CalibrationAdjudication['verdict'],
  expected: boolean,
  extra: Partial<CalibrationAdjudication> = {},
): CalibrationAdjudication {
  return {
    field,
    verdict,
    expected,
    adjudicatorId: 'synthetic-adjudicator',
    source: 'synthetic',
    ...extra,
  };
}

function requireMetric<T>(metric: T | undefined, field: string): T {
  expect(metric, `missing calibration metric for ${field}`).toBeDefined();
  if (metric === undefined) throw new Error(`Missing calibration metric for ${field}`);
  return metric;
}

// ─── Explicit thresholds are part of the contract ────────────────────────

describe('CALIBRATION_THRESHOLDS', () => {
  it('pins the explicit threshold values', () => {
    expect(CALIBRATION_THRESHOLDS).toEqual({
      minIndependentIdentifiedHumanRaters: 2,
      interRaterExactAgreement: 0.8,
      interRaterKappa: 0.6,
      adjudicatedPrecision: 0.8,
      adjudicatedRecall: 0.8,
      maxAbstentionRate: 0.1,
      repeatCallExactAgreement: 0.9,
      repeatCallRho: 0.8,
      maxPerturbationSensitivity: 0.1,
    });
  });
});

// ─── Metric arithmetic on synthetic records ──────────────────────────────

describe('inter-rater agreement arithmetic (synthetic)', () => {
  it('computes exact agreement, within-one and kappa per field', () => {
    const evidence = makeEvidence({
      ratings: [
        // F1: perfect agreement → exact 1, withinOne 1, kappa 1, ci95 [1,1]
        ...scoresFor('F1', 'rater-A', [0, 1, 2, 3]),
        ...scoresFor('F1', 'rater-B', [0, 1, 2, 3]),
        // F2: total disagreement on a 2-category scale → exact 0, withinOne 1, kappa 0
        ...scoresFor('F2', 'rater-A', [0, 0, 0]),
        ...scoresFor('F2', 'rater-B', [1, 1, 1]),
      ],
    });
    const report = buildCalibrationReport(evidence);

    const f1 = requireMetric(
      report.metrics.interRaterAgreement.perField.find((m) => m.field === 'F1'),
      'F1',
    );
    expect(f1.exactAgreement).toBe(1);
    expect(f1.withinOne).toBe(1);
    expect(f1.kappa).toBe(1);
    expect(f1.kappaCi95).toEqual([1, 1]); // every bootstrap resample is identical → deterministic
    expect(f1.status).toBe('pass');

    const f2 = requireMetric(
      report.metrics.interRaterAgreement.perField.find((m) => m.field === 'F2'),
      'F2',
    );
    expect(f2.exactAgreement).toBe(0);
    expect(f2.withinOne).toBe(1);
    expect(f2.kappa).toBe(0);
    expect(f2.status).toBe('fail');

    expect(report.metrics.interRaterAgreement.overall.exactAgreement).toBeCloseTo(0.5, 10);
    expect(report.metrics.interRaterAgreement.overall.kappa).toBeCloseTo(0.5, 10);
  });

  it('reports n/a when no paired raters exist', () => {
    const report = buildCalibrationReport(
      makeEvidence({ ratings: scoresFor('F1', 'rater-A', [0, 1]) }),
    );
    const f1 = requireMetric(
      report.metrics.interRaterAgreement.perField.find((m) => m.field === 'F1'),
      'F1',
    );
    expect(f1.status).toBe('n/a');
    expect(f1.exactAgreement).toBeNull();
    expect(report.metrics.interRaterAgreement.overall.exactAgreement).toBeNull();
  });
});

describe('adjudicated precision/recall arithmetic (synthetic)', () => {
  it('computes tp/fp/fn, precision, recall and f1 per field', () => {
    const evidence = makeEvidence({
      adjudications: [
        // F3: 2 correct + 1 incorrect, all expected → precision 2/3, recall 2/3, f1 2/3
        makeAdjudication('F3', 'correct', true),
        makeAdjudication('F3', 'correct', true),
        makeAdjudication('F3', 'incorrect', true),
        // F4: all correct → 1 / 1 / 1
        makeAdjudication('F4', 'correct', true),
        makeAdjudication('F4', 'correct', true),
        makeAdjudication('F4', 'correct', true),
        // F5: unresolved expected verdict counts as a recall miss
        makeAdjudication('F5', 'correct', true),
        makeAdjudication('F5', 'unresolved', true),
        // F6: nothing expected → recall undefined → fails closed
        makeAdjudication('F6', 'incorrect', false),
        makeAdjudication('F6', 'correct', false),
      ],
    });
    const report = buildCalibrationReport(evidence);
    const byField = new Map(
      report.metrics.adjudicatedPrecisionRecall.perField.map((m) => [m.field, m]),
    );

    const f3 = requireMetric(byField.get('F3'), 'F3');
    expect(f3).toMatchObject({ tp: 2, fp: 1, fn: 1, expected: 3 });
    expect(f3.precision).toBeCloseTo(2 / 3, 10);
    expect(f3.recall).toBeCloseTo(2 / 3, 10);
    expect(f3.f1).toBeCloseTo(2 / 3, 10);
    expect(f3.status).toBe('fail');

    const f4 = requireMetric(byField.get('F4'), 'F4');
    expect(f4).toMatchObject({ tp: 3, fp: 0, fn: 0, expected: 3 });
    expect(f4.precision).toBe(1);
    expect(f4.recall).toBe(1);
    expect(f4.f1).toBe(1);
    expect(f4.status).toBe('pass');

    const f5 = requireMetric(byField.get('F5'), 'F5');
    expect(f5).toMatchObject({ tp: 1, fp: 0, fn: 1, expected: 2 });
    expect(f5.precision).toBe(1);
    expect(f5.recall).toBeCloseTo(0.5, 10);

    const f6 = requireMetric(byField.get('F6'), 'F6');
    expect(f6).toMatchObject({ tp: 1, fp: 1, expected: 0 });
    expect(f6.precision).toBeCloseTo(0.5, 10);
    expect(f6.recall).toBeNull();
    expect(f6.status).toBe('fail');

    // Pooled overall: tp 7, fp 2, expected 8 → precision 7/9, recall 7/8, f1 14/17
    const overall = report.metrics.adjudicatedPrecisionRecall.overall;
    expect(overall.precision).toBeCloseTo(7 / 9, 10);
    expect(overall.recall).toBeCloseTo(7 / 8, 10);
    expect(overall.f1).toBeCloseTo(14 / 17, 10);
  });
});

describe('abstention rate arithmetic (synthetic)', () => {
  it('computes the null-score share per field and overall', () => {
    const evidence = makeEvidence({
      ratings: [
        makeRating('F7', 'rater-A', 1),
        makeRating('F7', 'rater-A', null),
        makeRating('F7', 'rater-B', 2),
        makeRating('F7', 'rater-B', null),
        makeRating('F8', 'rater-A', 0),
        makeRating('F8', 'rater-A', 1),
        makeRating('F8', 'rater-B', 1),
      ],
    });
    const report = buildCalibrationReport(evidence);
    const byField = new Map(report.metrics.abstention.perField.map((m) => [m.field, m]));

    expect(byField.get('F7')).toMatchObject({
      rated: 4,
      abstained: 2,
      abstentionRate: 0.5,
      status: 'fail',
    });
    expect(byField.get('F8')).toMatchObject({
      rated: 3,
      abstained: 0,
      abstentionRate: 0,
      status: 'pass',
    });
    expect(report.metrics.abstention.overall).toBeCloseTo(2 / 7, 10);
  });
});

describe('repeat-call stability arithmetic (synthetic)', () => {
  it('computes exact agreement and Spearman rho between rounds', () => {
    const evidence = makeEvidence({
      ratings: [
        ...scoresFor('F9', 'rater-A', [1, 2, 3], { round: 0 }),
        ...scoresFor('F9', 'rater-A', [1, 2, 3], { round: 1 }),
        ...scoresFor('F10', 'rater-B', [0, 1, 2], { round: 0 }),
        ...scoresFor('F10', 'rater-B', [2, 1, 0], { round: 1 }),
      ],
    });
    const report = buildCalibrationReport(evidence);
    const byField = new Map(report.metrics.repeatCallStability.perField.map((m) => [m.field, m]));

    const f9 = requireMetric(byField.get('F9'), 'F9');
    expect(f9.exactAgreement).toBe(1);
    expect(f9.rho).toBe(1);
    expect(f9.status).toBe('pass');

    const f10 = requireMetric(byField.get('F10'), 'F10');
    expect(f10.exactAgreement).toBeCloseTo(1 / 3, 10);
    expect(f10.rho).toBe(-1);
    expect(f10.status).toBe('fail');

    expect(report.metrics.repeatCallStability.overall.exactAgreement).toBeCloseTo(2 / 3, 10);
    expect(report.metrics.repeatCallStability.overall.rho).toBeCloseTo(0, 10);
  });

  it('treats constant scores (undefined rho) as stable when exact agreement is perfect', () => {
    const evidence = makeEvidence({
      ratings: [
        ...scoresFor('F9', 'rater-A', [2, 2, 2], { round: 0 }),
        ...scoresFor('F9', 'rater-A', [2, 2, 2], { round: 1 }),
      ],
    });
    const report = buildCalibrationReport(evidence);
    const f9 = requireMetric(
      report.metrics.repeatCallStability.perField.find((m) => m.field === 'F9'),
      'F9',
    );
    expect(f9.exactAgreement).toBe(1);
    expect(f9.rho).toBeNull();
    expect(f9.status).toBe('pass');
  });
});

describe('perturbation sensitivity arithmetic (synthetic)', () => {
  it('computes sensitivity = 1 - agreement for order and length variants', () => {
    const evidence = makeEvidence({
      ratings: [
        // F11: order-perturbed identical → sensitivity 0 (pass)
        ...scoresFor('F11', 'rater-A', [1, 1, 1], { perturbation: 'baseline' }),
        ...scoresFor('F11', 'rater-A', [1, 1, 1], { perturbation: 'order' }),
        // F12: order-perturbed reversed → sensitivity 1 (fail)
        ...scoresFor('F12', 'rater-A', [1, 2], { perturbation: 'baseline' }),
        ...scoresFor('F12', 'rater-A', [2, 1], { perturbation: 'order' }),
        // F13: length-perturbed identical → sensitivity 0 (pass)
        ...scoresFor('F13', 'rater-A', [0, 1, 2], { perturbation: 'baseline' }),
        ...scoresFor('F13', 'rater-A', [0, 1, 2], { perturbation: 'length' }),
        // F14: length-perturbed half agree → sensitivity 0.5 (fail)
        ...scoresFor('F14', 'rater-A', [0, 1], { perturbation: 'baseline' }),
        ...scoresFor('F14', 'rater-A', [1, 1], { perturbation: 'length' }),
      ],
    });
    const report = buildCalibrationReport(evidence);
    const order = report.metrics.orderPerturbationSensitivity.perField;
    const length = report.metrics.lengthPerturbationSensitivity.perField;

    expect(order.find((m) => m.field === 'F11')).toMatchObject({
      agreement: 1,
      sensitivity: 0,
      status: 'pass',
    });
    expect(order.find((m) => m.field === 'F12')).toMatchObject({
      agreement: 0,
      sensitivity: 1,
      status: 'fail',
    });
    expect(length.find((m) => m.field === 'F13')).toMatchObject({
      agreement: 1,
      sensitivity: 0,
      status: 'pass',
    });
    expect(length.find((m) => m.field === 'F14')).toMatchObject({
      agreement: 0.5,
      sensitivity: 0.5,
      status: 'fail',
    });

    expect(report.metrics.orderPerturbationSensitivity.overall).toBeCloseTo(0.5, 10);
    expect(report.metrics.lengthPerturbationSensitivity.overall).toBeCloseTo(0.25, 10);
  });
});

// ─── The gate: synthetic perfection still fails closed ───────────────────

describe('gate: synthetic records cannot pass as human calibration', () => {
  it('yields calibrated:false with missing-human-evidence reasons even when every metric passes', () => {
    const evidence = makeEvidence({
      ratings: [
        // Field P1 — every metric family computes and passes, but all records are synthetic.
        ...scoresFor('P1', 'rater-A', [0, 1, 2]),
        ...scoresFor('P1', 'rater-B', [0, 1, 2]),
        ...scoresFor('P1', 'rater-A', [0, 1, 2], { round: 1 }),
        ...scoresFor('P1', 'rater-B', [0, 1, 2], { round: 1 }),
        ...scoresFor('P1', 'rater-A', [0, 1, 2], { perturbation: 'order' }),
        ...scoresFor('P1', 'rater-B', [0, 1, 2], { perturbation: 'order' }),
        ...scoresFor('P1', 'rater-A', [0, 1, 2], { perturbation: 'length' }),
        ...scoresFor('P1', 'rater-B', [0, 1, 2], { perturbation: 'length' }),
      ],
      adjudications: [
        makeAdjudication('P1', 'correct', true),
        makeAdjudication('P1', 'correct', true),
      ],
    });
    const report = buildCalibrationReport(evidence);

    // Metric arithmetic is computed and passes…
    expect(report.metrics.interRaterAgreement.perField[0].status).toBe('pass');
    expect(report.metrics.adjudicatedPrecisionRecall.perField[0].status).toBe('pass');
    expect(report.metrics.abstention.perField[0].status).toBe('pass');
    expect(report.metrics.repeatCallStability.perField[0].status).toBe('pass');
    expect(report.metrics.orderPerturbationSensitivity.perField[0].status).toBe('pass');
    expect(report.metrics.lengthPerturbationSensitivity.perField[0].status).toBe('pass');
    expect(report.gating.thresholdFailures).toEqual([]);

    // …but the human-evidence gate still fails closed.
    expect(report.gating.calibrated).toBe(false);
    expect(report.evidence.kind).toBe('synthetic');
    expect(report.evidence.status).toBe('pending');
    expect(report.evidence.syntheticLabel).toContain('NON-EMPIRICAL');
    expect(report.gating.missingHumanEvidence.length).toBe(2);
    expect(report.gating.missingHumanEvidence[0]).toContain(
      'need at least 2 independent identified human raters with ratings; found 0',
    );
    expect(report.gating.missingHumanEvidence[1]).toContain('no adjudication record');
    expect(report.gating.reasons.every((r) => r.startsWith('missing-human-evidence:'))).toBe(true);
    // Quality self-assessment must never surface as blocking empirical evidence.
    expect(report.gating.blockingEmpiricalEvidence).toBe(false);
  });
});

// ─── Committed artifact: honest pending state ────────────────────────────

describe('committed evidence artifact', () => {
  it('loads and records the pending state honestly', () => {
    const evidence = loadCalibrationEvidence(ARTIFACT_PATH);
    expect(evidence.kind).toBe('calibration-evidence');
    expect(evidence.status).toBe('pending');
    expect(evidence.raters).toEqual([]);
    expect(evidence.adjudication).toBeNull();
    expect(evidence.ratings).toEqual([]);
    expect(evidence.adjudications).toEqual([]);
    expect(evidence.gold).toBeNull();
    // The artifact must state why it is pending, not paper over it.
    expect(evidence.summary).toMatch(/no two independent/i);
  });

  it('yields calibrated:false with explicit missing-human-evidence reasons', () => {
    const report = buildCalibrationReport(loadCalibrationEvidence(ARTIFACT_PATH), ARTIFACT_PATH);

    expect(report.kind).toBe('calibration-report');
    expect(report.source.evidencePath).toBe(ARTIFACT_PATH);
    expect(report.source.evidenceStatus).toBe('pending');
    expect(report.evidence.kind).toBe('none');
    expect(report.evidence.status).toBe('pending');
    expect(report.evidence.syntheticLabel).toBeNull();

    expect(report.gating.calibrated).toBe(false);
    expect(report.gating.blockingEmpiricalEvidence).toBe(false);
    expect(report.gating.blockingEvidenceReason).toContain('measurement-calibration only');
    // Explicit missing-human-evidence reasons.
    const missing = report.gating.missingHumanEvidence;
    expect(
      missing.some((r) =>
        r.includes('need at least 2 independent identified human raters with ratings; found 0'),
      ),
    ).toBe(true);
    expect(missing.some((r) => r.includes('no adjudication record'))).toBe(true);

    // Every planned metric is represented in the report and marked n/a,
    // with an explicit missing-evidence reason for each family.
    expect(report.metrics.interRaterAgreement.perField).toEqual([]);
    expect(report.metrics.adjudicatedPrecisionRecall.perField).toEqual([]);
    expect(report.metrics.abstention.perField).toEqual([]);
    expect(report.metrics.repeatCallStability.perField).toEqual([]);
    expect(report.metrics.orderPerturbationSensitivity.perField).toEqual([]);
    expect(report.metrics.lengthPerturbationSensitivity.perField).toEqual([]);
    expect(report.metrics.interRaterAgreement.overall.exactAgreement).toBeNull();
    expect(report.metrics.adjudicatedPrecisionRecall.overall.precision).toBeNull();
    expect(report.metrics.abstention.overall).toBeNull();
    expect(report.metrics.repeatCallStability.overall.exactAgreement).toBeNull();
    expect(report.metrics.orderPerturbationSensitivity.overall).toBeNull();
    expect(report.metrics.lengthPerturbationSensitivity.overall).toBeNull();

    for (const reason of [
      'no paired baseline ratings for inter-rater agreement',
      'no adjudication verdicts for precision/recall',
      'no baseline ratings for abstention rate',
      'no repeat-call rounds for stability',
      'no order-perturbed ratings',
      'no length-perturbed ratings',
    ]) {
      expect(report.gating.reasons.some((r) => r.includes(reason))).toBe(true);
    }

    // Thresholds travel with the report.
    expect(report.thresholds.minIndependentIdentifiedHumanRaters).toBe(2);
  });
});
// ─── The human path: two raters + adjudication open the gate ─────────────

describe('gate: human evidence path (fixture records, not real data)', () => {
  it('yields calibrated:true when two independent identified human raters plus human adjudication are supplied', () => {
    // Fixture simulating the genuine-human path so the gate logic is proven
    // both ways. These are test records, not committed empirical evidence:
    // real evidence must arrive via the committed artifact.
    const evidence = makeEvidence({
      status: 'sufficient',
      summary: 'fixture simulating the human path — NOT real empirical data',
      raters: [
        { id: 'fixture-human-rater-A', independent: true, identified: true },
        { id: 'fixture-human-rater-B', independent: true, identified: true },
      ],
      adjudication: { adjudicatorId: 'fixture-human-adjudicator', human: true },
      ratings: [
        // scene: perfect agreement, stable repeats, zero perturbation sensitivity
        ...scoresFor('scene', 'fixture-human-rater-A', [1, 2, 3], { source: 'human', round: 0 }),
        ...scoresFor('scene', 'fixture-human-rater-B', [1, 2, 3], { source: 'human', round: 0 }),
        ...scoresFor('scene', 'fixture-human-rater-A', [1, 2, 3], { source: 'human', round: 1 }),
        ...scoresFor('scene', 'fixture-human-rater-B', [1, 2, 3], { source: 'human', round: 1 }),
        ...scoresFor('scene', 'fixture-human-rater-A', [1, 2, 3], {
          source: 'human',
          perturbation: 'order',
        }),
        ...scoresFor('scene', 'fixture-human-rater-B', [1, 2, 3], {
          source: 'human',
          perturbation: 'order',
        }),
        ...scoresFor('scene', 'fixture-human-rater-A', [1, 2, 3], {
          source: 'human',
          perturbation: 'length',
        }),
        ...scoresFor('scene', 'fixture-human-rater-B', [1, 2, 3], {
          source: 'human',
          perturbation: 'length',
        }),
        // dialog: constant scores — rho undefined, exact agreement perfect
        ...scoresFor('dialog', 'fixture-human-rater-A', [2, 2, 2], { source: 'human', round: 0 }),
        ...scoresFor('dialog', 'fixture-human-rater-B', [2, 2, 2], { source: 'human', round: 0 }),
        ...scoresFor('dialog', 'fixture-human-rater-A', [2, 2, 2], { source: 'human', round: 1 }),
        ...scoresFor('dialog', 'fixture-human-rater-B', [2, 2, 2], { source: 'human', round: 1 }),
        ...scoresFor('dialog', 'fixture-human-rater-A', [2, 2, 2], {
          source: 'human',
          perturbation: 'order',
        }),
        ...scoresFor('dialog', 'fixture-human-rater-B', [2, 2, 2], {
          source: 'human',
          perturbation: 'order',
        }),
        ...scoresFor('dialog', 'fixture-human-rater-A', [2, 2, 2], {
          source: 'human',
          perturbation: 'length',
        }),
        ...scoresFor('dialog', 'fixture-human-rater-B', [2, 2, 2], {
          source: 'human',
          perturbation: 'length',
        }),
      ],
      adjudications: [
        makeAdjudication('scene', 'correct', true, {
          adjudicatorId: 'fixture-human-adjudicator',
          source: 'human',
        }),
        makeAdjudication('scene', 'correct', true, {
          adjudicatorId: 'fixture-human-adjudicator',
          source: 'human',
        }),
        makeAdjudication('scene', 'correct', true, {
          adjudicatorId: 'fixture-human-adjudicator',
          source: 'human',
        }),
        makeAdjudication('dialog', 'correct', true, {
          adjudicatorId: 'fixture-human-adjudicator',
          source: 'human',
        }),
        makeAdjudication('dialog', 'correct', true, {
          adjudicatorId: 'fixture-human-adjudicator',
          source: 'human',
        }),
        makeAdjudication('dialog', 'correct', true, {
          adjudicatorId: 'fixture-human-adjudicator',
          source: 'human',
        }),
      ],
      gold: { fields: ['scene', 'dialog'], source: 'human' },
    });
    const report = buildCalibrationReport(evidence);

    expect(report.evidence.kind).toBe('human');
    expect(report.evidence.humanRaters.map((r) => r.id)).toEqual([
      'fixture-human-rater-A',
      'fixture-human-rater-B',
    ]);
    expect(report.evidence.adjudicationPresent).toBe(true);
    expect(report.evidence.adjudicationHuman).toBe(true);
    expect(report.gating.missingHumanEvidence).toEqual([]);
    expect(report.gating.thresholdFailures).toEqual([]);
    expect(report.gating.calibrated).toBe(true);
    expect(report.gating.reasons).toEqual([]);
    expect(report.evidence.status).toBe('calibrated');
    expect(report.gating.blockingEmpiricalEvidence).toBe(true);
  });

  it('fails when a rater is not both independent and identified', () => {
    const evidence = makeEvidence({
      raters: [
        { id: 'fixture-human-rater-A', independent: true, identified: true },
        { id: 'fixture-human-rater-B', independent: false, identified: true },
      ],
      adjudication: { adjudicatorId: 'fixture-human-adjudicator', human: true },
      ratings: [
        ...scoresFor('scene', 'fixture-human-rater-A', [1, 2, 3], { source: 'human' }),
        ...scoresFor('scene', 'fixture-human-rater-B', [1, 2, 3], { source: 'human' }),
      ],
      adjudications: [makeAdjudication('scene', 'correct', true, { source: 'human' })],
    });
    const report = buildCalibrationReport(evidence);
    expect(report.gating.calibrated).toBe(false);
    expect(report.gating.missingHumanEvidence.some((r) => r.includes('found 1 qualifying'))).toBe(
      true,
    );
  });

  it('fails when adjudication is declared human but no human verdicts are recorded', () => {
    const evidence = makeEvidence({
      raters: [
        { id: 'fixture-human-rater-A', independent: true, identified: true },
        { id: 'fixture-human-rater-B', independent: true, identified: true },
      ],
      adjudication: { adjudicatorId: 'fixture-human-adjudicator', human: true },
      ratings: [
        ...scoresFor('scene', 'fixture-human-rater-A', [1, 2, 3], { source: 'human' }),
        ...scoresFor('scene', 'fixture-human-rater-B', [1, 2, 3], { source: 'human' }),
      ],
      adjudications: [],
    });
    const report = buildCalibrationReport(evidence);
    expect(report.gating.calibrated).toBe(false);
    expect(
      report.gating.missingHumanEvidence.some((r) =>
        r.includes('adjudication declared human but no human adjudication verdicts recorded'),
      ),
    ).toBe(true);
  });
});

// ─── Loader fails closed on malformed evidence ───────────────────────────

describe('loadCalibrationEvidence validation', () => {
  it('rejects malformed evidence objects with precise messages', () => {
    expect(() => assertCalibrationEvidence({})).toThrow(CalibrationEvidenceError);
    expect(() =>
      assertCalibrationEvidence(
        makeEvidence({
          ratings: [makeRating('F1', 'rater-A', -1)],
        }),
      ),
    ).toThrow(/ratings\[0\]\.score/);
    expect(() =>
      assertCalibrationEvidence(
        makeEvidence({
          ratings: [makeRating('F1', 'rater-A', 1, { source: 'model' as never })],
        }),
      ),
    ).toThrow(/ratings\[0\]\.source/);
  });

  it('rejects unreadable or invalid-JSON artifacts', () => {
    expect(() => loadCalibrationEvidence('/nonexistent/calibration-evidence.json')).toThrow(
      /cannot read calibration evidence/,
    );

    const dir = mkdtempSync(join(tmpdir(), 'calibration-evidence-'));
    try {
      const badJson = join(dir, 'bad.json');
      writeFileSync(badJson, '{ not json');
      expect(() => loadCalibrationEvidence(badJson)).toThrow(/not valid JSON/);

      const badShape = join(dir, 'bad-shape.json');
      writeFileSync(badShape, JSON.stringify({ kind: 'wrong' }));
      expect(() => loadCalibrationEvidence(badShape)).toThrow(
        /kind must be "calibration-evidence"/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
