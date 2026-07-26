// STORAGE-2 AUDIT RESULTS (2026-07-22)
// ================================
// 1. api.ts — VIOLATION (fixes below): fs.existsSync, fs.readdirSync, fs.readFileSync, fs.mkdirSync
// 2. cli/index.ts — partial VIOLATION: fs ops in project init (acceptable for bootstrapping); needs storage param in API callers
// 3. entity/mapper.ts — Storage-backed: uses readYamlFile/readYamlFilesInDir (internally use Storage via yaml-loader)
// 4. assembler/novel.ts — Storage-backed: already uses Storage interface
// 5. pipeline/output.ts — Storage-backed: already uses Storage interface
// 6. reporter/validation-reporter.ts — VIOLATION (deferred): writeFileSync/mkdirSync from 'node:fs'
// 7. bench/reporters.ts — Storage-backed: uses FsStorage/Storage types
// ================================

// ============================================================================
// Novalistically Core — Orchestration Functions (Public API)
// ============================================================================
//
import type { RelationshipRuntimeState } from './types/index.js';
// pure-function-like API for CLIs, MCP servers, and external consumers.
// They are the recommended entry point for most use cases.
// ============================================================================

import * as crypto from 'node:crypto';
import * as path from 'node:path';

import { EntityMapper } from './entity/mapper.ts';
import type { ProjectData } from './entity/index.js';
import { InMemoryEntityRegistry } from './entity/registry.ts';
import { StateManager } from './state/manager.ts';
import { compileStoryBoundaries } from './state/story-boundaries.ts';
import { ContextCompiler } from './context/compiler.ts';
import { assembleNovel } from './assembler/novel.ts';
import { countNarrativeText } from './assembler/count.ts';
import { RenderPipeline, buildAndWriteOutputs, InteractionManager } from './pipeline/index.ts';
import type { RenderSceneResult, RenderJob, ProviderCallLedgerEntry } from './pipeline/render.ts';
import { BatchRenderPipeline } from './batch-renderer.ts';
import type { BatchConfig } from './batch-renderer.ts';
import type { SystemContext } from './types/context.js';
import { ResultAggregator } from './validator/aggregator.ts';
import { calculateISS } from './iss/score.ts';
import { FsStorage } from './storage/fs-storage.ts';
import type { Storage } from './storage/types.ts';
import type { LLMProvider } from './ai/types.ts';
import type { BranchPath } from './types/branch.js';
import { Logger, JsonlLogTransport, LevelFilterTransport } from './observability/logger.ts';
import { TraceCollector } from './observability/trace.ts';
import { TypedEventBus } from './event-bus.ts';
import { DEFAULT_CONFIG } from './config/index.js';
import { sanitizeError } from './errors.ts';
import { LogicalDisclosureSummaryCompiler, SurfaceReferenceExtractor } from './summary/index.ts';
import type {
  AnalysisResult,
  Entity,
  EventFile,
  Fact,
  ISSSnapshot,
  NarrativeEvent,
  ValidationResult,
  WorldState,
} from './types/index.ts';


// ============================================================================
// Module-level cache for initializeProject — API-1 / API-5
// ============================================================================

interface ProjectCacheEntry {
  hash: string;
  mapper: EntityMapper;
  data: ReturnType<EntityMapper['loadProject']>;
  events: NarrativeEvent[];
  registry: InMemoryEntityRegistry;
  stateManager: StateManager;
  state: WorldState;
}

const projectCache = new Map<string, ProjectCacheEntry>();

function computeProjectHash(projectDir: string, events: NarrativeEvent[], storage: Storage): string {
  const hasher = crypto.createHash('sha256');
  // Hash each definition YAML, config, and event YAML by content
  const defsDir = path.join(projectDir, 'definitions');
  if (storage.exists(defsDir)) {
    const defs = storage.listFiles(defsDir).sort();
    for (const f of defs) {
      if (f.endsWith('.yaml') || f.endsWith('.yml')) {
        hasher.update(storage.read(path.join(defsDir, f)));
      }
    }
  }
  const configPath = path.join(projectDir, 'nova.yaml');
  if (storage.exists(configPath)) {
    hasher.update(storage.read(configPath));
  }
  // Hash all event YAMLs by content (not just paths)
  for (const ev of events) {
    if (ev.id !== 'system:genesis') {
      const evPath = path.join(projectDir, 'events', `${ev.id}.yaml`);
      if (storage.exists(evPath)) {
        hasher.update(storage.read(evPath));
      }
    }
  }
  const hashObj = { projectDir, defsDir };
  return `${hasher.digest('hex')}:${crypto.createHash('sha256').update(JSON.stringify(hashObj)).digest('hex')}`;
}
// ============================================================================
// Type Definitions
// ============================================================================

