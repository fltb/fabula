// ============================================================================
// Annotation Statistics — Human Evaluation Agreement Metrics
//
// Implements all functions inline (no external stats library imports).
// Per TODO L81:
//   - Quadratic weighted Cohen's kappa with cluster bootstrap 95% CI
//   - Exact agreement / within-one-category agreement
//   - Grade distribution
//   - Transition matrix
//   - Spearman test-retest rho with midrank tie handling
// ============================================================================

// ─── Rank with midrank (average rank for tied values) ──────────────────────

/**
 * Compute midranks (average rank for tied values) for an array of numbers.
 * Ties receive the mean of the ranks they would occupy if untied.
 * Ranks are 1-based.
 *
 * @example
 * rankWithTies([3, 1, 2])       // [3, 1, 2]
 * rankWithTies([10, 10, 20])   // [1.5, 1.5, 3]
 */
export function rankWithTies(values: number[]): number[] {
  const n = values.length;
  if (n === 0) return [];

  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);

  const ranks = new Array<number>(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && indexed[j + 1].v === indexed[i].v) {
      j++;
    }
    // Average rank for this tie block (1-based)
    const midrank = (i + j + 2) / 2;
    for (let k = i; k <= j; k++) {
      ranks[indexed[k].i] = midrank;
    }
    i = j + 1;
  }
  return ranks;
}

// ─── Internal helpers for kappa computation ───────────────────────────────

/**
 * Create a k-by-k matrix of zeros.
 */
function createMatrix(k: number): number[][] {
  return Array.from({ length: k }, () => new Array<number>(k).fill(0));
}

/**
 * Compute the quadratic weight matrix w_ij = ((i - j) / (k - 1))^2.
 */
function createWeightMatrix(k: number): number[][] {
  const w = createMatrix(k);
  const denom = k - 1;
  if (denom === 0) return w; // single category: all weights are 0
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      w[i][j] = ((i - j) / denom) ** 2;
    }
  }
  return w;
}

/**
 * Assert two arrays have identical length.
 */
function assertSameLength(a: number[], b: number[]): void {
  if (a.length !== b.length) {
    throw new Error('Arrays must have the same length');
  }
}

// ─── Quadratic weighted Cohen's kappa ──────────────────────────────────────

/**
 * Compute quadratic weighted Cohen's kappa with a 95% confidence interval
 * obtained via cluster bootstrap (resampling items/clusters with replacement).
 *
 * Uses the quadratic weight function w_ij = ((i - j) / (k - 1))^2.
 *
 * @param rater1 - First rater's ordinal scores (integers 0..k-1)
 * @param rater2 - Second rater's ordinal scores (integers 0..k-1)
 * @param numCategories - Number of ordinal categories (default 4)
 * @returns kappa value, 95% CI, and number of rated items
 *
 * @example
 * const r1 = [0, 1, 2, 3, 0, 1, 2, 3];
 * const r2 = [0, 1, 1, 3, 1, 2, 2, 3];
 * quadraticWeightedKappa(r1, r2)  // { kappa: ~0.77, ci95: [...], n: 8 }
 */
export function quadraticWeightedKappa(
  rater1: number[],
  rater2: number[],
  numCategories = 4,
): { kappa: number; ci95: [number, number]; n: number } {
  if (rater1.length !== rater2.length) {
    throw new Error('Arrays must have the same length');
  }
  const n = rater1.length;
  if (n === 0) {
    return { kappa: NaN, ci95: [NaN, NaN], n: 0 };
  }
  for (const s of rater1) {
    if (!Number.isInteger(s) || s < 0 || s >= numCategories) {
      throw new Error(`Score must be integer in [0, ${numCategories - 1}], got ${s}`);
    }
  }
  for (const s of rater2) {
    if (!Number.isInteger(s) || s < 0 || s >= numCategories) {
      throw new Error(`Score must be integer in [0, ${numCategories - 1}], got ${s}`);
    }
  }

  // Observed agreement matrix
  const obs = createMatrix(numCategories);
  for (let i = 0; i < n; i++) {
    obs[rater1[i]][rater2[i]]++;
  }

  // Marginal sums
  const rowSum = new Array<number>(numCategories).fill(0);
  const colSum = new Array<number>(numCategories).fill(0);
  for (let i = 0; i < numCategories; i++) {
    for (let j = 0; j < numCategories; j++) {
      rowSum[i] += obs[i][j];
      colSum[j] += obs[i][j];
    }
  }

  // Quadratic weight matrix
  const weight = createWeightMatrix(numCategories);

  // Weighted observed and expected agreement proportions
  let weightedObs = 0;
  let weightedExp = 0;
  const total = n;

  for (let i = 0; i < numCategories; i++) {
    for (let j = 0; j < numCategories; j++) {
      const expected = (rowSum[i] * colSum[j]) / total;
      weightedObs += weight[i][j] * obs[i][j];
      weightedExp += weight[i][j] * expected;
    }
  }

  const kappa = weightedExp === 0 ? (weightedObs === 0 ? 1 : 0) : 1 - weightedObs / weightedExp;

  // Bootstrap confidence interval
  const clusterData: Array<{
    rater1: number;
    rater2: number;
    cluster: string;
  }> = [];
  for (let i = 0; i < n; i++) {
    clusterData.push({
      rater1: rater1[i],
      rater2: rater2[i],
      cluster: `i${i}`,
    });
  }
  const distribution = clusterBootstrap(clusterData);

  let ci95: [number, number];
  if (distribution.length === 0) {
    ci95 = [NaN, NaN];
  } else {
    const lowerIdx = Math.max(0, Math.floor(0.025 * distribution.length));
    const upperIdx = Math.min(distribution.length - 1, Math.floor(0.975 * distribution.length));
    ci95 = [distribution[lowerIdx], distribution[upperIdx]];
  }

  return { kappa, ci95, n };
}

