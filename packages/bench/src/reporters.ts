// ============================================================================
// Benchmark Reporters — Markdown + JSON output
// ============================================================================

import { FsStorage } from '@novalistically/core';
import type { Storage } from '@novalistically/core';
import type { ValidationIssue } from '@novalistically/core';
import type { PerValidatorBreakdown, SeverityLevelCED } from './consistency.js';
import * as path from 'node:path';

export interface BenchMeasurement {
  name: string;
  hz: number;
  meanMs: number;
  samples: number;
  scale: string;
}

export interface BenchResults {
  timestamp: string;
  regression: Array<{
    stage: string;
    passed: boolean;
    ms: number;
    detail: string;
  }>;
  performance: BenchMeasurement[];
  /** L2 (post-render validation) stats, if the stage was run */
  l2Stats?: {
    passed: boolean;
    ms: number;
    detail: string;
  };
  /** L1 issues from pre-render validation */
  l1Issues: ValidationIssue[];
  /** L2 issues from post-render validation (with Pass 2 analysis) */
  l2Issues: ValidationIssue[];
  /** Variant benchmark injection results */
  variants?: {
    branchA: { eventsLoaded: number; issues: ValidationIssue[] };
    branchB: { eventsLoaded: number; issues: ValidationIssue[] };
    errorInjection: Array<{
      file: string;
      description: string;
      expectedValidator: string;
      expectedSeverity: string;
      matched: boolean;
      actualIssueCount: number;
    }>;
    extremeDamage: Array<{
      file: string;
      description: string;
      expectedValidator: string;
      expectedSeverity: string;
      matched: boolean;
      actualIssueCount: number;
    }>;
  };
  /** Pipeline F1 scores from injection results */
  pipelineF1?: {
    precision: number;
    recall: number;
    f1: number;
    matchedCount: number;
    missedCount: number;
    falsePositiveCount: number;
  };
  /** Per-validator N-CED for L1 issues */
  l1PerValidator: PerValidatorBreakdown[];
  /** Per-validator N-CED for L2 issues */
  l2PerValidator: PerValidatorBreakdown[];
  /** Severity-level CED combining L1 and L2 */
  severityCED: SeverityLevelCED[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function trunc(s: string, max = 120): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function severityIcon(sev: string): string {
  switch (sev) {
    case 'error': return '🔴';
    case 'warning': return '🟡';
    case 'info': return '🔵';
    default: return '⚪';
  }
}

function issueTableRows(issues: ValidationIssue[], startIndex: number): string[] {
  return issues.map((iss, i) => {
    const n = startIndex + i + 1;
    const attr = iss.attribute ?? '';
    return `| ${n} | ${iss.validator} | ${severityIcon(iss.severity)} ${iss.severity} | ${iss.event} | ${iss.entity} | ${trunc(attr, 40)} | ${trunc(iss.message, 120)} |`;
  });
}

// ─── JSON Reporter ─────────────────────────────────────────────────────────

export function toJson(results: BenchResults): string {
  return JSON.stringify(results, null, 2);
}

// ─── Markdown Reporter ─────────────────────────────────────────────────────

export function toMarkdown(results: BenchResults): string {
  const lines: string[] = [];

  lines.push(`# Novalistically Benchmark Results`);
  lines.push('');
  lines.push(`**Timestamp:** ${results.timestamp}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // ── Regression ──────────────────────────────────────────────────────
  lines.push('## Regression Benchmarks (祝福)');
  lines.push('');
  lines.push('| Stage | Result | Time (ms) | Detail |');
  lines.push('|-------|--------|-----------|--------|');
  for (const f of results.regression) {
    const icon = f.passed ? '✅' : '❌';
    lines.push(`| ${f.stage} | ${icon} ${f.passed ? 'PASS' : 'FAIL'} | ${f.ms.toFixed(2)} | ${f.detail} |`);
  }
  lines.push('');

  // L2 post-render validation summary
  if (results.l2Stats) {
    lines.push('### L2 Post-Render Validation');
    lines.push('');
    lines.push('| Metric | Value |');
    lines.push('|--------|-------|');
    const icon = results.l2Stats.passed ? '✅' : '❌';
    lines.push(`| Status | ${icon} ${results.l2Stats.passed ? 'PASS' : 'FAIL'} |`);
    lines.push(`| Time | ${results.l2Stats.ms}ms |`);
    // Parse detail to extract counts if available
    const detail = results.l2Stats.detail;
    if (detail.includes('Post-render errors')) {
      lines.push(`| Detail | ${detail} |`);
    } else {
      lines.push(`| Note | ${detail} |`);
    }
    lines.push('');
  }

  // ── Variant Benchmarks ──────────────────────────────────────────────
  if (results.variants) {
    lines.push('## Variant Benchmarks');
    lines.push('');

    // Branch variants
    lines.push('### Branch Variants');
    lines.push('');
    lines.push('| Variant | Events Loaded | Issues |');
    lines.push('|---------|--------------|--------|');
    lines.push(`| Branch A | ${results.variants.branchA.eventsLoaded} | ${results.variants.branchA.issues.length} |`);
    lines.push(`| Branch B | ${results.variants.branchB.eventsLoaded} | ${results.variants.branchB.issues.length} |`);
    lines.push('');

    // Error injection results
    if (results.variants.errorInjection.length > 0) {
      const matched = results.variants.errorInjection.filter((r) => r.matched).length;
      const total = results.variants.errorInjection.length;
      lines.push('### Error Injection Validation');
      lines.push('');
      lines.push(`**Summary:** ${matched}/${total} injected errors detected (${Math.round((matched / total) * 100)}%)`);
      lines.push('');
      lines.push('| File | Expected Validator | Expected Severity | Matched | Actual Issues | Description |');
      lines.push('|------|-------------------|-------------------|---------|---------------|-------------|');
      for (const r of results.variants.errorInjection) {
        const icon = r.matched ? '✅' : '❌';
        lines.push(`| ${r.file} | ${r.expectedValidator} | ${r.expectedSeverity} | ${icon} ${r.matched ? 'Yes' : 'No'} | ${r.actualIssueCount} | ${trunc(r.description, 80)} |`);
      }
      lines.push('');
    }

    // Extreme damage results
    if (results.variants.extremeDamage.length > 0) {
      const matched = results.variants.extremeDamage.filter((r) => r.matched).length;
      const total = results.variants.extremeDamage.length;
      lines.push('### Extreme Damage Validation');
      lines.push('');
      lines.push(`**Summary:** ${matched}/${total} injected errors detected (${Math.round((matched / total) * 100)}%)`);
      lines.push('');
      lines.push('| File | Expected Validator | Expected Severity | Matched | Actual Issues | Description |');
      lines.push('|------|-------------------|-------------------|---------|---------------|-------------|');
      for (const r of results.variants.extremeDamage) {
        const icon = r.matched ? '✅' : '❌';
        lines.push(`| ${r.file} | ${r.expectedValidator} | ${r.expectedSeverity} | ${icon} ${r.matched ? 'Yes' : 'No'} | ${r.actualIssueCount} | ${trunc(r.description, 80)} |`);
      }
      lines.push('');
    }

    // Pipeline F1
    if (results.pipelineF1) {
      const f = results.pipelineF1;
      lines.push('### Pipeline F1 Score');
      lines.push('');
      lines.push('| Metric | Value |');
      lines.push('|--------|-------|');
      lines.push(`| Precision | ${f.precision} |`);
      lines.push(`| Recall | ${f.recall} |`);
      lines.push(`| F1 Score | ${f.f1} |`);
      lines.push(`| Matched | ${f.matchedCount} |`);
      lines.push(`| Missed | ${f.missedCount} |`);
      lines.push(`| False Positives | ${f.falsePositiveCount} |`);
      lines.push('');
    }

    lines.push('---');
    lines.push('');
  }

  // ── L1 Issues Table ──────────────────────────────────────────────────
  if (results.l1Issues.length > 0) {
    lines.push(`### L1 Issues (Pre-Render Validation) — ${results.l1Issues.length} issues`);
    lines.push('');
    lines.push('| # | Validator | Severity | Event | Entity | Attribute | Message |');
    lines.push('|---|-----------|----------|-------|--------|-----------|---------|');
    for (const row of issueTableRows(results.l1Issues, 0)) {
      lines.push(row);
    }
    lines.push('');
  }

  // ── L2 Issues Table ──────────────────────────────────────────────────
  if (results.l2Issues.length > 0) {
    lines.push(`### L2 Issues (Post-Render Validation with Pass 2) — ${results.l2Issues.length} issues`);
    lines.push('');
    lines.push('| # | Validator | Severity | Event | Entity | Attribute | Message |');
    lines.push('|---|-----------|----------|-------|--------|-----------|---------|');
    for (const row of issueTableRows(results.l2Issues, 0)) {
      lines.push(row);
    }
    lines.push('');
  }

  // ── Per-Validator Error Density (L1) ──────────────────────────────
  if (results.l1PerValidator && results.l1PerValidator.length > 0) {
    lines.push('### Per-Validator Error Density (L1)');
    lines.push('');
    lines.push('| Validator | Errors | Warnings | Infos | Issues | N-CED (per 10K words) |');
    lines.push('|-----------|--------|----------|-------|--------|------------------------|');
    for (const pv of results.l1PerValidator) {
      const total = pv.errors + pv.warnings + pv.infos;
      lines.push(`| ${pv.validator} | ${pv.errors} | ${pv.warnings} | ${pv.infos} | ${total} | ${pv.nCED.toFixed(2)} |`);
    }
    lines.push('');
  }

  // ── Per-Validator Error Density (L2) ──────────────────────────────
  if (results.l2PerValidator && results.l2PerValidator.length > 0) {
    lines.push('### Per-Validator Error Density (L2)');
    lines.push('');
    lines.push('| Validator | Errors | Warnings | Infos | Issues | N-CED (per 10K words) |');
    lines.push('|-----------|--------|----------|-------|--------|------------------------|');
    for (const pv of results.l2PerValidator) {
      const total = pv.errors + pv.warnings + pv.infos;
      lines.push(`| ${pv.validator} | ${pv.errors} | ${pv.warnings} | ${pv.infos} | ${total} | ${pv.nCED.toFixed(2)} |`);
    }
    lines.push('');
  }

  // ── Severity-Level CED ────────────────────────────────────────────
  if (results.severityCED && results.severityCED.length > 0) {
    lines.push('### Severity-Level CED');
    lines.push('');
    lines.push('| Severity | L1 CED | L2 CED |');
    lines.push('|----------|--------|--------|');
    for (const sc of results.severityCED) {
      lines.push(`| ${sc.severity} | ${sc.l1CED.toFixed(2)} | ${sc.l2CED.toFixed(2)} |`);
    }
    lines.push('');
  }

  // ── Performance Benchmarks ──────────────────────────────────────────
  lines.push('## Performance Benchmarks');
  lines.push('');
  lines.push('| Stage | Hz | Mean (ms) | Samples | Scale |');
  lines.push('|-------|----|-----------|---------|-------|');
  for (const p of results.performance) {
    lines.push(`| ${p.name} | ${p.hz.toFixed(1)} | ${p.meanMs.toFixed(3)} | ${p.samples} | ${p.scale} |`);
  }
  lines.push('');

  // Scaling summary table
  lines.push('### Scaling Summary');
  lines.push('');
  const byName = new Map<string, BenchMeasurement[]>();
  for (const m of results.performance) {
    const baseName = m.name.replace(/ \(N=\d+\)$/, '');
    if (!byName.has(baseName)) byName.set(baseName, []);
    byName.get(baseName)!.push(m);
  }
  lines.push('| Stage | N=10 | N=100 | N=1000 |');
  lines.push('|-------|------|-------|--------|');
  for (const [name, measures] of byName) {
    const n10 = measures.find((m) => m.scale === '10');
    const n100 = measures.find((m) => m.scale === '100');
    const n1000 = measures.find((m) => m.scale === '1000');
    const col10 = n10 ? `${n10.meanMs.toFixed(2)}ms` : '-';
    const col100 = n100 ? `${n100.meanMs.toFixed(2)}ms` : '-';
    const col1000 = n1000 ? `${n1000.meanMs.toFixed(2)}ms` : '-';
    lines.push(`| ${name} | ${col10} | ${col100} | ${col1000} |`);
  }
  lines.push('');

  return lines.join('\n');
}

// ─── File Writer ───────────────────────────────────────────────────────────

const RESULTS_DIR = new URL('../../../output/bench/', import.meta.url).pathname;

export function writeResults(results: BenchResults, storage?: Storage): string {
  const st = storage ?? new FsStorage();
  const ts = results.timestamp.replace(/[:.]/g, '-').replace(/T/, '_').replace(/Z/, '');
  const basePath = path.join(RESULTS_DIR, ts);

  st.mkdirp(RESULTS_DIR);
  const jsonPath = `${basePath}.json`;
  st.write(jsonPath, toJson(results));

  const mdPath = `${basePath}.md`;
  st.write(mdPath, toMarkdown(results));

  console.log(`[Reporters] Written ${jsonPath}`);
  console.log(`[Reporters] Written ${mdPath}`);

  return basePath;
}
