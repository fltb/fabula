// ============================================================================
// StateManager — Unit Tests
// Tests EventStore, SnapshotEngine, ReplayEngine, and StateManager
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyBranchPath } from '../src/branch/index.js';
import { compileEntityTypeCatalog } from '../src/entity/entity-catalog-compiler.js';
import { EventStore, ReplayEngine, SnapshotEngine, StateManager } from '../src/state/index.js';
import { applyRuleTransaction } from '../src/state/rule-replay.js';
import {
  MemoryStateLogRepository,
  MemoryStateSnapshotRepository,
} from '../src/testing/memory-repositories.js';
import type {
  BranchPath,
  EntityCatalogContext,
  EntityDeclarationCatalog,
  EntityTypeCatalog,
  EntityTypeCatalogSource,
  EntityTypeDefinitionSource,
  Fact,
  NarrativeEvent,
  RuleRuntimeState,
  RuleTransaction,
  Snapshot,
  WorldState,
} from '../src/types/index.js';
import type { StateEvent, StateStreamKey } from '../src/ports/state-repository.js';
import type { JsonValue } from '../src/contracts/json.js';

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
    storyTime: { type: 'absolute', value: `day_${narrativeOrder}` },
    sceneType: 'linear',
    pov: { character: 'camille', type: 'third_person_limited' },
    sceneBrief: `Scene brief for event ${narrativeOrder}`,
    beats: [`Scene brief for event ${narrativeOrder}`],
    preconditions: [],
    postconditions: [],
    threadProgress: [],
    foreshadowing: [],
    relationshipEffects: [],
    ruleEffects: [],
    kind: 'event',
    source: 'event_file',
    branchExistence: { type: 'all' },
    participants: { entities: [] },
    ...overrides,
  };
}

// ============================================================================
// Synthetic entity catalog — explicit declarations, schemas, and activation
// ============================================================================

const LIFECYCLE_TRANSITIONS: Array<
  ['active' | 'inactive' | 'retired', 'active' | 'inactive' | 'retired']
> = [
  ['active', 'inactive'],
  ['active', 'retired'],
  ['inactive', 'active'],
  ['inactive', 'retired'],
];

const CHARACTER_SOURCE: EntityTypeDefinitionSource = {
  typeId: 'character',
  kind: 'character',
  attributes: {
    lifecycle: {
      attributeId: 'lifecycle',
      valueType: 'string',
      requiredAt: 'never',
      writePolicy: 'lifecycle_managed',
      allowedLifecycleStates: ['active', 'inactive', 'retired'],
      unsetAllowed: false,
    },
    name: {
      attributeId: 'name',
      valueType: 'string',
      requiredAt: 'never',
      writePolicy: 'mutable',
      unsetAllowed: true,
    },
    age: {
      attributeId: 'age',
      valueType: 'number',
      requiredAt: 'never',
      writePolicy: 'mutable',
      unsetAllowed: true,
    },
    location: {
      attributeId: 'location',
      valueType: 'string',
      requiredAt: 'never',
      writePolicy: 'mutable',
      unsetAllowed: true,
    },
    knows: {
      attributeId: 'knows',
      valueType: 'string',
      requiredAt: 'never',
      writePolicy: 'mutable',
      unsetAllowed: true,
    },
    knowledge: {
      attributeId: 'knowledge',
      valueType: 'string',
      requiredAt: 'never',
      writePolicy: 'mutable',
      unsetAllowed: true,
    },
    path: {
      attributeId: 'path',
      valueType: 'string',
      requiredAt: 'never',
      writePolicy: 'mutable',
      unsetAllowed: true,
    },
    fate: {
      attributeId: 'fate',
      valueType: 'string',
      requiredAt: 'never',
      writePolicy: 'mutable',
      unsetAllowed: true,
    },
    value: {
      attributeId: 'value',
      valueType: 'number',
      requiredAt: 'never',
      writePolicy: 'mutable',
      unsetAllowed: true,
    },
    counter: {
      attributeId: 'counter',
      valueType: 'number',
      requiredAt: 'never',
      writePolicy: 'mutable',
      unsetAllowed: true,
    },
  },
  lifecyclePolicy: { allowedTransitions: LIFECYCLE_TRANSITIONS },
  referenceCapabilities: { defaultEligibility: 'live' },
  typedInvariants: [],
};

