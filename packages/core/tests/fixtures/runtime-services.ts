// ============================================================================
// Test Fixture — Complete CoreRuntimeServices construction
// ============================================================================
// Shared deterministic builder for the frozen runtime contract. It composes
// semantic memory repositories (execution, render cache, state log, state
// snapshots), an in-memory prompt template catalog, a fixed clock, a
// sequential ID generator, and an injected mock LLM — with no MemoryStorage,
// project paths, or Node filesystem.
//
// It also provides JSON-safe record builders and CAS helpers so tests can
// write accepted execution records (and seed the render cache / state repos)
// entirely through the repository ports.
// ============================================================================

import { sha256 } from '../../src/cache/pure-sha256.ts';
import type { LLMProvider } from '../../src/ai/types.ts';
import type { MockPass2Entry } from '../../src/ai/providers/mock-pass2.ts';
import { MockPass2Provider } from '../../src/ai/providers/mock-pass2.ts';
import type { JsonValue } from '../../src/contracts/json.ts';
import type {
  AcceptedSceneRecord,
  CommitResult,
  CoreExecutionRepository,
  OperationRecord,
  PublicationRecord,
  ReviewRecord,
  SceneRevisionRecord,
  TraceRecord,
} from '../../src/ports/execution-repository.ts';
import type { LayeredCacheKey, RenderCacheRecord, RenderCacheRepository } from '../../src/ports/render-cache-repository.ts';
import type { Clock, CoreRuntimeServices, IdGenerator, PromptTemplate, PromptTemplateCatalog } from '../../src/ports/runtime-services.ts';
import type { StateEvent, StateLogRepository, StateSnapshotRecord, StateSnapshotRepository, StateStreamKey } from '../../src/ports/state-repository.ts';
import {
  MemoryExecutionRepository,
  MemoryRenderCacheRepository,
  MemoryStateLogRepository,
  MemoryStateSnapshotRepository,
} from '../../src/testing/memory-repositories.ts';
import type { EditorialRuntime } from '../../src/types/editorial.ts';

// ── Deterministic clock ─────────────────────────────────────────────────────

export const DEFAULT_CLOCK_TIME = '2026-01-01T00:00:00.000Z';

/** A mutable, deterministic ISO-8601 clock. Advancing is explicit. */
export class FixedClock implements Clock {
  private current: string;

  constructor(start: string = DEFAULT_CLOCK_TIME) {
    this.current = start;
  }

  now(): string {
    return this.current;
  }

  set(iso: string): void {
    this.current = iso;
  }

  advanceBy(milliseconds: number): void {
    this.current = new Date(Date.parse(this.current) + milliseconds).toISOString();
  }
}

// ── Deterministic ID generator ──────────────────────────────────────────────

/** Sequential, deterministic IDs: `${kind ?? prefix}-N`. */
export class SequenceIdGenerator implements IdGenerator {
  private nextIndex = 1;
  readonly issued: string[] = [];

  constructor(private readonly prefix = 'id') {}

  next(input?: { readonly kind?: string }): string {
    const base = input?.kind && input.kind.length > 0 ? input.kind : this.prefix;
    const id = `${base}-${this.nextIndex}`;
    this.nextIndex += 1;
    this.issued.push(id);
    return id;
  }
}

// ── In-memory prompt template catalog ───────────────────────────────────────

/** A deterministic PromptTemplateCatalog; `get` returns null for unknown names. */
export class MemoryPromptTemplateCatalog implements PromptTemplateCatalog {
  private readonly templates = new Map<string, PromptTemplate>();

  constructor(templates: readonly PromptTemplate[] = []) {
    for (const template of templates) this.set(template);
  }

  set(template: PromptTemplate): void {
    this.templates.set(this.keyOf(template.name, template.version), template);
  }

  async get(input: { readonly name: string; readonly version?: string }): Promise<PromptTemplate | null> {
    const exact = input.version ? this.keyOf(input.name, input.version) : null;
    const hit = (exact !== null ? this.templates.get(exact) : undefined) ?? this.templates.get(this.keyOf(input.name)) ?? null;
    return hit ? { ...hit } : null;
  }

