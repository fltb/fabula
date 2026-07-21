// ============================================================================
// Registry Catalog-Driven Load Tests
// ============================================================================
//
// STATE-3a: Verifies that InMemoryEntityRegistry.load() uses the default
// EntityTypeCatalog to drive entity construction, and that all entity kinds
// get lifecycle/typeRef fields. Specifically tests the zhu-fu fixture to
// confirm character promoted fields survive and rules get category/type.
// ============================================================================

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { InMemoryEntityRegistry } from '../../src/entity/index.js';
import { defaultEntityTypeCatalog } from '../../src/entity/default-catalog.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const ZHU_FU_FIXTURE = path.resolve(ROOT, 'fixtures', 'zhu-fu');
const ARCANE_FIXTURE = path.resolve(ROOT, 'fixtures', 'arcane-aftermath');

describe('registry catalog-driven load', () => {
  describe('zhu-fu fixture', () => {
    let registry: InMemoryEntityRegistry;

    beforeAll(() => {
      registry = new InMemoryEntityRegistry();
      registry.load(ZHU_FU_FIXTURE);
    });

    it('loads all character entities', () => {
      const characters = registry.findByKind('character');
      expect(characters.length).toBeGreaterThanOrEqual(4);
      const ids = characters.map((c) => c.id);
      expect(ids).toContain('xianglins_wife');
      expect(ids).toContain('fourth_master_lu');
      expect(ids).toContain('liu_ma');
    });

    it('characters have lifecycle: "active"', () => {
      const entity = registry.resolve('xianglins_wife');
      expect(entity).not.toBeNull();
      expect(entity!.lifecycle).toBe('active');
    });

    it('characters have typeRef with typeId and schemaVersion', () => {
      const entity = registry.resolve('xianglins_wife');
      expect(entity!.typeRef).toEqual({ typeId: 'character', schemaVersion: 1 });
    });

    it('characters have aliases in state from promoted field', () => {
      const entity = registry.resolve('xianglins_wife');
      const aliases = entity!.state['aliases'];
      expect(Array.isArray(aliases)).toBe(true);
      expect((aliases as string[]).length).toBeGreaterThanOrEqual(1);
    });

    it('characters have gender in state from promoted field', () => {
      const entity = registry.resolve('xianglins_wife');
      expect(entity!.state['gender']).toBe('女');
    });

    it('characters have appearance in state from promoted field', () => {
      const entity = registry.resolve('xianglins_wife');
      expect(typeof entity!.state['appearance']).toBe('string');
      expect((entity!.state['appearance'] as string).length).toBeGreaterThan(10);
    });

    it('characters have age in state from promoted field', () => {
      const entity = registry.resolve('xianglins_wife');
      expect(entity!.state['age']).toBe('约二十六七岁到四十岁');
    });

    it('characters have profession in state from promoted field', () => {
      const entity = registry.resolve('xianglins_wife');
      expect(entity!.state['profession']).toBe('佣工');
    });

    it('characters have traits in state (always set)', () => {
      const entity = registry.resolve('xianglins_wife');
      expect(Array.isArray(entity!.state['traits'])).toBe(true);
    });

    it('characters preserve initialState values (location) alongside promoted fields', () => {
      const entity = registry.resolve('xianglins_wife');
      expect(entity!.state['location']).toBe('weijia_shan');
    });

    it('loads location entities with lifecycle and typeRef', () => {
      const locations = registry.findByKind('location');
      expect(locations.length).toBeGreaterThanOrEqual(1);
      for (const loc of locations) {
        expect(loc.lifecycle).toBe('active');
        expect(loc.typeRef).toEqual({ typeId: 'location', schemaVersion: 1 });
      }
    });

    it('loads rule entities with lifecycle, typeRef, category and type', () => {
      const rules = registry.findByKind('rule');
      expect(rules.length).toBeGreaterThanOrEqual(1);
      for (const rule of rules) {
        expect(rule.lifecycle).toBe('active');
        expect(rule.typeRef).toEqual({ typeId: 'rule', schemaVersion: 1 });
        // Rules get category and type from definition fields (no longer hardcoded 2-field)
        expect(rule.state['category']).toBeDefined();
        expect(rule.state['type']).toBeDefined();
      }
    });

    it('loads concept entities (world facts) with lifecycle and typeRef', () => {
      const concepts = registry.findByKind('concept');
      expect(concepts.length).toBeGreaterThanOrEqual(1);
      for (const con of concepts) {
        expect(con.lifecycle).toBe('active');
        expect(con.typeRef).toEqual({ typeId: 'concept', schemaVersion: 1 });
      }
    });

    it('all loaded entities have lifecycle and typeRef', () => {
      const all = registry.getAll();
      expect(all.length).toBeGreaterThanOrEqual(5);
      for (const entity of all) {
        expect(entity.lifecycle).toBe('active');
        expect(entity.typeRef).toBeDefined();
        expect(entity.typeRef.typeId).toBe(entity.kind);
        expect(entity.typeRef.schemaVersion).toBeGreaterThanOrEqual(1);
      }
    });
  });

  describe('arcane-aftermath fixture', () => {
    let registry: InMemoryEntityRegistry;

    beforeAll(() => {
      registry = new InMemoryEntityRegistry();
      registry.load(ARCANE_FIXTURE);
    });

    it('loads all entities', () => {
      const all = registry.getAll();
      expect(all.length).toBeGreaterThanOrEqual(5);
    });

    it('characters have correct lifecycle and typeRef', () => {
      const chars = registry.findByKind('character');
      expect(chars.length).toBeGreaterThanOrEqual(1);
      for (const c of chars) {
        expect(c.lifecycle).toBe('active');
        expect(c.typeRef).toEqual({ typeId: 'character', schemaVersion: 1 });
      }
    });

    it('locations have loaded initialState', () => {
      const locs = registry.findByKind('location');
      expect(locs.length).toBeGreaterThanOrEqual(1);
      for (const loc of locs) {
        expect(loc.state).toBeDefined();
      }
    });
  });

  describe('catalog-driven invariant', () => {
    it('entity kinds match catalog typeId in typeRef', () => {
      const registry = new InMemoryEntityRegistry();
      registry.load(ZHU_FU_FIXTURE);
      const all = registry.getAll();
      for (const entity of all) {
        // Every loaded entity's typeRef.typeId should match its kind
        expect(entity.typeRef.typeId).toBe(entity.kind);
        // The kind should exist in the catalog
        expect(defaultEntityTypeCatalog.types[entity.kind]).toBeDefined();
      }
    });
  });
});
