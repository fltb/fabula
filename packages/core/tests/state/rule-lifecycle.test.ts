// ============================================================================
// rule-lifecycle.test.ts — Rule lifecycle: activation, effectiveness, epochs,
// amend/replace operations, RuleTransaction application
// ============================================================================

import { describe, expect, it } from 'vitest';
import { applyRuleTransaction, convertLegacyRuleEffect } from '../../src/state/rule-replay.js';
import type { RuleException, RuleRuntimeState, RuleTransaction } from '../../src/types/index.js';

function makeEmptyState(): Record<string, RuleRuntimeState> {
  return {};
}

describe('Rule lifecycle — activation', () => {
  it('should enable a rule', () => {
    const rules = makeEmptyState();
    const tx: RuleTransaction = {
      type: 'rule_transaction',
      ruleId: 'test_rule',
      operation: 'enable',
      evidence: 'Rule activated',
    };
    applyRuleTransaction(rules, tx);
    expect(rules.test_rule.activation).toBe('enabled');
    expect(rules.test_rule.effectiveness).toBe('full');
  });

  it('should suspend a rule', () => {
    const rules = makeEmptyState();
    const enable: RuleTransaction = {
      type: 'rule_transaction',
      ruleId: 'test_rule',
      operation: 'enable',
      evidence: 'enable',
    };
    applyRuleTransaction(rules, enable);
    const suspend: RuleTransaction = {
      type: 'rule_transaction',
      ruleId: 'test_rule',
      operation: 'suspend',
      evidence: 'suspend',
    };
    applyRuleTransaction(rules, suspend);
    expect(rules.test_rule.activation).toBe('suspended');
  });

  it('should revoke a rule', () => {
    const rules = makeEmptyState();
    const enable: RuleTransaction = {
      type: 'rule_transaction',
      ruleId: 'test_rule',
      operation: 'enable',
      evidence: 'enable',
    };
    applyRuleTransaction(rules, enable);
    const revoke: RuleTransaction = {
      type: 'rule_transaction',
      ruleId: 'test_rule',
      operation: 'revoke',
      evidence: 'revoke',
    };
    applyRuleTransaction(rules, revoke);
    expect(rules.test_rule.activation).toBe('revoked');
  });
});

describe('Rule lifecycle — effectiveness', () => {
  it('should set effectiveness to nullified', () => {
    const rules = makeEmptyState();
    const enable: RuleTransaction = {
      type: 'rule_transaction',
      ruleId: 'test_rule',
      operation: 'enable',
      evidence: 'enable',
    };
    applyRuleTransaction(rules, enable);
    const nullify: RuleTransaction = {
      type: 'rule_transaction',
      ruleId: 'test_rule',
      operation: 'set_effectiveness',
      evidence: 'nullify',
      newEffectiveness: 'nullified',
    };
    applyRuleTransaction(rules, nullify);
    expect(rules.test_rule.effectiveness).toBe('nullified');
    // Nullification preserves activation and identity
    expect(rules.test_rule.activation).toBe('enabled');
  });

  it('should set effectiveness to limited', () => {
    const rules = makeEmptyState();
    const enable: RuleTransaction = {
      type: 'rule_transaction',
      ruleId: 'test_rule',
      operation: 'enable',
      evidence: 'enable',
    };
    applyRuleTransaction(rules, enable);
    const limit: RuleTransaction = {
      type: 'rule_transaction',
      ruleId: 'test_rule',
      operation: 'set_effectiveness',
      evidence: 'limit',
      newEffectiveness: 'limited',
    };
    applyRuleTransaction(rules, limit);
    expect(rules.test_rule.effectiveness).toBe('limited');
  });
});

