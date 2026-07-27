// ============================================================================
// ReportWriter — Unit Tests
// ============================================================================

import { describe, expect, it } from 'vitest';
import type { PipelineRunResult } from '../src/report/writer.js';
import { ReportWriter } from '../src/report/writer.js';
import type { Blocker, NextAction, StatusReport, ThreadSnapshot } from '../src/types/index.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeSampleResult(overrides?: Partial<PipelineRunResult>): PipelineRunResult {
  return {
    projectName: 'test-project',
    projectDir: '/tmp/test-project',
    generatedAt: '2026-07-22T12:00:00.000Z',
    passed: false,
    l1Issues: [
      {
        validator: 'CausalityValidator',
        severity: 'error',
        event: 'E1',
        entity: 'protagonist',
        attribute: 'motivation',
        message: 'Missing motivation for action',
        fixSuggestion: 'Add motivation precondition',
        fixAction: 'add_precondition',
        fixTarget: { file: 'events/E1.yaml', field: 'preconditions' },
      },
      {
        validator: 'TimelineValidator',
        severity: 'warning',
        event: 'E2',
        entity: 'timeline',
        attribute: 'order',
        message: 'Event order ambiguous',
        fixSuggestion: 'Add storyTime field',
        fixAction: 'add_field',
        fixTarget: { file: 'events/E2.yaml', field: 'storyTime' },
      },
    ],
    l2Issues: [
      {
        validator: 'VoiceDriftDetector',
        severity: 'error',
        event: 'E1',
        entity: 'narrator',
        attribute: 'voice',
        message: 'Voice drift detected in paragraph 3',
        fixSuggestion: 'Rewrite paragraph 3 to match narrative voice',
        fixAction: 'manual',
        fixTarget: { file: 'scenes/E1.md' },
      },
    ],
    iss: {
      overall: 72,
      target: 80,
      dimensions: [
        {
          name: 'Characterization',
          score: 70,
          max: 100,
          threshold: 60,
          status: 'yellow',
          gaps: [
            {
              entity: 'protagonist',
              suggestion: 'Add more traits',
              fixAction: 'add_field',
              fixTarget: 'entities/protagonist.yaml',
            },
          ],
        },
      ],
    },
    results: [
      {
        eventId: 'E1',
        prose: 'Once upon a time...',
        wordCount: 150,
        cacheHit: true,
        errors: [],
        validationErrors: 1,
        validationIssueMessages: ['Voice drift detected'],
        renderStart: 1000,
        renderEnd: 3500,
      },
      {
        eventId: 'E2',
        prose: 'The end.',
        wordCount: 50,
        cacheHit: false,
        errors: [],
        validationErrors: 0,
        validationIssueMessages: [],
        renderStart: 4000,
        renderEnd: 6000,
      },
    ],
    renderStatus: {
      ready: [],
      blocked: [],
      waiting: [],
      completed: ['E1', 'E2'],
    },
    threads: [
      {
        id: 'main-plot',
        name: 'Main Plot',
        progress: '3/5',
        lastAdvancedIn: 'E2',
        targetChapter: 10,
        currentChapter: 3,
        onTrack: true,
        risk: 'on_track',
      },
    ],
    blockers: [],
    nextActions: [
      {
        priority: 'high',
        category: 'validation',
        action: 'Fix missing motivation for protagonist',
        targetFile: 'events/E1.yaml',
      },
    ],
    guidance: 'Focus on character motivation in next events.',
    errors: [],
    ...overrides,
  };
}

