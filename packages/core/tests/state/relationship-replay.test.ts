// ============================================================================
// relationship-replay.test.ts — replay requires declaration/type context
// First establishment must match the declaration epoch; unknown declarations,
// unknown types, unknown epochs, and type drift all fail closed. No 'default'
// type is ever synthesized.
// ============================================================================

import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/errors.js';
import {
  applyRelationshipIdentityTransitionGroup,
  applyRelationshipTransaction,
  type RelationshipReplayContext,
} from '../../src/state/relationship-replay.js';
import type {
  EpochId,
  MembershipId,
  RelationshipDeclaration,
  RelationshipId,
  RelationshipRuntimeState,
  RelationshipTransaction,
  RelationshipTypeCatalog,
} from '../../src/types/relationship.js';

const typeCatalog: RelationshipTypeCatalog = {
  types: {
    friendship: {
      typeId: 'friendship',
      label: 'Friendship',
      roles: [
        {
          roleId: 'member',
          label: 'Member',
          minCardinality: 2,
          maxCardinality: 2,
          allowedEntityKinds: ['character'],
        },
      ],
      continuityImpact: 'preserve',
    },
  },
};

const declaration: RelationshipDeclaration = {
  relationshipId: 'rel_alice_bob',
  typeId: 'friendship',
  initialEpoch: {
    epochId: 'epoch_alice_bob_1',
    lifecycle: 'active',
    memberships: [
      { membershipId: 'mem_alice_1' as MembershipId, entityId: 'alice' },
      { membershipId: 'mem_bob_1' as MembershipId, entityId: 'bob' },
    ],
    dimensions: [{ dimensionId: 'direction', scope: 'global', value: 'alice → bob' }],
  },
};

function context(overrides?: Partial<RelationshipReplayContext>): RelationshipReplayContext {
  return {
    relationshipDeclarations: [declaration],
    relationshipTypeCatalog: typeCatalog,
    ...overrides,
  };
}

function establishTx(): RelationshipTransaction {
  return {
    type: 'relationship_transaction',
    effectId: 'E1_rel_0',
    relationshipId: 'rel_alice_bob' as RelationshipId,
    epochId: 'epoch_alice_bob_1' as EpochId,
    lifecycleAfter: 'active',
    membershipAfter: declaration.initialEpoch.memberships,
    dimensionSet: declaration.initialEpoch.dimensions,
  };
}

