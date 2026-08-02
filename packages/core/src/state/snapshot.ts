// ============================================================================
// SnapshotEngine — Periodic state snapshots for fast recovery (pure in-memory)
//
// This engine keeps only snapshot *value* semantics: interval policy, deep
// clone serialization, nearest-snapshot selection and invalidation. It never
// touches the filesystem. Durable snapshots belong to the semantic
// StateSnapshotRepository port (see ports/state-repository.ts); Hosts write
// the Snapshot values produced here through that port and hydrate selection
// from `readNearestValid`.
// ============================================================================

import type { Snapshot, WorldState } from '../types/index.js';

export class SnapshotEngine {
  private snapshotInterval: number;
  private snapshots: Snapshot[] = [];

  constructor(
    snapshotInterval = 20,
    private readonly now: () => string = () => '1970-01-01T00:00:00.000Z',
  ) {
    this.snapshotInterval = snapshotInterval;
  }

  /** Determine if a snapshot should be created at this event count */
  shouldSnapshot(eventCount: number): boolean {
    return eventCount > 0 && eventCount % this.snapshotInterval === 0;
  }

  /** Create a snapshot of the current world state (pure value, no I/O) */
  createSnapshot(eventCount: number, eventId: string, state: WorldState): Snapshot {
    const snapshot: Snapshot = {
      version: 1,
      eventCount,
      eventId,
      timestamp: this.now(),
      state: JSON.parse(JSON.stringify(state)), // deep clone
    };
    this.snapshots.push(snapshot);
    return snapshot;
  }

  /** Find the nearest snapshot at or before the given event count */
  findNearest(targetCount: number): Snapshot | null {
    const nearest = this.snapshots
      .filter((snapshot) => snapshot.eventCount > 0 && snapshot.eventCount <= targetCount)
      .sort((a, b) => b.eventCount - a.eventCount)[0];
    return nearest ?? null;
  }

  /** Invalidate snapshots at or after a given event count */
  invalidateFrom(eventCount: number): void {
    this.snapshots = this.snapshots.filter(
      (snapshot) => snapshot.eventCount < eventCount,
    );
  }

  /** List all available snapshot event counts */
  listSnapshots(): number[] {
    return this.snapshots
      .map((snapshot) => snapshot.eventCount)
      .filter((n) => n > 0)
      .sort((a, b) => a - b);
  }
}