describe('Rule lifecycle — epoch management', () => {
  it('should amend a rule (close old epoch, start new)', () => {
    const rules = makeEmptyState();
    const enable: RuleTransaction = {
      type: 'rule_transaction',
      ruleId: 'test_rule',
      operation: 'enable',
      evidence: 'enable',
      epochId: 'epoch-1',
      specificationId: 'spec-v1',
    };
    applyRuleTransaction(rules, enable);
    expect(rules.test_rule.currentEpoch).toBe('epoch-1');

    const amend: RuleTransaction = {
      type: 'rule_transaction',
      ruleId: 'test_rule',
      operation: 'amend',
      evidence: 'amend',
      epochId: 'epoch-2',
      specificationId: 'spec-v2',
    };
    applyRuleTransaction(rules, amend);
    expect(rules.test_rule.currentEpoch).toBe('epoch-2');
    expect(rules.test_rule.specificationId).toBe('spec-v2');
    expect(rules.test_rule.activation).toBe('enabled');
  });

  it('should replace a rule (new epoch, cleared exceptions)', () => {
    const rules = makeEmptyState();
    const enable: RuleTransaction = {
      type: 'rule_transaction',
      ruleId: 'test_rule',
      operation: 'enable',
      evidence: 'enable',
      epochId: 'epoch-1',
    };
    applyRuleTransaction(rules, enable);
    // Add an exception
    const addExc: RuleTransaction = {
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
    };
    applyRuleTransaction(rules, addExc);
    expect(rules.test_rule.exceptions).toHaveLength(1);

    const replace: RuleTransaction = {
      type: 'rule_transaction',
      ruleId: 'test_rule',
      operation: 'replace',
      evidence: 'replace',
      epochId: 'epoch-2',
      specificationId: 'spec-v2',
    };
    applyRuleTransaction(rules, replace);
    expect(rules.test_rule.currentEpoch).toBe('epoch-2');
    expect(rules.test_rule.exceptions).toHaveLength(0); // cleared
  });
});

describe('Rule lifecycle — exception management', () => {
  it('should add an exception', () => {
    const rules = makeEmptyState();
    const enable: RuleTransaction = {
      type: 'rule_transaction',
      ruleId: 'test_rule',
      operation: 'enable',
      evidence: 'enable',
    };
    applyRuleTransaction(rules, enable);
    const exc: RuleException = {
      exceptionId: 'exc-1',
      status: 'active',
      constraintIds: ['c1'],
      scopeBindings: {},
      effect: { type: 'exempt' },
    };
    const addExc: RuleTransaction = {
      type: 'rule_transaction',
      ruleId: 'test_rule',
      operation: 'add_exception',
      evidence: 'add',
      exception: exc,
    };
    applyRuleTransaction(rules, addExc);
    expect(rules.test_rule.exceptions).toHaveLength(1);
    expect(rules.test_rule.exceptions[0].exceptionId).toBe('exc-1');
  });

  it('should remove an exception', () => {
    const rules = makeEmptyState();
    const enable: RuleTransaction = {
      type: 'rule_transaction',
      ruleId: 'test_rule',
      operation: 'enable',
      evidence: 'enable',
    };
    applyRuleTransaction(rules, enable);
    const exc: RuleException = {
      exceptionId: 'exc-1',
      status: 'active',
      constraintIds: [],
      scopeBindings: {},
      effect: { type: 'exempt' },
    };
    applyRuleTransaction(rules, {
      type: 'rule_transaction',
      ruleId: 'test_rule',
      operation: 'add_exception',
      evidence: 'add',
      exception: exc,
    });
    expect(rules.test_rule.exceptions).toHaveLength(1);
    applyRuleTransaction(rules, {
      type: 'rule_transaction',
      ruleId: 'test_rule',
      operation: 'remove_exception',
      evidence: 'remove',
      exception: exc,
    });
    expect(rules.test_rule.exceptions).toHaveLength(0);
  });
});

describe('Rule lifecycle — backward compat (convertLegacyRuleEffect)', () => {
  it('should convert reinforce to enable', () => {
    const tx = convertLegacyRuleEffect(
      { rule: 'test_rule', effect: 'reinforce', evidence: 'test' },
      'event-1',
    );
    expect(tx.operation).toBe('enable');
    expect(tx.ruleId).toBe('test_rule');
  });

  it('should convert weaken to suspend', () => {
    const tx = convertLegacyRuleEffect(
      { rule: 'test_rule', effect: 'weaken', evidence: 'test' },
      'event-1',
    );
    expect(tx.operation).toBe('suspend');
  });

  it('should convert introduce_exception to add_exception', () => {
    const tx = convertLegacyRuleEffect(
      { rule: 'test_rule', effect: 'introduce_exception', evidence: 'test' },
      'event-1',
    );
    expect(tx.operation).toBe('add_exception');
    expect(tx.exception).toBeDefined();
    expect(tx.exception!.effect.type).toBe('exempt');
  });

  it('should convert nullify to set_effectiveness:nullified', () => {
    const tx = convertLegacyRuleEffect(
      { rule: 'test_rule', effect: 'nullify', evidence: 'test' },
      'event-1',
    );
    expect(tx.operation).toBe('set_effectiveness');
    expect(tx.newEffectiveness).toBe('nullified');
  });
});
