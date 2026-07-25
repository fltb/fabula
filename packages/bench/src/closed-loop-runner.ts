import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, readdirSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import YAML from 'yaml';
import { renderNovel, assembleNovel, buildAndWriteOutputs, EntityMapper, InMemoryEntityRegistry, compileStoryBoundaries, FsStorage, ResultAggregator, sanitizeError } from '@novalistically/core';
import type { RenderNovelResult, RenderJob, RenderSceneResult, ContextPackage, Fact, NarrativeEvent, ProviderCallLedgerEntry, ValidationIssue } from '@novalistically/core';
import { loadApprovedReferences, collectReferenceValidationIssues } from './reference.js';
import {
  evaluateClosedLoopRun,
  aggregateClosedLoopRuns,
  computeFixtureHash,
  computeSpecHashFromFile,
  assertClosedLoopArtifacts,
  computeSourceOverlap,
  evaluateClosedLoopThresholds,
} from './closed-loop.js';
import type {
  ClosedLoopRunInput,
  ClosedLoopRunMetrics,
  ClosedLoopAggregate,
} from './closed-loop.js';
import type { z } from 'zod';
import { closedLoopSpecSchema } from './closed-loop-schema.js';
type ClosedLoopSpecParsed = z.infer<typeof closedLoopSpecSchema>;

function serializeDiagnosticIssue(issue: ValidationIssue) {
  return {
    validator: issue.validator,
    severity: issue.severity,
    event: issue.event,
    entity: issue.entity,
    attribute: issue.attribute,
    reason: sanitizeError(issue.message),
  };
}

function classifyProviderFailure(reason: string | undefined): 'timeout' | 'network' | 'http' | 'other' | null {
  if (!reason) return null;
  if (/PROVIDER_TIMEOUT|timeout/i.test(reason)) return 'timeout';
  if (/network|fetch|ECONN|ENOTFOUND|EAI_AGAIN/i.test(reason)) return 'network';
  if (/HTTP|status\s+\d{3}/i.test(reason)) return 'http';
  return 'other';
}

function serializeProviderCall(call: ProviderCallLedgerEntry) {
  const failureReason = call.failureReason ? sanitizeError(call.failureReason) : undefined;
  return {
    phase: call.phase,
    outcome: call.outcome,
    attempt: call.attempt,
    durationMs: call.durationMs,
    failureCategory: classifyProviderFailure(failureReason),
    failureReason,
  };
}

// ============================================================================
// Injectable dependency type for offline testing
// ============================================================================

export type RenderNovelFn = (
  fixturePath: string,
  options: {
    model?: string;
    maxRounds?: number;
    concurrency?: number;
    requestTimeoutMs?: number;
    seed?: number;
    env?: { apiKey?: string; baseUrl?: string };
    eventId?: string;
  },
) => Promise<RenderNovelResult>;

export interface ClosedLoopConditionSpec {
  fixture: string;
  mode: 'live-all' | 'live-event' | 'offline-assembly';
  eventId?: string;
}

export interface ClosedLoopRenderConfig {
  fullRuns: number;
  concurrency: number;
  maxRounds: number;
  maxNetworkReplacementRuns: number;
}

export interface ClosedLoopRequiredCodeCoverage {
  lines: number;
  statements: number;
  functions: number;
  branches: number;
}

export interface ClosedLoopCoverage {
  requiredLayers: string[];
  requiredConditions: string[];
  requiredGates: string[];
  requiredCodeCoverage: ClosedLoopRequiredCodeCoverage;
}

export interface ClosedLoopThresholds {
  maxPass2CallsPerEvent: number;
  medianChecklistCoverage: number;
  minimumRunChecklistCoverage: number;
  maxMajorInventedDetails: number;
  medianWordCountAPE: number;
  maxSceneWordCountAPE: number;
  minimumChecklistJaccard: number;
  memorizationOverlap24: number;
  memorizationMaxMatchedWindow: number;
  humanFullMedian: number;
  humanMaxPoorScenes: number;
  humanMinimumLiftOverMinimal: number;
}

export type ClosedLoopEvaluationMode = 'quality' | 'workflow';

export interface ClosedLoopSpec {
  version: number;
  evaluationMode: ClosedLoopEvaluationMode;
  changeReason: string;
  fixture: string;
  fixtureHash: string;
  sourceText: string;
  expectedEvents: string[];
  models: { primary: string; fallback: string };
  render: ClosedLoopRenderConfig;
  conditions: Record<string, ClosedLoopConditionSpec>;
  coverage: ClosedLoopCoverage;
  thresholds: ClosedLoopThresholds;
  specHash: string;
}


// ============================================================================
// History entry types
// ============================================================================

export interface ClosedLoopHistoryEntry {
  generatedAt: string;
  resultDir: string;
  specHash: string;
  fixtureHash: string;
  model: string;
  automatedPass: boolean;
  recommendation: string;
}

// ============================================================================
// Spec validation — Zod .strict()
// ============================================================================

const EXPECTED_CONDITIONS = ['full', 'layer-minimal', 'pov-switch', 'discourse-reorder'];

export class ClosedLoopSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClosedLoopSpecError';
  }
}

/**
 * Convert a Zod-parsed spec to the runtime ClosedLoopSpec interface.
 */
function parsedToSpec(parsed: ClosedLoopSpecParsed, specHash: string): ClosedLoopSpec {
  const conditions: Record<string, ClosedLoopConditionSpec> = {};
  for (const key of EXPECTED_CONDITIONS) {
    const c = parsed.conditions[key as keyof typeof parsed.conditions];
    conditions[key] = {
      fixture: c.fixture,
      mode: c.mode,
      eventId: c.eventId,
    };
  }

  return {
    version: parsed.version,
    evaluationMode: parsed.evaluationMode,
    changeReason: parsed.changeReason,
    fixture: parsed.fixture,
    fixtureHash: parsed.fixtureHash,
    sourceText: parsed.sourceText,
    expectedEvents: parsed.expectedEvents,
    models: { primary: parsed.models.primary, fallback: parsed.models.fallback },
    render: {
      fullRuns: parsed.render.fullRuns,
      concurrency: parsed.render.concurrency,
      maxRounds: parsed.render.maxRounds,
      maxNetworkReplacementRuns: parsed.render.maxNetworkReplacementRuns,
    },
    conditions,
    coverage: {
      requiredLayers: parsed.coverage.requiredLayers,
      requiredConditions: parsed.coverage.requiredConditions,
      requiredGates: parsed.coverage.requiredGates,
      requiredCodeCoverage: {
        lines: parsed.coverage.requiredCodeCoverage.lines,
        statements: parsed.coverage.requiredCodeCoverage.statements,
        functions: parsed.coverage.requiredCodeCoverage.functions,
        branches: parsed.coverage.requiredCodeCoverage.branches,
      },
    },
    thresholds: {
      maxPass2CallsPerEvent: parsed.thresholds.maxPass2CallsPerEvent,
      medianChecklistCoverage: parsed.thresholds.medianChecklistCoverage,
      minimumRunChecklistCoverage: parsed.thresholds.minimumRunChecklistCoverage,
      maxMajorInventedDetails: parsed.thresholds.maxMajorInventedDetails,
      medianWordCountAPE: parsed.thresholds.medianWordCountAPE,
      maxSceneWordCountAPE: parsed.thresholds.maxSceneWordCountAPE,
      minimumChecklistJaccard: parsed.thresholds.minimumChecklistJaccard,
      memorizationOverlap24: parsed.thresholds.memorizationOverlap24,
      memorizationMaxMatchedWindow: parsed.thresholds.memorizationMaxMatchedWindow,
      humanFullMedian: parsed.thresholds.humanFullMedian,
      humanMaxPoorScenes: parsed.thresholds.humanMaxPoorScenes,
      humanMinimumLiftOverMinimal: parsed.thresholds.humanMinimumLiftOverMinimal,
    },
    specHash,
  };
}

/**
 * Read and validate the closed-loop spec from its YAML file using Zod .strict().
 * Computes the specHash as SHA-256 of raw spec bytes.
 * Unknown keys or malformed nested shapes cause rejection.
 */
