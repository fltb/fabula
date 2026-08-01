// ============================================================================
// Novalistically — Typed Causal Graph Types (GRAPH-1)
// StoryGraph (storyTime) and DiscourseGraph (DiscoursePosition),
// with 4 edge classes, OutputDescriptor, ReadRequirement, provider
// resolution, AbsenceWitness, and typed errors.
//
// NOTE: Types with `Graph` prefix (GraphProviderOutput, GraphAbsenceWitness,
// GraphReadResolution, GraphBoundaryReference, GraphNarrativeEllipsis)
// are GRAPH-1 specific and distinct from same-name types in integration.ts.
// ============================================================================
import type { SceneStoryCoordinate, StoryCoordinate } from './entity.js';

// ——— Edge Classes & Coordinates ———

/** The four edge classes. NEVER mixed between graphs. */
export type EdgeClass = 'author_origin' | 'provider' | 'same_coordinate_order' | 'internal';

/** Discourse coordinate — discoursePosition domain. */
export interface DiscourseCoordinate {
  type: 'discoursePosition';
  value: number;
}

/** Either storyTime (StoryGraph) or DiscoursePosition (DiscourseGraph). */
export type EffectiveCoordinate = StoryCoordinate | DiscourseCoordinate;

// ——— OutputDescriptor (§5) ———

/** Value state: set (with data) or unset (reversion/removal). */
export type OutputValue = { type: 'set'; data: unknown } | { type: 'unset' };

/**
 * Every replay effect normalises to an immutable OutputDescriptor with:
 * - stable output/effect/node ID
 * - canonical state/artifact key
 * - set/unset after value
 * - branch scope
 * - effectiveCoordinate (storyTime or DiscoursePosition)
 * - provenance hash
 */
export interface OutputDescriptor {
  outputId: string;
  canonicalKey: string;
  value: OutputValue;
  branchScope: string;
  effectiveCoordinate: EffectiveCoordinate;
  provenanceHash: string;
}

// ——— ReadRequirement (§9) ———

export type ReadPhase = 'stateBefore' | 'stateAfter';

export type ReadOrigin = 'precondition' | 'source' | 'rule' | 'scope' | 'lifecycle' | 'merge';

/**
 * Presence-aware predicate for ReadRequirement.
 * - exists: the key must be present
 * - absent: the key must be absent
 * - equals: the value must equal a specific value
 * - neq/gt/gte/lt/lte/contains/not_contains: compile-time existence check
 *   (full operator semantics enforced at runtime by applyNarrativeEvent)
 * - matches: the value must match a pattern
 */
export type PresencePredicate =
  | { type: 'exists' }
  | { type: 'absent' }
  | { type: 'equals'; value: unknown }
  | { type: 'neq'; value: unknown }
  | { type: 'gt'; value: unknown }
  | { type: 'gte'; value: unknown }
  | { type: 'lt'; value: unknown }
  | { type: 'lte'; value: unknown }
  | { type: 'contains'; value: unknown }
  | { type: 'not_contains'; value: unknown }
  | { type: 'matches'; pattern: string };

/**
 * Every deterministic consumer exposes a ReadRequirement:
 * - read ID
 * - exact canonical key/artifact
 * - presence-aware predicate
 * - stateBefore/stateAfter phase
 * - branch scope
 * - origin (precondition/source/rule/scope/lifecycle/merge)
 */
export interface ReadRequirement {
  readId: string;
  canonicalKey: string;
  predicate: PresencePredicate;
  phase: ReadPhase;
  branchScope: string;
  origin: ReadOrigin;
}

// ——— GraphEdge (§4) ———

/**
 * One predecessor per dependency.
 * Multiple causes use multiple dependency edges (can share causalGroupId).
 */
export interface GraphEdge {
  predecessor: string;
  dependent: string;
  edgeClass: EdgeClass;
  causalGroupId?: string;
}

// ——— Provider Resolution (§12–14) ———

/** A resolved provider — points to an output that satisfies the read. */
export interface GraphProviderOutput {
  type: 'output';
  outputId: string;
  canonicalKey: string;
  coordinate: EffectiveCoordinate;
  provenanceHash: string;
}

