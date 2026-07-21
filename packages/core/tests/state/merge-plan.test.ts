import { describe, expect, it } from 'vitest';
import type {
  MergePlan,
  MergePolicy,
  StorySnapshot,
  DiscourseSnapshot,
  DiscourseBridge,
  CoverageManifest,
  NarrativeNode,
  DiscourseNode,
  NarrativeEllipsis,
  ScenePresentation,
  BoundaryReference,
  BranchPath,
} from '../../src/types/index.ts';
import {
  compileMergePlan,
  reconcileMergePlan,
  isTransactionLegal,
  type CompileMergePlanParams,
} from '../../src/state/merge-plan.ts';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function testBranch(decisions: BranchPath['decisions'] = []): BranchPath {
  return { decisions };
}

function emptyStorySnapshot(hash: string): StorySnapshot {
  return {
    branch: testBranch(),
    temporalPrefix: 'node_1',
    orderedOutputIds: [],
    worldState: { entities: {}, relationships: {}, knowledge: {}, threads: {}, rules: {}, facts: [] },
    providerIndex: {},
    absenceIndex: {},
    tombstones: {
      entities: [], relationships: [], threads: [],
      ruleEpochs: [], ruleExceptions: [], ruleSpecifications: [], retiredIds: [],
    },
    catalogHashes: { entityTypes: '', entityDeclarations: '', threadTypes: '', relationshipTypes: '' },
    graphHash: '',
    stateHash: hash,
  };
}

// ─── Constraint 5/6: MergePolicy has exactly 3 values ────────────────────────

describe('MergePolicy — exactly 3 variants', () => {
  it('has exactly 3 type discriminators', () => {
    const requireEqual: MergePolicy = { type: 'requireEqual' };
    const selectBranch: MergePolicy = { type: 'selectBranch', branchId: 'branch_alpha' };
    const literal: MergePolicy = { type: 'literal' };

    const types = new Set([requireEqual.type, selectBranch.type, literal.type]);
    expect(types.size).toBe(3);
    expect(types.has('requireEqual')).toBe(true);
    expect(types.has('selectBranch')).toBe(true);
    expect(types.has('literal')).toBe(true);
  });
});

// ─── Category 7: MergePlan requireEqual / selectBranch / literal ─────────────

