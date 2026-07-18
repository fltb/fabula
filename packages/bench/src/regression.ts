// ============================================================================
// Regression Benchmarks — Run zhu-fu (祝福) fixture through full pipeline
// ============================================================================

import {
  EntityMapper,
  InMemoryEntityRegistry,
  ResultAggregator,
  ReplayEngine,
  ContextCompiler,
  buildCausalEdges,
  topologicalSort,
  createEmptyBranchPath,
  writeValidationReport,
  type NarrativeEvent,
  type WorldState,
  type ProjectData,
  type ValidationIssue,
  type AnalysisResult,
} from '@novalistically/core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { computeNCED, type PerValidatorBreakdown, type SeverityLevelCED } from './consistency.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface RegressionStageResult {
  stage: string;
  passed: boolean;
  ms: number;
  detail: string;
}

export interface RegressionResults {
  fixturePath: string;
  fixtureName: string;
  stages: RegressionStageResult[];
  totalPassed: number;
  totalFailed: number;
  totalTime: number;
  l1Issues: ValidationIssue[];
  l2Issues: ValidationIssue[];
  /** Total estimated word count across narrative events */
  totalWordCount: number;
  /** Per-validator N-CED for L1 issues */
  l1PerValidator: PerValidatorBreakdown[];
  /** Per-validator N-CED for L2 issues */
  l2PerValidator: PerValidatorBreakdown[];
  /** Severity-level CED (L1 + L2) */
  severityCED: SeverityLevelCED[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function trunc(s: string, max = 120): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// ─── Main entry ─────────────────────────────────────────────────────────────

/**
 * Run validation against the zhu-fu fixture and return detailed per-issue results.
 * Each ValidationIssue includes: validator, severity, event, entity, message, attribute, fixSuggestion, fixTarget.
 * Useful for debugging — the regular bench only reports aggregated counts.
 */
export function validateFixtureIssues(fixturePath?: string): ValidationIssue[] {
  const p = fixturePath ?? path.resolve(
    __dirname, '..', '..', '..', 'fixtures', 'zhu-fu',
  );

  const mapper = new EntityMapper(p);
  const projectData = mapper.loadProject();
  const registry = new InMemoryEntityRegistry();
  registry.load(p);
  const allEvents = mapper.loadAllEvents(projectData.chapters);
  const replay = new ReplayEngine();
  const state = replay.replay(allEvents, createEmptyBranchPath());
  const aggregator = new ResultAggregator();
  const results = aggregator.validateAll(allEvents, state, registry);

  const allIssues: ValidationIssue[] = [];
  for (const result of results.values()) {
    allIssues.push(...result.errors, ...result.warnings, ...result.infos);
  }
  return allIssues;
}

/**
 * Run all regression benchmark stages against the 祝福 (zhu-fu) fixture.
 * Replaces the old functional.ts with real fixture-based testing.
 */
export async function runRegressionBench(fixturePath?: string): Promise<RegressionResults> {
  const p = fixturePath ?? path.resolve(
    __dirname, '..', '..', '..', 'fixtures', 'zhu-fu',
  );
  const fixtureName = path.basename(p);
  const startTime = Date.now();
  const stages: RegressionStageResult[] = [];

  // Shared state populated across stages
  let projectData!: ProjectData;
  let registry!: InMemoryEntityRegistry;
  let allEvents: NarrativeEvent[] = [];
  let state!: WorldState;

  // Helper: async mark a stage
  async function mark(
    stage: string,
    fn: () => Promise<unknown>,
    detailFn?: () => string,
  ): Promise<void> {
    const t0 = performance.now();
    try {
      await fn();
      stages.push({
        stage,
        passed: true,
        ms: Math.round(performance.now() - t0),
        detail: detailFn?.() ?? 'ok',
      });
    } catch (e: unknown) {
      stages.push({
        stage,
        passed: false,
        ms: Math.round(performance.now() - t0),
        detail: e instanceof Error ? e.message.slice(0, 250) : String(e),
      });
    }
  }

  // ── 1. Load entities ──────────────────────────────────────────────────
  await mark('Load entities', async () => {
    const mapper = new EntityMapper(p);
    projectData = mapper.loadProject();
    registry = new InMemoryEntityRegistry();
    registry.load(p);
  }, () => {
    const chars = registry.findByKind('character').length;
    const locs = registry.findByKind('location').length;
    const rules = registry.findByKind('rule').length;
    return `Characters: ${chars}, Locations: ${locs}, Rules: ${rules}`;
  });

  // ── 2. Load events (including system:genesis) ─────────────────────────
  await mark('Load events', async () => {
    const mapper = new EntityMapper(p);
    // Re-use projectData loaded in step 1
    allEvents = mapper.loadAllEvents(projectData.chapters);
  }, () => {
    const total = allEvents.length;
    const genesisCount = allEvents.filter((e) => e.id === 'system:genesis').length;
    return `Total events: ${total} (${genesisCount} genesis, ${total - genesisCount} narrative)`;
  });

  // ── 3. Build DAG (causal edges + topological sort) ────────────────────
  let dagOrder: string[] = [];
  let dagCycleMsg = '';
  await mark('Build DAG', async () => {
    const { edges, inDegree } = buildCausalEdges(allEvents);
    try {
      dagOrder = topologicalSort(allEvents, edges, inDegree);
    } catch (err) {
      // DAG cycles are expected in some fixtures; ReplayEngine handles the
      // fallback via narrativeOrder sort. The cycle detection itself is working
      // correctly — note it but don't fail the stage.
      dagCycleMsg = (err as Error).message;
      dagOrder = [];
    }
  }, () => {
    if (dagCycleMsg) return `Cycle detected (handled by ReplayEngine fallback): ${dagCycleMsg}`;
    return `DAG order: ${dagOrder.length} events (matching input: ${dagOrder.length === allEvents.length})`;
  });

  // ── 4. Replay state ───────────────────────────────────────────────────
  await mark('Replay state', async () => {
    const replay = new ReplayEngine();
    state = replay.replay(allEvents, createEmptyBranchPath());
  }, () => {
    const entityCount = Object.keys(state.entities).length;
    const factCount = state.facts.length;
    return `Entities: ${entityCount}, Facts: ${factCount}, Threads: ${Object.keys(state.threads).length}`;
  });

  // ── 5. Run all validators via ResultAggregator ────────────────────────
  let collectedL1Issues: ValidationIssue[] = [];
  await mark('Run validators', async () => {
    const aggregator = new ResultAggregator();
    const results = aggregator.validateAll(allEvents, state, registry);
    if (results.size === 0 && allEvents.filter((e) => e.id !== 'system:genesis').length > 0) {
      throw new Error('Aggregator returned empty results');
    }
    // Collect all L1 issues
    const allL1Issues: ValidationIssue[] = [];
    for (const r of results.values()) {
      allL1Issues.push(...r.errors, ...r.warnings, ...r.infos);
    }
    collectedL1Issues = allL1Issues;
  }, () => {
    let errors = 0; let warnings = 0; let infos = 0;
    for (const issue of collectedL1Issues) {
      if (issue.severity === 'error') errors++;
      else if (issue.severity === 'warning') warnings++;
      else if (issue.severity === 'info') infos++;
    }
    return `Errors: ${errors}, Warnings: ${warnings}, Infos: ${infos} (${allEvents.filter(e => e.id !== 'system:genesis').length} events validated)`;
  });

  // ── 6. Run post-render validators (L2) against reference data ──────
  let collectedL2Issues: ValidationIssue[] = [];
  await mark('Run post-render validators (L2)', async () => {
    const refDir = path.join(p, 'reference', 'data');
    if (!fs.existsSync(refDir)) {
      collectedL2Issues = [];
      return; // no reference data — stage notes this but does not fail
    }
    const refFiles = fs.readdirSync(refDir).filter((f) => f.endsWith('.json'));
    if (refFiles.length === 0) {
      collectedL2Issues = [];
      return; // no reference files — stage notes this but does not fail
    }

    const aggregator = new ResultAggregator();
    const eventsById = new Map(allEvents.map((e) => [e.id, e]));

    let withAnalysis = 0;
    const allL2Issues: ValidationIssue[] = [];

    for (const file of refFiles) {
      const raw = fs.readFileSync(path.join(refDir, file), 'utf-8');
      let ref: { prose?: string; analysis?: AnalysisResult | null };
      try {
        ref = JSON.parse(raw);
      } catch {
        continue; // skip malformed JSON
      }

      if (!ref.analysis || !ref.prose) continue;
      withAnalysis++;

      const eventId = ref.analysis.eventId;
      const event = eventsById.get(eventId);
      if (!event) continue;

      const result = aggregator.validateRender(
        ref.prose,
        event,
        state,
        ref.analysis,
      );
      allL2Issues.push(...result.errors, ...result.warnings, ...result.infos);
    }

    collectedL2Issues = allL2Issues;

    if (withAnalysis === 0) {
      return; // No reference files have analysis data — stage notes this but does not fail
    }
  }, () => {
    const refDir = path.join(p, 'reference', 'data');
    if (!fs.existsSync(refDir)) {
      return 'No reference/data directory found — skipping L2 validation';
    }
    const refFiles = fs.readdirSync(refDir).filter((f) => f.endsWith('.json'));
    if (refFiles.length === 0) {
      return 'No reference files found — skipping L2 validation';
    }

    let errors = 0; let warnings = 0; let infos = 0;
    for (const issue of collectedL2Issues) {
      if (issue.severity === 'error') errors++;
      else if (issue.severity === 'warning') warnings++;
      else if (issue.severity === 'info') infos++;
    }

    return `Events with analysis: ${collectedL2Issues.length > 0 ? 'yes' : 'none'}, Post-render errors: ${errors}, Warnings: ${warnings}, Infos: ${infos}`;
  });

  // ── 7. Write validation report ──────────────────────────────────────
  let reportPath = '';
  await mark('Write validation report', async () => {
    reportPath = writeValidationReport(p, {
      projectName: fixtureName,
      generatedAt: new Date().toISOString(),
      l1Issues: collectedL1Issues,
      l2Issues: collectedL2Issues,
    });
  }, () => reportPath);

  // ── 8. Compile context for last narrative event ───────────────────────
  await mark('Compile context', async () => {
    const compiler = new ContextCompiler();
    const narrativeEvents = allEvents.filter((e) => e.id !== 'system:genesis');
    const lastEvent = narrativeEvents[narrativeEvents.length - 1];
    if (!lastEvent) throw new Error('No narrative events to compile context for');
    const contextPkg = compiler.compile(lastEvent, state, registry);
    // Verify all expected layers present
    if (!contextPkg.systemContext) throw new Error('Missing systemContext');
    if (!contextPkg.sceneSpec) throw new Error('Missing sceneSpec');
    if (!contextPkg.characterSnapshots) throw new Error('Missing characterSnapshots');
    if (!contextPkg.relationshipContext) throw new Error('Missing relationshipContext');
    if (!contextPkg.worldFacts) throw new Error('Missing worldFacts');
    if (!contextPkg.knowledgeBoundary) throw new Error('Missing knowledgeBoundary');
    if (!contextPkg.activeThreads) throw new Error('Missing activeThreads');
    if (!contextPkg.markdown) throw new Error('Missing markdown');
  }, () => {
    const compiler = new ContextCompiler();
    const narrativeEvents = allEvents.filter((e) => e.id !== 'system:genesis');
    const lastEvent = narrativeEvents[narrativeEvents.length - 1];
    if (!lastEvent) return 'Skipped';
    const contextPkg = compiler.compile(lastEvent, state, registry);
    return `Chars: ${contextPkg.characterSnapshots.length}, Rels: ${contextPkg.relationshipContext.length}, Facts: ${contextPkg.worldFacts.length}, Threads: ${contextPkg.activeThreads.length}`;
  });

  // ── Tally & consistency metrics ──────────────────────────────────────
  const totalTime = Date.now() - startTime;
  const totalPassed = stages.filter((s) => s.passed).length;
  const totalFailed = stages.filter((s) => !s.passed).length;

  // Estimate total word count (400 words per narrative event as default)
  const narrativeEvents = allEvents.filter((e) => e.id !== 'system:genesis');
  const totalWordCount = narrativeEvents.length * 400;

  // Per-validator breakdown: group issues by validator, split by severity
  function buildPerValidator(issues: ValidationIssue[]): PerValidatorBreakdown[] {
    const map = new Map<string, { errors: number; warnings: number; infos: number }>();
    for (const iss of issues) {
      let entry = map.get(iss.validator);
      if (!entry) {
        entry = { errors: 0, warnings: 0, infos: 0 };
        map.set(iss.validator, entry);
      }
      if (iss.severity === 'error') entry.errors++;
      else if (iss.severity === 'warning') entry.warnings++;
      else if (iss.severity === 'info') entry.infos++;
    }
    const result: PerValidatorBreakdown[] = [];
    for (const [validator, counts] of map) {
      result.push({
        validator,
        category: '',
        errors: counts.errors,
        warnings: counts.warnings,
        infos: counts.infos,
        nCED: computeNCED(counts.errors, counts.warnings, counts.infos, totalWordCount),
      });
    }
    result.sort((a, b) => b.nCED - a.nCED);
    return result;
  }

  const l1PerValidator = buildPerValidator(collectedL1Issues);
  const l2PerValidator = buildPerValidator(collectedL2Issues);

  // Severity-level CED
  function countBySeverity(issues: ValidationIssue[]): { error: number; warning: number; info: number } {
    const counts = { error: 0, warning: 0, info: 0 };
    for (const iss of issues) {
      if (iss.severity === 'error') counts.error++;
      else if (iss.severity === 'warning') counts.warning++;
      else if (iss.severity === 'info') counts.info++;
    }
    return counts;
  }

  const l1Sev = countBySeverity(collectedL1Issues);
  const l2Sev = countBySeverity(collectedL2Issues);

  const severityCED: SeverityLevelCED[] = [
    { severity: 'error', l1CED: computeNCED(l1Sev.error, 0, 0, totalWordCount), l2CED: computeNCED(l2Sev.error, 0, 0, totalWordCount) },
    { severity: 'warning', l1CED: computeNCED(0, l1Sev.warning, 0, totalWordCount), l2CED: computeNCED(0, l2Sev.warning, 0, totalWordCount) },
    { severity: 'info', l1CED: computeNCED(0, 0, l1Sev.info, totalWordCount), l2CED: computeNCED(0, 0, l2Sev.info, totalWordCount) },
  ];

  return {
    fixturePath: p,
    fixtureName,
    stages,
    totalPassed,
    totalFailed,
    totalTime,
    l1Issues: collectedL1Issues,
    l2Issues: collectedL2Issues,
    totalWordCount,
    l1PerValidator,
    l2PerValidator,
    severityCED,
  };
}
