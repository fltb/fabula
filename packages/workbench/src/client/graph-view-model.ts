/**
 * Pure client-side adapter from the frozen canonical graph projection to
 * browser-local canvas geometry and LogicFlow data.
 *
 * This module is the single read-only translation layer for the graph canvas:
 * it never mutates its inputs, never writes back to the projection, and
 * exposes no create/delete/edit API. Canonical node ids and the
 * `predecessor → dependent` edge direction are copied verbatim; coordinates
 * are deterministic, temporary, browser-local layout values only (the Host
 * never sees them). Story and discourse views are laid out independently.
 *
 * The module has no runtime imports: every contract import is type-only, so
 * this file is safe for any bundler and for direct Node type-stripped runs.
 */

import type {
  WorkbenchGraphCoordinateV1,
  WorkbenchGraphDomainV1,
  WorkbenchGraphEdgeClassV1,
  WorkbenchGraphEdgeV1,
  WorkbenchGraphNodeOriginV1,
  WorkbenchGraphNodeV1,
  WorkbenchGraphProjectionV1,
  WorkbenchGraphViewV1,
  WorkbenchRouteChoiceV1,
  WorkbenchRouteSelectorV1,
  WorkbenchRouteViewV1,
} from '../contracts/graph.js';

/** Deterministic temporary canvas layout constants. Never persisted. */
export const GRAPH_LAYOUT = Object.freeze({
  /** Canvas node width in px (LogicFlow rect size). */
  nodeWidth: 180,
  /** Canvas node height in px (LogicFlow rect size). */
  nodeHeight: 64,
  /** Horizontal distance between dependency layers. */
  columnGap: 260,
  /** Vertical distance between nodes within one layer. */
  rowGap: 116,
  /** Left/top padding of the canvas. */
  paddingX: 48,
  paddingY: 48,
} as const);

/** One laid-out canvas node; identity and origin are the canonical ones. */
export interface GraphCanvasNodeV1 {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly coordinate: WorkbenchGraphCoordinateV1;
  readonly origin: WorkbenchGraphNodeOriginV1;
  readonly branchScope: string;
}

/** One canvas edge, direction copied verbatim from the canonical edge. */
export interface GraphCanvasEdgeV1 {
  readonly id: string;
  readonly predecessor: string;
  readonly dependent: string;
  readonly edgeClass: WorkbenchGraphEdgeClassV1;
}

/** Deterministic canvas model for exactly one domain. */
export interface GraphCanvasModelV1 {
  readonly domain: WorkbenchGraphDomainV1;
  readonly hash: string;
  readonly nodes: readonly GraphCanvasNodeV1[];
  readonly edges: readonly GraphCanvasEdgeV1[];
}

/** LogicFlow node payload; ids and direction mirror the canonical graph. */
export interface LogicFlowNodeDataV1 {
  readonly id: string;
  readonly type: 'rect';
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly text: string;
  readonly properties: Readonly<{
    readonly coordinate: WorkbenchGraphCoordinateV1;
    readonly origin: WorkbenchGraphNodeOriginV1;
    readonly branchScope: string;
  }>;
}

/** LogicFlow edge payload; `source` is the predecessor, `target` the dependent. */
export interface LogicFlowEdgeDataV1 {
  readonly id: string;
  readonly type: 'bezier';
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly properties: Readonly<{ readonly edgeClass: WorkbenchGraphEdgeClassV1 }>;
}

/** LogicFlow `render()` input for one domain. */
export interface LogicFlowGraphDataV1 {
  readonly nodes: readonly LogicFlowNodeDataV1[];
  readonly edges: readonly LogicFlowEdgeDataV1[];
}

/** Deep-freeze a plain JSON-safe value; already-frozen values pass through. */
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
 * Longest-path dependency layers: a dependent sits strictly right of every
 * predecessor it depends on. Deterministic: sources are visited in sorted id
 * order, dependents in sorted id order, and nodes that cannot be reached
 * (cycles, dangling edges) stay at layer 0.
 */
