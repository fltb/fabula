// ============================================================================
// Entity Type Catalog Tests
// ============================================================================
//
// STATE-3a: Compiles an explicit EntityTypeCatalog source via
// compileEntityTypeCatalog (the built-in default catalog was removed — no
// fallback) and validates its structure, attribute coverage across all 6
// entity kinds, and critical invariants:
// - marital_status is mutable/lifecycle (NOT immutable)
// - All 6 kinds have definitions
// - Catalog version
// ============================================================================

import { describe, expect, it } from 'vitest';
import { compileEntityTypeCatalog } from '../../src/entity/entity-catalog-compiler.js';
import type {
  AttributeDefinitionSource,
  EntityTypeCatalog,
  EntityTypeCatalogSource,
  EntityTypeDefinitionSource,
} from '../../src/types/index.js';

// ─── Explicit catalog source (mirrors the removed built-in default) ─────────

function sourceAttr(
  attributeId: string,
  overrides?: Partial<AttributeDefinitionSource>,
): AttributeDefinitionSource {
  return {
    attributeId,
    valueType: 'string',
    requiredAt: 'never',
    writePolicy: 'mutable',
    unsetAllowed: true,
    ...overrides,
  };
}

function immutableSourceAttr(
  attributeId: string,
  overrides?: Partial<AttributeDefinitionSource>,
): AttributeDefinitionSource {
  return sourceAttr(attributeId, { writePolicy: 'immutable', ...overrides });
}

const LIFECYCLE_TRANSITIONS: EntityTypeDefinitionSource['lifecyclePolicy']['allowedTransitions'] = [
  ['active', 'inactive'],
  ['active', 'retired'],
  ['inactive', 'active'],
  ['inactive', 'retired'],
];

const CHARACTER_SOURCE: EntityTypeDefinitionSource = {
  typeId: 'character',
  kind: 'character',
  attributes: {
    // Identity (immutable)
    gender: immutableSourceAttr('gender', { semanticRole: 'identity' }),
    // Lifecycle (mutable)
    lifeStatus: sourceAttr('lifeStatus', { semanticRole: 'lifecycle' }),
    status: sourceAttr('status', { semanticRole: 'lifecycle' }),
    alive: sourceAttr('alive', { valueType: 'boolean', semanticRole: 'lifecycle' }),
    marital_status: sourceAttr('marital_status', { semanticRole: 'lifecycle' }),
    character_state: sourceAttr('character_state', { semanticRole: 'lifecycle' }),
    // Identity/Profile (mutable)
    age: sourceAttr('age', { semanticRole: 'identity' }),
    profession: sourceAttr('profession', { semanticRole: 'identity' }),
    traits: sourceAttr('traits', { valueType: 'string_list', semanticRole: 'identity' }),
    aliases: sourceAttr('aliases', { valueType: 'string_list', semanticRole: 'identity' }),
    appearance: sourceAttr('appearance', { semanticRole: 'appearance' }),
    // Location
    location: sourceAttr('location', { semanticRole: 'location' }),
    // Emotional
    mood: sourceAttr('mood', { semanticRole: 'emotional' }),
    // Knowledge
    knows: sourceAttr('knows', { semanticRole: 'knowledge' }),
    // Narrative
    pov: sourceAttr('pov', { semanticRole: 'narrative' }),
    pronoun: sourceAttr('pronoun', { semanticRole: 'narrative' }),
    pronoun_consistency: sourceAttr('pronoun_consistency', { semanticRole: 'narrative' }),
    'voice_*': sourceAttr('voice_*', { semanticRole: 'narrative' }),
    pacing: sourceAttr('pacing', { semanticRole: 'narrative' }),
    discourse_balance: sourceAttr('discourse_balance', { semanticRole: 'narrative' }),
    discourseMode: sourceAttr('discourseMode', { semanticRole: 'narrative' }),
  },
  lifecyclePolicy: { allowedTransitions: LIFECYCLE_TRANSITIONS },
  referenceCapabilities: { defaultEligibility: 'live' },
  typedInvariants: [],
};

const LOCATION_SOURCE: EntityTypeDefinitionSource = {
  typeId: 'location',
  kind: 'location',
  attributes: {
    access: sourceAttr('access', { semanticRole: 'lifecycle' }),
    containment: sourceAttr('containment', { semanticRole: 'structural' }),
    time_period: sourceAttr('time_period', { semanticRole: 'temporal' }),
  },
  lifecyclePolicy: { allowedTransitions: LIFECYCLE_TRANSITIONS },
  referenceCapabilities: { defaultEligibility: 'live' },
  typedInvariants: [],
};

const ITEM_SOURCE: EntityTypeDefinitionSource = {
  typeId: 'item',
  kind: 'item',
  attributes: {
    quantity: sourceAttr('quantity', { valueType: 'number', semanticRole: 'lifecycle' }),
    condition: sourceAttr('condition', { semanticRole: 'lifecycle' }),
    ownership: sourceAttr('ownership', { semanticRole: 'relational' }),
    location: sourceAttr('location', { semanticRole: 'location' }),
  },
  lifecyclePolicy: { allowedTransitions: LIFECYCLE_TRANSITIONS },
  referenceCapabilities: { defaultEligibility: 'live' },
  typedInvariants: [],
};

