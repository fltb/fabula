// ============================================================================
// Novalistically — STATE-6: Rule identity, constraints, audit, and semantic规范
// ============================================================================

// ——— Identity types ———

export type RuleId = string;
export type RuleEpochId = string;
export type RuleExceptionId = string;
export type RuleSpecificationId = string;

// ——— RuleTypeDefinition — reusable static schema ———

export type RuleClass =
  | 'natural_law'
  | 'social_norm'
  | 'moral_principle'
  | 'game_rule'
  | 'legal_code';

export interface RuleTypeDefinition {
  typeId: string;
  name: string;
  category: string;
  ruleClass?: RuleClass;
  defaultConstraints: RuleConstraint[];
}
export interface RuleTypeCatalog {
  types: Record<string, RuleTypeDefinition>;
}

// ——— RuleDeclaration — project-level rule declaration ———

export interface RuleSpecificationDeclaration {
  statement: string;
  constraints: RuleConstraint[];
}

export interface RuleDeclaration {
  ruleId: RuleId;
  name: string;
  typeId: string;
  initialEpochId: RuleEpochId;
  initialSpecificationId: RuleSpecificationId;
  initialActivation: RuleActivation;
  initialEffectiveness: RuleEffectiveness;
  scopeBindings: Record<string, unknown>;
  exceptions: RuleException[];
  specifications: Record<RuleSpecificationId, RuleSpecificationDeclaration>;
}

// ——— RuleSpecification — immutable enacted formal semantics ———

export interface RuleSpecification {
  specificationId: RuleSpecificationId;
  typeRef: { typeId: string; version: string };
  statement: string;
  constraints: RuleConstraint[];
  semanticHash: string;
}

// ——— RuleConstraint — four kinds, three enforcement channels ———

export type RuleConstraintKind =
  | 'state_invariant'
  | 'transition_constraint'
  | 'precondition_requirement'
  | 'postcondition_requirement';

export type RuleEnforcement = 'hard' | 'audit' | 'semantic';

export type RuleApplicableEffectiveness = 'full' | 'limited' | 'nullified';

export interface RuleConstraint {
  constraintId: string;
  kind: RuleConstraintKind;
  enforcement: RuleEnforcement;
  applicableEffectiveness: RuleApplicableEffectiveness[];
  scope: Record<string, unknown>;
  predicate: RulePredicate;
  semanticHint?: string;
}

export interface RulePredicate {
  version: string;
  type: 'compiled' | 'simple';
  expression: string;
  operators?: Array<'all' | 'exists' | 'count'>;
}

// ——— RuleRuntimeState — per-rule runtime state ———

export type RuleActivation = 'dormant' | 'enabled' | 'suspended' | 'revoked';
export type RuleEffectiveness = 'full' | 'limited' | 'nullified';

export interface RuleRuntimeState {
  ruleId: RuleId;
  currentEpoch: RuleEpochId;
  specificationId: RuleSpecificationId;
  activation: RuleActivation;
  effectiveness: RuleEffectiveness;
  scopeBindings: Record<string, unknown>;
  exceptions: RuleException[];
}

// ——— RuleEvaluationRecord ———

export type RuleEvaluationResult = 'compliant' | 'violated' | 'exempt';

export interface RuleEvaluationRecord {
  evaluationId: string;
  ruleId: RuleId;
  epochId: RuleEpochId;
  constraintId: string;
  nodeId: string;
  result: RuleEvaluationResult;
  enforcement: RuleEnforcement;
  details?: string;
}

// ——— RuleException ———

export type RuleExceptionStatus = 'active' | 'suspended' | 'revoked';

export type RuleExceptionEffect =
  | { type: 'exempt' }
  | { type: 'replaceWith'; replacementConstraintId: string };

export interface RuleExceptionCondition {
  type: 'fact' | 'expression';
  factId?: string;
  expression?: string;
}

export interface RuleException {
  exceptionId: RuleExceptionId;
  status: RuleExceptionStatus;
  constraintIds: string[];
  scopeBindings: Record<string, unknown>;
  condition?: RuleExceptionCondition;
  effect: RuleExceptionEffect;
}

// ——— RuleTransaction — canonical rule event transaction ———

export type RuleTransactionOperation =
  | 'enable'
  | 'suspend'
  | 'revoke'
  | 'amend'
  | 'replace'
  | 'set_effectiveness'
  | 'add_exception'
  | 'remove_exception';

export interface RuleTransaction {
  type: 'rule_transaction';
  ruleId: RuleId;
  operation: RuleTransactionOperation;
  evidence: string;
  epochId?: RuleEpochId;
  specificationId?: RuleSpecificationId;
  newEffectiveness?: RuleEffectiveness;
  exception?: RuleException;
  constraintEvaluation?: RuleConstraint[];
}