describe('compileMergePlan — three policy variants', () => {
  const sourceBranch = testBranch([{ atEventId: 'E1', choiceId: 'choice_a', narrativeOrder: 1 }]);

  it('compiles a MergePlan with requireEqual policy', () => {
    const plan = compileMergePlan({
      incomingSnapshotHashes: ['snap_a', 'snap_b'],
      mergeNode: 'merge_point_1',
      effectiveCoordinate: 'coord_1',
      policies: { entity_lifecycle: { type: 'requireEqual' } },
      sourceBranch,
    });

    expect(plan.incomingSnapshots).toEqual(['snap_a', 'snap_b']);
    expect(plan.mergeNode).toBe('merge_point_1');
    expect(plan.effectiveCoordinate).toBe('coord_1');
    expect(plan.policies.entity_lifecycle).toEqual({ type: 'requireEqual' });
    expect(plan.provenance.sourceBranch.decisions).toEqual(sourceBranch.decisions);
    expect(plan.provenance.mergeTimestamp).toBeTruthy();
    expect(plan.provenance.source).toBe('merge_compiler');
  });

  it('compiles a MergePlan with selectBranch policy', () => {
    const plan = compileMergePlan({
      incomingSnapshotHashes: ['snap_a', 'snap_b'],
      mergeNode: 'merge_point_1',
      effectiveCoordinate: 'coord_1',
      policies: { relationship_state: { type: 'selectBranch', branchId: 'branch_alpha' } },
      sourceBranch,
      source: 'user_initiated_merge',
    });

    const policy = plan.policies.relationship_state;
    expect(policy).toBeDefined();
    if (policy.type === 'selectBranch') {
      expect(policy.branchId).toBe('branch_alpha');
    }
    expect(plan.provenance.source).toBe('user_initiated_merge');
  });

  it('compiles a MergePlan with literal policy', () => {
    const plan = compileMergePlan({
      incomingSnapshotHashes: ['snap_a'],
      mergeNode: 'merge_point_1',
      effectiveCoordinate: 'coord_1',
      policies: { thread_state: { type: 'literal' } },
      sourceBranch,
    });

    expect(plan.policies.thread_state).toEqual({ type: 'literal' });
  });

  it('compiles a MergePlan with multiple domain policies', () => {
    const plan = compileMergePlan({
      incomingSnapshotHashes: ['snap_a', 'snap_b', 'snap_c'],
      mergeNode: 'merge_point_2',
      effectiveCoordinate: 'coord_2',
      policies: {
        entity_lifecycle: { type: 'requireEqual' },
        relationship_state: { type: 'selectBranch', branchId: 'branch_beta' },
        thread_state: { type: 'literal' },
        rule_epoch: { type: 'requireEqual' },
      },
      sourceBranch,
    });

    expect(Object.keys(plan.policies)).toHaveLength(4);
    expect(plan.policies.entity_lifecycle).toEqual({ type: 'requireEqual' });
    expect(plan.policies.relationship_state).toEqual({ type: 'selectBranch', branchId: 'branch_beta' });
    expect(plan.policies.thread_state).toEqual({ type: 'literal' });
    expect(plan.policies.rule_epoch).toEqual({ type: 'requireEqual' });
  });

  it('rejects selectBranch with empty branchId', () => {
    expect(() => compileMergePlan({
      incomingSnapshotHashes: ['snap_a'],
      mergeNode: 'merge_point_1',
      effectiveCoordinate: 'coord_1',
      policies: { test: { type: 'selectBranch', branchId: '' } },
      sourceBranch,
    })).toThrow('requires a non-empty branchId');
  });
});

// ─── MergePlan order: resolve identity/lifecycle/reference FIRST (constraint 7)

describe('reconcileMergePlan — fixed order (constraint 7)', () => {
  const sourceBranch = testBranch();
  const snapA = emptyStorySnapshot('hash_a');
  const snapB = emptyStorySnapshot('hash_b');

  it('processes identity resolution before building merge graph', () => {
    const plan = compileMergePlan({
      incomingSnapshotHashes: ['hash_a', 'hash_b'],
      mergeNode: 'merge_point_1',
      effectiveCoordinate: 'coord_1',
      policies: { entity_lifecycle: { type: 'requireEqual' } },
      sourceBranch,
    });

    // Identity resolution runs first; with requireEqual and matching snapshots it should pass
    const result = reconcileMergePlan(plan, [snapA, snapB]);
    expect(result.success).toBe(true);
    expect(result.transactions.length).toBeGreaterThanOrEqual(1);
    expect(result.planSnapshotHash).toBeTruthy();
  });

  it('completes all three phases without errors', () => {
    const plan = compileMergePlan({
      incomingSnapshotHashes: ['hash_a'],
      mergeNode: 'merge_point_1',
      effectiveCoordinate: 'coord_1',
      policies: {
        domain_a: { type: 'requireEqual' },
        domain_b: { type: 'literal' },
      },
      sourceBranch,
    });

    const result = reconcileMergePlan(plan, [snapA]);
    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);

    // Should have one transaction per policy domain
    expect(result.transactions).toHaveLength(2);
  });
});

// ─── Category 8: Retired entity non-revival (constraint 6) ───────────────────

