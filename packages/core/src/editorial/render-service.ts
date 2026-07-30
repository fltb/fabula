// ============================================================================
// Editorial Render Service — Compile → Claim → Materialize → Execute →
//                             Promote → Publish orchestration.
//
// Pipeline stages:
//   1. COMPILE  — pure compileEditorialRun (selector preflight, identity,
//                 branch contracts, plan hash, read set)
//   2. CLAIM    — OperationStore.register (idempotent by request hash)
//   3. PREFLIGHT — provider requirement, selector errors, revision errors,
//                 abort signal check
//   4. MATERIALIZE — load project, build RenderJob[], wire surface deps
//   5. EXECUTE  — wave-based RenderPipeline::renderAll with heartbeat,
//                 progress events, AbortSignal
//   6. PROMOTE  — archive candidates, update latest (CAS), track heads
//   7. PUBLISH  — buildAndWriteOutputs, finalize operation
//
// All storage writes use ProjectTransactionCoordinator transactions.
// Provider resolution: runtime.provider > runtime.providerFactory > lazy config.
// ============================================================================

import * as crypto from 'node:crypto';
import * as path from 'node:path';
import YAML from 'yaml';
import { AiSdkProvider } from '../ai/index.ts';
import type { LLMProvider } from '../ai/types.ts';
import { assembleGameDialogueTree } from '../assembler/game-dialogue-tree.ts';
import { BatchRenderPipeline } from '../batch-renderer.ts';
import type { CompiledGameDialogueTree } from '../branch/game-dialogue-tree.ts';
import { compileGameDialogueTree } from '../branch/game-dialogue-tree.ts';
import { includesPath } from '../branch/set.ts';
import { computeSourceContentHash } from '../cache/render-cache.ts';
import { ContextCompiler } from '../context/compiler.ts';
import { PromptAssembler } from '../context/prompt-assembler.ts';
import { loadProjectConfig, resolveTemporalContext, type ProjectData } from '../entity/index.js';
import { EntityMapper } from '../entity/mapper.ts';
import { InMemoryEntityRegistry } from '../entity/registry.ts';
import { ConfigError, sanitizeError } from '../errors.ts';
import type { TypedEventBus } from '../event-bus.ts';
import { JsonlLogTransport, LevelFilterTransport, Logger } from '../observability/logger.ts';
import { TraceCollector } from '../observability/trace.ts';
import {
  AcceptedArtifactResolver,
  evaluateReleaseDecision,
  type ProviderCallLedgerEntry,
  type RenderJob,
  RenderPipeline,
  type RenderSceneResult,
  SurfaceScheduler,
} from '../pipeline/index.ts';
import { appendPlayerChoicesBlock } from '../pipeline/output.ts';
import { PluginHooksManager, PluginLoader, ValidatorRegistry } from '../plugin/index.js';
import type { PluginContext, ProviderRegistry } from '../plugin/types.ts';
import { canonicalJson, compileSceneContract, computeSha256Hex } from '../render/scene-contract.ts';
import { SurfacePlanner } from '../render/surface-planner.ts';
import { ReviewManager } from '../review/manager.ts';
import {
  editorialProgressEventV1Schema,
  sceneMetadataV1Schema,
  sceneRevisionEnvelopeV1Schema,
} from '../schemas/editorial.ts';
import type { CompiledDiscourseRenderContext } from '../state/discourse-context.ts';
import type { StoryBoundaries } from '../state/index.ts';
import { compileDiscourseSceneSequence, resolveDiscourseBranch } from '../state/discourse-sequence.ts';
import type { CompiledNarrativeRuntime } from '../state/narrative-runtime.ts';
import { compileNarrativeRuntime } from '../state/narrative-runtime.ts';
import { FsStorage } from '../storage/fs-storage.ts';
import {
  computeContentHash,
  computeDirectoryManifestHash,
  computeFileHash,
} from '../storage/hash.ts';
import type { Storage, TransactionReadExpectation } from '../storage/types.ts';
import { LogicalDisclosureSummaryCompiler, SurfaceReferenceExtractor } from '../summary/index.ts';
import type { BranchPath, BranchSet } from '../types/branch.ts';
import type { SystemContext } from '../types/context.ts';
import type {
  Clock,
  EditorialError,
  EditorialErrorCode,
  EditorialOperationV1,
  EditorialPlanSummaryV1,
  EditorialProgressEventV1,
  EditorialRenderRequestV1,
  EditorialRuntime,
  ProviderCallLedgerEntryV1,
  ProviderFactory,
  PublicationManifestV1,
  PublicationResult,
  RenderGameDialogueTreeRequestV1,
  RenderGameDialogueTreeResult,
  RenderNovelResult,
  RenderNovelSceneResult,
  RevisionRequest,
  SceneActionResult,
  SceneDisposition,
  SceneRevisionEnvelopeV1,
  SceneRevisionOrigin,
} from '../types/editorial.ts';
import type { EventFile, Fact, NarrativeEvent, ReleaseDecision } from '../types/index.ts';
import type {
  AcceptedSceneArtifact,
  RenderGroup,
  RevisionContext,
  SurfacePlannerOptions,
  SurfacePlanResult,
} from '../types/render-surface.ts';
import type { ReviewComment } from '../types/review.ts';
import { type AnalysisContract, ResultAggregator } from '../validator/aggregator.ts';
import {
  compileEditorialRun,
  type EditorialCompileInput,
  type EditorialCompileOutput,
  inlineInstructionFeedbackProjection,
  reviewFeedbackProjection,
  sortReviewFeedback,
} from './compiler.ts';
import { EditorialOperationError, PublicationError, toEditorialError } from './errors.ts';
import {
  BUILT_IN_VALIDATOR_IMPLEMENTATION_VERSION,
  type ValidationIdentityInput,
} from './identity.ts';
import { OperationStore } from './operation-store.ts';
import { type ProjectPaths, resolveProjectPaths } from './paths.ts';
import {
  buildNovelDocument,
  EditorialPublisher,
  type PromoteCandidateInput,
  type ScopeEventData,
  type VerifiedHeadData,
} from './publisher.ts';
import { SceneRevisionStore } from './scene-store.ts';
import type { SceneCatalog } from './selector.ts';
import { SourceRevisionStore } from './source-store.ts';
import { ProjectTransactionCoordinator } from './transaction.ts';

// ============================================================================
// Internal clock
// ============================================================================

const REAL_CLOCK: Clock = { now: () => Date.now() };

// ============================================================================
// Operation-local progress event emitter factory
// ============================================================================

type ProgressEventInput = Omit<
  EditorialProgressEventV1,
  'version' | 'operationId' | 'sequence' | 'timestamp'
>;

interface ProgressEmitter {
  (event: ProgressEventInput): void;
  prepareTerminal(event: ProgressEventInput): () => void;
}

function createProgressEmitter(
  eventBus: TypedEventBus | undefined,
  operationId: string,
  store: OperationStore,
  workerId: string,
): ProgressEmitter {
  let sequence = 0;
  const prepare = (event: ProgressEventInput): EditorialProgressEventV1 => {
    sequence++;
    const payload: EditorialProgressEventV1 = {
      version: 1,
      operationId,
      sequence,
      timestamp: new Date().toISOString(),
      ...event,
    };
    return editorialProgressEventV1Schema.parse(JSON.parse(JSON.stringify(payload)));
  };
  const emit = (event: ProgressEventInput): void => {
    const payload = prepare(event);
    store.checkpointSequence(operationId, workerId, payload.sequence);
    eventBus?.emit('editorial:progress', payload);
  };
  return Object.assign(emit, {
    prepareTerminal(event: ProgressEventInput): () => void {
      const payload = prepare(event);
      store.checkpointSequence(operationId, workerId, payload.sequence);
      return () => eventBus?.emit('editorial:progress', payload);
    },
  });
}

// ============================================================================
// withOperationLease — bounded heartbeat scope
// ============================================================================

/**
 * Execute an async function within a bounded operation lease. A periodic
 * heartbeat runs during the scope, keeping the operation lease alive. When
 * the scope exits (success or error), the heartbeat interval is cleared and
 * any in-flight heartbeat is awaited. The `stopped` guard prevents late
 * heartbeats after scope end. Terminal finalization (succeed/fail/cancel)
 * must happen AFTER the lease scope ends.
 */
async function withOperationLease<T>(
  operationId: string,
  workerId: string,
  store: Pick<OperationStore, 'heartbeat'>,
  leaseAbortController: AbortController,
  fn: () => Promise<T>,
): Promise<T> {
  let stopped = false;
  let inflight: Promise<void> | undefined;
  let heartbeatError: unknown;
  const heartbeatIntervalMs = 5 * 60_000;

  const beat = async (): Promise<void> => {
    if (stopped) return;
    if (heartbeatError !== undefined) throw heartbeatError;
    try {
      await store.heartbeat(operationId, workerId);
    } catch (error) {
      heartbeatError = error;
      leaseAbortController.abort(error);
      throw error;
    }
  };

  const interval = setInterval(() => {
    const heartbeat = beat();
    inflight = heartbeat;
    heartbeat.catch(() => {});
  }, heartbeatIntervalMs);

  let result: T | undefined;
  let functionError: unknown;
  try {
    await beat();
    result = await fn();
  } catch (error) {
    functionError = error;
  } finally {
    stopped = true;
    clearInterval(interval);
    if (inflight) await inflight.catch(() => {});
  }

  if (heartbeatError !== undefined) throw heartbeatError;
  if (functionError !== undefined) throw functionError;
  return result as T;
}

// ============================================================================
// Publication manifest helpers
// ============================================================================

function loadOrCreatePublication(storage: Storage, pubPath: string): PublicationManifestV1 {
  const raw = storage.readOptional(pubPath);
  if (raw !== null) {
    try {
      return JSON.parse(raw) as PublicationManifestV1;
    } catch {
      // malformed — reset
    }
  }
  return {
    version: 1,
    status: 'stale',
    branch_scope_hash: '',
    novel_hash: null,
    revision_ids: {},
    last_assembled_at: null,
    active_operation_id: '',
    reasons: [],
  };
}

function fileExpectation(storage: Storage, filePath: string): TransactionReadExpectation {
  return {
    kind: 'file',
    path: filePath,
    expectedHash: computeFileHash(storage, filePath),
  };
}

function directoryExpectation(storage: Storage, directoryPath: string): TransactionReadExpectation {
  return {
    kind: 'directory',
    path: directoryPath,
    expectedManifestHash: computeDirectoryManifestHash(storage, directoryPath),
  };
}

function dedupeReadSet(
  expectations: readonly TransactionReadExpectation[],
): TransactionReadExpectation[] {
  const deduped = new Map<string, TransactionReadExpectation>();
  for (const expectation of expectations) {
    const key = `${expectation.kind}:${expectation.path}`;
    const previous = deduped.get(key);
    if (previous && canonicalJson(previous) !== canonicalJson(expectation)) {
      throw new EditorialOperationError(
        'REVISION_STALE',
        `Conflicting pre-evaluation expectations for ${expectation.path}`,
        { path: expectation.path },
      );
    }
    deduped.set(key, expectation);
  }
  return [...deduped.values()].sort(
    (left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind),
  );
}

function capturePublicationReadSet(
  storage: Storage,
  paths: ProjectPaths,
  init: Pick<ProjectInitialization, 'data' | 'chapterByEventId'>,
  scopeEventIds: readonly string[],
): TransactionReadExpectation[] {
  const expectations: TransactionReadExpectation[] = [
    fileExpectation(storage, path.join(paths.projectDir, 'nova.yaml')),
    fileExpectation(storage, paths.sourceHeadPath),
    fileExpectation(storage, paths.reviewLedgerPath),
    fileExpectation(storage, paths.publicationPath),
    fileExpectation(storage, paths.novelPath),
    directoryExpectation(storage, path.join(paths.projectDir, 'definitions')),
    directoryExpectation(storage, path.join(paths.projectDir, 'chapters')),
    directoryExpectation(storage, path.join(paths.workDir, 'locks')),
  ];
  if (init.data.config?.plugins?.enabled) {
    expectations.push(
      directoryExpectation(
        storage,
        path.join(paths.projectDir, init.data.config.plugins.directory ?? 'plugins'),
      ),
    );
  }
  for (const name of ['threads.yaml', 'foreshadowing.yaml', 'relationships.yaml', 'rules.yaml']) {
    expectations.push(fileExpectation(storage, path.join(paths.derivedDir, name)));
  }
  for (const eventId of scopeEventIds) {
    const chapter = init.chapterByEventId[eventId] ?? 1;
    const sceneDir = path.join(paths.scenesDir, `chapter-${String(chapter).padStart(2, '0')}`);
    const metadataPath = path.join(sceneDir, `${eventId}.yaml`);
    const metadataRaw = storage.readOptional(metadataPath);
    expectations.push(
      fileExpectation(storage, metadataPath),
      fileExpectation(storage, path.join(sceneDir, `${eventId}.md`)),
      fileExpectation(storage, path.join(paths.workDir, 'locks', `${eventId}.lock`)),
      fileExpectation(storage, path.join(sceneDir, `${eventId}_render_request.yaml`)),
    );
    if (metadataRaw !== null) {
      try {
        const metadata = sceneMetadataV1Schema.safeParse(YAML.parse(metadataRaw));
        if (metadata.success && metadata.data.event === eventId) {
          expectations.push(
            fileExpectation(
              storage,
              path.join(paths.sceneRevisionsDir, eventId, `${metadata.data.revision_id}.json`),
            ),
          );
        }
      } catch {
        // The exact malformed metadata bytes remain in the read set. Head
        // verification later rejects them without losing conflict detection.
      }
    }
  }
  return dedupeReadSet(expectations);
}

function expectedFileHash(
  readSet: readonly TransactionReadExpectation[] | undefined,
  filePath: string,
): string | null {
  const expectation = readSet?.find(
    (candidate) => candidate.kind === 'file' && candidate.path === filePath,
  );
  if (expectation?.kind !== 'file') {
    throw new EditorialOperationError(
      'REVISION_STALE',
      `Missing pre-evaluation expectation for ${filePath}`,
      { path: filePath },
    );
  }
  return expectation.expectedHash;
}

// ============================================================================
// Provider resolution
// ============================================================================

async function _resolveProvider(
  runtime: EditorialRuntime,
  model: string | undefined,
  projectDir: string,
  storage: Storage,
  _eventBus: TypedEventBus | undefined,
): Promise<LLMProvider | null> {
  if (runtime.provider) return runtime.provider;
  if (runtime.providerFactory) return runtime.providerFactory.create();

  // Lazy config: check project config for model/apiKey/baseUrl
  const _novaRaw = storage.readOptional(path.join(projectDir, 'nova.yaml'));
  let resolvedModel = model;
  const apiKey = process.env.NOVALISTICALLY_AI_API_KEY ?? '';
  const baseUrl: string | undefined = process.env.NOVALISTICALLY_AI_BASE_URL ?? undefined;

  // Try to read config for defaults
  if (!resolvedModel) {
    resolvedModel = process.env.NOVALISTICALLY_AI_MODEL ?? undefined;
  }

  if (!resolvedModel) return null;
  if (!apiKey) return null;

  try {
    return new AiSdkProvider({
      apiKey,
      baseURL: baseUrl,
      model: resolvedModel,
    });
  } catch {
    return null;
  }
}

// ============================================================================
// Full project data loader (from initializeProject pattern)
// ============================================================================

interface ProjectInitialization {
  data: ProjectData;
  events: NarrativeEvent[];
  registry: InMemoryEntityRegistry;
  mapper: EntityMapper;
  sourceHeadHash: string | null;
  latestRevisions: Record<string, { revisionId: string; proseHash: string } | null>;
  eventContents: Record<string, string>;
  sourceDocumentContents: Record<string, string>;
  catalog: SceneCatalog;
  chapterByEventId: Record<string, number>;
}

function readAcceptedHeadEnvelope(
  storage: Storage,
  paths: ProjectPaths,
  eventId: string,
  chapter: number,
): SceneRevisionEnvelopeV1 | null {
  const metadataPath = path.join(
    paths.scenesDir,
    `chapter-${String(chapter).padStart(2, '0')}`,
    `${eventId}.yaml`,
  );
  const metadataRaw = storage.readOptional(metadataPath);
  if (metadataRaw === null) return null;

  try {
    const metadataResult = sceneMetadataV1Schema.safeParse(YAML.parse(metadataRaw));
    if (!metadataResult.success || metadataResult.data.event !== eventId) return null;
    const metadata = metadataResult.data;
    const revisionPath = path.join(
      paths.sceneRevisionsDir,
      eventId,
      `${metadata.revision_id}.json`,
    );
    const revisionRaw = storage.readOptional(revisionPath);
    if (revisionRaw === null) return null;
    const envelopeResult = sceneRevisionEnvelopeV1Schema.safeParse(JSON.parse(revisionRaw));
    if (!envelopeResult.success) return null;
    const envelope = envelopeResult.data as SceneRevisionEnvelopeV1;
    if (
      envelope.eventId !== eventId ||
      envelope.revisionId !== metadata.revision_id ||
      envelope.releaseDecision.status !== 'accepted' ||
      !envelope.released ||
      envelope.proseHash !== metadata.prose_hash ||
      envelope.sceneHash !== metadata.scene_hash ||
      envelope.editorialBasisHash !== metadata.editorial_basis_hash ||
      envelope.scopeHash !== metadata.scope_hash ||
      envelope.validationIdentity !== metadata.validation_identity ||
      computeContentHash(envelope.prose) !== envelope.proseHash
    ) {
      return null;
    }
    return envelope;
  } catch {
    return null;
  }
}