describe('applyRelationshipTransaction — declaration/type context', () => {
  it('establishes the first epoch using the declared type, never a default', () => {
    const relationships: Record<RelationshipId, RelationshipRuntimeState> = {};
    applyRelationshipTransaction(relationships, establishTx(), context());
    const relState = relationships['rel_alice_bob' as RelationshipId];
    expect(relState).toBeDefined();
    if (!relState) throw new Error('Expected declared relationship state');
    expect(relState.typeId).toBe('friendship');
    expect(relState.typeId).not.toBe('default');
    expect(relState.activeEpochId).toBe('epoch_alice_bob_1');
    expect(Object.keys(relState.epochs)).toEqual(['epoch_alice_bob_1']);
  });

  it('rejects a transaction for an undeclared relationship', () => {
    const relationships: Record<RelationshipId, RelationshipRuntimeState> = {};
    const tx = { ...establishTx(), relationshipId: 'rel_unknown' as RelationshipId };
    expect(() => applyRelationshipTransaction(relationships, tx, context())).toThrow(ConfigError);
  });

  it('rejects a declared relationship whose type is absent from the catalog', () => {
    const relationships: Record<RelationshipId, RelationshipRuntimeState> = {};
    const unknownType: RelationshipDeclaration = {
      ...declaration,
      typeId: 'rivalry',
    };
    expect(() =>
      applyRelationshipTransaction(
        relationships,
        establishTx(),
        context({
          relationshipDeclarations: [unknownType],
        }),
      ),
    ).toThrow(ConfigError);
  });

  it('rejects first establishment against an epoch not in the declaration', () => {
    const relationships: Record<RelationshipId, RelationshipRuntimeState> = {};
    const tx = { ...establishTx(), epochId: 'epoch_wrong_1' as EpochId };
    expect(() => applyRelationshipTransaction(relationships, tx, context())).toThrow(ConfigError);
  });

  it('never synthesizes an unknown epoch on an existing relationship', () => {
    const relationships: Record<RelationshipId, RelationshipRuntimeState> = {};
    applyRelationshipTransaction(relationships, establishTx(), context());
    const tx: RelationshipTransaction = {
      ...establishTx(),
      effectId: 'E2_rel_0',
      epochId: 'epoch_made_up_2' as EpochId,
    };
    expect(() => applyRelationshipTransaction(relationships, tx, context())).toThrow(ConfigError);
    const relState = relationships['rel_alice_bob' as RelationshipId];
    expect(relState).toBeDefined();
    if (!relState) throw new Error('Expected declared relationship state');
    expect(Object.keys(relState.epochs)).toEqual(['epoch_alice_bob_1']);
  });

  it('rejects a transaction that drifts from the declared relationship type', () => {
    const relationships: Record<RelationshipId, RelationshipRuntimeState> = {};
    applyRelationshipTransaction(relationships, establishTx(), context());
    const rivalryCatalog: RelationshipTypeCatalog = {
      types: {
        ...typeCatalog.types,
        rivalry: {
          typeId: 'rivalry',
          label: 'Rivalry',
          roles: [
            {
              roleId: 'member',
              label: 'Member',
              minCardinality: 2,
              maxCardinality: 2,
              allowedEntityKinds: ['character'],
            },
          ],
          continuityImpact: 'new_epoch',
        },
      },
    };
    const tx: RelationshipTransaction = {
      ...establishTx(),
      effectId: 'E2_rel_0',
      membershipAfter: [
        { membershipId: 'mem_alice_2' as MembershipId, entityId: 'alice' },
        { membershipId: 'mem_bob_2' as MembershipId, entityId: 'bob' },
      ],
    };
    expect(() =>
      applyRelationshipTransaction(
        relationships,
        tx,
        context({
          relationshipDeclarations: [{ ...declaration, typeId: 'rivalry' }],
          relationshipTypeCatalog: rivalryCatalog,
        }),
      ),
    ).toThrow(ConfigError);
  });

  it('keeps a dissolved epoch terminal for a same-membership retrospective restatement', () => {
    const relationships: Record<RelationshipId, RelationshipRuntimeState> = {};
    applyRelationshipTransaction(relationships, establishTx(), context());
    const dissolve: RelationshipTransaction = {
      ...establishTx(),
      effectId: 'E2_dissolve',
      lifecycleAfter: 'dissolved',
      membershipAfter: [],
    };
    applyRelationshipTransaction(relationships, dissolve, context());
    const restatement: RelationshipTransaction = {
      ...establishTx(),
      effectId: 'E3_restatement',
      lifecycleAfter: 'active',
      membershipAfter: [],
    };
    applyRelationshipTransaction(relationships, restatement, context());
    expect(
      relationships['rel_alice_bob' as RelationshipId].epochs.epoch_alice_bob_1.lifecycle,
    ).toBe('dissolved');
  });

  it('rejects a direct dissolved-to-active rewrite with different memberships', () => {
    const relationships: Record<RelationshipId, RelationshipRuntimeState> = {};
    applyRelationshipTransaction(relationships, establishTx(), context());
    applyRelationshipTransaction(
      relationships,
      {
        ...establishTx(),
        effectId: 'E2_dissolve',
        lifecycleAfter: 'dissolved',
        membershipAfter: [],
      },
      context(),
    );
    expect(() =>
      applyRelationshipTransaction(
        relationships,
        {
          ...establishTx(),
          effectId: 'E3_illegal_revival',
          lifecycleAfter: 'active',
          membershipAfter: [{ membershipId: 'mem_alice_2' as MembershipId, entityId: 'alice' }],
        },
        context(),
      ),
    ).toThrow(ConfigError);
  });

  it('establishes a fresh epoch only through an identity transition group', () => {
    const relationships: Record<RelationshipId, RelationshipRuntimeState> = {};
    const newEpochContext = context({
      relationshipTypeCatalog: {
        types: {
          friendship: { ...typeCatalog.types.friendship, continuityImpact: 'new_epoch' },
        },
      },
    });
    applyRelationshipTransaction(relationships, establishTx(), newEpochContext);
    applyRelationshipIdentityTransitionGroup(
      relationships,
      {
        type: 'identity_transition',
        oldEpochClosures: [
          {
            relationshipId: 'rel_alice_bob' as RelationshipId,
            epochId: 'epoch_alice_bob_1' as EpochId,
          },
        ],
        newTransactions: [
          {
            type: 'relationship_transaction',
            effectId: 'E2_new_epoch',
            relationshipId: 'rel_alice_bob' as RelationshipId,
            epochId: 'epoch_alice_bob_2' as EpochId,
            lifecycleAfter: 'active',
            membershipAfter: [
              { membershipId: 'mem_alice_2' as MembershipId, entityId: 'alice' },
              { membershipId: 'mem_bob_2' as MembershipId, entityId: 'bob' },
            ],
          },
        ],
      },
      newEpochContext,
    );
    const state = relationships['rel_alice_bob' as RelationshipId];
    expect(state.epochs.epoch_alice_bob_1.lifecycle).toBe('dissolved');
    expect(state.activeEpochId).toBe('epoch_alice_bob_2');
  });
});