const ITEM_SOURCE: EntityTypeDefinitionSource = {
  typeId: 'item',
  kind: 'item',
  attributes: {
    lifecycle: {
      attributeId: 'lifecycle',
      valueType: 'string',
      requiredAt: 'never',
      writePolicy: 'lifecycle_managed',
      allowedLifecycleStates: ['active', 'inactive', 'retired'],
      unsetAllowed: false,
    },
    status: {
      attributeId: 'status',
      valueType: 'string',
      requiredAt: 'never',
      writePolicy: 'mutable',
      unsetAllowed: true,
    },
  },
  lifecyclePolicy: { allowedTransitions: LIFECYCLE_TRANSITIONS },
  referenceCapabilities: { defaultEligibility: 'live' },
  typedInvariants: [],
};

const SYNTHETIC_TYPE_SOURCE: EntityTypeCatalogSource = {
  types: {
    character: CHARACTER_SOURCE,
    item: ITEM_SOURCE,
  },
};

const TYPE_CATALOG: EntityTypeCatalog = compileEntityTypeCatalog(SYNTHETIC_TYPE_SOURCE);

const DECLARATION_CATALOG: EntityDeclarationCatalog = {
  declarations: {
    camille: {
      entityId: 'camille',
      typeRef: { typeId: 'character', schemaVersion: 1 },
      immutableMetadata: { name: 'Camille', definitionFile: 'camille.yaml' },
      introduction: { type: 'initial' },
    },
    npc_gear: {
      entityId: 'npc_gear',
      typeRef: { typeId: 'item', schemaVersion: 1 },
      immutableMetadata: { name: 'NPC Gear', definitionFile: 'npc_gear.yaml' },
      introduction: { type: 'initial' },
    },
  },
  version: 1,
};

const CATALOG_CONTEXT: EntityCatalogContext = {
  entityDeclarationCatalog: DECLARATION_CATALOG,
  entityTypeCatalog: TYPE_CATALOG,
};

/**
 * Baseline activation facts for the initial-introduced test entities. Every
 * entity the tests write facts for is declared above and activated here, so
 * replay never hits the "write before activation" guard.
 */