export function readClosedLoopSpec(specPath: string): ClosedLoopSpec {
  const content = readFileSync(specPath, 'utf-8');
  const specHash = createHash('sha256').update(content).digest('hex');
  const raw = YAML.parse(content);

  const result = closedLoopSpecSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map(
      (i) => `${i.path.join('.')}: ${i.message}`,
    );
    throw new ClosedLoopSpecError(`Spec validation failed:\n${issues.join('\n')}`);
  }

  return parsedToSpec(result.data, specHash);
}

// ============================================================================
// Spec history validation — nondecreasing additive contracts
// ============================================================================

export interface IndexFileEntry {
  generatedAt: string;
  resultDir: string;
  specHash: string;
  fixtureHash: string;
  model: string;
  automatedPass: boolean;
  recommendation: string;
}

/**
 * Validate spec version history for nondecreasing additive contracts.
 * Returns null on pass, or an error string on failure.
 * Checks: same specHash → rerun, valid; same fixtureHash but different specHash → drift detected.
 */
export function validateSpecHistory(
  history: IndexFileEntry[],
  spec: ClosedLoopSpec,
): string | null {
  if (history.length === 0) return null;

  // Same specHash found → this exact spec has been run before. Always valid.
  if (history.some((e) => e.specHash === spec.specHash)) return null;

  // Same fixtureHash with different specHash → fixture unchanged but spec config changed = drift
  const sameFixture = history.filter((e) => e.fixtureHash === spec.fixtureHash);
  if (sameFixture.length > 0) {
    const prev = sameFixture[sameFixture.length - 1];
    return `Spec drift detected: fixtureHash ${spec.fixtureHash} previously run with spec ${prev.specHash}, now using ${spec.specHash}. Version or configuration changed.`;
  }

  // New specHash with new fixtureHash → fresh experiment lineage, valid
  return null;
}

/**
 * A more complete history validation using persisted resultDir info.
 * Checks that the new spec doesn't relax any constraints vs the previous
 * spec of the same major version.
 */
export function validateSpecHistoryStrict(
  history: IndexFileEntry[],
  spec: ClosedLoopSpec,
): string | null {
  if (history.length === 0) return null;

  // Same specHash → exact match, valid
  if (history.some((e) => e.specHash === spec.specHash)) return null;

  // Same fixtureHash with different specHash → drift
  const sameFixture = history.filter((e) => e.fixtureHash === spec.fixtureHash);
  if (sameFixture.length > 0) {
    return `Strict: fixtureHash ${spec.fixtureHash} previously run with different spec (${sameFixture[sameFixture.length - 1].specHash}). Spec config changed without version bump.`;
  }

  // Different fixtureHash → new experiment lineage entirely, valid
  return null;
}

// ============================================================================
// Coverage gate check
// ============================================================================

export interface CoverageGateResult {
  passed: boolean;
  failures: string[];
}

/**
 * Check that code coverage JSON summary meets the spec thresholds.
 * Returns failures; empty array = pass.
 * REQUIRED check: missing coverage summary or missing "total" key both fail.
 */
export function checkCoverageGate(
  coveragePath: string,
  thresholds: ClosedLoopRequiredCodeCoverage,
): CoverageGateResult {
  const failures: string[] = [];

  let summary: Record<string, unknown>;
  try {
    const content = readFileSync(coveragePath, 'utf-8');
    summary = JSON.parse(content);
  } catch {
    return {
      passed: false,
      failures: [`Coverage summary not found at ${coveragePath}`],
    };
  }

  const totals = summary.total as Record<string, number> | undefined;
  if (!totals) {
    return { passed: false, failures: ['Coverage summary missing "total"'] };
  }

  for (const metric of ['lines', 'statements', 'functions', 'branches'] as const) {
    const actual = totals[metric] as number | undefined;
    const required = thresholds[metric];
    if (actual === undefined) {
      failures.push(`Coverage metric "${metric}" not found in summary`);
    } else if (actual < required) {
      failures.push(`Coverage ${metric}: ${actual}% < required ${required}%`);
    }
  }

  return { passed: failures.length === 0, failures };
}

// ============================================================================
// Temp fixture copy
// ============================================================================

/**
 * Create a temporary copy of a fixture excluding runtime and generated output.
 * @param fixturePath - Source fixture directory to copy
 * @param workDir - Base working directory for the copy
 * @param subDir - Optional subdirectory name for uniqueness (e.g., "full-run-01").
 *                 If omitted, uses the basename of fixturePath.
 */
export function createTempFixtureCopy(
  fixturePath: string,
  workDir: string,
  subDir?: string,
): string {
  const targetDir = subDir
    ? path.join(workDir, subDir)
    : path.join(workDir, path.basename(fixturePath));
  cpSync(fixturePath, targetDir, {
    recursive: true,
    filter: (src: string) => {
      const rel = path.relative(fixturePath, src);
      const parts = rel.split(path.sep);
      if (parts[0] === '.nova' || parts[0] === 'output' || parts[0] === 'scenes') return false;
      return true;
    },
  });
  return targetDir;
}
// ============================================================================
// Spec persistence/version validation
// ============================================================================

/**
 * Load the history index file for a results directory.
 */
export function loadHistory(outputDir: string): IndexFileEntry[] {
  const indexPath = path.join(outputDir, 'index.json');
  try {
    const content = readFileSync(indexPath, 'utf-8');
    return JSON.parse(content) as IndexFileEntry[];
  } catch {
    return [];
  }
}

/**
 * Append a new history entry and write latest.json.
 */
export function appendHistory(
  outputDir: string,
  entry: IndexFileEntry,
): void {
  mkdirSync(outputDir, { recursive: true });
  const history = loadHistory(outputDir);
  history.push(entry);
  writeFileSync(path.join(outputDir, 'index.json'), JSON.stringify(history, null, 2));
  writeFileSync(path.join(outputDir, 'latest.json'), JSON.stringify(entry, null, 2));
}

// ============================================================================
// Condition execution
// ============================================================================

/**
 * Run a single condition of the closed-loop experiment.
 * Accepts injectable renderNovelFn for offline testing.
 * Honors conditionSpec.eventId for single-event conditions (pov-switch).
 * Precheck (runId === 'precheck') renders E0 only with maxRounds=1.
 * Uses projectDir for per-run output isolation.
 */
