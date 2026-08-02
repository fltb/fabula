import { describe, expect, it } from 'vitest';
import { WORKBENCH_GRAPH_VIEW_VERSION } from '../../src/contracts/graph.js';
import type {
  WorkbenchGraphEdgeV1,
  WorkbenchRouteViewV1,
} from '../../src/contracts/index.js';
import {
  GRAPH_LAYOUT,
  describeCoordinate,
  describeOrigin,
  emptyRouteSelector,
  isRouteLeaf,
  layoutGraphView,
  layoutProjection,
  nextRouteSelector,
  toLogicFlowData,
} from '../../src/client/graph-view-model';
import {
  DISCOURSE_VIEW_FIXTURE,
  GRAPH_PROJECTION_FIXTURE,
  STORY_VIEW_FIXTURE,
} from './helpers/graph-fixture';

describe('layoutGraphView', () => {
  it('preserves canonical node ids and their order', () => {
    const model = layoutGraphView(GRAPH_PROJECTION_FIXTURE.story);
    expect(model.nodes.map((node) => node.id)).toEqual(
      GRAPH_PROJECTION_FIXTURE.story.nodes.map((node) => node.id),
    );
    expect(model.hash).toBe('story-hash');
  });

  it('preserves the predecessor → dependent direction on every edge', () => {
    const model = layoutGraphView(GRAPH_PROJECTION_FIXTURE.story);
    expect(model.edges).toHaveLength(GRAPH_PROJECTION_FIXTURE.story.edges.length);
    for (const edge of model.edges) {
      const canonical = GRAPH_PROJECTION_FIXTURE.story.edges.find(
        (candidate) =>
          candidate.predecessor === edge.predecessor && candidate.dependent === edge.dependent,
      );
      expect(canonical).toBeDefined();
      expect(edge.edgeClass).toBe(canonical?.edgeClass);
    }
    const data = toLogicFlowData(model);
    for (const edge of data.edges) {
      expect(
        GRAPH_PROJECTION_FIXTURE.story.edges.some(
          (candidate) =>
            candidate.predecessor === edge.sourceNodeId && candidate.dependent === edge.targetNodeId,
        ),
      ).toBe(true);
    }
    expect(data.edges[0]?.sourceNodeId).toBe('S1');
    expect(data.edges[0]?.targetNodeId).toBe('S2');
  });

  it('keeps story and discourse domains completely separate', () => {
    const story = layoutGraphView(GRAPH_PROJECTION_FIXTURE.story);
    const discourse = layoutGraphView(GRAPH_PROJECTION_FIXTURE.discourse);
    expect(story.domain).toBe('story');
    expect(discourse.domain).toBe('discourse');
    const storyIds = new Set(story.nodes.map((node) => node.id));
    const discourseIds = new Set(discourse.nodes.map((node) => node.id));
    for (const id of storyIds) expect(discourseIds.has(id)).toBe(false);
    for (const edge of story.edges) {
      expect(storyIds.has(edge.predecessor)).toBe(true);
      expect(storyIds.has(edge.dependent)).toBe(true);
    }
    for (const edge of discourse.edges) {
      expect(discourseIds.has(edge.predecessor)).toBe(true);
      expect(discourseIds.has(edge.dependent)).toBe(true);
    }
    const both = layoutProjection(GRAPH_PROJECTION_FIXTURE);
    expect(both.story).toEqual(story);
    expect(both.discourse).toEqual(discourse);
  });

  it('produces deterministic, dependency-consistent coordinates', () => {
    const first = layoutGraphView(GRAPH_PROJECTION_FIXTURE.story);
    const second = layoutGraphView(GRAPH_PROJECTION_FIXTURE.story);
    expect(second).toEqual(first);
    const byId = new Map(first.nodes.map((node) => [node.id, node]));
    for (const edge of first.edges) {
      const predecessor = byId.get(edge.predecessor);
      const dependent = byId.get(edge.dependent);
      expect(predecessor?.x ?? Number.POSITIVE_INFINITY).toBeLessThan(
        dependent?.x ?? Number.NEGATIVE_INFINITY,
      );
    }
    for (const node of first.nodes) {
      expect((node.x - GRAPH_LAYOUT.paddingX) % GRAPH_LAYOUT.columnGap).toBe(0);
      expect((node.y - GRAPH_LAYOUT.paddingY) % GRAPH_LAYOUT.rowGap).toBe(0);
    }
  });

  it('does not mutate its frozen input and returns frozen models', () => {
    const before = JSON.stringify(GRAPH_PROJECTION_FIXTURE);
    const model = layoutGraphView(GRAPH_PROJECTION_FIXTURE.story);
    expect(JSON.stringify(GRAPH_PROJECTION_FIXTURE)).toBe(before);
    expect(Object.isFrozen(model)).toBe(true);
    expect(Object.isFrozen(model.nodes)).toBe(true);
    expect(Object.isFrozen(model.nodes[0])).toBe(true);
    expect(Object.isFrozen(model.edges)).toBe(true);
    expect(Object.isFrozen(model.edges[0])).toBe(true);
  });

  it('exposes no write surface: frozen values reject every mutation', () => {
    const model = layoutGraphView(GRAPH_PROJECTION_FIXTURE.story);
    // Deliberate write attempts: the casts exist only so the compiler permits
    // performing (and observing) the mutation failure on frozen output.
    const writableNode = model.nodes[0] as unknown as { x: number };
    expect(() => {
      writableNode.x = 9999;
    }).toThrow(TypeError);
    const writableEdges = model.edges as unknown as WorkbenchGraphEdgeV1[];
    expect(() => {
      writableEdges.push({ predecessor: 'S9', dependent: 'S8', edgeClass: 'internal' });
    }).toThrow(TypeError);
    const data = toLogicFlowData(model);
    const writableDataNodes = data.nodes as unknown as { id: string }[];
    expect(() => {
      writableDataNodes.pop();
    }).toThrow(TypeError);
  });
});

