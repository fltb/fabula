import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileMockPass2Provider, loadReferenceEntries } from '../src/providers/file-mock-pass2.ts';
import { withTempProject } from './cache-fixtures.js';

describe('FileMockPass2Provider', () => {
  it('materializes file fixtures before creating the pure in-memory provider', async () => {
    await withTempProject(async (root) => {
      const references = join(root, 'references');
      await mkdir(references);
      await writeFile(
        join(references, 'E1.json'),
        JSON.stringify({ prose: 'fixture prose', analysis: { eventId: 'E1' } }),
      );
      expect(loadReferenceEntries(references)).toEqual({
        E1: { prose: 'fixture prose', analysis: { eventId: 'E1' } },
      });
      expect(new FileMockPass2Provider({ referenceDir: references })).toHaveProperty(
        'name',
        'mock-pass2',
      );
    });
  });

  it('rejects malformed fixture records at the Node boundary', async () => {
    await withTempProject(async (root) => {
      await writeFile(join(root, 'E1.json'), JSON.stringify({ prose: 7 }));
      expect(() => loadReferenceEntries(root)).toThrow('Invalid mock reference fixture');
    });
  });
});
