// ============================================================================
// validation-reporter.test.ts — Storage-backed writeValidationReport contract
// ============================================================================

import { describe, expect, it } from 'vitest';
import { MemoryStorage } from '../../src/storage/memory-storage.ts';
import { writeValidationReport } from '../../src/reporter/validation-reporter.ts';
import type { ValidationReport } from '../../src/reporter/validation-reporter.ts';

describe('writeValidationReport', () => {
  it('writes validation.md through MemoryStorage', () => {
    const storage = new MemoryStorage();

    const report: ValidationReport = {
      projectName: 'test-project',
      generatedAt: '2026-07-27T12:00:00.000Z',
      l1Issues: [],
      l2Issues: [],
    };

    const outPath = writeValidationReport(storage, '/fake/project', report);

    expect(outPath).toBe('/fake/project/output/validation.md');

    // Verify the file was written in the storage backend
    const content = storage.read('/fake/project/output/validation.md');
    expect(content).toBeTruthy();
    expect(content).toContain('All validations passed');
  });

  it('reports FAILED when there are issues', () => {
    const storage = new MemoryStorage();

    const report: ValidationReport = {
      projectName: 'failing-project',
      generatedAt: '2026-07-27T12:00:00.000Z',
      l1Issues: [
        {
          validator: 'test-validator',
          eventId: 'e1',
          category: 'consistency',
          severity: 'error',
          message: 'Something went wrong',
          entityId: 'entity-a',
          attribute: 'name',
        },
      ],
      l2Issues: [],
    };

    const outPath = writeValidationReport(storage, '/fake/project', report);

    expect(outPath).toBe('/fake/project/output/validation.md');
    const content = storage.read('/fake/project/output/validation.md');
    expect(content).toContain('Validation failed');
    expect(content).toContain('Something went wrong');
    expect(content).toContain('test-validator');
  });

  it('reports L1 and L2 issues separately', () => {
    const storage = new MemoryStorage();

    const report: ValidationReport = {
      projectName: 'multi-level',
      generatedAt: '2026-07-27T12:00:00.000Z',
      l1Issues: [
        {
          validator: 'v1',
          eventId: 'e1',
          category: 'logic',
          severity: 'warning',
          message: 'Pre-render warning',
        },
      ],
      l2Issues: [
        {
          validator: 'v2',
          eventId: 'e2',
          category: 'style',
          severity: 'error',
          message: 'Post-render error',
        },
      ],
    };

    writeValidationReport(storage, '/fake/project', report);
    const content = storage.read('/fake/project/output/validation.md');
    expect(content).toContain('Pre-render warning');
    expect(content).toContain('Post-render error');
  });

  it('each MemoryStorage instance is isolated', () => {
    const storageA = new MemoryStorage();
    const storageB = new MemoryStorage();

    const reportA: ValidationReport = {
      projectName: 'project-a',
      generatedAt: '2026-07-27T12:00:00.000Z',
      l1Issues: [],
      l2Issues: [],
    };

    const reportB: ValidationReport = {
      projectName: 'project-b',
      generatedAt: '2026-07-27T12:00:00.000Z',
      l1Issues: [],
      l2Issues: [],
    };

    writeValidationReport(storageA, '/path/a', reportA);
    writeValidationReport(storageB, '/path/b', reportB);

    // Each storage should only see its own data
    expect(storageA.read('/path/a/output/validation.md')).toContain('project-a');
    expect(storageA.read('/path/a/output/validation.md')).not.toContain('project-b');

    expect(storageB.read('/path/b/output/validation.md')).toContain('project-b');
    expect(storageB.read('/path/b/output/validation.md')).not.toContain('project-a');
  });
});
