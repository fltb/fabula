// ============================================================================
// NarrativeKnowledgeBoundary — Tests for focalizer-claim filtering and
// group epistemic forms
// ============================================================================

import { describe, expect, it } from 'vitest';
import {
  applyClaimTransaction,
  applyKnowledgeBoundary,
  evaluateGroupEpistemic,
} from '../../src/state/knowledge-replay.js';
import type {
  ClaimAssessment,
  ClaimEvidenceRecord,
  EpistemicLedger,
} from '../../src/types/index.js';

const settledKnow: ClaimAssessment = {
  type: 'settled',
  grade: 'know',
  polarity: 'affirmative',
};
const settledBelieve: ClaimAssessment = {
  type: 'settled',
  grade: 'believe',
  polarity: 'affirmative',
};
const forgotten: ClaimAssessment = { type: 'forgotten' };

const evidence: ClaimEvidenceRecord[] = [
  {
    source: 'direct_experience',
    provenance: ['evt1'],
    acquiredAt: { type: 'absolute' as const, value: 'day_1' },
  },
];

function buildLedgerWithClaims(): EpistemicLedger {
  let ledger: EpistemicLedger = {
    claims: {},
    bySubject: {},
    byProposition: {},
    actLog: [],
  };
  ledger = applyClaimTransaction(ledger, 'frodo', 'p_ring', settledKnow, evidence);
  ledger = applyClaimTransaction(ledger, 'frodo', 'p_mordor', settledBelieve, evidence);
  ledger = applyClaimTransaction(ledger, 'sam', 'p_ring', settledKnow, evidence);
  ledger = applyClaimTransaction(ledger, 'gollum', 'p_ring', forgotten, evidence);
  return ledger;
}

describe('NarrativeKnowledgeBoundary', () => {
  describe('applyKnowledgeBoundary', () => {
    it('filters ledger to allowlisted claims only', () => {
      const ledger = buildLedgerWithClaims();
      const boundary = {
        focalizer: 'frodo',
        allowlistedClaims: ['frodo:p_ring', 'frodo:p_mordor'],
      };
      const filtered = applyKnowledgeBoundary(ledger, boundary);
      expect(Object.keys(filtered.claims)).toHaveLength(2);
      expect(filtered.claims['frodo:p_ring']).toBeDefined();
      expect(filtered.claims['frodo:p_mordor']).toBeDefined();
    });

    it('excludes non-allowlisted claims', () => {
      const ledger = buildLedgerWithClaims();
      const boundary = {
        focalizer: 'frodo',
        allowlistedClaims: ['frodo:p_ring'],
      };
      const filtered = applyKnowledgeBoundary(ledger, boundary);
      expect(Object.keys(filtered.claims)).toHaveLength(1);
      expect(filtered.claims['sam:p_ring']).toBeUndefined();
    });

    it('excludes forgotten, suspended, and unset claims', () => {
      const ledger = buildLedgerWithClaims();
      const boundary = {
        focalizer: 'gollum',
        allowlistedClaims: ['gollum:p_ring'],
      };
      const filtered = applyKnowledgeBoundary(ledger, boundary);
      // 'gollum:p_ring' is forgotten → excluded
      expect(filtered.claims['gollum:p_ring']).toBeUndefined();
    });

    it('empty allowlist produces empty filtered ledger', () => {
      const ledger = buildLedgerWithClaims();
      const boundary = {
        focalizer: 'frodo',
        allowlistedClaims: [],
      };
      const filtered = applyKnowledgeBoundary(ledger, boundary);
      expect(Object.keys(filtered.claims)).toHaveLength(0);
    });

    it('maintains indices in filtered ledger', () => {
      const ledger = buildLedgerWithClaims();
      const boundary = {
        focalizer: 'frodo',
        allowlistedClaims: ['frodo:p_ring', 'frodo:p_mordor'],
      };
      const filtered = applyKnowledgeBoundary(ledger, boundary);
      expect(filtered.bySubject['frodo']).toContain('p_ring');
      expect(filtered.bySubject['frodo']).toContain('p_mordor');
      expect(filtered.byProposition['p_ring']).toContain('frodo');
    });
  });

  describe('evaluateGroupEpistemic', () => {
    it('institutional: checks group entity claim', () => {
      const ledger = buildLedgerWithClaims();
      // 'fellowship' group claim would be under the group entity ID
      const result = evaluateGroupEpistemic(
        { mode: 'institutional', propositionId: 'p_ring', audience: ['fellowship'] },
        ledger,
      );
      // No claim for fellowship:p_ring → false
      expect(result).toBe(false);
    });

    it('distributed: true if any member has claim', () => {
      const ledger = buildLedgerWithClaims();
      const result = evaluateGroupEpistemic(
        { mode: 'distributed', propositionId: 'p_ring', audience: ['frodo', 'sam', 'gollum'] },
        ledger,
      );
      // frodo and sam both have claims on p_ring → true
      expect(result).toBe(true);
    });

    it('distributed: false if no member has claim', () => {
      const ledger = buildLedgerWithClaims();
      const result = evaluateGroupEpistemic(
        { mode: 'distributed', propositionId: 'p_mordor', audience: ['sam'] },
        ledger,
      );
      // sam does not have a claim on p_mordor → false
      expect(result).toBe(false);
    });

    it('mutual: true if all members have settled claim', () => {
      const ledger = buildLedgerWithClaims();
      const result = evaluateGroupEpistemic(
        { mode: 'mutual', propositionId: 'p_ring', audience: ['frodo', 'sam'] },
        ledger,
      );
      // Both frodo and sam have settled claims → true
      expect(result).toBe(true);
    });

    it('mutual: false if any member lacks claim', () => {
      const ledger = buildLedgerWithClaims();
      const result = evaluateGroupEpistemic(
        { mode: 'mutual', propositionId: 'p_ring', audience: ['frodo', 'sam', 'gollum'] },
        ledger,
      );
      // Gollum's claim is forgotten → not settled → false
      expect(result).toBe(false);
    });

    it('mutual: false for empty audience (no vacuous truth)', () => {
      const ledger = buildLedgerWithClaims();
      const result = evaluateGroupEpistemic(
        { mode: 'mutual', propositionId: 'p_ring', audience: [] },
        ledger,
      );
      expect(result).toBe(false);
    });
  });
});
