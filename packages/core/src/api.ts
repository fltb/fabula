// ============================================================================
// Novalistically Core — Orchestration Functions (Public API)
// ============================================================================
//
// These functions wrap the internal stateful classes and provide a clean,
// pure-function-like API for CLIs, MCP servers, and external consumers.
// They are the recommended entry point for most use cases.
// ============================================================================

import * as fs from 'node:fs';
import * as path from 'node:path';

import { EntityMapper } from './entity/mapper.ts';
import { InMemoryEntityRegistry } from './entity/registry.ts';
import { StateManager } from './state/manager.ts';
import { ContextCompiler } from './context/compiler.ts';
import { RenderPipeline, buildAndWriteOutputs } from './pipeline/index.ts';
import type { RenderSceneResult, RenderJob } from './pipeline/render.ts';
import { BatchRenderPipeline } from './batch-renderer.ts';
import type { BatchConfig } from './batch-renderer.ts';
import type { SystemContext } from './types/context.js';
import { ResultAggregator } from './validator/aggregator.ts';
import { calculateISS } from './iss/score.ts';
import { FsStorage } from './storage/fs-storage.ts';
import type { Storage } from './storage/types.ts';
import type { LLMProvider } from './ai/types.ts';
import type {
  AnalysisResult,
  Entity,
  ISSSnapshot,
  NarrativeEvent,
  ValidationResult,
  WorldState,
} from './types/index.ts';

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
  /** Optional batch config for sliding-window batch rendering. */
  batch?: BatchConfig;
}

