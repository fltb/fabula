// ============================================================================
// Release Decision — Sole release evaluator for scene candidates
// ============================================================================
//
// Design:
//   evaluateReleaseDecision is the ONLY function that determines whether a
//   render candidate may be released. All callers (API, pipeline, output)
//   must funnel through this single function.
//
//   Rules:
//     - Empty prose, missing analysis, exhausted retries → blocked
//     - Error-severity validation issues → blocked
//     - Warning-only issues with matching waiver → accepted
//     - Warning-only issues without waiver → pending_waiver
//     - Info-only or all-clear → accepted
// ============================================================================

import type { AnalysisResult, ReleaseDecision, ValidationResult } from '../types/index.ts';
import type { InteractionManager } from './interaction-gate.ts';

/**
 * Evaluate whether a render candidate satisfies all release criteria.
 *
 * @param candidate        - The scene result to evaluate.
 * @param scopeHash        - Identity hash for the render/validation scope
 *                           (branch, discourse, contract, etc.).
 * @param validationIdentity - Fingerprint of the active validator set + overrides.
 * @param interactionManager - Optional gate manager for warning waivers.
 * @returns A ReleaseDecision with status, reasons, and optional waiver ID.
 */
export function evaluateReleaseDecision(
  candidate: {
    eventId: string;
    prose: string;
    analysis: AnalysisResult | null;
    validation: ValidationResult | null;
    needsReview: boolean;
    errors: string[];
  },
  scopeHash: string,
  validationIdentity: string,
  interactionManager?: InteractionManager,
): ReleaseDecision {
  const reasons: string[] = [];

  // Empty prose — always blocked
  if (!candidate.prose || candidate.prose.trim().length === 0) {
    reasons.push('empty prose');
    return { status: 'blocked', scopeHash, validationIdentity, reasons };
  }

  // Missing analysis — always blocked
  if (candidate.analysis === null) {
    reasons.push('missing analysis output');
    return { status: 'blocked', scopeHash, validationIdentity, reasons };
  }

  // Exhausted retries — blocked
  if (candidate.needsReview) {
    reasons.push('exhausted retries — needs review');
    return { status: 'blocked', scopeHash, validationIdentity, reasons };
  }

  // Missing validation — blocked
  if (candidate.validation === null) {
    reasons.push('missing validation');
    return { status: 'blocked', scopeHash, validationIdentity, reasons };
  }

  // Error-severity issues — always blocked
  const errorIssues = candidate.validation.errors.filter((e) => e.severity === 'error');
  if (errorIssues.length > 0) {
    reasons.push(...errorIssues.map((e) => e.message));
    return { status: 'blocked', scopeHash, validationIdentity, reasons };
  }

  // Warning-only issues — check for waiver
  const warningIssues = candidate.validation.warnings;
  if (warningIssues.length > 0) {
    reasons.push(...warningIssues.map((e) => e.message));
    if (interactionManager) {
      const gateId = `gate:${candidate.eventId}:validation`;
      if (!interactionManager.needsApproval(gateId, 'warning')) {
        // Waiver exists — accepted
        const waiver = interactionManager.getWaiver(gateId);
        return {
          status: 'accepted',
          scopeHash,
          validationIdentity,
          reasons,
          waiverId: waiver?.gateId,
        };
      }
    }
    // No waiver — pending
    return { status: 'pending_waiver', scopeHash, validationIdentity, reasons };
  }

  // All clear — accepted
  return { status: 'accepted', scopeHash, validationIdentity, reasons: [] };
}
