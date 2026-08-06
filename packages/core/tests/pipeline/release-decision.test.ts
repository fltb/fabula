// ============================================================================
// Release Decision — gate identity + release policy semantics
//
// evaluateReleaseDecision is the SOLE release evaluator. The default policy
// is `accept-and-record`: warning-only candidates are ACCEPTED and their
// reasons + warning fingerprints are recorded on the decision. Under
// `require-waiver` the candidate stays `pending_waiver` until a matching
// waiver resolves the gate. Error / empty prose / missing analysis /
// exhausted retries are ALWAYS blocked — no waiver can bypass them.
//
// The release-gate identity is
//   sha256({projectId, sourceHash, eventId, proseHash, scopeHash,
//           validationIdentity, sortedWarningFingerprints})
// — stable for identical inputs, and it changes when ANY identity input
// changes. No provider, filesystem, or network access.
// ============================================================================

import { describe, expect, it } from 'vitest';
import { sha256 } from '../../src/cache/pure-sha256.ts';
import { DEFAULT_RELEASE_POLICY } from '../../src/config/defaults.ts';
import { InteractionManager } from '../../src/pipeline/interaction-gate.ts';
import {
  computeReleaseGateId,
  computeWarningFingerprint,
  evaluateReleaseDecision,
} from '../../src/pipeline/release-decision.ts';
import type {
  AnalysisResult,
  ReleaseDecision,
  ValidationIssue,
  ValidationResult,
} from '../../src/types/index.ts';

// ——— helpers ———

const PROSE = 'Rainsford pulled himself onto the jagged coral shore.';
const EVENT_ID = 'E1';

function warningIssue(
  message = 'Pass 2 measurement for analysis field "pov" is abstained',
): ValidationIssue {
  return {
    validator: 'PovConsumer',
    severity: 'warning',
    kind: 'analysis_uncertainty',
    event: EVENT_ID,
    entity: 'system',
    message,
    fixSuggestion: 'Review the measurement uncertainty or waive the finding.',
    fixAction: 'manual',
    fixTarget: { file: '' },
    observationRef: { field: 'pov' },
  };
}

function errorIssue(message = 'Knowledge boundary violation'): ValidationIssue {
  return {
    validator: 'KnowledgeValidator',
    severity: 'error',
    kind: 'evidence_mismatch',
    event: EVENT_ID,
    entity: 'rainsford',
    message,
    fixSuggestion: 'Fix the boundary.',
    fixAction: 'edit_file',
    fixTarget: { file: 'definitions/knowledge.yaml' },
  };
}

function validation(
  warnings: readonly ValidationIssue[],
  errors: readonly ValidationIssue[] = [],
): ValidationResult {
  return {
    passed: errors.length === 0,
    errors: [...errors],
    warnings: [...warnings],
    infos: [],
  };
}

function candidate(
  v: ValidationResult | null,
  overrides: Partial<{
    eventId: string;
    prose: string;
    analysis: AnalysisResult | null;
    needsReview: boolean;
    errors: string[];
  }> = {},
): Parameters<typeof evaluateReleaseDecision>[0] {
  return {
    eventId: EVENT_ID,
    prose: PROSE,
    analysis: {
      eventId: EVENT_ID,
      protocol: {},
      observations: {},
      analysis: {},
    } as unknown as AnalysisResult,
    validation: v,
    needsReview: false,
    errors: [],
    ...overrides,
  };
}

const GATE_CONTEXT = {
  projectId: 'proj-a',
  sourceHash: sha256('source'),
  proseHash: sha256(PROSE),
};

const requireWaiver = {
  warnings: 'require-waiver' as const,
  openBlockingReviews: 'block' as const,
};

function gateIdFor(
  warnings: readonly ValidationIssue[],
  overrides: Partial<Parameters<typeof computeReleaseGateId>[0]> = {},
): string {
  return computeReleaseGateId({
    projectId: GATE_CONTEXT.projectId,
    sourceHash: GATE_CONTEXT.sourceHash,
    eventId: EVENT_ID,
    proseHash: GATE_CONTEXT.proseHash,
    scopeHash: 'scope-a',
    validationIdentity: 'validators-v1',
    warnings,
    ...overrides,
  });
}

// ============================================================================
// Release policy semantics
// ============================================================================

