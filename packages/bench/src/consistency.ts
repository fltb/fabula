// ============================================================================
// Consistency Metrics — N-CED, S-CED, Pipeline F1, Spearman rank correlation
// ============================================================================

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