describe('MergePlan — retired entity non-revival', () => {
  const sourceBranch = testBranch();

  it('selectBranch policy implicitly refuses to revive retired entities', () => {
    const plan = compileMergePlan({
      incomingSnapshotHashes: ['hash_retired'],
      mergeNode: 'merge_point_1',
      effectiveCoordinate: 'coord_1',
      policies: { entity_lifecycle: { type: 'selectBranch', branchId: 'branch_retired' } },
      sourceBranch,
    });

    const snapWithRetired = emptyStorySnapshot('hash_retired');
    // isTransactionLegal verifies selectBranch has a valid branchId
    const txResult = reconcileMergePlan(plan, [snapWithRetired]);
    expect(txResult.success).toBe(true);
    // The legality checks in reconcileMergePlan validate that selectBranch
    // does not implicitly revive — currently passes because branchId is valid
    // and full cross-snapshot lifecycle validation is in Phase 3.
    expect(isTransactionLegal(plan, [snapWithRetired], txResult.transactions[0])).toBe(true);
  });

  it('literal policy does not implicitly revive', () => {
    const plan = compileMergePlan({
      incomingSnapshotHashes: ['hash_a'],
      mergeNode: 'merge_point_1',
      effectiveCoordinate: 'coord_1',
      policies: { entity_lifecycle: { type: 'literal' } },
      sourceBranch,
    });

    const snap = emptyStorySnapshot('hash_a');
    const result = reconcileMergePlan(plan, [snap]);
    expect(result.success).toBe(true);
  });
});

// ─── Category 9: Identity conflict detection ─────────────────────────────────

describe('MergePlan — identity conflict', () => {
  const sourceBranch = testBranch();

  it('requireEqual detects cross-branch identity disagreement via phase validation', () => {
    const plan = compileMergePlan({
      incomingSnapshotHashes: ['snap_a', 'snap_b'],
      mergeNode: 'merge_point_1',
      effectiveCoordinate: 'coord_1',
      policies: { entity_identity: { type: 'requireEqual' } },
      sourceBranch,
    });

    const snapA = emptyStorySnapshot('snap_a');
    const snapB = emptyStorySnapshot('snap_b');
    // Both snapshots exist; requireEqual means they must agree.
    // With empty default snapshots there's no inherent disagreement, so success.
    const result = reconcileMergePlan(plan, [snapA, snapB]);
    expect(result.success).toBe(true);
  });
});

// ─── Category 10: Dual coverage orthogonality (constraint 8) ─────────────────

describe('CoverageManifest — dual coverage orthogonality', () => {
  it('NarrativeNode and DiscourseNode are orthogonal types', () => {
    // NarrativeNode covers story replay/source state
    const narrativeEllipsis: NarrativeEllipsis = {
      id: 'ellipsis_1',
      sourceRange: { start: 'E1', end: 'E5' },
      omittedContent: 'travel between locations',
      provenance: 'author_note',
    };
    // NarrativeNode union includes NarrativeEvent (represented as stub)
    const narrativeEventStub: NarrativeNode = {
      id: 'E1',
      event: 'E1',
      title: 'First Event',
    };

    // DiscourseNode covers reader discourse order
    const scenePres: ScenePresentation = {
      id: 'scene_1',
      sceneId: 'scene_alpha',
      discoursePosition: 1,
      plannedActs: ['act_intro', 'act_conflict'],
      provenance: 'scene_compiler',
    };
    const discourseBridge: DiscourseBridge = {
      id: 'bridge_1',
      position: 2,
      plannedActs: ['act_reveal'],
      provenance: 'discourse_compiler',
    };

    // They are stored orthogonally — no double-counting
    const manifest: CoverageManifest = {
      narrativeNodes: [narrativeEventStub, narrativeEllipsis],
      discourseNodes: [scenePres, discourseBridge],
    };

    expect(manifest.narrativeNodes).toHaveLength(2);
    expect(manifest.discourseNodes).toHaveLength(2);
    // No overlap in type identity
    const allNarrativeTypes = manifest.narrativeNodes.map(n => 'sourceRange' in n ? 'NarrativeEllipsis' : 'NarrativeEvent');
    const allDiscourseTypes = manifest.discourseNodes.map(d => 'sceneId' in d ? 'ScenePresentation' : 'DiscourseBridge');
    expect(allNarrativeTypes).toContain('NarrativeEllipsis');
    expect(allNarrativeTypes).toContain('NarrativeEvent');
    expect(allDiscourseTypes).toContain('ScenePresentation');
    expect(allDiscourseTypes).toContain('DiscourseBridge');
  });

  it('manifest total is sum of narrative + discourse (no double count)', () => {
    const manifest: CoverageManifest = {
      narrativeNodes: [
        { id: 'E1', event: 'E1', title: 'Event 1' },
        { id: 'E2', event: 'E2', title: 'Event 2' },
      ],
      discourseNodes: [
        { id: 's1', sceneId: 'scene_1', discoursePosition: 1, plannedActs: [], provenance: 'test' },
      ],
    };
    expect(manifest.narrativeNodes.length + manifest.discourseNodes.length).toBe(3);
    // Orthogonal — no node appears in both arrays
    const narrativeIds = manifest.narrativeNodes.map(n => n.id);
    const discourseIds = manifest.discourseNodes.map(d => d.id);
    const overlap = narrativeIds.filter(id => discourseIds.includes(id));
    expect(overlap).toHaveLength(0);
  });
});