export interface RenderNovelResult {
  results: Array<{
    eventId: string;
    prose: string;
    wordCount: number;
    cacheHit: boolean;
    errors: string[];
    analysis: AnalysisResult | null;
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
 * Load a project's mapper, data, events, registry, and state manager.
 * This is the common initialization sequence used by most functions.
 */
function initializeProject(projectDir: string): {
  mapper: EntityMapper;
  data: ReturnType<EntityMapper['loadProject']>;
  events: NarrativeEvent[];
  registry: InMemoryEntityRegistry;
  stateManager: StateManager;
  state: WorldState;
} {
  const mapper = new EntityMapper(projectDir);
  const data = mapper.loadProject();
  const events = mapper.loadAllEvents(data.chapters);

  const registry = new InMemoryEntityRegistry();
  registry.load(projectDir);

  const snapshotsDir = path.join(projectDir, '.nova', 'snapshots');
  const stateManager = new StateManager(snapshotsDir);
  for (const event of events) {
    stateManager.commit(event);
  }
  const state = stateManager.getCurrentState();

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
 * Create an LLM provider using AiSdkProvider (Vercel AI SDK).
 * Reads apiKey and baseUrl from parameters or environment variables.
 */
async function createProvider(
  apiKey: string,
  baseUrl?: string,
): Promise<LLMProvider> {
  const { AiSdkProvider } = await import('./ai/providers/ai-sdk.ts');
  return new AiSdkProvider({ apiKey, baseURL: baseUrl });
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
  const { projectDir, model, apiKey, baseUrl, eventId, dryRun } = opts;
  const errors: string[] = [];

  // ── Load project ──────────────────────────────────────────────────
  const { mapper, data, events, registry, stateManager } = initializeProject(projectDir);

  // Determine which events to render
  const renderEvents = !eventId || eventId === 'all'
    ? events.filter((e) => e.id !== 'system:genesis')
    : events.filter((e) => e.id === eventId);

  if (renderEvents.length === 0) {
    errors.push(`No events found to render${eventId ? ` for eventId "${eventId}"` : ''}`);
    return { results: [], errors };
  }

  // Build systemContext from project config (fixes hardcoded 'fantasy' genre bug)
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
      const beforeState = stateManager.getStateAt(ev.narrativeOrder - 1);
      const compiler = new ContextCompiler();
      const pkg = compiler.compile(ev, beforeState, registry, { systemContext: sysCtx });

      const dryRunPath = path.join(dryRunDir, `${ev.id}_prompt.md`);
      fs.writeFileSync(dryRunPath, pkg.markdown, 'utf-8');

      results.push({
        eventId: ev.id,
        prose: '',
        wordCount: 0,
        cacheHit: false,
        errors: [],
        analysis: null,
      });
    }

    return { results, errors: [] };
  }

  // ── Full rendering ────────────────────────────────────────────────
  const resolvedApiKey = apiKey ?? process.env['NOVALISTICALLY_AI_API_KEY'] ?? '';
  if (!resolvedApiKey) {
    errors.push('No API key provided. Set NOVALISTICALLY_AI_API_KEY environment variable or pass apiKey option.');
    return { results: [], errors };
  }
  const resolvedBaseUrl = baseUrl ?? process.env['NOVALISTICALLY_AI_BASE_URL'] ?? undefined;

  let provider: LLMProvider;
  try {
    provider = await createProvider(resolvedApiKey, resolvedBaseUrl);
  } catch (err) {
    errors.push(`Failed to create LLM provider: ${(err as Error).message}`);
    return { results: [], errors };
  }

  const resolvedModel = model ?? data.config?.defaultModel ?? 'claude-sonnet-4-20250514';
  const cacheDir = path.join(projectDir, '.nova', 'render-cache');
  const storage = new FsStorage();

  const pipeline = new RenderPipeline({
    provider,
    model: resolvedModel,
    cacheDir,
    storage,
  });

  // Initialize cache
  const eventsFileMap = buildEventsFileMap(data);
  await pipeline.initCache(eventsFileMap, path.join(projectDir, 'definitions'));

  // Build render jobs
  const jobs: RenderJob[] = [];
  for (const ev of renderEvents) {
    const chapterNum = findChapterForEvent(data, ev.id);
    const beforeState = stateManager.getStateAt(ev.narrativeOrder - 1);
    const compiler = new ContextCompiler();
    const pkg = compiler.compile(ev, beforeState, registry, { systemContext: sysCtx });
    jobs.push({
      event: ev,
      stateBefore: beforeState,
      context: pkg,
      chapter: chapterNum,
    });
  }

  // Render — choose batched or bulk mode
  let results: RenderSceneResult[];
  try {
    if (opts.batch) {
      // Batch mode: sliding-window rendering with progress hooks
      const batchRenderer = new BatchRenderPipeline(pipeline);
      const batchResult = await batchRenderer.renderBatched(jobs, opts.batch);
      results = batchResult.results;
    } else {
      // Original mode: full parallel render
      results = await pipeline.renderAll(jobs);
      // Write outputs (batch mode handles output writing via onAfterBatch hooks)
      buildAndWriteOutputs(storage, projectDir, jobs, results);
    }
  } catch (err) {
    errors.push(`Render failed: ${(err as Error).message}`);
    return { results: [], errors };
  }

  // Map to return type
  const mappedResults = results.map((r) => ({
    eventId: r.eventId,
    prose: r.prose,
    wordCount: r.prose.split(/\s+/).filter(Boolean).length,
    cacheHit: r.cacheHit,
    errors: r.errors,
    analysis: r.analysis,
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
  const { data, events, registry, state } = initializeProject(projectDir);

  // Run validators
  const aggregator = new ResultAggregator();
  const mergedOverrides = overrides ?? data.config?.validatorOverrides;
  const validationResults = aggregator.validateAll(events, state, registry, mergedOverrides);

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
 */
export function getProjectStatus(projectDir: string): ProjectStatusResult {
  const { data, events, registry, state } = initializeProject(projectDir);

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

  // Validate to determine blocked events
  const aggregator = new ResultAggregator();
  const overrides = data.config?.validatorOverrides;
  const validationResults = aggregator.validateAll(events, state, registry, overrides);

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

  // Thread progress
  const threads: ProjectStatusResult['threads'] = [];
  for (const [threadId, threadData] of Object.entries(state.threads)) {
    threads.push({
      id: threadId,
      progress: threadData.progress,
      total: threadData.total,
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
 * EntityMapper → StateManager → getStateAt(narrativeOrder-1) vs getStateAt(narrativeOrder).
 */
export function diffEvent(
  projectDir: string,
  eventId: string,
): DiffResult | null {
  const { data, events, registry, stateManager } = initializeProject(projectDir);

  const targetEvent = events.find((e) => e.id === eventId);
  if (!targetEvent) return null;

  const beforeState = stateManager.getStateAt(targetEvent.narrativeOrder - 1);
  const afterState = stateManager.getStateAt(targetEvent.narrativeOrder);

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
    const br = beforeState.relationships[relId];
    const ar = afterState.relationships[relId];
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
