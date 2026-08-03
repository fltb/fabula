import { Navigate, Route, Router, useLocation, useNavigate } from '@solidjs/router';
import type { JSX } from 'solid-js';
import { createSignal, Match, onCleanup, onMount, Show, Switch } from 'solid-js';
import { render } from 'solid-js/web';
import type {
  BrowserAuthoringReconcileRequestV1,
  BrowserAuthoringSubmitRequestV1,
  BrowserAuthoringRevisionDiffV1,
  BrowserAuthoringRevisionListV1,
  BrowserAuthoringRevisionRestoreRequestV1,
  BrowserAuthoringRevisionV1,
  BrowserGraphRouteSelectorV1,
  BrowserProjectSummaryV1,
  BrowserSessionPrincipalV1,
  ConfigOperationReceiptV1,
  SourceStudioDocumentDescriptorV1,
} from '../contracts/index.js';
import {
  createProjectEventClient,
  type ProjectEventClient,
  type ProjectEventClientSnapshot,
} from './project-event-client';
import {
  createRuntimeClient,
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
        if (!status.configurationPresent || status.phase !== 'ready') {
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
        setStartup(!status.configurationPresent || status.phase !== 'ready' ? 'setup' : 'ready');
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
      <Match when={location.pathname === '/setup'}>{setupRoute()}</Match>
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
  const [revisionHistory, setRevisionHistory] = createSignal<BrowserAuthoringRevisionListV1 | null>(null);
  const [selectedRevision, setSelectedRevision] = createSignal<BrowserAuthoringRevisionV1 | null>(null);
  const [revisionDiff, setRevisionDiff] = createSignal<BrowserAuthoringRevisionDiffV1 | null>(null);
  const [yjsStatus, setYjsStatus] = createSignal<
    Record<string, 'idle' | 'connecting' | 'connected' | 'disconnected' | 'unavailable'>
  >({});
  let eventClient: ProjectEventClient | null = null;
  let loadGeneration = 0;

  const load = async (selector: BrowserGraphRouteSelectorV1 = DEFAULT_GRAPH_SELECTOR) => {
    const projectId = props.projectId;
    const generation = ++loadGeneration;
    eventClient?.stop();
    eventClient = null;
    setAuthoring(null);
    setYjsStatus({});
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
  const reconcileAuthoring = async (request: BrowserAuthoringReconcileRequestV1): Promise<void> => {
    await props.client.authoring.reconcile(request);
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

  return (
    <Show
      when={!pending() && workspace()}
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
          overview={current().overview}
          graphProjection={current().graph}
          sourceStudio={current().source}
          authoringState={authoring()?.state}
          authoringOperations={authoring()?.operations}
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
          onGraphRouteChange={(selector) => void load(selector)}
          onSourceYjsStatusChange={updateYjsStatus}
          agentClient={props.client.agent}
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