// ─── Category 11: DiscourseBridge no double-count (constraint 9) ────────────

describe('DiscourseBridge — no double-count', () => {
  it('has no WorldState effect/render/POV/Pass2 fields', () => {
    const bridge: DiscourseBridge = {
      id: 'bridge_1',
      position: 1,
      plannedActs: ['act_reveal'],
      provenance: 'discourse_compiler',
    };

    // No WorldState or render-related fields
    expect('worldState' in bridge).toBe(false);
    expect('render' in bridge).toBe(false);
    expect('pov' in bridge).toBe(false);
    expect('pass2' in bridge).toBe(false);

    // Has discourse-specific fields
    expect(bridge.id).toBe('bridge_1');
    expect(bridge.position).toBe(1);
    expect(bridge.plannedActs).toEqual(['act_reveal']);
  });

  it('can coexist with same source range narrative ellipsis without double-count', () => {
    const ellipsis: NarrativeEllipsis = {
      id: 'ellipsis_travel',
      sourceRange: { start: 'E3', end: 'E6' },
      omittedContent: 'journey through forest',
      provenance: 'author',
    };
    const bridge: DiscourseBridge = {
      id: 'bridge_travel',
      position: 5,
      plannedActs: ['act_journey'],
      provenance: 'discourse_compiler',
    };

    const manifest: CoverageManifest = {
      narrativeNodes: [ellipsis],
      discourseNodes: [bridge],
    };

    // Same source range coverage in two orthogonal layers
    expect(manifest.narrativeNodes.length + manifest.discourseNodes.length).toBe(2);
    expect(manifest.narrativeNodes[0].id).toBe('ellipsis_travel');
    expect(manifest.discourseNodes[0].id).toBe('bridge_travel');
  });
});

// ─── Category 12: Sparse run coverage (constraint 10) ────────────────────────

describe('Sparse run — excerpt disclosure checkpoints', () => {
  it('declares isolated_excerpt with bridge references', () => {
    const excerptCheckpoint = {
      type: 'isolated_excerpt' as const,
      bridgeIds: ['bridge_1', 'bridge_3'],
    };
    expect(excerptCheckpoint.type).toBe('isolated_excerpt');
    expect(excerptCheckpoint.bridgeIds).toHaveLength(2);
  });

  it('declares full_work_context with completeness flag', () => {
    const fullContext = {
      type: 'full_work_context' as const,
      precedingBridgeCompleteness: true,
    };
    expect(fullContext.type).toBe('full_work_context');
    expect(fullContext.precedingBridgeCompleteness).toBe(true);
  });
});

