import { Dialog } from '@kobalte/core/dialog';
import type { JSX } from 'solid-js';
import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import type {
  AuthoringOperationReceiptV1,
  AuthoringStateV1,
  BrowserAuthoringReconcileRequestV1,
  BrowserAuthoringRevisionDiffV1,
  BrowserAuthoringRevisionListV1,
  BrowserAuthoringRevisionRestoreRequestV1,
  BrowserAuthoringRevisionV1,
  BrowserAuthoringSubmitRequestV1,
  BrowserProjectOverviewV1,
  SceneAdoptionViewV1,
  SourceStudioDocumentDescriptorV1,
  SourceStudioStateV1,
  WorkbenchGraphProjectionV1,
  WorkbenchRouteSelectorV1,
} from '../contracts/index.js';
import type { AgentClient } from './agent-client';
import { createEditorAssistantContext, EditorAssistantProvider } from './editor-assistant-context';
import {
  loadWorkbenchPreferences,
  saveWorkbenchPreferences,
  type WorkbenchPreferencesV1,
} from './preferences';
import { GraphRoute, ProjectHome } from './projection-views';
import { SceneCanvas } from './scene-canvas';
import { SourceStudio, type SourceStudioYjsStatus } from './source-studio';
import { AgentDrawer } from './ui/AgentDrawer';
import type { YjsEditorSelection } from './yjs-editor';

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
  readonly authoringRevisionHistory?: BrowserAuthoringRevisionListV1 | null;
  readonly authoringRevision?: BrowserAuthoringRevisionV1 | null;
  readonly authoringRevisionDiff?: BrowserAuthoringRevisionDiffV1 | null;
  readonly onListAuthoringRevisions?: () => void | Promise<void>;
  readonly onGetAuthoringRevision?: (revisionId: string) => void | Promise<void>;
  readonly onDiffAuthoringRevisions?: (
    fromRevisionId: string,
    toRevisionId: string,
  ) => void | Promise<void>;
  readonly onRestoreAuthoringRevision?: (
    request: BrowserAuthoringRevisionRestoreRequestV1,
  ) => void | Promise<void>;
  /** Host-derived Source Studio state; working edits stay noncanonical until Host submission. */
  readonly sourceStudio?: SourceStudioStateV1 | null;
  readonly authoringState?: AuthoringStateV1 | null;
  readonly authoringOperations?: readonly AuthoringOperationReceiptV1[];
  readonly sourceSessionId?: string | null;
  readonly sourceYjsStatus?: Readonly<Record<string, SourceStudioYjsStatus>>;
  readonly onConnectSourceYjs?: (descriptor: SourceStudioDocumentDescriptorV1) => void;
  readonly onSubmitSource?: (descriptor: SourceStudioDocumentDescriptorV1) => void;
  readonly onSubmitAuthoring?: (request: BrowserAuthoringSubmitRequestV1) => void | Promise<void>;
  readonly onReconcileAuthoring?: (
    request: BrowserAuthoringReconcileRequestV1,
  ) => void | Promise<void>;
  readonly onGraphRouteChange?: (selector: WorkbenchRouteSelectorV1) => void;
  readonly onSourceYjsStatusChange?: (
    descriptor: SourceStudioDocumentDescriptorV1,
    status: SourceStudioYjsStatus,
  ) => void;
  readonly agentClient?: AgentClient;
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
  readonly operations?: readonly AuthoringOperationReceiptV1[];
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
  readonly authoringState?: AuthoringStateV1 | null;
  readonly authoringOperations?: readonly AuthoringOperationReceiptV1[];
  readonly authoringRevisionHistory?: BrowserAuthoringRevisionListV1 | null;
  readonly authoringRevision?: BrowserAuthoringRevisionV1 | null;
  readonly authoringRevisionDiff?: BrowserAuthoringRevisionDiffV1 | null;
  readonly onListAuthoringRevisions?: () => void | Promise<void>;
  readonly onGetAuthoringRevision?: (revisionId: string) => void | Promise<void>;
  readonly onDiffAuthoringRevisions?: (
    fromRevisionId: string,
    toRevisionId: string,
  ) => void | Promise<void>;
  readonly onRestoreAuthoringRevision?: (
    request: BrowserAuthoringRevisionRestoreRequestV1,
  ) => void | Promise<void>;
  readonly sourceSessionId?: string | null;
  readonly selectedSourceDocumentId?: string | null;
  readonly sourceYjsStatus?: Readonly<Record<string, SourceStudioYjsStatus>>;
  readonly onConnectSourceYjs?: (descriptor: SourceStudioDocumentDescriptorV1) => void;
  readonly onSubmitSource?: (descriptor: SourceStudioDocumentDescriptorV1) => void;
  readonly onSubmitAuthoring?: (request: BrowserAuthoringSubmitRequestV1) => void | Promise<void>;
  readonly onReconcileAuthoring?: (
    request: BrowserAuthoringReconcileRequestV1,
  ) => void | Promise<void>;
  readonly onGraphRouteChange?: (selector: WorkbenchRouteSelectorV1) => void;
  readonly onSourceYjsStatusChange?: (
    descriptor: SourceStudioDocumentDescriptorV1,
    status: SourceStudioYjsStatus,
  ) => void;
  readonly onSourceSelection?: (
    descriptor: SourceStudioDocumentDescriptorV1,
    selection: YjsEditorSelection,
  ) => void;
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
          <p>
            {copy().description}
          </p>
        </div>
      </section>

      <Show when={props.hostStatus === 'ready' && props.activeView === 'project-home'}>
        <ProjectHome overview={props.overview ?? null} />
      </Show>
      <Show when={props.hostStatus === 'ready' && props.activeView === 'graph-route'}>
        <GraphRoute
          projection={props.graphProjection ?? null}
          onRouteChange={props.onGraphRouteChange}
        />
      </Show>
      <Show when={props.hostStatus === 'ready' && props.activeView === 'source-studio'}>
        <SourceStudio
          state={props.sourceStudio ?? null}
          authoring={props.authoringState}
          operations={props.authoringOperations}
          revisionHistory={props.authoringRevisionHistory}
          selectedRevision={props.authoringRevision}
          revisionDiff={props.authoringRevisionDiff}
          onListRevisions={props.onListAuthoringRevisions}
          onGetRevision={props.onGetAuthoringRevision}
          onDiffRevisions={props.onDiffAuthoringRevisions}
          onRestoreRevision={props.onRestoreAuthoringRevision}
          sessionId={props.sourceSessionId}
          selectedDocumentId={props.selectedSourceDocumentId}
          onSelectDocument={props.onConnectSourceYjs}
          yjsStatus={props.sourceYjsStatus}
          onConnectYjs={props.onConnectSourceYjs}
          onSubmit={props.onSubmitSource}
          onSubmitAuthoring={props.onSubmitAuthoring}
          onReconcileAuthoring={props.onReconcileAuthoring}
          onYjsStatusChange={props.onSourceYjsStatusChange}
          onEditorSelection={props.onSourceSelection}
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
        <Show
          when={(props.operations?.length ?? 0) > 0}
          fallback={
            <div class="operation-empty" id="operation-center-content">
              <span class="operation-pulse" aria-hidden="true" />
              <div>
                <h3>No operations running</h3>
                <p>Host operations will appear here with explicit status and provenance.</p>
              </div>
            </div>
          }
        >
          <ul
            id="operation-center-content"
            class="grid gap-[var(--wb-space-2)]"
            aria-label="Authoring operations"
          >
            <For each={props.operations ?? []}>
              {(operation) => (
                <li class="flex flex-wrap items-center justify-between gap-[var(--wb-space-3)] rounded-[var(--wb-radius-sm)] border border-[var(--wb-border)] bg-[var(--wb-surface-muted)] px-[var(--wb-space-3)] py-[var(--wb-space-2)] text-sm">
                  <span>
                    <strong>{operation.kind}</strong> <code>{operation.operationId}</code>
                  </span>
                  <span>{operation.status}</span>
                </li>
              )}
            </For>
          </ul>
        </Show>
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

