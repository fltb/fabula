import { Navigate, Route, Router, useLocation, useNavigate } from '@solidjs/router';
import type { JSX } from 'solid-js';
import { createEffect, createSignal, Match, onCleanup, onMount, Show, Switch } from 'solid-js';
import { render } from 'solid-js/web';
import type {
  BrowserAuthoringDocumentCreateRequestV1,
  BrowserAuthoringDocumentDeleteRequestV1,
  BrowserAuthoringDocumentMoveRequestV1,
  BrowserAuthoringReconcileRequestV1,
  BrowserAuthoringRevisionDiffV1,
  BrowserAuthoringRevisionListV1,
  BrowserAuthoringRevisionRestoreRequestV1,
  BrowserAuthoringRevisionV1,
  BrowserAuthoringSubmitRequestV1,
  BrowserGraphRouteSelectorV1,
  BrowserProjectReferenceImportResultV1,
  BrowserProjectReferenceListV1,
  BrowserProjectReferenceReadQueryV1,
  BrowserProjectReferenceReadResultV1,
  BrowserProjectReferenceRetryResultV1,
  BrowserProjectSummaryV1,
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
  BrowserSessionPrincipalV1,
  ConfigOperationReceiptV1,
  ProjectAccessRole,
  SceneAdoptionViewV1,
  SceneDetailViewV1,
  SceneMapViewV1,
  SourceStudioDocumentDescriptorV1,
} from '../contracts/index.js';
import {
  createProjectEventClient,
  type ProjectEventClient,
  type ProjectEventClientSnapshot,
} from './project-event-client';
import {
  createRuntimeClient,
  requiresSetup,
  type RuntimeClient,
  type RuntimeWorkspace,
  runtimeErrorMessage,
  runtimeHealthForError,
} from './runtime-client';
import { LoginForm, ProjectPicker, RuntimeStatePanel } from './ui/RuntimeStates';
import { SetupWizard } from './ui/SetupWizard';
import './styles.css';
import { App } from './App';
import { AdminShell } from './admin/AdminShell';
import type { AdminAuthorizationState } from './admin/admin-client';

const root = document.getElementById('root');
const DEFAULT_GRAPH_SELECTOR: BrowserGraphRouteSelectorV1 = {
  version: 1,
  branchPath: { decisions: [] },
};

type StartupState = 'loading' | 'setup' | 'ready' | 'restart-required' | 'fatal';

interface RuntimeRouterProps {
  readonly client: RuntimeClient;
}

/**
 * The router owns only browser navigation. API, MCP, and Yjs paths are Host
 * routes and are intentionally absent here; static fallback configuration must
 * leave those requests to the Host rather than letting the SPA consume them.
 */