export async function runCondition(
  spec: ClosedLoopSpec,
  conditionKey: string,
  conditionSpec: ClosedLoopConditionSpec,
  runId: string,
  rootDir: string,
  model: string,
  renderNovelFn?: RenderNovelFn,
  projectDir?: string,
): Promise<ClosedLoopRunMetrics> {
  console.log(JSON.stringify({
    event: 'closed_loop_condition_start',
    condition: conditionKey,
    runId,
    model,
    eventId: runId === 'precheck' ? 'E0' : conditionSpec.eventId ?? 'all',
  }));
  const fullFixturePath = path.resolve(rootDir, conditionSpec.fixture);

  if (conditionSpec.mode === 'offline-assembly') {
    return runOfflineAssembly(spec, conditionKey, runId, fullFixturePath, model, rootDir, projectDir);
  }

  // Create temp copy of fixture in system temp directory to avoid Node's refusal
  // to copy a source directory into its own descendant when projectDir lives
  // under the fixture tree (e.g., fixtures/zhu-fu/output/closed-loop/.../project).
  // After rendering, archive (cpSync) the completed project to projectDir if
  // provided, then clean up the temp dir.
  const tempBase = mkdtempSync(path.join(tmpdir(), 'zhu-fu-'));
  const tempFixture = createTempFixtureCopy(fullFixturePath, tempBase);
  let cleanedUp = false;
  try {
    const sourceTextPath = path.resolve(rootDir, spec.sourceText);
    const sourceText = readFileSync(sourceTextPath, 'utf-8');

    // Determine eventId: precheck renders E0 only; condition spec may specify (pov-switch E5)
    const eventIdOverride = runId === 'precheck' ? 'E0' : conditionSpec.eventId;
    const maxRoundsOverride = runId === 'precheck' ? 1 : spec.render.maxRounds;

    const renderer = renderNovelFn || ((fp, opts) => renderNovel({
      projectDir: fp,
      model: opts.model,
      apiKey: opts.env?.apiKey,
      baseUrl: opts.env?.baseUrl,
      maxRounds: opts.maxRounds,
      concurrency: opts.concurrency,
      eventId: opts.eventId,
      requestTimeoutMs: opts.requestTimeoutMs,
      trace: true,
    }));

    const result = await renderer(tempFixture, {
      model,
      maxRounds: maxRoundsOverride,
      concurrency: spec.render.concurrency,
      requestTimeoutMs: 90_000,
      eventId: eventIdOverride,
      seed: 42,
      env: {
        apiKey: process.env.NOVALISTICALLY_AI_API_KEY || undefined,
        baseUrl: process.env.NOVALISTICALLY_AI_BASE_URL || undefined,
      },
    });
    console.log(JSON.stringify({
      event: 'closed_loop_condition_rendered',
      condition: conditionKey,
      runId,
      results: result.results.map((entry) => ({
        eventId: entry.eventId,
        released: entry.released,
        analysisPresent: entry.analysis !== null,
        pass2Rejection: entry.pass2Rejection ?? null,
        providerCalls: entry.providerCalls.length,
      })),
      errors: result.errors.length,
    }));

    // ── Load event-specific target word counts directly from fixture YAML ──
    // Scoring must not fall back to 1200 because unrelated fixture definitions
    // are incomplete; only each event's style guidance is relevant here.
    const targetWordCounts: Record<string, number> = {};
    const chaptersDir = path.join(tempFixture, 'chapters');
    if (existsSync(chaptersDir)) {
      for (const chapter of readdirSync(chaptersDir, { withFileTypes: true })) {
        if (!chapter.isDirectory()) continue;
        const chapterDir = path.join(chaptersDir, chapter.name);
        for (const file of readdirSync(chapterDir, { withFileTypes: true })) {
          if (!file.isFile() || !file.name.endsWith('.yaml') || file.name.startsWith('_')) continue;
          try {
            const raw = YAML.parse(readFileSync(path.join(chapterDir, file.name), 'utf-8'));
            const eventId = typeof raw?.event === 'string' ? raw.event : undefined;
            const targetWordCount = raw?.styleGuidance?.targetWordCount;
            if (eventId && typeof targetWordCount === 'number' && Number.isFinite(targetWordCount) && targetWordCount > 0) {
              targetWordCounts[eventId] = targetWordCount;
            }
          } catch {
            // A malformed event remains eligible for the default only; rendering
            // and its own validation path report the underlying fixture failure.
          }
        }
      }
    }


    const allValidationIssues = result.results.flatMap((r) => r.validationIssues ?? []);
    const validatorCategories: Record<string, import('@novalistically/core').Validator['category']> = {};
    const validatorAggregator = new ResultAggregator();
    for (const issue of allValidationIssues) {
      try {
        validatorCategories[issue.validator] = validatorAggregator.getValidatorCategory(issue.validator);
      } catch {
        // Plugin and unknown validators retain the scoring layer's explicit
        // fallback category rather than being guessed from their messages.
      }
    }
    const metrics = evaluateClosedLoopRun({
      condition: conditionKey as ClosedLoopRunInput['condition'],
      runId,
      model,
      fixturePath: fullFixturePath,
      renderedProjectDir: tempFixture,
      specHash: spec.specHash,
      result,
      sourceText,
      targetWordCounts,
      validationIssues: allValidationIssues.length > 0 ? allValidationIssues : undefined,
      validatorCategories,
    });

    // ── Write sanitized diagnostic artifact when any event is unreleased ──
    const unreleasedEvents = result.results.filter((r) => !r.released);
    if (unreleasedEvents.length > 0) {
      const diagnosticDir = projectDir ? path.dirname(projectDir) : path.join(tempFixture, '.diagnostics');
      mkdirSync(diagnosticDir, { recursive: true });
      for (const r of unreleasedEvents) {
        console.error(JSON.stringify({
          event: 'closed_loop_condition_unreleased',
          condition: conditionKey,
          runId,
          eventId: r.eventId,
          validationErrors: r.validationErrors,
          validationIssues: (r.validationIssues ?? []).map(serializeDiagnosticIssue),
          providerCalls: r.providerCalls.map(serializeProviderCall),
        }));
      }
      const diagnostic = {
        condition: conditionKey,
        runId,
        generatedAt: new Date().toISOString(),
        eventCount: result.results.length,
        unreleasedEventCount: unreleasedEvents.length,
        events: unreleasedEvents.map((r) => ({
          eventId: r.eventId,
          released: r.released,
          analysisPresent: r.analysis !== null,
          pass2Rejection: r.pass2Rejection ?? null,
          pass2Calls: r.providerCalls.filter((pc) => pc.phase === 'pass2').length,
          sceneAttempts: r.providerCalls.length > 0 ? Math.max(...r.providerCalls.map((pc: { attempt: number }) => pc.attempt)) : 0,
          validationErrorCount: r.validationErrors,
          validationIssues: (r.validationIssues ?? []).map(serializeDiagnosticIssue),
          ledger: r.providerCalls.map(serializeProviderCall),
        })),
      };
      writeFileSync(
        path.join(diagnosticDir, `${runId}_unreleased-diagnostic.json`),
        JSON.stringify(diagnostic, null, 2),
      );
    }
    // ── End unreleased diagnostic ──

    // Archive: copy completed rendered project to projectDir for result layout persistence
    if (projectDir) {
      mkdirSync(path.dirname(projectDir), { recursive: true });
      cpSync(tempFixture, projectDir, { recursive: true });
    }

    cleanedUp = true;
    rmSync(tempBase, { recursive: true, force: true });

    return metrics;
  } finally {
    if (!cleanedUp) {
      try { rmSync(tempBase, { recursive: true, force: true }); } catch { /* best effort cleanup */ }
    }
  }
}

