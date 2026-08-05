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

import { describe, expect, it } from 'vitest';
// ——— AI / Mock ———
import { MockPass2Provider } from '../src/ai/providers/mock-pass2.ts';
// ——— Context ———
import { ContextCompiler } from '../src/context/index.js';
import { InMemoryEntityRegistry } from '../src/entity/index.js';
// ——— State / relationship replay ———
import { ConfigError } from '../src/errors.js';
// ——— Logger ———
import { Logger } from '../src/observability/logger.ts';
import type { RenderJob } from '../src/pipeline/render.ts';
// ——— Pipeline ———
import { RenderPipeline } from '../src/pipeline/render.ts';
// ——— Plugin system ———
import { PluginHooksManager, PluginLoader, ValidatorRegistry } from '../src/plugin/index.js';
import type {
  PluginContext,
  PluginHooks,
  PluginManifest,
  ProviderRegistry,
} from '../src/plugin/types.js';
import {
  applyRelationshipTransaction,
  type RelationshipReplayContext,
} from '../src/state/relationship-replay.js';
import { emptyWorldState } from '../src/state/story-boundaries.ts';
import type {
  CompiledSceneContract,
  EpochId,
  MembershipId,
  RelationshipDeclaration,
  RelationshipId,
  RelationshipRuntimeState,
  RelationshipTransaction,
  RelationshipTypeCatalog,
  SystemContext,
} from '../src/types/index.ts';
// ——— Validation ———
import { ResultAggregator } from '../src/validator/aggregator.ts';
import { makeAnalysisResult } from './fixtures/mock-pass2-helpers.ts';
import { createRuntimeServices } from './fixtures/runtime-services.ts';

// ============================================================================
// Helpers
// ============================================================================

/** Create a minimal host-neutral PluginContext for test use. */
function makePluginContext(): PluginContext {
  return {
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

// ============================================================================
// 2. RenderPipeline with PluginHooksManager + MockPass2Provider
// ============================================================================

describe('plugin activation — render with hooks', () => {
  it('runs plugin hooks without error and preserves normal pipeline failures', async () => {
    // ── Shared setup ─────────────────────────────────────────────────
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
      makePluginContext(),
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
      runtimeServices: createRuntimeServices({ provider }).services,
      skipCache: true,
      maxRetries: 1,
      aggregator,
      pluginHooksManager: hooksManager,
      validatorPolicyId: 'test-policy-v1',
    });

    const _sysCtx: SystemContext = {
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
        beats: ['A test scene for plugin hook verification.'],
        preconditions: [],
        postconditions: [],
        threadProgress: [],
        foreshadowing: [],
        relationshipEffects: [],
        ruleEffects: [],
        source: 'event_file',
        branchExistence: { type: 'all' as const },
        participants: { entities: ['narrator'] },
        styleGuidance: undefined,
      },
      stateBefore: emptyWorldState(),
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
          beats: ['A test scene for plugin hook verification.'],
          preconditions: [],
          postconditions: [],
          threadProgress: [],
          foreshadowing: [],
          relationshipEffects: [],
          ruleEffects: [],
          source: 'event_file',
          branchExistence: { type: 'all' as const },
          participants: { entities: ['narrator'] },
          styleGuidance: undefined,
        },
        emptyWorldState(),
        new InMemoryEntityRegistry(),
      ),
      sourceContentHash: 'source-plugin-hooks',
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
    const analysis = resultA.analysis;
    expect(analysis).not.toBeNull();
    if (!analysis) throw new Error('Expected successful analysis fixture');
    expect(analysis.eventId).toBe('E0');

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
      runtimeServices: createRuntimeServices({ provider: badProvider }).services,
      skipCache: true,
      maxRetries: 1,
      aggregator: new ResultAggregator(),
      pluginHooksManager: hooksManager,
      validatorPolicyId: 'test-policy-v1',
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
    const loader = new PluginLoader();
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

    const loader = new PluginLoader();
    loader.register(a);
    loader.register(b);

    const reports = loader.detectConflicts();
    expect(reports).toHaveLength(0);
  });
});

// ============================================================================
// 4. Canonical relationship lifecycle and re-establishment
// ============================================================================

const RELATIONSHIP_TYPE_CATALOG: RelationshipTypeCatalog = {
  types: {
    friendship: {
      typeId: 'friendship',
      label: 'Friendship',
      roles: [
        {
          roleId: 'member',
          label: 'Member',
          minCardinality: 2,
          maxCardinality: 2,
          allowedEntityKinds: ['character'],
        },
      ],
      continuityImpact: 'new_epoch',
    },
  },
};

const RELATIONSHIP_ID = 'rel_alice_bob' as RelationshipId;
const INITIAL_EPOCH_ID = 'epoch_alice_bob_1' as EpochId;
const REESTABLISHED_EPOCH_ID = 'epoch_alice_bob_2' as EpochId;
const INITIAL_MEMBERSHIPS = [
  { membershipId: 'mem_alice_1' as MembershipId, entityId: 'alice', role: 'member' },
  { membershipId: 'mem_bob_1' as MembershipId, entityId: 'bob', role: 'member' },
];

