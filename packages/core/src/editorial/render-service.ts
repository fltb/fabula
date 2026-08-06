// ============================================================================
// Editorial Render Service — Compile → Plan → Execute → Promote → Publish
// ----------------------------------------------------------------------------
// The renderer consumes only immutable author source snapshots
// (request.source + sourceHash) and explicit semantic runtime services. It
// never reads host paths or cache files:
//
//   - accepted scenes / revisions / reviews / operations flow through
//     CoreExecutionRepository (runtime.services.execution)
//   - render records flow through RenderCacheRepository
//     (runtime.services.renderCache)
//   - prose generation flows through runtime.services.llm (or an explicit
//     runtime.provider / runtime.providerFactory, mutually exclusive)
//
// Pipeline stages:
//   1. COMPILE   — pure compileEditorialRun over the immutable snapshot
//   2. PREFLIGHT — selector / revision / lock errors
//   3. SURFACE   — configured groups + lanes → per-job surfaceDependency
//   4. EXECUTE   — wave-based RenderPipeline::renderAll with surface packets
//   5. PROMOTE   — accepted scenes/revisions via execution repository CAS
//   6. PUBLISH   — release-gate publication summary + operation record
// ============================================================================

import { BatchRenderPipeline } from '../batch-renderer.ts';
import type { CompiledGameDialogueTree } from '../branch/game-dialogue-tree.ts';
import { sha256 } from '../cache/pure-sha256.ts';
import { resolveReleasePolicy } from '../config/defaults.ts';
import { ContextCompiler } from '../context/compiler.ts';
import { PromptAssembler } from '../context/prompt-assembler.ts';
import type { JsonValue } from '../contracts/json.js';
import type { ProjectSourceSnapshotV1 } from '../contracts/source.ts';
import type { ProjectData } from '../entity/index.js';
import {
  type CanonicalProjectIR,
  compileCanonicalRuntime,
  loadCanonicalProject,
} from '../entity/project-runtime.ts';
import type { TypedEventBus } from '../event-bus.ts';
import { TraceCollector } from '../observability/trace.ts';
import {
  evaluateReleaseDecision,
  InteractionManager,
  PASS1_PROMPT_TEMPLATE_NAME,
  type ProviderCallLedgerEntry,
  type RenderJob,
  RenderPipeline,
  type RenderPipelineOptions,
  type RenderSceneResult,
  SurfaceScheduler,
} from '../pipeline/index.ts';
import { appendPlayerChoicesBlock } from '../pipeline/output.ts';
import type { PluginHooksManager } from '../plugin/hooks-manager.ts';
import type {
  AcceptedSceneRecord,
  CoreExecutionRepository,
} from '../ports/execution-repository.ts';
import type { Clock, IdGenerator } from '../ports/runtime-services.ts';
import { buildReferencePacket } from '../reference.ts';
import { canonicalJson, compileSceneContract, computeSha256Hex } from '../render/scene-contract.ts';
import { SurfacePlanner } from '../render/surface-planner.ts';
import { ReviewManager } from '../review/manager.ts';
import { resolveDiscourseBranch } from '../state/discourse-sequence.ts';
import type { CompiledNarrativeRuntime } from '../state/narrative-runtime.ts';
import { LogicalDisclosureSummaryCompiler, SurfaceReferenceExtractor } from '../summary/index.ts';
import type { BranchPath } from '../types/branch.ts';
import type { SystemContext } from '../types/context.ts';
import type {
  EditorialError,
  EditorialErrorCode,
  EditorialPlanSummaryV1,
  EditorialRenderRequestV1,
  EditorialRuntime,
  ProviderCallLedgerEntryV1,
  PublicationResult,
  RenderGameDialogueTreeRequestV1,
  RenderGameDialogueTreeResult,
  RenderNovelResult,
  RenderNovelSceneResult,
  RevisionRequest,
  SceneDisposition,
  SceneRevisionEnvelopeV1,
  SceneRevisionOrigin,
} from '../types/editorial.ts';
import type {
  EntityTypeCatalog,
  NarrativeEvent,
  ReleaseDecision,
  RevisionContext,
  Validator,
} from '../types/index.ts';
import type {
  AcceptedSceneArtifact,
  RenderGroup,
  SurfacePlannerOptions,
  SurfacePlanResult,
} from '../types/render-surface.ts';
import type { ReviewApplicationV1, ReviewComment } from '../types/review.ts';
import { ResultAggregator } from '../validator/aggregator.ts';
import { createBuiltInValidators } from '../validator/builtins.ts';
import {
  compileEditorialRun,
  type EditorialCompileInput,
  type EditorialCompileOutput,
  sortReviewFeedback,
} from './compiler.ts';
import { EditorialOperationError } from './errors.ts';
import { reviewServices } from './facade.ts';
import {
  BUILT_IN_VALIDATOR_IMPLEMENTATION_VERSION,
  type PluginValidationIdentity,
  type ValidationIdentityInput,
} from './identity.ts';
import { preflightSelector, type SceneCatalog } from './selector.ts';

// ============================================================================
// Local helpers
// ============================================================================
interface ProjectInitialization {
  readonly ir: CanonicalProjectIR;
  readonly data: ProjectData;
  readonly events: readonly NarrativeEvent[];
  readonly registry: CanonicalProjectIR['registry'];
  readonly entityTypes: EntityTypeCatalog;
  readonly chapterByEventId: Readonly<Record<string, number>>;
  readonly eventContents: Record<string, string>;
  readonly sourceDocumentContents: Record<string, string>;
  readonly catalog: SceneCatalog;
}

function documentContents(source: ProjectSourceSnapshotV1): Record<string, string> {
  const contents: Record<string, string> = {};
  for (const document of source.documents) {
    contents[document.logicalPath] = document.content;
  }
  return contents;
}

/** Event-file bytes only — `chapters/chapter_NN/E*.yaml` documents. */
function eventContents(source: ProjectSourceSnapshotV1): Record<string, string> {
  const contents: Record<string, string> = {};
  for (const document of source.documents) {
    const match = /^chapters\/chapter_\d+\/(E[^/]+)\.ya?ml$/i.exec(document.logicalPath);
    if (match) contents[match[1]] = document.content;
  }
  return contents;
}
function initialize(source: ProjectSourceSnapshotV1): ProjectInitialization {
  const ir = loadCanonicalProject(source);
  return {
    ir,
    data: ir.data,
    events: ir.authoredEvents,
    registry: ir.registry,
    entityTypes: ir.entityTypes,
    chapterByEventId: ir.chapterByEventId,
    eventContents: eventContents(source),
    sourceDocumentContents: documentContents(source),
    catalog: {
      events: ir.authoredEvents.map((event) => ({
        eventId: event.id,
        narrativeOrder: event.narrativeOrder,
        chapter: ir.chapterByEventId[event.id] ?? 1,
      })),
    },
  };
}

function requiresProviderByEventId(
  events: readonly NarrativeEvent[],
  request: Omit<EditorialRenderRequestV1, 'mutation'>,
  data: ProjectData,
): Record<string, boolean> {
  const enabled = Boolean(
    request.revision || request.model || request.providerProfile || data.config?.defaultModel,
  );
  const result: Record<string, boolean> = {};
  for (const event of events) result[event.id] = enabled;
  return result;
}

/**
 * Deterministic PluginValidationIdentity list from the active hooks manager.
 * Covers name/version/manifestHash/moduleHash/hook names/validator names so
 * any plugin change (different moduleHash included) shifts validationIdentity,
 * planHash, and the render cache key. Empty when no manager is present.
 */
function pluginValidationIdentities(
  manager: PluginHooksManager | undefined,
): PluginValidationIdentity[] {
  if (!manager) return [];
  return manager.getPluginIdentities().map((identity) => {
    const version = identity.version ?? '';
    const promptHookIdentity = sha256(
      canonicalJson({
        version: identity.version,
        manifestHash: identity.manifestHash,
        moduleHash: identity.moduleHash,
        hooks: identity.hooks,
      }),
    );
    return {
      name: identity.name,
      version,
      manifestHash: identity.manifestHash ?? '',
      moduleHash: identity.moduleHash ?? '',
      hookNames: identity.hooks,
      validators: manager.getPluginValidatorIdentities(identity.name),
      promptHookIdentity,
    };
  });
}

