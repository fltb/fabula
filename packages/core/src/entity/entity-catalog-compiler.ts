// ============================================================================
// Novalistically — Entity Type Catalog Compiler
// ============================================================================
//
// Compiles the author-facing, versionless EntityTypeCatalogSource into a fresh
// runtime EntityTypeCatalog. Every call builds brand-new Zod value schemas, so
// compiled catalogs never share schema instances across calls.
//
// The runtime EntityTypeRef.schemaVersion and catalog `version` are
// implementation-local constants: they never appear in authored YAML, never
// select a migration, and are not a compatibility guarantee — cache identity
// only.
// ============================================================================

import { z } from 'zod';
import { ConfigError } from '../errors.ts';
import type {
  AttributeDefinition,
  AttributeDefinitionSource,
  AttributeValueType,
  EntityTypeCatalog,
  EntityTypeCatalogSource,
  EntityTypeDefinition,
  EntityTypeDefinitionSource,
} from '../types/index.js';

/** Internal runtime catalog version — cache identity only, not author-facing. */
const RUNTIME_CATALOG_VERSION = 1;
/** Internal runtime type schema version — cache identity only, not author-facing. */
const RUNTIME_TYPE_SCHEMA_VERSION = 1;

/**
 * Build a fresh Zod value schema for an authored value type. Called per
 * attribute per compile, so every compiled catalog gets its own instances.
 */
function buildValueSchema(valueType: AttributeValueType): z.ZodTypeAny {
  switch (valueType) {
    case 'string':
      return z.string();
    case 'number':
      return z.number().finite();
    case 'boolean':
      return z.boolean();
    case 'string_list':
      return z.array(z.string());
    case 'string_map':
      return z.record(z.string(), z.string());
  }
}

function compileAttribute(source: AttributeDefinitionSource): AttributeDefinition {
  return {
    attributeId: source.attributeId,
    valueSchema: buildValueSchema(source.valueType),
    requiredAt: source.requiredAt,
    writePolicy: source.writePolicy,
    allowedLifecycleStates: source.allowedLifecycleStates,
    unsetAllowed: source.unsetAllowed,
    semanticRole: source.semanticRole,
    typedReferenceConstraint: source.typedReferenceConstraint,
  };
}

function compileType(source: EntityTypeDefinitionSource): EntityTypeDefinition {
  const attributes: Record<string, AttributeDefinition> = {};
  for (const [attributeId, attributeSource] of Object.entries(source.attributes)) {
    attributes[attributeId] = compileAttribute(attributeSource);
  }
  return {
    typeRef: { typeId: source.typeId, schemaVersion: RUNTIME_TYPE_SCHEMA_VERSION },
    kind: source.kind,
    attributes,
    lifecyclePolicy: source.lifecyclePolicy,
    referenceCapabilities: source.referenceCapabilities,
    typedInvariants: source.typedInvariants,
  };
}

/**
 * Compile an authored entity type catalog source into a fresh runtime catalog.
 *
 * Strict compile-time invariants (all ConfigError):
 * - type record key must equal the declared `typeId`;
 * - attribute record key must equal the declared `attributeId`;
 * - `typedInvariants` must be empty — descriptions are not executable rules.
 *
 * @throws ConfigError on any invariant violation.
 */
export function compileEntityTypeCatalog(source: EntityTypeCatalogSource): EntityTypeCatalog {
  const types: Record<string, EntityTypeDefinition> = {};
  for (const [typeId, typeSource] of Object.entries(source.types)) {
    if (typeSource.typeId !== typeId) {
      throw new ConfigError(
        `Entity type key "${typeId}" does not match declared typeId "${typeSource.typeId}"`,
        { path: `types.${typeId}.typeId` },
      );
    }
    if (typeSource.typedInvariants.length > 0) {
      throw new ConfigError(
        `typedInvariants must be empty for entity type "${typeId}" — descriptions are not executable rules`,
        { path: `types.${typeId}.typedInvariants` },
      );
    }
    for (const [attributeId, attributeSource] of Object.entries(typeSource.attributes)) {
      if (attributeSource.attributeId !== attributeId) {
        throw new ConfigError(
          `Attribute key "${attributeId}" does not match declared attributeId "${attributeSource.attributeId}" for type "${typeId}"`,
          { path: `types.${typeId}.attributes.${attributeId}.attributeId` },
        );
      }
    }
    types[typeId] = compileType(typeSource);
  }
  return { types, version: RUNTIME_CATALOG_VERSION };
}
