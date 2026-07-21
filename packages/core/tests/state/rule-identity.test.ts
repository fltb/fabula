// ============================================================================
// rule-identity.test.ts — Rule identity, types, and type definitions
// Tests: RuleId, RuleEpochId, RuleExceptionId, RuleSpecificationId,
// RuleTypeDefinition, RuleSpecification, RuleConstraint structure
// ============================================================================

import { describe, it, expect } from 'vitest';
import type {
  RuleId,
  RuleEpochId,
  RuleExceptionId,
  RuleSpecificationId,
  RuleTypeDefinition,
  RuleSpecification,
  RuleConstraint,
  RulePredicate,
  RuleConstraintKind,
  RuleEnforcement,
  RuleApplicableEffectiveness,
} from '../../src/types/index.js';

describe('Rule identity — type definitions', () => {
  it('should define RuleId as string', () => {
    const id: RuleId = 'widow_purity';
    expect(typeof id).toBe('string');
  });

  it('should define RuleEpochId as string', () => {
    const id: RuleEpochId = 'widow_purity-epoch-1';
    expect(typeof id).toBe('string');
  });

  it('should define RuleExceptionId as string', () => {
    const id: RuleExceptionId = 'exc-001';
    expect(typeof id).toBe('string');
  });

  it('should define RuleSpecificationId as string', () => {
    const id: RuleSpecificationId = 'widow_purity-v1';
    expect(typeof id).toBe('string');
  });
});

describe('Rule identity — RuleTypeDefinition', () => {
  it('should create a valid RuleTypeDefinition', () => {
    const ruleType: RuleTypeDefinition = {
      typeId: 'social_norm_purity',
      name: 'Social Norm: Purity',
      category: 'social',
      ruleClass: 'social_norm',
      defaultConstraints: [],
    };
    expect(ruleType.typeId).toBe('social_norm_purity');
    expect(ruleType.defaultConstraints).toEqual([]);
  });

  it('should accept optional ruleClass', () => {
    const ruleType: RuleTypeDefinition = {
      typeId: 'natural_law_gravity',
      name: 'Gravity',
      category: 'physics',
      defaultConstraints: [],
    };
    expect(ruleType.ruleClass).toBeUndefined();
  });

  it('should hold constraints', () => {
    const constraint: RuleConstraint = {
      constraintId: 'c1',
      kind: 'state_invariant',
      enforcement: 'hard',
      applicableEffectiveness: ['full', 'limited'],
      scope: {},
      predicate: {
        version: '1.0',
        type: 'simple',
        expression: 'entity.effectiveness !== nullified',
      },
    };
    const ruleType: RuleTypeDefinition = {
      typeId: 'game_rule_combat',
      name: 'Combat',
      category: 'game',
      ruleClass: 'game_rule',
      defaultConstraints: [constraint],
    };
    expect(ruleType.defaultConstraints).toHaveLength(1);
    expect(ruleType.defaultConstraints[0].constraintId).toBe('c1');
  });
});

describe('Rule identity — RuleSpecification', () => {
  it('should create a valid RuleSpecification with semantic hash', () => {
    const spec: RuleSpecification = {
      specificationId: 'widow_purity-v2',
      typeRef: { typeId: 'social_norm_purity', version: '1.0' },
      statement: 'A widow must not remarry',
      constraints: [],
      semanticHash: 'abc123def456',
    };
    expect(spec.specificationId).toBe('widow_purity-v2');
    expect(spec.typeRef.typeId).toBe('social_norm_purity');
    expect(spec.semanticHash).toBe('abc123def456');
  });
});

describe('Rule identity — RuleConstraint kinds', () => {
  it('should support all four constraint kinds', () => {
    const kinds: RuleConstraintKind[] = [
      'state_invariant',
      'transition_constraint',
      'precondition_requirement',
      'postcondition_requirement',
    ];
    expect(kinds).toHaveLength(4);
  });

  it('should support all three enforcement channels', () => {
    const channels: RuleEnforcement[] = ['hard', 'audit', 'semantic'];
    expect(channels).toHaveLength(3);
  });

  it('should support effectiveness levels', () => {
    const levels: RuleApplicableEffectiveness[] = ['full', 'limited', 'nullified'];
    expect(levels).toHaveLength(3);
  });

  it('should create a state_invariant constraint', () => {
    const constraint: RuleConstraint = {
      constraintId: 'invariant_1',
      kind: 'state_invariant',
      enforcement: 'hard',
      applicableEffectiveness: ['full'],
      scope: { entityType: 'character' },
      predicate: { version: '1.0', type: 'simple', expression: 'marital_status !== undefined' },
    };
    expect(constraint.kind).toBe('state_invariant');
    expect(constraint.enforcement).toBe('hard');
  });

  it('should create a semantic constraint with hint', () => {
    const constraint: RuleConstraint = {
      constraintId: 'semantic_1',
      kind: 'transition_constraint',
      enforcement: 'semantic',
      applicableEffectiveness: ['full', 'limited'],
      scope: { narrativeContext: 'death_scene' },
      predicate: { version: '1.0', type: 'simple', expression: 'narrative_consistency' },
      semanticHint: 'Check if the death narrative respects the rule',
    };
    expect(constraint.enforcement).toBe('semantic');
    expect(constraint.semanticHint).toBeDefined();
  });

  it('should create a precondition_requirement constraint', () => {
    const constraint: RuleConstraint = {
      constraintId: 'pre_1',
      kind: 'precondition_requirement',
      enforcement: 'hard',
      applicableEffectiveness: ['full', 'limited'],
      scope: {},
      predicate: { version: '1.0', type: 'compiled', expression: 'age >= 18', operators: ['all'] },
    };
    expect(constraint.kind).toBe('precondition_requirement');
    expect(constraint.predicate.operators).toContain('all');
  });
});

describe('Rule identity — RulePredicate', () => {
  it('should support compiled predicates', () => {
    const pred: RulePredicate = {
      version: '2.0',
      type: 'compiled',
      expression: 'select entity where attribute=marital_status value=widowed',
      operators: ['exists'],
    };
    expect(pred.type).toBe('compiled');
    expect(pred.operators).toContain('exists');
  });

  it('should support simple predicates', () => {
    const pred: RulePredicate = {
      version: '1.0',
      type: 'simple',
      expression: 'entity.marital_status === widowed',
    };
    expect(pred.type).toBe('simple');
    expect(pred.operators).toBeUndefined();
  });
});