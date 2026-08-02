// ============================================================================
// Novalistically — Entity Type & Declaration Catalog Types
// ============================================================================
//
// STATE-3a: Three-layer separation:
// 1. EntityTypeCatalog — static, versioned schema (NOT entities, NOT in WorldState)
// 2. EntityDeclarationCatalog — stable entityId + typeRef + immutable metadata
// 3. WorldState.entities[entityId] — runtime instances
// ============================================================================

import type { z } from 'zod';
import type { EntityId, EntityKind, EntityRuntimeState, EntityTypeRef } from './entity.js';

// ——— Attribute Definition ———

export type WritePolicy = 'immutable' | 'write_once' | 'mutable' | 'lifecycle_managed';

export type RequiredAt = 'introduction' | 'activation' | 'never';

export type AttributeValueType = 'string' | 'number' | 'boolean' | 'string_list' | 'string_map';

export interface AttributeDefinition {
  attributeId: string;
  valueType: AttributeValueType;
  requiredAt: RequiredAt;
  writePolicy: WritePolicy;
  allowedLifecycleStates?: EntityRuntimeState[];
  unsetAllowed: boolean;
  semanticRole?: string;
  typedReferenceConstraint?: { targetKind: EntityKind; targetTypeId?: string };
}

/** Package-private runtime attribute definition retaining executable validation. */
export interface RuntimeAttributeDefinition extends AttributeDefinition {
  valueSchema: z.ZodTypeAny;
}

// ——— Entity Type Definition ———

export interface EntityTypeDefinition {
  typeRef: EntityTypeRef;
  kind: EntityKind;
  /** Static key-value mapping — use Record per project convention */
  attributes: Record<string, AttributeDefinition>;
  lifecyclePolicy: {
    allowedTransitions: Array<[EntityRuntimeState, EntityRuntimeState]>;
  };
  referenceCapabilities: {
    defaultEligibility: 'identity' | 'live' | 'historical';
  };
  typedInvariants: Array<{ id: string; description: string }>;
}

/** Package-private runtime entity definition retaining executable validators. */
export interface RuntimeEntityTypeDefinition extends Omit<EntityTypeDefinition, 'attributes'> {
  attributes: Record<string, RuntimeAttributeDefinition>;
}

export interface RuntimeEntityTypeCatalog {
  types: Record<string, RuntimeEntityTypeDefinition>;
  version: number;
}

// ——— Entity Declaration ———

/** Live-state activation source of a declared entity. */
export type EntityIntroductionSource = { type: 'initial' } | { type: 'event'; eventId: string };

export interface EntityDeclaration {
  entityId: EntityId;
  typeRef: EntityTypeRef;
  immutableMetadata: { name: string; definitionFile: string };
  /** Live-state activation source; every declaration exists before story compile. */
  introduction: EntityIntroductionSource;
  provenance?: { source: string; hash: string };
}

// ——— Catalog Interfaces ———

export interface EntityTypeCatalog {
  /** Static key-value mapping — use Record */
  types: Record<string, EntityTypeDefinition>;
  version: number;
}

export interface EntityDeclarationCatalog {
  /** Static key-value mapping — use Record */
  declarations: Record<EntityId, EntityDeclaration>;
  version: number;
}

/**
 * The one shared catalog pair threaded through every write path (source
 * preflight, replay, story-boundary compilation). No optional fallback:
 * callers construct it from compiled catalogs and pass the same object.
 */
export interface EntityCatalogContext {
  entityDeclarationCatalog: EntityDeclarationCatalog;
  entityTypeCatalog: RuntimeEntityTypeCatalog;
}

// ——— Author-facing Catalog Source (versionless) ———
//
// The strict, versionless YAML contract for definitions/entity-types.yaml.
// Source only expresses the currently compilable structure: no recursive DSL,
// unions, nullables, `any` escape hatches, or version-negotiation fields.
// The runtime EntityTypeRef.schemaVersion / catalog version never appear here.

/** Author-facing attribute declaration. */
export interface AttributeDefinitionSource extends AttributeDefinition {}

/** Author-facing entity type declaration; `typeId` replaces `typeRef` (no schemaVersion). */
export interface EntityTypeDefinitionSource
  extends Omit<EntityTypeDefinition, 'typeRef' | 'attributes'> {
  typeId: string;
  attributes: Record<string, AttributeDefinitionSource>;
}

/** Author-facing entity types file shape; no `version` field. */
export interface EntityTypeCatalogSource {
  types: Record<string, EntityTypeDefinitionSource>;
}
