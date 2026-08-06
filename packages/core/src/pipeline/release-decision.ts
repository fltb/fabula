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

import { sha256 } from '../cache/pure-sha256.ts';
import { DEFAULT_RELEASE_POLICY, type ReleasePolicy } from '../config/defaults.ts';
import type {
  AnalysisResult,
  ReleaseDecision,
  ValidationIssue,
  ValidationResult,
} from '../types/index.ts';
import type { InteractionManager } from './interaction-gate.ts';

/**
 * Deterministic fingerprint of one warning finding. The stable identity is
 * the finding's semantic fields (validator, kind, event, entity, attribute,
 * message) — NOT severity, which is a policy/override-derived property.
 * Equal findings always produce equal fingerprints; any identity change
 * produces a different fingerprint.
 */
export function computeWarningFingerprint(warning: ValidationIssue): string {
  return sha256(
    JSON.stringify({
      validator: warning.validator,
      kind: warning.kind,
      event: warning.event,
      entity: warning.entity,
      attribute: warning.attribute ?? null,
      message: warning.message,
    }),
  );
}

/**
 * Deterministic release-gate identity (plan 5.3):
 * `sha256({projectId, sourceHash, eventId, proseHash, scopeHash,
 * validationIdentity, sortedWarningFingerprints})`.
 *
 * `sortedWarningFingerprints` is the lexicographically sorted list of
 * per-warning fingerprints, so identical warning SETS (any order) yield the
 * same gate. Any change to project/source/event/prose/scope/validator
 * identity or to the warning set changes the gate.
 */
export function computeReleaseGateId(input: {
  readonly projectId: string;
  readonly sourceHash: string;
  readonly eventId: string;
  readonly proseHash: string;
  readonly scopeHash: string;
  readonly validationIdentity: string;
  readonly warnings: readonly ValidationIssue[];
}): string {
  const sortedWarningFingerprints = input.warnings.map(computeWarningFingerprint).sort();
  return sha256(
    JSON.stringify({
      projectId: input.projectId,
      sourceHash: input.sourceHash,
      eventId: input.eventId,
      proseHash: input.proseHash,
      scopeHash: input.scopeHash,
      validationIdentity: input.validationIdentity,
      sortedWarningFingerprints,
    }),
  );
}

/**
 * Project/source identity context required to compute the release-gate id.
 * Supplied by production callers (render service); when absent the decision
 * carries no `gateId` and waiver matching is impossible.
 */
export interface ReleaseGateIdentityContext {
  readonly projectId: string;
  readonly sourceHash: string;
  readonly proseHash: string;
}

/** Optional evaluation controls: release policy + gate identity context. */
export interface EvaluateReleaseDecisionOptions {
  readonly policy?: ReleasePolicy;
  readonly gateIdentity?: ReleaseGateIdentityContext;
}

/**
 * Evaluate whether a render candidate satisfies all release criteria.
 *
 * This is the ONLY release evaluator: every caller (API, pipeline, output,
 * resolveReleaseGate) must funnel through it.
 *
 * @param candidate        - The scene result to evaluate.
 * @param scopeHash        - Identity hash for the render/validation scope
 *                           (branch, discourse, contract, etc.).
 * @param validationIdentity - Fingerprint of the active validator set + overrides.
 * @param interactionManager - Gate manager for warning waivers (require-waiver).
 * @param options          - Release policy (default accept-and-record) and the
 *                           project/source identity context used to compute the
 *                           deterministic release-gate id.
 * @returns A ReleaseDecision with status, reasons, optional waiver ID, and —
 *          when the gate identity context is supplied — the gate id and the
 *          sorted warning fingerprints that bind the gate.
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
  options?: EvaluateReleaseDecisionOptions,
): ReleaseDecision {
  const reasons: string[] = [];
  const providerFailure = candidate.errors.find((error) => error.includes('PROVIDER_REQUIRED'));
  if (providerFailure) {
    reasons.push(providerFailure);
    return { status: 'blocked', scopeHash, validationIdentity, reasons };
  }

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

  // Warning-only issues — policy determines accept-and-record vs pending
  const warningIssues = candidate.validation.warnings;
  if (warningIssues.length > 0) {
    reasons.push(...warningIssues.map((e) => e.message));
    const policy = options?.policy ?? DEFAULT_RELEASE_POLICY;
    const context = options?.gateIdentity;
    const gateId = context
      ? computeReleaseGateId({
          projectId: context.projectId,
          sourceHash: context.sourceHash,
          eventId: candidate.eventId,
          proseHash: context.proseHash,
          scopeHash,
          validationIdentity,
          warnings: warningIssues,
        })
      : undefined;
    const warningFingerprints = gateId
      ? warningIssues.map(computeWarningFingerprint).sort()
      : undefined;

    if (policy.warnings === 'require-waiver') {
      if (gateId && interactionManager) {
        if (!interactionManager.needsApproval(gateId, 'warning')) {
          // Waiver exists — accepted
          const waiver = interactionManager.getWaiver(gateId);
          return {
            status: 'accepted',
            scopeHash,
            validationIdentity,
            reasons,
            waiverId: waiver?.gateId,
            gateId,
            releasePolicy: policy,
            warningFingerprints,
          };
        }
      }
      // No waiver — candidate waits on a maintainer decision
      return {
        status: 'pending_waiver',
        scopeHash,
        validationIdentity,
        reasons,
        gateId,
        releasePolicy: policy,
        warningFingerprints,
      };
    }

    // accept-and-record (default): warning candidates are ACCEPTED and their
    // reasons + warning fingerprints are recorded on the decision.
    return {
      status: 'accepted',
      scopeHash,
      validationIdentity,
      reasons,
      gateId,
      releasePolicy: policy,
      warningFingerprints,
    };
  }

  // All clear — accepted
  return { status: 'accepted', scopeHash, validationIdentity, reasons: [] };
}
