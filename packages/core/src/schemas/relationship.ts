// ============================================================================
// Novalistically — STATE-2 Relationship Type & Transaction Zod Schemas
// ============================================================================

import { z } from 'zod';

// ——— RelationshipDefinition (first-class entity, original schema) ———

export const relationshipDefinitionSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    participants: z.tuple([z.string(), z.string()]),
    bidirectional: z.boolean(),
    initialState: z
      .object({
        trust: z.number().min(-100).max(100),
        emotionalDistance: z.number().min(0).max(100),
        intensity: z.number().min(0).max(100),
        status: z.string(),
        notes: z.string().optional(),
      })
      .strict(),
    establishedEvent: z.string().optional(),
    breakingEvent: z.string().optional(),
  })
  .strict();

// ——— RelationshipRoleDefinition ———

export const relationshipRoleDefinitionSchema = z
  .object({
    roleId: z.string(),
    label: z.string(),
    minCardinality: z.number().int().min(0),
    maxCardinality: z.number().int().min(1),
    allowedEntityKinds: z.array(z.string()),
    exclusiveGroup: z.string().optional(),
  })
  .strict();

// ——— RelationshipTypeDefinition ———

export const relationshipTypeDefinitionSchema = z
  .object({
    typeId: z.string(),
    label: z.string(),
    description: z.string().optional(),
    roles: z.array(relationshipRoleDefinitionSchema),
    continuityImpact: z.enum(['preserve', 'new_epoch', 'new_relationship']),
  })
  .strict();

// ——— Membership ———

export const membershipSchema = z
  .object({
    membershipId: z.string(),
    entityId: z.string(),
    role: z.string().optional(),
  })
  .strict();

// ——— DimensionWrite ———

export const dimensionWriteSchema = z
  .object({
    dimensionId: z.string(),
    scope: z.enum(['global', 'role', 'member', 'subset', 'positional']),
    value: z.unknown(),
    roleId: z.string().optional(),
    memberId: z.string().optional(),
    position: z.string().optional(),
  })
  .strict();

// ——— DimensionUnset ———

export const dimensionUnsetSchema = z
  .object({
    dimensionId: z.string(),
    scope: z.enum(['global', 'role', 'member', 'subset', 'positional']),
    roleId: z.string().optional(),
    memberId: z.string().optional(),
    position: z.string().optional(),
  })
  .strict();

// ——— RelationshipTransaction ———

export const relationshipTransactionSchema = z
  .object({
    effectId: z.string(),
    relationshipId: z.string(),
    epochId: z.string().optional(),
    lifecycleAfter: z.enum(['active', 'suspended', 'dissolved']).optional(),
    membershipAfter: z.array(membershipSchema),
    dimensionSet: z.array(dimensionWriteSchema).optional(),
    dimensionUnset: z.array(dimensionUnsetSchema).optional(),
    provenance: z.string().optional(),
  })
  .strict();

// ——— IdentityTransitionCarryEntry ———

export const identityTransitionCarryEntrySchema = z
  .object({
    fromDimensionId: z.string(),
    toDimensionId: z.string(),
    fromScope: z.enum(['global', 'role', 'member', 'subset', 'positional']),
    toScope: z.enum(['global', 'role', 'member', 'subset', 'positional']),
  })
  .strict();

// ——— RelationshipIdentityTransitionGroup ———

export const relationshipIdentityTransitionGroupSchema = z
  .object({
    oldEpochClosures: z.array(
      z
        .object({
          relationshipId: z.string(),
          epochId: z.string(),
        })
        .strict(),
    ),
    newTransactions: z.array(relationshipTransactionSchema),
    carryMap: z.array(identityTransitionCarryEntrySchema).optional(),
    provenance: z.string().optional(),
  })
  .strict();
