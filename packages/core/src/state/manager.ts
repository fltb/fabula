// ============================================================================
// StateManager — Coordinates EventStore + SnapshotEngine + ReplayEngine
// ============================================================================

import type { NarrativeEvent, WorldState, BranchPath } from '../types/index.js';
import { EventStore } from './event-store.ts';
import { SnapshotEngine } from './snapshot.ts';
import { ReplayEngine } from './replay.ts';

export class StateManager {
  public eventStore: EventStore;
  public snapshotEngine: SnapshotEngine;
  public replayEngine: ReplayEngine;

  constructor(snapshotsDir: string, snapshotInterval = 20) {
    this.eventStore = new EventStore();
    this.snapshotEngine = new SnapshotEngine(snapshotsDir, snapshotInterval);
    this.replayEngine = new ReplayEngine();
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
  getCurrentState(branchPath?: BranchPath): WorldState {
    return this.replayEngine.replay(this.eventStore.getAll(), branchPath);
  }

  /** Get state at a specific DAG position (by replaying that many events in causal order) */
  getStateAt(position: number, branchPath?: BranchPath): WorldState {
    return this.replayEngine.getStateAt(
      this.eventStore.getAll(),
      position,
      branchPath,
    );
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
