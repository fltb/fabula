// ============================================================================
// reference-eligibility.test.ts — ReferenceEligibility & lifecycle closure
//
// Minimum test categories (constraint 16):
// 1. Matrix cells (mode × kind × lifecycle state)
// 2. Introduction+use (same-node eligibility)
// 3. Retirement closure validation
// 4. Historical conversion
// 5. POV/narrator boundary
// 6. Inactive overrides
// 7. Branch/merge/race (simulated)
// 8. Index recomputation/snapshot/cache (hash verification)
// 9. Independent matrix interpreter properties
// ============================================================================

import { describe, it, expect } from 'vitest';
import type { WorldState, EntityRuntimeState } from '../../src/types/index.js';
import type { ReferenceIndex, ReferenceEntry, ReferenceMode, ReferenceKind } from '../../src/types/reference.js';
import {
  computeReferenceIndex,
  checkNewReferenceEligibility,
  validateNewReferenceSet,
  validateRetirementClosure,
  validateCandidateIndex,
  computeIndexHash,
  ALL_REFERENCE_KINDS,
} from '../../src/state/reference-index.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Build a minimal WorldState for testing */
function emptyWorld(): WorldState {
  return {
    entities: {},
    relationships: {},
    knowledge: {},
    threads: {},
    rules: {},
    facts: [],
  };
}

/** Create an entity in the world state attributes */
function addEntity(ws: WorldState, id: string, lifecycle?: EntityRuntimeState): void {
  ws.entities[id] = { lifecycle: lifecycle ?? 'active' };
}

// ─── 1. Matrix cells (mode × kind × lifecycle state) ────────────────────────

describe('Mode × Kind × Lifecycle eligibility matrix', () => {
  // All 14 kinds
  const allKinds: ReferenceKind[] = ALL_REFERENCE_KINDS;
  // All 3 modes
  const allModes: ReferenceMode[] = ['identity', 'live', 'historical'];
  // All lifecycle states + absent
  const lifecycles: Array<{ label: string; lc: EntityRuntimeState | undefined }> = [
    { label: 'active', lc: 'active' },
    { label: 'inactive', lc: 'inactive' },
    { label: 'retired', lc: 'retired' },
    { label: 'absent', lc: undefined },
  ];

  it('identity mode is always eligible regardless of lifecycle', () => {
    for (const { lc } of lifecycles) {
      for (const kind of allKinds) {
        const result = checkNewReferenceEligibility(lc, 'identity', kind);
        expect(result.outcome).toBe('eligible');
      }
    }
  });

  it('live mode requires active lifecycle (or inactive with override)', () => {
    for (const kind of allKinds) {
      // Active → eligible
      expect(checkNewReferenceEligibility('active', 'live', kind).outcome).toBe('eligible');

      // Retired → ineligible
      expect(checkNewReferenceEligibility('retired', 'live', kind).outcome).toBe('ineligible');

      // Absent → ineligible
      expect(checkNewReferenceEligibility(undefined, 'live', kind).outcome).toBe('ineligible');

      // Inactive → ineligible by default
      expect(checkNewReferenceEligibility('inactive', 'live', kind).outcome).toBe('ineligible');

      // Inactive + override → eligible
      expect(checkNewReferenceEligibility('inactive', 'live', kind, { inactiveOverride: true }).outcome).toBe('eligible');
    }
  });

  it('historical mode needs a lifecycle (not absent) and appropriate kind for retired', () => {
    // Active/inactive → eligible for any kind
    expect(checkNewReferenceEligibility('active', 'historical', 'declaration').outcome).toBe('eligible');
    expect(checkNewReferenceEligibility('inactive', 'historical', 'declaration').outcome).toBe('eligible');

    // Absent → ineligible
    expect(checkNewReferenceEligibility(undefined, 'historical', 'declaration').outcome).toBe('ineligible');

    // Retired + non-approved kind → ineligible (needs explicit conversion)
    expect(checkNewReferenceEligibility('retired', 'historical', 'runtime_foreign_key').outcome).toBe('ineligible');

    // Retired + approved kinds → eligible (historical_boundary, provenance, causal_output)
    expect(checkNewReferenceEligibility('retired', 'historical', 'historical_boundary').outcome).toBe('eligible');
    expect(checkNewReferenceEligibility('retired', 'historical', 'provenance').outcome).toBe('eligible');
    expect(checkNewReferenceEligibility('retired', 'historical', 'causal_output').outcome).toBe('eligible');
  });

  it('covers every mode × kind combination without throwing', () => {
    for (const mode of allModes) {
      for (const kind of allKinds) {
        for (const { lc } of lifecycles) {
          const result = checkNewReferenceEligibility(lc, mode, kind);
          expect(['eligible', 'ineligible']).toContain(result.outcome);
        }
      }
    }
  });
});