const INITIAL_FACTS: Fact[] = [
  makeFact('camille', 'lifecycle', 'active'),
  makeFact('npc_gear', 'lifecycle', 'active'),
];

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
      expect(() => store.commit(e2)).toThrow('Event with narrativeOrder 5 already exists');
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
      for (const event of events) store.commit(event);

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

  describe('semantic persistence via StateLogRepository', () => {
    const STREAM_KEY: StateStreamKey = {
      projectId: 'project',
      streamId: 'world',
      branchId: 'main',
    };

    /** Serialize a NarrativeEvent into the semantic state log record shape. */
    const toStateEvent = (event: NarrativeEvent, sequence: number): StateEvent => ({
      eventId: event.id,
      sequence,
      type: event.event,
      payload: JSON.parse(JSON.stringify(event)) as JsonValue,
    });

    /** Rebuild an EventStore from a semantic log read (recovery path). */
    const toEventStore = (events: readonly StateEvent[]): EventStore => {
      const store = new EventStore();
      store.load(
        events.map((entry) => JSON.parse(JSON.stringify(entry.payload)) as NarrativeEvent),
      );
      return store;
    };

    it('should round-trip events through the repository preserving order and content', async () => {
      const e1 = makeEvent(1, {
        title: 'First',
        sceneBrief: 'Brief one',
        beats: ['Brief one'],
      });
      const e2 = makeEvent(2, {
        title: 'Second',
        sceneBrief: 'Brief two',
        beats: ['Brief two'],
      });
      const log = new MemoryStateLogRepository();

      expect(
        await log.append({
          key: STREAM_KEY,
          expectedVersion: 0,
          events: [toStateEvent(e1, 1), toStateEvent(e2, 2)],
        }),
      ).toMatchObject({ kind: 'appended', version: 2 });

      const loadedStore = toEventStore((await log.read({ key: STREAM_KEY })).events);
      expect(loadedStore.count).toBe(2);
      expect(loadedStore.getAll().map((e) => e.narrativeOrder)).toEqual([1, 2]);
      expect(loadedStore.getById(e1.id)?.title).toBe('First');
      expect(loadedStore.getById(e2.id)?.sceneBrief).toBe('Brief two');
    });

    it('should handle an empty event stream', async () => {
      const log = new MemoryStateLogRepository();
      const read = await log.read({ key: STREAM_KEY });
      expect(read.events).toEqual([]);
      expect(read.version).toBe(0);
      expect(read.firstSequence).toBeNull();
      expect(read.lastSequence).toBeNull();

      const loadedStore = toEventStore(read.events);
      expect(loadedStore.count).toBe(0);
    });

    it('should reject append on expected-version conflict (CAS)', async () => {
      const log = new MemoryStateLogRepository();
      await log.append({
        key: STREAM_KEY,
        expectedVersion: 0,
        events: [toStateEvent(makeEvent(1), 1)],
      });

      expect(
        await log.append({
          key: STREAM_KEY,
          expectedVersion: 0,
          events: [toStateEvent(makeEvent(2), 2)],
        }),
      ).toEqual({ kind: 'conflict', expectedVersion: 0, actualVersion: 1 });

      // The conflicting append must not mutate the stream.
      const read = await log.read({ key: STREAM_KEY });
      expect(read.events).toHaveLength(1);
      expect(read.version).toBe(1);
    });

    it('should preserve event ordering after recovery', async () => {
      const log = new MemoryStateLogRepository();
      await log.append({
        key: STREAM_KEY,
        expectedVersion: 0,
        events: [
          toStateEvent(makeEvent(3), 1),
          toStateEvent(makeEvent(1), 2),
          toStateEvent(makeEvent(2), 3),
        ],
      });

      const loadedStore = toEventStore((await log.read({ key: STREAM_KEY })).events);
      expect(loadedStore.getAll().map((e) => e.narrativeOrder)).toEqual([1, 2, 3]);
    });

    it('should read a suffix from a given sequence (snapshot+replay recovery)', async () => {
      const log = new MemoryStateLogRepository();
      await log.append({
        key: STREAM_KEY,
        expectedVersion: 0,
        events: [
          toStateEvent(makeEvent(1), 1),
          toStateEvent(makeEvent(2), 2),
          toStateEvent(makeEvent(3), 3),
        ],
      });

      const suffix = await log.read({ key: STREAM_KEY, fromSequence: 2 });
      expect(suffix.events.map((e) => e.eventId)).toEqual([expect.any(String), expect.any(String)]);
      expect(suffix.lastSequence).toBe(3);
    });
  });
});

// ============================================================================
// SnapshotEngine Tests
// ============================================================================

