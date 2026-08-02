/**
 * Pure Host-side adapter from Core's compiler-owned canonical graph artifact
 * (`inspectCanonicalGraphRuntime` from `@novalistically/core/tooling`) into
 * browser-safe, deeply frozen `WorkbenchGraphViewV1` / `WorkbenchRouteViewV1`
 * DTOs.
 *
 * The projection copies compiler values verbatim — node identity/coordinates/
 * origins, directed edges, output provenance, reads/resolutions, boundary
 * references, ellipses, both graph hashes, the discourse sceneSequence, and
 * the full route (branchPath, opaque branchScope, discourseBranch, leaf
 * paths, event scopes, choices). Nothing is reconstructed from YAML, prose,
 * output ids, or adjacency, and `branchScope` values are never parsed.
 *
 * The returned DTOs are detached (fresh objects) and deeply frozen; they
 * carry no source text and no Host handles, so they are safe to hand to the
 * browser read API.
 */

import type { CompileProjectOptions, ProjectSourceSnapshotV1 } from '@novalistically/core';
import {
  type CanonicalGraphRuntimeSnapshot,
  inspectCanonicalGraphRuntime,
} from '@novalistically/core/tooling';
import {
  WORKBENCH_GRAPH_VIEW_VERSION,
  type WorkbenchBranchPathV1,
  type WorkbenchBranchSetV1,
  type WorkbenchConditionV1,
  type WorkbenchGraphBoundaryReferenceV1,
  type WorkbenchGraphCoordinateV1,
  type WorkbenchGraphEdgeV1,
  type WorkbenchGraphNarrativeEllipsisV1,
  type WorkbenchGraphNodeOriginV1,
  type WorkbenchGraphNodeV1,
  type WorkbenchGraphOutputV1,
  type WorkbenchGraphProjectionV1,
  type WorkbenchGraphReadV1,
  type WorkbenchGraphResolutionV1,
  type WorkbenchGraphViewV1,
  type WorkbenchPresencePredicateV1,
  type WorkbenchRouteEventScopeV1,
  type WorkbenchRouteSelectorV1,
  type WorkbenchRouteViewV1,
  type WorkbenchSceneSequenceEntryV1,
  type WorkbenchSceneStoryCoordinateV1,
} from '../contracts/graph.js';

// Compiler-owned nested types, reached through the snapshot shape so this
// module never depends on Core internals beyond the tooling export.
type StoryGraph = CanonicalGraphRuntimeSnapshot['story']['graph'];
type DiscourseGraph = CanonicalGraphRuntimeSnapshot['discourse']['graph'];
type CanonicalGraphNode = CanonicalGraphRuntimeSnapshot['story']['nodes'][number];
type CanonicalGraphRoute = CanonicalGraphRuntimeSnapshot['route'];
type GraphEdge = StoryGraph['edges'][number];
type GraphOutput = StoryGraph['outputs'][number];
type GraphRead = StoryGraph['reads'][number];
type GraphReadResolution = StoryGraph['resolutions'][number];
type GraphBoundaryReference = NonNullable<DiscourseGraph['boundaryReferences']>[number];
type GraphNarrativeEllipsis = NonNullable<StoryGraph['ellipses']>[number];
type GraphSceneSequenceEntry = DiscourseGraph['sceneSequence'][number];

/** Translate the documented route selector into Core compile options. */
function toCompileOptions(
  selector: WorkbenchRouteSelectorV1 | undefined,
): CompileProjectOptions | undefined {
  if (!selector) return undefined;
  const options: CompileProjectOptions = {
    branchPath: {
      decisions: selector.branchPath.decisions.map((decision) => ({
        atEventId: decision.atEventId,
        choiceId: decision.choiceId,
        narrativeOrder: decision.narrativeOrder,
      })),
    },
  };
  if (selector.discourseBranch !== undefined) options.discourseBranch = selector.discourseBranch;
  return options;
}

function projectCoordinate(
  coordinate: CanonicalGraphNode['coordinate'],
): WorkbenchGraphCoordinateV1 {
  if (coordinate.type === 'discoursePosition') {
    return { type: 'discoursePosition', value: coordinate.value };
  }
  switch (coordinate.kind) {
    case 'initial':
      return { type: 'storyTime', kind: 'initial' };
    case 'unlocated':
      return { type: 'storyTime', kind: 'unlocated' };
    case 'point':
      return {
        type: 'storyTime',
        kind: 'point',
        clock: coordinate.clock,
        scalar: coordinate.scalar,
      };
  }
}