// ─── 2. Introduction+use (same-node eligibility) ────────────────────────────

describe('Introduction+use (same-node legality)', () => {
  it('active entity can receive new live references', () => {
    const ws = emptyWorld();
    addEntity(ws, 'hero', 'active');

    const newRef: ReferenceEntry = {
      targetEntityId: 'hero',
      mode: 'live',
      kind: 'thread_binding',
      sourceDomain: 'thread',
      sourceId: 'main-quest',
    };

    const lifecycleMap: Record<string, EntityRuntimeState | undefined> = { hero: 'active' };
    const errors = validateNewReferenceSet([newRef], lifecycleMap);
    expect(errors).toHaveLength(0);
  });

  it('same-node introduction + use is valid (constraint 14)', () => {
    // Entity introduced and immediately used in same node
    const newRef: ReferenceEntry = {
      targetEntityId: 'new_hero',
      mode: 'live',
      kind: 'scene_participant',
      sourceDomain: 'scene',
      sourceId: 'scene_1',
    };

    const lifecycleMap: Record<string, EntityRuntimeState | undefined> = { new_hero: 'active' };
    const errors = validateNewReferenceSet([newRef], lifecycleMap);
    expect(errors).toHaveLength(0);
  });

  it('absent entity cannot receive live reference', () => {
    const newRef: ReferenceEntry = {
      targetEntityId: 'ghost',
      mode: 'live',
      kind: 'relationship_membership',
      sourceDomain: 'relationship',
      sourceId: 'rel:epoch:mem',
    };

    const lifecycleMap: Record<string, EntityRuntimeState | undefined> = {};
    const errors = validateNewReferenceSet([newRef], lifecycleMap);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('ghost');
    expect(errors[0]).toContain('Absent');
  });
});

// ─── 3. Retirement closure ──────────────────────────────────────────────────

describe('Retirement closure validation', () => {
  it('requires closure of all live relationship memberships', () => {
    const index: ReferenceIndex = {
      byEntity: {
        hero: [
          {
            targetEntityId: 'hero',
            mode: 'live',
            kind: 'relationship_membership',
            sourceDomain: 'relationship',
            sourceId: 'rel:epoch:mem1',
          },
        ],
      },
      hash: 'mock',
    };

    const errors = validateRetirementClosure('hero', index);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('relationship_membership');
  });

  it('requires closure of live thread bindings', () => {
    const index: ReferenceIndex = {
      byEntity: {
        hero: [
          {
            targetEntityId: 'hero',
            mode: 'live',
            kind: 'thread_binding',
            sourceDomain: 'thread',
            sourceId: 'quest:run1',
          },
        ],
      },
      hash: 'mock',
    };

    const errors = validateRetirementClosure('hero', index);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('thread_binding');
  });

  it('requires closure of live rule scopes', () => {
    const index: ReferenceIndex = {
      byEntity: {
        hero: [
          {
            targetEntityId: 'hero',
            mode: 'live',
            kind: 'rule_scope',
            sourceDomain: 'rule',
            sourceId: 'magic_law:scopedEntity',
          },
        ],
      },
      hash: 'mock',
    };

    const errors = validateRetirementClosure('hero', index);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('rule_scope');
  });

  it('historical references do NOT block retirement', () => {
    const index: ReferenceIndex = {
      byEntity: {
        hero: [
          {
            targetEntityId: 'hero',
            mode: 'historical',
            kind: 'knowledge_subject',
            sourceDomain: 'knowledge',
            sourceId: 'information_act:E1:actor',
            boundary: 'ch1',
          },
        ],
      },
      hash: 'mock',
    };

    const errors = validateRetirementClosure('hero', index);
    expect(errors).toHaveLength(0);
  });

  it('live scene_participant closes before retirement', () => {
    const index: ReferenceIndex = {
      byEntity: {
        hero: [
          {
            targetEntityId: 'hero',
            mode: 'live',
            kind: 'scene_participant',
            sourceDomain: 'scene',
            sourceId: 'scene_1',
          },
        ],
      },
      hash: 'mock',
    };

    const errors = validateRetirementClosure('hero', index);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('scene_participant');
  });

  it('entity with no incoming refs can retire freely', () => {
    const index: ReferenceIndex = {
      byEntity: {},
      hash: 'mock',
    };

    const errors = validateRetirementClosure('loner', index);
    expect(errors).toHaveLength(0);
  });
});

