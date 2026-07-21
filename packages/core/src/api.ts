// ============================================================================
// Novalistically Core — Orchestration Functions (Public API)
// ============================================================================
//
import type { RelationshipRuntimeState } from './types/index.js';
// pure-function-like API for CLIs, MCP servers, and external consumers.
// They are the recommended entry point for most use cases.
// ============================================================================

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { EntityMapper } from './entity/mapper.ts';
import type { ProjectData } from './entity/index.js';
import { InMemoryEntityRegistry } from './entity/registry.ts';
import { StateManager } from './state/manager.ts';
import { compileStoryBoundaries } from './state/story-boundaries.ts';
import { ContextCompiler } from './context/compiler.ts';
import { assembleNovel } from './assembler/novel.ts';
import { countNarrativeText } from './assembler/count.ts';
import { RenderPipeline, buildAndWriteOutputs } from './pipeline/index.ts';
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
import { Logger } from './observability/logger.ts';
import { TraceCollector } from './observability/trace.ts';
import { sanitizeError } from './errors.ts';
import type {
  AnalysisResult,
  Entity,
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

function computeProjectHash(projectDir: string, events: NarrativeEvent[]): string {
  const hasher = crypto.createHash('sha256');
  // Hash each definition YAML, config, and event YAML by content
  const defsDir = path.join(projectDir, 'definitions');
  if (fs.existsSync(defsDir)) {
    const defs = fs.readdirSync(defsDir).sort();
    for (const f of defs) {
      if (f.endsWith('.yaml') || f.endsWith('.yml')) {
        hasher.update(fs.readFileSync(path.join(defsDir, f)));
      }
    }
  }
  const configPath = path.join(projectDir, 'nova.yaml');
  if (fs.existsSync(configPath)) {
    hasher.update(fs.readFileSync(configPath));
  }
  // Hash all event YAMLs by content (not just paths)
  for (const ev of events) {
    if (ev.id !== 'system:genesis') {
      const evPath = path.join(projectDir, 'events', `${ev.id}.yaml`);
      if (fs.existsSync(evPath)) {
        hasher.update(fs.readFileSync(evPath));
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
export function initializeProject(projectDir: string): {
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
  const hash = computeProjectHash(projectDir, events);

  const cached = projectCache.get(projectDir);
  if (cached && cached.hash === hash) {
    return { mapper: cached.mapper, data: cached.data, events: cached.events, registry: cached.registry, stateManager: cached.stateManager, state: cached.state };
  }

  const registry = new InMemoryEntityRegistry();
  registry.load(projectDir);
  const stateManager = new StateManager(path.join(projectDir, '.nova', 'snapshots'));
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
  const { projectDir, model, apiKey, baseUrl, eventId, dryRun, provider: injectedProvider, branchPath, trace } = opts;
  const errors: string[] = [];
  // Observability: trace collector for this render session
  const traceCollector = trace ? new TraceCollector(eventId ?? 'render-all') : undefined;
  const eventLogger = traceCollector ? new Logger(undefined, { module: 'render' }) : undefined;

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
  };

  // ── Dry run ───────────────────────────────────────────────────────
  if (dryRun) {
    const results: RenderNovelResult['results'] = [];
    const dryRunDir = path.join(projectDir, '.nova', 'dry-runs');
    fs.mkdirSync(dryRunDir, { recursive: true });

    for (const ev of renderEvents) {
      const beforeState = boundaries.stateBeforeByEventId.get(ev.id)!;
      const compiler = new ContextCompiler();
      compiler.compile(ev, beforeState, registry, { systemContext: sysCtx });

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
  const resolvedModel = model ?? data.config?.defaultModel ?? 'claude-sonnet-4-20250514';
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
  const cacheDir = path.join(projectDir, '.nova', 'render-cache');
  const storage = opts.storage ?? new FsStorage();
  const pipeline = new RenderPipeline({
    provider,
    model: resolvedModel,
    cacheDir,
    storage,
    aggregator: new ResultAggregator(),
    logger: eventLogger,
    traceCollector,
    targetLengthWords: data.config?.defaultSceneTextTarget ?? 400,
    language: data.config?.defaultLanguage ?? 'en',
    maxRounds: opts.maxRounds,
  });

  // Initialize cache
  const eventsFileMap = buildEventsFileMap(data);
  await pipeline.initCache(eventsFileMap, path.join(projectDir, 'definitions'));

  // Build render jobs
  const jobs: RenderJob[] = [];
  for (const ev of renderEvents) {
    const chapterNum = findChapterForEvent(data, ev.id);
    const beforeState = boundaries.stateBeforeByEventId.get(ev.id)!;
    const compiler = new ContextCompiler();
    const ctxStart = Date.now();
    traceCollector?.record({ phase: 'context', state: 'start', spanId: ev.id, eventId: ev.id });
    const pkg = compiler.compile(ev, beforeState, registry, { systemContext: sysCtx });
    traceCollector?.record({ phase: 'context', state: 'end', spanId: ev.id, eventId: ev.id, durationMs: Date.now() - ctxStart });
    jobs.push({
      event: ev,
      stateBefore: beforeState,
      context: pkg,
      chapter: chapterNum,
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
      const diagnostics = unreleased.map(buildReleaseDiagnostic);
      errors.push(`Release gate rejected: ${diagnostics.join('; ')}`);
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
    released: r.prose.trim().length > 0 && r.analysis !== null && r.validation !== null && r.validation.passed && !r.needsReview,
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
): ProjectStatusResult {
  const { data, events, registry } = initializeProject(projectDir);

  // Determine rendered events by checking scenes/ directory for .md files
  const renderedSet = new Set<string>();
  const scenesDir = path.join(projectDir, 'scenes');
  if (fs.existsSync(scenesDir)) {
    const sceneDirs = fs.readdirSync(scenesDir, { withFileTypes: true });
    for (const dir of sceneDirs) {
      if (!dir.isDirectory()) continue;
      const dirPath = path.join(scenesDir, dir.name);
      const mdFiles = fs.readdirSync(dirPath).filter((f) => f.endsWith('.md'));
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
      if (fs.existsSync(sceneMetaPath)) {
        try {
          const metaContent = fs.readFileSync(sceneMetaPath, 'utf-8');
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
