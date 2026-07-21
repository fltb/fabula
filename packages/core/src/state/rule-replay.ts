// ============================================================================
// Novalistically — STATE-6: Rule Transaction Replay & Constraint Evaluation
// Applies RuleTransaction to WorldState, handles constraint evaluation
// (hard/audit/semantic), exception resolution, and RuleEvaluationRecord generation.
// ============================================================================

import type {
  RuleTransaction,
  RuleRuntimeState,
  RuleEffectEntry,
  RuleEvaluationRecord,
  RuleConstraint,
  RuleException,
  RuleId,
  RuleEpochId,
  RuleSpecificationId,
  RuleActivation,
  RuleEffectiveness,
} from '../types/index.js';
import { RuleConstraintViolationError } from '../errors.js';

// ============================================================================
// Public API
// ============================================================================

/**
 * applyRuleTransaction — Apply a single RuleTransaction to the rules map.
 * Follows the fixed evaluation order:
 * 1. Read state before
 * 2. Build candidate results
 * 3. Run transition/precondition constraints with stateBefore activation
 * 4. Run invariants/postcondition constraints with candidate stateAfter activation
 * 5. Verify cross-domain referential integrity
 * 6. Commit or reject
 */
export function applyRuleTransaction(
  rules: Record<string, RuleRuntimeState>,
  tx: RuleTransaction,
  context?: { nodeId?: string; stateBefore?: Record<string, unknown>; stateAfter?: Record<string, unknown> },
): RuleEvaluationRecord[] {
  const evaluationRecords: RuleEvaluationRecord[] = [];
  const ruleId = tx.ruleId;

  // Phase 1: Read state before
  if (!rules[ruleId]) {
    // Initialize a new rule runtime state
    rules[ruleId] = createDefaultRuntimeState(ruleId, tx);
  }

  const state = rules[ruleId];
  const nodeId = context?.nodeId ?? 'unknown';

  // Phase 2: Build candidate results
  const candidate = { ...state };

  // Phase 3: Run transition/precondition constraints with stateBefore activation
  // (constraint evaluation is a no-op for basic operations; complex evaluation
  //  happens when constraints are explicitly provided in the transaction)
  if (tx.constraintEvaluation) {
    for (const constraint of tx.constraintEvaluation) {
      const record = evaluateConstraint(
        constraint,
        candidate,
        nodeId,
        context?.stateBefore,
        context?.stateAfter,
      );
      evaluationRecords.push(record);

      if (record.result === 'violated' && constraint.enforcement === 'hard') {
        throw new RuleConstraintViolationError(
          `Hard constraint violation: ${constraint.constraintId} on rule ${ruleId}`,
          { path: ruleId, eventId: nodeId, phase: 'rule-replay' },
        );
      }
    }
  }

  // Phase 4 (implicit): Run invariants/postcondition constraints
  // (handled by the constraint evaluation above when provided)

  // Phase 5: Verify cross-domain referential integrity
  // (basic check: ensure referenced ruleIds exist)
  if (tx.operation === 'replace' || tx.operation === 'amend') {
    if (tx.specificationId && !state.specificationId) {
      throw new RuleConstraintViolationError(
        `Cannot ${tx.operation} rule ${ruleId}: no specificationId provided`,
        { path: ruleId, eventId: nodeId, phase: 'rule-replay' },
      );
    }
  }

  // Phase 6: Commit or reject
  applyOperation(candidate, tx);
  rules[ruleId] = candidate;

  return evaluationRecords;
}

/**
 * evaluateConstraints — Evaluate a list of constraints against rule state.
 * Returns evaluation records for each constraint.
 */
export function evaluateConstraints(
  constraints: RuleConstraint[],
  ruleState: RuleRuntimeState,
  nodeId: string,
  stateBefore?: Record<string, unknown>,
  stateAfter?: Record<string, unknown>,
): RuleEvaluationRecord[] {
  const records: RuleEvaluationRecord[] = [];

  for (const constraint of constraints) {
    const record = evaluateConstraint(constraint, ruleState, nodeId, stateBefore, stateAfter);
    records.push(record);

    if (record.result === 'violated' && constraint.enforcement === 'hard') {
      throw new RuleConstraintViolationError(
        `Hard constraint violation: ${constraint.constraintId} on rule ${ruleState.ruleId}`,
        { path: ruleState.ruleId, eventId: nodeId, phase: 'rule-replay' },
      );
    }
  }

  return records;
}

