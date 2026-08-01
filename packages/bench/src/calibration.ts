// ============================================================================
// Measurement Calibration — per-field calibration evidence loader and report
// builder (bench-only).
//
// Computes an honest, machine-readable calibration report from committed
// evidence records and reuses the agreement functions in annotation-stats.ts
// (agreementStats / quadraticWeightedKappa / spearmanTestRetestRho) where
// semantically applicable. Consistency metrics (N-CED / S-CED) are not
// semantically applicable here: calibration measures the measurement
// instrument, not issue density in prose.
//
// Planned metrics (one per family, per field, plus overall):
//   - inter-rater agreement            (exact agreement, within-one, kappa)
//   - adjudicated precision/recall     (tp/fp/fn against adjudicated gold)
//   - abstention rate                  (null scores over baseline ratings)
//   - repeat-call stability            (round 0 vs round 1, same rater)
//   - order perturbation sensitivity   (baseline vs order-perturbed, 1-agreement)
//   - length perturbation sensitivity  (baseline vs length-perturbed, 1-agreement)
//
// Fail-closed contract:
//   - `gating.calibrated` is true ONLY when at least two genuine, independent,
//     identified human raters plus a human adjudication record are present,
//     every planned metric is computable, and every metric meets its explicit
//     threshold (see CALIBRATION_THRESHOLDS).
//   - Synthetic/mock records can NEVER satisfy the human-evidence gate. They
//     may only exercise metric arithmetic and are unmistakably labeled
//     non-empirical in the report (`evidence.syntheticLabel`).
//   - The report cannot be represented as blocking empirical evidence for
//     quality claims: `scope` fixes the report kind to measurement
//     calibration, and `gating.blockingEmpiricalEvidence` fails closed.
// ============================================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  agreementStats,
  quadraticWeightedKappa,
  spearmanTestRetestRho,
} from './annotation-stats.js';

// ─── Types: committed evidence input ──────────────────────────────────────

/** Provenance of a record: genuine human annotation or non-empirical synthetic data. */
export type CalibrationSource = 'human' | 'synthetic';

/** Declaration of a human rater's identity and independence. */
export interface CalibrationRater {
  id: string;
  /** True when the rater annotated without seeing the other rater's work. */
  independent: boolean;
  /** True when the rater is identified (named/verifiable person), not anonymous. */
  identified: boolean;
}

/**
 * One per-field measurement rating.
 * `score` is an ordinal category in [0, numCategories-1], or null when the
 * rater abstained on this field. `round` 0/1 is the first / repeat call of
 * the same measurement (repeat-call stability). `perturbation` marks the
 * presentation variant used for sensitivity analysis.
 */
export interface CalibrationRating {
  field: string;
  raterId: string;
  source: CalibrationSource;
  score: number | null;
  round: 0 | 1;
  perturbation: 'baseline' | 'order' | 'length';
  note?: string;
}

/**
 * One adjudicated verdict over a measured field occurrence.
 * `expected` is true when this field occurrence belongs to the gold set for
 * the session; it contributes to the recall denominator. `unresolved` verdicts
 * count toward neither precision numerator nor denominator but, when expected,
 * still count as not-correctly-measured for recall.
 */
export interface CalibrationAdjudication {
  field: string;
  verdict: 'correct' | 'incorrect' | 'unresolved';
  expected: boolean;
  adjudicatorId: string;
  source: CalibrationSource;
  note?: string;
}

/** Gold standard: the fields that should have been measured in the session. */
export interface CalibrationGold {
  fields: string[];
  source: CalibrationSource;
  note?: string;
}

/** Committed calibration evidence document (see packages/bench/reference/calibration-evidence.json). */
export interface CalibrationEvidence {
  kind: 'calibration-evidence';
  recordedAt: string;
  status: 'pending' | 'sufficient' | 'insufficient';
  summary: string;
  raters: CalibrationRater[];
  adjudication: { adjudicatorId: string; human: boolean } | null;
  ratings: CalibrationRating[];
  adjudications: CalibrationAdjudication[];
  gold: CalibrationGold | null;
}

// ─── Explicit thresholds ──────────────────────────────────────────────────

