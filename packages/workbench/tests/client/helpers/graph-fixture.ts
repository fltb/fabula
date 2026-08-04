/**
 * Shared frozen canonical graph fixture for client graph tests. Mirrors the
 * Host projection contract: every value is JSON-plain and deeply frozen,
 * exactly like `projectCanonicalGraphRuntime` output.
 */

import { type GraphCanvasModelV1, layoutGraphView } from '../../../src/client/graph-view-model';
import { WORKBENCH_GRAPH_VIEW_VERSION } from '../../../src/contracts/graph.js';
import type {
  WorkbenchGraphProjectionV1,
  WorkbenchGraphViewV1,
  WorkbenchRouteViewV1,
} from '../../../src/contracts/index.js';

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

export const STORY_VIEW_FIXTURE: WorkbenchGraphViewV1 = {
  version: WORKBENCH_GRAPH_VIEW_VERSION,
  domain: 'story',
  hash: 'story-hash',
  nodes: [
    {
      id: 'S1',
      coordinate: { type: 'storyTime', kind: 'initial' },
      branchScope: 'scope-1',
      origin: { type: 'initial' },
    },
    {
      id: 'S2',
      coordinate: { type: 'storyTime', kind: 'point', clock: 'story', scalar: 10 },
      branchScope: 'scope-1',
      origin: { type: 'event', eventId: 'E2', source: 'event_file' },
    },
    {
      id: 'S3',
      coordinate: { type: 'storyTime', kind: 'point', clock: 'story', scalar: 20 },
      branchScope: 'scope-1',
      origin: { type: 'event', eventId: 'E3', source: 'event_file' },
    },
    {
      id: 'S4',
      coordinate: { type: 'storyTime', kind: 'unlocated' },
      branchScope: 'scope-1',
      origin: { type: 'event', eventId: 'E4', source: 'system' },
    },
  ],
  edges: [
    { predecessor: 'S1', dependent: 'S2', edgeClass: 'author_origin' },
    { predecessor: 'S2', dependent: 'S3', edgeClass: 'provider' },
    { predecessor: 'S2', dependent: 'S4', edgeClass: 'same_coordinate_order' },
  ],
  outputs: [],
  reads: [],
  resolutions: [],
  boundaryReferences: [],
  ellipses: [],
  sceneSequence: [],
};

export const DISCOURSE_VIEW_FIXTURE: WorkbenchGraphViewV1 = {
  version: WORKBENCH_GRAPH_VIEW_VERSION,
  domain: 'discourse',
  hash: 'discourse-hash',
  nodes: [
    {
      id: 'D1',
      coordinate: { type: 'discoursePosition', value: 0 },
      branchScope: 'scope-1',
      origin: { type: 'discourse', entryId: 'd1', sceneId: 's1', branch: 'main' },
    },
    {
      id: 'D2',
      coordinate: { type: 'discoursePosition', value: 1 },
      branchScope: 'scope-1',
      origin: { type: 'discourse', entryId: 'd2', sceneId: 's1', branch: 'main' },
    },
    {
      id: 'D3',
      coordinate: { type: 'discoursePosition', value: 2 },
      branchScope: 'scope-1',
      origin: { type: 'discourse', entryId: 'd3', sceneId: 's2', branch: 'main' },
    },
  ],
  edges: [
    { predecessor: 'D1', dependent: 'D2', edgeClass: 'internal' },
    { predecessor: 'D2', dependent: 'D3', edgeClass: 'internal' },
  ],
  outputs: [],
  reads: [],
  resolutions: [],
  boundaryReferences: [
    {
      type: 'boundary',
      snapshotHash: 'boundary-hash',
      sourceGraph: 'story',
      targetGraph: 'discourse',
      pinnedOutputs: ['o1'],
    },
  ],
  ellipses: [],
  sceneSequence: [
    { sceneId: 's1', sequence: 1, chapter: 1 },
    { sceneId: 's2', sequence: 2, chapter: 1 },
  ],
};

export const ROUTE_VIEW_FIXTURE: WorkbenchRouteViewV1 = {
  version: WORKBENCH_GRAPH_VIEW_VERSION,
  branchPath: {
    decisions: [{ atEventId: 'E0', choiceId: 'accept_hunt', narrativeOrder: 0 }],
  },
  branchScope: 'scope-1',
  discourseBranch: 'accept_hunt',
  selectedEventIds: ['E1', 'E2', 'E3'],
  leafPaths: [],
  eventScopes: [],
  choices: [
    {
      eventId: 'E3',
      choiceId: 'flee',
      label: 'Flee the village',
      description: 'Leave before the crowd gathers.',
      targetEventId: 'E4',
      narrativeOrder: 1,
    },
  ],
};

/** Deeply frozen canonical projection, matching the Host wire shape. */
export const GRAPH_PROJECTION_FIXTURE: WorkbenchGraphProjectionV1 = deepFreeze({
  version: WORKBENCH_GRAPH_VIEW_VERSION,
  story: STORY_VIEW_FIXTURE,
  discourse: DISCOURSE_VIEW_FIXTURE,
  route: ROUTE_VIEW_FIXTURE,
});

export function storyGraphModel(): GraphCanvasModelV1 {
  return layoutGraphView(GRAPH_PROJECTION_FIXTURE.story);
}

export function discourseGraphModel(): GraphCanvasModelV1 {
  return layoutGraphView(GRAPH_PROJECTION_FIXTURE.discourse);
}
