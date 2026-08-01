// ============================================================================
// Performance Benchmarks — Measure pipeline stages at 10 / 100 / 1000 events
// ============================================================================

import * as os from 'node:os';
import type {
  AttributeDefinition,
  EntityCatalogContext,
  EntityDeclaration,
  EntityDeclarationCatalog,
  EntityKind,
  EntityTypeCatalog,
  EntityTypeDefinition,
  Fact,
  NarrativeEvent,
  RelationshipTransaction,
} from '@novalistically/core';
import {
  BranchMergeValidator,
  CausalityValidator,
  CharacterStateValidator,
  ContextCompiler,
  calculateISS,
  compileStoryRuntimeGraph,
  computeEvidenceHash,
  FactualDetailValidator,
  ForeshadowingValidator,
  getCachedRender,
  InMemoryEntityRegistry,
  KnowledgeValidator,
  MemoryStorage,
  POVValidator,
  ReachabilityValidator,
  ReplayEngine,
  ResultAggregator,
  setCachedRender,
  TimelineValidator,
  VoiceDriftDetector,
  WorldRuleValidator,
} from '@novalistically/core';
import { z } from 'zod';
import { makePreInput } from './context-helper.js';

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
  /** Offline core path benchmark results (N=100, 5 iterations per stage) */
  offlineCorePath?: {
    stages: Array<{
      name: string;
      medianMs: number;
      meanMs: number;
      p95Ms: number;
      hz: number;
    }>;
    totalElapsedMs: number;
    hardware: { cpu: string; cores: number; os: string; nodeVersion: string; loadAvg: number[] };
  };
  /** Cache cold/warm benchmark */
  cache?: {
    coldRun: CacheStats;
    warmRun: CacheStats;
    speedup: number;
  };
  /** Pool efficiency results */
  pool?: PoolEfficiencyResult[];
}

export interface CacheStats {
  cacheHits: number;
  cacheMisses: number;
  totalAttempts: number;
  elapsedMs: number;
  hitRate: number;
}

export interface PoolEfficiencyResult {
  poolSize: number;
  meanMs: number;
  medianMs: number;
  p95Ms: number;
  speedup: number;
  efficiency: number;
}

// ─── Event Factory — generate synthetic NarrativeEvent[] ───────────────────

const CHARACTERS = [
  'raincourt',
  'zariel',
  'mira',
  'doran',
  'carissa',
  'theron',
  'lydia',
  'balthus',
  'elara',
  'finn',
];
const LOCATIONS = [
  'ship_deck',
  'cabin',
  'island_beach',
  'jungle_trail',
  'cliff_edge',
  'cave',
  'mountain_pass',
  'swamp',
  'fortress_wall',
  'great_hall',
];
const THREADS = ['survival', 'mystery_of_island', 'hunter_and_hunted', 'trust'];

let eventCounter = 0;

function makeSyntheticEvent(): NarrativeEvent {
  eventCounter++;
  const idx = eventCounter;
  const char1 = CHARACTERS[idx % CHARACTERS.length];
  const char2 = CHARACTERS[(idx + 1) % CHARACTERS.length];
  const loc = LOCATIONS[idx % LOCATIONS.length];
  const thread = THREADS[idx % THREADS.length];

  return {
    kind: 'event',
    id: `E${idx}`,
    event: `E${idx}`,
    narrativeOrder: idx,
    title: `Synthetic Event ${idx}`,
    storyTime: { type: 'absolute', value: `day_${idx}` },
    sceneType: idx % 5 === 0 ? 'flashback' : 'linear',
    pov: { character: char1, type: 'third_person_limited' as const },
    sceneBrief: `Scene ${idx}: ${char1} encounters ${char2} at ${loc}.`,
    beats: [`${char1} encounters ${char2} at ${loc}.`],
    preconditions: [],
    postconditions: [
      {
        id: `${char1}.state`,
        entityId: char1,
        attribute: 'state',
        value: `advanced_${idx}`,
        validity: {
          temporal: { start: { type: 'absolute', value: 'day_0' }, end: null },
          branches: { type: 'all' as const },
        },
      },
      {
        id: `${char2}.state`,
        entityId: char2,
        attribute: 'state',
        value: `noticed_${idx}`,
        validity: {
          temporal: { start: { type: 'absolute', value: 'day_0' }, end: null },
          branches: { type: 'all' as const },
        },
      },
    ],
    threadProgress: [{ thread, advancement: `0.${idx}`, progressAfter: idx, progressTotal: 100 }],
    foreshadowing:
      idx % 3 === 0
        ? [
            {
              id: `f_shadow_${idx}`,
              hint: `Something ominous about ${char2}`,
              targetRevealChapter: Math.min(idx + 3, 12),
            },
          ]
        : [],
    relationshipEffects:
      idx % 2 === 0
        ? ([
            {
              effectId: `perf_rel_${idx}`,
              relationshipId: `rel_${[char1, char2].sort().join('_')}`,
              epochId: 'epoch_1',
              lifecycleAfter: 'active' as const,
              membershipAfter: [
                { membershipId: `mem_${char1}_${idx}`, entityId: char1, role: 'member' },
                { membershipId: `mem_${char2}_${idx}`, entityId: char2, role: 'member' },
              ],
              dimensionSet: [
                {
                  dimensionId: 'direction',
                  scope: 'global' as const,
                  value: `${char1} -> ${char2}`,
                },
                { dimensionId: 'type', scope: 'global' as const, value: 'acquainted' },
                { dimensionId: 'intensity', scope: 'global' as const, value: 0.5 + idx * 0.01 },
              ],
              provenance: 'bench:performance',
            },
          ] as unknown as RelationshipTransaction[])
        : [],
    ruleEffects: [],
    source: 'event_file' as const,
    branchExistence: { type: 'all' as const },
    participants: { entities: [char1, char2] },
  };
}

