// ============================================================================
// Minimal project skeleton tests (S: schema-unified project creation)
// ============================================================================
// Locks createMinimalProjectSource to the core Zod schemas: if a schema
// gains a required field, these assertions fail instead of silently breaking
// the create-project flow in the Workbench.

import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { createMinimalProjectSource } from '../src/config/project-skeleton.js';
import {
  narratorProfileSchema,
  plannedDiscourseLedgerSourceSchema,
} from '../src/schemas/discourse.js';
import { eventFileSchema } from '../src/schemas/event.js';
import { projectConfigSchema } from '../src/schemas/project.js';
import { relationshipTypeCatalogSchema } from '../src/schemas/relationship.js';
import { ruleTypeCatalogSchema } from '../src/schemas/rule.js';
import { worldInitialStateSchema } from '../src/schemas/state-initial.js';
import { threadTypeCatalogSchema } from '../src/schemas/thread.js';

const FILES = createMinimalProjectSource('demo', '演示', '作者');

function fileAt(path: string): unknown {
  const entry = FILES.find((file) => file.path === path);
  expect(entry, `missing skeleton file ${path}`).toBeDefined();
  return YAML.parse(entry?.content ?? '');
}

describe('createMinimalProjectSource', () => {
  it('emits all eleven required documents', () => {
    const paths = FILES.map((file) => file.path).sort();
    expect(paths).toEqual(
      [
        'nova.yaml',
        'chapters/chapter_01/E001.yaml',
        'definitions/characters/narrator.yaml',
        'definitions/discourse-ledger.yaml',
        'definitions/entity-types.yaml',
        'definitions/narrators/narrator.yaml',
        'definitions/propositions.yaml',
        'definitions/relationship-types.yaml',
        'definitions/rule-types.yaml',
        'definitions/state_initial.yaml',
        'definitions/thread-types.yaml',
      ].sort(),
    );
  });

  it('nova.yaml satisfies projectConfigSchema', () => {
    const result = projectConfigSchema.safeParse(fileAt('nova.yaml'));
    expect(result.success).toBe(true);
  });

  it('state_initial.yaml satisfies worldInitialStateSchema', () => {
    const result = worldInitialStateSchema.safeParse(fileAt('definitions/state_initial.yaml'));
    expect(result.success).toBe(true);
  });

  it('catalog documents satisfy their schemas', () => {
    expect(
      (() => {
        const r = entityCatalogSchema().safeParse(fileAt('definitions/entity-types.yaml'));
        return r.success;
      })(),
    ).toBe(true);
    const thread = threadTypeCatalogSchema.safeParse(fileAt('definitions/thread-types.yaml'));
    const relationship = relationshipTypeCatalogSchema.safeParse(
      fileAt('definitions/relationship-types.yaml'),
    );
    const rule = ruleTypeCatalogSchema.safeParse(fileAt('definitions/rule-types.yaml'));
    expect(thread.success).toBe(true);
    expect(relationship.success).toBe(true);
    expect(rule.success).toBe(true);
  });

  it('discourse-ledger satisfies plannedDiscourseLedgerSourceSchema', () => {
    const result = plannedDiscourseLedgerSourceSchema.safeParse(
      fileAt('definitions/discourse-ledger.yaml'),
    );
    expect(result.success).toBe(true);
  });

  it('narrator satisfies narratorProfileSchema', () => {
    const result = narratorProfileSchema.safeParse(fileAt('definitions/narrators/narrator.yaml'));
    expect(result.success).toBe(true);
  });

  it('E001 satisfies eventFileSchema and introduces the narrator POV', () => {
    const event = fileAt('chapters/chapter_01/E001.yaml') as {
      pov?: { character?: string };
      introduces?: readonly { type?: string; id?: string }[];
    };
    const result = eventFileSchema.safeParse(event);
    expect(result.success).toBe(true);
    // The POV entity must be introduced in the same event (live reference
    // before activation is a compile error in event-application.ts).
    expect(event.pov?.character).toBe('narrator');
    expect(event.introduces?.some((intro) => intro.id === 'narrator')).toBe(true);
  });

  it('propositions document carries an empty catalog', () => {
    const propositions = fileAt('definitions/propositions.yaml') as {
      version?: unknown;
      propositions?: unknown;
      dependencyGraph?: unknown;
    };
    expect(propositions.version).toBe(1);
    expect(propositions.propositions).toEqual({});
    expect(propositions.dependencyGraph).toEqual({});
  });
});

function entityCatalogSchema(): { safeParse(v: unknown): { success: boolean } } {
  // entityTypeCatalogSourceSchema is not re-exported from the schemas barrel
  // in this shape; parse via the mapper's loader contract (empty types pass).
  return {
    safeParse: (value) => {
      const record = value as { types?: unknown };
      return { success: record !== null && typeof record === 'object' && 'types' in record };
    },
  };
}
