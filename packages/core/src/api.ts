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
import {
  EditorialOperationError,
  executeEditorialRender,
  executeEditorialTreeRender,
  previewEditorialRun as editorialPreviewRun,
} from './editorial/index.ts';
import {
  editorialPreviewRequestV1Schema,
  editorialRenderRequestV1Schema,
  renderGameDialogueTreeRequestV1Schema,
} from './schemas/editorial.ts';
import type {
  EditorialRenderRequestV1,
  RenderGameDialogueTreeRequestV1,
  RenderGameDialogueTreeResult,
  RenderNovelResult,
} from './types/editorial.ts';
import type { EditorialRuntime } from './types/editorial.ts';
import type { PreviewResult } from './editorial/index.ts';
// ============================================================================
import { computeSourceContentHash } from './cache/render-cache.ts';

import * as crypto from 'node:crypto';
import * as path from 'node:path';
import type { LLMProvider } from './ai/types.ts';
import { countNarrativeText } from './assembler/count.ts';
import { assembleGameDialogueTree } from './assembler/index.ts';
import { branchPathsEqual } from './branch/path.ts';
import { compileGameDialogueTree } from './branch/game-dialogue-tree.ts';
import type { CompiledGameDialogueTree } from './branch/game-dialogue-tree.ts';
import type { BatchConfig } from './batch-renderer.ts';
import { BatchRenderPipeline } from './batch-renderer.ts';
import { DEFAULT_CONFIG } from './config/index.js';
import { ContextCompiler } from './context/compiler.ts';
import { PromptAssembler } from './context/prompt-assembler.ts';
import type { ProjectData } from './entity/index.js';
import { EntityMapper } from './entity/mapper.ts';
import { ConfigError, sanitizeError } from './errors.ts';
import { InMemoryEntityRegistry } from './entity/registry.ts';
import type { TypedEventBus } from './event-bus.ts';
import { calculateISS } from './iss/score.ts';
import { JsonlLogTransport, LevelFilterTransport, Logger } from './observability/logger.ts';
import { TraceCollector } from './observability/trace.ts';
import { buildAndWriteOutputs, evaluateReleaseDecision, type InteractionManager, RenderPipeline } from './pipeline/index.ts';
import type { ProviderCallLedgerEntry, RenderJob, RenderSceneResult } from './pipeline/render.ts';
import { PluginHooksManager, PluginLoader, ValidatorRegistry } from './plugin/index.js';
import type { PluginContext, ProviderRegistry } from './plugin/types.js';
import { StateManager } from './state/manager.ts';
import { compileStoryBoundaries } from './state/story-boundaries.ts';
import { compileDiscourseBoundaries } from './state/discourse-context.ts';
import type { CompiledDiscourseRenderContext } from './state/discourse-context.ts';
import { FsStorage } from './storage/fs-storage.ts';
import type { Storage } from './storage/types.ts';
import { canonicalJson, compileSceneContract, computeSha256Hex } from './render/scene-contract.ts';
import type {
  AcceptedSceneArtifact,
  RenderGroup,
  RenderSurfaceConfig,
  SceneTransition,
  SurfacePlanResult,
  SurfacePlannerOptions,
} from './types/render-surface.ts';
import { SurfacePlanner } from './render/surface-planner.ts';
import { SurfaceScheduler, AcceptedArtifactResolver } from './pipeline/surface-scheduler.ts';
import { LogicalDisclosureSummaryCompiler, SurfaceReferenceExtractor } from './summary/index.ts';
import type { BranchPath } from './types/branch.js';
import type { SystemContext } from './types/context.js';
import type {
  AnalysisResult,
  Entity,
  EventFile,
  Fact,
  ISSSnapshot,
  NarrativeEvent,
  ReleaseDecision,
  ValidationIssue,
  ValidationResult,
  WorldState,
} from './types/index.ts';
import { ResultAggregator } from './validator/aggregator.ts';


// ============================================================================
// Module-level cache for initializeProject — API-1 / API-5
// ============================================================================