export interface CalibrationThresholds {
  /** Minimum number of independent, identified human raters with ratings. */
  minIndependentIdentifiedHumanRaters: number;
  /** Per-field inter-rater exact agreement must be at least this. */
  interRaterExactAgreement: number;
  /** Per-field quadratic weighted kappa must be at least this. */
  interRaterKappa: number;
  /** Adjudicated precision must be at least this. */
  adjudicatedPrecision: number;
  /** Adjudicated recall must be at least this. */
  adjudicatedRecall: number;
  /** Abstention rate (null scores) must be at most this. */
  maxAbstentionRate: number;
  /** Repeat-call exact agreement must be at least this. */
  repeatCallExactAgreement: number;
  /** Repeat-call Spearman rho must be at least this. */
  repeatCallRho: number;
  /** Order/length perturbation sensitivity (1 - agreement) must be at most this. */
  maxPerturbationSensitivity: number;
}

export const CALIBRATION_THRESHOLDS: CalibrationThresholds = {
  minIndependentIdentifiedHumanRaters: 2,
  interRaterExactAgreement: 0.8,
  interRaterKappa: 0.6,
  adjudicatedPrecision: 0.8,
  adjudicatedRecall: 0.8,
  maxAbstentionRate: 0.1,
  repeatCallExactAgreement: 0.9,
  repeatCallRho: 0.8,
  maxPerturbationSensitivity: 0.1,
};

// ─── Types: computed report ───────────────────────────────────────────────

export type MetricStatus = 'pass' | 'fail' | 'n/a';

export interface InterRaterFieldMetric {
  field: string;
  pairs: Array<{ raterA: string; raterB: string; n: number }>;
  exactAgreement: number | null;
  withinOne: number | null;
  kappa: number | null;
  kappaCi95: [number, number] | null;
  n: number;
  status: MetricStatus;
}

export interface AdjudicatedFieldMetric {
  field: string;
  tp: number;
  fp: number;
  fn: number;
  expected: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  status: MetricStatus;
}

export interface AbstentionFieldMetric {
  field: string;
  rated: number;
  abstained: number;
  abstentionRate: number | null;
  status: MetricStatus;
}

export interface RepeatCallFieldMetric {
  field: string;
  pairs: Array<{ raterId: string; n: number }>;
  exactAgreement: number | null;
  rho: number | null;
  n: number;
  status: MetricStatus;
}

export interface PerturbationFieldMetric {
  kind: 'order' | 'length';
  field: string;
  pairs: Array<{ raterId: string; n: number }>;
  agreement: number | null;
  /** 1 - agreement; the reported sensitivity. */
  sensitivity: number | null;
  n: number;
  status: MetricStatus;
}

export interface CalibrationReport {
  kind: 'calibration-report';
  generatedAt: string;
  source: { evidencePath: string; recordedAt: string; evidenceStatus: string };
  scope: {
    kind: 'measurement-calibration';
    covers: string[];
    doesNotConstitute: string[];
  };
  evidence: {
    kind: 'human' | 'synthetic' | 'mixed' | 'none';
    status: 'calibrated' | 'pending' | 'insufficient';
    humanRaters: Array<{ id: string; independent: boolean; identified: boolean }>;
    adjudicationPresent: boolean;
    adjudicationHuman: boolean;
    syntheticLabel: string | null;
  };
  thresholds: CalibrationThresholds;
  metrics: {
    interRaterAgreement: {
      overall: { exactAgreement: number | null; kappa: number | null };
      perField: InterRaterFieldMetric[];
    };
    adjudicatedPrecisionRecall: {
      overall: { precision: number | null; recall: number | null; f1: number | null };
      perField: AdjudicatedFieldMetric[];
    };
    abstention: { overall: number | null; perField: AbstentionFieldMetric[] };
    repeatCallStability: {
      overall: { exactAgreement: number | null; rho: number | null };
      perField: RepeatCallFieldMetric[];
    };
    orderPerturbationSensitivity: { overall: number | null; perField: PerturbationFieldMetric[] };
    lengthPerturbationSensitivity: { overall: number | null; perField: PerturbationFieldMetric[] };
  };
  gating: {
    calibrated: boolean;
    reasons: string[];
    missingHumanEvidence: string[];
    thresholdFailures: string[];
    blockingEmpiricalEvidence: boolean;
    blockingEvidenceReason: string;
  };
}

// ─── Evidence loader ──────────────────────────────────────────────────────

/** Thrown when the committed calibration evidence violates its contract. */
export class CalibrationEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalibrationEvidenceError';
  }
}

