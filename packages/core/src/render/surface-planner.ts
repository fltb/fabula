// ============================================================================
// Novalistically — RENDER-SURFACE-1: Surface Planner
//
// Group planning with manual/suggest/auto modes.
// Produces RenderGroupManifest (versioned, hash-pinned, overridable).
//
// Binding constraints:
//   §3: Default logical_parallel — all scenes render in parallel
//   §5: Each scene belongs to exactly one group. Group order is branch
//       discourse order subsequence. NOT inferred from filename/storyTime.
//   §6: Planner MUST NOT read prose/LLM judgment, modify YAML/logic/discourse/
//       causal edges, or reorder by completion timing.
//   §7: parallel and serial_surface ONLY.
//   §9: Validation gate determines accept/retry/block. Failed scene only
//       blocks surface descendants; logical compilation still valid.
// ============================================================================

import type { BranchPath } from '../types/branch.js';
import type {
  CompiledSceneContract,
  PlannerMode,
  RenderGroup,
  RenderGroupManifest,
  SerialLane,
  SurfaceDependencyGraph,
  SurfaceErrorCode,
  SurfacePlannerOptions,
  SurfacePlanProposal,
  SurfacePlanResult,
  SurfacePolicy,
  ValidationGate,
  ValidationGateGraph,
  ValidationPolicy,
} from '../types/render-surface.js';
import { SurfacePlannerError } from '../types/render-surface.js';
import { canonicalJson, computeSha256Hex } from './scene-contract.js';

// ─── Default Configuration ───────────────────────────────────────────────────

const DEFAULT_MANIFEST_VERSION = 'render-surface-v1';
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MAX_PARALLEL_GROUP_SIZE = 10;

// ─── SurfacePlanner ──────────────────────────────────────────────────────────

/**
 * SurfacePlanner — determines group composition and serial lanes for
 * a set of scenes within a single branch.
 *
 * Modes:
 *   manual — author explicitly provides group/lane definitions
 *   suggest — planner proposes groups/lanes but does NOT apply them
 *   auto   — planner generates groups/lanes (only if project authorizes)
 */
export class SurfacePlanner {
  private readonly options: SurfacePlannerOptions;
  private readonly manifestVersion: string;

  constructor(options: SurfacePlannerOptions) {
    this.options = options;
    this.manifestVersion = DEFAULT_MANIFEST_VERSION;
  }

  /**
   * Generate the surface plan (groups + dependency graph + validation gates).
   *
   * In `manual` mode: uses author-provided lanes/group definitions directly.
   * In `suggest` mode: generates a proposal with warnings.
   * In `auto` mode: applies generated grouping (if authorized).
   *
   * Planner NEVER reads prose/LLM judgment, modifies YAML/logic/discourse/
   * causal edges, or reorders by completion timing (§6).
   */
  plan(): SurfacePlanResult {
    const { mode, branch, sceneIds, contracts } = this.options;

    this.validateContracts(contracts, sceneIds);

    let groups: RenderGroup[];
    let lanes: SerialLane[];
    let proposal: SurfacePlanProposal | undefined;

    switch (mode) {
      case 'manual':
        ({ groups, lanes } = this.planManual());
        break;
      case 'suggest': {
        const suggestResult = this.planSuggest();
        groups = suggestResult.groups;
        lanes = suggestResult.lanes;
        // Build a deterministic proposal from any suggested serial grouping
        if (suggestResult.suggestedGroups && suggestResult.suggestedLanes) {
          proposal = {
            groups: suggestResult.suggestedGroups,
            lanes: suggestResult.suggestedLanes,
            hash: this.computeSourceHash(
              suggestResult.suggestedGroups,
              suggestResult.suggestedLanes,
              'suggest',
            ),
          };
        }
        break;
      }
      case 'auto':
        ({ groups, lanes } = this.planAuto());
        break;
    }

    // Validate groups — each scene belongs to exactly one group (§5)
    this.validateGroupUniqueness(groups);

    // Build surface dependency graph
    const surfaceDependencyGraph: SurfaceDependencyGraph = {
      groups,
      serialLanes: lanes,
      branch,
    };

    // Build validation gate graph (§9)
    const validationGateGraph = this.buildValidationGateGraph(sceneIds, branch);

    // Build manifest (always from effective groups/lanes, never proposal)
    const manifest = this.buildManifest(groups, lanes, mode);

    // Generate warnings for suggest mode (reference proposal lanes, not empty effective ones)
    const warnings =
      mode === 'suggest'
        ? this.generateSuggestWarnings(proposal?.groups ?? groups, proposal?.lanes ?? lanes)
        : undefined;

    return {
      manifest,
      surfaceDependencyGraph,
      validationGateGraph,
      warnings,
      proposal,
    };
  }

