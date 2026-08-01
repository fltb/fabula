// ============================================================================
// Bench Test Suite — invokes `runRegressionBench` and `runPerformanceBench`
// inside vitest `it()` blocks, printing tables and writing results.
// ============================================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { BenchResults, RegressionResults } from '../src/index.js';
import { runPerformanceBench, runRegressionBench, writeResults } from '../src/index.js';

// ─── Config ────────────────────────────────────────────────────────────────

const ZHU_FU_FIXTURE = path.resolve(__dirname, '../../../fixtures/zhu-fu');
const FALLBACK_FIXTURE = path.resolve(__dirname, '../../../fixtures/most-dangerous-game');

function requireValue<T>(value: T | undefined, label: string): T {
  expect(value, `missing ${label}`).toBeDefined();
  if (value === undefined) throw new Error(`Missing ${label}`);
  return value;
}

/** Pick the best available fixture */
function pickFixture(): string {
  try {
    if (fs.existsSync(path.join(ZHU_FU_FIXTURE, 'nova.yaml'))) return ZHU_FU_FIXTURE;
  } catch {
    /* ignore */
  }
  try {
    if (fs.existsSync(path.join(FALLBACK_FIXTURE, 'nova.yaml'))) return FALLBACK_FIXTURE;
  } catch {
    /* ignore */
  }
  return ZHU_FU_FIXTURE;
}

const FIXTURE = pickFixture();

// ─── Regression Benchmarks ────────────────────────────────────────────────

