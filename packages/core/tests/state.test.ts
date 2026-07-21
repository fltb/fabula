// ============================================================================
// StateManager — Unit Tests
// Tests EventStore, SnapshotEngine, ReplayEngine, and StateManager
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { NarrativeEvent, WorldState, BranchPath, Fact, Snapshot } from '../src/types/index.js';
import {
  EventStore,
  SnapshotEngine,
  ReplayEngine,
  StateManager,
} from '../src/state/index.js';
import { createEmptyBranchPath } from '../src/branch/index.js';

// ============================================================================
// Helpers — test event factories
// ============================================================================

let eventCounter = 0;

/** Create a simple timestamp for test events */
function makeTimestamp() {
  return { type: 'absolute' as const, value: '2025-01-01T00:00:00Z' };
}

/** Create a minimal Fact */
function makeFact(
  entityId: string,
  attribute: string,
  value: unknown,
  overrides: Partial<Fact> = {},
): Fact {
  return {
    id: `fact_${entityId}_${attribute}_${++eventCounter}`,
    entityId,
    attribute,
    value,
    validity: {
      temporal: { start: makeTimestamp(), end: null },
      branches: { type: 'all' },
    },
    ...overrides,
  };
}

/** Create a minimal NarrativeEvent */
function makeEvent(
  narrativeOrder: number,
  overrides: Partial<NarrativeEvent> = {},
): NarrativeEvent {
  const id = `evt_${narrativeOrder}_${++eventCounter}`;
  return {
    id,
    event: `event_${narrativeOrder}`,
    narrativeOrder,
    title: `Event ${narrativeOrder}`,
    storyTime: makeTimestamp(),
    sceneType: 'linear',
    pov: { character: 'camille', type: 'third_person_limited' },
    sceneBrief: `Scene brief for event ${narrativeOrder}`,
    preconditions: [],
    postconditions: [],
    threadProgress: [],
    foreshadowing: [],
    relationshipEffects: [],
    ruleEffects: [],
    source: 'genesis',
    branchExistence: { type: 'all' },
    participants: { entities: [] },
    ...overrides,
  };
}

// ============================================================================
// EventStore Tests
// ============================================================================

