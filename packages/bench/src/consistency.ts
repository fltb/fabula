// ============================================================================
// Consistency Metrics — N-CED, S-CED, Pipeline F1, Spearman rank correlation
// ============================================================================

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ConsistencyReport {
  storyId: string;
  totalWords: number;
  errorsByCategory: Record<string, number>;
  severityBreakdown: { error: number; warning: number; info: number };
  perValidatorBreakdown: PerValidatorBreakdown[];
  nCED: number;
  nCEDcategory: Record<string, number>;
  severityLevelCED: SeverityLevelCED[];
  sCED: number;
  sCEDexperimental: true;
  percentileRank: number;
  rankDescription: string;
  pipelineF1?: { precision: number; recall: number; f1: number; baselineFP: number; injectionTP: number; injectionFN: number };
}

export interface PerValidatorBreakdown {
  validator: string;
  category: string;
  errors: number;
  warnings: number;
  infos: number;
  nCED: number;
}

export interface SeverityLevelCED {
  severity: 'error' | 'warning' | 'info';
  l1CED: number;
  l2CED: number;
}

// ─── Metric 1: N-CED (Novalistically Consistency Error Density) ────────────

/**
 * Compute N-CED: total issues per 10K words.
 * Higher values indicate a less consistent narrative.
 */
export function computeNCED(
  errors: number,
  warnings: number,
  infos: number,
  totalWords: number,
): number {
  const total = errors + warnings + infos;
  if (totalWords <= 0) return 0;
  return total / (totalWords / 10000);
}

// ─── Metric 2: S-CED (Severity-Weighted) — EXPERIMENTAL ────────────────────

const SEVERITY_WEIGHTS: Record<string, number> = {
  error: 1.0,
  warning: 0.3,
  info: 0.1,
};

const CATEGORY_COEFFICIENTS: Record<string, number> = {
  characterization: 1.3,
  timeline_plot: 1.2,
  worldbuilding: 1.0,
  factual_detail: 1.1,
  narrative_style: 0.8,
};

/**
 * Compute severity-weighted consistency error density.
 * Categories like characterization and timeline_plot are weighted higher.
 */
export function computeSCED(
  issues: Array<{ severity: 'error' | 'warning' | 'info'; category: string }>,
  totalWords: number,
): number {
  if (totalWords <= 0) return 0;
  const weighted = issues.reduce((sum, i) => {
    const sw = SEVERITY_WEIGHTS[i.severity] ?? 1.0;
    const cc = CATEGORY_COEFFICIENTS[i.category] ?? 1.0;
    return sum + sw * cc;
  }, 0);
  return weighted / (totalWords / 10000);
}

// ─── Metric 3: Pipeline F1 ─────────────────────────────────────────────────

/**
 * Compute precision, recall, and F1 for the validation pipeline.
 *
 * @param baselineFP    False positives on clean (baseline) passages.
 * @param injectionTP   True positives on error-injected passages.
 * @param injectionFN   False negatives on error-injected passages.
 * @param totalDetected Total issues detected (used for FP computation).
 */
export function computeF1(
  baselineFP: number,
  injectionTP: number,
  injectionFN: number,
  totalDetected: number,
): { precision: number; recall: number; f1: number; baselineFP: number; injectionTP: number; injectionFN: number } {
  const fp = totalDetected - injectionTP - baselineFP;
  const precision = injectionTP / (injectionTP + fp) || 0;
  const recall = injectionTP / (injectionTP + injectionFN) || 0;
  const f1 = 2 * (precision * recall) / (precision + recall) || 0;
  return { precision, recall, f1, baselineFP, injectionTP, injectionFN };
}

// ─── Metric 4: ECDF Percentile Rank ─────────────────────────────────────────

/**
 * Compute the percentile rank of a value within a reference corpus.
 * Returns a value in [0, 1] where 1.0 means the value is at or below
 * all corpus entries.
 */
export function computePercentileRank(value: number, corpus: number[]): number {
  if (corpus.length === 0) return 1.0;
  const count = corpus.filter((v) => v <= value).length;
  return count / corpus.length;
}

// ─── Metric 7: Spearman Rank Correlation (HANNA-compatible) ────────────────

/**
 * Compute Spearman's rank correlation coefficient between system
 * and human evaluation scores.
 */
export function computeSpearmanRho(systemScores: number[], humanScores: number[]): number {
  if (systemScores.length !== humanScores.length || systemScores.length < 2) return 0;

  // Rank transformation
  const rank = (arr: number[]): number[] => {
    const sorted = [...arr].map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const ranks = new Array(arr.length);
    for (let i = 0; i < sorted.length; i++) {
      ranks[sorted[i].i] = i + 1;
    }
    return ranks;
  };

  const sysRanks = rank(systemScores);
  const humRanks = rank(humanScores);
  const n = sysRanks.length;
  const d2 = sysRanks.reduce((sum, r, i) => sum + (r - humRanks[i]) ** 2, 0);
  return 1 - (6 * d2) / (n * (n * n - 1));
}

// ─── Disattenuation Correction ─────────────────────────────────────────────

/**
 * Correct observed correlation for measurement unreliability using ICC.
 */
export function disattenuateRho(observedRho: number, icc: number): number {
  if (icc <= 0 || icc > 1) return observedRho;
  return observedRho / Math.sqrt(icc);
}