function projectNodeOrigin(origin: CanonicalGraphNode['origin']): WorkbenchGraphNodeOriginV1 {
  if (origin.type === 'initial') return { type: 'initial' };
  if (origin.type === 'event') {
    return { type: 'event', eventId: origin.eventId, source: origin.source };
  }
  return {
    type: 'discourse',
    entryId: origin.entryId,
    sceneId: origin.sceneId,
    branch: origin.branch,
  };
}

function projectNode(node: CanonicalGraphNode): WorkbenchGraphNodeV1 {
  return {
    id: node.id,
    coordinate: projectCoordinate(node.coordinate),
    branchScope: node.branchScope,
    origin: projectNodeOrigin(node.origin),
  };
}

function projectEdge(edge: GraphEdge): WorkbenchGraphEdgeV1 {
  return {
    predecessor: edge.predecessor,
    dependent: edge.dependent,
    edgeClass: edge.edgeClass,
    ...(edge.causalGroupId !== undefined ? { causalGroupId: edge.causalGroupId } : {}),
  };
}

function projectOutput(output: GraphOutput): WorkbenchGraphOutputV1 {
  return {
    outputId: output.outputId,
    canonicalKey: output.canonicalKey,
    value:
      output.value.type === 'set' ? { type: 'set', data: output.value.data } : { type: 'unset' },
    branchScope: output.branchScope,
    effectiveCoordinate: projectCoordinate(output.effectiveCoordinate),
    provenanceHash: output.provenanceHash,
  };
}

function projectPredicate(predicate: GraphRead['predicate']): WorkbenchPresencePredicateV1 {
  // Fresh wrapper object; `value` payloads are already compiler-detached.
  return { ...predicate };
}

function projectRead(read: GraphRead): WorkbenchGraphReadV1 {
  return {
    readId: read.readId,
    canonicalKey: read.canonicalKey,
    predicate: projectPredicate(read.predicate),
    phase: read.phase,
    branchScope: read.branchScope,
    origin: read.origin,
  };
}

function projectResolution(resolution: GraphReadResolution): WorkbenchGraphResolutionV1 {
  if (resolution.type === 'output') {
    return {
      type: 'output',
      outputId: resolution.outputId,
      canonicalKey: resolution.canonicalKey,
      coordinate: projectCoordinate(resolution.coordinate),
      provenanceHash: resolution.provenanceHash,
    };
  }
  return {
    type: 'absence',
    readId: resolution.readId,
    canonicalKey: resolution.canonicalKey,
    ...(resolution.coordinate !== undefined
      ? { coordinate: projectCoordinate(resolution.coordinate) }
      : {}),
    reason: resolution.reason,
  };
}

function projectBoundary(boundary: GraphBoundaryReference): WorkbenchGraphBoundaryReferenceV1 {
  return {
    type: 'boundary',
    snapshotHash: boundary.snapshotHash,
    sourceGraph: boundary.sourceGraph,
    targetGraph: boundary.targetGraph,
    pinnedOutputs: [...boundary.pinnedOutputs],
  };
}

function projectEllipsis(ellipsis: GraphNarrativeEllipsis): WorkbenchGraphNarrativeEllipsisV1 {
  return {
    outputId: ellipsis.outputId,
    // The compiler only ever emits a scene coordinate here; the narrowing
    // cast keeps the DTO honest about never carrying `initial`.
    storyCoordinate: projectCoordinate(ellipsis.storyCoordinate) as WorkbenchSceneStoryCoordinateV1,
    requiredOutputHash: ellipsis.requiredOutputHash,
  };
}

function projectSceneSequenceEntry(entry: GraphSceneSequenceEntry): WorkbenchSceneSequenceEntryV1 {
  return {
    sceneId: entry.sceneId,
    sequence: entry.sequence,
    chapter: entry.chapter,
    ...(entry.actionInterval !== undefined
      ? { actionInterval: { start: entry.actionInterval.start, end: entry.actionInterval.end } }
      : {}),
  };
}

function projectBranchPath(path: WorkbenchBranchPathV1): WorkbenchBranchPathV1 {
  return {
    decisions: path.decisions.map((decision) => ({
      atEventId: decision.atEventId,
      choiceId: decision.choiceId,
      narrativeOrder: decision.narrativeOrder,
    })),
  };
}