type WorkbenchLayoutMode = 'desktop' | 'tablet' | 'mobile';

function ResponsiveDrawer(props: {
  readonly open: boolean;
  readonly label: string;
  readonly onClose: () => void;
  readonly children: JSX.Element;
}) {
  return (
    <Show when={props.open}>
      <Dialog open onOpenChange={(open) => !open && props.onClose()}>
        <Dialog.Portal>
          <Dialog.Overlay class="responsive-drawer-backdrop" />
          <Dialog.Content class="responsive-drawer" role="dialog">
            <div class="responsive-drawer-heading">
              <Dialog.Title>{props.label}</Dialog.Title>
              <button
                class="icon-button"
                type="button"
                aria-label={`Close ${props.label}`}
                onClick={props.onClose}
              >
                ×
              </button>
            </div>
            {props.children}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>
    </Show>
  );
}

interface TopbarProps {
  readonly activeView: WorkbenchViewId;
  readonly hostStatus: HostStatus;
  readonly layoutMode: WorkbenchLayoutMode;
  readonly navigatorOpen: boolean;
  readonly inspectorOpen: boolean;
  readonly agentShelfOpen: boolean;
  readonly onNavigatorToggle: () => void;
  readonly onInspectorToggle: () => void;
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

      <Show when={props.layoutMode !== 'desktop'}>
        <fieldset class="mobile-layout-controls">
          <legend class="sr-only">Workspace panels</legend>
          <Show when={props.layoutMode === 'mobile'}>
            <button
              class="icon-button"
              type="button"
              aria-label="Open navigation"
              aria-expanded={props.navigatorOpen}
              onClick={props.onNavigatorToggle}
            >
              ☰
            </button>
          </Show>
          <button
            class="icon-button"
            type="button"
            aria-label="Open Inspector"
            aria-expanded={props.inspectorOpen}
            onClick={props.onInspectorToggle}
          >
            ⓘ
          </button>
        </fieldset>
      </Show>

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
  const [layoutMode, setLayoutMode] = createSignal<WorkbenchLayoutMode>('desktop');
  const [navigatorDrawerOpen, setNavigatorDrawerOpen] = createSignal(false);
  const [inspectorDrawerOpen, setInspectorDrawerOpen] = createSignal(false);
  onMount(() => {
    const updateLayout = () => {
      const width = window.innerWidth;
      setLayoutMode(width < 768 ? 'mobile' : width < 1024 ? 'tablet' : 'desktop');
    };
    updateLayout();
    window.addEventListener('resize', updateLayout);
    onCleanup(() => window.removeEventListener('resize', updateLayout));
  });
  const assistant = createEditorAssistantContext();
  const [selectedSourceDocumentId, setSelectedSourceDocumentId] = createSignal<string | null>(null);