  // ─── Manual Mode ────────────────────────────────────────────────────────────

  /**
   * Manual mode: use author-provided groups directly.
   * Each group has explicit groupId, sceneIds, and surfacePolicy.
   * Lanes reference group IDs for serial ordering — NOT scene IDs.
   * Defaults to one parallel group per scene when no groups provided.
   */
  private planManual(): { groups: RenderGroup[]; lanes: SerialLane[] } {
    const { authorGroups, authorLanes, sceneIds } = this.options;

    if (!authorGroups || authorGroups.length === 0) {
      // No author groups — default to one parallel group per scene (§3)
      return this.defaultParallelGroups(sceneIds);
    }

    // ── Validation ───────────────────────────────────────────────────────
    this.validateNoDuplicateGroupIds(authorGroups);
    this.validateAllScenesAssigned(sceneIds, authorGroups);
    this.validateGroupPolicies(authorGroups);

    const lanes = authorLanes ?? [];
    if (lanes.length > 0) {
      this.validateLaneReferences(authorGroups, lanes);
      this.validateSerialGroupSingleScene(authorGroups, lanes);
      this.validateNoCycles(authorGroups, lanes);
    }

    return { groups: authorGroups, lanes };
  }

  // ─── Suggest Mode ───────────────────────────────────────────────────────────

  /**
   * Suggest mode: planner proposes groups/lanes but does NOT apply them.
   * The manifest is generated with `suggest` mode, and warnings detail
   * the proposal. Author must manually adopt the suggestions.
   */
  private planSuggest(): {
    groups: RenderGroup[];
    lanes: SerialLane[];
    suggestedGroups?: RenderGroup[];
    suggestedLanes?: SerialLane[];
  } {
    const { sceneIds, contracts } = this.options;

    // Effective: logical_parallel — all scenes in parallel (§3)
    const effective = this.defaultParallelGroups(sceneIds);

    // Suggestion: candidate serial lanes based on scene transitions
    const suggested = this.suggestSerialLanes(sceneIds, contracts);

    return {
      groups: effective.groups,
      lanes: effective.lanes,
      suggestedGroups: suggested?.groups,
      suggestedLanes: suggested?.lanes,
    };
  }

  // ─── Auto Mode ──────────────────────────────────────────────────────────────

  /**
   * Auto mode: planner generates groups/lanes.
   * MUST only apply if project explicitly authorises auto mode (§6).
   */
  private planAuto(): { groups: RenderGroup[]; lanes: SerialLane[] } {
    const { autoConfig, sceneIds, contracts } = this.options;

    if (!autoConfig?.authorized) {
      throw this.createError(
        'UNAUTHORIZED_AUTO_MODE',
        'Auto mode is not authorized for this project',
      );
    }

    const maxSize = autoConfig?.maxParallelGroupSize ?? DEFAULT_MAX_PARALLEL_GROUP_SIZE;

    // Group scenes by discourse proximity for serial lanes
    return this.autoGroupScenes(sceneIds, contracts, maxSize);
  }

  // ─── Default: Logical Parallel (§3) ─────────────────────────────────────────

