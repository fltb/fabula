// ============================================================================
// Integration Test: Arcane Aftermath Fixture
//
// Tests the full Novalistically pipeline against the fixture project at
//   /home/float/myfile/Projects/novalistically/fixtures/arcane-aftermath/
//
// The fixture uses a different YAML schema than the TypeScript types expect
// (underscore vs camelCase, alternate field names, nested wrappers). These
// tests document what works, what partially works, and what gracefully degrades.
// Additionally, E1b.yaml has a YAML duplicate-key error, so only E1a is loaded.
// ============================================================================

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

const FIXTURE_PATH = path.resolve(
  '/home/float/myfile/Projects/novalistically/fixtures/arcane-aftermath',
);

import { EntityMapper, InMemoryEntityRegistry } from '../src/entity/index.js';
import type { ProjectData } from '../src/entity/index.js';
import { StateManager, ReplayEngine } from '../src/state/index.js';
import {
  ResultAggregator,
  TimelineValidator,
  POVValidator,
} from '../src/validator/index.js';
import { calculateISS, detectAntiPatterns } from '../src/iss/index.js';
import { assembleNovel, countWords } from '../src/assembler/index.js';
import { ContextCompiler } from '../src/context/index.js';
import type { NarrativeEvent, PreRenderInput, WorldState } from '../src/types/index.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<NarrativeEvent> = {}): NarrativeEvent {
  return {
    id: 'test:evt',
    event: 'test_event',
    narrativeOrder: 1,
    title: 'Test Event',
    storyTime: { type: 'absolute', value: 'day_1' },
    sceneType: 'linear',
    pov: { character: 'system', type: 'omniscient' },
    sceneBrief: 'Test event for integration test',
    preconditions: [],
    postconditions: [],
    threadProgress: [],
    foreshadowing: [],
    relationshipEffects: [],
    ruleEffects: [],
    source: 'event_file',
    branchExistence: { type: 'all' },
    participants: { entities: [] },
    ...overrides,
  };
}

// ─── 1. Full pipeline: load → validate → state → assemble ─────────────────────

