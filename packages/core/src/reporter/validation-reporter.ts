// ============================================================================
// Validation Report Writer — Human-readable output/validation.md
// ============================================================================

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ValidationIssue } from '../types/validator.js';
import { ReportWriter } from '../report/writer.js';
import type { PipelineRunResult } from '../report/writer.js';

export interface ValidationReport {
  projectName: string;
  generatedAt: string;
  l1Issues: ValidationIssue[];   // pre-render issues
  l2Issues: ValidationIssue[];   // post-render issues
}

export function writeValidationReport(
  projectDir: string,
  report: ValidationReport,
): string {
  // Build a PipelineRunResult from the ValidationReport and delegate to ReportWriter
  const runResult: PipelineRunResult = {
    projectName: report.projectName,
    projectDir,
    generatedAt: report.generatedAt,
    passed: report.l1Issues.length === 0 && report.l2Issues.length === 0,
    l1Issues: report.l1Issues,
    l2Issues: report.l2Issues,
    results: [],
    renderStatus: { ready: [], blocked: [], waiting: [], completed: [] },
    threads: [],
    blockers: [],
    nextActions: [],
    guidance: '',
    errors: [],
  };
  const markdown = new ReportWriter(runResult).toMarkdown();

  const outDir = join(projectDir, 'output');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'validation.md');
  writeFileSync(outPath, markdown);
  return outPath;
}
