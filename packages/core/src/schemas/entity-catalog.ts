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
    valueType: z.enum(['string', 'number', 'boolean', 'string_list', 'string_map']),
    valueSchema: z.custom<z.ZodTypeAny>((val) => val instanceof z.ZodType),
    requiredAt: requiredAtSchema,
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

export const entityIntroductionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('initial') }).strict(),
  z
    .object({
      type: z.literal('event'),
      eventId: z.string(),
    })
    .strict(),
]);

export const entityDeclarationSchema = z
  .object({
    entityId: z.string(),
    typeRef: entityTypeRefSchema,
    immutableMetadata: z.object({
      name: z.string(),
      definitionFile: z.string(),
    }),
    introduction: entityIntroductionSchema,
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

// ——— Author-facing Catalog Source (strict, versionless) ———
//
// Strict Zod contract for definitions/entity-types.yaml. No `version` or
// `schemaVersion` fields: files that do not match the current shape fail
// validation with ConfigError — no negotiation, dual reads, or migration.

export const attributeValueTypeSchema = z.enum([
  'string',
  'number',
  'boolean',
  'string_list',
  'string_map',
]);

export const attributeDefinitionSourceSchema = z
  .object({
    attributeId: z.string(),
    valueType: attributeValueTypeSchema,
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

export const entityTypeDefinitionSourceSchema = z
  .object({
    typeId: z.string(),
    kind: z.enum(['character', 'location', 'item', 'concept', 'faction', 'rule']),
    attributes: z.record(z.string(), attributeDefinitionSourceSchema),
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

export const entityTypeCatalogSourceSchema = z
  .object({
    types: z.record(z.string(), entityTypeDefinitionSourceSchema),
  })
  .strict();
