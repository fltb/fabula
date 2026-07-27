// ============================================================================
// Novalistically — Branch Set Logic & Condition Evaluation
// ============================================================================

import { branchPathsEqual } from './path.ts';
import type { BranchChoice, BranchPath, BranchPoint, BranchSet, Condition } from './types.ts';

/**
 * Resolves a dot-notation field path against an object.
 * Supports paths like "decisions.length", "decisions.0.choiceId", etc.
 * Returns `undefined` for unresolvable paths.
 */
function getFieldValue(obj: unknown, field: string): unknown {
  if (!field) return undefined;
  const parts = field.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current === 'object' && part in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

/**
 * Evaluates a Condition against a BranchPath.
 *
 * Supported condition types:
 *  - `equals` / `not_equals` — compares a field value against a literal
 *  - `greater_than` / `less_than` — numeric comparison
 *  - `contains` — checks array inclusion
 *  - `and` — every sub-condition must be true (vacuous truth when empty)
 *  - `or` — at least one sub-condition must be true (false when empty)
 *
 * Field values are resolved via dot-notation on the BranchPath, e.g.
 * "decisions.length", "decisions.0.choiceId", "decisions.0.atEventId".
 */
export function evaluateCondition(condition: Condition, branchPath: BranchPath): boolean {
  switch (condition.type) {
    case 'equals': {
      const val = getFieldValue(branchPath, condition.field ?? '');
      return val === condition.value;
    }

    case 'not_equals': {
      const val = getFieldValue(branchPath, condition.field ?? '');
      return val !== condition.value;
    }

    case 'greater_than': {
      const val = getFieldValue(branchPath, condition.field ?? '');
      if (typeof val !== 'number' || typeof condition.value !== 'number') return false;
      return val > condition.value;
    }

    case 'less_than': {
      const val = getFieldValue(branchPath, condition.field ?? '');
      if (typeof val !== 'number' || typeof condition.value !== 'number') return false;
      return val < condition.value;
    }

    case 'contains': {
      const val = getFieldValue(branchPath, condition.field ?? '');
      if (!Array.isArray(val)) return false;
      return val.includes(condition.value);
    }

    case 'and': {
      if (!condition.conditions || condition.conditions.length === 0) return true;
      return condition.conditions.every((c) => evaluateCondition(c, branchPath));
    }

    case 'or': {
      if (!condition.conditions || condition.conditions.length === 0) return false;
      return condition.conditions.some((c) => evaluateCondition(c, branchPath));
    }

    default:
      // Unknown condition type — treat as unsatisfied
      return false;
  }
}

/**
 * Core filtering predicate: determines whether a BranchPath is included in a
 * BranchSet.
 *
 * - `{ type: "all" }` → always true
 * - `{ type: "paths" }` → true if branchPath is deep-equal to any path
 * - `{ type: "except" }` → negated inclusion check
 * - `{ type: "condition" }` → delegates to evaluateCondition
 * - Empty branchPath (linear narrative) includes only `{ type: "all" }`.
 */
export function includesPath(branchSet: BranchSet, branchPath: BranchPath): boolean {
  if (branchPath.decisions.length === 0) return branchSet.type === 'all';

  switch (branchSet.type) {
    case 'all':
      return true;

    case 'paths':
      return branchSet.paths.some((p) => branchPathsEqual(p, branchPath));

    case 'except':
      return !includesPath(branchSet.branches, branchPath);

    case 'condition':
      return evaluateCondition(branchSet.condition, branchPath);

    default:
      return false;
  }
}

/**
 * Factory function that builds a BranchPoint.
 *
 * The `existenceCondition` defaults to `{ type: 'all' }` so the branch point
 * is always visible unless explicitly scoped to specific paths.
 */
export function createBranchPoint(
  branchPointId: string,
  atEventId: string,
  description: string,
  choices: BranchChoice[],
): BranchPoint {
  return {
    branchPointId,
    atEventId,
    description,
    choices,
    existenceCondition: { type: 'all' },
  };
}

/**
 * Returns the subset of choices whose conditions are satisfied by the current
 * branch path. Choices without a condition are always available.
 */
export function getAvailableChoices(
  branchPoint: BranchPoint,
  currentBranchPath: BranchPath,
): BranchChoice[] {
  return branchPoint.choices.filter((choice) => {
    if (!choice.condition) return true;
    return evaluateCondition(choice.condition, currentBranchPath);
  });
}
