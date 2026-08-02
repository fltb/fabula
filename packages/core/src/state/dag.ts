import { DagCycleError, DagProviderError } from '../errors.js';
import type { SceneStoryCoordinate } from '../types/entity.js';

export type AdjacencyList = ReadonlyMap<string, readonly string[]>;

export interface StoryOrderIndex {
  initialRootId: string | null;
  /** Ordinary event IDs only. */
  topologicalOrder: readonly string[];
  /** Transitive ordinary-event ancestors; may include the initial root. */
  ancestorsByEventId: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * Build a deterministic linear extension and transitive reachability index without
 * mutating the authored/compiled graph. Derived temporal edges already encode every
 * comparable temporal constraint; event IDs break ties only among genuinely unrelated nodes.
 */
export function buildStoryOrderIndex(
  initialRootId: string | null,
  eventIds: readonly string[],
  adjacency: AdjacencyList,
  _coordinatesByEventId: ReadonlyMap<string, SceneStoryCoordinate>,
): StoryOrderIndex {
  const ordinaryIds = new Set(eventIds);
  if (ordinaryIds.size !== eventIds.length) {
    throw new DagProviderError('Story order contains duplicate ordinary event IDs', {
      phase: 'story-order',
    });
  }
  if (initialRootId !== null && ordinaryIds.has(initialRootId)) {
    throw new DagProviderError('Initial root must not be an ordinary event', {
      eventId: initialRootId,
      phase: 'story-order',
    });
  }

  const nodeIds = new Set(eventIds);
  if (initialRootId !== null) nodeIds.add(initialRootId);
  const copied = new Map<string, string[]>();
  for (const id of nodeIds) copied.set(id, []);
  for (const [predecessor, dependents] of adjacency) {
    if (!nodeIds.has(predecessor)) {
      throw new DagProviderError(`Unknown predecessor '${predecessor}' in story graph`, {
        eventId: predecessor,
        phase: 'story-order',
      });
    }
    const successors = copied.get(predecessor);
    if (successors === undefined) {
      throw new DagProviderError(`Unknown predecessor '${predecessor}' in story graph`, {
        eventId: predecessor,
        phase: 'story-order',
      });
    }
    for (const dependent of dependents) {
      if (!nodeIds.has(dependent)) {
        throw new DagProviderError(`Unknown dependent '${dependent}' in story graph`, {
          eventId: dependent,
          phase: 'story-order',
        });
      }
      if (!successors.includes(dependent)) successors.push(dependent);
    }
  }

  const inDegree = new Map<string, number>([...nodeIds].map((id) => [id, 0]));
  for (const dependents of copied.values()) {
    for (const dependent of dependents) inDegree.set(dependent, (inDegree.get(dependent) ?? 0) + 1);
  }

  const ancestors = new Map<string, Set<string>>([...nodeIds].map((id) => [id, new Set()]));
  const compareReady = (left: string, right: string): number => {
    if (left === initialRootId) return -1;
    if (right === initialRootId) return 1;
    return left.localeCompare(right);
  };
  const ready = [...nodeIds].filter((id) => inDegree.get(id) === 0).sort(compareReady);
  const orderedAll: string[] = [];

  while (ready.length > 0) {
    const current = ready.shift();
    if (current === undefined) {
      throw new DagProviderError('Story graph ready queue unexpectedly emptied', {
        phase: 'story-order',
      });
    }
    orderedAll.push(current);
    for (const dependent of copied.get(current) ?? []) {
      const targetAncestors = ancestors.get(dependent);
      const currentAncestors = ancestors.get(current);
      if (targetAncestors === undefined || currentAncestors === undefined) {
        throw new DagProviderError('Story graph ancestor index is incomplete', {
          eventId: targetAncestors === undefined ? dependent : current,
          phase: 'story-order',
        });
      }
      for (const ancestor of currentAncestors) targetAncestors.add(ancestor);
      targetAncestors.add(current);

      const remaining = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort(compareReady);
      }
    }
  }

  if (orderedAll.length !== nodeIds.size) {
    const cycle = [...nodeIds].filter((id) => !orderedAll.includes(id));
    throw new DagCycleError('Story graph contains a cycle', { cycle, phase: 'story-order' });
  }

  return {
    initialRootId,
    topologicalOrder: orderedAll.filter((id) => ordinaryIds.has(id)),
    ancestorsByEventId: new Map(
      eventIds.map((id) => [id, ancestors.get(id) ?? new Set<string>()] as const),
    ),
  };
}

export function isProvenBefore(
  predecessorId: string,
  dependentId: string,
  order: StoryOrderIndex,
): boolean {
  if (predecessorId === dependentId) return false;
  if (order.initialRootId !== null && predecessorId === order.initialRootId) {
    return order.ancestorsByEventId.has(dependentId);
  }
  return order.ancestorsByEventId.get(dependentId)?.has(predecessorId) ?? false;
}
