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

export interface AttributeDefinition {
  attributeId: string;
  valueSchema: z.ZodTypeAny;
  requiredAt: RequiredAt;
  writePolicy: WritePolicy;
  allowedLifecycleStates?: EntityRuntimeState[];
  unsetAllowed: boolean;
  semanticRole?: string;
  typedReferenceConstraint?: { targetKind: EntityKind; targetTypeId?: string };
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

// ——— Entity Declaration ———

export interface EntityDeclaration {
  entityId: EntityId;
  typeRef: EntityTypeRef;
  immutableMetadata: { name: string; definitionFile: string };
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
