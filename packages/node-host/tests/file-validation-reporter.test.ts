import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeFileValidationReport } from '../src/reports/file-validation-reporter.js';
import { withTempProject } from './cache-fixtures.js';

describe('writeFileValidationReport', () => {
  it('persists Core-formatted validation markdown through the Host boundary', async () => {
    await withTempProject(async (root) => {
      const target = await writeFileValidationReport(root, {
        projectName: 'report-project',
        generatedAt: '2026-08-02T00:00:00.000Z',
        l1Issues: [],
        l2Issues: [],
      });

      expect(target).toBe(path.join(root, 'output', 'validation.md'));
      await expect(readFile(target, 'utf8')).resolves.toContain('All validations passed');
    });
  });
});