/** A read that has no matching provider (canonical absence). */
export interface GraphAbsenceWitness {
  type: 'absence';
  readId: string;
  canonicalKey: string;
  coordinate?: EffectiveCoordinate;
  reason: string;
}

/** Each dependent read per branch has exactly one ReadResolution. */
export type GraphReadResolution = GraphProviderOutput | GraphAbsenceWitness;

// ——— BoundaryReference (§2) ———

/**
 * Hash-pinned, one-way readonly reference between StoryGraph and DiscourseGraph.
 * Only StorySnapshot → Discourse validation/context.
 * NEVER cross-graph causal/provider edges.
 */
export interface GraphBoundaryReference {
  type: 'boundary';
  snapshotHash: string;
  sourceGraph: 'story' | 'discourse';
  targetGraph: 'discourse' | 'story';
  pinnedOutputs: string[];
}

// ——— NarrativeEllipsis (§22) ———

/** Only StoryGraph predecessor/dependent. Summary NEVER selected. */
export interface GraphNarrativeEllipsis {
  outputId: string;
  storyCoordinate: SceneStoryCoordinate;
  requiredOutputHash: string;
}

// ——— Graph Structures (§1) ———

/**
 * StoryGraph is a graph-wide structure: only nodes and outputs have coordinates.
 * Outputs include entity/relationship/knowledge/story-thread/rule writes,
 * materialized defaults, merge writes, information acts, and rule evaluations.
 */
export interface StoryGraph {
  type: 'story';
  edges: GraphEdge[];
  outputs: OutputDescriptor[];
  reads: ReadRequirement[];
  resolutions: GraphReadResolution[];
  hash: string;
  ellipses?: GraphNarrativeEllipsis[];
}

/**
 * DiscourseGraph is a graph-wide structure: only nodes and outputs have coordinates.
 * It can have boundary references from StorySnapshot.
 */
export interface DiscourseGraph {
  type: 'discourse';
  edges: GraphEdge[];
  outputs: OutputDescriptor[];
  hash: string;
  boundaryReferences?: GraphBoundaryReference[];
  sceneSequence: readonly DiscourseSceneSequenceEntry[];
}

// ——— DiscourseSceneSequenceEntry ———

/** A single scene in the branch's reader-order scene sequence. */
export interface DiscourseSceneSequenceEntry {
  sceneId: string;
  sequence: number;
  chapter: number;
  actionInterval?: { start: number; end: number };
}

// ——— Cache Entry (§25) ———

export interface GraphCacheEntry {
  branchScope: string;
  dependencyHashes: string[];
  outputHashes: string[];
  absenceHashes: string[];
  timestamp: number;
}

// ——— Compiler Options ———

export interface GraphCompilerOptions {
  branchPath?: string;
  allowAbsence?: boolean;
}

// ——— Compiler Result ———

export interface GraphCompilerResult {
  storyGraphs: StoryGraph[];
  discourseGraphs: DiscourseGraph[];
  cache: GraphCacheEntry[];
  errors: GraphCompileError[];
}

// ============================================================================
// Typed Errors (§24 — 24 categories)
// ============================================================================

export interface GraphErrorContext {
  code: string;
  nodeId?: string;
  edgeClass?: EdgeClass;
  branchScope?: string;
  canonicalKey?: string;
  readId?: string;
  outputId?: string;
  coordinate?: EffectiveCoordinate;
  cycle?: string[];
  detail?: string;
}

export class GraphCompileError extends Error {
  readonly code: string;
  readonly context: Readonly<GraphErrorContext>;

  constructor(code: string, message: string, context: GraphErrorContext = { code }) {
    super(message);
    this.name = 'GraphCompileError';
    this.code = code;
    this.context = context;
  }
}

// — 1. UnknownPredecessor —
export class UnknownPredecessorError extends GraphCompileError {
  constructor(nodeId: string, predecessor: string, context?: Partial<GraphErrorContext>) {
    super('UNKNOWN_PREDECESSOR', `Unknown predecessor "${predecessor}" for node "${nodeId}"`, {
      code: 'UNKNOWN_PREDECESSOR',
      nodeId,
      detail: `predecessor: ${predecessor}`,
      ...context,
    });
  }
}