function RuntimeRouter(props: RuntimeRouterProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const [startup, setStartup] = createSignal<StartupState>('loading');
  const [startupError, setStartupError] = createSignal<string | null>(null);
  const [principal, setPrincipal] = createSignal<BrowserSessionPrincipalV1 | null>(null);

  onMount(() => {
    void (async () => {
      try {
        const status = await props.client.setup.getStatus();
        if (requiresSetup(status)) {
          setStartup('setup');
        } else {
          setStartup('ready');
        }
      } catch (error) {
        setStartupError(runtimeErrorMessage(error));
        setStartup('fatal');
      }
    })();
  });

  const onOwnerCreated = (sessionId: string) => {
    // Setup bootstrap returns the same transient session carrier used by
    // normal login. It is held in a closure and never enters storage/URL.
    props.client.auth.setSessionId(sessionId);
  };

  const onSetupComplete = (receipt: ConfigOperationReceiptV1) => {
    if (receipt.status === 'restart-required') {
      setStartup('restart-required');
      navigate('/setup', { replace: true });
      return;
    }
    setStartup('ready');
    void props.client.auth
      .getSession()
      .then((nextPrincipal) => setPrincipal(nextPrincipal))
      .catch(() => setPrincipal(null));
    navigate('/projects', { replace: true });
  };

  const login = async (input: { readonly userId: string; readonly password: string }) => {
    setStartupError(null);
    try {
      const nextPrincipal = await props.client.auth.login(input);
      setPrincipal(nextPrincipal);
      setStartup('ready');
      navigate('/projects', { replace: true });
    } catch (error) {
      setStartupError(runtimeErrorMessage(error));
      if (runtimeHealthForError(error) === 'fatal') setStartup('fatal');
    }
  };

  const openProject = (projectId: string) => {
    navigate(`/workspace/${encodeURIComponent(projectId)}`);
  };

  const retryStartup = () => {
    setStartupError(null);
    setStartup('loading');
    navigate('/', { replace: true });
    // A remount is not required for the status probe: routing to `/` and back
    // is a visible retry affordance while the Host remains authoritative.
    void (async () => {
      try {
        const status = await props.client.setup.getStatus();
        setStartup(requiresSetup(status) ? 'setup' : 'ready');
      } catch (error) {
        setStartupError(runtimeErrorMessage(error));
        setStartup('fatal');
      }
    })();
  };

  const setupRoute = () => (
    <Show
      when={startup() !== 'restart-required'}
      fallback={
        <RuntimeStatePanel
          state="configuration-restart-required"
          actionLabel="Check Host again"
          onAction={retryStartup}
        />
      }
    >
      <SetupWizard
        client={props.client.setup}
        onOwnerCreated={onOwnerCreated}
        onComplete={onSetupComplete}
        onStateChange={(state) => {
          if (state === 'configuration-restart-required') setStartup('restart-required');
        }}
        onAlreadyConfigured={() => navigate('/login', { replace: true })}
      />
    </Show>
  );

  const loginRoute = () => (
    <LoginForm pending={startup() === 'loading'} error={startupError()} onSubmit={login} />
  );

  // Loopback device trust: a passwordless owner (dummy hash) cannot log in
  // interactively, so the login view silently tries the loopback session
  // endpoint once; null (owner has a password, or non-loopback binding)
  // leaves the form visible.
  createEffect(() => {
    if (startup() !== 'ready' || props.client.auth.hasSession()) return;
    if (location.pathname !== '/login') return;
    void props.client.auth
      .loopback()
      .then((principal) => {
        if (principal === null) return;
        setPrincipal(principal);
        navigate('/projects', { replace: true });
      })
      .catch(() => {});
  });

  const workspaceRoute = () => {
    const encodedProjectId = location.pathname.slice('/workspace/'.length);
    try {
      return (
        <WorkspaceRoute
          client={props.client}
          projectId={decodeURIComponent(encodedProjectId)}
          onSignIn={() => navigate('/login')}
        />
      );
    } catch {
      return (
        <RuntimeStatePanel
          state="workspace"
          health="fatal"
          message="The project address is invalid."
        />
      );
    }
  };
  const projectsRoute = () => (
    <ProjectsRoute
      client={props.client}
      onSelect={openProject}
      onSignIn={() => navigate('/login')}
    />
  );
  const adminRoute = () => {
    const authorization: AdminAuthorizationState =
      principal() === null ? 'unauthorized' : principal()?.role === 'owner' ? 'owner' : 'user';
    return <AdminShell client={props.client.admin} authorization={authorization} />;
  };

  return (
    <Switch
      fallback={
        <RuntimeStatePanel
          state="fatal-host-error"
          health="fatal"
          message="The requested Workbench page does not exist."
        />
      }
    >
      <Match when={location.pathname === '/'}>
        <Show
          when={startup() !== 'loading'}
          fallback={<RuntimeStatePanel state="login" health="loading" />}
        >
          <Show
            when={startup() === 'setup'}
            fallback={
              <Show
                when={startup() === 'restart-required'}
                fallback={
                  <Show
                    when={startup() === 'ready'}
                    fallback={
                      <RuntimeStatePanel
                        state="fatal-host-error"
                        health="fatal"
                        message={startupError() ?? undefined}
                        actionLabel="Retry Host status"
                        onAction={retryStartup}
                      />
                    }
                  >
                    <Navigate href={props.client.auth.hasSession() ? '/projects' : '/login'} />
                  </Show>
                }
              >
                <RuntimeStatePanel
                  state="configuration-restart-required"
                  actionLabel="Check Host again"
                  onAction={retryStartup}
                />
              </Show>
            }
          >
            <Navigate href="/setup" />
          </Show>
        </Show>
      </Match>
      <Match when={location.pathname === '/setup'}>
        <Show when={startup() === 'setup'} fallback={<Navigate href="/" />}>
          {setupRoute()}
        </Show>
      </Match>
      <Match when={location.pathname === '/login'}>{loginRoute()}</Match>
      <Match when={location.pathname === '/projects'}>{projectsRoute()}</Match>
      <Match when={location.pathname.startsWith('/workspace/')}>{workspaceRoute()}</Match>
      <Match when={location.pathname === '/admin' || location.pathname.startsWith('/admin/')}>
        {adminRoute()}
      </Match>
    </Switch>
  );
}

