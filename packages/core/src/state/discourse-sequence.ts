// ============================================================================
// Novalistically — DISCOURSE-2: Canonical Discourse Scene Sequence Compiler
//
// Merges the private compileSceneSequence (graph-adapter.ts) and
// compileBranchSceneSequence (discourse-context.ts) into a single canonical
// helper. Only source === 'event_file' scenes are accepted. The helper
// performs strict preflight before any graph/technique/prompt assembly.
// ============================================================================

import { ConfigError } from '../errors.ts';
import type { BranchPath } from '../types/branch.ts';
import type { PlannedDiscourseLedger } from '../types/discourse.ts';
import type { NarrativeEvent } from '../types/event.ts';
import type { DiscourseSceneSequenceEntry } from '../types/graph.ts';

// DiscourseSceneSequenceEntry is defined in types/graph.ts (the source of truth).

// ═════════════════════════════════════════════════════════════════════════════
// compileDiscourseSceneSequence — canonical scene sequence compiler
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Compile the branch-selected, source-filtered discourse scene sequence from
 * authored events and a mandatory planned disclosure ledger.
 *
 * Performs strict preflight:
 *  - Only `source === 'event_file'` scenes are included.
 *  - The selected branch must have at least one chapter block.
 *  - Chapter numbers must be strictly increasing.
 *  - Scene IDs must be globally unique (no duplicates).
 *  - Every event_file scene must appear in the ledger exactly once.
 *  - Every ledger scene must reference an existing event_file scene (no unknowns).
 *  - Branch action positions must be contiguous from 0.
 *  - Each scene's action positions must form a contiguous range.
 *  - Action intervals must be ordered according to the scene sequence.
 *
 * @throws ConfigError with phase 'discourse-sequence' on any violation.
 */