// — 2. SelfPredecessor —
export class SelfPredecessorError extends GraphCompileError {
  constructor(nodeId: string, context?: Partial<GraphErrorContext>) {
    super('SELF_PREDECESSOR', `Node "${nodeId}" lists itself as predecessor`, {
      code: 'SELF_PREDECESSOR',
      nodeId,
      ...context,
    });
  }
}

// — 3. MissingOutput —
export class MissingOutputError extends GraphCompileError {
  constructor(canonicalKey: string, nodeId?: string, context?: Partial<GraphErrorContext>) {
    super('MISSING_OUTPUT', `Missing output for canonical key "${canonicalKey}"`, {
      code: 'MISSING_OUTPUT',
      canonicalKey,
      nodeId,
      ...context,
    });
  }
}

// — 4. AmbiguousOutput —
export class AmbiguousOutputError extends GraphCompileError {
  constructor(
    canonicalKey: string,
    candidates: string[],
    nodeId?: string,
    context?: Partial<GraphErrorContext>,
  ) {
    super(
      'AMBIGUOUS_OUTPUT',
      `Ambiguous output for key "${canonicalKey}": ${candidates.join(', ')}`,
      {
        code: 'AMBIGUOUS_OUTPUT',
        canonicalKey,
        nodeId,
        detail: `candidates: ${candidates.join(', ')}`,
        ...context,
      },
    );
  }
}

// — 5. AssertionMismatch —
export class AssertionMismatchError extends GraphCompileError {
  constructor(
    expected: string,
    actual: string,
    nodeId?: string,
    context?: Partial<GraphErrorContext>,
  ) {
    super('ASSERTION_MISMATCH', `Assertion mismatch: expected "${expected}", got "${actual}"`, {
      code: 'ASSERTION_MISMATCH',
      nodeId,
      detail: `expected: ${expected}, actual: ${actual}`,
      ...context,
    });
  }
}

// — 6. ReadMismatch —
export class ReadMismatchError extends GraphCompileError {
  constructor(
    readId: string,
    expected: string,
    actual: string,
    context?: Partial<GraphErrorContext>,
  ) {
    super(
      'READ_MISMATCH',
      `Read mismatch for "${readId}": expected "${expected}", got "${actual}"`,
      {
        code: 'READ_MISMATCH',
        readId,
        detail: `expected: ${expected}, actual: ${actual}`,
        ...context,
      },
    );
  }
}

// — 7. UnknownReadId —
export class UnknownReadIdError extends GraphCompileError {
  constructor(readId: string, context?: Partial<GraphErrorContext>) {
    super('UNKNOWN_READ_ID', `Unknown read ID "${readId}"`, {
      code: 'UNKNOWN_READ_ID',
      readId,
      ...context,
    });
  }
}

// — 8. StaleProviderSelection —
export class StaleProviderSelectionError extends GraphCompileError {
  constructor(
    readId: string,
    selectedOutput: string,
    latestOutput: string,
    context?: Partial<GraphErrorContext>,
  ) {
    super(
      'STALE_PROVIDER_SELECTION',
      `Stale provider selection for read "${readId}": selected "${selectedOutput}" but latest is "${latestOutput}"`,
      {
        code: 'STALE_PROVIDER_SELECTION',
        readId,
        outputId: selectedOutput,
        detail: `latest: ${latestOutput}`,
        ...context,
      },
    );
  }
}

// — 9. DuplicateBranchProvider —
export class DuplicateBranchProviderError extends GraphCompileError {
  constructor(
    readId: string,
    branchScope: string,
    existing: string,
    conflict: string,
    context?: Partial<GraphErrorContext>,
  ) {
    super(
      'DUPLICATE_BRANCH_PROVIDER',
      `Duplicate provider for read "${readId}" in branch "${branchScope}": "${existing}" vs "${conflict}"`,
      {
        code: 'DUPLICATE_BRANCH_PROVIDER',
        readId,
        branchScope,
        detail: `existing: ${existing}, conflict: ${conflict}`,
        ...context,
      },
    );
  }
}

