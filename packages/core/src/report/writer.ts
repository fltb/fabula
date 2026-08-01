// ============================================================================
// ReportWriter — Unified report output format generator (D11)
// ============================================================================

import type { ProviderCallLedgerEntry } from '../pipeline/render.js';
import type {
  AnalysisResult,
  Blocker,
  ISSSnapshot,
  NextAction,
  StatusReport,
  ThreadSnapshot,
  ValidationIssue,
} from '../types/index.js';

// ——— PipelineRunResult ———

export interface PipelineRunResult {
  projectName: string;
  projectDir: string;
  generatedAt: string;

  /** Overall validation passed/failed */
  passed: boolean;
  /** Pre-render (L1) validation issues */
  l1Issues: ValidationIssue[];
  /** Post-render (L2) validation issues */
  l2Issues: ValidationIssue[];

  /** ISS snapshot (optional — absent in validation-only runs) */
  iss?: ISSSnapshot;

  /** Per-event render results */
  results: Array<{
    eventId: string;
    prose?: string;
    wordCount?: number;
    cacheHit?: boolean;
    errors?: string[];
    validationErrors?: number;
    validationIssueMessages?: string[];
    analysis?: AnalysisResult | null;
    providerCalls?: ProviderCallLedgerEntry[];
    promptHash?: string;
    pass2Rejection?: string;
    renderStart?: number;
    renderEnd?: number;
  }>;

  /** Render status lists (eventIds by category) */
  renderStatus: {
    ready: string[];
    blocked: string[];
    waiting: string[];
    completed: string[];
  };

  /** Thread snapshots for status report */
  threads: ThreadSnapshot[];
  /** Blocked event reasons */
  blockers: Blocker[];
  /** Suggested next actions */
  nextActions: NextAction[];
  /** Human-readable guidance */
  guidance: string;

  /** Pipeline-level errors */
  errors: string[];
}

// ——— BenchReport (developer-facing) ———

export interface BenchReport {
  timestamp: string;
  projectName: string;
  totalEvents: number;
  renderedEvents: number;
  totalValidationIssues: number;
  errorsCount: number;
  warningsCount: number;
  infosCount: number;
  cacheHitCount: number;
  cacheHitRate: number;
  averageRenderTimeMs: number;
  totalRenderTimeMs: number;
  passed: boolean;
}

// ——— Internal helpers ———

function severityIcon(sev: string): string {
  switch (sev) {
    case 'error':
      return '🔴';
    case 'warning':
      return '🟡';
    case 'info':
      return '🔵';
    default:
      return '⚪';
  }
}

function trunc(s: string, max = 120): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function issueTableRows(issues: ValidationIssue[], startIndex = 1): string[] {
  return issues.map((iss, i) => {
    const n = startIndex + i;
    const attr = iss.attribute ?? '';
    const ref = iss.observationRef
      ? iss.observationRef.analysisPointer
        ? `${iss.observationRef.field} ${iss.observationRef.analysisPointer}`
        : iss.observationRef.field
      : '';
    return `| ${n} | ${iss.validator} | ${severityIcon(iss.severity)} ${iss.severity} | ${iss.kind} | ${iss.event} | ${iss.entity} | ${trunc(attr, 40)} | ${trunc(ref, 48)} | ${trunc(iss.message)} |`;
  });
}

// ——— ReportWriter ———

export class ReportWriter {
  constructor(private result: PipelineRunResult) {}

  // ── User-facing Markdown report ────────────────────────────────────

