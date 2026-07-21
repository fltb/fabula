// ============================================================================
// Novalistically Core — Public API
// ============================================================================

// Types
export type * from './types/index.js';

// Stable, safe operational errors
export {
  NovalisticallyError,
  ConfigError,
  StorageError,
  DagProviderError,
  DagCycleError,
  PreconditionMismatchError,
  ReferenceFormatError,
  CacheCorruptionError,
  PipelineError,
  AuthError,
  RateLimitError,
  TimeoutError,
  ModelNotFoundError,
  AssemblyIncompleteError,
  NetworkDeniedError,
  sanitizeError,
} from './errors.js';
export type { ErrorContext } from './errors.js';

// Entity
export {
  EntityMapper,
  InMemoryEntityRegistry,
  readYamlFile,
  compareFact,
} from './entity/index.js';
export type { ProjectData, CompareOutcome } from './entity/index.js';
export {
  analysisResultSchema,
} from './schemas/analysis.js';
export {
  expectedOutcomeManifestSchema,
  provenanceManifestSchema,
  responseReferenceSchema,
  liveSmokeRecordSchema,
} from './schemas/contracts.ts';

// Observability types only
export type { LogContext, LogEntry, LogLevel, LogTransport } from './observability/logger.ts';


// State
export {
  ReplayEngine,
  StateManager,
  compileStoryBoundaries,
  buildCausalEdges,
  exportDAGtoDOT,
  exportDAGtoMermaid,
} from './state/index.js';
export type { AdjacencyList, StoryBoundaries } from './state/index.js';

// Validator
export {
  TimelineValidator,
  CharacterStateValidator,
  KnowledgeValidator,
  WorldRuleValidator,
  CausalityValidator,
  ForeshadowingValidator,
  POVValidator,
  FactualDetailValidator,
  VoiceDriftDetector,
  BranchMergeValidator,
  ReachabilityValidator,
  PacingValidator,
  TenseConsistencyValidator,
  DiscourseBalanceValidator,
  AliasValidator,
  PronounValidator,
  AppearanceValidator,
  ConflictValidator,
  ResultAggregator,
} from './validator/index.js';

// Context
export {
  RelevanceEngine,
  ContextAssembler,
  ContextCompiler,
} from './context/index.js';
export type { RelevanceContext } from './context/index.js';

// Assembler
export {
  assembleNovel,
  countNarrativeText,
  countWords,
  type AssembleOptions,
  type AssembleResult,
} from './assembler/index.js';
export { calculateISS } from './iss/index.js';

// Review
export { ReviewManager } from './review/index.js';

// Plugin types only
export type { PluginValidator } from './plugin/index.js';

// Storage
export { FsStorage, MemoryStorage } from './storage/index.ts';
export type { Storage, DirEntry, StorageWrite } from './storage/index.ts';

// Reporter
export { writeValidationReport, type ValidationReport } from './reporter/index.js';

// AI
export type {
  LLMProvider,
  Message,
  CompletionRequest,
  CompletionResponse,
} from './ai/index.ts';
export { LLMError, MockProvider, MockPass2Provider, AiSdkProvider } from './ai/index.ts';
export type { MockProviderOptions, MockPass2Options, MockPass2Entry, AiSdkProviderOptions } from './ai/index.ts';
export type { SceneRenderInput, ThreadStatusInput, ProseOnlyInput, RenderAnalysisInput } from './ai/index.ts';

// Cache
export { clearEventCache } from './cache/render-cache.js';

// Pipeline types only
export type { RenderJob, RenderSceneResult, RenderPipelineOptions, ProviderCallLedgerEntry } from './pipeline/index.js';
export type { ReverseValidationResult, RepairStrategy, RepairDecision } from './pipeline/index.js';

// Batch types only
export type { BatchConfig, BatchProgressEvent, BatchResult, BatchStats } from './batch-renderer.js';

// Bench (functional + performance) is in @novalistically/bench, NOT core.
// Bench calls core to do measurements; bench itself is not part of core.

// API — Orchestration functions (public API)
export {
  initializeProject,
  renderNovel,
  validateNovel,
  getProjectStatus,
  diffEvent,
  listEntities,
  showEntity,
} from './api.js';
export type {
  RenderNovelOptions,
  RenderNovelResult,
  ProjectStatusResult,
  DiffResult,
} from './api.js';
