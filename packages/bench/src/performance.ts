// ============================================================================
// Performance Benchmarks — Measure pipeline stages at 10 / 100 / 1000 events
// ============================================================================

import type { NarrativeEvent, WorldState } from '@novalistically/core';

import {
  InMemoryEntityRegistry,
  TimelineValidator,
  CharacterStateValidator,
  KnowledgeValidator,
  WorldRuleValidator,
  CausalityValidator,
  ForeshadowingValidator,
  POVValidator,
  FactualDetailValidator,
  VoiceDriftDetector,
  BranchMergeValidator,
  ReachabilityValidator,
  ResultAggregator,
  ContextCompiler,
  ReplayEngine,
  calculateISS,
} from '@novalistically/core';

import { makeCtx } from './context-helper.js';

export interface PerfMeasurement {
  name: string;
  hz: number;
  meanMs: number;
  samples: number;
  scale: string;
}

export interface PerfResults {
  measurements: PerfMeasurement[];
  raw: Record<string, { hz: number; meanMs: number; samples: number }>;
}

// ─── Event Factory — generate synthetic NarrativeEvent[] ───────────────────

const CHARACTERS = [
  'raincourt', 'zariel', 'mira', 'doran', 'carissa',
  'theron', 'lydia', 'balthus', 'elara', 'finn',
];
const LOCATIONS = [
  'ship_deck', 'cabin', 'island_beach', 'jungle_trail',
  'cliff_edge', 'cave', 'mountain_pass', 'swamp',
  'fortress_wall', 'great_hall',
];
const THREADS = [
  'survival', 'mystery_of_island', 'hunter_and_hunted', 'trust',
];

let eventCounter = 0;

function makeSyntheticEvent(): NarrativeEvent {
  eventCounter++;
  const idx = eventCounter;
  const char1 = CHARACTERS[idx % CHARACTERS.length];
  const char2 = CHARACTERS[(idx + 1) % CHARACTERS.length];
  const loc = LOCATIONS[idx % LOCATIONS.length];
  const thread = THREADS[idx % THREADS.length];

  return {
    id: `E${idx}`,
    event: `E${idx}`,
    narrativeOrder: idx,
    title: `Synthetic Event ${idx}`,
    storyTime: { type: 'absolute', value: `day_${idx}` },
    sceneType: idx % 5 === 0 ? 'flashback' : 'linear',
    pov: { character: char1, type: 'third_person_limited' as const },
    sceneBrief: `Scene ${idx}: ${char1} encounters ${char2} at ${loc}.`,
    preconditions: [
      {
        id: `${char1}.location`,
        entityId: char1,
        attribute: 'location',
        value: loc,
        validity: {
          temporal: { start: { type: 'absolute', value: 'day_0' }, end: null },
          branches: { type: 'all' as const },
        },
      },
      {
        id: `${char1}.alive`,
        entityId: char1,
        attribute: 'alive',
        value: true,
        validity: {
          temporal: { start: { type: 'absolute', value: 'day_0' }, end: null },
          branches: { type: 'all' as const },
        },
      },
    ],
    postconditions: [
      {
        id: `${char1}.state`,
        entityId: char1,
        attribute: `state_after_E${idx}`,
        value: `advanced_${idx}`,
        validity: {
          temporal: { start: { type: 'absolute', value: 'day_0' }, end: null },
          branches: { type: 'all' as const },
        },
      },
      {
        id: `${char2}.state`,
        entityId: char2,
        attribute: `state_after_E${idx}`,
        value: `noticed_${idx}`,
        validity: {
          temporal: { start: { type: 'absolute', value: 'day_0' }, end: null },
          branches: { type: 'all' as const },
        },
      },
    ],
    threadProgress: [
      { thread, advancement: `0.${idx}`, progressAfter: idx, progressTotal: 100 },
    ],
    foreshadowing: idx % 3 === 0 ? [
      { id: `f_shadow_${idx}`, hint: `Something ominous about ${char2}`, targetRevealChapter: Math.min(idx + 3, 12) },
    ] : [],
    relationshipEffects: idx % 2 === 0 ? [{
      participants: [char1, char2] as [string, string],
      effect: 'reinforce' as const,
      direction: `${char1} -> ${char2}`,
      newState: { type: 'acquainted', intensity: 0.5 + (idx * 0.01) },
    }] : [],
    ruleEffects: [],
    source: 'event_file' as const,
    branchExistence: { type: 'all' as const },
    participants: { entities: [char1, char2] },
  };
}

function makeGenesisEvent(): NarrativeEvent {
  return {
    id: 'system:genesis',
    event: 'system:genesis',
    narrativeOrder: 0,
    title: 'World Genesis',
    storyTime: { type: 'absolute', value: 'day_0' },
    sceneType: 'linear',
    pov: { character: 'system', type: 'omniscient' },
    sceneBrief: 'Initial world state.',
    preconditions: [],
    postconditions: [
      {
        id: 'world.init',
        entityId: 'world',
        attribute: 'status',
        value: 'active',
        validity: {
          temporal: { start: { type: 'absolute', value: 'day_0' }, end: null },
          branches: { type: 'all' as const },
        },
      },
    ],
    threadProgress: [],
    foreshadowing: [],
    relationshipEffects: [],
    ruleEffects: [],
    source: 'genesis',
    branchExistence: { type: 'all' },
    participants: { entities: [] },
  };
}