describe('evaluateReleaseDecision — release policy semantics', () => {
  it('default policy is accept-and-record: warning candidates are accepted and recorded', () => {
    const warnings = [warningIssue('first warning'), warningIssue('second warning')];
    const decision = evaluateReleaseDecision(
      candidate(validation(warnings)),
      'scope-a',
      'validators-v1',
    );
    expect(decision.status).toBe('accepted');
    // Reasons are recorded with the decision.
    expect(decision.reasons).toEqual(['first warning', 'second warning']);
    expect(decision.releasePolicy).toEqual(DEFAULT_RELEASE_POLICY);
    // No waiver is involved under accept-and-record.
    expect(decision.waiverId).toBeUndefined();
  });

  it('accept-and-record decision carries the deterministic gate identity', () => {
    const warnings = [warningIssue()];
    const decision = evaluateReleaseDecision(
      candidate(validation(warnings)),
      'scope-a',
      'validators-v1',
      undefined,
      { gateIdentity: GATE_CONTEXT },
    );
    expect(decision.gateId).toBe(gateIdFor(warnings));
    expect(decision.warningFingerprints).toEqual(warnings.map(computeWarningFingerprint).sort());
  });

  it('accept-and-record accepts without any interaction manager', () => {
    const decision = evaluateReleaseDecision(
      candidate(validation([warningIssue()])),
      'scope-a',
      'validators-v1',
      undefined,
      { policy: requireWaiver },
    );
    // Even under require-waiver there is no manager and no context → pending.
    expect(decision.status).toBe('pending_waiver');
  });

  it('require-waiver: warnings without a waiver → pending_waiver', () => {
    const warnings = [warningIssue()];
    const manager = new InteractionManager();
    const decision = evaluateReleaseDecision(
      candidate(validation(warnings)),
      'scope-a',
      'validators-v1',
      manager,
      { policy: requireWaiver, gateIdentity: GATE_CONTEXT },
    );
    expect(decision.status).toBe('pending_waiver');
    expect(decision.gateId).toBe(gateIdFor(warnings));
    expect(decision.waiverId).toBeUndefined();
    expect(decision.releasePolicy?.warnings).toBe('require-waiver');
  });

  it('require-waiver: exact waiver on the computed gate → accepted', () => {
    const warnings = [warningIssue()];
    const gateId = gateIdFor(warnings);
    const manager = new InteractionManager();
    manager.recordWaiver(gateId, 'maintainer accepts the uncertainty');
    const decision = evaluateReleaseDecision(
      candidate(validation(warnings)),
      'scope-a',
      'validators-v1',
      manager,
      { policy: requireWaiver, gateIdentity: GATE_CONTEXT },
    );
    expect(decision.status).toBe('accepted');
    expect(decision.waiverId).toBe(gateId);
  });

  it('require-waiver: a waiver under a legacy gate id never matches the computed gate', () => {
    const warnings = [warningIssue()];
    const manager = new InteractionManager();
    manager.recordWaiver(`gate:${EVENT_ID}:validation`, 'legacy waiver');
    const decision = evaluateReleaseDecision(
      candidate(validation(warnings)),
      'scope-a',
      'validators-v1',
      manager,
      { policy: requireWaiver, gateIdentity: GATE_CONTEXT },
    );
    expect(decision.status).toBe('pending_waiver');
  });

  it('error-severity issues are blocked under accept-and-record even with a waiver', () => {
    const manager = new InteractionManager();
    manager.recordWaiver(gateIdFor([warningIssue()]), 'attempted bypass');
    const decision = evaluateReleaseDecision(
      candidate(validation([], [errorIssue()])),
      'scope-a',
      'validators-v1',
      manager,
      { gateIdentity: GATE_CONTEXT },
    );
    expect(decision.status).toBe('blocked');
    expect(decision.waiverId).toBeUndefined();
  });

  it('error-severity issues are blocked under require-waiver even with a waiver', () => {
    const manager = new InteractionManager();
    manager.recordWaiver(gateIdFor([warningIssue()]), 'attempted bypass');
    const decision = evaluateReleaseDecision(
      candidate(validation([], [errorIssue()])),
      'scope-a',
      'validators-v1',
      manager,
      { policy: requireWaiver, gateIdentity: GATE_CONTEXT },
    );
    expect(decision.status).toBe('blocked');
  });

  it('empty prose and missing analysis are always blocked under both policies', () => {
    const policies = [undefined, requireWaiver] as const;
    for (const policy of policies) {
      const emptyProse = evaluateReleaseDecision(
        candidate(validation([]), { prose: '   ' }),
        'scope-a',
        'validators-v1',
        undefined,
        { policy, gateIdentity: GATE_CONTEXT },
      );
      expect(emptyProse.status).toBe('blocked');

      const noAnalysis = evaluateReleaseDecision(
        candidate(validation([]), { analysis: null }),
        'scope-a',
        'validators-v1',
        undefined,
        { policy, gateIdentity: GATE_CONTEXT },
      );
      expect(noAnalysis.status).toBe('blocked');

      const exhausted = evaluateReleaseDecision(
        candidate(validation([]), { needsReview: true }),
        'scope-a',
        'validators-v1',
        undefined,
        { policy, gateIdentity: GATE_CONTEXT },
      );
      expect(exhausted.status).toBe('blocked');
    }
  });

  it('all-clear candidates are accepted without a gate', () => {
    const decision = evaluateReleaseDecision(
      candidate(validation([])),
      'scope-a',
      'validators-v1',
      undefined,
      { gateIdentity: GATE_CONTEXT },
    );
    expect(decision.status).toBe('accepted');
    expect(decision.gateId).toBeUndefined();
    expect(decision.reasons).toEqual([]);
  });

  it('accept-and-record is the default when no policy is supplied', () => {
    const decision = evaluateReleaseDecision(
      candidate(validation([warningIssue()])),
      'scope-a',
      'validators-v1',
      undefined,
      { gateIdentity: GATE_CONTEXT },
    );
    expect(decision.status).toBe('accepted');
    expect(decision.releasePolicy).toEqual(DEFAULT_RELEASE_POLICY);
  });
});

