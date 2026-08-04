import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BROWSER_SETUP_STATUS_PATH,
  DEFAULT_WORKBENCH_REFERENCE_LIMITS_V2,
  type WorkbenchConfigurationV1,
} from '../src/contracts/configuration.js';
import { createAuthPersistence, LocalAuthService } from '../src/host/auth/index.js';
import { ConfigurationFileStore } from '../src/host/configuration-file-store.js';
import { ConfigurationChangeService } from '../src/host/configuration-service.js';
import type { HostListenerMode } from '../src/host/listener.js';
import {
  createHostListener,
  HostListenerError,
  HostListenerStateError,
} from '../src/host/listener.js';
import { createProviderCredentialStore } from '../src/host/providers/credential-store.js';
import { createHostServer, type HostServer } from '../src/host/server.js';
import {
  BROWSER_SETUP_FINISH_PATH,
  BROWSER_SETUP_NETWORK_PATH,
  BROWSER_SETUP_OWNER_PATH,
  BROWSER_SETUP_PROJECTS_PATH,
  BROWSER_SETUP_PROJECTS_VALIDATE_PATH,
  BROWSER_SETUP_PROVIDERS_CREDENTIAL_PATH,
  BROWSER_SETUP_PROVIDERS_VALIDATE_PATH,
  createSetupApi,
  type SetupApiSurface,
} from '../src/host/setup-api.js';
import { createRealPersistence } from './helpers/real-persistence.js';

const openServers: HostServer[] = [];
const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
  await Promise.all(disposers.splice(0).map((fn) => fn()));
});

function baseConfiguration(root: string): WorkbenchConfigurationV1 {
  return {
    version: 1,
    projects: [{ projectId: 'demo', displayName: 'Demo', root }],
    defaultProjectId: 'demo',
    provider: null,
    network: {
      mode: 'loopback',
      port: 8787,
      allowedHosts: [],
      allowedOrigins: [],
      unixSocket: null,
    },
  };
}

interface SetupHarness {
  readonly projectRoot: string;
  readonly store: ConfigurationFileStore;
  readonly configuration: ConfigurationChangeService;
  readonly auth: LocalAuthService;
  readonly server: HostServer;
  setListenerMode(mode: HostListenerMode): void;
}

async function createHarness(options: { preconfigured?: boolean } = {}): Promise<SetupHarness> {
  const persistence = createRealPersistence();
  disposers.push(() => persistence.dispose());
  const auth = new LocalAuthService({ persistence: createAuthPersistence(persistence.client) });
  const home = await mkdtemp(join(tmpdir(), 'fabula-setup-api-'));
  const store = new ConfigurationFileStore({ filePath: join(home, 'config', 'workbench.yaml') });
  const configuration = new ConfigurationChangeService({ store });
  const credentials = createProviderCredentialStore({ configDir: home });
  const projectRoot = await mkdtemp(join(tmpdir(), 'fabula-setup-project-'));
  await writeFile(join(projectRoot, 'nova.yaml'), 'project: demo\n', 'utf8');
  let mode: HostListenerMode = 'loopback';
  const surface = createSetupApi({
    configuration,
    auth,
    credentials,
    listenerMode: () => mode,
    unixSocketDir: join(home, 'run'),
  });
  const server = createHostServer({ port: 0 });
  surface.register(server);
  openServers.push(server);
  if (options.preconfigured === true) {
    await configuration.apply({
      candidate: baseConfiguration(projectRoot),
      expectedRevision: null,
      origin: 'setup',
    });
  }
  return {
    projectRoot,
    store,
    configuration,
    auth,
    server,
    setListenerMode(next) {
      mode = next;
    },
  };
}