export interface RenderNovelOptions {
  projectDir: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  eventId?: string;     // single event; omit or 'all' for all
  dryRun?: boolean;
  branchPath?: BranchPath;
  provider?: LLMProvider;
  storage?: Storage;
  /** Opt-in trace output to .nova/traces/<jobId>.jsonl */
  trace?: boolean;
  /** Optional batch config for sliding-window batch rendering. */
  batch?: BatchConfig;
  /** Circuit breaker max rounds (default 3, smoke=1) */
  maxRounds?: number;
  /** Max concurrent LLM calls (default from config) */
  concurrency?: number;
  /**
   * Optional InteractionManager for approving waiver-eligible results.
   * When provided, warning-level (C) validation failures can be waived;
   * error-level (S/X) failures remain blocking.
   */
  interactionManager?: InteractionManager;
  /** Optional event bus for live render-progress observation */
  eventBus?: TypedEventBus;
}

export interface RenderNovelResult {
  results: Array<{
    eventId: string;
    prose: string;
    wordCount: number;
    cacheHit: boolean;
    errors: string[];
    released: boolean;
    validationErrors: number;
    validationIssueMessages: string[];
    analysis: AnalysisResult | null;
    /** Provider call ledger — per-call record for live smoke auditing. */
    providerCalls: ProviderCallLedgerEntry[];
    /** Aggregate SHA-256 of ordered provider-call identities */
    promptHash: string;
    /** Pass2 rejection category when analysis is null (empty/parse/validation) */
    pass2Rejection?: string;
  }>;
  errors: string[];
}

export interface ProjectStatusResult {
  events: Array<{
    id: string;
    narrativeOrder: number;
    status: 'rendered' | 'pending' | 'blocked';
    chapter: number;
    wordCount?: number;
  }>;
  threads: Array<{ id: string; progress: number; total: number }>;
  summary: { totalEvents: number; renderedCount: number; blockedCount: number };
}

export interface DiffResult {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  changed: string[];
}

/** Impact level for a single event in impact analysis */
export type ImpactLevel = 'green' | 'yellow' | 'red';