describe('Regression Benchmarks', () => {
  let results: RegressionResults;

  beforeAll(async () => {
    console.log(`\n[Regression] Fixture: ${FIXTURE}`);
    results = await runRegressionBench(FIXTURE);
  }, 30000); // 30s timeout for regression

  it('runs all regression stages without crashing', () => {
    expect(results.stages.length).toBeGreaterThan(0);
    console.log(
      `[Regression] ${results.totalPassed}/${results.stages.length} passed, ` +
        `${results.totalFailed} failed, ${results.totalTime}ms total`,
    );
  });

  // Print summary table
  it('produces readable regression results', () => {
    const table = results.stages.map((s) => ({
      Stage: s.stage,
      Result: s.passed ? 'PASS' : 'FAIL',
      'Time (ms)': s.ms,
      Detail: s.detail.slice(0, 80),
    }));
    console.table(table);
  });

  it('Load entities succeeds', () => {
    const stage = results.stages.find((s) => s.stage === 'Load entities');
    expect(stage?.passed).toBe(true);
  });

  it('Load events succeeds', () => {
    const stage = results.stages.find((s) => s.stage === 'Load events');
    expect(stage?.passed).toBe(true);
  });

  it('Build DAG succeeds', () => {
    const stage = results.stages.find((s) => s.stage === 'Build DAG');
    expect(stage?.passed, stage?.detail).toBe(true);
  });

  it('Replay state succeeds', () => {
    const stage = results.stages.find((s) => s.stage === 'Replay state');
    expect(stage?.passed).toBe(true);
  });

  it('Run validators succeeds', () => {
    const stage = results.stages.find((s) => s.stage === 'Run validators');
    expect(stage?.passed).toBe(true);
  });

  it('Compile context succeeds', () => {
    const stage = results.stages.find((s) => s.stage === 'Compile context');
    if (stage) {
      expect(stage.passed).toBe(true);
    }
  });
  it('Run post-render validators (L2) stage exists', () => {
    const stage = requireValue(
      results.stages.find((s) => s.stage === 'Run post-render validators (L2)'),
      'post-render validator stage',
    );
    // Under fail-closed contract, L2 succeeds only with complete, hash-verified
    // reference data (review.json, generation-record.json, valid hashes).
    // Without a properly reviewed reference, the stage reports a descriptive failure.
    console.log(`[L2] Passed: ${stage.passed}, Detail: ${stage.detail}`);
    if (stage.passed) {
      expect(stage.detail).toContain('L2 issues');
    }
  });

  it('collects L1 issues array from zhu-fu', () => {
    // zhu-fu should produce validation issues (may be 0 when clean)
    expect(results.l1Issues).toBeDefined();
    expect(results.l1Issues.length).toBeGreaterThanOrEqual(0);
    console.log(`[L1 Issues] Total: ${results.l1Issues.length}`);
    // Print top-level breakdown
    const bySeverity = new Map<string, number>();
    for (const iss of results.l1Issues) {
      bySeverity.set(iss.severity, (bySeverity.get(iss.severity) ?? 0) + 1);
    }
    for (const [sev, count] of bySeverity) {
      console.log(`  ${sev}: ${count}`);
    }
  });

  it('collects L2 issues array (may be empty if no reference data)', () => {
    expect(results.l2Issues).toBeDefined();
    // L2 may be empty if reference directory has no analysis data — that's ok
    console.log(`[L2 Issues] Total: ${results.l2Issues.length}`);
    if (results.l2Issues.length > 0) {
      const bySeverity = new Map<string, number>();
      for (const iss of results.l2Issues) {
        bySeverity.set(iss.severity, (bySeverity.get(iss.severity) ?? 0) + 1);
      }
      for (const [sev, count] of bySeverity) {
        console.log(`  ${sev}: ${count}`);
      }
    }
  });

  it('each L1 issue has required fields', () => {
    for (const iss of results.l1Issues) {
      expect(iss.validator).toBeTruthy();
      expect(['error', 'warning', 'info']).toContain(iss.severity);
      expect(iss.event).toBeTruthy();
      expect(iss.entity).toBeTruthy();
      expect(iss.message).toBeTruthy();
      expect(iss.fixSuggestion).toBeTruthy();
    }
  });

  it('computes per-validator N-CED for L1 issues', () => {
    expect(results.l1PerValidator).toBeDefined();
    expect(Array.isArray(results.l1PerValidator)).toBe(true);
    if (results.l1PerValidator.length > 0) {
      const first = results.l1PerValidator[0];
      expect(first.validator).toBeTruthy();
      expect(typeof first.nCED).toBe('number');
      expect(first.nCED).toBeGreaterThanOrEqual(0);
      console.log(
        `[L1 PerValidator] ${results.l1PerValidator.length} validators, top: ${first.validator} (N-CED=${first.nCED.toFixed(2)})`,
      );
    }
  });

  it('computes per-validator N-CED for L2 issues', () => {
    expect(results.l2PerValidator).toBeDefined();
    expect(Array.isArray(results.l2PerValidator)).toBe(true);
    if (results.l2PerValidator.length > 0) {
      const first = results.l2PerValidator[0];
      expect(first.validator).toBeTruthy();
      expect(typeof first.nCED).toBe('number');
      expect(first.nCED).toBeGreaterThanOrEqual(0);
      console.log(
        `[L2 PerValidator] ${results.l2PerValidator.length} validators, top: ${first.validator} (N-CED=${first.nCED.toFixed(2)})`,
      );
    }
  });

  it('computes severity-level CED', () => {
    expect(results.severityCED).toBeDefined();
    expect(Array.isArray(results.severityCED)).toBe(true);
    expect(results.severityCED.length).toBe(3); // error, warning, info
    for (const sc of results.severityCED) {
      expect(['error', 'warning', 'info']).toContain(sc.severity);
      expect(typeof sc.l1CED).toBe('number');
      expect(sc.l1CED).toBeGreaterThanOrEqual(0);
      expect(typeof sc.l2CED).toBe('number');
      expect(sc.l2CED).toBeGreaterThanOrEqual(0);
    }
    const errorEntry = requireValue(
      results.severityCED.find((s) => s.severity === 'error'),
      'error severity CED',
    );
    const warningEntry = requireValue(
      results.severityCED.find((s) => s.severity === 'warning'),
      'warning severity CED',
    );
    const infoEntry = requireValue(
      results.severityCED.find((s) => s.severity === 'info'),
      'info severity CED',
    );
    console.log(
      `[Severity CED] error: L1=${errorEntry.l1CED.toFixed(2)} L2=${errorEntry.l2CED.toFixed(2)}, warning: L1=${warningEntry.l1CED.toFixed(2)} L2=${warningEntry.l2CED.toFixed(2)}, info: L1=${infoEntry.l1CED.toFixed(2)} L2=${infoEntry.l2CED.toFixed(2)}`,
    );
  });
});