describe('1. Full Pipeline', () => {
  let mapper: EntityMapper;
  let projectData: ProjectData;

  beforeAll(() => {
    expect(fs.existsSync(FIXTURE_PATH)).toBe(true);
    mapper = new EntityMapper(FIXTURE_PATH);
    projectData = mapper.loadProject();
  });

  it('1a. EntityMapper loads the fixture project data', () => {
    // ── Project config ───────────────────────────────────────────
    expect(projectData.config).not.toBeNull();
    expect(projectData.config!.project).toBe('arcane_aftermath');
    expect(projectData.config!.title).toBe('Arcane 后传：灰色市场');
    expect(projectData.config!.author).toBe('Test Author');

    // ── Characters ──────────────────────────────────────────────
    // Characters — use .id (YAML now has this field)
    expect(projectData.characters.length).toBeGreaterThanOrEqual(3);
    const rawChars = projectData.characters.map((c: any) => c.character || c.id);
    expect(rawChars).toContain('camille');
    expect(rawChars).toContain('seraphine');
    expect(rawChars).toContain('gear');

    // ── Locations ───────────────────────────────────────────────
    expect(projectData.locations.length).toBe(2);
    const locIds = projectData.locations.map((l: any) => l.location || l.id);
    expect(locIds).toContain('piltover_enforcer_headquarters');
    expect(locIds).toContain('zaun_gray_exchange');

    // ── Rules ──────────────────────────────────────────────────
    // YAML uses `rule:` not `ruleId:`
    expect(projectData.rules.length).toBe(2);
    const rawRules = projectData.rules.map((r: any) => r.rule || r.ruleId);
    expect(rawRules).toContain('hextech_crystal_scarcity');
    expect(rawRules).toContain('shimmer_addiction_timeline');

    // ── Relationships ──────────────────────────────────────────
    expect(projectData.relationships.length).toBe(1);
    const rel = projectData.relationships[0] as any;
    expect(rel.type).toBe('professional_mentor_asset');

    // ── World initial state (now flat structure) ─────────
    expect(projectData.worldInitialState).not.toBeNull();
    const wis = projectData.worldInitialState as any;
    expect(wis.timeAnchors).toBeDefined();
    expect(wis.timeAnchors.length).toBeGreaterThanOrEqual(3);
    expect(wis.threads).toHaveLength(3);
    expect(wis.worldFacts).toBeDefined();
    expect(wis.worldFacts.length).toBeGreaterThanOrEqual(5);
    // mapper reads worldInitialState.timeAnchors (camelCase) which now has data
    expect(projectData.timeAnchors.length).toBeGreaterThanOrEqual(3);

    // ── Chapter 1 ─────────────────────────────────────────────
    expect(projectData.chapters.size).toBe(1);
    const ch1 = projectData.chapters.get(1)!;
    expect(ch1.metadata).not.toBeNull();
    // YAML now uses camelCase `title`
    expect(ch1.metadata!.title).toBe('Chapter 1: The Signal');

    // Both E1a and E1b now load (duplicate-key issue was fixed in fixture rewrite)
    expect(ch1.events.length).toBe(2);
    const evt = ch1.events[0] as any;
    expect(evt.event).toBe('E1a');
    expect(evt.narrativeOrder).toBe(1);
  });

  it('1b. InMemoryEntityRegistry.load() loads all fixture entities', () => {
    const registry = new InMemoryEntityRegistry();
    expect(() => registry.load(FIXTURE_PATH)).not.toThrow();

    // All entities load correctly now that fixture YAMLs use camelCase
    const all = registry.getAll();
    expect(all.length).toBeGreaterThanOrEqual(5);
    // Each entity has a defined state
    for (const entity of all) {
      expect(entity.state).toBeDefined();
    }

    // Characters
    const characters = registry.findByKind('character');
    expect(characters.length).toBeGreaterThanOrEqual(1);
    // Locations
    const locations = registry.findByKind('location');
    expect(locations.length).toBeGreaterThanOrEqual(1);
    // Rules
    const rules = registry.findByKind('rule');
    expect(rules.length).toBeGreaterThanOrEqual(1);
  });

  it('1c. loadAllEvents creates genesis + loaded chapter events', () => {
    const events = mapper.loadAllEvents(projectData.chapters);
    // genesis + 2 loaded events (E1a and E1b)
    expect(events).toHaveLength(3);

    const ids = events.map((e) => e.id);
    expect(ids).toContain('system:genesis');
    expect(ids).toContain('E1a');
    expect(ids).toContain('E1b');

    // Genesis event
    const genesis = events.find((e) => e.id === 'system:genesis')!;
    expect(genesis.narrativeOrder).toBe(0);
    expect(genesis.source).toBe('genesis');

    // E1a event — fixture now uses camelCase so narrativeOrder is defined
    const e1a = events.find((e) => e.id === 'E1a')!;
    expect(e1a.pov.character).toBe('seraphine');
    expect(e1a.pov.type).toBe('third_person_limited');
    expect(e1a.narrativeOrder).toBe(1);
    expect(e1a.sceneType).toBe('linear');
  });

  it('1d. StateManager commits events and produces world state', () => {
    const snapDir = fs.mkdtempSync(path.join(tmpdir(), 'novalistically-snap-'));
    const sm = new StateManager(snapDir);

    const genesis = makeEvent({
      id: 'system:genesis', event: 'system:genesis',
      narrativeOrder: 0, title: 'World Genesis',
      storyTime: { type: 'absolute', value: 'day_0' },
      source: 'genesis',
      postconditions: [{
        id: 'world.council_disarray', entityId: 'world',
        attribute: 'council_status', value: 'in_disarray', confidence: 1.0,
        validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
      }],
    });

    const e1a = makeEvent({
      id: 'E1a', event: 'E1a', narrativeOrder: 1,
      title: 'Seraphine Detects the Anomalous Signal',
      storyTime: { type: 'absolute', value: 'day_0' },
      sceneType: 'linear',
      pov: { character: 'seraphine', type: 'third_person_limited' },
      sceneBrief: 'Seraphine detects an anomalous emotional frequency.',
      postconditions: [{
        id: 'seraphine.detected_anomaly', entityId: 'seraphine',
        attribute: 'detected_anomaly', value: true, confidence: 1.0,
        validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
      }],
      threadProgress: [{ thread: 'T1', advancement: 'Anomaly detected', progressAfter: 20, progressTotal: 100 }],
      participants: { entities: ['seraphine'] },
    });

    const e1b = makeEvent({
      id: 'E1b', event: 'E1b', narrativeOrder: 2,
      title: 'Camille Takes the Case',
      storyTime: { type: 'absolute', value: 'day_0' },
      pov: { character: 'camille', type: 'third_person_limited' },
      sceneBrief: 'Camille takes the missing-crystals case.',
      postconditions: [{
        id: 'camille.accepted_case', entityId: 'camille',
        attribute: 'case_status', value: 'accepted', confidence: 1.0,
        validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
      }],
      threadProgress: [
        { thread: 'T1', advancement: 'Case accepted', progressAfter: 30, progressTotal: 100 },
        { thread: 'T2', advancement: 'Family involvement', progressAfter: 15, progressTotal: 100 },
      ],
      participants: { entities: ['camille'] },
    });

    sm.commit(genesis);
    sm.commit(e1a);
    sm.commit(e1b);

    // Store
    expect(sm.eventStore.count).toBe(3);
    expect(sm.eventStore.getAll().map((e) => e.id))
      .toEqual(['system:genesis', 'E1a', 'E1b']);

    // Duplicate narrative order throws
    expect(() => sm.commit(e1a)).toThrow(/already exists/);

    // State
    const state = sm.getCurrentState();
    expect(state.threads['T1']).toEqual({ progress: 30, total: 100 });
    expect(state.threads['T2']).toEqual({ progress: 15, total: 100 });
    expect(state.entities['seraphine']?.['detected_anomaly']).toBe(true);
    expect(state.entities['camille']?.['case_status']).toBe('accepted');

    // EventStore.saveToDisk / loadFromDisk round-trip
    sm.saveToDisk(snapDir);
    expect(fs.existsSync(path.join(snapDir, 'event_log.jsonl'))).toBe(true);

    const sm2 = new StateManager(fs.mkdtempSync(path.join(tmpdir(), 'novalistically-snap-')));
    sm2.loadFromDisk(snapDir);
    expect(sm2.eventStore.count).toBe(3);

    fs.rmSync(snapDir, { recursive: true, force: true });
    fs.rmSync((sm2 as any).snapshotEngine.snapshotsDir, { recursive: true, force: true });
  });

  it('1e. ResultAggregator runs validators with no errors', () => {
    const snapDir = fs.mkdtempSync(path.join(tmpdir(), 'novalistically-snap-'));
    const sm = new StateManager(snapDir);

    const genesis = makeEvent({ id: 'system:genesis', narrativeOrder: 0, source: 'genesis' });
    const evt1 = makeEvent({
      id: 'E1a', narrativeOrder: 1,
      pov: { character: 'seraphine', type: 'third_person_limited' },
      sceneBrief: 'Seraphine detects the signal.',
      participants: { entities: ['seraphine'] },
      postconditions: [{
        id: 's.detected', entityId: 'seraphine', attribute: 'detected_anomaly', value: true, confidence: 1.0,
        validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
      }],
    });
    const evt2 = makeEvent({
      id: 'E1b', narrativeOrder: 2,
      pov: { character: 'camille', type: 'third_person_limited' },
      sceneBrief: 'Camille takes the case.',
      participants: { entities: ['camille'] },
      postconditions: [{
        id: 'c.accepted', entityId: 'camille', attribute: 'case_status', value: 'accepted', confidence: 1.0,
        validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
      }],
    });

    sm.commit(genesis);
    sm.commit(evt1);
    sm.commit(evt2);

    const state = sm.getCurrentState();
    const events = sm.eventStore.getAll();
    const registry = new InMemoryEntityRegistry();
    registry.register({
      id: 'seraphine', kind: 'character', name: 'Seraphine',
      definitionFile: 'definitions/characters/seraphine.yaml',
      lifecycle: 'active',
      typeRef: { typeId: 'character', schemaVersion: 1 },
      state: { traits: ['empathetic', 'musical'], location: 'piltover_enforcer_headquarters' },
    });
    registry.register({
      id: 'camille', kind: 'character', name: 'Camille',
      definitionFile: 'definitions/characters/camille.yaml',
      lifecycle: 'active',
      typeRef: { typeId: 'character', schemaVersion: 1 },
      state: { traits: ['calculating'], location: 'piltover_enforcer_headquarters' },
    });

    const aggregator = new ResultAggregator();
    const results = aggregator.validateAll(events, state, registry);

    expect(results.size).toBe(2);
    expect(results.has('E1a')).toBe(true);
    expect(results.has('E1b')).toBe(true);

    for (const [eventId, result] of results) {
      expect(result.errors).toHaveLength(
        0,
        `Event ${eventId} has errors: ${JSON.stringify(result.errors)}`,
      );
    }
  });


  it('1f. Individual TimelineValidator and POVValidator produce no errors', () => {
    const registry = new InMemoryEntityRegistry();
    registry.register({
      id: 'seraphine', kind: 'character', name: 'Seraphine',
      definitionFile: 'definitions/characters/seraphine.yaml',
      lifecycle: 'active',
      typeRef: { typeId: 'character', schemaVersion: 1 },
      state: { traits: ['empathetic'] },
    });

    const event = makeEvent({
      id: 'E1a', narrativeOrder: 1,
      pov: { character: 'seraphine', type: 'third_person_limited' },
      sceneBrief: 'Seraphine detects the signal.',
      participants: { entities: ['seraphine'] },
    });
    const events = [event];
    const state: WorldState = {
      entities: {}, relationships: {}, knowledge: {},
      threads: {}, rules: {}, facts: [],
    };
    const input: PreRenderInput = {
      event,
      worldState: state,
      events,
      entityRegistry: registry,
      chapter: 1,
      queryState: () => undefined,
      getKnowledge: () => ({ worldTruth: [], characterKnowledge: {}, readerKnowledge: [], narratorKnowledge: [] }),
      getThreadProgress: () => ({ progress: 0, total: 0 }),
    };

    const tv = new TimelineValidator();
    expect(tv.validatePre(input).filter((i) => i.severity === 'error')).toHaveLength(0);

    const pv = new POVValidator();
    expect(pv.validatePre(input).filter((i) => i.severity === 'error')).toHaveLength(0);
  });
});

