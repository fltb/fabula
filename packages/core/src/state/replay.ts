// ============================================================================
// ReplayEngine — Reconstructs WorldState in causal order
// ============================================================================

import { createEmptyBranchPath } from '../branch/index.js';
import { ConfigError } from '../errors.js';
import type { StateSnapshotRecord } from '../ports/index.ts';
import type {
  BranchPath,
  EntityCatalogContext,
  Fact,
  NarrativeEvent,
  TimeAnchor,
  WorldState,
} from '../types/index.js';
import { verifySnapshotRecord } from './canonical-snapshot.ts';
import { applyNarrativeEvent } from './event-application.ts';
import type { CompiledStoryRuntimeGraph } from './graph-adapter.ts';
import { compileStoryRuntimeGraph } from './graph-adapter.ts';
import type { RelationshipReplayContext } from './relationship-replay.js';
import {
  applyNarrativeBaseline,
  emptyWorldState,
  type NarrativeStateBaseline,
} from './story-boundaries.ts';

export interface ReplayOptions {
  branchPath?: BranchPath;
  initialFacts?: readonly Fact[];
  initialThreads?: readonly { id: string }[];
  timeAnchors?: readonly TimeAnchor[];
  relationshipReplayContext?: RelationshipReplayContext;
  baseline?: NarrativeStateBaseline;
}

/** State was reconstructed from a verified snapshot plus its canonical suffix. */
export interface SnapshotReplaySource {
  readonly kind: 'snapshot';
  readonly sequence: number;
  readonly schema: string;
  readonly schemaVersion: number;
  readonly snapshotHash: string;
}

/** State was reconstructed by full canonical replay from the immutable source. */
export interface FullReplaySource {
  readonly kind: 'full-replay';
}

export type ReplaySource = SnapshotReplaySource | FullReplaySource;

export interface ReplayFromNearestResult {
  readonly state: WorldState;
  /** How the state was produced: verified snapshot + suffix, or full replay. */
  readonly source: ReplaySource;
  /** Quarantined candidates (hash/schema/position failures) — never hydrated. */
  readonly corrupt: readonly StateSnapshotRecord[];
}

/** Deep-clone a snapshot's stored state back into a mutable WorldState. */
function hydrateSnapshotState(verified: StateSnapshotRecord): WorldState {
  return JSON.parse(JSON.stringify(verified.state)) as WorldState;
}

function requireCompiledEvent(
  eventsById: ReadonlyMap<string, NarrativeEvent>,
  eventId: string,
): NarrativeEvent {
  const event = eventsById.get(eventId);
  if (event === undefined) {
    throw new ConfigError(`Compiled story order references unknown event "${eventId}"`, {
      eventId,
      phase: 'replay',
    });
  }
  return event;
}

export class ReplayEngine {
  private readonly catalogs: EntityCatalogContext;
  private readonly relationshipReplayContext?: RelationshipReplayContext;

  constructor(
    catalogContext: EntityCatalogContext,
    relationshipReplayContext?: RelationshipReplayContext,
  ) {
    this.catalogs = catalogContext;
    this.relationshipReplayContext = relationshipReplayContext;
  }

  /** Replay all events in canonical causal order, including baseline. */
  replay(events: NarrativeEvent[], options: ReplayOptions = {}): WorldState {
    const branchPath = options.branchPath ?? createEmptyBranchPath();
    const compiled = compileStoryRuntimeGraph({
      events,
      initialFacts: options.initialFacts ?? [],
      initialThreads: options.initialThreads ?? [],
      timeAnchors: options.timeAnchors ?? [],
      branchPath,
    });

    return this.buildFromCompiled(compiled, branchPath, options);
  }

  /** Get state after the first `position` causally ordered events (0 = baseline). */
  getStateAt(events: NarrativeEvent[], position: number, options: ReplayOptions = {}): WorldState {
    const branchPath = options.branchPath ?? createEmptyBranchPath();
    const compiled = compileStoryRuntimeGraph({
      events,
      initialFacts: options.initialFacts ?? [],
      initialThreads: options.initialThreads ?? [],
      timeAnchors: options.timeAnchors ?? [],
      branchPath,
    });

    const state = emptyWorldState();
    const lifecycleChangesByCoordinate = applyNarrativeBaseline(
      state,
      compiled.initialFacts,
      compiled.initialThreads,
      branchPath,
      this.catalogs,
      options.baseline,
    );

    // Replay up to position ordinary events
    const eventsById = new Map(compiled.selectedEvents.map((e) => [e.id, e]));
    for (const eventId of compiled.order.topologicalOrder.slice(0, position)) {
      applyNarrativeEvent(state, requireCompiledEvent(eventsById, eventId), {
        catalogs: this.catalogs,
        relationshipReplayContext:
          options.relationshipReplayContext ?? this.relationshipReplayContext,
        branchPath,
        lifecycleChangesByCoordinate,
        storyCoordinate: compiled.temporalContext.coordinatesByEventId.get(eventId),
        phase: 'replay',
      });
    }

    return state;
  }

