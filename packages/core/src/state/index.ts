// ============================================================================
// StateManager — Event Sourcing + Snapshot Engine + Replay Engine
// Core of the narrative state system. All world state is derived from events.
// ============================================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  NarrativeEvent,
  WorldState,
  Snapshot,
  BranchPath,
  Fact,
  EntityId,
} from '../types/index.js';
import {
  createEmptyBranchPath,
  includesPath,
  isLinearNarrative,
} from '../branch/index.js';

// ============================================================================
// EventStore — Append-only event log
// ============================================================================

export class EventStore {
  private events: NarrativeEvent[] = [];
  private eventsByOrder: Map<number, NarrativeEvent> = new Map();

  /** Append an event to the store */
  commit(event: NarrativeEvent): void {
    // Validate: no duplicate narrative orders
    if (this.eventsByOrder.has(event.narrativeOrder)) {
      throw new Error(
        `Event with narrativeOrder ${event.narrativeOrder} already exists: ${this.eventsByOrder.get(event.narrativeOrder)?.id}`,
      );
    }
    this.events.push(event);
    this.eventsByOrder.set(event.narrativeOrder, event);
  }

  /** Get all events sorted by narrative order */
  getAll(): NarrativeEvent[] {
    return [...this.events].sort((a, b) => a.narrativeOrder - b.narrativeOrder);
  }

  /** Get events in a range of narrative orders */
  getRange(fromOrder: number, toOrder: number): NarrativeEvent[] {
    return this.getAll().filter(
      (e) => e.narrativeOrder >= fromOrder && e.narrativeOrder <= toOrder,
    );
  }

  /** Get an event by ID */
  getById(id: string): NarrativeEvent | undefined {
    return this.events.find((e) => e.id === id);
  }

  /** Get the last committed narrative order */
  getLastOrder(): number {
    if (this.events.length === 0) return 0;
    return Math.max(...this.events.map((e) => e.narrativeOrder));
  }

  /** Get event count */
  get count(): number {
    return this.events.length;
  }

  /** Load events from an array (for testing/recovery) */
  load(events: NarrativeEvent[]): void {
    this.events = [...events];
    this.eventsByOrder.clear();
    for (const e of this.events) {
      this.eventsByOrder.set(e.narrativeOrder, e);
    }
  }

  /** Persist event log to disk as JSON lines */
  saveToDisk(dirPath: string): void {
    const filePath = path.join(dirPath, 'event_log.jsonl');
    const lines = this.getAll().map((e) => JSON.stringify(e));
    fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
  }

  /** Load event log from disk */
  loadFromDisk(dirPath: string): void {
    const filePath = path.join(dirPath, 'event_log.jsonl');
    if (!fs.existsSync(filePath)) return;

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    this.events = lines.map((line) => JSON.parse(line) as NarrativeEvent);
    this.eventsByOrder.clear();
    for (const e of this.events) {
      this.eventsByOrder.set(e.narrativeOrder, e);
    }
  }
}

// ============================================================================
// SnapshotEngine — Periodic state snapshots for fast recovery
// ============================================================================

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

// ============================================================================
// ReplayEngine — Replay events to reconstruct world state
// ============================================================================

