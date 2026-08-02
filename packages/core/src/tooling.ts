// ============================================================================
// Tooling — scoped public entry: validation, graph, cache, report helpers.
// Published as `@novalistically/core/tooling`. Non-contract surface.
// ============================================================================

export {
  analyzeProjectImpact,
  type DiffResult,
  diffEvent,
  type ImpactAnalysisResult,
  type ImpactLevel,
  inspectProjectGraph,
  type ProjectGraphSnapshot,
} from './api.ts';
export {
  type CacheDiagnostics,
  buildAttemptKeyMaterial,
  buildLogicalKeyMaterial,
  buildSurfaceKeyMaterial,
  buildValidationKeyMaterial,
  canonicalJson,
  computeEvidenceHash,
  computeFlatCacheKey,
  computeSourceContentHash,
  getCachedRender,
  setCachedRender,
  clearEventCache,
  clearRenderCache,
  type VerifyChainResult,
  verifyEvidenceChain,
} from './cache/render-cache.ts';
export { ContextCompiler } from './context/index.ts';
export { AuthError, PipelineError, ReferenceFormatError } from './errors.ts';
export { calculateISS } from './iss/index.ts';
export type { ProviderCallLedgerEntry } from './pipeline/index.ts';
export { type PipelineRunResult, ReportWriter } from './report/index.ts';
export {
  type ValidationReport,
  formatValidationReport,
} from './reporter/index.ts';
export {
  expectedOutcomeManifestSchema,
  liveSmokeRecordSchema,
  provenanceManifestSchema,
  responseReferenceSchema,
} from './schemas/contracts.ts';
export type { AdjacencyList } from './state/dag.ts';
export {
  type CompiledStoryRuntimeGraph,
  compileStoryRuntimeGraph,
  exportDAGtoDOT,
  exportDAGtoMermaid,
  ReplayEngine,
} from './state/index.ts';
export type {
  Blocker,
  NextAction,
  StatusReport,
  ThreadSnapshot,
} from './types/status.ts';
export { ResultAggregator } from './validator/aggregator.ts';
export { createBuiltInValidators } from './validator/builtins.ts';
