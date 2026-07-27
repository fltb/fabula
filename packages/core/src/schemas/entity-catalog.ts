// ============================================================================
// Novalistically — Entity Type Catalog Zod Schemas
// ============================================================================
//
// Serialization schemas for EntityTypeCatalog and EntityDeclarationCatalog.
// Maps are serialized as records for JSON/YAML compatibility.
// ============================================================================

import { z } from 'zod';

// ——— Entity Type Ref ———

export const entityTypeRefSchema = z
  .object({
    typeId: z.string(),
    schemaVersion: z.number().int().positive(),
  })
  .strict();

// ——— Runtime State ———

export const entityRuntimeStateSchema = z.enum(['active', 'inactive', 'retired']);

// ——— Write Policy ———

export const writePolicySchema = z.enum([
  'immutable',
  'write_once',
  'mutable',
  'lifecycle_managed',
]);

// ——— Required At ———

export const requiredAtSchema = z.enum(['introduction', 'activation', 'never']);

// ——— Attribute Definition (serializable form) ———

export const attributeDefinitionSchema = z
  .object({
    attributeId: z.string(),
    valueSchema: z.custom<z.ZodTypeAny>((val) => val instanceof z.ZodType),
    requiredAt: requiredAtSchema,
    writePolicy: writePolicySchema,
    allowedLifecycleStates: z.array(entityRuntimeStateSchema).optional(),
    unsetAllowed: z.boolean(),
    semanticRole: z.string().optional(),
    typedReferenceConstraint: z
      .object({
        targetKind: z.string(),
        targetTypeId: z.string().optional(),
      })
      .optional(),
  })
  .strict();

// ——— Entity Type Definition (serialized as record for attributes) ———

export const entityTypeDefinitionSchema = z
  .object({
    typeRef: entityTypeRefSchema,
    kind: z.enum(['character', 'location', 'item', 'concept', 'faction', 'rule']),
    attributes: z.record(z.string(), attributeDefinitionSchema),
    lifecyclePolicy: z.object({
      allowedTransitions: z.array(z.tuple([entityRuntimeStateSchema, entityRuntimeStateSchema])),
    }),
    referenceCapabilities: z.object({
      defaultEligibility: z.enum(['identity', 'live', 'historical']),
    }),
    typedInvariants: z.array(
      z.object({
        id: z.string(),
        description: z.string(),
      }),
    ),
  })
  .strict();

// ——— Entity Type Catalog (serialized as record for types) ———

export const entityTypeCatalogSchema = z
  .object({
    types: z.record(z.string(), entityTypeDefinitionSchema),
    version: z.number().int().nonnegative(),
  })
  .strict();

// ——— Entity Declaration ———

export const entityDeclarationSchema = z
  .object({
    entityId: z.string(),
    typeRef: entityTypeRefSchema,
    immutableMetadata: z.object({
      name: z.string(),
      definitionFile: z.string(),
    }),
    provenance: z
      .object({
        source: z.string(),
        hash: z.string(),
      })
      .optional(),
  })
  .strict();

// ——— Entity Declaration Catalog ———

export const entityDeclarationCatalogSchema = z
  .object({
    declarations: z.record(z.string(), entityDeclarationSchema),
    version: z.number().int().nonnegative(),
  })
  .strict();
