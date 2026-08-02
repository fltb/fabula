// ============================================================================
// Registry Catalog-Driven Load Tests
// ============================================================================
//
// STATE-3a: Verifies that the canonical project load (loadCanonicalProject)
// drives registry construction from ProjectData — never from a filesystem
// path — so all entity kinds get lifecycle/typeRef fields. Specifically tests
// the zhu-fu fixture to confirm character promoted fields survive and rules
// get category/type.
// ============================================================================

import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadCanonicalProject } from '../../src/entity/project-runtime.js';
import type { InMemoryEntityRegistry } from '../../src/entity/registry.js';
import { materializeFixtureSnapshot } from '../fixtures/fixture-snapshots.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const ZHU_FU_FIXTURE = path.resolve(ROOT, 'fixtures', 'zhu-fu');
const ARCANE_FIXTURE = path.resolve(ROOT, 'fixtures', 'arcane-aftermath');

function loadRegistry(fixtureDir: string): InMemoryEntityRegistry {
  return loadCanonicalProject(materializeFixtureSnapshot(fixtureDir)).registry;
}

describe('registry catalog-driven load', () => {
  describe('zhu-fu fixture', () => {
    let registry: InMemoryEntityRegistry;

    beforeAll(() => {
      registry = loadRegistry(ZHU_FU_FIXTURE);
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

    it('characters preserve initialState values (location) alongside promoted fields', () => {
      const entity = registry.resolve('fourth_aunt');
      expect(entity).not.toBeNull();
      expect(entity!.state['location']).toBe('fourth_master_lu_house');
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
      registry = loadRegistry(ARCANE_FIXTURE);
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
      const ir = loadCanonicalProject(materializeFixtureSnapshot(ZHU_FU_FIXTURE));
      const all = ir.registry.getAll();
      for (const entity of all) {
        // Every loaded entity's typeRef.typeId should match its kind
        expect(entity.typeRef.typeId).toBe(entity.kind);
        // The kind should exist in the project's compiled catalog
        expect(ir.entityTypes.types[entity.kind]).toBeDefined();
      }
    });
  });
});

describe('catalog compilation wall-clock determinism', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('compiles identical catalogs under different wall clocks', () => {
    const snapshot = materializeFixtureSnapshot(ZHU_FU_FIXTURE);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
    const early = loadCanonicalProject(snapshot);
    vi.setSystemTime(new Date('2026-08-02T03:04:05.000Z'));
    const late = loadCanonicalProject(snapshot);
    expect(late.registry).toEqual(early.registry);
    expect(late.entityDeclarations).toEqual(early.entityDeclarations);
    // The runtime catalog carries executable Zod schemas; compare their
    // JSON-serialized form — identical construction yields identical identity.
    expect(JSON.stringify(late.entityTypes)).toBe(JSON.stringify(early.entityTypes));
  });
});