function makeSyntheticEntities(registry: InMemoryEntityRegistry): void {
  for (const char of CHARACTERS) {
    registry.register({
      id: char,
      kind: 'character',
      name: char.charAt(0).toUpperCase() + char.slice(1),
      definitionFile: `definitions/characters/${char}.yaml`,
      lifecycle: 'active',
      typeRef: { typeId: 'character', schemaVersion: 1 },
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
      lifecycle: 'active',
      typeRef: { typeId: 'location', schemaVersion: 1 },
      state: { explored: false },
    });
  }
}

// ─── Synthetic Catalog Context — the one shared catalog pair ───────────────
//
// This benchmark is explicitly synthetic and lower-level: it never loads a
// project through the kernel. Instead every synthetic entity and attribute is
// declared up front so replay's write gate (validateCatalogWrite) accepts the
// corpus, and the same context object is threaded to ReplayEngine /
// ResultAggregator / story-boundary compilation.

function syntheticAttribute(attributeId: string, valueSchema: z.ZodTypeAny): AttributeDefinition {
  return {
    attributeId,
    valueSchema,
    requiredAt: 'never',
    writePolicy: 'mutable',
    unsetAllowed: true,
  };
}

const characterType: EntityTypeDefinition = {
  typeRef: { typeId: 'character', schemaVersion: 1 },
  kind: 'character',
  attributes: {
    status: syntheticAttribute('status', z.string()),
    state: syntheticAttribute('state', z.string()),
  },
  lifecyclePolicy: {
    allowedTransitions: [
      ['active', 'inactive'],
      ['active', 'retired'],
      ['inactive', 'active'],
      ['inactive', 'retired'],
    ],
  },
  referenceCapabilities: { defaultEligibility: 'live' },
  typedInvariants: [],
};

const locationType: EntityTypeDefinition = {
  typeRef: { typeId: 'location', schemaVersion: 1 },
  kind: 'location',
  attributes: {
    explored: syntheticAttribute('explored', z.boolean()),
  },
  lifecyclePolicy: {
    allowedTransitions: [
      ['active', 'inactive'],
      ['active', 'retired'],
      ['inactive', 'active'],
      ['inactive', 'retired'],
    ],
  },
  referenceCapabilities: { defaultEligibility: 'live' },
  typedInvariants: [],
};

const syntheticEntityTypeCatalog: EntityTypeCatalog = {
  types: {
    character: characterType,
    location: locationType,
  },
  version: 1,
};

function syntheticDeclaration(
  entityId: string,
  kind: EntityKind,
  name: string,
  definitionFile: string,
): EntityDeclaration {
  return {
    entityId,
    typeRef: { typeId: kind, schemaVersion: 1 },
    immutableMetadata: { name, definitionFile },
    introduction: { type: 'initial' },
  };
}