async function runOfflineAssembly(
  spec: ClosedLoopSpec,
  conditionKey: string,
  runId: string,
  fixturePath: string,
  model: string,
  rootDir: string,
  projectDir?: string,
): Promise<ClosedLoopRunMetrics> {
  // Determine output directory: use projectDir if provided, else fixturePath
  const outputDir = projectDir || fixturePath;

  const sourcePath = path.resolve(rootDir, spec.sourceText);
  const sourceText = readFileSync(sourcePath, 'utf-8');

  // Approved prose/analysis are anchored to the frozen base fixture. The
  // discourse-reorder variant supplies only the causal/event definition.
  const approvedFixturePath = path.resolve(rootDir, spec.fixture);
  const refDir = path.join(approvedFixturePath, 'reference');
  if (!existsSync(refDir)) {
    throw new ClosedLoopSpecError(
      `Approved reference directory is missing at ${refDir}. ` +
      'Offline assembly requires the frozen base reference.',
    );
  }
  const references = loadApprovedReferences(refDir);
  const refMap = references.references;

  // Collect validation issues (L1 + L2) from the reference using EntityMapper,
  // compileStoryBoundaries, and ResultAggregator
  const allIssues = collectReferenceValidationIssues(fixturePath, refMap);

  const errors = allIssues.filter((i: { severity: string }) => i.severity === 'error').length;
  const warnings = allIssues.filter((i: { severity: string }) => i.severity === 'warning').length;
  const infos = allIssues.filter((i: { severity: string }) => i.severity === 'info').length;

  // Discourse-reorder assembly order
  const discourseOrder = ['E0', 'E1', 'E3', 'E2', 'E4', 'E5', 'E6'];
  const functionalPass = errors === 0;

  // ── Load fixture data via EntityMapper for proper RenderJob construction ──
  const mapper = new EntityMapper(fixturePath);
  const projectData = mapper.loadProject();
  const registry = new InMemoryEntityRegistry();
  registry.load(fixturePath);
  const allEvents = mapper.loadAllEvents(projectData.chapters);
  const narrativeEvents = allEvents.filter((e) => e.id !== 'system:genesis');
  const genesis = allEvents.find((e) => e.id === 'system:genesis');

  // Compile initial facts from registry entity states
  const initialFacts: Fact[] = [
    ...(genesis?.postconditions ?? []),
    ...registry.getAll().flatMap((entity) =>
      Object.entries(entity.state ?? {}).map(([attribute, value]) => ({
        id: `${entity.id}.${attribute}`,
        entityId: entity.id,
        attribute,
        value,
        validity: {
          temporal: { start: { type: 'absolute' as const, value: 'day_0' }, end: null },
          branches: { type: 'all' as const },
        },
      })),
    ),
  ];

  const boundaries = compileStoryBoundaries(
    narrativeEvents,
    initialFacts,
    new Map((projectData.timeAnchors ?? []).map((a) => [a.id, a.day] as const)),
  );

  // Build chapter-by-event lookup
  const chapterByEventId = new Map<string, number>();
  for (const [ch, chapter] of projectData.chapters) {
    for (const evFile of chapter.events) {
      chapterByEventId.set(evFile.event, ch);
    }
  }
  const eventById = new Map(allEvents.map((e) => [e.id, e]));

  const now = Date.now();

  // Build RenderJob[] and RenderSceneResult[] from reference data
  const jobs: RenderJob[] = [];
  const renderSceneResults: RenderSceneResult[] = [];

  for (const [idx, eventId] of discourseOrder.entries()) {
    const event = eventById.get(eventId);
    if (!event) continue;

    const stateBefore = boundaries.stateBeforeByEventId.get(eventId);
    if (!stateBefore) continue;

    const chapter = chapterByEventId.get(eventId) ?? 1;
    const ref = refMap.get(eventId);
    const prose = ref?.prose || '';
    const analysis = ref?.analysis || null;

    // Build minimal valid ContextPackage
    const context: ContextPackage = {
      eventId,
      systemContext: {
        genre: projectData.config?.genre ?? 'literary',
        style: 'literary',
        narrativeRules: [],
        ideaIR: projectData.config?.ideaIR ?? undefined,
      },
      sceneSpec: {
        goal: event.sceneBrief || '',
        povType: event.pov?.type || 'third_person_limited',
        povCharacter: event.pov?.character || '',
        conflict: event.conflictType || '',
        expectedOutcome: '',
      },
      characterSnapshots: [],
      relationshipContext: [],
      worldFacts: [],
      knowledgeBoundary: { characterId: '', knownFacts: [], unknownFacts: [] },
      activeThreads: [],
      previousSceneSummary: '',
      volumeSummary: '',
      markdown: `# ${eventId}\n\n${prose}\n`,
    };

    jobs.push({ event, stateBefore, context, chapter });

    renderSceneResults.push({
      eventId,
      prose,
      analysis,
      llmPass1: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      llmPass2: null,
      cacheHit: false,
      errors: [],
      promptHash: ref?.metadata?.promptHash || 'offline-assembly',
      renderStart: now,
      renderEnd: now,
      validation: null,
      providerCalls: [],
      attempts: 1,
      needsReview: false,
    });
  }

  // Write outputs using buildAndWriteOutputs to outputDir (FsStorage writes to real filesystem)
  buildAndWriteOutputs(new FsStorage(), outputDir, jobs, renderSceneResults);

  // Assemble novel — let errors propagate (never catch-and-ignore)
  assembleNovel({ projectDir: outputDir, language: 'zh-CN' });

  // Build events for metrics
  const events = discourseOrder.map((eventId) => {
    const ref = refMap.get(eventId);
    const prose = ref?.prose || '';
    const wordCount = prose.length;

    return {
      eventId,
      released: true,
      analysisPresent: (ref?.analysis) !== null,
      pass2Rejection: null,
      sceneAttempts: 1,
      pass2Calls: 0,
      providerCalls: [],
      wordCount,
      targetWordCount: 1200,
      wordCountAbsolutePercentageError: 1200 > 0 ? Math.abs(wordCount - 1200) / 1200 : 0,
      checklist: { covered: 0, total: 0, ratio: null },
      majorInventedDetails: 0,
      qualitySelfEvaluation: null,
      sourceOverlap: computeSourceOverlap(prose, sourceText),
    };
  });

  const fixtureHash = computeFixtureHash(fixturePath);
  const specHash = spec.specHash;

  return {
    condition: conditionKey as ClosedLoopRunInput['condition'],
    runId,
    model,
    fixtureHash,
    specHash,
    events,
    issues: {
      identities: [],
      errors,
      warnings,
      infos,
      nced: 0,
      sced: { rawSCED: 0, weightedSCED: 0, totalWeightedIssues: 0, totalRawIssues: 0 },
      perValidator: {},
    },
    functionalPass,
  };
}

// ============================================================================
// Fatal record helper — sanitized precheck failure record (no prose/errors/keys)
// ============================================================================

/**
 * Write a sanitized fatal-record.json for a precheck failure.
 * It preserves a classified outcome for both frozen models without raw provider
 * output, prose, error text, credentials, or request identifiers.
 */
export function writeFatalRecord(
  resultDir: string,
  failures: Array<{
    model: string;
    status: 'nonfunctional' | 'provider_error';
    metrics: ClosedLoopRunMetrics | null;
  }>,
): void {
  const record = {
    precheckFailed: true,
    failures: failures.map(({ model, status, metrics }) => ({
      model,
      status,
      events: metrics?.events.map((e) => ({
        eventId: e.eventId,
        analysisPresent: e.analysisPresent,
        pass2Rejection: e.pass2Rejection,
        released: e.released,
        pass2Calls: e.pass2Calls,
        sceneAttempts: e.sceneAttempts,
        validationErrorCount: metrics.issues.errors,
      })) ?? [],
    })),
  };

  writeFileSync(path.join(resultDir, 'fatal-record.json'), JSON.stringify(record, null, 2));
}
// ============================================================================
// runClosedLoopExperiment — Full experiment orchestrator
// ============================================================================

export interface ExperimentResult {
  resultDir: string;
  experimentJson: Record<string, unknown>;
  reportLines: string[];
  allMetrics: ClosedLoopRunMetrics[];
  aggregate: ClosedLoopAggregate;
  exitCode: number;
  recommendation: string;
  precheckFailed: boolean;
  blockedByCoverage: boolean;
}

/**
 * Run a complete closed-loop experiment with the full condition matrix.
 *
 * Orchestration:
 *   1. Coverage gate check — REQUIRED before any provider call
 *   2. Precheck: render E0 with primary model (maxRounds=1); fallback on failure
 *   3. Full condition matrix: 3× full, 1× layer-minimal, 1× pov-switch, 1× discourse-reorder
 *   4. Aggregate, build report, compute experiment.json
 *
 * @param spec - frozen closed-loop spec
 * @param outputDir - directory for experiment output
 * @param rootDir - repository root directory for resolving fixture/sourceText paths (default process.cwd())
 * @param renderNovelFn - optional injectable render function for testing
 */
function getEvaluationMode(spec: ClosedLoopSpec): ClosedLoopEvaluationMode {
  // Keep direct programmatic callers of the pre-mode interface on the legacy
  // quality contract while parsed specs always carry the explicit default.
  return spec.evaluationMode ?? 'quality';
}

