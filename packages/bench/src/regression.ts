// ============================================================================
// Regression Benchmarks — Run zhu-fu (祝福) fixture through full pipeline
// ============================================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  compileProject,
  type NarrativeEvent,
  type StoryBoundaries,
  type ValidationIssue,
  type WorldState,
} from '@novalistically/core';
import {
  ContextCompiler,
  type PipelineRunResult,
  ReportWriter,
  ResultAggregator,
} from '@novalistically/core/tooling';
import { FileProjectSourceLoader } from '@novalistically/node-host';
import { computeNCED, type PerValidatorBreakdown, type SeverityLevelCED } from './consistency.js';
import type { ApprovedReferenceSet, ValidatorIssueIdentity } from './reference.js';
import { collectReferenceIssueIdentities, loadApprovedReferences } from './reference.js';

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

// ─── Main entry ─────────────────────────────────────────────────────────────

/**
 * Run validation against the zhu-fu fixture and return detailed per-issue results.
 * Each ValidationIssue includes: validator, severity, event, entity, message, attribute, fixSuggestion, fixTarget.
 * Useful for debugging — the regular bench only reports aggregated counts.
 */
export function validateFixtureIssues(fixturePath?: string): ValidationIssue[] {
  const p = fixturePath ?? path.resolve(__dirname, '..', '..', '..', 'fixtures', 'zhu-fu');
  const compilation = compileProject(new FileProjectSourceLoader().load(p));
  const events = [...compilation.events];
  const entities = compilation.entities;
  const boundaries = compilation.boundaries;
  const results = new ResultAggregator().validateAll(events, boundaries.finalState, entities);
  return [...results.values()].flatMap((result) => [
    ...result.errors,
    ...result.warnings,
    ...result.infos,
  ]);
}

/** Build a comparable key for a ValidatorIssueIdentity. */
function idKey(id: ValidatorIssueIdentity): string {
  return `${id.validator}\x00${id.eventId}\x00${id.category}\x00${id.entityId ?? ''}\x00${id.attribute ?? ''}\x00${id.severity}`;
}

/** Human-readable representation. */
function idStr(id: ValidatorIssueIdentity): string {
  return `${id.validator}/${id.eventId}/${id.category}/${id.entityId ?? '-'}/${id.attribute ?? '-'}/${id.severity}`;
}

/**
 * Run all regression benchmark stages against the 祝福 (zhu-fu) fixture.
 * Replaces the old functional.ts with real fixture-based testing.
 */
