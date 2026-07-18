// ============================================================================
// Validation Report Writer — Human-readable output/validation.md
// ============================================================================

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ValidationIssue } from '../types/validator.js';

export interface ValidationReport {
  projectName: string;
  generatedAt: string;
  l1Issues: ValidationIssue[];   // pre-render issues
  l2Issues: ValidationIssue[];   // post-render issues
}

function severityIcon(s: string): string {
  if (s === 'error') return '🔴';
  if (s === 'warning') return '🟡';
  return '🔵';
}

function trunc(s: string, max = 120): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

export function writeValidationReport(
  projectDir: string,
  report: ValidationReport,
): string {
  const outDir = join(projectDir, 'output');
  mkdirSync(outDir, { recursive: true });

  const lines: string[] = [];
  lines.push(`# Validation Report — ${report.projectName}`);
  lines.push('');
  lines.push(`**Generated:** ${report.generatedAt}`);
  lines.push('');

  // Summary
  const l1Errors = report.l1Issues.filter(i => i.severity === 'error').length;
  const l1Warnings = report.l1Issues.filter(i => i.severity === 'warning').length;
  const l1Infos = report.l1Issues.filter(i => i.severity === 'info').length;
  const l2Errors = report.l2Issues.filter(i => i.severity === 'error').length;
  const l2Warnings = report.l2Issues.filter(i => i.severity === 'warning').length;
  const l2Infos = report.l2Issues.filter(i => i.severity === 'info').length;

  lines.push('## Summary');
  lines.push('');
  lines.push('| Layer | Errors | Warnings | Infos | Total |');
  lines.push('|-------|--------|----------|-------|-------|');
  lines.push(`| L1 (Pre-render) | ${l1Errors} | ${l1Warnings} | ${l1Infos} | ${report.l1Issues.length} |`);
  lines.push(`| L2 (Post-render) | ${l2Errors} | ${l2Warnings} | ${l2Infos} | ${report.l2Issues.length} |`);
  lines.push('');

  // L1 Issues
  if (report.l1Issues.length > 0) {
    lines.push(`## L1 Issues (Pre-Render Validation) — ${report.l1Issues.length} issues`);
    lines.push('');
    lines.push('| # | Validator | Severity | Event | Entity | Attribute | Message |');
    lines.push('|---|-----------|----------|-------|--------|-----------|---------|');
    report.l1Issues.forEach((issue, i) => {
      lines.push(`| ${i + 1} | ${issue.validator} | ${severityIcon(issue.severity)} ${issue.severity} | ${issue.event} | ${issue.entity} | ${trunc(issue.attribute ?? '', 40)} | ${trunc(issue.message)} |`);
    });
    lines.push('');
  }

  // L2 Issues
  if (report.l2Issues.length > 0) {
    lines.push(`## L2 Issues (Post-Render Validation with Pass 2) — ${report.l2Issues.length} issues`);
    lines.push('');
    lines.push('| # | Validator | Severity | Event | Entity | Attribute | Message |');
    lines.push('|---|-----------|----------|-------|--------|-----------|---------|');
    report.l2Issues.forEach((issue, i) => {
      lines.push(`| ${i + 1} | ${issue.validator} | ${severityIcon(issue.severity)} ${issue.severity} | ${issue.event} | ${issue.entity} | ${trunc(issue.attribute ?? '', 40)} | ${trunc(issue.message)} |`);
    });
    lines.push('');
  }

  const outPath = join(outDir, 'validation.md');
  writeFileSync(outPath, lines.join('\n'));
  return outPath;
}