// ─── 2. Entity Completeness ──────────────────────────────────────────────────

describe('2. Entity Completeness', () => {
  it('2a. Characters have their traits loaded from YAML', () => {
    const data = new EntityMapper(FIXTURE_PATH).loadProject();

    // Camille
    const camille = data.characters.find((c: any) => c.id === 'camille') as any;
    expect(camille).toBeDefined();
    expect(camille.traits).toContain('calculating');
    expect(camille.traits).toContain('ruthless_when_necessary');
    expect(camille.traits).toContain('hidden_moral_code');
    expect(camille.initialState.location).toBe('piltover_enforcer_headquarters');

    // Seraphine
    const seraphine = data.characters.find((c: any) => c.id === 'seraphine') as any;
    expect(seraphine).toBeDefined();
    expect(seraphine.traits).toContain('empathetic');
    expect(seraphine.traits).toContain('musical');
    expect(seraphine.initialState.location).toBe('piltover_enforcer_headquarters');

    // Gear (NPC)
    const gear = data.characters.find((c: any) => c.id === 'gear') as any;
    expect(gear).toBeDefined();
    expect(gear.traits).toContain('greedy');
    expect(gear.traits).toContain('shimmer_addicted');
    expect(gear.initialState.condition).toBe('shimmer_damaged');
    expect(gear.initialState.location).toBe('zaun_gray_exchange');
  });

  it('2b. Locations have descriptions and initial state', () => {
    const data = new EntityMapper(FIXTURE_PATH).loadProject();

    const hq = data.locations.find((l: any) => l.id === 'piltover_enforcer_headquarters') as any;
    expect(hq).toBeDefined();
    expect(hq.name).toBe('Piltover Enforcer Headquarters');
    expect(hq.description).toBeDefined();
    expect(hq.description.length).toBeGreaterThan(0);
    expect(hq.initialState.status).toBe('operational');

    const exchange = data.locations.find((l: any) => l.id === 'zaun_gray_exchange') as any;
    expect(exchange).toBeDefined();
    expect(exchange.name).toBe('Gray Market Exchange');
    expect(exchange.description).toBeDefined();
    expect(exchange.initialState.controlledBy).toBe('zaun_underground');
  });
});

