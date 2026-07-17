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
} from './entity/index.js';
export type { ProjectData } from './entity/index.js';

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
} from './state/index.js';

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
export { FsStorage, MemoryStorage } from './storage/index.ts';
export type { Storage, DirEntry } from './storage/index.ts';

// AI
export type {
  LLMProvider,
  Message,
  CompletionRequest,
  CompletionResponse,
} from './ai/index.ts';
export { LLMError } from './ai/index.ts';
export { MockProvider, OpencodeZenProvider, OpencodeGoProvider } from './ai/index.ts';
export { OPENCODE_GO_MODELS } from './ai/index.ts';
export { buildSceneRenderPrompt, buildThreadStatusPrompt, buildProsePrompt, buildAnalysisPrompt } from './ai/index.ts';
export type { MockProviderOptions, OpencodeZenOptions, OpencodeGoOptions, OpencodeGoModel } from './ai/index.ts';
export type { SceneRenderInput, ThreadStatusInput, ProseOnlyInput, RenderAnalysisInput } from './ai/index.ts';

// Cache
export {
  computeCacheKeys,
  getCachedRender,
  setCachedRender,
  clearRenderCache,
  clearEventCache,
} from './cache/render-cache.js';

// Pipeline
export { RenderPipeline, ConcurrencyPool, buildAndWriteOutputs } from './pipeline/index.js';
export type { RenderJob, RenderSceneResult, RenderPipelineOptions } from './pipeline/index.js';

// Bench (functional + performance) is in @novalistically/bench, NOT core.
// Bench calls core to do measurements; bench itself is not part of core.
