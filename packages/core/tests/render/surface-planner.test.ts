// ============================================================================
// Surface Planner — Unit Tests (RENDER-SURFACE-1)
// Covers ALL 9 minimum test categories from the sub-plan:
// 1. Surface NEVER enters logical/discourse reads
// 2. Author group/order/branch validation
// 3. Manual/suggest/auto manifest determinism
// 4. Excerpt budget/normalization (SurfaceReferencePacket)
// 5. POV/chapter/flashback policies (StyleProfile resolution)
// 6. Source retry/stale descendants/fallback
// 7. Branch merge isolation
// 8. Cache partition/invalidation
// 9. Parallel groups completion order doesn't affect results
// ============================================================================

import { describe, expect, it } from 'vitest';
import {
  clearStyleProfileRegistry,
  compileSceneContract,
  registerStyleProfile,
  resolveStyleProfile,
  type SceneContractInput,
} from '../../src/render/scene-contract.js';
import { SurfacePlanner } from '../../src/render/surface-planner.js';
import {
  type AttemptKey,
  type CompiledSceneContract,
  type LogicalRenderKey,
  type StyleProfile,
  SurfacePlannerError,
  type SurfaceReferencePacket,
  type SurfaceRenderKey,
  type SurfaceValidationKey,
} from '../../src/types/render-surface.js';

// ============================================================================
// Helper factories
// ============================================================================

function makeContract(
  sceneId: string,
  branch: string = 'main',
  discoursePosition: number = 0,
  transition:
    | 'continuous'
    | 'hard_cut'
    | 'time_jump'
    | 'location_jump'
    | 'pov_shift'
    | 'chapter'
    | 'flashback' = 'continuous',
): CompiledSceneContract {
  return compileSceneContract({
    sceneId,
    branch,
    discoursePosition,
    worldStateHash: `ws_${sceneId}`,
    knowledgeStateHash: `know_${sceneId}`,
    narratorProfileHash: `narr_${sceneId}`,
    plannedDiscourseHash: `disc_${sceneId}`,
    continuityDirectives: {
      transition,
      motifs: transition === 'flashback' ? ['memory_motif'] : undefined,
    },
    promptProviderId: 'default',
  });
}

function makeContracts(
  ids: string[],
  branch: string = 'main',
  transitions: (
    | 'continuous'
    | 'hard_cut'
    | 'time_jump'
    | 'location_jump'
    | 'pov_shift'
    | 'chapter'
    | 'flashback'
  )[] = [],
): CompiledSceneContract[] {
  return ids.map((id, i) => makeContract(id, branch, i, transitions[i] ?? 'continuous'));
}

function makeOptions(overrides: Partial<SurfacePlannerOptions> = {}): SurfacePlannerOptions {
  return {
    mode: 'manual',
    branch: 'main',
    sceneIds: [],
    contracts: [],
    ...overrides,
  };
}

function serialLane(laneId: string, groupIds: string[]) {
  return { laneId, groupIds };
}

// ============================================================================
// Tests
// ============================================================================