export function compileDiscourseSceneSequence(input: {
  /** All reachable events in the selected branch (pre-filtered by branchPath). */
  events: readonly NarrativeEvent[];
  /** Runtime-compiled mandatory disclosure ledger. */
  ledger: PlannedDiscourseLedger;
  /** Branch to compile the sequence for. */
  branch: string;
}): readonly DiscourseSceneSequenceEntry[] {
  const { events, ledger, branch } = input;

  // ── Filter to only event_file scenes ──
  const eventFileEvents = events.filter((event) => event.source === 'event_file');
  const eventById = new Map(eventFileEvents.map((event) => [event.id, event]));
  if (eventById.size !== eventFileEvents.length) {
    throw new ConfigError(`Duplicate event IDs supplied for discourse branch "${branch}".`, {
      phase: 'discourse-sequence',
    });
  }

  // ── Branch chapter blocks must exist ──
  const chapterBlocks = ledger.chapters.filter((chapter) => chapter.branch === branch);
  if (chapterBlocks.length === 0) {
    throw new ConfigError(
      `Discourse ledger "${ledger.id}" has no chapter sequence for branch "${branch}".`,
      { phase: 'discourse-sequence' },
    );
  }

  // ── Validate chapter sequence and scene coverage ──
  let previousChapter = 0;
  const seenSceneIds = new Set<string>();
  const sceneIds: string[] = [];

  for (const chapterBlock of chapterBlocks) {
    if (chapterBlock.chapter <= previousChapter) {
      throw new ConfigError(
        `Discourse ledger "${ledger.id}" has non-increasing chapter ${chapterBlock.chapter} ` +
          `for branch "${branch}".`,
        { phase: 'discourse-sequence' },
      );
    }
    previousChapter = chapterBlock.chapter;

    for (const sceneId of chapterBlock.sceneIds) {
      if (!eventById.has(sceneId)) {
        throw new ConfigError(
          `Discourse ledger "${ledger.id}" chapter ${chapterBlock.chapter} references unknown scene "${sceneId}" ` +
            `for branch "${branch}".`,
          { phase: 'discourse-sequence', eventId: sceneId },
        );
      }
      if (seenSceneIds.has(sceneId)) {
        throw new ConfigError(
          `Discourse ledger "${ledger.id}" lists scene "${sceneId}" more than once ` +
            `on branch "${branch}".`,
          { phase: 'discourse-sequence', eventId: sceneId },
        );
      }
      seenSceneIds.add(sceneId);
      sceneIds.push(sceneId);
    }
  }

  // Every event_file scene must be covered by the ledger
  for (const eventId of eventById.keys()) {
    if (!seenSceneIds.has(eventId)) {
      throw new ConfigError(
        `Discourse ledger "${ledger.id}" omits reachable scene "${eventId}" ` +
          `on branch "${branch}".`,
        { phase: 'discourse-sequence', eventId },
      );
    }
  }

  // ── Validate branch action positions are contiguous from 0 ──
  const branchEntries = ledger.entries
    .filter((entry) => entry.branch === branch)
    .sort((left, right) => left.discoursePosition - right.discoursePosition);

  for (const [index, entry] of branchEntries.entries()) {
    if (entry.discoursePosition !== index) {
      throw new ConfigError(
        `Discourse ledger "${ledger.id}" has gapped action position ${entry.discoursePosition} ` +
          `on branch "${branch}"; positions must be contiguous from 0.`,
        { phase: 'discourse-sequence' },
      );
    }
  }

  // ── Validate each scene's action positions form a contiguous range ──
  const entriesByScene = new Map<string, typeof branchEntries>();
  for (const entry of branchEntries) {
    const entries = entriesByScene.get(entry.sceneId) ?? [];
    entries.push(entry);
    entriesByScene.set(entry.sceneId, entries);
  }

  for (const [sceneId, entries] of entriesByScene) {
    if (entries.length < 2) continue; // single action is trivially contiguous
    const sorted = entries.map((e) => e.discoursePosition).sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] !== sorted[i - 1] + 1) {
        throw new ConfigError(
          `Discourse ledger "${ledger.id}" scene "${sceneId}" on branch "${branch}" ` +
            `has non-continuous action positions: ${sorted.join(', ')}. ` +
            `Scene action positions must form a contiguous range. ` +
            `Gap between ${sorted[i - 1]} and ${sorted[i]}.`,
          { phase: 'discourse-sequence', eventId: sceneId },
        );
      }
    }
  }

  // ── Compute action intervals ──
  const actionIntervals = new Map<string, { start: number; end: number }>();
  for (const [sceneId, entries] of entriesByScene) {
    const sortedPositions = entries.map((e) => e.discoursePosition).sort((a, b) => a - b);
    const start = sortedPositions[0];
    const end = sortedPositions[sortedPositions.length - 1];
    if (start === undefined || end === undefined) {
      throw new ConfigError(`Scene "${sceneId}" has no discourse actions on branch "${branch}".`, {
        phase: 'discourse-sequence',
        eventId: sceneId,
      });
    }
    actionIntervals.set(sceneId, { start, end });
  }

  // ── Validate action intervals follow scene sequence order ──
  let previousSceneIndex = -1;
  const sortedIntervals = [...actionIntervals.entries()].sort(
    (left, right) => left[1].start - right[1].start,
  );
  for (const [sceneId, interval] of sortedIntervals) {
    const sceneIndex = sceneIds.indexOf(sceneId);
    if (sceneIndex <= previousSceneIndex) {
      throw new ConfigError(
        `Discourse ledger "${ledger.id}" action interval for scene "${sceneId}" ` +
          `begins at ${interval.start} outside the declared scene sequence ` +
          `for branch "${branch}".`,
        { phase: 'discourse-sequence', eventId: sceneId },
      );
    }
    previousSceneIndex = sceneIndex;
  }

  // ── Build result entries ──
  return chapterBlocks.flatMap((chapterBlock) =>
    chapterBlock.sceneIds.map((sceneId) => {
      const interval = actionIntervals.get(sceneId);
      return {
        sceneId,
        sequence: sceneIds.indexOf(sceneId),
        chapter: chapterBlock.chapter,
        ...(interval === undefined ? {} : { actionInterval: interval }),
      };
    }),
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// resolveDiscourseBranch — map selected graph events to a unique discourse
// branch by exact scene coverage. Fails closed: missing or ambiguous route
// throws ConfigError before any provider call, cache write, or scene write.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Given the event IDs that survived BranchPath graph filtering, resolve the
 * unique discourse branch in the ledger whose scene set exactly covers them.
 *
 * Resolution logic:
 *  - Every discourse branch from the ledger chapters is collected.
 *  - A branch is a candidate when ALL its scene IDs are present in the
 *    provided selectedEventIds (i.e. every scene the branch claims is
 *    reachable via this BranchPath).
 *  - If exactly one branch is a candidate, it is returned as the resolved
 *    discourse branch name.
 *  - Zero candidates → ConfigError (no discourse branch covers the route).
 *  - Multiple candidates → ConfigError (ambiguous — caller must narrow
 *    the BranchPath).
 *
 * @param selectedEventIds  Event IDs that survived graph BranchPath filtering
 *                          (only event_file / ledger-scene IDs matter;
 *                          transition/system IDs that are not in any branch
 *                          are ignored and do not trigger mismatch).
 * @param branchPath        The full BranchPath used for graph filtering.
 * @param ledger            The compiled planned disclosure ledger.
 * @returns The unique discourse branch name (e.g. "main", "accept_hunt").
 * @throws ConfigError with phase 'discourse-branch-resolve' on missing or
 *         ambiguous routes, or when the ledger has no chapters at all.
 */
export function resolveDiscourseBranch(input: {
  selectedEventIds: ReadonlySet<string>;
  branchPath: BranchPath;
  ledger: PlannedDiscourseLedger;
}): string {
  const { selectedEventIds, branchPath: _branchPath, ledger } = input;

  if (ledger.chapters.length === 0) {
    throw new ConfigError(
      `Discourse ledger "${ledger.id}" has no chapters; cannot resolve discourse branch.`,
      { phase: 'discourse-branch-resolve' },
    );
  }

  // ── Collect scene-Id sets per unique branch ──
  const scenesByBranch = new Map<string, Set<string>>();
  for (const chapter of ledger.chapters) {
    let scenes = scenesByBranch.get(chapter.branch);
    if (!scenes) {
      scenes = new Set();
      scenesByBranch.set(chapter.branch, scenes);
    }
    for (const sceneId of chapter.sceneIds) {
      scenes.add(sceneId);
    }
  }

  // ── Find branches whose scenes are all present in selectedEventIds ──
  const matchingBranches: string[] = [];
  for (const [branchName, sceneIds] of scenesByBranch) {
    let allCovered = true;
    for (const sceneId of sceneIds) {
      if (!selectedEventIds.has(sceneId)) {
        allCovered = false;
        break;
      }
    }
    if (allCovered) {
      matchingBranches.push(branchName);
    }
  }

  if (matchingBranches.length === 0) {
    // Build a helpful diagnostic
    const allBranchNames = [...scenesByBranch.keys()];
    const sceneSample = [...selectedEventIds].slice(0, 5);
    throw new ConfigError(
      `No discourse branch in ledger "${ledger.id}" covers the selected events ` +
        `(branches: ${allBranchNames.join(', ')}, event sample: ${sceneSample.join(', ')}). ` +
        `The route's event set does not match any branch's scene coverage.`,
      { phase: 'discourse-branch-resolve' },
    );
  }

  if (matchingBranches.length > 1) {
    throw new ConfigError(
      `Ambiguous discourse branch for ledger "${ledger.id}": ` +
        `${matchingBranches.join(', ')} all cover the selected events. ` +
        `Narrow the BranchPath or provide an explicit discourseBranch.`,
      { phase: 'discourse-branch-resolve' },
    );
  }

  const matchingBranch = matchingBranches[0];
  if (matchingBranch === undefined) {
    throw new ConfigError('Discourse branch resolution produced no branch.', {
      phase: 'discourse-branch-resolve',
    });
  }
  return matchingBranch;
}