// ─── Bootstrap helper ──────────────────────────────────────────────────────

/**
 * Bootstrap the distribution of quadratic weighted Cohen's kappa by
 * resampling clusters with replacement.
 *
 * @param scores - Array of scored items, each with rater scores and a cluster
 *   identifier (e.g., project or scene ID). Items sharing a cluster are
 *   bootstrapped as a unit to preserve within-cluster dependencies.
 * @param numSamples - Number of bootstrap replications (default 2000)
 * @returns Sorted array of kappa values from each bootstrap replication
 */
export function clusterBootstrap(
  scores: Array<{ rater1: number; rater2: number; cluster: string }>,
  numSamples = 2000,
): number[] {
  // Group items by cluster
  const clusterMap = new Map<string, Array<{ r1: number; r2: number }>>();
  for (const s of scores) {
    let arr = clusterMap.get(s.cluster);
    if (!arr) {
      arr = [];
      clusterMap.set(s.cluster, arr);
    }
    arr.push({ r1: s.rater1, r2: s.rater2 });
  }
  const clusters = Array.from(clusterMap.values());
  const nClusters = clusters.length;

  if (nClusters === 0) return [];

  const kappaValues: number[] = [];

  for (let sample = 0; sample < numSamples; sample++) {
    const boot1: number[] = [];
    const boot2: number[] = [];

    // Resample clusters with replacement
    for (let c = 0; c < nClusters; c++) {
      const idx = Math.floor(Math.random() * nClusters);
      for (const item of clusters[idx]) {
        boot1.push(item.r1);
        boot2.push(item.r2);
      }
    }

    const k = computeKappaInternal(boot1, boot2);
    if (Number.isFinite(k)) {
      kappaValues.push(k);
    }
  }

  kappaValues.sort((a, b) => a - b);
  return kappaValues;
}

/**
 * Internal: compute kappa without validation. Used during bootstrap.
 * Infers numCategories from the maximum score value.
 */
function computeKappaInternal(rater1: number[], rater2: number[]): number {
  let maxVal = 0;
  for (const v of rater1) if (v > maxVal) maxVal = v;
  for (const v of rater2) if (v > maxVal) maxVal = v;
  const k = maxVal + 1;
  const n = rater1.length;

  if (n === 0 || k < 2) return 0;

  const obs = createMatrix(k);
  for (let i = 0; i < n; i++) {
    obs[rater1[i]][rater2[i]]++;
  }

  const rowSum = new Array<number>(k).fill(0);
  const colSum = new Array<number>(k).fill(0);
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      rowSum[i] += obs[i][j];
      colSum[j] += obs[i][j];
    }
  }

  const weight = createWeightMatrix(k);
  let weightedObs = 0;
  let weightedExp = 0;
  const total = n;

  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      const expected = (rowSum[i] * colSum[j]) / total;
      weightedObs += weight[i][j] * obs[i][j];
      weightedExp += weight[i][j] * expected;
    }
  }

  if (weightedExp === 0) return weightedObs === 0 ? 1 : 0;
  return 1 - weightedObs / weightedExp;
}

// ─── Agreement stats ───────────────────────────────────────────────────────

/**
 * Compute exact agreement and within-one-category agreement proportions.
 *
 * Exact agreement: proportion of items where rater1 === rater2.
 * Within-one: proportion where |rater1 - rater2| <= 1.
 *
 * @returns Agreement proportions and total item count
 */
export function agreementStats(
  rater1: number[],
  rater2: number[],
): { exactAgreement: number; withinOne: number; n: number } {
  assertSameLength(rater1, rater2);
  const n = rater1.length;
  if (n === 0) return { exactAgreement: 1, withinOne: 1, n: 0 };

  let exact = 0;
  let withinOne = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(rater1[i] - rater2[i]);
    if (d === 0) exact++;
    if (d <= 1) withinOne++;
  }

  return {
    exactAgreement: exact / n,
    withinOne: withinOne / n,
    n,
  };
}

// ─── Grade distribution ────────────────────────────────────────────────────

/**
 * Compute the distribution of scores across ordinal categories.
 *
 * @param scores - Array of ordinal scores (integers 0..numCategories-1)
 * @param numCategories - Number of ordinal categories (default 4)
 * @returns Map from category index to count of scores
 */