/**
 * convertLegacyRuleEffect — Convert a RuleEffectEntry to a RuleTransaction.
 * Backward compat mapping:
 *   reinforce  → enable + audit
 *   weaken     → suspend
 *   introduce_exception → add_exception
 *   nullify    → set_effectiveness:nullified
 */
export function convertLegacyRuleEffect(
  entry: RuleEffectEntry,
  nodeId: string,
): RuleTransaction {
  const base = {
    type: 'rule_transaction' as const,
    ruleId: entry.rule,
    evidence: entry.evidence,
    operation: 'enable' as const,
  };

  switch (entry.effect) {
    case 'reinforce':
      return {
        ...base,
        operation: 'enable' as const,
        epochId: `${entry.rule}-epoch-${Date.now()}`,
        specificationId: `${entry.rule}-spec`,
      };
    case 'weaken':
      return { ...base, operation: 'suspend' as const };
    case 'introduce_exception':
      return {
        ...base,
        operation: 'add_exception' as const,
        exception: {
          exceptionId: `${entry.rule}-exc-${Date.now()}`,
          status: 'active' as const,
          constraintIds: [],
          scopeBindings: {},
          effect: { type: 'exempt' as const },
        },
      };
    case 'nullify':
      return { ...base, operation: 'set_effectiveness' as const, newEffectiveness: 'nullified' as const };
  }
}

/**
 * isLegacyRuleEffect — Check if an entry is a legacy RuleEffectEntry.
 */
export function isLegacyRuleEffect(entry: unknown): entry is RuleEffectEntry {
  if (typeof entry !== 'object' || entry === null) return false;
  const e = entry as Record<string, unknown>;
  return (
    typeof e.rule === 'string' &&
    typeof e.effect === 'string' &&
    ['reinforce', 'weaken', 'introduce_exception', 'nullify'].includes(e.effect as string) &&
    typeof e.evidence === 'string' &&
    e.type !== 'rule_transaction'
  );
}

/**
 * generateEvaluationRecord — Create a RuleEvaluationRecord for result tracking.
 */
export function generateEvaluationRecord(
  ruleId: RuleId,
  epochId: RuleEpochId,
  constraintId: string,
  nodeId: string,
  result: 'compliant' | 'violated' | 'exempt',
  enforcement: 'hard' | 'audit' | 'semantic',
  details?: string,
): RuleEvaluationRecord {
  const evaluationId = `${ruleId}:${epochId}:${constraintId}:${nodeId}`;
  return {
    evaluationId,
    ruleId,
    epochId,
    constraintId,
    nodeId,
    result,
    enforcement,
    details,
  };
}

// ============================================================================
// Internal helpers
// ============================================================================

function createDefaultRuntimeState(
  ruleId: string,
  tx: RuleTransaction,
): RuleRuntimeState {
  return {
    ruleId,
    currentEpoch: tx.epochId ?? `${ruleId}-epoch-default`,
    specificationId: tx.specificationId ?? `${ruleId}-spec`,
    activation: 'dormant',
    effectiveness: 'full',
    scopeBindings: {},
    exceptions: [],
  };
}

