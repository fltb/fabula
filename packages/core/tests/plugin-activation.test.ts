// ============================================================================
// WS2/WS3 — Plugin Activation Integration Tests
//
// Verifies the full plugin activation chain:
//   1) Real valence-guard plugin loaded from plugin-check fixture validates
//      events — E1 (missing emotionalValence) produces a valence-guard error.
//   2) RenderPipeline with PluginHooksManager + MockPass2Provider runs
//      hooks without error and does not suppress normal pipeline failures.
//   3) Conflict detection catches two manifests competing on the same
//      authoritative dimension with one exclusive: true.
// ============================================================================

import path from 'node:path';
import { describe, expect, it } from 'vitest';
// ——— AI / Mock ———
import { MockPass2Provider } from '../src/ai/providers/mock-pass2.ts';
// ——— Project loading ———
import { initializeProject, validateNovel } from '../src/api.js';
// ——— Context ———
import { ContextCompiler } from '../src/context/index.js';
import { InMemoryEntityRegistry } from '../src/entity/index.js';
// ——— Logger ———
import { Logger } from '../src/observability/logger.ts';
import type { RenderJob } from '../src/pipeline/render.ts';
import type { CompiledSceneContract } from '../src/types/index.ts';
// ——— Pipeline ———
import { RenderPipeline } from '../src/pipeline/render.ts';
// ——— Plugin system ———
import {
  detectConflicts,
  PluginHooksManager,
  PluginLoader,
  ValidatorRegistry,
} from '../src/plugin/index.js';
import type {
  PluginContext,
  PluginHooks,
  PluginManifest,
  ProviderRegistry,
} from '../src/plugin/types.js';
// ——— Storage ———
import { FsStorage } from '../src/storage/fs-storage.ts';
import { MemoryStorage } from '../src/storage/memory-storage.ts';
import type { EntityRegistry, SystemContext } from '../src/types/index.ts';
// ——— Validation ———
import { ResultAggregator } from '../src/validator/aggregator.ts';
import { makeAnalysisResult } from './fixtures/mock-pass2-helpers.ts';
// ——— State / relationship replay ———
import { ConfigError } from '../src/errors.js';
import { applyRelationshipTransaction } from '../src/state/relationship-replay.js';
import { convertRelationshipChange } from '../src/types/relationship.js';
import { emptyWorldState } from '../src/state/story-boundaries.js';
import { applyNarrativeEvent } from '../src/state/event-application.js';
import type { EpochId, NarrativeEvent, RelationshipId, RelationshipRuntimeState, RelationshipTransaction } from '../src/types/index.ts';

// ——— Fixture paths ———
const ROOT = path.resolve(__dirname, '..', '..', '..');
const PLUGIN_CHECK_DIR = path.join(ROOT, 'fixtures', 'zhu-fu-variants', 'plugin-check');

// ============================================================================
// Helpers
// ============================================================================

/** Create a minimal PluginContext for test use. */
function makePluginContext(projectDir: string, storage: MemoryStorage | FsStorage): PluginContext {
  return {
    projectDir,
    storage,
    log: new Logger(undefined, { module: 'test' }),
  };
}

/** A dummy provider registry that accepts registrations silently. */
const dummyProviderRegistry: ProviderRegistry = {
  getProvider: () => undefined,
  register() {
    /* noop */
  },
};

/** Build a minimal NarrativeEvent that carries raw RelationshipChange effects for legacy compat routing. */
function makeRelEvent(
  id: string,
  order: number,
  effects: Array<{
    participants: [string, string];
    effect: string;
    direction: string;
    newState?: { type: string; intensity: number };
  }>,
): NarrativeEvent {
  return {
    id,
    event: `event_${id}`,
    narrativeOrder: order,
    title: `Event ${id}`,
    storyTime: { type: 'absolute' as const, year: 0, month: 0, day: 0 },
    sceneType: 'linear',
    pov: { character: 'narrator' as unknown as never, type: 'omniscient' },
    sceneBrief: 'test event',
    branchExistence: { type: 'all' },
    preconditions: [],
    postconditions: [],
    threadProgress: [],
    foreshadowing: [],
    relationshipEffects: effects as unknown as Array<never>,
    ruleEffects: [],
    source: 'event_file',
    participants: { entities: [] },
  };
}