describe('EventStore', () => {
  let store: EventStore;

  beforeEach(() => {
    store = new EventStore();
  });

  describe('commit()', () => {
    it('should add events to the store', () => {
      const e1 = makeEvent(1);
      const e2 = makeEvent(2);

      store.commit(e1);
      store.commit(e2);

      expect(store.count).toBe(2);
      expect(store.getAll()).toHaveLength(2);
    });

    it('should throw on duplicate narrativeOrder', () => {
      const e1 = makeEvent(5);
      store.commit(e1);

      const e2 = makeEvent(5, { id: 'dup_id' });
      expect(() => store.commit(e2)).toThrow(
        'Event with narrativeOrder 5 already exists',
      );
    });

    it('should allow events with different narrative orders', () => {
      store.commit(makeEvent(10));
      store.commit(makeEvent(20));
      store.commit(makeEvent(30));
      expect(store.count).toBe(3);
    });
  });

  describe('getAll()', () => {
    it('should return events sorted by narrativeOrder', () => {
      store.commit(makeEvent(3));
      store.commit(makeEvent(1));
      store.commit(makeEvent(2));

      const events = store.getAll();
      expect(events.map((e) => e.narrativeOrder)).toEqual([1, 2, 3]);
    });

    it('should return a copy, not the internal array', () => {
      store.commit(makeEvent(1));
      const events = store.getAll();
      events.push(makeEvent(999));
      expect(store.count).toBe(1);
    });

    it('should return empty array when no events exist', () => {
      expect(store.getAll()).toEqual([]);
    });
  });

  describe('getRange()', () => {
    it('should return events within the specified range', () => {
      store.commit(makeEvent(1));
      store.commit(makeEvent(2));
      store.commit(makeEvent(3));
      store.commit(makeEvent(4));
      store.commit(makeEvent(5));

      const range = store.getRange(2, 4);
      expect(range.map((e) => e.narrativeOrder)).toEqual([2, 3, 4]);
    });

    it('should return empty array when no events match range', () => {
      store.commit(makeEvent(10));
      store.commit(makeEvent(20));

      expect(store.getRange(1, 5)).toEqual([]);
    });

    it('should handle single-order range', () => {
      store.commit(makeEvent(42));
      expect(store.getRange(42, 42)).toHaveLength(1);
    });
  });

  describe('getById()', () => {
    it('should find an event by its ID', () => {
      const e1 = makeEvent(1);
      store.commit(e1);

      const found = store.getById(e1.id);
      expect(found).toBeDefined();
      expect(found!.id).toBe(e1.id);
    });

    it('should return undefined for missing ID', () => {
      store.commit(makeEvent(1));
      expect(store.getById('nonexistent')).toBeUndefined();
    });

    it('should return the correct event among many', () => {
      const events = [makeEvent(1), makeEvent(2), makeEvent(3)];
      events.forEach((e) => store.commit(e));

      const found = store.getById(events[1].id);
      expect(found!.narrativeOrder).toBe(2);
    });
  });

  describe('getLastOrder()', () => {
    it('should return the highest narrative order', () => {
      store.commit(makeEvent(10));
      store.commit(makeEvent(50));
      store.commit(makeEvent(25));

      expect(store.getLastOrder()).toBe(50);
    });

    it('should return 0 when no events exist', () => {
      expect(store.getLastOrder()).toBe(0);
    });

    it('should work with a single event', () => {
      store.commit(makeEvent(7));
      expect(store.getLastOrder()).toBe(7);
    });
  });

  describe('count', () => {
    it('should return the number of events', () => {
      expect(store.count).toBe(0);
      store.commit(makeEvent(1));
      expect(store.count).toBe(1);
      store.commit(makeEvent(2));
      store.commit(makeEvent(3));
      expect(store.count).toBe(3);
    });
  });

  describe('saveToDisk() / loadFromDisk()', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evtstore-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should round-trip events correctly', () => {
      const e1 = makeEvent(1, {
        title: 'First',
        sceneBrief: 'Brief one',
      });
      const e2 = makeEvent(2, {
        title: 'Second',
        sceneBrief: 'Brief two',
      });
      store.commit(e1);
      store.commit(e2);

      store.saveToDisk(tmpDir);

      const loadedStore = new EventStore();
      loadedStore.loadFromDisk(tmpDir);

      expect(loadedStore.count).toBe(2);
      expect(loadedStore.getAll().map((e) => e.narrativeOrder)).toEqual([1, 2]);
      expect(loadedStore.getById(e1.id)?.title).toBe('First');
      expect(loadedStore.getById(e2.id)?.sceneBrief).toBe('Brief two');
    });

    it('should handle empty event log', () => {
      store.saveToDisk(tmpDir);

      const loadedStore = new EventStore();
      loadedStore.loadFromDisk(tmpDir);

      expect(loadedStore.count).toBe(0);
    });

    it('should preserve event ordering after load', () => {
      store.commit(makeEvent(3));
      store.commit(makeEvent(1));
      store.commit(makeEvent(2));
      store.saveToDisk(tmpDir);

      const loadedStore = new EventStore();
      loadedStore.loadFromDisk(tmpDir);

      const orders = loadedStore.getAll().map((e) => e.narrativeOrder);
      expect(orders).toEqual([1, 2, 3]);
    });

    it('should not throw when loading from non-existent directory', () => {
      const loadedStore = new EventStore();
      loadedStore.loadFromDisk('/nonexistent/path');
      expect(loadedStore.count).toBe(0);
    });
  });
});

// ============================================================================
// SnapshotEngine Tests
// ============================================================================

