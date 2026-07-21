// ============================================================================
// EpistemicLedger — Tests for claim management and epistemic state
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  applyClaimTransaction,
  evaluate,
  hasSufficientWarrant,
  recordInformationAct,
} from '../../src/state/knowledge-replay.js';
import { claimKey } from '../../src/types/knowledge.js';
import type {
  EpistemicLedger,
  PropositionCatalog,
  ClaimAssessment,
  ClaimEvidenceRecord,
  InformationAct,
  Proposition,
  WorldState,
} from '../../src/types/index.js';

const emptyWorldState: WorldState = {
  entities: {},
  relationships: {},
  knowledge: {},
  threads: {},
  rules: {},
  facts: [],
};

const emptyCatalog: PropositionCatalog = {
  version: 1,
  propositions: {},
  dependencyGraph: {},
};

describe('EpistemicLedger', () => {
  describe('claim operations', () => {
    it('creates empty ledger', () => {
      const ledger: EpistemicLedger = { claims: {}, bySubject: {}, byProposition: {}, actLog: [] };
      expect(Object.keys(ledger.claims)).toHaveLength(0);
    });

    it('records a settled claim', () => {
      const ledger: EpistemicLedger = { claims: {}, bySubject: {}, byProposition: {}, actLog: [] };
      const assessment: ClaimAssessment = {
        type: 'settled',
        grade: 'know',
        polarity: 'affirmative',
      };
      const evidence: ClaimEvidenceRecord = {
        source: 'direct_experience',
        provenance: ['evt1'],
        acquiredAt: { type: 'absolute' as const, value: 'day_1' },
      };

      const updated = applyClaimTransaction(ledger, 'frodo', 'p_ring_location', assessment, [evidence]);
      const key = claimKey('frodo', 'p_ring_location');

      expect(updated.claims[key]).toBeDefined();
      expect(updated.claims[key].assessment).toEqual(assessment);
      expect(updated.bySubject['frodo']).toContain('p_ring_location');
      expect(updated.byProposition['p_ring_location']).toContain('frodo');
    });

    it('rejects duplicate claim write', () => {
      const assessment: ClaimAssessment = {
        type: 'settled', grade: 'believe', polarity: 'affirmative',
      };
      const evidence: ClaimEvidenceRecord = {
        source: 'testimony', provider: 'gandalf', provenance: ['evt1'],
        acquiredAt: { type: 'absolute' as const, value: 'day_1' },
      };

      const ledger: EpistemicLedger = { claims: {}, bySubject: {}, byProposition: {}, actLog: [] };
      const once = applyClaimTransaction(ledger, 'frodo', 'p1', assessment, [evidence]);
      expect(() => applyClaimTransaction(once, 'frodo', 'p1', assessment, [evidence]))
        .toThrow(/Duplicate claim/);
    });

    it('records a conflcted assessment', () => {
      const assessment: ClaimAssessment = {
        type: 'conflicted',
        affirmations: 2,
        rejections: 1,
      };
      const evidence: ClaimEvidenceRecord[] = [
        { source: 'testimony', provider: 'a', provenance: ['evt1'], acquiredAt: { type: 'absolute' as const, value: 'day_1' } },
        { source: 'testimony', provider: 'b', provenance: ['evt2'], acquiredAt: { type: 'absolute' as const, value: 'day_2' } },
      ];
      const ledger: EpistemicLedger = { claims: {}, bySubject: {}, byProposition: {}, actLog: [] };
      const updated = applyClaimTransaction(ledger, 'sam', 'p2', assessment, evidence);
      const key = claimKey('sam', 'p2');
      expect(updated.claims[key].assessment).toEqual(assessment);
    });

    it('records forgotten state', () => {
      const assessment: ClaimAssessment = { type: 'forgotten' };
      const ledger: EpistemicLedger = { claims: {}, bySubject: {}, byProposition: {}, actLog: [] };
      const updated = applyClaimTransaction(ledger, 'bilbo', 'p_ring', assessment, []);
      const key = claimKey('bilbo', 'p_ring');
      expect(updated.claims[key].assessment.type).toBe('forgotten');
    });

    it('records suspended state', () => {
      const assessment: ClaimAssessment = { type: 'suspended' };
      const ledger: EpistemicLedger = { claims: {}, bySubject: {}, byProposition: {}, actLog: [] };
      const updated = applyClaimTransaction(ledger, 'arwen', 'p_fate', assessment, []);
      const key = claimKey('arwen', 'p_fate');
      expect(updated.claims[key].assessment.type).toBe('suspended');
    });
  });

  describe('evaluate() grounded propositions', () => {
    it('returns true for matching world state', () => {
      const prop: Proposition = {
        kind: 'grounded', id: 'p1', entityId: 'hero', attribute: 'alive', value: true,
      };
      const state = {
        ...emptyWorldState,
        entities: { hero: { alive: true } },
      };
      const ledger: EpistemicLedger = { claims: {}, bySubject: {}, byProposition: {}, actLog: [] };
      expect(evaluate(prop, state, ledger, emptyCatalog)).toBe('true');
    });

    it('returns false for non-matching world state', () => {
      const prop: Proposition = {
        kind: 'grounded', id: 'p1', entityId: 'hero', attribute: 'alive', value: true,
      };
      const state = {
        ...emptyWorldState,
        entities: { hero: { alive: false } },
      };
      const ledger: EpistemicLedger = { claims: {}, bySubject: {}, byProposition: {}, actLog: [] };
      expect(evaluate(prop, state, ledger, emptyCatalog)).toBe('false');
    });

    it('returns indeterminate for unset attribute', () => {
      const prop: Proposition = {
        kind: 'grounded', id: 'p1', entityId: 'hero', attribute: 'age', value: 30,
      };
      const state = {
        ...emptyWorldState,
        entities: { hero: { alive: true } }, // age not set
      };
      const ledger: EpistemicLedger = { claims: {}, bySubject: {}, byProposition: {}, actLog: [] };
      expect(evaluate(prop, state, ledger, emptyCatalog)).toBe('indeterminate');
    });

    it('evaluates "not" quantifier', () => {
      const prop: Proposition = {
        kind: 'grounded', id: 'p1', entityId: 'hero', attribute: 'alive', value: true, quantifier: 'not',
      };
      const state = { ...emptyWorldState, entities: { hero: { alive: false } } };
      const ledger: EpistemicLedger = { claims: {}, bySubject: {}, byProposition: {}, actLog: [] };
      expect(evaluate(prop, state, ledger, emptyCatalog)).toBe('true');
    });
  });

  describe('evaluate() epistemic propositions', () => {
    it('returns true when settled claim matches', () => {
      const ledger: EpistemicLedger = { claims: {}, bySubject: {}, byProposition: {}, actLog: [] };
      const assessment: ClaimAssessment = { type: 'settled', grade: 'know', polarity: 'affirmative' };
      const evidence: ClaimEvidenceRecord = { source: 'direct_experience', provenance: ['e1'], acquiredAt: { type: 'absolute' as const, value: 'day_1' } };
      const updated = applyClaimTransaction(ledger, 'frodo', 'p_ring', assessment, [evidence]);

      const prop: Proposition = {
        kind: 'epistemic', id: 'p_ep', subject: 'frodo', propositionId: 'p_ring', attitude: 'knows',
      };
      expect(evaluate(prop, emptyWorldState, updated, emptyCatalog)).toBe('true');
    });

    it('returns false when attitude does not match', () => {
      const ledger: EpistemicLedger = { claims: {}, bySubject: {}, byProposition: {}, actLog: [] };
      const assessment: ClaimAssessment = { type: 'settled', grade: 'know', polarity: 'affirmative' };
      const evidence: ClaimEvidenceRecord = { source: 'direct_experience', provenance: ['e1'], acquiredAt: { type: 'absolute' as const, value: 'day_1' } };
      const updated = applyClaimTransaction(ledger, 'frodo', 'p_ring', assessment, [evidence]);

      const prop: Proposition = {
        kind: 'epistemic', id: 'p_ep', subject: 'frodo', propositionId: 'p_ring', attitude: 'suspects',
      };
      expect(evaluate(prop, emptyWorldState, updated, emptyCatalog)).toBe('false');
    });

    it('returns indeterminate for absent claim', () => {
      const ledger: EpistemicLedger = { claims: {}, bySubject: {}, byProposition: {}, actLog: [] };
      const prop: Proposition = {
        kind: 'epistemic', id: 'p_ep', subject: 'gollum', propositionId: 'p_ring', attitude: 'knows',
      };
      expect(evaluate(prop, emptyWorldState, ledger, emptyCatalog)).toBe('indeterminate');
    });
  });

  describe('evaluate() act propositions', () => {
    it('returns true when matching act is logged', () => {
      const ledger: EpistemicLedger = { claims: {}, bySubject: {}, byProposition: {}, actLog: [] };
      const act: InformationAct = {
        type: 'testimony',
        actor: 'gandalf',
        recipients: ['frodo'],
        contentPropositions: ['p_ring_danger'],
        timestamp: { type: 'absolute' as const, value: 'day_1' },
        eventId: 'evt1',
      };
      const updated = recordInformationAct(ledger, act);

      const prop: Proposition = {
        kind: 'act', id: 'p_act', actType: 'testimony', actor: 'gandalf', recipients: ['frodo'],
        contentPropositions: ['p_ring_danger'],
      };
      expect(evaluate(prop, emptyWorldState, updated, emptyCatalog)).toBe('true');
    });

    it('returns false when act is not logged', () => {
      const ledger: EpistemicLedger = { claims: {}, bySubject: {}, byProposition: {}, actLog: [] };
      const prop: Proposition = {
        kind: 'act', id: 'p_act', actType: 'perception', actor: 'frodo', recipients: [],
        contentPropositions: ['p_mordor'],
      };
      expect(evaluate(prop, emptyWorldState, ledger, emptyCatalog)).toBe('false');
    });
  });

  describe('evaluate() intensional propositions', () => {
    it('always returns indeterminate', () => {
      const prop: Proposition = {
        kind: 'intensional', id: 'p_int', content: 'A prophecy', domain: 'prophecy',
      };
      const ledger: EpistemicLedger = { claims: {}, bySubject: {}, byProposition: {}, actLog: [] };
      expect(evaluate(prop, emptyWorldState, ledger, emptyCatalog)).toBe('indeterminate');
    });
  });

  describe('hasSufficientWarrant', () => {
    it('direct_experience is sufficient', () => {
      const evidence: ClaimEvidenceRecord[] = [
        { source: 'direct_experience', provenance: ['e1'], acquiredAt: { type: 'absolute' as const, value: 'day_1' } },
      ];
      expect(hasSufficientWarrant(evidence)).toBe(true);
    });

    it('testimony with warrant and provider is sufficient', () => {
      const evidence: ClaimEvidenceRecord[] = [
        { source: 'testimony', warrant: 'witness under oath', provider: 'gandalf', provenance: ['e1'], acquiredAt: { type: 'absolute' as const, value: 'day_1' } },
      ];
      expect(hasSufficientWarrant(evidence)).toBe(true);
    });

    it('testimony without warrant is insufficient', () => {
      const evidence: ClaimEvidenceRecord[] = [
        { source: 'testimony', provider: 'gandalf', provenance: ['e1'], acquiredAt: { type: 'absolute' as const, value: 'day_1' } },
      ];
      expect(hasSufficientWarrant(evidence)).toBe(false);
    });

    it('inference with provenance is sufficient', () => {
      const evidence: ClaimEvidenceRecord[] = [
        { source: 'inference', provenance: ['e1', 'e2'], acquiredAt: { type: 'absolute' as const, value: 'day_1' } },
      ];
      expect(hasSufficientWarrant(evidence)).toBe(true);
    });

    it('default source is insufficient', () => {
      const evidence: ClaimEvidenceRecord[] = [
        { source: 'default', provenance: [], acquiredAt: { type: 'absolute' as const, value: 'day_1' } },
      ];
      expect(hasSufficientWarrant(evidence)).toBe(false);
    });

    it('empty evidence is insufficient', () => {
      expect(hasSufficientWarrant([])).toBe(false);
    });
  });

  describe('information act recording', () => {
    it('appends act to actLog', () => {
      const ledger: EpistemicLedger = { claims: {}, bySubject: {}, byProposition: {}, actLog: [] };
      const act: InformationAct = {
        type: 'perception',
        actor: 'frodo',
        recipients: [],
        contentPropositions: ['p_light'],
        timestamp: { type: 'absolute' as const, value: 'day_1' },
        eventId: 'evt1',
      };
      const updated = recordInformationAct(ledger, act);
      expect(updated.actLog).toHaveLength(1);
      expect(updated.actLog[0].type).toBe('perception');
    });

    it('records multiple acts in order', () => {
      const ledger: EpistemicLedger = { claims: {}, bySubject: {}, byProposition: {}, actLog: [] };
      const act1: InformationAct = { type: 'thought', actor: 'frodo', recipients: [], contentPropositions: ['p1'], timestamp: { type: 'chapter' as const, chapter: 1 }, eventId: 'e1' };
      const act2: InformationAct = { type: 'assertion', actor: 'frodo', recipients: ['sam'], contentPropositions: ['p2'], timestamp: { type: 'chapter' as const, chapter: 2 }, eventId: 'e2' };
      const l1 = recordInformationAct(ledger, act1);
      const l2 = recordInformationAct(l1, act2);
      expect(l2.actLog).toHaveLength(2);
      expect(l2.actLog[0].type).toBe('thought');
      expect(l2.actLog[1].type).toBe('assertion');
    });
  });
});
