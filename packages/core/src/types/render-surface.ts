// ============================================================================
// Novalistically — RENDER-SURFACE-1: Types for logical-independent text
// coherence & grouped parallel render
//
// Binding constraints from docs/todos/graph-discourse-render.md RENDER-SURFACE-1:
//   1. Four-graph separation (logicalGraph, plannedDiscourseGraph,
//      SurfaceDependencyGraph, ValidationGateGraph)
//   2. CompiledSceneContract per scene before prose
//   3. Default logical_parallel rendering
//   4. SurfaceReferencePacket is non-authoritative — YAML ALWAYS wins
//   5. Group rules — each scene belongs to exactly one group
//   6. Group policies (manual/suggest/auto) — RenderGroupManifest
//   7. Supported: parallel, serial_surface ONLY
//   8. Chapter default — no prose excerpt
//   9. Validation gate (accept/retry/block) with AttemptKey
//  10. 4 independent cache keys
//  11. Cache invalidation rules
//  12. Performance constraints
// ============================================================================

import type { BranchPath } from './branch.js';
import type { DiscoursePosition } from './discourse.js';

// ─── StyleProfile (§2) ──────────────────────────────────────────────────────

/**
 * StyleProfile is resolved deterministically by
 * project → chapter → narrator/POV → scene precedence.
 * Can include voice/diction/rhythm/paragraphing/typography/dialogue/avoid.
 * Generated prose NEVER rewrites style profile.
 */
export interface StyleProfile {
  /** Unique stable style profile ID. */
  profileId: string;

  /** Resolution precedence path. */
  resolutionPrecedence: StyleResolutionPath;

  /** Narrative voice guidance. */
  voice?: string;

  /** Diction guidance. */
  diction?: string;

  /** Rhythm/prose rhythm guidance. */
  rhythm?: string;

  /** Paragraphing guidance. */
  paragraphing?: string;

  /** Typography constraints. */
  typography?: string;

  /** Dialogue formatting/presentation guidance. */
  dialogue?: string;

  /** Elements to avoid in prose. */
  avoid?: string[];
}

/**
 * Style resolution precedence path.
 * Project → chapter → narrator/POV → scene deterministic order.
 */
export interface StyleResolutionPath {
  projectStyle: string;
  chapterStyle?: string;
  narratorPovStyle?: string;
  sceneStyle?: string;
}

// ─── ContinuityPacket (§2) ──────────────────────────────────────────────────

/**
 * Authored continuity packet for a scene.
 * ONLY: transition, authored motifs/callbacks, open-close mode.
 * Generated phrase NEVER becomes mandatory callback unless author
 * writes it to YAML and recompiles.
 */
export interface ContinuityPacket {
  /** Transition type for this scene. */
  transition: SceneTransition;

  /** Authored motif references. */
  motifs?: string[];

  /** Authored callback references. */
  callbacks?: string[];

  /** Open-close mode for the scene. */
  openCloseMode?: 'open' | 'closed' | 'open_close' | 'none';
}

export type SceneTransition =
  | 'continuous'
  | 'hard_cut'
  | 'time_jump'
  | 'location_jump'
  | 'pov_shift'
  | 'chapter'
  | 'flashback';

// ─── CompiledSceneContract (§2) ─────────────────────────────────────────────

/**
 * Every scene has one CompiledSceneContract BEFORE prose.
 * Contains: branch/discourse position, WorldState/Knowledge/narrator/planned
 * discourse boundary hashes, resolved versioned StyleProfile, deterministic
 * authored continuity packet, prompt contract hash.
 */
export interface CompiledSceneContract {
  /** Scene ID — stable across render attempts. */
  sceneId: string;

  /** Branch scope for this scene. */
  branch: BranchPath;

  /** Discourse position of this scene. */
  discoursePosition: DiscoursePosition;

  /** Hash of the WorldState at scene boundary. */
  worldStateHash: string;

  /** Hash of relevant Knowledge state at scene boundary. */
  knowledgeStateHash: string;

  /** Hash of narrator profile/configuration. */
  narratorProfileHash: string;

  /** Hash of planned discourse boundary (PlannedDiscourseLedger excerpt). */
  plannedDiscourseHash: string;

  /** Resolved versioned StyleProfile. */
  styleProfile: StyleProfile;

  /** Deterministc authored continuity packet. */
  continuityPacket: ContinuityPacket;

  /** Hash of the full prompt contract. */
  promptContractHash: string;

  /** Prompt provider identifier (model/system prompt version). */
  promptProviderId?: string;
}

// ─── SurfaceDependencyGraph (§1) ────────────────────────────────────────────

/**
 * SurfaceDependencyGraph — one of the four render-plan graphs.
 * Defines group-level surface ordering constraints (serial lanes).
 * NEVER cross-branch; NEVER inferred from filename/storyTime/causal order.
 */
export interface SurfaceDependencyGraph {
  /** All groups in this graph. */
  groups: RenderGroup[];

  /**
   * Serial lane order — discourse-order subsequences that MUST render
   * serially within their lane. Groups NOT in any lane render in parallel.
   */
  serialLanes: SerialLane[];

