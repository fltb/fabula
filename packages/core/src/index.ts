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
  RelationshipDefinition,
  RelationshipTransaction,
  RequiredAt,
  RuleDefinition,
  RuleEffectEntry,
  SourceContext,
  StoryCoordinate,
  StoryTimestamp,
  StyleGuidance,
  ThreadDeclaration,
  ThreadProgressEntry,
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
export type { StoryBoundaries } from './state/index.js';
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
export type {
  AnalysisBlockRequirement,
  AnalysisDisposition,
  AnalysisObservation,
  AnalysisResult,
  NovelValidationResult,
  ObservationRef,
  PostRenderInput,
  PreRenderInput,
  ValidationIssue,
  ValidationIssueKind,
  ValidationKey,
  ValidationResult,
  ValidationRunOptions,
  Validator,
} from './types/index.js';
export {
  DeterministicReferenceExtractor,
  ReferenceExtractionError,
  buildReferencePacket,
  extractReferenceChunks,
} from './reference.ts';
export type {
  BuildReferencePacketOptionsV1,
  ProjectReferencePacketV1,
  ReferenceChunkV1,
  ReferenceCitationV1,
  ReferenceExtractionInputV1,
  ReferenceExtractorOptionsV1,
  ReferenceExtractorV1,
} from './reference.ts';