function computeDependencyLayers(
  nodes: readonly WorkbenchGraphNodeV1[],
  edges: readonly WorkbenchGraphEdgeV1[],
): ReadonlyMap<string, number> {
  const layer = new Map<string, number>();
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const node of nodes) {
    layer.set(node.id, 0);
    indegree.set(node.id, 0);
  }
  for (const edge of edges) {
    if (!layer.has(edge.predecessor) || !layer.has(edge.dependent)) continue;
    const list = dependents.get(edge.predecessor);
    if (list) list.push(edge.dependent);
    else dependents.set(edge.predecessor, [edge.dependent]);
    indegree.set(edge.dependent, (indegree.get(edge.dependent) ?? 0) + 1);
  }
  for (const list of dependents.values()) list.sort();
  const queue = nodes
    .filter((node) => (indegree.get(node.id) ?? 0) === 0)
    .map((node) => node.id)
    .sort();
  let head = 0;
  while (head < queue.length) {
    const id = queue[head++];
    const current = layer.get(id) ?? 0;
    for (const dependent of dependents.get(id) ?? []) {
      layer.set(dependent, Math.max(layer.get(dependent) ?? 0, current + 1));
      const remaining = (indegree.get(dependent) ?? 1) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) queue.push(dependent);
    }
  }
  return layer;
}

/**
 * Deterministic in-layer ordering key: canonical coordinates first (reader
 * position for discourse, story-clock scalar for story points), `initial`
 * before everything, `unlocated` last, ids as the final tie-break.
 */
function coordinateOrder(node: WorkbenchGraphNodeV1): number {
  const coordinate = node.coordinate;
  if (coordinate.type === 'discoursePosition') return coordinate.value;
  if (coordinate.kind === 'point') return coordinate.scalar;
  if (coordinate.kind === 'initial') return Number.NEGATIVE_INFINITY;
  return Number.POSITIVE_INFINITY;
}

export function layoutGraphView(view: WorkbenchGraphViewV1): GraphCanvasModelV1 {
  const layers = computeDependencyLayers(view.nodes, view.edges);
  const nodeById = new Map(view.nodes.map((node) => [node.id, node]));
  const byLayer = new Map<number, string[]>();
  for (const node of view.nodes) {
    const key = layers.get(node.id) ?? 0;
    const bucket = byLayer.get(key);
    if (bucket) bucket.push(node.id);
    else byLayer.set(key, [node.id]);
  }
  const layerKeys = [...byLayer.keys()].sort((a, b) => a - b);
  const rowByNode = new Map<string, number>();
  for (const layerKey of layerKeys) {
    const ids = byLayer.get(layerKey) ?? [];
    const sorted = [...ids].sort((a, b) => {
      const nodeA = nodeById.get(a);
      const nodeB = nodeById.get(b);
      const orderA = nodeA ? coordinateOrder(nodeA) : Number.POSITIVE_INFINITY;
      const orderB = nodeB ? coordinateOrder(nodeB) : Number.POSITIVE_INFINITY;
      return orderA !== orderB ? orderA - orderB : a.localeCompare(b);
    });
    for (const [row, id] of sorted.entries()) rowByNode.set(id, row);
  }
  const nodes = view.nodes.map((node) => {
    const layer = layers.get(node.id) ?? 0;
    const row = rowByNode.get(node.id) ?? 0;
    return {
      id: node.id,
      x: GRAPH_LAYOUT.paddingX + layer * GRAPH_LAYOUT.columnGap,
      y: GRAPH_LAYOUT.paddingY + row * GRAPH_LAYOUT.rowGap,
      width: GRAPH_LAYOUT.nodeWidth,
      height: GRAPH_LAYOUT.nodeHeight,
      coordinate: node.coordinate,
      origin: node.origin,
      branchScope: node.branchScope,
    };
  });
  const edges = view.edges.map((edge, index) => ({
    id: `edge:${edge.predecessor}->${edge.dependent}:${edge.edgeClass}:${index}`,
    predecessor: edge.predecessor,
    dependent: edge.dependent,
    edgeClass: edge.edgeClass,
  }));
  return deepFreeze({ domain: view.domain, hash: view.hash, nodes, edges });
}