  toMarkdown(): string {
    const r = this.result;
    const lines: string[] = [];

    lines.push(`# Validation Report — ${r.projectName}`);
    lines.push('');
    lines.push(`**Generated:** ${r.generatedAt}`);
    lines.push('');

    const l1Errors = r.l1Issues.filter((i) => i.severity === 'error').length;
    const l1Warnings = r.l1Issues.filter((i) => i.severity === 'warning').length;
    const l1Infos = r.l1Issues.filter((i) => i.severity === 'info').length;
    const l2Errors = r.l2Issues.filter((i) => i.severity === 'error').length;
    const l2Warnings = r.l2Issues.filter((i) => i.severity === 'warning').length;
    const l2Infos = r.l2Issues.filter((i) => i.severity === 'info').length;

    // Summary header with pass/fail
    if (r.passed) {
      lines.push('✅ **All validations passed.**');
    } else {
      lines.push('❌ **Validation failed — issues found.**');
    }
    lines.push('');

    lines.push('## Summary');
    lines.push('');
    lines.push('| Layer | Errors | Warnings | Infos | Total |');
    lines.push('|-------|--------|----------|-------|-------|');
    lines.push(
      `| L1 (Pre-render) | ${l1Errors} | ${l1Warnings} | ${l1Infos} | ${r.l1Issues.length} |`,
    );
    lines.push(
      `| L2 (Post-render) | ${l2Errors} | ${l2Warnings} | ${l2Infos} | ${r.l2Issues.length} |`,
    );
    lines.push('');

    if (r.l1Issues.length > 0) {
      lines.push('## L1 Issues (Pre-Render Validation)');
      lines.push('');
      lines.push(
        '| # | Validator | Severity | Kind | Event | Entity | Attribute | Observation | Message |',
      );
      lines.push(
        '|---|-----------|----------|------|-------|--------|-----------|-------------|---------|',
      );
      lines.push(
        ...issueTableRows(
          r.l1Issues.sort((a, b) => {
            if (a.severity !== b.severity) {
              const order = { error: 0, warning: 1, info: 2 };
              return order[a.severity] - order[b.severity];
            }
            return a.validator.localeCompare(b.validator);
          }),
        ),
      );
      lines.push('');
    }

    if (r.l2Issues.length > 0) {
      lines.push('## L2 Issues (Post-Render Validation with Pass 2)');
      lines.push('');
      lines.push(
        '| # | Validator | Severity | Kind | Event | Entity | Attribute | Observation | Message |',
      );
      lines.push(
        '|---|-----------|----------|------|-------|--------|-----------|-------------|---------|',
      );
      lines.push(
        ...issueTableRows(
          r.l2Issues.sort((a, b) => {
            if (a.severity !== b.severity) {
              const order = { error: 0, warning: 1, info: 2 };
              return order[a.severity] - order[b.severity];
            }
            return a.validator.localeCompare(b.validator);
          }),
          r.l1Issues.length + 1,
        ),
      );
      lines.push('');
    }

    // Render summary
    const renderedCount = r.results.filter((res) => res.prose && res.prose.length > 0).length;
    if (r.results.length > 0) {
      lines.push('## Render Summary');
      lines.push('');
      lines.push(`| Metric | Value |`);
      lines.push('|--------|-------|');
      lines.push(`| Total events | ${r.results.length} |`);
      lines.push(`| Rendered | ${renderedCount} |`);
      lines.push(`| Cache hits | ${r.results.filter((res) => res.cacheHit).length} |`);
      lines.push(
        `| Render errors | ${r.results.filter((res) => res.errors && res.errors.length > 0).length} |`,
      );
      const totalTime = r.results.reduce((sum, res) => {
        if (res.renderStart !== undefined && res.renderEnd !== undefined) {
          return sum + (res.renderEnd - res.renderStart);
        }
        return sum;
      }, 0);
      if (totalTime > 0) {
        lines.push(`| Total render time | ${totalTime}ms |`);
      }
      lines.push('');
    }

    // Next steps
    if (r.nextActions.length > 0) {
      lines.push('## Next Steps');
      lines.push('');
      lines.push('| Priority | Category | Action | Target |');
      lines.push('|----------|----------|--------|--------|');
      for (const action of r.nextActions) {
        const priorityIcon =
          action.priority === 'critical'
            ? '🔴'
            : action.priority === 'high'
              ? '🟠'
              : action.priority === 'medium'
                ? '🟡'
                : '🔵';
        lines.push(
          `| ${priorityIcon} ${action.priority} | ${action.category} | ${action.action} | ${action.targetFile ?? '-'} |`,
        );
      }
      lines.push('');
    }

    // Pipeline errors
    if (r.errors.length > 0) {
      lines.push('## Pipeline Errors');
      lines.push('');
      for (const err of r.errors) {
        lines.push(`- ❌ ${err}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  // ── Machine-readable JSON ──────────────────────────────────────────

  toJSON(): object {
    return {
      projectName: this.result.projectName,
      projectDir: this.result.projectDir,
      generatedAt: this.result.generatedAt,
      passed: this.result.passed,
      validation: {
        l1Issues: this.result.l1Issues,
        l2Issues: this.result.l2Issues,
        total: {
          errors:
            this.result.l1Issues.filter((i) => i.severity === 'error').length +
            this.result.l2Issues.filter((i) => i.severity === 'error').length,
          warnings:
            this.result.l1Issues.filter((i) => i.severity === 'warning').length +
            this.result.l2Issues.filter((i) => i.severity === 'warning').length,
          infos:
            this.result.l1Issues.filter((i) => i.severity === 'info').length +
            this.result.l2Issues.filter((i) => i.severity === 'info').length,
        },
      },
      iss: this.result.iss ?? null,
      render: {
        events: this.result.results.map((res) => ({
          eventId: res.eventId,
          wordCount: res.wordCount ?? 0,
          cacheHit: res.cacheHit ?? false,
          validationErrors: res.validationErrors ?? 0,
          errors: res.errors ?? [],
          pass2Rejection: res.pass2Rejection ?? null,
          renderTimeMs:
            res.renderStart !== undefined && res.renderEnd !== undefined
              ? res.renderEnd - res.renderStart
              : undefined,
        })),
        status: this.result.renderStatus,
      },
      threads: this.result.threads.map((t) => ({
        id: t.id,
        name: t.name,
        progress: t.progress,
        risk: t.risk,
        onTrack: t.onTrack,
      })),
      blockers: this.result.blockers,
      nextActions: this.result.nextActions,
      guidance: this.result.guidance,
      pipelineErrors: this.result.errors,
    };
  }

  // ── MCP StatusReport ───────────────────────────────────────────────

  toStatusReport(): StatusReport {
    const r = this.result;
    const allErrors: ValidationIssue[] = [
      ...r.l1Issues.filter((i) => i.severity === 'error'),
      ...r.l2Issues.filter((i) => i.severity === 'error'),
    ];
    const allWarnings: ValidationIssue[] = [
      ...r.l1Issues.filter((i) => i.severity === 'warning'),
      ...r.l2Issues.filter((i) => i.severity === 'warning'),
    ];

    return {
      project: r.projectName,
      timestamp: r.generatedAt,
      iss: r.iss ?? {
        overall: 0,
        target: 0,
        dimensions: [],
      },
      validation: {
        lastRun: r.generatedAt,
        errors: allErrors,
        warnings: allWarnings,
      },
      threads: r.threads,
      render: {
        ready: r.renderStatus.ready,
        blocked: r.renderStatus.blocked,
        waiting: r.renderStatus.waiting,
        completed: r.renderStatus.completed,
      },
      blockers: r.blockers,
      nextActions: r.nextActions,
      guidance: r.guidance,
    };
  }

  // ── Developer bench report ─────────────────────────────────────────

  toBenchReport(): BenchReport {
    const r = this.result;
    const renderedResults = r.results.filter(
      (res) => res.renderStart !== undefined || (res.prose && res.prose.length > 0),
    );
    const totalRenderTimeMs = r.results.reduce((sum, res) => {
      if (res.renderStart !== undefined && res.renderEnd !== undefined) {
        return sum + (res.renderEnd - res.renderStart);
      }
      return sum;
    }, 0);
    const timedCount = r.results.filter(
      (res) => res.renderStart !== undefined && res.renderEnd !== undefined,
    ).length;
    const cacheHits = r.results.filter((res) => res.cacheHit).length;
    const totalIssues = r.l1Issues.length + r.l2Issues.length;

    return {
      timestamp: r.generatedAt,
      projectName: r.projectName,
      totalEvents: r.results.length,
      renderedEvents: renderedResults.length,
      totalValidationIssues: totalIssues,
      errorsCount:
        r.l1Issues.filter((i) => i.severity === 'error').length +
        r.l2Issues.filter((i) => i.severity === 'error').length,
      warningsCount:
        r.l1Issues.filter((i) => i.severity === 'warning').length +
        r.l2Issues.filter((i) => i.severity === 'warning').length,
      infosCount:
        r.l1Issues.filter((i) => i.severity === 'info').length +
        r.l2Issues.filter((i) => i.severity === 'info').length,
      cacheHitCount: cacheHits,
      cacheHitRate: r.results.length > 0 ? cacheHits / r.results.length : 0,
      averageRenderTimeMs: timedCount > 0 ? Math.round(totalRenderTimeMs / timedCount) : 0,
      totalRenderTimeMs,
      passed: r.passed,
    };
  }
}