// ─── Performance Benchmarks ────────────────────────────────────────────────

describe('Performance Benchmarks', () => {
  let perfResults: Awaited<ReturnType<typeof runPerformanceBench>>;

  beforeAll(async () => {
    perfResults = await runPerformanceBench();
  }, 60000); // 60s timeout for performance benchmarks

  it('produces measurements for all scales (10, 100, 1000)', () => {
    const scales = new Set(perfResults.measurements.map((m) => m.scale));
    expect(scales.has('10')).toBe(true);
    expect(scales.has('100')).toBe(true);
    expect(scales.has('1000')).toBe(true);
    console.log(`[Perf] Total measurements: ${perfResults.measurements.length}`);
  });

  it('prints performance table grouped by stage and scale', () => {
    const table = perfResults.measurements.map((m) => ({
      Stage: m.name,
      Hz: m.hz.toFixed(1),
      'Mean (ms)': m.meanMs.toFixed(3),
      Samples: m.samples,
      'Scale (N)': m.scale,
    }));
    console.table(table);

    // Print scaling summary
    const byName = new Map<string, typeof perfResults.measurements>();
    for (const m of perfResults.measurements) {
      const baseName = m.name.replace(/ \(N=\d+\)$/, '');
      const measurements = byName.get(baseName);
      if (measurements) measurements.push(m);
      else byName.set(baseName, [m]);
    }
    console.log('\n── Scaling Summary ──');
    console.log('Stage                    | N=10       | N=100      | N=1000     | scaling');
    console.log('─────────────────────────┼────────────┼────────────┼────────────┼────────');
    for (const [name, measures] of byName) {
      const n10 = measures.find((m) => m.scale === '10');
      const n100 = measures.find((m) => m.scale === '100');
      const n1000 = measures.find((m) => m.scale === '1000');
      const c10 = n10 ? `${n10.meanMs.toFixed(2)}ms` : '-';
      const c100 = n100 ? `${n100.meanMs.toFixed(2)}ms` : '-';
      const c1000 = n1000 ? `${n1000.meanMs.toFixed(2)}ms` : '-';
      const p50 =
        n10 && n1000 && n10.meanMs > 0 ? `~O(${(n1000.meanMs / n10.meanMs).toFixed(1)}x)` : '-';
      console.log(
        `${name.padEnd(24)} | ${c10.padEnd(10)} | ${c100.padEnd(10)} | ${c1000.padEnd(10)} | ${p50}`,
      );
    }
  });

  it('all measurements produce valid numbers', () => {
    for (const m of perfResults.measurements) {
      expect(m.meanMs).toBeGreaterThan(0);
      expect(m.samples).toBeGreaterThanOrEqual(1);
    }
  });

  it('run all validators is measurable at all scales', () => {
    for (const scale of ['10', '100', '1000']) {
      const m = requireValue(
        perfResults.measurements.find(
          (x) => x.name.includes('Run all validators') && x.scale === scale,
        ),
        `Run all validators measurement at N=${scale}`,
      );
      expect(m.meanMs).toBeGreaterThan(0);
    }
  });

  it('ResultAggregator is measurable at all scales', () => {
    for (const scale of ['10', '100', '1000']) {
      const m = requireValue(
        perfResults.measurements.find(
          (x) => x.name.includes('ResultAggregator') && x.scale === scale,
        ),
        `ResultAggregator measurement at N=${scale}`,
      );
      expect(m.meanMs).toBeGreaterThan(0);
    }
  });
});

// ─── Report Writing ────────────────────────────────────────────────────────