function makeEmptyResult(): PipelineRunResult {
  return {
    projectName: 'empty-project',
    projectDir: '/tmp/empty-project',
    generatedAt: '2026-07-22T12:00:00.000Z',
    passed: true,
    l1Issues: [],
    l2Issues: [],
    results: [],
    renderStatus: { ready: [], blocked: [], waiting: [], completed: [] },
    threads: [],
    blockers: [],
    nextActions: [],
    guidance: '',
    errors: [],
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('ReportWriter', () => {
  describe('toMarkdown()', () => {
    it('produces markdown with expected sections for a result with issues', () => {
      const writer = new ReportWriter(makeSampleResult());
      const md = writer.toMarkdown();

      expect(md).toContain('# Validation Report — test-project');
      expect(md).toContain('**Generated:** 2026-07-22T12:00:00.000Z');
      expect(md).toContain('❌ **Validation failed');
      expect(md).toContain('## Summary');
      expect(md).toContain('## L1 Issues (Pre-Render Validation)');
      expect(md).toContain('## L2 Issues (Post-Render Validation with Pass 2)');
      expect(md).toContain('## Render Summary');
      expect(md).toContain('## Next Steps');
      expect(md).toContain('CausalityValidator');
      expect(md).toContain('VoiceDriftDetector');
      expect(md).toContain('Missing motivation');
      expect(md).toContain('🔴 error');
      expect(md).toContain('🟡 warning');
    });

    it('shows pass indicator when all validations pass', () => {
      const writer = new ReportWriter(makeEmptyResult());
      const md = writer.toMarkdown();
      expect(md).toContain('✅ **All validations passed.**');
    });

    it('omits L1 section when no L1 issues', () => {
      const result = makeSampleResult({ l1Issues: [] });
      const md = new ReportWriter(result).toMarkdown();
      expect(md).not.toContain('## L1 Issues');
      expect(md).toContain('## L2 Issues');
    });

    it('omits L2 section when no L2 issues', () => {
      const result = makeSampleResult({ l2Issues: [] });
      const md = new ReportWriter(result).toMarkdown();
      expect(md).toContain('## L1 Issues');
      expect(md).not.toContain('## L2 Issues');
    });

    it('omits Next Steps section when no next actions', () => {
      const result = makeSampleResult({ nextActions: [] });
      const md = new ReportWriter(result).toMarkdown();
      expect(md).not.toContain('## Next Steps');
    });

    it('omits Render Summary when no results', () => {
      const md = new ReportWriter(makeEmptyResult()).toMarkdown();
      expect(md).not.toContain('## Render Summary');
    });

    it('shows Pipeline Errors section when errors present', () => {
      const result = makeSampleResult({ errors: ['Provider connection failed'] });
      const md = new ReportWriter(result).toMarkdown();
      expect(md).toContain('## Pipeline Errors');
      expect(md).toContain('Provider connection failed');
    });
  });

  describe('toJSON()', () => {
    it('returns an object with all required top-level fields', () => {
      const json = new ReportWriter(makeSampleResult()).toJSON() as Record<string, unknown>;

      expect(json).toHaveProperty('projectName', 'test-project');
      expect(json).toHaveProperty('projectDir');
      expect(json).toHaveProperty('generatedAt');
      expect(json).toHaveProperty('passed', false);
      expect(json).toHaveProperty('validation');
      expect(json).toHaveProperty('iss');
      expect(json).toHaveProperty('render');
      expect(json).toHaveProperty('threads');
      expect(json).toHaveProperty('blockers');
      expect(json).toHaveProperty('nextActions');
      expect(json).toHaveProperty('guidance');
      expect(json).toHaveProperty('pipelineErrors');
    });

    it('includes correct issue counts in validation totals', () => {
      const json = new ReportWriter(makeSampleResult()).toJSON() as Record<string, any>;
      expect(json.validation.total.errors).toBe(2); // 1 L1 error + 1 L2 error
      expect(json.validation.total.warnings).toBe(1); // 1 L1 warning
    });

    it('includes render events with timing data', () => {
      const json = new ReportWriter(makeSampleResult()).toJSON() as Record<string, any>;
      expect(json.render.events).toHaveLength(2);
      expect(json.render.events[0].eventId).toBe('E1');
      expect(json.render.events[0].renderTimeMs).toBe(2500);
      expect(json.render.events[1].renderTimeMs).toBe(2000);
    });

    it('includes ISS data when present', () => {
      const json = new ReportWriter(makeSampleResult()).toJSON() as Record<string, any>;
      expect(json.iss).not.toBeNull();
      expect(json.iss.overall).toBe(72);
    });

    it('includes ISS as null when absent', () => {
      const result = makeSampleResult({ iss: undefined });
      const json = new ReportWriter(result).toJSON() as Record<string, any>;
      expect(json.iss).toBeNull();
    });
  });

  describe('toStatusReport()', () => {
    it('returns a valid StatusReport', () => {
      const status = new ReportWriter(makeSampleResult()).toStatusReport();

      expect(status).toHaveProperty('project', 'test-project');
      expect(status).toHaveProperty('timestamp');
      expect(status).toHaveProperty('iss');
      expect(status).toHaveProperty('validation');
      expect(status).toHaveProperty('threads');
      expect(status).toHaveProperty('render');
      expect(status).toHaveProperty('blockers');
      expect(status).toHaveProperty('nextActions');
      expect(status).toHaveProperty('guidance');
    });

    it('separates errors and warnings in validation', () => {
      const status = new ReportWriter(makeSampleResult()).toStatusReport();
      expect(status.validation.errors).toHaveLength(2); // 1 L1 error + 1 L2 error
      expect(status.validation.warnings).toHaveLength(1); // 1 L1 warning
    });

    it('maps render status correctly', () => {
      const status = new ReportWriter(makeSampleResult()).toStatusReport();
      expect(status.render.completed).toEqual(['E1', 'E2']);
      expect(status.render.ready).toEqual([]);
      expect(status.render.blocked).toEqual([]);
    });

    it('provides default ISS when absent', () => {
      const result = makeSampleResult({ iss: undefined });
      const status = new ReportWriter(result).toStatusReport();
      expect(status.iss.overall).toBe(0);
      expect(status.iss.dimensions).toEqual([]);
    });
  });

  describe('toBenchReport()', () => {
    it('returns a BenchReport with all metric fields', () => {
      const bench = new ReportWriter(makeSampleResult()).toBenchReport();

      expect(bench).toHaveProperty('timestamp');
      expect(bench).toHaveProperty('projectName', 'test-project');
      expect(bench).toHaveProperty('totalEvents', 2);
      expect(bench).toHaveProperty('renderedEvents', 2);
      expect(bench).toHaveProperty('totalValidationIssues', 3);
      expect(bench).toHaveProperty('errorsCount', 2);
      expect(bench).toHaveProperty('warningsCount', 1);
      expect(bench).toHaveProperty('infosCount', 0);
      expect(bench).toHaveProperty('cacheHitCount', 1);
      expect(bench).toHaveProperty('cacheHitRate', 0.5);
      expect(bench).toHaveProperty('passed', false);
    });

    it('calculates timing averages correctly', () => {
      const bench = new ReportWriter(makeSampleResult()).toBenchReport();
      expect(bench.totalRenderTimeMs).toBe(4500); // 2500 + 2000
      expect(bench.averageRenderTimeMs).toBe(2250);
    });

    it('reports zero metrics for empty result', () => {
      const bench = new ReportWriter(makeEmptyResult()).toBenchReport();
      expect(bench.totalEvents).toBe(0);
      expect(bench.renderedEvents).toBe(0);
      expect(bench.totalValidationIssues).toBe(0);
      expect(bench.cacheHitRate).toBe(0);
      expect(bench.averageRenderTimeMs).toBe(0);
      expect(bench.passed).toBe(true);
    });
  });
});
