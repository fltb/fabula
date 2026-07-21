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
  SurfaceDependencyGraph,
  SurfacePolicy,
  RenderGroup,
  RenderGroupManifest,
  SerialLane,
  SurfacePlanResult,
  SurfacePlannerOptions,
  ValidationGate,
  ValidationGateGraph,
  ValidationPolicy,
  SurfaceErrorCode,
  PlannerMode,
} from '../types/render-surface.js';
import { SurfacePlannerError } from '../types/render-surface.js';

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

    switch (mode) {
      case 'manual':
        ({ groups, lanes } = this.planManual());
        break;
      case 'suggest':
        ({ groups, lanes } = this.planSuggest());
        break;
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

    // Build manifest
    const manifest = this.buildManifest(groups, lanes, mode);

    // Generate warnings for suggest mode
    const warnings = mode === 'suggest'
      ? this.generateSuggestWarnings(groups, lanes)
      : undefined;

    return {
      manifest,
      surfaceDependencyGraph,
      validationGateGraph,
      warnings,
    };
  }

  // ─── Manual Mode ────────────────────────────────────────────────────────────

  /**
   * Manual mode: use author-provided lanes and group definitions directly.
   * Author must write groups — planner does NOT infer them.
   */
  private planManual(): { groups: RenderGroup[]; lanes: SerialLane[] } {
    const { authorLanes, sceneIds } = this.options;

    if (!authorLanes || authorLanes.length === 0) {
      // No author lanes provided — default to one parallel group per scene
      return this.defaultParallelGroups(sceneIds);
    }

    const allGroupedIds = new Set(authorLanes.flatMap(l => l.groupIds));

    // Validate all scene IDs are covered
    for (const id of sceneIds) {
      if (!allGroupedIds.has(id)) {
        throw this.createError(
          'MISSING_CONTRACT',
          `Scene '${id}' is not assigned to any group`,
        );
      }
    }

    // Build groups from the lane definitions
    const groups: RenderGroup[] = [];
    for (const lane of authorLanes) {
      for (const groupId of lane.groupIds) {
        const sceneIdsInGroup = sceneIds.filter(id => id === groupId);
        groups.push({
          groupId,
          sceneIds: sceneIdsInGroup,
          surfacePolicy: { type: 'serial_surface' },
        });
      }
    }

    return { groups, lanes: authorLanes };
  }

  // ─── Suggest Mode ───────────────────────────────────────────────────────────

  /**
   * Suggest mode: planner proposes groups/lanes but does NOT apply them.
   * The manifest is generated with `suggest` mode, and warnings detail
   * the proposal. Author must manually adopt the suggestions.
   */
  private planSuggest(): { groups: RenderGroup[]; lanes: SerialLane[] } {
    const { sceneIds, contracts } = this.options;

    // Default: logical_parallel — all scenes in parallel (§3)
    const { groups, lanes } = this.defaultParallelGroups(sceneIds);

    // Suggest serial lanes for scenes with related discourse transitions
    const suggested = this.suggestSerialLanes(sceneIds, contracts);

    return {
      groups: suggested?.groups ?? groups,
      lanes: suggested?.lanes ?? lanes,
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
  private defaultParallelGroups(sceneIds: string[]): { groups: RenderGroup[]; lanes: SerialLane[] } {
    const groups: RenderGroup[] = sceneIds.map(id => ({
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

    const contractMap = new Map(contracts.map(c => [c.sceneId, c]));

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
        currentChain = [id];
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
    const groupedIds = new Set(groups.map(g => g.sceneIds).flat());
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
      groupIds: groups.map(g => g.groupId),
    });

    return { groups, lanes };
  }

  // ─── Validation Gates (§9) ─────────────────────────────────────────────────

  /**
   * Build ValidationGateGraph for all scenes in this branch.
   * Each scene starts with a `pending` gate.
   */
  private buildValidationGateGraph(
    sceneIds: string[],
    branch: BranchPath,
  ): ValidationGateGraph {
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
    const groupIds = groups.map(g => g.groupId);
    const groupPolicies: Record<string, SurfacePolicy> = {};
    for (const g of groups) {
      groupPolicies[g.groupId] = g.surfacePolicy;
    }

    // Compute source definition hash from deterministic inputs
    const sourceHash = this.computeSourceHash(groups, lanes);

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
  private validateContracts(
    contracts: CompiledSceneContract[],
    sceneIds: string[],
  ): void {
    const contractIds = new Set(contracts.map(c => c.sceneId));

    for (const id of sceneIds) {
      if (!contractIds.has(id)) {
        throw this.createError(
          'MISSING_CONTRACT',
          `Scene '${id}' has no CompiledSceneContract`,
        );
      }
    }
  }

  // ─── Suggest Warnings ───────────────────────────────────────────────────────

  /**
   * Generate human-readable warnings for suggest mode.
   */
  private generateSuggestWarnings(
    groups: RenderGroup[],
    lanes: SerialLane[],
  ): string[] {
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

  // ─── Utilities ──────────────────────────────────────────────────────────────

  /**
   * Compute a deterministic hash from groups and lanes for the manifest.
   */
  private computeSourceHash(
    groups: RenderGroup[],
    lanes: SerialLane[],
  ): string {
    const raw = JSON.stringify({ groups, lanes });
    let hash = 0;
    for (let i = 0; i < raw.length; i++) {
      const char = raw.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    return Math.abs(hash).toString(16).padStart(8, '0');
  }

  private createError(
    code: SurfaceErrorCode,
    message: string,
  ): SurfacePlannerError {
    return new SurfacePlannerError(message, code, {
      branch: this.options.branch,
      mode: this.options.mode,
    });
  }
}
