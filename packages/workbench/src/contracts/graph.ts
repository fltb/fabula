/**
 * Workbench graph contract — browser-safe, frozen DTOs.
 *
 * `WorkbenchGraphViewV1` / `WorkbenchRouteViewV1` are the Workbench-client
 * projection of Core's compiler-owned canonical graph artifact
 * (`inspectCanonicalGraphRuntime` from `@novalistically/core/tooling`). The
 * projection is produced by the pure Host-side adapter in
 * `host/graph-projection.ts`; this file is the standalone, dependency-free
 * surface the browser imports.
 *
 * No graph value here is reconstructed from YAML, prose, output ids, or
 * adjacency: every node, coordinate, edge, hash, and reader-order entry is
 * copied verbatim from the compiler artifact. `branchScope` values are opaque
 * compiler identities — consumers MUST NOT parse them into paths.
 *
 * This file imports nothing: it is safe for the browser bundle, holds no
 * Host/Node/Git/credential/persistence/Core handles, and carries no source
 * text.
 */

/** Version of every graph/route DTO in this module. */
export const WORKBENCH_GRAPH_VIEW_VERSION = 1 as const;
export type WorkbenchGraphViewVersion = typeof WORKBENCH_GRAPH_VIEW_VERSION;

/** Which canonical graph domain a view projects. */
export type WorkbenchGraphDomainV1 = 'story' | 'discourse';

// ─── Nodes & coordinates ────────────────────────────────────────────────

/** Story-clock coordinate of a compiler-owned node. */
export type WorkbenchStoryCoordinateV1 =
  | { readonly type: 'storyTime'; readonly kind: 'initial' }
  | { readonly type: 'storyTime'; readonly kind: 'unlocated' }
  | {
      readonly type: 'storyTime';
      readonly kind: 'point';
      readonly clock: 'story' | 'calendar' | 'chapter';
      readonly scalar: number;
    };

/** Story coordinate of a story-only narrative ellipsis (never `initial`). */
export type WorkbenchSceneStoryCoordinateV1 = Exclude<
  WorkbenchStoryCoordinateV1,
  { readonly kind: 'initial' }
>;

/** Discourse-position coordinate of a compiler-owned node. */
export interface WorkbenchDiscourseCoordinateV1 {
  readonly type: 'discoursePosition';
  readonly value: number;
}

export type WorkbenchGraphCoordinateV1 =
  | WorkbenchStoryCoordinateV1
  | WorkbenchDiscourseCoordinateV1;

export type WorkbenchGraphNodeOriginV1 =
  | { readonly type: 'initial' }
  | {
      readonly type: 'event';
      readonly eventId: string;
      readonly source: 'event_file' | 'branch_point' | 'system';
    }
  | {
      readonly type: 'discourse';
      readonly entryId: string;
      readonly sceneId: string;
      readonly branch: string;
    };

/** One compiler-owned node, detached with its exact id, coordinate, and origin. */
export interface WorkbenchGraphNodeV1 {
  readonly id: string;
  readonly coordinate: WorkbenchGraphCoordinateV1;
  readonly branchScope: string;
  readonly origin: WorkbenchGraphNodeOriginV1;
}

// ─── Edges ──────────────────────────────────────────────────────────────

/** The four canonical edge classes; never mixed between graphs. */
export type WorkbenchGraphEdgeClassV1 =
  | 'author_origin'
  | 'provider'
  | 'same_coordinate_order'
  | 'internal';

/** One directed predecessor→dependent dependency edge. */
export interface WorkbenchGraphEdgeV1 {
  readonly predecessor: string;
  readonly dependent: string;
  readonly edgeClass: WorkbenchGraphEdgeClassV1;
  readonly causalGroupId?: string;
}

// ─── Outputs ────────────────────────────────────────────────────────────

export type WorkbenchOutputValueV1 =
  | { readonly type: 'set'; readonly data: unknown }
  | { readonly type: 'unset' };

/** One normalized replay output with its provenance hash. */
export interface WorkbenchGraphOutputV1 {
  readonly outputId: string;
  readonly canonicalKey: string;
  readonly value: WorkbenchOutputValueV1;
  readonly branchScope: string;
  readonly effectiveCoordinate: WorkbenchGraphCoordinateV1;
  readonly provenanceHash: string;
}

// ─── Reads & resolutions ────────────────────────────────────────────────

export type WorkbenchReadPhaseV1 = 'stateBefore' | 'stateAfter';

export type WorkbenchReadOriginV1 =
  | 'precondition'
  | 'source'
  | 'rule'
  | 'scope'
  | 'lifecycle'
  | 'merge';

export type WorkbenchPresencePredicateV1 =
  | { readonly type: 'exists' }
  | { readonly type: 'absent' }
  | { readonly type: 'equals'; readonly value: unknown }
  | { readonly type: 'neq'; readonly value: unknown }
  | { readonly type: 'gt'; readonly value: unknown }
  | { readonly type: 'gte'; readonly value: unknown }
  | { readonly type: 'lt'; readonly value: unknown }
  | { readonly type: 'lte'; readonly value: unknown }
  | { readonly type: 'contains'; readonly value: unknown }
  | { readonly type: 'not_contains'; readonly value: unknown }
  | { readonly type: 'matches'; readonly pattern: string };

/** One deterministic consumer read requirement. */
export interface WorkbenchGraphReadV1 {
  readonly readId: string;
  readonly canonicalKey: string;
  readonly predicate: WorkbenchPresencePredicateV1;
  readonly phase: WorkbenchReadPhaseV1;
  readonly branchScope: string;
  readonly origin: WorkbenchReadOriginV1;
}