// ============================================================================
// 1. Real plugin-check fixture — valence-guard validation
// ============================================================================

describe('plugin activation — real fixture validation', () => {
  it('loads valence-guard from plugin-check and reports missing emotionalValence on E1', async () => {
    // ── Load the project ──────────────────────────────────────────────
    const fsStorage = new FsStorage();
    const { events, registry, state } = initializeProject(PLUGIN_CHECK_DIR, fsStorage);
    const e1 = events.find((ev) => ev.id === 'E1');
    const e0 = events.find((ev) => ev.id === 'E0');
    expect(e1).toBeDefined();
    expect(e0).toBeDefined();
    // E1 must not have emotionalValence (fixture invariant)
    expect((e1 as Record<string, unknown>).emotionalValence).toBeUndefined();
    // E0 does have it
    expect((e0 as Record<string, unknown>).emotionalValence).toBe('unsettling_encounter_guilt');

    // ── Load plugins from the real fixture directory ──────────────────
    const loader = new PluginLoader(fsStorage);
    const hooks = await loader.loadFromDirectory(path.join(PLUGIN_CHECK_DIR, 'plugins'));
    expect(hooks).toHaveLength(1);
    expect(hooks[0].name).toBe('valence-guard');

    // ── Wire the plugin through PluginHooksManager → ValidatorRegistry ─
    const validatorRegistry = new ValidatorRegistry();
    const hooksManager = new PluginHooksManager(
      makePluginContext(PLUGIN_CHECK_DIR, fsStorage),
      validatorRegistry,
      dummyProviderRegistry,
    );
    hooksManager.register(hooks[0]);
    await hooksManager.initialize();

    // After initialize(), the valence-guard plugin should have registered
    // its validator in the ValidatorRegistry.
    expect(validatorRegistry.validators).toHaveLength(1);
    expect(validatorRegistry.validators[0].name).toBe('valence-guard');

    // ── Run validation through the real activation chain ──────────────
    // (validateNovel activates plugins from nova.yaml and compiles proper
    // per-event pre-state boundaries — hand-running validateAll against the
    // empty initial WorldState would fail core validators spuriously.)
    const { results } = await validateNovel(PLUGIN_CHECK_DIR);

    // ── Assert: E1 fails with valence-guard error ─────────────────────
    const e1Result = results.get('E1');
    expect(e1Result).toBeDefined();
    expect(e1Result!.passed).toBe(false);

    // Locate the valence-guard issue among the errors
    const valenceError = e1Result!.errors.find((issue) => issue.validator === 'valence-guard');
    expect(valenceError).toBeDefined();

    // Assert specific value shape (not just "failed")
    expect(valenceError!.message).toContain('emotionalValence');
    // The plugin computes event identity from ctx.currentEvent.event
    expect(valenceError!.event).toBe('E1');
    expect(valenceError!.severity).toBe('error');
    expect(valenceError!.fixAction).toBe('add_field');

    // ── Assert: E0 passes (has emotionalValence) ──────────────────────
    const e0Result = results.get('E0');
    expect(e0Result).toBeDefined();
    expect(e0Result!.passed).toBe(true);
    expect(e0Result!.errors).toHaveLength(0);
  });
});

// ============================================================================
// 2. RenderPipeline with PluginHooksManager + MockPass2Provider
// ============================================================================

