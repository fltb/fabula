import { Tabs } from '@kobalte/core/tabs';
import { createMemo, createSignal, For, Show } from 'solid-js';
import type {
  BrowserProjectOverviewV1,
  WorkbenchGraphDomainV1,
  WorkbenchGraphProjectionV1,
  WorkbenchGraphViewV1,
  WorkbenchRouteChoiceV1,
  WorkbenchRouteSelectorV1,
} from '../contracts/index.js';
import {
  describeCoordinate,
  describeOrigin,
  emptyRouteSelector,
  type GraphCanvasModelV1,
  isRouteLeaf,
  layoutGraphView,
  nextRouteSelector,
} from './graph-view-model';
import { LogicFlowGraph, type LogicFlowGraphControls } from './logicflow-graph';
import { TABS_CONTENT, TABS_LIST, TABS_ROOT, TABS_TRIGGER } from './ui/controls';
import { KICKER, ScreenEmpty, ScreenNote, TEXT_BUTTON } from './ui/primitives';

export interface ProjectHomeProps {
  readonly overview: BrowserProjectOverviewV1 | null;
}

/** A Host-projected project summary; never invents a project or operation. */
export function ProjectHome(props: ProjectHomeProps) {
  return (
    <Show
      when={props.overview}
      fallback={
        <ScreenEmpty
          title="No project projection"
          body="Open an authenticated project in the Host to load its accepted projection."
        />
      }
    >
      {(overview) => {
        const projection = () => overview().projection;
        return (
          <section aria-labelledby="project-home-heading">
            <header>
              <p class={KICKER}>Accepted project</p>
              <h2 id="project-home-heading">{overview().metadata.displayName}</h2>
              <p>{overview().projectId}</p>
            </header>
            <Show
              when={projection()}
              fallback={
                <ScreenNote>
                  The Host has no accepted source projection for this open project yet.
                </ScreenNote>
              }
            >
              {(accepted) => (
                <dl class="my-4 grid grid-cols-[repeat(auto-fit,minmax(7rem,1fr))] gap-3">
                  <div class="grid gap-1 rounded-[0.375rem] bg-surface-muted p-3">
                    <dt class="text-[0.625rem] font-extrabold uppercase tracking-[0.1em] text-muted">
                      Documents
                    </dt>
                    <dd class="m-0 text-lg font-[750]">{accepted().documents}</dd>
                  </div>
                  <div class="grid gap-1 rounded-[0.375rem] bg-surface-muted p-3">
                    <dt class="text-[0.625rem] font-extrabold uppercase tracking-[0.1em] text-muted">
                      Scenes
                    </dt>
                    <dd class="m-0 text-lg font-[750]">{accepted().events}</dd>
                  </div>
                  <div class="grid gap-1 rounded-[0.375rem] bg-surface-muted p-3">
                    <dt class="text-[0.625rem] font-extrabold uppercase tracking-[0.1em] text-muted">
                      Rendered
                    </dt>
                    <dd class="m-0 text-lg font-[750]">{accepted().rendered}</dd>
                  </div>
                  <div class="grid gap-1 rounded-[0.375rem] bg-surface-muted p-3">
                    <dt class="text-[0.625rem] font-extrabold uppercase tracking-[0.1em] text-muted">
                      Blocked
                    </dt>
                    <dd class="m-0 text-lg font-[750]">{accepted().blocked}</dd>
                  </div>
                  <div class="grid gap-1 rounded-[0.375rem] bg-surface-muted p-3">
                    <dt class="text-[0.625rem] font-extrabold uppercase tracking-[0.1em] text-muted">
                      Warnings
                    </dt>
                    <dd class="m-0 text-lg font-[750]">{accepted().warningCount}</dd>
                  </div>
                  <div class="grid gap-1 rounded-[0.375rem] bg-surface-muted p-3">
                    <dt class="text-[0.625rem] font-extrabold uppercase tracking-[0.1em] text-muted">
                      Errors
                    </dt>
                    <dd class="m-0 text-lg font-[750]">{accepted().errorCount}</dd>
                  </div>
                </dl>
              )}
            </Show>
            <ScreenNote>
              {overview().activity.busy
                ? 'The Host has an active operation.'
                : 'No Host operation is active.'}{' '}
              {overview().activity.hasHumanPresence
                ? 'Human collaboration is present.'
                : 'No human collaboration is present.'}
            </ScreenNote>
          </section>
        );
      }}
    </Show>
  );
}

