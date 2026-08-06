// ============================================================================
// Novalistically Core — General Narrative-Engine Public Contract
// ============================================================================
//
// Root intentionally exposes only universal narrative-engine semantics.
// Editorial workflows, schemas, tooling, and test doubles live at explicit
// subpaths: /editorial, /schema, /tooling, /testing, and /extensions. Do not
// add wildcard exports here.
// ============================================================================

// ── Runtime contract (exactly 10 values) ─────────────────────────────────────

export { LLMError } from './ai/types.ts';
export {
  compileProject,
  getProjectStatus,
  listEntities,
  showEntity,
  validateNovel,
} from './api.js';
export { compareFact, resolveTemporalContext } from './entity/index.js';
export { NovalisticallyError, sanitizeError } from './errors.js';

// ── Source / domain ──────────────────────────────────────────────────────────

export type {
  AttributeDefinitionSource,
  AttributeValueType,
  AuthoredStoryTime,
  BranchPath,
  BranchSet,
  CharacterDefinition,
  Entity,
  EntityId,
  EntityKind,
  EntityTypeCatalogSource,
  EntityTypeDefinitionSource,
  EntityTypeRef,
  EventFile,
  Fact,
  FactId,
  FactionDefinition,
  FactValidity,
  ForeshadowEntry,
  GameDialogueChoice,
  ItemDefinition,
  LocationDefinition,
  NarrativeChecklist,
  NarrativeEvent,
  NarratorAssertion,
  NarratorProfile,
  PlannedDiscourseLedgerSource,
  ProjectConfig,
  RelationshipDeclaration,
  RelationshipEffect,
  RelationshipTransaction,
  RelationshipTypeCatalog,
  RequiredAt,
  RuleDeclaration,
  RuleTransaction,
  RuleTypeCatalog,
  SourceContext,
  StoryCoordinate,
  StoryTimestamp,
  StyleGuidance,
  ThreadDeclaration,
  ThreadRunId,
  ThreadTransaction,
  TimeAnchor,
  WritePolicy,
} from './types/index.js';

// ── Canonical compiled state ─────────────────────────────────────────────────

export type {
  CompileProjectOptions,
  ProjectCompilation,
  ProjectData,
  TemporalContext,
} from './entity/index.js';
export type {
  FullReplaySource,
  ReplayFromNearestResult,
  ReplayOptions,
  ReplaySource,
  SnapshotReplaySource,
  SnapshotStampOptions,
  SnapshotVerification,
  StateRecoveryInput,
  StateRecoveryResult,
  StoryBoundaries,
} from './state/index.js';
export {
  CANONICAL_WORLD_SCHEMA,
  CANONICAL_WORLD_SCHEMA_VERSION,
  computeSnapshotStateHash,
  narrativeEventToStateEvent,
  ReplayEngine,
  SnapshotEngine,
  StateManager,
  verifySnapshotRecord,
  worldStateToSnapshotRecord,
} from './state/index.js';
export type {
  ContextPackage,
  EntityDeclarationCatalog,
  EntityLookup,
  EntityTypeCatalog,
  EpistemicLedger,
  ISSDimension,
  ISSGap,
  ISSSnapshot,
  ThreadRuntimeState,
  WorldState,
} from './types/index.js';

// ── Provider port ────────────────────────────────────────────────────────────

export type {
  CompletionRequest,
  CompletionResponse,
  LLMProvider,
  Message,
  TaskType,
} from './ai/types.ts';

// ── Analysis / validation port ───────────────────────────────────────────────

export type { EntityDetail, EntitySummary, ProjectStatusResult } from './api.js';

// ── Pure contracts and semantic ports ────────────────────────────────────────
export type * from './contracts/index.js';
export type { ErrorContext } from './errors.js';
export type {
  AcceptedArtifactRecord,
  AcceptedSceneRecord,
  Clock,
  CommitResult,
  CommitSuccess,
  CoreExecutionRepository,
  CoreRuntimeServices,
  IdGenerator,
  LayeredCacheKey,
  OperationRecord,
  PromptTemplate,
  PromptTemplateCatalog,
  PublicationRecord,
  ReadResult,
  RenderCacheRecord,
  RenderCacheRepository,
  ReviewEventDraftV1,
  ReviewEventKindV1,
  ReviewEventReadResultV1,
  ReviewEventRecordV1,
  ReviewRecord,
  SceneRevisionRecord,
  StateAppendResult,
  StateAppendSuccess,
  StateEvent,
  StateLogReadResult,
  StateLogRepository,
  StateSnapshotRecord,
  StateSnapshotRepository,
  StateSnapshotWriteResult,
  StateStreamKey,
  StateVersionConflict,
  TraceRecord,
  VersionConflict,
} from './ports/index.js';

// ── Review event stream (append-only review state) ──────────────────────────

export type {
  BuildReferencePacketOptionsV1,
  ProjectReferencePacketV1,
  ReferenceChunkV1,
  ReferenceCitationV1,
  ReferenceExtractionInputV1,
  ReferenceExtractorOptionsV1,
  ReferenceExtractorV1,
} from './reference.ts';
export {
  buildReferencePacket,
  DeterministicReferenceExtractor,
  extractReferenceChunks,
  ReferenceExtractionError,
} from './reference.ts';
export type {
  ReviewGateDecisionV1,
  ReviewGateInputV1,
  ReviewGateV1,
  ReviewProjectionV1,
} from './review/events.js';
export {
  legacyLedgerToReviewEvents,
  parseLegacyReviewLedger,
  projectReviewState,
} from './review/events.js';
export type {
  Blocker,
  WorkflowActionPriority,
  WorkflowEventExecutionV1,
  WorkflowExecutionProjectionV1,
  WorkflowNextActionCode,
  WorkflowNextActionV1,
  WorkflowPublicationProjectionV1,
  WorkflowReviewProjectionV1,
  WorkflowStatusInputV1,
  WorkflowStatusV1,
  WorkflowValidationProjectionV1,
  WorkflowWorkingProjectionV1,
} from './status/index.js';
export { buildWorkflowStatus } from './status/index.js';
export type {
  AnalysisBlockRequirement,
  AnalysisDisposition,
  AnalysisObservation,
  AnalysisResult,
  NovelValidationResult,
  ObservationRef,
  PostRenderInput,
  PreRenderInput,
  ReviewLedgerV1,
  ValidationIssue,
  ValidationIssueKind,
  ValidationKey,
  ValidationResult,
  ValidationRunOptions,
  Validator,
} from './types/index.js';

// ── Plugin system (trusted host plugins) ────────────────────────────────────
//
// Runtime surface for host-owned plugin activation (Node Host). Plugin hooks
// receive a read-only context; transform hooks hard-fail scenes, observation
// hooks are non-authoritative. Extensions entry is `@novalistically/core/extensions`.

export type {
  BuildPromptInput,
  ConflictReport,
  PluginContext,
  PluginExtensionSchema,
  PluginHooks,
  PromptDecoration,
  ProviderRegistry,
  ResolutionResult,
  ValidatorRegistrar,
} from './plugin/index.ts';
export {
  detectConflicts,
  PluginExtensionSchemaRegistrar,
  PluginHooksManager,
  PluginLoader,
  resolveConflict,
  ValidatorRegistry,
} from './plugin/index.ts';
