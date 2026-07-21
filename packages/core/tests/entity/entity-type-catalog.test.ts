// ============================================================================
// Entity Type Catalog Tests
// ============================================================================
//
// STATE-3a: Validates the default EntityTypeCatalog structure, attribute
// coverage across all 6 entity kinds, and critical invariants:
// - marital_status is mutable/lifecycle (NOT immutable)
// - All 6 kinds have definitions
// - Catalog version
// ============================================================================

import { describe, it, expect } from 'vitest';
import { defaultEntityTypeCatalog, getTypeDefinitionByKind, getAttributeIdsForKind } from '../../src/entity/default-catalog.js';
import type { EntityTypeCatalog, AttributeDefinition } from '../../src/types/index.js';

describe('EntityTypeCatalog', () => {
  describe('catalog structure', () => {
    it('has version 1', () => {
      expect(defaultEntityTypeCatalog.version).toBe(1);
    });

    it('has definitions for all 6 entity kinds', () => {
      const kinds = ['character', 'location', 'item', 'concept', 'faction', 'rule'];
      for (const kind of kinds) {
        expect(defaultEntityTypeCatalog.types[kind]).toBeDefined();
        expect(defaultEntityTypeCatalog.types[kind].kind).toBe(kind);
      }
    });

    it('each type definition has a typeRef with typeId and schemaVersion', () => {
      for (const [typeId, def] of Object.entries(defaultEntityTypeCatalog.types)) {
        expect(def.typeRef.typeId).toBe(typeId);
        expect(def.typeRef.schemaVersion).toBeGreaterThanOrEqual(1);
      }
    });

    it('each type definition has lifecycle policy with allowed transitions', () => {
      for (const def of Object.values(defaultEntityTypeCatalog.types)) {
        expect(def.lifecyclePolicy.allowedTransitions.length).toBeGreaterThanOrEqual(2);
        for (const [from, to] of def.lifecyclePolicy.allowedTransitions) {
          expect(['active', 'inactive', 'retired']).toContain(from);
          expect(['active', 'inactive', 'retired']).toContain(to);
        }
      }
    });

    it('each type definition has referenceCapabilities', () => {
      for (const def of Object.values(defaultEntityTypeCatalog.types)) {
        expect(['identity', 'live', 'historical']).toContain(def.referenceCapabilities.defaultEligibility);
      }
    });
  });

  describe('attribute coverage', () => {
    it('character type has all expected attributes', () => {
      const charAttrs = defaultEntityTypeCatalog.types['character']?.attributes;
      expect(charAttrs).toBeDefined();

      const expected = [
        'gender', 'lifeStatus', 'status', 'alive', 'marital_status',
        'character_state', 'age', 'profession', 'traits', 'aliases',
        'appearance', 'location', 'mood', 'knows', 'pov', 'pronoun',
        'pronoun_consistency', 'pacing', 'discourse_balance', 'discourseMode',
      ];
      for (const attr of expected) {
        expect(charAttrs![attr]).toBeDefined();
      }
    });

    it('location type has all expected attributes', () => {
      const locAttrs = defaultEntityTypeCatalog.types['location']?.attributes;
      expect(locAttrs).toBeDefined();
      expect(locAttrs!['access']).toBeDefined();
      expect(locAttrs!['containment']).toBeDefined();
      expect(locAttrs!['time_period']).toBeDefined();
    });

    it('item type has all expected attributes', () => {
      const itemAttrs = defaultEntityTypeCatalog.types['item']?.attributes;
      expect(itemAttrs).toBeDefined();
      expect(itemAttrs!['quantity']).toBeDefined();
      expect(itemAttrs!['condition']).toBeDefined();
      expect(itemAttrs!['ownership']).toBeDefined();
      expect(itemAttrs!['location']).toBeDefined();
    });

    it('faction type has membership attribute', () => {
      const facAttrs = defaultEntityTypeCatalog.types['faction']?.attributes;
      expect(facAttrs).toBeDefined();
      expect(facAttrs!['membership']).toBeDefined();
    });

    it('concept type has all expected attributes', () => {
      const conAttrs = defaultEntityTypeCatalog.types['concept']?.attributes;
      expect(conAttrs).toBeDefined();
      expect(conAttrs!['stability']).toBeDefined();
      expect(conAttrs!['value']).toBeDefined();
      expect(conAttrs!['description']).toBeDefined();
    });

    it('rule type has all expected attributes', () => {
      const ruleAttrs = defaultEntityTypeCatalog.types['rule']?.attributes;
      expect(ruleAttrs).toBeDefined();
      expect(ruleAttrs!['category']).toBeDefined();
      expect(ruleAttrs!['type']).toBeDefined();
      expect(ruleAttrs!['applicability']).toBeDefined();
      expect(ruleAttrs!['effectiveness']).toBeDefined();
      expect(ruleAttrs!['evidence']).toBeDefined();
    });

    it('each kind has at least one attribute definition', () => {
      for (const [kind, def] of Object.entries(defaultEntityTypeCatalog.types)) {
        const attrCount = Object.keys(def.attributes).length;
        expect(attrCount).toBeGreaterThanOrEqual(1);
      }
    });

    it('attribute definitions have required fields', () => {
      for (const def of Object.values(defaultEntityTypeCatalog.types)) {
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
      const charAttrs = defaultEntityTypeCatalog.types['character']?.attributes;
      expect(charAttrs).toBeDefined();
      expect(charAttrs!['marital_status']).toBeDefined();
    });

    it('marital_status has writePolicy "mutable" (NOT immutable)', () => {
      const maritalStatus = defaultEntityTypeCatalog.types['character']?.attributes['marital_status'];
      expect(maritalStatus!.writePolicy).toBe('mutable');
      expect(maritalStatus!.writePolicy).not.toBe('immutable');
    });

    it('marital_status has semanticRole "lifecycle"', () => {
      const maritalStatus = defaultEntityTypeCatalog.types['character']?.attributes['marital_status'];
      expect(maritalStatus!.semanticRole).toBe('lifecycle');
    });
  });

  describe('type immutability', () => {
    it('rule category and type are immutable (identity)', () => {
      const ruleAttrs = defaultEntityTypeCatalog.types['rule']?.attributes;
      expect(ruleAttrs!['category'].writePolicy).toBe('immutable');
      expect(ruleAttrs!['category'].semanticRole).toBe('identity');
      expect(ruleAttrs!['type'].writePolicy).toBe('immutable');
      expect(ruleAttrs!['type'].semanticRole).toBe('identity');
    });

    it('character gender is immutable (identity)', () => {
      const gender = defaultEntityTypeCatalog.types['character']?.attributes['gender'];
      expect(gender!.writePolicy).toBe('immutable');
      expect(gender!.semanticRole).toBe('identity');
    });
  });

  describe('getTypeDefinitionByKind helper', () => {
    it('returns the type definition for each kind', () => {
      const kinds = ['character', 'location', 'item', 'concept', 'faction', 'rule'];
      for (const kind of kinds) {
        const def = getTypeDefinitionByKind(kind);
        expect(def).toBeDefined();
        expect(def!.kind).toBe(kind);
      }
    });

    it('returns undefined for unknown kind', () => {
      expect(getTypeDefinitionByKind('unknown')).toBeUndefined();
    });
  });

  describe('getAttributeIdsForKind helper', () => {
    it('returns attribute IDs for each kind', () => {
      const charAttrs = getAttributeIdsForKind('character');
      expect(charAttrs).toContain('gender');
      expect(charAttrs).toContain('marital_status');
      expect(charAttrs).toContain('location');
    });

    it('returns empty array for unknown kind', () => {
      expect(getAttributeIdsForKind('unknown')).toEqual([]);
    });
  });

  describe('catalog total attribute count', () => {
    it('counts all attributes across all 6 kinds', () => {
      let total = 0;
      for (const def of Object.values(defaultEntityTypeCatalog.types)) {
        total += Object.keys(def.attributes).length;
      }
      // Minimum expected: character (20+) + location (3) + item (4) + faction (1) + concept (3) + rule (5)
      expect(total).toBeGreaterThanOrEqual(36);
    });
  });
});