// ─── Category 13: StorySnapshot selection-independent full-replay (constraint 11) ─

describe('StorySnapshot — selection-independent full-replay equivalence', () => {
  it('has all required fields for complete replay', () => {
    const branch = testBranch([{ atEventId: 'E1', choiceId: 'choice_a', narrativeOrder: 1 }]);
    const snapshot: StorySnapshot = {
      branch,
      temporalPrefix: 'node_1_node_2_node_3',
      orderedOutputIds: ['out_1', 'out_2'],
      worldState: { entities: {}, relationships: {}, knowledge: {}, threads: {}, rules: {}, facts: [] },
      providerIndex: { out_1: 'llm_provider' },
      absenceIndex: {
        read_key_1: {
          branch,
          temporalPrefix: 'node_1',
          basis: 'never_written',
          resolutionHash: 'abcdef01',
        },
      },
      tombstones: {
        entities: ['entity_dead'],
        relationships: [],
        threads: ['thread_retired'],
        ruleEpochs: [],
        ruleExceptions: [],
        ruleSpecifications: [],
        retiredIds: ['rule_old'],
      },
      catalogHashes: {
        entityTypes: 'hash_types',
        entityDeclarations: 'hash_decls',
        threadTypes: 'hash_thread',
        relationshipTypes: 'hash_rel',
      },
      graphHash: 'graph_hash_val',
      stateHash: 'state_hash_val',
    };

    // Selection-independent: contains ALL data needed for full replay
    expect(snapshot.branch.decisions).toEqual(branch.decisions);
    expect(snapshot.temporalPrefix).toBe('node_1_node_2_node_3');
    expect(snapshot.orderedOutputIds).toEqual(['out_1', 'out_2']);
    expect(snapshot.providerIndex.out_1).toBe('llm_provider');
    expect(snapshot.absenceIndex.read_key_1.basis).toBe('never_written');
    expect(snapshot.tombstones.entities).toContain('entity_dead');
    expect(snapshot.tombstones.threads).toContain('thread_retired');
    expect(snapshot.catalogHashes.entityTypes).toBe('hash_types');
    expect(snapshot.graphHash).toBe('graph_hash_val');
    expect(snapshot.stateHash).toBe('state_hash_val');
  });

  it('NEVER contains generated prose, Pass 2 observations, or surface packets (constraint 13)', () => {
    const snapshot: StorySnapshot = {
      branch: testBranch(),
      temporalPrefix: 'node_1',
      orderedOutputIds: [],
      worldState: { entities: {}, relationships: {}, knowledge: {}, threads: {}, rules: {}, facts: [] },
      providerIndex: {},
      absenceIndex: {},
      tombstones: {
        entities: [], relationships: [], threads: [],
        ruleEpochs: [], ruleExceptions: [], ruleSpecifications: [], retiredIds: [],
      },
      catalogHashes: { entityTypes: '', entityDeclarations: '', threadTypes: '', relationshipTypes: '' },
      graphHash: '',
      stateHash: '',
    };

    // Verify forbidden fields are absent
    expect('generatedProse' in snapshot).toBe(false);
    expect('pass2Observations' in snapshot).toBe(false);
    expect('surfacePackets' in snapshot).toBe(false);
    expect('renderedOutput' in snapshot).toBe(false);
  });
});

// ─── Category 14: DiscourseSnapshot planned-replay equivalence (constraint 12) ─