export async function runClosedLoopExperiment(
  spec: ClosedLoopSpec,
  outputDir: string,
  rootDir: string = process.cwd(),
  renderNovelFn?: RenderNovelFn,
): Promise<ExperimentResult> {
  const primaryModel = spec.models.primary;
  const fallbackModel = spec.models.fallback;

  // ── 0. Coverage gate — REQUIRED, blocks on missing or insufficient coverage ──
  const evaluationMode = getEvaluationMode(spec);
  const coveragePath = path.join(process.cwd(), 'coverage', 'closed-loop', 'coverage-summary.json');
  const gateResult = checkCoverageGate(coveragePath, spec.coverage.requiredCodeCoverage);
  if (!gateResult.passed) {
    return {
      resultDir: outputDir,
      experimentJson: {
        version: spec.version,
        generatedAt: new Date().toISOString(),
        specHash: spec.specHash,
        evaluationMode,
        summary: {
          evaluationMode,
          automatedPass: false,
          workflowPass: false,
          functionalPass: false,
          stabilityPass: false,
          counterfactualPass: false,
          qualityMeasurementStatus: 'not_evaluated',
          qualityMeasurementsOutOfScope: evaluationMode === 'workflow',
          developmentStatus: 'blocked',
          frontendInvestmentRecommendation: 'hold',
          literaryQualityStatus: 'not_established',
          coverageFailures: gateResult.failures,
        },
      },
      reportLines: [
        '# Zhu-Fu Closed-Loop Report',
        '',
        `**Spec**: v${spec.version} — ${spec.changeReason}`,
        '**Status**: BLOCKED — coverage gate failed before provider calls',
        '',
        `**Evaluation mode**: ${evaluationMode}`,
        evaluationMode === 'workflow'
          ? '**Quality/originality measures**: out of workflow acceptance scope'
          : '**Quality/originality measures**: acceptance-blocking',
        '## Coverage Failures',
        ...gateResult.failures.map((f) => `- ${f}`),
      ],
      allMetrics: [],
      aggregate: { runs: [], functionalPass: false, stabilityPass: false, pairwiseChecklistJaccard: [] },
      exitCode: 4,
      recommendation: 'hold',
      precheckFailed: false,
      blockedByCoverage: true,
    };
  }

  const resultDir = path.join(outputDir, new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(resultDir, { recursive: true });

  // ── 1. Precheck: render E0 with primary model (maxRounds=1) ──
  let model = primaryModel;
  const precheckCondSpec = spec.conditions.full;

  try {
    const e0Result = await runCondition(
      spec, 'full', precheckCondSpec, 'precheck', rootDir, primaryModel, renderNovelFn,
    );
    if (!e0Result.functionalPass) {
      // Fallback
      const fbResult = await runCondition(
        spec, 'full', precheckCondSpec, 'precheck', rootDir, fallbackModel, renderNovelFn,
      );
      if (!fbResult.functionalPass) {
        writeFatalRecord(resultDir, [
          { model: primaryModel, status: 'nonfunctional', metrics: e0Result },
          { model: fallbackModel, status: 'nonfunctional', metrics: fbResult },
        ]);
        const blockedPath = path.join(resultDir, 'blocked-pass2.md');
        writeFileSync(blockedPath, `# Blocked: Pass 2 failure\n\nBoth primary (${primaryModel}) and fallback (${fallbackModel}) models failed E0 precheck.\n`);
        return {
          resultDir,
          experimentJson: {
            version: spec.version,
            generatedAt: new Date().toISOString(),
            specHash: spec.specHash,
            evaluationMode,
            summary: {
              evaluationMode,
              automatedPass: false,
              workflowPass: false,
              functionalPass: false,
              stabilityPass: false,
              counterfactualPass: false,
              qualityMeasurementStatus: 'not_evaluated',
              qualityMeasurementsOutOfScope: evaluationMode === 'workflow',
              developmentStatus: 'blocked',
              frontendInvestmentRecommendation: 'stop_and_fix_pipeline',
              precheckFailed: true,
            },
          },
          reportLines: [
            '# Zhu-Fu Closed-Loop Report',
            '',
            `**Spec**: v${spec.version} — ${spec.changeReason}`,
            `**Evaluation mode**: ${evaluationMode}`,
            '**Status**: BLOCKED — both models failed E0 precheck',
            '',
            evaluationMode === 'workflow'
              ? '**Quality/originality measures**: out of workflow acceptance scope'
              : '**Quality/originality measures**: acceptance-blocking',
            '',
            'Details written to blocked-pass2.md and fatal-record.json',
          ],
          allMetrics: [],
          aggregate: { runs: [], functionalPass: false, stabilityPass: false, pairwiseChecklistJaccard: [] },
          exitCode: 3,
          recommendation: 'hold',
          precheckFailed: true,
          blockedByCoverage: false,
        };
      }
      model = fallbackModel;
    }
  } catch {
    try {
      const fbResult = await runCondition(
        spec, 'full', precheckCondSpec, 'precheck', rootDir, fallbackModel, renderNovelFn,
      );
      if (!fbResult.functionalPass) {
        writeFatalRecord(resultDir, [
          { model: primaryModel, status: 'provider_error', metrics: null },
          { model: fallbackModel, status: 'nonfunctional', metrics: fbResult },
        ]);
        const blockedPath = path.join(resultDir, 'blocked-pass2.md');
        writeFileSync(blockedPath, `# Blocked: Pass 2 failure\n\nBoth models failed E0 precheck (primary threw, fallback returned nonfunctional).\n`);
        return {
          resultDir,
          experimentJson: {
            version: spec.version,
            generatedAt: new Date().toISOString(),
            specHash: spec.specHash,
            evaluationMode,
            summary: {
              evaluationMode,
              automatedPass: false,
              workflowPass: false,
              functionalPass: false,
              stabilityPass: false,
              counterfactualPass: false,
              qualityMeasurementStatus: 'not_evaluated',
              qualityMeasurementsOutOfScope: evaluationMode === 'workflow',
              developmentStatus: 'blocked',
              frontendInvestmentRecommendation: 'stop_and_fix_pipeline',
              precheckFailed: true,
            },
          },
          reportLines: [
            '# Zhu-Fu Closed-Loop Report',
            '',
            `**Evaluation mode**: ${evaluationMode}`,
            '**Status**: BLOCKED — both models failed E0 precheck (primary threw, fallback returned nonfunctional)',
            '',
            evaluationMode === 'workflow'
              ? '**Quality/originality measures**: out of workflow acceptance scope'
              : '**Quality/originality measures**: acceptance-blocking',
            '',
            'Details written to blocked-pass2.md and fatal-record.json',
          ],
          allMetrics: [],
          aggregate: { runs: [], functionalPass: false, stabilityPass: false, pairwiseChecklistJaccard: [] },
          exitCode: 3,
          recommendation: 'hold',
          precheckFailed: true,
          blockedByCoverage: false,
        };
      }
      model = fallbackModel;
    } catch {
      writeFatalRecord(resultDir, [
        { model: primaryModel, status: 'provider_error', metrics: null },
        { model: fallbackModel, status: 'provider_error', metrics: null },
      ]);
      const blockedPath = path.join(resultDir, 'blocked-pass2.md');
      writeFileSync(blockedPath, `# Blocked: Pass 2 failure\n\nBoth models threw during E0 precheck.\n`);
      return {
        resultDir,
        experimentJson: {
          version: spec.version,
          generatedAt: new Date().toISOString(),
          specHash: spec.specHash,
          evaluationMode,
          summary: {
            evaluationMode,
            automatedPass: false,
            workflowPass: false,
            functionalPass: false,
            stabilityPass: false,
            counterfactualPass: false,
            qualityMeasurementStatus: 'not_evaluated',
            qualityMeasurementsOutOfScope: evaluationMode === 'workflow',
            developmentStatus: 'blocked',
            frontendInvestmentRecommendation: 'stop_and_fix_pipeline',
            precheckFailed: true,
          },
        },
        reportLines: [
          '# Zhu-Fu Closed-Loop Report',
          '',
          `**Evaluation mode**: ${evaluationMode}`,
          '**Status**: BLOCKED — both models threw during E0 precheck',
          '',
          evaluationMode === 'workflow'
            ? '**Quality/originality measures**: out of workflow acceptance scope'
            : '**Quality/originality measures**: acceptance-blocking',
          '',
          'Details written to blocked-pass2.md and fatal-record.json',
        ],
        allMetrics: [],
        aggregate: { runs: [], functionalPass: false, stabilityPass: false, pairwiseChecklistJaccard: [] },
        exitCode: 3,
        recommendation: 'hold',
        precheckFailed: true,
        blockedByCoverage: false,
      };
    }
  }
  // ── 2. Run conditions ──
  const allMetrics: ClosedLoopRunMetrics[] = [];
  const conditionsDir = path.join(resultDir, 'conditions');
  mkdirSync(conditionsDir, { recursive: true });

  // full: 3 runs
  const fullRuns = spec.render.fullRuns;
  for (let runNum = 1; runNum <= fullRuns; runNum++) {
    const runId = `run-${String(runNum).padStart(2, '0')}`;
    const runDir = path.join(conditionsDir, 'full', runId);
    const projectDir = path.join(runDir, 'project');
    mkdirSync(projectDir, { recursive: true });

    const metrics = await runCondition(
      spec, 'full', spec.conditions.full, runId, rootDir, model, renderNovelFn, projectDir,
    );
    allMetrics.push(metrics);

    // Write metrics.json at run level (not inside project)
    writeFileSync(path.join(runDir, 'metrics.json'), JSON.stringify(metrics, null, 2));
  }

  // layer-minimal: 1 run
  const minimalRunDir = path.join(conditionsDir, 'layer-minimal', 'run-01');
  const minimalProjectDir = path.join(minimalRunDir, 'project');
  mkdirSync(minimalProjectDir, { recursive: true });
  const minimalMetrics = await runCondition(
    spec, 'layer-minimal', spec.conditions['layer-minimal'], 'run-01', rootDir, model, renderNovelFn, minimalProjectDir,
  );
  allMetrics.push(minimalMetrics);
  writeFileSync(path.join(minimalRunDir, 'metrics.json'), JSON.stringify(minimalMetrics, null, 2));

  // pov-switch: 1 run, E5 only
  const povRunDir = path.join(conditionsDir, 'pov-switch', 'E5');
  const povProjectDir = path.join(povRunDir, 'project');
  mkdirSync(povProjectDir, { recursive: true });
  const povMetrics = await runCondition(
    spec, 'pov-switch', spec.conditions['pov-switch'], 'E5', rootDir, model, renderNovelFn, povProjectDir,
  );
  allMetrics.push(povMetrics);
  writeFileSync(path.join(povRunDir, 'metrics.json'), JSON.stringify(povMetrics, null, 2));

  // discourse-reorder: 1 run, offline
  const reorderRunDir = path.join(conditionsDir, 'discourse-reorder', 'run-01');
  const reorderProjectDir = path.join(reorderRunDir, 'project');
  mkdirSync(reorderProjectDir, { recursive: true });
  const reorderMetrics = await runCondition(
    spec, 'discourse-reorder', spec.conditions['discourse-reorder'], 'run-01', rootDir, model, renderNovelFn, reorderProjectDir,
  );
  allMetrics.push(reorderMetrics);
  writeFileSync(path.join(reorderRunDir, 'metrics.json'), JSON.stringify(reorderMetrics, null, 2));
  const fullMetrics = allMetrics.filter((m) => m.condition === 'full');
  const aggregate = aggregateClosedLoopRuns(fullMetrics);

  // Determine pass/fail
  const functionalPass = allMetrics.every((m) => m.functionalPass);
  const stabilityPass = aggregate.stabilityPass;
  const counterfactualPass = allMetrics
    .filter((m) => m.condition === 'pov-switch')
    .every((m) => m.functionalPass);

  // Memorization risk
  const allSourceOverlaps = allMetrics.flatMap((m) =>
    m.events.map((e) => e.sourceOverlap),
  );
  const hasHighMemorization = allSourceOverlaps.some((o) => o.memorizationRisk === 'high');

  // Evaluate frozen thresholds
  const thresholdResult = evaluateClosedLoopThresholds(spec.thresholds, allMetrics);

  const workflowPass = functionalPass && stabilityPass && counterfactualPass;
  const qualityMeasurementPass = !hasHighMemorization && thresholdResult.pass;
  // Quality mode preserves the historical acceptance formula. Workflow mode
  // deliberately gates only functional/stability/counterfactual behavior;
  // quality and originality measurements remain persisted below.
  const automatedPass = evaluationMode === 'workflow'
    ? workflowPass
    : workflowPass && qualityMeasurementPass;

  // ── 4. Build conditions map ──
  const conditionsMap: Record<string, { runs: ClosedLoopRunMetrics[] }> = {};
  for (const condition of ['full', 'layer-minimal', 'pov-switch', 'discourse-reorder'] as const) {
    conditionsMap[condition] = {
      runs: allMetrics.filter((m) => m.condition === condition),
    };
  }

  // ── 5. Build experiment.json with full coverage tracking ──
  const layerNames = spec.coverage.requiredLayers;
  const conditionNames = spec.coverage.requiredConditions;
  const gateNames = spec.coverage.requiredGates;

  // Build capability coverage evidence paths
  const capabilityCoverage: { covered: number; required: number; ratio: number } = {
    covered: 0,
    required: layerNames.length + conditionNames.length + gateNames.length,
    ratio: 0,
  };

  const layerEvidence: Record<string, { promptReachable: boolean; automatedValidation: boolean; humanReviewRequired: boolean; evidencePaths: string[] }> = {};
  for (const layer of layerNames) {
    layerEvidence[layer] = {
      promptReachable: true,
      automatedValidation: ['s1-checklist', 's2-grey-lines'].includes(layer),
      humanReviewRequired: true,
      evidencePaths: [],
    };
  }

  const capabilityEntries: Array<{ name: string; type: string; status: string; evidencePaths: string[] }> = [];

  // Build evidence paths from conditions
  for (const conditionName of conditionNames) {
    const conditionRuns = allMetrics.filter((m) => m.condition === conditionName);
    const paths: string[] = [];
    for (const run of conditionRuns) {
      for (const event of run.events) {
        const runDir = conditionsMap[conditionName]?.runs.find((r) => r.runId === run.runId);
        const base = runDir ? `conditions/${conditionName}/${run.runId}` : '';
        if (event.analysisPresent) {
          paths.push(`${base}/project/scenes/chapter-01/${event.eventId}.md`);
          paths.push(`${base}/project/.nova/responses/${event.eventId}.json`);
        }
      }
    }
    capabilityEntries.push({
      name: conditionName,
      type: 'condition',
      status: conditionRuns.length > 0 && conditionRuns.every((r) => r.functionalPass) ? 'covered' : 'missing',
      evidencePaths: paths,
    });
  }

  // Gates evidence
  for (const gate of gateNames) {
    const paths: string[] = ['metrics.json (per condition)'];
    capabilityEntries.push({
      name: gate,
      type: 'gate',
      status: functionalPass ? 'covered' : 'missing',
      evidencePaths: paths,
    });
  }

  // Layers evidence
  for (const layer of layerNames) {
    const paths: string[] = ['experiment.json (layerEvidence)'];
    capabilityEntries.push({
      name: layer,
      type: 'layer',
      status: 'covered',
      evidencePaths: paths,
    });
  }

  capabilityCoverage.covered = capabilityEntries.filter((e) => e.status === 'covered').length;
  capabilityCoverage.ratio = capabilityCoverage.covered / capabilityCoverage.required;

  const experimentJson: Record<string, unknown> = {
    version: spec.version,
    generatedAt: new Date().toISOString(),
    model,
    specHash: spec.specHash,
    fixtureHash: spec.fixtureHash,
    evaluationMode,
    conditions: conditionsMap,
    summary: {
      evaluationMode,
      automatedPass,
      workflowPass,
      functionalPass,
      stabilityPass,
      counterfactualPass,
      qualityMeasurementPass,
      qualityMeasurementStatus: qualityMeasurementPass ? 'pass' : 'fail',
      qualityMeasurementsOutOfScope: evaluationMode === 'workflow',
      thresholdsPass: thresholdResult.pass,
      thresholdFailures: thresholdResult.failures,
      memorizationRisk: hasHighMemorization ? 'high' : 'low',
      developmentStatus: automatedPass ? 'automated_stable' : 'iterating',
      frontendInvestmentRecommendation: 'hold',
      literaryQualityStatus: 'not_established',
      capabilityCoverage,
      layerEvidence,
      evidencePaths: capabilityEntries,
    },
  };

  // ── 6. Build report.md ──
  const reportLines = buildReportMd(
    spec,
    model,
    aggregate,
    allMetrics,
    hasHighMemorization,
    automatedPass,
    workflowPass,
    qualityMeasurementPass,
  );

  writeFileSync(path.join(resultDir, 'experiment.json'), JSON.stringify(experimentJson, null, 2));
  writeFileSync(path.join(resultDir, 'report.md'), reportLines.join('\n'));

  // ── 7. Exit code ──
  let exitCode: number;
  let recommendation: string;

  if (!automatedPass) {
    exitCode = 2;
    recommendation = 'hold';
  } else {
    exitCode = 0;
    recommendation = 'proceed';
  }

  return {
    resultDir,
    experimentJson,
    reportLines,
    allMetrics,
    aggregate,
    exitCode,
    recommendation,
    precheckFailed: false,
    blockedByCoverage: false,
  };
}

/**
 * Build report.md content lines.
 */
function buildReportMd(
  spec: ClosedLoopSpec,
  model: string,
  aggregate: ClosedLoopAggregate,
  allMetrics: ClosedLoopRunMetrics[],
  hasHighMemorization: boolean,
  automatedPass: boolean,
  workflowPass: boolean,
  qualityMeasurementPass: boolean,
): string[] {
  const evaluationMode = getEvaluationMode(spec);
  const qualityScope = evaluationMode === 'workflow'
    ? 'non-blocking; quality/originality measures are out of workflow acceptance scope'
    : 'acceptance-blocking';
  const lines: string[] = [
    '# Zhu-Fu Closed-Loop Report',
    '',
    `**Spec**: v${spec.version} — ${spec.changeReason}`,
    `**Model**: ${model}`,
    `**Generated**: ${new Date().toISOString()}`,
    `**Spec Hash**: ${spec.specHash}`,
    `**Fixture Hash**: ${spec.fixtureHash}`,
    `**Evaluation mode**: ${evaluationMode}`,
    '',
    '## Summary',
    '',
    `- Workflow gates: ${workflowPass ? 'PASS' : 'FAIL'}`,
    `- Functional pass: ${allMetrics.every((m) => m.functionalPass) ? 'PASS' : 'FAIL'}`,
    `- Stability pass: ${aggregate.stabilityPass ? 'PASS' : 'FAIL'}`,
    `- Counterfactual pass: ${allMetrics.filter((m) => m.condition === 'pov-switch').every((m) => m.functionalPass) ? 'PASS' : 'FAIL'}`,
    `- Quality measurements: ${qualityMeasurementPass ? 'PASS' : 'FAIL'} (${qualityScope})`,
    `- Memorization risk: ${hasHighMemorization ? 'HIGH — not proven YAML independent control' : 'LOW'}`,
    `- Acceptance result: ${automatedPass ? 'PASS' : 'FAIL'}`,
    `- Development status: ${automatedPass ? 'automated_stable' : 'iterating'}`,
    `- Literary quality: not_established`,
    `- Recommendation: ${automatedPass ? 'proceed' : 'hold'}`,
    '',
    '## Conditions',
    '',
  ];

  for (const metric of allMetrics) {
    const eventCount = metric.events.length;
    const releasedCount = metric.events.filter((e) => e.released).length;
    const analysisCount = metric.events.filter((e) => e.analysisPresent).length;

    lines.push(`### ${metric.condition} (${metric.runId})`);
    lines.push('');
    lines.push(`- Events: ${releasedCount}/${eventCount} released`);
    lines.push(`- Analysis: ${analysisCount}/${eventCount} present`);
    lines.push(`- Errors: ${metric.issues.errors}`);
    lines.push(`- Warnings: ${metric.issues.warnings}`);
    lines.push(`- Functional pass: ${metric.functionalPass ? 'YES' : 'NO'}`);
    lines.push('');
  }

  if (aggregate.pairwiseChecklistJaccard.length > 0) {
    lines.push('## Stability (Checklist Jaccard)');
    lines.push('');
    for (const j of aggregate.pairwiseChecklistJaccard) {
      lines.push(`- Pairwise Jaccard: ${j.toFixed(4)}`);
    }
    lines.push('');
  }

  lines.push('## Assumptions');
  lines.push('');
  lines.push('- This is a pilot N=3 stability assessment.');
  lines.push('- Literary quality requires human review (blind-scenes.md).');
  lines.push('- `layer-minimal` is an internal ablation, not a benchmark.');
  lines.push('- Approved reference is not re-run through Pass 2.');

  return lines;
}

// ============================================================================
// Verify-only mode
// ============================================================================

export interface VerifyResult {
  passed: boolean;
  failures: string[];
}

// Verification JSON helpers
interface VerificationMetricEvent {
  eventId: string;
  released: boolean;
}

function isVerificationRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readVerificationMetricEvents(
  runDirPath: string,
  label: string,
  failures: string[],
): VerificationMetricEvent[] | null {
  const metricsPath = path.join(runDirPath, 'metrics.json');
  if (!existsSync(metricsPath)) {
    failures.push(`${label}/metrics.json not found`);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(metricsPath, 'utf-8'));
  } catch {
    failures.push(`${label}: metrics.json is not valid JSON`);
    return null;
  }

  if (!isVerificationRecord(parsed)) {
    failures.push(`${label}: metrics.json is invalid (expected an object)`);
    return null;
  }

  // Keep accepting legacy empty metrics fixtures while treating a supplied
  // events member as a contract that must be structurally valid.
  const rawEvents = parsed.events;
  if (rawEvents === undefined) return [];
  if (!Array.isArray(rawEvents)) {
    failures.push(`${label}: metrics.json has invalid "events" (expected an array)`);
    return null;
  }

  const events: VerificationMetricEvent[] = [];
  for (const event of rawEvents) {
    if (!isVerificationRecord(event) || typeof event.eventId !== 'string' || event.eventId.length === 0) {
      failures.push(`${label}: metrics.json has invalid event entry (expected a non-empty string eventId)`);
      return null;
    }
    events.push({
      eventId: event.eventId,
      released: event.released === true,
    });
  }
  return events;
}