// ─── 3. Event Integrity ──────────────────────────────────────────────────────

describe('3. Event Integrity', () => {
  it('3a. E1a has narrativeOrder = 1', () => {
    const data = new EntityMapper(FIXTURE_PATH).loadProject();
    const ch1 = data.chapters.get(1)!;
    const e1a = ch1.events[0] as any;
    expect(e1a.narrativeOrder).toBe(1);
  });

  it('3b. E1a has proper POV assignment (seraphine, third_person_limited)', () => {
    const data = new EntityMapper(FIXTURE_PATH).loadProject();
    const ch1 = data.chapters.get(1)!;
    const e1a = ch1.events[0] as any;
    expect(e1a.pov.character).toBe('seraphine');
    expect(e1a.pov.type).toBe('third_person_limited');
  });

  it('3c. Scene type is valid (linear)', () => {
    const validTypes = ['linear', 'flashback', 'flashforward', 'dream', 'parallel'];
    const data = new EntityMapper(FIXTURE_PATH).loadProject();
    const ch1 = data.chapters.get(1)!;
    for (const evt of ch1.events) {
      expect(validTypes).toContain((evt as any).sceneType);
    }
  });

  it('3d. Preconditions reference known fixture entities', () => {
    const data = new EntityMapper(FIXTURE_PATH).loadProject();
    const ch1 = data.chapters.get(1)!;
    const e1a = ch1.events[0] as any;
    expect(e1a.preconditions).toBeDefined();
    expect(e1a.preconditions.length).toBeGreaterThanOrEqual(3);
    for (const pc of e1a.preconditions) {
      expect(pc.entity).toBeDefined();
      expect(typeof pc.entity).toBe('string');
      expect(pc.attribute).toBeDefined();
      expect(pc.value).toBeDefined();
    }
    // Verify preconditions reference correct entities/locations
    const text = JSON.stringify(e1a.preconditions);
    expect(text).toContain('seraphine');
    expect(text).toContain('piltover_enforcer_headquarters');
  });
});

// ─── 4. State Transitions ────────────────────────────────────────────────────

describe('4. State Transitions', () => {
  let snapDir: string;
  let sm: StateManager;

  beforeAll(() => {
    snapDir = fs.mkdtempSync(path.join(tmpdir(), 'novalistically-snap-'));
    sm = new StateManager(snapDir);
  });

  afterAll(() => {
    fs.rmSync(snapDir, { recursive: true, force: true });
  });

  it('4a. After E1a: seraphine has detected anomaly', () => {
    const e1a = makeEvent({
      id: 'E1a', narrativeOrder: 1,
      storyTime: { type: 'absolute', value: 'day_0' },
      postconditions: [{
        id: 'seraphine.detected_anomaly', entityId: 'seraphine',
        attribute: 'detected_anomaly', value: true, confidence: 1.0,
        validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
      }],
      participants: { entities: ['seraphine'] },
    });
    sm.commit(e1a);
    const state = sm.getCurrentState();
    expect(state.entities['seraphine']?.['detected_anomaly']).toBe(true);
  });

  it('4b. After E1b: camille has taken the case', () => {
    const e1b = makeEvent({
      id: 'E1b', narrativeOrder: 2,
      storyTime: { type: 'absolute', value: 'day_0' },
      postconditions: [{
        id: 'camille.accepted_case', entityId: 'camille',
        attribute: 'case_status', value: 'accepted', confidence: 1.0,
        validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
      }],
      participants: { entities: ['camille'] },
    });
    sm.commit(e1b);
    const state = sm.getCurrentState();
    expect(state.entities['camille']?.['case_status']).toBe('accepted');
  });

  it('4c. Thread T1, T2, T3 have progress after events', () => {
    const snapDir2 = fs.mkdtempSync(path.join(tmpdir(), 'novalistically-snap-'));
    const sm2 = new StateManager(snapDir2);

    const genesis = makeEvent({ id: 'genesis', narrativeOrder: 0, source: 'genesis' });
    const e1a = makeEvent({
      id: 'E1a', narrativeOrder: 1,
      threadProgress: [{ thread: 'T1', advancement: 'a', progressAfter: 20, progressTotal: 100 }],
    });
    const e1b = makeEvent({
      id: 'E1b', narrativeOrder: 2,
      threadProgress: [
        { thread: 'T1', advancement: 'b', progressAfter: 30, progressTotal: 100 },
        { thread: 'T2', advancement: 'c', progressAfter: 15, progressTotal: 100 },
        { thread: 'T3', advancement: 'd', progressAfter: 3, progressTotal: 100 },
      ],
    });

    sm2.commit(genesis);
    sm2.commit(e1a);
    sm2.commit(e1b);

    const state = sm2.getCurrentState();
    expect(state.threads['T1']).toEqual({ progress: 30, total: 100 });
    expect(state.threads['T2']).toEqual({ progress: 15, total: 100 });
    expect(state.threads['T3']).toEqual({ progress: 3, total: 100 });

    fs.rmSync(snapDir2, { recursive: true, force: true });
  });

  it('4d. ReplayEngine reconstucts state at specific narrative orders', () => {
    const replay = new ReplayEngine();
    const genesis = makeEvent({ id: 'sys:g', narrativeOrder: 0, source: 'genesis' });
    const e1a = makeEvent({
      id: 'E1a', narrativeOrder: 1,
      postconditions: [{
        id: 's.detected', entityId: 'seraphine', attribute: 'detected_anomaly', value: true, confidence: 1.0,
        validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
      }],
      threadProgress: [{ thread: 'T1', advancement: 'a', progressAfter: 20, progressTotal: 100 }],
    });
    const e1b = makeEvent({
      id: 'E1b', narrativeOrder: 2,
      postconditions: [{
        id: 'c.accepted', entityId: 'camille', attribute: 'case_status', value: 'accepted', confidence: 1.0,
        validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
      }],
      threadProgress: [{ thread: 'T1', advancement: 'b', progressAfter: 30, progressTotal: 100 }],
    });
    const allEvents = [genesis, e1a, e1b];

    // At order 0: no entity state
    expect(replay.getStateAt(allEvents, 0).entities['seraphine']).toBeUndefined();

    // At order 1: seraphine detected anomaly
    const at1 = replay.getStateAt(allEvents, 1);
    expect(at1.entities['seraphine']?.['detected_anomaly']).toBe(true);
    expect(at1.threads['T1']?.progress).toBe(20);

    // At order 2: camille accepted case
    const at2 = replay.getStateAt(allEvents, 2);
    expect(at2.entities['camille']?.['case_status']).toBe('accepted');
    expect(at2.threads['T1']?.progress).toBe(30);

    // Optimized path with snapshot
    const snap = { narrativeOrder: 0, eventId: 'sys:g', timestamp: '', state: replay.getStateAt(allEvents, 0) };
    const at1opt = replay.getStateAtOptimized(allEvents, 1, snap);
    expect(at1opt.entities['seraphine']?.['detected_anomaly']).toBe(true);
  });
});

