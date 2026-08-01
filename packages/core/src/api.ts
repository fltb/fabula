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

import type { PreviewResult } from './editorial/index.ts';
// pure-function-like API for CLIs, MCP servers, and external consumers.
// They are the recommended entry point for most use cases.
// ============================================================================
import {
  EditorialOperationError,
  previewEditorialRun as editorialPreviewRun,
  executeEditorialRender,
  executeEditorialTreeRender,
} from './editorial/index.ts';
import {
  editorialPreviewRequestV1Schema,
  editorialRenderRequestV1Schema,
  renderGameDialogueTreeRequestV1Schema,
} from './schemas/editorial.ts';
import type {
  EditorialRenderRequestV1,
  EditorialRuntime,
  RenderGameDialogueTreeRequestV1,
  RenderGameDialogueTreeResult,
  RenderNovelResult,
} from './types/editorial.ts';
// ============================================================================
// Novalistically Core — Orchestration Functions (Public API)
// ============================================================================
//
import type { RelationshipRuntimeState } from './types/index.js';
// ============================================================================

import * as path from 'node:path';
import type { LLMProvider } from './ai/types.ts';
import { DEFAULT_CONFIG } from './config/index.js';
import type { ProjectData } from './entity/index.js';
import type { EntityMapper } from './entity/mapper.ts';
import { compileCanonicalRuntime, loadCanonicalProject } from './entity/project-runtime.ts';
import type { InMemoryEntityRegistry } from './entity/registry.ts';
import { sanitizeError } from './errors.ts';
import { calculateISS } from './iss/score.ts';
import { JsonlLogTransport, LevelFilterTransport, Logger } from './observability/logger.ts';
import type { RenderSceneResult } from './pipeline/render.ts';
import { PluginHooksManager, PluginLoader, ValidatorRegistry } from './plugin/index.js';
import type { PluginContext, ProviderRegistry } from './plugin/types.js';
import { canonicalJson } from './render/scene-contract.ts';
import { resolveDiscourseBranch } from './state/discourse-sequence.ts';
import { StateManager } from './state/manager.ts';
import type { CompiledNarrativeRuntime } from './state/narrative-runtime.ts';
import { FsStorage } from './storage/fs-storage.ts';
import type { Storage } from './storage/types.ts';
import type { BranchPath } from './types/branch.js';
import type {
  EntityDeclarationCatalog,
  EntityKind,
  EntityTypeCatalog,
  Fact,
  ISSSnapshot,
  NarrativeEvent,
  ValidationIssue,
  ValidationResult,
  WorldState,
} from './types/index.ts';
import { ResultAggregator } from './validator/aggregator.ts';

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
 * Load a project through the canonical kernel and return the current
 * repository-facing projection: the mapper/registry that performed the
 * single load, authored events, the canonical catalogs, a StateManager
 * (initialized with runtime events + the kernel's catalog context), the
 * replayed default-branch world state, and the compiled narrative runtime.
 *
 * The third parameter carries inline optional branch/discourse route options.
 * The returned `events` are the authored (renderable) events; synthetic
 * introduction/choice transitions live in `runtimeEvents`/`runtime` only.
 */
export function initializeProject(
  projectDir: string,
  storage: Storage,
  options?: { branchPath?: BranchPath; discourseBranch?: string },
): {
  mapper: EntityMapper;
  data: ProjectData;
  events: NarrativeEvent[];
  runtimeEvents: NarrativeEvent[];
  initialFacts: Fact[];
  entityTypes: EntityTypeCatalog;
  entityDeclarations: EntityDeclarationCatalog;
  registry: InMemoryEntityRegistry;
  stateManager: StateManager;
  state: WorldState;
  runtime: CompiledNarrativeRuntime;
} {
  const ir = loadCanonicalProject(projectDir, storage);
  const runtime = compileCanonicalRuntime(ir, options);
  const stateManager = new StateManager(
    path.join(projectDir, ir.data.config?.outputDir ?? DEFAULT_CONFIG.outputDir, 'snapshots'),
    ir.catalogContext,
    ir.data.config?.snapshotInterval ?? 20,
    storage,
    {
      initialFacts: [...ir.initialFacts],
      initialThreads: [...ir.initialThreads],
      timeAnchors: ir.data.timeAnchors,
    },
  );
  stateManager.initialize([...ir.runtimeEvents]);
  return {
    mapper: ir.mapper,
    data: ir.data,
    events: [...ir.authoredEvents],
    runtimeEvents: [...ir.runtimeEvents],
    initialFacts: [...ir.initialFacts],
    entityTypes: ir.entityTypes,
    entityDeclarations: ir.entityDeclarations,
    registry: ir.registry,
    stateManager,
    state: stateManager.getCurrentState(),
    runtime,
  };
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
 * Run all validators against the project and calculate ISS.
 *
 * Internally: canonical project kernel → compiled runtime boundaries
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
  const ir = loadCanonicalProject(projectDir, resolvedStorage);
  const events = [...ir.authoredEvents];

  // Initialize plugins (if configured)
  const { validatorRegistry, conflictErrors: pluginConflictErrors } = await initializePlugins(
    projectDir,
    resolvedStorage,
    validateLogger,
    ir.data.config ?? undefined,
  );

  const discourseBranch = resolveDiscourseBranch({
    selectedEventIds: new Set(events.map((ev) => ev.id)),
    branchPath: { decisions: [] },
    ledger: ir.data.discourseLedger,
  });
  const runtime = compileCanonicalRuntime(ir, { discourseBranch });
  const boundaries = runtime.boundaries;

  // Run validators with per-event pre-state and plugin validators
  const aggregator = new ResultAggregator(
    undefined,
    validatorRegistry?.validators,
    undefined,
    undefined,
    ir.entityTypes,
  );
  const mergedOverrides = overrides ?? ir.data.config?.validatorOverrides;
  const validationResults = aggregator.validateAll(events, boundaries.finalState, ir.registry, {
    overrides: mergedOverrides,
    stateBeforeByEventId: boundaries.stateBeforeByEventId,
  });

  // Add plugin conflict as synthetic validation failure if present
  if (pluginConflictErrors.length > 0) {
    const syntheticResult: ValidationResult = {
      passed: false,
      errors: pluginConflictErrors.map((msg) => ({
        validator: 'plugin-loader',
        severity: 'error' as const,
        kind: 'compiler_invariant' as const,
        event: '__plugin__',
        entity: '',
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
  const threads = ir.data.worldInitialState?.threads ?? [];
  const iss = calculateISS({
    projectDir,
    entityRegistry: ir.registry,
    events,
    threads: threads.map((t) => ({ id: t.id, name: t.name })),
    rules: ir.data.rules,
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
  const ir = loadCanonicalProject(projectDir, resolvedStorage);
  const events = [...ir.authoredEvents];

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

  const discourseBranch = resolveDiscourseBranch({
    selectedEventIds: new Set(events.map((ev) => ev.id)),
    branchPath: { decisions: [] },
    ledger: ir.data.discourseLedger,
  });
  const runtime = compileCanonicalRuntime(ir, { discourseBranch });
  const boundaries = runtime.boundaries;

  // Use provided validation results or run validateAll
  if (!validationResults) {
    const aggregator = new ResultAggregator(
      undefined,
      undefined,
      undefined,
      undefined,
      ir.entityTypes,
    );
    const overrides = ir.data.config?.validatorOverrides;
    validationResults = aggregator.validateAll(events, boundaries.finalState, ir.registry, {
      overrides,
      stateBeforeByEventId: boundaries.stateBeforeByEventId,
    });
  }

  const eventStatuses: ProjectStatusResult['events'] = [];

  for (const event of events) {
    const chapterNum = ir.chapterByEventId[event.id] ?? 1;

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
 * Uses the canonical compiled runtime for graph-driven state with time anchors.
 */
export function diffEvent(
  projectDir: string,
  eventId: string,
  storage?: Storage,
): DiffResult | null {
  const resolvedStorage = storage ?? new FsStorage();
  const ir = loadCanonicalProject(projectDir, resolvedStorage);
  const events = [...ir.authoredEvents];

  const targetEvent = events.find((e) => e.id === eventId);
  if (!targetEvent) return null;

  const discourseBranch = resolveDiscourseBranch({
    selectedEventIds: new Set(events.map((ev) => ev.id)),
    branchPath: { decisions: [] },
    ledger: ir.data.discourseLedger,
  });
  const runtime = compileCanonicalRuntime(ir, { discourseBranch });
  const boundaries = runtime.boundaries;

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

  // After state: state including the target event from graph-driven boundaries
  const afterState = boundaries.stateAfterByEventId.get(eventId) ?? boundaries.finalState;

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
 * Canonical kernel → InMemoryEntityRegistry → getAll() or findByKind(kind).
 */
export function listEntities(
  projectDir: string,
  kind?: string,
  storage?: Storage,
): Array<{ id: string; kind: string; name?: string }> {
  const resolvedStorage = storage ?? new FsStorage();
  const ir = loadCanonicalProject(projectDir, resolvedStorage);
  // Public API accepts any kind string; findByKind compares by equality,
  // so unknown kinds simply match nothing.
  const entities = kind ? ir.registry.findByKind(kind as EntityKind) : ir.registry.getAll();

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
 * Canonical kernel → InMemoryEntityRegistry → resolve(entityId).
 */
export function showEntity(
  projectDir: string,
  entityId: string,
  storage?: Storage,
): Record<string, unknown> | null {
  const resolvedStorage = storage ?? new FsStorage();
  const ir = loadCanonicalProject(projectDir, resolvedStorage);

  const entity = ir.registry.resolve(entityId);
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
 * Loads both project directories through the canonical kernel (one
 * EntityMapper.loadProject per version) and compares authored events:
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
  const oldIr = loadCanonicalProject(oldPath, new FsStorage());
  const newIr = loadCanonicalProject(newPath, new FsStorage());

  const oldEvents = new Map<string, NarrativeEvent>();
  for (const ev of oldIr.authoredEvents) {
    oldEvents.set(ev.id, ev);
  }

  const newEvents = new Map<string, NarrativeEvent>();
  for (const ev of newIr.authoredEvents) {
    newEvents.set(ev.id, ev);
  }

  // Helper: serialize a precondition or postcondition for comparison
  const preconditionKey = (pc: Fact): string =>
    `${pc.entityId}:${pc.attribute}:${JSON.stringify(pc.value)}:${pc.operator ?? 'eq'}`;
  const postconditionKey = (pc: Fact): string =>
    `${pc.entityId}:${pc.attribute}:${JSON.stringify(pc.value)}:${pc.operation ?? 'set'}`;

  const events: Record<string, ImpactLevel> = {};
  const downstream: Record<string, string[]> = {};

  // Collect which (entityId, attribute) pairs each event's postconditions write to
  const postconditionPairs = new Map<string, Set<string>>();
  for (const [id, ev] of newEvents) {
    const pairs = new Set<string>();
    for (const pc of ev.postconditions) {
      pairs.add(`${pc.entityId}:${pc.attribute}`);
    }
    postconditionPairs.set(id, pairs);
  }

  // Collect which (entityId, attribute) pairs each event's preconditions read
  const preconditionPairs = new Map<string, Set<string>>();
  for (const [id, ev] of newEvents) {
    const pairs = new Set<string>();
    for (const pc of ev.preconditions) {
      pairs.add(`${pc.entityId}:${pc.attribute}`);
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
    const oldPreKeys = new Set(oldEv.preconditions.map(preconditionKey));
    const newPreKeys = new Set(newEv.preconditions.map(preconditionKey));
    const preChanged =
      oldPreKeys.size !== newPreKeys.size || [...oldPreKeys].some((k) => !newPreKeys.has(k));

    // Compare postconditions
    const oldPostKeys = new Set(oldEv.postconditions.map(postconditionKey));
    const newPostKeys = new Set(newEv.postconditions.map(postconditionKey));
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
      JSON.stringify(oldEv.beats) !== JSON.stringify(newEv.beats) ||
      canonicalJson(oldEv.storyTime) !== canonicalJson(newEv.storyTime) ||
      canonicalJson(oldEv.narrationTime) !== canonicalJson(newEv.narrationTime) ||
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
