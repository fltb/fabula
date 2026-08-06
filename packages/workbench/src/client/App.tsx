import { Dialog } from '@kobalte/core/dialog';
import type { JSX } from 'solid-js';
import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import type {
  AuthoringOperationReceiptV1,
  AuthoringStateV1,
  BrowserAuthoringDocumentCreateRequestV1,
  BrowserAuthoringDocumentDeleteRequestV1,
  BrowserAuthoringDocumentMoveRequestV1,
  BrowserAuthoringReconcileRequestV1,
  BrowserAuthoringRevisionDiffV1,
  BrowserAuthoringRevisionListV1,
  BrowserAuthoringRevisionRestoreRequestV1,
  BrowserAuthoringRevisionV1,
  BrowserAuthoringSubmitRequestV1,
  BrowserProjectOverviewV1,
  BrowserPublicationListV1,
  BrowserPublicationReadQueryV1,
  BrowserPublicationReadResultV1,
  BrowserPublishRequestV1,
  BrowserReviewAddRequestV1,
  BrowserReviewGateDecideRequestV1,
  BrowserReviewGateListV1,
  BrowserReviewHistoryV1,
  BrowserReviewListV1,
  BrowserReviewUpdateRequestV1,
  ProjectAccessRole,
  SceneAdoptionViewV1,
  SourceStudioDocumentDescriptorV1,
  SourceStudioStateV1,
  WorkbenchGraphProjectionV1,
  WorkbenchProjectFeatureV1,
  WorkbenchRouteSelectorV1,
} from '../contracts/index.js';
import { AgentChat } from './AgentChat';
import type { AgentChatClient } from './agent-chat-client.js';
import { PublicationView } from './PublicationView';
import {
  loadWorkbenchPreferences,
  saveWorkbenchPreferences,
  type WorkbenchPreferencesV1,
} from './preferences';
import { GraphRoute, ProjectHome } from './projection-views';
import { ReviewHub } from './ReviewHub';
import { SceneCanvas } from './scene-canvas';
import { SourceStudio, type SourceStudioYjsStatus } from './source-studio';

/**
 * Full catalog of every Workbench view. The visible list is derived from the
 * Host-supplied `features` (see {@link viewsFor}); a view that is not in the
 * current feature set is never rendered, never offered, and never used as a
 * fallback target.
 */
const WORKBENCH_VIEW_CATALOG = [
  { id: 'project-home', label: 'Project Home', glyph: '⌂' },
  { id: 'scene-canvas', label: 'Scene Canvas', glyph: '◇' },
  { id: 'source-studio', label: 'Source Studio', glyph: '≋' },
  { id: 'graph-route', label: 'Graph / Route', glyph: '↗' },
  { id: 'review-hub', label: 'Review Hub', glyph: '✓' },
  { id: 'publication', label: 'Publication', glyph: '◫' },
  { id: 'agent-chat', label: 'Agent Chat', glyph: '✳' },
] as const;

export type WorkbenchViewId = (typeof WORKBENCH_VIEW_CATALOG)[number]['id'];
export type HostStatus = 'unavailable' | 'loading' | 'empty' | 'error' | 'ready';

type ViewDefinition = (typeof WORKBENCH_VIEW_CATALOG)[number];

/**
 * Features shown whenever the Host has not supplied capabilities (null,
 * undefined, or an empty set): the four always-on views whose Host routes are
 * unconditionally registered by the composition root.
 */
const DEFAULT_FEATURES: readonly WorkbenchProjectFeatureV1[] = [
  'project-home',
  'source-studio',
  'scene-canvas',
  'graph-route',
];

const DEFAULT_VIEWS: ViewDefinition[] = WORKBENCH_VIEW_CATALOG.filter((view) =>
  DEFAULT_FEATURES.includes(view.id),
);

/**
 * Derive the visible view list from Host-supplied feature gates. Features
 * without a view in the catalog (e.g. `agent-chat`) are ignored and catalog
 * order is preserved, so the navigation order never depends on Host array
 * ordering.
 */
