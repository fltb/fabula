// ============================================================================
// Novalistically — Default Entity Type Catalog
// ============================================================================
//
// Built-in default EntityTypeCatalog covering the 6 entity kinds with
// AttributeDefinitions for all attributes currently hardcoded in validators.
// Project config can override this catalog in the future (not in scope).
//
// CRITICAL: marital_status has writePolicy: 'mutable' and semanticRole: 'lifecycle'
// (NOT immutable — this fixes zhu-fu false world_rule errors in STATE-3b).
// ============================================================================

import { z } from 'zod';
import type {
  EntityTypeCatalog,
  EntityTypeDefinition,
  AttributeDefinition,
} from '../types/index.js';

// ——— Attribute builder helpers ———

function mutableAttr(
  attributeId: string,
  overrides?: Partial<AttributeDefinition>,
): AttributeDefinition {
  return {
    attributeId,
    valueSchema: z.any(),
    requiredAt: 'never',
    writePolicy: 'mutable',
    unsetAllowed: true,
    ...overrides,
  };
}

function immutableAttr(
  attributeId: string,
  overrides?: Partial<AttributeDefinition>,
): AttributeDefinition {
  return mutableAttr(attributeId, { writePolicy: 'immutable', ...overrides });
}

// ——— Entity Type Definitions ———

const characterType: EntityTypeDefinition = {
  typeRef: { typeId: 'character', schemaVersion: 1 },
  kind: 'character',
  attributes: {
    // Identity (immutable)
    gender: immutableAttr('gender', { semanticRole: 'identity' }),
    // Lifecycle (mutable)
    lifeStatus: mutableAttr('lifeStatus', { semanticRole: 'lifecycle' }),
    status: mutableAttr('status', { semanticRole: 'lifecycle' }),
    alive: mutableAttr('alive', { semanticRole: 'lifecycle' }),
    marital_status: mutableAttr('marital_status', { semanticRole: 'lifecycle' }),
    character_state: mutableAttr('character_state', { semanticRole: 'lifecycle' }),
    // Identity/Profile (mutable)
    age: mutableAttr('age', { semanticRole: 'identity' }),
    profession: mutableAttr('profession', { semanticRole: 'identity' }),
    traits: mutableAttr('traits', { semanticRole: 'identity' }),
    aliases: mutableAttr('aliases', { semanticRole: 'identity' }),
    appearance: mutableAttr('appearance', { semanticRole: 'appearance' }),
    // Location
    location: mutableAttr('location', { semanticRole: 'location' }),
    // Emotional
    mood: mutableAttr('mood', { semanticRole: 'emotional' }),
    // Knowledge
    knows: mutableAttr('knows', { semanticRole: 'knowledge' }),
    // Narrative
    pov: mutableAttr('pov', { semanticRole: 'narrative' }),
    pronoun: mutableAttr('pronoun', { semanticRole: 'narrative' }),
    pronoun_consistency: mutableAttr('pronoun_consistency', { semanticRole: 'narrative' }),
    'voice_*': mutableAttr('voice_*', { semanticRole: 'narrative' }),
    pacing: mutableAttr('pacing', { semanticRole: 'narrative' }),
    discourse_balance: mutableAttr('discourse_balance', { semanticRole: 'narrative' }),
    discourseMode: mutableAttr('discourseMode', { semanticRole: 'narrative' }),
  },
  lifecyclePolicy: { allowedTransitions: [['active', 'inactive'], ['active', 'retired'], ['inactive', 'active'], ['inactive', 'retired']] },
  referenceCapabilities: { defaultEligibility: 'live' },
  typedInvariants: [],
};

const locationType: EntityTypeDefinition = {
  typeRef: { typeId: 'location', schemaVersion: 1 },
  kind: 'location',
  attributes: {
    access: mutableAttr('access', { semanticRole: 'lifecycle' }),
    containment: mutableAttr('containment', { semanticRole: 'structural' }),
    time_period: mutableAttr('time_period', { semanticRole: 'temporal' }),
  },
  lifecyclePolicy: { allowedTransitions: [['active', 'inactive'], ['active', 'retired'], ['inactive', 'active'], ['inactive', 'retired']] },
  referenceCapabilities: { defaultEligibility: 'live' },
  typedInvariants: [],
};

const itemType: EntityTypeDefinition = {
  typeRef: { typeId: 'item', schemaVersion: 1 },
  kind: 'item',
  attributes: {
    quantity: mutableAttr('quantity', { semanticRole: 'lifecycle' }),
    condition: mutableAttr('condition', { semanticRole: 'lifecycle' }),
    ownership: mutableAttr('ownership', { semanticRole: 'relational' }),
    location: mutableAttr('location', { semanticRole: 'location' }),
  },
  lifecyclePolicy: { allowedTransitions: [['active', 'inactive'], ['active', 'retired'], ['inactive', 'active'], ['inactive', 'retired']] },
  referenceCapabilities: { defaultEligibility: 'live' },
  typedInvariants: [],
};

const factionType: EntityTypeDefinition = {
  typeRef: { typeId: 'faction', schemaVersion: 1 },
  kind: 'faction',
  attributes: {
    membership: mutableAttr('membership', { semanticRole: 'relational' }),
  },
  lifecyclePolicy: { allowedTransitions: [['active', 'inactive'], ['active', 'retired'], ['inactive', 'active'], ['inactive', 'retired']] },
  referenceCapabilities: { defaultEligibility: 'live' },
  typedInvariants: [],
};

const conceptType: EntityTypeDefinition = {
  typeRef: { typeId: 'concept', schemaVersion: 1 },
  kind: 'concept',
  attributes: {
    stability: mutableAttr('stability', { semanticRole: 'lifecycle' }),
    value: mutableAttr('value', { semanticRole: 'knowledge' }),
    description: mutableAttr('description', { semanticRole: 'knowledge' }),
  },
  lifecyclePolicy: { allowedTransitions: [['active', 'inactive'], ['active', 'retired'], ['inactive', 'active'], ['inactive', 'retired']] },
  referenceCapabilities: { defaultEligibility: 'identity' },
  typedInvariants: [],
};

const ruleType: EntityTypeDefinition = {
  typeRef: { typeId: 'rule', schemaVersion: 1 },
  kind: 'rule',
  attributes: {
    category: immutableAttr('category', { semanticRole: 'identity' }),
    type: immutableAttr('type', { semanticRole: 'identity' }),
    applicability: mutableAttr('applicability', { semanticRole: 'lifecycle' }),
    effectiveness: mutableAttr('effectiveness', { semanticRole: 'lifecycle' }),
    evidence: mutableAttr('evidence', { semanticRole: 'audit' }),
  },
  lifecyclePolicy: { allowedTransitions: [['active', 'inactive'], ['active', 'retired'], ['inactive', 'active'], ['inactive', 'retired']] },
  referenceCapabilities: { defaultEligibility: 'identity' },
  typedInvariants: [],
};

// ——— Default Catalog ———

export const defaultEntityTypeCatalog: EntityTypeCatalog = {
  types: {
    character: characterType,
    location: locationType,
    item: itemType,
    faction: factionType,
    concept: conceptType,
    rule: ruleType,
  },
  version: 1,
};

/** Look up a type definition by kind */
export function getTypeDefinitionByKind(kind: string): EntityTypeDefinition | undefined {
  return defaultEntityTypeCatalog.types[kind];
}

/** Get all attribute IDs defined for a given kind */
export function getAttributeIdsForKind(kind: string): string[] {
  const def = defaultEntityTypeCatalog.types[kind];
  if (!def) return [];
  return Object.keys(def.attributes);
}