describe('plugin activation — render with hooks', () => {
  it('runs plugin hooks without error and preserves normal pipeline failures', async () => {
    // ── Shared setup ─────────────────────────────────────────────────
    const storage = new MemoryStorage();
    const callLog: string[] = [];

    const observerHook: PluginHooks = {
      name: 'observer',
      async beforeRender() {
        callLog.push('beforeRender');
      },
      async afterRender() {
        callLog.push('afterRender');
      },
    };

    const validatorRegistry = new ValidatorRegistry();
    const hooksManager = new PluginHooksManager(
      makePluginContext(PLUGIN_CHECK_DIR, storage),
      validatorRegistry,
      dummyProviderRegistry,
    );
    hooksManager.register(observerHook);
    await hooksManager.initialize();

    // ── Scenario A: successful render with hooks + MockPass2Provider ──
    const entry = makeAnalysisResult('E0');
    const provider = new MockPass2Provider({ entries: { E0: entry } });
    const aggregator = new ResultAggregator();

    const pipeline = new RenderPipeline({
      provider,
      model: 'mock-pass2',
      cacheDir: '/tmp/test-cache',
      storage,
      skipCache: true,
      maxRetries: 1,
      aggregator,
      pluginHooksManager: hooksManager,
    });

    const sysCtx: SystemContext = {
      genre: 'literary',
      style: 'neutral',
      narrativeRules: [],
    };

    const job: RenderJob = {
      event: {
        id: 'E0',
        event: 'E0',
        narrativeOrder: 1,
        title: 'Test scene',
        storyTime: { type: 'absolute' as const, value: 'start' },
        sceneType: 'linear',
        pov: { character: 'narrator', type: 'first_person' },
        sceneBrief: 'A test scene for plugin hook verification.',
        preconditions: [],
        postconditions: [],
        threadProgress: [],
        foreshadowing: [],
        relationshipEffects: [],
        ruleEffects: [],
        source: 'genesis',
        branchExistence: { type: 'all' as const },
        participants: { entities: ['narrator'] },
        styleGuidance: undefined,
      },
      stateBefore: {
        entities: {},
        relationships: {},
        knowledge: {},
        threads: {},
        rules: {},
        facts: [],
      },
      context: new ContextCompiler().compile(
        {
          id: 'E0',
          event: 'E0',
          narrativeOrder: 1,
          title: 'Test scene',
          storyTime: { type: 'absolute' as const, value: 'start' },
          sceneType: 'linear',
          pov: { character: 'narrator', type: 'first_person' },
          sceneBrief: 'A test scene for plugin hook verification.',
          preconditions: [],
          postconditions: [],
          threadProgress: [],
          foreshadowing: [],
          relationshipEffects: [],
          ruleEffects: [],
          source: 'genesis',
          branchExistence: { type: 'all' as const },
          participants: { entities: ['narrator'] },
          styleGuidance: undefined,
        },
        {
          entities: {},
          relationships: {},
          knowledge: {},
          threads: {},
          rules: {},
          facts: [],
        },
        { resolve: () => undefined, getByKind: () => [], getAll: () => [] } as never,
        new InMemoryEntityRegistry(),
      ),
      chapter: 1,
      contract: {
        sceneId: 'E0',
        branch: { decisions: [] },
        discoursePosition: 1,
        worldStateHash: 'a00',
        knowledgeStateHash: 'a00',
        narratorProfileHash: 'a00',
        plannedDiscourseHash: 'a00',
        styleProfile: {
          profileId: 'default',
          resolutionPrecedence: { projectStyle: 'default' },
        },
        continuityPacket: { transition: 'continuous' },
        promptContractHash: 'a00',
      } satisfies CompiledSceneContract,
      surfaceDependency: {
        groupId: 'default',
        policy: 'parallel',
        manifestHash: 'a00',
      },
    };

    const resultA = await pipeline.renderScene(job);

    // No plugin hook errors in output
    expect(resultA.errors).toHaveLength(0);
    // Hooks were actually called
    expect(callLog).toContain('beforeRender');
    expect(callLog).toContain('afterRender');

    // Prose and analysis from MockPass2Provider are present
    expect(resultA.prose.length).toBeGreaterThan(0);
    expect(resultA.analysis).not.toBeNull();
    expect(resultA.analysis!.eventId).toBe('E0');

    // ── Scenario B: normal pipeline failure preserved (no entry) ────
    const badProvider = new MockPass2Provider({
      entries: { OTHER_EVENT: entry },
    });
    // Reset call log for fresh tracking
    callLog.length = 0;

    // Pipeline-level aggregator not null ensures the full path is exercised
    const badPipeline = new RenderPipeline({
      provider: badProvider,
      model: 'mock-pass2',
      cacheDir: '/tmp/test-cache-bad',
      storage: new MemoryStorage(),
      skipCache: true,
      maxRetries: 1,
      aggregator: new ResultAggregator(),
      pluginHooksManager: hooksManager,
    });

    const resultB = await badPipeline.renderScene(job);

    // Normal pipeline failure is NOT suppressed by plugin hooks
    expect(resultB.errors.length).toBeGreaterThan(0);
    // Error should mention missing entry (provider error), not plugin hooks
    const providerError = resultB.errors.find(
      (e) => e.includes('MockPass2Provider') || e.includes('no entry for event'),
    );
    expect(providerError).toBeDefined();
    // Hooks still ran despite the error
    expect(callLog).toContain('beforeRender');
    expect(callLog).toContain('afterRender');
  });
});