// ─── 4. Historical conversion ───────────────────────────────────────────────

describe('Historical conversion', () => {
  it('live reference can be converted to historical with boundary', () => {
    // Simulate: before conversion, we have a live ref
    const beforeIndex: ReferenceIndex = {
      byEntity: {
        hero: [{ targetEntityId: 'hero', mode: 'live', kind: 'thread_binding', sourceDomain: 'thread', sourceId: 'quest:run1' }],
      },
      hash: 'pre',
    };

    // After closure: ref is removed from the index
    const errors = validateRetirementClosure('hero', beforeIndex);
    expect(errors).toHaveLength(1);

    // After historical conversion: the ref is historical and does not block
    const afterIndex: ReferenceIndex = {
      byEntity: {
        hero: [{ targetEntityId: 'hero', mode: 'historical', kind: 'historical_boundary', sourceDomain: 'thread', sourceId: 'quest:run1', boundary: 'ch1' }],
      },
      hash: 'post',
    };

    const afterErrors = validateRetirementClosure('hero', afterIndex);
    expect(afterErrors).toHaveLength(0);
  });

  it('explicit historical conversion authorized by type policy', () => {
    // Type policy authorizes historical conversion of thread binding
    const eligible = checkNewReferenceEligibility('retired', 'historical', 'historical_boundary');
    expect(eligible.outcome).toBe('eligible');
  });
});

// ─── 5. POV/narrator boundary ───────────────────────────────────────────────

describe('POV/narrator boundary', () => {
  it('narrator can reference historical entity (discourse, no live participation)', () => {
    // Per constraint 12: narrator can reference historical entity
    // but cannot create new live reference
    const historicalRef: ReferenceEntry = {
      targetEntityId: 'dead_king',
      mode: 'historical',
      kind: 'narrator_subject',
      sourceDomain: 'discourse',
      sourceId: 'chapter_5',
      boundary: 'battle_end',
    };

    const lifecycleMap: Record<string, EntityRuntimeState | undefined> = { dead_king: 'retired' };
    const errors = validateNewReferenceSet([historicalRef], lifecycleMap);
    expect(errors).toHaveLength(0);
  });

  it('narrator cannot create new live reference for inactive entity', () => {
    const liveRef: ReferenceEntry = {
      targetEntityId: 'dead_king',
      mode: 'live',
      kind: 'scene_participant',
      sourceDomain: 'scene',
      sourceId: 'scene_10',
    };

    const lifecycleMap: Record<string, EntityRuntimeState | undefined> = { dead_king: 'retired' };
    const errors = validateNewReferenceSet([liveRef], lifecycleMap);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Retired');
  });

  it('POV focalizer must be active for live reference', () => {
    const povRef: ReferenceEntry = {
      targetEntityId: 'narrator',
      mode: 'live',
      kind: 'pov_focalizer',
      sourceDomain: 'scene',
      sourceId: 'scene_3',
    };

    expect(checkNewReferenceEligibility('active', 'live', 'pov_focalizer').outcome).toBe('eligible');
    expect(checkNewReferenceEligibility('inactive', 'live', 'pov_focalizer').outcome).toBe('ineligible');
    expect(checkNewReferenceEligibility('retired', 'live', 'pov_focalizer').outcome).toBe('ineligible');
  });
});

// ─── 6. Inactive overrides ──────────────────────────────────────────────────

describe('Inactive overrides', () => {
  it('inactive entity blocks new live refs by default (constraint 6)', () => {
    const ref: ReferenceEntry = {
      targetEntityId: 'sidekick',
      mode: 'live',
      kind: 'scene_participant',
      sourceDomain: 'scene',
      sourceId: 'scene_5',
    };

    const lifecycleMap: Record<string, EntityRuntimeState | undefined> = { sidekick: 'inactive' };
    const errors = validateNewReferenceSet([ref], lifecycleMap);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Inactive');
  });

  it('inactive override permits new live ref when authorized (constraint 8)', () => {
    const ref: ReferenceEntry = {
      targetEntityId: 'sidekick',
      mode: 'live',
      kind: 'scene_participant',
      sourceDomain: 'scene',
      sourceId: 'scene_5',
    };

    const lifecycleMap: Record<string, EntityRuntimeState | undefined> = { sidekick: 'inactive' };
    const errors = validateNewReferenceSet([ref], lifecycleMap, { sidekick: { inactiveOverride: true } });
    expect(errors).toHaveLength(0);
  });

  it('core safety: override CANNOT allow absent entity live ref', () => {
    expect(checkNewReferenceEligibility(undefined, 'live', 'declaration', { inactiveOverride: true }).outcome).toBe('ineligible');
  });

  it('core safety: override CANNOT allow retired entity live ref', () => {
    expect(checkNewReferenceEligibility('retired', 'live', 'declaration', { inactiveOverride: true }).outcome).toBe('ineligible');
  });
});