export interface GraphRouteProps {
  readonly projection: WorkbenchGraphProjectionV1 | null;
  /** Re-requests the canonical projection for a new branch path. */
  readonly onRouteChange?: (selector: WorkbenchRouteSelectorV1) => void;
  /** Surfaces a canvas node selection for inspector/source navigation. */
  readonly onNodeSelect?: (nodeId: string) => void;
  /** The Host is re-projecting; route controls are disabled while true. */
  readonly fetchingRoute?: boolean;
}

function domainLabel(domain: WorkbenchGraphDomainV1): string {
  return domain === 'story' ? 'Story' : 'Discourse';
}

interface GraphDomainPanelProps {
  readonly domain: WorkbenchGraphDomainV1;
  readonly view: WorkbenchGraphViewV1;
  readonly model: GraphCanvasModelV1 | null;
  readonly controls: LogicFlowGraphControls | null;
  readonly selectedNode: string | null;
  readonly onNodeSelect: (nodeId: string) => void;
  readonly onControls: (controls: LogicFlowGraphControls | null) => void;
}

/** One domain's read-only canvas, viewport toolbar, status, and summary. */
function GraphDomainPanel(props: GraphDomainPanelProps) {
  const label = () => domainLabel(props.domain);
  return (
    <div class="grid gap-3">
      <div
        class="flex flex-wrap items-center justify-between gap-3"
        role="toolbar"
        aria-label={`${label()} graph viewport`}
      >
        <span class="text-[0.625rem] font-extrabold uppercase tracking-[0.1em] text-muted">
          {label()} · {props.view.nodes.length} nodes · {props.view.edges.length} edges
        </span>
        <span class="inline-flex gap-2">
          <button
            type="button"
            class={TEXT_BUTTON}
            disabled={!props.controls}
            onClick={() => props.controls?.fitView()}
          >
            Fit
          </button>
          <button
            type="button"
            class={TEXT_BUTTON}
            disabled={!props.controls}
            onClick={() => props.controls?.zoomIn()}
          >
            Zoom in
          </button>
          <button
            type="button"
            class={TEXT_BUTTON}
            disabled={!props.controls}
            onClick={() => props.controls?.zoomOut()}
          >
            Zoom out
          </button>
          <button
            type="button"
            class={TEXT_BUTTON}
            disabled={!props.controls}
            onClick={() => props.controls?.resetZoom()}
          >
            Reset zoom
          </button>
        </span>
      </div>
      <Show when={props.model} fallback={<ScreenNote>No {label()} layout.</ScreenNote>}>
        {(model) => (
          <div class="relative h-[34rem] overflow-hidden rounded-[0.625rem] border border-line bg-surface max-[40rem]:h-[22rem]">
            <LogicFlowGraph
              model={model()}
              label={`${label()} graph canvas`}
              onNodeSelect={props.onNodeSelect}
              onControls={props.onControls}
            />
          </div>
        )}
      </Show>
      <p
        class="m-0 text-[0.8125rem] text-muted"
        role="status"
        aria-live="polite"
        aria-label={
          props.selectedNode ? `Selected node: ${props.selectedNode}` : 'No node selected'
        }
      >
        {props.selectedNode
          ? `Selected node: ${props.selectedNode}`
          : 'No node selected. Use the structured summary below for keyboard access.'}
      </p>
      <details class="rounded-[0.625rem] border border-line bg-surface p-4">
        <summary class="cursor-pointer text-[0.8125rem] font-extrabold">
          Structured {label()} summary
        </summary>
        <dl class="mt-3 mb-4 grid grid-cols-[repeat(auto-fit,minmax(7rem,1fr))] gap-3">
          <div class="grid gap-1 rounded-[0.375rem] bg-surface-muted p-3">
            <dt class="text-[0.625rem] font-extrabold uppercase tracking-[0.1em] text-muted">
              Nodes
            </dt>
            <dd class="m-0 text-lg font-[750]">{props.view.nodes.length}</dd>
          </div>
          <div class="grid gap-1 rounded-[0.375rem] bg-surface-muted p-3">
            <dt class="text-[0.625rem] font-extrabold uppercase tracking-[0.1em] text-muted">
              Edges
            </dt>
            <dd class="m-0 text-lg font-[750]">{props.view.edges.length}</dd>
          </div>
          <div class="grid gap-1 rounded-[0.375rem] bg-surface-muted p-3">
            <dt class="text-[0.625rem] font-extrabold uppercase tracking-[0.1em] text-muted">
              Outputs
            </dt>
            <dd class="m-0 text-lg font-[750]">{props.view.outputs.length}</dd>
          </div>
          <div class="grid gap-1 rounded-[0.375rem] bg-surface-muted p-3">
            <dt class="text-[0.625rem] font-extrabold uppercase tracking-[0.1em] text-muted">
              Reads
            </dt>
            <dd class="m-0 text-lg font-[750]">{props.view.reads.length}</dd>
          </div>
        </dl>
        <h4 class="mt-4 mb-2 text-[0.625rem] font-extrabold uppercase tracking-[0.1em] text-muted">
          Nodes
        </h4>
        <ul class="m-0 pl-5">
          <For each={props.view.nodes}>
            {(node) => (
              <li class="my-1 text-[0.8125rem] leading-[1.5] text-ink-soft">
                <code class="text-xs">{node.id}</code>
                <span class="ml-2 text-muted">{describeCoordinate(node.coordinate)}</span>
                <span class="ml-2 text-muted">{describeOrigin(node.origin)}</span>
              </li>
            )}
          </For>
        </ul>
        <h4 class="mt-4 mb-2 text-[0.625rem] font-extrabold uppercase tracking-[0.1em] text-muted">
          Edges
        </h4>
        <ul class="m-0 pl-5">
          <For each={props.view.edges}>
            {(edge) => (
              <li class="my-1 text-[0.8125rem] leading-[1.5] text-ink-soft">
                <code class="text-xs">{edge.predecessor}</code> →{' '}
                <code class="text-xs">{edge.dependent}</code>
                <span class="ml-2 text-muted">{edge.edgeClass}</span>
              </li>
            )}
          </For>
        </ul>
        <Show when={props.domain === 'discourse'}>
          <h4 class="mt-4 mb-2 text-[0.625rem] font-extrabold uppercase tracking-[0.1em] text-muted">
            Reader order
          </h4>
          <ol class="m-0 pl-5">
            <For each={props.view.sceneSequence}>
              {(scene) => (
                <li class="my-1 text-[0.8125rem] leading-[1.5] text-ink-soft">
                  {scene.sceneId} · chapter {scene.chapter}
                </li>
              )}
            </For>
          </ol>
        </Show>
      </details>
    </div>
  );
}