  /** Branch scope — SurfaceDependencyGraph is branch-local. */
  branch: BranchPath;
}

/**
 * A serial lane — ordered group IDs that must render sequentially
 * within their discourse-order lane.
 */
export interface SerialLane {
  laneId: string;
  groupIds: string[];
}

// ─── ValidationGateGraph (§1) ————————————————————————————————————————————————

/**
 * ValidationGateGraph — determines if prose artifact can release/assemble
 * and be surface source. Pass 1 → Pass 2/deterministic checks → accept/retry/block.
 * Accepted prose → surface packet. Failed scene ONLY blocks surface descendants;
 * logical compilation/unrelated groups still valid.
 */
export interface ValidationGateGraph {
  /** Per-scene validation gates. */
  gates: Record<string, ValidationGate>;

  /** Global validation policy. */
  policy: ValidationPolicy;

  /** Branch scope. */
  branch: BranchPath;
}

export interface ValidationGate {
  /** Scene ID this gate guards. */
  sceneId: string;

  /** Current gate status. */
  status: ValidationGateStatus;

  /** Current attempt count. */
  attemptCount: number;

  /** Maximum retry attempts before hard block. */
  maxRetries: number;

  /** Whether fallback_without_surface is legal (must be explicitly stated in group policy). */
  fallbackWithoutSurface: boolean;
}

export type ValidationGateStatus =
  | 'pending'
  | 'pass1_required'
  | 'pass1_complete'
  | 'validation_pending'
  | 'accepted'
  | 'retry'
  | 'blocked';

export interface ValidationPolicy {
  /** Maximum retry attempts per scene. */
  maxRetries: number;

  /** Whether fallback_without_surface is globally permitted. */
  allowFallbackWithoutSurface: boolean;
}

// ─── RenderGroup & Manifest (§5–6) ──────────────────────────────────────────

/**
 * A render group — each scene belongs to exactly one group.
 * Group order is branch discourse order subsequence.
 * NOT inferred from filename/storyTime/causal order/completion timing.
 */
export interface RenderGroup {
  /** Stable group ID. */
  groupId: string;

  /** Sibling scene IDs in this group, in discourse order. */
  sceneIds: string[];

  /** Surface policy for this group. */
  surfacePolicy: SurfacePolicy;
}

/**
 * Group-level surface policy.
 * `parallel` and `serial_surface` are the ONLY supported policies.
 * `parallel_then_harmonize` and `joint_group` are EXPLICITLY X.
 */
export type SurfacePolicy =
  | { type: 'parallel' }
  | { type: 'serial_surface' }
  | { type: 'fallback_without_surface' };

/**
 * RenderGroupManifest — versioned, hash-pinned, overridable.
 * Policy version / source definition hash / group IDs / lanes / surface policy.
 * Enters surface cache key.
 */
export interface RenderGroupManifest {
  /** Manifest version. */
  manifestVersion: string;

  /** Source definition hash — hash of the YAML/catalog definition this manifest was generated from. */
  sourceDefinitionHash: string;

  /** All group IDs in order. */
  groupIds: string[];

  /** Serial lanes for serial_surface groups. */
  lanes: SerialLane[];

  /** Per-group surface policies. */
  groupPolicies: Record<string, SurfacePolicy>;

  /** Planner mode used to generate this manifest. */
  plannerMode: PlannerMode;

  /** Timestamp of manifest generation (deterministic from source hash for same inputs). */
  generatedAt: string;
}

export type PlannerMode = 'manual' | 'suggest' | 'auto';

// ─── SurfaceReferencePacket (§4) — Non-authoritative ────────────────────────

/**
 * SurfaceReferencePacket — fixed tail/full excerpt of accepted source prose
 * + deterministc style metrics + authored anchor.
 *
 * NON-AUTHORITATIVE. YAML ALWAYS wins on conflict.
 * Rhythm/transition only — YAML contract overrides.
 */
export interface SurfaceReferencePacket {
  /** Scene ID this packet references. */
  sceneId: string;

  /** Excerpt mode: fixed tail (last N chars) or full excerpt. */
  excerptMode: 'tail' | 'full' | 'authored_anchor';

  /** The prose excerpt content. */
  excerpt: string;

  /** Style metrics computed from the prose excerpt. */
  styleMetrics: StyleMetrics;

  /** Authored anchor reference (if any). */
  authoredAnchor?: string;

  /** Hash of the source prose this packet was extracted from. */
  sourceProseHash: string;

  /** Whether this packet has been accepted by validation gate. */
  accepted: boolean;

  /** Extractor/truncation version for cache key. */
  extractorVersion: string;
}

/**
 * Deterministic style metrics from prose excerpt.
 * Non-authoritative — for surface reference only.
 */
export interface StyleMetrics {
  /** Average words per sentence. */
  avgSentenceLength: number;

  /** Estimated reading level (Flesch-Kincaid or similar). */
  readingLevel: number;

  /** Token count. */
  tokenCount: number;

  /** Unique word ratio. */
  lexicalDiversity: number;