/** Lay both canonical domains out independently. */
export function layoutProjection(projection: WorkbenchGraphProjectionV1): Readonly<{
  readonly story: GraphCanvasModelV1;
  readonly discourse: GraphCanvasModelV1;
}> {
  return deepFreeze({
    story: layoutGraphView(projection.story),
    discourse: layoutGraphView(projection.discourse),
  });
}

/**
 * Translate a canvas model into LogicFlow `render()` data. Node ids are the
 * canonical ids; every edge keeps `predecessor → dependent` as
 * `sourceNodeId → targetNodeId`. No labels or properties are invented beyond
 * the canonical values.
 */
export function toLogicFlowData(model: GraphCanvasModelV1): LogicFlowGraphDataV1 {
  const nodes = model.nodes.map((node) => ({
    id: node.id,
    type: 'rect' as const,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    text: node.id,
    properties: {
      coordinate: node.coordinate,
      origin: node.origin,
      branchScope: node.branchScope,
    },
  }));
  const edges = model.edges.map((edge) => ({
    id: edge.id,
    type: 'bezier' as const,
    sourceNodeId: edge.predecessor,
    targetNodeId: edge.dependent,
    properties: { edgeClass: edge.edgeClass },
  }));
  return deepFreeze({ nodes, edges });
}

/** Short human label for a canonical coordinate; never invents data. */
export function describeCoordinate(coordinate: WorkbenchGraphCoordinateV1): string {
  if (coordinate.type === 'discoursePosition') {
    return `discourse position ${coordinate.value}`;
  }
  if (coordinate.kind === 'initial') return 'story initial';
  if (coordinate.kind === 'unlocated') return 'story unlocated';
  const clock = coordinate.clock === 'story' ? 'time' : coordinate.clock;
  return `story ${clock} ${coordinate.scalar}`;
}

/** Short human label for a canonical node origin; never invents data. */
export function describeOrigin(origin: WorkbenchGraphNodeOriginV1): string {
  if (origin.type === 'initial') return 'initial';
  if (origin.type === 'event') return `event ${origin.eventId} (${origin.source})`;
  return `discourse ${origin.entryId} · scene ${origin.sceneId} (${origin.branch})`;
}

/** Selector that requests the Host's linear default route. */
export function emptyRouteSelector(route: WorkbenchRouteViewV1): WorkbenchRouteSelectorV1 {
  return { version: route.version, branchPath: { decisions: [] } };
}

/**
 * Selector that re-requests the canonical projection with one authored choice
 * appended to the current branch path. Choosing the same decision twice is a
 * no-op; the version always comes from the canonical route view.
 */
export function nextRouteSelector(
  route: WorkbenchRouteViewV1,
  choice: WorkbenchRouteChoiceV1,
): WorkbenchRouteSelectorV1 {
  const decisions = route.branchPath.decisions;
  const alreadyChosen = decisions.some(
    (decision) => decision.atEventId === choice.eventId && decision.choiceId === choice.choiceId,
  );
  return {
    version: route.version,
    branchPath: {
      decisions: alreadyChosen
        ? [...decisions]
        : [
            ...decisions,
            {
              atEventId: choice.eventId,
              choiceId: choice.choiceId,
              narrativeOrder: choice.narrativeOrder,
            },
          ],
    },
  };
}

/** A route without exposed choices cannot advance further. */
export function isRouteLeaf(route: WorkbenchRouteViewV1): boolean {
  return route.choices.length === 0;
}
