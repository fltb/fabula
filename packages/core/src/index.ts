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
// Assembler
export {
  type AssembleOptions,
  type AssembleResult,
  assembleNovel,
  countNarrativeText,
  countWords,
} from './assembler/index.js';
// Batch types only
export type { BatchConfig, BatchProgressEvent, BatchResult, BatchStats } from './batch-renderer.js';
export type { VerifyChainResult } from './cache/render-cache.js';
// Cache
export {
  clearEventCache,
  computeEvidenceHash,
  getCachedRender,
  setCachedRender,
  verifyEvidenceChain,
} from './cache/render-cache.js';
export type { RelevanceContext } from './context/index.js';
// Context
export {
  ContextAssembler,
  ContextCompiler,
  RelevanceEngine,
} from './context/index.js';
export type { CompareOutcome, ProjectData } from './entity/index.js';
// Entity
export {
  compareFact,
  EntityMapper,
  InMemoryEntityRegistry,
  loadProjectConfig,
  migrateProjectFile,
  readYamlFile,
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
  StorageError,
  sanitizeError,
  TimeoutError,
  ValidationError,
} from './errors.js';
export type { EventMap } from './event-bus.ts';
// Event bus
export { TypedEventBus } from './event-bus.ts';
export { calculateISS } from './iss/index.js';
// Migration
export {
  CURRENT_SCHEMA_VERSION,
  type MigrationFn,
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
// Report
export { type BenchReport, type PipelineRunResult, ReportWriter } from './report/index.js';
// Reporter (legacy, delegates to ReportWriter)
export { type ValidationReport, writeValidationReport } from './reporter/index.js';
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
export type { AdjacencyList, StoryBoundaries } from './state/index.js';
// State
export {
  buildCausalEdges,
  compileStoryBoundaries,
  exportDAGtoDOT,
  exportDAGtoMermaid,
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
  RenderNovelOptions,
  RenderNovelResult,
} from './api.js';
// API — Orchestration functions (public API)
export {
  analyzeProjectImpact,
  diffEvent,
  getProjectStatus,
  initializeProject,
  listEntities,
  renderNovel,
  showEntity,
  validateNovel,
} from './api.js';