/**
 * Canonical graph and route view. The canvas renders only frozen compiler
 * projections: domain tabs switch which view is projected, route choices
 * re-request the projection through `onRouteChange`, node selection flows out
 * through `onNodeSelect`, and every editing affordance stays disabled. The
 * collapsible structured summary is the keyboard/screen-reader path.
 */
export function GraphRoute(props: GraphRouteProps) {
  const [activeDomain, setActiveDomain] = createSignal<WorkbenchGraphDomainV1>('story');
  const [selectedNode, setSelectedNode] = createSignal<string | null>(null);
  const [controls, setControls] = createSignal<LogicFlowGraphControls | null>(null);

  const storyModel = createMemo<GraphCanvasModelV1 | null>(() => {
    const projection = props.projection;
    return projection ? layoutGraphView(projection.story) : null;
  });
  const discourseModel = createMemo<GraphCanvasModelV1 | null>(() => {
    const projection = props.projection;
    return projection ? layoutGraphView(projection.discourse) : null;
  });

  const handleNodeSelect = (nodeId: string) => {
    setSelectedNode(nodeId);
    props.onNodeSelect?.(nodeId);
  };

  const chooseRoute = (choice: WorkbenchRouteChoiceV1) => {
    const route = props.projection?.route;
    if (!route || !props.onRouteChange) return;
    props.onRouteChange(nextRouteSelector(route, choice));
  };

  const resetRoute = () => {
    const route = props.projection?.route;
    if (!route || !props.onRouteChange) return;
    props.onRouteChange(emptyRouteSelector(route));
  };

  return (
    <Show
      when={props.projection}
      fallback={
        <ScreenEmpty
          title="No canonical graph projection"
          body="Select an authenticated project route to load compiler-owned nodes and reader order."
        />
      }
    >
      {(projection) => (
        <section class="mx-auto grid max-w-[60rem] gap-6" aria-labelledby="graph-route-heading">
          <header class="grid gap-1">
            <p class={KICKER}>Canonical route</p>
            <h2 id="graph-route-heading">Story and discourse graph</h2>
            <ScreenNote>
              Scope: <code class="text-xs">{projection().route.branchScope}</code> · Discourse:{' '}
              <code class="text-xs">{projection().route.discourseBranch}</code>
            </ScreenNote>
          </header>

          <section
            class="grid gap-4 rounded-[0.625rem] border border-line bg-surface p-5 shadow-[var(--wb-shadow-panel)]"
            aria-labelledby="route-selector-heading"
          >
            <header class="flex items-start justify-between gap-3">
              <div>
                <p class={KICKER}>Selected branch</p>
                <h3 id="route-selector-heading">Route choices</h3>
              </div>
              <Show when={props.fetchingRoute}>
                <span
                  class="inline-flex w-max items-center gap-2 rounded-full border border-loading-border bg-loading-surface px-3 py-2 text-[0.6875rem] font-bold leading-none tracking-[0.04em] text-warning"
                  role="status"
                  aria-label="Reloading projection"
                >
                  Reloading projection…
                </span>
              </Show>
            </header>
            <Show when={projection().route.branchPath.decisions.length > 0}>
              <ol
                class="m-0 flex list-none flex-wrap gap-2 p-0"
                aria-label="Selected route decisions"
              >
                <For each={projection().route.branchPath.decisions}>
                  {(decision) => (
                    <li class="rounded-[0.375rem] bg-surface-muted px-2 py-1 text-xs text-ink-soft">
                      <code class="text-[0.6875rem]">{decision.atEventId}</code> →{' '}
                      <code class="text-[0.6875rem]">{decision.choiceId}</code>
                    </li>
                  )}
                </For>
              </ol>
            </Show>
            <Show
              when={isRouteLeaf(projection().route)}
              fallback={
                <ul class="m-0 grid list-none gap-3 p-0">
                  <For each={projection().route.choices}>
                    {(choice) => (
                      <li>
                        <button
                          type="button"
                          class="grid w-full cursor-pointer gap-1 rounded-[0.375rem] border border-line bg-surface px-4 py-3 text-left text-ink transition-[background,border-color] duration-[160ms] enabled:hover:border-line-strong enabled:hover:bg-surface-muted disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-muted"
                          disabled={!props.onRouteChange || props.fetchingRoute}
                          onClick={() => chooseRoute(choice)}
                          aria-label={`Choose ${choice.label}`}
                        >
                          <span class="text-sm font-[750]">{choice.label}</span>
                          <span class="text-[0.625rem] font-extrabold uppercase tracking-[0.1em] text-muted">
                            {choice.eventId} → {choice.targetEventId}
                          </span>
                          <span class="text-[0.8125rem] leading-[1.5] text-ink-soft">
                            {choice.description}
                          </span>
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              }
            >
              <ScreenNote>
                This route is a leaf — the canonical compiler exposes no further choices.
              </ScreenNote>
            </Show>
            <Show when={!props.onRouteChange && projection().route.choices.length > 0}>
              <ScreenNote>Route switching is not connected in this workspace yet.</ScreenNote>
            </Show>
            <Show when={props.onRouteChange && projection().route.branchPath.decisions.length > 0}>
              <button
                type="button"
                class={TEXT_BUTTON}
                disabled={props.fetchingRoute}
                onClick={resetRoute}
              >
                Reset route
              </button>
            </Show>
          </section>

          <Tabs
            class={TABS_ROOT}
            value={activeDomain()}
            onChange={(value) => setActiveDomain(value as WorkbenchGraphDomainV1)}
          >
            <Tabs.List class={TABS_LIST} aria-label="Graph domain">
              <Tabs.Trigger class={TABS_TRIGGER} value="story">
                Story
              </Tabs.Trigger>
              <Tabs.Trigger class={TABS_TRIGGER} value="discourse">
                Discourse
              </Tabs.Trigger>
            </Tabs.List>
            <Tabs.Content class={TABS_CONTENT} value="story">
              <Show when={activeDomain() === 'story'}>
                <GraphDomainPanel
                  domain="story"
                  view={projection().story}
                  model={storyModel()}
                  controls={controls()}
                  selectedNode={selectedNode()}
                  onNodeSelect={handleNodeSelect}
                  onControls={setControls}
                />
              </Show>
            </Tabs.Content>
            <Tabs.Content class={TABS_CONTENT} value="discourse">
              <Show when={activeDomain() === 'discourse'}>
                <GraphDomainPanel
                  domain="discourse"
                  view={projection().discourse}
                  model={discourseModel()}
                  controls={controls()}
                  selectedNode={selectedNode()}
                  onNodeSelect={handleNodeSelect}
                  onControls={setControls}
                />
              </Show>
            </Tabs.Content>
          </Tabs>
        </section>
      )}
    </Show>
  );
}