const FACTION_SOURCE: EntityTypeDefinitionSource = {
  typeId: 'faction',
  kind: 'faction',
  attributes: {
    membership: sourceAttr('membership', { semanticRole: 'relational' }),
  },
  lifecyclePolicy: { allowedTransitions: LIFECYCLE_TRANSITIONS },
  referenceCapabilities: { defaultEligibility: 'live' },
  typedInvariants: [],
};

const CONCEPT_SOURCE: EntityTypeDefinitionSource = {
  typeId: 'concept',
  kind: 'concept',
  attributes: {
    stability: sourceAttr('stability', { semanticRole: 'lifecycle' }),
    value: sourceAttr('value', { semanticRole: 'knowledge' }),
    description: sourceAttr('description', { semanticRole: 'knowledge' }),
  },
  lifecyclePolicy: { allowedTransitions: LIFECYCLE_TRANSITIONS },
  referenceCapabilities: { defaultEligibility: 'identity' },
  typedInvariants: [],
};

const RULE_SOURCE: EntityTypeDefinitionSource = {
  typeId: 'rule',
  kind: 'rule',
  attributes: {
    category: immutableSourceAttr('category', { semanticRole: 'identity' }),
    type: immutableSourceAttr('type', { semanticRole: 'identity' }),
    applicability: sourceAttr('applicability', { semanticRole: 'lifecycle' }),
    effectiveness: sourceAttr('effectiveness', { semanticRole: 'lifecycle' }),
    evidence: sourceAttr('evidence', { semanticRole: 'audit' }),
  },
  lifecyclePolicy: { allowedTransitions: LIFECYCLE_TRANSITIONS },
  referenceCapabilities: { defaultEligibility: 'identity' },
  typedInvariants: [],
};

const CATALOG_SOURCE: EntityTypeCatalogSource = {
  types: {
    character: CHARACTER_SOURCE,
    location: LOCATION_SOURCE,
    item: ITEM_SOURCE,
    faction: FACTION_SOURCE,
    concept: CONCEPT_SOURCE,
    rule: RULE_SOURCE,
  },
};

/** Compiled fresh per test file — no shared Zod schema instances, no default. */
const catalog: EntityTypeCatalog = compileEntityTypeCatalog(CATALOG_SOURCE);