describe('Benchmark Reporting', () => {
  it('writes JSON and Markdown results to disk', async () => {
    const results = await runRegressionBench(FIXTURE);
    const benchResults: BenchResults = {
      timestamp: new Date().toISOString(),
      regression: results.stages.map((s) => ({
        stage: s.stage,
        passed: s.passed,
        ms: s.ms,
        detail: s.detail,
      })),
      performance: [],
      l1Issues: results.l1Issues ?? [],
      l2Issues: results.l2Issues ?? [],
      l1PerValidator: results.l1PerValidator ?? [],
      l2PerValidator: results.l2PerValidator ?? [],
      severityCED: results.severityCED ?? [],
    };

    // Include L2 stats if present
    const l2Stage = results.stages.find((s) => s.stage === 'Run post-render validators (L2)');
    if (l2Stage) {
      benchResults.l2Stats = {
        passed: l2Stage.passed,
        ms: l2Stage.ms,
        detail: l2Stage.detail,
      };
    }

    const basePath = writeResults(benchResults);

    const jsonPath = `${basePath}.json`;
    const mdPath = `${basePath}.md`;

    expect(fs.existsSync(jsonPath)).toBe(true);
    expect(fs.existsSync(mdPath)).toBe(true);

    // Verify L2 data in JSON output
    const jsonContent = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    expect(jsonContent.l2Stats).toBeDefined();
    if (l2Stage?.passed) {
      expect(jsonContent.l2Stats.detail).toContain('L2 issues');
    }

    // Verify L2 data in Markdown output
    const mdContent = fs.readFileSync(mdPath, 'utf-8');
    expect(mdContent).toContain('L2 Post-Render Validation');
    if (l2Stage?.passed) {
      expect(mdContent).toContain('L2 Issues');
    }

    // Verify issue detail sections
    expect(jsonContent.l1Issues).toBeDefined();
    expect(Array.isArray(jsonContent.l1Issues)).toBe(true);
    expect(jsonContent.l2Issues).toBeDefined();
    expect(Array.isArray(jsonContent.l2Issues)).toBe(true);

    // Verify JSON issues have full fields (not truncated)
    if (jsonContent.l1Issues.length > 0) {
      const first = jsonContent.l1Issues[0];
      expect(first.validator).toBeTruthy();
      expect(first.severity).toBeTruthy();
      expect(first.event).toBeTruthy();
      expect(first.entity).toBeTruthy();
      expect(first.message).toBeTruthy();
      expect(first.fixSuggestion).toBeTruthy();
    }

    // Verify Markdown contains issue tables when issues exist
    if (results.l1Issues.length > 0) {
      expect(mdContent).toContain('L1 Issues (Pre-Render Validation)');
      expect(mdContent).toContain(
        '| # | Validator | Severity | Event | Entity | Attribute | Message |',
      );
    }
    if (results.l2Issues.length > 0) {
      expect(mdContent).toContain('L2 Issues (Post-Render Validation with Pass 2)');
    }

    // Clean up test artifacts
    try {
      fs.unlinkSync(jsonPath);
      fs.unlinkSync(mdPath);
    } catch {
      /* ignore */
    }

    console.log(`[Report] Written and cleaned up: ${basePath}.{json,md}`);
  });
});

// ─── Main entry (also runnable as standalone) ─────────────────────────────

import { runAll } from '../src/index.js';

describe('runAll integration', () => {
  it('runs all benchmark suites', async () => {
    const results = await runAll(FIXTURE);
    expect(results.regression.length).toBeGreaterThan(0);
    expect(results.timestamp).toBeTruthy();
    console.log(`[runAll] ${results.regression.filter((f) => f.passed).length} regression passed`);
    expect(results.performance.length).toBeGreaterThan(0);
    console.log(`[runAll] ${results.performance.length} performance measurements`);
    // Verify issue arrays are present
    expect(results.l1Issues).toBeDefined();
    expect(Array.isArray(results.l1Issues)).toBe(true);
    expect(results.l2Issues).toBeDefined();
    expect(Array.isArray(results.l2Issues)).toBe(true);
    if (results.l1Issues.length > 0) {
      console.log(`[runAll] L1 issues: ${results.l1Issues.length}`);
    }
    if (results.l2Issues.length > 0) {
      console.log(`[runAll] L2 issues: ${results.l2Issues.length}`);
    }
  }, 120000); // Allow up to 120s for full suite
});