function viewsFor(
  features: readonly WorkbenchProjectFeatureV1[] | null | undefined,
): ViewDefinition[] {
  const visible = new Set(features ?? DEFAULT_FEATURES);
  const derived = WORKBENCH_VIEW_CATALOG.filter((view) => visible.has(view.id));
  return derived.length > 0 ? derived : DEFAULT_VIEWS;
}

export interface AppProps {
  /** The initial view is a local UI choice; it never identifies a project. */
  readonly initialView?: WorkbenchViewId;
  /** The shell stays honest until an authenticated Host supplies a status. */
  readonly hostStatus?: HostStatus;
  readonly initialNavigatorCollapsed?: boolean;
  readonly initialInspectorPinned?: boolean;
  readonly initialOperationCenterExpanded?: boolean;
  readonly onViewChange?: (view: WorkbenchViewId) => void;
  /**
   * Host-derived capability gates for the open project (null = no Host). The
   * visible navigation is derived from these features; a hidden view is never
   * rendered, never offered, and never used as a fallback target.
   */
  readonly features?: readonly WorkbenchProjectFeatureV1[] | null;
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
  /** Cancel one durable operation from the Operation Center (queued/running). */
  readonly onCancelOperation?: (operationId: string) => void | Promise<void>;
  readonly sourceSessionId?: string | null;
  readonly sourceYjsStatus?: Readonly<Record<string, SourceStudioYjsStatus>>;
  readonly onConnectSourceYjs?: (descriptor: SourceStudioDocumentDescriptorV1) => void;
  readonly onSubmitSource?: (descriptor: SourceStudioDocumentDescriptorV1) => void;
  readonly onSubmitAuthoring?: (request: BrowserAuthoringSubmitRequestV1) => void | Promise<void>;
  readonly onReconcileAuthoring?: (
    request: BrowserAuthoringReconcileRequestV1,
  ) => void | Promise<void>;
  readonly onCreateDocument?: (
    request: BrowserAuthoringDocumentCreateRequestV1,
  ) => void | Promise<void>;
  readonly onMoveDocument?: (
    request: BrowserAuthoringDocumentMoveRequestV1,
  ) => void | Promise<void>;
  readonly onDeleteDocument?: (
    request: BrowserAuthoringDocumentDeleteRequestV1,
  ) => void | Promise<void>;
  readonly onGraphRouteChange?: (selector: WorkbenchRouteSelectorV1) => void;
  readonly onSourceYjsStatusChange?: (
    descriptor: SourceStudioDocumentDescriptorV1,
    status: SourceStudioYjsStatus,
  ) => void;
  /** Explicit, Host-derived adoption preview for the selected Scene Canvas. */
  readonly sceneAdoption?: SceneAdoptionViewV1 | null;
  readonly onRequestAdoption?: (candidate: SceneAdoptionViewV1) => void;
  /** Host review projection for the Review Hub surface. */
  readonly reviewState?: BrowserReviewListV1 | null;
  readonly reviewGates?: BrowserReviewGateListV1 | null;
  readonly reviewHistory?: BrowserReviewHistoryV1 | null;
  /** Project membership role; mutations are offered only when grants allow. */
  readonly sessionProjectRole?: ProjectAccessRole | null;
  readonly onAddReviewComment?: (request: BrowserReviewAddRequestV1) => void | Promise<void>;
  readonly onUpdateReviewComment?: (request: BrowserReviewUpdateRequestV1) => void | Promise<void>;
  readonly onDecideReviewGate?: (request: BrowserReviewGateDecideRequestV1) => void | Promise<void>;
  readonly onRefreshReview?: () => void | Promise<void>;
  /** Host publication catalog for the Publication surface. */
  readonly publications?: BrowserPublicationListV1 | null;
  /** Publish the canonical novel or a custom branch artifact. */
  readonly onPublish?: (request: BrowserPublishRequestV1) => void | Promise<void>;
  /** Re-requests the Host publication catalog after a publish. */
  readonly onRefreshPublication?: () => void | Promise<void>;
  /** Reads one bounded slice of a publication artifact (download flow). */
  readonly onReadPublication?: (
    projectId: string,
    publicationId: string,
    query?: BrowserPublicationReadQueryV1,
  ) => Promise<BrowserPublicationReadResultV1>;
  /**
   * Agent chat surface (plan 9.5): supplied only when the Host feature set
   * includes `agent-chat`; absent here the view is never rendered.
   */
  readonly agentChat?: { readonly projectId: string; readonly client: AgentChatClient } | null;
}