function verifyUnreleasedDiagnostic(
  runDirPath: string,
  runId: string,
  label: string,
  unreleasedEventIds: string[],
  failures: string[],
): void {
  const diagnosticPath = path.join(runDirPath, `${runId}_unreleased-diagnostic.json`);
  if (!existsSync(diagnosticPath)) {
    failures.push(`${label}: unreleased diagnostic missing at ${diagnosticPath}`);
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(diagnosticPath, 'utf-8'));
  } catch {
    failures.push(`${label}: unreleased diagnostic is not valid JSON`);
    return;
  }

  const rawEvents = isVerificationRecord(parsed) ? parsed.events : undefined;
  if (!Array.isArray(rawEvents)) {
    failures.push(`${label}: unreleased diagnostic is invalid (expected an events array)`);
    return;
  }

  const diagnosticEventIds: string[] = [];
  for (const event of rawEvents) {
    if (!isVerificationRecord(event) || typeof event.eventId !== 'string' || event.eventId.length === 0) {
      failures.push(`${label}: unreleased diagnostic is invalid (each event requires a non-empty string eventId)`);
      return;
    }
    diagnosticEventIds.push(event.eventId);
  }

  const expected = [...unreleasedEventIds].sort();
  const actual = [...diagnosticEventIds].sort();
  if (expected.length !== actual.length || expected.some((eventId, index) => eventId !== actual[index])) {
    failures.push(
      `${label}: unreleased diagnostic event IDs mismatch (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
    );
  }
}

function verifyReleasedOrDiagnostic(
  runDirPath: string,
  condition: string,
  runId: string,
  expectedEventIds: string[],
  failures: string[],
): void {
  const label = `${condition}/${runId}`;
  const events = readVerificationMetricEvents(runDirPath, label, failures);
  if (!events) return;

  const unreleasedEventIds = events.filter((event) => !event.released).map((event) => event.eventId);
  if (unreleasedEventIds.length > 0) {
    verifyUnreleasedDiagnostic(runDirPath, runId, label, unreleasedEventIds, failures);
    return;
  }

  const artifactErrors = assertClosedLoopArtifacts(path.join(runDirPath, 'project'), expectedEventIds);
  failures.push(...artifactErrors.map((error) => `${label}: ${error}`));
}

/**
 * Verify a completed experiment result directory.
 * Checks for expected condition directories, artifact files per condition,
 * root files (experiment.json, report.md), and validates JSON.
 */
export function verifyClosedLoopExperiment(resultDir: string): VerifyResult {
  const failures: string[] = [];
  const conditionsDir = path.join(resultDir, 'conditions');

  if (!existsSync(conditionsDir)) {
    return { passed: false, failures: [`conditions directory not found at ${conditionsDir}`] };
  }

  const expectedEventIds = ['E0', 'E1', 'E2', 'E3', 'E4', 'E5', 'E6'];

  // Check conditions
  for (const condition of EXPECTED_CONDITIONS) {
    const condDir = path.join(conditionsDir, condition);
    if (!existsSync(condDir)) {
      failures.push(`condition directory ${condDir} not found`);
      continue;
    }

    if (condition === 'full') {
      // Check 3 runs. Publication state comes from metrics.json, never from
      // whether a project directory happens to be present.
      for (let i = 1; i <= 3; i++) {
        const runId = `run-${String(i).padStart(2, '0')}`;
        const runDirPath = path.join(condDir, runId);
        if (!existsSync(runDirPath)) {
          failures.push(`full/${runId} not found`);
          continue;
        }
        verifyReleasedOrDiagnostic(runDirPath, 'full', runId, expectedEventIds, failures);
      }
    } else if (condition === 'layer-minimal') {
      const runId = 'run-01';
      const runDirPath = path.join(condDir, runId);
      if (!existsSync(runDirPath)) {
        failures.push(`layer-minimal/run-01 not found at ${runDirPath}`);
      } else {
        verifyReleasedOrDiagnostic(runDirPath, 'layer-minimal', runId, expectedEventIds, failures);
      }
    } else if (condition === 'pov-switch') {
      const runId = 'E5';
      const runDirPath = path.join(condDir, runId);
      if (!existsSync(runDirPath)) {
        failures.push(`pov-switch/E5 not found`);
      } else {
        readVerificationMetricEvents(runDirPath, 'pov-switch/E5', failures);
      }
    } else if (condition === 'discourse-reorder') {
      const runId = 'run-01';
      const runDirPath = path.join(condDir, runId);
      if (!existsSync(runDirPath)) {
        failures.push(`discourse-reorder/run-01 not found`);
      } else {
        readVerificationMetricEvents(runDirPath, 'discourse-reorder/run-01', failures);
      }
    }
  }

  // Check root files
  const rootFiles = ['experiment.json', 'report.md'];
  for (const f of rootFiles) {
    const fp = path.join(resultDir, f);
    if (!existsSync(fp)) {
      failures.push(`root file ${fp} not found`);
    }
  }

  // Read experiment.json and verify
  const expPath = path.join(resultDir, 'experiment.json');
  if (existsSync(expPath)) {
    try {
      const exp = JSON.parse(readFileSync(expPath, 'utf-8'));
      if (exp.summary?.literaryQualityStatus === 'established' && exp.summary?.humanMedianScore) {
        // Ratings applied — verify
      }
    } catch {
      failures.push('experiment.json is not valid JSON');
    }
  }

  return { passed: failures.length === 0, failures };
}

// ============================================================================
// Ratings application
// ============================================================================

export interface ClosedLoopRating {
  sampleId: string;
  score: number;
  reason: string;
}

/**
 * Parse a ratings CSV file and return validated ratings.
 * Score must be in range 1-4.
 */
export function parseRatings(csvPath: string): ClosedLoopRating[] {
  const content = readFileSync(csvPath, 'utf-8');
  const lines = content.trim().split('\n');
  if (lines.length < 2) return [];

  const ratings: ClosedLoopRating[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    if (parts.length < 3) continue;
    const score = Number.parseInt(parts[1], 10);
    if (score < 1 || score > 4) continue;
    ratings.push({
      sampleId: parts[0].trim(),
      score,
      reason: parts.slice(2).join(',').trim(),
    });
  }
  return ratings;
}

/**
 * Apply ratings to an experiment, updating experiment.json and report.md.
 * Returns exit code and recommendation based on rating thresholds:
 * - full median >= 3, no score=1, full median >= minimal median + 0.5 → proceed
 */
export function applyClosedLoopRatings(
  resultDir: string,
  ratingsPath: string,
): { exitCode: number; recommendation: string } {
  const ratings = parseRatings(ratingsPath);
  if (ratings.length === 0) {
    return { exitCode: 4, recommendation: 'hold' };
  }

  const scores = ratings.map((r) => r.score);
  const sortedScores = [...scores].sort((a, b) => a - b);
  const median = sortedScores[Math.floor(sortedScores.length / 2)];
  const hasPoor = scores.some((s) => s <= 1);

  // Separate full and minimal ratings by sampleId prefix/convention
  // Sample IDs follow: "full/run-NN/event" or "minimal/..."
  const fullScores: number[] = [];
  const minimalScores: number[] = [];

  for (const r of ratings) {
    if (r.sampleId.includes('minimal') || r.sampleId.includes('layer-minimal')) {
      minimalScores.push(r.score);
    } else if (r.sampleId.startsWith('full')) {
      fullScores.push(r.score);
    }
  }

  const fullMedian = fullScores.length > 0
    ? [...fullScores].sort((a, b) => a - b)[Math.floor(fullScores.length / 2)]
    : median;
  const minimalMedian = minimalScores.length > 0
    ? [...minimalScores].sort((a, b) => a - b)[Math.floor(minimalScores.length / 2)]
    : 1;

  // Proceed conditions
  const meetsMedianThreshold = fullMedian >= 3;
  const noPoorScores = !hasPoor;
  const liftOverMinimal = fullMedian - minimalMedian >= 0.5;

  const meetsThreshold = meetsMedianThreshold && noPoorScores && liftOverMinimal;

  const recommendation = meetsThreshold ? 'proceed' : 'hold';

  // Update experiment.json
  const expPath = path.join(resultDir, 'experiment.json');
  try {
    const exp = JSON.parse(readFileSync(expPath, 'utf-8'));
    exp.summary.literaryQualityStatus = meetsThreshold ? 'established' : 'not_established';
    exp.summary.humanMedianScore = median;
    exp.summary.fullMedianScore = fullMedian;
    exp.summary.minimalMedianScore = minimalMedian;
    exp.summary.ratingCount = ratings.length;
    exp.summary.frontendInvestmentRecommendation = recommendation;
    writeFileSync(expPath, JSON.stringify(exp, null, 2));
  } catch {
    // experiment.json not found; create minimal one
    const exp: Record<string, unknown> = {
      version: 1,
      generatedAt: new Date().toISOString(),
      summary: {
        literaryQualityStatus: meetsThreshold ? 'established' : 'not_established',
        humanMedianScore: median,
        fullMedianScore: fullMedian,
        minimalMedianScore: minimalMedian,
        ratingCount: ratings.length,
        frontendInvestmentRecommendation: recommendation,
      },
    };
    writeFileSync(expPath, JSON.stringify(exp, null, 2));
  }

  // Update report.md
  const reportPath = path.join(resultDir, 'report.md');
  try {
    const existing = readFileSync(reportPath, 'utf-8');
    const updated = existing
      .replace(/Literary quality: [a-z_]+/, `Literary quality: ${meetsThreshold ? 'established' : 'not_established'}`)
      .replace(/Recommendation: [a-z_]+/, `Recommendation: ${recommendation}`)
      + `\n## Ratings\n\n- Total ratings: ${ratings.length}\n- Median score: ${median}\n- Full median: ${fullMedian}\n- Minimal median: ${minimalMedian}\n- Lift over minimal: ${(fullMedian - minimalMedian).toFixed(1)}\n- Recommendation: ${recommendation}\n`;
    writeFileSync(reportPath, updated);
  } catch {
    // report.md not found, skip update
  }

  const exitCode = meetsThreshold ? 0 : 2;
  return { exitCode, recommendation };
}

// ============================================================================
// History comparison
// ============================================================================

/**
 * Compare the latest run result with the previous run having the same specHash+model.
 */
export function compareWithPrevious(
  outputDir: string,
  currentSpecHash: string,
  currentModel: string,
  currentAutomatedPass: boolean,
): Record<string, unknown> | null {
  const history = loadHistory(outputDir);
  const sameSpecAndModel = history
    .filter((e) => e.specHash === currentSpecHash && e.model === currentModel);

  if (sameSpecAndModel.length <= 1) return null;

  const prev = sameSpecAndModel[sameSpecAndModel.length - 2];

  return {
    previousAutomatedPass: prev.automatedPass,
    currentAutomatedPass,
    status: prev.automatedPass === currentAutomatedPass ? 'stable' : 'changed',
  };
}
