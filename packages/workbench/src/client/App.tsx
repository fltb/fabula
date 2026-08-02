import type { JSX } from 'solid-js';
import { createSignal, For, Show } from 'solid-js';
import type {
  BrowserProjectOverviewV1,
  SceneAdoptionViewV1,
  SourceStudioDocumentDescriptorV1,
  SourceStudioStateV1,
  WorkbenchGraphProjectionV1,
} from '../contracts/index.js';
import {
  loadWorkbenchPreferences,
  saveWorkbenchPreferences,
  type WorkbenchPreferencesV1,
} from './preferences';
import { GraphRoute, ProjectHome } from './projection-views';
import { SceneCanvas } from './scene-canvas';
import { SourceStudio, type SourceStudioYjsStatus } from './source-studio';

export const WORKBENCH_VIEWS = [
  { id: 'project-home', label: 'Project Home', glyph: '⌂' },
  { id: 'scene-canvas', label: 'Scene Canvas', glyph: '◇' },
  { id: 'source-studio', label: 'Source Studio', glyph: '≋' },
  { id: 'graph-route', label: 'Graph / Route', glyph: '↗' },
  { id: 'review-hub', label: 'Review Hub', glyph: '✓' },
  { id: 'publication', label: 'Publication', glyph: '◫' },
] as const;

export type WorkbenchViewId = (typeof WORKBENCH_VIEWS)[number]['id'];
export type HostStatus = 'unavailable' | 'loading' | 'empty' | 'error' | 'ready';

type ViewDefinition = (typeof WORKBENCH_VIEWS)[number];

export interface AppProps {
  /** The initial view is a local UI choice; it never identifies a project. */
  readonly initialView?: WorkbenchViewId;
  /** The shell stays honest until an authenticated Host supplies a status. */
  readonly hostStatus?: HostStatus;
  readonly initialNavigatorCollapsed?: boolean;
  readonly initialInspectorPinned?: boolean;
  readonly initialOperationCenterExpanded?: boolean;
  readonly initialAgentShelfOpen?: boolean;
  readonly onViewChange?: (view: WorkbenchViewId) => void;
  /** Accepted project view supplied only by the authenticated Host read client. */
  readonly overview?: BrowserProjectOverviewV1 | null;
  /** Canonical graph view supplied only by the authenticated Host read client. */
  readonly graphProjection?: WorkbenchGraphProjectionV1 | null;
  /** Host-derived Source Studio state; working edits stay noncanonical until Host submission. */
  readonly sourceStudio?: SourceStudioStateV1 | null;
  readonly sourceYjsStatus?: Readonly<Record<string, SourceStudioYjsStatus>>;
  readonly onConnectSourceYjs?: (descriptor: SourceStudioDocumentDescriptorV1) => void;
  readonly onSubmitSource?: (descriptor: SourceStudioDocumentDescriptorV1) => void;
  /** Explicit, Host-derived adoption preview for the selected Scene Canvas. */
  readonly sceneAdoption?: SceneAdoptionViewV1 | null;
  readonly onRequestAdoption?: (candidate: SceneAdoptionViewV1) => void;
}

export interface NavigatorProps {
  readonly activeView: WorkbenchViewId;
  readonly collapsed: boolean;
  readonly onCollapseToggle: () => void;
  readonly onViewChange: (view: WorkbenchViewId) => void;
}

export interface InspectorProps {
  readonly pinned: boolean;
  readonly onPinToggle: () => void;
}

export interface OperationCenterProps {
  readonly expanded: boolean;
  readonly onExpandedToggle: () => void;
}

export interface AgentShelfProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

interface WorkspaceProps {
  readonly activeView: WorkbenchViewId;
  readonly hostStatus: HostStatus;
  readonly overview?: BrowserProjectOverviewV1 | null;
  readonly graphProjection?: WorkbenchGraphProjectionV1 | null;
  readonly sourceStudio?: SourceStudioStateV1 | null;
  readonly sourceYjsStatus?: Readonly<Record<string, SourceStudioYjsStatus>>;
  readonly onConnectSourceYjs?: (descriptor: SourceStudioDocumentDescriptorV1) => void;
  readonly onSubmitSource?: (descriptor: SourceStudioDocumentDescriptorV1) => void;
  readonly sceneAdoption?: SceneAdoptionViewV1 | null;
  readonly onRequestAdoption?: (candidate: SceneAdoptionViewV1) => void;
}

const STATUS_COPY: Record<
  HostStatus,
  {
    readonly label: string;
    readonly title: string;
    readonly description: string;
    readonly marker: string;
  }