describe('SnapshotEngine', () => {
  let engine: SnapshotEngine;

  beforeEach(() => {
    engine = new SnapshotEngine(20);
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
      const custom = new SnapshotEngine(5);
      expect(custom.shouldSnapshot(5)).toBe(true);
      expect(custom.shouldSnapshot(10)).toBe(true);
      expect(custom.shouldSnapshot(7)).toBe(false);
    });
  });

  describe('createSnapshot()', () => {
    it('should produce a snapshot value with the event identity', () => {
      const state: WorldState = {
        entities: { camille: { age: 25 } },
        relationships: {},
        knowledge: {},
        threads: {
          main: {
            threadId: 'main',
            status: 'active',
            currentRunId: 'legacy-main',
            phase: '',
            bindings: {},
            goalStates: { progress: 'active' },
            milestoneStates: {},
            semanticStateHash: 'h0',
          },
        },
        rules: {},
        facts: [],
      };

      const snapshot = engine.createSnapshot(20, 'evt_test', state);

      expect(snapshot.eventCount).toBe(20);
      expect(snapshot.eventId).toBe('evt_test');
      expect(snapshot.state).toEqual(state);
      expect(snapshot.timestamp).toBe('1970-01-01T00:00:00.000Z');
      expect(snapshot.version).toBe(1);
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

      expect(engine.listSnapshots()).toEqual([20, 40]);
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
      expect(found!.eventCount).toBe(40);
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
      expect(found!.eventCount).toBe(20);
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
      expect(found!.eventCount).toBe(40);
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

      expect(engine.listSnapshots()).toEqual([20]);
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

      expect(engine.listSnapshots()).toEqual([20]);
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

      expect(engine.listSnapshots()).toEqual([]);
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
  });

  describe('semantic persistence via StateSnapshotRepository', () => {
    const STREAM_KEY: StateStreamKey = {
      projectId: 'project',
      streamId: 'world',
      branchId: 'main',
    };
    const SCHEMA = 'world';

    const toSnapshotRecord = (
      snapshot: Snapshot,
    ): {
      version: 1;
      key: StateStreamKey;
      schema: string;
      schemaVersion: number;
      sequence: number;
      state: JsonValue;
      snapshotHash: string;
    } => ({
      version: 1,
      key: STREAM_KEY,
      schema: SCHEMA,
      schemaVersion: 1,
      sequence: snapshot.eventCount,
      state: JSON.parse(JSON.stringify(snapshot.state)) as JsonValue,
      snapshotHash: `snapshot_${snapshot.eventCount}`,
    });

    it('should save snapshots under expected-version CAS and select the nearest', async () => {
      const state: WorldState = {
        entities: { camille: { age: 25 } },
        relationships: {},
        knowledge: {},
        threads: {},
        rules: {},
        facts: [],
      };
      const snapshots = new MemoryStateSnapshotRepository();

      expect(
        await snapshots.save({
          snapshot: toSnapshotRecord(engine.createSnapshot(20, 'evt_20', state)),
          expectedVersion: null,
        }),
      ).toMatchObject({ kind: 'saved', sequence: 20, version: 1 });
      expect(
        await snapshots.save({
          snapshot: toSnapshotRecord(engine.createSnapshot(40, 'evt_40', state)),
          expectedVersion: 1,
        }),
      ).toMatchObject({ kind: 'saved', sequence: 40, version: 2 });

      // Stale expected version is rejected; the store keeps the last save.
      expect(
        await snapshots.save({
          snapshot: toSnapshotRecord(engine.createSnapshot(60, 'evt_60', state)),
          expectedVersion: 1,
        }),
      ).toEqual({ kind: 'conflict', expectedVersion: 1, actualVersion: 2 });

      const nearest = await snapshots.readNearestValid({
        key: STREAM_KEY,
        atOrBeforeSequence: 55,
        schema: SCHEMA,
        schemaVersion: 1,
      });
      expect(nearest).not.toBeNull();
      expect(nearest!.sequence).toBe(40);
      expect(nearest!.state).toEqual(state);
    });

    it('should treat a missing snapshot as absent (safe full replay)', async () => {
      const snapshots = new MemoryStateSnapshotRepository();

      expect(
        await snapshots.readNearestValid({
          key: STREAM_KEY,
          atOrBeforeSequence: 20,
          schema: SCHEMA,
          schemaVersion: 1,
        }),
      ).toBeNull();
    });

    it('should ignore snapshots of a different schema or version (stale/corrupt fallback)', async () => {
      const state: WorldState = {
        entities: {},
        relationships: {},
        knowledge: {},
        threads: {},
        rules: {},
        facts: [],
      };
      const snapshots = new MemoryStateSnapshotRepository();
      await snapshots.save({
        snapshot: {
          ...toSnapshotRecord(engine.createSnapshot(20, 'evt_20', state)),
          schema: 'other',
        },
        expectedVersion: null,
      });
      await snapshots.save({
        snapshot: {
          ...toSnapshotRecord(engine.createSnapshot(30, 'evt_30', state)),
          schemaVersion: 2,
        },
        expectedVersion: 1,
      });

      expect(
        await snapshots.readNearestValid({
          key: STREAM_KEY,
          atOrBeforeSequence: 30,
          schema: SCHEMA,
          schemaVersion: 1,
        }),
      ).toBeNull();
    });
  });
});

// ============================================================================
// ReplayEngine Tests
// ============================================================================

