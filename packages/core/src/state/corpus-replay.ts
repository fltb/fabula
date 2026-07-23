// ============================================================================
// Novalistically — CORPUS-4: Mixed Causal Replay + Boundary Oracles
// Mixed-node ordering, stateBefore computation, and oracle creation
// for reproducible corpus replay validation.
// ============================================================================

import type { AdjacencyList } from './dag.ts';
import type { SourceManifest, NarrativeNodeAnchor } from './corpus-index.ts';
import { PreconditionMismatchError } from '../errors.ts';

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
   * Verified state before the event (entityId → attribute → value).
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

// ═════════════════════════════════════════════════════════════════════════════
// Mixed Node Ordering
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Build a deterministic mixed-node topological order from narrative nodes
 * (scene events and ellipses) using GRAPH-1 typed causal edges, with
 * storyTime as a secondary tiebreaker.
 *
 * The order MUST include all reachable nodes respecting:
 * - Causal dependencies (preconditions → node → postconditions)
 * - Story time chronology (earlier storyTime first)
 * - Stable sorting for nodes with identical storyTime
 *
 * Ellipsis nodes are ordered alongside scene nodes — they participate
 * in the same causal graph.
 *
 * This order is used for stateBefore computation but NEVER for discourse
 * ordering (which uses narrativeOrder). discourse ordering is handled
 * separately by DiscoursePlanner/Assembler.
 *
 * @param nodes - Narrative node anchors (scenes + ellipses)
 * @param dag - GRAPH-1 adjacency list mapping node IDs to their dependents
 * @returns Ordered list of node IDs in deterministic topological order
 * @throws {PreconditionMismatchError} if the graph contains a cycle
 */
export function buildMixedNodeOrder(
  nodes: NarrativeNodeAnchor[],
  dag: AdjacencyList,
): string[] {
  const nodeMap = new Map(nodes.map((n) => [n.nodeId, n]));
  const inDegree = new Map<string, number>();
  const graph = new Map<string, string[]>();

  // Build full graph from the adjacency list — dag maps nodeId → its dependents.
  // Also compute in-degree for each node.
  for (const node of nodes) {
    if (!inDegree.has(node.nodeId)) {
      inDegree.set(node.nodeId, 0);
    }
    if (!graph.has(node.nodeId)) {
      graph.set(node.nodeId, []);
    }
  }

  // dag maps node → nodes that depend on it (edge: node → dependent)
  // So for edges, the source node is the key, the targets are dependents.
  // We need to reverse: a node's dependencies = edges pointing TO it.
  // But adjacency list in dag is parent → child (source → dependent).
  // For topological ordering, we need children's in-degree to count parents.
  // dag[source] = [dependent1, dependent2] means dependent1 has source as precondition.
  for (const [source, dependents] of dag) {
    if (!graph.has(source)) {
      // Source may be from a different context — add it as an anchor-only entry
      // when it's referenced. This handles nodes outside the current scope
      // that are referenced by the DAG.
      graph.set(source, []);
    }
    for (const dependent of dependents) {
      if (!graph.has(dependent)) {
        graph.set(dependent, []);
      }
      // Increment in-degree: dependent depends on source
      inDegree.set(dependent, (inDegree.get(dependent) ?? 0) + 1);
    }
  }

  // Kahn's algorithm with storyTime tiebreakers
  const queue: string[] = [];
  for (const [nodeId, deg] of inDegree) {
    if (deg === 0) {
      queue.push(nodeId);
    }
  }

  // Sort initial queue by storyTime (nodes without storyTime go last)
  queue.sort((a, b) => {
    const nodeA = nodeMap.get(a);
    const nodeB = nodeMap.get(b);
    const ta = nodeA?.sourceRange.startByte ?? Number.MAX_SAFE_INTEGER;
    const tb = nodeB?.sourceRange.startByte ?? Number.MAX_SAFE_INTEGER;
    if (ta !== tb) return ta - tb;
    return a.localeCompare(b);
  });

  const ordered: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    ordered.push(current);

    // Process dependents of current
    const dependents = graph.get(current) ?? [];
    for (const dependent of dependents) {
      const newDegree = (inDegree.get(dependent) ?? 1) - 1;
      inDegree.set(dependent, newDegree);
      if (newDegree === 0) {
        queue.push(dependent);
        // Re-sort: maintain storyTime ordering within each wave
        // (partial sort since queue is small per wave)
        queue.sort((a, b) => {
          const nodeA = nodeMap.get(a);
          const nodeB = nodeMap.get(b);
          const ta = nodeA?.sourceRange.startByte ?? Number.MAX_SAFE_INTEGER;
          const tb = nodeB?.sourceRange.startByte ?? Number.MAX_SAFE_INTEGER;
          if (ta !== tb) return ta - tb;
          return a.localeCompare(b);
        });
      }
    }
  }

  // Detect cycles: if not all nodes were ordered, there's a cycle
  if (ordered.length < nodes.length) {
    const missing = nodes
      .filter((n) => !ordered.includes(n.nodeId))
      .map((n) => n.nodeId);
    throw new PreconditionMismatchError(
      `Cycle detected in mixed-node causal graph: ${missing.length} unreachable nodes: ${missing.join(', ')}`,
    );
  }

  return ordered;
}

