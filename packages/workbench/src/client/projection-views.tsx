import { Tabs } from '@kobalte/core/tabs';
import { For, Show, createMemo, createSignal } from 'solid-js';
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
  isRouteLeaf,
  layoutGraphView,
  nextRouteSelector,
  type GraphCanvasModelV1,
} from './graph-view-model';
import { LogicFlowGraph, type LogicFlowGraphControls } from './logicflow-graph';

export interface ProjectHomeProps {
  readonly overview: BrowserProjectOverviewV1 | null;
}

/** A Host-projected project summary; never invents a project or operation. */
export function ProjectHome(props: ProjectHomeProps) {
  return (
    <Show
      when={props.overview}
      fallback={
        <section class="screen-empty" aria-live="polite">
          <h2>No project projection</h2>
          <p>Open an authenticated project in the Host to load its accepted projection.</p>
        </section>
      }
    >
      {(overview) => {
        const projection = () => overview().projection;
        return (
          <section class="project-home" aria-labelledby="project-home-heading">
            <header>
              <p class="region-kicker">Accepted project</p>
              <h2 id="project-home-heading">{overview().metadata.displayName}</h2>
              <p class="project-identity">{overview().projectId}</p>
            </header>
            <Show
              when={projection()}
              fallback={
                <p class="screen-note">
                  The Host has no accepted source projection for this open project yet.
                </p>
              }
            >
              {(accepted) => (
                <dl class="projection-metrics">
                  <div>
                    <dt>Documents</dt>
                    <dd>{accepted().documents}</dd>
                  </div>
                  <div>
                    <dt>Scenes</dt>
                    <dd>{accepted().events}</dd>
                  </div>
                  <div>
                    <dt>Rendered</dt>
                    <dd>{accepted().rendered}</dd>
                  </div>
                  <div>
                    <dt>Blocked</dt>
                    <dd>{accepted().blocked}</dd>
                  </div>
                  <div>
                    <dt>Warnings</dt>
                    <dd>{accepted().warningCount}</dd>
                  </div>
                  <div>
                    <dt>Errors</dt>
                    <dd>{accepted().errorCount}</dd>
                  </div>
                </dl>
              )}
            </Show>
            <p class="screen-note">
              {overview().activity.busy
                ? 'The Host has an active operation.'
                : 'No Host operation is active.'}{' '}
              {overview().activity.hasHumanPresence
                ? 'Human collaboration is present.'
                : 'No human collaboration is present.'}
            </p>
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
    <div class="graph-domain-panel">
      <div
        class="graph-toolbar"
        role="toolbar"
        aria-label={`${label()} graph viewport`}
      >
        <span class="graph-toolbar-note">
          {label()} · {props.view.nodes.length} nodes · {props.view.edges.length} edges
        </span>
        <span class="graph-toolbar-actions">
          <button
            type="button"
            class="text-button"
            disabled={!props.controls}
            onClick={() => props.controls?.fitView()}
          >
            Fit
          </button>
          <button
            type="button"
            class="text-button"
            disabled={!props.controls}
            onClick={() => props.controls?.zoomIn()}
          >
            Zoom in
          </button>
          <button
            type="button"
            class="text-button"
            disabled={!props.controls}
            onClick={() => props.controls?.zoomOut()}
          >
            Zoom out
          </button>
          <button
            type="button"
            class="text-button"
            disabled={!props.controls}
            onClick={() => props.controls?.resetZoom()}
          >
            Reset zoom
          </button>
        </span>
      </div>
      <Show when={props.model} fallback={<p class="screen-note">No {label()} layout.</p>}>
        {(model) => (
          <div class="graph-canvas-frame">
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
        class="graph-status"
        role="status"
        aria-live="polite"
        aria-label={
          props.selectedNode
            ? `Selected node: ${props.selectedNode}`
            : 'No node selected'
        }
      >
        {props.selectedNode
          ? `Selected node: ${props.selectedNode}`
          : 'No node selected. Use the structured summary below for keyboard access.'}
      </p>
      <details class="graph-access-summary">
        <summary>Structured {label()} summary</summary>
        <dl class="projection-metrics">
          <div>
            <dt>Nodes</dt>
            <dd>{props.view.nodes.length}</dd>
          </div>
          <div>
            <dt>Edges</dt>
            <dd>{props.view.edges.length}</dd>
          </div>
          <div>
            <dt>Outputs</dt>
            <dd>{props.view.outputs.length}</dd>
          </div>
          <div>
            <dt>Reads</dt>
            <dd>{props.view.reads.length}</dd>
          </div>
        </dl>
        <h4>Nodes</h4>
        <ul class="graph-node-list">
          <For each={props.view.nodes}>
            {(node) => (
              <li>
                <code>{node.id}</code>
                <span>{describeCoordinate(node.coordinate)}</span>
                <span>{describeOrigin(node.origin)}</span>
              </li>
            )}
          </For>
        </ul>
        <h4>Edges</h4>
        <ul class="graph-edge-list">
          <For each={props.view.edges}>
            {(edge) => (
              <li>
                <code>{edge.predecessor}</code> → <code>{edge.dependent}</code>
                <span>{edge.edgeClass}</span>
              </li>
            )}
          </For>
        </ul>
        <Show when={props.domain === 'discourse'}>
          <h4>Reader order</h4>
          <ol class="scene-sequence">
            <For each={props.view.sceneSequence}>
              {(scene) => (
                <li>
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
        <section class="screen-empty" aria-live="polite">
          <h2>No canonical graph projection</h2>
          <p>
            Select an authenticated project route to load compiler-owned nodes and reader order.
          </p>
        </section>
      }
    >
      {(projection) => (
        <section class="graph-route" aria-labelledby="graph-route-heading">
          <header>
            <p class="region-kicker">Canonical route</p>
            <h2 id="graph-route-heading">Story and discourse graph</h2>
            <p class="screen-note">
              Scope: <code>{projection().route.branchScope}</code> · Discourse:{' '}
              <code>{projection().route.discourseBranch}</code>
            </p>
          </header>

          <section class="graph-route-selector" aria-labelledby="route-selector-heading">
            <header class="region-heading">
              <div>
                <p class="region-kicker">Selected branch</p>
                <h3 id="route-selector-heading">Route choices</h3>
              </div>
              <Show when={props.fetchingRoute}>
                <span
                  class="graph-fetching"
                  role="status"
                  aria-label="Reloading projection"
                >
                  Reloading projection…
                </span>
              </Show>
            </header>
            <Show when={projection().route.branchPath.decisions.length > 0}>
              <ol class="route-decision-trail" aria-label="Selected route decisions">
                <For each={projection().route.branchPath.decisions}>
                  {(decision) => (
                    <li>
                      <code>{decision.atEventId}</code> → <code>{decision.choiceId}</code>
                    </li>
                  )}
                </For>
              </ol>
            </Show>
            <Show
              when={isRouteLeaf(projection().route)}
              fallback={
                <ul class="route-choice-list">
                  <For each={projection().route.choices}>
                    {(choice) => (
                      <li>
                        <button
                          type="button"
                          class="route-choice"
                          disabled={!props.onRouteChange || props.fetchingRoute}
                          onClick={() => chooseRoute(choice)}
                          aria-label={`Choose ${choice.label}`}
                        >
                          <span class="route-choice-label">{choice.label}</span>
                          <span class="route-choice-meta">
                            {choice.eventId} → {choice.targetEventId}
                          </span>
                          <span class="route-choice-description">{choice.description}</span>
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              }
            >
              <p class="screen-note">
                This route is a leaf — the canonical compiler exposes no further choices.
              </p>
            </Show>
            <Show when={!props.onRouteChange && projection().route.choices.length > 0}>
              <p class="screen-note">Route switching is not connected in this workspace yet.</p>
            </Show>
            <Show when={props.onRouteChange && projection().route.branchPath.decisions.length > 0}>
              <button
                type="button"
                class="text-button"
                disabled={props.fetchingRoute}
                onClick={resetRoute}
              >
                Reset route
              </button>
            </Show>
          </section>

          <Tabs
            class="graph-domain-tabs-root"
            value={activeDomain()}
            onChange={(value) => setActiveDomain(value as WorkbenchGraphDomainV1)}
          >
            <Tabs.List class="graph-domain-tabs" aria-label="Graph domain">
              <Tabs.Trigger class="graph-domain-tab" value="story">
                Story
              </Tabs.Trigger>
              <Tabs.Trigger class="graph-domain-tab" value="discourse">
                Discourse
              </Tabs.Trigger>
            </Tabs.List>
            <Tabs.Content value="story">
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
            <Tabs.Content value="discourse">
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
