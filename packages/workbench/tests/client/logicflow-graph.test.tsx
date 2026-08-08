import { cleanup, render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { GraphCanvasModelV1 } from '../../src/client/graph-view-model';
import { discourseGraphModel, storyGraphModel } from './helpers/graph-fixture';

interface MockLogicFlowInstance {
  readonly render: Mock;
  readonly on: Mock;
  readonly off: Mock;
  readonly fitView: Mock;
  readonly zoom: Mock;
  readonly resetZoom: Mock;
  readonly extension: {
    readonly miniMap: {
      readonly show: Mock;
      readonly hide: Mock;
    };
  };
}
const mocks = vi.hoisted(() => {
  const instances: MockLogicFlowInstance[] = [];
  // biome-ignore lint/complexity/useArrowFunction: vitest4 cannot `new` an arrow fn
  const createInstance = function (_options: unknown): MockLogicFlowInstance {
    const instance: MockLogicFlowInstance = {
      render: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      fitView: vi.fn(),
      zoom: vi.fn(),
      resetZoom: vi.fn(),
      extension: { miniMap: { show: vi.fn(), hide: vi.fn() } },
    };
    instances.push(instance);
    return instance;
  };
  const LogicFlow = Object.assign(vi.fn(createInstance), { use: vi.fn() });
  return { LogicFlow, latestInstance: () => instances.at(-1) };
});

vi.mock('@logicflow/core', () => ({ default: mocks.LogicFlow }));
vi.mock('@logicflow/extension', () => ({ MiniMap: vi.fn() }));

import { LogicFlowGraph } from '../../src/client/logicflow-graph';

function latestInstance(): MockLogicFlowInstance {
  const latest = mocks.latestInstance();
  if (!latest) throw new Error('No LogicFlow instance was created.');
  return latest;
}

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('LogicFlowGraph', () => {
  it('creates a silent read-only canvas and renders the frozen model', () => {
    const model = storyGraphModel();
    render(() => <LogicFlowGraph model={model} label="Story graph canvas" />);

    expect(mocks.LogicFlow).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('region', { name: 'Story graph canvas' })).toBeInTheDocument();

    // The mock boundary erased the option shape; narrow it for the read-only
    // configuration assertions below.
    const options = mocks.LogicFlow.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(options?.isSilentMode).toBe(true);
    expect(options?.adjustNodePosition).toBe(false);
    expect(options?.adjustEdge).toBe(false);
    expect(options?.adjustEdgeStartAndEnd).toBe(false);
    expect(options?.allowRotation).toBe(false);
    expect(options?.textEdit).toBe(false);
    expect(options?.nodeTextEdit).toBe(false);
    expect(options?.edgeTextEdit).toBe(false);
    expect(options?.keyboard).toEqual({ enabled: false });
    const guards = (options?.guards ?? {}) as {
      beforeDelete?: () => boolean;
      beforeClone?: () => boolean;
    };
    expect(guards.beforeDelete?.()).toBe(false);
    expect(guards.beforeClone?.()).toBe(false);
    expect(options?.container).toBeInstanceOf(HTMLElement);

    const instance = latestInstance();
    const data = instance.render.mock.calls[0]?.[0];
    expect(data.nodes.map((node: { id: string }) => node.id)).toEqual(['S1', 'S2', 'S3', 'S4']);
    expect(data.nodes[0].text).toBe('S1');
    expect(data.edges[0]).toMatchObject({ sourceNodeId: 'S1', targetNodeId: 'S2' });
    expect(instance.fitView).toHaveBeenCalled();
    expect(instance.extension.miniMap.show).toHaveBeenCalled();
  });

  it('surfaces canonical node ids through node selection', () => {
    const onNodeSelect = vi.fn();
    render(() => (
      <LogicFlowGraph
        model={storyGraphModel()}
        label="Story graph canvas"
        onNodeSelect={onNodeSelect}
      />
    ));

    const instance = latestInstance();
    const registrations = instance.on.mock.calls as Array<
      [string, (event: { data?: { id?: string } }) => void]
    >;
    const nodeClick = registrations.find(([event]) => event === 'node:click')?.[1];
    expect(nodeClick).toBeTypeOf('function');
    nodeClick?.({ data: { id: 'S2' } });
    expect(onNodeSelect).toHaveBeenCalledWith('S2');
    nodeClick?.({ data: { id: '' } });
    nodeClick?.({ data: {} });
    expect(onNodeSelect).toHaveBeenCalledTimes(1);
  });

  it('exposes viewport controls and releases them on unmount', () => {
    const onControls = vi.fn();
    const { unmount } = render(() => (
      <LogicFlowGraph
        model={storyGraphModel()}
        label="Story graph canvas"
        onControls={onControls}
      />
    ));

    const handle = onControls.mock.calls[0]?.[0];
    expect(handle).not.toBeNull();
    const instance = latestInstance();
    handle.fitView();
    handle.zoomIn();
    handle.zoomOut();
    handle.resetZoom();
    expect(instance.fitView).toHaveBeenCalled();
    expect(instance.zoom).toHaveBeenNthCalledWith(1, 2);
    expect(instance.zoom).toHaveBeenNthCalledWith(2, 0.5);
    expect(instance.resetZoom).toHaveBeenCalled();

    unmount();
    expect(onControls).toHaveBeenLastCalledWith(null);
    expect(instance.off).toHaveBeenCalledWith('node:click', expect.any(Function));
    expect(instance.off).toHaveBeenCalledWith('graph:rendered', expect.any(Function));
  });

  it('re-renders the canvas when the frozen model changes', () => {
    const storyModel = storyGraphModel();
    const discourseModel: GraphCanvasModelV1 = discourseGraphModel();
    const [model, setModel] = createSignal<GraphCanvasModelV1>(storyModel);
    render(() => <LogicFlowGraph model={model()} label="Graph canvas" />);
    setModel(discourseModel);

    const instance = latestInstance();
    expect(instance.render).toHaveBeenCalledTimes(2);
    const secondData = instance.render.mock.calls[1]?.[0];
    expect(secondData.nodes.map((node: { id: string }) => node.id)).toEqual(['D1', 'D2', 'D3']);
    expect(secondData.edges[0]).toMatchObject({ sourceNodeId: 'D1', targetNodeId: 'D2' });
  });
});