function loadProjectData(
  storage: Storage,
  projectDir: string,
  _branchPath: BranchPath | undefined,
  paths: ProjectPaths,
): ProjectInitialization {
  const mapper = new EntityMapper(projectDir, storage);
  const data = mapper.loadProject();
  const registry = new InMemoryEntityRegistry();
  registry.load(projectDir, storage);

  // Load all event files and map to NarrativeEvent
  const allEventFiles = [...data.chapters.values()].flatMap(
    (ch: { events: EventFile[] }) => ch.events,
  );
  const events: NarrativeEvent[] = allEventFiles.map((ef: EventFile) =>
    mapper.mapToNarrativeEvent(ef),
  );

  // Event contents for compiler
  const eventContents: Record<string, string> = {};
  const chapterByEventId: Record<string, number> = {};
  for (const [chapterNum, chapterData] of data.chapters) {
    for (const ef of chapterData.events) {
      if (ef.filePath) {
        try {
          eventContents[ef.event] = storage.read(ef.filePath);
        } catch {
          eventContents[ef.event] = '';
        }
      }
      chapterByEventId[ef.event] = chapterNum;
    }
  }

  // Source document contents
  const sourceDocumentContents: Record<string, string> = {};
  const sourcePaths: string[] = [];
  // Collect definition files
  const defDir = path.join(projectDir, 'definitions');
  if (storage.exists(defDir)) {
    const entries = storage.list(defDir);
    for (const entry of entries) {
      if (entry.isFile()) {
        const fullPath = path.join(defDir, entry.name);
        sourcePaths.push(fullPath);
      }
    }
    // Check subdirectories
    const subDirs = [
      'characters',
      'locations',
      'items',
      'factions',
      'relationships',
      'rules',
      'narrators',
      'assertions',
    ];
    for (const subDir of subDirs) {
      const subPath = path.join(defDir, subDir);
      if (storage.exists(subPath)) {
        const subEntries = storage.list(subPath);
        for (const entry of subEntries) {
          if (entry.isFile()) {
            sourcePaths.push(path.join(subPath, entry.name));
          }
        }
      }
    }
  }
  for (const srcPath of sourcePaths) {
    try {
      sourceDocumentContents[srcPath] = storage.read(srcPath);
    } catch {
      // skip unreadable
    }
  }

  // Catalog: all event_file events in narrative order
  const contentEvents = events.filter((ev) => ev.source === 'event_file');
  const catalogEvents = contentEvents
    .filter((ev) => ev.narrativeOrder != null)
    .sort((a, b) => (a.narrativeOrder ?? 0) - (b.narrativeOrder ?? 0))
    .map((ev) => ({
      eventId: ev.id,
      narrativeOrder: ev.narrativeOrder ?? 0,
      chapter: chapterByEventId[ev.id] ?? 1,
    }));
  const catalog: SceneCatalog = { events: Object.freeze(catalogEvents) };

  // Compiler identity is based on the materialized accepted head, never the
  // latest blocked or pending candidate.
  const latestRevisions: Record<string, { revisionId: string; proseHash: string } | null> = {};
  for (const event of contentEvents) {
    const acceptedHead = readAcceptedHeadEnvelope(
      storage,
      paths,
      event.id,
      chapterByEventId[event.id] ?? 1,
    );
    latestRevisions[event.id] = acceptedHead
      ? { revisionId: acceptedHead.revisionId, proseHash: acceptedHead.proseHash }
      : null;
  }

  // Source head hash — use configured sourceHeadPath
  let sourceHeadHash: string | null = null;
  if (storage.exists(paths.sourceHeadPath)) {
    try {
      const head = JSON.parse(storage.read(paths.sourceHeadPath));
      sourceHeadHash = head.projectSourceHash ?? null;
    } catch {
      sourceHeadHash = null;
    }
  }

  return {
    data,
    events,
    registry,
    mapper,
    sourceHeadHash,
    latestRevisions,
    eventContents,
    sourceDocumentContents,
    catalog,
    chapterByEventId,
  };
}

// ============================================================================
// Extract review comments from project
// ============================================================================

function loadReviewComments(
  storage: Storage,
  coordinator: ProjectTransactionCoordinator,
  paths: ProjectPaths,
): readonly ReviewComment[] {
  const mgr = new ReviewManager(storage, coordinator, paths.reviewLedgerPath);
  const snapshot = mgr.readLedger();
  return snapshot.ledger.comments;
}
function computeRequiresProviderByEventId(
  events: readonly NarrativeEvent[],
  request: Omit<EditorialRenderRequestV1, 'mutation'>,
  data: ProjectData,
): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const event of events) {
    result[event.id] = Boolean(
      request.revision || request.model || request.providerProfile || data.config?.defaultModel,
    );
  }
  return result;
}

interface ValidationRuntime {
  aggregator: ResultAggregator;
  overrides: Record<string, 'off' | 'warning' | 'error'>;
  analysisContract: AnalysisContract;
  identityInput: ValidationIdentityInput;
  pluginHooksManager?: PluginHooksManager;
}

async function createValidationRuntime(
  data: ProjectData,
  projectDir: string,
  storage: Storage,
): Promise<ValidationRuntime> {
  const overrides = { ...(data.config?.validatorOverrides ?? {}) };
  const validatorRegistry = new ValidatorRegistry();
  const pluginLoader = new PluginLoader(storage);
  let pluginHooksManager: PluginHooksManager | undefined;

  if (data.config?.plugins?.enabled) {
    const hooks = await pluginLoader.loadFromDirectory(
      path.join(projectDir, data.config.plugins.directory ?? 'plugins'),
    );
    const conflicts = pluginLoader.detectConflicts();
    if (conflicts.length > 0) {
      throw new ConfigError(
        conflicts
          .map((conflict) => `${conflict.pluginA} vs ${conflict.pluginB}: ${conflict.reason}`)
          .join('; '),
        { phase: 'plugin_initialization' },
      );
    }

    const providers = new Map<string, LLMProvider>();
    const providerRegistry: ProviderRegistry = {
      register(name, provider): void {
        providers.set(name, provider);
      },
      getProvider(name): LLMProvider | undefined {
        return providers.get(name);
      },
    };
    const pluginContext: PluginContext = {
      projectDir,
      storage,
      log: new Logger(undefined, { module: 'editorial-validation' }),
    };
    pluginHooksManager = new PluginHooksManager(pluginContext, validatorRegistry, providerRegistry);
    for (const hook of hooks) pluginHooksManager.register(hook);
    await pluginHooksManager.initialize();
  }

  const aggregator = new ResultAggregator(undefined, validatorRegistry.validators);
  const analysisContract = aggregator.getAnalysisContract(overrides);
  const registeredValidators = new Map(
    validatorRegistry.validators.map((validator) => [validator.name, validator]),
  );
  const hookIdentities = new Map(
    (pluginHooksManager?.getPluginIdentities() ?? []).map((identity) => [identity.name, identity]),
  );
  const plugins = pluginLoader.list().map((manifest) => {
    const hookIdentity = hookIdentities.get(manifest.name);
    return {
      name: manifest.name,
      version: manifest.version,
      validators: (hookIdentity?.validators ?? []).map((name) => ({
        name,
        version: registeredValidators.get(name)?.version ?? manifest.version,
      })),
      promptHookIdentity: computeSha256Hex(canonicalJson(hookIdentity?.hooks ?? [])),
    };
  });

  return {
    aggregator,
    overrides,
    analysisContract,
    ...(pluginHooksManager ? { pluginHooksManager } : {}),
    identityInput: {
      analysisContractHash: analysisContract.hash,
      builtInValidatorImplementationVersion: BUILT_IN_VALIDATOR_IMPLEMENTATION_VERSION,
      effectiveOverrides: overrides,
      validators: aggregator.listValidatorIdentities(BUILT_IN_VALIDATOR_IMPLEMENTATION_VERSION),
      plugins,
    },
  };
}

// ============================================================================
// Build compile input from project data + request
// ============================================================================

function buildCompileInput(
  init: ProjectInitialization,
  request: Omit<EditorialRenderRequestV1, 'mutation'>,
  reviewComments: readonly ReviewComment[],
  requiresProviderByEventId: Record<string, boolean>,
  validation: ValidationIdentityInput,
  paths: ProjectPaths,
): EditorialCompileInput {
  return {
    request: {
      version: 1,
      projectDir: request.projectDir,
      selector: request.selector,
      revision: request.revision
        ? { reviewIds: request.revision.reviewIds, instruction: request.revision.instruction }
        : undefined,
      model: request.model,
      providerProfile: request.providerProfile,
      branchPath: request.branchPath,
      discourseBranch: request.discourseBranch,
      waivers: request.waivers,
      batch: request.batch,
      maxRounds: request.maxRounds,
    },
    catalog: init.catalog,
    eventContents: init.eventContents,
    sourceDocumentContents: init.sourceDocumentContents,
    sourceHeadHash: init.sourceHeadHash,
    latestRevisions: init.latestRevisions,
    validation,
    reviewComments,
    chapterByEventId: init.chapterByEventId,
    requiresProviderByEventId,
    responsesDir: paths.responsesDir,
    sourceHeadPath: paths.sourceHeadPath,
  };
}

// ============================================================================
// Build RenderJob[] from compiled plan + initialised project data
// ============================================================================

function buildRenderJobs(
  plan: EditorialCompileOutput,
  init: ProjectInitialization,
  request: Omit<EditorialRenderRequestV1, 'mutation'>,
  sourceContentHash: string,
  model: string,
  runtime: CompiledNarrativeRuntime,
): RenderJob[] {
  const jobs: RenderJob[] = [];
  const branchPath = request.branchPath;
  const data = init.data;

  // Use pre-compiled context from the single narrative runtime.
  const boundaries = runtime.boundaries;
  const discourseContextByEventId = runtime.discourseContextsByEventId;
  const techniquesByEventId = runtime.graphs.techniquesByEventId;

  // Canonical graph hash from both sub-graphs for render cache identity.
  const graphHash = computeSha256Hex(
    canonicalJson({
      story: runtime.graphs.storyGraph.hash,
      discourse: runtime.graphs.discourseGraph.hash,
    }),
  );

  const renderEvents = init.events.filter(
    (ev) => ev.source === 'event_file' && plan.selectedEventIds.includes(ev.id),
  );

  const sysCtx: SystemContext = {
    genre: data.config?.genre ?? 'literary',
    style: 'literary',
    narrativeRules: [],
    thematicIntent: data.config?.ideaIR?.thematicIntent,
    synopsis: data.config?.synopsis,
  };

  const disclosureCompiler = new LogicalDisclosureSummaryCompiler();

  for (const ev of renderEvents) {
    const compileJob = plan.jobs.find((j) => j.eventId === ev.id);
    if (!compileJob?.requiresProvider) continue;

    const discourseCtx = discourseContextByEventId[ev.id];
    const chapterNum = init.chapterByEventId[ev.id] ?? 1;
    const beforeState = boundaries.stateBeforeByEventId.get(ev.id);
    if (!beforeState) continue;

    const emotionalBeat = ev.arcPosition
      ? data.config?.ideaIR?.emotionalArc?.emotionalBeats.find(
          (beat) => beat.position === ev.arcPosition,
        )?.emotion
      : undefined;

    const narrativeTechniques = techniquesByEventId.get(ev.id) ?? [];
    const compiler = new ContextCompiler();
    const pkg = compiler.compile(ev, beforeState, init.registry, {
      systemContext: sysCtx,
      narratorProfiles: data.narratorProfiles,
      discourseContext: discourseCtx,
      emotionalBeat,
      narrativeTechniques,
    });

    const worldStateHash = computeSha256Hex(canonicalJson(beforeState));
    const knowledgeStateHash = computeSha256Hex(canonicalJson(beforeState.knowledge));
    const narratorProfileHash = computeSha256Hex(canonicalJson(data.narratorProfiles));
    const plannedDiscourseHash = discourseCtx
      ? computeSha256Hex(`${discourseCtx.ledgerHash}|${discourseCtx.assertionCatalogHash}`)
      : '';
    const catalogHash =
      data.narratorAssertions && Object.keys(data.narratorAssertions).length > 0
        ? computeSha256Hex(canonicalJson(Object.keys(data.narratorAssertions).sort()))
        : undefined;

    const sceneTransition: 'continuous' | 'flashback' | 'time_jump' | 'hard_cut' =
      ev.sceneType === 'linear'
        ? 'continuous'
        : ev.sceneType === 'flashback'
          ? 'flashback'
          : ev.sceneType === 'flashforward'
            ? 'time_jump'
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
      graphHash,
      sourceContentHash,
      logicalDisclosureSummary,
      surfaceDependency: {
        groupId: ev.id,
        policy: 'parallel' as const,
        manifestHash: computeSha256Hex(
          canonicalJson({
            eventId: ev.id,
            contractHash: contract.promptContractHash,
            policy: 'parallel',
          }),
        ),
      },
    });
  }

  // Order jobs by discourse scene sequence for deterministic planning/input order.
  // Surface execution order is independently governed by SurfaceScheduler.buildWavePlan.
  const sceneOrder = new Map<string, number>();
  for (const entry of runtime.graphs.discourseGraph.sceneSequence) {
    sceneOrder.set(entry.sceneId, entry.sequence);
  }
  jobs.sort((a, b) => (sceneOrder.get(a.event.id) ?? 999) - (sceneOrder.get(b.event.id) ?? 999));

  return jobs;
}

// ============================================================================
// Apply surface plan to jobs
// ============================================================================

function applySurfacePlanToJobs(jobs: RenderJob[], plan: SurfacePlanResult): void {
  const { surfaceDependencyGraph } = plan;
  const { groups, serialLanes } = surfaceDependencyGraph;

  const sceneGroupMap = new Map<string, RenderGroup>();
  for (const group of groups) {
    for (const sceneId of group.sceneIds) {
      sceneGroupMap.set(sceneId, group);
    }
  }

  const groupPredecessors = new Map<string, string>();
  const groupToLane = new Map<string, string>();

  for (const lane of serialLanes) {
    for (let i = 0; i < lane.groupIds.length; i++) {
      groupToLane.set(lane.groupIds[i], lane.laneId);
      if (i > 0) {
        groupPredecessors.set(lane.groupIds[i], lane.groupIds[i - 1]);
      }
    }
  }

  for (const job of jobs) {
    const group = sceneGroupMap.get(job.event.id);
    if (!group) continue;

    const groupId = group.groupId;
    const policy = group.surfacePolicy.type as
      | 'parallel'
      | 'serial_surface'
      | 'fallback_without_surface';
    let predecessorEventId: string | undefined;

    const predecessorGroupId = groupPredecessors.get(groupId);
    if (predecessorGroupId !== undefined) {
      const predecessorGroup = groups.find((candidate) => candidate.groupId === predecessorGroupId);
      if (predecessorGroup && predecessorGroup.sceneIds.length > 0) {
        predecessorEventId = predecessorGroup.sceneIds[predecessorGroup.sceneIds.length - 1];
      }
    }

    job.surfaceDependency = {
      groupId,
      ...(groupToLane.has(groupId) ? { laneId: groupToLane.get(groupId) } : {}),
      predecessorEventId,
      policy,
      manifestHash: plan.manifest.sourceDefinitionHash,
    };
  }
}

