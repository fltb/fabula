// ============================================================================
// compareFact — Unified fact comparison function
// ============================================================================
//
// All validators MUST use compareFact() for deterministic fact checking.
// No ad-hoc comparison strategies.
//
// Returns:
//   'match'    — fact.value exists and equals stateValue
//   'mismatch' — fact.value exists and does NOT equal stateValue
//   'deferred' — fact has only narrativeHint (Pass 2 handles semantic checks)
// ============================================================================

import type { Fact } from '../types/entity.js';

export type CompareOutcome = 'match' | 'mismatch' | 'deferred';

export function compareFact(fact: Fact, stateValue: unknown): CompareOutcome {
  if (fact.value !== undefined) {
    return stateValue === fact.value ? 'match' : 'mismatch';
  }
  if (fact.narrativeHint !== undefined) {
    return 'deferred';
  }
  // Defensive: Zod should reject facts without value or narrativeHint,
  // but we guard against it here.
  throw new Error(`Fact ${fact.id}: must have either value or narrativeHint`);
}
