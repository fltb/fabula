// ============================================================================
// Novalistically — STATE-2 Relationship Type & Transaction Zod Schemas
// ============================================================================

import { z } from 'zod';

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

// ——— RelationshipTypeCatalog (versionless authoring root) ———

export const relationshipTypeCatalogSchema = z
  .object({
    types: z.record(z.string(), relationshipTypeDefinitionSchema),
  })
  .strict()
  .superRefine((catalog, ctx) => {
    for (const [typeId, definition] of Object.entries(catalog.types)) {
      if (typeId !== definition.typeId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['types', typeId, 'typeId'],
          message: `Catalog key ${typeId} must match typeId ${definition.typeId}`,
        });
      }
    }
  });

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
    type: z.literal('relationship_transaction'),
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
    type: z.literal('identity_transition'),
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

// ——— RelationshipDeclaration (versionless authoring source) ———

export const relationshipDeclarationSchema = z
  .object({
    relationshipId: z.string(),
    typeId: z.string(),
    initialEpoch: z
      .object({
        epochId: z.string(),
        lifecycle: z.enum(['active', 'suspended', 'dissolved']),
        memberships: z.array(membershipSchema),
        dimensions: z.array(dimensionWriteSchema),
      })
      .strict(),
    provenance: z.string().optional(),
  })
  .strict();

// ——— Canonical event relationship effect ———

export const relationshipEffectSchema = z.discriminatedUnion('type', [
  relationshipTransactionSchema,
  relationshipIdentityTransitionGroupSchema,
]);