describe('SnapshotEngine', () => {
  let tmpDir: string;
  let engine: SnapshotEngine;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-test-'));
    engine = new SnapshotEngine(tmpDir, 20);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('should create the snapshots directory', () => {
      expect(fs.existsSync(tmpDir)).toBe(true);
    });
  });

  describe('shouldSnapshot()', () => {
    it('should return true at the configured interval', () => {
      expect(engine.shouldSnapshot(20)).toBe(true);
      expect(engine.shouldSnapshot(40)).toBe(true);
      expect(engine.shouldSnapshot(60)).toBe(true);
    });

    it('should return false for order 0', () => {
      expect(engine.shouldSnapshot(0)).toBe(false);
    });

    it('should return false when not at interval', () => {
      expect(engine.shouldSnapshot(1)).toBe(false);
      expect(engine.shouldSnapshot(19)).toBe(false);
      expect(engine.shouldSnapshot(21)).toBe(false);
      expect(engine.shouldSnapshot(39)).toBe(false);
    });

    it('should work with custom interval', () => {
      const custom = new SnapshotEngine(tmpDir, 5);
      expect(custom.shouldSnapshot(5)).toBe(true);
      expect(custom.shouldSnapshot(10)).toBe(true);
      expect(custom.shouldSnapshot(7)).toBe(false);
    });
  });

  describe('createSnapshot()', () => {
    it('should write a snapshot file to disk', () => {
      const state: WorldState = {
        entities: { camille: { age: 25 } },
        relationships: {},
        knowledge: {},
        threads: { main: { threadId: 'main', status: 'active', currentRunId: 'legacy-main', phase: '', bindings: {}, goalStates: { progress: 'active' }, milestoneStates: {}, semanticStateHash: 'h0' } },
        rules: {},
        facts: [],
      };

      const snapshot = engine.createSnapshot(20, 'evt_test', state);

      expect(snapshot.narrativeOrder).toBe(20);
      expect(snapshot.eventId).toBe('evt_test');
      expect(snapshot.state).toEqual(state);
      expect(snapshot.timestamp).toBeDefined();

      // Verify file exists
      const filePath = path.join(tmpDir, 'snapshot_20.json');
      expect(fs.existsSync(filePath)).toBe(true);

      // Verify file content
      const loaded = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(loaded.narrativeOrder).toBe(20);
    });

    it('should deep-clone the state', () => {
      const state: WorldState = {
        entities: { camille: { age: 25, name: 'Camille' } },
        relationships: {},
        knowledge: {},
        threads: {},
        rules: {},
        facts: [],
      };

      const snapshot = engine.createSnapshot(20, 'evt_test', state);
      state.entities.camille.age = 99; // mutate original

      expect(snapshot.state.entities.camille.age).toBe(25);
    });

    it('should create snapshots at multiple orders', () => {
      const state: WorldState = {
        entities: {},
        relationships: {},
        knowledge: {},
        threads: {},
        rules: {},
        facts: [],
      };

      engine.createSnapshot(20, 'evt_20', state);
      engine.createSnapshot(40, 'evt_40', state);

      expect(fs.existsSync(path.join(tmpDir, 'snapshot_20.json'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'snapshot_40.json'))).toBe(true);
    });
  });

  describe('findNearest()', () => {
    it('should find the nearest snapshot at or before a target order', () => {
      const state: WorldState = {
        entities: {},
        relationships: {},
        knowledge: {},
        threads: {},
        rules: {},
        facts: [],
      };

      engine.createSnapshot(20, 'evt_20', state);
      engine.createSnapshot(40, 'evt_40', state);
      engine.createSnapshot(60, 'evt_60', state);

      const found = engine.findNearest(55);
      expect(found).not.toBeNull();
      expect(found!.narrativeOrder).toBe(40);

      const exact = engine.findNearest(40);
      expect(exact!.narrativeOrder).toBe(40);
    });

    it('should return the exact snapshot when target matches', () => {
      const state: WorldState = {
        entities: {},
        relationships: {},
        knowledge: {},
        threads: {},
        rules: {},
        facts: [],
      };

      engine.createSnapshot(20, 'evt_20', state);

      const found = engine.findNearest(20);
      expect(found!.narrativeOrder).toBe(20);
    });

    it('should return null when no snapshots exist', () => {
      expect(engine.findNearest(100)).toBeNull();
    });

    it('should return null when all snapshots are after the target', () => {
      const state: WorldState = {
        entities: {},
        relationships: {},
        knowledge: {},
        threads: {},
        rules: {},
        facts: [],
      };

      engine.createSnapshot(50, 'evt_50', state);

      expect(engine.findNearest(30)).toBeNull();
    });

    it('should return the most recent snapshot when target is large', () => {
      const state: WorldState = {
        entities: {},
        relationships: {},
        knowledge: {},
        threads: {},
        rules: {},
        facts: [],
      };

      engine.createSnapshot(20, 'evt_20', state);
      engine.createSnapshot(40, 'evt_40', state);

      const found = engine.findNearest(999);
      expect(found!.narrativeOrder).toBe(40);
    });
  });

  describe('invalidateFrom()', () => {
    it('should remove snapshots at or after the given order', () => {
      const state: WorldState = {
        entities: {},
        relationships: {},
        knowledge: {},
        threads: {},
        rules: {},
        facts: [],
      };

      engine.createSnapshot(20, 'evt_20', state);
      engine.createSnapshot(30, 'evt_30', state);
      engine.createSnapshot(40, 'evt_40', state);
      engine.createSnapshot(50, 'evt_50', state);

      engine.invalidateFrom(30);

      expect(fs.existsSync(path.join(tmpDir, 'snapshot_20.json'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'snapshot_30.json'))).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, 'snapshot_40.json'))).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, 'snapshot_50.json'))).toBe(false);
    });

    it('should remove nothing when order is above all snapshots', () => {
      const state: WorldState = {
        entities: {},
        relationships: {},
        knowledge: {},
        threads: {},
        rules: {},
        facts: [],
      };

      engine.createSnapshot(20, 'evt_20', state);

      engine.invalidateFrom(100);

      expect(fs.existsSync(path.join(tmpDir, 'snapshot_20.json'))).toBe(true);
    });

    it('should remove all snapshots when order is 0', () => {
      const state: WorldState = {
        entities: {},
        relationships: {},
        knowledge: {},
        threads: {},
        rules: {},
        facts: [],
      };

      engine.createSnapshot(20, 'evt_20', state);
      engine.createSnapshot(40, 'evt_40', state);

      engine.invalidateFrom(0);

      expect(fs.existsSync(path.join(tmpDir, 'snapshot_20.json'))).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, 'snapshot_40.json'))).toBe(false);
    });

    it('should not throw when no snapshots exist', () => {
      expect(() => engine.invalidateFrom(10)).not.toThrow();
    });
  });

  describe('listSnapshots()', () => {
    it('should return empty array when no snapshots exist', () => {
      expect(engine.listSnapshots()).toEqual([]);
    });

    it('should return sorted snapshot orders', () => {
      const state: WorldState = {
        entities: {},
        relationships: {},
        knowledge: {},
        threads: {},
        rules: {},
        facts: [],
      };

      engine.createSnapshot(50, 'evt_50', state);
      engine.createSnapshot(10, 'evt_10', state);
      engine.createSnapshot(30, 'evt_30', state);

      expect(engine.listSnapshots()).toEqual([10, 30, 50]);
    });

    it('should exclude non-snapshot files', () => {
      const state: WorldState = {
        entities: {},
        relationships: {},
        knowledge: {},
        threads: {},
        rules: {},
        facts: [],
      };

      fs.writeFileSync(path.join(tmpDir, 'random.json'), '{}');
      engine.createSnapshot(20, 'evt_20', state);

      expect(engine.listSnapshots()).toEqual([20]);
    });
  });
});