// — 10. BranchCoverage —
export class BranchCoverageError extends GraphCompileError {
  constructor(branchScope: string, readId: string, context?: Partial<GraphErrorContext>) {
    super('BRANCH_COVERAGE', `Branch "${branchScope}" coverage gap for read "${readId}"`, {
      code: 'BRANCH_COVERAGE',
      branchScope,
      readId,
      ...context,
    });
  }
}

// — 11. BranchIncompatibility —
export class BranchIncompatibilityError extends GraphCompileError {
  constructor(branchScope: string, detail: string, context?: Partial<GraphErrorContext>) {
    super('BRANCH_INCOMPATIBILITY', `Branch incompatibility: "${branchScope}" — ${detail}`, {
      code: 'BRANCH_INCOMPATIBILITY',
      branchScope,
      detail,
      ...context,
    });
  }
}

// — 12. FutureTime —
export class FutureTimeError extends GraphCompileError {
  constructor(
    coordinate: EffectiveCoordinate,
    nodeId: string,
    predecessorCoordinate: EffectiveCoordinate,
    context?: Partial<GraphErrorContext>,
  ) {
    super(
      'FUTURE_TIME',
      `Future time: node "${nodeId}" at ${JSON.stringify(coordinate)} has predecessor at ${JSON.stringify(predecessorCoordinate)}`,
      {
        code: 'FUTURE_TIME',
        coordinate,
        nodeId,
        detail: `predecessor coordinate: ${JSON.stringify(predecessorCoordinate)}`,
        ...context,
      },
    );
  }
}

// — 13. InvalidSameCoordinateOrder —
export class InvalidSameCoordinateOrderError extends GraphCompileError {
  constructor(predecessor: string, dependent: string, context?: Partial<GraphErrorContext>) {
    super(
      'INVALID_SAME_COORDINATE_ORDER',
      `same_coordinate_order edge "${predecessor}" → "${dependent}" requires equal point coordinates`,
      {
        code: 'INVALID_SAME_COORDINATE_ORDER',
        nodeId: dependent,
        detail: `predecessor: ${predecessor}`,
        ...context,
      },
    );
  }
}

// — 14. UnorderedStoryConflict —
export class UnorderedStoryConflictError extends GraphCompileError {
  constructor(
    nodeId: string,
    coordinate: EffectiveCoordinate,
    conflictingNode: string,
    context?: Partial<GraphErrorContext>,
  ) {
    super(
      'UNORDERED_STORY_CONFLICT',
      `Unordered story conflict: "${nodeId}" and "${conflictingNode}" overlap at ${JSON.stringify(coordinate)}`,
      {
        code: 'UNORDERED_STORY_CONFLICT',
        coordinate,
        nodeId,
        detail: `conflicting node: ${conflictingNode}`,
        ...context,
      },
    );
  }
}

// — 15. CrossClockEdge —
export class CrossClockEdgeError extends GraphCompileError {
  constructor(predecessor: string, dependent: string, context?: Partial<GraphErrorContext>) {
    super(
      'CROSS_CLOCK_EDGE',
      `Cross-clock edge: "${predecessor}" → "${dependent}" — story/discourse clocks cannot cross-domain depend`,
      {
        code: 'CROSS_CLOCK_EDGE',
        nodeId: dependent,
        detail: `predecessor: ${predecessor}`,
        ...context,
      },
    );
  }
}

// — 16. EdgeOriginCycle —
export class EdgeOriginCycleError extends GraphCompileError {
  constructor(cycle: string[], context?: Partial<GraphErrorContext>) {
    super('EDGE_ORIGIN_CYCLE', `Edge-origin cycle detected: ${cycle.join(' → ')}`, {
      code: 'EDGE_ORIGIN_CYCLE',
      cycle,
      detail: cycle.join(' → '),
      ...context,
    });
  }
}

