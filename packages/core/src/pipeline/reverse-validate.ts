// ============================================================================
// Reverse Validation — Analyze validation errors and build repair guidance
// ============================================================================
//
// Takes a ValidationResult from post-render validation and produces:
//  - Whether the errors are repairable (canRepair)
//  - A structured feedbackPrompt for the LLM retry
//  - buildRepairGuidance() wraps prompt with round metadata
//  - decideRepairStrategy() selects retry strategy based on error count
//  - degradeStrategy() escalates when repairs aren't working
// ============================================================================

import type { ValidationResult } from '../types/index.js';

export interface ReverseValidationResult {
  canRepair: boolean;
  feedbackPrompt: string;
  errorCount: number;
  criticalErrors: string[];
  suggestions: string[];
}

export type RepairStrategy = 'retry' | 'prompt_fix' | 'context_enrich' | 'abort';

export interface RepairDecision {
  strategy: RepairStrategy;
  maxRepairRounds: number;
  shouldRetry: boolean;
  guidance: string;
}

/**
 * Analyze validation errors and determine if automatic repair is feasible.
 * Max 5 repairable errors — beyond that it's better to abort and flag for review.
 */
export function analyzeValidationErrors(result: ValidationResult): ReverseValidationResult {
  const criticalErrors = result.errors.filter((e) => e.severity === 'error').map((e) => e.message);
  const warnings = result.warnings.map((e) => e.message);

  // Only attempt repair if there are errors and the count is manageable
  const canRepair = result.errors.length > 0 && result.errors.length <= 5;

  const suggestions = [
    ...criticalErrors.map((e) => `Fix: ${e}`),
    ...warnings.map((w) => `Consider: ${w}`),
  ];

  const feedbackPrompt = canRepair
    ? `The previous render had the following issues. Please correct them in this revision:\n${suggestions.join('\n')}`
    : '';

  return {
    canRepair,
    feedbackPrompt,
    errorCount: result.errors.length,
    criticalErrors,
    suggestions,
  };
}

/**
 * Build structured repair guidance for injection into the retry prompt.
 * Includes round metadata and the list of issues to fix.
 */
function buildRepairGuidance(
  result: ReverseValidationResult,
  round: number,
  maxRounds: number,
): string {
  if (!result.canRepair) return '';
  return `[Revision ${round}/${maxRounds}]\n${result.feedbackPrompt}\nPlease maintain all other aspects of the prose while fixing these specific issues.`;
}

/**
 * Decide repair strategy based on error count and current round.
 *
 * Strategy selection:
 *   - 1-2 errors → 'retry' (simple retry with no extra guidance)
 *   - 3-5 errors → 'prompt_fix' (guided repair with specific error feedback)
 *   - 6-10 errors → 'context_enrich' (add more context to the prompt)
 *   - 11+ errors or round > maxRounds → 'abort'
 */
export function decideRepairStrategy(
  result: ReverseValidationResult,
  round: number,
  maxRounds: number,
): RepairDecision {
  const errorCount = result.errorCount;

  if (round > maxRounds || errorCount > 10) {
    return {
      strategy: 'abort',
      maxRepairRounds: maxRounds,
      shouldRetry: false,
      guidance: 'Too many errors to repair.',
    };
  }

  if (errorCount <= 2) {
    return { strategy: 'retry', maxRepairRounds: maxRounds, shouldRetry: true, guidance: '' };
  } else if (errorCount <= 5) {
    return {
      strategy: 'prompt_fix',
      maxRepairRounds: maxRounds,
      shouldRetry: true,
      guidance: buildRepairGuidance(result, round, maxRounds),
    };
  } else {
    return {
      strategy: 'context_enrich',
      maxRepairRounds: maxRounds,
      shouldRetry: true,
      guidance: `The render has ${errorCount} issues. Additional context and style guidance will be added for the retry.\n${result.feedbackPrompt}`,
    };
  }
}