  const selectSourceDocument = (descriptor: SourceStudioDocumentDescriptorV1): void => {
    setSelectedSourceDocumentId(descriptor.documentId);
    assistant.clearSelection();
    props.onConnectSourceYjs?.(descriptor);
  };

  const publishSourceSelection = (
    descriptor: SourceStudioDocumentDescriptorV1,
    selection: YjsEditorSelection,
  ): void => {
    const baseVector = props.authoringState?.workspaceDigest;
    if (baseVector === null || baseVector === undefined) {
      assistant.clearSelection();
      return;
    }
    assistant.setSelection({
      version: 1,
      projectId: descriptor.projectId,
      documentId: descriptor.documentId,
      selection,
      baseVector,
    });
  };

  const hostStatus = () => props.hostStatus ?? 'unavailable';

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
    if (layoutMode() === 'mobile') setNavigatorDrawerOpen(false);
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

  const toggleNavigatorDrawer = () => setNavigatorDrawerOpen((open) => !open);
  const toggleInspectorDrawer = () => setInspectorDrawerOpen((open) => !open);

  return (
    <EditorAssistantProvider value={assistant}>
      <div
        class={`workbench-shell${navigatorCollapsed() ? ' navigator-is-collapsed' : ''}`}
        data-testid="workbench-shell"
        data-view={activeView()}
      >
        <Topbar
          activeView={activeView()}
          hostStatus={hostStatus()}
          layoutMode={layoutMode()}
          navigatorOpen={navigatorDrawerOpen()}
          inspectorOpen={inspectorDrawerOpen()}
          agentShelfOpen={agentShelfOpen()}
          onNavigatorToggle={toggleNavigatorDrawer}
          onInspectorToggle={toggleInspectorDrawer}
          onAgentShelfToggle={toggleAgentShelf}
        />

        <div class="workbench-body">
          <Show when={layoutMode() !== 'mobile'}>
            <Navigator
              activeView={activeView()}
              collapsed={navigatorCollapsed()}
              onCollapseToggle={toggleNavigator}
              onViewChange={chooseView}
            />
          </Show>

          <div class="workspace-column">
            <Workspace
              activeView={activeView()}
              hostStatus={hostStatus()}
              overview={props.overview}
              graphProjection={props.graphProjection}
              sourceStudio={props.sourceStudio}
              authoringState={props.authoringState}
              authoringOperations={props.authoringOperations}
              sourceSessionId={props.sourceSessionId}
              sourceYjsStatus={props.sourceYjsStatus}
              onConnectSourceYjs={selectSourceDocument}
              onSubmitSource={props.onSubmitSource}
              onSubmitAuthoring={props.onSubmitAuthoring}
              onReconcileAuthoring={props.onReconcileAuthoring}
              onGraphRouteChange={props.onGraphRouteChange}
              selectedSourceDocumentId={selectedSourceDocumentId()}
              onSourceYjsStatusChange={props.onSourceYjsStatusChange}
              onSourceSelection={publishSourceSelection}
              sceneAdoption={props.sceneAdoption}
              onRequestAdoption={props.onRequestAdoption}
            />
            <OperationCenter
              expanded={operationCenterExpanded()}
              operations={props.authoringOperations}
              onExpandedToggle={toggleOperationCenter}
            />
          </div>

          <Show when={layoutMode() === 'desktop'}>
            <Inspector pinned={inspectorPinned()} onPinToggle={toggleInspector} />
          </Show>
        </div>

        <Show when={layoutMode() === 'tablet'}>
          <ResponsiveDrawer
            open={inspectorDrawerOpen()}
            label="Inspector"
            onClose={() => setInspectorDrawerOpen(false)}
          >
            <Inspector pinned={inspectorPinned()} onPinToggle={toggleInspector} />
          </ResponsiveDrawer>
        </Show>
        <Show when={layoutMode() === 'mobile'}>
          <ResponsiveDrawer
            open={navigatorDrawerOpen()}
            label="Navigation"
            onClose={() => setNavigatorDrawerOpen(false)}
          >
            <Navigator
              activeView={activeView()}
              collapsed={false}
              onCollapseToggle={() => setNavigatorDrawerOpen(false)}
              onViewChange={chooseView}
            />
          </ResponsiveDrawer>
          <ResponsiveDrawer
            open={inspectorDrawerOpen()}
            label="Inspector"
            onClose={() => setInspectorDrawerOpen(false)}
          >
            <Inspector pinned={inspectorPinned()} onPinToggle={toggleInspector} />
          </ResponsiveDrawer>
        </Show>

        <Show
          when={props.agentClient}
          fallback={<AgentShelf open={agentShelfOpen()} onClose={toggleAgentShelf} />}
        >
          {(client) => (
            <AgentDrawer
              open={agentShelfOpen()}
              context={assistant.selection()}
              client={client()}
              onClose={toggleAgentShelf}
              onApplied={() => assistant.clearSelection()}
            />
          )}
        </Show>
      </div>
    </EditorAssistantProvider>
  );
}

export function App(props: AppProps = {}): JSX.Element {
  return <WorkbenchShell {...props} />;
}

export default App;
