// ============================================================================
// Novalistically — S8: Narrative Planner (reference implementation)
//
// ⚠️  DESIGN CORRECTION (2026-07-24):
// S8 was originally designed as a forward event generator for generative
// writing tools (Novel OS, Sudowrite). However, this system's Novel IR
// processes already-completed novels — all events have already happened.
// There is no "what happens next" to plan. The forward-planner assumption
// does not apply to this architecture.
//
// If this capability is needed in the future, the correct direction is a
// standalone YAML editor module — LLM-assisted human authoring of stable
// YAML from source text (no missing preconditions, no dropped threads,
// no conflicting Facts). Not a forward planner in the core pipeline.
//
// The types (NarrativeGoal, ActionDefinition), algorithms (validatePreconditions,
// suggestEvents), and 18 tests are preserved as reference material.
// ============================================================================

import type { EventFile } from '../types/event.js';
import type { WorldState } from '../types/world.js';
import type {
  ActionDefinition,
  NarrativeGoal,
  Precondition,
} from '../types/planner.js';
import type { ValidationIssue } from '../types/validator.js';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Number of candidates returned by suggestEvents when arcPosition is given */
const SUGGEST_TOP_K_DEFAULT = 5;

/** Weight used when arcPosition matches an ActionDefinition's typicalArcPositions */
const ARC_POSITION_MATCH_WEIGHT = 10;

/** Multiplier for thread priority in ranking score */
const PRIORITY_WEIGHT = 1;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Evaluate a single precondition against the current WorldState.
 * Returns true if the condition holds, false otherwise.
 */
function checkPrecondition(pre: Precondition, world: WorldState): boolean {
  const entityState = world.entities[pre.entity];
  if (!entityState) {
    // Entity not present — only passes for 'not_exists'
    return pre.operator === 'not_exists';
  }

  const actual = entityState[pre.attribute];
  const op = pre.operator ?? 'eq';

  switch (op) {
    case 'eq':
      return actual === pre.value;
    case 'neq':
      return actual !== pre.value;
    case 'gt':
      return typeof actual === 'number' && typeof pre.value === 'number' && actual > pre.value;
    case 'gte':
      return typeof actual === 'number' && typeof pre.value === 'number' && actual >= pre.value;
    case 'lt':
      return typeof actual === 'number' && typeof pre.value === 'number' && actual < pre.value;
    case 'lte':
      return typeof actual === 'number' && typeof pre.value === 'number' && actual <= pre.value;
    case 'contains':
      if (typeof actual === 'string' && typeof pre.value === 'string') {
        return actual.includes(pre.value);
      }
      if (Array.isArray(actual)) {
        return actual.includes(pre.value);
      }
      return false;
    case 'not_contains':
      if (typeof actual === 'string' && typeof pre.value === 'string') {
        return !actual.includes(pre.value);
      }
      return true;
    case 'exists':
      return actual !== undefined;
    case 'not_exists':
      return actual === undefined;
    default:
      return false;
  }
}

/**
 * Build a ValidationIssue for an unsatisfied precondition.
 */
function unsatisfiedIssue(eventId: string, pre: Precondition): ValidationIssue {
  return {
    validator: 'narrative-planner',
    severity: 'warning',
    event: eventId,
    entity: pre.entity,
    attribute: pre.attribute,
    message: `Precondition not satisfied: ${pre.entity}.${pre.attribute} ${pre.operator ?? 'eq'} ${JSON.stringify(pre.value)}`,
    fixSuggestion: 'Ensure the entity attribute matches the precondition before this event, or relax the precondition.',
    fixAction: 'manual',
    fixTarget: { file: '', field: 'preconditions' },
  };
}

// ─── Manual Mode ─────────────────────────────────────────────────────────────

/**
 * Validate event preconditions against the current WorldState.
 * Returns a list of ValidationIssue entries — one warning per unsatisfied
 * precondition. Narrative-hint preconditions (no value) are accepted as-is
 * since they cannot be checked against concrete WorldState values.
 */
export function validatePreconditions(
  event: EventFile,
  worldState: WorldState,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const pre of event.preconditions) {
    // Narrative-hint preconditions have no deterministic value — skip.
    if (pre.narrativeHint !== undefined && pre.value === undefined) continue;

    if (!checkPrecondition(pre as Precondition, worldState)) {
      issues.push(unsatisfiedIssue(event.event, pre as Precondition));
    }
  }

  return issues;
}

// ─── Suggest Mode ────────────────────────────────────────────────────────────

/**
 * Score a candidate ActionDefinition for ranking.
 *   - arcPosition match: +ARC_POSITION_MATCH_WEIGHT if the action's
 *     typicalArcPositions includes the current arc position
 *   - thread priority: +PRIORITY_WEIGHT * goal.priority for each active goal
 *     whose threadId matches a relatedThreadType (generic boost strategy)
 *
 * Higher score = more recommended.
 */
function scoreCandidate(
  action: ActionDefinition,
  goals: NarrativeGoal[],
  arcPosition?: string,
): number {
  let score = 0;

  // Arc position match
  if (arcPosition && action.typicalArcPositions.includes(arcPosition)) {
    score += ARC_POSITION_MATCH_WEIGHT;
  }

  // Thread priority boost
  for (const goal of goals) {
    if (
      action.relatedThreadTypes &&
      action.relatedThreadTypes.includes(goal.threadId)
    ) {
      score += PRIORITY_WEIGHT * goal.priority;
    }
  }

  return score;
}

/**
 * Find ActionDefinitions whose preconditions all match the current WorldState
 * and rank them by arcPosition fit + thread priority.
 *
 * @param worldState  Current world state for precondition evaluation
 * @param goals       Active narrative goals to boost related candidates
 * @param actionDefs  Full catalog of available action definitions
 * @param arcPosition Optional current arc position for position-based ranking
 * @returns Top-K ActionDefinitions sorted by descending score
 */
export function suggestEvents(
  worldState: WorldState,
  goals: NarrativeGoal[],
  actionDefs: ActionDefinition[],
  arcPosition?: string,
): ActionDefinition[] {
  // Filter: only actions whose preconditions are all satisfied
  const candidates = actionDefs.filter((action) => {
    // No preconditions = always available
    if (action.preconditions.length === 0) return true;

    return action.preconditions.every((pre) => {
      // Narrative-hint preconditions are assumed satisfied
      if (pre.narrativeHint !== undefined && pre.value === undefined) return true;
      return checkPrecondition(pre, worldState);
    });
  });

  // Score and sort descending
  const scored = candidates
    .map((action) => ({
      action,
      score: scoreCandidate(action, goals, arcPosition),
    }))
    .sort((a, b) => b.score - a.score);

  // Return top-K
  return scored.slice(0, SUGGEST_TOP_K_DEFAULT).map((s) => s.action);
}

// ─── Auto Mode ───────────────────────────────────────────────────────────────

/**
 * AUTO mode — research-grade, deferred.
 * This stub serves as a placeholder for future automated event chain generation.
 */
export function autoGenerate(
  _worldState: WorldState,
  _goals: NarrativeGoal[],
  _actionDefs: ActionDefinition[],
): ActionDefinition[] {
  // AUTO mode — research-grade, deferred
  return [];
}