export interface NavigatorProps {
  readonly activeView: WorkbenchViewId;
  /** Visible views derived from the Host-supplied feature gates. */
  readonly views: readonly ViewDefinition[];
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
  /** Cancel one durable operation (queued/running only); absent hides the action. */
  readonly onCancelOperation?: (operationId: string) => void | Promise<void>;
}

interface WorkspaceProps {
  readonly activeView: WorkbenchViewId;
  /** Visible views derived from the Host-supplied feature gates. */
  readonly views: readonly ViewDefinition[];
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
  readonly onCreateDocument?: (
    request: BrowserAuthoringDocumentCreateRequestV1,
  ) => void | Promise<void>;
  readonly onMoveDocument?: (
    request: BrowserAuthoringDocumentMoveRequestV1,
  ) => void | Promise<void>;
  readonly onDeleteDocument?: (
    request: BrowserAuthoringDocumentDeleteRequestV1,
  ) => void | Promise<void>;
  readonly onGraphRouteChange?: (selector: WorkbenchRouteSelectorV1) => void;
  readonly onSourceYjsStatusChange?: (
    descriptor: SourceStudioDocumentDescriptorV1,
    status: SourceStudioYjsStatus,
  ) => void;
  readonly sceneAdoption?: SceneAdoptionViewV1 | null;
  readonly onRequestAdoption?: (candidate: SceneAdoptionViewV1) => void;
  readonly reviewState?: BrowserReviewListV1 | null;
  readonly reviewGates?: BrowserReviewGateListV1 | null;
  readonly reviewHistory?: BrowserReviewHistoryV1 | null;
  readonly sessionProjectRole?: ProjectAccessRole | null;
  readonly onAddReviewComment?: (request: BrowserReviewAddRequestV1) => void | Promise<void>;
  readonly onUpdateReviewComment?: (request: BrowserReviewUpdateRequestV1) => void | Promise<void>;
  readonly onDecideReviewGate?: (request: BrowserReviewGateDecideRequestV1) => void | Promise<void>;
  readonly onRefreshReview?: () => void | Promise<void>;
  readonly publications?: BrowserPublicationListV1 | null;
  readonly onPublish?: (request: BrowserPublishRequestV1) => void | Promise<void>;
  readonly onRefreshPublication?: () => void | Promise<void>;
  readonly onReadPublication?: (
    projectId: string,
    publicationId: string,
    query?: BrowserPublicationReadQueryV1,
  ) => Promise<BrowserPublicationReadResultV1>;
  readonly agentChat?: { readonly projectId: string; readonly client: AgentChatClient } | null;
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

function viewById(viewId: WorkbenchViewId, available: readonly ViewDefinition[]): ViewDefinition {
  return available.find((view) => view.id === viewId) ?? available[0];
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
        <For each={props.views}>
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
  const view = () => viewById(props.activeView, props.views);
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
          <p>{copy().description}</p>
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
          onCreateDocument={props.onCreateDocument}
          onMoveDocument={props.onMoveDocument}
          onDeleteDocument={props.onDeleteDocument}
          onYjsStatusChange={props.onSourceYjsStatusChange}
        />
      </Show>
      <Show when={props.hostStatus === 'ready' && props.activeView === 'scene-canvas'}>
        <SceneCanvas
          adoption={props.sceneAdoption ?? null}
          onRequestAdoption={props.onRequestAdoption}
        />
      </Show>
      <Show when={props.hostStatus === 'ready' && props.activeView === 'review-hub'}>
        <ReviewHub
          projectId={props.overview?.projectId ?? null}
          review={props.reviewState ?? null}
          gates={props.reviewGates ?? null}
          history={props.reviewHistory ?? null}
          sessionRole={props.sessionProjectRole ?? null}
          onAddComment={props.onAddReviewComment}
          onUpdateComment={props.onUpdateReviewComment}
          onDecideGate={props.onDecideReviewGate}
          onRefresh={props.onRefreshReview}
        />
      </Show>
      <Show when={props.hostStatus === 'ready' && props.activeView === 'publication'}>
        <PublicationView
          projectId={props.overview?.projectId ?? null}
          publications={props.publications ?? null}
          sessionRole={props.sessionProjectRole ?? null}
          onPublish={props.onPublish}
          onRefresh={props.onRefreshPublication}
          onReadPublication={props.onReadPublication}
        />
      </Show>
      <Show
        when={
          props.hostStatus === 'ready' &&
          props.activeView === 'agent-chat' &&
          props.agentChat !== undefined &&
          props.agentChat !== null
        }
      >
        <AgentChat projectId={props.agentChat!.projectId} client={props.agentChat!.client} />
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

function OperationStatus(props: { readonly operation: AuthoringOperationReceiptV1 }) {
  const { operation } = props;
  return (
    <span class="flex min-w-0 flex-col items-end gap-[var(--wb-space-1)]">
      <span class="operation-status" data-status={operation.status}>
        {operation.status}
      </span>
      <Show when={operation.progress !== undefined && operation.progress !== null}>
        <span class="text-xs text-[var(--wb-text-muted)]" data-testid="operation-progress">
          {operation.progress?.completed}/{operation.progress?.total}
        </span>
      </Show>
    </span>
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
                  <span class="min-w-0">
                    <strong>{operation.kind}</strong> <code>{operation.operationId}</code>
                  </span>
                  <Show when={operation.errorCode !== null}>
                    <span class="text-xs text-[var(--wb-text-muted)]" data-testid="operation-error">
                      {operation.errorCode}
                    </span>
                  </Show>
                  <OperationStatus operation={operation} />
                  <Show when={operation.status === 'queued' || operation.status === 'running'}>
                    <button
                      class="text-button"
                      type="button"
                      data-testid={`cancel-operation-${operation.operationId}`}
                      onClick={() => void props.onCancelOperation?.(operation.operationId)}
                    >
                      Cancel
                    </button>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>
    </section>
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
  readonly views: readonly ViewDefinition[];
  readonly hostStatus: HostStatus;
  readonly layoutMode: WorkbenchLayoutMode;
  readonly navigatorOpen: boolean;
  readonly inspectorOpen: boolean;
  readonly onNavigatorToggle: () => void;
  readonly onInspectorToggle: () => void;
}

function Topbar(props: TopbarProps) {
  const view = () => viewById(props.activeView, props.views);
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
    </header>
  );
}

export function WorkbenchShell(props: AppProps = {}) {
  const stored = loadWorkbenchPreferences();
  const views = () => viewsFor(props.features);
  const initialView = props.initialView ?? stored.selectedNavigationView;
  // A stored or requested view that is not in the current feature set is
  // never activated: the shell starts on the first available view instead of
  // rendering an empty shell for a hidden one.
  const available = views();
  const initialVisibleView = available.some((view) => view.id === initialView)
    ? initialView
    : available[0].id;
  const [activeView, setActiveView] = createSignal<WorkbenchViewId>(initialVisibleView);
  const [navigatorCollapsed, setNavigatorCollapsed] = createSignal(
    props.initialNavigatorCollapsed ?? stored.navigatorCollapsed,
  );
  const [inspectorPinned, setInspectorPinned] = createSignal(
    props.initialInspectorPinned ?? stored.inspectorPinned,
  );
  const [operationCenterExpanded, setOperationCenterExpanded] = createSignal(
    props.initialOperationCenterExpanded ?? stored.operationCenterExpanded,
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
  const [selectedSourceDocumentId, setSelectedSourceDocumentId] = createSignal<string | null>(null);

  const selectSourceDocument = (descriptor: SourceStudioDocumentDescriptorV1): void => {
    setSelectedSourceDocumentId(descriptor.documentId);
    props.onConnectSourceYjs?.(descriptor);
  };

  const hostStatus = () => props.hostStatus ?? 'unavailable';

  const persistPreferences = (patch: Partial<WorkbenchPreferencesV1>) => {
    saveWorkbenchPreferences({
      version: stored.version,
      navigatorCollapsed: navigatorCollapsed(),
      inspectorPinned: inspectorPinned(),
      operationCenterExpanded: operationCenterExpanded(),
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

  const toggleNavigatorDrawer = () => setNavigatorDrawerOpen((open) => !open);
  const toggleInspectorDrawer = () => setInspectorDrawerOpen((open) => !open);

  return (
    <div
      class={`workbench-shell${navigatorCollapsed() ? ' navigator-is-collapsed' : ''}`}
      data-testid="workbench-shell"
      data-view={activeView()}
    >
      <Topbar
        activeView={activeView()}
        views={views()}
        hostStatus={hostStatus()}
        layoutMode={layoutMode()}
        navigatorOpen={navigatorDrawerOpen()}
        inspectorOpen={inspectorDrawerOpen()}
        onNavigatorToggle={toggleNavigatorDrawer}
        onInspectorToggle={toggleInspectorDrawer}
      />

      <div class="workbench-body">
        <Show when={layoutMode() !== 'mobile'}>
          <Navigator
            activeView={activeView()}
            views={views()}
            collapsed={navigatorCollapsed()}
            onCollapseToggle={toggleNavigator}
            onViewChange={chooseView}
          />
        </Show>

        <div class="workspace-column">
          <Workspace
            activeView={activeView()}
            views={views()}
            hostStatus={hostStatus()}
            overview={props.overview}
            graphProjection={props.graphProjection}
            sourceStudio={props.sourceStudio}
            authoringState={props.authoringState}
            authoringOperations={props.authoringOperations}
            authoringRevisionHistory={props.authoringRevisionHistory}
            authoringRevision={props.authoringRevision}
            authoringRevisionDiff={props.authoringRevisionDiff}
            onListAuthoringRevisions={props.onListAuthoringRevisions}
            onGetAuthoringRevision={props.onGetAuthoringRevision}
            onDiffAuthoringRevisions={props.onDiffAuthoringRevisions}
            onRestoreAuthoringRevision={props.onRestoreAuthoringRevision}
            sourceSessionId={props.sourceSessionId}
            sourceYjsStatus={props.sourceYjsStatus}
            onConnectSourceYjs={selectSourceDocument}
            onSubmitSource={props.onSubmitSource}
            onSubmitAuthoring={props.onSubmitAuthoring}
            onReconcileAuthoring={props.onReconcileAuthoring}
            onCreateDocument={props.onCreateDocument}
            onMoveDocument={props.onMoveDocument}
            onDeleteDocument={props.onDeleteDocument}
            onGraphRouteChange={props.onGraphRouteChange}
            selectedSourceDocumentId={selectedSourceDocumentId()}
            onSourceYjsStatusChange={props.onSourceYjsStatusChange}
            sceneAdoption={props.sceneAdoption}
            onRequestAdoption={props.onRequestAdoption}
            reviewState={props.reviewState}
            reviewGates={props.reviewGates}
            reviewHistory={props.reviewHistory}
            sessionProjectRole={props.sessionProjectRole}
            onAddReviewComment={props.onAddReviewComment}
            onUpdateReviewComment={props.onUpdateReviewComment}
            onDecideReviewGate={props.onDecideReviewGate}
            onRefreshReview={props.onRefreshReview}
            publications={props.publications}
            onPublish={props.onPublish}
            onRefreshPublication={props.onRefreshPublication}
            onReadPublication={props.onReadPublication}
            agentChat={props.agentChat}
          />
          <OperationCenter
            expanded={operationCenterExpanded()}
            operations={props.authoringOperations}
            onCancelOperation={props.onCancelOperation}
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
            views={views()}
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
    </div>
  );
}

export function App(props: AppProps = {}): JSX.Element {
  return <WorkbenchShell {...props} />;
}

export default App;