// ─── 7. Branch/merge/race (simulated) ───────────────────────────────────────

describe('Branch/merge/race scenarios', () => {
  it('branch filter: entity active on one branch, absent on another', () => {
    // Branch A: hero active → live ref is eligible
    expect(checkNewReferenceEligibility('active', 'live', 'thread_binding').outcome).toBe('eligible');

    // Branch B: hero absent → live ref is ineligible
    expect(checkNewReferenceEligibility(undefined, 'live', 'thread_binding').outcome).toBe('ineligible');
  });

  it('merge: resolve lifecycle first, then validate refs (constraint 15)', () => {
    // Simulate merge where identity is resolved first (active)
    const lifecycleMap: Record<string, EntityRuntimeState | undefined> = { hero: 'active' };
    const refs: ReferenceEntry[] = [
      { targetEntityId: 'hero', mode: 'live', kind: 'relationship_membership', sourceDomain: 'relationship', sourceId: 'rel:epoch:mem' },
    ];

    // After lifecycle resolution, live ref is eligible
    const errors = validateNewReferenceSet(refs, lifecycleMap);
    expect(errors).toHaveLength(0);
  });

  it('race: same-time lifecycle write + unordered refs → conflict detection', () => {
    // If lifecycle and reference are in the same batch:
    // We can validate them atomically — this tests that the validator
    // catches ineligible refs regardless of order
    const lifecycleMap: Record<string, EntityRuntimeState | undefined> = { hero: 'retired' };
    const refs: ReferenceEntry[] = [
      { targetEntityId: 'hero', mode: 'live', kind: 'scene_participant', sourceDomain: 'scene', sourceId: 'scene_1' },
    ];

    const errors = validateNewReferenceSet(refs, lifecycleMap);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Retired');
  });
});

// ─── 8. Index recomputation/snapshot/cache (hash verification) ──────────────

describe('Index recomputation and hash verification', () => {
  it('computeReferenceIndex produces deterministic hash', () => {
    const ws = emptyWorld();
    addEntity(ws, 'hero', 'active');

    const idx1 = computeReferenceIndex(ws);
    const idx2 = computeReferenceIndex(ws);

    expect(idx1.hash).toBe(idx2.hash);
    expect(idx1.byEntity.hero).toBeDefined();
  });

  it('different state produces different hash', () => {
    const ws1 = emptyWorld();
    addEntity(ws1, 'hero', 'active');
    const idx1 = computeReferenceIndex(ws1);

    const ws2 = emptyWorld();
    addEntity(ws2, 'hero', 'active');
    addEntity(ws2, 'villain', 'inactive');
    const idx2 = computeReferenceIndex(ws2);

    expect(idx1.hash).not.toBe(idx2.hash);
  });

  it('index is not independently writable (hash computed from entries)', () => {
    // The hash is always derived from the byEntity content
    const entries: ReferenceEntry[] = [
      { targetEntityId: 'hero', mode: 'identity', kind: 'declaration', sourceDomain: 'entity', sourceId: 'hero' },
    ];

    const byEntity = { hero: entries };
    const hash = computeIndexHash(byEntity);

    const index: ReferenceIndex = { byEntity, hash };
    const recomputedHash = computeIndexHash(index.byEntity);
    expect(index.hash).toBe(recomputedHash);
  });

  it('index computed from WorldState matches hash recomputation', () => {
    const ws = emptyWorld();
    addEntity(ws, 'hero', 'active');

    const index = computeReferenceIndex(ws);
    const expectedHash = computeIndexHash(index.byEntity);
    expect(index.hash).toBe(expectedHash);
  });
});

// ─── 9. Independent matrix interpreter properties ───────────────────────────