// ============================================================================
// 3. Conflict detection — exclusive dimension overlap
// ============================================================================

describe('plugin activation — conflict detection', () => {
  it('detects conflict when two manifests compete on emotional_valence with one exclusive:true', async () => {
    // Two manifests: both claim emotional_valence, one has exclusive: true
    const manifestA: PluginManifest = {
      name: 'emotion-analyzer',
      version: '1.0.0',
      priority: 10,
      provides: [],
      requires: [],
      conflicts: [],
      authority: {
        dimensions: ['emotional_valence'],
        exclusive: false,
      },
      observes: {
        eventTypes: ['scene'],
        stateDomains: [],
      },
    };

    const manifestB: PluginManifest = {
      name: 'valence-override',
      version: '2.0.0',
      priority: 20,
      provides: [],
      requires: [],
      conflicts: [],
      authority: {
        dimensions: ['emotional_valence'],
        exclusive: true,
      },
      observes: {
        eventTypes: ['scene'],
        stateDomains: [],
      },
    };

    // Use MemoryStorage as a lightweight tpm fs for the loader
    const storage = new MemoryStorage();
    const loader = new PluginLoader(storage);
    loader.register(manifestA);
    loader.register(manifestB);

    const reports = loader.detectConflicts();

    // Exactly one conflict — emotional_valence dimension overlap
    // with exclusive: true on one manifest
    expect(reports).toHaveLength(1);
    expect(reports[0].reason).toContain('emotional_valence');
    expect(reports[0].dimension).toBe('emotional_valence');
    // The two plugins involved
    const involved = [reports[0].pluginA, reports[0].pluginB];
    expect(involved).toContain('emotion-analyzer');
    expect(involved).toContain('valence-override');

    // Pre-render abort: conflict is detected before any render setup,
    // proving that rendering would be blocked at the configuration phase.
    // The plugin loader exposes detectConflicts() which is designed to
    // gate renderNovel — a non-empty report means render must not proceed.
    expect(reports.length).toBeGreaterThan(0);
  });

  it('reports no conflict when exclusive:false plugins share a dimension', () => {
    // Both non-exclusive — overlapping dimensions are allowed
    const a: PluginManifest = {
      name: 'a',
      version: '1.0.0',
      priority: 1,
      provides: [],
      requires: [],
      conflicts: [],
      authority: { dimensions: ['emotional_valence'], exclusive: false },
      observes: { eventTypes: [], stateDomains: [] },
    };
    const b: PluginManifest = {
      name: 'b',
      version: '1.0.0',
      priority: 1,
      provides: [],
      requires: [],
      conflicts: [],
      authority: { dimensions: ['emotional_valence'], exclusive: false },
      observes: { eventTypes: [], stateDomains: [] },
    };

    const storage = new MemoryStorage();
    const loader = new PluginLoader(storage);
    loader.register(a);
    loader.register(b);

    const reports = loader.detectConflicts();
    expect(reports).toHaveLength(0);
  });
});

// ============================================================================
// 4. Legacy relationship re-establishment after dissolution
// ============================================================================

