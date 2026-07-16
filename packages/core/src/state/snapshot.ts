// ============================================================================
// SnapshotEngine — Periodic state snapshots for fast recovery
// ============================================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WorldState, Snapshot } from '../types/index.js';

export class SnapshotEngine {
  private snapshotInterval: number;
  private snapshotsDir: string;

  constructor(snapshotsDir: string, snapshotInterval = 20) {
    this.snapshotsDir = snapshotsDir;
    this.snapshotInterval = snapshotInterval;
    if (!fs.existsSync(snapshotsDir)) {
      fs.mkdirSync(snapshotsDir, { recursive: true });
    }
  }

  /** Determine if a snapshot should be created at this narrative order */
  shouldSnapshot(narrativeOrder: number): boolean {
    return narrativeOrder > 0 && narrativeOrder % this.snapshotInterval === 0;
  }

  /** Create a snapshot of the current world state */
  createSnapshot(narrativeOrder: number, eventId: string, state: WorldState): Snapshot {
    const snapshot: Snapshot = {
      narrativeOrder,
      eventId,
      timestamp: new Date().toISOString(),
      state: JSON.parse(JSON.stringify(state)), // deep clone
    };

    const filePath = path.join(this.snapshotsDir, `snapshot_${narrativeOrder}.json`);
    fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), 'utf-8');

    return snapshot;
  }

  /** Find the nearest snapshot at or before the given narrative order */
  findNearest(targetOrder: number): Snapshot | null {
    if (!fs.existsSync(this.snapshotsDir)) return null;

    const files = fs.readdirSync(this.snapshotsDir)
      .filter((f) => f.startsWith('snapshot_') && f.endsWith('.json'))
      .map((f) => {
        const match = f.match(/snapshot_(\d+)\.json/);
        return match ? parseInt(match[1], 10) : 0;
      })
      .filter((n) => n > 0 && n <= targetOrder)
      .sort((a, b) => b - a); // descending

    if (files.length === 0) return null;

    const nearest = files[0];
    const filePath = path.join(this.snapshotsDir, `snapshot_${nearest}.json`);
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Snapshot;
    } catch {
      return null;
    }
  }

  /** Invalidate snapshots at or after a given narrative order */
  invalidateFrom(narrativeOrder: number): void {
    if (!fs.existsSync(this.snapshotsDir)) return;

    const files = fs.readdirSync(this.snapshotsDir)
      .filter((f) => f.startsWith('snapshot_') && f.endsWith('.json'));

    for (const file of files) {
      const match = file.match(/snapshot_(\d+)\.json/);
      if (match) {
        const order = parseInt(match[1], 10);
        if (order >= narrativeOrder) {
          fs.unlinkSync(path.join(this.snapshotsDir, file));
        }
      }
    }
  }

  /** List all available snapshots */
  listSnapshots(): number[] {
    if (!fs.existsSync(this.snapshotsDir)) return [];

    return fs.readdirSync(this.snapshotsDir)
      .filter((f) => f.startsWith('snapshot_') && f.endsWith('.json'))
      .map((f) => {
        const match = f.match(/snapshot_(\d+)\.json/);
        return match ? parseInt(match[1], 10) : 0;
      })
      .filter((n) => n > 0)
      .sort((a, b) => a - b);
  }
}