export async function runRegressionBench(fixturePath?: string): Promise<RegressionResults> {
  const p = fixturePath ?? path.resolve(__dirname, '..', '..', '..', 'fixtures', 'zhu-fu');
  const fixtureName = path.basename(p);
  const startTime = Date.now();
  const stages: RegressionStageResult[] = [];

  let entities!: Parameters<ContextCompiler['compile']>[2];
  let allEvents: NarrativeEvent[] = [];
  let boundaries!: StoryBoundaries;
  let stateBeforeByEventId = new Map<string, WorldState>();
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

  await mark(
    'Load entities',
    async () => {
      const project = compileProject(new FileProjectSourceLoader().load(p));
      entities = project.entities;
      allEvents = [...project.events];
      boundaries = project.boundaries;
      state = boundaries.finalState;
      stateBeforeByEventId = boundaries.stateBeforeByEventId;
    },
    () => `Total entities: ${entities.getAll().length}`,
  );

  // ── 2. Load events (canonical authored events) ────────────────────────
  await mark(
    'Load events',
    async () => {
      // Authored events arrive with the canonical kernel load (stage 1).
    },
    () => `Total events: ${allEvents.length} narrative events`,
  );

  // ── 3. Build DAG ─────────────────────────────────────────────────────
  await mark(
    'Build DAG',
    async () => {
      // Canonical boundaries arrive with the kernel load (stage 1).
    },
    () => `DAG order: ${boundaries.orderedEventIds.length} narrative events`,
  );

  await mark(
    'Replay state',
    async () => {
      // Canonical final state arrives with the kernel load (stage 1).
    },
    () => {
      const entityCount = Object.keys(state.entities).length;
      const factCount = state.facts.length;
      return `Entities: ${entityCount}, Facts: ${factCount}, Threads: ${Object.keys(state.threads).length}`;
    },
  );

  // ── 5. Run all validators via ResultAggregator ────────────────────────
  let collectedL1Issues: ValidationIssue[] = [];
  await mark(
    'Run validators',
    async () => {
      const aggregator = new ResultAggregator();
      const results = aggregator.validateAll(allEvents, state, entities, { stateBeforeByEventId });
      if (results.size === 0) {
        throw new Error('Aggregator returned empty results');
      }
      // Collect all L1 issues
      const allL1Issues: ValidationIssue[] = [];
      for (const r of results.values()) {
        allL1Issues.push(...r.errors, ...r.warnings, ...r.infos);
      }
      collectedL1Issues = allL1Issues;
    },
    () => {
      let errors = 0;
      let warnings = 0;
      let infos = 0;
      for (const issue of collectedL1Issues) {
        if (issue.severity === 'error') errors++;
        else if (issue.severity === 'warning') warnings++;
        else if (issue.severity === 'info') infos++;
      }
      return `Errors: ${errors}, Warnings: ${warnings}, Infos: ${infos} (${allEvents.length} events validated)`;
    },
  );

  // ── 6. Run post-render validators (L2) against reference data ──────
  let collectedL2Issues: ValidationIssue[] = [];
  await mark(
    'Run post-render validators (L2)',
    async () => {
      const referenceDir = path.join(p, 'reference');
      if (!fs.existsSync(referenceDir)) {
        collectedL2Issues = [];
        return; // no reference directory — stage is skipped
      }

      // Closed loading: validates data set, provenance, outcomes, review, hashes
      let refSet: ApprovedReferenceSet;
      try {
        refSet = loadApprovedReferences(referenceDir);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`Reference load failed: ${msg}`);
      }

      const aggregator = new ResultAggregator();
      const eventsById = new Map(allEvents.map((e) => [e.id, e]));
      const allL2Issues: ValidationIssue[] = [];

      for (const [eventId, ref] of refSet.references) {
        const event = eventsById.get(eventId);
        if (!event) continue;

        const stateBefore = stateBeforeByEventId.get(eventId);
        if (!stateBefore) continue;

        const result = aggregator.validatePost(ref.prose, event, stateBefore, ref.analysis);
        allL2Issues.push(...result.errors, ...result.warnings, ...result.infos);
      }
      collectedL2Issues = allL2Issues;

      // Collect actual issue identities and compare against approved manifest
      const actualIdentities = collectReferenceIssueIdentities(p, refSet.references);
      const approvedIdentities = refSet.expectedIssues;

      const actualKeySet = new Set(actualIdentities.map(idKey));
      const approvedKeySet = new Set(approvedIdentities.map(idKey));

      const missing: ValidatorIssueIdentity[] = [];
      const unexpected: ValidatorIssueIdentity[] = [];

      for (const id of approvedIdentities) {
        if (!actualKeySet.has(idKey(id))) {
          missing.push(id);
        }
      }
      for (const id of actualIdentities) {
        if (!approvedKeySet.has(idKey(id))) {
          unexpected.push(id);
        }
      }

      if (missing.length > 0 || unexpected.length > 0) {
        let detail = '';
        if (missing.length > 0) {
          detail += `Missing ${missing.length} identities: ${missing.map(idStr).join(', ')}. `;
        }
        if (unexpected.length > 0) {
          detail += `Unexpected ${unexpected.length} identities: ${unexpected.map(idStr).join(', ')}. `;
        }

        // Special case: empty approved list is valid only when actual is also empty
        // and review notes contain the literal "approved empty outcome set"
        if (
          approvedIdentities.length === 0 &&
          actualIdentities.length === 0 &&
          refSet.review.notes.includes('approved empty outcome set')
        ) {
          // Allowed — identity sets match both empty
        } else {
          throw new Error(`Reference identity mismatch: ${detail.trim()}`);
        }
      }
    },
    () => {
      if (!fs.existsSync(path.join(p, 'reference'))) {
        return 'No reference directory found — skipping L2 validation';
      }

      let errors = 0;
      let warnings = 0;
      let infos = 0;
      for (const issue of collectedL2Issues) {
        if (issue.severity === 'error') errors++;
        else if (issue.severity === 'warning') warnings++;
        else if (issue.severity === 'info') infos++;
      }

      return `L2 issues — errors: ${errors}, warnings: ${warnings}, infos: ${infos}`;
    },
  );
  // ── 7. Write validation report ──────────────────────────────────────
  let reportPath = '';
  await mark(
    'Write validation report',
    async () => {
      // Bench host boundary: the report markdown is generated by Core's pure
      // ReportWriter and persisted with ordinary Node fs mechanics.
      const runResult: PipelineRunResult = {
        projectName: fixtureName,
        generatedAt: new Date().toISOString(),
        passed: collectedL1Issues.length === 0 && collectedL2Issues.length === 0,
        l1Issues: collectedL1Issues,
        l2Issues: collectedL2Issues,
        results: [],
        renderStatus: { ready: [], blocked: [], waiting: [], completed: [] },
        threads: [],
        blockers: [],
        nextActions: [],
        guidance: '',
        errors: [],
      };
      const markdown = new ReportWriter(runResult).toMarkdown();
      const outDir = path.join(p, 'output');
      fs.mkdirSync(outDir, { recursive: true });
      reportPath = path.join(outDir, 'validation.md');
      fs.writeFileSync(reportPath, markdown);
    },
    () => reportPath,
  );

  // ── 8. Compile context for last narrative event ───────────────────────
  await mark(
    'Compile context',
    async () => {
      const compiler = new ContextCompiler();
      const lastEvent = allEvents[allEvents.length - 1];
      if (!lastEvent) throw new Error('No narrative events to compile context for');
      const stateBefore = stateBeforeByEventId.get(lastEvent.id);
      if (!stateBefore) throw new Error(`Missing state boundary for ${lastEvent.id}`);
      const contextPkg = compiler.compile(lastEvent, stateBefore, entities);
      if (
        !contextPkg.systemContext ||
        !contextPkg.sceneSpec ||
        !contextPkg.characterSnapshots ||
        !contextPkg.relationshipContext ||
        !contextPkg.worldFacts ||
        !contextPkg.knowledgeBoundary ||
        !contextPkg.activeThreads ||
        !contextPkg.markdown
      ) {
        throw new Error('Context compiler returned an incomplete package');
      }
    },
    () => {
      const compiler = new ContextCompiler();
      const lastEvent = allEvents[allEvents.length - 1];
      if (!lastEvent) return 'No narrative event';
      const stateBefore = stateBeforeByEventId.get(lastEvent.id);
      if (!stateBefore) return `Missing state boundary for ${lastEvent.id}`;
      const contextPkg = compiler.compile(lastEvent, stateBefore, entities);
      return `Context: ${contextPkg.characterSnapshots.length} character snapshots`;
    },
  );

  // ── Tally & consistency metrics ──────────────────────────────────────
  const totalTime = Date.now() - startTime;
  const totalPassed = stages.filter((s) => s.passed).length;
  const totalFailed = stages.filter((s) => !s.passed).length;

  // Estimate total word count (400 words per narrative event as default)
  const totalWordCount = allEvents.length * 400;

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
  function countBySeverity(issues: ValidationIssue[]): {
    error: number;
    warning: number;
    info: number;
  } {
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
    {
      severity: 'error',
      l1CED: computeNCED(l1Sev.error, 0, 0, totalWordCount),
      l2CED: computeNCED(l2Sev.error, 0, 0, totalWordCount),
    },
    {
      severity: 'warning',
      l1CED: computeNCED(0, l1Sev.warning, 0, totalWordCount),
      l2CED: computeNCED(0, l2Sev.warning, 0, totalWordCount),
    },
    {
      severity: 'info',
      l1CED: computeNCED(0, 0, l1Sev.info, totalWordCount),
      l2CED: computeNCED(0, 0, l2Sev.info, totalWordCount),
    },
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
