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
import { computeSourceContentHash } from './cache/render-cache.ts';

import * as crypto from 'node:crypto';
import * as path from 'node:path';
import type { LLMProvider } from './ai/types.ts';
import { countNarrativeText } from './assembler/count.ts';
import { assembleGameDialogueTree, assembleNovel } from './assembler/index.ts';
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

export interface RenderNovelOptions {
  projectDir: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  eventId?: string; // single event; omit or 'all' for all
  dryRun?: boolean;
  branchPath?: BranchPath;
  /**
   * Explicit discourse-ledger branch label for projection selection.
   * When absent and branchPath is set against a multi-branch ledger,
   * renderNovel fails with an actionable error.
   */
  discourseBranch?: string;
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
    /** Full release decision from evaluateReleaseDecision, null if unknown. */
    releaseDecision: ReleaseDecision | null;
  }>;
  errors: string[];
}

export interface RenderGameDialogueTreeOptions
  extends Omit<RenderNovelOptions, 'eventId' | 'branchPath' | 'discourseBranch'> {}

export interface RenderGameDialogueTreeResult {
  tree: CompiledGameDialogueTree;
  results: RenderNovelResult['results'];
  errors: string[];
  outputPath?: string;
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
 * Shared render-job builder — produces deterministic RenderJob[] with
 * pre-compiled contracts and default parallel surface dependencies.
 * Used by both dry-run and full-render paths.
 */
function buildRenderJobs(params: {
  renderEvents: NarrativeEvent[];
  data: ProjectData;
  registry: InMemoryEntityRegistry;
  boundaries: ReturnType<typeof compileStoryBoundaries>;
  discourseContextByEventId: Record<string, CompiledDiscourseRenderContext>;
  sysCtx: SystemContext;
  branchPath?: BranchPath;
  sourceContentHash: string;
  model: string;
}): RenderJob[] {
  const {
    renderEvents,
    data,
    registry,
    boundaries,
    discourseContextByEventId,
    sysCtx,
    branchPath,
    sourceContentHash,
    model,
  } = params;
  const jobs: RenderJob[] = [];
  const disclosureCompiler = new LogicalDisclosureSummaryCompiler();

  for (const ev of renderEvents) {
    const discourseCtx = discourseContextByEventId[ev.id];
    const chapterNum = findChapterForEvent(data, ev.id);
    const beforeState = boundaries.stateBeforeByEventId.get(ev.id)!;
    const emotionalBeat = ev.arcPosition
      ? data.config?.ideaIR?.emotionalArc?.emotionalBeats.find(
          (beat) => beat.position === ev.arcPosition,
        )?.emotion
      : undefined;
    const compiler = new ContextCompiler();
    const pkg = compiler.compile(ev, beforeState, registry, {
      systemContext: sysCtx,
      narratorProfiles: data.narratorProfiles,
      discourseContext: discourseCtx,
      emotionalBeat,
    });

    const worldStateHash = computeSha256Hex(canonicalJson(beforeState));
    const knowledgeStateHash = computeSha256Hex(canonicalJson(beforeState.knowledge));
    const narratorProfileHash = computeSha256Hex(canonicalJson(data.narratorProfiles));
    const plannedDiscourseHash = discourseCtx
      ? computeSha256Hex(discourseCtx.ledgerHash + '|' + discourseCtx.assertionCatalogHash)
      : '';
    const catalogHash =
      data.narratorAssertions && Object.keys(data.narratorAssertions).length > 0
        ? computeSha256Hex(canonicalJson(Object.keys(data.narratorAssertions).sort()))
        : undefined;

    const sceneTransition: SceneTransition =
      ev.sceneType === 'linear' ? 'continuous'
      : ev.sceneType === 'flashback' ? 'flashback'
      : ev.sceneType === 'flashforward' ? 'time_jump'
      : 'hard_cut';

    const contract = compileSceneContract({
      sceneId: ev.id,
      branch: branchPath ?? { decisions: [] },
      discoursePosition: discourseCtx?.cursor ?? 0,
      worldStateHash,
      knowledgeStateHash,
      narratorProfileHash,
      plannedDiscourseHash,
      catalogHash,
      styleHints: {
        chapterStyle: String(chapterNum),
        narratorPovStyle: ev.narratorProfileRef,
      },
      continuityDirectives: {
        transition: sceneTransition,
      },
      promptProviderId: model,
      promptProviderVersion: model,
    });

    let logicalDisclosureSummary: string | undefined;
    if (discourseCtx) {
      logicalDisclosureSummary = disclosureCompiler.compile(
        discourseCtx.stateBefore,
        contract,
        discourseCtx.projection,
      );
    }

    jobs.push({
      event: ev,
      stateBefore: beforeState,
      context: pkg,
      gameDialogue: ev.choices ? { choices: ev.choices } : undefined,
      chapter: chapterNum,
      contract,
      sourceContentHash,
      logicalDisclosureSummary,
      surfaceDependency: {
        groupId: ev.id,
        policy: 'parallel' as const,
        manifestHash: computeSha256Hex(canonicalJson({
          eventId: ev.id,
          contractHash: contract.promptContractHash,
          policy: 'parallel',
        })),
      },
    });
  }

  return jobs;
}

/**
 * Apply a SurfacePlanResult to jobs, wiring groupId, laneId,
 * predecessorEventId, and policy from the plan's dependency graph.
 */
function applySurfacePlanToJobs(
  jobs: RenderJob[],
  plan: SurfacePlanResult,
): void {
  const { surfaceDependencyGraph } = plan;
  const { groups, serialLanes } = surfaceDependencyGraph;

  // Build sceneId -> group map
  const sceneGroupMap = new Map<string, RenderGroup>();
  for (const group of groups) {
    for (const sceneId of group.sceneIds) {
      sceneGroupMap.set(sceneId, group);
    }
  }

  // Build predecessor chain from lane ordering
  const groupPredecessors = new Map<string, string>(); // groupId -> predecessor groupId
  const groupToLane = new Map<string, string>();       // groupId -> laneId

  for (const lane of serialLanes) {
    for (let i = 0; i < lane.groupIds.length; i++) {
      groupToLane.set(lane.groupIds[i], lane.laneId);
      if (i > 0) {
        groupPredecessors.set(lane.groupIds[i], lane.groupIds[i - 1]);
      }
    }
  }

  // Apply to jobs
  for (const job of jobs) {
    const group = sceneGroupMap.get(job.event.id);
    if (!group) continue;

    const groupId = group.groupId;
    const policy = group.surfacePolicy.type;
    let predecessorEventId: string | undefined;

    if (groupPredecessors.has(groupId)) {
      const predGroupId = groupPredecessors.get(groupId)!;
      const predGroup = groups.find((g) => g.groupId === predGroupId);
      if (predGroup && predGroup.sceneIds.length > 0) {
        predecessorEventId = predGroup.sceneIds[predGroup.sceneIds.length - 1];
      }
    }

    job.surfaceDependency = {
      groupId,
      ...(groupToLane.has(groupId) ? { laneId: groupToLane.get(groupId) } : {}),
      predecessorEventId,
      policy: policy as 'parallel' | 'serial_surface' | 'fallback_without_surface',
      manifestHash: plan.manifest.sourceDefinitionHash,
    };
  }
}
function compileConfiguredSurfacePlan(
  data: ProjectData,
  jobs: readonly RenderJob[],
  branchPath?: BranchPath,
): SurfacePlanResult | undefined {
  const config = data.config?.renderSurface;
  if (!config) return undefined;

  const options: SurfacePlannerOptions = {
    mode: config.mode ?? 'manual',
    branch: branchPath ?? { decisions: [] },
    sceneIds: jobs.map((job) => job.event.id),
    contracts: jobs.map((job) => job.contract),
    ...(config.groups
      ? {
          authorGroups: config.groups.map((group) => ({
            groupId: group.groupId,
            sceneIds: group.sceneIds,
            surfacePolicy: { type: group.surfacePolicy },
          })),
        }
      : {}),
    ...(config.lanes
      ? {
          authorLanes: config.lanes.map((lane) => ({
            laneId: lane.laneId,
            groupIds: lane.groupIds,
          })),
        }
      : {}),
    ...(config.auto
      ? {
          autoConfig: {
            authorized: config.auto.authorized,
            maxParallelGroupSize: config.auto.maxParallelGroupSize,
          },
        }
      : {}),
  };
  return new SurfacePlanner(options).plan();
}

/**
 * Materialize surface reference packets for wave jobs from accepted artifacts.
 * Returns blocked results for jobs whose serial predecessor is unavailable and
 * whose policy is not fallback_without_surface.
 */
function materializeSurfacePackets(
  jobs: RenderJob[],
  waveEventIds: readonly string[],
  acceptedByEventId: Map<string, AcceptedSceneArtifact>,
  storage: Storage,
  projectDir: string,
  extractor: SurfaceReferenceExtractor,
  scopeHash: string,
  currentRunEventIds: ReadonlySet<string>,
): { blocked: RenderSceneResult[] } {
  const resolver = new AcceptedArtifactResolver(storage, projectDir);
  const blocked: RenderSceneResult[] = [];
  for (const job of jobs) {
    if (!waveEventIds.includes(job.event.id)) continue;
    const predId = job.surfaceDependency.predecessorEventId;
    if (!predId) continue;

    const policy = job.surfaceDependency.policy;

    // Check current run's accepted artifacts first
    const accepted = acceptedByEventId.get(predId);
    if (accepted) {
      job.surfaceReferencePacket = extractor.extract(accepted);
      continue;
    }

    // A persisted source may satisfy a subset dependency only when it shares
    // this render's branch/discourse scope. It then becomes a ready root.
    const persisted = resolver.resolve(predId);
    if (persisted && persisted.scopeHash === scopeHash) {
      job.surfaceReferencePacket = extractor.extract(persisted);
      if (!currentRunEventIds.has(predId)) {
        job.surfaceDependency = { ...job.surfaceDependency, predecessorEventId: undefined };
      }
      continue;
    }

    // Missing source — explicit fallback can become a ready root without a packet.
    if (policy === 'fallback_without_surface') {
      if (!currentRunEventIds.has(predId)) {
        job.surfaceDependency = { ...job.surfaceDependency, predecessorEventId: undefined };
      }
      continue;
    }

    const now = Date.now();
    blocked.push({
      eventId: job.event.id,
      prose: '',
      analysis: null,
      llmPass1: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      llmPass2: null,
      cacheHit: false,
      errors: [
        `MISSING_SURFACE_SOURCE: predecessor "${predId}" has no accepted artifact in this run or persisted storage`,
      ],
      promptHash: '',
      renderStart: now,
      renderEnd: now,
      validation: {
        passed: false,
        errors: [{
          validator: 'surface-scheduler',
          severity: 'error' as const,
          event: job.event.id,
          entity: '',
          message: `MISSING_SURFACE_SOURCE: ${predId}`,
          fixSuggestion: 'Render the predecessor scene first or configure fallback_without_surface policy',
          fixAction: 'manual' as const,
          fixTarget: { file: '' },
        }],
        warnings: [],
        infos: [],
      },
      providerCalls: [],
      requestRecords: [],
      attempts: 0,
      needsReview: false,
    });
  }

  return { blocked };
 }

function writeSceneResponse(
  storage: Storage,
  responseDir: string,
  result: RenderSceneResult,
  decision: ReleaseDecision,
): ReleaseDecision {
  try {
    storage.write(
      path.join(responseDir, `${result.eventId}.json`),
      JSON.stringify(
        {
          prose: result.prose,
          timestamp: new Date().toISOString(),
          cacheHit: result.cacheHit,
          errors: result.errors,
          analysis: result.analysis,
          validation: result.validation,
          needsReview: result.needsReview,
          attempts: result.attempts,
          promptHash: result.promptHash,
          providerCalls: result.providerCalls,
          requestRecords: result.requestRecords,
          released: decision.status === 'accepted',
          releaseDecision: decision,
          ...(result.pass2Rejection !== undefined ? { pass2Rejection: result.pass2Rejection } : {}),
        },
        null,
        2,
      ),
    );
    return decision;
  } catch (writeErr) {
    return {
      status: 'blocked',
      scopeHash: decision.scopeHash,
      validationIdentity: decision.validationIdentity,
      reasons: [`response write failed: ${sanitizeError(writeErr)}`],
    };
  }
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
  const {
    projectDir,
    model,
    apiKey,
    baseUrl,
    eventId,
    dryRun,
    provider: injectedProvider,
    branchPath,
    trace,
    eventBus,
  } = opts;
  const errors: string[] = [];

  const storage = opts.storage ?? new FsStorage();
  // Observability: trace collector for this render session
  const traceCollector = trace ? new TraceCollector(eventId ?? 'render-all') : undefined;
  const eventLogger = new Logger(
    trace ? undefined : new LevelFilterTransport(new JsonlLogTransport()),
    { module: 'render' },
  );

  const { data, events, registry } = initializeProject(projectDir, storage);
  const gameDialogueTree = compileGameDialogueTree(
    [...data.chapters.values()].flatMap((chapter) => chapter.events),
    new Map(data.timeAnchors.map((anchor) => [anchor.id, anchor.day])),
  );
  if (
    gameDialogueTree &&
    (!branchPath ||
      !gameDialogueTree.leafPaths.some((leafPath) => branchPathsEqual(leafPath, branchPath)))
  ) {
    return {
      results: [],
      errors: ['Game dialogue rendering requires one complete, ordered leaf branchPath.'],
    };
  }

  const { initialFacts, authoredEvents, initialThreads } = buildInitialState(
    events,
    registry,
    data,
  );

  const anchors = new Map(data.timeAnchors.map((anchor) => [anchor.id, anchor.day]));
  const boundaries = compileStoryBoundaries(
    authoredEvents,
    initialFacts,
    anchors,
    branchPath,
    initialThreads,
  );
  const renderEvents = (
    !eventId || eventId === 'all'
      ? authoredEvents
      : authoredEvents.filter((event) => event.id === eventId)
  ).filter((event) => event.source === 'event_file' && boundaries.stateBeforeByEventId.has(event.id));
  if (renderEvents.length === 0) {
    errors.push(`No events found to render${eventId ? ` for eventId "${eventId}"` : ''}`);
    return { results: [], errors };
  }

  // DISCARD-1: Guard against silent discourse-branch mismatches before any
  // prompt construction. Three cases:
  //
  //   1. Explicit discourseBranch is set but does not match any ledger entry
  //      branch label — reject unknown/typo label.
  //   2. Explicit discourseBranch is set but no discourse ledger exists
  //      (definitions/discourse-ledger.yaml absent) — reject; a branch
  //      label is meaningless without a ledger.
  //   3. branchPath selects a non-main story branch, no explicit
  //      discourseBranch is given, and the loaded ledger has non-main
  //      entries — fail closed rather than silently projecting main.
  if (opts.discourseBranch != null) {
    if (!data.discourseLedger) {
      errors.push(
        'discourseBranch "' +
          opts.discourseBranch +
          '" was specified but no discourse ledger ' +
          'exists (definitions/discourse-ledger.yaml is absent or optional). ' +
          'Remove discourseBranch or add a ledger with matching entries.',
      );
      return { results: [], errors };
    }
    const branchExists = data.discourseLedger.entries.some(
      (e) => e.branch === opts.discourseBranch,
    );
    if (!branchExists) {
      errors.push(
        'discourseBranch "' +
          opts.discourseBranch +
          '" does not match any branch label ' +
          'in the discourse ledger. Valid labels: ' +
          [...new Set(data.discourseLedger.entries.map((e) => e.branch))].join(', '),
      );
      return { results: [], errors };
    }
  } else if (branchPath && data.discourseLedger) {
    const hasNonMainBranch = data.discourseLedger.entries.some((e) => e.branch !== 'main');
    if (hasNonMainBranch) {
      errors.push(
        'Story branchPath is set but no explicit discourseBranch was provided, and ' +
          'the discourse ledger contains non-main branches. Render would project the ' +
          'default (main) discourse, which may be incorrect. Set discourseBranch to ' +
          'specify the target discourse ledger branch, or omit branchPath to use main.',
      );
      return { results: [], errors };
    }
  }
  // DISCOURSE-1: Compile strict discourse boundaries — validates ledger structure,
  // assertion catalog, per-event cursor, and produces per-event compiled contexts.
  // This runs BEFORE any provider/cache/plugin/prompt/dry-run work.
  // ConfigErrors here cause early return with zero side effects.
  //
  // When no discourse ledger exists AND no explicit discourseBranch was provided,
  // this is a legal no-disclosure mode: skip discourse compilation entirely.
  // (The explicit discourseBranch-without-ledger case already errored above.)
  let discourseContextByEventId: Record<string, CompiledDiscourseRenderContext> = {};
  if (data.discourseLedger) {
    const discourseBranch = opts.discourseBranch ?? 'main';
    try {
      discourseContextByEventId = compileDiscourseBoundaries(
        renderEvents,
        data.discourseLedger,
        data.narratorAssertions,
        data.narratorProfiles,
        discourseBranch,
      );
    } catch (err) {
      errors.push(`Discourse preflight failed: ${(err as Error).message}`);
      return { results: [], errors };
    }
  }

  const sysCtx: SystemContext = {
    genre: data.config?.genre ?? 'literary',
    style: 'literary',
    narrativeRules: [],
    thematicIntent: data.config?.ideaIR?.thematicIntent,
    synopsis: data.config?.synopsis,
  };
  // Initialize plugins (after discourse preflight for strict ordering)
  const { pluginHooksManager, validatorRegistry, conflictErrors } = await initializePlugins(
    projectDir,
    storage,
    eventLogger,
    data.config ?? undefined,
  );
  if (conflictErrors.length > 0) {
    return { results: [], errors: conflictErrors };
  }

  // ── Dry run ───────────────────────────────────────────────────────
  if (dryRun) {
    const results: RenderNovelResult['results'] = [];
    const dryRunDir = path.join(
      projectDir,
      data.config?.outputDir ?? DEFAULT_CONFIG.outputDir,
      'dry-runs',
    );
    storage.mkdirp(dryRunDir);
    const language = data.config?.defaultLanguage ?? 'en';

    const dryScopeHash = computeSha256Hex(canonicalJson({
      branch: branchPath ?? { decisions: [] },
      discourse: opts.discourseBranch ?? 'main',
    }));
    const selectedEventIds = new Set(renderEvents.map((event) => event.id));
    const eventFilePaths = [...data.chapters.values()]
      .flatMap((chapter) => chapter.events)
      .filter((eventFile) => selectedEventIds.has(eventFile.event))
      .map((eventFile) => eventFile.filePath)
      .filter((filePath): filePath is string => filePath !== undefined);
    const sourceContentHash = computeSourceContentHash(
      eventFilePaths,
      path.join(projectDir, 'definitions'),
      { branchDiscourseScopeHash: dryScopeHash },
      projectDir,
      storage,
    );
    const dryJobs = buildRenderJobs({
      renderEvents,
      data,
      registry,
      boundaries,
      discourseContextByEventId,
      sysCtx,
      branchPath,
      sourceContentHash,
      model: model ?? data.config?.defaultModel ?? 'dry-run-model',
    });
    const drySurfacePlan = compileConfiguredSurfacePlan(data, dryJobs, branchPath);
    if (drySurfacePlan) applySurfacePlanToJobs(dryJobs, drySurfacePlan);
    const dryExtractor = new SurfaceReferenceExtractor(
      data.config?.renderSurface?.extraction?.budget ?? 2000,
    );
    const { blocked: dryBlocked } = materializeSurfacePackets(
      dryJobs,
      dryJobs.map((job) => job.event.id),
      new Map(),
      storage,
      projectDir,
      dryExtractor,
      dryScopeHash,
      new Set(),
    );
    const dryBlockedByEventId = new Map(dryBlocked.map((result) => [result.eventId, result]));

    for (const job of dryJobs) {
      const ev = job.event;
      const missingSource = dryBlockedByEventId.get(ev.id);
      if (missingSource) {
        results.push({
          eventId: ev.id,
          prose: '',
          wordCount: 0,
          cacheHit: false,
          released: false,
          validationErrors: missingSource.validation?.errors.length ?? 0,
          validationIssueMessages: missingSource.errors,
          errors: missingSource.errors,
          analysis: null,
          providerCalls: [],
          promptHash: '',
          releaseDecision: {
            status: 'blocked',
            scopeHash: dryScopeHash,
            validationIdentity: 'dry-run',
            reasons: [...missingSource.errors],
          },
        });
        continue;
      }
      const assembler = new PromptAssembler();
      const assembled = assembler.assemble(job.context, {
        targetLengthWords: ev.styleGuidance?.targetWordCount ?? 400,
        styleGuidance: ev.styleGuidance,
        characterVoiceNotes:
          ev.styleGuidance?.characterVoice &&
          Object.keys(ev.styleGuidance.characterVoice).length > 0
            ? Object.entries(ev.styleGuidance.characterVoice)
                .map(([id, note]) => `${id}: ${note}`)
                .join('; ')
            : undefined,
        language,
        narrativeChecklistItems: ev.narrativeChecklist?.items,
        sourceContextStyleNotes: ev.sourceContext?.entries
          .filter((e) => e.classification === 'STYLE')
          .map((e) => (e.styleNote ? `- "${e.excerpt}" (${e.styleNote})` : `- "${e.excerpt}"`))
          .join('\n'),
        logicalDisclosureSummary: job.logicalDisclosureSummary,
        surfaceReferencePacket: job.surfaceReferencePacket,
      });

      const eventErrors: string[] = [];
      const promptFile = path.join(dryRunDir, `${ev.id}_prompt.md`);
      try {
        storage.write(promptFile, assembled.userPrompt);
      } catch (writeErr) {
        eventErrors.push(
          `Failed to write dry-run prompt to ${promptFile}: ${sanitizeError(writeErr)}`,
        );
      }

      results.push({
        eventId: ev.id,
        prose: '',
        wordCount: 0,
        cacheHit: false,
        released: false,
        validationErrors: 0,
        validationIssueMessages: [],
        errors: eventErrors,
        analysis: null,
        providerCalls: [],
        promptHash: '',
        releaseDecision: null,
      });
    }

    const dryShutdownErrors = pluginHooksManager ? await pluginHooksManager.shutdown() : [];
    errors.push(...dryShutdownErrors);
    return { results, errors };
  }
  // ── Full rendering ────────────────────────────────────────────────
  const resolvedModel =
    model ?? data.config?.defaultModel ?? process.env['NOVALISTICALLY_AI_MODEL'];
  if (!resolvedModel) {
    errors.push(
      'No model configured. Set --model, nova.yaml "defaultModel", or the NOVALISTICALLY_AI_MODEL environment variable.',
    );
    const modelShutdownErrors = pluginHooksManager ? await pluginHooksManager.shutdown() : [];
    errors.push(...modelShutdownErrors);
    return { results: [], errors };
  }
  let provider: LLMProvider;
  // Check for plugin-registered provider configured in nova.yaml
  const configuredPluginProvider = data.config?.plugins?.provider;
  // Guard: provider set but plugins not enabled or no hooks manager
  if (configuredPluginProvider && !pluginHooksManager) {
    errors.push(
      `Plugin provider "${configuredPluginProvider}" is configured but plugins are not enabled or failed to initialize. ` +
        'Set plugins.enabled: true in nova.yaml or remove plugins.provider to use the default provider.',
    );
    return { results: [], errors };
  }
  if (configuredPluginProvider && pluginHooksManager) {
    const pluginProv = pluginHooksManager.getProvider(configuredPluginProvider);
    if (!pluginProv) {
      errors.push(
        `Plugin provider "${configuredPluginProvider}" is not registered. ` +
          `Available plugin providers: ${pluginHooksManager.getProviderNames().join(', ') || '(none)'}`,
      );
      const provShutdownErrors = await pluginHooksManager.shutdown();
      errors.push(...provShutdownErrors);
      return { results: [], errors };
    }
    provider = pluginProv;
  } else
  if (injectedProvider) {
    provider = injectedProvider;
  } else {
    const resolvedApiKey = apiKey ?? process.env['NOVALISTICALLY_AI_API_KEY'] ?? '';
    if (!resolvedApiKey) {
      errors.push(
        'No API key provided. Set NOVALISTICALLY_AI_API_KEY environment variable or pass apiKey option.',
      );
      const apiKeyShutdownErrors = pluginHooksManager ? await pluginHooksManager.shutdown() : [];
      errors.push(...apiKeyShutdownErrors);
      return { results: [], errors };
    }
    const resolvedBaseUrl = baseUrl ?? process.env['NOVALISTICALLY_AI_BASE_URL'] ?? undefined;
    try {
      provider = await createProvider(resolvedApiKey, resolvedBaseUrl, resolvedModel);
    } catch (err) {
      errors.push(`Failed to create LLM provider: ${(err as Error).message}`);
      const createShutdownErrors = pluginHooksManager ? await pluginHooksManager.shutdown() : [];
      errors.push(...createShutdownErrors);
      return { results: [], errors };
    }
  }
  const cacheDir = path.join(
    projectDir,
    data.config?.outputDir ?? DEFAULT_CONFIG.outputDir,
    'render-cache',
  );
  const aggregator = new ResultAggregator(
    undefined,
    validatorRegistry?.validators,
    undefined,
    traceCollector,
  );
  const pipeline = new RenderPipeline({
    provider,
    model: resolvedModel,
    cacheDir,
    storage,
    aggregator,
    logger: eventLogger,
    traceCollector,
    eventBus,
    maxRounds: opts.maxRounds,
    concurrency: opts.concurrency,
    language: data.config?.defaultLanguage ?? 'en',
    pluginHooksManager,
  });

  // ── Compute source content hash from loaded event files + definitions ──
  // This is injected into every RenderJob and forms the root of the logical
  // cache key. A source read failure here is a hard render configuration
  // failure — we abort before any provider/cache activity.
  const sourceScopeHash = computeSha256Hex(canonicalJson({
    branch: branchPath ?? { decisions: [] },
    discourse: opts.discourseBranch ?? 'main',
  }));
  const selectedEventIds = new Set(renderEvents.map((event) => event.id));
  const eventFilePaths = [...data.chapters.values()]
    .flatMap((chapter) => chapter.events)
    .filter((eventFile) => selectedEventIds.has(eventFile.event))
    .map((eventFile) => eventFile.filePath)
    .filter((filePath): filePath is string => filePath !== undefined);
  const definitionsDir = path.join(projectDir, 'definitions');
  const sourceContentHash = computeSourceContentHash(
    eventFilePaths,
    definitionsDir,
    { branchDiscourseScopeHash: sourceScopeHash },
    projectDir,
    storage,
  );
  // ── Build shared render jobs with deterministic pre-prose contracts ──
  const jobs = buildRenderJobs({
    renderEvents,
    data,
    registry,
    boundaries,
    discourseContextByEventId,
    sysCtx,
    branchPath,
    sourceContentHash,
    model: resolvedModel,
  });

  // Record context compilation spans
  for (const job of jobs) {
    traceCollector?.record({
      phase: 'context',
      state: 'end',
      spanId: job.event.id,
      eventId: job.event.id,
      durationMs: 0,
    });
  }

  // ── Apply surface plan from config ──────────────────────────────────
  if (data.config?.renderSurface) {
    const contracts = jobs.map((j) => j.contract);
    const renderSurfaceConfig = data.config.renderSurface;
    const plannerMode = renderSurfaceConfig.mode ?? 'manual';
    const plannerOptions: SurfacePlannerOptions = {
      mode: plannerMode,
      branch: branchPath ?? { decisions: [] },
      sceneIds: renderEvents.map((e) => e.id),
      contracts,
      ...(renderSurfaceConfig.groups
        ? {
            authorGroups: renderSurfaceConfig.groups.map((g) => ({
              groupId: g.groupId,
              sceneIds: g.sceneIds,
              surfacePolicy:
                g.surfacePolicy === 'serial_surface'
                  ? { type: 'serial_surface' as const }
                  : g.surfacePolicy === 'fallback_without_surface'
                    ? { type: 'fallback_without_surface' as const }
                    : { type: 'parallel' as const },
            })),
          }
        : {}),
      ...(renderSurfaceConfig.lanes
        ? {
            authorLanes: renderSurfaceConfig.lanes.map((l) => ({
              laneId: l.laneId,
              groupIds: l.groupIds,
            })),
          }
        : {}),
      ...(renderSurfaceConfig.auto
        ? {
            autoConfig: {
              authorized: renderSurfaceConfig.auto.authorized,
              maxParallelGroupSize: renderSurfaceConfig.auto.maxParallelGroupSize,
            },
          }
        : {}),
    };

    try {
      const planner = new SurfacePlanner(plannerOptions);
      const surfacePlan = planner.plan();

      // Persist suggest proposal separately — effective plan remains parallel
      if (plannerMode === 'suggest' && surfacePlan.proposal) {
        const renderPlanDir = path.join(
          projectDir,
          data.config?.outputDir ?? DEFAULT_CONFIG.outputDir,
          'render-plans',
        );
        storage.mkdirp(renderPlanDir);
        const branchScope = opts.discourseBranch ?? 'main';
        const suggestionPath = path.join(renderPlanDir, `${branchScope}.suggestion.json`);
        try {
          storage.write(suggestionPath, JSON.stringify(surfacePlan.proposal, null, 2));
        } catch (writeErr) {
          errors.push(`Failed to write surface suggestion: ${sanitizeError(writeErr)}`);
        }
      }

      // Apply plan to jobs — wires groupId, laneId, predecessorEventId, policy
      applySurfacePlanToJobs(jobs, surfacePlan);
    } catch (err) {
      errors.push(`Surface plan failed: ${(err as Error).message}`);
      return { results: [], errors };
    }
  }

  // ── Resolve subset predecessors before scheduling ───────────────────
  const scopeHash = sourceScopeHash;
  const validationIdentity = aggregator.getValidatorIdentity();
  const extractor = new SurfaceReferenceExtractor(
    data.config?.renderSurface?.extraction?.budget ?? 2000,
  );
  const responseDir = path.join(projectDir, '.nova', 'responses');
  storage.mkdirp(responseDir);
  const currentRunEventIds = new Set(jobs.map((job) => job.event.id));
  const subsetDependentIds = jobs
    .filter((job) => {
      const predecessor = job.surfaceDependency.predecessorEventId;
      return predecessor !== undefined && !currentRunEventIds.has(predecessor);
    })
    .map((job) => job.event.id);
  const { blocked: preBlocked } = materializeSurfacePackets(
    jobs,
    subsetDependentIds,
    new Map(),
    storage,
    projectDir,
    extractor,
    scopeHash,
    currentRunEventIds,
  );
  const preBlockedIds = new Set(preBlocked.map((result) => result.eventId));
  const schedulableJobs = jobs.filter((job) => !preBlockedIds.has(job.event.id));

  // ── Wave-based scheduling via SurfaceScheduler ───────────────────────
  const scheduler = new SurfaceScheduler();
  const wavePlan = scheduler.buildWavePlan(schedulableJobs);
  if (wavePlan.missingPredecessors.length > 0 || wavePlan.cycleParticipants.length > 0) {
    const missing = wavePlan.missingPredecessors
      .map((m) => `${m.eventId} -> ${m.predecessorEventId}`)
      .join(', ');
    const cycles = wavePlan.cycleParticipants.join(', ');
    let msg = 'Surface dependency validation failed:';
    if (wavePlan.missingPredecessors.length > 0) msg += ` missing predecessors: ${missing}`;
    if (wavePlan.cycleParticipants.length > 0) msg += ` cycle participants: ${cycles}`;
    errors.push(msg);
    return { results: [], errors };
  }

  // ── Process waves sequentially, each with independent release gate ──
  let results: RenderSceneResult[] = [...preBlocked];
  const decisions = new Map<string, ReleaseDecision>();
  const acceptedByEventId = new Map<string, AcceptedSceneArtifact>();
  for (const result of preBlocked) {
    const decision = writeSceneResponse(storage, responseDir, result, {
      status: 'blocked',
      scopeHash,
      validationIdentity,
      reasons: [...result.errors],
    });
    decisions.set(result.eventId, decision);
  }

  try {
    for (const wave of wavePlan.waves) {
      // ── Materialize surface packets from accepted current/persisted sources ──
      const { blocked: waveBlocked } = materializeSurfacePackets(
        schedulableJobs,
        wave.eventIds,
        acceptedByEventId,
        storage,
        projectDir,
        extractor,
        scopeHash,
        currentRunEventIds,
      );

      // Collect blocked results immediately — they skip rendering
      for (const br of waveBlocked) {
        results.push(br);
        const decision = writeSceneResponse(storage, responseDir, br, {
          status: 'blocked',
          scopeHash,
          validationIdentity,
          reasons: br.errors.length > 0 ? [...br.errors] : ['MISSING_SURFACE_SOURCE'],
        });
        decisions.set(br.eventId, decision);
      }

      // Filter to jobs that need actual rendering
      const renderedIds = new Set(results.map((r) => r.eventId));
      const waveJobs = schedulableJobs.filter(
        (job) => wave.eventIds.includes(job.event.id) && !renderedIds.has(job.event.id),
      );

      if (waveJobs.length === 0) continue;

      // ── Render this ready wave (batch confined per-wave) ──────────────
      let waveResults: RenderSceneResult[];
      try {
        waveResults = opts.batch
          ? (await new BatchRenderPipeline(pipeline).renderBatched(waveJobs, opts.batch)).results
          : await pipeline.renderAll(waveJobs);
      } catch (err) {
        errors.push(`Wave ${wave.waveIndex} render failed: ${sanitizeError(err)}`);
        continue;
      }

      // ── Release gate + write response per scene ─────────────────────
      for (const r of waveResults) {
        let decision = evaluateReleaseDecision(
          r,
          scopeHash,
          validationIdentity,
          opts.interactionManager,
        );

        decision = writeSceneResponse(storage, responseDir, r, decision);

        decisions.set(r.eventId, decision);
        results.push(r);

        // Collect accepted for subsequent wave packet materialization
        if (decision.status === 'accepted') {
          acceptedByEventId.set(r.eventId, {
            eventId: r.eventId,
            prose: r.prose,
            scopeHash,
            releaseDecision: decision,
          });
        }
      }
    }

    // Completion timing never changes the externally observed render-plan order.
    const resultByEventId = new Map(results.map((result) => [result.eventId, result]));
    results = jobs
      .map((job) => resultByEventId.get(job.event.id))
      .filter((result): result is RenderSceneResult => result !== undefined);

    // ── Output — accepted only ──────────────────────────────────────
    const accepted = results.filter((r) => decisions.get(r.eventId)?.status === 'accepted');
    const blocked = results.filter((r) => decisions.get(r.eventId)?.status === 'blocked');

    if (blocked.length > 0) {
      const diagnostics = blocked.map(buildReleaseDiagnostic);
      errors.push(`Release gate rejected (blocking): ${diagnostics.join('; ')}`);
    }

    if (accepted.length > 0) {
      buildAndWriteOutputs(storage, projectDir, jobs, accepted);
    }

    // Assembly only when ALL required scenes are accepted
    if (accepted.length === renderEvents.length && renderEvents.length === authoredEvents.length) {
      const assembled = assembleNovel({
        projectDir,
        storage,
        branchPath,
        language: data.config?.defaultLanguage ?? 'en',
      });
      const sceneTextCount = accepted.reduce(
        (total, r) => total + countNarrativeText(r.prose, data.config?.defaultLanguage ?? 'en'),
        0,
      );
      if (assembled.wordCount !== sceneTextCount) {
        throw new Error(
          `Assembly text count mismatch: scenes=${sceneTextCount}, novel=${assembled.wordCount}`,
        );
      }
    }
  } catch (err) {
    errors.push(sanitizeError(err));
  }
  // Record output spans (only for events that were rendered)
  for (const result of results) {
    traceCollector?.record({
      phase: 'output',
      state: 'end',
      spanId: result.eventId,
      eventId: result.eventId,
      durationMs: result.renderEnd - result.renderStart,
    });
  }
  // Write trace file (opt-in, errors must not affect release eligibility)
  if (traceCollector) {
    try {
      traceCollector.write(storage, projectDir);
    } catch {
      // trace write errors silently ignored
    }
  }

  // Map to return type — all release fields derive from ReleaseDecision
  const mappedResults = results.map((r) => {
    const d = decisions.get(r.eventId);
    return {
      eventId: r.eventId,
      prose: r.prose,
      wordCount: countNarrativeText(r.prose, data.config?.defaultLanguage ?? 'en'),
      cacheHit: r.cacheHit,
      errors: r.errors,
      analysis: r.analysis,
      released: d ? d.status === 'accepted' : false,
      validationErrors: r.validation?.errors.length ?? 0,
      validationIssueMessages: r.validation?.errors.map((issue) => issue.message) ?? [],
      providerCalls: r.providerCalls,
      promptHash: r.promptHash,
      pass2Rejection: r.pass2Rejection,
      releaseDecision: d ?? null,
    };
  });
  const finalShutdownErrors = pluginHooksManager ? await pluginHooksManager.shutdown() : [];
  errors.push(...finalShutdownErrors);
  return { results: mappedResults, errors };
}

/**
 * Render every authored game-tree node once using its representative complete
 * leaf path, then assemble a linked dialogue-tree document when all nodes pass
 * the release gate.
 */
export async function renderGameDialogueTree(
  opts: RenderGameDialogueTreeOptions,
): Promise<RenderGameDialogueTreeResult> {
  const storage = opts.storage ?? new FsStorage();
  const { data, events, registry } = initializeProject(opts.projectDir, storage);
  const tree = compileGameDialogueTree(
    [...data.chapters.values()].flatMap((chapter) => chapter.events),
    new Map(data.timeAnchors.map((anchor) => [anchor.id, anchor.day])),
  );
  if (!tree) {
    throw new ConfigError('No event-local choices found; render-tree requires a game dialogue tree', {
      phase: 'game_dialogue_tree',
    });
  }
  if (data.config?.renderSurface) {
    return {
      tree,
      results: [],
      errors: ['render-tree does not support renderSurface scheduling.'],
    };
  }
  if (data.discourseLedger?.entries.some((entry) => entry.branch !== 'main')) {
    return {
      tree,
      results: [],
      errors: ['render-tree requires a discourse ledger with only the main branch.'],
    };
  }

  const { initialFacts, authoredEvents, initialThreads } = buildInitialState(events, registry, data);
  const anchors = new Map(data.timeAnchors.map((anchor) => [anchor.id, anchor.day]));
  const stateBeforeByCommonEventId = new Map<string, string>();
  for (const leafPath of tree.leafPaths) {
    const boundaries = compileStoryBoundaries(
      authoredEvents,
      initialFacts,
      anchors,
      leafPath,
      initialThreads,
    );
    for (const [eventId, stateBefore] of boundaries.stateBeforeByEventId) {
      const serialized = canonicalJson(stateBefore);
      const previous = stateBeforeByCommonEventId.get(eventId);
      if (previous !== undefined && previous !== serialized) {
        throw new ConfigError(
          `Game dialogue event '${eventId}' has divergent stateBefore across descendant leaves`,
          { eventId, phase: 'game_dialogue_tree' },
        );
      }
      stateBeforeByCommonEventId.set(eventId, serialized);
    }
  }

  const contentEvents = authoredEvents.filter((event) => event.source === 'event_file');
  const results: RenderNovelResult['results'] = [];
  const errors: string[] = [];
  for (const event of contentEvents) {
    const branchPath = tree.representativePathByEventId.get(event.id);
    if (!branchPath) {
      throw new ConfigError(`Missing representative path for game dialogue event '${event.id}'`, {
        eventId: event.id,
        phase: 'game_dialogue_tree',
      });
    }
    const rendered = await renderNovel({
      ...opts,
      storage,
      eventId: event.id,
      branchPath,
    });
    results.push(...rendered.results);
    errors.push(...rendered.errors.map((error) => `${event.id}: ${error}`));
  }

  let outputPath: string | undefined;
  if (results.length === contentEvents.length && results.every((result) => result.released)) {
    const assembled = assembleGameDialogueTree({
      projectDir: opts.projectDir,
      storage,
      tree,
      eventsById: new Map(contentEvents.map((event) => [event.id, event])),
      chapterByEventId: new Map(
        contentEvents.map((event) => [event.id, findChapterForEvent(data, event.id)]),
      ),
      title: data.config?.title,
    });
    outputPath = assembled?.outputPath;
  }

  return { tree, results, errors, outputPath };
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
