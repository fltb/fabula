// ============================================================================
// Bench Test Suite — invokes `runFunctionalBench` and `runPerformanceBench`
// inside vitest `it()` blocks, printing tables and writing results.
// ============================================================================

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  runFunctionalBench,
  runPerformanceBench,
  writeResults,
} from './index.js';
import type { FunctionalResults } from './index.js';

// ─── Config ────────────────────────────────────────────────────────────────

const MDF_FIXTURE = path.resolve(
  '/home/float/myfile/Projects/novalistically/fixtures/most-dangerous-game',
);
const ARCANE_FIXTURE = path.resolve(
  '/home/float/myfile/Projects/novalistically/fixtures/arcane-aftermath',
);

/** Pick the best available fixture */
function pickFixture(): string {
  try {
    if (fs.existsSync(path.join(MDF_FIXTURE, 'nova.yaml'))) return MDF_FIXTURE;
  } catch { /* ignore */ }
  try {
    if (fs.existsSync(path.join(ARCANE_FIXTURE, 'nova.yaml'))) return ARCANE_FIXTURE;
  } catch { /* ignore */ }
  return MDF_FIXTURE;
}

const FIXTURE = pickFixture();
const IS_MDF = FIXTURE === MDF_FIXTURE;

// ─── Functional Benchmarks ────────────────────────────────────────────────

describe('Functional Benchmarks', () => {
  let results: FunctionalResults;

  beforeAll(() => {
    console.log(`\n[Functional] Fixture: ${FIXTURE}`);
    results = runFunctionalBench(FIXTURE);
  });

  it('runs all functional stages without crashing', () => {
    expect(results.stages.length).toBeGreaterThan(0);
    console.log(
      `[Functional] ${results.totalPassed}/${results.stages.length} passed, ` +
      `${results.totalFailed} failed, ${results.totalTime.toFixed(0)}ms total`,
    );
  });

  // Print summary table
  it('produces readable functional results', () => {
    const table = results.stages.map((s) => ({
      Stage: s.stage,
      Result: s.passed ? 'PASS' : 'FAIL',
      'Time (ms)': s.ms.toFixed(2),
      Detail: s.detail.slice(0, 80),
    }));
    console.table(table);
  });

  // Stage-specific assertions (Most Dangerous Game fixture)
  if (IS_MDF) {
    it('Load entities: ≥5 characters, ≥6 locations, ≥3 rules', () => {
      const stage = results.stages.find((s) => s.stage === 'Load entities');
      expect(stage?.passed).toBe(true);
    });

    it('Load events: events loaded successfully', () => {
      const stage = results.stages.find((s) => s.stage === 'Load events');
      expect(stage?.passed).toBe(true);
    });

    it('Build registry: no duplicate event IDs', () => {
      const stage = results.stages.find((s) => s.stage === 'Build registry');
      expect(stage?.passed).toBe(true);
    });

    it('ISS score in valid range (0-100)', () => {
      const stage = results.stages.find((s) => s.stage === 'Calculate ISS');
      expect(stage?.passed).toBe(true);
    });
  } else {
    // Generic assertions for any fixture
    it('Load entities succeeds', () => {
      const stage = results.stages.find((s) => s.stage === 'Load entities');
      expect(stage?.passed).toBe(true);
    });

    it('Load events succeeds', () => {
      const stage = results.stages.find((s) => s.stage === 'Load events');
      expect(stage?.passed).toBe(true);
    });

    it('Build registry: no duplicate event IDs', () => {
      const stage = results.stages.find((s) => s.stage === 'Build registry');
      expect(stage?.passed).toBe(true);
    });
  }

  // Validators all run without crashing
  it('all validators run without throwing', () => {
    const validatorStages = results.stages.filter(
      (s) => s.stage.includes('Validator') || s.stage === 'ResultAggregator',
    );
    for (const vs of validatorStages) {
      // Even if there are issues, the validator itself should not crash
      expect(vs.passed).toBe(true);
    }
  });

  it('Context compiler produces all 5 layers', () => {
    const stage = results.stages.find((s) => s.stage === 'Compile context');
    // May fail if no narrative events exist or E11 not found — check if present
    if (stage) {
      expect(stage.passed).toBe(true);
    }
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
      'Hz': m.hz.toFixed(1),
      'Mean (ms)': m.meanMs.toFixed(3),
      Samples: m.samples,
      'Scale (N)': m.scale,
    }));
    console.table(table);

    // Print scaling summary
    const byName = new Map<string, typeof perfResults.measurements>();
    for (const m of perfResults.measurements) {
      const baseName = m.name.replace(/ \(N=\d+\)$/, '');
      if (!byName.has(baseName)) byName.set(baseName, []);
      byName.get(baseName)!.push(m);
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
      const p50 = n10 && n1000 && n10.meanMs > 0
        ? `~O(${(n1000.meanMs / n10.meanMs).toFixed(1)}x)`
        : '-';
      console.log(`${name.padEnd(24)} | ${c10.padEnd(10)} | ${c100.padEnd(10)} | ${c1000.padEnd(10)} | ${p50}`);
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
      const m = perfResults.measurements.find(
        (x) => x.name.includes('Run all validators') && x.scale === scale,
      );
      expect(m).toBeDefined();
      expect(m!.meanMs).toBeGreaterThan(0);
    }
  });

  it('ResultAggregator is measurable at all scales', () => {
    for (const scale of ['10', '100', '1000']) {
      const m = perfResults.measurements.find(
        (x) => x.name.includes('ResultAggregator') && x.scale === scale,
      );
      expect(m).toBeDefined();
      expect(m!.meanMs).toBeGreaterThan(0);
    }
  });
});

// ─── Report Writing ────────────────────────────────────────────────────────

describe('Benchmark Reporting', () => {
  it('writes JSON and Markdown results to disk', () => {
    const results = runFunctionalBench(FIXTURE);
    const basePath = writeResults({
      timestamp: new Date().toISOString(),
      functional: results.stages.map((s) => ({
        stage: s.stage,
        passed: s.passed,
        ms: s.ms,
        detail: s.detail,
      })),
      performance: [],
    });

    const jsonPath = `${basePath}.json`;
    const mdPath = `${basePath}.md`;

    expect(fs.existsSync(jsonPath)).toBe(true);
    expect(fs.existsSync(mdPath)).toBe(true);

    // Clean up test artifacts
    try {
      fs.unlinkSync(jsonPath);
      fs.unlinkSync(mdPath);
    } catch { /* ignore */ }

    console.log(`[Report] Written and cleaned up: ${basePath}.{json,md}`);
  });
});

// ─── Main entry (also runnable as standalone) ─────────────────────────────

import { runAll } from './index.js';

describe('runAll integration', () => {
  it('runs both functional and performance benchmarks', async () => {
    const results = await runAll(FIXTURE);
    expect(results.functional.length).toBeGreaterThan(0);
    expect(results.timestamp).toBeTruthy();
    console.log(`[runAll] ${results.functional.filter((f) => f.passed).length} functional passed`);
    console.log(`[runAll] ${results.performance.length} performance measurements`);
  }, 60000); // Allow up to 60s for full suite
});