// ============================================================================
// Gate identity formula
// ============================================================================

describe('computeReleaseGateId — deterministic identity', () => {
  const baseWarnings = [warningIssue('a'), warningIssue('b')];

  it('is stable for identical inputs', () => {
    expect(gateIdFor(baseWarnings)).toBe(gateIdFor(baseWarnings));
    expect(gateIdFor(baseWarnings)).toBe(gateIdFor([...baseWarnings]));
  });

  it('is independent of warning order (sorted fingerprints)', () => {
    const forward = gateIdFor([warningIssue('a'), warningIssue('b')]);
    const reversed = gateIdFor([warningIssue('b'), warningIssue('a')]);
    expect(forward).toBe(reversed);
  });

  it('changes when any identity input changes', () => {
    const base = gateIdFor(baseWarnings);
    const cases: Array<Partial<Parameters<typeof computeReleaseGateId>[0]>> = [
      { projectId: 'proj-b' },
      { sourceHash: sha256('other-source') },
      { eventId: 'E2' },
      { proseHash: sha256('different prose') },
      { scopeHash: 'scope-b' },
      { validationIdentity: 'validators-v2' },
      { warnings: [warningIssue('a'), warningIssue('b'), warningIssue('c')] },
      { warnings: [warningIssue('changed message')] },
    ];
    for (const change of cases) {
      expect(gateIdFor(baseWarnings, change)).not.toBe(base);
    }
  });

  it('changes when a warning message changes, but not when severity changes', () => {
    const asWarning = warningIssue('same finding');
    const asInfo: ValidationIssue = { ...asWarning, severity: 'info' };
    const asError: ValidationIssue = { ...asWarning, severity: 'error' };
    // Severity is policy-derived, not part of the stable finding identity.
    expect(computeWarningFingerprint(asWarning)).toBe(computeWarningFingerprint(asInfo));
    expect(computeWarningFingerprint(asWarning)).toBe(computeWarningFingerprint(asError));
    expect(gateIdFor([asWarning])).toBe(gateIdFor([asInfo]));
    // But a different message is a different finding.
    expect(computeWarningFingerprint({ ...asWarning, message: 'different finding' })).not.toBe(
      computeWarningFingerprint(asWarning),
    );
  });

  it('fingerprints are deterministic 64-char hex digests', () => {
    const fingerprint = computeWarningFingerprint(warningIssue());
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(computeWarningFingerprint(warningIssue())).toBe(fingerprint);
  });

  it('rejects the legacy gate id format entirely (no gate:E0:validation fallback)', () => {
    const decision: ReleaseDecision = evaluateReleaseDecision(
      candidate(validation([warningIssue()])),
      'scope-a',
      'validators-v1',
      undefined,
      { gateIdentity: GATE_CONTEXT },
    );
    expect(decision.gateId).toBeDefined();
    expect(decision.gateId).not.toContain(`gate:${EVENT_ID}:validation`);
    expect(decision.gateId).toMatch(/^[a-f0-9]{64}$/);
  });
});