/** Each dependent read per branch has exactly one resolution. */
export type WorkbenchGraphResolutionV1 =
  | {
      readonly type: 'output';
      readonly outputId: string;
      readonly canonicalKey: string;
      readonly coordinate: WorkbenchGraphCoordinateV1;
      readonly provenanceHash: string;
    }
  | {
      readonly type: 'absence';
      readonly readId: string;
      readonly canonicalKey: string;
      readonly coordinate?: WorkbenchGraphCoordinateV1;
      readonly reason: string;
    };

// ─── Boundary references & ellipses ─────────────────────────────────────

/** Hash-pinned, one-way readonly reference between the two graphs. */
export interface WorkbenchGraphBoundaryReferenceV1 {
  readonly type: 'boundary';
  readonly snapshotHash: string;
  readonly sourceGraph: 'story' | 'discourse';
  readonly targetGraph: 'discourse' | 'story';
  readonly pinnedOutputs: readonly string[];
}

/** Story-only narrative ellipsis (summary never selected). */
export interface WorkbenchGraphNarrativeEllipsisV1 {
  readonly outputId: string;
  readonly storyCoordinate: WorkbenchSceneStoryCoordinateV1;
  readonly requiredOutputHash: string;
}

// ─── Scene sequence ─────────────────────────────────────────────────────

/** One scene in the branch's canonical reader-order scene sequence. */
export interface WorkbenchSceneSequenceEntryV1 {
  readonly sceneId: string;
  readonly sequence: number;
  readonly chapter: number;
  readonly actionInterval?: { readonly start: number; readonly end: number };
}

// ─── Graph view ─────────────────────────────────────────────────────────

/**
 * One canonical graph domain (story or discourse) as a browser-safe view.
 * Every value is copied verbatim from the compiler artifact; empty
 * collections mark collections the domain does not produce.
 */
export interface WorkbenchGraphViewV1 {
  readonly version: WorkbenchGraphViewVersion;
  readonly domain: WorkbenchGraphDomainV1;
  readonly hash: string;
  readonly nodes: readonly WorkbenchGraphNodeV1[];
  readonly edges: readonly WorkbenchGraphEdgeV1[];
  readonly outputs: readonly WorkbenchGraphOutputV1[];
  readonly reads: readonly WorkbenchGraphReadV1[];
  readonly resolutions: readonly WorkbenchGraphResolutionV1[];
  readonly boundaryReferences: readonly WorkbenchGraphBoundaryReferenceV1[];
  readonly ellipses: readonly WorkbenchGraphNarrativeEllipsisV1[];
  readonly sceneSequence: readonly WorkbenchSceneSequenceEntryV1[];
}

// ─── Route ──────────────────────────────────────────────────────────────

/** One branch decision along a selected route. */
export interface WorkbenchBranchDecisionV1 {
  readonly atEventId: string;
  readonly choiceId: string;
  readonly narrativeOrder: number;
}

/** Selected canonical branch path. */
export interface WorkbenchBranchPathV1 {
  readonly decisions: readonly WorkbenchBranchDecisionV1[];
}

/** Opaque compiler branch identity — NEVER parsed by consumers. */
export type WorkbenchBranchScopeV1 = string;

export interface WorkbenchConditionV1 {
  readonly type: 'equals' | 'not_equals' | 'greater_than' | 'less_than' | 'contains' | 'and' | 'or';
  readonly field?: string;
  readonly value?: unknown;
  readonly conditions?: readonly WorkbenchConditionV1[];
}

export type WorkbenchBranchSetV1 =
  | { readonly type: 'all' }
  | { readonly type: 'paths'; readonly paths: readonly WorkbenchBranchPathV1[] }
  | { readonly type: 'condition'; readonly condition: WorkbenchConditionV1 }
  | { readonly type: 'except'; readonly branches: WorkbenchBranchSetV1 };

/** One branch choice exposed by the canonical route compiler, without its mutation payload. */
export interface WorkbenchRouteChoiceV1 {
  readonly eventId: string;
  readonly choiceId: string;
  readonly label: string;
  readonly description: string;
  readonly targetEventId: string;
  readonly narrativeOrder: number;
}

/** One event's authored branch existence on the selected route. */
export interface WorkbenchRouteEventScopeV1 {
  readonly eventId: string;
  readonly branchExistence: WorkbenchBranchSetV1;
}

/** The selected canonical route plus the authored route space. */
export interface WorkbenchRouteViewV1 {
  readonly version: WorkbenchGraphViewVersion;
  readonly branchPath: WorkbenchBranchPathV1;
  readonly branchScope: WorkbenchBranchScopeV1;
  readonly discourseBranch: string;
  readonly selectedEventIds: readonly string[];
  readonly leafPaths: readonly WorkbenchBranchPathV1[];
  readonly eventScopes: readonly WorkbenchRouteEventScopeV1[];
  readonly choices: readonly WorkbenchRouteChoiceV1[];
}

/**
 * Strict documented route selector accepted by the browser read API and the
 * projector. Wire form: URL-encoded JSON of exactly this shape; unknown keys
 * or wrong types must be rejected.
 */
export interface WorkbenchRouteSelectorV1 {
  readonly version: WorkbenchGraphViewVersion;
  readonly branchPath: WorkbenchBranchPathV1;
  readonly discourseBranch?: string;
}

/** Detached, frozen projection of one canonical graph runtime. */
export interface WorkbenchGraphProjectionV1 {
  readonly version: WorkbenchGraphViewVersion;
  readonly story: WorkbenchGraphViewV1;
  readonly discourse: WorkbenchGraphViewV1;
  readonly route: WorkbenchRouteViewV1;
}