  /**
   * Default logical_parallel: all scenes render in parallel.
   * Each scene in its own group, no serial lanes.
   */
  private defaultParallelGroups(sceneIds: string[]): {
    groups: RenderGroup[];
    lanes: SerialLane[];
  } {
    const groups: RenderGroup[] = sceneIds.map((id) => ({
      groupId: `group_${id}`,
      sceneIds: [id],
      surfacePolicy: { type: 'parallel' },
    }));

    return { groups, lanes: [] };
  }

  // ─── Serial Lane Suggestion ─────────────────────────────────────────────────

  /**
   * Suggest serial lanes based on scene transitions and continuity.
   * Scenes with 'continuous' transitions that are adjacent
   * in discourse order may benefit from serial rendering for coherence.
   * This is a SUGGESTION only — author MUST adopt for it to take effect.
   */
  private suggestSerialLanes(
    sceneIds: string[],
    contracts: CompiledSceneContract[],
  ): { groups: RenderGroup[]; lanes: SerialLane[] } | null {
    if (contracts.length < 2) return null;

    const contractMap = new Map(contracts.map((c) => [c.sceneId, c]));

    // Find continuous transition chains
    const chains: string[][] = [];
    let currentChain: string[] = [];

    for (let i = 0; i < sceneIds.length; i++) {
      const id = sceneIds[i];
      const contract = contractMap.get(id);
      if (!contract) continue;

      const isContinuous = contract.continuityPacket.transition === 'continuous';

      if (isContinuous) {
        currentChain.push(id);
      } else {
        if (currentChain.length >= 2) {
          chains.push([...currentChain]);
        }
        currentChain = [];
      }
    }
    if (currentChain.length >= 2) {
      chains.push(currentChain);
    }

    if (chains.length === 0) return null;

    // Build serial groups
    const groups: RenderGroup[] = [];
    const lanes: SerialLane[] = [];
    let laneIndex = 0;

    for (const chain of chains) {
      if (chain.length >= 2) {
        const laneId = `suggested_serial_lane_${laneIndex++}`;
        lanes.push({ laneId, groupIds: chain });
        for (const sceneId of chain) {
          groups.push({
            groupId: `group_${sceneId}`,
            sceneIds: [sceneId],
            surfacePolicy: { type: 'serial_surface' },
          });
        }
      }
    }

    // Add remaining scenes as parallel
    const groupedIds = new Set(groups.flatMap((g) => g.sceneIds));
    for (const id of sceneIds) {
      if (!groupedIds.has(id)) {
        groups.push({
          groupId: `group_${id}`,
          sceneIds: [id],
          surfacePolicy: { type: 'parallel' },
        });
      }
    }

    return { groups, lanes };
  }

  // ─── Auto Grouping ─────────────────────────────────────────────────────────

  /**
   * Auto-group scenes into balanced parallel groups based on discourse
   * adjacency and configurable max group size.
   */
  private autoGroupScenes(
    sceneIds: string[],
    _contracts: CompiledSceneContract[],
    maxGroupSize: number,
  ): { groups: RenderGroup[]; lanes: SerialLane[] } {
    const groups: RenderGroup[] = [];
    const lanes: SerialLane[] = [];

    // Batch into groups of up to maxGroupSize
    for (let i = 0; i < sceneIds.length; i += maxGroupSize) {
      const batch = sceneIds.slice(i, i + maxGroupSize);
      const groupId = `auto_group_${groups.length}`;

      groups.push({
        groupId,
        sceneIds: batch,
        surfacePolicy: { type: 'parallel' },
      });
    }

    // If only one group, everything is parallel — no lanes needed
    if (groups.length <= 1) {
      return { groups, lanes: [] };
    }

    // Add a single serial lane ordering all groups in discourse order
    const laneId = 'auto_order_lane';
    lanes.push({
      laneId,
      groupIds: groups.map((g) => g.groupId),
    });

    return { groups, lanes };
  }

  // ─── Validation Gates (§9) ─────────────────────────────────────────────────