> = {
  unavailable: {
    label: 'Host unavailable',
    title: 'Host is unavailable',
    description:
      'The Workbench read API is not configured for this browser session. Connect an authenticated Host to load a project projection.',
    marker: '—',
  },
  loading: {
    label: 'Loading',
    title: 'Loading Host projection',
    description:
      'The Host is resolving an authenticated project projection. No project data is shown until that read completes.',
    marker: '…',
  },
  empty: {
    label: 'No project open',
    title: 'No project is open',
    description:
      'The Host is available, but it returned no project projection for this session. Open a project in the Host to populate the workspace.',
    marker: '○',
  },
  error: {
    label: 'Read error',
    title: 'The Host projection could not be read',
    description:
      'The read API returned an error. This shell does not guess a project, scene, route, or graph while the projection is unavailable.',
    marker: '!',
  },
  ready: {
    label: 'Host connected',
    title: 'Projection ready',
    description:
      'The authenticated Host projection is ready for this view. Compiler-owned data will appear here when the read API supplies it.',
    marker: '·',
  },
};

function viewById(viewId: WorkbenchViewId): ViewDefinition {
  return WORKBENCH_VIEWS.find((view) => view.id === viewId) ?? WORKBENCH_VIEWS[0];
}

function statusCopy(status: HostStatus) {
  return STATUS_COPY[status];
}

export function Navigator(props: NavigatorProps) {
  return (
    <aside
      class={`navigator-region${props.collapsed ? ' is-collapsed' : ''}`}
      aria-label="Navigator"
      data-collapsed={props.collapsed}
      data-testid="navigator"
    >
      <div class="region-heading navigator-heading">
        <div class="navigator-heading-copy">
          <p class="region-kicker">Navigate</p>
          <h2>Workbench views</h2>
        </div>
        <button
          class="icon-button"
          type="button"
          aria-label={props.collapsed ? 'Expand Navigator' : 'Collapse Navigator'}
          aria-expanded={!props.collapsed}
          onClick={props.onCollapseToggle}
        >
          <span aria-hidden="true">{props.collapsed ? '→' : '←'}</span>
        </button>
      </div>

      <nav aria-label="Workbench views" class="view-navigation">
        <For each={WORKBENCH_VIEWS}>
          {(view) => (
            <button
              class={`view-button${props.activeView === view.id ? ' is-active' : ''}`}
              type="button"
              aria-current={props.activeView === view.id ? 'page' : undefined}
              aria-label={props.collapsed ? view.label : undefined}
              title={props.collapsed ? view.label : undefined}
              onClick={() => props.onViewChange(view.id)}
            >
              <span class="view-glyph" aria-hidden="true">
                {view.glyph}
              </span>
              <span class="view-label">{view.label}</span>
            </button>
          )}
        </For>
      </nav>

      <div class="navigator-footer">
        <span class="status-dot" aria-hidden="true" />
        <span class="view-label">Read-only until Host connects</span>
      </div>
    </aside>
  );
}

export function Workspace(props: WorkspaceProps) {
  const view = () => viewById(props.activeView);
  const copy = () => statusCopy(props.hostStatus);

  return (
    <main class="workspace-scroll" id="workspace-panel" aria-labelledby="workspace-heading">
      <div class="workspace-heading-row">
        <div>
          <p class="region-kicker">Workspace / {view().label}</p>
          <h1 id="workspace-heading">{view().label}</h1>
        </div>
        <span class={`host-status host-status-${props.hostStatus}`}>
          <span class="status-dot" aria-hidden="true" />
          {copy().label}
        </span>
      </div>

      <section
        class={`workspace-state workspace-state-${props.hostStatus}`}
        aria-live="polite"
        aria-busy={props.hostStatus === 'loading'}
        data-testid="workspace-state"
      >
        <div class="state-marker" aria-hidden="true">
          {copy().marker}
        </div>
        <div class="state-copy">
          <p class="region-kicker">Projection status</p>
          <h2>{copy().title}</h2>
          <p>{copy().description}</p>
        </div>
      </section>

      <section class="projection-boundary" aria-labelledby="projection-boundary-heading">
        <div>
          <p class="region-kicker">Data boundary</p>
          <h2 id="projection-boundary-heading">Compiler-owned views only</h2>
        </div>
        <p>
          This shell never infers story nodes, scene order, graph edges, route scope, or branch data
          from prose. Those values appear only when the authenticated Host supplies a canonical
          projection.
        </p>
      </section>

      <Show when={props.hostStatus === 'ready' && props.activeView === 'project-home'}>
        <ProjectHome overview={props.overview ?? null} />
      </Show>
      <Show when={props.hostStatus === 'ready' && props.activeView === 'graph-route'}>
        <GraphRoute projection={props.graphProjection ?? null} />
      </Show>
      <Show when={props.hostStatus === 'ready' && props.activeView === 'source-studio'}>
        <SourceStudio
          state={props.sourceStudio ?? null}
          yjsStatus={props.sourceYjsStatus}
          onConnectYjs={props.onConnectSourceYjs}
          onSubmit={props.onSubmitSource}
        />
      </Show>
      <Show when={props.hostStatus === 'ready' && props.activeView === 'scene-canvas'}>
        <SceneCanvas
          adoption={props.sceneAdoption ?? null}
          onRequestAdoption={props.onRequestAdoption}
        />
      </Show>
    </main>
  );
}

