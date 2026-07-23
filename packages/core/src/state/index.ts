// ============================================================================
// StateManager — Event Sourcing + Snapshot Engine + Replay Engine
// Core of the narrative state system. All world state is derived from events.
// ============================================================================

export { EventStore } from './event-store.ts';
export { SnapshotEngine } from './snapshot.ts';
export { ReplayEngine } from './replay.ts';
export { StateManager } from './manager.ts';
export { buildCausalEdges, topologicalSort } from './dag.ts';
export { compileGraph, compileStoryGraph, compileDiscourseGraph } from './graph-compiler.ts';
export type { CompileNode, RawEffect, RawRequirement, ExplicitEdgeDecl } from './graph-compiler.ts';
export { compileStoryBoundaries } from './story-boundaries.ts';
export type { StoryBoundaries } from './story-boundaries.ts';
export { exportDAGtoDOT, exportDAGtoMermaid } from './dag-export.ts';
export type { AdjacencyList } from './dag.ts';
export {
  evaluate,
  applyClaimTransaction,
  recordInformationAct,
  hasSufficientWarrant,
  validatePropositionCatalog,
  applyKnowledgeBoundary,
  evaluateGroupEpistemic,
} from './knowledge-replay.ts';

// ——— CORPUS-3: Reproducible Selection ———
export type { SelectionPlan, CoverageStrata } from './corpus-selection.ts';
export {
  applySelectionFormula,
  planSelection,
  validateSelectionAgainstEvents,
  isBenchmarkEligible,
  getCoverageCategories,
  DEFAULT_SELECTION_FORMULA,
  BENCHMARK_ELIGIBILITY_MIN,
  COVERAGE_STRATA,
} from './corpus-selection.ts';

// ——— CORPUS-4: Mixed Causal Replay + Boundary Oracles ———
export type { StoryBoundaryOracle, DiscourseOracle } from './corpus-replay.ts';
export {
  buildMixedNodeOrder,
  computeStateBefore,
  createBoundaryOracle,
  createDiscourseOracle,
} from './corpus-replay.ts';

// ——— CORPUS-5: Build Failure, Metric Isolation & Gate ———
export type { CorpusGateResult, GateCheck } from './corpus-gate.ts';
export {
  validateCorpusIntegrity,
  checkProvenance,
  checkCausalDeps,
  checkOracleCoverage,
  checkSelectionReproducibility,
  checkNoPooling,
} from './corpus-gate.ts';