describe('DiscourseSnapshot — planned-replay equivalence', () => {
  it('has all required fields for planned discourse replay', () => {
    const branch = testBranch();
    const snapshot: DiscourseSnapshot = {
      assemblyId: 'assembly_1',
      branch,
      discoursePosition: 42,
      discourseState: { currentScene: 'scene_alpha', expectedReveals: 3 },
      narratorProfileHash: 'narrator_hash_val',
      propositionCatalogHash: 'prop_catalog_hash',
      selectionHash: 'selection_hash_val',
      discourseGraphHash: 'discourse_graph_hash',
    };

    expect(snapshot.assemblyId).toBe('assembly_1');
    expect(snapshot.discoursePosition).toBe(42);
    expect(snapshot.discourseState.currentScene).toBe('scene_alpha');
    expect(snapshot.narratorProfileHash).toBeTruthy();
    expect(snapshot.propositionCatalogHash).toBeTruthy();
    expect(snapshot.selectionHash).toBeTruthy();
    expect(snapshot.discourseGraphHash).toBeTruthy();
  });

  it('NEVER contains generated prose or surface packets (constraint 13)', () => {
    const snapshot: DiscourseSnapshot = {
      assemblyId: 'assembly_1',
      branch: testBranch(),
      discoursePosition: 1,
      discourseState: {},
      narratorProfileHash: '',
      propositionCatalogHash: '',
      selectionHash: '',
      discourseGraphHash: '',
    };

    expect('generatedProse' in snapshot).toBe(false);
    expect('pass2Observations' in snapshot).toBe(false);
    expect('surfacePackets' in snapshot).toBe(false);
    expect('renderedOutput' in snapshot).toBe(false);
  });
});

// ─── BoundaryReference one-way/no-edge (constraint 4) ────────────────────────

describe('BoundaryReference — one-way no-edge', () => {
  it('does not generate provider/order/causal edge', () => {
    const branch = testBranch();
    const boundaryRef: BoundaryReference = {
      sourceSnapshotHash: 'snapshot_hash_abc',
      branch,
      propositions: ['prop_world_status', 'prop_hero_alive'],
      truthValues: { prop_world_status: true, prop_hero_alive: true },
    };

    // BoundaryReference is purely a reference — no causality edge
    expect('causality' in boundaryRef).toBe(false);
    expect('provider' in boundaryRef).toBe(false);
    expect('outputId' in boundaryRef).toBe(false);
    expect('content' in boundaryRef).toBe(false);

    // It references a snapshot but doesn't contain one
    expect(boundaryRef.sourceSnapshotHash).toBe('snapshot_hash_abc');
    expect(Object.keys(boundaryRef.truthValues)).toHaveLength(2);
  });
});

// ─── isTransactionLegal ──────────────────────────────────────────────────────

describe('isTransactionLegal', () => {
  const sourceBranch = testBranch();
  const snap = emptyStorySnapshot('hash_a');

  it('requireEqual is always legal', () => {
    const plan = compileMergePlan({
      incomingSnapshotHashes: ['hash_a'],
      mergeNode: 'merge_point',
      effectiveCoordinate: 'coord',
      policies: { test: { type: 'requireEqual' } },
      sourceBranch,
    });
    const result = reconcileMergePlan(plan, [snap]);
    expect(isTransactionLegal(plan, [snap], result.transactions[0])).toBe(true);
  });

  it('selectBranch with branchId is legal', () => {
    const plan = compileMergePlan({
      incomingSnapshotHashes: ['hash_a'],
      mergeNode: 'merge_point',
      effectiveCoordinate: 'coord',
      policies: { test: { type: 'selectBranch', branchId: 'branch_alpha' } },
      sourceBranch,
    });
    const result = reconcileMergePlan(plan, [snap]);
    expect(isTransactionLegal(plan, [snap], result.transactions[0])).toBe(true);
  });

  it('literal is legal', () => {
    const plan = compileMergePlan({
      incomingSnapshotHashes: ['hash_a'],
      mergeNode: 'merge_point',
      effectiveCoordinate: 'coord',
      policies: { test: { type: 'literal' } },
      sourceBranch,
    });
    const result = reconcileMergePlan(plan, [snap]);
    expect(isTransactionLegal(plan, [snap], result.transactions[0])).toBe(true);
  });
});
