// ============================================================================
// StateManager — Event Sourcing + Snapshot Engine + Replay Engine
// Core of the narrative state system. All world state is derived from events.
// ============================================================================

export { EventStore } from './event-store.ts';
export { SnapshotEngine } from './snapshot.ts';
export { ReplayEngine } from './replay.ts';
export { StateManager } from './manager.ts';
export { buildCausalEdges, topologicalSort } from './dag.ts';
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