// ============================================================================
// ReplayEngine Tests
// ============================================================================

describe('ReplayEngine', () => {
  let engine: ReplayEngine;

  beforeEach(() => {
    engine = new ReplayEngine();
  });

  describe('replay()', () => {
    it('should return an empty world state for no events', () => {
      const state = engine.replay([]);
      expect(state).toEqual({
        entities: {},
        relationships: {},
        knowledge: {},
        threads: {},
        rules: {},
        facts: [],
      });
    });

    it('should apply postconditions to build world state', () => {
      const events: NarrativeEvent[] = [
        makeEvent(1, {
          postconditions: [
            makeFact('camille', 'age', 25),
            makeFact('camille', 'location', 'village'),
          ],
        }),
        makeEvent(2, {
          postconditions: [
            makeFact('camille', 'age', 26),
            makeFact('npc_gear', 'status', 'broken'),
          ],
        }),
      ];

      const state = engine.replay(events);

      expect(state.entities.camille).toEqual({
        lifecycle: 'active',
        age: 26,
        location: 'village',
      });
      expect(state.entities.npc_gear).toEqual({
        lifecycle: 'active',
        status: 'broken',
      });
    });

    it('should update thread progress', () => {
      const events: NarrativeEvent[] = [
        makeEvent(1, {
          threadProgress: [
            { thread: 'mystery', advancement: 'Discovered clue', progressAfter: 1, progressTotal: 10 },
            { thread: 'romance', advancement: 'Met love interest', progressAfter: 1, progressTotal: 5 },
          ],
        }),
        makeEvent(2, {
          threadProgress: [
            { thread: 'mystery', advancement: 'Found evidence', progressAfter: 3, progressTotal: 10 },
          ],
        }),
      ];

      const state = engine.replay(events);

      expect(state.threads.mystery).toBeDefined();
      expect(state.threads.mystery!.status).toBe('active');
      expect(state.threads.mystery!.goalStates.progress).toBe('active');
      expect(state.threads.romance).toBeDefined();
      expect(state.threads.romance!.status).toBe('active');
      expect(state.threads.romance!.goalStates.progress).toBe('active');
    });

    it('should update relationship state', () => {
      const events: NarrativeEvent[] = [
        makeEvent(1, {
          relationshipEffects: [
            {
              effectId: 'evt1_rel_0',
              relationshipId: 'rel_camille_npc_gear',
              epochId: 'epoch_1',
              lifecycleAfter: 'active',
              membershipAfter: [
                { membershipId: 'mem_camille_1', entityId: 'camille', role: 'member' },
                { membershipId: 'mem_npc_gear_1', entityId: 'npc_gear', role: 'member' },
              ],
              dimensionSet: [
                { dimensionId: 'direction', scope: 'global', value: 'camille → npc_gear' },
                { dimensionId: 'type', scope: 'global', value: 'friend' },
                { dimensionId: 'intensity', scope: 'global', value: 3 },
              ],
              provenance: 'test:establish',
            },
          ],
        }),
        makeEvent(2, {
          relationshipEffects: [
            {
              effectId: 'evt2_rel_0',
              relationshipId: 'rel_camille_npc_gear',
              epochId: 'epoch_1',
              lifecycleAfter: 'active',
              membershipAfter: [
                { membershipId: 'mem_camille_2', entityId: 'camille', role: 'member' },
                { membershipId: 'mem_npc_gear_2', entityId: 'npc_gear', role: 'member' },
              ],
              dimensionSet: [
                { dimensionId: 'direction', scope: 'global', value: 'camille → npc_gear' },
                { dimensionId: 'type', scope: 'global', value: 'friend' },
                { dimensionId: 'intensity', scope: 'global', value: 5 },
              ],
              provenance: 'test:change',
            },
          ],
        }),
      ];

      const state = engine.replay(events);

      const relKey = 'rel_camille_npc_gear';
      expect(state.relationships[relKey]).toBeDefined();
      const relState = state.relationships[relKey];
      const activeEpoch = relState.epochs[relState.activeEpochId!];
      expect(activeEpoch.dimensions['global::type'].value).toBe('friend');
      expect(activeEpoch.dimensions['global::intensity'].value).toBe(5);
    });

    it('should update knowledge state from postconditions with knows/knowledge attribute', () => {
      const events: NarrativeEvent[] = [
        makeEvent(1, {
          postconditions: [
            makeFact('camille', 'knows', 'camille_is_hero'),
            makeFact('camille', 'knowledge', 'camille_is_chosen'),
          ],
        }),
      ];

      const state = engine.replay(events);

      expect(state.knowledge.camille).toBeDefined();
      expect(state.knowledge.camille.knownFacts).toEqual([]);
    });

    it('should handle rule effects', () => {
      const events: NarrativeEvent[] = [
        makeEvent(1, {
          ruleEffects: [
            { rule: 'magic_conservation', effect: 'reinforce', evidence: 'Magic is limited' },
          ],
        }),
        makeEvent(2, {
          ruleEffects: [
            { rule: 'magic_conservation', effect: 'reinforce', evidence: 'Casting costs energy' },
          ],
        }),
      ];

      const state = engine.replay(events);

      expect(state.rules.magic_conservation).toEqual({ activeEvidence: 2, nullified: false, exceptions: [] });
    });

    it('rejects preconditions that have no deterministic provider', () => {
      const events: NarrativeEvent[] = [
        makeEvent(1, {
          preconditions: [makeFact('camille', 'age', 24)],
          postconditions: [makeFact('camille', 'age', 25)],
        }),
      ];

      expect(() => engine.replay(events)).toThrow('No earlier provider');
    });

    it('should handle branch filtering — skip events not on current path', () => {
      const branchPath: BranchPath = {
        decisions: [
          { atEventId: 'evt_choice', choiceId: 'path_a', narrativeOrder: 2 },
        ],
      };

      const pathAEvent = makeEvent(3, {
        title: 'Path A event',
        branchExistence: {
          type: 'paths',
          paths: [
            {
              decisions: [
                { atEventId: 'evt_choice', choiceId: 'path_a', narrativeOrder: 2 },
              ],
            },
          ],
        },
        postconditions: [makeFact('camille', 'path', 'A')],
      });

      const pathBEvent = makeEvent(4, {
        title: 'Path B event',
        branchExistence: {
          type: 'paths',
          paths: [
            {
              decisions: [
                { atEventId: 'evt_choice', choiceId: 'path_b', narrativeOrder: 2 },
              ],
            },
          ],
        },
        postconditions: [makeFact('camille', 'path', 'B')],
      });

      const events = [
        makeEvent(1, { postconditions: [makeFact('camille', 'name', 'Camille')] }),
        makeEvent(2, { title: 'Choice point' }),
        pathAEvent,
        pathBEvent,
      ];

      const state = engine.replay(events, branchPath);

      expect(state.entities.camille.name).toBe('Camille');
      expect(state.entities.camille.path).toBe('A');
      expect(state.entities.camille).not.toHaveProperty('path_B');
    });

    it('should filter facts by branch validity', () => {
      const branchPath: BranchPath = {
        decisions: [
          { atEventId: 'evt_choice', choiceId: 'path_a', narrativeOrder: 2 },
        ],
      };

      const events: NarrativeEvent[] = [
        makeEvent(1, {
          postconditions: [
            makeFact('camille', 'location', 'village', {
              validity: {
                temporal: { start: makeTimestamp(), end: null },
                branches: {
                  type: 'paths',
                  paths: [
                    {
                      decisions: [
                        { atEventId: 'evt_choice', choiceId: 'path_a', narrativeOrder: 2 },
                      ],
                    },
                  ],
                },
              },
            }),
            makeFact('camille', 'location', 'forest', {
              validity: {
                temporal: { start: makeTimestamp(), end: null },
                branches: {
                  type: 'paths',
                  paths: [
                    {
                      decisions: [
                        { atEventId: 'evt_choice', choiceId: 'path_b', narrativeOrder: 2 },
                      ],
                    },
                  ],
                },
              },
            }),
          ],
        }),
      ];

      const state = engine.replay(events, branchPath);

      // Only the fact scoped to 'path_a' should be applied
      expect(state.entities.camille.location).toBe('village');
    });
  });

  describe('getStateAt()', () => {
    it('should return state at a specific narrative order', () => {
      const events: NarrativeEvent[] = [
        makeEvent(1, { postconditions: [makeFact('camille', 'age', 25)] }),
        makeEvent(2, { postconditions: [makeFact('camille', 'age', 26)] }),
        makeEvent(3, { postconditions: [makeFact('camille', 'age', 27)] }),
      ];

      const stateAt2 = engine.getStateAt(events, 2);
      expect(stateAt2.entities.camille.age).toBe(26);

      const stateAt1 = engine.getStateAt(events, 1);
      expect(stateAt1.entities.camille.age).toBe(25);
    });

    it('should return empty state when order is 0', () => {
      const events: NarrativeEvent[] = [
        makeEvent(1, { postconditions: [makeFact('camille', 'age', 25)] }),
      ];

      const state = engine.getStateAt(events, 0);
      expect(state.entities).toEqual({});
    });

    it('should return full state when order exceeds all events', () => {
      const events: NarrativeEvent[] = [
        makeEvent(1, { postconditions: [makeFact('camille', 'age', 25)] }),
      ];

      const state = engine.getStateAt(events, 999);
      expect(state.entities.camille.age).toBe(25);
    });

    it('should accept an optional branchPath', () => {
      const branchPath: BranchPath = {
        decisions: [
          { atEventId: 'evt_choice', choiceId: 'path_a', narrativeOrder: 2 },
        ],
      };

      const events: NarrativeEvent[] = [
        makeEvent(1, { postconditions: [makeFact('camille', 'name', 'Camille')] }),
        makeEvent(2, { title: 'Choice' }),
        makeEvent(3, {
          branchExistence: {
            type: 'paths',
            paths: [
              {
                decisions: [
                  { atEventId: 'evt_choice', choiceId: 'path_a', narrativeOrder: 2 },
                ],
              },
            ],
          },
          postconditions: [makeFact('camille', 'fate', 'hero')],
        }),
      ];

      const stateWithoutBranch = engine.getStateAt(events, 3);
      expect(stateWithoutBranch.entities.camille.fate).toBeUndefined();

      const stateWithBranch = engine.getStateAt(events, 3, branchPath);
      expect(stateWithBranch.entities.camille.fate).toBe('hero');
    });
  });

  describe('getStateAtOptimized()', () => {
    it('should fall back to getStateAt when snapshot is null', () => {
      const events: NarrativeEvent[] = [
        makeEvent(1, { postconditions: [makeFact('camille', 'age', 25)] }),
        makeEvent(2, { postconditions: [makeFact('camille', 'age', 26)] }),
      ];

      const state = engine.getStateAtOptimized(events, 2, null);
      expect(state.entities.camille.age).toBe(26);
    });

    it('should start from snapshot state and replay only events after', () => {
      const snapshotState: WorldState = {
        entities: { camille: { age: 25, name: 'Camille' } },
        relationships: {},
        knowledge: {},
        threads: {},
        rules: {},
        facts: [],
      };

      const snapshot: Snapshot = {
        narrativeOrder: 10,
        eventId: 'evt_10',
        timestamp: new Date().toISOString(),
        state: snapshotState,
      };

      const events: NarrativeEvent[] = [
        makeEvent(1, { postconditions: [makeFact('camille', 'age', 20)] }),
        makeEvent(10, { postconditions: [makeFact('camille', 'age', 25)] }),
        makeEvent(15, {
          postconditions: [makeFact('camille', 'age', 30)],
        }),
        makeEvent(20, { postconditions: [makeFact('camille', 'age', 35)] }),
      ];

      const state = engine.getStateAtOptimized(events, 15, snapshot);

      expect(state.entities.camille.age).toBe(30);
    });

    it('should apply branch filtering after snapshot', () => {
      const snapshotState: WorldState = {
        entities: { camille: { name: 'Camille' } },
        relationships: {},
        knowledge: {},
        threads: {},
        rules: {},
        facts: [],
      };

      const snapshot: Snapshot = {
        narrativeOrder: 10,
        eventId: 'evt_10',
        timestamp: new Date().toISOString(),
        state: snapshotState,
      };

      const branchPath: BranchPath = {
        decisions: [
          { atEventId: 'evt_choice', choiceId: 'path_a', narrativeOrder: 5 },
        ],
      };

      const events: NarrativeEvent[] = [
        makeEvent(5, { title: 'Choice' }),
        makeEvent(11, {
          branchExistence: {
            type: 'paths',
            paths: [
              {
                decisions: [
                  { atEventId: 'evt_choice', choiceId: 'path_a', narrativeOrder: 5 },
                ],
              },
            ],
          },
          postconditions: [makeFact('camille', 'fate', 'hero')],
        }),
        makeEvent(12, {
          branchExistence: {
            type: 'paths',
            paths: [
              {
                decisions: [
                  { atEventId: 'evt_choice', choiceId: 'path_b', narrativeOrder: 5 },
                ],
              },
            ],
          },
          postconditions: [makeFact('camille', 'fate', 'villain')],
        }),
      ];

      const state = engine.getStateAtOptimized(events, 12, snapshot, branchPath);

      expect(state.entities.camille.fate).toBe('hero');
    });

    it('should produce same result as getStateAt', () => {
      const events: NarrativeEvent[] = [
        makeEvent(1, { postconditions: [makeFact('camille', 'age', 20)] }),
        makeEvent(5, { postconditions: [makeFact('camille', 'location', 'village')] }),
        makeEvent(10, {
          postconditions: [makeFact('camille', 'age', 25)],
          threadProgress: [
            { thread: 'main', advancement: 'Step', progressAfter: 2, progressTotal: 10 },
          ],
        }),
        makeEvent(15, { postconditions: [makeFact('camille', 'location', 'city')] }),
        makeEvent(20, { postconditions: [makeFact('camille', 'age', 30)] }),
      ];

      const snapshotState = engine.getStateAt(events, 10);
      const snapshot: Snapshot = {
        narrativeOrder: 10,
        eventId: 'evt_10',
        timestamp: new Date().toISOString(),
        state: snapshotState,
      };

      const direct = engine.getStateAt(events, 15);
      const optimized = engine.getStateAtOptimized(events, 15, snapshot);

      expect(optimized).toEqual(direct);
    });
  });
});