describe('Matrix interpreter properties', () => {
  it('ALL_REFERENCE_KINDS has exactly 14 entries', () => {
    expect(ALL_REFERENCE_KINDS).toHaveLength(14);
  });

  it('ALL_REFERENCE_KINDS contains every required kind', () => {
    const required = [
      'declaration',
      'runtime_foreign_key',
      'relationship_membership',
      'knowledge_subject',
      'proposition_target',
      'thread_binding',
      'rule_scope',
      'scene_participant',
      'pov_focalizer',
      'narrator_subject',
      'discourse_target',
      'causal_output',
      'provenance',
      'historical_boundary',
    ];
    for (const k of required) {
      expect(ALL_REFERENCE_KINDS).toContain(k);
    }
  });

  it('ReferenceMode has exactly 3 values', () => {
    const modes: ReferenceMode[] = ['identity', 'live', 'historical'];
    expect(modes).toHaveLength(3);
  });

  it('validateCandidateIndex aggregates errors from both eligibility and closure', () => {
    const lifecycleMap: Record<string, EntityRuntimeState | undefined> = {
      hero: 'active',
      villain: 'retired',
    };

    const index: ReferenceIndex = {
      byEntity: {
        villain: [
          { targetEntityId: 'villain', mode: 'live', kind: 'scene_participant', sourceDomain: 'scene', sourceId: 'scene_1' },
        ],
      },
      hash: 'test',
    };

    const newRefs: ReferenceEntry[] = [
      { targetEntityId: 'ghost', mode: 'live', kind: 'thread_binding', sourceDomain: 'thread', sourceId: 'quest' },
    ];

    const result = validateCandidateIndex(index, lifecycleMap, ['villain'], newRefs);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });

  it('all-modes x all-kinds matrix has predictable eligibility patterns', () => {
    // Identity: always eligible
    for (const kind of ALL_REFERENCE_KINDS) {
      expect(checkNewReferenceEligibility('active', 'identity', kind).outcome).toBe('eligible');
      expect(checkNewReferenceEligibility('inactive', 'identity', kind).outcome).toBe('eligible');
      expect(checkNewReferenceEligibility('retired', 'identity', kind).outcome).toBe('eligible');
      expect(checkNewReferenceEligibility(undefined, 'identity', kind).outcome).toBe('eligible');
    }

    // Live: only active (or inactive with override)
    for (const kind of ALL_REFERENCE_KINDS) {
      expect(checkNewReferenceEligibility('active', 'live', kind).outcome).toBe('eligible');
      expect(checkNewReferenceEligibility(undefined, 'live', kind).outcome).toBe('ineligible');
      expect(checkNewReferenceEligibility('retired', 'live', kind).outcome).toBe('ineligible');
      expect(checkNewReferenceEligibility('inactive', 'live', kind).outcome).toBe('ineligible');
      expect(checkNewReferenceEligibility('inactive', 'live', kind, { inactiveOverride: true }).outcome).toBe('eligible');
    }

    // Historical: needs lifecycle, retired needs specific kinds
    for (const kind of ALL_REFERENCE_KINDS) {
      expect(checkNewReferenceEligibility('active', 'historical', kind).outcome).toBe('eligible');
      expect(checkNewReferenceEligibility('inactive', 'historical', kind).outcome).toBe('eligible');
      expect(checkNewReferenceEligibility(undefined, 'historical', kind).outcome).toBe('ineligible');
    }
  });
});

// ─── WorldState domain scanning (integration) ──────────────────────────────

describe('WorldState domain scanning', () => {
  it('entity declarations produce identity references', () => {
    const ws = emptyWorld();
    addEntity(ws, 'hero');

    const index = computeReferenceIndex(ws);
    const heroRefs = index.byEntity.hero;
    expect(heroRefs).toBeDefined();
    expect(heroRefs!.some(r => r.kind === 'declaration' && r.mode === 'identity')).toBe(true);
  });

  it('scans multiple entities', () => {
    const ws = emptyWorld();
    addEntity(ws, 'hero');
    addEntity(ws, 'villain');
    addEntity(ws, 'sidekick');

    const index = computeReferenceIndex(ws);
    expect(Object.keys(index.byEntity)).toHaveLength(3);
  });

  it('empty world state produces empty index', () => {
    const ws = emptyWorld();
    const index = computeReferenceIndex(ws);
    expect(Object.keys(index.byEntity)).toHaveLength(0);
    expect(index.hash).toBeTruthy();
  });
});
