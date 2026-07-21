// ============================================================================
// Regression Benchmarks — Run zhu-fu (祝福) fixture through full pipeline
// ============================================================================

import {
  ContextCompiler,
  EntityMapper,
  InMemoryEntityRegistry,
  ResultAggregator,
  compileStoryBoundaries,
  writeValidationReport,
  type Fact,
  type NarrativeEvent,
  type StoryBoundaries,
  type WorldState,
  type ProjectData,
  type ValidationIssue,
} from '@novalistically/core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { computeNCED, type PerValidatorBreakdown, type SeverityLevelCED } from './consistency.js';
import { loadApprovedReferences, collectReferenceIssueIdentities } from './reference.js';
import type { ValidatorIssueIdentity, ApprovedReferenceSet } from './reference.js';

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

function initialFactsFor(registry: InMemoryEntityRegistry, genesis?: NarrativeEvent): Fact[] {
  return [
    ...(genesis?.postconditions ?? []),
    ...registry.getAll().flatMap((entity) => Object.entries(entity.state ?? {}).map(([attribute, value]) => ({
      id: `${entity.id}.${attribute}`,
      entityId: entity.id,
      attribute,
      value,
      validity: { temporal: { start: { type: 'absolute' as const, value: 'day_0' }, end: null }, branches: { type: 'all' as const } },
    }))),
  ];
}

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
  const genesis = allEvents.find((event) => event.id === 'system:genesis');
  const narrativeEvents = allEvents.filter((event) => event.id !== 'system:genesis');
  const initialThreads = (projectData.worldInitialState?.threads ?? []).map(t => ({
    id: t.id,
  }));
  const boundaries = compileStoryBoundaries(
    narrativeEvents,
    initialFactsFor(registry, genesis),
    new Map((projectData.timeAnchors ?? []).map((anchor) => [anchor.id, anchor.day])),
    undefined,
    initialThreads,
  );
  const results = new ResultAggregator().validateAll(narrativeEvents, boundaries.finalState, registry, undefined, boundaries.stateBeforeByEventId);
  return [...results.values()].flatMap((result) => [...result.errors, ...result.warnings, ...result.infos]);
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

  // ── 3. Build DAG ─────────────────────────────────────────────────────
  await mark('Build DAG', async () => {
    const narrativeEvents = allEvents.filter((event) => event.id !== 'system:genesis');
    const genesis = allEvents.find((event) => event.id === 'system:genesis');
    boundaries = compileStoryBoundaries(
      narrativeEvents,
      initialFactsFor(registry, genesis),
      new Map((projectData.timeAnchors ?? []).map((anchor) => [anchor.id, anchor.day])),
      undefined,
      (projectData.worldInitialState?.threads ?? []).map(t => ({
        id: t.id,
      })),
    );
    stateBeforeByEventId = boundaries.stateBeforeByEventId;
  }, () => `DAG order: ${boundaries.orderedEventIds.length} narrative events`);

  await mark('Replay state', async () => {
    state = boundaries.finalState;
    stateBeforeByEventId = boundaries.stateBeforeByEventId;
  }, () => {
    const entityCount = Object.keys(state.entities).length;
    const factCount = state.facts.length;
    return `Entities: ${entityCount}, Facts: ${factCount}, Threads: ${Object.keys(state.threads).length}`;
  });

  // ── 5. Run all validators via ResultAggregator ────────────────────────
  let collectedL1Issues: ValidationIssue[] = [];
  await mark('Run validators', async () => {
    const aggregator = new ResultAggregator();
    const narrativeEvents = allEvents.filter((event) => event.id !== 'system:genesis');
    const results = aggregator.validateAll(narrativeEvents, state, registry, undefined, stateBeforeByEventId);
    if (results.size === 0 && narrativeEvents.length > 0) {
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

      const result = aggregator.validateRender(
        ref.prose,
        event,
        stateBefore,
        ref.analysis,
      );
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
  }, () => {
    if (!fs.existsSync(path.join(p, 'reference'))) {
      return 'No reference directory found — skipping L2 validation';
    }

    let errors = 0; let warnings = 0; let infos = 0;
    for (const issue of collectedL2Issues) {
      if (issue.severity === 'error') errors++;
      else if (issue.severity === 'warning') warnings++;
      else if (issue.severity === 'info') infos++;
    }

    return `L2 issues — errors: ${errors}, warnings: ${warnings}, infos: ${infos}`;
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
    const narrativeEvents = allEvents.filter((event) => event.id !== 'system:genesis');
    const lastEvent = narrativeEvents[narrativeEvents.length - 1];
    if (!lastEvent) throw new Error('No narrative events to compile context for');
    const stateBefore = stateBeforeByEventId.get(lastEvent.id);
    if (!stateBefore) throw new Error(`Missing state boundary for ${lastEvent.id}`);
    const contextPkg = compiler.compile(lastEvent, stateBefore, registry);
    if (!contextPkg.systemContext || !contextPkg.sceneSpec || !contextPkg.characterSnapshots || !contextPkg.relationshipContext || !contextPkg.worldFacts || !contextPkg.knowledgeBoundary || !contextPkg.activeThreads || !contextPkg.markdown) {
      throw new Error('Context compiler returned an incomplete package');
    }
  }, () => {
    const compiler = new ContextCompiler();
    const narrativeEvents = allEvents.filter((event) => event.id !== 'system:genesis');
    const lastEvent = narrativeEvents[narrativeEvents.length - 1];
    if (!lastEvent) return 'No narrative event';
    const stateBefore = stateBeforeByEventId.get(lastEvent.id);
    if (!stateBefore) return `Missing state boundary for ${lastEvent.id}`;
    const contextPkg = compiler.compile(lastEvent, stateBefore, registry);
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
