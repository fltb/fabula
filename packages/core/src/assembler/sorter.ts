import type { SceneEntry } from './types.js';
import type { SortedScene } from './types.js';

// ────────────────────────────────────────────────────────────────────────────
// NarrativeSorter
// ────────────────────────────────────────────────────────────────────────────

/**
 * Sorts collected scenes by narrativeOrder ascending.
 * Grouping by chapter is preserved when two scenes share the same
 * chapter value (extracted from the directory during collection).
 */
export class NarrativeSorter {
  /**
   * Sort collected scenes by narrativeOrder ascending.
   */
  sortByOrder(collected: Map<string, SceneEntry>): SortedScene[] {
    const scenes: SortedScene[] = [];

    for (const [eventId, entry] of collected) {
      scenes.push({
        eventId,
        prose: entry.prose,
        narrativeOrder: entry.narrativeOrder,
        chapter: entry.chapter,
        branchExistence: entry.branchExistence,
      });
    }

    scenes.sort((a, b) => a.narrativeOrder - b.narrativeOrder);

    return scenes;
  }
}
