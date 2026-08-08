import { Dialog } from '@kobalte/core/dialog';
import type { JSX } from 'solid-js';
import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import type {
  AgentViewContextV1,
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
  BrowserProjectReferenceImportResultV1,
  BrowserProjectReferenceListV1,
  BrowserProjectReferenceReadQueryV1,
  BrowserProjectReferenceReadResultV1,
  BrowserProjectReferenceRetryResultV1,
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
  SceneDetailViewV1,
  SceneMapViewV1,
  SourceStudioDocumentDescriptorV1,
  SourceStudioStateV1,
  WorkbenchGraphProjectionV1,
  WorkbenchProjectFeatureV1,
  WorkbenchRouteSelectorV1,
} from '../contracts/index.js';
import { AgentChat, agentViewLabel } from './AgentChat';
import type { AgentChatClient } from './agent-chat-client.js';
import { PublicationView } from './PublicationView';
import {
  loadWorkbenchPreferences,
  saveWorkbenchPreferences,
  type WorkbenchPreferencesV1,
} from './preferences';
import { GraphRoute, ProjectHome } from './projection-views';
import { ReferencesView } from './ReferencesView';
import { ReviewHub } from './ReviewHub';
import { SceneMap } from './SceneMap';
import { SettingsView } from './SettingsView';
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
  { id: 'source-studio', label: 'Source Studio', glyph: '≋' },
  { id: 'graph-route', label: 'Graph / Route', glyph: '↗' },
  { id: 'scene-map', label: 'Scene Map', glyph: '▦' },
  { id: 'review-hub', label: 'Review Hub', glyph: '✓' },
  { id: 'scene-canvas', label: 'Scene Canvas', glyph: '◇' },
  { id: 'publication', label: 'Publication', glyph: '◫' },
  { id: 'references', label: 'References', glyph: '▤' },
  { id: 'settings', label: '设置', glyph: '⚙' },
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
 * Derive the visible view list from Host-supplied feature gates. Catalog
 * order is preserved, so the navigation order never depends on Host array
 * ordering; without Host features the always-on `DEFAULT_FEATURES` views
 * keep the shell honest.
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
  /** Browser route (`location.pathname`) supplied by the router wiring; feeds the agent context. */
  readonly route?: string;
  /** The shell stays honest until an authenticated Host supplies a status. */
  readonly hostStatus?: HostStatus;
  /** True while the workspace wiring reloads; the shell shows view-level skeletons. */
  readonly loading?: boolean;
  /** Live Host event-stream state; false renders the disconnect banner + red status dot. */
  readonly eventConnected?: boolean;
  readonly initialNavigatorCollapsed?: boolean;
  readonly initialOperationCenterExpanded?: boolean;
  /**
   * View change notification. The parameter is widened to `string` so the
   * Agent chat surface (whose artifact chips name views) can forward it
   * without a cast; the shell validates against the visible catalog.
   */
  readonly onViewChange?: (view: string) => void;
  /**
   * Open the admin Provider settings (agent enablement). Absent in hosts
   * without navigation, the agent-unavailable banner renders text only
   * (plan 9.4.3).
   */
  readonly onOpenSettings?: () => void;
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
  /** Adoption preview load failure; non-null renders a distinct retry state. */
  readonly sceneAdoptionError?: string | null;
  /** Re-requests the last adoption preview after a load failure. */
  readonly onRetryAdoption?: () => void | Promise<void>;
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
  /** Review Hub load failure from the Host surface; non-null renders a retry state. */
  readonly reviewError?: string | null;
  /** Host publication catalog for the Publication surface. */
  readonly publications?: BrowserPublicationListV1 | null;
  /** Catalog load failure from the Host surface; non-null renders a retry state. */
  readonly publicationsError?: string | null;
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
   * Reference library surface (plan 9.1): the first server page plus the
   * mutation/read callbacks. Supplied only when the Host feature set
   * includes `references`; absent here the view is never rendered.
   */
  readonly references?: BrowserProjectReferenceListV1 | null;
  /** Catalog load failure from the Host surface; non-null renders a retry state. */
  readonly referencesError?: string | null;
  /** Re-requests the first server page after an import or delete. */
  readonly onRefreshReferences?: () => void | Promise<void>;
  /** Fetches one more server page for the accumulated list. */
  readonly onLoadMoreReferences?: (cursor: string) => Promise<BrowserProjectReferenceListV1 | null>;
  /** Uploads one file through the Host's durable three-phase import. */
  readonly onImportReference?: (file: File) => Promise<BrowserProjectReferenceImportResultV1>;
  /** Re-runs one failed import job from its persisted chunks. */
  readonly onRetryReference?: (
    jobId: string,
  ) => Promise<BrowserProjectReferenceRetryResultV1 | null>;
  /** Deletes one reference through the Host's durable delete job. */
  readonly onDeleteReference?: (referenceId: string) => void | Promise<void>;
  /** Reads one bounded content slice for the detail preview. */
  readonly onReadReferenceContent?: (
    referenceId: string,
    query?: BrowserProjectReferenceReadQueryV1,
  ) => Promise<BrowserProjectReferenceReadResultV1 | null>;
  /**
  /**
   * Scene Map surface (plan 9.2): chapter-grouped map projection plus the
   * selected scene's detail for the inline Scene Inspector. Supplied only
   * when the Host feature set includes `scene-map`; absent here the view is
   * never rendered.
   */
  readonly sceneMap?: SceneMapViewV1 | null;
  /** Map load failure from the Host surface; non-null renders a retry state. */
  readonly sceneMapError?: string | null;
  readonly sceneDetail?: SceneDetailViewV1 | null;
  readonly sceneDetailError?: string | null;
  /** True while the workspace wiring is running the render trigger. */
  readonly sceneRenderBusy?: boolean;
  /** Render queue notice (operation id) after a successful trigger. */
  readonly sceneRenderNotice?: string | null;
  /** Render trigger failure message. */
  readonly sceneRenderError?: string | null;
  /** Re-requests the Host scene map (after render/adoption mutations). */
  readonly onRefreshSceneMap?: () => void | Promise<void>;
  /** Row click handler; the workspace wiring loads the scene detail. */
  readonly onSelectScene?: (eventId: string) => void | Promise<void>;
  /** Author+ render trigger for the selected scene. */
  readonly onRenderScene?: (eventId: string) => void | Promise<void>;
  /**
   * Agent chat surface (plan 9.5): supplied only when the Host feature set
   * includes `agent-chat`; the global drawer renders this surface when
   * present and a guidance panel when it is absent.
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
  /** View change forwarding for the Agent chat artifact chips (string views). */
  readonly onViewChange?: (view: string) => void;
  /** Open the admin Provider settings from the agent-unavailable banner. */
  readonly onOpenSettings?: () => void;
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
  readonly publicationsError?: string | null;
  readonly onPublish?: (request: BrowserPublishRequestV1) => void | Promise<void>;
  readonly onRefreshPublication?: () => void | Promise<void>;
  readonly onReadPublication?: (
    projectId: string,
    publicationId: string,
    query?: BrowserPublicationReadQueryV1,
  ) => Promise<BrowserPublicationReadResultV1>;
  readonly references?: BrowserProjectReferenceListV1 | null;
  readonly referencesError?: string | null;
  readonly onRefreshReferences?: () => void | Promise<void>;
  readonly onLoadMoreReferences?: (cursor: string) => Promise<BrowserProjectReferenceListV1 | null>;
  readonly onImportReference?: (file: File) => Promise<BrowserProjectReferenceImportResultV1>;
  readonly onRetryReference?: (
    jobId: string,
  ) => Promise<BrowserProjectReferenceRetryResultV1 | null>;
  readonly onDeleteReference?: (referenceId: string) => void | Promise<void>;
  readonly onReadReferenceContent?: (
    referenceId: string,
    query?: BrowserProjectReferenceReadQueryV1,
  ) => Promise<BrowserProjectReferenceReadResultV1 | null>;
  readonly sceneMap?: SceneMapViewV1 | null;
  readonly sceneMapError?: string | null;
  readonly sceneDetail?: SceneDetailViewV1 | null;
  readonly sceneDetailError?: string | null;
  readonly sceneRenderBusy?: boolean;
  readonly sceneRenderNotice?: string | null;
  readonly sceneRenderError?: string | null;
  readonly onRefreshSceneMap?: () => void | Promise<void>;
  readonly onSelectScene?: (eventId: string) => void | Promise<void>;
  readonly onRenderScene?: (eventId: string) => void | Promise<void>;
  readonly loading?: boolean;
  readonly eventConnected?: boolean;
  readonly reviewError?: string | null;
  readonly sceneAdoptionError?: string | null;
  readonly onRetryAdoption?: () => void | Promise<void>;
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
        <span
          class={`host-status host-status-${props.hostStatus}${
            props.eventConnected === false ? ' host-status-disconnected' : ''
          }`}
        >
          <span class="status-dot" aria-hidden="true" />
          {props.eventConnected === false ? 'Host 连接中断，正在重连…' : copy().label}
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

      <Show
        when={!props.loading}
        fallback={
          <div
            class="workspace-skeleton"
            data-testid="workspace-skeleton"
            aria-busy="true"
            role="status"
          >
            <div class="skeleton skeleton-title" />
            <div class="skeleton skeleton-row" />
            <div class="skeleton skeleton-row" />
            <div class="skeleton skeleton-list" />
          </div>
        }
      >
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
            adoptionError={props.sceneAdoptionError ?? null}
            onRetryAdoption={props.onRetryAdoption}
          />
        </Show>
        <Show when={props.hostStatus === 'ready' && props.activeView === 'review-hub'}>
          <ReviewHub
            projectId={props.overview?.projectId ?? null}
            review={props.reviewState ?? null}
            gates={props.reviewGates ?? null}
            reviewError={props.reviewError ?? null}
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
            publicationsError={props.publicationsError ?? null}
            sessionRole={props.sessionProjectRole ?? null}
            onPublish={props.onPublish}
            onRefresh={props.onRefreshPublication}
            onReadPublication={props.onReadPublication}
          />
        </Show>
        <Show when={props.hostStatus === 'ready' && props.activeView === 'references'}>
          <ReferencesView
            projectId={props.overview?.projectId ?? null}
            references={props.references ?? null}
            referencesError={props.referencesError ?? null}
            sessionRole={props.sessionProjectRole ?? null}
            onRefresh={props.onRefreshReferences}
            onLoadMore={props.onLoadMoreReferences}
            onImport={props.onImportReference}
            onRetry={props.onRetryReference}
            onDelete={props.onDeleteReference}
            onReadContent={props.onReadReferenceContent}
          />
        </Show>
        <Show when={props.hostStatus === 'ready' && props.activeView === 'settings'}>
          <SettingsView
            projectId={props.overview?.projectId ?? null}
            sessionRole={props.sessionProjectRole ?? null}
            sessionId={props.sourceSessionId ?? null}
          />
        </Show>
        <Show when={props.hostStatus === 'ready' && props.activeView === 'scene-map'}>
          <SceneMap
            projectId={props.overview?.projectId ?? null}
            map={props.sceneMap ?? null}
            mapError={props.sceneMapError ?? null}
            detail={props.sceneDetail ?? null}
            detailError={props.sceneDetailError ?? null}
            adoption={props.sceneAdoption ?? null}
            sessionRole={props.sessionProjectRole ?? null}
            renderBusy={props.sceneRenderBusy ?? false}
            renderNotice={props.sceneRenderNotice ?? null}
            renderError={props.sceneRenderError ?? null}
            onSelectScene={props.onSelectScene}
            onRenderScene={props.onRenderScene}
            onRequestAdoption={props.onRequestAdoption}
            onRefresh={props.onRefreshSceneMap}
            sourceSessionId={props.sourceSessionId ?? null}
          />
        </Show>
      </Show>
    </main>
  );
}

