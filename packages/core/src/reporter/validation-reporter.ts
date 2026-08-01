// ============================================================================
// Validation Report Writer — Human-readable output/validation.md
// ============================================================================

import * as path from 'node:path';
import type { PipelineRunResult } from '../report/writer.js';
import { ReportWriter } from '../report/writer.js';
import type { Storage } from '../storage/types.ts';
import type { ValidationIssue } from '../types/validator.js';

export interface ValidationReport {
  projectName: string;
  generatedAt: string;
  l1Issues: ValidationIssue[]; // pre-render issues
  l2Issues: ValidationIssue[]; // post-render issues
}

export function writeValidationReport(
  storage: Storage,
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

  const outDir = path.join(projectDir, 'output');
  storage.mkdirp(outDir);
  const outPath = path.join(outDir, 'validation.md');
  storage.write(outPath, markdown);
  return outPath;
}
