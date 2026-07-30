// ============================================================================
// Novalistically Core — Public API
// ============================================================================

export type { Agent, AgentConfig, AgentPacket, AgentRole } from './agent/index.js';
// Agent System
export { AgentRegistry } from './agent/index.js';
// AI
export type {
  AiSdkProviderOptions,
  CompletionRequest,
  CompletionResponse,
  LLMProvider,
  Message,
  MockPass2Entry,
  MockPass2Options,
  MockProviderOptions,
  ProseOnlyInput,
  RenderAnalysisInput,
  SceneRenderInput,
  ThreadStatusInput,
} from './ai/index.ts';
export { AiSdkProvider, LLMError, MockPass2Provider, MockProvider } from './ai/index.ts';
export type {
  AssembleGameDialogueTreeOptions,
  AssembleGameDialogueTreeResult,
} from './assembler/game-dialogue-tree.ts';
export { assembleGameDialogueTree } from './assembler/game-dialogue-tree.ts';
// Assembler types only — release-aware assembly is in editorial
export type { AssembleOptions, AssembleResult } from './assembler/index.js';
export {
  countNarrativeText,
  countWords,
} from './assembler/index.js';
// Batch types only
export type { BatchConfig, BatchProgressEvent, BatchResult, BatchStats } from './batch-renderer.js';
export type { CompiledGameDialogueTree } from './branch/game-dialogue-tree.ts';
export { compileGameDialogueTree } from './branch/game-dialogue-tree.ts';
export { branchPathsEqual } from './branch/path.ts';
export type { CacheDiagnostics, VerifyChainResult } from './cache/render-cache.js';
// Cache
export {
  buildAttemptKeyMaterial,
  buildLogicalKeyMaterial,
  buildSurfaceKeyMaterial,
  buildValidationKeyMaterial,
  canonicalJson,
  clearEventCache,
  clearRenderCache,
  computeEvidenceHash,
  computeFlatCacheKey,
  getCachedRender,
  setCachedRender,
  sha256Canonical,
  verifyEvidenceChain,
} from './cache/render-cache.js';
export type { RelevanceContext } from './context/index.js';
// Context
export {
  ContextAssembler,
  ContextCompiler,
  RelevanceEngine,
} from './context/index.js';
export {
  adoptSceneProse,
  applySourceChange,
  assembleCanonicalNovel,
  assembleCustomNovel,
  getEditorialOperation,
  getEditorialWorkspace,
  getSceneRevision,
  getSourceDocument,
  getSourceRevision,
  inspectScenes,
  listEditorialOperations,
  listSceneRevisions,
  listSourceDocuments,
  listSourceRevisions,
  previewSourceChange,
  reconcileSourceWorkingCopy,
  rollbackSceneRevision,
  setSceneLock,
} from './editorial/facade.ts';
export type {
  BranchContracts,
  CatalogEntry,
  CompiledSceneIdentity,
  CompiledSceneInfo,
  CompiledSceneState,
  EditorialCompileInput,
  EditorialCompileJob,
  EditorialCompileOutput,
  OverlayDocument,
  PlanHashInput,
  PreviewResult,
  ProjectPaths,
  ProjectTransactionInput,
  PromoteCandidateInput,
  PublishOptions,
  PublishScope,
  RevisionPreflightError,
  SceneCatalog,
  ScopeEventData,
  SelectorPreflightResult,
  ValidationIdentityInput,
  VerifiedHeadData,
} from './editorial/index.js';
// Editorial — workspace, transaction, store, compiler, and render orchestration
export {
  EditorialOperationError,
  EditorialPublisher,
  OperationStore,
  OverlayStorage,
  ProjectTransactionCoordinator,
  PublicationError,
  preflightSelector,
  resolveProjectPaths,
  SceneRevisionStore,
  SourceRevisionStore,
  SourceWorkspace,
  stableJson,
  toEditorialError,
} from './editorial/index.js';
export {
  addReviewComment,
  listReviewComments,
  replaceReviewComment,
  updateReviewComment,
} from './editorial/review-facade.ts';
export type { CompareOutcome, ProjectData, TemporalContext } from './entity/index.js';
// Entity
export {
  compareFact,
  EntityMapper,
  InMemoryEntityRegistry,
  loadProjectConfig,
  migrateProjectFile,
  readYamlFile,
  resolveTemporalContext,
} from './entity/index.js';
export type { ErrorContext } from './errors.js';
// Stable, safe operational errors
export {
  AssemblyIncompleteError,
  AuthError,
  CacheCorruptionError,
  ConfigError,
  DagCycleError,
  DagProviderError,
  ModelNotFoundError,
  NetworkDeniedError,
  NovalisticallyError,
  PipelineError,
  PreconditionMismatchError,
  RateLimitError,
  ReferenceFormatError,
  RuleConstraintViolationError,
  StorageConflictError,
  StorageError,
  sanitizeError,
  TimeoutError,
  ValidationError,
} from './errors.js';
export type { EventMap } from './event-bus.ts';
// Event bus
export { TypedEventBus } from './event-bus.ts';
export { calculateISS } from './iss/index.js';
export type { MigrationFn } from './migration/index.js';
export {
  CURRENT_SCHEMA_VERSION,
  migrateToLatest,
} from './migration/index.js';
// Observability types only
export type { LogContext, LogEntry, LogLevel, LogTransport } from './observability/logger.ts';
export type {
  InteractionGate,
  ProviderCallLedgerEntry,
  RenderJob,
  RenderPipelineOptions,
  RenderSceneResult,
  WaiverRecord,
} from './pipeline/index.js';
export { InteractionManager } from './pipeline/index.js';
// Plugin types only
export type {
  ConflictReport,
  PluginContext,
  PluginHooks,
  PluginValidator,
  ProviderRegistry,
  ResolutionResult,
} from './plugin/index.js';
export { PluginHooksManager } from './plugin/index.js';
export type { BenchReport, PipelineRunResult } from './report/index.js';
export { ReportWriter } from './report/index.js';
export type { ValidationReport } from './reporter/index.js';
export { writeValidationReport } from './reporter/index.js';
// Review
export { ReviewManager } from './review/index.js';
export type { CommentFilter, StatusSummary } from './review/types.js';
export { analysisResultSchema } from './schemas/analysis.js';
export {
  expectedOutcomeManifestSchema,
  liveSmokeRecordSchema,
  provenanceManifestSchema,
  responseReferenceSchema,
} from './schemas/contracts.ts';
// Editorial schemas
export {
  branchPathV1Schema,
  branchSetV1Schema,
  editorialErrorSchema,
  editorialMutationContextSchema,
  editorialOperationV1Schema,
  editorialPreviewRequestV1Schema,
  editorialProgressEventV1Schema,
  editorialRenderRequestV1Schema,
  editorialScopedRequestV1Schema,
  renderGameDialogueTreeRequestV1Schema,
  sceneMetadataV1Schema,
  sceneRevisionEnvelopeV1Schema,
  sceneSelectorSchema,
  sourceChangePreviewV1Schema,
  sourceChangeSetV1Schema,
  sourceDocumentChangeSchema,
  sourceHeadV1Schema,
  sourceRevisionV1Schema,
  transactionReadExpectationSchema,
} from './schemas/editorial.js';
export {
  newReviewCommentSchema,
  reviewApplicationV1Schema,
  reviewCommentSchema,
  reviewLedgerV1Schema,
} from './schemas/review.ts';
export type {
  AdjacencyList,
  CompileNarrativeRuntimeInput,
  CompiledNarrativeRuntime,
  CompiledStoryRuntimeGraph,
  DiscourseSceneSequenceEntry,
  ResolvedNarrativeTechniqueContract,
  StoryBoundaries,
  StoryOrderIndex,
} from './state/index.js';
// State
export {
  buildStoryOrderIndex,
  compileDiscourseSceneSequence,
  compileNarrativeRuntime,
  isProvenBefore,
  resolveDiscourseBranch,
  compileStoryBoundaries,
  compileStoryBoundariesFromGraph,
  compileStoryRuntimeGraph,
  exportDAGtoDOT,
  exportDAGtoMermaid,
  resolveNarrativeTechniques,
  ReplayEngine,
  StateManager,
} from './state/index.js';
export type { DirEntry, Storage, StorageWrite } from './storage/index.ts';
// Storage
export { FsStorage, MemoryStorage } from './storage/index.ts';
export type { VolumeSummaryOptions } from './summary/index.js';
// Summary
export {
  LogicalDisclosureSummaryCompiler,
  SurfaceReferenceExtractor,
  VolumeSummaryCompiler,
} from './summary/index.js';
// Editorial types (re-exported from types/editorial.ts)
export type {
  AssembleRequestV1,
  EditorialAssembleResult,
  EditorialError,
  EditorialErrorCode,
  EditorialMutationContext,
  EditorialOperationKind,
  EditorialOperationStatus,
  EditorialOperationV1,
  EditorialPlanSummaryV1,
  EditorialProgressEventV1,
  EditorialRenderRequestV1,
  EditorialRuntime,
  EditorialScopedRequestV1,
  EditorialWorkspaceSnapshotV1,
  ProviderCallLedgerEntryV1,
  ProviderFactory,
  PublicationResult,
  RenderGameDialogueTreeRequestV1,
  RenderGameDialogueTreeResult,
  RenderNovelResult,
  RenderNovelSceneResult,
  RevisionRequest,
  SceneActionResult,
  SceneDisposition,
  SceneInspection,
  SceneMetadataV1,
  SceneProseInput,
  SceneRevisionEnvelopeV1,
  SceneRevisionSummary,
  SceneSelector,
  SourceChangePreviewV1,
  SourceChangeResultV1,
  SourceChangeSetV1,
  SourceDocumentChange,
  SourceDocumentKind,
  SourceDocumentV1,
} from './types/editorial.js';
// Types
export type * from './types/index.js';
// Validator
export {
  AliasValidator,
  AnachronyConsistencyValidator,
  AppearanceValidator,
  BranchMergeValidator,
  CausalityValidator,
  CharacterStateValidator,
  ConflictValidator,
  DiscourseBalanceValidator,
  DiscourseValidator,
  DurationConsistencyValidator,
  FactualDetailValidator,
  FocalizationConsistencyValidator,
  ForeshadowingValidator,
  FrequencyConsistencyValidator,
  KnowledgeValidator,
  NarrativeTechniqueValidator,
  PacingValidator,
  POVValidator,
  PronounValidator,
  ReachabilityValidator,
  ResultAggregator,
  TenseConsistencyValidator,
  TimelineValidator,
  VoiceConsistencyValidator,
  VoiceDriftDetector,
  WorldRuleValidator,
} from './validator/index.js';

// Bench (functional + performance) is in @novalistically/bench, NOT core.
// Bench calls core to do measurements; bench itself is not part of core.

export type {
  DiffResult,
  ImpactAnalysisResult,
  ImpactLevel,
  ProjectStatusResult,
} from './api.js';
// API — Orchestration functions (public API)
export {
  analyzeProjectImpact,
  diffEvent,
  getProjectStatus,
  initializeProject,
  listEntities,
  previewEditorialRun,
  renderGameDialogueTree,
  renderNovel,
  showEntity,
  validateNovel,
} from './api.js';