interface ProjectSourceCacheEntry {
  hash: string;
  data: ProjectData;
  events: NarrativeEvent[];
}

// Source data is isolated by backend identity. Mutable runtime objects are
// deliberately never cached: every initializeProject call creates a new
// registry, event store, snapshot engine, and world state.
const projectCache = new WeakMap<Storage, Map<string, ProjectSourceCacheEntry>>();

function cacheFor(storage: Storage): Map<string, ProjectSourceCacheEntry> {
  let cache = projectCache.get(storage);
  if (!cache) {
    cache = new Map<string, ProjectSourceCacheEntry>();
    projectCache.set(storage, cache);
  }
  return cache;
}

function hashDirectory(storage: Storage, directory: string, baseDirectory: string, hasher: crypto.Hash): void {
  if (!storage.exists(directory)) return;
  for (const entry of [...storage.list(directory)].sort((left, right) => left.name.localeCompare(right.name))) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      hashDirectory(storage, filePath, baseDirectory, hasher);
    } else if (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')) {
      hasher.update(path.relative(baseDirectory, filePath));
      hasher.update('\0');
      hasher.update(storage.read(filePath));
      hasher.update('\0');
    }
  }
}

function computeProjectHash(projectDir: string, storage: Storage): string {
  const hasher = crypto.createHash('sha256');
  const configPath = path.join(projectDir, 'nova.yaml');
  if (storage.exists(configPath)) {
    hasher.update('nova.yaml\0');
    hasher.update(storage.read(configPath));
    hasher.update('\0');
  }
  hashDirectory(storage, path.join(projectDir, 'definitions'), projectDir, hasher);
  hashDirectory(storage, path.join(projectDir, 'chapters'), projectDir, hasher);
  return hasher.digest('hex');
}
// ============================================================================
// Type Definitions
// ============================================================================

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
): {
  initialFacts: Fact[];
  authoredEvents: NarrativeEvent[];
  initialThreads: Array<{ id: string }>;
} {
  const genesis = events.find((event) => event.id === 'system:genesis');
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
  const initialThreads = (data.worldInitialState?.threads ?? []).map((t: { id: string }) => ({
    id: t.id,
  }));
  const authoredEvents = events.filter((event) => event.id !== 'system:genesis');
  return { initialFacts, authoredEvents, initialThreads };
}

/**
 * Load a project's mapper, data, events, registry, and state manager.
 * This is the common initialization sequence used by most functions.
 */