function ProjectsRoute(props: {
  readonly client: RuntimeClient;
  readonly onSelect: (projectId: string) => void;
  readonly onSignIn: () => void;
}) {
  const [projects, setProjects] = createSignal<readonly BrowserProjectSummaryV1[]>([]);
  const [pending, setPending] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [health, setHealth] = createSignal<
    'empty' | 'disconnected' | 'unauthorized' | 'fatal' | null
  >(null);

  const load = async () => {
    if (!props.client.auth.hasSession()) {
      setHealth('unauthorized');
      setPending(false);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await props.client.projects.list();
      setProjects(result.projects);
      setHealth(result.projects.length === 0 ? 'empty' : null);
    } catch (cause) {
      setError(runtimeErrorMessage(cause));
      const nextHealth = runtimeHealthForError(cause);
      setHealth(nextHealth === 'ready' || nextHealth === 'loading' ? 'fatal' : nextHealth);
    } finally {
      setPending(false);
    }
  };

  onMount(() => void load());

  return (
    <Show
      when={health() !== 'unauthorized'}
      fallback={
        <main class="min-h-screen bg-[var(--wb-canvas)] px-[var(--wb-space-4)] py-[var(--wb-space-10)]">
          <RuntimeStatePanel
            state="project-picker"
            health="unauthorized"
            actionLabel="Sign in"
            onAction={props.onSignIn}
          />
        </main>
      }
    >
      <ProjectPicker
        projects={projects()}
        pending={pending()}
        error={error()}
        health={health() ?? undefined}
        onSelect={props.onSelect}
        onRetry={() => void load()}
      />
    </Show>
  );
}