async function jsonRequest(
  server: HostServer,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const response = await server.app.request(path, {
    method,
    headers: {
      'content-type': 'application/json',
      host: '127.0.0.1',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

describe('setup route seam', () => {
  it('accepts only paths under /api/v1/setup/* and only before start', async () => {
    const listener = createHostListener({ port: 0 });
    expect(() => listener.registerSetupRoute('GET', '/api/v1/other', () => new Response())).toThrow(
      HostListenerError,
    );
    expect(() =>
      listener.registerSetupRoute(
        'PATCH' as never,
        BROWSER_SETUP_STATUS_PATH,
        () => new Response(),
      ),
    ).toThrow(HostListenerError);
    listener.registerSetupRoute('GET', BROWSER_SETUP_STATUS_PATH, (c) => c.json({ ok: true }));
    expect(listener.endpoints().setup).toEqual([
      { method: 'GET', path: BROWSER_SETUP_STATUS_PATH, kind: 'setup', guarded: false },
    ]);
    const handle = await listener.start();
    expect(() =>
      listener.registerSetupRoute('POST', BROWSER_SETUP_OWNER_PATH, () => new Response()),
    ).toThrow(HostListenerStateError);
    await handle.close();
  });

  it('serves setup routes even when a public static fallback is registered', async () => {
    const { server } = await createHarness();
    server.registerPublicStaticRoute(
      '/*',
      () => new Response('<html>spa</html>', { headers: { 'content-type': 'text/html' } }),
    );
    const { status, body } = await jsonRequest(server, 'GET', BROWSER_SETUP_STATUS_PATH);
    expect(status).toBe(200);
    expect(body).toMatchObject({ version: 1, phase: 'unconfigured', configurationPresent: false });
    // The API path is never served as the SPA shell.
    expect(JSON.stringify(body)).not.toContain('<html>');
  });
});

describe('setup gating', () => {
  it('serves status while unconfigured and loopback', async () => {
    const { server } = await createHarness();
    const { status, body } = await jsonRequest(server, 'GET', BROWSER_SETUP_STATUS_PATH);
    expect(status).toBe(200);
    expect(body).toMatchObject({ version: 1, phase: 'unconfigured', ownerCreated: false });
  });

  it('rejects setup mutations once the Host is configured', async () => {
    const { server } = await createHarness({ preconfigured: true });
    const { status, body } = await jsonRequest(server, 'POST', BROWSER_SETUP_OWNER_PATH, {
      version: 1,
      password: 'a-very-long-password',
      displayName: 'Owner',
    });
    expect(status).toBe(409);
    expect(body).toMatchObject({ error: { code: 'SETUP_ALREADY_CONFIGURED' } });
  });

  it('rejects setup mutations when the listener is not loopback', async () => {
    const { server, setListenerMode } = await createHarness();
    setListenerMode('lan');
    const { status, body } = await jsonRequest(server, 'POST', BROWSER_SETUP_OWNER_PATH, {
      version: 1,
      password: 'a-very-long-password',
    });
    expect(status).toBe(403);
    expect(body).toMatchObject({ error: { code: 'SETUP_DISABLED' } });
  });
});

describe('setup wizard flow', () => {
  it('walks owner -> project -> provider -> network -> finish and writes the YAML', async () => {
    const { projectRoot, server, configuration, auth } = await createHarness();

    const initial = await jsonRequest(server, 'GET', BROWSER_SETUP_STATUS_PATH);
    expect(initial.body).toMatchObject({ phase: 'unconfigured', configurationPresent: false });

    const owner = await jsonRequest(server, 'POST', BROWSER_SETUP_OWNER_PATH, {
      version: 1,
      password: 'owner-secret-password',
      displayName: 'Owner',
    });
    expect(owner.status).toBe(200);
    expect(owner.body).toMatchObject({ version: 1 });
    expect(JSON.stringify(owner.body)).not.toContain('owner-secret-password');
    const ownerSession = (owner.body as { sessionId: string }).sessionId;
    expect(ownerSession.length).toBeGreaterThan(0);
    expect((await auth.getAuthState()).ownerExists).toBe(true);

    const ownerExists = await jsonRequest(server, 'POST', BROWSER_SETUP_OWNER_PATH, {
      version: 1,
      password: 'another-password-here',
    });
    expect(ownerExists.status).toBe(409);
    expect(ownerExists.body).toMatchObject({ error: { code: 'OWNER_EXISTS' } });

    const validated = await jsonRequest(server, 'POST', BROWSER_SETUP_PROJECTS_VALIDATE_PATH, {
      version: 1,
      projectId: 'demo',
      displayName: 'Demo',
      root: projectRoot,
    });
    expect(validated.status).toBe(200);
    expect(validated.body).toMatchObject({ validation: 'valid' });
    // The one-way root input is never echoed.
    expect(JSON.stringify(validated.body)).not.toContain(projectRoot);

    const saved = await jsonRequest(server, 'POST', BROWSER_SETUP_PROJECTS_PATH, {
      version: 1,
      projectId: 'demo',
      displayName: 'Demo',
      root: projectRoot,
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ projectId: 'demo', defaultProject: true });

    const duplicate = await jsonRequest(server, 'POST', BROWSER_SETUP_PROJECTS_PATH, {
      version: 1,
      projectId: 'demo',
      displayName: 'Demo 2',
      root: projectRoot,
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body).toMatchObject({ error: { code: 'PROJECT_DUPLICATE_ID' } });

    const provider = await jsonRequest(server, 'POST', BROWSER_SETUP_PROVIDERS_VALIDATE_PATH, {
      version: 1,
      kind: 'ai-sdk',
      baseUrl: 'https://api.example.com',
      model: 'model-x',
    });
    expect(provider.status).toBe(200);

    const credential = await jsonRequest(server, 'POST', BROWSER_SETUP_PROVIDERS_CREDENTIAL_PATH, {
      version: 1,
      providerId: 'ai-sdk',
      apiKey: 'sk-super-secret-key',
    });
    expect(credential.status).toBe(200);
    expect(credential.body).toMatchObject({ configured: true });
    expect(JSON.stringify(credential.body)).not.toContain('sk-super-secret-key');

    const network = await jsonRequest(server, 'POST', BROWSER_SETUP_NETWORK_PATH, {
      version: 1,
      mode: 'loopback',
      port: 8787,
      allowedHosts: [],
      allowedOrigins: [],
      unixSocketName: null,
    });
    expect(network.status).toBe(200);
    expect(network.body).toMatchObject({ restartRequired: true });

    const midStatus = await jsonRequest(server, 'GET', BROWSER_SETUP_STATUS_PATH);
    expect(midStatus.body).toMatchObject({ phase: 'network-pending' });

    const finish = await jsonRequest(server, 'POST', BROWSER_SETUP_FINISH_PATH, {
      version: 1,
      expectedRevision: null,
    });
    expect(finish.status).toBe(200);
    const receipt = (finish.body as { receipt: { status: string } }).receipt;
    expect(receipt.status).toBe('restart-required');

    const active = await configuration.readActive();
    expect(active).not.toBeNull();
    expect(active?.configuration.projects[0]?.projectId).toBe('demo');
    expect(active?.configuration.provider).toEqual({
      kind: 'ai-sdk',
      baseUrl: 'https://api.example.com',
      model: 'model-x',
    });
    expect(active?.configuration.version).toBe(2);
    expect(active?.configuration.projects[0]?.revisionMirror).toEqual({ mode: 'disabled' });
    expect(active?.configuration.referenceLimits).toEqual(DEFAULT_WORKBENCH_REFERENCE_LIMITS_V2);

    // A later finish is refused: the Host is configured now.
    const again = await jsonRequest(server, 'POST', BROWSER_SETUP_FINISH_PATH, {
      version: 1,
      expectedRevision: null,
    });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: { code: 'SETUP_ALREADY_CONFIGURED' } });
  });

  it('rejects unknown fields and invalid network policies', async () => {
    const { server } = await createHarness();
    const unknown = await jsonRequest(server, 'POST', BROWSER_SETUP_PROJECTS_PATH, {
      version: 1,
      projectId: 'demo',
      displayName: 'Demo',
      root: '/tmp',
      userId: 'attacker',
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body).toMatchObject({ error: { code: 'UNKNOWN_FIELD' } });

    const badNetwork = await jsonRequest(server, 'POST', BROWSER_SETUP_NETWORK_PATH, {
      version: 1,
      mode: 'lan',
      port: 70000,
      allowedHosts: [],
      allowedOrigins: [],
      unixSocketName: null,
    });
    expect(badNetwork.status).toBe(400);
    expect(badNetwork.body).toMatchObject({ error: { code: 'NETWORK_INVALID' } });
  });
});