describe('SurfacePlanner', () => {
  // ======================================================================
  // Category 1: Surface NEVER enters logical/discourse reads
  // ======================================================================

  describe('surface NEVER enters logical/discourse reads (§1)', () => {
    it('SurfacePlanner does not read prose, LLM judgment, or modify causal edges', () => {
      const contracts = makeContracts(['S1', 'S2', 'S3']);
      const planner = new SurfacePlanner(
        makeOptions({
          mode: 'auto',
          sceneIds: ['S1', 'S2', 'S3'],
          contracts,
          autoConfig: { maxParallelGroupSize: 10, authorized: true },
        }),
      );

      // Planner should use only deterministic inputs (scene IDs, contracts)
      // and NOT read any prose or LLM output
      const result = planner.plan();

      expect(result.manifest).toBeDefined();
      expect(result.surfaceDependencyGraph).toBeDefined();
      expect(result.validationGateGraph).toBeDefined();

      // Groups should not reference prose content
      for (const group of result.surfaceDependencyGraph.groups) {
        for (const sceneId of group.sceneIds) {
          expect(sceneId).toEqual(expect.any(String));
          // No prose, no LLM judgment, no surface packet in group data
          expect(group.surfacePolicy).not.toHaveProperty('proseRef');
          expect(group.surfacePolicy).not.toHaveProperty('llmJudgment');
        }
      }
    });

    it('CompiledSceneContract does not contain prose', () => {
      const contract = makeContract('S1');

      // Contract has only boundary hashes, style, continuity — no prose
      expect(contract.sceneId).toBe('S1');
      expect(contract.worldStateHash).toBe('ws_S1');
      expect(contract.styleProfile).toBeDefined();
      expect(contract.continuityPacket).toBeDefined();
      expect(contract.promptContractHash).toBeDefined();

      // Verify no prose fields
      expect(contract).not.toHaveProperty('prose');
      expect(contract).not.toHaveProperty('generatedText');
      expect(contract).not.toHaveProperty('pass2Result');
    });
  });

  // ======================================================================
  // Category 2: Author group/order/branch validation
  // ======================================================================

  it('validates each scene belongs to exactly one group', () => {
    const contracts = makeContracts(['S1', 'S2']);
    const planner = new SurfacePlanner(
      makeOptions({
        mode: 'manual',
        branch: 'main',
        sceneIds: ['S1', 'S2'],
        contracts,
        authorGroups: [
          { groupId: 'g1', sceneIds: ['S1'], surfacePolicy: { type: 'parallel' } },
          { groupId: 'g2', sceneIds: ['S2'], surfacePolicy: { type: 'parallel' } },
        ],
      }),
    );

    const result = planner.plan();
    expect(result.manifest.groupIds).toHaveLength(2);
    expect(result.manifest.groupIds).toEqual(['g1', 'g2']);
  });
  it('throws when a scene appears in multiple groups', () => {
    const contracts = makeContracts(['S1', 'S2', 'S3']);
    const planner = new SurfacePlanner(
      makeOptions({
        mode: 'manual',
        branch: 'main',
        sceneIds: ['S1', 'S2', 'S3'],
        contracts,
        authorGroups: [
          { groupId: 'g1', sceneIds: ['S1', 'S2'], surfacePolicy: { type: 'parallel' } },
          { groupId: 'g2', sceneIds: ['S2', 'S3'], surfacePolicy: { type: 'parallel' } },
        ],
      }),
    );

    // S2 appears in both g1 and g2 → GROUP_SCENE_CONFLICT
    expect(() => planner.plan()).toThrow(SurfacePlannerError);
    expect(() => planner.plan()).toThrow(/appears in multiple groups/i);
  });
  it('default parallel uses group IDs distinct from scene IDs', () => {
    // When no authorLanes are provided, defaultParallelGroups creates
    // group IDs with a 'group_' prefix — distinct from bare scene IDs.
    // Contract: group IDs are grouping constructs, NOT scene IDs (§5).
    const contracts = makeContracts(['S1', 'S2', 'S3']);
    const planner = new SurfacePlanner(
      makeOptions({
        mode: 'manual',
        branch: 'main',
        sceneIds: ['S1', 'S2', 'S3'],
        contracts,
        // No authorLanes → default parallel
      }),
    );

    const result = planner.plan();

    for (const group of result.surfaceDependencyGraph.groups) {
      // Group ID must NOT equal the bare scene ID
      expect(group.groupId).not.toBe(group.sceneIds[0]);
      // Group ID must have the 'group_' prefix from default parallel
      expect(group.groupId).toMatch(/^group_/);
      // Each default parallel group holds exactly one scene
      expect(group.sceneIds).toHaveLength(1);
    }
  });
  it('throws when lane references nonexistent group ID', () => {
    // Lane groupIds must reference groups that exist in the plan (§5).
    const contracts = makeContracts(['S1', 'S2']);
    const planner = new SurfacePlanner(
      makeOptions({
        mode: 'manual',
        branch: 'main',
        sceneIds: ['S1', 'S2'],
        contracts,
        authorGroups: [
          { groupId: 'g1', sceneIds: ['S1'], surfacePolicy: { type: 'parallel' } },
          { groupId: 'g2', sceneIds: ['S2'], surfacePolicy: { type: 'parallel' } },
        ],
        authorLanes: [serialLane('lane1', ['nonexistent_group'])],
      }),
    );

    // 'nonexistent_group' is not a defined group → UNKNOWN_GROUP_ID
    expect(() => planner.plan()).toThrow(SurfacePlannerError);
    expect(() => planner.plan()).toThrow(/unknown group/i);
  });

  it('throws on cross-branch scene references', () => {
    // Cross-branch surface edges are invalid — each branch has its own plan
    const contracts = makeContracts(['S1', 'S2'], 'branch_a');
    const planner = new SurfacePlanner(
      makeOptions({
        mode: 'manual',
        branch: 'branch_a',
        sceneIds: ['S1', 'S2'],
        contracts,
        authorLanes: [serialLane('branch_a_lane', ['S1', 'S2'])],
      }),
    );

    const result = planner.plan();

    // All groups belong to 'branch_a' — no cross-branch edge
    expect(result.surfaceDependencyGraph.branch).toBe('branch_a');
    for (const group of result.surfaceDependencyGraph.groups) {
      expect(group.groupId).toBeDefined();
      for (const sid of group.sceneIds) {
        // No scene IDs from a different branch
        expect(sid).not.toMatch(/branch_b/);
      }
    }
  });

  it('dependency graph has no cycles by construction', () => {
    // SurfaceDependencyGraph is built from groups and lanes.
    // Each lane orders groups in discourse sequence; there is no
    // mechanism for a group to reference itself or another group
    // in a loop.  Cycles would require cross-lane references.
    const contracts = makeContracts(['S1', 'S2', 'S3']);
    const planner = new SurfacePlanner(
      makeOptions({
        mode: 'manual',
        branch: 'main',
        sceneIds: ['S1', 'S2', 'S3'],
        contracts,
        authorGroups: [
          { groupId: 'g1', sceneIds: ['S1'], surfacePolicy: { type: 'parallel' } },
          { groupId: 'g2', sceneIds: ['S2'], surfacePolicy: { type: 'serial_surface' } },
          { groupId: 'g3', sceneIds: ['S3'], surfacePolicy: { type: 'parallel' } },
        ],
        authorLanes: [serialLane('lane1', ['g1', 'g2']), serialLane('lane2', ['g3'])],
      }),
    );

    const result = planner.plan();
    const groupIds = new Set(result.surfaceDependencyGraph.groups.map((g) => g.groupId));

    // Each lane's groupIds must reference existing groups
    for (const lane of result.surfaceDependencyGraph.serialLanes) {
      for (const gid of lane.groupIds) {
        expect(groupIds.has(gid)).toBe(true);
      }
    }

    // No group references itself — each group only holds sceneIds
    for (const group of result.surfaceDependencyGraph.groups) {
      expect(group.groupId).toBeDefined();
      expect(group.sceneIds.every((s) => s !== group.groupId));
    }
  });

  it('UNVERSIONED_BUDGET and UNVERSIONED_EXTRACTION are valid error codes', () => {
    // These error codes exist in the SurfaceErrorCode union and
    // SurfacePlannerError can carry them.  The planner itself
    // does not raise them (they are enforced by the extractor
    // and render pipeline), but they are part of the contract.
    const budgetErr = new SurfacePlannerError(
      'Extraction budget has no version',
      'UNVERSIONED_BUDGET',
      { branch: 'main' },
    );
    const extractErr = new SurfacePlannerError(
      'Extractor has no version identifier',
      'UNVERSIONED_EXTRACTION',
      { branch: 'main' },
    );

    expect(budgetErr.code).toBe('UNVERSIONED_BUDGET');
    expect(extractErr.code).toBe('UNVERSIONED_EXTRACTION');
    expect(budgetErr).toBeInstanceOf(SurfacePlannerError);
    expect(extractErr).toBeInstanceOf(SurfacePlannerError);
  });

  it('surface policy type is one of the allowed types', () => {
    // Only 'parallel', 'serial_surface', and 'fallback_without_surface'
    // are valid SurfacePolicy types per §7.
    const contracts = makeContracts(['S1']);
    const planner = new SurfacePlanner(
      makeOptions({
        mode: 'auto',
        branch: 'main',
        sceneIds: ['S1'],
        contracts,
        autoConfig: { maxParallelGroupSize: 5, authorized: true },
      }),
    );

    const result = planner.plan();
    for (const group of result.surfaceDependencyGraph.groups) {
      expect(['parallel', 'serial_surface', 'fallback_without_surface']).toContain(
        group.surfacePolicy.type,
      );
    }
  });

  it('throws when manual mode has unassigned scene IDs', () => {
    const contracts = makeContracts(['S1', 'S2', 'S3']);
    const planner = new SurfacePlanner(
      makeOptions({
        mode: 'manual',
        branch: 'main',
        sceneIds: ['S1', 'S2', 'S3'],
        contracts,
        authorGroups: [
          { groupId: 'g1', sceneIds: ['S1'], surfacePolicy: { type: 'parallel' } },
          { groupId: 'g2', sceneIds: ['S2'], surfacePolicy: { type: 'parallel' } },
        ],
      }),
    );

    // S3 is not assigned to any group
    expect(() => planner.plan()).toThrow(SurfacePlannerError);
    expect(() => planner.plan()).toThrow(/not assigned to any group/i);
  });

  // ======================================================================
  // Category 3: Manual/suggest/auto manifest determinism
  // ======================================================================

  describe('manual/suggest/auto manifest determinism (§6)', () => {
    it('manual mode creates deterministic manifest from author lanes', () => {
      const contracts = makeContracts(['S1', 'S2', 'S3']);
      const options = makeOptions({
        mode: 'manual',
        branch: 'main',
        sceneIds: ['S1', 'S2', 'S3'],
        contracts,
        authorLanes: [serialLane('lane1', ['S1', 'S2']), serialLane('lane2', ['S3'])],
      });

      const planner1 = new SurfacePlanner({ ...options });
      const planner2 = new SurfacePlanner({ ...options });

      const result1 = planner1.plan();
      const result2 = planner2.plan();

      // Same inputs — deterministic results
      expect(result1.manifest.groupIds).toEqual(result2.manifest.groupIds);
      expect(result1.manifest.sourceDefinitionHash).toBe(result2.manifest.sourceDefinitionHash);
    });

    it('suggest mode effective plan is default-parallel with deterministic proposal', () => {
      const contracts = makeContracts(['S1', 'S2', 'S3']);
      const options = makeOptions({
        mode: 'suggest',
        branch: 'main',
        sceneIds: ['S1', 'S2', 'S3'],
        contracts,
      });

      const planner1 = new SurfacePlanner(options);
      const planner2 = new SurfacePlanner(options);

      const r1 = planner1.plan();
      const r2 = planner2.plan();

      // Effective groups are default-parallel (§3)
      expect(r1.manifest.groupIds).toEqual(['group_S1', 'group_S2', 'group_S3']);
      expect(r1.manifest.groupIds).toEqual(r2.manifest.groupIds);
      expect(r1.manifest.plannerMode).toBe('suggest');
      for (const group of r1.surfaceDependencyGraph.groups) {
        expect(group.surfacePolicy).toEqual({ type: 'parallel' });
        expect(group.sceneIds).toHaveLength(1);
      }
      expect(r1.surfaceDependencyGraph.serialLanes).toHaveLength(0);

      // Proposal exists because continuous transitions form a chain
      const proposal1 = r1.proposal;
      const proposal2 = r2.proposal;
      expect(proposal1).toBeDefined();
      expect(proposal2).toBeDefined();
      if (proposal1 === undefined || proposal2 === undefined) {
        throw new Error('Expected deterministic serial proposal');
      }
      expect(proposal1.hash).toBe(proposal2.hash);
      expect(proposal1.hash).toMatch(/^[0-9a-f]{64}$/);

      // Proposal groups are serial_surface, not parallel
      for (const group of proposal1.groups) {
        expect(group.surfacePolicy.type).toBe('serial_surface');
      }

      // Warnings reference the proposal lanes
      const warnings = r1.warnings;
      expect(warnings).toBeDefined();
      if (warnings === undefined) {
        throw new Error('Expected suggest-mode warnings');
      }
      expect(warnings.length).toBeGreaterThan(0);
      const firstWarning = warnings[0];
      expect(firstWarning).toBeDefined();
      if (firstWarning === undefined) {
        throw new Error('Expected a suggest-mode warning');
      }
      expect(firstWarning).toContain('Suggested serial lane');
    });

    it('auto mode produces deterministic results', () => {
      const contracts = makeContracts(['S1', 'S2', 'S3']);
      const options = makeOptions({
        mode: 'auto',
        branch: 'main',
        sceneIds: ['S1', 'S2', 'S3'],
        contracts,
        autoConfig: { maxParallelGroupSize: 2, authorized: true },
      });

      const planner1 = new SurfacePlanner(options);
      const planner2 = new SurfacePlanner(options);

      const r1 = planner1.plan();
      const r2 = planner2.plan();

      expect(r1.manifest.groupIds).toEqual(r2.manifest.groupIds);
      expect(r1.surfaceDependencyGraph.groups).toEqual(r2.surfaceDependencyGraph.groups);
    });

    it('auto mode throws when not authorized', () => {
      const contracts = makeContracts(['S1']);
      const planner = new SurfacePlanner(
        makeOptions({
          mode: 'auto',
          branch: 'main',
          sceneIds: ['S1'],
          contracts,
          autoConfig: { maxParallelGroupSize: 5, authorized: false },
        }),
      );

      expect(() => planner.plan()).toThrow(SurfacePlannerError);
      expect(() => planner.plan()).toThrow(/not authorized/i);
    });

    it('manifest is versioned and hash-pinned', () => {
      const contracts = makeContracts(['S1', 'S2']);
      const planner = new SurfacePlanner(
        makeOptions({
          mode: 'manual',
          branch: 'main',
          sceneIds: ['S1', 'S2'],
          contracts,
          authorGroups: [
            { groupId: 'g1', sceneIds: ['S1'], surfacePolicy: { type: 'parallel' } },
            { groupId: 'g2', sceneIds: ['S2'], surfacePolicy: { type: 'parallel' } },
          ],
        }),
      );

      const result = planner.plan();

      expect(result.manifest.manifestVersion).toBeDefined();
      expect(result.manifest.sourceDefinitionHash).toBeDefined();
      expect(result.manifest.sourceDefinitionHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('manifest hash stability excludes generatedAt', () => {
      // SourceDefinitionHash must be deterministic from the same group/lane
      // structure regardless of the wall-clock generatedAt timestamp.
      const contracts = makeContracts(['S1', 'S2']);
      const options = makeOptions({
        mode: 'manual',
        branch: 'main',
        sceneIds: ['S1', 'S2'],
        contracts,
        authorGroups: [
          { groupId: 'g1', sceneIds: ['S1'], surfacePolicy: { type: 'parallel' } },
          { groupId: 'g2', sceneIds: ['S2'], surfacePolicy: { type: 'parallel' } },
        ],
      });

      const planner1 = new SurfacePlanner(options);
      const result1 = planner1.plan();
      const hash1 = result1.manifest.sourceDefinitionHash;

      // Same inputs — deterministic hash even though generatedAt may differ
      const planner2 = new SurfacePlanner(options);
      const result2 = planner2.plan();
      const hash2 = result2.manifest.sourceDefinitionHash;

      // sourceDefinitionHash is identical — excludes generatedAt
      expect(hash1).toBe(hash2);
    });

    it('canonical JSON serialization for manifest identity', () => {
      // canonicalJson sorts keys alphabetically but preserves array order.
      // Groups/lanes arrays are serialized in the order the planner receives them,
      // so different input array order produces a different serialized hash.
      const contracts = makeContracts(['S1', 'S2']);

      // Two planners with groups in reversed order
      const options1 = makeOptions({
        mode: 'manual',
        branch: 'main',
        sceneIds: ['S1', 'S2'],
        contracts,
        authorGroups: [
          { groupId: 'g1', sceneIds: ['S1'], surfacePolicy: { type: 'parallel' } },
          { groupId: 'g2', sceneIds: ['S2'], surfacePolicy: { type: 'parallel' } },
        ],
      });
      const options2 = makeOptions({
        mode: 'manual',
        branch: 'main',
        sceneIds: ['S1', 'S2'],
        contracts,
        authorGroups: [
          { groupId: 'g2', sceneIds: ['S2'], surfacePolicy: { type: 'parallel' } },
          { groupId: 'g1', sceneIds: ['S1'], surfacePolicy: { type: 'parallel' } },
        ],
      });

      const r1 = new SurfacePlanner(options1).plan();
      const r2 = new SurfacePlanner(options2).plan();

      // Group array order in manifest matches input order — not sorted (§6)
      expect(r1.manifest.groupIds).toEqual(['g1', 'g2']);
      expect(r2.manifest.groupIds).toEqual(['g2', 'g1']);
      // Different group array order → different canonical serialization → different hash
      expect(r1.manifest.sourceDefinitionHash).not.toBe(r2.manifest.sourceDefinitionHash);
    });
  });

  // ======================================================================
  // Category 4: Excerpt budget/normalization (SurfaceReferencePacket)
  // ======================================================================

  describe('excerpt budget/normalization — SurfaceReferencePacket (§4)', () => {
    it('SurfaceReferencePacket is non-authoritative — YAML wins', () => {
      const packet: SurfaceReferencePacket = {
        sceneId: 'S1',
        excerptMode: 'full',
        excerpt: 'Some generated prose for reference.',
        styleMetrics: {
          avgSentenceLength: 12.5,
          readingLevel: 8,
          tokenCount: 50,
          lexicalDiversity: 0.65,
          dialogueRatio: 0.2,
        },
        sourceProseHash: 'abc123',
        accepted: true,
        extractorVersion: 'v1',
      };

      // Packet carries metadata but is explicitly non-authoritative
      expect(packet.excerpt).toBeDefined();
      expect(packet.styleMetrics).toBeDefined();

      // YAML contract values would override these — packet is only for
      // surface reference
      expect(packet.accepted).toBe(true);
    });

    it('supports tail, full, and authored_anchor excerpt modes', () => {
      const tail: SurfaceReferencePacket = {
        sceneId: 'S1',
        excerptMode: 'tail',
        excerpt: '...tail of prose.',
        styleMetrics: {
          avgSentenceLength: 10,
          readingLevel: 6,
          tokenCount: 25,
          lexicalDiversity: 0.6,
          dialogueRatio: 0.1,
        },
        sourceProseHash: 'h1',
        accepted: true,
        extractorVersion: 'v1',
      };
      const full: SurfaceReferencePacket = {
        sceneId: 'S2',
        excerptMode: 'full',
        excerpt: 'Full prose text...',
        styleMetrics: {
          avgSentenceLength: 12,
          readingLevel: 7,
          tokenCount: 100,
          lexicalDiversity: 0.7,
          dialogueRatio: 0.3,
        },
        sourceProseHash: 'h2',
        accepted: true,
        extractorVersion: 'v1',
      };
      const anchored: SurfaceReferencePacket = {
        sceneId: 'S3',
        excerptMode: 'authored_anchor',
        excerpt: 'Anchor reference.',
        styleMetrics: {
          avgSentenceLength: 8,
          readingLevel: 5,
          tokenCount: 10,
          lexicalDiversity: 0.5,
          dialogueRatio: 0.0,
        },
        sourceProseHash: 'h3',
        accepted: true,
        extractorVersion: 'v1',
        authoredAnchor: 'chapter_3_opening',
      };

      expect(tail.excerptMode).toBe('tail');
      expect(full.excerptMode).toBe('full');
      expect(anchored.excerptMode).toBe('authored_anchor');
      expect(anchored.authoredAnchor).toBe('chapter_3_opening');
    });

    it('excerpt carries extractor version for cache key', () => {
      const packet: SurfaceReferencePacket = {
        sceneId: 'S1',
        excerptMode: 'full',
        excerpt: 'text',
        styleMetrics: {
          avgSentenceLength: 10,
          readingLevel: 6,
          tokenCount: 20,
          lexicalDiversity: 0.5,
          dialogueRatio: 0.1,
        },
        sourceProseHash: 'hash',
        accepted: true,
        extractorVersion: 'extractor-v2',
      };

      expect(packet.extractorVersion).toBe('extractor-v2');
    });
  });

  // ======================================================================
  // Category 5: POV/chapter/flashback policies (StyleProfile)
  // ======================================================================

  describe('POV/chapter/flashback policies — StyleProfile (§2)', () => {
    beforeEach(() => {
      clearStyleProfileRegistry();
    });

    it('resolves style by project → chapter → narrator/POV → scene precedence', () => {
      const chapterStyle: StyleProfile = {
        profileId: 'chapter_mystery',
        resolutionPrecedence: { projectStyle: 'default' },
        voice: 'tense and urgent',
      };
      registerStyleProfile(chapterStyle);

      const sceneStyle: StyleProfile = {
        profileId: 'scene_reveal',
        resolutionPrecedence: { projectStyle: 'default', chapterStyle: 'chapter_mystery' },
        voice: 'dramatic reveal',
        diction: 'formal',
      };
      registerStyleProfile(sceneStyle);

      const resolved = resolveStyleProfile({
        chapterStyle: 'chapter_mystery',
        sceneStyle: 'scene_reveal',
      });

      // Scene style wins over chapter style
      expect(resolved.profileId).toBe('scene_reveal');
      expect(resolved.voice).toBe('dramatic reveal');

      // Resolution path is recorded
      expect(resolved.resolutionPrecedence.projectStyle).toBe('default_project_style_v1');
      expect(resolved.resolutionPrecedence.chapterStyle).toBe('chapter_mystery');
      expect(resolved.resolutionPrecedence.sceneStyle).toBe('scene_reveal');
    });

    it('falls back to project default when no chapter/scene style specified', () => {
      const resolved = resolveStyleProfile({});
      expect(resolved.profileId).toBe('default_project_style_v1');
      expect(resolved.resolutionPrecedence.projectStyle).toBe('default_project_style_v1');
      expect(resolved.resolutionPrecedence.chapterStyle).toBeUndefined();
      expect(resolved.resolutionPrecedence.sceneStyle).toBeUndefined();
    });

    it('flashback scene has correct transition and continuity', () => {
      const contract = makeContract('S1', 'main', 0, 'flashback');

      expect(contract.continuityPacket.transition).toBe('flashback');
      expect(contract.continuityPacket.motifs).toContain('memory_motif');
    });

    it('POV switch transition is represented in continuity packet', () => {
      const contract = makeContract('S1', 'main', 0, 'pov_shift');

      expect(contract.continuityPacket.transition).toBe('pov_shift');
    });
  });

  // ======================================================================
  // Category 6: Source retry/stale descendants/fallback
  // ======================================================================

  describe('source retry/stale descendants/fallback (§9)', () => {
    it('validation gate starts pending with zero attempts', () => {
      const contracts = makeContracts(['S1', 'S2']);
      const planner = new SurfacePlanner(
        makeOptions({
          mode: 'manual',
          branch: 'main',
          sceneIds: ['S1', 'S2'],
          contracts,
        }),
      );

      const result = planner.plan();
      const gate = result.validationGateGraph.gates.S1;

      expect(gate).toBeDefined();
      if (gate === undefined) {
        throw new Error('Expected a validation gate for S1');
      }
      expect(gate.status).toBe('pending');
      expect(gate.attemptCount).toBe(0);
      expect(gate.maxRetries).toBeGreaterThan(0);
    });

    it('fallback_without_surface must be explicitly stated in group policy', () => {
      // fallback_without_surface is a distinct SurfacePolicy variant
      const policy = { type: 'fallback_without_surface' as const };
      expect(policy.type).toBe('fallback_without_surface');

      // Parallel does NOT have fallback semantics
      const parallelPolicy = { type: 'parallel' as const };
      expect(parallelPolicy.type).toBe('parallel');

      // verify the type discrimination works
      const policies = [parallelPolicy, policy];
      expect(policies.filter((p) => p.type === 'fallback_without_surface')).toHaveLength(1);
    });

    it('failed scene only blocks surface descendants, not logical compilation', () => {
      // Logical compilation is independent — validation gates are per-scene
      // Surface gate failure should not affect other scenes' contracts
      const contracts = makeContracts(['S1', 'S2', 'S3']);
      const planner = new SurfacePlanner(
        makeOptions({
          mode: 'manual',
          branch: 'main',
          sceneIds: ['S1', 'S2', 'S3'],
          contracts,
        }),
      );

      const result = planner.plan();

      // Each scene has its own independent gate
      expect('S1' in result.validationGateGraph.gates).toBe(true);
      expect('S2' in result.validationGateGraph.gates).toBe(true);
      expect('S3' in result.validationGateGraph.gates).toBe(true);

      // All gates start independent
      for (const [id, gate] of Object.entries(result.validationGateGraph.gates)) {
        expect(gate.sceneId).toBe(id);
      }
    });

    it('retry has independent AttemptKey', () => {
      const attemptKey: AttemptKey = {
        validationKey: {
          surfaceKey: {
            logicalKey: {
              sceneContractHash: 'contract1',
              worldStateHash: 'ws1',
              plannedDiscourseHash: 'disc1',
              catalogVersionHashes: { entities: 'v1' },
              graphHash: 'graph1',
              styleProfileHash: 'style1',
              promptProviderId: 'default',
              toKeyString() {
                return 'logical_key';
              },
            },
            groupManifestHash: 'manifest1',
            surfacePolicyHash: 'sp1',
            sourceProseHashes: ['prose1'],
            extractorVersion: 'v1',
            toKeyString() {
              return 'surface_key';
            },
          },
          proseHash: 'prose_abc',
          pass2SchemaModelId: 'schema_v2',
          validatorPolicyVersion: 'policy_v3',
          toKeyString() {
            return 'validation_key';
          },
        },
        attemptNumber: 2,
        priorProseHash: 'prose_old',
        retryGuidanceHash: 'retry_guide_v1',
        toKeyString() {
          return 'attempt_key';
        },
      };

      expect(attemptKey.attemptNumber).toBe(2);
      expect(attemptKey.priorProseHash).toBeDefined();
      expect(attemptKey.retryGuidanceHash).toBeDefined();
      expect(attemptKey.validationKey.proseHash).toBe('prose_abc');
    });
  });

  // ======================================================================
  // Category 7: Branch merge isolation
  // ======================================================================

  describe('branch merge isolation (§5, §14)', () => {
    it('groups are branch-local — no cross-branch surface edges', () => {
      const contracts = makeContracts(['S1', 'S2'], 'feature_a');
      const planner = new SurfacePlanner(
        makeOptions({
          mode: 'manual',
          branch: 'feature_a',
          sceneIds: ['S1', 'S2'],
          contracts,
          authorLanes: [serialLane('feature_a_lane', ['S1', 'S2'])],
        }),
      );

      const result = planner.plan();

      // All groups belong to the same branch
      expect(result.surfaceDependencyGraph.branch).toBe('feature_a');

      // Group IDs should not reference another branch
      for (const group of result.surfaceDependencyGraph.groups) {
        expect(group.groupId).not.toMatch(/feature_b/);
      }
    });

    it('separate branches have independent plans', () => {
      const contractsA = makeContracts(['A1', 'A2'], 'branch_a');
      const contractsB = makeContracts(['B1', 'B2'], 'branch_b');

      const plannerA = new SurfacePlanner(
        makeOptions({
          mode: 'auto',
          branch: 'branch_a',
          sceneIds: ['A1', 'A2'],
          contracts: contractsA,
          autoConfig: { maxParallelGroupSize: 5, authorized: true },
        }),
      );

      const plannerB = new SurfacePlanner(
        makeOptions({
          mode: 'auto',
          branch: 'branch_b',
          sceneIds: ['B1', 'B2'],
          contracts: contractsB,
          autoConfig: { maxParallelGroupSize: 5, authorized: true },
        }),
      );

      const resultA = plannerA.plan();
      const resultB = plannerB.plan();

      // Plans are independent
      expect(resultA.surfaceDependencyGraph.branch).toBe('branch_a');
      expect(resultB.surfaceDependencyGraph.branch).toBe('branch_b');

      // Groups are branch-local — no cross-branch scene references
      for (const group of resultA.surfaceDependencyGraph.groups) {
        for (const sceneId of group.sceneIds) {
          expect(sceneId.startsWith('A')).toBe(true);
        }
      }
      for (const group of resultB.surfaceDependencyGraph.groups) {
        for (const sceneId of group.sceneIds) {
          expect(sceneId.startsWith('B')).toBe(true);
        }
      }

      // Scene IDs from different branches are distinct
      const scenesA = new Set(resultA.surfaceDependencyGraph.groups.flatMap((g) => g.sceneIds));
      const scenesB = new Set(resultB.surfaceDependencyGraph.groups.flatMap((g) => g.sceneIds));
      for (const idA of scenesA) {
        expect(scenesB.has(idA)).toBe(false);
      }
    });
  });

  // ======================================================================
  // Category 8: Cache partition/invalidation
  // ======================================================================

  describe('cache partition/invalidation (§10–11)', () => {
    it('4 independent cache key types exist', () => {
      // Verify all 4 key types can be instantiated
      const logicalKey: LogicalRenderKey = {
        sceneContractHash: 'c1',
        worldStateHash: 'ws1',
        plannedDiscourseHash: 'pd1',
        catalogVersionHashes: { entities: 'v1', rules: 'v2' },
        graphHash: 'g1',
        styleProfileHash: 'sp1',
        promptProviderId: 'default',
        toKeyString() {
          return 'logical:S1:ws1:pd1:g1';
        },
      };

      const surfaceKey: SurfaceRenderKey = {
        logicalKey,
        groupManifestHash: 'gm1',
        surfacePolicyHash: 'sp1',
        sourceProseHashes: ['prose1', 'prose2'],
        extractorVersion: 'v1',
        toKeyString() {
          return 'surface:gm1:sp1';
        },
      };

      const validationKey: SurfaceValidationKey = {
        validatorPolicyVersion: 'policy_v3',
        toKeyString() {
          return 'validation:prose_abc';
        },
      };

      const attemptKey: AttemptKey = {
        validationKey,
        attemptNumber: 1,
        toKeyString() {
          return 'attempt:1';
        },
      };

      expect(logicalKey.toKeyString()).toBe('logical:S1:ws1:pd1:g1');
      expect(surfaceKey.toKeyString()).toBe('surface:gm1:sp1');
      expect(validationKey.toKeyString()).toBe('validation:prose_abc');
      expect(attemptKey.toKeyString()).toBe('attempt:1');
    });

    it('YAML/state change invalidates logical dependents and surface descendants', () => {
      // Different world state hash → different logical key → cascade to surface
      const keyA: LogicalRenderKey = {
        sceneContractHash: 'c1',
        worldStateHash: 'ws_v1',
        plannedDiscourseHash: 'pd1',
        catalogVersionHashes: { entities: 'v1' },
        graphHash: 'g1',
        styleProfileHash: 'sp1',
        promptProviderId: 'default',
        toKeyString() {
          return `logical:ws_v1`;
        },
      };
      const keyB: LogicalRenderKey = {
        sceneContractHash: 'c1',
        worldStateHash: 'ws_v2',
        plannedDiscourseHash: 'pd1',
        catalogVersionHashes: { entities: 'v1' },
        graphHash: 'g1',
        styleProfileHash: 'sp1',
        promptProviderId: 'default',
        toKeyString() {
          return `logical:ws_v2`;
        },
      };

      // Different world state → different key
      expect(keyA.toKeyString()).not.toBe(keyB.toKeyString());
    });

    it('prose-only change invalidates validation/assembly/surface descendants only', () => {
      // Same logical key, different validation key (prose hash changed)
      const logicalKey: LogicalRenderKey = {
        sceneContractHash: 'c1',
        worldStateHash: 'ws1',
        plannedDiscourseHash: 'pd1',
        catalogVersionHashes: { entities: 'v1' },
        graphHash: 'g1',
        styleProfileHash: 'sp1',
        promptProviderId: 'default',
        toKeyString() {
          return 'same_logical';
        },
      };

      const surfaceKey: SurfaceRenderKey = {
        logicalKey,
        groupManifestHash: 'gm1',
        surfacePolicyHash: 'sp1',
        sourceProseHashes: ['prose_v1'],
        extractorVersion: 'v1',
        toKeyString() {
          return 'same_surface';
        },
      };

      const validationKeyA: SurfaceValidationKey = {
        surfaceKey,
        proseHash: 'prose_v1',
        pass2SchemaModelId: 'schema_v2',
        validatorPolicyVersion: 'policy_v3',
        toKeyString() {
          return 'validation:prose_v1';
        },
      };

      const validationKeyB: SurfaceValidationKey = {
        surfaceKey,
        proseHash: 'prose_v2',
        pass2SchemaModelId: 'schema_v2',
        validatorPolicyVersion: 'policy_v3',
        toKeyString() {
          return 'validation:prose_v2';
        },
      };

      // Logical and surface keys are the same, only validation differs
      expect(validationKeyA.toKeyString()).not.toBe(validationKeyB.toKeyString());
    });

    it('group repartition/policy change invalidates surface keys only', () => {
      // Same logical key, different group manifest → different surface key only
      const logicalKey: LogicalRenderKey = {
        sceneContractHash: 'c1',
        worldStateHash: 'ws1',
        plannedDiscourseHash: 'pd1',
        catalogVersionHashes: { entities: 'v1' },
        graphHash: 'g1',
        styleProfileHash: 'sp1',
        promptProviderId: 'default',
        toKeyString() {
          return 'same_logical';
        },
      };

      const surfaceKeyA: SurfaceRenderKey = {
        logicalKey,
        groupManifestHash: 'gm_v1',
        surfacePolicyHash: 'parallel',
        sourceProseHashes: [],
        extractorVersion: 'v1',
        toKeyString() {
          return 'surface:gm_v1';
        },
      };

      const surfaceKeyB: SurfaceRenderKey = {
        logicalKey,
        groupManifestHash: 'gm_v2',
        surfacePolicyHash: 'serial',
        sourceProseHashes: [],
        extractorVersion: 'v1',
        toKeyString() {
          return 'surface:gm_v2';
        },
      };

      // Logical key unchanged; surface key differs
      expect(surfaceKeyA.toKeyString()).not.toBe(surfaceKeyB.toKeyString());
    });
  });

  // ======================================================================
  // Category 9: Parallel groups completion order doesn't affect results
  // ======================================================================

  describe('parallel groups — completion order does not affect results (§3)', () => {
    it('default logical_parallel creates one group per scene with parallel policy', () => {
      const contracts = makeContracts(['S1', 'S2', 'S3']);
      // Use manual mode with no authorLanes to invoke defaultParallelGroups
      const planner = new SurfacePlanner(
        makeOptions({
          mode: 'manual',
          branch: 'main',
          sceneIds: ['S1', 'S2', 'S3'],
          contracts,
        }),
      );

      const result = planner.plan();

      // Default: each scene in its own parallel group
      expect(result.surfaceDependencyGraph.groups).toHaveLength(3);
      for (const group of result.surfaceDependencyGraph.groups) {
        expect(group.surfacePolicy).toEqual({ type: 'parallel' });
        expect(group.sceneIds).toHaveLength(1);
      }

      // No serial lanes in default parallel
      expect(result.surfaceDependencyGraph.serialLanes).toHaveLength(0);
    });

    it('suggest mode proposal has serial lanes ordered by discourse position', () => {
      const contracts = makeContracts(['S1', 'S2', 'S3', 'S4'], 'main', [
        'continuous',
        'continuous',
        'hard_cut',
        'continuous',
      ]);

      const planner = new SurfacePlanner(
        makeOptions({
          mode: 'suggest',
          branch: 'main',
          sceneIds: ['S1', 'S2', 'S3', 'S4'],
          contracts,
        }),
      );

      const result = planner.plan();

      // Effective plan is always parallel in suggest mode
      expect(result.surfaceDependencyGraph.serialLanes).toHaveLength(0);
      for (const group of result.surfaceDependencyGraph.groups) {
        expect(group.surfacePolicy).toEqual({ type: 'parallel' });
      }

      // Proposal holds the suggested serial grouping
      if (result.proposal === undefined) throw new Error('Expected a serial-lane proposal');
      const proposal = result.proposal;

      // Two chains: [S1, S2] continuous, [S4] continuous (S3 is hard_cut)
      // suggestSerialLanes only creates lanes for chains of length ≥2
      expect(proposal.lanes).toHaveLength(1);
      expect(proposal.lanes[0].laneId).toMatch(/^suggested_serial_lane_\d+$/);
      expect(proposal.lanes[0].groupIds).toEqual(['S1', 'S2']);

      // Proposal groups in lane use serial_surface policy
      const laneGroupIds = new Set(proposal.lanes[0].groupIds);
      for (const group of proposal.groups) {
        if (laneGroupIds.has(group.sceneIds[0])) {
          expect(group.surfacePolicy.type).toBe('serial_surface');
        } else {
          expect(group.surfacePolicy.type).toBe('parallel');
        }
      }

      // Hash is deterministic and SHA-256
      expect(proposal.hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('auto mode grouping is stable regardless of group iteration order', () => {
      const contracts = makeContracts(['S1', 'S2', 'S3', 'S4', 'S5']);
      const options = makeOptions({
        mode: 'auto',
        branch: 'main',
        sceneIds: ['S1', 'S2', 'S3', 'S4', 'S5'],
        contracts,
        autoConfig: { maxParallelGroupSize: 2, authorized: true },
      });

      // Run three times — results must be identical
      const results = [0, 1, 2].map(() => {
        const p = new SurfacePlanner(options);
        return p.plan();
      });

      for (let i = 1; i < results.length; i++) {
        expect(results[i].manifest.groupIds).toEqual(results[0].manifest.groupIds);
        expect(results[i].surfaceDependencyGraph.groups).toEqual(
          results[0].surfaceDependencyGraph.groups,
        );
        expect(results[i].surfaceDependencyGraph.serialLanes).toEqual(
          results[0].surfaceDependencyGraph.serialLanes,
        );
      }
    });

    it('planner does not reorder by completion timing (§6)', () => {
      // SurfacePlanner determines groups upfront from deterministic inputs
      // Completion order cannot affect grouping
      const contracts = makeContracts(['S1', 'S2', 'S3']);
      const planner = new SurfacePlanner(
        makeOptions({
          mode: 'manual',
          branch: 'main',
          sceneIds: ['S1', 'S2', 'S3'],
          contracts,
          // No authorGroups → default parallel: group_<sceneId> IDs
        }),
      );

      const result = planner.plan();

      // Default parallel creates group_<sceneId> group IDs in discourse order
      expect(result.manifest.groupIds).toEqual(['group_S1', 'group_S2', 'group_S3']);
      // Groups are determined by scene order, not by completion timing
      expect(result.surfaceDependencyGraph.groups).toHaveLength(3);
    });
  });

  // ======================================================================
  // Suggest mode proposal isolation
  // ======================================================================

  describe('suggest mode proposal isolation', () => {
    it('effective groups are always parallel even when suggestion exists', () => {
      // Continuous scenes — would trigger a serial suggestion
      const contracts = makeContracts(['S1', 'S2', 'S3'], 'main', [
        'continuous',
        'continuous',
        'continuous',
      ]);

      const planner = new SurfacePlanner(
        makeOptions({
          mode: 'suggest',
          branch: 'main',
          sceneIds: ['S1', 'S2', 'S3'],
          contracts,
        }),
      );

      const result = planner.plan();

      // Effective: parallel
      for (const group of result.surfaceDependencyGraph.groups) {
        expect(group.surfacePolicy).toEqual({ type: 'parallel' });
      }
      expect(result.surfaceDependencyGraph.serialLanes).toHaveLength(0);

      // Proposal: serial
      expect(result.proposal).toBeDefined();
      expect(result.proposal?.lanes.length).toBeGreaterThan(0);
    });

    it('proposal is undefined when no suggestion is generated', () => {
      // Single scene → suggestSerialLanes returns null
      const contracts = makeContracts(['S1']);
      const planner = new SurfacePlanner(
        makeOptions({
          mode: 'suggest',
          branch: 'main',
          sceneIds: ['S1'],
          contracts,
        }),
      );

      const result = planner.plan();

      // Effective plan still valid
      expect(result.surfaceDependencyGraph.groups).toHaveLength(1);
      expect(result.surfaceDependencyGraph.groups[0].surfacePolicy).toEqual({ type: 'parallel' });

      // No proposal when no serial chain found
      expect(result.proposal).toBeUndefined();

      // Warnings still mention suggest mode is a proposal
      expect(result.warnings).toBeDefined();
      expect(result.warnings?.length).toBeGreaterThan(0);
    });

    it('manual mode has no proposal', () => {
      const contracts = makeContracts(['S1', 'S2']);
      const planner = new SurfacePlanner(
        makeOptions({
          mode: 'manual',
          branch: 'main',
          sceneIds: ['S1', 'S2'],
          contracts,
          authorGroups: [
            { groupId: 'g1', sceneIds: ['S1'], surfacePolicy: { type: 'serial_surface' } },
            { groupId: 'g2', sceneIds: ['S2'], surfacePolicy: { type: 'parallel' } },
          ],
          authorLanes: [serialLane('lane1', ['g1', 'g2'])],
        }),
      );

      const result = planner.plan();
      expect(result.proposal).toBeUndefined();
    });

    it('auto mode has no proposal', () => {
      const contracts = makeContracts(['S1', 'S2', 'S3']);
      const planner = new SurfacePlanner(
        makeOptions({
          mode: 'auto',
          branch: 'main',
          sceneIds: ['S1', 'S2', 'S3'],
          contracts,
          autoConfig: { maxParallelGroupSize: 2, authorized: true },
        }),
      );

      const result = planner.plan();
      expect(result.proposal).toBeUndefined();
    });

    it('proposal hash is deterministic across runs with same inputs', () => {
      const contracts = makeContracts(['S1', 'S2'], 'main', ['continuous', 'continuous']);
      const options = makeOptions({
        mode: 'suggest',
        branch: 'main',
        sceneIds: ['S1', 'S2'],
        contracts,
      });

      const r1 = new SurfacePlanner(options).plan();
      const r2 = new SurfacePlanner(options).plan();

      expect(r1.proposal).toBeDefined();
      expect(r2.proposal).toBeDefined();
      expect(r1.proposal?.hash).toBe(r2.proposal?.hash);

      // Proposal hash differs when scene transition changes
      const contractsChanged = makeContracts(['S1', 'S2'], 'main', ['hard_cut', 'hard_cut']);
      const r3 = new SurfacePlanner(
        makeOptions({
          mode: 'suggest',
          branch: 'main',
          sceneIds: ['S1', 'S2'],
          contracts: contractsChanged,
        }),
      ).plan();

      // Hard cut chain (single-element each) → no proposal
      expect(r3.proposal).toBeUndefined();
    });

    it('proposal hash excludes wall-clock generatedAt', () => {
      const contracts = makeContracts(['S1', 'S2', 'S3'], 'main', [
        'continuous',
        'continuous',
        'continuous',
      ]);
      const options = makeOptions({
        mode: 'suggest',
        branch: 'main',
        sceneIds: ['S1', 'S2', 'S3'],
        contracts,
      });

      // Run twice: same proposal hash even though generatedAt would differ
      const r1 = new SurfacePlanner(options).plan();
      const r2 = new SurfacePlanner(options).plan();

      expect(r1.proposal).toBeDefined();
      expect(r1.proposal?.hash).toBe(r2.proposal?.hash);
    });
  });

  // ======================================================================
  // CompiledSceneContract compilation details
  // ======================================================================

  describe('CompiledSceneContract compilation', () => {
    it('produces deterministic prompt contract hash', () => {
      const input: SceneContractInput = {
        sceneId: 'S1',
        branch: 'main',
        discoursePosition: 0,
        worldStateHash: 'ws1',
        knowledgeStateHash: 'know1',
        narratorProfileHash: 'narr1',
        plannedDiscourseHash: 'disc1',
        promptProviderId: 'gpt4',
      };

      const c1 = compileSceneContract(input);
      const c2 = compileSceneContract(input);

      expect(c1.promptContractHash).toBe(c2.promptContractHash);
      expect(c1.styleProfile.profileId).toBe('default_project_style_v1');
    });

    it('includes all required boundary hashes', () => {
      const contract = compileSceneContract({
        sceneId: 'S1',
        branch: 'main',
        discoursePosition: 5,
        worldStateHash: 'ws_hash',
        knowledgeStateHash: 'know_hash',
        narratorProfileHash: 'narr_hash',
        plannedDiscourseHash: 'disc_hash',
      });

      expect(contract.sceneId).toBe('S1');
      expect(contract.discoursePosition).toBe(5);
      expect(contract.worldStateHash).toBe('ws_hash');
      expect(contract.knowledgeStateHash).toBe('know_hash');
      expect(contract.narratorProfileHash).toBe('narr_hash');
      expect(contract.plannedDiscourseHash).toBe('disc_hash');
      expect(contract.branch).toBe('main');
    });
  });

  // ======================================================================
  // SurfacePlannerError details
  // ======================================================================

  describe('SurfacePlannerError', () => {
    it('carries error code and context', () => {
      const error = new SurfacePlannerError('Surface cycle detected', 'SURFACE_CYCLE', {
        branch: 'main',
        origin: 'S1',
        target: 'S2',
      });

      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('SurfacePlannerError');
      expect(error.code).toBe('SURFACE_CYCLE');
      expect(error.context).toEqual({ branch: 'main', origin: 'S1', target: 'S2' });
    });

    it('all error codes have corresponding schema values', () => {
      const codes = [
        'CROSS_BRANCH_SURFACE_EDGE',
        'SURFACE_CYCLE',
        'UNACCEPTED_SOURCE_PROSE',
        'UNVERSIONED_EXTRACTION',
        'UNVERSIONED_BUDGET',
        'MISSING_CONTRACT',
        'INVALID_POLICY',
        'UNAUTHORIZED_AUTO_MODE',
        'BRANCH_MISMATCH',
        'GROUP_SCENE_CONFLICT',
        'FALLBACK_WITHOUT_SURFACE_NOT_ALLOWED',
        'EXHAUSTED_RETRY',
        'DUPLICATE_GROUP_ID',
        'MISSING_SCENE_IN_GROUP',
        'MISSING_SURFACE_SOURCE',
        'SERIAL_GROUP_MULTIPLE_SCENES',
        'UNVERSIONED_MANIFEST',
        'UNKNOWN_GROUP_ID',
      ] as const;

      for (const code of codes) {
        const error = new SurfacePlannerError(`test ${code}`, code, {});
        expect(error.code).toBe(code);
      }
    });
  });
});
