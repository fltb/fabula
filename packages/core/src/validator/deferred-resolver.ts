// ============================================================================
// Deferred-fact resolution mechanism
// ============================================================================
//
// Preconditions that have only a narrativeHint (no deterministic value)
// are 'deferred' — they cannot be checked against WorldState; instead they
// must be validated against Pass 2 analysis narrativeChecks.
//
// resolveDeferredFacts() consumes the Pass 2 narrativeChecks block and
// emits issues for narrativeHint-only preconditions:
//   - contradicted → error (prose actively conflicts with the hint)
//   - absent / missing from checks → warning (prose may not restate prior context)
// ============================================================================

import { compareFact } from '../entity/compare.js';
import { makeIssue } from './base.js';
import type { NarrativeEvent, AnalysisResult, ValidationIssue } from '../types/index.js';

export function resolveDeferredFacts(
  event: NarrativeEvent,
  analysis: AnalysisResult | null | undefined,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!analysis) return issues;

  // Only resolve when narrativeChecks are present in the Pass 2 analysis
  const raw = (analysis.analysis as Record<string, unknown>).narrativeChecks;
  if (!raw) return issues;

  const narrativeChecks = raw as Array<{
    entityId: string;
    attribute: string;
    matchLevel: string;
  }>;

  for (const pc of event.preconditions) {
    // Skip deterministic preconditions — already handled by compareFact() in validatePre
    if (pc.value !== undefined) continue;
    if (!pc.narrativeHint) continue;

    // Confirm compareFact would classify this as deferred
    const outcome = compareFact(pc, undefined);
    if (outcome !== 'deferred') continue;

    // Look for a matching narrativeCheck from Pass 2
    const match = narrativeChecks.find(
      (nc) => nc.entityId === pc.entityId && nc.attribute === pc.attribute,
    );

    if (match?.matchLevel === 'contradicted') {
      issues.push(
        makeIssue(
          'DeferredResolver',
          event.id,
          pc.entityId,
          'error',
          `Narrative hint precondition for ${pc.entityId}.${pc.attribute} is contradicted by prose`,
          'Ensure the prose respects this precondition or adjust the precondition.',
          'manual',
          pc.attribute,
        ),
      );
    } else if (!match || match.matchLevel === 'absent') {
      issues.push(
        makeIssue(
          'DeferredResolver',
          event.id,
          pc.entityId,
          'warning',
          `Narrative hint precondition for ${pc.entityId}.${pc.attribute} is ${match?.matchLevel ?? 'unverified'}`,
          'Ensure the prose establishes this state or adjust the precondition.',
          'manual',
          pc.attribute,
        ),
      );
    }
  }

  return issues;
}
