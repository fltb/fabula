// ============================================================================
// rule-exception.test.ts — RuleException lifecycle, status transitions,
// constraint replacement, epoch isolation
// ============================================================================

import { describe, expect, it } from 'vitest';
import { applyRuleTransaction, evaluateConstraints } from '../../src/state/rule-replay.js';
import type { RuleConstraint, RuleException, RuleRuntimeState } from '../../src/types/index.js';

function makeRuleState(overrides: Partial<RuleRuntimeState> = {}): RuleRuntimeState {
  return {
    ruleId: 'test_rule',
    currentEpoch: 'epoch-1',
    specificationId: 'spec-v1',
    activation: 'enabled',
    effectiveness: 'full',
    scopeBindings: {},
    exceptions: [],
    ...overrides,
  };
}

describe('RuleException — structure', () => {
  it('should define an exception with exempt effect', () => {
    const exc: RuleException = {
      exceptionId: 'exc-001',
      status: 'active',
      constraintIds: ['c1', 'c2'],
      scopeBindings: { entityId: 'xianglin_sao' },
      effect: { type: 'exempt' },
    };
    expect(exc.exceptionId).toBe('exc-001');
    expect(exc.status).toBe('active');
    expect(exc.effect.type).toBe('exempt');
  });

  it('should define an exception with replaceWith effect', () => {
    const exc: RuleException = {
      exceptionId: 'exc-002',
      status: 'active',
      constraintIds: ['c3'],
      scopeBindings: {},
      effect: { type: 'replaceWith', replacementConstraintId: 'c4_alt' },
    };
    expect(exc.effect.type).toBe('replaceWith');
    if (exc.effect.type === 'replaceWith') {
      expect(exc.effect.replacementConstraintId).toBe('c4_alt');
    }
  });

  it('should define an exception with condition', () => {
    const exc: RuleException = {
      exceptionId: 'exc-003',
      status: 'active',
      constraintIds: ['c5'],
      scopeBindings: {},
      condition: { type: 'fact', factId: 'fact_001' },
      effect: { type: 'exempt' },
    };
    expect(exc.condition).toBeDefined();
    expect(exc.condition?.type).toBe('fact');
  });
});

describe('RuleException — status lifecycle', () => {
  it('should start active', () => {
    const exc: RuleException = {
      exceptionId: 'exc-001',
      status: 'active',
      constraintIds: [],
      scopeBindings: {},
      effect: { type: 'exempt' },
    };
    expect(exc.status).toBe('active');
  });

  it('can be suspended', () => {
    const exc: RuleException = {
      exceptionId: 'exc-001',
      status: 'suspended',
      constraintIds: [],
      scopeBindings: {},
      effect: { type: 'exempt' },
    };
    expect(exc.status).toBe('suspended');
  });

  it('can be revoked', () => {
    const exc: RuleException = {
      exceptionId: 'exc-001',
      status: 'revoked',
      constraintIds: [],
      scopeBindings: {},
      effect: { type: 'exempt' },
    };
    expect(exc.status).toBe('revoked');
  });
});

describe('RuleException — constraint exemption', () => {
  it('should exempt constraints listed in exception', () => {
    const constraint: RuleConstraint = {
      constraintId: 'c1',
      kind: 'state_invariant',
      enforcement: 'hard',
      applicableEffectiveness: ['full'],
      scope: {},
      predicate: { version: '1.0', type: 'simple', expression: 'no_match' },
    };
    const state = makeRuleState({
      exceptions: [
        {
          exceptionId: 'exc-1',
          status: 'active',
          constraintIds: ['c1'],
          scopeBindings: {},
          effect: { type: 'exempt' },
        },
      ],
    });
    const records = evaluateConstraints([constraint], state, 'node-1');
    expect(records[0].result).toBe('exempt');
  });

  it('should only exempt the specific constraint', () => {
    const constraints: RuleConstraint[] = [
      {
        constraintId: 'c1',
        kind: 'state_invariant',
        enforcement: 'hard',
        applicableEffectiveness: ['full'],
        scope: {},
        predicate: { version: '1.0', type: 'simple', expression: 'true' },
      },
      {
        constraintId: 'c2',
        kind: 'transition_constraint',
        enforcement: 'hard',
        applicableEffectiveness: ['full'],
        scope: {},
        predicate: { version: '1.0', type: 'simple', expression: 'true' },
      },
    ];
    const state = makeRuleState({
      exceptions: [
        {
          exceptionId: 'exc-c1-only',
          status: 'active',
          constraintIds: ['c1'],
          scopeBindings: {},
          effect: { type: 'exempt' },
        },
      ],
    });
    const records = evaluateConstraints(constraints, state, 'node-1');
    expect(records[0].result).toBe('exempt'); // c1 exempted
    expect(records[1].result).toBe('compliant'); // c2 not exempted
  });
});

describe('RuleException — epoch isolation', () => {
  it('should not carry exceptions across epochs automatically', () => {
    const rules: Record<string, RuleRuntimeState> = {};
    // Enable rule with an exception
    applyRuleTransaction(rules, {
      type: 'rule_transaction',
      ruleId: 'test_rule',
      operation: 'enable',
      evidence: 'enable',
      epochId: 'epoch-1',
    });
    applyRuleTransaction(rules, {
      type: 'rule_transaction',
      ruleId: 'test_rule',
      operation: 'add_exception',
      evidence: 'add',
      exception: {
        exceptionId: 'exc-1',
        status: 'active',
        constraintIds: [],
        scopeBindings: {},
        effect: { type: 'exempt' },
      },
    });
    expect(rules.test_rule.exceptions).toHaveLength(1);

    // Replace (new epoch) — exceptions are cleared
    applyRuleTransaction(rules, {
      type: 'rule_transaction',
      ruleId: 'test_rule',
      operation: 'replace',
      evidence: 'replace',
      epochId: 'epoch-2',
      specificationId: 'spec-v2',
    });
    expect(rules.test_rule.exceptions).toHaveLength(0);
  });
});

describe('RuleException — scope bindings', () => {
  it('should carry scope bindings', () => {
    const exc: RuleException = {
      exceptionId: 'exc-scoped',
      status: 'active',
      constraintIds: ['c1'],
      scopeBindings: {
        entityId: 'xianglin_sao',
        location: 'luchen_town',
        timePeriod: 'winter_solstice',
      },
      effect: { type: 'exempt' },
    };
    expect(exc.scopeBindings.entityId).toBe('xianglin_sao');
    expect(exc.scopeBindings.location).toBe('luchen_town');
  });
});

describe('RuleException — replaceWith effect', () => {
  it('should produce exempt result with replacement info', () => {
    const constraint: RuleConstraint = {
      constraintId: 'c1',
      kind: 'state_invariant',
      enforcement: 'hard',
      applicableEffectiveness: ['full'],
      scope: {},
      predicate: { version: '1.0', type: 'simple', expression: 'no_match' },
    };
    const state = makeRuleState({
      exceptions: [
        {
          exceptionId: 'exc-replace',
          status: 'active',
          constraintIds: ['c1'],
          scopeBindings: {},
          effect: { type: 'replaceWith', replacementConstraintId: 'c1_alt' },
        },
      ],
    });
    const records = evaluateConstraints([constraint], state, 'node-1');
    expect(records[0].result).toBe('exempt');
    expect(records[0].details).toContain('exc-replace');
  });
});