describe('EntityTypeCatalog', () => {
  describe('catalog structure', () => {
    it('has version 1', () => {
      expect(catalog.version).toBe(1);
    });

    it('has definitions for all 6 entity kinds', () => {
      const kinds = ['character', 'location', 'item', 'concept', 'faction', 'rule'];
      for (const kind of kinds) {
        expect(catalog.types[kind]).toBeDefined();
        expect(catalog.types[kind].kind).toBe(kind);
      }
    });

    it('each type definition has a typeRef with typeId and schemaVersion', () => {
      for (const [typeId, def] of Object.entries(catalog.types)) {
        expect(def.typeRef.typeId).toBe(typeId);
        expect(def.typeRef.schemaVersion).toBeGreaterThanOrEqual(1);
      }
    });

    it('each type definition has lifecycle policy with allowed transitions', () => {
      for (const def of Object.values(catalog.types)) {
        expect(def.lifecyclePolicy.allowedTransitions.length).toBeGreaterThanOrEqual(2);
        for (const [from, to] of def.lifecyclePolicy.allowedTransitions) {
          expect(['active', 'inactive', 'retired']).toContain(from);
          expect(['active', 'inactive', 'retired']).toContain(to);
        }
      }
    });

    it('each type definition has referenceCapabilities', () => {
      for (const def of Object.values(catalog.types)) {
        expect(['identity', 'live', 'historical']).toContain(
          def.referenceCapabilities.defaultEligibility,
        );
      }
    });
  });

  describe('attribute coverage', () => {
    it('character type has all expected attributes', () => {
      const charAttrs = catalog.types.character?.attributes;
      expect(charAttrs).toBeDefined();

      const expected = [
        'gender',
        'lifeStatus',
        'status',
        'alive',
        'marital_status',
        'character_state',
        'age',
        'profession',
        'traits',
        'aliases',
        'appearance',
        'location',
        'mood',
        'knows',
        'pov',
        'pronoun',
        'pronoun_consistency',
        'pacing',
        'discourse_balance',
        'discourseMode',
      ];
      for (const attr of expected) {
        expect(charAttrs?.[attr]).toBeDefined();
      }
    });

    it('location type has all expected attributes', () => {
      const locAttrs = catalog.types.location?.attributes;
      expect(locAttrs).toBeDefined();
      expect(locAttrs?.access).toBeDefined();
      expect(locAttrs?.containment).toBeDefined();
      expect(locAttrs?.time_period).toBeDefined();
    });

    it('item type has all expected attributes', () => {
      const itemAttrs = catalog.types.item?.attributes;
      expect(itemAttrs).toBeDefined();
      expect(itemAttrs?.quantity).toBeDefined();
      expect(itemAttrs?.condition).toBeDefined();
      expect(itemAttrs?.ownership).toBeDefined();
      expect(itemAttrs?.location).toBeDefined();
    });

    it('faction type has membership attribute', () => {
      const facAttrs = catalog.types.faction?.attributes;
      expect(facAttrs).toBeDefined();
      expect(facAttrs?.membership).toBeDefined();
    });

    it('concept type has all expected attributes', () => {
      const conAttrs = catalog.types.concept?.attributes;
      expect(conAttrs).toBeDefined();
      expect(conAttrs?.stability).toBeDefined();
      expect(conAttrs?.value).toBeDefined();
      expect(conAttrs?.description).toBeDefined();
    });

    it('rule type has all expected attributes', () => {
      const ruleAttrs = catalog.types.rule?.attributes;
      expect(ruleAttrs).toBeDefined();
      expect(ruleAttrs?.category).toBeDefined();
      expect(ruleAttrs?.type).toBeDefined();
      expect(ruleAttrs?.applicability).toBeDefined();
      expect(ruleAttrs?.effectiveness).toBeDefined();
      expect(ruleAttrs?.evidence).toBeDefined();
    });

    it('each kind has at least one attribute definition', () => {
      for (const [_kind, def] of Object.entries(catalog.types)) {
        const attrCount = Object.keys(def.attributes).length;
        expect(attrCount).toBeGreaterThanOrEqual(1);
      }
    });

    it('attribute definitions have required fields', () => {
      for (const def of Object.values(catalog.types)) {
        for (const [attrId, attr] of Object.entries(def.attributes)) {
          expect(attr.attributeId).toBe(attrId);
          expect(attr.requiredAt).toMatch(/^(introduction|activation|never)$/);
          expect(attr.writePolicy).toMatch(/^(immutable|write_once|mutable|lifecycle_managed)$/);
          expect(typeof attr.unsetAllowed).toBe('boolean');
        }
      }
    });
  });

  describe('marital_status — the zhu-fu fix', () => {
    it('marital_status is defined on character type', () => {
      const charAttrs = catalog.types.character?.attributes;
      expect(charAttrs).toBeDefined();
      expect(charAttrs?.marital_status).toBeDefined();
    });

    it('marital_status has writePolicy "mutable" (NOT immutable)', () => {
      const maritalStatus = catalog.types.character?.attributes.marital_status;
      expect(maritalStatus?.writePolicy).toBe('mutable');
      expect(maritalStatus?.writePolicy).not.toBe('immutable');
    });

    it('marital_status has semanticRole "lifecycle"', () => {
      const maritalStatus = catalog.types.character?.attributes.marital_status;
      expect(maritalStatus?.semanticRole).toBe('lifecycle');
    });
  });

  describe('type immutability', () => {
    it('rule category and type are immutable (identity)', () => {
      const ruleAttrs = catalog.types.rule?.attributes;
      expect(ruleAttrs?.category.writePolicy).toBe('immutable');
      expect(ruleAttrs?.category.semanticRole).toBe('identity');
      expect(ruleAttrs?.type.writePolicy).toBe('immutable');
      expect(ruleAttrs?.type.semanticRole).toBe('identity');
    });

    it('character gender is immutable (identity)', () => {
      const gender = catalog.types.character?.attributes.gender;
      expect(gender?.writePolicy).toBe('immutable');
      expect(gender?.semanticRole).toBe('identity');
    });
  });

  describe('type definition lookup by kind', () => {
    it('returns the type definition for each kind', () => {
      const kinds = ['character', 'location', 'item', 'concept', 'faction', 'rule'];
      for (const kind of kinds) {
        const def = catalog.types[kind];
        expect(def).toBeDefined();
        expect(def?.kind).toBe(kind);
      }
    });

    it('returns undefined for unknown kind', () => {
      expect(catalog.types.unknown).toBeUndefined();
    });
  });

  describe('attribute id lookup by kind', () => {
    it('returns attribute IDs for each kind', () => {
      const charAttrs = Object.keys(catalog.types.character?.attributes);
      expect(charAttrs).toContain('gender');
      expect(charAttrs).toContain('marital_status');
      expect(charAttrs).toContain('location');
    });

    it('returns no attributes for unknown kind', () => {
      expect(catalog.types.unknown?.attributes).toBeUndefined();
    });
  });

  describe('catalog total attribute count', () => {
    it('counts all attributes across all 6 kinds', () => {
      let total = 0;
      for (const def of Object.values(catalog.types)) {
        total += Object.keys(def.attributes).length;
      }
      // Minimum expected: character (20+) + location (3) + item (4) + faction (1) + concept (3) + rule (5)
      expect(total).toBeGreaterThanOrEqual(36);
    });
  });
});