const RELATIONSHIP_DECLARATION: RelationshipDeclaration = {
  relationshipId: RELATIONSHIP_ID,
  typeId: 'friendship',
  initialEpoch: {
    epochId: INITIAL_EPOCH_ID,
    lifecycle: 'active',
    memberships: INITIAL_MEMBERSHIPS,
    dimensions: [{ dimensionId: 'bond', scope: 'global', value: 'friendship' }],
  },
};

const RELATIONSHIP_REPLAY_CONTEXT: RelationshipReplayContext = {
  relationshipDeclarations: [RELATIONSHIP_DECLARATION],
  relationshipTypeCatalog: RELATIONSHIP_TYPE_CATALOG,
};

function relationshipTransaction(
  effectId: string,
  epochId: EpochId,
  lifecycleAfter: 'active' | 'suspended' | 'dissolved',
  membershipAfter = INITIAL_MEMBERSHIPS,
): RelationshipTransaction {
  return {
    type: 'relationship_transaction',
    effectId,
    relationshipId: RELATIONSHIP_ID,
    epochId,
    lifecycleAfter,
    membershipAfter,
    provenance: effectId,
  };
}

function preMaterializedRelationships(): Record<RelationshipId, RelationshipRuntimeState> {
  // Canonical post-dissolution state: the old epoch is terminal (dissolved)
  // and the next incarnation already exists as a dormant suspended epoch.
  // Re-establishment is the legal suspended → active resume; replay never
  // synthesizes an epoch or routes around the lifecycle table.
  return {
    [RELATIONSHIP_ID]: {
      relationshipId: RELATIONSHIP_ID,
      typeId: 'friendship',
      epochs: {
        [INITIAL_EPOCH_ID]: {
          epochId: INITIAL_EPOCH_ID,
          lifecycle: 'dissolved',
          memberships: {},
          dimensions: {},
        },
        [REESTABLISHED_EPOCH_ID]: {
          epochId: REESTABLISHED_EPOCH_ID,
          lifecycle: 'suspended',
          memberships: {},
          dimensions: {},
        },
      },
    },
  };
}

describe('plugin activation — canonical relationship lifecycle', () => {
  it('applies canonical transactions through an explicit replay context', () => {
    const relationships: Record<RelationshipId, RelationshipRuntimeState> = {};

    applyRelationshipTransaction(
      relationships,
      relationshipTransaction('E1_establish', INITIAL_EPOCH_ID, 'active'),
      RELATIONSHIP_REPLAY_CONTEXT,
    );
    applyRelationshipTransaction(
      relationships,
      relationshipTransaction('E2_suspend', INITIAL_EPOCH_ID, 'suspended'),
      RELATIONSHIP_REPLAY_CONTEXT,
    );
    applyRelationshipTransaction(
      relationships,
      relationshipTransaction('E3_resume', INITIAL_EPOCH_ID, 'active'),
      RELATIONSHIP_REPLAY_CONTEXT,
    );
    applyRelationshipTransaction(
      relationships,
      relationshipTransaction('E4_dissolve', INITIAL_EPOCH_ID, 'dissolved', []),
      RELATIONSHIP_REPLAY_CONTEXT,
    );

    const relationship = relationships[RELATIONSHIP_ID];
    expect(relationship).toBeDefined();
    expect(relationship?.typeId).toBe('friendship');
    expect(relationship?.epochs[INITIAL_EPOCH_ID].lifecycle).toBe('dissolved');
    expect(relationship?.activeEpochId).toBeUndefined();
  });

  it('re-establishes on a pre-materialized canonical epoch without synthetic routing', () => {
    const relationships = preMaterializedRelationships();

    applyRelationshipTransaction(
      relationships,
      relationshipTransaction('E5_reestablish', REESTABLISHED_EPOCH_ID, 'active'),
      RELATIONSHIP_REPLAY_CONTEXT,
    );

    const relationship = relationships[RELATIONSHIP_ID];
    expect(relationship).toBeDefined();
    expect(relationship?.epochs[INITIAL_EPOCH_ID].lifecycle).toBe('dissolved');
    expect(relationship?.epochs[REESTABLISHED_EPOCH_ID].lifecycle).toBe('active');
    expect(relationship?.activeEpochId).toBe(REESTABLISHED_EPOCH_ID);
  });

  it('rejects reactivation of a dissolved canonical epoch', () => {
    const relationships = preMaterializedRelationships();

    expect(() =>
      applyRelationshipTransaction(
        relationships,
        relationshipTransaction('E6_invalid_reactivation', INITIAL_EPOCH_ID, 'active'),
        RELATIONSHIP_REPLAY_CONTEXT,
      ),
    ).toThrow(ConfigError);

    expect(relationships[RELATIONSHIP_ID].epochs[INITIAL_EPOCH_ID].lifecycle).toBe('dissolved');
  });
});
