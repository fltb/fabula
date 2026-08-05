// ============================================================================
// relationship-contract.test.ts — canonical relationship source contracts
// Strict parsing for RelationshipDeclaration, RelationshipTypeCatalog, and the
// discriminated RelationshipEffect union. Legacy binary shapes must be rejected.
// ============================================================================

import { describe, expect, it } from 'vitest';
import {
  relationshipDeclarationSchema,
  relationshipEffectSchema,
  relationshipTypeCatalogSchema,
} from '../../src/schemas/relationship.js';

const canonicalDeclaration = {
  relationshipId: 'rel_alice_bob',
  typeId: 'friendship',
  initialEpoch: {
    epochId: 'epoch_alice_bob_1',
    lifecycle: 'active',
    memberships: [
      { membershipId: 'mem_alice_1', entityId: 'alice', role: 'member' },
      { membershipId: 'mem_bob_1', entityId: 'bob', role: 'member' },
    ],
    dimensions: [
      { dimensionId: 'direction', scope: 'global', value: 'alice → bob' },
      { dimensionId: 'intensity', scope: 'global', value: 3 },
    ],
  },
  provenance: 'author:chapter-1',
} as const;

const canonicalTransaction = {
  type: 'relationship_transaction',
  effectId: 'E1_rel_0',
  relationshipId: 'rel_alice_bob',
  epochId: 'epoch_alice_bob_1',
  lifecycleAfter: 'active',
  membershipAfter: [
    { membershipId: 'mem_alice_1', entityId: 'alice', role: 'member' },
    { membershipId: 'mem_bob_1', entityId: 'bob', role: 'member' },
  ],
  dimensionSet: [{ dimensionId: 'intensity', scope: 'global', value: 5 }],
} as const;

const canonicalTransitionGroup = {
  type: 'identity_transition',
  oldEpochClosures: [{ relationshipId: 'rel_alice_bob', epochId: 'epoch_alice_bob_1' }],
  newTransactions: [
    {
      ...canonicalTransaction,
      effectId: 'E2_rel_0',
      relationshipId: 'rel_alice_bob_2',
      epochId: 'epoch_alice_bob_2_1',
    },
  ],
  carryMap: [
    {
      fromDimensionId: 'intensity',
      toDimensionId: 'intensity',
      fromScope: 'global',
      toScope: 'global',
    },
  ],
} as const;

const legacyBinaryChange = {
  participants: ['alice', 'bob'],
  effect: 'establish',
  direction: 'alice → bob',
  newState: { type: 'friendship', intensity: 3 },
} as const;

const legacyDefinition = {
  id: 'rel_alice_bob',
  type: 'friendship',
  participants: ['alice', 'bob'],
  bidirectional: true,
  initialState: {
    trust: 40,
    emotionalDistance: 30,
    intensity: 3,
    status: 'active',
  },
} as const;

describe('relationshipDeclarationSchema', () => {
  it('accepts a canonical declaration', () => {
    expect(relationshipDeclarationSchema.safeParse(canonicalDeclaration).success).toBe(true);
  });

  it('accepts an optional provenance', () => {
    const withoutProvenance = {
      relationshipId: canonicalDeclaration.relationshipId,
      typeId: canonicalDeclaration.typeId,
      initialEpoch: canonicalDeclaration.initialEpoch,
    };
    expect(relationshipDeclarationSchema.safeParse(withoutProvenance).success).toBe(true);
  });

  it('rejects the legacy binary RelationshipDefinition shape', () => {
    const result = relationshipDeclarationSchema.safeParse(legacyDefinition);
    expect(result.success).toBe(false);
  });

  it('rejects missing initialEpoch', () => {
    const withoutEpoch = {
      relationshipId: canonicalDeclaration.relationshipId,
      typeId: canonicalDeclaration.typeId,
    };
    expect(relationshipDeclarationSchema.safeParse(withoutEpoch).success).toBe(false);
  });

  it('rejects unknown top-level fields', () => {
    expect(
      relationshipDeclarationSchema.safeParse({ ...canonicalDeclaration, participants: [] })
        .success,
    ).toBe(false);
  });
});

describe('relationshipTypeCatalogSchema', () => {
  it('accepts a catalog whose map keys equal typeId', () => {
    const catalog = {
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
    expect(relationshipTypeCatalogSchema.safeParse(catalog).success).toBe(true);
  });

  it('rejects a catalog whose map key differs from the internal typeId', () => {
    const catalog = {
      types: {
        rivalry: {
          typeId: 'friendship',
          label: 'Friendship',
          roles: [],
          continuityImpact: 'preserve',
        },
      },
    };
    const result = relationshipTypeCatalogSchema.safeParse(catalog);
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = JSON.stringify(result.error.issues);
      expect(message).toContain('must match typeId');
    }
  });
});

describe('relationshipEffectSchema (discriminated union on type)', () => {
  it('accepts a canonical relationship_transaction', () => {
    expect(relationshipEffectSchema.safeParse(canonicalTransaction).success).toBe(true);
  });

  it('accepts an identity_transition group', () => {
    expect(relationshipEffectSchema.safeParse(canonicalTransitionGroup).success).toBe(true);
  });

  it('rejects the legacy binary RelationshipChange shape', () => {
    expect(relationshipEffectSchema.safeParse(legacyBinaryChange).success).toBe(false);
  });

  it('rejects an unknown type discriminator', () => {
    expect(
      relationshipEffectSchema.safeParse({ ...canonicalTransaction, type: 'relationship_effect' })
        .success,
    ).toBe(false);
  });

  it('rejects a transaction missing the required type discriminator', () => {
    const withoutType = {
      effectId: canonicalTransaction.effectId,
      relationshipId: canonicalTransaction.relationshipId,
      epochId: canonicalTransaction.epochId,
      lifecycleAfter: canonicalTransaction.lifecycleAfter,
      membershipAfter: canonicalTransaction.membershipAfter,
      dimensionSet: canonicalTransaction.dimensionSet,
    };
    expect(relationshipEffectSchema.safeParse(withoutType).success).toBe(false);
  });
});