const syntheticEntityDeclarationCatalog: EntityDeclarationCatalog = {
  declarations: Object.fromEntries([
    ...CHARACTERS.map((char) => [
      char,
      syntheticDeclaration(
        char,
        'character',
        char.charAt(0).toUpperCase() + char.slice(1),
        `definitions/characters/${char}.yaml`,
      ),
    ]),
    ...LOCATIONS.map((loc) => [
      loc,
      syntheticDeclaration(
        loc,
        'location',
        loc.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        `definitions/locations/${loc}.yaml`,
      ),
    ]),
  ]),
  version: 1,
};

/** The one shared catalog pair for every synthetic replay in this file. */
const syntheticCatalogContext: EntityCatalogContext = {
  entityDeclarationCatalog: syntheticEntityDeclarationCatalog,
  entityTypeCatalog: syntheticEntityTypeCatalog,
};

/**
 * Initial activation facts for every declared synthetic entity. The write gate
 * requires initial-activated entities to be live (activated via initial facts)
 * before any event write or participant reference.
 */
const syntheticInitialFacts: Fact[] = [
  ...CHARACTERS.map((char) => ({
    id: `init:${char}`,
    entityId: char,
    attribute: 'status',
    value: 'alive',
    validity: {
      temporal: { start: { type: 'absolute' as const, value: 'day_0' }, end: null },
      branches: { type: 'all' as const },
    },
  })),
  ...LOCATIONS.map((loc) => ({
    id: `init:${loc}`,
    entityId: loc,
    attribute: 'explored',
    value: false,
    validity: {
      temporal: { start: { type: 'absolute' as const, value: 'day_0' }, end: null },
      branches: { type: 'all' as const },
    },
  })),
];

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

    // Build synthetic events (no genesis event — the corpus is ordinary events)
    const events: NarrativeEvent[] = [];
    for (let i = 0; i < n; i++) {
      events.push(makeSyntheticEvent());
    }

    // Build registry
    const registry = new InMemoryEntityRegistry();
    makeSyntheticEntities(registry);

    // Build state via replay over the shared synthetic catalog
    const replay = new ReplayEngine(syntheticCatalogContext);
    const state = replay.replay(events, { initialFacts: syntheticInitialFacts });

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
    const aggregator = new ResultAggregator(
      undefined,
      undefined,
      undefined,
      undefined,
      syntheticCatalogContext.entityTypeCatalog,
    );
    const compiler = new ContextCompiler();

    const lastEvent = events[events.length - 1];

    // Number of timing iterations per scale
    const iters = n >= 1000 ? 3 : n >= 100 ? 5 : 10;

    // a. Run all validators
    {
      const r = timeIt(() => {
        for (const event of events) {
          const input = makePreInput(event, state, registry, events);
          timelineVal.validatePre(input);
          charStateVal.validatePre(input);
          knowledgeVal.validatePre(input);
          worldRuleVal.validatePre(input);
          causalityVal.validatePre(input);
          foreshadowVal.validatePre(input);
          povVal.validatePre(input);
          factualVal.validatePre(input);
          voiceVal.validatePre(input);
          branchVal.validatePre(input);
          reachVal.validatePre(input);
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

    // d. Replay state over the synthetic corpus
    {
      const r = timeIt(() => {
        replay.replay(events, { initialFacts: syntheticInitialFacts });
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

// ─── Statistical Helpers ──────────────────────────────────────────────────

function calcMedian(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function calcP95(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.max(0, idx)];
}

function calcMean(samples: number[]): number {
  return samples.length === 0 ? 0 : samples.reduce((a, b) => a + b, 0) / samples.length;
}

/** Collect raw timing samples (with warmup) */
function collectSamples(fn: () => void, iterations: number): number[] {
  for (let i = 0; i < 3; i++) fn();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    fn();
    const elapsed = performance.now() - start;
    if (elapsed > 0) samples.push(elapsed);
  }
  return samples;
}

// ─── Offline Core Path Benchmark (N=100) ──────────────────────────────────

/**
 * Run the N=100 offline core path benchmark.
 *
 * Measures 6 stages (load, dag, replay, context, validate, assembly)
 * with 5 iterations each, returning median/mean/p95 per stage + cache +
 * pool efficiency results.
 */
export function runOfflineCorePathBench(): PerfResults {
  const ITERATIONS = 5;
  const N = 100;
  eventCounter = 0;

  // ── Build synthetic corpus (no genesis event) ──────────────────────────
  const events: NarrativeEvent[] = [];
  for (let i = 0; i < N; i++) {
    events.push(makeSyntheticEvent());
  }
  const registry = new InMemoryEntityRegistry();
  makeSyntheticEntities(registry);

  const stages: Array<{
    name: string;
    medianMs: number;
    meanMs: number;
    p95Ms: number;
    hz: number;
  }> = [];
  const allSamples: Record<string, number[]> = {};

  // 1. load — time to generate events + registry (already done above; re-run)
  {
    const samples = collectSamples(() => {
      eventCounter = 0;
      const e: NarrativeEvent[] = [];
      for (let i = 0; i < N; i++) e.push(makeSyntheticEvent());
      const r = new InMemoryEntityRegistry();
      makeSyntheticEntities(r);
    }, ITERATIONS);

    allSamples['load'] = samples;
    const sorted = [...samples].sort((a, b) => a - b);
    const meanMs = calcMean(samples);
    stages.push({
      name: 'load',
      medianMs: calcMedian(sorted),
      meanMs,
      p95Ms: calcP95(sorted),
      hz: meanMs > 0 ? 1000 / meanMs : 0,
    });
  }

  // 2. compile — compileStoryRuntimeGraph
  {
    const samples = collectSamples(() => {
      compileStoryRuntimeGraph({
        events,
        initialFacts: syntheticInitialFacts,
        initialThreads: [],
        timeAnchors: [],
        branchPath: { decisions: [] },
      });
    }, ITERATIONS);
    allSamples['compile'] = samples;
    const sorted = [...samples].sort((a, b) => a - b);
    const meanMs = calcMean(samples);
    stages.push({
      name: 'compile',
      medianMs: calcMedian(sorted),
      meanMs,
      p95Ms: calcP95(sorted),
      hz: meanMs > 0 ? 1000 / meanMs : 0,
    });
  }

  // 3. replay — ReplayEngine.replay
  const replay = new ReplayEngine(syntheticCatalogContext);
  {
    const samples = collectSamples(() => {
      replay.replay(events, { initialFacts: syntheticInitialFacts });
    }, ITERATIONS);
    allSamples['replay'] = samples;
    const sorted = [...samples].sort((a, b) => a - b);
    const meanMs = calcMean(samples);
    stages.push({
      name: 'replay',
      medianMs: calcMedian(sorted),
      meanMs,
      p95Ms: calcP95(sorted),
      hz: meanMs > 0 ? 1000 / meanMs : 0,
    });
  }

  // 4. context — compile context for each event
  const compiler = new ContextCompiler();
  const state = replay.replay(events, { initialFacts: syntheticInitialFacts });
  {
    const samples = collectSamples(() => {
      for (const event of events) {
        compiler.compile(event, state, registry);
      }
    }, ITERATIONS);
    allSamples['context'] = samples;
    const sorted = [...samples].sort((a, b) => a - b);
    const meanMs = calcMean(samples);
    stages.push({
      name: 'context',
      medianMs: calcMedian(sorted),
      meanMs,
      p95Ms: calcP95(sorted),
      hz: meanMs > 0 ? 1000 / meanMs : 0,
    });
  }

  // 5. validate — ResultAggregator.validateAll (pre-render only)
  const aggregator = new ResultAggregator(
    undefined,
    undefined,
    undefined,
    undefined,
    syntheticCatalogContext.entityTypeCatalog,
  );
  {
    const samples = collectSamples(() => {
      aggregator.validateAll(events, state, registry);
    }, ITERATIONS);
    allSamples['validate'] = samples;
    const sorted = [...samples].sort((a, b) => a - b);
    const meanMs = calcMean(samples);
    stages.push({
      name: 'validate',
      medianMs: calcMedian(sorted),
      meanMs,
      p95Ms: calcP95(sorted),
      hz: meanMs > 0 ? 1000 / meanMs : 0,
    });
  }

  // 6. assembly — calculateISS
  {
    const samples = collectSamples(() => {
      calculateISS({
        projectDir: '/dev/null',
        entityRegistry: registry,
        events,
        threads: THREADS.map((id) => ({ id, name: id })),
        rules: [],
      });
    }, ITERATIONS);
    allSamples['assembly'] = samples;
    const sorted = [...samples].sort((a, b) => a - b);
    const meanMs = calcMean(samples);
    stages.push({
      name: 'assembly',
      medianMs: calcMedian(sorted),
      meanMs,
      p95Ms: calcP95(sorted),
      hz: meanMs > 0 ? 1000 / meanMs : 0,
    });
  }

  const totalElapsedMs = Object.values(allSamples)
    .flat()
    .reduce((a, b) => a + b, 0);

  const hardware = {
    cpu: os.cpus()[0]?.model ?? 'unknown',
    cores: os.cpus().length,
    os: `${os.platform()} ${os.release()}`,
    nodeVersion: process.version,
    loadAvg: os.loadavg(),
  };

  return {
    measurements: stages.map((s) => ({
      name: `offline:${s.name}`,
      hz: s.hz,
      meanMs: s.meanMs,
      samples: ITERATIONS,
      scale: 'N=100',
    })),
    raw: Object.fromEntries(
      Object.entries(allSamples).map(([k, v]) => [
        `offline:${k}`,
        { hz: calcMean(v) > 0 ? 1000 / calcMean(v) : 0, meanMs: calcMean(v), samples: v.length },
      ]),
    ),
    offlineCorePath: {
      stages,
      totalElapsedMs,
      hardware,
    },
  };
}

// ─── Cache Benchmark ──────────────────────────────────────────────────────

/**
 * Run a cold/warm cache benchmark on N=100 synthetic events.
 *
 * Cold run: all cache misses; warm run: all cache hits.
 * Reports cacheHits, cacheMisses, totalAttempts, elapsedMs, hitRate, speedup.
 */
export function runCacheBench(): { coldRun: CacheStats; warmRun: CacheStats; speedup: number } {
  const N = 100;
  eventCounter = 0;
  const events: NarrativeEvent[] = [];
  for (let i = 0; i < N; i++) events.push(makeSyntheticEvent());

  const storage = new MemoryStorage();
  const cacheDir = '/bench-cache/';
  storage.mkdirp(cacheDir);

  // Pre-compute evidence hashes for all events
  const evidenceHashes = new Map<string, string>();
  for (const event of events) {
    const hash = computeEvidenceHash(event.id, event.preconditions, event.postconditions);
    evidenceHashes.set(event.id, hash);
  }

  // ── Cold run — populate nothing, all cache misses ──────────────────────
  const coldStart = performance.now();
  let coldHits = 0;
  let coldMisses = 0;
  for (const event of events) {
    const cacheKey = `bench-cold-key-${event.id}`;
    const cached = getCachedRender(
      cacheDir,
      event.id,
      cacheKey,
      storage,
      evidenceHashes.get(event.id),
    );
    if (cached) coldHits++;
    else coldMisses++;
  }
  const coldElapsed = performance.now() - coldStart;

  // ── Warm run — populate cache first, all hits ─────────────────────────
  for (const event of events) {
    const cacheKey = `bench-warm-key-${event.id}`;
    setCachedRender(
      cacheDir,
      event.id,
      cacheKey,
      { rendered: `scene-${event.id}`, timestamp: Date.now() },
      storage,
      evidenceHashes.get(event.id),
    );
  }

  const warmStart = performance.now();
  let warmHits = 0;
  let warmMisses = 0;
  const totalEvents = events.length;
  for (const event of events) {
    const cacheKey = `bench-warm-key-${event.id}`;
    const cached = getCachedRender(
      cacheDir,
      event.id,
      cacheKey,
      storage,
      evidenceHashes.get(event.id),
    );
    if (cached) warmHits++;
    else warmMisses++;
  }
  const warmElapsed = performance.now() - warmStart;

  const coldRun: CacheStats = {
    cacheHits: coldHits,
    cacheMisses: coldMisses,
    totalAttempts: totalEvents,
    elapsedMs: coldElapsed,
    hitRate: totalEvents > 0 ? coldHits / totalEvents : 0,
  };

  const warmRun: CacheStats = {
    cacheHits: warmHits,
    cacheMisses: warmMisses,
    totalAttempts: totalEvents,
    elapsedMs: warmElapsed,
    hitRate: totalEvents > 0 ? warmHits / totalEvents : 0,
  };

  const speedup = warmElapsed > 0 && coldElapsed > 0 ? coldElapsed / warmElapsed : 0;

  return { coldRun, warmRun, speedup };
}

// ─── Pool Efficiency Benchmark ────────────────────────────────────────────

/**
 * Run the validation pipeline with varying pool sizes (1, 2, 5, 10).
 *
 * For each pool size, validates events in batches of `poolSize` concurrently.
 * Reports speedup relative to poolSize=1 and efficiency = speedup / concurrency.
 */
export function runPoolEfficiencyBench(): PoolEfficiencyResult[] {
  const N = 100;
  const ITERATIONS = 5;
  eventCounter = 0;

  const events: NarrativeEvent[] = [];
  for (let i = 0; i < N; i++) events.push(makeSyntheticEvent());
  const registry = new InMemoryEntityRegistry();
  makeSyntheticEntities(registry);
  const replayEngine = new ReplayEngine(syntheticCatalogContext);
  const state = replayEngine.replay(events, { initialFacts: syntheticInitialFacts });
  const aggregator = new ResultAggregator(
    undefined,
    undefined,
    undefined,
    undefined,
    syntheticCatalogContext.entityTypeCatalog,
  );

  const poolSizes = [1, 2, 5, 10];
  const results: PoolEfficiencyResult[] = [];
  const baselineCache = new Map<number, number>(); // poolSize -> meanMs

  for (const poolSize of poolSizes) {
    const allSamples: number[] = [];

    for (let iter = 0; iter < ITERATIONS + 3; iter++) {
      // Warmup for first 3, then measure
      const start = performance.now();

      // Validate events in batches of poolSize
      const batches: NarrativeEvent[][] = [];
      for (let i = 0; i < events.length; i += poolSize) {
        batches.push(events.slice(i, i + poolSize));
      }
      for (const batch of batches) {
        aggregator.validateAll(batch, state, registry);
      }

      const elapsed = performance.now() - start;
      if (iter >= 3) allSamples.push(elapsed);
    }

    const sorted = [...allSamples].sort((a, b) => a - b);
    const meanMs = calcMean(allSamples);
    const medianMs = calcMedian(sorted);
    const p95Ms = calcP95(sorted);
    baselineCache.set(poolSize, meanMs);

    results.push({
      poolSize,
      meanMs,
      medianMs,
      p95Ms,
      speedup: 0, // filled below
      efficiency: 0,
    });
  }

  // Compute speedup relative to poolSize=1
  const baselineMean = baselineCache.get(1) ?? 1;
  for (const r of results) {
    r.speedup = baselineMean / r.meanMs;
    r.efficiency = r.speedup / r.poolSize;
  }

  return results;
}

// ─── Combined offline benchmark runner ────────────────────────────────────

/**
 * Run the full offline N=100 benchmark including core path, cache, and pool.
 */
export async function runFullOfflineBench(): Promise<PerfResults> {
  const core = runOfflineCorePathBench();
  const cacheResult = runCacheBench();
  const poolResult = runPoolEfficiencyBench();

  return {
    measurements: [
      ...core.measurements,
      {
        name: 'cache:cold',
        hz: cacheResult.coldRun.elapsedMs > 0 ? 1000 / cacheResult.coldRun.elapsedMs : 0,
        meanMs: cacheResult.coldRun.elapsedMs,
        samples: 1,
        scale: 'N=100',
      },
      {
        name: 'cache:warm',
        hz: cacheResult.warmRun.elapsedMs > 0 ? 1000 / cacheResult.warmRun.elapsedMs : 0,
        meanMs: cacheResult.warmRun.elapsedMs,
        samples: 1,
        scale: 'N=100',
      },
      ...poolResult.map((p) => ({
        name: `pool:size=${p.poolSize}`,
        hz: p.meanMs > 0 ? 1000 / p.meanMs : 0,
        meanMs: p.meanMs,
        samples: 5,
        scale: 'N=100',
      })),
    ],
    raw: {
      ...core.raw,
      'cache:cold': {
        hz: 1000 / cacheResult.coldRun.elapsedMs,
        meanMs: cacheResult.coldRun.elapsedMs,
        samples: 1,
      },
      'cache:warm': {
        hz: 1000 / cacheResult.warmRun.elapsedMs,
        meanMs: cacheResult.warmRun.elapsedMs,
        samples: 1,
      },
      ...Object.fromEntries(
        poolResult.map((p) => [
          `pool:size=${p.poolSize}`,
          { hz: p.meanMs > 0 ? 1000 / p.meanMs : 0, meanMs: p.meanMs, samples: 5 },
        ]),
      ),
    },
    offlineCorePath: core.offlineCorePath,
    cache: cacheResult,
    pool: poolResult,
  };
}
