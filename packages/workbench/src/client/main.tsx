import { createSignal, Show } from 'solid-js';
import { render } from 'solid-js/web';
import type {
  BrowserProjectOverviewV1,
  SourceStudioStateV1,
  WorkbenchGraphProjectionV1,
} from '../contracts/index.js';
import { App } from './App';
import { createBrowserReadClient } from './browser-read-client';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Workbench application root is missing');

function RuntimeApp() {
  let sessionId: string | undefined;
  const [userId, setUserId] = createSignal('owner');
  const [password, setPassword] = createSignal('');
  const [displayName, setDisplayName] = createSignal('Owner');
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [overview, setOverview] = createSignal<BrowserProjectOverviewV1 | null>(null);
  const [source, setSource] = createSignal<SourceStudioStateV1 | null>(null);
  const [graph, setGraph] = createSignal<WorkbenchGraphProjectionV1 | null>(null);

  const loadProjection = async (id: string): Promise<void> => {
    const client = createBrowserReadClient({ getSessionId: () => sessionId });
    await client.getSession();
    const projects = await client.listProjects();
    if (!projects.projects.some((project) => project.projectId === id))
      throw new Error('No authorized project is available');
    const selector = { version: 1 as const, branchPath: { decisions: [] } };
    const [nextOverview, nextSource, nextGraph] = await Promise.all([
      client.getOverview(id),
      client.getSourceStudio(id),
      client.getGraphs(id, selector),
    ]);
    setOverview(nextOverview);
    setSource(nextSource);
    setGraph(nextGraph);
  };

  const authenticate = async (
    path: '/api/v1/auth/login' | '/api/v1/auth/bootstrap',
  ): Promise<void> => {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(
        path.endsWith('login')
          ? { userId: userId(), password: password() }
          : { password: password(), displayName: displayName() },
      ),
    });
    const result = (await response.json().catch(() => null)) as {
      sessionId?: string;
      userId?: string;
      error?: string;
    } | null;
    if (!response.ok || !result?.sessionId)
      throw new Error(result?.error ?? 'Authentication failed');
    sessionId = result.sessionId;
    if (result.userId) setUserId(result.userId);
    const projects = await createBrowserReadClient({
      getSessionId: () => sessionId,
    }).listProjects();
    const first = projects.projects[0];
    if (!first) throw new Error('No project is registered in this Workbench');
    await loadProjection(first.projectId);
  };

  const runAuth =
    (path: '/api/v1/auth/login' | '/api/v1/auth/bootstrap') =>
    async (event: SubmitEvent): Promise<void> => {
      event.preventDefault();
      setLoading(true);
      setError(null);
      try {
        await authenticate(path);
      } catch (cause) {
        sessionId = undefined;
        setError(cause instanceof Error ? cause.message : 'Workbench connection failed');
      } finally {
        setLoading(false);
      }
    };

  return (
    <Show
      when={sessionId && overview()}
      fallback={
        <main style={{ 'max-width': '32rem', margin: '4rem auto', padding: '2rem' }}>
          <h1>Fabula Workbench</h1>
          <p>Authenticate with the Workbench Host. The session stays in memory.</p>
          <form onSubmit={runAuth('/api/v1/auth/login')}>
            <label>
              User ID
              <input
                value={userId()}
                onInput={(event) => setUserId(event.currentTarget.value)}
                autocomplete="username"
              />
            </label>
            <label>
              Password
              <input
                type="password"
                value={password()}
                onInput={(event) => setPassword(event.currentTarget.value)}
                autocomplete="current-password"
              />
            </label>
            <button type="submit" disabled={loading()}>
              {loading() ? 'Connecting…' : 'Sign in'}
            </button>
          </form>
          <details>
            <summary>First-run owner bootstrap (explicitly enabled by the Host)</summary>
            <form onSubmit={runAuth('/api/v1/auth/bootstrap')}>
              <label>
                Display name
                <input
                  value={displayName()}
                  onInput={(event) => setDisplayName(event.currentTarget.value)}
                />
              </label>
              <button type="submit" disabled={loading()}>
                Create owner and sign in
              </button>
            </form>
          </details>
          <Show when={error()}>
            <p role="alert">{error()}</p>
          </Show>
        </main>
      }
    >
      <App
        hostStatus="ready"
        overview={overview()}
        graphProjection={graph()}
        sourceStudio={source()}
      />
    </Show>
  );
}

render(() => <RuntimeApp />, root);