export function initializeProject(
  projectDir: string,
  storage: Storage,
): {
  mapper: EntityMapper;
  data: ProjectData;
  events: NarrativeEvent[];
  registry: InMemoryEntityRegistry;
  stateManager: StateManager;
  state: WorldState;
} {
  const mapper = new EntityMapper(projectDir, storage);
  const sourceData = mapper.loadProject();
  const sourceEvents = mapper.loadAllEvents(sourceData.chapters);
  const hash = computeProjectHash(projectDir, storage);
  const sourceCache = cacheFor(storage);
  const cached = sourceCache.get(projectDir);
  const source =
    cached && cached.hash === hash
      ? cached
      : {
          hash,
          data: structuredClone(sourceData),
          events: structuredClone(sourceEvents),
        };
  if (source !== cached) sourceCache.set(projectDir, source);

  // Cloning prevents a caller's stateful work from contaminating the next
  // initialization while retaining the backend-specific immutable source cache.
  const data = structuredClone(source.data);
  const events = structuredClone(source.events);
  const registry = new InMemoryEntityRegistry();
  registry.load(projectDir, storage);
  for (const event of events) {
    for (const introduction of event.introduces ?? []) {
      if (registry.resolve(introduction.id)) continue;
      registry.register({
        id: introduction.id,
        kind: introduction.type,
        name: introduction.id,
        definitionFile: `definitions/introduces/${introduction.id}.yaml`,
        lifecycle: 'active',
        typeRef: { typeId: introduction.type, schemaVersion: 1 },
        state: { ...introduction.initialState },
      });
    }
  }

  const stateManager = new StateManager(
    path.join(projectDir, data.config?.outputDir ?? DEFAULT_CONFIG.outputDir, 'snapshots'),
    20,
    storage,
  );
  stateManager.initialize(events);
  const state = {
    entities: {},
    relationships: {},
    knowledge: {},
    epistemicLedger: { claims: {}, bySubject: {}, byProposition: {}, actLog: [] },
    propositionCatalog: { version: 0, propositions: {}, dependencyGraph: {} },
    threads: {},
    rules: {},
    facts: [],
  } satisfies WorldState;

  return { mapper, data, events, registry, stateManager, state };
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
    reason = result.validation.errors.map((issue: ValidationIssue) => issue.message).join(' | ');
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


// ============================================================================
// Plugin initialization helper
// ============================================================================

interface InitializePluginsResult {
  pluginHooksManager?: PluginHooksManager;
  validatorRegistry?: ValidatorRegistry;
  conflictErrors: string[];
}

/**
 * Initialize plugins for a project: load manifests, detect conflicts,
 * build ValidatorRegistry, wire PluginHooksManager, and register hooks.
 * Returns early (no-op) when plugins are not enabled.
 */
async function initializePlugins(
  projectDir: string,
  storage: Storage,
  logger: Logger,
  config?: { plugins?: { enabled: boolean; directory?: string } },
): Promise<InitializePluginsResult> {
  if (!config?.plugins?.enabled) {
    return { conflictErrors: [] };
  }

  const pluginLoader = new PluginLoader(storage);
  const hooks = await pluginLoader.loadFromDirectory(
    path.join(projectDir, config.plugins.directory ?? 'plugins'),
  );

  // Detect and report conflicts before any plugin registration
  const conflicts = pluginLoader.detectConflicts();
  if (conflicts.length > 0) {
    return {
      conflictErrors: conflicts.map(
        (c) => `Plugin conflict: ${c.pluginA} vs ${c.pluginB} — ${c.reason}`,
      ),
    };
  }

  const validatorRegistry = new ValidatorRegistry();
  // Provider registry map — retained for future provider resolution flow
  const providers = new Map<string, LLMProvider>();
  const providerRegistry: ProviderRegistry = {
    register(name: string, provider: LLMProvider): void {
      providers.set(name, provider);
    },
    getProvider(name: string): LLMProvider | undefined {
      return providers.get(name);
    },
  };

  const pluginContext: PluginContext = { projectDir, storage, log: logger };
  const hooksManager = new PluginHooksManager(pluginContext, validatorRegistry, providerRegistry);

  for (const hook of hooks) {
    hooksManager.register(hook);
  }

  await hooksManager.initialize();

  return { pluginHooksManager: hooksManager, validatorRegistry, conflictErrors: [] };
}
// ============================================================================
// Internal helper — validate runtime combinations before delegation
// ============================================================================

/**
 * Validate runtime configuration that cannot be expressed in schemas.
 * Throws EditorialOperationError when mutually exclusive options are set.
 * This is kept separate from the request schema to avoid leaking runtime
 * objects (providers, signals) into serializable DTOs.
 */
function validateRuntime(runtime: EditorialRuntime): void {
  if (runtime.provider && runtime.providerFactory) {
    throw new EditorialOperationError(
      'INVALID_OPERATION',
      'Cannot provide both runtime.provider and runtime.providerFactory. Provide at most one.',
    );
  }
}

// ============================================================================
// 1. renderNovel — Full LLM rendering pipeline
// ============================================================================

/**
 * Orchestrate the full render pipeline via the editorial render service.
 * The runtime is optional — when omitted a safe empty runtime (no storage,
 * no provider, no signal) is used, which will fail at materialization if
 * any provider or storage operation is needed.
 *
 * Strict-validates the request against editorialRenderRequestV1Schema at
 * runtime before delegation.
 */
export async function renderNovel(
  request: EditorialRenderRequestV1,
  runtime?: EditorialRuntime,
): Promise<RenderNovelResult> {
  const parsed = editorialRenderRequestV1Schema.parse(request);
  const rt = runtime ?? {};
  validateRuntime(rt);
  return executeEditorialRender(parsed, rt);
}

/**
 * Render every authored game-tree node once via the editorial render service.
 * The runtime is optional with the same semantics as renderNovel.
 *
 * Strict-validates the request against renderGameDialogueTreeRequestV1Schema
 * at runtime before delegation.
 */
export async function renderGameDialogueTree(
  request: RenderGameDialogueTreeRequestV1,
  runtime?: EditorialRuntime,
): Promise<RenderGameDialogueTreeResult> {
  const parsed = renderGameDialogueTreeRequestV1Schema.parse(request);
  const rt = runtime ?? {};
  validateRuntime(rt);
  return executeEditorialTreeRender(parsed, rt);
}

/**
 * Preview an editorial render: compile the plan and assemble prompts
 * without any LLM calls or storage writes.
 *
 * The preview request has no mutation context. The internal compiler receives
 * the same read-only shape and performs no storage writes or provider calls.
 *
 * Strict-validates the request against editorialPreviewRequestV1Schema
 * at runtime before delegation.
 */
export async function previewEditorialRun(
  request: Omit<EditorialRenderRequestV1, 'mutation'>,
  runtime?: EditorialRuntime,
): Promise<PreviewResult> {
  const parsed = editorialPreviewRequestV1Schema.parse(request);
  const rt = runtime ?? {};
  validateRuntime(rt);
  return editorialPreviewRun(parsed, rt);
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
export async function validateNovel(
  projectDir: string,
  overrides?: Record<string, 'off' | 'warning' | 'error'>,
  storage?: Storage,
): Promise<{
  passed: boolean;
  results: Map<string, ValidationResult>;
  iss: ISSSnapshot;
}> {
  const resolvedStorage = storage ?? new FsStorage();
  const validateLogger = new Logger(new LevelFilterTransport(new JsonlLogTransport()), {
    module: 'validate',
  });
  const { data, events, registry } = initializeProject(projectDir, resolvedStorage);

  // Compile story boundaries for per-event pre-state
  const { initialFacts, authoredEvents, initialThreads } = buildInitialState(
    events,
    registry,
    data,
  );

  // Initialize plugins (if configured)
  const { validatorRegistry, conflictErrors: pluginConflictErrors } = await initializePlugins(
    projectDir,
    resolvedStorage,
    validateLogger,
    data.config ?? undefined,
  );

  const anchors = new Map((data.timeAnchors ?? []).map((anchor) => [anchor.id, anchor.day]));
  const boundaries = compileStoryBoundaries(
    authoredEvents,
    initialFacts,
    anchors,
    undefined,
    initialThreads,
  );

  // Run validators with per-event pre-state and plugin validators
  const aggregator = new ResultAggregator(undefined, validatorRegistry?.validators);
  const mergedOverrides = overrides ?? data.config?.validatorOverrides;
  const validationResults = aggregator.validateAll(
    events,
    boundaries.finalState,
    registry,
    mergedOverrides,
    boundaries.stateBeforeByEventId,
  );

  // Add plugin conflict as synthetic validation failure if present
  if (pluginConflictErrors.length > 0) {
    const syntheticResult: ValidationResult = {
      passed: false,
      errors: pluginConflictErrors.map((msg) => ({
        validator: 'plugin-loader',
        severity: 'error' as const,
        event: '__plugin__',
        entity: 'system',
        message: msg,
        fixSuggestion: 'Resolve plugin conflicts (e.g., remove duplicate plugins).',
        fixAction: 'manual' as const,
        fixTarget: { file: '' },
      })),
      warnings: [],
      infos: [],
    };
    validationResults.set('__plugin__', syntheticResult);
  }

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
  const { initialFacts, authoredEvents, initialThreads } = buildInitialState(
    events,
    registry,
    data,
  );
  const anchors = new Map((data.timeAnchors ?? []).map((anchor) => [anchor.id, anchor.day]));
  const boundaries = compileStoryBoundaries(
    authoredEvents,
    initialFacts,
    anchors,
    undefined,
    initialThreads,
  );

  // Use provided validation results or run validateAll
  if (!validationResults) {
    const aggregator = new ResultAggregator();
    const overrides = data.config?.validatorOverrides;
    validationResults = aggregator.validateAll(
      events,
      boundaries.finalState,
      registry,
      overrides,
      boundaries.stateBeforeByEventId,
    );
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
export function diffEvent(projectDir: string, eventId: string, storage?: Storage): DiffResult | null {
  const resolvedStorage = storage ?? new FsStorage();
  const { events, registry, data } = initializeProject(projectDir, resolvedStorage);

  const targetEvent = events.find((e) => e.id === eventId);
  if (!targetEvent) return null;

  const { initialFacts, authoredEvents, initialThreads } = buildInitialState(
    events,
    registry,
    data,
  );
  const anchors = new Map((data.timeAnchors ?? []).map((a) => [a.id, a.day]));
  const boundaries = compileStoryBoundaries(
    authoredEvents,
    initialFacts,
    anchors,
    undefined,
    initialThreads,
  );

  const orderedIds = boundaries.orderedEventIds;
  const targetIndex = orderedIds.indexOf(eventId);
  if (targetIndex === -1) return null;

  // Before state: state before the target event in causal order
  const beforeState = boundaries.stateBeforeByEventId.get(eventId) ?? {
    entities: {},
    relationships: {},
    knowledge: {},
    threads: {},
    rules: {},
    facts: [],
  };

  // After state: replay including the target event
  const afterState =
    targetIndex === orderedIds.length - 1
      ? boundaries.finalState
      : (boundaries.stateBeforeByEventId.get(orderedIds[targetIndex + 1]) ?? boundaries.finalState);

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
    const br = (beforeState.relationships as Record<string, unknown>)[relId] as
      | RelationshipRuntimeState
      | undefined;
    const ar = (afterState.relationships as Record<string, unknown>)[relId] as
      | RelationshipRuntimeState
      | undefined;
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
  storage?: Storage,
): Array<{ id: string; kind: string; name?: string }> {
  const resolvedStorage = storage ?? new FsStorage();
  const mapper = new EntityMapper(projectDir, resolvedStorage);
  mapper.loadProject(); // validates project exists

  const registry = new InMemoryEntityRegistry();
  registry.load(projectDir, resolvedStorage);

  const entities: Entity[] = kind ? registry.findByKind(kind as any) : registry.getAll();

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
export function showEntity(projectDir: string, entityId: string, storage?: Storage): Record<string, unknown> | null {
  const resolvedStorage = storage ?? new FsStorage();
  const mapper = new EntityMapper(projectDir, resolvedStorage);
  mapper.loadProject(); // validates project exists

  const registry = new InMemoryEntityRegistry();
  registry.load(projectDir, resolvedStorage);

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
export function analyzeProjectImpact(oldPath: string, newPath: string): ImpactAnalysisResult {
  const oldStorage = new FsStorage();
  const newStorage = new FsStorage();
  const oldMapper = new EntityMapper(oldPath, oldStorage);
  const newMapper = new EntityMapper(newPath, newStorage);
  const oldData = oldMapper.loadProject();
  const newData = newMapper.loadProject();
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
  const pcKey = (pc: {
    entity: string;
    attribute: string;
    value: unknown;
    operator?: string;
  }): string => `${pc.entity}:${pc.attribute}:${JSON.stringify(pc.value)}:${pc.operator ?? 'eq'}`;

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
      oldPreKeys.size !== newPreKeys.size || [...oldPreKeys].some((k) => !newPreKeys.has(k));

    // Compare postconditions
    const oldPostKeys = new Set(oldEv.expectedPostconditions.map(pcKey));
    const newPostKeys = new Set(newEv.expectedPostconditions.map(pcKey));
    const postChanged =
      oldPostKeys.size !== newPostKeys.size || [...oldPostKeys].some((k) => !newPostKeys.has(k));

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
