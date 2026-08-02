import { For, Show } from 'solid-js';
import type {
  BrowserProjectOverviewV1,
  WorkbenchGraphProjectionV1,
  WorkbenchGraphViewV1,
} from '../contracts/index.js';

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

function GraphSummary(props: { readonly label: string; readonly graph: WorkbenchGraphViewV1 }) {
  return (
    <section class="graph-summary" aria-label={`${props.label} graph`}>
      <header>
        <h3>{props.label}</h3>
        <code>{props.graph.hash}</code>
      </header>
      <dl class="projection-metrics">
        <div>
          <dt>Nodes</dt>
          <dd>{props.graph.nodes.length}</dd>
        </div>
        <div>
          <dt>Edges</dt>
          <dd>{props.graph.edges.length}</dd>
        </div>
        <div>
          <dt>Outputs</dt>
          <dd>{props.graph.outputs.length}</dd>
        </div>
        <div>
          <dt>Reads</dt>
          <dd>{props.graph.reads.length}</dd>
        </div>
      </dl>
      <ul class="graph-node-list" aria-label={`${props.label} graph nodes`}>
        <For each={props.graph.nodes}>
          {(node) => (
            <li>
              <code>{node.id}</code>
              <span>
                {node.coordinate.type === 'discoursePosition'
                  ? `discourse ${node.coordinate.value}`
                  : node.coordinate.kind}
              </span>
              <span>{node.origin.type}</span>
            </li>
          )}
        </For>
      </ul>
    </section>
  );
}

export interface GraphRouteProps {
  readonly projection: WorkbenchGraphProjectionV1 | null;
}

/** Renders only canonical compiler-projected graph and route fields. */
export function GraphRoute(props: GraphRouteProps) {
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
          <GraphSummary label="Story" graph={projection().story} />
          <GraphSummary label="Discourse" graph={projection().discourse} />
          <section class="scene-sequence" aria-labelledby="reader-order-heading">
            <h3 id="reader-order-heading">Reader order</h3>
            <ol>
              <For each={projection().discourse.sceneSequence}>
                {(scene) => (
                  <li>
                    {scene.sceneId} · chapter {scene.chapter}
                  </li>
                )}
              </For>
            </ol>
          </section>
        </section>
      )}
    </Show>
  );
}
