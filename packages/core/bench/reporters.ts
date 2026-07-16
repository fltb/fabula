// ============================================================================
// Benchmark Reporters — Markdown + JSON output
// ============================================================================

import * as fs from 'node:fs';
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
  functional: Array<{
    stage: string;
    passed: boolean;
    ms: number;
    detail: string;
  }>;
  performance: BenchMeasurement[];
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
  lines.push('## Functional Benchmarks');
  lines.push('');
  lines.push('| Stage | Result | Time (ms) | Detail |');
  lines.push('|-------|--------|-----------|--------|');
  for (const f of results.functional) {
    const icon = f.passed ? '✅' : '❌';
    lines.push(`| ${f.stage} | ${icon} ${f.passed ? 'PASS' : 'FAIL'} | ${f.ms.toFixed(2)} | ${f.detail} |`);
  }
  lines.push('');

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

const RESULTS_DIR = new URL('results', import.meta.url).pathname;

export function writeResults(results: BenchResults): string {
  const ts = results.timestamp.replace(/[:.]/g, '-').replace(/T/, '_').replace(/Z/, '');
  const basePath = path.join(RESULTS_DIR, ts);

  const jsonPath = `${basePath}.json`;
  fs.writeFileSync(jsonPath, toJson(results), 'utf-8');

  const mdPath = `${basePath}.md`;
  fs.writeFileSync(mdPath, toMarkdown(results), 'utf-8');

  console.log(`[Reporters] Written ${jsonPath}`);
  console.log(`[Reporters] Written ${mdPath}`);

  return basePath;
}