  private keyOf(name: string, version?: string): string {
    return version === undefined || version.length === 0 ? name : `${name}@${version}`;
  }
}

// ── Record builders (schema-valid JSON-safe values by default) ──────────────

export interface AcceptedSceneInput {
  readonly projectId: string;
  readonly eventId: string;
  readonly sourceHash: string;
  readonly revisionId?: string;
  readonly prose?: string;
  readonly proseHash?: string;
  readonly sceneHash?: string;
  readonly value?: JsonValue;
}

export function acceptedSceneRecord(input: AcceptedSceneInput): AcceptedSceneRecord {
  const prose = input.prose ?? `Rendered prose for ${input.eventId}.`;
  const revisionId = input.revisionId ?? `rev-${input.eventId}`;
  return {
    version: 1,
    projectId: input.projectId,
    eventId: input.eventId,
    sourceHash: input.sourceHash,
    revisionId,
    prose,
    proseHash: input.proseHash ?? sha256(prose),
    sceneHash: input.sceneHash ?? sha256(`${prose}\0${input.sourceHash}`),
    ...(input.value === undefined ? {} : { value: input.value }),
  };
}

export interface SceneRevisionInput {
  readonly projectId: string;
  readonly eventId: string;
  readonly sourceHash: string;
  readonly revisionId?: string;
  readonly parentRevisionId?: string | null;
  readonly value?: JsonValue;
}

export function sceneRevisionRecord(input: SceneRevisionInput): SceneRevisionRecord {
  return {
    version: 1,
    projectId: input.projectId,
    eventId: input.eventId,
    revisionId: input.revisionId ?? `rev-${input.eventId}`,
    parentRevisionId: input.parentRevisionId ?? null,
    sourceHash: input.sourceHash,
    value: input.value ?? {},
  };
}

export interface ReviewInput {
  readonly projectId: string;
  readonly reviewId?: string;
  readonly value?: JsonValue;
}

export function reviewRecord(input: ReviewInput): ReviewRecord {
  return {
    version: 1,
    projectId: input.projectId,
    reviewId: input.reviewId ?? `review-${input.projectId}`,
    value: input.value ?? {},
  };
}

export interface PublicationInput {
  readonly projectId: string;
  readonly sourceHash: string;
  readonly value?: JsonValue;
}

export function publicationRecord(input: PublicationInput): PublicationRecord {
  return { version: 1, projectId: input.projectId, sourceHash: input.sourceHash, value: input.value ?? {} };
}

export interface OperationInput {
  readonly projectId: string;
  readonly operationId: string;
  readonly value?: JsonValue;
}

export function operationRecord(input: OperationInput): OperationRecord {
  return { version: 1, projectId: input.projectId, operationId: input.operationId, value: input.value ?? {} };
}

export interface TraceInput {
  readonly projectId: string;
  readonly operationId: string;
  readonly value?: JsonValue;
}

export function traceRecord(input: TraceInput): TraceRecord {
  return { version: 1, projectId: input.projectId, operationId: input.operationId, value: input.value ?? {} };
}

// ── Accepted execution record writes through repository CAS ─────────────────

function committed<T>(result: CommitResult<T>): T {
  if (result.kind === 'conflict') {
    throw new Error(`Expected committed CAS result, got conflict (expected ${result.expectedVersion}, actual ${result.actualVersion})`);
  }
  return result.value;
}

/** CAS-write an accepted scene, throwing on version conflict, returning the record. */
export async function commitAcceptedScene(execution: CoreExecutionRepository, input: AcceptedSceneInput, expectedVersion: number | null = null): Promise<AcceptedSceneRecord> {
  const value = acceptedSceneRecord(input);
  return committed(await execution.compareAndSwapAcceptedScene({ projectId: value.projectId, eventId: value.eventId, expectedVersion, value }));
}

/** CAS-write a scene revision, throwing on version conflict, returning the record. */
export async function commitSceneRevision(execution: CoreExecutionRepository, input: SceneRevisionInput, expectedVersion: number | null = null): Promise<SceneRevisionRecord> {
  const value = sceneRevisionRecord(input);
  return committed(await execution.compareAndSwapSceneRevision({ projectId: value.projectId, eventId: value.eventId, revisionId: value.revisionId, expectedVersion, value }));
}