describe('ReplayEngine', () => {
  let engine: ReplayEngine;

  beforeEach(() => {
    engine = new ReplayEngine(CATALOG_CONTEXT);
  });

  describe('replay()', () => {
    it('should return an empty world state for no events', () => {
      const state = engine.replay([]);
      expect(state).toEqual({
        entities: {},
        relationships: {},
        knowledge: {},
        epistemicLedger: { claims: {}, bySubject: {}, byProposition: {}, actLog: [] },
        propositionCatalog: { version: 0, propositions: {}, dependencyGraph: {} },
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

      const state = engine.replay(events, { initialFacts: INITIAL_FACTS });

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
            {
              thread: 'mystery',
              advancement: 'Discovered clue',
              progressAfter: 1,
              progressTotal: 10,
            },
            {
              thread: 'romance',
              advancement: 'Met love interest',
              progressAfter: 1,
              progressTotal: 5,
            },
          ],
        }),
        makeEvent(2, {
          threadProgress: [
            {
              thread: 'mystery',
              advancement: 'Found evidence',
              progressAfter: 3,
              progressTotal: 10,
            },
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

      const state = engine.replay(events, { initialFacts: INITIAL_FACTS });

      // Legacy state.knowledge shim is removed — epistemic ledger handles knowledge now
      expect(state.knowledge.camille).toBeUndefined();
      expect(state.epistemicLedger).toBeDefined();
      // The entity attribute was still written via normal set path
      expect(state.entities.camille?.knows).toBe('camille_is_hero');
      expect(state.entities.camille?.knowledge).toBe('camille_is_chosen');
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

      const ruleState = state.rules.magic_conservation;
      expect(ruleState.activation).toBe('enabled');
      expect(ruleState.effectiveness).toBe('full');
      expect(ruleState.ruleId).toBe('magic_conservation');
      expect(ruleState.exceptions).toEqual([]);
    });

    it('rejects preconditions that have no deterministic provider', () => {
      const events: NarrativeEvent[] = [
        makeEvent(1, {
          preconditions: [makeFact('camille', 'age', 24)],
          postconditions: [makeFact('camille', 'age', 25)],
        }),
      ];

      // Precondition validation happens at replay time — the event sets
      // age=25 but then checks precondition age=24 before allowing the event
      expect(() => engine.replay(events, { initialFacts: INITIAL_FACTS })).toThrow(
        'Precondition eq fails',
      );
    });

    it('should handle branch filtering — skip events not on current path', () => {
      const branchPath: BranchPath = {
        decisions: [{ atEventId: 'evt_choice', choiceId: 'path_a', narrativeOrder: 2 }],
      };

      const pathAEvent = makeEvent(3, {
        title: 'Path A event',
        branchExistence: {
          type: 'paths',
          paths: [
            {
              decisions: [{ atEventId: 'evt_choice', choiceId: 'path_a', narrativeOrder: 2 }],
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
              decisions: [{ atEventId: 'evt_choice', choiceId: 'path_b', narrativeOrder: 2 }],
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

      const state = engine.replay(events, { branchPath, initialFacts: INITIAL_FACTS });

      expect(state.entities.camille.name).toBe('Camille');
      expect(state.entities.camille.path).toBe('A');
      expect(state.entities.camille).not.toHaveProperty('path_B');
    });

    it('should filter facts by branch validity', () => {
      const branchPath: BranchPath = {
        decisions: [{ atEventId: 'evt_choice', choiceId: 'path_a', narrativeOrder: 2 }],
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

      const state = engine.replay(events, { branchPath, initialFacts: INITIAL_FACTS });

      // Only the fact scoped to 'path_a' should be applied
      expect(state.entities.camille.location).toBe('village');
    });
  });

  describe('getStateAt()', () => {
    it('should return state at a specific narrative order', () => {
      const events: NarrativeEvent[] = [
        makeEvent(1, {
          storyTime: { type: 'chapter', chapter: 1 },
          postconditions: [makeFact('camille', 'age', 25)],
        }),
        makeEvent(2, {
          storyTime: { type: 'chapter', chapter: 2 },
          postconditions: [makeFact('camille', 'age', 26)],
        }),
        makeEvent(3, {
          storyTime: { type: 'chapter', chapter: 3 },
          postconditions: [makeFact('camille', 'age', 27)],
        }),
      ];

      const stateAt2 = engine.getStateAt(events, 2, { initialFacts: INITIAL_FACTS });
      expect(stateAt2.entities.camille.age).toBe(26);

      const stateAt1 = engine.getStateAt(events, 1, { initialFacts: INITIAL_FACTS });
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
        makeEvent(1, {
          storyTime: { type: 'chapter', chapter: 1 },
          postconditions: [makeFact('camille', 'age', 25)],
        }),
      ];

      const state = engine.getStateAt(events, 999, { initialFacts: INITIAL_FACTS });
      expect(state.entities.camille.age).toBe(25);
    });

    it('should accept an optional branchPath', () => {
      const branchPath: BranchPath = {
        decisions: [{ atEventId: 'evt_choice', choiceId: 'path_a', narrativeOrder: 2 }],
      };

      const events: NarrativeEvent[] = [
        makeEvent(1, {
          storyTime: { type: 'chapter', chapter: 1 },
          postconditions: [makeFact('camille', 'name', 'Camille')],
        }),
        makeEvent(2, { storyTime: { type: 'chapter', chapter: 2 }, title: 'Choice' }),
        makeEvent(3, {
          storyTime: { type: 'chapter', chapter: 3 },
          branchExistence: {
            type: 'paths',
            paths: [
              {
                decisions: [{ atEventId: 'evt_choice', choiceId: 'path_a', narrativeOrder: 2 }],
              },
            ],
          },
          postconditions: [makeFact('camille', 'fate', 'hero')],
        }),
      ];

      const stateWithoutBranch = engine.getStateAt(events, 3, {
        initialFacts: INITIAL_FACTS,
      });
      expect(stateWithoutBranch.entities.camille.fate).toBeUndefined();

      const stateWithBranch = engine.getStateAt(events, 3, {
        branchPath,
        initialFacts: INITIAL_FACTS,
      });
      expect(stateWithBranch.entities.camille.fate).toBe('hero');
    });
  });
});

// ============================================================================
// StateManager Tests
// ============================================================================

describe('StateManager', () => {
  let manager: StateManager;

  beforeEach(() => {
    manager = new StateManager(CATALOG_CONTEXT, 20);
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
      for (let i = 1; i <= 20; i++) {
        manager.commit(makeEvent(i));
      }

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
        epistemicLedger: { claims: {}, bySubject: {}, byProposition: {}, actLog: [] },
        propositionCatalog: { version: 0, propositions: {}, dependencyGraph: {} },
        threads: {},
        rules: {},
        facts: [],
      });
    });

    it('should return the full world state from all events', () => {
      manager.commit(
        makeEvent(1, {
          postconditions: [makeFact('camille', 'age', 25)],
          threadProgress: [
            { thread: 'main', advancement: 'Start', progressAfter: 1, progressTotal: 10 },
          ],
        }),
      );
      manager.commit(
        makeEvent(2, {
          postconditions: [makeFact('camille', 'age', 26)],
        }),
      );

      const state = manager.getCurrentState({ initialFacts: INITIAL_FACTS });

      expect(state.entities.camille.age).toBe(26);
      expect(state.threads.main).toBeDefined();
      expect(state.threads.main!.status).toBe('active');
      expect(state.threads.main!.goalStates.progress).toBe('active');
    });

    it('should honor branch path filtering', () => {
      const branchPath: BranchPath = {
        decisions: [{ atEventId: 'evt_choice', choiceId: 'path_a', narrativeOrder: 2 }],
      };

      manager.commit(
        makeEvent(1, {
          postconditions: [makeFact('camille', 'name', 'Camille')],
        }),
      );
      manager.commit(makeEvent(2, { title: 'Choice point' }));
      manager.commit(
        makeEvent(3, {
          branchExistence: {
            type: 'paths',
            paths: [
              {
                decisions: [{ atEventId: 'evt_choice', choiceId: 'path_a', narrativeOrder: 2 }],
              },
            ],
          },
          postconditions: [makeFact('camille', 'path', 'A')],
        }),
      );
      manager.commit(
        makeEvent(4, {
          branchExistence: {
            type: 'paths',
            paths: [
              {
                decisions: [{ atEventId: 'evt_choice', choiceId: 'path_b', narrativeOrder: 2 }],
              },
            ],
          },
          postconditions: [makeFact('camille', 'path', 'B')],
        }),
      );

      const state = manager.getCurrentState({ branchPath, initialFacts: INITIAL_FACTS });
      expect(state.entities.camille.path).toBe('A');
    });
  });

  describe('getStateAt()', () => {
    it('should return state at a specific narrative order', () => {
      for (let i = 1; i <= 5; i++) {
        manager.commit(
          makeEvent(i, {
            storyTime: { type: 'chapter', chapter: i },
            postconditions: [makeFact('camille', 'age', 20 + i)],
          }),
        );
      }

      const stateAt3 = manager.getStateAt(3, { initialFacts: INITIAL_FACTS });
      expect(stateAt3.entities.camille.age).toBe(23);

      const stateAt5 = manager.getStateAt(5, { initialFacts: INITIAL_FACTS });
      expect(stateAt5.entities.camille.age).toBe(25);
    });

    it('should use snapshots when available for optimization', () => {
      // Snapshot-time replays (commit at order 20) also write camille, so this
      // manager carries the baseline activation facts in its replay defaults.
      const manager = new StateManager(CATALOG_CONTEXT, 20, {
        initialFacts: INITIAL_FACTS,
      });
      // Commit events that create a snapshot at 20
      for (let i = 1; i <= 25; i++) {
        manager.commit(
          makeEvent(i, {
            storyTime: { type: 'chapter', chapter: i },
            postconditions: [makeFact('camille', 'value', i)],
          }),
        );
      }

      const state = manager.getStateAt(25);
      expect(state.entities.camille.value).toBe(25);
    });

    it('should return empty state when order is before all events', () => {
      manager.commit(
        makeEvent(10, {
          postconditions: [makeFact('camille', 'age', 30)],
        }),
      );

      const state = manager.getStateAt(0);
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
      const events = [makeEvent(1, { postconditions: [makeFact('camille', 'age', 25)] })];

      manager.initialize(events);

      const state = manager.getCurrentState({ initialFacts: INITIAL_FACTS });
      expect(state.entities.camille.age).toBe(25);
    });
  });

  describe('semantic recovery via state repositories', () => {
    const STREAM_KEY: StateStreamKey = {
      projectId: 'project',
      streamId: 'world',
      branchId: 'main',
    };
    const SCHEMA = 'world';

    const toStateEvent = (event: NarrativeEvent, sequence: number): StateEvent => ({
      eventId: event.id,
      sequence,
      type: event.event,
      payload: JSON.parse(JSON.stringify(event)) as JsonValue,
    });

    it('should persist and reload events, then reconstruct state by full replay', async () => {
      const log = new MemoryStateLogRepository();
      await log.append({
        key: STREAM_KEY,
        expectedVersion: 0,
        events: [
          toStateEvent(
            makeEvent(1, {
              title: 'Event One',
              postconditions: [makeFact('camille', 'age', 25)],
            }),
            1,
          ),
          toStateEvent(
            makeEvent(2, {
              title: 'Event Two',
              postconditions: [makeFact('camille', 'age', 26)],
            }),
            2,
          ),
        ],
      });

      const manager2 = new StateManager(CATALOG_CONTEXT, 20, {
        initialFacts: INITIAL_FACTS,
      });
      const read = await log.read({ key: STREAM_KEY });
      manager2.initialize(
        read.events.map((entry) => JSON.parse(JSON.stringify(entry.payload)) as NarrativeEvent),
      );

      expect(manager2.eventStore.count).toBe(2);
      expect(manager2.eventStore.getLastOrder()).toBe(2);

      const state = manager2.getCurrentState();
      expect(state.entities.camille.age).toBe(26);
    });

    it('should recover by full replay when the snapshot write never happened', async () => {
      // Append succeeded (event log durable) but the snapshot was never saved —
      // the missing snapshot must fall back to full replay of the log, with no
      // events lost.
      const log = new MemoryStateLogRepository();
      await log.append({
        key: STREAM_KEY,
        expectedVersion: 0,
        events: [
          toStateEvent(makeEvent(1, { postconditions: [makeFact('camille', 'age', 25)] }), 1),
          toStateEvent(makeEvent(2, { postconditions: [makeFact('camille', 'age', 26)] }), 2),
        ],
      });
      const snapshots = new MemoryStateSnapshotRepository(); // empty: snapshot not yet written

      expect(
        await snapshots.readNearestValid({
          key: STREAM_KEY,
          atOrBeforeSequence: 2,
          schema: SCHEMA,
          schemaVersion: 1,
        }),
      ).toBeNull();

      const read = await log.read({ key: STREAM_KEY });
      expect(read.events).toHaveLength(2);
      expect(read.lastSequence).toBe(2);

      const recovered = new StateManager(CATALOG_CONTEXT, 20, {
        initialFacts: INITIAL_FACTS,
      });
      recovered.initialize(
        read.events.map((entry) => JSON.parse(JSON.stringify(entry.payload)) as NarrativeEvent),
      );
      const state = recovered.getCurrentState();
      expect(state.entities.camille.age).toBe(26);
    });
  });

  describe('edge cases', () => {
    it('should handle many events without error', () => {
      // Snapshot-time replays (orders 20/40/…/100) also write camille, so this
      // manager carries the baseline activation facts in its replay defaults.
      const manager = new StateManager(CATALOG_CONTEXT, 20, {
        initialFacts: INITIAL_FACTS,
      });
      const count = 100;
      for (let i = 1; i <= count; i++) {
        manager.commit(
          makeEvent(i, {
            storyTime: { type: 'chapter', chapter: i },
            postconditions: [makeFact('camille', 'counter', i)],
          }),
        );
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

// ============================================================================
// Rule replay determinism — legacy rule effects and explicit amend/replace
// fallbacks must produce identical semantic state regardless of wall-clock.
// ============================================================================

describe('Rule replay determinism', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('replays identical legacy rule effects to identical WorldState under different clocks', () => {
    const events: NarrativeEvent[] = [
      makeEvent(1, {
        ruleEffects: [
          { rule: 'magic_conservation', effect: 'reinforce', evidence: 'Magic is limited' },
        ],
      }),
      makeEvent(2, {
        ruleEffects: [
          {
            rule: 'magic_conservation',
            effect: 'introduce_exception',
            evidence: 'Ritual exemption',
          },
          { rule: 'oath_binding', effect: 'reinforce', evidence: 'Oaths hold' },
        ],
      }),
    ];

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    const first = new ReplayEngine(CATALOG_CONTEXT).replay(events);

    vi.setSystemTime(new Date('2026-06-15T12:00:00Z'));
    const second = new ReplayEngine(CATALOG_CONTEXT).replay(events);

    // Full semantic WorldState equality — no wall-clock fingerprint anywhere.
    expect(second).toEqual(first);

    // Epoch/exception identities are stable, derived from rule + event ID.
    const magic = first.rules.magic_conservation;
    expect(magic?.activation).toBe('enabled');
    expect(magic?.effectiveness).toBe('full');
    expect(magic?.currentEpoch).toBe(`magic_conservation-epoch-${events[0].id}`);
    expect(magic?.exceptions[0]?.exceptionId).toBe(`magic_conservation-exc-${events[1].id}`);
    expect(magic?.exceptions[0]?.status).toBe('active');
    expect(first.rules.oath_binding?.currentEpoch).toBe(`oath_binding-epoch-${events[1].id}`);
  });

  it('derives stable fallback epochs for amend/replace without epochId under different clocks', () => {
    const amend: RuleTransaction = {
      type: 'rule_transaction',
      ruleId: 'contract_law',
      operation: 'amend',
      evidence: 'Charter amendment',
    };
    const replace: RuleTransaction = {
      type: 'rule_transaction',
      ruleId: 'contract_law',
      operation: 'replace',
      evidence: 'Rewritten by decree',
      specificationId: 'contract_law-spec-v2',
    };

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    const first: Record<string, RuleRuntimeState> = {};
    applyRuleTransaction(first, amend, { nodeId: 'E10' });
    applyRuleTransaction(first, replace, { nodeId: 'E11' });

    vi.setSystemTime(new Date('2026-06-15T12:00:00Z'));
    const second: Record<string, RuleRuntimeState> = {};
    applyRuleTransaction(second, amend, { nodeId: 'E10' });
    applyRuleTransaction(second, replace, { nodeId: 'E11' });

    expect(second).toEqual(first);
    expect(first.contract_law?.currentEpoch).toBe('contract_law-epoch-E11');
    expect(first.contract_law?.activation).toBe('enabled');
    expect(first.contract_law?.specificationId).toBe('contract_law-spec-v2');
  });
});