export class ReplayEngine {
  /**
   * Replay events to build the current world state.
   * Optionally filter by branch path for branch-aware state.
   */
  replay(
    events: NarrativeEvent[],
    branchPath?: BranchPath,
  ): WorldState {
    const bp = branchPath ?? createEmptyBranchPath();
    const sorted = [...events].sort((a, b) => a.narrativeOrder - b.narrativeOrder);

    const state: WorldState = {
      entities: {},
      relationships: {},
      knowledge: {},
      threads: {},
      rules: {},
      facts: [],
    };

    for (const event of sorted) {
      // Branch filtering: skip events not on this path
      if (!includesPath(event.branchExistence, bp)) continue;

      // Apply postconditions to entities
      for (const fact of event.postconditions) {
        // Also filter facts by branch
        if (!includesPath(fact.validity.branches, bp)) continue;

        state.facts.push(fact);

        if (!state.entities[fact.entityId]) {
          state.entities[fact.entityId] = {};
        }
        state.entities[fact.entityId][fact.attribute] = fact.value;
      }

      // Apply preconditions (they become known facts about the entity too)
      for (const fact of event.preconditions) {
        if (!includesPath(fact.validity.branches, bp)) continue;
        if (!state.entities[fact.entityId]) {
          state.entities[fact.entityId] = {};
        }
        // Only set if not already set by a later postcondition
        if (!(fact.attribute in state.entities[fact.entityId])) {
          state.entities[fact.entityId][fact.attribute] = fact.value;
        }
      }

      // Update thread progress
      for (const tp of event.threadProgress) {
        state.threads[tp.thread] = {
          progress: tp.progressAfter,
          total: tp.progressTotal,
        };
      }

      // Update relationship state
      for (const re of event.relationshipEffects) {
        const relKey = [re.participants[0], re.participants[1]].sort().join('_');
        if (!state.relationships[relKey]) {
          state.relationships[relKey] = { direction: {} };
        }

        // Parse direction (e.g., "camille → npc_gear")
        const dirMatch = re.direction.match(/(\S+)\s*→\s*(\S+)/);
        if (dirMatch) {
          const from = dirMatch[1];
          if (!state.relationships[relKey].direction[from]) {
            state.relationships[relKey].direction[from] = { dimensions: {}, perceivedBy: {} };
          }
          if (re.newState) {
            const dirEntry = state.relationships[relKey].direction[from]!;
            if (re.newState.type !== undefined) {
              dirEntry.dimensions['type'] = re.newState.type;
            }
            if (re.newState.intensity !== undefined) {
              dirEntry.dimensions['intensity'] = re.newState.intensity;
            }
          }
        }
      }

      // Update knowledge (from postconditions that look like "entity.knows = X")
      for (const fact of event.postconditions) {
        if (fact.attribute === 'knows' || fact.attribute === 'knowledge') {
          if (!state.knowledge[fact.entityId]) {
            state.knowledge[fact.entityId] = { knownFacts: [] };
          }
          state.knowledge[fact.entityId].knownFacts.push(fact.id);
        }
      }

      // Update rule evidence
      for (const re of event.ruleEffects) {
        if (!state.rules[re.rule]) {
          state.rules[re.rule] = { activeEvidence: 0 };
        }
        if (re.effect === 'reinforce') {
          state.rules[re.rule].activeEvidence++;
        }
      }
    }

    return state;
  }

  /**
   * Get state at a specific narrative order (by replaying up to that point).
   */
  getStateAt(
    events: NarrativeEvent[],
    narrativeOrder: number,
    branchPath?: BranchPath,
  ): WorldState {
    const relevantEvents = events.filter(
      (e) => e.narrativeOrder <= narrativeOrder,
    );
    return this.replay(relevantEvents, branchPath);
  }

  /**
   * Optimized: use snapshot + incremental replay
   */
  getStateAtOptimized(
    events: NarrativeEvent[],
    narrativeOrder: number,
    snapshot: Snapshot | null,
    branchPath?: BranchPath,
  ): WorldState {
    const bp = branchPath ?? createEmptyBranchPath();

    if (!snapshot) {
      return this.getStateAt(events, narrativeOrder, bp);
    }

    // Start from snapshot state
    const state = JSON.parse(JSON.stringify(snapshot.state)) as WorldState;

    // Replay events after the snapshot
    const eventsAfter = events.filter(
      (e) =>
        e.narrativeOrder > snapshot.narrativeOrder &&
        e.narrativeOrder <= narrativeOrder,
    ).sort((a, b) => a.narrativeOrder - b.narrativeOrder);

    for (const event of eventsAfter) {
      if (!includesPath(event.branchExistence, bp)) continue;

      for (const fact of event.postconditions) {
        if (!includesPath(fact.validity.branches, bp)) continue;

        state.facts.push(fact);
        if (!state.entities[fact.entityId]) {
          state.entities[fact.entityId] = {};
        }
        state.entities[fact.entityId][fact.attribute] = fact.value;
      }

      for (const tp of event.threadProgress) {
        state.threads[tp.thread] = {
          progress: tp.progressAfter,
          total: tp.progressTotal,
        };
      }

      for (const re of event.ruleEffects) {
        if (!state.rules[re.rule]) {
          state.rules[re.rule] = { activeEvidence: 0 };
        }
        if (re.effect === 'reinforce') {
          state.rules[re.rule].activeEvidence++;
        }
      }
    }

    return state;
  }
}

// ============================================================================
// StateManager — Coordinates EventStore + SnapshotEngine + ReplayEngine
// ============================================================================

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

    if (this.snapshotEngine.shouldSnapshot(event.narrativeOrder)) {
      const state = this.getCurrentState();
      this.snapshotEngine.createSnapshot(event.narrativeOrder, event.id, state);
    }
  }

  /** Get current world state */
  getCurrentState(branchPath?: BranchPath): WorldState {
    return this.replayEngine.replay(this.eventStore.getAll(), branchPath);
  }

  /** Get state at a specific narrative order (optimized with snapshots) */
  getStateAt(narrativeOrder: number, branchPath?: BranchPath): WorldState {
    const snapshot = this.snapshotEngine.findNearest(narrativeOrder);
    return this.replayEngine.getStateAtOptimized(
      this.eventStore.getAll(),
      narrativeOrder,
      snapshot,
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