/** CAS-write a review record, throwing on version conflict, returning the record. */
export async function commitReview(execution: CoreExecutionRepository, input: ReviewInput, expectedVersion: number | null = null): Promise<ReviewRecord> {
  const value = reviewRecord(input);
  return committed(await execution.compareAndSwapReview({ projectId: value.projectId, reviewId: value.reviewId, expectedVersion, value }));
}

/** CAS-write a publication record, throwing on version conflict, returning the record. */
export async function commitPublication(execution: CoreExecutionRepository, input: PublicationInput, expectedVersion: number | null = null): Promise<PublicationRecord> {
  const value = publicationRecord(input);
  return committed(await execution.compareAndSwapPublication({ projectId: value.projectId, expectedVersion, value }));
}

/** CAS-write an operation record, throwing on version conflict, returning the record. */
export async function commitOperation(execution: CoreExecutionRepository, input: OperationInput, expectedVersion: number | null = null): Promise<OperationRecord> {
  const value = operationRecord(input);
  return committed(await execution.compareAndSwapOperation({ projectId: value.projectId, operationId: value.operationId, expectedVersion, value }));
}

/** CAS-write a trace record, throwing on version conflict, returning the record. */
export async function commitTrace(execution: CoreExecutionRepository, input: TraceInput, expectedVersion: number | null = null): Promise<TraceRecord> {
  const value = traceRecord(input);
  return committed(await execution.compareAndSwapTrace({ projectId: value.projectId, operationId: value.operationId, expectedVersion, value }));
}

// ── Render cache helpers ────────────────────────────────────────────────────

export function layeredCacheKey(sourceHash: string, layers: Readonly<Record<string, string>> = {}): LayeredCacheKey {
  return { version: 1, sourceHash, layers: { ...layers } };
}

export function renderCacheRecord(key: LayeredCacheKey, output: JsonValue, recordHash?: string): RenderCacheRecord {
  return { version: 1, key, recordHash: recordHash ?? sha256(JSON.stringify({ key, output })), output };
}

/** Seed the cache with one derived record (returned for assertions). */
export async function putRenderCacheRecord(cache: RenderCacheRepository, key: LayeredCacheKey, output: JsonValue): Promise<RenderCacheRecord> {
  const record = renderCacheRecord(key, output);
  await cache.put({ key, record });
  return record;
}

// ── State helpers ───────────────────────────────────────────────────────────

export function stateEvent(eventId: string, sequence: number, type: string, payload: JsonValue): StateEvent {
  return { eventId, sequence, type, payload };
}

export function stateSnapshotRecord(key: StateStreamKey, sequence: number, state: JsonValue, options: { readonly schema?: string; readonly schemaVersion?: number; readonly snapshotHash?: string } = {}): StateSnapshotRecord {
  return {
    version: 1,
    key,
    schema: options.schema ?? 'world',
    schemaVersion: options.schemaVersion ?? 1,
    sequence,
    state,
    snapshotHash: options.snapshotHash ?? sha256(JSON.stringify(state)),
  };
}

/** Append contiguous state events at the given expected version, throwing on conflict. */
export async function appendStateEvents(log: StateLogRepository, key: StateStreamKey, expectedVersion: number, events: readonly StateEvent[]): Promise<readonly StateEvent[]> {
  const result = await log.append({ key, expectedVersion, events });
  if (result.kind === 'conflict') {
    throw new Error(`Expected appended state events, got conflict (expected ${result.expectedVersion}, actual ${result.actualVersion})`);
  }
  return result.events;
}

/** CAS-save a state snapshot, throwing on version conflict. */
export async function saveStateSnapshot(snapshots: StateSnapshotRepository, snapshot: StateSnapshotRecord, expectedVersion: number | null = null): Promise<void> {
  const result = await snapshots.save({ snapshot, expectedVersion });
  if (result.kind === 'conflict') {
    throw new Error(`Expected saved state snapshot, got conflict (expected ${result.expectedVersion}, actual ${result.actualVersion})`);
  }
}

