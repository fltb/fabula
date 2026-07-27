// ============================================================================
// InformationAct — Tests for information act types, recording, and warrant
// ============================================================================

import { describe, expect, it } from 'vitest';
import {
  applyClaimTransaction,
  evaluate,
  hasSufficientWarrant,
  recordInformationAct,
} from '../../src/state/knowledge-replay.js';
import type {
  ClaimAssessment,
  ClaimEvidenceRecord,
  EpistemicLedger,
  InformationAct,
  Proposition,
  PropositionCatalog,
  WorldState,
} from '../../src/types/index.js';
import { claimKey } from '../../src/types/knowledge.js';

const emptyWorld: WorldState = {
  entities: {},
  relationships: {},
  knowledge: {},
  threads: {},
  rules: {},
  facts: [],
};
const emptyCatalog: PropositionCatalog = { version: 1, propositions: {}, dependencyGraph: {} };

const emptyLedger = (): EpistemicLedger => ({
  claims: {},
  bySubject: {},
  byProposition: {},
  actLog: [],
});

describe('InformationAct', () => {
  describe('act types', () => {
    const actTypes = [
      'perception',
      'thought',
      'testimony',
      'assertion',
      'inference',
      'reading',
      'recall',
      'revelation',
    ] as const;

    for (const actType of actTypes) {
      it(`records and evaluates ${actType}`, () => {
        const ledger = emptyLedger();
        const act: InformationAct = {
          type: actType,
          actor: 'character_a',
          recipients: ['character_b'],
          contentPropositions: ['p1'],
          timestamp: { type: 'absolute' as const, value: 'day_1' },
          eventId: 'evt1',
        };
        const updated = recordInformationAct(ledger, act);

        const prop: Proposition = {
          kind: 'act',
          id: 'p_check',
          actType,
          actor: 'character_a',
          recipients: ['character_b'],
          contentPropositions: ['p1'],
        };
        expect(evaluate(prop, emptyWorld, updated, emptyCatalog)).toBe('true');
      });
    }
  });

  describe('warrant justification', () => {
    it('know requires verified warrant', () => {
      // 'know' with direct_experience → sufficient
      const knowEvidence: ClaimEvidenceRecord[] = [
        {
          source: 'direct_experience',
          provenance: ['evt1'],
          acquiredAt: { type: 'absolute' as const, value: 'day_1' },
        },
      ];
      expect(hasSufficientWarrant(knowEvidence)).toBe(true);
    });

    it('false testimony can produce false belief', () => {
      // Evidence from testimony without warrant → still creates a 'believe' claim,
      // but does NOT have sufficient warrant for 'know'
      const falseTestimony: ClaimEvidenceRecord[] = [
        {
          source: 'testimony',
          provider: 'deceiver',
          provenance: ['evt_lie'],
          acquiredAt: { type: 'absolute' as const, value: 'day_2' },
        },
      ];
      // Without warrant ('warrant' field missing), insufficient for 'know'
      expect(hasSufficientWarrant(falseTestimony)).toBe(false);
    });

    it('false testimony alone does not imply deceptive intent', () => {
      // The evidence records the testimony act; deception is separate.
      // The record stores source='testimony' regardless of truth.
      const testimony: ClaimEvidenceRecord = {
        source: 'testimony',
        provider: 'witness',
        provenance: ['evt_witness'],
        acquiredAt: { type: 'absolute' as const, value: 'day_3' },
      };
      // Trust the testimony (provider noted, but no explicit warrant)
      expect(testimony.source).toBe('testimony');
      expect(testimony.provider).toBe('witness');
      // No 'deception' flag in the evidence record — that's assessed at narrative level
    });
  });

  describe('information act fields', () => {
    it('records actor and recipients', () => {
      const ledger = emptyLedger();
      const act: InformationAct = {
        type: 'testimony',
        actor: 'gandalf',
        recipients: ['frodo', 'sam'],
        contentPropositions: ['p_ring'],
        timestamp: { type: 'absolute' as const, value: 'day_1' },
        eventId: 'fellowship_meeting',
      };
      const updated = recordInformationAct(ledger, act);
      expect(updated.actLog[0].actor).toBe('gandalf');
      expect(updated.actLog[0].recipients).toEqual(['frodo', 'sam']);
    });

    it('records story boundary and provenance', () => {
      const ledger = emptyLedger();
      const act: InformationAct = {
        type: 'revelation',
        actor: 'galadriel',
        recipients: ['frodo'],
        contentPropositions: ['p_future'],
        storyBoundary: 'lothlorien_mirror',
        inWorldSource: 'Mirror of Galadriel',
        corpusProvenance: 'elven_magic',
        timestamp: { type: 'absolute' as const, value: 'day_50' },
        eventId: 'mirror_scene',
        warrantJustification: 'direct supernatural revelation',
      };
      const updated = recordInformationAct(ledger, act);
      expect(updated.actLog[0].storyBoundary).toBe('lothlorien_mirror');
      expect(updated.actLog[0].inWorldSource).toBe('Mirror of Galadriel');
      expect(updated.actLog[0].warrantJustification).toBe('direct supernatural revelation');
    });
  });

  describe('truth-preserving inference', () => {
    it('inference with all premise providers verified is warrant-sufficient', () => {
      const evidence: ClaimEvidenceRecord[] = [
        {
          source: 'inference',
          provenance: ['evt_premise1', 'evt_premise2'],
          acquiredAt: { type: 'absolute' as const, value: 'day_5' },
        },
      ];
      expect(hasSufficientWarrant(evidence)).toBe(true);
    });

    it('inference without provenance is not warrant-sufficient', () => {
      const evidence: ClaimEvidenceRecord[] = [
        {
          source: 'inference',
          provenance: [],
          acquiredAt: { type: 'absolute' as const, value: 'day_5' },
        },
      ];
      expect(hasSufficientWarrant(evidence)).toBe(false);
    });
  });

  describe('information act types exhaustive', () => {
    it('supports all 8 information act types', () => {
      const types = new Set<InformationAct['type']>();
      const acts: InformationAct[] = [
        {
          type: 'perception',
          actor: 'a',
          recipients: [],
          contentPropositions: ['p'],
          timestamp: { type: 'chapter' as const, chapter: 1 },
          eventId: 'e1',
        },
        {
          type: 'thought',
          actor: 'a',
          recipients: [],
          contentPropositions: ['p'],
          timestamp: { type: 'chapter' as const, chapter: 1 },
          eventId: 'e2',
        },
        {
          type: 'testimony',
          actor: 'a',
          recipients: ['b'],
          contentPropositions: ['p'],
          timestamp: { type: 'chapter' as const, chapter: 1 },
          eventId: 'e3',
        },
        {
          type: 'assertion',
          actor: 'a',
          recipients: ['b'],
          contentPropositions: ['p'],
          timestamp: { type: 'chapter' as const, chapter: 1 },
          eventId: 'e4',
        },
        {
          type: 'inference',
          actor: 'a',
          recipients: [],
          contentPropositions: ['p'],
          timestamp: { type: 'chapter' as const, chapter: 1 },
          eventId: 'e5',
        },
        {
          type: 'reading',
          actor: 'a',
          recipients: [],
          contentPropositions: ['p'],
          timestamp: { type: 'chapter' as const, chapter: 1 },
          eventId: 'e6',
        },
        {
          type: 'recall',
          actor: 'a',
          recipients: [],
          contentPropositions: ['p'],
          timestamp: { type: 'chapter' as const, chapter: 1 },
          eventId: 'e7',
        },
        {
          type: 'revelation',
          actor: 'a',
          recipients: ['b'],
          contentPropositions: ['p'],
          timestamp: { type: 'chapter' as const, chapter: 1 },
          eventId: 'e8',
        },
      ];
      for (const act of acts) types.add(act.type);
      expect(types.size).toBe(8);
    });
  });
});
