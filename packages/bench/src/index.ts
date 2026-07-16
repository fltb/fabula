// ============================================================================
// Bench Module — Entry point
// ============================================================================

export { runFunctionalBench } from './functional.js';
export type { FunctionalResults, FunctionalStageResult } from './functional.js';

export { runPerformanceBench } from './performance.js';
export type { PerfResults, PerfMeasurement } from './performance.js';

export { toJson, toMarkdown, writeResults } from './reporters.js';
export type { BenchResults, BenchMeasurement } from './reporters.js';

import { runFunctionalBench } from './functional.js';
import { runPerformanceBench } from './performance.js';
import { writeResults } from './reporters.js';
import type { BenchResults } from './reporters.js';

/**
 * Run all benchmarks (functional + performance) and write results to disk.
 */
export async function runAll(fixturePath?: string): Promise<BenchResults> {
  console.log('═'.repeat(60));
  console.log('  Novalistically — Full Benchmark Suite');
  console.log('═'.repeat(60));
  console.log('');

  // Functional
  console.log('── Functional Benchmarks ──');
  const functional = runFunctionalBench(fixturePath);
  for (const s of functional.stages) {
    const icon = s.passed ? '✅' : '❌';
    console.log(`  ${icon} ${s.stage}: ${s.passed ? 'PASS' : 'FAIL'} (${s.ms.toFixed(2)}ms) — ${s.detail}`);
  }
  console.log(`  ── ${functional.totalPassed}/${functional.stages.length} passed, ${functional.totalFailed} failed, ${functional.totalTime.toFixed(0)}ms total ──`);
  console.log('');

  // Performance
  console.log('── Performance Benchmarks ──');
  const perf = await runPerformanceBench();
  console.table(
    perf.measurements.map((m) => ({
      Stage: m.name,
      'Hz': m.hz.toFixed(1),
      'Mean (ms)': m.meanMs.toFixed(3),
      Samples: m.samples,
      Scale: m.scale,
    })),
  );

  // Build results
  const results: BenchResults = {
    timestamp: new Date().toISOString(),
    functional: functional.stages.map((s) => ({
      stage: s.stage,
      passed: s.passed,
      ms: s.ms,
      detail: s.detail,
    })),
    performance: perf.measurements.map((m) => ({
      name: m.name,
      hz: m.hz,
      meanMs: m.meanMs,
      samples: m.samples,
      scale: m.scale,
    })),
  };

  // Write to disk
  const basePath = writeResults(results);
  console.log(`\nResults written to ${basePath}.{json,md}`);

  return results;
}