function WorkspaceRoute(props: {
  readonly client: RuntimeClient;
  readonly projectId: string;
  readonly onSignIn: () => void;
}) {
  const [pending, setPending] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [health, setHealth] = createSignal<
    'empty' | 'disconnected' | 'unauthorized' | 'fatal' | null
  >(null);
  const [workspace, setWorkspace] = createSignal<RuntimeWorkspace | null>(null);
  const [authoring, setAuthoring] = createSignal<ProjectEventClientSnapshot | null>(null);
  const [revisionHistory, setRevisionHistory] = createSignal<BrowserAuthoringRevisionListV1 | null>(
    null,
  );
  const [selectedRevision, setSelectedRevision] = createSignal<BrowserAuthoringRevisionV1 | null>(
    null,
  );
  const [revisionDiff, setRevisionDiff] = createSignal<BrowserAuthoringRevisionDiffV1 | null>(null);
  const [reviewState, setReviewState] = createSignal<BrowserReviewListV1 | null>(null);
  const [reviewGates, setReviewGates] = createSignal<BrowserReviewGateListV1 | null>(null);
  const [reviewHistory, setReviewHistory] = createSignal<BrowserReviewHistoryV1 | null>(null);
  const [publications, setPublications] = createSignal<BrowserPublicationListV1 | null>(null);
  const [publicationsError, setPublicationsError] = createSignal<string | null>(null);
  const [references, setReferences] = createSignal<BrowserProjectReferenceListV1 | null>(null);
  const [sceneMap, setSceneMap] = createSignal<SceneMapViewV1 | null>(null);
  const [sceneMapError, setSceneMapError] = createSignal<string | null>(null);
  const [sceneDetail, setSceneDetail] = createSignal<SceneDetailViewV1 | null>(null);
  const [sceneDetailError, setSceneDetailError] = createSignal<string | null>(null);
  const [sceneRenderBusy, setSceneRenderBusy] = createSignal(false);
  const [sceneRenderNotice, setSceneRenderNotice] = createSignal<string | null>(null);
  const [sceneRenderError, setSceneRenderError] = createSignal<string | null>(null);
  const [referencesError, setReferencesError] = createSignal<string | null>(null);
  const [reviewError, setReviewError] = createSignal<string | null>(null);
  const [sceneAdoptionError, setSceneAdoptionError] = createSignal<string | null>(null);
  const [sceneAdoption, setSceneAdoption] = createSignal<SceneAdoptionViewV1 | null>(null);
  const [sessionProjectRole, setSessionProjectRole] = createSignal<ProjectAccessRole | null>(null);
  const [yjsStatus, setYjsStatus] = createSignal<
    Record<string, 'idle' | 'connecting' | 'connected' | 'disconnected' | 'unavailable'>
  >({});
  let eventClient: ProjectEventClient | null = null;
  // Last adoption preview pair, kept so the Scene Canvas Retry can re-request it.
  let lastAdoptionScene: { readonly eventId: string; readonly revisionId: string } | null = null;
  let loadGeneration = 0;

  const load = async (selector: BrowserGraphRouteSelectorV1 = DEFAULT_GRAPH_SELECTOR) => {
    const projectId = props.projectId;
    const generation = ++loadGeneration;
    eventClient?.stop();
    eventClient = null;
    setAuthoring(null);
    setYjsStatus({});
    setSessionProjectRole(null);
    setSceneAdoption(null);
    setPublicationsError(null);
    setReviewError(null);
    setSceneAdoptionError(null);
    setSceneMap(null);
    setSceneMapError(null);
    setSceneDetail(null);
    setSceneDetailError(null);
    setSceneRenderNotice(null);
    setSceneRenderError(null);
    setSceneRenderBusy(false);
    if (!projectId) {
      setError('No project was selected.');
      setHealth('fatal');
      setPending(false);
      return;
    }
    if (!props.client.auth.hasSession()) {
      setHealth('unauthorized');
      setPending(false);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const [nextWorkspace, nextHistory] = await Promise.all([
        props.client.projects.loadWorkspace(projectId, selector),
        props.client.authoring.listRevisions(projectId),
      ]);
      if (generation !== loadGeneration) return;
      setWorkspace(nextWorkspace);
      setRevisionHistory(nextHistory);
      setSelectedRevision(null);
      setRevisionDiff(null);
      setSessionProjectRole(nextWorkspace.projectRole);
      await refreshReview(nextWorkspace.capabilities?.features?.includes('review-hub') === true);
      await refreshPublication(
        nextWorkspace.capabilities?.features?.includes('publication') === true,
      );
      await refreshReferences(
        nextWorkspace.capabilities?.features?.includes('references') === true,
      );
      await refreshSceneMap(nextWorkspace.capabilities?.features?.includes('scene-map') === true);
      // The adoption preview is keyed by one released scene revision; the
      // workspace projection carries no scene-revision pointer, so the
      // load-time preview stays null (honest empty state) until a released
      // revision is named (see adoptScene).
      await refreshSceneAdoption(
        nextWorkspace.capabilities?.features?.includes('scene-canvas') === true,
        null,
      );
      const nextEvents = createProjectEventClient({
        projectId,
        client: props.client.authoring,
        onChange: (snapshot) => {
          if (generation === loadGeneration) setAuthoring(snapshot);
        },
      });
      eventClient = nextEvents;
      void nextEvents.start().catch(() => undefined);
    } catch (cause) {
      if (generation !== loadGeneration) return;
      setError(runtimeErrorMessage(cause));
      const nextHealth = runtimeHealthForError(cause);
      setHealth(nextHealth === 'ready' || nextHealth === 'loading' ? 'fatal' : nextHealth);
    } finally {
      if (generation === loadGeneration) setPending(false);
    }
  };

  onMount(() => void load());
  onCleanup(() => eventClient?.stop());

  const submitAuthoring = async (request: BrowserAuthoringSubmitRequestV1): Promise<void> => {
    await props.client.authoring.submit(request);
  };
  const cancelOperation = async (operationId: string): Promise<void> => {
    await props.client.authoring.cancelOperation(props.projectId, operationId);
  };
  const reconcileAuthoring = async (request: BrowserAuthoringReconcileRequestV1): Promise<void> => {
    await props.client.authoring.reconcile(request);
  };
  const createDocument = async (
    request: BrowserAuthoringDocumentCreateRequestV1,
  ): Promise<void> => {
    await props.client.authoring.createDocument(request);
    await load();
  };
  const moveDocument = async (request: BrowserAuthoringDocumentMoveRequestV1): Promise<void> => {
    await props.client.authoring.moveDocument(request);
    await load();
  };
  const deleteDocument = async (
    request: BrowserAuthoringDocumentDeleteRequestV1,
  ): Promise<void> => {
    await props.client.authoring.deleteDocument(request);
    await load();
  };
  const listAuthoringRevisions = async (): Promise<void> => {
    setRevisionHistory(await props.client.authoring.listRevisions(props.projectId));
  };
  const getAuthoringRevision = async (revisionId: string): Promise<void> => {
    const result = await props.client.authoring.getRevision(props.projectId, revisionId);
    setSelectedRevision(result.revision);
  };
  const diffAuthoringRevisions = async (
    fromRevisionId: string,
    toRevisionId: string,
  ): Promise<void> => {
    setRevisionDiff(
      await props.client.authoring.diffRevisions(props.projectId, fromRevisionId, toRevisionId),
    );
  };
  const restoreAuthoringRevision = async (
    request: BrowserAuthoringRevisionRestoreRequestV1,
  ): Promise<void> => {
    await props.client.authoring.restoreRevision(request);
    await load();
  };
  const updateYjsStatus = (
    descriptor: SourceStudioDocumentDescriptorV1,
    status: 'idle' | 'connecting' | 'connected' | 'disconnected' | 'unavailable',
  ): void => {
    setYjsStatus((current) => ({ ...current, [descriptor.documentId]: status }));
  };

  /**
   * Load the Review Hub projections. When the feature is absent (or the read
   * fails) the signals stay null and the view renders an honest empty state;
   * the workspace load itself never depends on the review surface.
   */
  const refreshReview = async (enabled: boolean): Promise<void> => {
    if (!enabled) {
      setReviewState(null);
      setReviewGates(null);
      setReviewHistory(null);
      setReviewError(null);
      return;
    }
    const failures: string[] = [];
    const capture = (cause: unknown): null => {
      failures.push(runtimeErrorMessage(cause));
      return null;
    };
    const [nextReview, nextGates, nextHistory] = await Promise.all([
      props.client.review.list(props.projectId).catch(capture),
      props.client.review.gateList(props.projectId).catch(capture),
      props.client.review.history(props.projectId).catch(capture),
    ]);
    setReviewState(nextReview);
    setReviewGates(nextGates);
    setReviewHistory(nextHistory);
    setReviewError(failures.length > 0 ? failures.join('; ') : null);
  };
  const addReviewComment = async (request: BrowserReviewAddRequestV1): Promise<void> => {
    await props.client.review.add(request);
  };
  const updateReviewComment = async (request: BrowserReviewUpdateRequestV1): Promise<void> => {
    await props.client.review.update(request);
  };
  const decideReviewGate = async (request: BrowserReviewGateDecideRequestV1): Promise<void> => {
    await props.client.review.gateDecide(request);
  };

  /**
   * Load the publication catalog. Absent feature or load failure keeps the
   * catalog signal null; a load failure additionally sets `publicationsError`
   * so the view renders a distinct error state with Retry instead of
   * conflating failure with an honest empty state. The workspace load itself
   * never depends on the publication surface.
   */
  const refreshPublication = async (enabled: boolean): Promise<void> => {
    if (!enabled) {
      setPublications(null);
      setPublicationsError(null);
      return;
    }
    try {
      setPublications(await props.client.publication.list(props.projectId));
      setPublicationsError(null);
    } catch (cause) {
      setPublications(null);
      setPublicationsError(runtimeErrorMessage(cause));
    }
  };
  const publish = async (request: BrowserPublishRequestV1): Promise<void> => {
    await props.client.publication.publish(request);
  };
  const readPublication = async (
    projectId: string,
    publicationId: string,
    query?: BrowserPublicationReadQueryV1,
  ): Promise<BrowserPublicationReadResultV1> =>
    props.client.publication.read(projectId, publicationId, query);
  /**
   * Load the first reference page. Absent feature or load failure keeps the
   * catalog signal null; a load failure additionally sets `referencesError`
   * so the view renders a distinct error state with Retry. The workspace
   * load itself never depends on the reference surface.
   */
  const refreshReferences = async (enabled: boolean): Promise<void> => {
    if (!enabled) {
      setReferences(null);
      setReferencesError(null);
      return;
    }
    try {
      setReferences(await props.client.read.listReferences(props.projectId));
      setReferencesError(null);
    } catch (cause) {
      setReferences(null);
      setReferencesError(runtimeErrorMessage(cause));
    }
  };
  /** One more server page; null keeps the view's accumulated list unchanged. */
  const loadMoreReferences = async (
    cursor: string,
  ): Promise<BrowserProjectReferenceListV1 | null> =>
    props.client.read.listReferences(props.projectId, { cursor }).catch(() => null);
  const importReference = async (file: File): Promise<BrowserProjectReferenceImportResultV1> =>
    props.client.read.importReference(props.projectId, file);
  const retryReference = async (
    jobId: string,
  ): Promise<BrowserProjectReferenceRetryResultV1 | null> =>
    props.client.read.retryReference(props.projectId, jobId).catch(() => null);
  const deleteReference = async (referenceId: string): Promise<void> => {
    await props.client.read.deleteReference(props.projectId, referenceId);
  };
  const readReferenceContent = async (
    referenceId: string,
    query?: BrowserProjectReferenceReadQueryV1,
  ): Promise<BrowserProjectReferenceReadResultV1 | null> =>
    props.client.read
      .getReferenceContent(props.projectId, referenceId, query ?? { offset: 0, limit: 1 })
      .catch(() => null);
  /**
   * Load the chapter-grouped Scene Map (plan 9.2). Absent feature or load
   * failure keeps the map signal null; a load failure additionally sets
   * `sceneMapError` so the view renders a distinct retry state. The
   * workspace load itself never depends on this surface.
   */
  const refreshSceneMap = async (enabled: boolean): Promise<void> => {
    if (!enabled) {
      setSceneMap(null);
      setSceneMapError(null);
      return;
    }
    try {
      setSceneMap(await props.client.read.getSceneMap(props.projectId));
      setSceneMapError(null);
    } catch (cause) {
      setSceneMap(null);
      setSceneMapError(runtimeErrorMessage(cause));
    }
  };
  /**
   * Row click: load the selected scene's detail projection for the inline
   * Scene Inspector, and refresh the adoption preview for the row's released
   * revision (the detail DTO carries no revision id; the map row does).
   */
  const selectScene = async (eventId: string): Promise<void> => {
    setSceneDetail(null);
    setSceneDetailError(null);
    try {
      setSceneDetail(await props.client.read.getSceneDetail(props.projectId, eventId));
    } catch (cause) {
      setSceneDetail(null);
      setSceneDetailError(runtimeErrorMessage(cause));
    }
    const row = sceneMap()
      ?.chapters.flatMap((chapter) => chapter.scenes)
      .find((scene) => scene.eventId === eventId);
    const revisionId = row?.revisionId ?? null;
    await refreshSceneAdoption(true, revisionId === null ? null : { eventId, revisionId });
  };
  /**
   * Author+ render trigger (plan 9.2.3). The POST enqueues the durable
   * operation Host-side; when a released revision exists for the current
   * source the result also carries the adoption preview the Inspector may
   * act on. The map and the open detail are refreshed afterwards.
   */
  const renderScene = async (eventId: string): Promise<void> => {
    if (sceneRenderBusy()) return;
    setSceneRenderBusy(true);
    setSceneRenderNotice(null);
    setSceneRenderError(null);
    try {
      const result = await props.client.read.triggerSceneRender(props.projectId, eventId);
      if (result.adoption !== undefined) setSceneAdoption(result.adoption);
      setSceneRenderNotice(`Render queued as operation ${result.operationId}.`);
      await refreshSceneMap(true);
      await selectScene(eventId);
    } catch (cause) {
      setSceneRenderError(runtimeErrorMessage(cause));
    } finally {
      setSceneRenderBusy(false);
    }
  };
  /**
   * Load the Scene Canvas adoption preview (plan 5.2). The Host preview is
   * keyed by exactly one released scene revision (`eventId` + `revisionId`);
   * without that pair the signal stays null and the view renders an honest
   * empty state. The workspace load itself never depends on this surface.
   */
  const refreshSceneAdoption = async (
    enabled: boolean,
    scene: { readonly eventId: string; readonly revisionId: string } | null,
  ): Promise<void> => {
    if (!enabled || scene === null) {
      setSceneAdoption(null);
      setSceneAdoptionError(null);
      return;
    }
    lastAdoptionScene = scene;
    try {
      setSceneAdoption(
        await props.client.read.getSceneAdoption(props.projectId, scene.eventId, scene.revisionId),
      );
      setSceneAdoptionError(null);
    } catch (cause) {
      setSceneAdoption(null);
      setSceneAdoptionError(runtimeErrorMessage(cause));
    }
  };
  /**
   * Explicit adoption request. The Host derives the authoring-manifest claim
   * from the persisted released revision (never from browser-supplied
   * hashes); this handler re-requests the Host-authoritative preview for the
   * named revision so the surface always reflects the server's claim
   * derivation. The durable adoption mutation route is a later stage.
   */
  const adoptScene = async (candidate: SceneAdoptionViewV1): Promise<void> => {
    await refreshSceneAdoption(true, {
      eventId: candidate.eventId,
      revisionId: candidate.revisionId,
    });
  };

  return (
    <Show
      when={workspace()}
      fallback={
        <RuntimeStatePanel
          state="workspace"
          health={pending() ? 'loading' : (health() ?? 'fatal')}
          message={error() ?? undefined}
          actionLabel={health() === 'unauthorized' ? 'Sign in' : 'Try again'}
          onAction={health() === 'unauthorized' ? props.onSignIn : () => void load()}
        />
      }
    >
      {(current) => (
        <App
          hostStatus="ready"
          loading={pending()}
          eventConnected={authoring()?.connected ?? true}
          features={current().capabilities?.features ?? null}
          agentChat={
            current().capabilities?.features?.includes('agent-chat') === true
              ? { projectId: props.projectId, client: props.client.agentChat }
              : null
          }
          overview={current().overview}
          graphProjection={current().graph}
          sourceStudio={current().source}
          authoringState={authoring()?.state}
          authoringOperations={authoring()?.operations}
          onCancelOperation={cancelOperation}
          authoringRevisionHistory={revisionHistory()}
          authoringRevision={selectedRevision()}
          authoringRevisionDiff={revisionDiff()}
          onListAuthoringRevisions={listAuthoringRevisions}
          onGetAuthoringRevision={getAuthoringRevision}
          onDiffAuthoringRevisions={diffAuthoringRevisions}
          onRestoreAuthoringRevision={restoreAuthoringRevision}
          sourceSessionId={props.client.auth.getSessionId()}
          sourceYjsStatus={yjsStatus()}
          onSubmitAuthoring={submitAuthoring}
          onReconcileAuthoring={reconcileAuthoring}
          onCreateDocument={createDocument}
          onMoveDocument={moveDocument}
          onDeleteDocument={deleteDocument}
          onGraphRouteChange={(selector) => void load(selector)}
          onSourceYjsStatusChange={updateYjsStatus}
          sceneAdoption={sceneAdoption()}
          onRequestAdoption={adoptScene}
          sceneAdoptionError={sceneAdoptionError()}
          onRetryAdoption={() => refreshSceneAdoption(true, lastAdoptionScene)}
          reviewState={reviewState()}
          reviewGates={reviewGates()}
          reviewHistory={reviewHistory()}
          reviewError={reviewError()}
          sessionProjectRole={sessionProjectRole()}
          onAddReviewComment={addReviewComment}
          onUpdateReviewComment={updateReviewComment}
          onDecideReviewGate={decideReviewGate}
          onRefreshReview={() =>
            refreshReview(current().capabilities?.features?.includes('review-hub') === true)
          }
          publications={publications()}
          publicationsError={publicationsError()}
          onPublish={publish}
          onRefreshPublication={() =>
            refreshPublication(current().capabilities?.features?.includes('publication') === true)
          }
          onReadPublication={readPublication}
          references={references()}
          referencesError={referencesError()}
          onRefreshReferences={() =>
            refreshReferences(current().capabilities?.features?.includes('references') === true)
          }
          onLoadMoreReferences={loadMoreReferences}
          onImportReference={importReference}
          onRetryReference={retryReference}
          onDeleteReference={deleteReference}
          onReadReferenceContent={readReferenceContent}
          sceneMap={sceneMap()}
          sceneMapError={sceneMapError()}
          sceneDetail={sceneDetail()}
          sceneDetailError={sceneDetailError()}
          sceneRenderBusy={sceneRenderBusy()}
          sceneRenderNotice={sceneRenderNotice()}
          sceneRenderError={sceneRenderError()}
          onRefreshSceneMap={() =>
            refreshSceneMap(current().capabilities?.features?.includes('scene-map') === true)
          }
          onSelectScene={selectScene}
          onRenderScene={renderScene}
        />
      )}
    </Show>
  );
}

export function RuntimeApp(): JSX.Element {
  const client = createRuntimeClient();
  return (
    <Router>
      <Route path="/*" component={() => <RuntimeRouter client={client} />} />
    </Router>
  );
}

if (root) render(() => <RuntimeApp />, root);