  /**
   * Build ValidationGateGraph for all scenes in this branch.
   * Each scene starts with a `pending` gate.
   */
  private buildValidationGateGraph(sceneIds: string[], branch: BranchPath): ValidationGateGraph {
    const gates: Record<string, ValidationGate> = {};

    for (const sceneId of sceneIds) {
      gates[sceneId] = {
        sceneId,
        status: 'pending',
        attemptCount: 0,
        maxRetries: DEFAULT_MAX_RETRIES,
        fallbackWithoutSurface: false,
      };
    }

    const policy: ValidationPolicy = {
      maxRetries: DEFAULT_MAX_RETRIES,
      allowFallbackWithoutSurface: false,
    };

    return { gates, policy, branch };
  }

  // ─── Manifest Build ─────────────────────────────────────────────────────────

  /**
   * Build a RenderGroupManifest from the resolved groups and lanes.
   * Versioned, hash-pinned, overridable (§6).
   */
  private buildManifest(
    groups: RenderGroup[],
    lanes: SerialLane[],
    mode: PlannerMode,
  ): RenderGroupManifest {
    const groupIds = groups.map((g) => g.groupId);
    const groupPolicies: Record<string, SurfacePolicy> = {};
    for (const g of groups) {
      groupPolicies[g.groupId] = g.surfacePolicy;
    }

    // Compute source definition hash from deterministic inputs (excludes generatedAt)
    const sourceHash = this.computeSourceHash(groups, lanes, mode);

    return {
      manifestVersion: this.manifestVersion,
      sourceDefinitionHash: sourceHash,
      groupIds,
      lanes,
      groupPolicies,
      plannerMode: mode,
      generatedAt: new Date().toISOString(),
    };
  }

  // ─── Validation ─────────────────────────────────────────────────────────────

  /**
   * Validate that each scene belongs to exactly one group (§5).
   */
  private validateGroupUniqueness(groups: RenderGroup[]): void {
    const seenScenes = new Set<string>();

    for (const group of groups) {
      for (const sceneId of group.sceneIds) {
        if (seenScenes.has(sceneId)) {
          throw this.createError(
            'GROUP_SCENE_CONFLICT',
            `Scene '${sceneId}' appears in multiple groups`,
          );
        }
        seenScenes.add(sceneId);
      }
    }
  }

  /**
   * Validate that all scene IDs have a corresponding contract.
   */
  private validateContracts(contracts: CompiledSceneContract[], sceneIds: string[]): void {
    const contractIds = new Set(contracts.map((c) => c.sceneId));

    for (const id of sceneIds) {
      if (!contractIds.has(id)) {
        throw this.createError('MISSING_CONTRACT', `Scene '${id}' has no CompiledSceneContract`);
      }
    }
  }

  // ─── Manual-Mode Validations ─────────────────────────────────────────────

  /**
   * Validate that no two groups share the same group ID.
   */
  private validateNoDuplicateGroupIds(groups: RenderGroup[]): void {
    const seen = new Set<string>();
    for (const g of groups) {
      if (seen.has(g.groupId)) {
        throw this.createError(
          'DUPLICATE_GROUP_ID',
          `Duplicate group ID '${g.groupId}' in surface plan`,
        );
      }
      seen.add(g.groupId);
    }
  }

  /**
   * Validate that every scene in sceneIds appears exactly once across all groups.
   */
  private validateAllScenesAssigned(sceneIds: string[], groups: RenderGroup[]): void {
    const assigned = new Set<string>();
    for (const g of groups) {
      for (const sid of g.sceneIds) {
        if (assigned.has(sid)) {
          throw this.createError(
            'GROUP_SCENE_CONFLICT',
            `Scene '${sid}' appears in multiple groups`,
          );
        }
        assigned.add(sid);
      }
    }
    for (const sid of sceneIds) {
      if (!assigned.has(sid)) {
        throw this.createError(
          'MISSING_SCENE_IN_GROUP',
          `Scene '${sid}' is not assigned to any group`,
        );
      }
    }
  }