  /** Dialogue-to-prose ratio (0-1). */
  dialogueRatio: number;
}

// ─── Cache Keys (§10) — 4 independent layers ─────────────────────────────────

/**
 * LogicalRenderKey — scene contract / WorldState / planned discourse /
 * catalog / graph / style / profile / prompt-provider.
 * Changes on YAML/state/logic changes.
 */
export interface LogicalRenderKey {
  /** Scene contract hash. */
  sceneContractHash: string;

  /** WorldState hash at scene boundary. */
  worldStateHash: string;

  /** Planned discourse hash. */
  plannedDiscourseHash: string;

  /** Entity/relationship/rule/knowledge catalog versions. */
  catalogVersionHashes: Record<string, string>;

  /** Graph structure hash. */
  graphHash: string;

  /** Style profile hash. */
  styleProfileHash: string;

  /** Prompt provider identifier. */
  promptProviderId: string;

  /** Full serialized key string. */
  toKeyString(): string;
}

/**
 * SurfaceRenderKey — LogicalRenderKey + group manifest / surface policy /
 * ordered source prose hashes / extractor-truncation version.
 * Changes on group/partition/policy/truncation changes.
 */
export interface SurfaceRenderKey {
  /** Base logical render key. */
  logicalKey: LogicalRenderKey;

  /** Group manifest hash. */
  groupManifestHash: string;

  /** Surface policy hash. */
  surfacePolicyHash: string;

  /** Ordered list of source prose hashes for surface-dependent scenes. */
  sourceProseHashes: string[];

  /** Extractor/truncation version. */
  extractorVersion: string;

  /** Full serialized key string. */
  toKeyString(): string;
}

/**
 * SurfaceValidationKey — SurfaceRenderKey + prose hash / Pass2 schema-model /
 * validator-reference policy.
 * Changes on prose re-render or validation policy changes.
 * INDEPENDENT from logical/discourse cache keys.
 * Named SurfaceValidationKey to distinguish from DISCOURSE-1 ValidationKey.
 */
export interface SurfaceValidationKey {
  /** Surface render key. */
  surfaceKey: SurfaceRenderKey;

  /** Hash of the prose artifact being validated. */
  proseHash: string;

  /** Pass 2 schema/model identifier. */
  pass2SchemaModelId: string;

  /** Validator reference policy version. */
  validatorPolicyVersion: string;

  /** Full serialized key string. */
  toKeyString(): string;
}

/**
 * AttemptKey — SurfaceValidationKey + attempt number / prior prose hash /
 * same-scene retry guidance.
 */
export interface AttemptKey {
  /** Validation (parent) key. */
  validationKey: SurfaceValidationKey;

  /** Current attempt number (1-based). */
  attemptNumber: number;

  /** Hash of prior prose (if retrying). */
  priorProseHash?: string;

  /** Same-scene retry guidance hash (if provided). */
  retryGuidanceHash?: string;

  /** Full serialized key string. */
  toKeyString(): string;
}

// ─── Surface Planner Types (§6) ─────────────────────────────────────────────

export interface SurfacePlannerOptions {
  /** Planner mode. */
  mode: PlannerMode;

  /** Branch path for this plan. */
  branch: BranchPath;

  /** Scene IDs in branch discourse order. */
  sceneIds: string[];

  /** Existing scene contracts for grouping decisions. */
  contracts: CompiledSceneContract[];

  /** Serial surface group lanes (author-specified for manual mode). */
  authorLanes?: SerialLane[];

  /** Auto/suggest mode config. */
  autoConfig?: AutoGroupConfig;
}

export interface AutoGroupConfig {
  /** Maximum parallel group size before splitting. */
  maxParallelGroupSize: number;

  /** Whether auto mode is authorized for this project. */
  authorized: boolean;
}

export interface SurfacePlanResult {
  /** Generated manifest. */
  manifest: RenderGroupManifest;

  /** Surface dependency graph. */
  surfaceDependencyGraph: SurfaceDependencyGraph;

  /** Validation gate graph. */
  validationGateGraph: ValidationGateGraph;

  /** Any planner warnings (e.g., suggestions in suggest mode). */
  warnings?: string[];
}

// ─── Errors ─────────────────────────────────────────────────────────────────

export class SurfacePlannerError extends Error {
  constructor(
    message: string,
    public readonly code: SurfaceErrorCode,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SurfacePlannerError';
  }
}

export type SurfaceErrorCode =
  | 'CROSS_BRANCH_SURFACE_EDGE'
  | 'SURFACE_CYCLE'
  | 'UNACCEPTED_SOURCE_PROSE'
  | 'UNVERSIONED_EXTRACTION'
  | 'UNVERSIONED_BUDGET'
  | 'MISSING_CONTRACT'
  | 'INVALID_POLICY'
  | 'UNAUTHORIZED_AUTO_MODE'
  | 'BRANCH_MISMATCH'
  | 'GROUP_SCENE_CONFLICT'
  | 'FALLBACK_WITHOUT_SURFACE_NOT_ALLOWED'
  | 'EXHAUSTED_RETRY';