// ─── 5. ISS Calculation ──────────────────────────────────────────────────────

describe('5. ISS Calculation', () => {
  let registry: InMemoryEntityRegistry;

  beforeAll(() => {
    registry = new InMemoryEntityRegistry();
    registry.register({
      id: 'seraphine', kind: 'character', name: 'Seraphine',
      definitionFile: 'definitions/characters/seraphine.yaml',
      lifecycle: 'active',
      typeRef: { typeId: 'character', schemaVersion: 1 },
      state: { traits: ['empathetic', 'musical', 'burdened_by_voices'], location: 'piltover_enforcer_headquarters' },
    });
    registry.register({
      id: 'camille', kind: 'character', name: 'Camille',
      definitionFile: 'definitions/characters/camille.yaml',
      lifecycle: 'active',
      typeRef: { typeId: 'character', schemaVersion: 1 },
      state: { traits: ['calculating', 'ruthless_when_necessary'], location: 'piltover_enforcer_headquarters' },
    });
    registry.register({
      id: 'gear', kind: 'character', name: 'Gear',
      definitionFile: 'definitions/characters/npcs/npc_gear.yaml',
      lifecycle: 'active',
      typeRef: { typeId: 'character', schemaVersion: 1 },
      state: { traits: ['greedy', 'cowardly', 'shimmer_addicted'], location: 'zaun_gray_exchange' },
    });
    registry.register({
      id: 'piltover_enforcer_headquarters', kind: 'location', name: 'Piltover Enforcer HQ',
      definitionFile: 'definitions/locations/piltover_enforcer_headquarters.yaml',
      lifecycle: 'active',
      typeRef: { typeId: 'location', schemaVersion: 1 },
      state: { status: 'operational' },
    });
    registry.register({
      id: 'zaun_gray_exchange', kind: 'location', name: 'Gray Market Exchange',
      definitionFile: 'definitions/locations/zaun_gray_exchange.yaml',
      lifecycle: 'active',
      typeRef: { typeId: 'location', schemaVersion: 1 },
      state: { status: 'operational' },
    });
  });

  it('5a. Overall ISS score is calculable (not NaN)', () => {
    const events: NarrativeEvent[] = [
      makeEvent({ id: 'system:genesis', narrativeOrder: 0, source: 'genesis' }),
      makeEvent({
        id: 'E1a', narrativeOrder: 1,
        pov: { character: 'seraphine', type: 'third_person_limited' },
        preconditions: [{
          id: 's.loc', entityId: 'seraphine', attribute: 'location', value: 'piltover_enforcer_headquarters', confidence: 1.0,
          validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
        }],
        postconditions: [{
          id: 's.detected', entityId: 'seraphine', attribute: 'detected_anomaly', value: true, confidence: 1.0,
          validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
        }],
        threadProgress: [{ thread: 'T1', advancement: 'a', progressAfter: 20, progressTotal: 100 }],
      }),
      makeEvent({
        id: 'E1b', narrativeOrder: 2,
        pov: { character: 'camille', type: 'third_person_limited' },
        preconditions: [{
          id: 'c.loc', entityId: 'camille', attribute: 'location', value: 'piltover_enforcer_headquarters', confidence: 1.0,
          validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
        }],
        postconditions: [{
          id: 'c.accepted', entityId: 'camille', attribute: 'case_status', value: 'accepted', confidence: 1.0,
          validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
        }],
        threadProgress: [{ thread: 'T1', advancement: 'b', progressAfter: 30, progressTotal: 100 }],
      }),
    ];
    const threads = [
      { id: 'T1', name: 'Hextech Weapon Smuggling' },
      { id: 'T2', name: "Camille's Personal Dilemma" },
      { id: 'T3', name: "Seraphine's Double Burden" },
    ];
    const rules = [
      { ruleId: 'hextech_crystal_scarcity', name: 'Hextech Crystal Scarcity', category: 'state_invariant', type: 'state_invariant', statement: '', logicalConsequences: [], evidenceChain: [] },
      { ruleId: 'shimmer_addiction_timeline', name: 'Shimmer Addiction Timeline', category: 'progression_rule', type: 'progression_rule', statement: '', logicalConsequences: [], evidenceChain: [] },
    ];

    const iss = calculateISS({ projectDir: FIXTURE_PATH, entityRegistry: registry, events, threads, rules });
    expect(iss.overall).not.toBeNaN();
    expect(typeof iss.overall).toBe('number');
    expect(iss.overall).toBeGreaterThanOrEqual(0);
    expect(iss.overall).toBeLessThanOrEqual(100);
  });

  it('5b. Has 6 dimensions with correct names', () => {
    const iss = calculateISS({
      projectDir: FIXTURE_PATH,
      entityRegistry: registry,
      events: [makeEvent({ narrativeOrder: 0, source: 'genesis' }), makeEvent({ narrativeOrder: 1 })],
      threads: [{ id: 'T1', name: 'Test' }],
      rules: [],
    });
    expect(iss.dimensions).toHaveLength(6);
    const names = iss.dimensions.map((d) => d.name);
    expect(names[0]).toMatch(/Entity Reference/);
    expect(names[1]).toMatch(/Rule Executability/);
    expect(names[2]).toMatch(/Precondition Depth/);
    expect(names[3]).toMatch(/Postcondition Specificity/);
    expect(names[4]).toMatch(/Thread/);
    expect(names[5]).toMatch(/Foreshadow/);
  });

  it('5c. Each dimension has valid score, max, threshold, and status', () => {
    const iss = calculateISS({
      projectDir: FIXTURE_PATH,
      entityRegistry: registry,
      events: [makeEvent({ narrativeOrder: 0, source: 'genesis' }), makeEvent({ narrativeOrder: 1 })],
      threads: [{ id: 'T1', name: 'Test' }],
      rules: [],
    });
    for (const dim of iss.dimensions) {
      expect(typeof dim.score).toBe('number');
      expect(dim.score).not.toBeNaN();
      expect(dim.score).toBeGreaterThanOrEqual(0);
      expect(dim.score).toBeLessThanOrEqual(dim.max);
      expect(dim.max).toBeGreaterThan(0);
      expect(dim.threshold).toBeGreaterThan(0);
      expect(['green', 'yellow', 'red']).toContain(dim.status);
      expect(Array.isArray(dim.gaps)).toBe(true);
    }
  });

  it('5d. detectAntiPatterns finds anti-patterns in fixture data', () => {
    const events: NarrativeEvent[] = [
      makeEvent({ id: 'sys:g', narrativeOrder: 0, source: 'genesis' }),
      makeEvent({
        id: 'E1a', narrativeOrder: 1,
        pov: { character: 'seraphine', type: 'third_person_limited' },
        postconditions: [{
          id: 's.a', entityId: 'seraphine', attribute: 'detected_anomaly', value: true, confidence: 1.0,
          validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
        }],
      }),
      makeEvent({
        id: 'E1b', narrativeOrder: 2,
        pov: { character: 'camille', type: 'third_person_limited' },
        // No postconditions — triggers "empty scene" anti-pattern
      }),
    ];
    const antiPatterns = detectAntiPatterns({
      entityRegistry: registry,
      events,
      threads: [
        { id: 'T1', name: 'Hextech Weapon Smuggling' },
        { id: 'T2', name: "Camille's Personal Dilemma" },
        { id: 'T3', name: "Seraphine's Double Burden" },
      ],
    });

    expect(Array.isArray(antiPatterns)).toBe(true);
    for (const issue of antiPatterns) {
      expect(issue.severity).toBe('warning');
      expect(issue.validator).toBe('iss-anti-pattern');
      expect(issue.message.length).toBeGreaterThan(0);
    }

    // E1b has no postconditions → should trigger empty-scene anti-pattern
    const emptySceneIssues = antiPatterns.filter((i) => i.message.includes('no postconditions'));
    expect(emptySceneIssues.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── 6. Assembler with Empty Scenes Directory ─────────────────────────────────

describe('6. Assembler with Empty Scenes Directory', () => {
  afterAll(() => {
    const outputPath = path.join(FIXTURE_PATH, 'output', 'novel.md');
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
  });

  it('6a. assembly rejects empty scenes directory', () => {
    expect(() => assembleNovel({ projectDir: FIXTURE_PATH, title: 'Arcane Aftermath' })).toThrow(/scene/i);
  });

  it('6b. countWords utility works correctly', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('Hello world')).toBe(2);
    expect(countWords('# Heading\nSome **bold** text.')).toBe(4);
    expect(countWords('See [link](url) here.')).toBe(3);
  });

  it('6c. assembly rejects truly empty project', () => {
    const emptyDir = fs.mkdtempSync(path.join(tmpdir(), 'novalistically-empty-'));
    fs.mkdirSync(path.join(emptyDir, 'scenes'), { recursive: true });
    fs.mkdirSync(path.join(emptyDir, 'chapters'), { recursive: true });
    fs.writeFileSync(path.join(emptyDir, 'nova.yaml'), 'project: empty\ntitle: "Empty"\nauthor: "Test"\n', 'utf-8');

    expect(() => assembleNovel({ projectDir: emptyDir, title: 'Empty' })).toThrow(/scene|chapter/i);

    fs.rmSync(emptyDir, { recursive: true, force: true });
  });
});

// ─── 7. Context Compilation ──────────────────────────────────────────────────

describe('7. Context Compilation', () => {
  let registry: InMemoryEntityRegistry;
  let compiler: ContextCompiler;

  beforeAll(() => {
    registry = new InMemoryEntityRegistry();
    registry.register({
      id: 'seraphine', kind: 'character', name: 'Seraphine',
      definitionFile: 'definitions/characters/seraphine.yaml',
      lifecycle: 'active',
      typeRef: { typeId: 'character', schemaVersion: 1 },
      state: { traits: ['empathetic', 'musical'], location: 'piltover_enforcer_headquarters' },
    });
    registry.register({
      id: 'camille', kind: 'character', name: 'Camille',
      definitionFile: 'definitions/characters/camille.yaml',
      lifecycle: 'active',
      typeRef: { typeId: 'character', schemaVersion: 1 },
      state: { traits: ['calculating', 'ruthless_when_necessary'], location: 'piltover_enforcer_headquarters' },
    });
    compiler = new ContextCompiler();
  });

  it('7a. Compiles context for E1a with all required sections', () => {
    const event = makeEvent({
      id: 'E1a', narrativeOrder: 1,
      title: 'Seraphine Detects the Anomalous Signal',
      sceneType: 'linear',
      sceneBrief: 'Seraphine detects an anomalous emotional frequency.',
      pov: { character: 'seraphine', type: 'third_person_limited' },
      storyTime: { type: 'absolute', value: 'day_0' },
      preconditions: [{
        id: 's.loc', entityId: 'seraphine', attribute: 'location', value: 'piltover_enforcer_headquarters', confidence: 1.0,
        validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
      }],
      postconditions: [{
        id: 's.detected', entityId: 'seraphine', attribute: 'detected_anomaly', value: true, confidence: 1.0,
        validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
      }],
      threadProgress: [{ thread: 'T1', advancement: 'a', progressAfter: 20, progressTotal: 100 }],
      participants: { entities: ['seraphine'] },
    });
    const state: WorldState = {
      entities: { seraphine: { location: 'piltover_enforcer_headquarters', status: 'alive', detected_anomaly: true } },
      relationships: {}, knowledge: {},
      threads: { T1: { progress: 20, total: 100 } },
      rules: {}, facts: [],
    };

    const pkg = compiler.compile(event, state, registry);
    expect(pkg.eventId).toBe('E1a');
    expect(pkg.systemContext.genre).toBe('literary');
    expect(pkg.systemContext.style).toBe('literary');
    expect(pkg.sceneSpec.goal).toContain('anomalous');
    expect(pkg.sceneSpec.povCharacter).toBe('seraphine');
    expect(pkg.sceneSpec.povType).toBe('third_person_limited');

    // Character snapshot for seraphine
    const snap = pkg.characterSnapshots.find((cs) => cs.id === 'seraphine');
    expect(snap).toBeDefined();
    expect(snap!.traits).toContain('empathetic');
    expect(snap!.currentState).toBeDefined();

    // Thread status
    const t1 = pkg.activeThreads.find((t) => t.id === 'T1');
    expect(t1).toBeDefined();
    expect(t1!.progress).toBe(20);
    expect(t1!.total).toBe(100);
  });

  it('7b. Context package includes system context, scene spec, character snapshots', () => {
    const event = makeEvent({
      id: 'test:ctx', narrativeOrder: 1,
      sceneBrief: 'A test scene.',
      pov: { character: 'camille', type: 'third_person_limited' },
      participants: { entities: ['camille'] },
    });
    const state: WorldState = {
      entities: {}, relationships: {}, knowledge: {},
      threads: {}, rules: {}, facts: [],
    };
    const pkg = compiler.compile(event, state, registry, {
      systemContext: { genre: 'dark fantasy', style: 'noir', narrativeRules: ['Show don\'t tell'] },
      activeThreadIds: ['T1', 'T2'],
    });

    expect(pkg.systemContext.genre).toBe('dark fantasy');
    expect(pkg.systemContext.narrativeRules).toHaveLength(1);
    expect(pkg.sceneSpec.povCharacter).toBe('camille');
    expect(pkg.sceneSpec.povType).toBe('third_person_limited');
    expect(Array.isArray(pkg.characterSnapshots)).toBe(true);
    expect(pkg.knowledgeBoundary.characterId).toBe('camille');
  });

  it('7c. Markdown output is non-empty with expected sections', () => {
    const event = makeEvent({
      id: 'E1a', narrativeOrder: 1,
      sceneBrief: 'Test.',
      pov: { character: 'seraphine', type: 'third_person_limited' },
    });
    const state: WorldState = {
      entities: {}, relationships: {}, knowledge: {},
      threads: {}, rules: {}, facts: [],
    };
    const pkg = compiler.compile(event, state, registry);
    expect(pkg.markdown.length).toBeGreaterThan(0);
    expect(pkg.markdown).toContain('# Context Package: E1a');
    expect(pkg.markdown).toContain('## System Context');
    expect(pkg.markdown).toContain('## Scene Specification');
    expect(pkg.markdown).toContain('## Characters');
    expect(pkg.markdown).toContain('## POV Knowledge Boundary');
  });

  it('7d. ContextCompiler.inspect returns JSON with eventId, counts', () => {
    const event = makeEvent({
      id: 'test:inspect', narrativeOrder: 1,
      pov: { character: 'camille', type: 'third_person_limited' },
    });
    const state: WorldState = {
      entities: {}, relationships: {}, knowledge: {},
      threads: { T1: { progress: 50, total: 100 } },
      rules: {}, facts: [],
    };
    const pkg = compiler.compile(event, state, registry, { activeThreadIds: ['T1'] });
    const parsed = JSON.parse(compiler.inspect(pkg));
    expect(parsed.eventId).toBe('test:inspect');
    expect(typeof parsed.characterCount).toBe('number');
    expect(typeof parsed.relationshipCount).toBe('number');
    expect(typeof parsed.worldFactCount).toBe('number');
    expect(parsed.threadCount).toBeGreaterThanOrEqual(1);
  });
});

// ─── 8. Cross-cutting: Full Pipeline Smoke Test ─────────────────────────────

describe('8. Cross-cutting Pipeline Smoke Test', () => {
  let snapDir: string;

  beforeAll(() => {
    snapDir = fs.mkdtempSync(path.join(tmpdir(), 'novalistically-smoke-'));
  });

  afterAll(() => {
    const outputPath = path.join(FIXTURE_PATH, 'output', 'novel.md');
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    try { fs.rmSync(snapDir, { recursive: true, force: true }); } catch {}
  });

  it('8a. End-to-end: load → registry → state → validate → ISS → assembler → context', () => {
    // 1. LOAD
    const mapper = new EntityMapper(FIXTURE_PATH);
    const data = mapper.loadProject();
    expect(data.config).not.toBeNull();
    expect(data.chapters.size).toBe(1);

    // 2. REGISTRY (manual due to ruleId crash)
    const registry = new InMemoryEntityRegistry();
    registry.register({
      id: 'seraphine', kind: 'character', name: 'Seraphine',
      definitionFile: 'definitions/characters/seraphine.yaml',
      lifecycle: 'active',
      typeRef: { typeId: 'character', schemaVersion: 1 },
      state: { traits: ['empathetic'], location: 'piltover_enforcer_headquarters' },
    });
    registry.register({
      id: 'camille', kind: 'character', name: 'Camille',
      definitionFile: 'definitions/characters/camille.yaml',
      lifecycle: 'active',
      typeRef: { typeId: 'character', schemaVersion: 1 },
      state: { traits: ['calculating'], location: 'piltover_enforcer_headquarters' },
    });

    // 3. STATE
    const sm = new StateManager(snapDir);
    const genesis = makeEvent({
      id: 'system:genesis', narrativeOrder: 0, source: 'genesis',
      postconditions: [{
        id: 'world.init', entityId: 'world', attribute: 'status', value: 'post_arcane_s1', confidence: 1.0,
        validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
      }],
    });
    const e1a = makeEvent({
      id: 'E1a', narrativeOrder: 1,
      pov: { character: 'seraphine', type: 'third_person_limited' },
      sceneBrief: 'Seraphine detects signal.',
      participants: { entities: ['seraphine'] },
      postconditions: [{
        id: 's.detected', entityId: 'seraphine', attribute: 'detected_anomaly', value: true, confidence: 1.0,
        validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
      }],
    });
    const e1b = makeEvent({
      id: 'E1b', narrativeOrder: 2,
      pov: { character: 'camille', type: 'third_person_limited' },
      sceneBrief: 'Camille takes case.',
      participants: { entities: ['camille'] },
      postconditions: [{
        id: 'c.accepted', entityId: 'camille', attribute: 'case_status', value: 'accepted', confidence: 1.0,
        validity: { temporal: { start: { type: 'absolute', value: 'day_0' }, end: null }, branches: { type: 'all' } },
      }],
    });
    sm.commit(genesis);
    sm.commit(e1a);
    sm.commit(e1b);
    expect(sm.eventStore.count).toBe(3);

    // 4. VALIDATE
    const aggregator = new ResultAggregator();
    const state = sm.getCurrentState();
    const events = sm.eventStore.getAll();
    const results = aggregator.validateAll(events, state, registry);
    expect(results.size).toBe(2);
    for (const [, r] of results) expect(r.errors).toHaveLength(0);

    // 5. ISS
    const iss = calculateISS({
      projectDir: FIXTURE_PATH,
      entityRegistry: registry,
      events,
      threads: [
        { id: 'T1', name: 'Hextech Weapon Smuggling' },
        { id: 'T2', name: "Camille's Personal Dilemma" },
        { id: 'T3', name: "Seraphine's Double Burden" },
      ],
      rules: [
        { ruleId: 'hextech_crystal_scarcity', name: 'Hextech Crystal Scarcity', category: '', type: '', statement: '', logicalConsequences: [], evidenceChain: [] },
        { ruleId: 'shimmer_addiction_timeline', name: 'Shimmer Addiction Timeline', category: '', type: '', statement: '', logicalConsequences: [], evidenceChain: [] },
      ],
    });
    expect(iss.overall).not.toBeNaN();
    expect(iss.overall).toBeGreaterThanOrEqual(0);

    // 6. ASSEMBLER
    expect(() => assembleNovel({ projectDir: FIXTURE_PATH, title: 'Smoke Test' })).toThrow(/scene/i);

    // 7. CONTEXT
    const ctx = new ContextCompiler().compile(e1a, state, registry);
    expect(ctx.markdown.length).toBeGreaterThan(0);
    expect(ctx.markdown).toContain('# Context Package: E1a');
  });
});

