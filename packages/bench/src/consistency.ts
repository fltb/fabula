// ============================================================================
// Consistency Metrics — N-CED, S-CED, Pipeline F1, Spearman rank correlation
// ============================================================================

import type { ValidationIssue } from '@novalistically/core';

// ─── Types ─────────────────────────────────────────────────────────────────

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

export interface SeverityWeights {
  error: number;
  warning: number;
  info: number;
}

export const DEFAULT_SEVERITY_WEIGHTS: SeverityWeights = { error: 1.0, warning: 0.3, info: 0.1 };

// ─── Deduplication ──────────────────────────────────────────────────────────
// Key: (validator, event, entity, attribute, severity)

function deduplicateIssues(issues: ValidationIssue[]): ValidationIssue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const key = `${i.validator}\0${i.event}\0${i.entity ?? ''}\0${i.attribute ?? ''}\0${i.severity}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── Metric 1: N-CED ───────────────────────────────────────────────────────

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

// ─── Metric 2: S-CED ───────────────────────────────────────────────────────

export function computeSCED(
  issues: ValidationIssue[],
  wordCount: number,
  weights: SeverityWeights = DEFAULT_SEVERITY_WEIGHTS,
): { rawSCED: number; weightedSCED: number; totalWeightedIssues: number; totalRawIssues: number } {
  if (wordCount <= 0)
    return { rawSCED: 0, weightedSCED: 0, totalWeightedIssues: 0, totalRawIssues: 0 };
  const deduped = deduplicateIssues(issues);
  const totalRawIssues = deduped.length;
  const div = wordCount / 10000;
  const totalWeightedIssues = deduped.reduce((sum, i) => sum + (weights[i.severity] ?? 0), 0);
  return {
    rawSCED: totalRawIssues / div,
    weightedSCED: totalWeightedIssues / div,
    totalWeightedIssues,
    totalRawIssues,
  };
}

// ─── Metric 3: Spearman rho ────────────────────────────────────────────────

function rankWithTies(values: number[]): number[] {
  const n = values.length;
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j < n && indexed[j].v === indexed[i].v) j++;
    const avgRank = (i + 1 + j) / 2; // 1-indexed midrank
    for (let k = i; k < j; k++) ranks[indexed[k].i] = avgRank;
    i = j;
  }
  return ranks;
}

export function computeSpearmanRho(
  severityRankings: number[],
  repairPriorityRankings: number[],
): { rho: number; pValue: number } {
  const n = severityRankings.length;
  if (n < 3 || severityRankings.length !== repairPriorityRankings.length) {
    return { rho: Number.NaN, pValue: Number.NaN };
  }
  const rx = rankWithTies(severityRankings);
  const ry = rankWithTies(repairPriorityRankings);
  let sumD2 = 0;
  for (let i = 0; i < n; i++) {
    const d = rx[i] - ry[i];
    sumD2 += d * d;
  }
  const rho = 1 - (6 * sumD2) / (n * (n * n - 1));
  // Perfect correlation → p=0, avoid division by zero
  if (Math.abs(rho) >= 1) return { rho: rho >= 1 ? 1 : -1, pValue: 0 };
  const t = Math.abs(rho) * Math.sqrt((n - 2) / (1 - rho * rho));
  const df = n - 2;
  const x = (t * (1 - 1 / (4 * df))) / Math.sqrt(1 + (t * t) / (2 * df));
  const pValue = 2 * (1 - _normCDF(x));
  return { rho, pValue };
}

function _normCDF(x: number): number {
  const a = [0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429];
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + (p * Math.abs(x)) / Math.SQRT2);
  const y =
    1 - ((((a[4] * t + a[3]) * t + a[2]) * t + a[1]) * t + a[0]) * t * Math.exp((-x * x) / 2);
  return 0.5 * (1 + sign * y);
}

// ─── Metric 4: Disattenuated rho ───────────────────────────────────────────

export function computeDisattenuatedRho(
  observedRho: number,
  reliabilityA: number,
  reliabilityB: number,
): { value: number | null; applicable: boolean; reason?: string } {
  if (observedRho < -1 || observedRho > 1 || isNaN(observedRho)) {
    return { value: null, applicable: false, reason: 'observedRho out of range [-1, 1] or NaN' };
  }
  if (reliabilityA <= 0 || reliabilityA > 1 || isNaN(reliabilityA)) {
    return { value: null, applicable: false, reason: 'reliabilityA must be in (0, 1]' };
  }
  if (reliabilityB <= 0 || reliabilityB > 1 || isNaN(reliabilityB)) {
    return { value: null, applicable: false, reason: 'reliabilityB must be in (0, 1]' };
  }
  const corrected = observedRho / Math.sqrt(reliabilityA * reliabilityB);
  return { value: Math.max(-1, Math.min(1, corrected)), applicable: true };
}

// ─── Metric 5: CED by Language ─────────────────────────────────────────────

export function computeWordCountByLanguage(prose: string, language: 'zh' | 'en'): number {
  const s = prose.normalize('NFC').trim();
  if (!s) return 0;

  if (language === 'zh') {
    let count = 0;
    let inLatin = false;
    for (const ch of s) {
      const cp = ch.codePointAt(0)!;
      const isCJK =
        (cp >= 0x4e00 && cp <= 0x9fff) ||
        (cp >= 0x3400 && cp <= 0x4dbf) ||
        (cp >= 0xf900 && cp <= 0xfaff);
      const isLatinChar =
        (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || (cp >= 0x30 && cp <= 0x39);
      if (isCJK) {
        if (inLatin) {
          count++;
          inLatin = false;
        }
        count++;
      } else if (isLatinChar) {
        inLatin = true;
      } else {
        if (inLatin) {
          count++;
          inLatin = false;
        }
      }
    }
    if (inLatin) count++;
    return count;
  }
  // English: split on whitespace/punctuation, keep apostrophes and hyphens within words,
  // exclude tokens that are pure numbers.
  const tokens = s.split(/[^a-zA-Z0-9'-]+/).filter((t) => t.length > 0);
  return tokens.filter((t) => /[a-zA-Z]/.test(t)).length;
}

// ─── Metric 6: Per-Validator Breakdown ─────────────────────────────────────

export function computePerValidatorBreakdown(
  issues: ValidationIssue[],
  wordCount: number,
): Map<string, PerValidatorBreakdown> {
  const map = new Map<string, PerValidatorBreakdown>();
  const div = wordCount > 0 ? wordCount / 10000 : 1;
  for (const issue of issues) {
    let e = map.get(issue.validator);
    if (!e) {
      e = { validator: issue.validator, category: '', errors: 0, warnings: 0, infos: 0, nCED: 0 };
      map.set(issue.validator, e);
    }
    if (issue.severity === 'error') e.errors++;
    else if (issue.severity === 'warning') e.warnings++;
    else e.infos++;
  }
  for (const entry of map.values()) {
    entry.nCED = (entry.errors + entry.warnings + entry.infos) / div;
  }
  return map;
}

// ─── Metric 7: Severity-Level CED ──────────────────────────────────────────

export function computeSeverityLevelCED(
  issues: ValidationIssue[],
  wordCount: number,
): {
  error: { nCED: number; sCED: number };
  warning: { nCED: number; sCED: number };
  info: { nCED: number; sCED: number };
} {
  const deduped = deduplicateIssues(issues);
  const div = wordCount > 0 ? wordCount / 10000 : 1;
  const w = DEFAULT_SEVERITY_WEIGHTS;
  let eCount = 0,
    wCount = 0,
    iCount = 0;
  for (const issue of deduped) {
    if (issue.severity === 'error') eCount++;
    else if (issue.severity === 'warning') wCount++;
    else iCount++;
  }
  return {
    error: { nCED: eCount / div, sCED: (eCount * w.error) / div },
    warning: { nCED: wCount / div, sCED: (wCount * w.warning) / div },
    info: { nCED: iCount / div, sCED: (iCount * w.info) / div },
  };
}