export function Inspector(props: InspectorProps) {
  return (
    <aside
      class={`inspector-region${props.pinned ? ' is-pinned' : ' is-unpinned'}`}
      aria-label="Inspector"
      data-pinned={props.pinned}
      data-testid="inspector"
    >
      <div class="region-heading">
        <div>
          <p class="region-kicker">Selection</p>
          <h2>Inspector</h2>
        </div>
        <button
          class="text-button"
          type="button"
          aria-pressed={props.pinned}
          aria-label={props.pinned ? 'Unpin Inspector' : 'Pin Inspector'}
          onClick={props.onPinToggle}
        >
          <span aria-hidden="true">{props.pinned ? '●' : '○'}</span>
          {props.pinned ? 'Pinned' : 'Pin'}
        </button>
      </div>

      <div class="inspector-empty">
        <div class="empty-mark" aria-hidden="true">
          ＋
        </div>
        <h3>Nothing selected</h3>
        <p>Selection details will appear after the Host supplies a canonical projection.</p>
      </div>
    </aside>
  );
}

export function OperationCenter(props: OperationCenterProps) {
  return (
    <section
      class={`operation-center${props.expanded ? ' is-expanded' : ' is-collapsed'}`}
      aria-labelledby="operation-center-heading"
      data-expanded={props.expanded}
      data-testid="operation-center"
    >
      <div class="operation-heading">
        <div>
          <p class="region-kicker">Activity</p>
          <h2 id="operation-center-heading">Operation Center</h2>
        </div>
        <button
          class="text-button"
          type="button"
          aria-expanded={props.expanded}
          aria-controls="operation-center-content"
          onClick={props.onExpandedToggle}
        >
          {props.expanded ? 'Collapse' : 'Expand'}
        </button>
      </div>

      <Show when={props.expanded}>
        <div class="operation-empty" id="operation-center-content">
          <span class="operation-pulse" aria-hidden="true" />
          <div>
            <h3>No operations running</h3>
            <p>Host operations will appear here with explicit status and provenance.</p>
          </div>
        </div>
      </Show>
    </section>
  );
}

export function AgentShelf(props: AgentShelfProps) {
  return (
    <Show when={props.open}>
      <button
        class="agent-shelf-backdrop"
        type="button"
        aria-label="Dismiss Agent Shelf"
        onClick={props.onClose}
      />
      <aside
        class="agent-shelf"
        id="agent-shelf"
        aria-label="Agent Shelf"
        data-testid="agent-shelf"
      >
        <div class="region-heading">
          <div>
            <p class="region-kicker">Assistants</p>
            <h2>Agent Shelf</h2>
          </div>
          <button
            class="icon-button"
            type="button"
            aria-label="Close Agent Shelf drawer"
            onClick={props.onClose}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
        <div class="agent-shelf-empty">
          <div class="empty-mark" aria-hidden="true">
            ·
          </div>
          <h3>No agent activity</h3>
          <p>Agents appear only after the Host grants a scoped, expiring capability.</p>
        </div>
      </aside>
    </Show>
  );
}

interface TopbarProps {
  readonly activeView: WorkbenchViewId;
  readonly hostStatus: HostStatus;
  readonly agentShelfOpen: boolean;
  readonly onAgentShelfToggle: () => void;
}

