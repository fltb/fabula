import { cleanup, render, screen, within } from '@solidjs/testing-library';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { GraphRoute } from '../../src/client/projection-views';
import { GRAPH_PROJECTION_FIXTURE } from './helpers/graph-fixture';

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

function latestInstance(): MockLogicFlowInstance {
  const latest = mocks.latestInstance();
  if (!latest) throw new Error('No LogicFlow instance was created.');
  return latest;
}
/** The most recently registered `node:click` handler (per mounted canvas). */
function latestNodeClickHandler(): ((event: { data?: { id?: string } }) => void) | undefined {
  const registrations = latestInstance().on.mock.calls as Array<
    [string, (event: { data?: { id?: string } }) => void]
  >;
  return registrations.filter(([event]) => event === 'node:click').at(-1)?.[1];
}

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GraphRoute', () => {
  it('renders domain tabs and switches the read-only canvas between them', async () => {
    const user = userEvent.setup();
    render(() => <GraphRoute projection={GRAPH_PROJECTION_FIXTURE} />);

    expect(screen.getByRole('tab', { name: 'Story' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Discourse' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
    expect(screen.getByRole('region', { name: 'Story graph canvas' })).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Discourse' }));

    expect(screen.getByRole('tab', { name: 'Discourse' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('region', { name: 'Discourse graph canvas' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Story graph canvas' })).not.toBeInTheDocument();

    const data = latestInstance().render.mock.calls[0]?.[0];
    expect(data.nodes.map((node: { id: string }) => node.id)).toEqual(['D1', 'D2', 'D3']);
    expect(data.edges[0]).toMatchObject({ sourceNodeId: 'D1', targetNodeId: 'D2' });
  });

  it('requests the next route selector when an authored choice is picked', async () => {
    const user = userEvent.setup();
    const onRouteChange = vi.fn();
    render(() => (
      <GraphRoute projection={GRAPH_PROJECTION_FIXTURE} onRouteChange={onRouteChange} />
    ));

    expect(screen.getByRole('button', { name: 'Choose Flee the village' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Choose Flee the village' }));

    expect(onRouteChange).toHaveBeenCalledTimes(1);
    expect(onRouteChange).toHaveBeenCalledWith({
      version: 1,
      branchPath: {
        decisions: [
          { atEventId: 'E0', choiceId: 'accept_hunt', narrativeOrder: 0 },
          { atEventId: 'E3', choiceId: 'flee', narrativeOrder: 1 },
        ],
      },
    });
  });

  it('disables route switching while the Host is re-projecting', () => {
    render(() => <GraphRoute projection={GRAPH_PROJECTION_FIXTURE} fetchingRoute />);

    expect(screen.getByRole('status', { name: /reloading projection/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose Flee the village' })).toBeDisabled();
  });

  it('keeps route choices visible but inert when no refetch callback is wired', () => {
    render(() => <GraphRoute projection={GRAPH_PROJECTION_FIXTURE} />);

    expect(screen.getByRole('button', { name: 'Choose Flee the village' })).toBeDisabled();
    expect(
      screen.getByText(/Route switching is not connected in this workspace yet\./),
    ).toBeInTheDocument();
  });

  it('shows a leaf route without any choice controls', () => {
    const leafProjection = {
      ...GRAPH_PROJECTION_FIXTURE,
      route: { ...GRAPH_PROJECTION_FIXTURE.route, choices: [] },
    };
    render(() => <GraphRoute projection={leafProjection} />);

    expect(screen.getByText(/This route is a leaf/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Choose/ })).not.toBeInTheDocument();
  });

  it('surfaces canvas node selection to the callback and status region', () => {
    const onNodeSelect = vi.fn();
    render(() => <GraphRoute projection={GRAPH_PROJECTION_FIXTURE} onNodeSelect={onNodeSelect} />);

    const nodeClick = latestNodeClickHandler();
    expect(nodeClick).toBeTypeOf('function');
    nodeClick?.({ data: { id: 'S2' } });

    expect(onNodeSelect).toHaveBeenCalledWith('S2');
    expect(screen.getByRole('status', { name: /Selected node: S2/ })).toBeInTheDocument();
  });

  it('keeps the accessible structured summary as the keyboard path', () => {
    render(() => <GraphRoute projection={GRAPH_PROJECTION_FIXTURE} />);

    const summary = screen.getByText('Structured Story summary').closest('details');
    if (!(summary instanceof HTMLDetailsElement)) {
      throw new Error('Structured story summary must use a details element.');
    }
    expect(within(summary).getAllByText('S1').length).toBeGreaterThan(0);
    expect(within(summary).getAllByText('S4').length).toBeGreaterThan(0);
    expect(
      within(summary).getByText(
        (_content, element) =>
          element?.tagName === 'LI' && element.textContent?.includes('S2 → S3') === true,
      ),
    ).toBeInTheDocument();
    expect(within(summary).getAllByText('Nodes').length).toBeGreaterThan(0);
    expect(within(summary).getAllByText('Edges').length).toBeGreaterThan(0);
    expect(within(summary).queryByText('Reader order')).not.toBeInTheDocument();
  });

  it('exposes only viewport controls, never graph mutation controls', () => {
    render(() => <GraphRoute projection={GRAPH_PROJECTION_FIXTURE} />);

    expect(screen.getByRole('button', { name: 'Fit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset zoom' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /add|create|delete|edit|save|rename/i }),
    ).not.toBeInTheDocument();

    const options = mocks.LogicFlow.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(options?.isSilentMode).toBe(true);
    expect(options?.adjustNodePosition).toBe(false);
  });
});