export function gradeDistribution(scores: number[], numCategories = 4): Map<number, number> {
  const dist = new Map<number, number>();
  for (let c = 0; c < numCategories; c++) {
    dist.set(c, 0);
  }
  for (const s of scores) {
    dist.set(s, (dist.get(s) ?? 0) + 1);
  }
  return dist;
}

// ─── Transition matrix ────────────────────────────────────────────────────

/**
 * Build a transition (cross-tabulation) matrix from two raters' scores.
 *
 * `matrix[i][j]` = number of items where rater1 scored `i` and rater2 scored `j`.
 *
 * @returns numCategories x numCategories matrix
 */
export function transitionMatrix(
  rater1: number[],
  rater2: number[],
  numCategories = 4,
): number[][] {
  assertSameLength(rater1, rater2);
  const mat = createMatrix(numCategories);
  for (let i = 0; i < rater1.length; i++) {
    mat[rater1[i]][rater2[i]]++;
  }
  return mat;
}

// ─── Spearman test-retest rho ─────────────────────────────────────────────

/**
 * Compute Spearman rank correlation (rho) for test-retest reliability,
 * with midrank tie handling and an asymptotic p-value.
 *
 * The correlation is computed as the Pearson product-moment correlation on
 * midranks. The p-value is derived from the t-distribution with n-2 degrees
 * of freedom (two-tailed).
 *
 * @param round1 - Scores from the first annotation round
 * @param round2 - Scores from the second (re-test) annotation round
 * @returns rho and p-value (NaN if fewer than 3 observations)
 */
export function spearmanTestRetestRho(
  round1: number[],
  round2: number[],
): { rho: number; pValue: number } {
  assertSameLength(round1, round2);
  const n = round1.length;
  if (n < 3) return { rho: NaN, pValue: NaN };

  const ranks1 = rankWithTies(round1);
  const ranks2 = rankWithTies(round2);

  // Pearson correlation on midranks
  const mean1 = ranks1.reduce((a, b) => a + b, 0) / n;
  const mean2 = ranks2.reduce((a, b) => a + b, 0) / n;

  let cov = 0;
  let var1 = 0;
  let var2 = 0;
  for (let i = 0; i < n; i++) {
    const d1 = ranks1[i] - mean1;
    const d2 = ranks2[i] - mean2;
    cov += d1 * d2;
    var1 += d1 * d1;
    var2 += d2 * d2;
  }

  const denom = Math.sqrt(var1 * var2);
  if (denom === 0) {
    // Zero variance in at least one ranking — correlation undefined
    return { rho: NaN, pValue: NaN };
  }

  const rho = cov / denom;

  // Two-tailed p-value via t-distribution
  const tStat = rho * Math.sqrt((n - 2) / (1 - rho * rho));
  const df = n - 2;
  const pValue = 2 * (1 - studentTCdf(Math.abs(tStat), df));

  return { rho, pValue };
}

// ══════════════════════════════════════════════════════════════════════════
// Internal: Student's t CDF via regularized incomplete beta function
//
// These are the same Lanczos/betainc/tCDF functions used in consistency.ts
// but duplicated here to keep annotation-stats.ts self-contained
// (no internal cross-module dependency).
// ══════════════════════════════════════════════════════════════════════════

const LANCZOS_G = 7;
const LANCZOS_C: number[] = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];

/**
 * Log-gamma function via Lanczos approximation (same implementation as
 * consistency.ts for reproducible p-values).
 */
function lgamma(z: number): number {
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  }
  z -= 1;
  let x = LANCZOS_C[0];
  for (let i = 1; i < LANCZOS_G + 2; i++) {
    x += LANCZOS_C[i] / (z + i);
  }
  const t = z + LANCZOS_G + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/**
 * Regularized incomplete beta function I_x(a, b).
 * Uses modified Lentz's continued fraction method.
 */
function betainc(x: number, a: number, b: number): number {
  if (x < 0 || x > 1) return NaN;
  if (x === 0 || x === 1) return x;

  // Use symmetry for efficiency when x > mean
  if (x > (a + 1) / (a + b + 2)) {
    return 1 - betainc(1 - x, b, a);
  }

  const lbeta = lgamma(a) + lgamma(b) - lgamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lbeta) / a;

  // Lentz's continued fraction
  let f = 1;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < 1e-30) d = 1e-30;
  d = 1 / d;
  f = d;

  for (let m = 1; m <= 200; m++) {
    // 2m step
    let numerator = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
    d = 1 + numerator * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + numerator / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    f *= d * c;

    // 2m+1 step
    numerator = (-(a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1));
    d = 1 + numerator * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + numerator / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    const delta = d * c;
    f *= delta;

    if (Math.abs(delta - 1) < 1e-10) break;
  }

  return front * f;
}

/**
 * Student's t cumulative distribution function P(T <= t) for t >= 0.
 * Uses the relation: P(T <= t) = 1 - 0.5 * I_{df/(df+t^2)}(df/2, 1/2)
 */
function studentTCdf(t: number, df: number): number {
  if (t < 0) return 1 - studentTCdf(-t, df);
  const x = df / (df + t * t);
  return 1 - 0.5 * betainc(x, df / 2, 0.5);
}
