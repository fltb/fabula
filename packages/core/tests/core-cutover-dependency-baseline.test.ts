import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type InventoryEntry = Record<string, number>;
type Baseline = {
  scope: string[];
  categories: Record<string, InventoryEntry>;
};

const fixtureUrl = new URL('./fixtures/core-cutover-dependency-baseline.json', import.meta.url);
const baseline = JSON.parse(readFileSync(fixtureUrl, 'utf8')) as Baseline;

const expectedCategories = [
  '.nova/revisions/sources',
  '.nova/source-head.json',
  'Bun',
  'FsStorage',
  'ProjectPaths',
  'SourceHeadV1',
  'SourceRevisionStore',
  'SourceRevisionV1',
  'Storage',
  'node:child_process',
  'node:fs',
  'node:path',
  'process.env',
];


describe('Core cutover dependency baseline', () => {
  it('validates the deterministic legacy surface inventory', () => {
    expect(baseline).toEqual(expect.objectContaining({ scope: expect.any(Array), categories: expect.any(Object) }));
    expect(baseline.scope.length).toBeGreaterThan(0);
    expect(new Set(baseline.scope).size).toBe(baseline.scope.length);
    expect(baseline.scope).toEqual([...baseline.scope].sort());
    expect(Object.keys(baseline.categories).sort()).toEqual(expectedCategories);
    expect(Object.keys(baseline.categories)).toHaveLength(expectedCategories.length);

    const allPaths = new Set<string>();
    for (const [category, entries] of Object.entries(baseline.categories)) {
      expect(category).toBeTruthy();
      expect(entries).toEqual(expect.any(Object));
      const paths = Object.keys(entries);
      expect(paths).toEqual([...paths].sort());
      expect(new Set(paths).size).toBe(paths.length);

      for (const [logicalPath, count] of Object.entries(entries)) {
        expect(baseline.scope.some((scope) => logicalPath === scope || logicalPath.startsWith(`${scope}/`))).toBe(true);
        expect(count).toBeGreaterThan(0);
        expect(Number.isInteger(count)).toBe(true);
        expect(allPaths.has(`${category}\\0${logicalPath}`)).toBe(false);
        allPaths.add(`${category}\\0${logicalPath}`);
      }
    }

    expect(Object.keys(baseline.categories)).not.toHaveLength(0);
    expect(allPaths.size).toBeGreaterThan(0);
  });
});