function OperationStatus(props: { readonly operation: AuthoringOperationReceiptV1 }) {
  const { operation } = props;
  return (
    <span class="flex min-w-0 flex-col items-end gap-(--wb-space-1)">
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
  readonly connected: boolean;
  readonly layoutMode: WorkbenchLayoutMode;
  readonly navigatorOpen: boolean;
  readonly agentOpen: boolean;
  readonly onNavigatorToggle: () => void;
  readonly onAgentToggle: () => void;
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
        <span
          class={`topbar-status topbar-status-${props.hostStatus}${
            props.connected ? '' : ' topbar-status-disconnected'
          }`}
        >
          <span class="status-dot" aria-hidden="true" />
          {props.connected ? copy().label : 'Host 连接中断，正在重连…'}
        </span>
      </div>

      <button
        class="agent-drawer-toggle icon-button"
        type="button"
        aria-label={props.agentOpen ? 'Close Agent Shelf' : 'Open Agent Shelf'}
        aria-expanded={props.agentOpen}
        title={props.agentOpen ? '收起 Agent' : '展开 Agent'}
        onClick={props.onAgentToggle}
      >
        <span aria-hidden="true">✳</span>
      </button>

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
        </fieldset>
      </Show>
    </header>
  );
}

/**
 * Static view → available-agent-action map for the agent context snapshot.
 * Display strings only; the Host folds them into the run prompt as hints,
 * never as commands.
 */
