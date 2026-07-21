// ============================================================================
// Novalistically — INTEGRATION-1: Cross-domain resolution, Merge & dual coverage
// Types for AbsenceWitness, ReadResolution, BoundaryReference, MergePlan,
// StorySnapshot, DiscourseSnapshot, dual coverage manifest.
// ============================================================================

import type {
  BranchPath,
} from './branch.js';
import type {
  NarrativeEvent,
} from './event.js';
import type {
  WorldState,
} from './world.js';
import type {
  EntityId,
} from './entity.js';
import type {
  RelationshipId,
  EpochId as RelEpochId,
  MembershipId,
} from './relationship.js';
import type {
  RuleId,
  RuleEpochId,
  RuleExceptionId,
  RuleSpecificationId,
} from './rule.js';
import type {
  ThreadId,
} from './thread.js';

// ─── ProviderOutput — deterministic read result from a provider ──────────────

export interface ProviderOutput {
  outputId: string;
  provider: string;
  eventId: string;
  branch: BranchPath;
  temporalPrefix: string;
  content: unknown;
  resolutionHash: string;
  causality: 'provider_edge';
}

// ─── AbsenceWitness — deterministic absence resolution ───────────────────────

export type AbsenceBasis =
  | 'never_written'
  | 'pre_introduction'
  | 'after_unset'
  | 'branch_local';

export interface AbsenceWitness {
  /** Concrete branch this witness is bound to */
  branch: BranchPath;
  /** Ancestor-closed temporal node prefix */
  temporalPrefix: string;
  /** Catalog/lifecycle/closed-world basis — exactly 4 values */
  basis: AbsenceBasis;
  /** Latest unset output ID, if any */
  latestUnsetOutput?: string;
  /** Deterministic resolution hash */
  resolutionHash: string;
}

// ─── ReadResolution — exactly one per deterministic read ─────────────────────

/** Every deterministic read produces exactly one ReadResolution:
 *  ProviderOutput (with provider edge) or AbsenceWitness (absence index). */
export type ReadResolution = ProviderOutput | AbsenceWitness;

// ─── BoundaryReference — one-way StorySnapshot/StateBoundary input ──────────

export interface BoundaryReference {
  /** Hash of the source StorySnapshot or StateBoundary */
  sourceSnapshotHash: string;
  /** Branch compatibility marker */
  branch: BranchPath;
  /** Proposition IDs projected into discourse */
  propositions: string[];
  /** Verified truth values for the projected propositions */
  truthValues: Record<string, boolean>;
}

// ─── MergePolicy — exactly 3 values ──────────────────────────────────────────

export type MergePolicy =
  | { type: 'requireEqual' }
  | { type: 'selectBranch'; branchId: string }
  | { type: 'literal' };

// ─── MergePlan — cross-branch reconciliation ─────────────────────────────────

export interface MergePlan {
  /** Hashes of incoming pinned snapshots */
  incomingSnapshots: string[];
  /** Merge node / effective coordinate */
  mergeNode: string;
  /** Coordinate string identifying the merge point */
  effectiveCoordinate: string;
  /** Domain-scoped policies */
  policies: Record<string, MergePolicy>;
  /** Source and merge provenance */
  provenance: {
    /** Source branch path */
    sourceBranch: BranchPath;
    /** Timestamp of merge construction */
    mergeTimestamp: string;
    /** Provenance source identifier */
    source: string;
  };
}

// ─── NarrativeEllipsis — omitted content in story replay ────────────────────

export interface NarrativeEllipsis {
  id: string;
  sourceRange: { start: string; end: string };
  omittedContent: string;
  provenance: string;
}

// ─── NarrativeNode — covers story replay / source state ─────────────────────

export type NarrativeNode = NarrativeEvent | NarrativeEllipsis;

// ─── ScenePresentation — discourse scene presentation ───────────────────────

export interface ScenePresentation {
  id: string;
  sceneId: string;
  discoursePosition: number;
  plannedActs: string[];
  provenance: string;
}

// ─── DiscourseBridge — omitted-text disclosure record ───────────────────────

export interface DiscourseBridge {
  id: string;
  position: number;
  plannedActs: string[];
  provenance: string;
}

// ─── DiscourseNode — covers reader discourse order / planned disclosure ─────

export type DiscourseNode = ScenePresentation | DiscourseBridge;

// ─── CoverageManifest — dual coverage manifest (orthogonal) ─────────────────

export interface CoverageManifest {
  /** Narrative nodes covering story replay / source state */
  narrativeNodes: NarrativeNode[];
  /** Discourse nodes covering reader discourse order / planned disclosure */
  discourseNodes: DiscourseNode[];
}

// ─── StorySnapshot — selection-independent full replay result ───────────────

export interface StorySnapshot {
  /** Concrete branch path */
  branch: BranchPath;
  /** Ancestor-closed temporal node prefix */
  temporalPrefix: string;
  /** Ordered output IDs from replay */
  orderedOutputIds: string[];
  /** Complete world state */
  worldState: WorldState;
  /** Provider index: outputId → provider */
  providerIndex: Record<string, string>;
  /** Absence index: readKey → AbsenceWitness */
  absenceIndex: Record<string, AbsenceWitness>;
  /** Tombstone records for retired/closed entities */
  tombstones: {
    entities: EntityId[];
    relationships: RelationshipId[];
    threads: ThreadId[];
    ruleEpochs: RuleEpochId[];
    ruleExceptions: RuleExceptionId[];
    ruleSpecifications: RuleSpecificationId[];
    retiredIds: string[];
  };
  /** Catalog hashes for type/declaration catalogs */
  catalogHashes: {
    entityTypes: string;
    entityDeclarations: string;
    threadTypes: string;
    relationshipTypes: string;
  };
  /** Normalized graph hash */
  graphHash: string;
  /** Combined state/provenance/schema/replay hash — selection-independent */
  stateHash: string;
}

// ─── DiscourseSnapshot — planned discourse replay result ────────────────────

export interface DiscourseSnapshot {
  /** Assembly identifier */
  assemblyId: string;
  /** Branch path */
  branch: BranchPath;
  /** Current discourse position */
  discoursePosition: number;
  /** Planned discourse state (not rendered prose) */
  discourseState: Record<string, unknown>;
  /** Hash of narrator profile */
  narratorProfileHash: string;
  /** Hash of proposition catalog */
  propositionCatalogHash: string;
  /** Hash of selection state */
  selectionHash: string;
  /** Hash of discourse graph */
  discourseGraphHash: string;
}
