// ============================================================================
// Bench Module — Entry point
// ============================================================================

export { runRegressionBench, validateFixtureIssues } from './regression.js';
export type { RegressionResults, RegressionStageResult } from './regression.js';

export { runVariantBench } from './variants.js';
export type { VariantResults, VariantResult, VariantIssueResult, InjectedEntry } from './variants.js';

export { runExternalBench } from './external.js';
export type { ExternalBenchResult } from './external.js';

export { runPerformanceBench } from './performance.js';
export type { PerfResults, PerfMeasurement } from './performance.js';

export { toJson, toMarkdown, writeResults } from './reporters.js';
export type { BenchResults, BenchMeasurement } from './reporters.js';

// Consistency metric types
export type { PerValidatorBreakdown, SeverityLevelCED } from './consistency.js';

// Adapter exports — for downstream consumers to call conversion functions directly
export {
  convertChiNovelKE,
  convertChiNovelKECharacter,
  convertChiNovelKELocation,
  convertChiNovelKERelation,
} from './adapters/index.js';
export type { ChiNovelKEConversionResult, ChiNovelKERelationOutput } from './adapters/index.js';
export {
  convertAgentSFT,
  convertAgentSFTEvent,
  convertAgentSFTChapter,
} from './adapters/index.js';
export type { AgentSFTConversionResult } from './adapters/index.js';
export {
  convertIN3KNovel,
  convertIN3KChapterToEvents,
} from './adapters/index.js';
export type { IN3KConversionResult } from './adapters/index.js';

import { runRegressionBench } from './regression.js';
import type { RegressionResults } from './regression.js';
import { runVariantBench } from './variants.js';
import type { VariantResults } from './variants.js';
import { runExternalBench } from './external.js';
import type { ExternalBenchResult } from './external.js';
import { runPerformanceBench } from './performance.js';
import type { PerfResults } from './performance.js';
import { writeResults } from './reporters.js';
import type { BenchResults } from './reporters.js';

/**
 * Run all benchmarks (regression + variants + external + performance)
 * and write results to disk.
 */
export async function runAll(fixturePath?: string): Promise<BenchResults> {
  console.log('═'.repeat(60));
  console.log('  Novalistically — Full Benchmark Suite');
  console.log('═'.repeat(60));
  console.log('');

  // Regression
  console.log('── Regression Benchmarks (祝福) ──');
  const regression = await runRegressionBench(fixturePath);
  for (const s of regression.stages) {
    const icon = s.passed ? '✅' : '❌';
    console.log(`  ${icon} ${s.stage}: ${s.passed ? 'PASS' : 'FAIL'} (${s.ms}ms) — ${s.detail}`);
  }
  console.log(`  ── ${regression.totalPassed}/${regression.stages.length} passed, ${regression.totalFailed} failed, ${regression.totalTime}ms total ──`);
  console.log('');

  // Variants
  console.log('── Variant Benchmarks ──');
  const variants = await runVariantBench();
  console.table(
    variants.results.map((r) => ({
      Variant: r.variant,
      Type: r.type,
      Events: r.eventsLoaded,
      'Time (ms)': r.ms,
    })),
  );

  // Print variant injection summary
  if (variants.errorInjection.length > 0) {
    const matched = variants.errorInjection.filter((r) => r.matched).length;
    const total = variants.errorInjection.length;
    console.log(`  Error injection: ${matched}/${total} matched (${Math.round((matched / total) * 100)}%)`);
  }
  if (variants.extremeDamage.length > 0) {
    const matched = variants.extremeDamage.filter((r) => r.matched).length;
    const total = variants.extremeDamage.length;
    console.log(`  Extreme damage: ${matched}/${total} matched (${Math.round((matched / total) * 100)}%)`);
  }
  if (variants.pipelineF1) {
    const f = variants.pipelineF1;
    console.log(`  Pipeline F1: P=${f.precision} R=${f.recall} F1=${f.f1} (matched=${f.matchedCount}, missed=${f.missedCount}, fp=${f.falsePositiveCount})`);
  }
  console.log('');

  // External
  console.log('── External Benchmarks ──');
  const external = await runExternalBench();
  console.table(external.map((r) => ({
    Dataset: r.dataset,
    Benchmark: r.benchmark,
    Metric: r.metric,
    Status: r.status,
  })));
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
    regression: regression.stages.map((s) => ({
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
    l1Issues: regression.l1Issues ?? [],
    l2Issues: regression.l2Issues ?? [],
    l1PerValidator: regression.l1PerValidator ?? [],
    l2PerValidator: regression.l2PerValidator ?? [],
    severityCED: regression.severityCED ?? [],
    variants: {
      branchA: {
        eventsLoaded: variants.branchA.eventsLoaded,
        issues: variants.branchA.issues,
      },
      branchB: {
        eventsLoaded: variants.branchB.eventsLoaded,
        issues: variants.branchB.issues,
      },
      errorInjection: variants.errorInjection.map((r) => ({
        file: r.file,
        description: r.description,
        expectedValidator: r.expectedValidator,
        expectedSeverity: r.expectedSeverity,
        matched: r.matched,
        actualIssueCount: r.actualIssues.length,
      })),
      extremeDamage: variants.extremeDamage.map((r) => ({
        file: r.file,
        description: r.description,
        expectedValidator: r.expectedValidator,
        expectedSeverity: r.expectedSeverity,
        matched: r.matched,
        actualIssueCount: r.actualIssues.length,
      })),
    },
    pipelineF1: variants.pipelineF1 ? {
      precision: variants.pipelineF1.precision,
      recall: variants.pipelineF1.recall,
      f1: variants.pipelineF1.f1,
      matchedCount: variants.pipelineF1.matchedCount,
      missedCount: variants.pipelineF1.missedCount,
      falsePositiveCount: variants.pipelineF1.falsePositiveCount,
    } : undefined,
  };

  // Include L2 stats if present
  const l2Stage = regression.stages.find((s) => s.stage === 'Run post-render validators (L2)');
  if (l2Stage) {
    results.l2Stats = {
      passed: l2Stage.passed,
      ms: l2Stage.ms,
      detail: l2Stage.detail,
    };
  }

  // Write to disk
  const basePath = writeResults(results);
  console.log(`\nResults written to ${basePath}.{json,md}`);

  return results;
}