  /**
   * Reconstruct the final state from a verified snapshot (plan 8.3): hydrate
   * the snapshot value, then apply the canonical suffix — every event after
   * `verified.sequence` in the compiled topological order.
   *
   * `events` MUST be the complete immutable event source for the stream, not
   * just the suffix: the canonical order and per-event story coordinates are
   * derived from the full compiled graph, so a partial set would reorder and
   * mis-apply the suffix. The caller MUST pass a record that already passed
   * `verifySnapshotRecord`; corruption handling (quarantine) lives in
   * `replayFromNearest`.
   */
  replayFromSnapshot(
    verified: StateSnapshotRecord,
    events: NarrativeEvent[],
    options: ReplayOptions = {},
  ): WorldState {
    const branchPath = options.branchPath ?? createEmptyBranchPath();
    const compiled = compileStoryRuntimeGraph({
      events,
      initialFacts: options.initialFacts ?? [],
      initialThreads: options.initialThreads ?? [],
      timeAnchors: options.timeAnchors ?? [],
      branchPath,
    });
    const eventCount = compiled.order.topologicalOrder.length;
    if (verified.sequence < 1 || verified.sequence > eventCount) {
      throw new ConfigError(
        `Snapshot sequence ${verified.sequence} is outside the canonical replay range [1, ${eventCount}]`,
        { phase: 'replay' },
      );
    }
    const state = hydrateSnapshotState(verified);
    this.applySuffix(state, compiled, verified.sequence, eventCount, options, branchPath);
    return state;
  }

  /**
   * Read path for snapshot acceleration (plan 8.3): nearest valid snapshot at
   * or before `targetCount` → hydrate + canonical suffix; full-replay fallback
   * when no valid snapshot exists. Corrupt candidates (hash/schema/position
   * failures) are quarantined into `corrupt` and never hydrated — a corrupt
   * snapshot is never treated as an empty state.
   */
  replayFromNearest(
    snapshots: readonly StateSnapshotRecord[],
    targetCount: number,
    events: NarrativeEvent[],
    options: ReplayOptions = {},
  ): ReplayFromNearestResult {
    const branchPath = options.branchPath ?? createEmptyBranchPath();
    const compiled = compileStoryRuntimeGraph({
      events,
      initialFacts: options.initialFacts ?? [],
      initialThreads: options.initialThreads ?? [],
      timeAnchors: options.timeAnchors ?? [],
      branchPath,
    });
    const eventCount = compiled.order.topologicalOrder.length;
    const clampedTarget = Math.max(0, Math.min(targetCount, eventCount));

    // Verify every candidate; failures are quarantined, never candidates.
    const corrupt: StateSnapshotRecord[] = [];
    const candidates: StateSnapshotRecord[] = [];
    for (const snapshot of snapshots) {
      const verdict = verifySnapshotRecord(snapshot);
      if (!verdict.valid) {
        corrupt.push(snapshot);
        continue;
      }
      if (snapshot.sequence < 1 || snapshot.sequence > eventCount) {
        // Unreachable replay position — unusable, quarantine with the corrupt.
        corrupt.push(snapshot);
        continue;
      }
      candidates.push(snapshot);
    }

    const nearest = candidates
      .filter((snapshot) => snapshot.sequence <= clampedTarget)
      .sort((a, b) => b.sequence - a.sequence)[0];

    if (nearest === undefined) {
      // Full-replay fallback to the target position (baseline + prefix events).
      const state = emptyWorldState();
      applyNarrativeBaseline(
        state,
        compiled.initialFacts,
        compiled.initialThreads,
        branchPath,
        this.catalogs,
        options.baseline,
      );
      this.applySuffix(state, compiled, 0, clampedTarget, options, branchPath);
      return { state, source: { kind: 'full-replay' }, corrupt };
    }

    const state = hydrateSnapshotState(nearest);
    this.applySuffix(state, compiled, nearest.sequence, clampedTarget, options, branchPath);
    return {
      state,
      source: {
        kind: 'snapshot',
        sequence: nearest.sequence,
        schema: nearest.schema,
        schemaVersion: nearest.schemaVersion,
        snapshotHash: nearest.snapshotHash,
      },
      corrupt,
    };
  }

  /**
   * Apply the canonical topological suffix [fromSequence, toSequence) to a
   * state that already carries baseline + prefix (hydrated snapshot or freshly
   * baseline-applied empty state). The lifecycle guard starts empty in both
   * paths — baseline application never populates it — so the two paths agree.
   */
  private applySuffix(
    state: WorldState,
    compiled: CompiledStoryRuntimeGraph,
    fromSequence: number,
    toSequence: number,
    options: ReplayOptions,
    branchPath: BranchPath,
  ): void {
    const lifecycleChangesByCoordinate = new Map<string, Set<string>>();
    const eventsById = new Map(compiled.selectedEvents.map((e) => [e.id, e]));
    for (const eventId of compiled.order.topologicalOrder.slice(fromSequence, toSequence)) {
      applyNarrativeEvent(state, requireCompiledEvent(eventsById, eventId), {
        catalogs: this.catalogs,
        relationshipReplayContext:
          options.relationshipReplayContext ?? this.relationshipReplayContext,
        branchPath,
        lifecycleChangesByCoordinate,
        storyCoordinate: compiled.temporalContext.coordinatesByEventId.get(eventId),
        phase: 'replay',
      });
    }
  }

  /** Full replay from compiled artifact. */
  private buildFromCompiled(
    compiled: CompiledStoryRuntimeGraph,
    branchPath: BranchPath,
    options: ReplayOptions,
  ): WorldState {
    const state = emptyWorldState();
    const lifecycleChangesByCoordinate = applyNarrativeBaseline(
      state,
      compiled.initialFacts,
      compiled.initialThreads,
      branchPath,
      this.catalogs,
      options.baseline,
    );

    // Replay ordinary events in topological order
    const eventsById = new Map(compiled.selectedEvents.map((e) => [e.id, e]));
    for (const eventId of compiled.order.topologicalOrder) {
      applyNarrativeEvent(state, requireCompiledEvent(eventsById, eventId), {
        catalogs: this.catalogs,
        relationshipReplayContext:
          options.relationshipReplayContext ?? this.relationshipReplayContext,
        branchPath,
        lifecycleChangesByCoordinate,
        storyCoordinate: compiled.temporalContext.coordinatesByEventId.get(eventId),
        phase: 'replay',
      });
    }

    return state;
  }
}
