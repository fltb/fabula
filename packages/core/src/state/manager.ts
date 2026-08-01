// ============================================================================
// StateManager — Coordinates EventStore + SnapshotEngine + ReplayEngine
// ============================================================================

import type { Storage } from '../storage/types.js';
import type { EntityCatalogContext, NarrativeEvent, WorldState } from '../types/index.js';
import { EventStore } from './event-store.ts';
import type { ReplayOptions } from './replay.ts';
import { ReplayEngine } from './replay.ts';
import { SnapshotEngine } from './snapshot.ts';

export class StateManager {
  public eventStore: EventStore;
  public snapshotEngine: SnapshotEngine;
  public replayEngine: ReplayEngine;
  private replayDefaults: ReplayOptions;

  constructor(
    snapshotsDir: string,
    catalogContext: EntityCatalogContext,
    snapshotInterval = 20,
    storage?: Storage,
    replayDefaults?: ReplayOptions,
  ) {
    this.eventStore = new EventStore(storage);
    this.snapshotEngine = new SnapshotEngine(snapshotsDir, snapshotInterval, storage);
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

  /** Persist everything to disk */
  saveToDisk(dirPath: string): void {
    this.eventStore.saveToDisk(dirPath);
  }

  /** Load everything from disk */
  loadFromDisk(dirPath: string): void {
    this.eventStore.loadFromDisk(dirPath);
  }
}
