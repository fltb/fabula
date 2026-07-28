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
export type { DiscourseOracle, StoryBoundaryOracle } from './corpus-replay.ts';
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
export type { AdjacencyList } from './dag.ts';
export { buildCausalEdges, topologicalSort } from './dag.ts';
export { exportDAGtoDOT, exportDAGtoMermaid } from './dag-export.ts';
export { EventStore } from './event-store.ts';
export type { CompileNode, ExplicitEdgeDecl, RawEffect, RawRequirement } from './graph-compiler.ts';
export { compileDiscourseGraph, compileGraph, compileStoryGraph } from './graph-compiler.ts';
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
export { SnapshotEngine } from './snapshot.ts';
export type { CompiledDiscourseRenderContext } from './discourse-context.ts';
export { compileDiscourseBoundaries } from './discourse-context.ts';

export type { StoryBoundaries } from './story-boundaries.ts';
export { compileStoryBoundaries } from './story-boundaries.ts';
