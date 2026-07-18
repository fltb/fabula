// ============================================================================
// DAG — Causal edge building + topological sort for StateManager
// ============================================================================
// Events are replayed in topological order derived from causal edges:
//   eventA.postconditions → eventB.preconditions (matched on entityId + attribute)
// Disconnected events (no edges) are ordered by narrativeOrder.
// Cycle detection: throws Error if a cycle is detected.
// ============================================================================

import type { NarrativeEvent } from '../types/event.js';

export type AdjacencyList = Map<string, string[]>;

/**
 * Build causal edges from postcondition→precondition matching.
 *
 * Algorithm:
 *   1. Build postcondition index: Map<"entityId.attribute", {eventId, narrativeOrder}[]>
 *   2. For each event's preconditions, find matching postconditions in the index
 *   3. Multi-match: select the provider with the highest narrativeOrder (most recent)
 *   4. Skip self-loops (event must not depend on its own postconditions)
 *
 * @returns edges (adjacency list) and inDegree map for topological sort
 */
export function buildCausalEdges(events: NarrativeEvent[]): {
  edges: AdjacencyList;
  inDegree: Map<string, number>;
} {
  // Build postcondition index: "entityId.attribute.value" → [{eventId, narrativeOrder}]
  // Only deterministic values (value !== undefined) create causal edges;
  // narrativeHint facts are consumed by Pass 2 analysis, not causal ordering.
  const postIndex = new Map<string, Array<{ eventId: string; order: number }>>();
  for (const ev of events) {
    for (const pc of ev.postconditions) {
      if (pc.value === undefined) continue; // narrativeHint facts don't create causal edges
      const key = `${pc.entityId}.${pc.attribute}.${JSON.stringify(pc.value)}`;
      if (!postIndex.has(key)) postIndex.set(key, []);
      postIndex.get(key)!.push({ eventId: ev.id, order: ev.narrativeOrder });
    }
  }

  // Initialize edges and inDegree for all events
  const edges: AdjacencyList = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const ev of events) {
    edges.set(ev.id, []);
    inDegree.set(ev.id, 0);
  }

  // Match preconditions to postconditions
  for (const ev of events) {
    for (const pre of ev.preconditions) {
      // Skip narrativeHint preconditions (no deterministic value to match)
      if (pre.value === undefined) continue;
      const key = `${pre.entityId}.${pre.attribute}.${JSON.stringify(pre.value)}`;
      const providers = postIndex.get(key);
      if (!providers) continue;

      // Multi-match: pick the provider with the highest narrativeOrder (most recent)
      const best = providers.reduce((a, b) => (a.order > b.order ? a : b));

      // Skip self-loops
      if (best.eventId !== ev.id) {
        edges.get(best.eventId)!.push(ev.id);
        inDegree.set(ev.id, (inDegree.get(ev.id) ?? 0) + 1);
      }
    }
  }

  return { edges, inDegree };
}

/**
 * Topological sort using Kahn's algorithm.
 *
 * - Initial queue: events with inDegree=0, sorted by narrativeOrder
 *   (disconnected events will be in this set too)
 * - Process queue (FIFO), decrement neighbors' inDegree
 * - Cycle detection: if result.length < events.length → throw Error
 *
 * @returns topological order of event IDs
 * @throws Error if a cycle is detected (lists unvisited event IDs)
 */
export function topologicalSort(
  events: NarrativeEvent[],
  edges: AdjacencyList,
  inDegree: Map<string, number>,
): string[] {
  // Initial queue: all events with inDegree=0, sorted by narrativeOrder
  const queue: string[] = [];
  for (const ev of events) {
    if (inDegree.get(ev.id) === 0) {
      queue.push(ev.id);
    }
  }
  queue.sort((a, b) => {
    const ea = events.find((e) => e.id === a)!;
    const eb = events.find((e) => e.id === b)!;
    return ea.narrativeOrder - eb.narrativeOrder;
  });

  const result: string[] = [];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    result.push(current);

    for (const neighbor of edges.get(current) ?? []) {
      const deg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, deg);
      if (deg === 0 && !visited.has(neighbor)) {
        queue.push(neighbor);
      }
    }
  }

  // Cycle detection
  if (result.length < events.length) {
    const unvisited = events
      .filter((e) => !visited.has(e.id))
      .map((e) => e.id);
    throw new Error(
      `DAG cycle detected involving: ${unvisited.join(', ')}`,
    );
  }

  return result;
}