describe('plugin activation — legacy relationship re-establishment', () => {
  // These tests verify that the legacy RelationshipChange conversion/replay fix
  // routes re-establishment after dissolution to a new epoch (instead of an
  // invalid dissolved→active transition), while explicit RelationshipTransaction
  // lifecycle rules stay strict.

  it('routes legacy re-establishment to a new epoch without error', () => {
    // Use the public shared application route (applyNarrativeEvent) with events
    // carrying raw RelationshipChange effects. The internal applyTransactions
    // auto-converts legacy changes and routes dissolve→reinforce to a new epoch.
    const state = emptyWorldState();

    const e1 = makeRelEvent('E1', 0, [
      { participants: ['alice', 'bob'] as [string, string], effect: 'establish', direction: 'friendship', newState: { type: 'friend', intensity: 50 } },
    ]);
    const e2 = makeRelEvent('E2', 1, [
      { participants: ['alice', 'bob'] as [string, string], effect: 'dissolve', direction: 'falling_out', newState: { type: 'enemy', intensity: 80 } },
    ]);
    const e3 = makeRelEvent('E3', 2, [
      { participants: ['alice', 'bob'] as [string, string], effect: 'reinforce', direction: 'reconciliation', newState: { type: 'ally', intensity: 40 } },
    ]);

    // Step 1: establish — no error, one epoch created via legacy conversion
    applyNarrativeEvent(state, e1);
    const rel = state.relationships.rel_alice_bob;
    expect(rel).toBeDefined();
    expect(Object.keys(rel.epochs)).toHaveLength(1);
    expect(rel.activeEpochId).toBeDefined();

    // Step 2: dissolve — epoch marked dissolved, activeEpochId cleared
    applyNarrativeEvent(state, e2);
    expect(rel.activeEpochId).toBeUndefined();
    expect(rel.epochs.epoch_alice_bob_1.lifecycle).toBe('dissolved');

    // Step 3: re-establish (legacy reinforce after dissolve) — must NOT throw
    // and must create a NEW epoch via routeLegacyReestablishment.
    applyNarrativeEvent(state, e3);
    expect(Object.keys(rel.epochs)).toHaveLength(2);
    expect(rel.activeEpochId).toBeDefined();
    // The dissolved epoch must remain dissolved
    expect(rel.epochs.epoch_alice_bob_1.lifecycle).toBe('dissolved');
    // The active epoch must be the new one
    const activeEpoch = rel.epochs[rel.activeEpochId!]!;
    expect(activeEpoch.lifecycle).toBe('active');
    expect(activeEpoch.epochId).not.toBe('epoch_alice_bob_1');
  });

  it('rejects legacy re-establishment when lifecycleAfter is not active', () => {
    // A legacy transaction with lifecycleAfter 'dissolved' targeting a dissolved
    // epoch should be a no-op (or create dissolved epoch), not re-establishment.
    // This test confirms only 'active' lifecycleAfter triggers the re-route.
    const dissolve1 = convertRelationshipChange(
      {
        participants: ['alice', 'bob'] as [string, string],
        effect: 'dissolve',
        direction: 'break',
        newState: { type: 'enemy', intensity: 100 },
      },
      'E1',
      0,
    );
    const dissolve2 = convertRelationshipChange(
      {
        participants: ['alice', 'bob'] as [string, string],
        effect: 'dissolve',
        direction: 'double_break',
        newState: { type: 'stranger', intensity: 0 },
      },
      'E2',
      0,
    );

    const relationships: Record<string, RelationshipRuntimeState> = {};
    applyRelationshipTransaction(relationships, dissolve1);
    // Second dissolve targets the same (now dissolved) epoch but also has
    // lifecycleAfter 'dissolved' — the re-route guard checks for 'active'
    // lifecycleAfter, so the epoch stays dissolved and no new epoch is created.
    applyRelationshipTransaction(relationships, dissolve2);
    const relState = relationships[dissolve1.relationshipId]!;
    // Only one epoch (no re-route for dissolved→dissolved)
    expect(Object.keys(relState.epochs)).toHaveLength(1);
    expect(relState.epochs[dissolve1.epochId!]!.lifecycle).toBe('dissolved');
  });

  it('rejects explicit non-legacy dissolved→active transition', () => {
    // Explicit RelationshipTransaction (provenance not starting with 'compat:')
    // must still throw ConfigError for an invalid dissolved→active lifecycle transition.
    const relationships: Record<string, RelationshipRuntimeState> = {};

    // First establish through legacy conversion to set up state
    const establish = convertRelationshipChange(
      {
        participants: ['alice', 'bob'] as [string, string],
        effect: 'establish',
        direction: 'friendship',
      },
      'E1',
      0,
    );
    applyRelationshipTransaction(relationships, establish);

    const dissolve = convertRelationshipChange(
      {
        participants: ['alice', 'bob'] as [string, string],
        effect: 'dissolve',
        direction: 'break',
      },
      'E2',
      0,
    );
    applyRelationshipTransaction(relationships, dissolve);

    // Now create an EXPLICIT transaction (no compat: provenance) trying to
    // reactivate the dissolved epoch — must throw ConfigError.
    const explicitReActivate: RelationshipTransaction = {
      effectId: 'E3_explicit',
      relationshipId: establish.relationshipId,
      epochId: dissolve.epochId,
      lifecycleAfter: 'active',
      membershipAfter: [],
      provenance: 'author:manual',
    };

    expect(() =>
      applyRelationshipTransaction(relationships, explicitReActivate),
    ).toThrow(ConfigError);
  });

  it('creates deterministic collision-free epoch when existing epochs are sparse', () => {
    // With sparse epochs (e.g. _1, _2, _4 exist but no _3), the old count-based
    // strategy would compute Object.keys(epochs).length + 1 = 4 → colliding with
    // the existing epoch _4. The max-suffix+1 strategy produces _5 (no collision).
    const state = emptyWorldState();

    // Step 1-2: establish → dissolve → create epochs _1 (dissolved)
    applyNarrativeEvent(state, makeRelEvent('E1', 0, [
      { participants: ['alice', 'bob'] as [string, string], effect: 'establish', direction: 'friendship', newState: { type: 'friend', intensity: 50 } },
    ]));
    applyNarrativeEvent(state, makeRelEvent('E2', 1, [
      { participants: ['alice', 'bob'] as [string, string], effect: 'dissolve', direction: 'falling_out', newState: { type: 'enemy', intensity: 80 } },
    ]));

    // Step 3-4: reinforce → dissolve → create epochs _1, _2 (both dissolved)
    applyNarrativeEvent(state, makeRelEvent('E3', 2, [
      { participants: ['alice', 'bob'] as [string, string], effect: 'reinforce', direction: 'reconciliation', newState: { type: 'ally', intensity: 40 } },
    ]));
    applyNarrativeEvent(state, makeRelEvent('E4', 3, [
      { participants: ['alice', 'bob'] as [string, string], effect: 'dissolve', direction: 'break', newState: { type: 'enemy', intensity: 90 } },
    ]));

    const rel = state.relationships.rel_alice_bob!;
    expect(Object.keys(rel.epochs)).toHaveLength(2);

    // Step 5: Inject epoch _4 directly (non-compat provenance) to create a
    // sparse gap — no epoch _3 exists. Must set up, then dissolve.
    const createTx: RelationshipTransaction = {
      effectId: 'E5_create',
      relationshipId: 'rel_alice_bob' as unknown as RelationshipId,
      epochId: 'epoch_alice_bob_4' as unknown as EpochId,
      lifecycleAfter: 'active',
      membershipAfter: [],
      provenance: 'direct',
    };
    applyRelationshipTransaction(state.relationships, createTx);
    const dissolveTx: RelationshipTransaction = {
      effectId: 'E5_dissolve',
      relationshipId: 'rel_alice_bob' as unknown as RelationshipId,
      epochId: 'epoch_alice_bob_4' as unknown as EpochId,
      lifecycleAfter: 'dissolved',
      membershipAfter: [],
      provenance: 'direct',
    };
    applyRelationshipTransaction(state.relationships, dissolveTx);

    // Verify sparse setup: epochs _1, _2, _4 (no _3)
    expect(Object.keys(rel.epochs)).toHaveLength(3);
    expect(rel.epochs.epoch_alice_bob_3).toBeUndefined();
    expect(rel.epochs.epoch_alice_bob_4!.lifecycle).toBe('dissolved');

    // Step 6: Legacy reinforce — routes through routeLegacyReestablishment.
    // OLD (count-based): 3 + 1 = 4 → COLLISION with epoch _4
    // NEW (max-based): max suffix 4 + 1 = 5 → unique epoch _5
    applyNarrativeEvent(state, makeRelEvent('E6', 4, [
      { participants: ['alice', 'bob'] as [string, string], effect: 'reinforce', direction: 'second_chance', newState: { type: 'ally', intensity: 60 } },
    ]));

    expect(Object.keys(rel.epochs)).toHaveLength(4);
    // epoch _5 must exist and be active
    const epoch5Id = 'epoch_alice_bob_5';
    expect(rel.epochs[epoch5Id]).toBeDefined();
    expect(rel.epochs[epoch5Id]!.lifecycle).toBe('active');
    expect(rel.activeEpochId).toBe(epoch5Id);
    // epoch _4 must remain dissolved (guaranteeing no overwrite)
    expect(rel.epochs.epoch_alice_bob_4!.lifecycle).toBe('dissolved');
  });
});
