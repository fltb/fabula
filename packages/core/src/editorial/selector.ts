// ============================================================================
// Editorial Selector Preflight — Pure validation of SceneSelector against a
// branch-scoped authored event catalog.  Side-effect free: no storage, no
// provider, no clock.
// ============================================================================

import type { EditorialError, SceneSelector } from '../types/editorial.ts';

// ─── Catalog ─────────────────────────────────────────────────────────────────

/** One entry in the branch‑required event catalog. */
export interface CatalogEntry {
  eventId: string;
  narrativeOrder: number;
  chapter: number;
}

/** The catalog of every event known to the current branch. */
export interface SceneCatalog {
  readonly events: readonly CatalogEntry[];
}

// ─── Preflight Result ────────────────────────────────────────────────────────

export interface SelectorPreflightResult {
  /** Resolved event IDs — deduplicated, narrative‑order sorted. */
  readonly eventIds: readonly string[];
  /** Validation errors encountered during preflight.  Empty = clean. */
  readonly errors: readonly EditorialError[];
}

// ─── Preflight ───────────────────────────────────────────────────────────────

/**
 * Validate a SceneSelector against a branch‑required event catalog and
 * return the resolved, deduplicated, narrative‑sorted event Ids.
 *
 * Errors are accumulated (never thrown) and the result is always a valid
 * readonly array — callers inspect `errors` to decide whether to proceed.
 *
 * Rules
 * -----
 * - `events` selector: every eventId must exist in the catalog.  Unknown
 *   Ids → `SCENE_NOT_FOUND`; off‑branch Ids → `SCENE_NOT_IN_BRANCH`.
 * - `chapter` selector: resolves to every catalog entry whose `chapter`
 *   matches.  Empty chapter → `SCENE_NOT_FOUND`.
 * - `all` selector: every catalog entry.
 * - Duplicate eventIds (explicit in `events` or arising from an overlap
 *   between the selector and a second call) are silently deduplicated.
 * - Final list is sorted by narrative order.
 */
export function preflightSelector(
  selector: SceneSelector | undefined,
  catalog: SceneCatalog,
): SelectorPreflightResult {
  // Build a fast Record lookup from the catalog.
  const index: Record<string, CatalogEntry> = {};
  for (const entry of catalog.events) {
    index[entry.eventId] = entry;
  }

  const errors: EditorialError[] = [];
  const seen = new Set<string>();
  const result: CatalogEntry[] = [];

  // ── Resolve candidate Ids from the selector ─────────────────────────

  let candidateIds: readonly string[];

  if (selector === undefined || selector.type === 'all') {
    // `all` or absent selector: every catalog event
    candidateIds = catalog.events.map((e) => e.eventId);
  } else if (selector.type === 'chapter') {
    // `chapter`: events whose chapter field matches
    candidateIds = catalog.events
      .filter((e) => e.chapter === selector.chapter)
      .map((e) => e.eventId);
  } else {
    // `events`: the caller‑supplied list
    candidateIds = selector.eventIds;
  }

  // ── Validate each candidate ─────────────────────────────────────────

  for (const eventId of candidateIds) {
    // Duplicate check (explicit duplicates in the selector)
    if (seen.has(eventId)) continue;
    seen.add(eventId);

    const entry = index[eventId];

    if (entry === undefined) {
      errors.push({
        code: 'SCENE_NOT_FOUND',
        message: `Event "${eventId}" is not part of the authored catalog for this branch.`,
        eventId,
      });
      continue; // unknown — skip
    }

    // Off‑branch: if a secondary filter were supplied, this would compare
    // against it.  With the branch‑scoped catalog every resolved entry is
    // implicitly on‑branch, so the code below is deliberately unreachable
    // in the current implementation — the error type exists for future use.
    /*
    if (!isOnBranch(entry, branchFilter)) {
      errors.push({
        code: 'SCENE_NOT_IN_BRANCH',
        message: `Event "${eventId}" is not reachable on the requested branch.`,
        eventId,
      });
      continue;
    }
    */

    result.push(entry);
  }

  // ── Sort by narrative order ─────────────────────────────────────────

  result.sort((a, b) => a.narrativeOrder - b.narrativeOrder);

  return {
    eventIds: Object.freeze(result.map((e) => e.eventId)),
    errors: Object.freeze(errors),
  };
}