// — 17. InitialRootMisuse —
export class InitialRootMisuseError extends GraphCompileError {
  constructor(nodeId: string, edgeClass: EdgeClass, context?: Partial<GraphErrorContext>) {
    super(
      'INITIAL_ROOT_MISUSE',
      `Initial root misuse: "${nodeId}" has edge class "${edgeClass}" — initial root cannot be author_origin/same_coordinate_order predecessor`,
      {
        code: 'INITIAL_ROOT_MISUSE',
        nodeId,
        edgeClass,
        ...context,
      },
    );
  }
}

// — 18. SemanticOutputDependency —
export class SemanticOutputDependencyError extends GraphCompileError {
  constructor(dependent: string, canonicalKey: string, context?: Partial<GraphErrorContext>) {
    super(
      'SEMANTIC_OUTPUT_DEPENDENCY',
      `Semantic output dependency: "${dependent}" depends on "${canonicalKey}" which is not a valid output`,
      {
        code: 'SEMANTIC_OUTPUT_DEPENDENCY',
        nodeId: dependent,
        canonicalKey,
        ...context,
      },
    );
  }
}

// — 19. DynamicLifecycle —
export class DynamicLifecycleError extends GraphCompileError {
  constructor(nodeId: string, detail: string, context?: Partial<GraphErrorContext>) {
    super('DYNAMIC_LIFECYCLE', `Dynamic lifecycle error at "${nodeId}": ${detail}`, {
      code: 'DYNAMIC_LIFECYCLE',
      nodeId,
      detail,
      ...context,
    });
  }
}

// — 20. MergeInput —
export class MergeInputError extends GraphCompileError {
  constructor(detail: string, nodeId?: string, context?: Partial<GraphErrorContext>) {
    super('MERGE_INPUT', `Merge input error: ${detail}`, {
      code: 'MERGE_INPUT',
      nodeId,
      detail,
      ...context,
    });
  }
}

// — 21. EllipsisSummary —
export class EllipsisSummaryError extends GraphCompileError {
  constructor(outputId: string, detail: string, context?: Partial<GraphErrorContext>) {
    super('ELLIPSIS_SUMMARY', `Ellipsis summary error at "${outputId}": ${detail}`, {
      code: 'ELLIPSIS_SUMMARY',
      outputId,
      detail,
      ...context,
    });
  }
}

// — 22. ProvenanceError —
export class ProvenanceError extends GraphCompileError {
  constructor(
    outputId: string,
    expectedHash: string,
    actualHash: string,
    context?: Partial<GraphErrorContext>,
  ) {
    super(
      'PROVENANCE_ERROR',
      `Provenance mismatch at "${outputId}": expected "${expectedHash}", got "${actualHash}"`,
      {
        code: 'PROVENANCE_ERROR',
        outputId,
        detail: `expected: ${expectedHash}, actual: ${actualHash}`,
        ...context,
      },
    );
  }
}

// — 23. NoOutputEdge —
export class NoOutputEdgeError extends GraphCompileError {
  constructor(dependent: string, predecessor: string, context?: Partial<GraphErrorContext>) {
    super(
      'NO_OUTPUT_EDGE',
      `Edge from "${predecessor}" to "${dependent}" has no output — cannot resolve dependency`,
      {
        code: 'NO_OUTPUT_EDGE',
        nodeId: dependent,
        detail: `predecessor: ${predecessor}`,
        ...context,
      },
    );
  }
}

// — 24. DuplicateDiscoursePosition —
export class DuplicateDiscoursePositionError extends GraphCompileError {
  constructor(
    position: number,
    existingNode: string,
    conflictingNode: string,
    context?: Partial<GraphErrorContext>,
  ) {
    super(
      'DUPLICATE_DISCOURSE_POSITION',
      `Duplicate discourse position ${position}: "${existingNode}" and "${conflictingNode}"`,
      {
        code: 'DUPLICATE_DISCOURSE_POSITION',
        detail: `position: ${position}, existing: ${existingNode}, conflicting: ${conflictingNode}`,
        nodeId: conflictingNode,
        ...context,
      },
    );
  }
}
