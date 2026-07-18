// ============================================================================
// Novalistically Core — Public API
// ============================================================================

// Types
export type * from './types/index.js';

// Entity
export {
  EntityMapper,
  InMemoryEntityRegistry,
  compareTimestamp,
  parseStoryTimestamp,
  resolveTimestampToDay,
  readYamlFile,
  readYamlFilesInDir,
  compareFact,
} from './entity/index.js';
export type { ProjectData, CompareOutcome } from './entity/index.js';

// Branch
export {
  createEmptyBranchPath,
  includesPath,
  evaluateCondition,
  branchPathsEqual,
  branchPathToString,
  isLinearNarrative,
  createBranchPoint,
  getAvailableChoices,
} from './branch/index.js';

// State
export {
  EventStore,
  SnapshotEngine,
  ReplayEngine,
  StateManager,
  buildCausalEdges,
  topologicalSort,
  exportDAGtoDOT,
  exportDAGtoMermaid,
} from './state/index.js';
export type { AdjacencyList } from './state/index.js';

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
  PromptAssembler,
} from './context/index.js';
export type { RelevanceContext } from './context/index.js';

// Assembler
export {
  SceneCollector,
  NarrativeSorter,
  ProseConcatenator,
  assembleNovel,
  countWords,
  type AssembleOptions,
  type AssembleResult,
} from './assembler/index.js';

// ISS
export { calculateISS, detectAntiPatterns, validateStrict } from './iss/index.js';

// Review
export { ReviewManager } from './review/index.js';

// Plugin
export { PluginLoader, ValidatorRegistry } from './plugin/index.js';
export type { PluginValidator } from './plugin/index.js';

// Storage
export { FsStorage } from './storage/index.ts';
export type { Storage, DirEntry } from './storage/index.ts';

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
export { buildSceneRenderPrompt, buildThreadStatusPrompt, buildProsePrompt, buildAnalysisPrompt } from './ai/index.ts';
export type { MockProviderOptions, MockPass2Options, MockPass2Entry, AiSdkProviderOptions } from './ai/index.ts';
export type { SceneRenderInput, ThreadStatusInput, ProseOnlyInput, RenderAnalysisInput } from './ai/index.ts';

// Cache
export { clearEventCache } from './cache/render-cache.js';

// Pipeline
export { RenderPipeline, buildAndWriteOutputs } from './pipeline/index.js';
export type { RenderJob, RenderSceneResult, RenderPipelineOptions } from './pipeline/index.js';
export { analyzeValidationErrors, buildRepairGuidance, decideRepairStrategy, degradeStrategy } from './pipeline/index.js';
export type { ReverseValidationResult, RepairStrategy, RepairDecision } from './pipeline/index.js';

// Batch renderer
export { BatchRenderPipeline } from './batch-renderer.js';
export type { BatchConfig, BatchProgressEvent, BatchResult, BatchStats } from './batch-renderer.js';

// Bench (functional + performance) is in @novalistically/bench, NOT core.
// Bench calls core to do measurements; bench itself is not part of core.

// API — Orchestration functions (public API)
export {
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
