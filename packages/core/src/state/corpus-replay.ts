// ============================================================================
// Novalistically — CORPUS-4: Mixed Causal Replay + Boundary Oracles
// Mixed-node ordering, stateBefore computation, and oracle creation
// for reproducible corpus replay validation.
//
// Runtime separation: buildMixedNodeOrder delegates to buildStoryOrderIndex
// with resolved runtime coordinates (no source-byte tie-breaking).
// computeStateBefore replays real event effects with baseline.
// ============================================================================

import { PreconditionMismatchError } from '../errors.ts';
import type { BranchPath } from '../types/branch.ts';
import type {
  EntityCatalogContext,
  Fact,
  NarrativeEvent,
  SceneStoryCoordinate,
  ThreadId,
  ThreadLifecycle,
  ThreadRunId,
  WorldState,
} from '../types/index.js';
import type { AdjacencyList, StoryOrderIndex } from './dag.ts';
import { buildStoryOrderIndex, isProvenBefore } from './dag.ts';
import { applyInitialFacts, applyNarrativeEvent } from './event-application.ts';
import type { RelationshipReplayContext } from './relationship-replay.js';
import { emptyWorldState } from './story-boundaries.ts';

// ═════════════════════════════════════════════════════════════════════════════
// Types
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Story-level boundary oracle — human-verified causal pre-state for an event.
 * Created from `computeStateBefore` and reviewed by a human annotator.
 */
export interface StoryBoundaryOracle {
  /** Event ID this oracle applies to */
  eventId: string;
  /** Version of the oracle schema */
  version: string;
  /** SHA-256 hash of the source material */
  sourceHash: string;
  /**
   * Verified state before the event (entityId -> attribute -> value).
   * Every fact that must hold for correct rendering.
   */
  stateBefore: Record<string, Record<string, unknown>>;
  /** Identity of the reviewer who verified this oracle */
  reviewerId: string;
  /** Review status */
  reviewStatus: 'pending' | 'approved' | 'rejected';
  /** SHA-256 hash of the review record for auditability */
  reviewHash: string;
}

/**
 * Discourse-level oracle — planned narrator/POV/scene-brief for rendering.
 */
export interface DiscourseOracle {
  /** Event ID this oracle applies to */
  eventId: string;
  /** Version of the oracle schema */
  version: string;
  /** Planned narrator identity for the scene */
  plannedNarrator: string;
  /** Planned point-of-view character */
  plannedPOV: string;
  /** Brief scene description for discourse planning */
  plannedSceneBrief: string;
}

/**
 * Consolidated options for corpus runtime stateBefore computation.
 * Bundles the causal graph, resolved runtime coordinates, baseline facts,
 * branch scope, and optional initial thread declarations.
 */
export interface CorpusReplayOptions {
  /** Shared compiled catalogs; required, no optional fallback. */
  catalogs: EntityCatalogContext;
  /**
   * Relationship replay context (declarations + type catalog); required when
   * any event in the corpus carries relationship effects — replay fails closed
   * without it.
   */
  relationshipReplayContext?: RelationshipReplayContext;
  /** Initial facts applied as baseline before any event replay */
  initialFacts: readonly Fact[];
  /** Active branch path for scope filtering */
  branchPath: BranchPath;
  /** Initial thread declarations applied during baseline */
  initialThreads?: readonly { id: string }[];
  /** Event ID to resolved scene story coordinate map (runtime coordinates) */
  coordinatesByEventId: ReadonlyMap<string, SceneStoryCoordinate>;
  /** Causal adjacency list encoding all node relationships (events + ellipses) */
  adjacency: AdjacencyList;
  /** Optional initial root ID for story order index */
  initialRootId?: string | null;
}

// ═════════════════════════════════════════════════════════════════════════════
// Mixed Node Ordering
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Build StoryOrderIndex from corpus runtime node IDs and resolved coordinates.
 *
 * Delegates entirely to buildStoryOrderIndex — no source-byte tie-breaking,
 * no local Kahn's algorithm. The coordinate map enables deterministic event-ID
 * tie-breaking among genuinely unordered nodes; derived temporal edges already
 * encode every comparable temporal constraint.
 *
 * Ellipsis node IDs participate in the same causal graph as event node IDs.
 * The returned StoryOrderIndex covers all supplied nodeIds plus the optional
 * initial root.
 *
 * This order is used for stateBefore computation but NEVER for discourse
 * ordering (which uses narrativeOrder).
 *
 * @param nodeIds - All node IDs (both events and ellipses) to order
 * @param adjacency - GRAPH-1 adjacency list mapping node ID -> its dependents
 * @param coordinatesByEventId - Resolved runtime coordinates keyed by node ID
 * @param initialRootId - Optional initial root for the order index
 * @returns StoryOrderIndex with topological order and transitive ancestors
 * @throws {DagProviderError} if a predecessor is unknown
 * @throws {DagCycleError} if the graph contains a cycle
 */
export function buildMixedNodeOrder(
  nodeIds: readonly string[],
  adjacency: AdjacencyList,
  coordinatesByEventId: ReadonlyMap<string, SceneStoryCoordinate>,
  initialRootId?: string | null,
): StoryOrderIndex {
  return buildStoryOrderIndex(initialRootId ?? null, nodeIds, adjacency, coordinatesByEventId);
}