function Topbar(props: TopbarProps) {
  const view = () => viewById(props.activeView);
  const copy = () => STATUS_COPY[props.hostStatus];

  return (
    <header class="workbench-topbar">
      <div class="brand-lockup">
        <span class="brand-mark" aria-hidden="true">
          F
        </span>
        <span class="brand-copy">
          <strong>Fabula</strong>
          <span>Workbench</span>
        </span>
      </div>

      <div class="topbar-context" aria-live="polite">
        <span class="topbar-view">{view().label}</span>
        <span class={`topbar-status topbar-status-${props.hostStatus}`}>
          <span class="status-dot" aria-hidden="true" />
          {copy().label}
        </span>
      </div>

      <button
        class="agent-toggle"
        type="button"
        aria-expanded={props.agentShelfOpen}
        aria-controls="agent-shelf"
        onClick={props.onAgentShelfToggle}
      >
        <span class="agent-toggle-mark" aria-hidden="true">
          ✦
        </span>
        {props.agentShelfOpen ? 'Close Agent Shelf' : 'Open Agent Shelf'}
      </button>
    </header>
  );
}

export function WorkbenchShell(props: AppProps = {}) {
  const stored = loadWorkbenchPreferences();
  const initialView = props.initialView ?? stored.selectedNavigationView;
  const [activeView, setActiveView] = createSignal<WorkbenchViewId>(initialView);
  const [navigatorCollapsed, setNavigatorCollapsed] = createSignal(
    props.initialNavigatorCollapsed ?? stored.navigatorCollapsed,
  );
  const [inspectorPinned, setInspectorPinned] = createSignal(
    props.initialInspectorPinned ?? stored.inspectorPinned,
  );
  const [operationCenterExpanded, setOperationCenterExpanded] = createSignal(
    props.initialOperationCenterExpanded ?? stored.operationCenterExpanded,
  );
  const [agentShelfOpen, setAgentShelfOpen] = createSignal(
    props.initialAgentShelfOpen ?? stored.agentShelfOpen,
  );

  const hostStatus = props.hostStatus ?? 'unavailable';

  const persistPreferences = (patch: Partial<WorkbenchPreferencesV1>) => {
    saveWorkbenchPreferences({
      version: stored.version,
      navigatorCollapsed: navigatorCollapsed(),
      inspectorPinned: inspectorPinned(),
      operationCenterExpanded: operationCenterExpanded(),
      agentShelfOpen: agentShelfOpen(),
      selectedNavigationView: activeView(),
      ...patch,
    });
  };

  const chooseView = (view: WorkbenchViewId) => {
    setActiveView(view);
    persistPreferences({ selectedNavigationView: view });
    props.onViewChange?.(view);
  };

  const toggleNavigator = () => {
    const collapsed = !navigatorCollapsed();
    setNavigatorCollapsed(collapsed);
    persistPreferences({ navigatorCollapsed: collapsed });
  };

  const toggleInspector = () => {
    const pinned = !inspectorPinned();
    setInspectorPinned(pinned);
    persistPreferences({ inspectorPinned: pinned });
  };

  const toggleOperationCenter = () => {
    const expanded = !operationCenterExpanded();
    setOperationCenterExpanded(expanded);
    persistPreferences({ operationCenterExpanded: expanded });
  };

  const toggleAgentShelf = () => {
    const open = !agentShelfOpen();
    setAgentShelfOpen(open);
    persistPreferences({ agentShelfOpen: open });
  };

  return (
    <div
      class={`workbench-shell${navigatorCollapsed() ? ' navigator-is-collapsed' : ''}`}
      data-testid="workbench-shell"
      data-view={activeView()}
    >
      <Topbar
        activeView={activeView()}
        hostStatus={hostStatus}
        agentShelfOpen={agentShelfOpen()}
        onAgentShelfToggle={toggleAgentShelf}
      />

      <div class="workbench-body">
        <Navigator
          activeView={activeView()}
          collapsed={navigatorCollapsed()}
          onCollapseToggle={toggleNavigator}
          onViewChange={chooseView}
        />

        <div class="workspace-column">
          <Workspace
            activeView={activeView()}
            hostStatus={hostStatus}
            overview={props.overview}
            graphProjection={props.graphProjection}
            sourceStudio={props.sourceStudio}
            sourceYjsStatus={props.sourceYjsStatus}
            onConnectSourceYjs={props.onConnectSourceYjs}
            onSubmitSource={props.onSubmitSource}
            sceneAdoption={props.sceneAdoption}
            onRequestAdoption={props.onRequestAdoption}
          />
          <OperationCenter
            expanded={operationCenterExpanded()}
            onExpandedToggle={toggleOperationCenter}
          />
        </div>

        <Inspector pinned={inspectorPinned()} onPinToggle={toggleInspector} />
      </div>

      <AgentShelf open={agentShelfOpen()} onClose={toggleAgentShelf} />
    </div>
  );
}

export function App(props: AppProps = {}): JSX.Element {
  return <WorkbenchShell {...props} />;
}

export default App;