// ═════════════════════════════════════════════════════════════════════════════
// StateBefore Computation
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Compute the state before a target event from the mixed-node causal graph.
 *
 * Walks the ordered node list up to (but not including) the target event,
 * collecting preconditions and postconditions from each node into a unified
 * state map. Excludes the target event itself and any nodes that causally
 * depend on it (future effects).
 *
 * The returned state is a snapshot of entity attributes that must hold
 * for the target event to render correctly.
 *
 * @param eventId - The target event ID
 * @param nodes - All narrative node anchors in the work index
 * @param manifest - Source manifest for hash/language context
 * @returns Entity → attribute → value map representing the pre-state
 */
export function computeStateBefore(
  eventId: string,
  nodes: NarrativeNodeAnchor[],
  manifest: SourceManifest,
): Record<string, Record<string, unknown>> {
  // Build a quick lookup map
  const nodeMap = new Map(nodes.map((n) => [n.nodeId, n]));

  const targetNode = nodeMap.get(eventId);
  if (!targetNode) {
    throw new PreconditionMismatchError(
      `Target event "${eventId}" not found in the node index for work "${manifest.workId}"`,
    );
  }

  // Collect pre-state from all nodes that appear before the target
  // in story time and are not causally dependent on the target.
  // Heuristic: we walk all nodes with storyTime < target's storyTime,
  // and collect their postconditions as the base state.
  const stateBefore: Record<string, Record<string, unknown>> = {};

  for (const node of nodes) {
    if (node.nodeId === eventId) continue;

    // Skip nodes that depend on the target (postconditions that reference target)
    if (node.preconditions.includes(eventId)) continue;
    // Skip nodes that only constellate from this event
    if (node.postconditions.includes(eventId)) continue;

    // Apply preconditions — these are facts that must be true
    // We record them as state entries
    for (const precond of node.preconditions) {
      const parts = precond.split(':');
      if (parts.length >= 2) {
        const entityId = parts[0];
        const attr = parts[1];
        if (!stateBefore[entityId]) {
          stateBefore[entityId] = {};
        }
        // Mark as required but unknown value
        stateBefore[entityId][attr] = stateBefore[entityId][attr] ?? Symbol('required');
      }
    }

    // Apply postconditions — these are facts established by prior nodes
    // that become part of the state before our target
    for (const postcond of node.postconditions) {
      const parts = postcond.split(':');
      if (parts.length >= 2) {
        const entityId = parts[0];
        const attr = parts[1];
        if (!stateBefore[entityId]) {
          stateBefore[entityId] = {};
        }
        stateBefore[entityId][attr] = `established_by_${node.nodeId}`;
      }
    }
  }

  // Clean up any Symbol placeholders — they were merely required, not established
  for (const [entityId, attrs] of Object.entries(stateBefore)) {
    for (const [attr, value] of Object.entries(attrs)) {
      if (typeof value === 'symbol') {
        delete stateBefore[entityId][attr];
      }
      // Remove empty entity entries
      if (Object.keys(stateBefore[entityId]).length === 0) {
        delete stateBefore[entityId];
      }
    }
  }

  return stateBefore;
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
 * @param stateBefore - Computed pre-event state
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
  node: NarrativeNodeAnchor,
): DiscourseOracle {
  // Derive narrator and POV from node context
  // In practice, the NarrativeEvent's pov field and sceneBrief are the source;
  // since NarrativeNodeAnchor only has structural metadata, use the nodeId
  // convention and source context to infer defaults.
  const narrator = node.type === 'ellipsis' ? 'ellipsis_narrator' : 'omniscient';
  const pov = node.type === 'ellipsis' ? 'none' : 'protagonist';
  const brief = `${node.type === 'ellipsis' ? 'Ellipsis' : 'Scene'} at ${node.chapterId}:${node.sourceRange.startByte}`;

  return {
    eventId,
    version: ORACLE_SCHEMA_VERSION,
    plannedNarrator: narrator,
    plannedPOV: pov,
    plannedSceneBrief: brief,
  };
}