// ============================================================================
// Compile surface plan from config
// ============================================================================

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
          authorGroups: config.groups.map(
            (group: { groupId: string; sceneIds: string[]; surfacePolicy: string }) => ({
              groupId: group.groupId,
              sceneIds: group.sceneIds,
              surfacePolicy: {
                type: group.surfacePolicy as
                  | 'parallel'
                  | 'serial_surface'
                  | 'fallback_without_surface',
              },
            }),
          ),
        }
      : {}),
    ...(config.lanes
      ? {
          authorLanes: config.lanes.map((lane: { laneId: string; groupIds: string[] }) => ({
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

// ============================================================================
// Materialize surface packets (blocked result tracking)
// ============================================================================

function materializeSurfacePackets(
  jobs: RenderJob[],
  waveEventIds: readonly string[],
  acceptedByEventId: Map<string, AcceptedSceneArtifact>,
  storage: Storage,
  paths: ProjectPaths,
  extractor: SurfaceReferenceExtractor,
  scopeHash: string,
  _currentRunEventIds: ReadonlySet<string>,
): { blocked: RenderSceneResult[] } {
  const blocked: RenderSceneResult[] = [];

  for (const job of jobs) {
    if (!waveEventIds.includes(job.event.id)) continue;
    const predecessorId = job.surfaceDependency.predecessorEventId;
    if (!predecessorId) continue;

    // Check if predecessor is accepted in this run
    const accepted = acceptedByEventId.get(predecessorId);
    if (accepted) {
      const packet = extractor.extract(accepted, job.event.id);
      job.surfaceReferencePacket = packet;
      continue;
    }

    // Resolve only a matching-scope accepted head: latest response is a
    // pointer, while immutable revision data is authoritative.
    const storedArtifact = new AcceptedArtifactResolver(
      storage,
      paths.responsesDir,
      paths.sceneRevisionsDir,
    ).resolve(predecessorId, scopeHash);
    if (storedArtifact) {
      const packet = extractor.extract(storedArtifact, job.event.id);
      job.surfaceReferencePacket = packet;
      continue;
    }

    // If policy allows fallback, skip blocking
    if (job.surfaceDependency.policy === 'fallback_without_surface') continue;

    // Block this job
    blocked.push({
      eventId: job.event.id,
      prose: '',
      analysis: null,
      llmPass1: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      llmPass2: null,
      cacheHit: false,
      errors: [`Predecessor ${predecessorId} not accepted and no surface source available`],
      promptHash: '',
      renderStart: 0,
      renderEnd: 0,
      validation: null,
      providerCalls: [],
      requestRecords: [],
      attempts: 0,
      needsReview: false,
    });
  }

  return { blocked };
}

// ============================================================================
// Map a single RenderSceneResult to a RenderNovelSceneResult
// ============================================================================

function mapSceneResult(
  result: RenderSceneResult,
  decision: ReleaseDecision | null,
  _chapter: number,
  revisionId: string | null,
  disposition: SceneDisposition,
  _language: string,
): RenderNovelSceneResult {
  return {
    eventId: result.eventId,
    prose: result.prose,
    wordCount: result.prose ? result.prose.split(/\s+/).filter(Boolean).length : 0,
    cacheHit: result.cacheHit,
    released: decision ? decision.status === 'accepted' : false,
    revisionId,
    promoted: disposition === 'candidate_promoted' || disposition === 'head_reused',
    locked: false,
    disposition,
    releaseDecision: decision,
    analysis: result.analysis,
    validationErrors: result.validation?.errors.length ?? 0,
    validationIssueMessages:
      result.validation?.errors.map((issue: { message: string }) => issue.message) ?? [],
    providerCalls: result.providerCalls.map(mapProviderCallEntry),
    promptHash: result.promptHash,
    pass2Rejection: result.pass2Rejection,
    errors: result.errors,
    editorialErrors: [],
  };
}

function mapProviderCallEntry(entry: ProviderCallLedgerEntry): ProviderCallLedgerEntryV1 {
  return {
    phase: entry.phase as 'pass1' | 'pass2' | 'pass2_verify',
    attempt: entry.attempt,
    outcome: entry.outcome as 'success' | 'failure',
    requestHash: entry.requestHash,
    model: entry.model,
    seed: entry.seed,
    failureReason: entry.failureReason,
  };
}

// ============================================================================
// Build scene revision envelope from render result + compile identity
// ============================================================================

function buildRevisionEnvelope(
  result: RenderSceneResult,
  job: RenderJob,
  plan: EditorialCompileOutput,
  operationId: string,
  request: EditorialRenderRequestV1,
  decision: ReleaseDecision,
  paths: ProjectPaths,
  parentRevisionId: string | null,
  expectedLatestHash: string | null,
  override?: {
    origin: SceneRevisionOrigin;
    restoredFromRevisionId?: string;
  },
): SceneRevisionEnvelopeV1 {
  const sceneInfo = plan.scenes.find((s) => s.eventId === result.eventId);
  const revisionId = crypto.randomUUID();
  const now = new Date().toISOString();
  const materializedScene = job.gameDialogue
    ? appendPlayerChoicesBlock(result.prose, job.gameDialogue.choices)
    : result.prose;

  return {
    version: 1,
    revisionId,
    parentRevisionId,
    ...(override?.restoredFromRevisionId
      ? { restoredFromRevisionId: override.restoredFromRevisionId }
      : {}),
    operationId,
    planHash: plan.planHash,
    actorId: request.mutation.actorId,
    eventId: result.eventId,
    origin: override?.origin ?? (request.revision ? 'llm_revision' : 'llm_draft'),
    prose: result.prose,
    proseHash: computeContentHash(result.prose),
    sceneHash: computeContentHash(materializedScene),
    editorialBasisHash: sceneInfo?.editorialBasisHash ?? '',
    scopeHash: sceneInfo?.scopeHash ?? '',
    validationIdentity: sceneInfo?.validationIdentity ?? '',
    modelUsed: request.model,
    feedbackHash: job.revisionContext
      ? computeContentHash(canonicalJson(job.revisionContext.feedbackHashes))
      : null,
    reviewIds: [...(job.editorialReviewIds ?? [])],
    analysis: result.analysis,
    validation: result.validation,
    releaseDecision: decision,
    released: decision.status === 'accepted',
    cacheHit: result.cacheHit,
    errors: result.errors,
    llmPass1: result.llmPass1,
    llmPass2: result.llmPass2,
    attempts: result.attempts,
    needsReview: result.needsReview,
    promptHash: result.promptHash || computeSha256Hex(''),
    pass2Rejection: result.pass2Rejection,
    providerCalls: result.providerCalls.map(mapProviderCallEntry),
    promotionReadSet: [
      {
        kind: 'file' as const,
        path: path.join(paths.responsesDir, `${result.eventId}.json`),
        expectedHash: expectedLatestHash,
      },
    ],
    requestRecords: result.requestRecords.map((r) => ({
      phase: r.phase as 'pass1' | 'pass2',
      attempt: r.attempt,
      requestHash: r.requestHash,
      messages: r.messages,
      responseContent: r.responseContent ?? null,
    })),
    createdAt: now,
  };
}

// ============================================================================
// Write blocked scene decision
// ============================================================================

// ============================================================================
// Build renders jobs — helper subset for full-branch rendering
// ============================================================================

function buildBoundariesAndJobs(
  init: ProjectInitialization,
  plan: EditorialCompileOutput,
  request: Omit<EditorialRenderRequestV1, 'mutation'>,
  sourceContentHash: string,
  model: string,
  _storage: Storage,
): {
  jobs: RenderJob[];
  boundaries: StoryBoundaries;
  discourseContextByEventId: Record<string, CompiledDiscourseRenderContext>;
  runtime: CompiledNarrativeRuntime;
  scopeHash: string;
} {
  const branchPath = request.branchPath;
  const renderEvents = init.events.filter(
    (ev) => ev.source === 'event_file' && plan.selectedEventIds.includes(ev.id),
  );

  const initialFacts: Fact[] = [
    ...init.events
      .filter((ev) => ev.id === 'system:genesis')
      .flatMap((ev) => ev.postconditions ?? []),
    ...init.registry.getAll().flatMap((entity) =>
      Object.entries(entity.state ?? {}).map(
        ([attribute, value]) =>
          ({
            id: `${entity.id}.${attribute}`,
            entityId: entity.id,
            attribute,
            value,
            validity: {
              temporal: { start: { type: 'absolute' as const, value: 'day_0' }, end: null },
              branches: { type: 'all' as const },
            },
          }) as Fact,
      ),
    ),
  ];

  // Compile game dialogue transition events so choice effects are available.
  // Override authored event branchExistence with game tree scopes so events
  // on unreachable branches are excluded from the graph compilation.
  let eventsForRuntime = init.events;
  const temporalContext = resolveTemporalContext(init.events, init.data.timeAnchors);
  const gdTree = compileGameDialogueTree(init.events, temporalContext);
  if (gdTree && gdTree.transitionEvents.length > 0) {
    if (branchPath) {
      eventsForRuntime = init.events.map((ev) => {
        const scope = gdTree.eventScopes.get(ev.id);
        if (scope) {
          return { ...ev, branchExistence: scope };
        }
        return ev;
      });
    }
    eventsForRuntime = [...eventsForRuntime, ...gdTree.transitionEvents];
  }

  // Resolve the discourse branch: prefer explicit request override, otherwise
  // resolve uniquely from the ledger by matching against reachable event IDs.
  // Missing or ambiguous routes throw ConfigError before any provider call.
  const discourseBranch =
    request.discourseBranch ??
    resolveDiscourseBranch({
      selectedEventIds: new Set(
        (branchPath != null
          ? eventsForRuntime.filter((ev) => includesPath(ev.branchExistence, branchPath))
          : eventsForRuntime
        ).map((ev) => ev.id),
      ),
      branchPath: branchPath ?? { decisions: [] },
      ledger: init.data.discourseLedger,
    });

  // Single production runtime: graphs → state boundaries → discourse contexts.
  const runtime = compileNarrativeRuntime({
    events: eventsForRuntime,
    initialFacts,
    timeAnchors: init.data.timeAnchors,
    branchPath,
    discourseBranch,
    ledger: init.data.discourseLedger,
    assertions: init.data.narratorAssertions,
    narratorProfiles: init.data.narratorProfiles,
    initialThreads: [],
  });

  const boundaries = runtime.boundaries;
  const discourseContextByEventId: Record<string, CompiledDiscourseRenderContext> = {};
  for (const [eventId, ctx] of Object.entries(runtime.discourseContextsByEventId)) {
    discourseContextByEventId[eventId] = ctx;
  }

  const scopeHash = computeSha256Hex(
    canonicalJson({
      branch: branchPath ?? { decisions: [] },
      discourse: discourseBranch,
      ledgerHash: init.data.discourseLedger.hash,
    }),
  );

  const jobs = buildRenderJobs(plan, init, request, sourceContentHash, model, runtime);

  return { jobs, boundaries, discourseContextByEventId, scopeHash, runtime };
}

// ============================================================================
// Lock state check (mirrors SceneService.readLock)
// ============================================================================

interface SceneLockRecord {
  revisionId: string;
  proseHash: string;
  lockedAt: string;
  actorId: string;
  valid: boolean;
}

function readSceneLock(
  storage: Storage,
  paths: ProjectPaths,
  eventId: string,
): SceneLockRecord | null {
  const lockPath = path.join(paths.workDir, 'locks', `${eventId}.lock`);
  const raw = storage.readOptional(lockPath);
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { revisionId: '', proseHash: '', lockedAt: '', actorId: '', valid: false };
    }
    const record = value as Record<string, unknown>;
    const valid =
      Object.keys(record).sort().join(',') === 'actorId,lockedAt,proseHash,revisionId' &&
      typeof record.revisionId === 'string' &&
      record.revisionId.length > 0 &&
      typeof record.proseHash === 'string' &&
      /^[a-f0-9]{64}$/.test(record.proseHash) &&
      typeof record.lockedAt === 'string' &&
      !Number.isNaN(Date.parse(record.lockedAt)) &&
      typeof record.actorId === 'string' &&
      record.actorId.trim().length > 0;
    return {
      revisionId: typeof record.revisionId === 'string' ? record.revisionId : '',
      proseHash: typeof record.proseHash === 'string' ? record.proseHash : '',
      lockedAt: typeof record.lockedAt === 'string' ? record.lockedAt : '',
      actorId: typeof record.actorId === 'string' ? record.actorId : '',
      valid,
    };
  } catch {
    return { revisionId: '', proseHash: '', lockedAt: '', actorId: '', valid: false };
  }
}
function sceneLockFreshness(
  storage: Storage,
  paths: ProjectPaths,
  eventId: string,
  chapterNumber: number,
): 'none' | 'current' | 'stale' {
  const lock = readSceneLock(storage, paths, eventId);
  if (lock === null) return 'none';
  const latest = readAcceptedHeadEnvelope(storage, paths, eventId, chapterNumber);
  if (
    !lock.valid ||
    latest?.releaseDecision.status !== 'accepted' ||
    lock.revisionId !== latest.revisionId ||
    lock.proseHash !== latest.proseHash
  ) {
    return 'stale';
  }
  const sourceHeadExpectation = latest.promotionReadSet.find(
    (expectation): expectation is Extract<TransactionReadExpectation, { kind: 'file' }> =>
      expectation.kind === 'file' && expectation.path === paths.sourceHeadPath,
  );
  if (
    sourceHeadExpectation &&
    sourceHeadExpectation.expectedHash !== computeFileHash(storage, paths.sourceHeadPath)
  ) {
    return 'stale';
  }
  if (!sourceHeadExpectation) {
    try {
      const sourceStore = new SourceRevisionStore(
        new ProjectTransactionCoordinator(storage, paths),
        paths,
      );
      const sourceHead = sourceStore.getHead();
      if (sourceHead?.revisionId) {
        const sourceRevision = sourceStore.get(sourceHead.revisionId);
        if (
          sourceRevision.createdAt > latest.createdAt &&
          sourceRevision.operationId !== latest.operationId &&
          sourceRevision.affectedEventIds.includes(eventId)
        ) {
          return 'stale';
        }
      }
    } catch {
      return 'stale';
    }
  }
  return 'current';
}

// ============================================================================
// Per-event revision state (revision preflight)
// ============================================================================

export interface EventRevisionState {
  eventId: string;
  state:
    | 'will_revise'
    | 'no_revision_needed'
    | 'no_accepted_base'
    | 'skipped_by_lock'
    | 'lock_stale'
    | 'revision_stale';
  /** Applicable review IDs from the ledger. */
  applicableReviewIds: readonly string[];
  /** Deterministic content/target feedback hashes. */
  feedbackHashes: readonly string[];
  /** Deterministic, non-authoritative prompt payload. */
  editorialRevisionInstructions?: string;
  /** Base revision info — present when an accepted unlocked head exists. */
  baseRevisionId?: string;
  baseProse?: string;
  baseProseHash?: string;
}

/**
 * Build per-event revision states: for each selected event, determine
 * which reviews apply and whether the revision can proceed.
 *
 * When `reviewIds` are explicitly given, they are validated atomically.
 * Without explicit IDs, all applicable open reviews are selected in
 * stable novel→chapter→scene→line order.
 *
 * Zero-provider outcomes:
 *   - no_revision_needed  — no applicable reviews or feedback
 *   - no_accepted_base    — no accepted unlocked head exists
 *   - skipped_by_lock     — scene is locked
 *   - revision_stale      — line-level basis is stale (proseHash mismatch)
 */
export function buildEventRevisionStates(
  eventIds: readonly string[],
  revisionRequest: RevisionRequest | undefined,
  reviewComments: readonly ReviewComment[],
  storage: Storage,
  paths: ProjectPaths,
  chapterByEventId: Record<string, number>,
): EventRevisionState[] {
  if (!revisionRequest) return [];

  const explicitReviewIds = revisionRequest.reviewIds ?? [];
  const hasExplicitIds = explicitReviewIds.length > 0;
  const hasInlineInstruction = Boolean(revisionRequest.instruction?.trim());
  const commentById = new Map(reviewComments.map((comment) => [comment.id, comment]));

  const appliesToEvent = (comment: ReviewComment, eventId: string): boolean => {
    const chapterId = `chapter:${chapterByEventId[eventId] ?? 1}`;
    if (comment.target.type === 'novel') return true;
    if (comment.target.type === 'chapter') return comment.target.id === chapterId;
    if (comment.target.type === 'scene' || comment.target.type === 'line') {
      return comment.target.id === eventId;
    }
    return false;
  };

  if (hasInlineInstruction && eventIds.length !== 1) {
    throw new EditorialOperationError(
      'INVALID_REVIEW_SELECTION',
      'Inline revision instruction requires exactly one selected scene.',
    );
  }
  if (hasExplicitIds) {
    for (const reviewId of explicitReviewIds) {
      const comment = commentById.get(reviewId);
      if (comment?.status !== 'open' || !eventIds.some((id) => appliesToEvent(comment, id))) {
        throw new EditorialOperationError(
          'INVALID_REVIEW_SELECTION',
          `Review "${reviewId}" must exist, be open, and apply to a selected scene.`,
        );
      }
    }
  }

  const results: EventRevisionState[] = [];
  for (const eventId of eventIds) {
    const applicableReviews = sortReviewFeedback(
      hasExplicitIds
        ? explicitReviewIds
            .map((reviewId) => commentById.get(reviewId))
            .filter(
              (comment): comment is ReviewComment =>
                comment !== undefined && appliesToEvent(comment, eventId),
            )
        : reviewComments.filter(
            (comment) => comment.status === 'open' && appliesToEvent(comment, eventId),
          ),
    );
    const hasLocalInstruction = hasInlineInstruction && eventIds.length === 1;

    if (applicableReviews.length === 0 && !hasLocalInstruction) {
      results.push({
        eventId,
        state: 'no_revision_needed',
        applicableReviewIds: [],
        feedbackHashes: [],
      });
      continue;
    }

    const latest = readAcceptedHeadEnvelope(
      storage,
      paths,
      eventId,
      chapterByEventId[eventId] ?? 1,
    );
    const lock = readSceneLock(storage, paths, eventId);
    if (lock !== null) {
      const lockIsCurrent =
        lock.valid &&
        latest?.releaseDecision.status === 'accepted' &&
        lock.revisionId === latest.revisionId &&
        lock.proseHash === latest.proseHash;
      results.push({
        eventId,
        state: lockIsCurrent ? 'skipped_by_lock' : 'lock_stale',
        applicableReviewIds: applicableReviews.map((review) => review.id),
        feedbackHashes: [],
      });
      continue;
    }

    if (latest?.releaseDecision.status !== 'accepted') {
      results.push({
        eventId,
        state: 'no_accepted_base',
        applicableReviewIds: applicableReviews.map((review) => review.id),
        feedbackHashes: [],
      });
      continue;
    }

    const hasStaleLineReview = applicableReviews.some(
      (review) =>
        review.target.type === 'line' &&
        review.target.lineBasis !== undefined &&
        (review.target.lineBasis.revisionId !== latest.revisionId ||
          review.target.lineBasis.proseHash !== latest.proseHash),
    );
    if (hasStaleLineReview) {
      results.push({
        eventId,
        state: 'revision_stale',
        applicableReviewIds: applicableReviews.map((review) => review.id),
        feedbackHashes: [],
      });
      continue;
    }

    const feedbackHashes = applicableReviews.map((review) =>
      computeContentHash(canonicalJson(reviewFeedbackProjection(review))),
    );
    const promptFeedback: unknown[] = applicableReviews.map((review) => ({
      reviewId: review.id,
      ...reviewFeedbackProjection(review),
    }));
    if (hasLocalInstruction) {
      const inlineFeedback = inlineInstructionFeedbackProjection(
        eventId,
        revisionRequest.instruction ?? '',
      );
      feedbackHashes.push(computeContentHash(canonicalJson(inlineFeedback)));
      promptFeedback.push(inlineFeedback);
    }

    results.push({
      eventId,
      state: 'will_revise',
      applicableReviewIds: applicableReviews.map((review) => review.id),
      feedbackHashes,
      editorialRevisionInstructions: YAML.stringify(
        { feedback: promptFeedback },
        { lineWidth: 120 },
      ).trimEnd(),
      baseRevisionId: latest.revisionId,
      baseProse: latest.prose,
      baseProseHash: latest.proseHash,
    });
  }

  return results;
}

// ============================================================================
// Build revision context for a single job
// ============================================================================

/**
 * Given an event revision state and optional inline instruction,
 * produce the RevisionContext and editorialRevisionInstructions for a RenderJob.
 */
export function buildRevisionContextForJob(revisionState: EventRevisionState): {
  revisionContext?: RevisionContext;
  editorialRevisionInstructions?: string;
} {
  if (revisionState.state !== 'will_revise') return {};
  if (
    revisionState.baseRevisionId === undefined ||
    revisionState.baseProse === undefined ||
    revisionState.baseProseHash === undefined ||
    revisionState.editorialRevisionInstructions === undefined
  ) {
    return {};
  }

  return {
    revisionContext: {
      baseRevisionId: revisionState.baseRevisionId,
      baseProse: revisionState.baseProse,
      baseProseHash: revisionState.baseProseHash,
      feedbackHashes: revisionState.feedbackHashes,
      revisionInstructionHash: computeContentHash(revisionState.editorialRevisionInstructions),
    },
    editorialRevisionInstructions: revisionState.editorialRevisionInstructions,
  };
}

// ============================================================================
// Persist inline instruction as a real review comment (post-claim)
// ============================================================================

/**
 * When a single-scene inline instruction is given (no explicit reviewIds),
 * persist it as a real review comment in the ledger after the operation
 * is claimed.  Returns the review ID, or null if no instruction.
 */
export function persistInlineInstructionReview(
  revisionRequest: RevisionRequest | undefined,
  eventIds: readonly string[],
  reviewManager: ReviewManager,
  actorId: string,
  expectedLedgerHash: string | null,
): string | null {
  if (!revisionRequest?.instruction?.trim() || eventIds.length !== 1) {
    return null;
  }

  const comment = reviewManager.addReviewComment(
    {
      target: { type: 'scene', id: eventIds[0] },
      severity: 'suggestion',
      category: 'style',
      content: revisionRequest.instruction.trim(),
    },
    actorId,
    expectedLedgerHash !== null ? { expectedLedgerHash } : undefined,
    0,
  );

  return comment.id;
}

// ============================================================================
// Apply scene/line reviews after accepted candidate becomes head
// ============================================================================

/**
 * Apply scene- and line-level reviews for any event where the
 * render result was accepted and promoted to head.
 * Reviews at chapter/novel scope remain open until complete-scope success.
 */
export function applySceneLineReviews(
  promotedRevisionIds: ReadonlyMap<string, string>,
  eventRevisionStates: readonly EventRevisionState[],
  reviewManager: ReviewManager,
  operationId: string,
): void {
  const snapshot = reviewManager.readLedger();
  const commentById = new Map(snapshot.ledger.comments.map((comment) => [comment.id, comment]));

  for (const revisionState of eventRevisionStates) {
    if (revisionState.state !== 'will_revise') continue;
    const revisionId = promotedRevisionIds.get(revisionState.eventId);
    if (!revisionId) continue;

    const reviewIds = revisionState.applicableReviewIds.filter((reviewId) => {
      const comment = commentById.get(reviewId);
      return comment?.target.type === 'scene' || comment?.target.type === 'line';
    });
    if (reviewIds.length === 0) continue;

    reviewManager.applyComments(
      reviewIds,
      {
        eventId: revisionState.eventId,
        revisionId,
        operationId,
        appliedAt: new Date().toISOString(),
      },
      new Set(reviewIds),
    );
  }
}

// ============================================================================
// Apply chapter/novel reviews after complete-scope success
// ============================================================================

/**
 * Apply chapter- and novel-scope reviews after all scenes in the scope
 * have been successfully accepted and published.
 */
export function applyChapterNovelReviews(
  promotedRevisionIds: ReadonlyMap<string, string>,
  eventRevisionStates: readonly EventRevisionState[],
  reviewManager: ReviewManager,
  operationId: string,
  selector: EditorialRenderRequestV1['selector'],
  selectedEventIds: readonly string[],
): void {
  const effectiveSelector = selector ?? { type: 'all' as const };
  if (
    selectedEventIds.length === 0 ||
    selectedEventIds.some((eventId) => !promotedRevisionIds.has(eventId))
  ) {
    return;
  }

  const snapshot = reviewManager.readLedger();
  const commentById = new Map(snapshot.ledger.comments.map((comment) => [comment.id, comment]));
  const candidateReviewIds = new Set(
    eventRevisionStates.flatMap((state) => [...state.applicableReviewIds]),
  );
  const applicableScopeReviewIds = [...candidateReviewIds].filter((reviewId) => {
    const comment = commentById.get(reviewId);
    if (comment?.status !== 'open') return false;
    if (comment.target.type === 'chapter') {
      return (
        effectiveSelector.type === 'chapter' &&
        comment.target.id === `chapter:${effectiveSelector.chapter}`
      );
    }
    return comment.target.type === 'novel' && effectiveSelector.type === 'all';
  });

  for (const reviewId of applicableScopeReviewIds) {
    for (const [index, eventId] of selectedEventIds.entries()) {
      const revisionId = promotedRevisionIds.get(eventId);
      if (revisionId === undefined) {
        throw new EditorialOperationError(
          'REVISION_STALE',
          `Promoted revision is missing for ${eventId}`,
          { eventId, operationId },
        );
      }
      reviewManager.applyComments(
        [reviewId],
        {
          eventId,
          revisionId,
          operationId,
          appliedAt: new Date().toISOString(),
        },
        index === selectedEventIds.length - 1 ? new Set([reviewId]) : new Set(),
      );
    }
  }
}

// ============================================================================
// executeEditorialRender — Full editorial render orchestration
// ============================================================================

export interface EditorialCandidateExecution {
  operationKind: 'adopt_scene' | 'rollback_scene';
  eventId: string;
  prose: string;
  origin: 'human_edit' | 'rollback';
  actionRequestHash: string;
  restoredFromRevisionId?: string;
  lockAfter?: boolean;
  note?: string;
  readSet?: readonly TransactionReadExpectation[];
}

export function computeCandidateOperationRequestHash(
  request: EditorialRenderRequestV1,
  candidateExecution: EditorialCandidateExecution,
): string {
  return computeContentHash(
    canonicalJson({
      request: {
        version: request.version,
        projectDir: request.projectDir,
        selector: request.selector,
        model: request.model ?? null,
        providerProfile: request.providerProfile ?? null,
        branchPath: request.branchPath ?? null,
        discourseBranch: request.discourseBranch ?? null,
        waivers: request.waivers ?? [],
        batch: request.batch ?? null,
        maxRounds: request.maxRounds ?? null,
        actorId: request.mutation.actorId,
      },
      candidate: {
        operationKind: candidateExecution.operationKind,
        eventId: candidateExecution.eventId,
        proseHash: computeContentHash(candidateExecution.prose),
        origin: candidateExecution.origin,
        actionRequestHash: candidateExecution.actionRequestHash,
        restoredFromRevisionId: candidateExecution.restoredFromRevisionId ?? null,
        lockAfter: candidateExecution.lockAfter ?? false,
        note: candidateExecution.note ?? null,
      },
    }),
  );
}

/**
 * Execute a full editorial render: compile → claim → materialize →
 * execute → promote → publish.
 *
 * Returns a JSON-safe result with all scene results and publication status.
 */
export async function executeEditorialRender(
  request: EditorialRenderRequestV1,
  runtime: EditorialRuntime,
  candidateExecution?: EditorialCandidateExecution,
): Promise<RenderNovelResult> {
  const storage = runtime.storage ?? new FsStorage();

  // Load project config first to resolve configured output directory
  const projectConfig = loadProjectConfig(path.join(request.projectDir, 'nova.yaml'), storage);
  const paths = resolveProjectPaths(request.projectDir, projectConfig?.outputDir);

  const coordinator = new ProjectTransactionCoordinator(storage, paths);
  const clock = REAL_CLOCK;
  const operationStore = new OperationStore(coordinator, paths, clock);
  const sceneStore = new SceneRevisionStore(coordinator, paths);
  const signal = runtime.signal;
  const eventBus = runtime.eventBus;

  // ── 0. Check abort ──────────────────────────────────────────────────
  if (signal?.aborted) {
    return buildCancelledResult(request.mutation.operationId ?? crypto.randomUUID());
  }

  // ── 1. COMPILE ──────────────────────────────────────────────────────
  const init = loadProjectData(storage, request.projectDir, request.branchPath, paths);
  const validationRuntime = await createValidationRuntime(init.data, request.projectDir, storage);
  const reviewComments = loadReviewComments(storage, coordinator, paths);
  const requiresProviderByEventId = computeRequiresProviderByEventId(
    init.events,
    request,
    init.data,
  );
  if (candidateExecution) {
    requiresProviderByEventId[candidateExecution.eventId] = true;
  }
  const compileInput = buildCompileInput(
    init,
    request,
    reviewComments,
    requiresProviderByEventId,
    validationRuntime.identityInput,
    paths,
  );
  const plan = compileEditorialRun(compileInput);

  // All selector/review/instruction errors are atomic and pre-claim.
  if (plan.selectorErrors.length > 0) {
    const editorialErrors = plan.selectorErrors.map((error) => ({
      code: error.code as EditorialErrorCode,
      message: error.message,
      ...(error.eventId ? { eventId: error.eventId } : {}),
    }));
    return buildFailedResult(
      request.mutation.operationId ?? crypto.randomUUID(),
      editorialErrors,
      plan.planSummary,
    );
  }

  const renderLockedEventIds = new Set<string>();
  if (!request.revision && !candidateExecution) {
    const staleLockErrors: EditorialError[] = [];
    for (const eventId of plan.selectedEventIds) {
      const freshness = sceneLockFreshness(
        storage,
        paths,
        eventId,
        init.chapterByEventId[eventId] ?? 1,
      );
      if (freshness === 'current') {
        renderLockedEventIds.add(eventId);
      } else if (freshness === 'stale') {
        staleLockErrors.push({
          code: 'SCENE_LOCK_STALE',
          message: `Scene "${eventId}" is locked against stale canon or revision state`,
          eventId,
        });
      }
    }
    if (staleLockErrors.length > 0) {
      return buildFailedResult(
        request.mutation.operationId ?? crypto.randomUUID(),
        staleLockErrors,
        plan.planSummary,
      );
    }
  }

  // ── Compute revision preflight states ──────────────────────────
  const reviewMgr = new ReviewManager(storage, coordinator, paths.reviewLedgerPath);
  const eventRevisionStates = request.revision
    ? buildEventRevisionStates(
        plan.selectedEventIds,
        request.revision,
        reviewComments,
        storage,
        paths,
        init.chapterByEventId,
      )
    : [];
  const _zeroProviderEventIds = new Set(
    eventRevisionStates.filter((ers) => ers.state !== 'will_revise').map((ers) => ers.eventId),
  );
  // Capture zero-provider editorial errors for reporting
  const revisionPreflightErrors: EditorialError[] = [];
  for (const ers of eventRevisionStates) {
    if (ers.state === 'no_accepted_base') {
      revisionPreflightErrors.push({
        code: 'NO_ACCEPTED_BASE' as EditorialErrorCode,
        message: `Scene "${ers.eventId}" has no accepted base revision — cannot apply reviews`,
        eventId: ers.eventId,
      });
    } else if (ers.state === 'revision_stale') {
      revisionPreflightErrors.push({
        code: 'REVISION_STALE' as EditorialErrorCode,
        message: `Line-level review basis is stale for scene "${ers.eventId}" — head revision or prose hash mismatch`,
        eventId: ers.eventId,
      });
    } else if (ers.state === 'skipped_by_lock') {
      revisionPreflightErrors.push({
        code: 'SCENE_LOCKED' as EditorialErrorCode,
        message: `Scene "${ers.eventId}" is locked — revision skipped`,
        eventId: ers.eventId,
      });
    } else if (ers.state === 'lock_stale') {
      revisionPreflightErrors.push({
        code: 'SCENE_LOCK_STALE' as EditorialErrorCode,
        message: `Scene "${ers.eventId}" has a lock that does not match its current accepted head`,
        eventId: ers.eventId,
      });
    }
  }

  // A revision request with no executable scene must not claim an operation
  // or construct a provider.
  if (
    request.revision &&
    !eventRevisionStates.some((revisionState) => revisionState.state === 'will_revise')
  ) {
    const errors =
      revisionPreflightErrors.length > 0
        ? revisionPreflightErrors
        : [
            {
              code: 'NO_OPEN_FEEDBACK' as EditorialErrorCode,
              message: 'No open feedback applies to the selected scenes.',
            },
          ];
    return buildFailedResult(
      request.mutation.operationId ?? crypto.randomUUID(),
      errors,
      plan.planSummary,
    );
  }

  // ── Check game dialogue tree requires branchPath ────────────────────
  if (!request.branchPath) {
    const temporalContext = resolveTemporalContext(init.events, init.data.timeAnchors);
    const gdTree = compileGameDialogueTree(init.events, temporalContext);
    if (gdTree && gdTree.transitionEvents.length > 0) {
      return buildFailedResult(
        request.mutation.operationId ?? crypto.randomUUID(),
        [
          {
            code: 'SCENE_NOT_IN_BRANCH' as EditorialErrorCode,
            message:
              'Game dialogue tree project requires a branchPath to select a narrative route. Provide branchPath with scene decisions.',
          },
        ],
        plan.planSummary,
      );
    }
  }

  // Ensure work directories exist (after preflight — zero writes on error)
  storage.mkdirp(paths.workDir);
  storage.mkdirp(paths.operationsDir);
  storage.mkdirp(paths.transactionsDir);
  storage.mkdirp(paths.conflictsDir);
  storage.mkdirp(paths.responsesDir);
  storage.mkdirp(paths.outputDir);

  // Provider resolution is lazy — handled by RenderPipeline via
  // runtime.provider / runtime.providerFactory / config fallback.

  // ── 2. CLAIM ────────────────────────────────────────────────────────
  const operationId = request.mutation.operationId ?? crypto.randomUUID();
  const requestHash = candidateExecution
    ? computeCandidateOperationRequestHash(request, candidateExecution)
    : plan.planHash;
  let operation: EditorialOperationV1;
  try {
    operation = operationStore.register({
      operationId,
      kind: candidateExecution?.operationKind ?? 'render',
      actorId: request.mutation.actorId,
      requestHash,
    });
  } catch (err) {
    // Idempotent terminal case: return the existing result if same request
    if (err instanceof EditorialOperationError && err.code === 'OPERATION_IN_PROGRESS') {
      // Different hash or already running — propagate error
      return buildFailedResult(operationId, [toEditorialError(err)], plan.planSummary);
    }
    // Check if idempotent terminal
    try {
      const existing = operationStore.get(operationId);
      if (
        existing.requestHash === requestHash &&
        existing.status === 'succeeded' &&
        existing.result
      ) {
        return existing.result as RenderNovelResult;
      }
      if (
        existing.requestHash === requestHash &&
        (existing.status === 'failed' || existing.status === 'cancelled')
      ) {
        return (
          (existing.result as RenderNovelResult) ??
          buildFailedResult(operationId, existing.errors, plan.planSummary)
        );
      }
    } catch {
      // fall through — register threw for a different reason
    }
    return buildFailedResult(operationId, [toEditorialError(err)], plan.planSummary);
  }
  // If register returned an existing terminal operation, return it
  if (operation.status !== 'running') {
    if (operation.status === 'succeeded' && operation.result) {
      return operation.result as RenderNovelResult;
    }
    return buildFailedResult(operationId, operation.errors, plan.planSummary);
  }

  const emit = createProgressEmitter(
    eventBus,
    operationId,
    operationStore,
    request.mutation.actorId,
  );
  let inlineReviewId: string | null = null;
  try {
    if (request.revision?.instruction && !request.revision.reviewIds?.length) {
      const snapshot = reviewMgr.readLedger();
      inlineReviewId = persistInlineInstructionReview(
        request.revision,
        plan.selectedEventIds,
        reviewMgr,
        request.mutation.actorId,
        snapshot.contentHash,
      );
      if (inlineReviewId) {
        const revisionState = eventRevisionStates.find(
          (state) => state.eventId === plan.selectedEventIds[0],
        );
        if (revisionState) {
          revisionState.applicableReviewIds = [
            ...revisionState.applicableReviewIds,
            inlineReviewId,
          ];
        }
      }
    }
  } catch (error) {
    const editorialError = toEditorialError(error);
    const publishTerminal = emit.prepareTerminal({ kind: 'operation_failed' });
    operationStore.fail(operationId, request.mutation.actorId, [editorialError]);
    publishTerminal();
    return buildFailedResult(operationId, [editorialError], plan.planSummary);
  }

  emit({
    kind: 'operation_started',
    totalScenes: plan.selectedEventIds.length,
    completedScenes: 0,
  });

  // ── 3. Compute source content hash & build RenderJob[] ──────────────
  if (signal?.aborted) {
    const publishTerminal = emit.prepareTerminal({ kind: 'operation_cancelled' });
    operationStore.cancel(operationId, request.mutation.actorId);
    publishTerminal();
    return buildCancelledResult(operationId, plan.planSummary);
  }

  // Resolve discourse branch — explicit override or unique ledger match.
  const discourseBranch =
    request.discourseBranch ??
    resolveDiscourseBranch({
      selectedEventIds: new Set(
        (request.branchPath != null
          ? init.events.filter((ev) => includesPath(ev.branchExistence, request.branchPath!))
          : init.events
        ).map((ev) => ev.id),
      ),
      branchPath: request.branchPath ?? { decisions: [] },
      ledger: init.data.discourseLedger,
    });

  const scopeHash = computeSha256Hex(
    canonicalJson({
      branch: request.branchPath ?? { decisions: [] },
      discourse: discourseBranch,
      ledgerHash: init.data.discourseLedger.hash,
    }),
  );
  const selectedEventIds = new Set(plan.selectedEventIds);
  const eventFilePaths = [...init.data.chapters.values()]
    .flatMap((chapter) => chapter.events)
    .filter((ef: EventFile) => selectedEventIds.has(ef.event))
    .map((ef: EventFile) => ef.filePath)
    .filter((fp: string | undefined): fp is string => fp !== undefined);
  const definitionsDir = path.join(request.projectDir, 'definitions');
  const sourceContentHash = computeSourceContentHash(
    eventFilePaths,
    definitionsDir,
    { branchDiscourseScopeHash: scopeHash },
    request.projectDir,
    storage,
  );
  const resolvedModel = request.model ?? init.data.config?.defaultModel ?? 'default';
  const { jobs, boundaries, runtime: compiledRuntime } = buildBoundariesAndJobs(
    init,
    plan,
    request,
    sourceContentHash,
    resolvedModel,
    storage,
  );
  if (renderLockedEventIds.size > 0) {
    const unlockedJobs = jobs.filter((job) => !renderLockedEventIds.has(job.event.id));
    jobs.length = 0;
    jobs.push(...unlockedJobs);
  }

  // ── Wire deterministic revision context onto jobs ──────────────
  if (eventRevisionStates.length > 0) {
    for (const job of jobs) {
      const revisionState = eventRevisionStates.find((state) => state.eventId === job.event.id);
      if (revisionState?.state !== 'will_revise') continue;

      const context = buildRevisionContextForJob(revisionState);
      job.revisionContext = context.revisionContext;
      job.editorialRevisionInstructions = context.editorialRevisionInstructions;
      job.editorialReviewIds = [...revisionState.applicableReviewIds];
    }

    // Remove zero-provider events from the jobs list
    const filtered = jobs.filter((j) => {
      const ers = eventRevisionStates.find((s) => s.eventId === j.event.id);
      return !ers || ers.state === 'will_revise';
    });
    jobs.length = 0;
    jobs.push(...filtered);
  }

  if (candidateExecution) {
    const candidateJob = jobs.find((job) => job.event.id === candidateExecution.eventId);
    if (!candidateJob || plan.selectedEventIds.length !== 1) {
      const error: EditorialError = {
        code: 'SCENE_NOT_FOUND',
        message: `No executable scene job for ${candidateExecution.eventId}`,
        eventId: candidateExecution.eventId,
        operationId,
      };
      const publishTerminal = emit.prepareTerminal({ kind: 'operation_failed' });
      operationStore.fail(operationId, request.mutation.actorId, [error]);
      publishTerminal();
      return buildFailedResult(operationId, [error], plan.planSummary);
    }
    candidateJob.proseCandidate = candidateExecution.prose;
  }

  if (jobs.length === 0 && plan.selectorErrors.length === 0) {
    const emptyResult: RenderNovelResult = {
      operationId,
      results: [],
      errors: revisionPreflightErrors.map((error) => error.message),
      editorialErrors: revisionPreflightErrors,
      publication: {
        status: revisionPreflightErrors.length > 0 ? 'stale' : 'unchanged',
        outputPath: paths.novelPath,
        novelHash: null,
        reasons: revisionPreflightErrors,
      },
    };
    if (revisionPreflightErrors.length > 0) {
      const publishTerminal = emit.prepareTerminal({ kind: 'operation_failed' });
      operationStore.fail(operationId, request.mutation.actorId, revisionPreflightErrors);
      publishTerminal();
    } else {
      const publishTerminal = emit.prepareTerminal({ kind: 'operation_completed' });
      operationStore.succeed(operationId, request.mutation.actorId, emptyResult);
      publishTerminal();
    }
    return emptyResult;
  }

  // Capture every authoritative input and publication preimage after claim
  // and before any provider call. Promotion transactions validate this set.
  const scopeEventIdsForPublication = init.events
    .filter(
      (event) => event.source === 'event_file' && boundaries.stateBeforeByEventId.has(event.id),
    )
    .sort(
      (left, right) =>
        left.narrativeOrder - right.narrativeOrder || left.id.localeCompare(right.id),
    )
    .map((event) => event.id);
  const publicationRawBeforeExecution = storage.readOptional(paths.publicationPath);
  const previousManifestBeforeExecution = loadOrCreatePublication(storage, paths.publicationPath);
  const publicationReadSet = capturePublicationReadSet(
    storage,
    paths,
    init,
    scopeEventIdsForPublication,
  );
  for (const job of jobs) {
    job.promotionReadSet = dedupeReadSet([
      ...publicationReadSet,
      ...(candidateExecution?.readSet ?? []),
      fileExpectation(storage, sceneStore.latestPath(job.event.id)),
    ]);
  }

  // ── 4. Apply surface plan ──────────────────────────────────────────
  if (init.data.config?.renderSurface) {
    const surfacePlan = compileConfiguredSurfacePlan(init.data, jobs, request.branchPath);
    if (surfacePlan) {
      applySurfacePlanToJobs(jobs, surfacePlan);
    }
  }

  // ── 5. EXECUTE (wave-based) ─────────────────────────────────────────
  const extractor = new SurfaceReferenceExtractor(
    init.data.config?.renderSurface?.extraction?.budget ?? 2000,
  );
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
    paths,
    extractor,
    scopeHash,
    currentRunEventIds,
  );
  const preBlockedIds = new Set(preBlocked.map((r) => r.eventId));
  const schedulableJobs = jobs.filter((j) => !preBlockedIds.has(j.event.id));

  // Subset dependency resolution: jobs in subsetDependentIds that were NOT
  // blocked successfully resolved their predecessor from persisted storage.
  // Clear their predecessorEventId so the wave plan scheduler treats them
  // as independent — the materializer already loaded the necessary packet.
  for (const job of schedulableJobs) {
    const pred = job.surfaceDependency.predecessorEventId;
    if (pred !== undefined && !currentRunEventIds.has(pred)) {
      job.surfaceDependency.predecessorEventId = undefined;
    }
  }

  const scheduler = new SurfaceScheduler();
  const wavePlan = scheduler.buildWavePlan(schedulableJobs);
  if (wavePlan.missingPredecessors.length > 0 || wavePlan.cycleParticipants.length > 0) {
    const missing = wavePlan.missingPredecessors
      .map(
        (m: { eventId: string; predecessorEventId: string }) =>
          `${m.eventId} -> ${m.predecessorEventId}`,
      )
      .join(', ');
    const cycles = wavePlan.cycleParticipants.join(', ');
    let msg = 'Surface dependency validation failed:';
    if (wavePlan.missingPredecessors.length > 0) msg += ` missing predecessors: ${missing}`;
    if (wavePlan.cycleParticipants.length > 0) msg += ` cycle participants: ${cycles}`;
    const publishTerminal = emit.prepareTerminal({ kind: 'operation_failed' });
    operationStore.fail(operationId, request.mutation.actorId, [
      {
        code: 'INVALID_OPERATION' as EditorialErrorCode,
        message: msg,
      },
    ]);
    publishTerminal();
    return buildFailedResult(
      operationId,
      [{ code: 'INVALID_OPERATION' as EditorialErrorCode, message: msg }],
      plan.planSummary,
    );
  }

  // ── Build pipeline ──────────────────────────────────────────────────
  const eventLogger = new Logger(
    runtime.trace ? undefined : new LevelFilterTransport(new JsonlLogTransport()),
    { module: 'editorial-render' },
  );
  const traceCollector = runtime.trace ? new TraceCollector(`render-${operationId}`) : undefined;
  const language = init.data.config?.defaultLanguage ?? 'en';
  // Build provider chain: runtime.provider > runtime.providerFactory > config fallback
  // All resolution is lazy — factory.create() is only called when the pipeline
  // actually needs to make a completion call.
  const pipelineProviderFactory: ProviderFactory | undefined =
    runtime.providerFactory ??
    (!runtime.provider
      ? {
          profile: 'config',
          create: async () => {
            let fallbackModel = request.model;
            const apiKey = process.env.NOVALISTICALLY_AI_API_KEY ?? '';
            const baseUrl: string | undefined = process.env.NOVALISTICALLY_AI_BASE_URL ?? undefined;
            if (!fallbackModel) {
              fallbackModel = process.env.NOVALISTICALLY_AI_MODEL ?? undefined;
            }
            if (!fallbackModel) {
              throw new Error('PROVIDER_REQUIRED: No LLM provider available: no model configured');
            }
            if (!apiKey) {
              throw new Error(
                'PROVIDER_REQUIRED: No LLM provider available: NOVALISTICALLY_AI_API_KEY is not configured',
              );
            }
            return new AiSdkProvider({ apiKey, baseURL: baseUrl, model: fallbackModel });
          },
        }
      : undefined);
  const leaseAbortController = new AbortController();
  if (signal?.aborted) {
    leaseAbortController.abort(signal.reason);
  } else {
    signal?.addEventListener('abort', () => leaseAbortController.abort(signal.reason), {
      once: true,
    });
  }
  const operationSignal = leaseAbortController.signal;

  const pipeline = new RenderPipeline({
    provider: runtime.provider,
    providerFactory: pipelineProviderFactory,
    providerProfile: request.providerProfile,
    model: resolvedModel,
    cacheDir: paths.renderCacheDir,
    storage,
    language,
    logger: eventLogger,
    traceCollector,
    eventBus,
    aggregator: validationRuntime.aggregator,
    validatorOverrides: validationRuntime.overrides,
    analysisContract: validationRuntime.analysisContract,
    entityRegistry: init.registry,
    pluginHooksManager: validationRuntime.pluginHooksManager,
    maxRounds: request.maxRounds,
    concurrency: runtime.concurrency,
    signal: operationSignal,
  });

  // ── Process waves ───────────────────────────────────────────────────
  const allResults: RenderSceneResult[] = [...preBlocked];
  const decisions = new Map<string, ReleaseDecision>();
  const acceptedByEventId = new Map<string, AcceptedSceneArtifact>();
  const sceneDispositions = new Map<string, SceneDisposition>();
  const revisionIds = new Map<string, string | null>();
  const promotedEnvelopes = new Map<string, SceneRevisionEnvelopeV1>();
  const revisionOverride = candidateExecution
    ? {
        origin: candidateExecution.origin,
        ...(candidateExecution.restoredFromRevisionId
          ? {
              restoredFromRevisionId: candidateExecution.restoredFromRevisionId,
            }
          : {}),
      }
    : undefined;

  for (const result of preBlocked) {
    const decision: ReleaseDecision = {
      status: 'blocked',
      scopeHash,
      validationIdentity: plan.planSummary.validationIdentity,
      reasons: [...result.errors],
    };
    decisions.set(result.eventId, decision);
    sceneDispositions.set(result.eventId, 'candidate_blocked');

    // Archive blocked candidate through SceneRevisionStore before latest CAS
    const preBlockedJob = jobs.find((j) => j.event.id === result.eventId);
    if (preBlockedJob) {
      const expectedLatestHash = expectedFileHash(
        preBlockedJob.promotionReadSet,
        sceneStore.latestPath(result.eventId),
      );
      const previousAcceptedRevisionId = init.latestRevisions[result.eventId]?.revisionId ?? null;
      const envelope = buildRevisionEnvelope(
        result,
        preBlockedJob,
        plan,
        operationId,
        request,
        decision,
        paths,
        previousAcceptedRevisionId,
        expectedLatestHash,
        revisionOverride,
      );
      sceneStore.archiveAndUpdateLatest(envelope, expectedLatestHash);
    }
  }

  const totalScenes = plan.selectedEventIds.length;
  let completedScenes = preBlocked.length;

  // ── Execute waves within operation lease ─────────────────────────────
  let leaseAborted = false;
  let leaseError: EditorialError[] | undefined;

  try {
    await withOperationLease(
      operationId,
      request.mutation.actorId,
      operationStore,
      leaseAbortController,
      async () => {
        for (const wave of wavePlan.waves) {
          if (operationSignal.aborted) {
            if (signal?.aborted) leaseAborted = true;
            return;
          }

          operationStore.heartbeat(operationId, request.mutation.actorId);

          // Materialise surface packets
          const { blocked: waveBlocked } = materializeSurfacePackets(
            schedulableJobs,
            wave.eventIds,
            acceptedByEventId,
            storage,
            paths,
            extractor,
            scopeHash,
            currentRunEventIds,
          );
          for (const br of waveBlocked) {
            allResults.push(br);
            const decision: ReleaseDecision = {
              status: 'blocked',
              scopeHash,
              validationIdentity: plan.planSummary.validationIdentity,
              reasons: br.errors.length > 0 ? [...br.errors] : ['MISSING_SURFACE_SOURCE'],
            };
            decisions.set(br.eventId, decision);
            sceneDispositions.set(br.eventId, 'candidate_blocked');
            completedScenes++;

            // Archive blocked candidate through SceneRevisionStore before latest CAS
            const waveBlockedJob = schedulableJobs.find((j) => j.event.id === br.eventId);
            if (waveBlockedJob) {
              const expectedLatestHash = expectedFileHash(
                waveBlockedJob.promotionReadSet,
                sceneStore.latestPath(br.eventId),
              );
              const previousAcceptedRevisionId =
                init.latestRevisions[br.eventId]?.revisionId ?? null;
              const envelope = buildRevisionEnvelope(
                br,
                waveBlockedJob,
                plan,
                operationId,
                request,
                decision,
                paths,
                previousAcceptedRevisionId,
                expectedLatestHash,
                revisionOverride,
              );
              sceneStore.archiveAndUpdateLatest(envelope, expectedLatestHash);
            }
          }
          const renderedIds = new Set(allResults.map((r) => r.eventId));
          const waveJobs = schedulableJobs.filter(
            (j) => wave.eventIds.includes(j.event.id) && !renderedIds.has(j.event.id),
          );
          if (waveJobs.length === 0) continue;

          // Emit scene progress
          for (const wj of waveJobs) {
            emit({
              kind: 'scene_started',
              eventId: wj.event.id,
              completedScenes,
              totalScenes,
            });
          }

          // Execute wave
          let waveResults: RenderSceneResult[];
          try {
            waveResults = request.batch
              ? (await new BatchRenderPipeline(pipeline).renderBatched(waveJobs, request.batch))
                  .results
              : await pipeline.renderAll(waveJobs);
          } catch (err) {
            const errMsg = `Wave ${wave.waveIndex} render failed: ${sanitizeError(err)}`;
            throw new EditorialOperationError('INVALID_OPERATION', errMsg, { operationId });
          }
          operationStore.heartbeat(operationId, request.mutation.actorId);

          // Release gate + archive
          for (const r of waveResults) {
            if (operationSignal.aborted) {
              if (signal?.aborted) leaseAborted = true;
              return;
            }
            operationStore.heartbeat(operationId, request.mutation.actorId);
            completedScenes++;
            const decision = evaluateReleaseDecision(
              r,
              scopeHash,
              plan.planSummary.validationIdentity,
            );

            // ── 6. PROMOTE ── Archive candidate then update latest (CAS)
            const job = schedulableJobs.find((j) => j.event.id === r.eventId);
            if (!job) {
              throw new EditorialOperationError(
                'SCENE_NOT_FOUND',
                `Compiled render job missing for ${r.eventId}`,
                { eventId: r.eventId, operationId },
              );
            }
            const expectedLatestHash = expectedFileHash(
              job.promotionReadSet,
              sceneStore.latestPath(r.eventId),
            );
            const acceptedRevisionId = init.latestRevisions[r.eventId]?.revisionId ?? null;
            const previousLatest =
              acceptedRevisionId === null ? null : sceneStore.get(r.eventId, acceptedRevisionId);
            let disposition: SceneDisposition;
            let revisionId: string | null = null;

            if (decision.status === 'accepted') {
              if (r.cacheHit && r.prose) {
                disposition = 'head_reused';
                const latestEnvelope = previousLatest;
                revisionId = latestEnvelope?.revisionId ?? null;
                if (latestEnvelope) {
                  acceptedByEventId.set(r.eventId, {
                    eventId: r.eventId,
                    prose: r.prose,
                    scopeHash,
                    releaseDecision: decision,
                    revisionId: latestEnvelope.revisionId,
                    proseHash: latestEnvelope.proseHash,
                    sceneHash: latestEnvelope.sceneHash,
                    editorialBasisHash: latestEnvelope.editorialBasisHash,
                    createdAt: latestEnvelope.createdAt,
                  });
                }
              } else {
                disposition = 'candidate_promoted';
                const envelope = buildRevisionEnvelope(
                  r,
                  job,
                  plan,
                  operationId,
                  request,
                  decision,
                  paths,
                  acceptedRevisionId,
                  expectedLatestHash,
                  revisionOverride,
                );
                revisionId = envelope.revisionId;
                sceneStore.archive(envelope);
                promotedEnvelopes.set(r.eventId, envelope);
                acceptedByEventId.set(r.eventId, {
                  eventId: r.eventId,
                  prose: r.prose,
                  scopeHash,
                  releaseDecision: decision,
                  revisionId: envelope.revisionId,
                  proseHash: envelope.proseHash,
                  sceneHash: envelope.sceneHash,
                  editorialBasisHash: envelope.editorialBasisHash,
                  createdAt: envelope.createdAt,
                });
              }
            } else if (decision.status === 'pending_waiver') {
              disposition = 'candidate_pending_waiver';
              const waiverEnvelope = buildRevisionEnvelope(
                r,
                job,
                plan,
                operationId,
                request,
                decision,
                paths,
                acceptedRevisionId,
                expectedLatestHash,
                revisionOverride,
              );
              revisionId = waiverEnvelope.revisionId;
              sceneStore.archiveAndUpdateLatest(waiverEnvelope, expectedLatestHash);
            } else {
              disposition = 'candidate_blocked';
              const blockedEnvelope = buildRevisionEnvelope(
                r,
                job,
                plan,
                operationId,
                request,
                decision,
                paths,
                acceptedRevisionId,
                expectedLatestHash,
                revisionOverride,
              );
              revisionId = blockedEnvelope.revisionId;
              sceneStore.archiveAndUpdateLatest(blockedEnvelope, expectedLatestHash);
            }
            operationStore.heartbeat(operationId, request.mutation.actorId);
            decisions.set(r.eventId, decision);
            sceneDispositions.set(r.eventId, disposition);
            revisionIds.set(r.eventId, revisionId);
            allResults.push(r);

            emit({
              kind: 'candidate_archived',
              eventId: r.eventId,
              disposition,
              completedScenes,
              totalScenes,
            });
          }
        }
      },
    );
  } catch (err) {
    // Pipeline crash or lost ownership during lease
    leaseError = [{ code: 'INVALID_OPERATION' as EditorialErrorCode, message: sanitizeError(err) }];
  }

  // ── Lease ended — heartbeat stopped, now handle result ───────────────
  if (leaseError) {
    const publishTerminal = emit.prepareTerminal({ kind: 'operation_failed' });
    operationStore.fail(operationId, request.mutation.actorId, leaseError);
    publishTerminal();
    return buildFailedResult(operationId, leaseError, plan.planSummary);
  }
  if (leaseAborted) {
    const publishTerminal = emit.prepareTerminal({ kind: 'operation_cancelled' });
    operationStore.cancel(operationId, request.mutation.actorId);
    publishTerminal();
    return buildCancelledResult(operationId, plan.planSummary);
  }

  const promotedRevisionIds = new Map<string, string>();
  for (const [eventId, revisionId] of revisionIds) {
    if (sceneDispositions.get(eventId) === 'candidate_promoted' && revisionId) {
      promotedRevisionIds.set(eventId, revisionId);
    }
  }

  // ── Reorder results to match job order ──────────────────────────────
  const resultByEventId = new Map(allResults.map((r) => [r.eventId, r]));
  const orderedResults = jobs
    .map((j) => resultByEventId.get(j.event.id))
    .filter((r): r is RenderSceneResult => r !== undefined);

  // ── 7. PUBLISH ──────────────────────────────────────────────────────
  const accepted = orderedResults.filter(
    (result) => decisions.get(result.eventId)?.status === 'accepted',
  );
  const unsuccessful = orderedResults.filter(
    (result) => decisions.get(result.eventId)?.status !== 'accepted',
  );
  const editorialErrors: EditorialError[] = [
    ...unsuccessful.map((result) => ({
      code: 'PUBLICATION_INCOMPLETE' as EditorialErrorCode,
      message: `Scene ${result.eventId} was not accepted: ${(
        decisions.get(result.eventId)?.reasons ?? result.errors
      ).join(', ')}`,
      eventId: result.eventId,
      operationId,
    })),
    ...revisionPreflightErrors,
  ];

  const scopeNarrativeEvents = init.events
    .filter(
      (event) => event.source === 'event_file' && boundaries.stateBeforeByEventId.has(event.id),
    )
    .sort(
      (left, right) =>
        left.narrativeOrder - right.narrativeOrder || left.id.localeCompare(right.id),
    );
  const scopeEvents: ScopeEventData[] = scopeNarrativeEvents.map((event) => ({
    eventId: event.id,
    narrativeOrder: event.narrativeOrder,
    threadProgress: event.threadProgress,
    foreshadowing: event.foreshadowing,
    relationshipEffects: event.relationshipEffects.map((effect) => ({
      membershipAfter: effect.membershipAfter,
      dimensionSet: effect.dimensionSet,
      provenance: effect.provenance,
    })),
    ruleEffects: event.ruleEffects,
  }));
  const scopeEventById = new Map(scopeEvents.map((event) => [event.eventId, event]));
  const publishCandidates: PromoteCandidateInput[] = [];
  for (const result of accepted) {
    const job = jobs.find((candidate) => candidate.event.id === result.eventId);
    const event = scopeEventById.get(result.eventId);
    const revisionId = revisionIds.get(result.eventId);
    if (!job || !event || !revisionId) {
      editorialErrors.push({
        code: 'PUBLICATION_INCOMPLETE',
        message: `Accepted scene ${result.eventId} has no verified head`,
        eventId: result.eventId,
        operationId,
      });
      continue;
    }
    const envelope = sceneStore.get(result.eventId, revisionId);
    const materializedScene = job.gameDialogue
      ? appendPlayerChoicesBlock(envelope.prose, job.gameDialogue.choices)
      : envelope.prose;
    const candidateProseSource = candidateExecution
      ? candidateExecution.lockAfter
        ? 'human_locked'
        : 'human_edited'
      : 'llm';
    const editAction = candidateExecution
      ? candidateExecution.origin === 'rollback'
        ? 'rollback'
        : 'human_adopted'
      : request.revision
        ? 'llm_revised'
        : 'llm_generated';
    const head: VerifiedHeadData = {
      revisionId: envelope.revisionId,
      proseHash: envelope.proseHash,
      prose: envelope.prose,
      sceneHash: envelope.sceneHash,
      editorialBasisHash: envelope.editorialBasisHash,
      scopeHash: envelope.scopeHash,
      validationIdentity: envelope.validationIdentity,
      proseSource: candidateProseSource,
      modelUsed: envelope.modelUsed,
      renderedAt: envelope.createdAt,
      wordCount: materializedScene.split(/\s+/).filter(Boolean).length,
      editHistory: [
        {
          action: editAction,
          actor_id: request.mutation.actorId,
          operation_id: operationId,
          timestamp: envelope.createdAt,
          revision_id: envelope.revisionId,
          review_ids: [...envelope.reviewIds],
          ...(candidateExecution?.note ? { note: candidateExecution.note } : {}),
        },
      ],
      playerChoices: job.gameDialogue?.choices,
      branchExistence: job.event.branchExistence ?? { type: 'all' },
    };
    publishCandidates.push({
      promote: sceneDispositions.get(result.eventId) === 'candidate_promoted',
      latestEnvelope: promotedEnvelopes.get(result.eventId),
      ...(candidateExecution?.lockAfter
        ? {
            lock: {
              actorId: request.mutation.actorId,
              lockedAt: envelope.createdAt,
            },
          }
        : {}),
      readSet: job.promotionReadSet,
      eventId: result.eventId,
      chapterNumber: job.chapter,
      head,
      event,
      scene: {
        prose: materializedScene,
        renderRequest:
          result.requestRecords.length > 0
            ? {
                eventId: result.eventId,
                chapter: job.chapter,
                logicalDisclosureSummary: job.logicalDisclosureSummary,
                surfaceReferencePacket: job.surfaceReferencePacket,
                requests: result.requestRecords,
              }
            : undefined,
      },
    });
  }

  // Add unchanged accepted heads needed to publish the complete branch scope.
  for (const event of scopeEvents) {
    if (publishCandidates.some((candidate) => candidate.eventId === event.eventId)) {
      continue;
    }
    const chapterNumber = init.chapterByEventId[event.eventId] ?? 1;
    const sceneDir = path.join(
      paths.scenesDir,
      `chapter-${String(chapterNumber).padStart(2, '0')}`,
    );
    const metadataPath = path.join(sceneDir, `${event.eventId}.yaml`);
    const scenePath = path.join(sceneDir, `${event.eventId}.md`);
    const metadataRaw = storage.readOptional(metadataPath);
    const sceneContent = storage.readOptional(scenePath);
    if (metadataRaw === null || sceneContent === null) continue;
    try {
      const metadata = sceneMetadataV1Schema.parse(YAML.parse(metadataRaw));
      const scopeCompatible =
        metadata.scope_hash === scopeHash ||
        Boolean(
          request.branchPath &&
            includesPath(metadata.branch_existence as BranchSet, request.branchPath),
        );
      if (
        metadata.event !== event.eventId ||
        !scopeCompatible ||
        computeContentHash(sceneContent) !== metadata.scene_hash
      ) {
        continue;
      }
      const envelope = sceneStore.get(event.eventId, metadata.revision_id);
      if (
        envelope.releaseDecision.status !== 'accepted' ||
        envelope.scopeHash !== metadata.scope_hash ||
        envelope.proseHash !== metadata.prose_hash ||
        envelope.sceneHash !== metadata.scene_hash ||
        envelope.editorialBasisHash !== metadata.editorial_basis_hash
      ) {
        continue;
      }
      publishCandidates.push({
        promote: false,
        eventId: event.eventId,
        chapterNumber,
        event,
        head: {
          revisionId: envelope.revisionId,
          proseHash: envelope.proseHash,
          prose: envelope.prose,
          sceneHash: envelope.sceneHash,
          editorialBasisHash: envelope.editorialBasisHash,
          scopeHash: envelope.scopeHash,
          validationIdentity: envelope.validationIdentity,
          proseSource: metadata.prose_source,
          modelUsed: metadata.model_used,
          renderedAt: metadata.rendered_at,
          wordCount: metadata.word_count,
          editHistory: metadata.edit_history,
          playerChoices: metadata.player_choices,
          branchExistence: metadata.branch_existence as BranchSet,
        },
        scene: { prose: sceneContent },
      });
    } catch {
      // Malformed or inconsistent heads are excluded; finalization stays stale.
    }
  }

  const chapterMetadata = new Map<number, { title: string }>();
  for (const [chapterNumber, chapter] of init.data.chapters) {
    chapterMetadata.set(chapterNumber, {
      title: chapter.metadata?.title ?? `Chapter ${chapterNumber}`,
    });
  }
  const hasCompleteScope =
    scopeEvents.length > 0 &&
    scopeEvents.every((event) =>
      publishCandidates.some((candidate) => candidate.eventId === event.eventId),
    ) &&
    editorialErrors.length === 0;
  if (!hasCompleteScope && editorialErrors.length === 0) {
    editorialErrors.push({
      code: 'PUBLICATION_INCOMPLETE',
      message: 'Not every branch-required scene has a verified current head',
      operationId,
    });
  }
  const sceneSeq = compiledRuntime.graphs.discourseGraph.sceneSequence;
  const novelContent = hasCompleteScope
    ? buildNovelDocument(publishCandidates, chapterMetadata, init.data.config?.title ?? 'Untitled', sceneSeq)
    : null;
  // The operation lease updates publication.json while rendering. Re-read its
  // authoritative preimage immediately before the final publication CAS.
  const publicationRawAtPublish = storage.readOptional(paths.publicationPath);
  const previousManifestAtPublish = loadOrCreatePublication(storage, paths.publicationPath);
  const publicationReadSetAtPublish = dedupeReadSet([
    ...publicationReadSet.filter(
      (expectation) =>
        expectation.kind !== 'file' || expectation.path !== paths.publicationPath,
    ),
    fileExpectation(storage, paths.publicationPath),
  ]);
  let publication: PublicationResult;
  try {
    publication = new EditorialPublisher(coordinator, paths).publish({
      scope: {
        projectDir: request.projectDir,
        branchScopeHash: scopeHash,
        scopeEventIds: scopeEvents.map((event) => event.eventId),
        scopeEvents,
        mutationContext: request.mutation,
      },
      candidates: publishCandidates,
      previousManifest: previousManifestAtPublish,
      previousManifestHash:
        publicationRawAtPublish === null ? null : computeContentHash(publicationRawAtPublish),
      novelContent,
      novelHash: novelContent === null ? null : computeContentHash(novelContent),
      reasons: editorialErrors,
      readSet: publicationReadSetAtPublish,
    });
  } catch (error) {
    const publicationErrors =
      error instanceof PublicationError ? [...error.reasons] : [toEditorialError(error)];
    if (publicationErrors.some((item) => item.code === 'PUBLICATION_CONTENT_CONFLICT')) {
      const conflictedNovel = storage.readOptional(paths.novelPath);
      if (conflictedNovel !== null) {
        const conflictPath = path.join(paths.conflictsDir, `novel-${operationId}.md`);
        coordinator.commit({
          transactionId: `${operationId}-novel-conflict`,
          readSet: [
            fileExpectation(storage, paths.novelPath),
            { kind: 'file', path: conflictPath, expectedHash: null },
          ],
          writes: [
            {
              type: 'put',
              path: conflictPath,
              content: conflictedNovel,
              expectedHash: null,
            },
          ],
        });
      }
    }
    for (const [eventId] of promotedRevisionIds) {
      sceneDispositions.set(eventId, 'candidate_stale');
    }
    const failedResults = orderedResults.map((result) =>
      mapSceneResult(
        result,
        decisions.get(result.eventId) ?? null,
        init.chapterByEventId[result.eventId] ?? 1,
        revisionIds.get(result.eventId) ?? null,
        sceneDispositions.get(result.eventId) ?? 'candidate_blocked',
        language,
      ),
    );
    const failedPublication: PublicationResult = {
      status: 'stale',
      outputPath: paths.novelPath,
      novelHash: previousManifestBeforeExecution.novel_hash,
      reasons: publicationErrors,
    };
    const failedResult: RenderNovelResult = {
      operationId,
      results: failedResults,
      errors: publicationErrors.map((item) => item.message),
      editorialErrors: publicationErrors,
      publication: failedPublication,
    };
    const publishTerminal = emit.prepareTerminal({
      kind: 'operation_failed',
      completedScenes,
      totalScenes,
    });
    operationStore.fail(operationId, request.mutation.actorId, publicationErrors);
    publishTerminal();
    return failedResult;
  }
  if (eventRevisionStates.length > 0) {
    applySceneLineReviews(promotedRevisionIds, eventRevisionStates, reviewMgr, operationId);
  }
  for (const [eventId] of promotedRevisionIds) {
    emit({
      kind: 'scene_promoted',
      eventId,
      disposition: 'candidate_promoted',
      completedScenes,
      totalScenes,
      phase: 'promotion',
    });
  }

  emit({
    kind: 'publication_updated',
    completedScenes: publishCandidates.length,
    totalScenes,
  });

  // ── Map results ─────────────────────────────────────────────────────
  const mappedResults = orderedResults.map((result) =>
    mapSceneResult(
      result,
      decisions.get(result.eventId) ?? null,
      init.chapterByEventId[result.eventId] ?? 1,
      revisionIds.get(result.eventId) ?? null,
      sceneDispositions.get(result.eventId) ?? 'candidate_blocked',
      language,
    ),
  );

  // Finalize operation
  const operationSucceeded = unsuccessful.length === 0 && publication.status === 'current';
  const resultErrors = editorialErrors.map((error) => error.message);
  const finalResult: RenderNovelResult = {
    operationId,
    results: mappedResults,
    errors: resultErrors,
    editorialErrors,
    publication,
  };
  const persistedResult: RenderNovelResult | SceneActionResult =
    candidateExecution && mappedResults.length > 0
      ? {
          operationId,
          eventId: candidateExecution.eventId,
          revisionId: mappedResults[0]?.revisionId ?? null,
          proseHash: mappedResults[0]?.revisionId
            ? sceneStore.get(candidateExecution.eventId, mappedResults[0].revisionId).proseHash
            : null,
          sceneHash: mappedResults[0]?.revisionId
            ? sceneStore.get(candidateExecution.eventId, mappedResults[0].revisionId).sceneHash
            : null,
          proseSource: mappedResults[0]?.promoted
            ? candidateExecution.lockAfter
              ? 'human_locked'
              : 'human_edited'
            : null,
          locked: Boolean(mappedResults[0]?.promoted && candidateExecution.lockAfter),
          released: mappedResults[0]?.released ?? false,
          promoted: mappedResults[0]?.promoted ?? false,
          releaseDecision: mappedResults[0]?.releaseDecision ?? null,
          publication,
          editorialErrors,
        }
      : finalResult;
  const publishTerminal = emit.prepareTerminal({
    kind: operationSucceeded ? 'operation_completed' : 'operation_failed',
    completedScenes,
    totalScenes,
  });
  if (operationSucceeded) {
    // Complete-scope feedback is addressed only when every selected scene
    // produced a new accepted head and canonical publication succeeded.
    if (eventRevisionStates.length > 0) {
      applyChapterNovelReviews(
        promotedRevisionIds,
        eventRevisionStates,
        reviewMgr,
        operationId,
        request.selector,
        plan.selectedEventIds,
      );
    }
    operationStore.succeed(operationId, request.mutation.actorId, persistedResult);
  } else {
    operationStore.fail(operationId, request.mutation.actorId, editorialErrors);
  }
  publishTerminal();

  return finalResult;
}

// ============================================================================
// previewEditorialRun — Compile-only preview (replaces old dryRun)
// ============================================================================

export interface PreviewResult {
  planHash: string;
  planSummary: EditorialPlanSummaryV1;
  selectedEventIds: readonly string[];
  scenes: ReadonlyArray<{
    eventId: string;
    state: EditorialPlanSummaryV1['scenes'][number]['state'];
    editorialBasisHash: string;
  }>;
  prompts: Array<{
    eventId: string;
    userPrompt: string;
  }>;
  errors: string[];
  editorialErrors: EditorialError[];
}
/**
 * Preview an editorial render: compile the plan and assemble prompts without
 * executing any provider calls or writing any storage artifacts.
 * Two successive previews with identical input always produce deep-equal output.
 * Zero storage writes, zero provider calls.
 */
export async function previewEditorialRun(
  request: Omit<EditorialRenderRequestV1, 'mutation'>,
  runtime: EditorialRuntime,
): Promise<PreviewResult> {
  const storage = runtime.storage ?? new FsStorage();

  // Resolve configured paths from project config
  const projectConfig = loadProjectConfig(path.join(request.projectDir, 'nova.yaml'), storage);
  const paths = resolveProjectPaths(request.projectDir, projectConfig?.outputDir);
  const coordinator = new ProjectTransactionCoordinator(storage, paths);

  const init = loadProjectData(storage, request.projectDir, request.branchPath, paths);
  const validationRuntime = await createValidationRuntime(init.data, request.projectDir, storage);
  const reviewComments = loadReviewComments(storage, coordinator, paths);
  const requiresProviderByEventId = computeRequiresProviderByEventId(
    init.events,
    request,
    init.data,
  );
  const compileInput = buildCompileInput(
    init,
    request,
    reviewComments,
    requiresProviderByEventId,
    validationRuntime.identityInput,
    paths,
  );
  const plan = compileEditorialRun(compileInput);

  // Check selector errors
  if (plan.selectorErrors.length > 0) {
    return {
      planHash: plan.planHash,
      planSummary: plan.planSummary,
      selectedEventIds: plan.selectedEventIds,
      scenes: plan.scenes.map((s) => ({
        eventId: s.eventId,
        state: s.state,
        editorialBasisHash: s.editorialBasisHash,
      })),
      prompts: [],
      errors: plan.selectorErrors.map((e) => e.message),
      editorialErrors: plan.selectorErrors.map((e) => ({
        code: e.code as EditorialErrorCode,
        message: e.message,
        ...(e.eventId ? { eventId: e.eventId } : {}),
      })),
    };
  }

  // Build prompts for each job
  const prompts: PreviewResult['prompts'] = [];
  const resolvedModel = request.model ?? init.data.config?.defaultModel ?? 'preview-model';

  // Build all jobs once (not inside the loop — the per-iteration rebuild in
  // the previous version produced N copies of each prompt for N compile jobs).
  // Resolve discourse branch — explicit override or unique ledger match.
  const discourseBranch =
    request.discourseBranch ??
    resolveDiscourseBranch({
      selectedEventIds: new Set(
        (request.branchPath != null
          ? init.events.filter((ev) => includesPath(ev.branchExistence, request.branchPath!))
          : init.events
        ).map((ev) => ev.id),
      ),
      branchPath: request.branchPath ?? { decisions: [] },
      ledger: init.data.discourseLedger,
    });

  const scopeHash = computeSha256Hex(
    canonicalJson({
      branch: request.branchPath ?? { decisions: [] },
      discourse: discourseBranch,
      ledgerHash: init.data.discourseLedger.hash,
    }),
  );
  // Build single production runtime for the preview branch.
  const previewInitialFacts: Fact[] = [
    ...init.events
      .filter((ev) => ev.id === 'system:genesis')
      .flatMap((ev) => ev.postconditions ?? []),
    ...init.registry.getAll().flatMap((entity) =>
      Object.entries(entity.state ?? {}).map(
        ([attribute, value]) =>
          ({
            id: `${entity.id}.${attribute}`,
            entityId: entity.id,
            attribute,
            value,
            validity: {
              temporal: { start: { type: 'absolute' as const, value: 'day_0' }, end: null },
              branches: { type: 'all' as const },
            },
          }) as Fact,
      ),
    ),
  ];
  // Prepare events with game dialogue tree scopes for preview.
  let previewEvents = init.events;
  const previewTemporalContext = resolveTemporalContext(init.events, init.data.timeAnchors);
  const previewGdTree = compileGameDialogueTree(init.events, previewTemporalContext);
  if (previewGdTree && previewGdTree.transitionEvents.length > 0 && request.branchPath) {
    previewEvents = init.events.map((ev) => {
      const scope = previewGdTree.eventScopes.get(ev.id);
      if (scope) return { ...ev, branchExistence: scope };
      return ev;
    });
    previewEvents = [...previewEvents, ...previewGdTree.transitionEvents];
  }
  const previewRuntime = compileNarrativeRuntime({
    events: previewEvents,
    initialFacts: previewInitialFacts,
    timeAnchors: init.data.timeAnchors,
    branchPath: request.branchPath,
    discourseBranch,
    ledger: init.data.discourseLedger,
    assertions: init.data.narratorAssertions,
    narratorProfiles: init.data.narratorProfiles,
    initialThreads: [],
  });

  const allEventFilePaths = [...init.data.chapters.values()]
    .flatMap((chapter) => chapter.events)
    .filter((ef: EventFile) => plan.selectedEventIds.includes(ef.event))
    .map((ef: EventFile) => ef.filePath)
    .filter((fp: string | undefined): fp is string => fp !== undefined);
  const previewJobs = buildRenderJobs(
    plan,
    init,
    request,
    computeSourceContentHash(
      allEventFilePaths,
      path.join(request.projectDir, 'definitions'),
      { branchDiscourseScopeHash: scopeHash },
      request.projectDir,
      storage,
    ),
    resolvedModel,
    previewRuntime,
  );

  for (const compileJob of plan.jobs) {
    if (!compileJob.requiresProvider) continue;
    const ev = init.events.find((e) => e.id === compileJob.eventId);
    if (!ev) continue;
    const job = previewJobs.find((j) => j.event.id === compileJob.eventId);
    if (!job) continue;

    const assembler = new PromptAssembler();
    const assembled = assembler.assemble(job.context, {
      targetLengthWords: ev.styleGuidance?.targetWordCount ?? 400,
      styleGuidance: ev.styleGuidance,
      language: init.data.config?.defaultLanguage ?? 'en',
      logicalDisclosureSummary: job.logicalDisclosureSummary,
      surfaceReferencePacket: job.surfaceReferencePacket,
    });
    prompts.push({
      eventId: ev.id,
      userPrompt: assembled.userPrompt,
    });
  }

  return {
    planHash: plan.planHash,
    planSummary: plan.planSummary,
    selectedEventIds: plan.selectedEventIds,
    scenes: plan.scenes.map((s) => ({
      eventId: s.eventId,
      state: s.state,
      editorialBasisHash: s.editorialBasisHash,
    })),
    prompts,
    errors: plan.selectorErrors.map((e) => e.message),
    editorialErrors: plan.selectorErrors.map((e) => ({
      code: e.code as EditorialErrorCode,
      message: e.message,
      ...(e.eventId ? { eventId: e.eventId } : {}),
    })),
  };
}

// ============================================================================
// executeEditorialTreeRender — Game dialogue tree as one top-level operation
// ============================================================================

/**
 * Render a game dialogue tree as one top-level operation.
 *
 * Compiles the game dialogue tree, renders each node via
 * executeEditorialRender, and assembles the final tree when all nodes pass.
 * No recursive public render call, no novel publication until all nodes output.
 */
export async function executeEditorialTreeRender(
  request: RenderGameDialogueTreeRequestV1,
  runtime: EditorialRuntime,
): Promise<RenderGameDialogueTreeResult> {
  const storage = runtime.storage ?? new FsStorage();

  // Load project config first to resolve configured output directory
  const projectConfig = loadProjectConfig(path.join(request.projectDir, 'nova.yaml'), storage);
  const paths = resolveProjectPaths(request.projectDir, projectConfig?.outputDir);
  const coordinator = new ProjectTransactionCoordinator(storage, paths);
  const clock = REAL_CLOCK;
  const operationStore = new OperationStore(coordinator, paths, clock);
  const signal = runtime.signal;

  const operationId = request.mutation.operationId ?? crypto.randomUUID();

  if (signal?.aborted) {
    return {
      operationId,
      tree: { eventScopes: {}, representativePathByEventId: {}, choicesByEventId: {} },
      results: [],
      errors: ['Operation cancelled before start'],
      editorialErrors: [{ code: 'OPERATION_CANCELLED', message: 'Cancelled before start' }],
      outputPath: undefined,
      publication: { status: 'stale', outputPath: paths.novelPath, novelHash: null, reasons: [] },
    };
  }
  // Load project
  const mapper = new EntityMapper(request.projectDir, storage);
  const data = mapper.loadProject();
  const validationRuntime = await createValidationRuntime(data, request.projectDir, storage);
  const registry = new InMemoryEntityRegistry();
  registry.load(request.projectDir, storage);
  const events = [...data.chapters.values()]
    .flatMap((ch: { events: EventFile[] }) => ch.events)
    .map((ef: EventFile) => mapper.mapToNarrativeEvent(ef));
  const contentEvents = events.filter((event) => event.source === 'event_file');

  // Compile game dialogue tree
  const temporalContext = resolveTemporalContext(events, data.timeAnchors);
  const tree = compileGameDialogueTree(events, temporalContext);

  if (!tree) {
    return {
      operationId,
      tree: { eventScopes: {}, representativePathByEventId: {}, choicesByEventId: {} },
      results: [],
      errors: ['No event-local choices found; render-tree requires a game dialogue tree'],
      editorialErrors: [{ code: 'INVALID_OPERATION', message: 'No game dialogue tree found' }],
      outputPath: undefined,
      publication: { status: 'stale', outputPath: paths.novelPath, novelHash: null, reasons: [] },
    };
  }
  // Validate every content event has a representative path
  const missingRepPath = contentEvents.filter((ev) => !tree.representativePathByEventId.has(ev.id));
  if (missingRepPath.length > 0) {
    return {
      operationId,
      tree: {
        eventScopes: Object.fromEntries(tree.eventScopes),
        representativePathByEventId: Object.fromEntries(tree.representativePathByEventId),
        choicesByEventId: Object.fromEntries(
          Array.from(tree.choicesByEventId).map(([k, v]) => [k, [...v]]),
        ),
      },
      results: [],
      errors: [
        `Tree events missing representative path: ${missingRepPath.map((e) => e.id).join(', ')}`,
      ],
      editorialErrors: [
        { code: 'INVALID_OPERATION', message: 'Missing representative path for tree events' },
      ],
      outputPath: undefined,
      publication: { status: 'stale', outputPath: paths.novelPath, novelHash: null, reasons: [] },
    };
  }

  // Guard: no renderSurface
  if (data.config?.renderSurface) {
    return {
      operationId,
      tree: {
        eventScopes: Object.fromEntries(tree.eventScopes),
        representativePathByEventId: Object.fromEntries(tree.representativePathByEventId),
        choicesByEventId: Object.fromEntries(
          Array.from(tree.choicesByEventId).map(([k, v]) => [k, [...v]]),
        ),
      },
      results: [],
      errors: ['render-tree does not support renderSurface scheduling.'],
      editorialErrors: [
        { code: 'INVALID_OPERATION', message: 'renderSurface not supported for tree render' },
      ],
      outputPath: undefined,
      publication: { status: 'stale', outputPath: paths.novelPath, novelHash: null, reasons: [] },
    };
  }


  // Claim operation
  const requestHash = computeSha256Hex(
    canonicalJson({ ...request, mutation: { operationId, actorId: request.mutation.actorId } }),
  );
  let _operation: EditorialOperationV1;
  try {
    _operation = operationStore.register({
      operationId,
      kind: 'render_tree',
      actorId: request.mutation.actorId,
      requestHash,
    });
  } catch (err) {
    return {
      operationId,
      tree: {
        eventScopes: Object.fromEntries(tree.eventScopes),
        representativePathByEventId: Object.fromEntries(tree.representativePathByEventId),
        choicesByEventId: Object.fromEntries(
          Array.from(tree.choicesByEventId).map(([k, v]) => [k, [...v]]),
        ),
      },
      results: [],
      errors: [`Failed to register operation: ${(err as Error).message}`],
      editorialErrors: [toEditorialError(err)],
      outputPath: undefined,
      publication: { status: 'stale', outputPath: paths.novelPath, novelHash: null, reasons: [] },
    };
  }
  // Provider resolution is lazy — handled by each RenderPipeline instance via
  // runtime.provider / runtime.providerFactory / config fallback.

  // Create shared pipeline and store
  const sceneStore = new SceneRevisionStore(coordinator, paths);
  const eventBus = runtime.eventBus;
  const language = 'en';
  const eventLogger = new Logger(
    runtime.trace ? undefined : new LevelFilterTransport(new JsonlLogTransport()),
    { module: 'editorial-tree-render' },
  );
  const traceCollector = runtime.trace
    ? new TraceCollector(`tree-render-${operationId}`)
    : undefined;

  // Capture publication read set before any provider calls
  const scopeEventIds = contentEvents
    .filter((ev) => tree.representativePathByEventId.has(ev.id))
    .sort(
      (left, right) =>
        left.narrativeOrder - right.narrativeOrder || left.id.localeCompare(right.id),
    )
    .map((ev) => ev.id);
  const treeChapterByEventId: Record<string, number> = {};
  for (const [chNum, ch] of data.chapters) {
    for (const ef of ch.events) {
      treeChapterByEventId[ef.event] = chNum;
    }
  }
  const treeScopeInit = {
    data,
    chapterByEventId: treeChapterByEventId,
  };
  const publicationRawBeforeExecution = storage.readOptional(paths.publicationPath);
  const previousManifestBeforeExecution = loadOrCreatePublication(storage, paths.publicationPath);
  const publicationReadSet = capturePublicationReadSet(
    storage,
    paths,
    treeScopeInit,
    scopeEventIds,
  );

  // Post-loop tracking for publication
  const decisions = new Map<string, ReleaseDecision>();
  const dialogueTreeOutputPath = path.join(request.projectDir, 'output', 'dialogue-tree.md');
  publicationReadSet.push(fileExpectation(storage, dialogueTreeOutputPath));
  const sceneDispositions = new Map<string, SceneDisposition>();
  const revisionIds = new Map<string, string | null>();
  const acceptedPromotedEnvs = new Map<string, SceneRevisionEnvelopeV1>();
  const allRenderJobs = new Map<string, RenderJob>();

  const allResults: RenderNovelSceneResult[] = [];
  const errors: string[] = [];
  let _hasFailure = false;

  // ── Execute event processing within operation lease ─────────────────
  let treeAborted = false;

  const treeLeaseAbortController = new AbortController();
  if (signal?.aborted) {
    treeLeaseAbortController.abort(signal.reason);
  } else {
    signal?.addEventListener('abort', () => treeLeaseAbortController.abort(signal.reason), {
      once: true,
    });
  }

  try {
    await withOperationLease(
      operationId,
      request.mutation.actorId,
      operationStore,
      treeLeaseAbortController,
      async () => {
        // ── Pre-compute leaf-route discourse branches for dedup ────────
        // Enumerate leaf paths and resolve their discourse branch.
        // Shared events (e.g. E0) that appear under multiple branches with
        // the same discourse context are deduplicated.
        const leafRouteDedup = new Map<string, BranchPath>();
        for (const leafPath of tree.leafPaths) {
          const routeEventIds = contentEvents
            .filter((event) =>
              includesPath(tree.eventScopes.get(event.id) ?? event.branchExistence, leafPath),
            )
            .map((event) => event.id);
          const discourseBranch = resolveDiscourseBranch({
            selectedEventIds: new Set(routeEventIds),
            branchPath: leafPath,
            ledger: data.discourseLedger,
          });
          for (const eventId of routeEventIds) {
            const key = `${eventId}\x00${discourseBranch}`;
            if (!leafRouteDedup.has(key)) {
              leafRouteDedup.set(key, leafPath);
            }
          }
        }

        for (const [dedupKey, branchPath] of leafRouteDedup) {
          const nullIdx = dedupKey.indexOf('\x00');
          const eventId = dedupKey.slice(0, nullIdx);
          const discourseBranch = dedupKey.slice(nullIdx + 1);

          if (treeLeaseAbortController.signal.aborted) {
            if (signal?.aborted) treeAborted = true;
            return;
          }

          operationStore.heartbeat(operationId, request.mutation.actorId);

          const ev = contentEvents.find(e => e.id === eventId);
          if (!ev) {
            errors.push(`Event '${eventId}' not found for dedup key '${dedupKey}'`);
            _hasFailure = true;
            continue;
          }

          try {
            // ── 1. Build scene request with explicit discourse branch ─────────
            const sceneRequest: EditorialRenderRequestV1 = {
              version: 1,
              projectDir: request.projectDir,
              selector: { type: 'events', eventIds: [ev.id] },
              mutation: request.mutation,
              model: request.model,
              providerProfile: request.providerProfile,
              branchPath,
              discourseBranch,  // explicit — avoids re-resolution in buildBoundariesAndJobs
              waivers: request.waivers,
              maxRounds: request.maxRounds,
            };

            // ── 2. Load project data for this branch ─────────────────────────
            const init = loadProjectData(storage, request.projectDir, branchPath, paths);
            const reviewComments = loadReviewComments(storage, coordinator, paths);
            const requiresProviderByEventId = computeRequiresProviderByEventId(
              init.events,
              sceneRequest,
              init.data,
            );

            // ── 3. Compile scene plan ────────────────────────────────────────
            const compileInput = buildCompileInput(
              init,
              sceneRequest,
              reviewComments,
              requiresProviderByEventId,
              validationRuntime.identityInput,
              paths,
            );
            const plan = compileEditorialRun(compileInput);

            if (plan.selectorErrors.length > 0) {
              for (const se of plan.selectorErrors) {
                errors.push(`${ev.id}: ${se.message}`);
              }
              _hasFailure = true;
              continue;
            }

            // Provider check is lazy — RenderPipeline handles missing provider
            // as per-scene PROVIDER_REQUIRED during real completion calls.

            // ── 5. Build source hash & render jobs ───────────────────────────
            const resolvedModel = request.model ?? init.data.config?.defaultModel ?? 'default';
            const eventFilePaths = [...init.data.chapters.values()]
              .flatMap((chapter) => chapter.events)
              .filter((ef: EventFile) => ef.event === ev.id)
              .map((ef: EventFile) => ef.filePath)
              .filter((fp: string | undefined): fp is string => fp !== undefined);
            const definitionsDir = path.join(request.projectDir, 'definitions');
            // Use pre-computed discourse branch (no re-resolution needed).
            const scopeHash = computeSha256Hex(
              canonicalJson({
                branch: branchPath ?? { decisions: [] },
                discourse: discourseBranch,
                ledgerHash: init.data.discourseLedger.hash,
              }),
            );
            const sourceContentHash = computeSourceContentHash(
              eventFilePaths,
              definitionsDir,
              { branchDiscourseScopeHash: scopeHash },
              request.projectDir,
              storage,
            );
            const { jobs } = buildBoundariesAndJobs(
              init,
              plan,
              sceneRequest,
              sourceContentHash,
              resolvedModel,
              storage,
            );

            if (jobs.length === 0) {
              // No work needed — cache hit, head reused, etc.
              continue;
            }

            // Attach tree-wide publication read set to each job
            for (const job of jobs) {
              job.promotionReadSet = dedupeReadSet([
                ...publicationReadSet,
                fileExpectation(storage, sceneStore.latestPath(job.event.id)),
              ]);
              allRenderJobs.set(job.event.id, job);
            }

            // ── 6. Execute pipeline ──────────────────────────────────────────
            // Build provider chain for this node: runtime.provider > runtime.providerFactory > config fallback
            const nodeProviderFactory: ProviderFactory | undefined =
              runtime.providerFactory ??
              (!runtime.provider
                ? {
                    profile: 'config',
                    create: async () => {
                      let fallbackModel = request.model;
                      const apiKey = process.env.NOVALISTICALLY_AI_API_KEY ?? '';
                      const baseUrl: string | undefined =
                        process.env.NOVALISTICALLY_AI_BASE_URL ?? undefined;
                      if (!fallbackModel) {
                        fallbackModel = process.env.NOVALISTICALLY_AI_MODEL ?? undefined;
                      }
                      if (!fallbackModel) {
                        throw new Error(
                          'PROVIDER_REQUIRED: No LLM provider available: no model configured',
                        );
                      }
                      if (!apiKey) {
                        throw new Error(
                          'PROVIDER_REQUIRED: No LLM provider available: NOVALISTICALLY_AI_API_KEY is not configured',
                        );
                      }
                      return new AiSdkProvider({ apiKey, baseURL: baseUrl, model: fallbackModel });
                    },
                  }
                : undefined);
            const pipeline = new RenderPipeline({
              provider: runtime.provider,
              providerFactory: nodeProviderFactory,
              providerProfile: request.providerProfile,
              model: resolvedModel,
              cacheDir: paths.renderCacheDir,
              storage,
              language,
              logger: eventLogger,
              traceCollector,
              eventBus,
              aggregator: validationRuntime.aggregator,
              validatorOverrides: validationRuntime.overrides,
              analysisContract: validationRuntime.analysisContract,
              entityRegistry: init.registry,
              pluginHooksManager: validationRuntime.pluginHooksManager,
              maxRounds: request.maxRounds,
              concurrency: runtime.concurrency,
              signal: treeLeaseAbortController.signal,
            });

            const waveResults = await pipeline.renderAll(jobs);

            // ── 7. Evaluate, archive, promote ────────────────────────────────
            for (const r of waveResults) {
              const decision = evaluateReleaseDecision(
                r,
                scopeHash,
                plan.planSummary.validationIdentity,
              );

              let disposition: SceneDisposition;
              let revisionId: string | null = null;

              if (decision.status === 'accepted') {
                if (r.cacheHit && r.prose) {
                  disposition = 'head_reused';
                  const acceptedRevisionId = init.latestRevisions[r.eventId]?.revisionId ?? null;
                  revisionId = acceptedRevisionId;
                } else {
                  disposition = 'candidate_promoted';
                  const job = jobs.find((j) => j.event.id === r.eventId);
                  if (job) {
                    const expectedLatestHash = expectedFileHash(
                      job.promotionReadSet,
                      sceneStore.latestPath(r.eventId),
                    );
                    const previousAcceptedRevisionId =
                      init.latestRevisions[r.eventId]?.revisionId ?? null;
                    const envelope = buildRevisionEnvelope(
                      r,
                      job,
                      plan,
                      operationId,
                      sceneRequest,
                      decision,
                      paths,
                      previousAcceptedRevisionId,
                      expectedLatestHash,
                    );
                    revisionId = envelope.revisionId;
                    sceneStore.archive(envelope);
                    acceptedPromotedEnvs.set(r.eventId, envelope);
                  }
                }
              } else if (decision.status === 'pending_waiver') {
                disposition = 'candidate_pending_waiver';
                const bjob = allRenderJobs.get(r.eventId);
                if (bjob) {
                  const expHash = expectedFileHash(
                    bjob.promotionReadSet,
                    sceneStore.latestPath(r.eventId),
                  );
                  const previousAcceptedRevisionId =
                    init.latestRevisions[r.eventId]?.revisionId ?? null;
                  const envelope = buildRevisionEnvelope(
                    r,
                    bjob,
                    plan,
                    operationId,
                    sceneRequest,
                    decision,
                    paths,
                    previousAcceptedRevisionId,
                    expHash,
                  );
                  sceneStore.archiveAndUpdateLatest(envelope, expHash);
                }
              } else {
                disposition = 'candidate_blocked';
                const bjob = allRenderJobs.get(r.eventId);
                if (bjob) {
                  const expHash = expectedFileHash(
                    bjob.promotionReadSet,
                    sceneStore.latestPath(r.eventId),
                  );
                  const previousAcceptedRevisionId =
                    init.latestRevisions[r.eventId]?.revisionId ?? null;
                  const envelope = buildRevisionEnvelope(
                    r,
                    bjob,
                    plan,
                    operationId,
                    sceneRequest,
                    decision,
                    paths,
                    previousAcceptedRevisionId,
                    expHash,
                  );
                  sceneStore.archiveAndUpdateLatest(envelope, expHash);
                }
              }

              decisions.set(r.eventId, decision);
              sceneDispositions.set(r.eventId, disposition);
              revisionIds.set(r.eventId, revisionId);

              const chapter = init.chapterByEventId[r.eventId] ?? 1;
              const mappedResult = mapSceneResult(
                r,
                decision,
                chapter,
                revisionId,
                disposition,
                language,
              );
              allResults.push(mappedResult);

              if (decision.status !== 'accepted') {
                errors.push(`${r.eventId}: ${(decision.reasons ?? r.errors).join(', ')}`);
                _hasFailure = true;
              }
            }
          } catch (err) {
            errors.push(`${ev.id}: ${sanitizeError(err)}`);
            _hasFailure = true;
          }
        }
      },
    );
  } catch (err) {
    errors.push(`Tree render lease error: ${sanitizeError(err)}`);
    _hasFailure = true;
  }

  // ── Lease ended — heartbeat stopped, handle abort ──────────────────
  if (treeAborted) {
    operationStore.cancel(operationId, request.mutation.actorId);
    return buildTreeResult(tree, allResults, errors, operationId, paths);
  }

  // ── Publish tree-wide via EditorialPublisher ────────────────────────
  const resultByEventId = new Map(allResults.map((r) => [r.eventId, r]));
  const orderedResults = contentEvents
    .filter((ev) => tree.representativePathByEventId.has(ev.id))
    .map((ev) => resultByEventId.get(ev.id))
    .filter((r): r is RenderNovelSceneResult => r !== undefined);

  const accepted = orderedResults.filter(
    (result) => decisions.get(result.eventId)?.status === 'accepted',
  );
  const unsuccessful = orderedResults.filter(
    (result) => decisions.get(result.eventId)?.status !== 'accepted',
  );
  const editorialErrors: EditorialError[] = unsuccessful.map((result) => ({
    code: 'PUBLICATION_INCOMPLETE' as EditorialErrorCode,
    message: `Scene ${result.eventId} was not accepted: ${(
      decisions.get(result.eventId)?.reasons ?? result.errors
    ).join(', ')}`,
    eventId: result.eventId,
    operationId,
  }));

  // Build scope events from tree
  const scopeNarrativeEvents = contentEvents
    .filter((ev) => tree.representativePathByEventId.has(ev.id))
    .sort(
      (left, right) =>
        left.narrativeOrder - right.narrativeOrder || left.id.localeCompare(right.id),
    );
  const scopeEvents: ScopeEventData[] = scopeNarrativeEvents.map((event) => ({
    eventId: event.id,
    narrativeOrder: event.narrativeOrder,
    threadProgress: event.threadProgress,
    foreshadowing: event.foreshadowing,
    relationshipEffects: event.relationshipEffects.map((effect) => ({
      membershipAfter: effect.membershipAfter,
      dimensionSet: effect.dimensionSet,
      provenance: effect.provenance,
    })),
    ruleEffects: event.ruleEffects,
  }));
  const scopeEventById = new Map(scopeEvents.map((event) => [event.eventId, event]));

  // Build publish candidates from accepted results
  const publishCandidates: PromoteCandidateInput[] = [];
  for (const result of accepted) {
    const eventId = result.eventId;
    const event = scopeEventById.get(eventId);
    const revisionId = revisionIds.get(eventId);
    const disposition = sceneDispositions.get(eventId);
    if (!event || !revisionId) {
      editorialErrors.push({
        code: 'PUBLICATION_INCOMPLETE',
        message: `Accepted scene ${eventId} has no verified head`,
        eventId,
        operationId,
      });
      continue;
    }
    const envelope = sceneStore.get(eventId, revisionId);
    const job = allRenderJobs.get(eventId);
    const materializedScene = job?.gameDialogue
      ? appendPlayerChoicesBlock(envelope.prose, job.gameDialogue.choices)
      : envelope.prose;
    const head: VerifiedHeadData = {
      revisionId: envelope.revisionId,
      proseHash: envelope.proseHash,
      prose: envelope.prose,
      sceneHash: envelope.sceneHash,
      editorialBasisHash: envelope.editorialBasisHash,
      scopeHash: envelope.scopeHash,
      validationIdentity: envelope.validationIdentity,
      proseSource: 'llm',
      modelUsed: envelope.modelUsed,
      renderedAt: envelope.createdAt,
      wordCount: materializedScene.split(/\s+/).filter(Boolean).length,
      editHistory: [
        {
          action: 'llm_generated',
          actor_id: request.mutation.actorId,
          operation_id: operationId,
          timestamp: envelope.createdAt,
          revision_id: envelope.revisionId,
          review_ids: [...envelope.reviewIds],
        },
      ],
      playerChoices: job?.gameDialogue?.choices,
      branchExistence: tree.eventScopes.get(eventId) ?? { type: 'all' },
    };
    publishCandidates.push({
      promote: disposition === 'candidate_promoted',
      latestEnvelope:
        disposition === 'candidate_promoted' ? acceptedPromotedEnvs.get(eventId) : undefined,
      readSet: job?.promotionReadSet,
      eventId,
      chapterNumber: treeChapterByEventId[eventId] ?? 1,
      head,
      event,
      scene: {
        prose: materializedScene,
      },
    });
  }

  let treeComplete =
    accepted.length === scopeEventIds.length &&
    editorialErrors.length === 0 &&
    scopeEventIds.length > 0;
  const assembled = treeComplete
    ? assembleGameDialogueTree({
        projectDir: request.projectDir,
        storage,
        tree,
        eventsById: new Map(contentEvents.map((event) => [event.id, event])),
        chapterByEventId: new Map(
          Array.from(data.chapters.entries()).flatMap(([chapter, definition]) =>
            definition.events.map((event: EventFile) => [event.event, chapter] as [string, number]),
          ),
        ),
        responsesDir: paths.responsesDir,
        sceneContents: new Map(
          publishCandidates.map((candidate) => [candidate.eventId, candidate.scene.prose]),
        ),
      })
    : null;
  if (treeComplete && assembled === null) {
    editorialErrors.push({
      code: 'PUBLICATION_INCOMPLETE',
      message: 'Dialogue tree could not be assembled from verified scene heads',
      operationId,
    });
    treeComplete = false;
  }
  const publication = new EditorialPublisher(coordinator, paths).publish({
    scope: {
      projectDir: request.projectDir,
      branchScopeHash: computeSha256Hex(
        canonicalJson({
          branch: { decisions: [] },
          discourse: 'main',
          ledgerHash: data.discourseLedger.hash,
        }),
      ),
      scopeEventIds: scopeEvents.map((event) => event.eventId),
      scopeEvents,
      mutationContext: request.mutation,
    },
    candidates: publishCandidates,
    previousManifest: previousManifestBeforeExecution,
    previousManifestHash:
      publicationRawBeforeExecution === null
        ? null
        : computeContentHash(publicationRawBeforeExecution),
    novelContent: null,
    novelHash: null,
    reasons: editorialErrors,
    readSet: publicationReadSet,
    publicationMode: 'tree',
    additionalWrites: assembled
      ? [
          {
            type: 'put',
            path: dialogueTreeOutputPath,
            content: assembled.markdown,
            expectedHash: null,
          },
        ]
      : [],
    outputPath: dialogueTreeOutputPath,
  });
  treeComplete = treeComplete && publication.status === 'current';
  const outputPath = treeComplete ? dialogueTreeOutputPath : undefined;

  const result: RenderGameDialogueTreeResult = {
    operationId,
    tree: {
      eventScopes: Object.fromEntries(tree.eventScopes),
      representativePathByEventId: Object.fromEntries(tree.representativePathByEventId),
      choicesByEventId: Object.fromEntries(
        Array.from(tree.choicesByEventId).map(([k, v]) => [k, [...v]]),
      ),
    },
    results: orderedResults,
    errors,
    editorialErrors,
    ...(treeComplete && assembled ? { dialogueTree: assembled.markdown } : {}),
    outputPath,
    publication,
  };

  if (treeComplete) {
    operationStore.succeed(
      operationId,
      request.mutation.actorId,
      result satisfies RenderGameDialogueTreeResult,
    );
  } else {
    operationStore.fail(operationId, request.mutation.actorId, editorialErrors);
  }

  return result;
}

// ============================================================================
// Internal helpers
// ============================================================================
function buildCancelledResult(
  operationId: string,
  _planSummary?: EditorialPlanSummaryV1,
): RenderNovelResult {
  return {
    operationId,
    results: [],
    errors: ['Operation cancelled'],
    editorialErrors: [{ code: 'OPERATION_CANCELLED', message: 'Cancelled' }],
    publication: { status: 'stale', outputPath: '', novelHash: null, reasons: [] },
  };
}

function buildFailedResult(
  operationId: string,
  editorialErrors: EditorialError[],
  _planSummary?: EditorialPlanSummaryV1,
): RenderNovelResult {
  return {
    operationId,
    results: [],
    errors: editorialErrors.map((e) => e.message),
    editorialErrors,
    publication: { status: 'stale', outputPath: '', novelHash: null, reasons: [] },
  };
}

function buildTreeResult(
  tree: CompiledGameDialogueTree,
  results: RenderNovelSceneResult[],
  errors: string[],
  operationId: string,
  paths: ProjectPaths,
): RenderGameDialogueTreeResult {
  const eventScopes: Record<string, BranchSet> =
    'eventScopes' in tree ? (tree.eventScopes as unknown as Record<string, BranchSet>) : {};
  return {
    operationId,
    tree: {
      eventScopes,
      representativePathByEventId: Object.fromEntries(tree.representativePathByEventId),
      choicesByEventId: Object.fromEntries(
        Array.from(tree.choicesByEventId).map(([k, v]) => [k, [...v]]),
      ),
    },
    results,
    errors,
    editorialErrors: [],
    outputPath: undefined,
    publication: { status: 'stale', outputPath: paths.novelPath, novelHash: null, reasons: [] },
  };
}