/**
 * Plugin validators registered through the hooks manager, merged into the
 * same validator set the pipeline validates with. Absent manager → built-ins
 * only (today's exact behavior).
 */
function pluginValidators(manager: PluginHooksManager | undefined): readonly Validator[] {
  return manager?.getValidators() ?? [];
}

function buildCompileInput(
  init: ProjectInitialization,
  request: Omit<EditorialRenderRequestV1, 'mutation'>,
  reviewComments: readonly ReviewComment[],
  latestRevisions: Record<string, { revisionId: string; proseHash: string } | null>,
  pluginHooksManager?: PluginHooksManager,
): EditorialCompileInput {
  const overrides = { ...(init.data.config?.validatorOverrides ?? {}) };
  const aggregator = new ResultAggregator(
    [...createBuiltInValidators(), ...pluginValidators(pluginHooksManager)],
    init.entityTypes,
  );
  const analysisContract = aggregator.getAnalysisContract(overrides);
  const validation: ValidationIdentityInput = {
    analysisContractHash: analysisContract.hash,
    builtInValidatorImplementationVersion: BUILT_IN_VALIDATOR_IMPLEMENTATION_VERSION,
    effectiveOverrides: overrides,
    validators: aggregator.listValidatorIdentities(BUILT_IN_VALIDATOR_IMPLEMENTATION_VERSION),
    plugins: pluginValidationIdentities(pluginHooksManager),
  };
  return {
    request: {
      version: 1,
      source: request.source,
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
    source: request.source,
    catalog: init.catalog,
    eventContents: init.eventContents,
    validation,
    reviewComments,
    sourceDocumentContents: init.sourceDocumentContents,
    latestRevisions,
    chapterByEventId: { ...init.chapterByEventId },
    requiresProviderByEventId: requiresProviderByEventId(init.events, request, init.data),
  };
}

// ============================================================================
// RenderJob construction (pure, snapshot-derived)
// ============================================================================

function buildRenderJobs(
  plan: EditorialCompileOutput,
  init: ProjectInitialization,
  request: Omit<EditorialRenderRequestV1, 'mutation'>,
  projectId: string,
  sourceHash: string,
  model: string,
  runtime: CompiledNarrativeRuntime,
  revisionStates: ReadonlyMap<string, EventRevisionState>,
  reviewComments: readonly ReviewComment[],
): RenderJob[] {
  const jobs: RenderJob[] = [];
  const referencePacket =
    request.referencePacket === undefined
      ? undefined
      : request.referencePacket.projectId !== projectId
        ? (() => {
            throw new EditorialOperationError(
              'REFERENCE_PROJECT_MISMATCH',
              `Reference packet belongs to ${request.referencePacket?.projectId}, not ${projectId}.`,
            );
          })()
        : buildReferencePacket(
            request.referencePacket.projectId,
            request.referencePacket.citations,
          );
  const boundaries = runtime.boundaries;
  const discourseContextByEventId = runtime.discourseContextsByEventId;
  const techniquesByEventId = runtime.graphs.techniquesByEventId;
  const graphHash = computeSha256Hex(
    canonicalJson({
      story: runtime.graphs.storyGraph.hash,
      discourse: runtime.graphs.discourseGraph.hash,
    }),
  );
  const sysCtx: SystemContext = {
    genre: init.data.config?.genre ?? 'literary',
    style: 'literary',
    narrativeRules: [],
    thematicIntent: init.data.config?.ideaIR?.thematicIntent,
    synopsis: init.data.config?.synopsis,
  };
  const disclosureCompiler = new LogicalDisclosureSummaryCompiler();
  const renderEvents = init.events.filter((event) => plan.selectedEventIds.includes(event.id));

  for (const event of renderEvents) {
    const intent = plan.intents.find((job) => job.eventId === event.id);
    if (!intent?.requiresProvider) continue;

    const discourseCtx = discourseContextByEventId[event.id];
    const chapterNum = init.chapterByEventId[event.id] ?? 1;
    const beforeState = boundaries.stateBeforeByEventId.get(event.id);
    if (!beforeState) continue;

    const narrativeTechniques = techniquesByEventId.get(event.id) ?? [];
    const pkg = new ContextCompiler().compile(event, beforeState, init.registry, {
      systemContext: sysCtx,
      narratorProfiles: init.data.narratorProfiles,
      ruleDeclarations: init.data.ruleDeclarations,
      threadDeclarations: init.data.worldInitialState.threads,
      discourseContext: discourseCtx,
      narrativeTechniques,
    });

    const worldStateHash = computeSha256Hex(canonicalJson(beforeState));
    const knowledgeStateHash = computeSha256Hex(
      canonicalJson({
        ledger: beforeState.epistemicLedger,
        propositions: beforeState.propositionCatalog,
        commonGround: beforeState.commonGround,
      }),
    );
    const narratorProfileHash = computeSha256Hex(canonicalJson(init.data.narratorProfiles));
    const plannedDiscourseHash = discourseCtx
      ? computeSha256Hex(`${discourseCtx.ledgerHash}|${discourseCtx.assertionCatalogHash}`)
      : '';
    const sceneTransition: 'continuous' | 'flashback' | 'time_jump' | 'hard_cut' =
      event.sceneType === 'linear'
        ? 'continuous'
        : event.sceneType === 'flashback'
          ? 'flashback'
          : event.sceneType === 'flashforward'
            ? 'time_jump'
            : 'hard_cut';

    const contract = compileSceneContract({
      sceneId: event.id,
      branch: request.branchPath ?? { decisions: [] },
      discoursePosition: discourseCtx?.cursor ?? 0,
      worldStateHash,
      knowledgeStateHash,
      narratorProfileHash,
      plannedDiscourseHash,
      styleHints: {
        chapterStyle: String(chapterNum),
        narratorPovStyle: event.narratorProfileRef,
      },
      continuityDirectives: { transition: sceneTransition },
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

    const revisionState = revisionStates.get(event.id);
    let revisionContext: RevisionContext | undefined;
    let editorialRevisionInstructions: string | undefined;
    let editorialReviewIds: readonly string[] | undefined;
    if (revisionState?.state === 'will_revise' && revisionState.baseProse !== null) {
      const appliedReviews = reviewComments.filter((review) =>
        revisionState.applicableReviewIds.includes(review.id),
      );
      const directive = composeRevisionDirective(request.revision?.instruction, appliedReviews);
      const context = buildRevisionContextForJob(revisionState, directive);
      revisionContext = context.revisionContext;
      editorialRevisionInstructions = context.editorialRevisionInstructions;
      editorialReviewIds = revisionState.applicableReviewIds;
    }

    jobs.push({
      event,
      stateBefore: beforeState,
      context: pkg,
      chapter: chapterNum,
      contract,
      graphHash,
      sourceContentHash: sourceHash,
      logicalDisclosureSummary,
      referencePacket,
      surfaceDependency: {
        groupId: event.id,
        policy: 'parallel' as const,
        manifestHash: computeSha256Hex(
          canonicalJson({
            eventId: event.id,
            contractHash: contract.promptContractHash,
            policy: 'parallel',
          }),
        ),
      },
      revisionContext,
      editorialRevisionInstructions,
      editorialReviewIds,
    });
  }

  // Deterministic discourse scene sequence for planning/input order.
  const sceneOrder = new Map<string, number>();
  for (const entry of runtime.graphs.discourseGraph.sceneSequence) {
    sceneOrder.set(entry.sceneId, entry.sequence);
  }
  jobs.sort((a, b) => (sceneOrder.get(a.event.id) ?? 999) - (sceneOrder.get(b.event.id) ?? 999));
  return jobs;
}

// ============================================================================
// Configured surface plan (pure, from renderSurface config)
// ============================================================================
function compileConfiguredSurfacePlan(
  data: ProjectData,
  jobs: readonly RenderJob[],
  branchPath: BranchPath | undefined,
  clock: Clock,
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
  return new SurfacePlanner(options, clock).plan();
}

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
// Surface packet materialization (semantic — accepted artifacts only)
// ============================================================================

async function materializeSurfacePackets(
  jobs: readonly RenderJob[],
  waveEventIds: readonly string[],
  acceptedByEventId: ReadonlyMap<string, AcceptedSceneArtifact>,
  execution: CoreExecutionRepository,
  projectId: string,
  extractor: SurfaceReferenceExtractor,
): Promise<{ blocked: RenderSceneResult[] }> {
  const blocked: RenderSceneResult[] = [];

  for (const job of jobs) {
    if (!waveEventIds.includes(job.event.id)) continue;
    const predecessorId = job.surfaceDependency.predecessorEventId;
    if (!predecessorId) continue;

    const accepted = acceptedByEventId.get(predecessorId);
    if (accepted) {
      job.surfaceReferencePacket = extractor.extract(accepted, job.event.id);
      continue;
    }

    const record = await execution.resolveAcceptedArtifact({ projectId, eventId: predecessorId });
    if (record) {
      const artifact: AcceptedSceneArtifact = {
        eventId: record.eventId,
        revisionId: record.revisionId,
        prose: record.prose,
        proseHash: record.proseHash,
        sceneHash: record.sceneHash,
        editorialBasisHash: '',
        scopeHash: '',
        releaseDecision: { status: 'accepted', scopeHash: '', validationIdentity: '', reasons: [] },
        createdAt: '',
      };
      job.surfaceReferencePacket = extractor.extract(artifact, job.event.id);
      continue;
    }

    // Policy allows rendering without a surface source.
    if (job.surfaceDependency.policy === 'fallback_without_surface') continue;

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
// Result mapping
// ============================================================================

function mapProviderCallEntry(entry: ProviderCallLedgerEntry): ProviderCallLedgerEntryV1 {
  return {
    phase: entry.phase,
    attempt: entry.attempt,
    outcome: entry.outcome,
    requestHash: entry.requestHash,
    model: entry.model,
    seed: entry.seed,
    failureReason: entry.failureReason,
  };
}

function mapSceneResult(
  result: RenderSceneResult,
  decision: ReleaseDecision | null,
  revisionId: string | null,
  disposition: SceneDisposition,
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

function buildPublication(
  selectedEventIds: readonly string[],
  decisions: ReadonlyMap<string, ReleaseDecision>,
  editorialErrors: readonly EditorialError[],
): PublicationResult {
  if (selectedEventIds.length === 0) {
    return { status: 'unchanged', outputPath: '', novelHash: null, reasons: [] };
  }
  const anyBlocked = selectedEventIds.some(
    (eventId) => (decisions.get(eventId)?.status ?? 'blocked') !== 'accepted',
  );
  const status: PublicationResult['status'] =
    anyBlocked || editorialErrors.length > 0 ? 'stale' : 'current';
  return { status, outputPath: '', novelHash: null, reasons: [...editorialErrors] };
}

// ============================================================================
// Revision envelope + promotion (semantic repository records)
// ============================================================================
function buildRevisionEnvelope(
  result: RenderSceneResult,
  job: RenderJob,
  plan: EditorialCompileOutput,
  operationId: string,
  request: EditorialRenderRequestV1,
  decision: ReleaseDecision,
  parentRevisionId: string | null,
  clock: Clock,
  ids: IdGenerator,
  override?: {
    origin: SceneRevisionOrigin;
    restoredFromRevisionId?: string;
  },
): SceneRevisionEnvelopeV1 {
  const sceneInfo = plan.scenes.find((s) => s.eventId === result.eventId);
  const revisionId = ids.next({ kind: 'scene_revision' });
  const now = clock.now();
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
    proseHash: sha256(result.prose),
    sceneHash: sha256(materializedScene),
    editorialBasisHash: sceneInfo?.editorialBasisHash ?? '',
    scopeHash: sceneInfo?.scopeHash ?? '',
    validationIdentity: sceneInfo?.validationIdentity ?? '',
    modelUsed: request.model,
    feedbackHash: null,
    reviewIds: [],
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
    promotionReadSet: [],
    requestRecords: result.requestRecords.map((r) => ({
      phase: r.phase,
      attempt: r.attempt,
      requestHash: r.requestHash,
      messages: r.messages,
      responseContent: r.responseContent ?? null,
    })),
    createdAt: now,
  };
}

/**
 * One accepted-head CAS payload captured during candidate execution. The
 * revision envelope is appended to the append-only scene revision archive by
 * `executeEditorialCandidates`; the accepted head CAS itself is deferred to
 * `commitEditorialCandidates`, which must match `expectedVersion` (the head
 * revision read at candidate time) or the candidate is stale.
 */
export interface EditorialSceneCommitV1 {
  readonly eventId: string;
  readonly revisionId: string;
  readonly envelope: SceneRevisionEnvelopeV1;
  readonly expectedVersion: number | null;
  /** Render errors of the candidate, folded into the blocked decision on conflict. */
  readonly resultErrors: readonly string[];
}

/**
 * Everything a detached commit needs to promote accepted scenes without
 * provider calls or compilation: per-event commit payloads plus the state
 * required to assemble the final render result afterwards.
 */
export interface EditorialCandidateSetV1 {
  readonly version: 1;
  readonly operationId: string;
  readonly projectId: string;
  readonly sourceHash: string;
  readonly request: EditorialRenderRequestV1;
  readonly candidateExecution?: EditorialCandidateExecution;
  readonly planHash: string;
  readonly planSummary: EditorialPlanSummaryV1;
  readonly selectedEventIds: readonly string[];
  /** Render results in deterministic display order (chapter, narrativeOrder, eventId). */
  readonly orderedResults: readonly RenderSceneResult[];
  readonly decisions: ReadonlyMap<string, ReleaseDecision>;
  readonly sceneDispositions: ReadonlyMap<string, SceneDisposition>;
  readonly revisionIds: ReadonlyMap<string, string | null>;
  readonly editorialErrors: readonly EditorialError[];
  readonly commits: readonly EditorialSceneCommitV1[];
  readonly trace: TraceCollector;
  readonly completedScenes: number;
  readonly totalScenes: number;
}

/**
 * Outcome of `executeEditorialCandidates`: a preflight failure that must be
 * returned as-is (no commit, no operation record), or a commit-ready
 * candidate set.
 */
export type EditorialCandidatesOutcome =
  | { readonly kind: 'failed'; readonly result: RenderNovelResult }
  | { readonly kind: 'candidates'; readonly candidateSet: EditorialCandidateSetV1 };

/** Per-event accepted-head CAS outcome from `commitEditorialCandidates`. */
export interface EditorialHeadCommitOutcomeV1 {
  readonly eventId: string;
  readonly status: 'accepted' | 'conflict';
  readonly revisionId: string;
}

/**
 * Result of `commitEditorialCandidates`. `stale` is true when ANY head CAS
 * conflicted: the whole operation is stale, publication is forbidden, and the
 * already-appended candidate revisions remain as auditable stale candidates.
 */
export interface EditorialCommitResultV1 {
  readonly version: 1;
  readonly stale: boolean;
  readonly outcomes: readonly EditorialHeadCommitOutcomeV1[];
  readonly publication: PublicationResult;
  readonly decisions: ReadonlyMap<string, ReleaseDecision>;
  readonly sceneDispositions: ReadonlyMap<string, SceneDisposition>;
  readonly revisionIds: ReadonlyMap<string, string | null>;
  readonly editorialErrors: readonly EditorialError[];
}

interface AcceptedSceneRecordLike {
  version: 1;
  projectId: string;
  eventId: string;
  sourceHash: string;
  revisionId: string;
  prose: string;
  proseHash: string;
  sceneHash: string;
  value?: JsonValue;
}

// ============================================================================
// Shared result helpers
// ============================================================================

function buildFailedResult(
  operationId: string,
  editorialErrors: readonly EditorialError[],
  _planSummary: EditorialPlanSummaryV1,
): RenderNovelResult {
  return {
    operationId,
    results: [],
    errors: editorialErrors.map((error) => error.message),
    editorialErrors: [...editorialErrors],
    publication: {
      status: 'stale',
      outputPath: '',
      novelHash: null,
      reasons: [...editorialErrors],
    },
  };
}

// ============================================================================
// Progress events
// ============================================================================

function createProgressEmitter(
  eventBus: TypedEventBus | undefined,
  operationId: string,
  clock: Clock,
): {
  emit(event: {
    kind: string;
    eventId?: string;
    phase?: string;
    completedScenes?: number;
    totalScenes?: number;
    disposition?: string;
  }): void;
} {
  let sequence = 0;
  return {
    emit(event) {
      if (!eventBus) return;
      sequence++;
      eventBus.emit('editorial:progress', {
        version: 1,
        operationId,
        sequence,
        timestamp: clock.now(),
        ...event,
      });
    },
  };
}

// ============================================================================
// Runtime assertion
// ============================================================================

function assertRuntime(runtime: EditorialRuntime): asserts runtime is EditorialRuntime & {
  services: NonNullable<EditorialRuntime['services']>;
} {
  if (runtime.provider && runtime.providerFactory) {
    throw new EditorialOperationError(
      'PROVIDER_REQUIRED',
      'Cannot provide both provider and providerFactory',
    );
  }
  if (!runtime.services) {
    throw new EditorialOperationError('INVALID_OPERATION', 'Runtime services are required');
  }
}

/**
 * Resolve the current accepted scene head for every event from the semantic
 * execution repository, scoped to the given immutable source hash. Only
 * `readAcceptedScene` (`{revision, value}`) records are used — never the
 * render cache. Events without an accepted head for THIS source hash are
 * simply absent from the returned map, so a stale-source head never acts as
 * a base (or revision preflight base) for a newer source render.
 */
async function resolveAcceptedHeads(
  execution: CoreExecutionRepository,
  projectId: string,
  eventIds: readonly string[],
  sourceHash: string,
): Promise<ReadonlyMap<string, AcceptedSceneRecord>> {
  const records = await Promise.all(
    eventIds.map(async (eventId) => {
      const read = await execution.readAcceptedScene({ projectId, eventId });
      if (!read || read.value.sourceHash !== sourceHash) return null;
      return [eventId, read.value] as const;
    }),
  );
  const accepted = new Map<string, AcceptedSceneRecord>();
  for (const entry of records) {
    if (entry) accepted.set(entry[0], entry[1]);
  }
  return accepted;
}

/**
 * Map resolved accepted heads onto the compiler's `latestRevisions` input:
 * `null` for every selected event without an accepted head, so the editorial
 * basis hash reflects the real base revision/prose identity.
 */
function buildLatestRevisions(
  eventIds: readonly string[],
  acceptedHeads: ReadonlyMap<string, AcceptedSceneRecord>,
): Record<string, { revisionId: string; proseHash: string } | null> {
  const latest: Record<string, { revisionId: string; proseHash: string } | null> = {};
  for (const eventId of eventIds) {
    const head = acceptedHeads.get(eventId);
    latest[eventId] = head ? { revisionId: head.revisionId, proseHash: head.proseHash } : null;
  }
  return latest;
}

/**
 * Events under an explicit revision request that have no accepted base block
 * with the canonical `NO_ACCEPTED_BASE` preflight error before any provider
 * call.
 */
function collectNoAcceptedBaseErrors(
  revisionStates: readonly EventRevisionState[],
): EditorialError[] {
  const errors: EditorialError[] = [];
  for (const state of revisionStates) {
    if (state.state !== 'will_revise' || state.baseProse !== null) continue;
    errors.push({
      code: 'NO_ACCEPTED_BASE',
      message: `Revision request for scene "${state.eventId}" requires an accepted base, but no accepted scene exists.`,
      eventId: state.eventId,
    });
  }
  return errors;
}

// ============================================================================
// Exported revision-state helpers (pure)
// ============================================================================

export interface EventRevisionState {
  eventId: string;
  state: 'will_revise' | 'no_revision_needed' | 'preflight_failed';
  applicableReviewIds: readonly string[];
  baseRevisionId: string | null;
  baseProseHash: string | null;
  /** Previous accepted prose text; null when no accepted base is resolved. */
  baseProse: string | null;
  /** Ordered hashes of reviewer feedback entries for the event. */
  feedbackHashes: readonly string[];
  /** Hash of the YAML-authored revision instruction; null when absent. */
  revisionInstructionHash: string | null;
  errors: readonly EditorialError[];
}

export function buildEventRevisionStates(
  eventIds: readonly string[],
  revisionRequest: RevisionRequest | undefined,
  reviewComments: readonly ReviewComment[],
  acceptedByEventId?: ReadonlyMap<string, { revisionId: string; proseHash: string; prose: string }>,
): EventRevisionState[] {
  return eventIds.map((eventId) => {
    const applicableReviews = sortReviewFeedback(
      reviewComments.filter((review) => review.target.id === eventId),
    );
    const accepted = acceptedByEventId?.get(eventId);
    return {
      eventId,
      state: revisionRequest ? 'will_revise' : 'no_revision_needed',
      applicableReviewIds: applicableReviews.map((review) => review.id),
      baseRevisionId: accepted?.revisionId ?? null,
      baseProseHash: accepted?.proseHash ?? null,
      baseProse: accepted?.prose ?? null,
      feedbackHashes: applicableReviews.map((review) => sha256(review.content)),
      revisionInstructionHash: revisionRequest?.instruction
        ? sha256(revisionRequest.instruction)
        : null,
      errors: [],
    };
  });
}

export function buildRevisionContextForJob(
  state: EventRevisionState,
  revisionDirective?: string,
): {
  revisionContext?: RevisionContext;
  editorialRevisionInstructions?: string;
} {
  if (state.state !== 'will_revise') return {};
  return {
    revisionContext: {
      baseRevisionId: state.baseRevisionId ?? '',
      baseProse: state.baseProse ?? '',
      baseProseHash: state.baseProseHash ?? '',
      feedbackHashes: state.feedbackHashes,
      revisionInstructionHash: state.revisionInstructionHash ?? '',
    },
    ...(revisionDirective ? { editorialRevisionInstructions: revisionDirective } : {}),
  };
}

/**
 * Compose the canonical Pass-1 revision directive: the YAML-authored request
 * instruction first, then each applicable review's content in the canonical
 * feedback order (scope, creation time, immutable ID). Deterministic for a
 * given request + review ledger; undefined when there is nothing to direct.
 */
export function composeRevisionDirective(
  instruction: string | undefined,
  reviews: readonly ReviewComment[],
): string | undefined {
  const parts: string[] = [];
  if (instruction !== undefined && instruction.trim() !== '') {
    parts.push(instruction.trim());
  }
  for (const review of sortReviewFeedback(reviews)) {
    const content = review.content.trim();
    if (content === '') continue;
    parts.push(`[${review.id}] ${content}`);
  }
  if (parts.length === 0) return undefined;
  return parts.join('\n');
}

export interface EditorialCandidateExecution {
  operationKind: 'adopt_scene' | 'rollback_scene';
  eventId: string;
  prose: string;
  lockAfter?: boolean;
  note?: string;
  origin?: 'adopt' | 'rollback';
  restoredFromRevisionId?: string;
}

export function computeCandidateOperationRequestHash(
  request: EditorialRenderRequestV1,
  candidateExecution: EditorialCandidateExecution,
): string {
  return sha256(JSON.stringify({ request, candidateExecution }));
}

// ============================================================================
// executeEditorialCandidates — compile + provider + validation + archive
// ----------------------------------------------------------------------------
// Everything up to but NOT including accepted-scene CAS / publication CAS /
// operation completion: compile, provider calls, Pass 2, validation, release
// decision and the append-only scene revision archive. In-run generated
// scenes feed subsequent surface waves ONLY through the in-memory
// `acceptedByEventId` map — they never become repository accepted heads until
// `commitEditorialCandidates` runs.
// ============================================================================

export async function executeEditorialCandidates(
  request: EditorialRenderRequestV1,
  runtime: EditorialRuntime,
  candidateExecution?: EditorialCandidateExecution,
): Promise<EditorialCandidatesOutcome> {
  assertRuntime(runtime);
  const execution = runtime.services.execution;
  const operationId = request.mutation.operationId;
  const emit = createProgressEmitter(runtime.eventBus, operationId, runtime.services.clock);
  emit.emit({ kind: 'operation_started' });

  // ── 1. COMPILE (immutable snapshot + resolved accepted heads) ─────────
  const init = initialize(request.source);
  const projectId = init.data.config?.project ?? 'default-project';
  const reviewManager = new ReviewManager(execution, projectId);
  const reviewComments = await reviewManager.getComments();
  // Release policy: legacy projects without `releasePolicy` get the canonical
  // accept-and-record default — never inferred from pending_waiver history.
  const releasePolicy = resolveReleasePolicy(init.data.config?.releasePolicy);
  // Pre-granted waivers (request.waivers) seed the gate manager so explicit
  // waivers are honored under require-waiver policies.
  const waiverManager = new InteractionManager();
  for (const waiver of request.waivers ?? []) {
    waiverManager.recordWaiver(waiver.gateId, waiver.reason, waiver.signedBy);
  }
  const preflight = preflightSelector(request.selector, init.catalog);
  const acceptedHeads = await resolveAcceptedHeads(
    execution,
    projectId,
    preflight.eventIds,
    request.source.sourceHash,
  );
  const plan = compileEditorialRun(
    buildCompileInput(
      init,
      request,
      reviewComments,
      buildLatestRevisions(preflight.eventIds, acceptedHeads),
      runtime.pluginHooksManager,
    ),
  );

  if (plan.selectorErrors.length > 0) {
    const editorialErrors = plan.selectorErrors.map((error) => ({
      code: error.code as EditorialErrorCode,
      message: error.message,
      ...(error.eventId ? { eventId: error.eventId } : {}),
    }));
    emit.emit({ kind: 'operation_failed' });
    return {
      kind: 'failed',
      result: buildFailedResult(operationId, editorialErrors, plan.planSummary),
    };
  }

  // Revision preflight: every explicitly revised scene must resolve an
  // accepted base. Missing bases block before any provider call.
  const revisionStates = new Map(
    buildEventRevisionStates(
      plan.selectedEventIds,
      request.revision,
      reviewComments,
      acceptedHeads,
    ).map((state) => [state.eventId, state] as const),
  );
  const noAcceptedBaseErrors = collectNoAcceptedBaseErrors([...revisionStates.values()]);
  if (noAcceptedBaseErrors.length > 0) {
    emit.emit({ kind: 'operation_failed' });
    return {
      kind: 'failed',
      result: buildFailedResult(operationId, noAcceptedBaseErrors, plan.planSummary),
    };
  }

  // ── 2. Canonical runtime + surface plan ──────────────────────────────
  const discourseBranch = request.discourseBranch;
  const compiledRuntime = compileCanonicalRuntime(init.ir, {
    branchPath: request.branchPath,
    discourseBranch,
  });
  const resolvedModel = request.model ?? init.data.config?.defaultModel ?? 'default';

  const jobs = buildRenderJobs(
    plan,
    init,
    request,
    projectId,
    request.source.sourceHash,
    resolvedModel,
    compiledRuntime,
    revisionStates,
    reviewComments,
  );
  if (init.data.config?.renderSurface) {
    const surfacePlan = compileConfiguredSurfacePlan(
      init.data,
      jobs,
      request.branchPath,
      runtime.services.clock,
    );
    if (surfacePlan) applySurfacePlanToJobs(jobs, surfacePlan);
  }

  // Candidate adoption/rollback renders the supplied prose without Pass 1.
  if (candidateExecution) {
    const candidateJob = jobs.find((job) => job.event.id === candidateExecution.eventId);
    if (candidateJob) candidateJob.proseCandidate = candidateExecution.prose;
  }

  const traceCollector = new TraceCollector(operationId, operationId, runtime.services.clock);
  const pipeline = buildPipeline(runtime, init, plan, request, resolvedModel, traceCollector);

  // ── 3. Wave-based execution ──────────────────────────────────────────
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

  const acceptedByEventId = new Map<string, AcceptedSceneArtifact>();
  const { blocked: preBlocked } = await materializeSurfacePackets(
    jobs,
    subsetDependentIds,
    acceptedByEventId,
    execution,
    projectId,
    extractor,
  );
  const preBlockedIds = new Set(preBlocked.map((result) => result.eventId));
  const schedulableJobs = jobs.filter((job) => !preBlockedIds.has(job.event.id));
  for (const job of schedulableJobs) {
    const predecessor = job.surfaceDependency.predecessorEventId;
    if (predecessor !== undefined && !currentRunEventIds.has(predecessor)) {
      job.surfaceDependency.predecessorEventId = undefined;
    }
  }

  const wavePlan = new SurfaceScheduler().buildWavePlan(schedulableJobs);
  if (wavePlan.missingPredecessors.length > 0 || wavePlan.cycleParticipants.length > 0) {
    const missing = wavePlan.missingPredecessors
      .map((m) => `${m.eventId} -> ${m.predecessorEventId}`)
      .join(', ');
    const cycles = wavePlan.cycleParticipants.join(', ');
    const message = `Surface dependency validation failed:${
      missing ? ` missing predecessors: ${missing}` : ''
    }${cycles ? ` cycle participants: ${cycles}` : ''}`;
    const editorialErrors: EditorialError[] = [{ code: 'INVALID_OPERATION', message }];
    emit.emit({ kind: 'operation_failed' });
    return {
      kind: 'failed',
      result: buildFailedResult(operationId, editorialErrors, plan.planSummary),
    };
  }

  const allResults: RenderSceneResult[] = [...preBlocked];
  const decisions = new Map<string, ReleaseDecision>();
  const sceneDispositions = new Map<string, SceneDisposition>();
  const revisionIds = new Map<string, string | null>();
  const totalScenes = plan.selectedEventIds.length;
  let completedScenes = preBlocked.length;
  const editorialErrors: EditorialError[] = [];
  const commits: EditorialSceneCommitV1[] = [];

  const scopeHash = plan.planSummary.scopeHash;
  const validationIdentity = plan.planSummary.validationIdentity;
  const revisionOverride = candidateExecution
    ? {
        origin:
          candidateExecution.origin === 'rollback'
            ? ('rollback' as const)
            : ('human_edit' as const),
        ...(candidateExecution.restoredFromRevisionId
          ? { restoredFromRevisionId: candidateExecution.restoredFromRevisionId }
          : {}),
      }
    : undefined;

  for (const blocked of preBlocked) {
    decisions.set(blocked.eventId, {
      status: 'blocked',
      scopeHash,
      validationIdentity,
      reasons: [...blocked.errors],
    });
    sceneDispositions.set(blocked.eventId, 'candidate_blocked');
    revisionIds.set(blocked.eventId, null);
  }

  for (const wave of wavePlan.waves) {
    if (runtime.signal?.aborted) break;
    for (const eventId of wave.eventIds) {
      emit.emit({ kind: 'scene_started', eventId, completedScenes, totalScenes });
    }

    const { blocked: waveBlocked } = await materializeSurfacePackets(
      schedulableJobs,
      wave.eventIds,
      acceptedByEventId,
      execution,
      projectId,
      extractor,
    );
    for (const blocked of waveBlocked) {
      allResults.push(blocked);
      decisions.set(blocked.eventId, {
        status: 'blocked',
        scopeHash,
        validationIdentity,
        reasons: blocked.errors.length > 0 ? [...blocked.errors] : ['MISSING_SURFACE_SOURCE'],
      });
      sceneDispositions.set(blocked.eventId, 'candidate_blocked');
      revisionIds.set(blocked.eventId, null);
      completedScenes++;
    }

    const renderedIds = new Set(allResults.map((result) => result.eventId));
    const waveJobs = schedulableJobs.filter(
      (job) => wave.eventIds.includes(job.event.id) && !renderedIds.has(job.event.id),
    );
    if (waveJobs.length === 0) continue;

    const waveResults = request.batch
      ? (await new BatchRenderPipeline(pipeline).renderBatched(waveJobs, request.batch)).results
      : await pipeline.renderAll(waveJobs, runtime.signal);

    for (const result of waveResults) {
      completedScenes++;
      const proseHash = sha256(result.prose);
      const decision = evaluateReleaseDecision(
        result,
        scopeHash,
        validationIdentity,
        waiverManager,
        {
          policy: releasePolicy,
          gateIdentity: { projectId, sourceHash: request.source.sourceHash, proseHash },
        },
      );
      decisions.set(result.eventId, decision);
      allResults.push(result);

      const job = schedulableJobs.find((candidate) => candidate.event.id === result.eventId);
      if (!job) continue;
      const previousAccepted = await execution.readAcceptedScene({
        projectId,
        eventId: result.eventId,
      });
      const parentRevisionId = previousAccepted?.value.revisionId ?? null;

      if (decision.status === 'accepted') {
        if (result.cacheHit && result.prose) {
          sceneDispositions.set(result.eventId, 'head_reused');
          revisionIds.set(result.eventId, previousAccepted?.value.revisionId ?? null);
          if (previousAccepted) {
            acceptedByEventId.set(result.eventId, {
              eventId: result.eventId,
              prose: result.prose,
              proseHash: previousAccepted.value.proseHash,
              sceneHash: previousAccepted.value.sceneHash,
              editorialBasisHash: '',
              scopeHash,
              releaseDecision: decision,
              revisionId: previousAccepted.value.revisionId,
              createdAt: '',
            });
          }
        } else {
          // Append-only scene revision archive: the candidate becomes
          // auditable immediately. The accepted head itself is NOT touched
          // here — commitEditorialCandidates performs the CAS later, so
          // in-run scenes only propagate via the in-memory acceptedByEventId
          // map and never become repository accepted heads before commit.
          const envelope = buildRevisionEnvelope(
            result,
            job,
            plan,
            operationId,
            request,
            decision,
            parentRevisionId,
            runtime.services.clock,
            runtime.services.ids,
          );
          await execution.compareAndSwapSceneRevision({
            projectId,
            eventId: result.eventId,
            revisionId: envelope.revisionId,
            expectedVersion: null,
            value: {
              version: 1,
              projectId,
              eventId: result.eventId,
              revisionId: envelope.revisionId,
              parentRevisionId,
              sourceHash: request.source.sourceHash,
              value: envelope as unknown as JsonValue,
            },
          });
          commits.push({
            eventId: result.eventId,
            revisionId: envelope.revisionId,
            envelope,
            expectedVersion: previousAccepted?.revision ?? null,
            resultErrors: result.errors,
          });
          sceneDispositions.set(result.eventId, 'candidate_promoted');
          revisionIds.set(result.eventId, envelope.revisionId);
          acceptedByEventId.set(result.eventId, {
            eventId: result.eventId,
            prose: result.prose,
            proseHash: envelope.proseHash,
            sceneHash: envelope.sceneHash,
            editorialBasisHash: envelope.editorialBasisHash,
            scopeHash: envelope.scopeHash,
            releaseDecision: decision,
            revisionId: envelope.revisionId,
            createdAt: envelope.createdAt,
          });
          emit.emit({
            kind: 'candidate_archived',
            eventId: result.eventId,
            completedScenes,
            totalScenes,
            phase: 'promotion',
            disposition: 'candidate_promoted',
          });
        }
      } else {
        sceneDispositions.set(
          result.eventId,
          decision.status === 'pending_waiver' ? 'candidate_pending_waiver' : 'candidate_blocked',
        );
        revisionIds.set(result.eventId, null);
        const blockedEnvelope = buildRevisionEnvelope(
          result,
          job,
          plan,
          operationId,
          request,
          decision,
          parentRevisionId,
          runtime.services.clock,
          runtime.services.ids,
          revisionOverride,
        );
        await execution.compareAndSwapSceneRevision({
          projectId,
          eventId: result.eventId,
          revisionId: blockedEnvelope.revisionId,
          expectedVersion: null,
          value: {
            version: 1,
            projectId,
            eventId: result.eventId,
            revisionId: blockedEnvelope.revisionId,
            parentRevisionId,
            sourceHash: request.source.sourceHash,
            value: blockedEnvelope as unknown as JsonValue,
          },
        });
        if (decision.status === 'pending_waiver' && decision.gateId) {
          // Open the release gate in the review stream: the candidate waits
          // on a maintainer decision (require-waiver policy). The archived
          // envelope above is the authoritative pending candidate; the gate
          // record is the review-stream projection.
          const existingGate = await reviewManager.getGate(decision.gateId);
          if (!existingGate) {
            await reviewManager.openGate(
              {
                gateId: decision.gateId,
                sourceHash: request.source.sourceHash,
                eventId: result.eventId,
                proseHash,
                scopeHash,
                validationIdentity,
                warningFingerprints: decision.warningFingerprints ?? [],
                revisionId: blockedEnvelope.revisionId,
              },
              request.mutation.actorId,
            );
          }
        }
      }
    }
  }

  // ── 4. Deterministic result order + commit-ready candidate set ──────
  const orderedResults = [...allResults].sort(
    (left, right) =>
      (init.chapterByEventId[left.eventId] ?? 0) - (init.chapterByEventId[right.eventId] ?? 0) ||
      (init.events.find((event) => event.id === left.eventId)?.narrativeOrder ?? 0) -
        (init.events.find((event) => event.id === right.eventId)?.narrativeOrder ?? 0) ||
      left.eventId.localeCompare(right.eventId),
  );

  return {
    kind: 'candidates',
    candidateSet: {
      version: 1,
      operationId,
      projectId,
      sourceHash: request.source.sourceHash,
      request,
      candidateExecution,
      planHash: plan.planHash,
      planSummary: plan.planSummary,
      selectedEventIds: plan.selectedEventIds,
      orderedResults,
      decisions,
      sceneDispositions,
      revisionIds,
      editorialErrors,
      commits,
      trace: traceCollector,
      completedScenes,
      totalScenes,
    },
  };
}

// ============================================================================
// commitEditorialCandidates — accepted-scene CAS + publication readiness
// ----------------------------------------------------------------------------
// The ONLY repository writes are the per-head accepted-scene CAS
// (`compareAndSwapAcceptedScene`). No provider calls, no compile, no revision
// archive. Any head CAS conflict marks the whole operation stale and forbids
// publication; the already-appended candidate revisions are retained as
// auditable stale candidates. Review application hooks into this slot (Step 5).
// ============================================================================

export async function commitEditorialCandidates(
  candidateSet: EditorialCandidateSetV1,
  runtime: EditorialRuntime,
): Promise<EditorialCommitResultV1> {
  assertRuntime(runtime);
  const execution = runtime.services.execution;
  const { projectId, sourceHash } = candidateSet;
  const emit = createProgressEmitter(
    runtime.eventBus,
    candidateSet.operationId,
    runtime.services.clock,
  );

  const decisions = new Map(candidateSet.decisions);
  const sceneDispositions = new Map(candidateSet.sceneDispositions);
  const revisionIds = new Map(candidateSet.revisionIds);
  const editorialErrors: EditorialError[] = [...candidateSet.editorialErrors];
  const outcomes: EditorialHeadCommitOutcomeV1[] = [];
  let stale = false;

  for (const commit of candidateSet.commits) {
    const accepted: AcceptedSceneRecordLike = {
      version: 1,
      projectId,
      eventId: commit.eventId,
      sourceHash,
      revisionId: commit.revisionId,
      prose: commit.envelope.prose,
      proseHash: commit.envelope.proseHash,
      sceneHash: commit.envelope.sceneHash,
      value: commit.envelope as unknown as JsonValue,
    };
    const cas = await execution.compareAndSwapAcceptedScene({
      projectId,
      eventId: commit.eventId,
      expectedVersion: commit.expectedVersion,
      value: accepted,
    });
    if (cas.kind === 'conflict') {
      // The accepted head moved between candidate compute and commit: this
      // candidate is stale. Never report promotion/current and never feed
      // later surface packets from the contested candidate.
      stale = true;
      const conflictMessage = `ACCEPTED_HEAD_CONFLICT: accepted scene ${commit.eventId} changed concurrently; candidate not promoted`;
      editorialErrors.push({
        code: 'STORAGE_CONFLICT',
        message: conflictMessage,
        eventId: commit.eventId,
      });
      decisions.set(commit.eventId, {
        status: 'blocked',
        scopeHash: candidateSet.planSummary.scopeHash,
        validationIdentity: candidateSet.planSummary.validationIdentity,
        reasons: [...commit.resultErrors, conflictMessage],
      });
      sceneDispositions.set(commit.eventId, 'candidate_stale');
      revisionIds.set(commit.eventId, null);
      outcomes.push({
        eventId: commit.eventId,
        status: 'conflict',
        revisionId: commit.revisionId,
      });
      emit.emit({
        kind: 'candidate_archived',
        eventId: commit.eventId,
        phase: 'promotion',
        disposition: 'candidate_stale',
      });
    } else {
      outcomes.push({
        eventId: commit.eventId,
        status: 'accepted',
        revisionId: commit.revisionId,
      });
    }
  }

  // Review application: a revision that explicitly names review comments
  // (`request.revision.reviewIds`) addresses the scene/line-scoped comments
  // whose target event was successfully committed. Recorded as append-only
  // `comment_applied` events; skipped when the operation is stale (any
  // accepted head conflicted) or no revision review ids were supplied.
  await applyRevisionReviewApplications(candidateSet, runtime, outcomes, stale);

  // Publication readiness derives from the post-commit decisions/errors: any
  // conflict above blocks publication (status stale).
  const publication = buildPublication(candidateSet.selectedEventIds, decisions, editorialErrors);

  return {
    version: 1,
    stale,
    outcomes,
    publication,
    decisions,
    sceneDispositions,
    revisionIds,
    editorialErrors,
  };
}

// ============================================================================
// executeEditorialRender — facade composing candidates + commit
// ============================================================================

/**
 * Append `comment_applied` events for the review comments a completed
 * revision explicitly names (`request.revision.reviewIds`). A comment is
 * addressed only when its scene/line target was successfully committed by
 * this operation; already resolved/wontfix/superseded comments and unknown
 * ids are left untouched. Never runs on a stale (conflicted) operation.
 */
async function applyRevisionReviewApplications(
  candidateSet: EditorialCandidateSetV1,
  runtime: EditorialRuntime,
  outcomes: readonly EditorialHeadCommitOutcomeV1[],
  stale: boolean,
): Promise<void> {
  assertRuntime(runtime);
  const reviewIds = candidateSet.request.revision?.reviewIds ?? [];
  if (stale || reviewIds.length === 0) return;
  const committedEventIds = new Set(
    outcomes.filter((outcome) => outcome.status === 'accepted').map((outcome) => outcome.eventId),
  );
  if (committedEventIds.size === 0) return;
  const execution = runtime.services.execution;
  const manager = new ReviewManager(execution, candidateSet.projectId, reviewServices(runtime));
  const comments = await manager.getComments();
  const commentsById = new Map(comments.map((comment) => [comment.id, comment] as const));
  const applications = new Map<
    string,
    { readonly application: ReviewApplicationV1; readonly addressed: boolean }
  >();
  const now = runtime.services.clock.now();
  for (const id of new Set(reviewIds)) {
    const comment = commentsById.get(id);
    if (!comment) continue;
    if (
      comment.status === 'superseded' ||
      comment.status === 'resolved' ||
      comment.status === 'wontfix'
    )
      continue;
    if (comment.target.type !== 'scene' && comment.target.type !== 'line') continue;
    if (!committedEventIds.has(comment.target.id)) continue;
    const revisionId = candidateSet.revisionIds.get(comment.target.id) ?? null;
    if (revisionId === null) continue;
    applications.set(id, {
      application: {
        eventId: comment.target.id,
        revisionId,
        operationId: candidateSet.operationId,
        appliedAt: now,
      },
      addressed: true,
    });
  }
  if (applications.size > 0) await manager.recordCommentApplications(applications);
}

export async function executeEditorialRender(
  request: EditorialRenderRequestV1,
  runtime: EditorialRuntime,
  candidateExecution?: EditorialCandidateExecution,
): Promise<RenderNovelResult> {
  const outcome = await executeEditorialCandidates(request, runtime, candidateExecution);
  if (outcome.kind === 'failed') return outcome.result;

  const candidateSet = outcome.candidateSet;
  const commitResult = await commitEditorialCandidates(candidateSet, runtime);

  assertRuntime(runtime);
  const execution = runtime.services.execution;
  const operationId = candidateSet.operationId;
  const emit = createProgressEmitter(runtime.eventBus, operationId, runtime.services.clock);

  // ── 5. Publish summary + operation record ───────────────────────────
  const mappedResults = candidateSet.orderedResults.map((result) =>
    mapSceneResult(
      result,
      commitResult.decisions.get(result.eventId) ?? null,
      commitResult.revisionIds.get(result.eventId) ?? null,
      commitResult.sceneDispositions.get(result.eventId) ?? 'candidate_blocked',
    ),
  );
  const publication = commitResult.publication;
  const resultErrors = commitResult.editorialErrors.map((error) => error.message);
  const operationSucceeded =
    publication.status === 'current' && mappedResults.every((result) => result.released);

  const completedAt = runtime.services.clock.now();
  await execution.compareAndSwapOperation({
    projectId: candidateSet.projectId,
    operationId,
    expectedVersion: null,
    value: {
      version: 1,
      projectId: candidateSet.projectId,
      operationId,
      value: {
        version: 1,
        operationId,
        kind: candidateSet.candidateExecution?.operationKind ?? 'render',
        actorId: candidateSet.request.mutation.actorId,
        requestHash: candidateSet.candidateExecution
          ? computeCandidateOperationRequestHash(
              candidateSet.request,
              candidateSet.candidateExecution,
            )
          : candidateSet.planHash,
        status: operationSucceeded ? 'succeeded' : 'failed',
        startedAt: completedAt,
        heartbeatAt: completedAt,
        leaseExpiresAt: completedAt,
        result: mappedResults,
        errors: resultErrors.map((message) => ({ code: 'INVALID_OPERATION', message })),
      } as unknown as JsonValue,
    },
  });
  await persistTrace(execution, candidateSet.projectId, operationId, candidateSet.trace);
  emit.emit({
    kind: operationSucceeded ? 'operation_completed' : 'operation_failed',
    completedScenes: candidateSet.completedScenes,
    totalScenes: candidateSet.totalScenes,
  });

  return {
    operationId,
    results: mappedResults,
    errors: resultErrors,
    editorialErrors: [...commitResult.editorialErrors],
    publication,
  };
}

function buildPipeline(
  runtime: EditorialRuntime,
  init: ProjectInitialization,
  plan: EditorialCompileOutput,
  request: Omit<EditorialRenderRequestV1, 'mutation'>,
  resolvedModel: string,
  traceCollector: TraceCollector,
): RenderPipeline {
  assertRuntime(runtime);
  const overrides = { ...(init.data.config?.validatorOverrides ?? {}) };
  const aggregator = new ResultAggregator(
    [...createBuiltInValidators(), ...pluginValidators(runtime.pluginHooksManager)],
    init.entityTypes,
  );
  const options: RenderPipelineOptions = {
    provider: runtime.provider ?? (runtime.providerFactory ? undefined : runtime.services.llm),
    providerFactory: runtime.providerFactory,
    providerProfile: request.providerProfile,
    model: resolvedModel,
    runtimeServices: runtime.services,
    signal: runtime.signal,
    concurrency: runtime.concurrency,
    eventBus: runtime.eventBus,
    traceCollector,
    aggregator,
    validatorOverrides: overrides,
    analysisContract: aggregator.getAnalysisContract(overrides),
    entities: init.registry,
    maxRounds: request.maxRounds,
    validatorPolicyId: plan.planSummary.validationIdentity,
    pluginHooksManager: runtime.pluginHooksManager,
  };
  return new RenderPipeline(options);
}

async function persistTrace(
  execution: CoreExecutionRepository,
  projectId: string,
  operationId: string,
  traceCollector: TraceCollector,
): Promise<void> {
  const current = await execution.readTrace({ projectId, operationId });
  const result = await execution.compareAndSwapTrace({
    projectId,
    operationId,
    expectedVersion: current?.revision ?? null,
    value: {
      version: 1,
      projectId,
      operationId,
      value: {
        format: 'jsonl',
        traceId: traceCollector.traceId,
        content: traceCollector.toJsonLines(),
      },
    },
  });
  if (result.kind === 'conflict') {
    throw new Error(`TRACE_PERSISTENCE_CONFLICT: ${operationId}`);
  }
}

// ============================================================================
// previewEditorialRun — compile + prompt assembly only
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

export async function previewEditorialRun(
  request: Omit<EditorialRenderRequestV1, 'mutation'>,
  runtime: EditorialRuntime,
): Promise<PreviewResult> {
  assertRuntime(runtime);
  const init = initialize(request.source);
  const projectId = init.data.config?.project ?? 'default-project';
  const reviewComments = await new ReviewManager(
    runtime.services.execution,
    projectId,
  ).getComments();
  const preflight = preflightSelector(request.selector, init.catalog);
  const acceptedHeads = await resolveAcceptedHeads(
    runtime.services.execution,
    projectId,
    preflight.eventIds,
    request.source.sourceHash,
  );
  const plan = compileEditorialRun(
    buildCompileInput(
      init,
      request,
      reviewComments,
      buildLatestRevisions(preflight.eventIds, acceptedHeads),
      runtime.pluginHooksManager,
    ),
  );

  const scenes = plan.scenes.map((scene) => ({
    eventId: scene.eventId,
    state: scene.state,
    editorialBasisHash: scene.editorialBasisHash,
  }));
  const editorialErrors = plan.selectorErrors.map((error) => ({
    code: error.code as EditorialErrorCode,
    message: error.message,
    ...(error.eventId ? { eventId: error.eventId } : {}),
  }));
  if (plan.selectorErrors.length > 0) {
    return {
      planHash: plan.planHash,
      planSummary: plan.planSummary,
      selectedEventIds: plan.selectedEventIds,
      scenes,
      prompts: [],
      errors: plan.selectorErrors.map((error) => error.message),
      editorialErrors,
    };
  }

  const revisionStates = new Map(
    buildEventRevisionStates(
      plan.selectedEventIds,
      request.revision,
      reviewComments,
      acceptedHeads,
    ).map((state) => [state.eventId, state] as const),
  );
  const noAcceptedBaseErrors = collectNoAcceptedBaseErrors([...revisionStates.values()]);
  if (noAcceptedBaseErrors.length > 0) {
    return {
      planHash: plan.planHash,
      planSummary: plan.planSummary,
      selectedEventIds: plan.selectedEventIds,
      scenes,
      prompts: [],
      errors: noAcceptedBaseErrors.map((error) => error.message),
      editorialErrors: noAcceptedBaseErrors,
    };
  }

  const compiledRuntime = compileCanonicalRuntime(init.ir, {
    branchPath: request.branchPath,
    discourseBranch: request.discourseBranch,
  });
  const resolvedModel = request.model ?? init.data.config?.defaultModel ?? 'preview-model';
  const jobs = buildRenderJobs(
    plan,
    init,
    request,
    projectId,
    request.source.sourceHash,
    resolvedModel,
    compiledRuntime,
    revisionStates,
    reviewComments,
  );
  let pass1TemplateText: string | undefined;
  try {
    const template = await runtime.services.promptTemplates.get({
      name: PASS1_PROMPT_TEMPLATE_NAME,
    });
    pass1TemplateText = template?.template;
  } catch {
    // A failing catalog falls back to the built-in template, mirroring Pass 1.
  }
  const assembler = new PromptAssembler(pass1TemplateText);
  const prompts: PreviewResult['prompts'] = [];
  for (const job of jobs) {
    const assembled = assembler.assemble(job.context, {
      targetLengthWords: job.event.styleGuidance?.targetWordCount ?? 400,
      styleGuidance: job.event.styleGuidance,
      language: init.data.config?.defaultLanguage ?? 'en',
      logicalDisclosureSummary: job.logicalDisclosureSummary,
      surfaceReferencePacket: job.surfaceReferencePacket,
      previousAcceptedProse: job.revisionContext?.baseProse,
      editorialRevisionInstructions: job.editorialRevisionInstructions,
    });
    prompts.push({ eventId: job.event.id, userPrompt: assembled.userPrompt });
  }

  return {
    planHash: plan.planHash,
    planSummary: plan.planSummary,
    selectedEventIds: plan.selectedEventIds,
    scenes,
    prompts,
    errors: [],
    editorialErrors: [],
  };
}

// ============================================================================
// executeEditorialTreeRender — game dialogue tree as one top-level operation
// ============================================================================

function toRecordShapedGameDialogueTree(
  tree: CompiledGameDialogueTree | null,
): RenderGameDialogueTreeResult['tree'] {
  if (!tree) {
    return { eventScopes: {}, representativePathByEventId: {}, choicesByEventId: {} };
  }
  return {
    eventScopes: Object.fromEntries(tree.eventScopes),
    representativePathByEventId: Object.fromEntries(tree.representativePathByEventId),
    choicesByEventId: Object.fromEntries(
      [...tree.choicesByEventId.entries()].map(([eventId, choices]) => [eventId, [...choices]]),
    ),
  };
}

export async function executeEditorialTreeRender(
  request: RenderGameDialogueTreeRequestV1,
  runtime: EditorialRuntime,
): Promise<RenderGameDialogueTreeResult> {
  const init = initialize(request.source);
  const tree = init.ir.gameDialogueTree;
  if (!tree) {
    const result = await executeEditorialRender(request, runtime);
    return {
      operationId: result.operationId,
      tree: toRecordShapedGameDialogueTree(null),
      results: result.results,
      errors: result.errors,
      editorialErrors: result.editorialErrors,
      publication: result.publication,
    };
  }

  const renderedEventIds = new Set<string>();
  const results: RenderNovelSceneResult[] = [];
  const errors: string[] = [];
  const editorialErrors: EditorialError[] = [];
  let publication: PublicationResult | null = null;

  for (const [index, branchPath] of tree.leafPaths.entries()) {
    const scopedEventIds = init.events
      .filter((event) => {
        const scope = tree.eventScopes.get(event.id);
        return (
          scope?.type === 'all' ||
          (scope?.type === 'paths' &&
            scope.paths.some((path) => canonicalJson(path) === canonicalJson(branchPath)))
        );
      })
      .map((event) => event.id);
    const eventIds = scopedEventIds.filter((eventId) => !renderedEventIds.has(eventId));
    if (eventIds.length === 0) continue;

    const discourseBranch = resolveDiscourseBranch({
      selectedEventIds: new Set(scopedEventIds),
      branchPath,
      ledger: init.ir.data.discourseLedger,
    });
    const routeRequest: EditorialRenderRequestV1 = {
      ...request,
      selector: { type: 'events', eventIds },
      branchPath,
      discourseBranch,
      mutation: {
        ...request.mutation,
        operationId:
          index === 0
            ? request.mutation.operationId
            : treeRouteOperationId(request.mutation.operationId, index),
      },
    };
    const routeResult = await executeEditorialRender(routeRequest, runtime);
    for (const scene of routeResult.results) {
      if (renderedEventIds.has(scene.eventId)) continue;
      renderedEventIds.add(scene.eventId);
      results.push(scene);
    }
    errors.push(...routeResult.errors);
    editorialErrors.push(...routeResult.editorialErrors);
    publication = routeResult.publication;
  }

  return {
    operationId: request.mutation.operationId,
    tree: toRecordShapedGameDialogueTree(tree),
    results,
    errors,
    editorialErrors,
    publication: publication ?? {
      status: 'unchanged',
      outputPath: '',
      novelHash: null,
      reasons: [],
    },
  };
}

function treeRouteOperationId(operationId: string, routeIndex: number): string {
  const hash = sha256(`${operationId}:${routeIndex}`);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
