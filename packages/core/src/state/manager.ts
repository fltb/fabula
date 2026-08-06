// ============================================================================
// StateManager — Coordinates EventStore + SnapshotEngine + ReplayEngine
//
// Pure in-memory state machine: events are appended and replayed in process,
// snapshots are tracked as values only. Durable event logs and snapshots are
// the caller's responsibility via the semantic StateLogRepository /
// StateSnapshotRepository ports (see ports/state-repository.ts).
// ============================================================================

import type { StateSnapshotRecord } from '../ports/index.ts';
import type { EntityCatalogContext, NarrativeEvent, WorldState } from '../types/index.js';
import { EventStore } from './event-store.ts';
import type { ReplayOptions, ReplaySource } from './replay.ts';
import { ReplayEngine } from './replay.ts';
import { SnapshotEngine } from './snapshot.ts';

export interface StateRecoveryInput {
  /** Immutable source events for the stream (canonical order is graph-derived). */
  readonly events: readonly NarrativeEvent[];
  /** Candidate durable snapshots; nearest valid wins, corrupt ones are quarantined. */
  readonly snapshots: readonly StateSnapshotRecord[];
  /** Canonical replay position to recover to (0 = baseline; clamped to event count). */
  readonly targetCount: number;
  readonly options?: ReplayOptions;
}

export interface StateRecoveryResult {
  readonly state: WorldState;
  /** How the state was produced: verified snapshot + suffix, or full replay. */
  readonly source: ReplaySource;
  /** Corrupt snapshot candidates excluded from hydration (quarantined). */
  readonly corrupt: readonly StateSnapshotRecord[];
}

export class StateManager {
  public eventStore: EventStore;
  public snapshotEngine: SnapshotEngine;
  public replayEngine: ReplayEngine;
  private replayDefaults: ReplayOptions;

  constructor(
    catalogContext: EntityCatalogContext,
    snapshotInterval = 20,
    replayDefaults?: ReplayOptions,
  ) {
    this.eventStore = new EventStore();
    this.snapshotEngine = new SnapshotEngine(snapshotInterval);
    this.replayEngine = new ReplayEngine(catalogContext);
    this.replayDefaults = replayDefaults ?? {};
  }

  /** Commit an event: write to event store, optionally create snapshot */
  commit(event: NarrativeEvent): void {
    this.eventStore.commit(event);
    if (this.snapshotEngine.shouldSnapshot(this.eventStore.count)) {
      const state = this.getCurrentState();
      this.snapshotEngine.createSnapshot(this.eventStore.count, event.id, state);
    }
  }

  /** Get current world state */
  getCurrentState(options?: ReplayOptions): WorldState {
    const merged: ReplayOptions = { ...this.replayDefaults, ...options };
    return this.replayEngine.replay(this.eventStore.getAll(), merged);
  }

  /** Get state at a specific DAG position (0 = baseline) */
  getStateAt(position: number, options?: ReplayOptions): WorldState {
    const merged: ReplayOptions = { ...this.replayDefaults, ...options };
    return this.replayEngine.getStateAt(this.eventStore.getAll(), position, merged);
  }

  /** Initialize with events (for testing or recovery) */
  initialize(events: NarrativeEvent[]): void {
    this.eventStore.load(events);
  }

  /**
   * Recovery path (plan 8.3): verified-snapshot-first via ReplayEngine.
   *
   * The nearest valid snapshot at or before `targetCount` is hydrated and the
   * canonical suffix applied; when no valid snapshot exists the state is
   * rebuilt by full replay from the immutable source. Corrupt snapshots are
   * quarantined in the result and never treated as an empty state. The event
   * store is loaded with the full source so subsequent commits/queries work.
   */
  recover(input: StateRecoveryInput): StateRecoveryResult {
    const merged: ReplayOptions = { ...this.replayDefaults, ...input.options };
    const result = this.replayEngine.replayFromNearest(
      input.snapshots,
      input.targetCount,
      [...input.events],
      merged,
    );
    this.eventStore.load([...input.events]);
    return result;
  }
}