// ═════════════════════════════════════════════════════════════════════════════
// StateBefore Computation
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Compute the real WorldState before a target event using proven-before replay.
 *
 * Builds canonical order from CorpusReplayOptions.adjacency and
 * .coordinatesByEventId, applies baseline initial facts, then replays every
 * event proven-before the target in topological order. Returns a clone of the
 * accumulated state at that point — no placeholders, no symbolic values.
 *
 * Ellipsis nodes are ordering constraints in the causal graph but have no
 * runtime effects applied here; only NarrativeEvent objects from the events
 * array are replayed. This matches the corpus runtime contract where ellipsis
 * effects are encoded as causal edges, not as WorldState mutations.
 *
 * @param eventId - Target event ID to compute state before
 * @param events - NarrativeEvent objects available for replay
 * @param options - CorpusReplayOptions with adjacency, coordinates, baseline
 * @returns WorldState snapshot before the target event
 * @throws {PreconditionMismatchError} if the target is not found in the event list or causal graph
 * @throws {DagProviderError} if a predecessor is unknown in the causal graph
 * @throws {DagCycleError} if the causal graph contains a cycle
 */
export function computeStateBefore(
  eventId: string,
  events: readonly NarrativeEvent[],
  options: CorpusReplayOptions,
): WorldState {
  const eventsById = new Map<string, NarrativeEvent>();
  for (const event of events) {
    eventsById.set(event.id, event);
  }

  // Determine all node IDs: adjacency keys include all causal participants
  const allNodeIds = new Set<string>();
  for (const [source, dependents] of options.adjacency) {
    allNodeIds.add(source);
    for (const dep of dependents) allNodeIds.add(dep);
  }
  // Also include event IDs that may not be adjacency keys (e.g. root with no incoming)
  for (const event of events) allNodeIds.add(event.id);

  if (!allNodeIds.has(eventId) && !eventsById.has(eventId)) {
    throw new PreconditionMismatchError(
      `Target event "${eventId}" not found in the event list or causal graph`,
      { eventId, phase: 'corpus-replay' },
    );
  }

  // Build canonical story order from the full node set with resolved coordinates
  const order = buildMixedNodeOrder(
    [...allNodeIds],
    options.adjacency,
    options.coordinatesByEventId,
    options.initialRootId,
  );

  // Initialize state with baseline
  const state = emptyWorldState();
  const lifecycleChangesByCoordinate = new Map<string, Set<string>>();
  applyInitialFacts(state, options.initialFacts, {
    branchPath: options.branchPath,
    catalogs: options.catalogs,
  });

  // Apply thread baseline
  for (const thread of options.initialThreads ?? []) {
    state.threads[thread.id] = {
      threadId: thread.id as ThreadId,
      status: 'planned' as ThreadLifecycle,
      currentRunId: `init-${thread.id}` as ThreadRunId,
      phase: '',
      bindings: {},
      goalStates: {},
      milestoneStates: {},
      semanticStateHash: '',
    };
  }

  // Replay all events proven-before the target in topological order
  for (const candidateId of order.topologicalOrder) {
    if (candidateId === eventId) break;
    if (!isProvenBefore(candidateId, eventId, order)) continue;

    const candidateEvent = eventsById.get(candidateId);
    if (!candidateEvent) continue; // skip ellipsis or non-event nodes

    applyNarrativeEvent(state, candidateEvent, {
      catalogs: options.catalogs,
      relationshipReplayContext: options.relationshipReplayContext,
      branchPath: options.branchPath,
      lifecycleChangesByCoordinate,
      storyCoordinate: options.coordinatesByEventId.get(candidateId),
      phase: 'corpus-replay',
    });
  }

  return state;
}

// ═════════════════════════════════════════════════════════════════════════════
// Oracle Creation
// ═════════════════════════════════════════════════════════════════════════════

const ORACLE_SCHEMA_VERSION = '1.0.0';

/**
 * Create a story boundary oracle for an event.
 *
 * The oracle records the computed stateBefore at the time of creation,
 * along with the source hash for auditability. The initial reviewer
 * field is empty (pending human annotation).
 *
 * @param eventId - Event ID this oracle applies to
 * @param stateBefore - Computed pre-event state (WorldState.entities or flat map)
 * @param sourceHash - SHA-256 hash of the source material
 * @returns A new StoryBoundaryOracle in 'pending' status
 */
export function createBoundaryOracle(
  eventId: string,
  stateBefore: Record<string, Record<string, unknown>>,
  sourceHash: string,
): StoryBoundaryOracle {
  const oracle: StoryBoundaryOracle = {
    eventId,
    version: ORACLE_SCHEMA_VERSION,
    sourceHash,
    stateBefore,
    reviewerId: '',
    reviewStatus: 'pending',
    reviewHash: '',
  };
  return oracle;
}

/**
 * Create a discourse oracle from a narrative node anchor.
 *
 * Derives the planned narrator, POV, and scene brief from the node's
 * metadata if available, falling back to sensible defaults.
 *
 * @param eventId - Event ID for the oracle
 * @param node - Narrative node anchor containing scene metadata
 * @returns A new DiscourseOracle for the event
 */
export function createDiscourseOracle(
  eventId: string,
  node: {
    type: 'scene' | 'ellipsis';
    chapterId: string;
  },
): DiscourseOracle {
  const narrator = node.type === 'ellipsis' ? 'ellipsis_narrator' : 'omniscient';
  const pov = node.type === 'ellipsis' ? 'none' : 'protagonist';
  const brief = `${node.type === 'ellipsis' ? 'Ellipsis' : 'Scene'} at ${node.chapterId}`;

  return {
    eventId,
    version: ORACLE_SCHEMA_VERSION,
    plannedNarrator: narrator,
    plannedPOV: pov,
    plannedSceneBrief: brief,
  };
}