function makeSyntheticEntities(registry: InMemoryEntityRegistry): void {
  for (const char of CHARACTERS) {
    registry.register({
      id: char,
      kind: 'character',
      name: char.charAt(0).toUpperCase() + char.slice(1),
      definitionFile: `definitions/characters/${char}.yaml`,
      state: {
        status: 'alive',
        alive: true,
        traits: ['brave', 'resourceful', 'cautious_observer'],
      },
    });
  }
  for (const loc of LOCATIONS) {
    registry.register({
      id: loc,
      kind: 'location',
      name: loc.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      definitionFile: `definitions/locations/${loc}.yaml`,
      state: { explored: false },
    });
  }
}

// ─── Manual timing helper ──────────────────────────────────────────────────

function timeIt(fn: () => void, iterations = 10): { meanMs: number; hz: number; samples: number } {
  // Warmup
  for (let i = 0; i < 3; i++) fn();

  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    fn();
    const elapsed = performance.now() - start;
    if (elapsed > 0) samples.push(elapsed);
  }

  const meanMs = samples.reduce((a, b) => a + b, 0) / samples.length;
  const hz = meanMs > 0 ? 1000 / meanMs : 0;
  return { meanMs, hz, samples: samples.length };
}

// ─── Benchmark runner ──────────────────────────────────────────────────────

export async function runPerformanceBench(): Promise<PerfResults> {
  const measurements: PerfMeasurement[] = [];
  const raw: Record<string, { hz: number; meanMs: number; samples: number }> = {};

  for (const scale of ['10', '100', '1000']) {
    const n = parseInt(scale, 10);
    eventCounter = 0;

    // Build synthetic events
    const events: NarrativeEvent[] = [makeGenesisEvent()];
    for (let i = 0; i < n; i++) {
      events.push(makeSyntheticEvent());
    }

    // Build registry
    const registry = new InMemoryEntityRegistry();
    makeSyntheticEntities(registry);

    // Build state via replay
    const replay = new ReplayEngine();
    const state = replay.replay(events);

    // Instantiate all validators once
    const timelineVal = new TimelineValidator();
    const charStateVal = new CharacterStateValidator();
    const knowledgeVal = new KnowledgeValidator();
    const worldRuleVal = new WorldRuleValidator();
    const causalityVal = new CausalityValidator();
    const foreshadowVal = new ForeshadowingValidator();
    const povVal = new POVValidator();
    const factualVal = new FactualDetailValidator();
    const voiceVal = new VoiceDriftDetector();
    const branchVal = new BranchMergeValidator();
    const reachVal = new ReachabilityValidator();
    const aggregator = new ResultAggregator();
    const compiler = new ContextCompiler();

    const narrativeEvents = events.filter((e) => e.id !== 'system:genesis');
    const lastEvent = narrativeEvents[narrativeEvents.length - 1];

    // Number of timing iterations per scale
    const iters = n >= 1000 ? 3 : n >= 100 ? 5 : 10;

    // a. Run all validators
    {
      const r = timeIt(() => {
        for (const event of narrativeEvents) {
          const ctx = makeCtx(event, state, registry, events);
          timelineVal.validate(event, ctx);
          charStateVal.validate(event, ctx);
          knowledgeVal.validate(event, ctx);
          worldRuleVal.validate(event, ctx);
          causalityVal.validate(event, ctx);
          foreshadowVal.validate(event, ctx);
          povVal.validate(event, ctx);
          factualVal.validate(event, ctx);
          voiceVal.validate(event, ctx);
          branchVal.validate(event, ctx);
          reachVal.validate(event, ctx);
        }
      }, iters);
      const name = `Run all validators (N=${scale})`;
      measurements.push({ name, ...r, scale });
      raw[name] = r;
    }

    // b. ResultAggregator
    {
      const r = timeIt(() => {
        aggregator.validateAll(events, state, registry);
      }, iters);
      const name = `ResultAggregator (N=${scale})`;
      measurements.push({ name, ...r, scale });
      raw[name] = r;
    }

    // c. Calculate ISS
    {
      const r = timeIt(() => {
        calculateISS({
          projectDir: '/dev/null',
          entityRegistry: registry,
          events,
          threads: THREADS.map((id) => ({ id, name: id })),
          rules: [],
        });
      }, iters);
      const name = `Calculate ISS (N=${scale})`;
      measurements.push({ name, ...r, scale });
      raw[name] = r;
    }

    // d. Replay state from genesis
    {
      const r = timeIt(() => {
        replay.replay(events);
      }, iters);
      const name = `Replay state (N=${scale})`;
      measurements.push({ name, ...r, scale });
      raw[name] = r;
    }

    // e. Compile context for last event
    if (lastEvent) {
      const r = timeIt(() => {
        compiler.compile(lastEvent, state, registry);
      }, iters);
      const name = `Compile context (N=${scale})`;
      measurements.push({ name, ...r, scale });
      raw[name] = r;
    }
  }

  return { measurements, raw };
}
