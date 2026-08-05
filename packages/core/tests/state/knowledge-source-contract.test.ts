import { describe, expect, it } from 'vitest';
import {
  commonGroundTransactionSchema,
  knowledgeInitialStateSchema,
  knowledgeTransactionSchema,
  propositionCatalogSchema,
} from '../../src/schemas/knowledge.js';

const authoredChapter = { chapter: 1 };
const evidence = {
  source: 'direct_experience' as const,
  acquiredAt: authoredChapter,
  provenance: ['source:E0'],
};

describe('knowledge source contracts', () => {
  it('accepts an explicit claim_write transaction', () => {
    expect(
      knowledgeTransactionSchema.safeParse({
        type: 'claim_write',
        subject: 'narrator',
        propositionId: 'p_location',
        assessment: { type: 'settled', grade: 'know', polarity: 'affirmative' },
        evidence: [evidence],
      }).success,
    ).toBe(true);
  });

  it('accepts an explicit information_act transaction without inferring claims', () => {
    expect(
      knowledgeTransactionSchema.safeParse({
        type: 'information_act',
        actType: 'testimony',
        actor: 'witness',
        recipients: ['narrator'],
        contentPropositions: ['p_location'],
        timestamp: authoredChapter,
      }).success,
    ).toBe(true);
  });

  it('accepts an explicit common_ground transaction', () => {
    expect(
      commonGroundTransactionSchema.safeParse({
        type: 'common_ground',
        propositionId: 'p_location',
        participants: ['narrator', 'witness'],
        establishedAt: authoredChapter,
      }).success,
    ).toBe(true);
  });

  it('rejects unknown transaction variants and unknown fields', () => {
    expect(
      knowledgeTransactionSchema.safeParse({
        type: 'claim_read',
        subject: 'narrator',
        propositionId: 'p_location',
      }).success,
    ).toBe(false);
    expect(
      knowledgeTransactionSchema.safeParse({
        type: 'information_act',
        actType: 'testimony',
        actor: 'witness',
        recipients: [],
        contentPropositions: [],
        timestamp: authoredChapter,
        claims: ['p_location'],
      }).success,
    ).toBe(false);
  });

  it('rejects authored ledger indexes and non-v1 proposition catalogs', () => {
    expect(
      knowledgeInitialStateSchema.safeParse({
        claims: [],
        commonGround: [],
        bySubject: {},
        byProposition: {},
      }).success,
    ).toBe(false);
    expect(
      propositionCatalogSchema.safeParse({
        version: 2,
        propositions: {},
        dependencyGraph: {},
      }).success,
    ).toBe(false);
  });
});