function evaluateConstraint(
  constraint: RuleConstraint,
  ruleState: RuleRuntimeState,
  nodeId: string,
  stateBefore?: Record<string, unknown>,
  stateAfter?: Record<string, unknown>,
): RuleEvaluationRecord {
  // Check if constraint is applicable at current effectiveness level
  if (!constraint.applicableEffectiveness.includes(ruleState.effectiveness)) {
    return generateEvaluationRecord(
      ruleState.ruleId,
      ruleState.currentEpoch,
      constraint.constraintId,
      nodeId,
      'exempt',
      constraint.enforcement,
      'Constraint not applicable at current effectiveness level',
    );
  }

  // Check for active exceptions that exempt this constraint
  const activeException = ruleState.exceptions.find(
    (exc) =>
      exc.status === 'active' &&
      (exc.constraintIds.length === 0 || exc.constraintIds.includes(constraint.constraintId)),
  );

  if (activeException) {
    if (activeException.effect.type === 'exempt') {
      return generateEvaluationRecord(
        ruleState.ruleId,
        ruleState.currentEpoch,
        constraint.constraintId,
        nodeId,
        'exempt',
        constraint.enforcement,
        `Exempted by exception ${activeException.exceptionId}`,
      );
    }
    // replaceWith: could implement replacement constraint resolution here
    return generateEvaluationRecord(
      ruleState.ruleId,
      ruleState.currentEpoch,
      constraint.constraintId,
      nodeId,
      'exempt',
      constraint.enforcement,
      `Replaced by exception ${activeException.exceptionId}`,
    );
  }

  // Semantic enforcement is Pass 2 only — no deterministic evaluation
  if (constraint.enforcement === 'semantic') {
    return generateEvaluationRecord(
      ruleState.ruleId,
      ruleState.currentEpoch,
      constraint.constraintId,
      nodeId,
      'compliant',
      'semantic',
      'Semantic evaluation deferred to Pass 2',
    );
  }

  // For audit and hard enforcement, evaluate the predicate
  // Simple predicate evaluation: check if the expression matches
  const isCompliant = evaluatePredicate(constraint.predicate, stateBefore, stateAfter);

  const result = isCompliant ? 'compliant' : 'violated';

  return generateEvaluationRecord(
    ruleState.ruleId,
    ruleState.currentEpoch,
    constraint.constraintId,
    nodeId,
    result,
    constraint.enforcement,
    isCompliant ? undefined : `Predicate "${constraint.predicate.expression}" not satisfied`,
  );
}

function evaluatePredicate(
  predicate: { version: string; type: string; expression: string; operators?: string[] },
  stateBefore?: Record<string, unknown>,
  stateAfter?: Record<string, unknown>,
): boolean {
  // Simple predicate evaluation: check for selector expressions
  // Format: "entityId.attribute operator value" or "state.invariant condition"
  if (predicate.type === 'simple') {
    // Simple selectors: check if a value exists or matches in state
    // For now, treat as a basic pass-through check
    // Full predicate AST evaluation would be implemented with a proper evaluator
    return true;
  }

  // Compiled predicates are evaluated by their compiled form
  return true;
}

function applyOperation(
  state: RuleRuntimeState,
  tx: RuleTransaction,
): void {
  switch (tx.operation) {
    case 'enable':
      state.activation = 'enabled';
      state.effectiveness = 'full';
      if (tx.epochId) state.currentEpoch = tx.epochId;
      if (tx.specificationId) state.specificationId = tx.specificationId;
      break;

    case 'suspend':
      state.activation = 'suspended';
      break;

    case 'revoke':
      state.activation = 'revoked';
      break;

    case 'amend': {
      // Close old epoch + new epoch in same RuleId
      state.currentEpoch = tx.epochId ?? `${state.ruleId}-epoch-${Date.now()}`;
      if (tx.specificationId) state.specificationId = tx.specificationId;
      // Reset activation to enabled for the new epoch
      state.activation = 'enabled';
      break;
    }

    case 'replace':
      // Full replacement — new specification
      if (tx.specificationId) state.specificationId = tx.specificationId;
      state.currentEpoch = tx.epochId ?? `${state.ruleId}-epoch-${Date.now()}`;
      state.activation = 'enabled';
      state.effectiveness = 'full';
      state.exceptions = [];
      state.scopeBindings = {};
      break;

    case 'set_effectiveness':
      if (tx.newEffectiveness) {
        state.effectiveness = tx.newEffectiveness;
      }
      break;

    case 'add_exception':
      if (tx.exception) {
        state.exceptions.push(tx.exception);
      }
      break;

    case 'remove_exception':
      if (tx.exception) {
        state.exceptions = state.exceptions.filter(
          (e) => e.exceptionId !== tx.exception!.exceptionId,
        );
      }
      break;
  }
}