/** Default committed evidence artifact, resolved relative to this module. */
export const DEFAULT_CALIBRATION_EVIDENCE_PATH = fileURLToPath(
  new URL('../reference/calibration-evidence.json', import.meta.url),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate an unknown value as CalibrationEvidence, fail closed with precise
 * messages on any contract violation.
 */
export function assertCalibrationEvidence(value: unknown): asserts value is CalibrationEvidence {
  const errors: string[] = [];
  if (!isRecord(value)) {
    throw new CalibrationEvidenceError('calibration evidence must be a JSON object');
  }
  if (value.kind !== 'calibration-evidence') errors.push('kind must be "calibration-evidence"');
  if (typeof value.recordedAt !== 'string') errors.push('recordedAt must be an ISO-8601 string');
  const status = value.status;
  if (status !== 'pending' && status !== 'sufficient' && status !== 'insufficient') {
    errors.push('status must be one of "pending" | "sufficient" | "insufficient"');
  }
  if (typeof value.summary !== 'string') errors.push('summary must be a string');

  if (!Array.isArray(value.raters)) {
    errors.push('raters must be an array');
  } else {
    value.raters.forEach((rater, i) => {
      if (!isRecord(rater)) {
        errors.push(`raters[${i}] must be an object`);
        return;
      }
      if (typeof rater.id !== 'string' || rater.id.length === 0)
        errors.push(`raters[${i}].id must be a non-empty string`);
      if (typeof rater.independent !== 'boolean')
        errors.push(`raters[${i}].independent must be a boolean`);
      if (typeof rater.identified !== 'boolean')
        errors.push(`raters[${i}].identified must be a boolean`);
    });
  }

  if (value.adjudication !== null) {
    if (!isRecord(value.adjudication)) {
      errors.push('adjudication must be null or an object');
    } else {
      if (typeof value.adjudication.adjudicatorId !== 'string') {
        errors.push('adjudication.adjudicatorId must be a string');
      }
      if (typeof value.adjudication.human !== 'boolean') {
        errors.push('adjudication.human must be a boolean');
      }
    }
  }

  if (!Array.isArray(value.ratings)) {
    errors.push('ratings must be an array');
  } else {
    value.ratings.forEach((rating, i) => {
      if (!isRecord(rating)) {
        errors.push(`ratings[${i}] must be an object`);
        return;
      }
      if (typeof rating.field !== 'string' || rating.field.length === 0)
        errors.push(`ratings[${i}].field must be a non-empty string`);
      if (typeof rating.raterId !== 'string' || rating.raterId.length === 0)
        errors.push(`ratings[${i}].raterId must be a non-empty string`);
      if (rating.source !== 'human' && rating.source !== 'synthetic')
        errors.push(`ratings[${i}].source must be "human" | "synthetic"`);
      if (
        rating.score !== null &&
        (!Number.isInteger(rating.score) || (rating.score as number) < 0)
      ) {
        errors.push(`ratings[${i}].score must be a non-negative integer or null (abstention)`);
      }
      if (rating.round !== 0 && rating.round !== 1)
        errors.push(`ratings[${i}].round must be 0 | 1`);
      const pert = rating.perturbation;
      if (pert !== 'baseline' && pert !== 'order' && pert !== 'length') {
        errors.push(`ratings[${i}].perturbation must be "baseline" | "order" | "length"`);
      }
    });
  }

  if (!Array.isArray(value.adjudications)) {
    errors.push('adjudications must be an array');
  } else {
    value.adjudications.forEach((adj, i) => {
      if (!isRecord(adj)) {
        errors.push(`adjudications[${i}] must be an object`);
        return;
      }
      if (typeof adj.field !== 'string' || adj.field.length === 0)
        errors.push(`adjudications[${i}].field must be a non-empty string`);
      const verdict = adj.verdict;
      if (verdict !== 'correct' && verdict !== 'incorrect' && verdict !== 'unresolved') {
        errors.push(`adjudications[${i}].verdict must be "correct" | "incorrect" | "unresolved"`);
      }
      if (typeof adj.expected !== 'boolean')
        errors.push(`adjudications[${i}].expected must be a boolean`);
      if (typeof adj.adjudicatorId !== 'string')
        errors.push(`adjudications[${i}].adjudicatorId must be a string`);
      if (adj.source !== 'human' && adj.source !== 'synthetic')
        errors.push(`adjudications[${i}].source must be "human" | "synthetic"`);
    });
  }

  if (value.gold !== null) {
    if (!isRecord(value.gold)) {
      errors.push('gold must be null or an object');
    } else {
      if (
        !Array.isArray(value.gold.fields) ||
        value.gold.fields.some((f) => typeof f !== 'string')
      ) {
        errors.push('gold.fields must be an array of strings');
      }
      if (value.gold.source !== 'human' && value.gold.source !== 'synthetic') {
        errors.push('gold.source must be "human" | "synthetic"');
      }
    }
  }

  if (errors.length > 0) {
    throw new CalibrationEvidenceError(
      `calibration evidence contract violations:\n  - ${errors.join('\n  - ')}`,
    );
  }
}

/**
 * Load and validate the committed calibration evidence artifact.
 * Fails closed (CalibrationEvidenceError) on any contract violation.
 */
export function loadCalibrationEvidence(
  evidencePath: string = DEFAULT_CALIBRATION_EVIDENCE_PATH,
): CalibrationEvidence {
  let raw: string;
  try {
    raw = readFileSync(evidencePath, 'utf8');
  } catch (error) {
    throw new CalibrationEvidenceError(
      `cannot read calibration evidence at ${evidencePath}: ${(error as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CalibrationEvidenceError(
      `calibration evidence at ${evidencePath} is not valid JSON: ${(error as Error).message}`,
    );
  }
  assertCalibrationEvidence(parsed);
  return parsed;
}

// ─── Internal helpers ─────────────────────────────────────────────────────

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

/** Distinct fields referenced by ratings, in first-appearance order. */
function ratingFields(evidence: CalibrationEvidence): string[] {
  const fields = new Set<string>();
  for (const r of evidence.ratings) {
    fields.add(r.field);
  }
  return Array.from(fields);
}

/** Distinct fields referenced by adjudications, in first-appearance order. */
function adjudicationFields(evidence: CalibrationEvidence): string[] {
  const fields = new Set<string>();
  for (const a of evidence.adjudications) {
    fields.add(a.field);
  }
  return Array.from(fields);
}

/**
 * Baseline (round 0, unperturbed) non-null scores per rater, per field.
 * Positional alignment: both raters scored the same occurrence order.
 */
function baselineScoresByRater(
  evidence: CalibrationEvidence,
  field: string,
): Map<string, number[]> {
  const byRater = new Map<string, number[]>();
  for (const r of evidence.ratings) {
    if (r.field !== field || r.round !== 0 || r.perturbation !== 'baseline' || r.score === null) {
      continue;
    }
    const scores = byRater.get(r.raterId);
    if (scores) scores.push(r.score);
    else byRater.set(r.raterId, [r.score]);
  }
  return byRater;
}

/** Baseline round-0 non-null scores, grouped by round, per rater, per field. */
function repeatScoresByRater(
  evidence: CalibrationEvidence,
  field: string,
): Map<string, number[][]> {
  const byRater = new Map<string, number[][]>();
  for (const r of evidence.ratings) {
    if (r.field !== field || r.perturbation !== 'baseline' || r.score === null) continue;
    const rounds = byRater.get(r.raterId);
    if (rounds) rounds[r.round].push(r.score);
    else {
      const fresh: number[][] = [[], []];
      fresh[r.round].push(r.score);
      byRater.set(r.raterId, fresh);
    }
  }
  return byRater;
}

/** Baseline round-0 non-null scores per rater for one perturbation variant. */
function perturbedScoresByRater(
  evidence: CalibrationEvidence,
  field: string,
  kind: 'order' | 'length',
): Map<string, number[]> {
  const byRater = new Map<string, number[]>();
  for (const r of evidence.ratings) {
    if (r.field !== field || r.round !== 0 || r.perturbation !== kind || r.score === null) continue;
    const scores = byRater.get(r.raterId);
    if (scores) scores.push(r.score);
    else byRater.set(r.raterId, [r.score]);
  }
  return byRater;
}

// ─── Metric families ──────────────────────────────────────────────────────

function interRaterPerField(evidence: CalibrationEvidence, field: string): InterRaterFieldMetric {
  const byRater = baselineScoresByRater(evidence, field);
  const raters = Array.from(byRater.keys());
  const pairs: Array<{ raterA: string; raterB: string; n: number }> = [];
  const allA: number[] = [];
  const allB: number[] = [];
  let maxScore = 0;
  for (let i = 0; i < raters.length; i++) {
    for (let j = i + 1; j < raters.length; j++) {
      const raterA = raters[i];
      const raterB = raters[j];
      if (raterA === undefined || raterB === undefined) continue;
      const a = byRater.get(raterA);
      const b = byRater.get(raterB);
      if (!a || !b) continue;
      const n = Math.min(a.length, b.length);
      if (n === 0) continue;
      pairs.push({ raterA, raterB, n });
      for (let k = 0; k < n; k++) {
        allA.push(a[k]);
        allB.push(b[k]);
        maxScore = Math.max(maxScore, a[k], b[k]);
      }
    }
  }
  if (allA.length === 0) {
    return {
      field,
      pairs: [],
      exactAgreement: null,
      withinOne: null,
      kappa: null,
      kappaCi95: null,
      n: 0,
      status: 'n/a',
    };
  }
  // Kappa scale is inferred per field from the observed score range (min 2 categories).
  const numCategories = Math.max(maxScore + 1, 2);
  const ag = agreementStats(allA, allB);
  const k = quadraticWeightedKappa(allA, allB, numCategories);
  const pass =
    ag.exactAgreement >= CALIBRATION_THRESHOLDS.interRaterExactAgreement &&
    k.kappa >= CALIBRATION_THRESHOLDS.interRaterKappa;
  return {
    field,
    pairs,
    exactAgreement: ag.exactAgreement,
    withinOne: ag.withinOne,
    kappa: k.kappa,
    kappaCi95: k.ci95,
    n: allA.length,
    status: pass ? 'pass' : 'fail',
  };
}

function adjudicatedPerField(evidence: CalibrationEvidence, field: string): AdjudicatedFieldMetric {
  let tp = 0;
  let fp = 0;
  let expected = 0;
  for (const a of evidence.adjudications) {
    if (a.field !== field) continue;
    if (a.verdict === 'correct') tp++;
    else if (a.verdict === 'incorrect') fp++;
    if (a.expected) expected++;
  }
  // Expected occurrences whose verdict is not 'correct' (incorrect or
  // unresolved) were not correctly measured: they are the recall misses.
  const fn = expected - tp;
  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  const recall = expected > 0 ? tp / expected : null;
  const f1 =
    precision !== null && recall !== null && precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : null;
  let status: MetricStatus = 'n/a';
  if (evidence.adjudications.some((a) => a.field === field)) {
    status =
      precision !== null &&
      recall !== null &&
      precision >= CALIBRATION_THRESHOLDS.adjudicatedPrecision &&
      recall >= CALIBRATION_THRESHOLDS.adjudicatedRecall
        ? 'pass'
        : 'fail';
  }
  return { field, tp, fp, fn, expected, precision, recall, f1, status };
}

function abstentionPerField(evidence: CalibrationEvidence, field: string): AbstentionFieldMetric {
  const ratings = evidence.ratings.filter(
    (r) => r.field === field && r.round === 0 && r.perturbation === 'baseline',
  );
  const abstained = ratings.filter((r) => r.score === null).length;
  const rate = ratings.length > 0 ? abstained / ratings.length : null;
  let status: MetricStatus = 'n/a';
  if (rate !== null) {
    status = rate <= CALIBRATION_THRESHOLDS.maxAbstentionRate ? 'pass' : 'fail';
  }
  return { field, rated: ratings.length, abstained, abstentionRate: rate, status };
}

function repeatCallPerField(evidence: CalibrationEvidence, field: string): RepeatCallFieldMetric {
  const byRater = repeatScoresByRater(evidence, field);
  const pairs: Array<{ raterId: string; n: number }> = [];
  const exacts: number[] = [];
  const rhos: number[] = [];
  for (const [raterId, rounds] of byRater) {
    const n = Math.min(rounds[0].length, rounds[1].length);
    if (n === 0) continue;
    pairs.push({ raterId, n });
    exacts.push(agreementStats(rounds[0].slice(0, n), rounds[1].slice(0, n)).exactAgreement);
    const rho = spearmanTestRetestRho(rounds[0].slice(0, n), rounds[1].slice(0, n)).rho;
    if (Number.isFinite(rho)) rhos.push(rho);
  }
  const exactAgreement = mean(exacts);
  const rho = mean(rhos);
  if (pairs.length === 0) {
    return { field, pairs: [], exactAgreement: null, rho: null, n: 0, status: 'n/a' };
  }
  // rho is undefined (NaN) when scores are constant; perfect exact agreement
  // then already establishes stability, so only the agreement threshold gates.
  const rhoOk = rho === null ? exactAgreement === 1 : rho >= CALIBRATION_THRESHOLDS.repeatCallRho;
  const pass =
    exactAgreement !== null &&
    exactAgreement >= CALIBRATION_THRESHOLDS.repeatCallExactAgreement &&
    rhoOk;
  return {
    field,
    pairs,
    exactAgreement,
    rho,
    n: pairs.reduce((sum, p) => sum + p.n, 0),
    status: pass ? 'pass' : 'fail',
  };
}

function perturbationPerField(
  evidence: CalibrationEvidence,
  field: string,
  kind: 'order' | 'length',
): PerturbationFieldMetric {
  const baseline = baselineScoresByRater(evidence, field);
  const perturbed = perturbedScoresByRater(evidence, field, kind);
  const pairs: Array<{ raterId: string; n: number }> = [];
  const agreements: number[] = [];
  for (const [raterId, base] of baseline) {
    const pert = perturbed.get(raterId);
    if (!pert) continue;
    const n = Math.min(base.length, pert.length);
    if (n === 0) continue;
    pairs.push({ raterId, n });
    agreements.push(agreementStats(base.slice(0, n), pert.slice(0, n)).exactAgreement);
  }
  const agreement = mean(agreements);
  const sensitivity = agreement === null ? null : 1 - agreement;
  let status: MetricStatus = 'n/a';
  if (sensitivity !== null) {
    status = sensitivity <= CALIBRATION_THRESHOLDS.maxPerturbationSensitivity ? 'pass' : 'fail';
  }
  return {
    kind,
    field,
    pairs,
    agreement,
    sensitivity,
    n: pairs.reduce((sum, p) => sum + p.n, 0),
    status,
  };
}

// ─── Report builder ───────────────────────────────────────────────────────

/**
 * Build the per-field measurement calibration report from committed evidence.
 * Pure function over the evidence document: identical input yields identical
 * metric arithmetic (kappa confidence intervals excepted, which are
 * bootstrap-based and never gate the verdict).
 */
export function buildCalibrationReport(
  evidence: CalibrationEvidence,
  evidencePath: string = DEFAULT_CALIBRATION_EVIDENCE_PATH,
): CalibrationReport {
  const fields = ratingFields(evidence);
  const adjFields = adjudicationFields(evidence);
  const allFields = Array.from(new Set([...fields, ...adjFields]));

  // ── Metrics ─────────────────────────────────────────────────────────────
  const interRater = allFields.map((f) => interRaterPerField(evidence, f));
  const adjudicated = adjFields.map((f) => adjudicatedPerField(evidence, f));
  const abstention = fields.map((f) => abstentionPerField(evidence, f));
  const repeatCall = fields.map((f) => repeatCallPerField(evidence, f));
  const orderPert = fields.map((f) => perturbationPerField(evidence, f, 'order'));
  const lengthPert = fields.map((f) => perturbationPerField(evidence, f, 'length'));

  const overallInterRater = {
    exactAgreement: mean(
      interRater.map((m) => m.exactAgreement).filter((v): v is number => v !== null),
    ),
    kappa: mean(interRater.map((m) => m.kappa).filter((v): v is number => v !== null)),
  };
  const pooledAdj = adjudicated.reduce(
    (acc, m) => ({
      tp: acc.tp + m.tp,
      fp: acc.fp + m.fp,
      fn: acc.fn + m.fn,
      expected: acc.expected + m.expected,
    }),
    { tp: 0, fp: 0, fn: 0, expected: 0 },
  );
  const overallAdj = {
    precision:
      pooledAdj.tp + pooledAdj.fp > 0 ? pooledAdj.tp / (pooledAdj.tp + pooledAdj.fp) : null,
    recall: pooledAdj.expected > 0 ? pooledAdj.tp / pooledAdj.expected : null,
    f1:
      pooledAdj.tp + pooledAdj.fp > 0 && pooledAdj.expected > 0
        ? (2 * pooledAdj.tp) / (pooledAdj.tp + pooledAdj.fp + pooledAdj.expected)
        : null,
  };
  const overallAbstention = (() => {
    const rated = abstention.reduce((sum, m) => sum + m.rated, 0);
    const abstained = abstention.reduce((sum, m) => sum + m.abstained, 0);
    return rated > 0 ? abstained / rated : null;
  })();
  const overallRepeat = {
    exactAgreement: mean(
      repeatCall.map((m) => m.exactAgreement).filter((v): v is number => v !== null),
    ),
    rho: mean(repeatCall.map((m) => m.rho).filter((v): v is number => v !== null)),
  };
  const overallOrder = mean(
    orderPert.map((m) => m.sensitivity).filter((v): v is number => v !== null),
  );
  const overallLength = mean(
    lengthPert.map((m) => m.sensitivity).filter((v): v is number => v !== null),
  );

  // ── Evidence census ─────────────────────────────────────────────────────
  const humanRaterIds = Array.from(
    new Set(evidence.ratings.filter((r) => r.source === 'human').map((r) => r.raterId)),
  );
  const declared = new Map(evidence.raters.map((r) => [r.id, r]));
  const qualifyingHumanRaters = humanRaterIds.flatMap((id) => {
    const rater = declared.get(id);
    return rater?.independent && rater.identified ? [rater] : [];
  });
  const humanAdjudications = evidence.adjudications.filter((a) => a.source === 'human');

  // ── Gate: missing human evidence ────────────────────────────────────────
  const missingHumanEvidence: string[] = [];
  const required = CALIBRATION_THRESHOLDS.minIndependentIdentifiedHumanRaters;
  if (qualifyingHumanRaters.length < required) {
    missingHumanEvidence.push(
      `missing-human-evidence: need at least ${required} independent identified human raters with ratings; found ${qualifyingHumanRaters.length} qualifying (${humanRaterIds.length} distinct human rater id(s) in ratings)`,
    );
  }
  if (evidence.adjudication === null) {
    missingHumanEvidence.push(
      'missing-human-evidence: no adjudication record (adjudication is null)',
    );
  } else if (!evidence.adjudication.human) {
    missingHumanEvidence.push('missing-human-evidence: adjudication record exists but human=false');
  } else if (humanAdjudications.length === 0) {
    missingHumanEvidence.push(
      'missing-human-evidence: adjudication declared human but no human adjudication verdicts recorded',
    );
  }

  // ── Gate: planned metric coverage ───────────────────────────────────────
  const coverageMissing: string[] = [];
  if (interRater.every((m) => m.status === 'n/a')) {
    coverageMissing.push('missing-evidence: no paired baseline ratings for inter-rater agreement');
  }
  if (evidence.adjudications.length === 0) {
    coverageMissing.push('missing-evidence: no adjudication verdicts for precision/recall');
  }
  if (abstention.every((m) => m.status === 'n/a')) {
    coverageMissing.push('missing-evidence: no baseline ratings for abstention rate');
  }
  if (repeatCall.every((m) => m.status === 'n/a')) {
    coverageMissing.push('missing-evidence: no repeat-call rounds for stability');
  }
  if (orderPert.every((m) => m.status === 'n/a')) {
    coverageMissing.push(
      'missing-evidence: no order-perturbed ratings for order perturbation sensitivity',
    );
  }
  if (lengthPert.every((m) => m.status === 'n/a')) {
    coverageMissing.push(
      'missing-evidence: no length-perturbed ratings for length perturbation sensitivity',
    );
  }

  // ── Gate: threshold failures ────────────────────────────────────────────
  const thresholdFailures: string[] = [];
  for (const m of interRater) {
    if (m.status !== 'fail' || m.exactAgreement === null || m.kappa === null) continue;
    if (m.exactAgreement < CALIBRATION_THRESHOLDS.interRaterExactAgreement) {
      thresholdFailures.push(
        `threshold: field ${m.field}: inter-rater exactAgreement ${m.exactAgreement.toFixed(3)} < ${CALIBRATION_THRESHOLDS.interRaterExactAgreement}`,
      );
    }
    if (m.kappa < CALIBRATION_THRESHOLDS.interRaterKappa) {
      thresholdFailures.push(
        `threshold: field ${m.field}: inter-rater kappa ${m.kappa.toFixed(3)} < ${CALIBRATION_THRESHOLDS.interRaterKappa}`,
      );
    }
  }
  for (const m of adjudicated) {
    if (m.status !== 'fail' || m.precision === null || m.recall === null) continue;
    if (m.precision < CALIBRATION_THRESHOLDS.adjudicatedPrecision) {
      thresholdFailures.push(
        `threshold: field ${m.field}: adjudicated precision ${m.precision.toFixed(3)} < ${CALIBRATION_THRESHOLDS.adjudicatedPrecision}`,
      );
    }
    if (m.recall < CALIBRATION_THRESHOLDS.adjudicatedRecall) {
      thresholdFailures.push(
        `threshold: field ${m.field}: adjudicated recall ${m.recall.toFixed(3)} < ${CALIBRATION_THRESHOLDS.adjudicatedRecall}`,
      );
    }
  }
  for (const m of abstention) {
    if (m.status !== 'fail' || m.abstentionRate === null) continue;
    thresholdFailures.push(
      `threshold: field ${m.field}: abstentionRate ${m.abstentionRate.toFixed(3)} > ${CALIBRATION_THRESHOLDS.maxAbstentionRate}`,
    );
  }
  for (const m of repeatCall) {
    if (m.status !== 'fail' || m.exactAgreement === null) continue;
    if (m.exactAgreement < CALIBRATION_THRESHOLDS.repeatCallExactAgreement) {
      thresholdFailures.push(
        `threshold: field ${m.field}: repeat-call exactAgreement ${m.exactAgreement.toFixed(3)} < ${CALIBRATION_THRESHOLDS.repeatCallExactAgreement}`,
      );
    }
    if (m.rho !== null && m.rho < CALIBRATION_THRESHOLDS.repeatCallRho) {
      thresholdFailures.push(
        `threshold: field ${m.field}: repeat-call rho ${m.rho.toFixed(3)} < ${CALIBRATION_THRESHOLDS.repeatCallRho}`,
      );
    }
  }
  for (const m of [...orderPert, ...lengthPert]) {
    if (m.status !== 'fail' || m.sensitivity === null) continue;
    thresholdFailures.push(
      `threshold: field ${m.field}: ${m.kind}-perturbation sensitivity ${m.sensitivity.toFixed(3)} > ${CALIBRATION_THRESHOLDS.maxPerturbationSensitivity}`,
    );
  }

  // ── Evidence kind / status ──────────────────────────────────────────────
  const anyRecords =
    evidence.ratings.length > 0 || evidence.adjudications.length > 0 || evidence.gold !== null;
  const hasHuman =
    evidence.ratings.some((r) => r.source === 'human') ||
    evidence.adjudications.some((a) => a.source === 'human');
  const hasSynthetic =
    evidence.ratings.some((r) => r.source === 'synthetic') ||
    evidence.adjudications.some((a) => a.source === 'synthetic') ||
    evidence.gold?.source === 'synthetic';
  const evidenceKind: 'human' | 'synthetic' | 'mixed' | 'none' = !anyRecords
    ? 'none'
    : hasHuman && hasSynthetic
      ? 'mixed'
      : hasSynthetic
        ? 'synthetic'
        : 'human';
  const syntheticLabel = hasSynthetic
    ? 'NON-EMPIRICAL: synthetic records included — metric arithmetic only; these records cannot satisfy the human-evidence gate'
    : null;

  const calibrated =
    missingHumanEvidence.length === 0 &&
    coverageMissing.length === 0 &&
    thresholdFailures.length === 0;
  const evidenceStatus: 'calibrated' | 'pending' | 'insufficient' = calibrated
    ? 'calibrated'
    : missingHumanEvidence.length > 0
      ? 'pending'
      : 'insufficient';

  const blockingEmpiricalEvidence = calibrated && evidenceKind === 'human';
  const blockingEvidenceReason =
    'scope is measurement-calibration only: this report never constitutes empirical evidence of model or output quality, and cannot serve as release-gate blocking evidence; it becomes human-empirical ONLY with two independent identified human raters plus human adjudication, and even then only for measurement validity';

  return {
    kind: 'calibration-report',
    generatedAt: new Date().toISOString(),
    source: {
      evidencePath,
      recordedAt: evidence.recordedAt,
      evidenceStatus: evidence.status,
    },
    scope: {
      kind: 'measurement-calibration',
      covers: [
        'inter-rater agreement',
        'adjudicated precision/recall',
        'abstention rate',
        'repeat-call stability',
        'order perturbation sensitivity',
        'length perturbation sensitivity',
      ],
      doesNotConstitute: [
        'model or output quality evidence',
        'release-gate blocking evidence',
        'human review attestation of prose quality',
      ],
    },
    evidence: {
      kind: evidenceKind,
      status: evidenceStatus,
      humanRaters: qualifyingHumanRaters,
      adjudicationPresent: evidence.adjudication !== null,
      adjudicationHuman: evidence.adjudication?.human ?? false,
      syntheticLabel,
    },
    thresholds: CALIBRATION_THRESHOLDS,
    metrics: {
      interRaterAgreement: { overall: overallInterRater, perField: interRater },
      adjudicatedPrecisionRecall: { overall: overallAdj, perField: adjudicated },
      abstention: { overall: overallAbstention, perField: abstention },
      repeatCallStability: { overall: overallRepeat, perField: repeatCall },
      orderPerturbationSensitivity: { overall: overallOrder, perField: orderPert },
      lengthPerturbationSensitivity: { overall: overallLength, perField: lengthPert },
    },
    gating: {
      calibrated,
      reasons: [...missingHumanEvidence, ...coverageMissing, ...thresholdFailures],
      missingHumanEvidence,
      thresholdFailures,
      blockingEmpiricalEvidence,
      blockingEvidenceReason,
    },
  };
}
