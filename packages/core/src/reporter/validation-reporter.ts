// ============================================================================
// Validation Report Formatter — pure markdown construction.
//
// Hosts choose whether and where to persist the resulting document.
// ============================================================================

import type { PipelineRunResult } from '../report/writer.js';
import { ReportWriter } from '../report/writer.js';
import type { ValidationIssue } from '../types/validator.js';

export interface ValidationReport {
  projectName: string;
  generatedAt: string;
  l1Issues: ValidationIssue[]; // pre-render issues
  l2Issues: ValidationIssue[]; // post-render issues
}

export function formatValidationReport(report: ValidationReport): string {
  const runResult: PipelineRunResult = {
    projectName: report.projectName,
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
  return new ReportWriter(runResult).toMarkdown();
}