describe('route selectors', () => {
  it('builds the next refetch selector with the chosen decision appended', () => {
    const choice = GRAPH_PROJECTION_FIXTURE.route.choices[0];
    const selector = nextRouteSelector(GRAPH_PROJECTION_FIXTURE.route, choice);
    expect(selector.version).toBe(WORKBENCH_GRAPH_VIEW_VERSION);
    expect(selector.branchPath.decisions).toEqual([
      { atEventId: 'E0', choiceId: 'accept_hunt', narrativeOrder: 0 },
      { atEventId: 'E3', choiceId: 'flee', narrativeOrder: 1 },
    ]);
  });

  it('treats choosing an existing branch decision as a no-op', () => {
    const selector = nextRouteSelector(GRAPH_PROJECTION_FIXTURE.route, {
      eventId: 'E0',
      choiceId: 'accept_hunt',
      label: 'Accept the hunt',
      description: 'Already selected in the canonical route.',
      targetEventId: 'E1',
      narrativeOrder: 0,
    });
    expect(selector.branchPath.decisions).toHaveLength(1);
    expect(selector).toEqual({
      version: WORKBENCH_GRAPH_VIEW_VERSION,
      branchPath: { decisions: [{ atEventId: 'E0', choiceId: 'accept_hunt', narrativeOrder: 0 }] },
    });
  });

  it('builds the empty (linear default) selector from the route version', () => {
    expect(emptyRouteSelector(GRAPH_PROJECTION_FIXTURE.route)).toEqual({
      version: WORKBENCH_GRAPH_VIEW_VERSION,
      branchPath: { decisions: [] },
    });
  });

  it('detects leaf routes that expose no further choices', () => {
    expect(isRouteLeaf(GRAPH_PROJECTION_FIXTURE.route)).toBe(false);
    const leaf: WorkbenchRouteViewV1 = { ...GRAPH_PROJECTION_FIXTURE.route, choices: [] };
    expect(isRouteLeaf(leaf)).toBe(true);
  });
});

describe('summary labels', () => {
  it('labels coordinates and origins without inventing data', () => {
    const story = STORY_VIEW_FIXTURE;
    const discourse = DISCOURSE_VIEW_FIXTURE;
    expect(describeCoordinate(story.nodes[0].coordinate)).toBe('story initial');
    expect(describeCoordinate(story.nodes[1].coordinate)).toBe('story time 10');
    expect(describeCoordinate(story.nodes[2].coordinate)).toBe('story time 20');
    expect(describeCoordinate(story.nodes[3].coordinate)).toBe('story unlocated');
    expect(describeCoordinate(discourse.nodes[0].coordinate)).toBe('discourse position 0');
    expect(describeOrigin(story.nodes[0].origin)).toBe('initial');
    expect(describeOrigin(story.nodes[1].origin)).toBe('event E2 (event_file)');
    expect(describeOrigin(discourse.nodes[0].origin)).toBe('discourse d1 · scene s1 (main)');
  });
});