const VIEW_AGENT_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  'project-home': ['查看项目概览'],
  'source-studio': ['查看文稿', '提交文稿'],
  'graph-route': ['查看图谱'],
  'scene-map': ['查看场景', '提交场景'],
  'review-hub': ['查看门禁', '提交审校'],
  'scene-canvas': ['查看场景画布'],
  publication: ['查看发布产物'],
  references: ['查看参考资料'],
  settings: ['查看设置'],
};

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
  const [agentOpen, setAgentOpen] = createSignal(true);
  const [activeView, setActiveView] = createSignal<WorkbenchViewId>(initialVisibleView);
  const [navigatorCollapsed, setNavigatorCollapsed] = createSignal(
    props.initialNavigatorCollapsed ?? stored.navigatorCollapsed,
  );

  const [operationCenterExpanded, setOperationCenterExpanded] = createSignal(
    props.initialOperationCenterExpanded ?? stored.operationCenterExpanded,
  );
  const [layoutMode, setLayoutMode] = createSignal<WorkbenchLayoutMode>('desktop');
  const [navigatorDrawerOpen, setNavigatorDrawerOpen] = createSignal(false);

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
  /** Secret-free snapshot of the current view + project, folded into every agent run. */
  const agentContext = createMemo<AgentViewContextV1>(() => {
    const view = activeView();
    const overview = props.overview;
    return {
      route: props.route ?? '',
      view,
      projectId: overview?.projectId,
      projectName: overview?.metadata.displayName,
      visible: [agentViewLabel(view)],
      actions: VIEW_AGENT_ACTIONS[view] ?? [],
    };
  });

  const persistPreferences = (patch: Partial<WorkbenchPreferencesV1>) => {
    saveWorkbenchPreferences({
      version: stored.version,
      navigatorCollapsed: navigatorCollapsed(),

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

  const toggleOperationCenter = () => {
    const expanded = !operationCenterExpanded();
    setOperationCenterExpanded(expanded);
    persistPreferences({ operationCenterExpanded: expanded });
  };

  const toggleNavigatorDrawer = () => setNavigatorDrawerOpen((open) => !open);

  return (
    <div
      class={`workbench-shell${navigatorCollapsed() ? ' navigator-is-collapsed' : ''}${
        agentOpen() ? ' agent-shelf-open' : ''
      }`}
      data-testid="workbench-shell"
      data-view={activeView()}
    >
      <Topbar
        activeView={activeView()}
        views={views()}
        hostStatus={hostStatus()}
        connected={props.eventConnected ?? true}
        layoutMode={layoutMode()}
        navigatorOpen={navigatorDrawerOpen()}
        onNavigatorToggle={toggleNavigatorDrawer}
        agentOpen={agentOpen()}
        onAgentToggle={() => setAgentOpen((open) => !open)}
      />
      <Show when={props.eventConnected === false}>
        <div class="host-disconnect-banner" role="status" data-testid="host-disconnect-banner">
          与 Host 的连接中断，正在重连…
        </div>
      </Show>

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
            loading={props.loading}
            eventConnected={props.eventConnected}
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
            onViewChange={props.onViewChange}
            onOpenSettings={props.onOpenSettings}
            selectedSourceDocumentId={selectedSourceDocumentId()}
            onSourceYjsStatusChange={props.onSourceYjsStatusChange}
            sceneAdoption={props.sceneAdoption}
            onRequestAdoption={props.onRequestAdoption}
            sceneAdoptionError={props.sceneAdoptionError}
            onRetryAdoption={props.onRetryAdoption}
            reviewState={props.reviewState}
            reviewGates={props.reviewGates}
            reviewHistory={props.reviewHistory}
            sessionProjectRole={props.sessionProjectRole}
            reviewError={props.reviewError}
            onAddReviewComment={props.onAddReviewComment}
            onUpdateReviewComment={props.onUpdateReviewComment}
            onDecideReviewGate={props.onDecideReviewGate}
            publications={props.publications}
            publicationsError={props.publicationsError}
            onPublish={props.onPublish}
            onRefreshPublication={props.onRefreshPublication}
            onReadPublication={props.onReadPublication}
            references={props.references}
            referencesError={props.referencesError}
            onRefreshReferences={props.onRefreshReferences}
            onLoadMoreReferences={props.onLoadMoreReferences}
            onImportReference={props.onImportReference}
            onRetryReference={props.onRetryReference}
            onDeleteReference={props.onDeleteReference}
            onReadReferenceContent={props.onReadReferenceContent}
            sceneMap={props.sceneMap}
            sceneMapError={props.sceneMapError}
            sceneDetail={props.sceneDetail}
            sceneDetailError={props.sceneDetailError}
            sceneRenderBusy={props.sceneRenderBusy}
            sceneRenderNotice={props.sceneRenderNotice}
            sceneRenderError={props.sceneRenderError}
            onRefreshSceneMap={props.onRefreshSceneMap}
            onSelectScene={props.onSelectScene}
            onRenderScene={props.onRenderScene}
          />
          <OperationCenter
            expanded={operationCenterExpanded()}
            operations={props.authoringOperations}
            onCancelOperation={props.onCancelOperation}
            onExpandedToggle={toggleOperationCenter}
          />
        </div>

        <Show when={agentOpen()}>
          <aside class="agent-drawer" data-testid="agent-shelf" aria-label="Agent">
            <Show
              when={props.agentChat}
              fallback={
                <div class="agent-drawer-guidance" data-testid="agent-drawer-guidance">
                  <p class="region-kicker">Agent</p>
                  <p class="agent-drawer-guidance-copy">选择一个项目后,Agent 将在这里就绪</p>
                </div>
              }
            >
              {(surface) => (
                <AgentChat
                  projectId={surface().projectId}
                  client={surface().client}
                  hostStatus={hostStatus()}
                  onViewChange={props.onViewChange}
                  onOpenSettings={props.onOpenSettings}
                  context={agentContext()}
                />
              )}
            </Show>
          </aside>
        </Show>
      </div>
      <Show when={!agentOpen()}>
        <button
          class="agent-drawer-fab"
          type="button"
          aria-label="Open Agent Shelf"
          onClick={() => setAgentOpen(true)}
        >
          <span aria-hidden="true">✳</span>
        </button>
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
      </Show>
    </div>
  );
}

export function App(props: AppProps = {}): JSX.Element {
  return <WorkbenchShell {...props} />;
}

export default App;