/** Result of comparing two project versions */
export interface ImpactAnalysisResult {
  events: Record<string, ImpactLevel>;
  downstream: Record<string, string[]>;
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Build the initial state from genesis event data (post-
 * conditions + entity registry).
 */
function buildInitialState(
  events: NarrativeEvent[],
  registry: InMemoryEntityRegistry,
  data: ProjectData,
): { initialFacts: Fact[]; authoredEvents: NarrativeEvent[]; initialThreads: Array<{ id: string }> } {
  const genesis = events.find((event) => event.id === 'system:genesis');
  const initialFacts: Fact[] = [
    ...(genesis?.postconditions ?? []),
    ...registry.getAll().flatMap((entity) => Object.entries(entity.state ?? {}).map(([attribute, value]) => ({
      id: `${entity.id}.${attribute}`,
      entityId: entity.id,
      attribute,
      value,
      validity: { temporal: { start: { type: 'absolute' as const, value: 'day_0' }, end: null }, branches: { type: 'all' as const } },
    }))),
  ];
  const initialThreads = (data.worldInitialState?.threads ?? []).map((t: { id: string }) => ({ id: t.id }));
  const authoredEvents = events.filter((event) => event.id !== 'system:genesis');
  return { initialFacts, authoredEvents, initialThreads };
}

/**
 * Load a project's mapper, data, events, registry, and state manager.
 * This is the common initialization sequence used by most functions.
 */
export function initializeProject(projectDir: string, storage?: Storage): {
  mapper: EntityMapper;
  data: ReturnType<EntityMapper['loadProject']>;
  events: NarrativeEvent[];
  registry: InMemoryEntityRegistry;
  stateManager: StateManager;
  state: WorldState;
} {
  // Load events first for hash computation
  const mapper = new EntityMapper(projectDir);
  const data = mapper.loadProject();
  const events = mapper.loadAllEvents(data.chapters);
  const hash = computeProjectHash(projectDir, events, storage ?? new FsStorage());

  const cached = projectCache.get(projectDir);
  if (cached && cached.hash === hash) {
    return { mapper: cached.mapper, data: cached.data, events: cached.events, registry: cached.registry, stateManager: cached.stateManager, state: cached.state };
  }

  const registry = new InMemoryEntityRegistry();
  registry.load(projectDir);
  const stateManager = new StateManager(path.join(projectDir, data.config?.outputDir ?? DEFAULT_CONFIG.outputDir, 'snapshots'));
  stateManager.initialize(events);
  const state: WorldState = {
    entities: {},
    relationships: {},
    knowledge: {},
    threads: {},
    rules: {},
    facts: [],
  };

  const entry: ProjectCacheEntry = {
    hash,
    mapper,
    data,
    events,
    registry,
    stateManager,
    state,
  };
  projectCache.set(projectDir, entry);

  return { mapper, data, events, registry, stateManager, state };
}

/**
 * Build the eventsFileMap needed for RenderPipeline cache initialization.
 */
function buildEventsFileMap(
  data: ReturnType<EntityMapper['loadProject']>,
): Map<string, { narrativeOrder: number; filePath: string; chapter: number }> {
  const eventsFileMap = new Map<string, { narrativeOrder: number; filePath: string; chapter: number }>();
  for (const [ch, chapter] of data.chapters) {
    for (const evFile of chapter.events) {
      eventsFileMap.set(evFile.event, {
        narrativeOrder: evFile.narrativeOrder,
        filePath: evFile.filePath ?? '',
        chapter: ch,
      });
    }
  }
  return eventsFileMap;
}

/**
 * Find which chapter an event belongs to.
 */
function findChapterForEvent(
  data: ReturnType<EntityMapper['loadProject']>,
  eventId: string,
): number {
  for (const [ch, chapter] of data.chapters) {
    if (chapter.events.some((e) => e.event === eventId)) return ch;
  }
  return 1;
}

/**
 * Build a release-gate diagnostic message for a single scene result.
 * The message includes the event ID and a sanitized, stable reason —
 * never raw provider error secrets.
 *
 * @param result - The scene render result to diagnose.
 * @returns A diagnostic string in the form "eventId: sanitized-reason".
 */
export function buildReleaseDiagnostic(result: RenderSceneResult): string {
  let reason: string;

  if (result.validation && result.validation.errors.length > 0) {
    reason = result.validation.errors.map((issue) => issue.message).join(' | ');
  } else if (result.errors.length > 0) {
    reason = result.errors.join(' | ');
  } else if (result.analysis === null) {
    reason = 'missing analysis output';
  } else if (result.prose.trim().length === 0) {
    reason = 'empty prose';
  } else if (result.needsReview) {
    reason = 'exhausted retries — needs review';
  } else {
    reason = 'release requirements unmet';
  }

  return `${result.eventId}: ${sanitizeError(reason)}`;
}

/**
 * Create an LLM provider using AiSdkProvider (Vercel AI SDK).
 * Reads apiKey and baseUrl from parameters or environment variables.
 */
async function createProvider(
  apiKey: string,
  baseUrl: string | undefined,
  model: string,
): Promise<LLMProvider> {
  const { AiSdkProvider } = await import('./ai/providers/ai-sdk.ts');
  return new AiSdkProvider({ apiKey, baseURL: baseUrl, model });
}

// ============================================================================
// 1. renderNovel — Full LLM rendering pipeline
// ============================================================================

/**
 * Orchestrate the full render pipeline for one or all events.
 *
 * Internally: EntityMapper.loadProject → loadAllEvents → InMemoryEntityRegistry.load
 * → StateManager.commit (loop) → ContextCompiler.compile (per event) → create LLM provider
 * → RenderPipeline → buildAndWriteOutputs.
 *
 * For dryRun: compile context, save to `.nova/dry-runs/{eventId}_prompt.md`,
 * return with prose empty.
 */
export async function renderNovel(opts: RenderNovelOptions): Promise<RenderNovelResult> {
  const { projectDir, model, apiKey, baseUrl, eventId, dryRun, provider: injectedProvider, branchPath, trace, eventBus } = opts;
  const errors: string[] = [];
  const waivedEventIds = new Set<string>();

  const storage = opts.storage ?? new FsStorage();
  // Observability: trace collector for this render session
  const traceCollector = trace ? new TraceCollector(eventId ?? 'render-all') : undefined;
  const eventLogger = new Logger(
    trace ? undefined : new LevelFilterTransport(new JsonlLogTransport()),
    { module: 'render' },
  );

  const { data, events, registry } = initializeProject(projectDir);
  const { initialFacts, authoredEvents, initialThreads } = buildInitialState(events, registry, data);
  const anchors = new Map(data.timeAnchors.map((anchor) => [anchor.id, anchor.day]));
  const boundaries = compileStoryBoundaries(authoredEvents, initialFacts, anchors, branchPath, initialThreads);
  const renderEvents = (!eventId || eventId === 'all'
    ? authoredEvents
    : authoredEvents.filter((event) => event.id === eventId))
    .filter((event) => boundaries.stateBeforeByEventId.has(event.id));
  if (renderEvents.length === 0) {
    errors.push(`No events found to render${eventId ? ` for eventId "${eventId}"` : ''}`);
    return { results: [], errors };
  }

  const sysCtx: SystemContext = {
    genre: data.config?.genre ?? 'literary',
    style: 'literary',
    narrativeRules: [],
    thematicIntent: data.config?.ideaIR?.thematicIntent,
  };

  // ── Dry run ───────────────────────────────────────────────────────
  if (dryRun) {
    const results: RenderNovelResult['results'] = [];
    const dryRunDir = path.join(projectDir, data.config?.outputDir ?? DEFAULT_CONFIG.outputDir, 'dry-runs');
    storage.mkdirp(dryRunDir);

    for (const ev of renderEvents) {
      const beforeState = boundaries.stateBeforeByEventId.get(ev.id)!;
      const compiler = new ContextCompiler();
      compiler.compile(ev, beforeState, registry, { systemContext: sysCtx, narratorProfiles: data.narratorProfiles, discourseLedger: data.discourseLedger });

      results.push({
        eventId: ev.id,
        prose: '',
        wordCount: 0,
        cacheHit: false,
        released: false,
        validationErrors: 0,
        validationIssueMessages: [],
        errors: [],
        analysis: null,
        providerCalls: [],
        promptHash: '',
      });
    }

    return { results, errors: [] };
  }
  // ── Full rendering ────────────────────────────────────────────────
  const resolvedModel = model ?? data.config?.defaultModel ?? process.env['NOVALISTICALLY_AI_MODEL'];
  if (!resolvedModel) {
    errors.push('No model configured. Set --model, nova.yaml "defaultModel", or the NOVALISTICALLY_AI_MODEL environment variable.');
    return { results: [], errors };
  }
  let provider: LLMProvider;
  if (injectedProvider) {
    provider = injectedProvider;
  } else {
    const resolvedApiKey = apiKey ?? process.env['NOVALISTICALLY_AI_API_KEY'] ?? '';
    if (!resolvedApiKey) {
      errors.push('No API key provided. Set NOVALISTICALLY_AI_API_KEY environment variable or pass apiKey option.');
      return { results: [], errors };
    }
    const resolvedBaseUrl = baseUrl ?? process.env['NOVALISTICALLY_AI_BASE_URL'] ?? undefined;
    try {
      provider = await createProvider(resolvedApiKey, resolvedBaseUrl, resolvedModel);
    } catch (err) {
      errors.push(`Failed to create LLM provider: ${(err as Error).message}`);
      return { results: [], errors };
    }
  }
  const cacheDir = path.join(projectDir, data.config?.outputDir ?? DEFAULT_CONFIG.outputDir, 'render-cache');
  const pipeline = new RenderPipeline({
    provider,
    model: resolvedModel,
    cacheDir,
    storage,
    aggregator: new ResultAggregator(undefined, undefined, undefined, traceCollector),
    logger: eventLogger,
    traceCollector,
    eventBus,
    maxRounds: opts.maxRounds,
    concurrency: opts.concurrency,
    language: data.config?.defaultLanguage ?? 'en',
  });

  // Initialize cache
  const eventsFileMap = buildEventsFileMap(data);
  await pipeline.initCache(eventsFileMap, path.join(projectDir, 'definitions'));
  // Build render jobs
  const jobs: RenderJob[] = [];
  const disclosureCompiler = new LogicalDisclosureSummaryCompiler();
  const surfaceExtractor = new SurfaceReferenceExtractor();
  let previousSummary: string | undefined;
  for (const ev of renderEvents) {
    const chapterNum = findChapterForEvent(data, ev.id);
    const beforeState = boundaries.stateBeforeByEventId.get(ev.id)!;
    const compiler = new ContextCompiler();
    const ctxStart = Date.now();
    traceCollector?.record({ phase: 'context', state: 'start', spanId: ev.id, eventId: ev.id });

    // Compute disclosure-safe summary for prior discoure context
    // Full DiscourseState wiring requires the planned discourse ledger, which
    // is loaded once the discourse system is fully integrated. For now the
    // summarizer is available and ready — wire it with compile options.
    const pkg = compiler.compile(ev, beforeState, registry, {
      systemContext: sysCtx,
      previousSceneSummary: previousSummary ?? '',
      narratorProfiles: data.narratorProfiles,
      discourseLedger: data.discourseLedger,
    });
    // After rendering this scene, the surface extractor can produce a
    // reference packet from the accepted prose. Stash the summary for the
    // next scene.
    previousSummary = pkg.markdown.includes('## Previous Scene Summary')
      ? pkg.previousSceneSummary
      : undefined;
    traceCollector?.record({ phase: 'context', state: 'end', spanId: ev.id, eventId: ev.id, durationMs: Date.now() - ctxStart });
    jobs.push({
      event: ev,
      stateBefore: beforeState,
      context: pkg,
      chapter: chapterNum,
      logicalDisclosureSummary: pkg.previousSceneSummary || undefined,
    });
  }
  // Render — choose batched or bulk mode, preserving results even on exception
  let results: RenderSceneResult[] = [];
  try {
    results = opts.batch
      ? (await new BatchRenderPipeline(pipeline).renderBatched(jobs, opts.batch)).results
      : await pipeline.renderAll(jobs);
    const unreleased = results.filter((result) => result.prose.trim().length === 0 || result.analysis === null || result.validation === null || !result.validation.passed || result.needsReview);
    if (unreleased.length > 0) {
      const interactionManager = opts.interactionManager;
      if (interactionManager) {
        // With InteractionManager: separate waivable (warning-only, C) from blocking (errors, S/X)
        const blocking: RenderSceneResult[] = [];
        const waived: string[] = [];
        for (const result of unreleased) {
          // Empty prose or missing analysis are always blocking
          if (result.prose.trim().length === 0 || result.analysis === null) {
            blocking.push(result);
            continue;
          }
          // Check for error-level (S/X) issues — cannot waive
          const hasErrors = result.validation?.errors.some(issue => issue.severity === 'error');
          if (hasErrors) {
            blocking.push(result);
            continue;
          }
          // Warning-only (C) findings: check if a waiver exists
          // Gate is only needed when there are actual warnings
          if (result.validation && result.validation.warnings.length > 0) {
            const gateId = `gate:${result.eventId}:validation`;
            if (!interactionManager.needsApproval(gateId, 'warning')) {
              // Gate is already waived — release
              waived.push(result.eventId);
            } else {
              // Gate is pending — cannot release without waiver
              blocking.push(result);
            }
          } else {
            // No warning issues but needsReview is true (shouldn't happen in practice)
            blocking.push(result);
          }
        }
        if (blocking.length > 0) {
          const diagnostics = blocking.map(buildReleaseDiagnostic);
          errors.push(`Release gate rejected (blocking): ${diagnostics.join('; ')}`);
        }
        if (waived.length > 0 || blocking.length === 0) {
          const releasable = results.filter(r => !blocking.some(b => b.eventId === r.eventId));
          if (releasable.length > 0) {
            buildAndWriteOutputs(storage, projectDir, jobs, releasable);
          }
        }
        // Track waived event IDs for the released field below
        for (const id of waived) waivedEventIds.add(id);
      } else {
        // No InteractionManager — original strict behavior
        const diagnostics = unreleased.map(buildReleaseDiagnostic);
        errors.push(`Release gate rejected: ${diagnostics.join('; ')}`);
      }
    } else {
      buildAndWriteOutputs(storage, projectDir, jobs, results);
      if (renderEvents.length === authoredEvents.length) {
        const assembled = assembleNovel({ projectDir, storage, branchPath, language: data.config?.defaultLanguage ?? 'en' });
        const sceneTextCount = results.reduce((total, result) => total + countNarrativeText(result.prose, data.config?.defaultLanguage ?? 'en'), 0);
        if (assembled.wordCount !== sceneTextCount) {
          throw new Error(`Assembly text count mismatch: scenes=${sceneTextCount}, novel=${assembled.wordCount}`);
        }
      }
    }
  } catch (err) {
    errors.push(sanitizeError(err));
    // results already populated from renderAll if it succeeded;
    // if renderAll threw, results is still [] — no output writes.
  }
  // Record output spans (only for events that were rendered)
  for (const result of results) {
    traceCollector?.record({ phase: 'output', state: 'end', spanId: result.eventId, eventId: result.eventId, durationMs: result.renderEnd - result.renderStart });
  }
  // Write trace file (opt-in, errors must not affect release eligibility)
  if (traceCollector) {
    try {
      traceCollector.write(storage, projectDir);
    } catch {
      // trace write errors silently ignored
    }
  }

  // Map to return type
  const mappedResults = results.map((r) => ({
    eventId: r.eventId,
    prose: r.prose,
    wordCount: countNarrativeText(r.prose, data.config?.defaultLanguage ?? 'en'),
    cacheHit: r.cacheHit,
    errors: r.errors,
    analysis: r.analysis,
    released: waivedEventIds.has(r.eventId) || (r.prose.trim().length > 0 && r.analysis !== null && r.validation !== null && r.validation.passed && !r.needsReview),
    validationErrors: r.validation?.errors.length ?? 0,
    validationIssueMessages: r.validation?.errors.map((issue) => issue.message) ?? [],
    providerCalls: r.providerCalls,
    promptHash: r.promptHash,
    pass2Rejection: r.pass2Rejection,
  }));
  return { results: mappedResults, errors };
}

// ============================================================================
// 2. validateNovel — Run all validators + ISS
// ============================================================================

/**
 * Run all 18 validators against the project and calculate ISS.
 *
 * Internally: EntityMapper → InMemoryEntityRegistry → StateManager
 * → ResultAggregator → calculateISS.
 */
export function validateNovel(
  projectDir: string,
  overrides?: Record<string, 'off' | 'warning' | 'error'>,
): {
  passed: boolean;
  results: Map<string, ValidationResult>;
  iss: ISSSnapshot;
} {
  const { data, events, registry } = initializeProject(projectDir);

  // Compile story boundaries for per-event pre-state
  const { initialFacts, authoredEvents, initialThreads } = buildInitialState(events, registry, data);
  const anchors = new Map((data.timeAnchors ?? []).map((anchor) => [anchor.id, anchor.day]));
  const boundaries = compileStoryBoundaries(authoredEvents, initialFacts, anchors, undefined, initialThreads);

  // Run validators with per-event pre-state
  const aggregator = new ResultAggregator();
  const mergedOverrides = overrides ?? data.config?.validatorOverrides;
  const validationResults = aggregator.validateAll(events, boundaries.finalState, registry, mergedOverrides, boundaries.stateBeforeByEventId);

  // Determine overall pass/fail
  let passed = true;
  for (const [, result] of validationResults) {
    if (!result.passed) {
      passed = false;
      break;
    }
  }

  // ISS calculation
  const threads = data.worldInitialState?.threads ?? [];
  const iss = calculateISS({
    projectDir,
    entityRegistry: registry,
    events,
    threads: threads.map((t) => ({ id: t.id, name: t.name })),
    rules: data.rules,
  });

  return { passed, results: validationResults, iss };
}

// ============================================================================
// 3. getProjectStatus — Status of events, threads, and render progress
// ============================================================================
/**
 * Get the current project status.
 *
 * Reads scenes/ to check which events have rendered output.
 * Checks preconditions to determine blocked status.
 *
 * @param validationResults - Optional pre-computed validation results.
 *   When provided, skips the internal validateAll call.
 */
export function getProjectStatus(
  projectDir: string,
  validationResults?: Map<string, ValidationResult>,
  storage?: Storage,
): ProjectStatusResult {
  const resolvedStorage = storage ?? new FsStorage();
  const { data, events, registry } = initializeProject(projectDir, resolvedStorage);

  // Determine rendered events by checking scenes/ directory for .md files
  const renderedSet = new Set<string>();
  const scenesDir = path.join(projectDir, 'scenes');
  if (resolvedStorage.exists(scenesDir)) {
    const sceneDirs = resolvedStorage.list(scenesDir);
    for (const dir of sceneDirs) {
      if (!dir.isDirectory()) continue;
      const dirPath = path.join(scenesDir, dir.name);
      const mdFiles = resolvedStorage.listFiles(dirPath).filter((f) => f.endsWith('.md'));
      for (const mf of mdFiles) {
        const evId = mf.replace('.md', '');
        renderedSet.add(evId);
      }
    }
  }

  // Compile story boundaries for per-event pre-state validation
  const { initialFacts, authoredEvents, initialThreads } = buildInitialState(events, registry, data);
  const anchors = new Map((data.timeAnchors ?? []).map((anchor) => [anchor.id, anchor.day]));
  const boundaries = compileStoryBoundaries(authoredEvents, initialFacts, anchors, undefined, initialThreads);

  // Use provided validation results or run validateAll
  if (!validationResults) {
    const aggregator = new ResultAggregator();
    const overrides = data.config?.validatorOverrides;
    validationResults = aggregator.validateAll(events, boundaries.finalState, registry, overrides, boundaries.stateBeforeByEventId);
  }

  const eventStatuses: ProjectStatusResult['events'] = [];

  for (const event of events) {
    if (event.id === 'system:genesis') continue;

    const chapterNum = findChapterForEvent(data, event.id);

    let status: 'rendered' | 'pending' | 'blocked';
    let wordCount: number | undefined;

    if (renderedSet.has(event.id)) {
      status = 'rendered';
      // Try to read word count from scene metadata yaml
      const sceneMetaPath = path.join(
        scenesDir,
        `chapter-${String(chapterNum).padStart(2, '0')}`,
        `${event.id}.yaml`,
      );
      if (resolvedStorage.exists(sceneMetaPath)) {
        try {
          const metaContent = resolvedStorage.read(sceneMetaPath);
          const wcMatch = metaContent.match(/word_count:\s*(\d+)/);
          if (wcMatch) wordCount = parseInt(wcMatch[1], 10);
        } catch {
          // silent
        }
      }
    } else {
      const eventResult = validationResults.get(event.id);
      if (eventResult && !eventResult.passed) {
        status = 'blocked';
      } else {
        status = 'pending';
      }
    }

    eventStatuses.push({
      id: event.id,
      narrativeOrder: event.narrativeOrder,
      status,
      chapter: chapterNum,
      wordCount,
    });
  }

  const threads: ProjectStatusResult['threads'] = [];
  for (const [threadId, threadData] of Object.entries(boundaries.finalState.threads)) {
    const goalEntries = Object.values(threadData.goalStates);
    threads.push({
      id: threadId,
      progress: goalEntries.filter((s) => s === 'achieved').length,
      total: goalEntries.length,
    });
  }

  const renderedCount = eventStatuses.filter((e) => e.status === 'rendered').length;
  const blockedCount = eventStatuses.filter((e) => e.status === 'blocked').length;

  return {
    events: eventStatuses,
    threads,
    summary: {
      totalEvents: eventStatuses.length,
      renderedCount,
      blockedCount,
    },
  };
}

// ============================================================================
// 4. diffEvent — Show state changes for an event
// ============================================================================

/**
 * Show the world state before and after a specific event.
 *
 * Uses compileStoryBoundaries for DAG-ordered state with time anchors.
 */
export function diffEvent(
  projectDir: string,
  eventId: string,
): DiffResult | null {
  const { events, registry, data } = initializeProject(projectDir);

  const targetEvent = events.find((e) => e.id === eventId);
  if (!targetEvent) return null;

  const { initialFacts, authoredEvents, initialThreads } = buildInitialState(events, registry, data);
  const anchors = new Map((data.timeAnchors ?? []).map((a) => [a.id, a.day]));
  const boundaries = compileStoryBoundaries(authoredEvents, initialFacts, anchors, undefined, initialThreads);

  const orderedIds = boundaries.orderedEventIds;
  const targetIndex = orderedIds.indexOf(eventId);
  if (targetIndex === -1) return null;

  // Before state: state before the target event in causal order
  const beforeState = boundaries.stateBeforeByEventId.get(eventId) ?? { entities: {}, relationships: {}, knowledge: {}, threads: {}, rules: {}, facts: [] };

  // After state: replay including the target event
  const afterState = targetIndex === orderedIds.length - 1
    ? boundaries.finalState
    : boundaries.stateBeforeByEventId.get(orderedIds[targetIndex + 1]) ?? boundaries.finalState;

  // Build human-readable diffs
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const changed: string[] = [];

  // Entity state changes
  const allEntityIds = new Set([
    ...Object.keys(beforeState.entities),
    ...Object.keys(afterState.entities),
  ]);
  for (const entityId of allEntityIds) {
    const beforeEntity = beforeState.entities[entityId];
    const afterEntity = afterState.entities[entityId];

    if (!beforeEntity && afterEntity) {
      // Entity created
      before[`entity:${entityId}`] = null;
      after[`entity:${entityId}`] = afterEntity;
      changed.push(`entity:${entityId}`);
    } else if (beforeEntity && !afterEntity) {
      // Entity removed
      before[`entity:${entityId}`] = beforeEntity;
      after[`entity:${entityId}`] = null;
      changed.push(`entity:${entityId}`);
    } else if (beforeEntity && afterEntity) {
      const allAttrs = new Set([...Object.keys(beforeEntity), ...Object.keys(afterEntity)]);
      for (const attr of allAttrs) {
        const bv = beforeEntity[attr];
        const av = afterEntity[attr];
        if (JSON.stringify(bv) !== JSON.stringify(av)) {
          before[`entity:${entityId}.${attr}`] = bv;
          after[`entity:${entityId}.${attr}`] = av;
          changed.push(`entity:${entityId}.${attr}`);
        }
      }
    }
  }

  // Thread changes
  const allThreadIds = new Set([
    ...Object.keys(beforeState.threads),
    ...Object.keys(afterState.threads),
  ]);
  for (const threadId of allThreadIds) {
    const bt = beforeState.threads[threadId];
    const at = afterState.threads[threadId];
    if (JSON.stringify(bt) !== JSON.stringify(at)) {
      before[`thread:${threadId}`] = bt ?? null;
      after[`thread:${threadId}`] = at ?? null;
      changed.push(`thread:${threadId}`);
    }
  }

  // Relationship changes
  const allRelIds = new Set([
    ...Object.keys(beforeState.relationships),
    ...Object.keys(afterState.relationships),
  ]);
  for (const relId of allRelIds) {
    const br = (beforeState.relationships as Record<string, unknown>)[relId] as RelationshipRuntimeState | undefined;
    const ar = (afterState.relationships as Record<string, unknown>)[relId] as RelationshipRuntimeState | undefined;
    if (JSON.stringify(br) !== JSON.stringify(ar)) {
      before[`relationship:${relId}`] = br ?? null;
      after[`relationship:${relId}`] = ar ?? null;
      changed.push(`relationship:${relId}`);
    }
  }

  return { before, after, changed };
}

// ============================================================================
// 5. listEntities — List all entities (optionally filtered by kind)
// ============================================================================

/**
 * List all entities in the project, optionally filtered by kind.
 *
 * EntityMapper → InMemoryEntityRegistry → getAll() or findByKind(kind).
 */
export function listEntities(
  projectDir: string,
  kind?: string,
): Array<{ id: string; kind: string; name?: string }> {
  const mapper = new EntityMapper(projectDir);
  mapper.loadProject(); // validates project exists

  const registry = new InMemoryEntityRegistry();
  registry.load(projectDir);

  const entities: Entity[] = kind
    ? registry.findByKind(kind as any)
    : registry.getAll();

  return entities.map((e) => ({
    id: e.id,
    kind: e.kind,
    name: e.name,
  }));
}

// ============================================================================
// 6. showEntity — Show detailed info for a specific entity
// ============================================================================

/**
 * Get detailed information about a specific entity.
 *
 * EntityMapper → InMemoryEntityRegistry → resolve(entityId).
 */
export function showEntity(
  projectDir: string,
  entityId: string,
): Record<string, unknown> | null {
  const mapper = new EntityMapper(projectDir);
  mapper.loadProject(); // validates project exists

  const registry = new InMemoryEntityRegistry();
  registry.load(projectDir);

  const entity = registry.resolve(entityId);
  if (!entity) return null;

  return {
    id: entity.id,
    kind: entity.kind,
    name: entity.name,
    definitionFile: entity.definitionFile,
    state: entity.state,
  };
}

// ============================================================================
// 7. analyzeProjectImpact — Compare two project versions
// ============================================================================

/**
 * Compare two project versions and classify each event's impact level.
 *
 * Loads both project YAML directories, compares event definitions, and
 * classifies changes:
 * - Green: only narrativeOrder changed (no downstream effect)
 * - Yellow: event data changed but preconditions/postconditions intact
 * - Red: precondition/postcondition changed → causal chain potentially broken
 *
 * Also detects downstream events: when a Red event has changed postconditions,
 * any event whose preconditions reference the same entity+attribute pairs is
 * flagged as downstream.
 *
 * @param oldPath - Path to the original project directory
 * @param newPath - Path to the modified project directory
 * @returns Impact analysis result with per-event levels and downstream map
 */
export function analyzeProjectImpact(
  oldPath: string,
  newPath: string,
): ImpactAnalysisResult {
  const oldMapper = new EntityMapper(oldPath);
  const newMapper = new EntityMapper(newPath);
  const oldData = oldMapper.loadProject();
  const newData = newMapper.loadProject();

  // Build event map (event ID → EventFile) for both versions
  const oldEvents = new Map<string, EventFile>();
  for (const [, chapter] of oldData.chapters) {
    for (const ev of chapter.events) {
      oldEvents.set(ev.event, ev);
    }
  }

  const newEvents = new Map<string, EventFile>();
  for (const [, chapter] of newData.chapters) {
    for (const ev of chapter.events) {
      newEvents.set(ev.event, ev);
    }
  }

  // Helper: serialize a precondition or postcondition for comparison
  const pcKey = (pc: { entity: string; attribute: string; value: unknown; operator?: string }): string =>
    `${pc.entity}:${pc.attribute}:${JSON.stringify(pc.value)}:${pc.operator ?? 'eq'}`;

  const events: Record<string, ImpactLevel> = {};
  const downstream: Record<string, string[]> = {};

  // Collect which (entityId, attribute) pairs each event's postconditions write to
  const postconditionPairs = new Map<string, Set<string>>();
  for (const [id, ev] of newEvents) {
    const pairs = new Set<string>();
    for (const pc of ev.expectedPostconditions) {
      pairs.add(`${pc.entity}:${pc.attribute}`);
    }
    postconditionPairs.set(id, pairs);
  }

  // Collect which (entityId, attribute) pairs each event's preconditions read
  const preconditionPairs = new Map<string, Set<string>>();
  for (const [id, ev] of newEvents) {
    const pairs = new Set<string>();
    for (const pc of ev.preconditions) {
      pairs.add(`${pc.entity}:${pc.attribute}`);
    }
    preconditionPairs.set(id, pairs);
  }

  // Compare events present in both versions
  const allIds = new Set([...oldEvents.keys(), ...newEvents.keys()]);
  const newOnlyIds = new Set<string>();

  for (const id of allIds) {
    const oldEv = oldEvents.get(id);
    const newEv = newEvents.get(id);

    if (!oldEv && newEv) {
      // New event added
      events[id] = 'red';
      newOnlyIds.add(id);
      continue;
    }
    if (oldEv && !newEv) {
      // Event removed
      events[id] = 'red';
      continue;
    }
    if (!oldEv || !newEv) continue;

    // Compare preconditions
    const oldPreKeys = new Set(oldEv.preconditions.map(pcKey));
    const newPreKeys = new Set(newEv.preconditions.map(pcKey));
    const preChanged =
      oldPreKeys.size !== newPreKeys.size ||
      [...oldPreKeys].some((k) => !newPreKeys.has(k));

    // Compare postconditions
    const oldPostKeys = new Set(oldEv.expectedPostconditions.map(pcKey));
    const newPostKeys = new Set(newEv.expectedPostconditions.map(pcKey));
    const postChanged =
      oldPostKeys.size !== newPostKeys.size ||
      [...oldPostKeys].some((k) => !newPostKeys.has(k));

    if (preChanged || postChanged) {
      events[id] = 'red';
      continue;
    }

    // Check for other event data changes (excluding narrativeOrder)
    const dataChanged =
      oldEv.title !== newEv.title ||
      oldEv.sceneBrief !== newEv.sceneBrief ||
      oldEv.storyTime !== newEv.storyTime ||
      oldEv.narrationTime !== newEv.narrationTime ||
      oldEv.sceneType !== newEv.sceneType ||
      oldEv.discourseMode !== newEv.discourseMode ||
      oldEv.arcPosition !== newEv.arcPosition ||
      oldEv.emotionalValence !== newEv.emotionalValence ||
      oldEv.conflictType !== newEv.conflictType ||
      oldEv.resolutionType !== newEv.resolutionType ||
      oldEv.tense !== newEv.tense ||
      JSON.stringify(oldEv.pov) !== JSON.stringify(newEv.pov) ||
      JSON.stringify(oldEv.threadProgress) !== JSON.stringify(newEv.threadProgress) ||
      JSON.stringify(oldEv.foreshadowing) !== JSON.stringify(newEv.foreshadowing) ||
      JSON.stringify(oldEv.relationshipEffects) !== JSON.stringify(newEv.relationshipEffects) ||
      JSON.stringify(oldEv.ruleEffects) !== JSON.stringify(newEv.ruleEffects) ||
      JSON.stringify(oldEv.styleGuidance) !== JSON.stringify(newEv.styleGuidance) ||
      JSON.stringify(oldEv.cast) !== JSON.stringify(newEv.cast);

    if (dataChanged) {
      events[id] = 'yellow';
      continue;
    }

    // Only narrativeOrder changed (or nothing at all)
    if (oldEv.narrativeOrder !== newEv.narrativeOrder) {
      events[id] = 'green';
    }
    // else: no changes — leave unset
  }

  // Downstream detection: for each Red event, find events whose preconditions
  // reference entity+attribute pairs that this event's postconditions set
  for (const [id, level] of Object.entries(events)) {
    if (level !== 'red' && !newOnlyIds.has(id)) continue;

    const changedPairs = postconditionPairs.get(id);
    if (!changedPairs || changedPairs.size === 0) continue;

    const downstreamEvents: string[] = [];
    for (const [otherId, otherPrePairs] of preconditionPairs) {
      if (otherId === id) continue;
      for (const prePair of otherPrePairs) {
        if (changedPairs.has(prePair)) {
          downstreamEvents.push(otherId);
          break;
        }
      }
    }

    if (downstreamEvents.length > 0) {
      downstream[id] = downstreamEvents.sort();
    }
  }

  return { events, downstream };
}