// ── Complete runtime services composition ───────────────────────────────────

export interface RuntimeServicesOptions {
  /** LLM provider; overrides `entries`. Defaults to a fresh MockPass2Provider. */
  readonly provider?: LLMProvider;
  /** Pass 2 entries used to build the default MockPass2Provider. */
  readonly entries?: Readonly<Record<string, MockPass2Entry>>;
  /** Shared execution repository (defaults to a fresh MemoryExecutionRepository). */
  readonly execution?: MemoryExecutionRepository;
  /** Shared render cache repository (defaults to a fresh MemoryRenderCacheRepository). */
  readonly renderCache?: MemoryRenderCacheRepository;
  /** Shared state log repository (defaults to a fresh MemoryStateLogRepository). */
  readonly stateLog?: MemoryStateLogRepository;
  /** Shared state snapshot repository (defaults to a fresh MemoryStateSnapshotRepository). */
  readonly stateSnapshots?: MemoryStateSnapshotRepository;
  /** Initial prompt templates for the default catalog. */
  readonly promptTemplates?: readonly PromptTemplate[];
  /** Custom prompt template catalog (overrides `promptTemplates`). */
  readonly promptTemplateCatalog?: MemoryPromptTemplateCatalog;
  /** Fixed clock start time. */
  readonly now?: string;
  /** Custom clock (overrides `now`). */
  readonly clock?: FixedClock;
  /** Custom ID generator (overrides `idPrefix`). */
  readonly ids?: SequenceIdGenerator;
  /** Prefix for the default SequenceIdGenerator. */
  readonly idPrefix?: string;
}

export interface RuntimeServicesHarness {
  /** The frozen CoreRuntimeServices contract. */
  readonly services: CoreRuntimeServices;
  readonly execution: MemoryExecutionRepository;
  readonly renderCache: MemoryRenderCacheRepository;
  readonly stateLog: MemoryStateLogRepository;
  readonly stateSnapshots: MemoryStateSnapshotRepository;
  readonly promptTemplates: MemoryPromptTemplateCatalog;
  readonly clock: FixedClock;
  readonly ids: SequenceIdGenerator;
  readonly provider: LLMProvider;
}

/**
 * Build a complete, deterministic CoreRuntimeServices with semantic memory
 * repositories, an in-memory prompt catalog, a fixed clock, sequential IDs,
 * and an injected mock LLM.
 */
export function createRuntimeServices(options: RuntimeServicesOptions = {}): RuntimeServicesHarness {
  const execution = options.execution ?? new MemoryExecutionRepository();
  const renderCache = options.renderCache ?? new MemoryRenderCacheRepository();
  const stateLog = options.stateLog ?? new MemoryStateLogRepository();
  const stateSnapshots = options.stateSnapshots ?? new MemoryStateSnapshotRepository();
  const promptTemplates = options.promptTemplateCatalog ?? new MemoryPromptTemplateCatalog(options.promptTemplates);
  const clock = options.clock ?? new FixedClock(options.now);
  const ids = options.ids ?? new SequenceIdGenerator(options.idPrefix);
  const provider = options.provider ?? new MockPass2Provider({ entries: options.entries ?? {} });
  const services: CoreRuntimeServices = { execution, renderCache, stateLog, stateSnapshots, promptTemplates, clock, ids, llm: provider };
  return { services, execution, renderCache, stateLog, stateSnapshots, promptTemplates, clock, ids, provider };
}

/** Wrap a harness into the EditorialRuntime accepted by render/preview APIs. */
export function toEditorialRuntime(harness: RuntimeServicesHarness, extra?: Partial<EditorialRuntime>): EditorialRuntime {
  return { services: harness.services, provider: harness.provider, ...extra };
}

/** Count LLM completion calls made through the provider (mutates its `complete`). */
export function trackProviderCalls(provider: LLMProvider): () => number {
  let calls = 0;
  const complete = provider.complete.bind(provider);
  provider.complete = async (request) => {
    calls += 1;
    return complete(request);
  };
  return () => calls;
}
