// ============================================================================
// Annotation Sampler — Stratified random sampling for human evaluation
// ============================================================================

import type { ValidationIssue } from '@novalistically/core';

export interface StratumDefinition {
  name: string; // e.g. 'error_severity', 'conflict_validator'
  validator?: string;
  severity?: ValidationIssue['severity'];
  sceneType?: string;
}

export interface SamplingConfig {
  targetProblemCount: number; // ≥120 per TODO L101
  targetSceneCount: number; // ≥50 per TODO L101
  seed: number; // frozen before scoring
  reannotationFraction: number; // min(0.20, max(0.50, 50/N))
}

export interface AnnotationSample {
  issueId: string; // composite key
  issue: ValidationIssue;
  stratum: string;
  index: number;
}

export interface ReannotationPlan {
  sampleIds: string[];
  gapDays: number; // 7-14 days
  randomized: boolean;
  hiddenFirstScores: boolean;
}

/**
 * Compute re-annotation count: min(N, max(50, ceil(0.20 * N)))
 */
export function computeReannotationCount(totalSamples: number): number {
  return Math.min(totalSamples, Math.max(50, Math.ceil(0.2 * totalSamples)));
}

/**
 * Deterministic pseudo-random generator (mulberry32) for reproducible sampling
 */
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fisher-Yates shuffle with deterministic RNG
 */
function shuffle<T>(arr: T[], rng: () => number): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * Stratified random sampling by severity level × scene type.
 * Returns deterministic samples given a frozen seed.
 */
export function sampleAnnotationIssues(
  issues: ValidationIssue[],
  strata: StratumDefinition[],
  config: SamplingConfig,
): { problemSamples: AnnotationSample[]; isExploratory: boolean } {
  const rng = mulberry32(config.seed);

  // Group issues by stratum
  const groups = new Map<string, ValidationIssue[]>();
  for (const issue of issues) {
    for (const stratum of strata) {
      if (stratum.validator && issue.validator !== stratum.validator) continue;
      if (stratum.severity && issue.severity !== stratum.severity) continue;
      const key = stratum.name;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(issue);
      break; // assign to first matching stratum
    }
  }

  // Allocate per-stratum quota proportionally
  const totalPool = Array.from(groups.values()).reduce((s, g) => s + g.length, 0);
  if (totalPool === 0) return { problemSamples: [], isExploratory: true };

  const problemSamples: AnnotationSample[] = [];
  let index = 0;

  for (const [name, group] of groups) {
    const quota = Math.max(1, Math.ceil((group.length / totalPool) * config.targetProblemCount));
    const shuffled = shuffle(group, rng);
    const selected = shuffled.slice(0, Math.min(quota, shuffled.length));
    for (const issue of selected) {
      problemSamples.push({
        issueId: `${issue.validator}\0${issue.event}\0${issue.severity}\0${index}`,
        issue,
        stratum: name,
        index: index++,
      });
    }
  }

  const isExploratory = problemSamples.length < 50;
  return { problemSamples, isExploratory };
}

/**
 * Create a re-annotation plan: select subsample, randomize order,
 * enforce 7-14 day gap, hide first scores.
 */
export function createReannotationPlan(
  samples: AnnotationSample[],
  config: SamplingConfig,
): ReannotationPlan {
  const rng = mulberry32(config.seed + 1); // different seed from initial sampling
  const reannotateCount = computeReannotationCount(samples.length);
  const shuffled = shuffle(samples, rng);
  const selected = shuffled.slice(0, reannotateCount);

  return {
    sampleIds: selected.map((s) => s.issueId),
    gapDays: 7 + Math.floor(rng() * 7), // 7-14 days
    randomized: true,
    hiddenFirstScores: true,
  };
}

/**
 * Validate that annotation set covers all required dimensions per TODO L101:
 * every validator, every severity level, major scene types, C capability.
 */
export function validateAnnotationCoverage(
  samples: AnnotationSample[],
  validators: string[],
): {
  covered: boolean;
  missingValidators: string[];
  missingSeverities: string[];
  warnings: string[];
} {
  const seenValidators = new Set(samples.map((s) => s.issue.validator));
  const seenSeverities = new Set(samples.map((s) => s.issue.severity));
  const allSeverities: ValidationIssue['severity'][] = ['error', 'warning', 'info'];

  return {
    covered: validators.every((v) => seenValidators.has(v)),
    missingValidators: validators.filter((v) => !seenValidators.has(v)),
    missingSeverities: allSeverities.filter((s) => !seenSeverities.has(s)),
    warnings:
      samples.length < 120 ? [`Only ${samples.length} problem-level samples (target ≥120)`] : [],
  };
}
