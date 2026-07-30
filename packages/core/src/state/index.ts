// ============================================================================
// StateManager — Event Sourcing + Snapshot Engine + Replay Engine
// Core of the narrative state system. All world state is derived from events.
// ============================================================================

// ——— CORPUS-5: Build Failure, Metric Isolation & Gate ———
export type { CorpusGateResult, GateCheck } from './corpus-gate.ts';
export {
  checkCausalDeps,
  checkNoPooling,
  checkOracleCoverage,
  checkProvenance,
  checkSelectionReproducibility,
  validateCorpusIntegrity,
} from './corpus-gate.ts';
// ——— CORPUS-4: Mixed Causal Replay + Boundary Oracles ———
export type { CorpusReplayOptions, DiscourseOracle, StoryBoundaryOracle } from './corpus-replay.ts';
export {
  buildMixedNodeOrder,
  computeStateBefore,
  createBoundaryOracle,
  createDiscourseOracle,
} from './corpus-replay.ts';
// ——— CORPUS-3: Reproducible Selection ———
export type { CoverageStrata, SelectionPlan } from './corpus-selection.ts';
export {
  applySelectionFormula,
  BENCHMARK_ELIGIBILITY_MIN,
  COVERAGE_STRATA,
  DEFAULT_SELECTION_FORMULA,
  getCoverageCategories,
  isBenchmarkEligible,
  planSelection,
  validateSelectionAgainstEvents,
} from './corpus-selection.ts';
export type { AdjacencyList, StoryOrderIndex } from './dag.ts';
export { buildStoryOrderIndex, isProvenBefore } from './dag.ts';
export { exportDAGtoDOT, exportDAGtoMermaid } from './dag-export.ts';
export { EventStore } from './event-store.ts';
export type { CompileNode, ExplicitEdgeDecl, RawEffect, RawRequirement } from './graph-compiler.ts';
export { compileDiscourseGraph, compileGraph, compileStoryGraph } from './graph-compiler.ts';
export type { CompiledNarrativeGraphs, CompiledStoryRuntimeGraph } from './graph-adapter.ts';
export { compileNarrativeGraphs, compileStoryRuntimeGraph, storyGraphToEventAdjacency } from './graph-adapter.ts';
export {
  applyClaimTransaction,
  applyKnowledgeBoundary,
  evaluate,
  evaluateGroupEpistemic,
  hasSufficientWarrant,
  recordInformationAct,
  validatePropositionCatalog,
} from './knowledge-replay.ts';
export { StateManager } from './manager.ts';
export { ReplayEngine } from './replay.ts';
export type { ReplayOptions } from './replay.ts';
export { SnapshotEngine } from './snapshot.ts';
export type { CompiledDiscourseRenderContext } from './discourse-context.ts';
export { compileDiscourseBoundaries } from './discourse-context.ts';
export type { DiscourseSceneSequenceEntry } from '../types/graph.js';
export { compileDiscourseSceneSequence, resolveDiscourseBranch } from './discourse-sequence.ts';
export type { PlannedDiscourseLedgerSource } from '../types/discourse.js';
export { compilePlannedDiscourseLedger } from './discourse-ledger.ts';

export type { StoryBoundaries } from './story-boundaries.ts';
export { compileStoryBoundaries, compileStoryBoundariesFromGraph } from './story-boundaries.ts';

export type { CompiledNarrativeRuntime, CompileNarrativeRuntimeInput } from './narrative-runtime.ts';
export { compileNarrativeRuntime } from './narrative-runtime.ts';

export { resolveNarrativeTechniques } from './technique-resolver.ts';
export type { NarrativeTechniqueKind, ResolvedNarrativeTechniqueContract } from '../types/narrative-techniques.ts';