function projectCondition(condition: WorkbenchConditionV1): WorkbenchConditionV1 {
  return {
    type: condition.type,
    ...(condition.field !== undefined ? { field: condition.field } : {}),
    ...(condition.value !== undefined ? { value: condition.value } : {}),
    ...(condition.conditions !== undefined
      ? { conditions: condition.conditions.map((nested) => projectCondition(nested)) }
      : {}),
  };
}

function projectBranchSet(branchSet: WorkbenchBranchSetV1): WorkbenchBranchSetV1 {
  switch (branchSet.type) {
    case 'all':
      return { type: 'all' };
    case 'paths':
      return { type: 'paths', paths: branchSet.paths.map((path) => projectBranchPath(path)) };
    case 'condition':
      return { type: 'condition', condition: projectCondition(branchSet.condition) };
    case 'except':
      return { type: 'except', branches: projectBranchSet(branchSet.branches) };
  }
}

function projectRoute(route: CanonicalGraphRoute): WorkbenchRouteViewV1 {
  return {
    version: WORKBENCH_GRAPH_VIEW_VERSION,
    branchPath: projectBranchPath(route.branchPath),
    branchScope: route.branchScope,
    discourseBranch: route.discourseBranch,
    selectedEventIds: [...route.selectedEventIds],
    leafPaths: route.leafPaths.map((path) => projectBranchPath(path)),
    eventScopes: route.eventScopes.map(
      (scope): WorkbenchRouteEventScopeV1 => ({
        eventId: scope.eventId,
        branchExistence: projectBranchSet(scope.branchExistence),
      }),
    ),
    choices: route.choices.map((choice) => ({
      eventId: choice.eventId,
      choiceId: choice.choiceId,
      label: choice.label,
      description: choice.description,
      targetEventId: choice.targetEventId,
      narrativeOrder: choice.narrativeOrder,
    })),
  };
}

function projectStoryView(
  graph: StoryGraph,
  nodes: readonly CanonicalGraphNode[],
): WorkbenchGraphViewV1 {
  return {
    version: WORKBENCH_GRAPH_VIEW_VERSION,
    domain: 'story',
    hash: graph.hash,
    nodes: nodes.map((node) => projectNode(node)),
    edges: graph.edges.map((edge) => projectEdge(edge)),
    outputs: graph.outputs.map((output) => projectOutput(output)),
    reads: graph.reads.map((read) => projectRead(read)),
    resolutions: graph.resolutions.map((resolution) => projectResolution(resolution)),
    boundaryReferences: [],
    ellipses: (graph.ellipses ?? []).map((ellipsis) => projectEllipsis(ellipsis)),
    sceneSequence: [],
  };
}

function projectDiscourseView(
  graph: DiscourseGraph,
  nodes: readonly CanonicalGraphNode[],
): WorkbenchGraphViewV1 {
  return {
    version: WORKBENCH_GRAPH_VIEW_VERSION,
    domain: 'discourse',
    hash: graph.hash,
    nodes: nodes.map((node) => projectNode(node)),
    edges: graph.edges.map((edge) => projectEdge(edge)),
    outputs: graph.outputs.map((output) => projectOutput(output)),
    reads: [],
    resolutions: [],
    boundaryReferences: (graph.boundaryReferences ?? []).map((boundary) =>
      projectBoundary(boundary),
    ),
    ellipses: [],
    sceneSequence: graph.sceneSequence.map((entry) => projectSceneSequenceEntry(entry)),
  };
}

/**
 * Deep-freeze a plain JSON-safe value in place. Only objects and arrays are
 * touched; primitives and `null` pass through untouched.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return value;
  }
  if (Object.isFrozen(value)) return value;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

/**
 * Project one canonical graph runtime for the selected route into a detached,
 * deeply frozen browser-safe DTO. Without a selector the compiler's linear
 * default route is used.
 */
export function projectCanonicalGraphRuntime(
  snapshot: ProjectSourceSnapshotV1,
  selector?: WorkbenchRouteSelectorV1,
): WorkbenchGraphProjectionV1 {
  const compiled = inspectCanonicalGraphRuntime(snapshot, toCompileOptions(selector));
  const projection: WorkbenchGraphProjectionV1 = {
    version: WORKBENCH_GRAPH_VIEW_VERSION,
    story: projectStoryView(compiled.story.graph, compiled.story.nodes),
    discourse: projectDiscourseView(compiled.discourse.graph, compiled.discourse.nodes),
    route: projectRoute(compiled.route),
  };
  return deepFreeze(projection);
}
