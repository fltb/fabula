import { describe, expect, it } from 'vitest';
import {
  ruleDeclarationSchema,
  ruleTransactionSchema,
  ruleTypeCatalogSchema,
} from '../../src/schemas/rule.js';

const constraint = {
  constraintId: 'c1',
  kind: 'state_invariant' as const,
  enforcement: 'audit' as const,
  applicableEffectiveness: ['full' as const],
  scope: {},
  predicate: {
    version: '1.0',
    type: 'simple' as const,
    expression: 'entity.status exists',
  },
};

const ruleType = {
  typeId: 'social_norm',
  name: 'Social norm',
  category: 'social',
  defaultConstraints: [constraint],
};

const declaration = {
  ruleId: 'widow_purity',
  name: 'Widow purity',
  typeId: 'social_norm',
  initialEpochId: 'widow_purity-epoch-1',
  initialSpecificationId: 'widow_purity-spec-1',
  initialActivation: 'dormant' as const,
  initialEffectiveness: 'full' as const,
  scopeBindings: {},
  exceptions: [],
  specifications: {
    'widow_purity-spec-1': {
      statement: 'A widow must not touch ritual vessels.',
      constraints: [constraint],
    },
  },
};

describe('canonical rule source contracts', () => {
  it('parses a versionless keyed rule type catalog', () => {
    expect(ruleTypeCatalogSchema.parse({ types: { social_norm: ruleType } })).toEqual({
      types: { social_norm: ruleType },
    });
  });

  it('rejects a catalog map key that differs from its internal typeId', () => {
    expect(ruleTypeCatalogSchema.safeParse({ types: { wrong_key: ruleType } }).success).toBe(false);
  });

  it('parses a canonical declaration without authored semantic hashes', () => {
    expect(ruleDeclarationSchema.parse(declaration)).toEqual(declaration);
    expect(
      ruleDeclarationSchema.safeParse({
        ...declaration,
        specifications: {
          'widow_purity-spec-1': {
            ...declaration.specifications['widow_purity-spec-1'],
            semanticHash: 'authored-is-not-allowed',
          },
        },
      }).success,
    ).toBe(false);
  });

  it('rejects legacy rule declaration fields', () => {
    expect(
      ruleDeclarationSchema.safeParse({
        ruleId: 'widow_purity',
        name: 'Widow purity',
        category: 'ritual_taboo',
        type: 'constraint',
        statement: 'legacy expression declaration',
        logicalConsequences: [],
        evidenceChain: [],
      }).success,
    ).toBe(false);
  });

  it('parses canonical rule transactions and rejects legacy effects', () => {
    expect(
      ruleTransactionSchema.parse({
        type: 'rule_transaction',
        ruleId: 'widow_purity',
        operation: 'enable',
        evidence: 'event evidence',
      }),
    ).toMatchObject({ type: 'rule_transaction', ruleId: 'widow_purity' });

    expect(
      ruleTransactionSchema.safeParse({
        rule: 'widow_purity',
        effect: 'reinforce',
        evidence: 'legacy effect',
      }).success,
    ).toBe(false);
  });
});
