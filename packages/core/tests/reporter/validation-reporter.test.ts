import { describe, expect, it } from 'vitest';
import type { ValidationReport } from '../../src/reporter/validation-reporter.ts';
import { formatValidationReport } from '../../src/reporter/validation-reporter.ts';

describe('formatValidationReport', () => {
  it('formats a passing report without a Host output path', () => {
    const report: ValidationReport = {
      projectName: 'test-project',
      generatedAt: '2026-07-27T12:00:00.000Z',
      l1Issues: [],
      l2Issues: [],
    };

    const markdown = formatValidationReport(report);

    expect(markdown).toContain('All validations passed');
    expect(markdown).toContain('test-project');
  });

  it('formats failed validation evidence', () => {
    const report: ValidationReport = {
      projectName: 'failing-project',
      generatedAt: '2026-07-27T12:00:00.000Z',
      l1Issues: [{
        validator: 'test-validator',
        eventId: 'e1',
        category: 'consistency',
        severity: 'error',
        message: 'Something went wrong',
        entityId: 'entity-a',
        attribute: 'name',
      }],
      l2Issues: [],
    };

    const markdown = formatValidationReport(report);

    expect(markdown).toContain('Validation failed');
    expect(markdown).toContain('Something went wrong');
    expect(markdown).toContain('test-validator');
  });

  it('keeps pre-render and post-render issues distinct', () => {
    const report: ValidationReport = {
      projectName: 'multi-level',
      generatedAt: '2026-07-27T12:00:00.000Z',
      l1Issues: [{
        validator: 'v1',
        eventId: 'e1',
        category: 'logic',
        severity: 'warning',
        message: 'Pre-render warning',
      }],
      l2Issues: [{
        validator: 'v2',
        eventId: 'e2',
        category: 'style',
        severity: 'error',
        message: 'Post-render error',
      }],
    };

    const markdown = formatValidationReport(report);

    expect(markdown).toContain('Pre-render warning');
    expect(markdown).toContain('Post-render error');
  });
  it('does not reorder the caller-owned validation arrays', () => {
    const report: ValidationReport = {
      projectName: 'stable-order',
      generatedAt: '2026-07-27T12:00:00.000Z',
      l1Issues: [
        { validator: 'zeta', eventId: 'e1', category: 'logic', severity: 'warning', message: 'later' },
        { validator: 'alpha', eventId: 'e2', category: 'logic', severity: 'error', message: 'earlier' },
      ],
      l2Issues: [],
    };

    formatValidationReport(report);

    expect(report.l1Issues.map((issue) => issue.validator)).toEqual(['zeta', 'alpha']);
  });
});