// ============================================================================
// StateManager Tests
// ============================================================================

describe('StateManager', () => {
  let tmpDir: string;
  let manager: StateManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-test-'));
    manager = new StateManager(tmpDir, 20);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('should initialize with empty event store', () => {
      expect(manager.eventStore.count).toBe(0);
    });

    it('should initialize all engines', () => {
      expect(manager.eventStore).toBeInstanceOf(EventStore);
      expect(manager.snapshotEngine).toBeInstanceOf(SnapshotEngine);
      expect(manager.replayEngine).toBeInstanceOf(ReplayEngine);
    });
  });

  describe('commit()', () => {
    it('should add an event to the event store', () => {
      const event = makeEvent(1, {
        postconditions: [makeFact('camille', 'age', 25)],
      });

      manager.commit(event);

      expect(manager.eventStore.count).toBe(1);
      expect(manager.eventStore.getById(event.id)).toBeDefined();
    });

    it('should create a snapshot when at snapshot interval', () => {
      const event = makeEvent(20, {
        postconditions: [makeFact('camille', 'age', 25)],
      });

      manager.commit(event);

      const snapshots = manager.snapshotEngine.listSnapshots();
      expect(snapshots).toContain(20);
    });

    it('should not create a snapshot when not at interval', () => {
      const event = makeEvent(19, {
        postconditions: [makeFact('camille', 'age', 25)],
      });

      manager.commit(event);

      expect(manager.snapshotEngine.listSnapshots()).toEqual([]);
    });

    it('should create snapshots at every interval point', () => {
      for (let i = 1; i <= 60; i++) {
        manager.commit(makeEvent(i));
      }

      const snapshots = manager.snapshotEngine.listSnapshots();
      expect(snapshots).toEqual([20, 40, 60]);
    });

    it('should throw on duplicate narrative order', () => {
      manager.commit(makeEvent(1));
      expect(() => manager.commit(makeEvent(1))).toThrow();
    });
  });

  describe('getCurrentState()', () => {
    it('should return empty state when no events exist', () => {
      const state = manager.getCurrentState();
      expect(state).toEqual({
        entities: {},
        relationships: {},
        knowledge: {},
        threads: {},
        rules: {},
        facts: [],
      });
    });

    it('should return the full world state from all events', () => {
      manager.commit(makeEvent(1, {
        postconditions: [makeFact('camille', 'age', 25)],
        threadProgress: [
          { thread: 'main', advancement: 'Start', progressAfter: 1, progressTotal: 10 },
        ],
      }));
      manager.commit(makeEvent(2, {
        postconditions: [makeFact('camille', 'age', 26)],
      }));

      const state = manager.getCurrentState();

      expect(state.entities.camille.age).toBe(26);
      expect(state.threads.main).toBeDefined();
      expect(state.threads.main!.status).toBe('active');
      expect(state.threads.main!.goalStates.progress).toBe('active');
    });

    it('should honor branch path filtering', () => {
      const branchPath: BranchPath = {
        decisions: [
          { atEventId: 'evt_choice', choiceId: 'path_a', narrativeOrder: 2 },
        ],
      };

      manager.commit(makeEvent(1, {
        postconditions: [makeFact('camille', 'name', 'Camille')],
      }));
      manager.commit(makeEvent(2, { title: 'Choice point' }));
      manager.commit(makeEvent(3, {
        branchExistence: {
          type: 'paths',
          paths: [
            {
              decisions: [
                { atEventId: 'evt_choice', choiceId: 'path_a', narrativeOrder: 2 },
              ],
            },
          ],
        },
        postconditions: [makeFact('camille', 'path', 'A')],
      }));
      manager.commit(makeEvent(4, {
        branchExistence: {
          type: 'paths',
          paths: [
            {
              decisions: [
                { atEventId: 'evt_choice', choiceId: 'path_b', narrativeOrder: 2 },
              ],
            },
          ],
        },
        postconditions: [makeFact('camille', 'path', 'B')],
      }));

      const state = manager.getCurrentState(branchPath);
      expect(state.entities.camille.path).toBe('A');
    });
  });

  describe('getStateAt()', () => {
    it('should return state at a specific narrative order', () => {
      for (let i = 1; i <= 5; i++) {
        manager.commit(makeEvent(i, {
          postconditions: [makeFact('camille', 'age', 20 + i)],
        }));
      }

      const stateAt3 = manager.getStateAt(3);
      expect(stateAt3.entities.camille.age).toBe(23);

      const stateAt5 = manager.getStateAt(5);
      expect(stateAt5.entities.camille.age).toBe(25);
    });

    it('should use snapshots when available for optimization', () => {
      // Commit events that create a snapshot at 20
      for (let i = 1; i <= 25; i++) {
        manager.commit(makeEvent(i, {
          postconditions: [makeFact('camille', 'value', i)],
        }));
      }

      const state = manager.getStateAt(25);
      expect(state.entities.camille.value).toBe(25);

      // Verify snapshots were created
      expect(manager.snapshotEngine.listSnapshots()).toContain(20);
    });

    it('should return empty state when order is before all events', () => {
      manager.commit(makeEvent(10, {
        postconditions: [makeFact('camille', 'age', 30)],
      }));

      const state = manager.getStateAt(5);
      expect(state.entities).toEqual({});
    });
  });

  describe('initialize()', () => {
    it('should load events for testing/recovery', () => {
      const events = [
        makeEvent(1, { postconditions: [makeFact('camille', 'age', 25)] }),
        makeEvent(2, { postconditions: [makeFact('camille', 'age', 26)] }),
        makeEvent(3, { postconditions: [makeFact('camille', 'age', 27)] }),
      ];

      manager.initialize(events);

      expect(manager.eventStore.count).toBe(3);
      expect(manager.eventStore.getLastOrder()).toBe(3);
    });

    it('should replace existing events', () => {
      manager.commit(makeEvent(1));
      expect(manager.eventStore.count).toBe(1);

      manager.initialize([]);

      expect(manager.eventStore.count).toBe(0);
    });

    it('should allow getCurrentState after initialize', () => {
      const events = [
        makeEvent(1, { postconditions: [makeFact('camille', 'age', 25)] }),
      ];

      manager.initialize(events);

      const state = manager.getCurrentState();
      expect(state.entities.camille.age).toBe(25);
    });
  });

  describe('saveToDisk() / loadFromDisk()', () => {
    it('should persist and reload events', () => {
      manager.commit(makeEvent(1, {
        title: 'Event One',
        postconditions: [makeFact('camille', 'age', 25)],
      }));
      manager.commit(makeEvent(2, {
        title: 'Event Two',
        postconditions: [makeFact('camille', 'age', 26)],
      }));

      manager.saveToDisk(tmpDir);

      const manager2 = new StateManager(tmpDir, 20);
      manager2.loadFromDisk(tmpDir);

      expect(manager2.eventStore.count).toBe(2);
      expect(manager2.eventStore.getLastOrder()).toBe(2);

      const state = manager2.getCurrentState();
      expect(state.entities.camille.age).toBe(26);
    });
  });

  describe('edge cases', () => {
    it('should handle many events without error', () => {
      const count = 100;
      for (let i = 1; i <= count; i++) {
        manager.commit(makeEvent(i, {
          postconditions: [makeFact('camille', 'counter', i)],
        }));
      }

      expect(manager.eventStore.count).toBe(count);
      expect(manager.eventStore.getLastOrder()).toBe(count);

      const state = manager.getCurrentState();
      expect(state.entities.camille.counter).toBe(count);
    });

    it('should snapshot at every interval with many events', () => {
      for (let i = 1; i <= 100; i++) {
        manager.commit(makeEvent(i));
      }

      const snapshots = manager.snapshotEngine.listSnapshots();
      expect(snapshots).toEqual([20, 40, 60, 80, 100]);
    });
  });
});