  /**
   * Validate group surface policies are valid.
   * fallback_without_surface must be explicitly declared (enforced by type).
   */
  private validateGroupPolicies(groups: RenderGroup[]): void {
    for (const g of groups) {
      const policy = g.surfacePolicy.type;
      if (policy === 'serial_surface' && g.sceneIds.length !== 1) {
        throw this.createError(
          'SERIAL_GROUP_MULTIPLE_SCENES',
          `Serial surface group '${g.groupId}' has ${g.sceneIds.length} scenes; v1 requires exactly one`,
        );
      }
    }
  }

  /**
   * Validate that lane group IDs reference existing groups.
   */
  private validateLaneReferences(groups: RenderGroup[], lanes: SerialLane[]): void {
    const groupIds = new Set(groups.map((g) => g.groupId));
    for (const lane of lanes) {
      for (const gid of lane.groupIds) {
        if (!groupIds.has(gid)) {
          throw this.createError(
            'UNKNOWN_GROUP_ID',
            `Lane '${lane.laneId}' references unknown group ID '${gid}'`,
          );
        }
      }
    }
  }

  /**
   * Validate serial_v1 constraint: groups in a serial lane can only have
   * a single scene each (v1 limitation).
   */
  private validateSerialGroupSingleScene(groups: RenderGroup[], lanes: SerialLane[]): void {
    const laneGroupIds = new Set(lanes.flatMap((l) => l.groupIds));
    for (const g of groups) {
      if (laneGroupIds.has(g.groupId) && g.sceneIds.length !== 1) {
        throw this.createError(
          'SERIAL_GROUP_MULTIPLE_SCENES',
          `Serial-lane group '${g.groupId}' has ${g.sceneIds.length} scenes; v1 requires exactly one`,
        );
      }
    }
  }

  /**
   * Validate no cycles in lane ordering.
   * In v1, each group appears in at most one lane, so cycles within a single lane
   * are impossible. Cross-lane cycles are also impossible since lanes are independent.
   * Check: no group appears in more than one lane; no group repeats within a lane.
   */
  private validateNoCycles(_groups: RenderGroup[], lanes: SerialLane[]): void {
    const groupToLane = new Map<string, string>();
    for (const lane of lanes) {
      const seenInLane = new Set<string>();
      for (const gid of lane.groupIds) {
        if (seenInLane.has(gid)) {
          throw this.createError(
            'SURFACE_CYCLE',
            `Duplicate group ID '${gid}' in lane '${lane.laneId}'`,
          );
        }
        seenInLane.add(gid);
        if (groupToLane.has(gid)) {
          throw this.createError(
            'SURFACE_CYCLE',
            `Group '${gid}' appears in multiple lanes ('${groupToLane.get(gid)}' and '${lane.laneId}')`,
          );
        }
        groupToLane.set(gid, lane.laneId);
      }
    }
  }

  // ─── Suggest Warnings ───────────────────────────────────────────────────────

  /**
   * Generate human-readable warnings for suggest mode.
   */
  private generateSuggestWarnings(_groups: RenderGroup[], lanes: SerialLane[]): string[] {
    const warnings: string[] = [];

    if (lanes.length > 0) {
      for (const lane of lanes) {
        warnings.push(
          `Suggested serial lane '${lane.laneId}' with ${lane.groupIds.length} groups. ` +
            'Author must explicitly adopt this grouping.',
        );
      }
    }

    warnings.push(
      'Suggestion mode — this manifest is a proposal only. ' +
        'Set plannerMode to "manual" with explicit group definitions to apply.',
    );

    return warnings;
  }

  /**
   * Compute a deterministic SHA-256 hash from groups, lanes, and mode.
   * Uses canonical JSON (sorted key order) for deterministic identity.
   * Excludes wall-clock `generatedAt` field.
   */
  private computeSourceHash(groups: RenderGroup[], lanes: SerialLane[], mode: PlannerMode): string {
    const payload = { groups, lanes, mode };
    const json = canonicalJson(payload);
    return computeSha256Hex(json);
  }

  private createError(code: SurfaceErrorCode, message: string): SurfacePlannerError {
    return new SurfacePlannerError(message, code, {
      branch: this.options.branch,
      mode: this.options.mode,
    });
  }
}
