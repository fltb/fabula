import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BROWSER_PROJECT_IMPORT_PATH,
  BROWSER_SESSION_HEADER,
  type BrowserApiErrorV1,
  type BrowserProjectImportResultV1,
  type BrowserSessionPrincipalV1,
} from '../src/contracts/browser-api.js';
import { createBrowserImportApi } from '../src/host/browser-import-api.js';
import type { BrowserPrincipalResolver } from '../src/host/browser-read-api.js';
import { ConfigurationFileStore } from '../src/host/configuration-file-store.js';
import { ConfigurationChangeService } from '../src/host/configuration-service.js';
import { createHostServer, type HostServer } from '../src/host/server.js';

const homes: string[] = [];
const openServers: HostServer[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

const principal: BrowserSessionPrincipalV1 = {
  version: 1,
  userId: 'u-owner',
  role: 'owner',
  displayName: 'Owner',
  capabilityVersion: 1,
  expiresAt: '2099-01-01T00:00:00.000Z',
};

const userPrincipal: BrowserSessionPrincipalV1 = {
  version: 1,
  userId: 'u-user',
  role: 'user',
  displayName: 'Reader',
  capabilityVersion: 1,
  expiresAt: '2099-01-01T00:00:00.000Z',
};

const authHeaders = { [BROWSER_SESSION_HEADER]: 'session-1' };

const resolver: BrowserPrincipalResolver = {
  resolve: async (request) => {
    const session = request.headers.get(BROWSER_SESSION_HEADER);
    if (session === 'session-user') return { ok: true, principal: userPrincipal };
    if (session !== 'session-1') return { ok: false, failure: 'SESSION_NOT_FOUND' };
    return { ok: true, principal };
  },
};

interface Harness {
  readonly app: HostServer['app'];
  readonly home: string;
  readonly configuration: ConfigurationChangeService;
  readonly close: () => Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), 'fabula-import-api-'));
  homes.push(home);
  const store = new ConfigurationFileStore({ filePath: join(home, 'config', 'workbench.yaml') });
  const configuration = new ConfigurationChangeService({ store });
  const server = createHostServer({ port: 0 });
  createBrowserImportApi({ principal: resolver, configuration, hostHome: home }).register(server);
  openServers.push(server);
  const handle = await server.start();
  return {
    app: server.app,
    home,
    configuration,
    close: async () => {
      await handle.close();
    },
  };
}

/** A realistic external project tree: nova.yaml + content + author-internal dirs. */
async function makeSource(novaYaml?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fabula-import-source-'));
  homes.push(root);
  await writeFile(
    join(root, 'nova.yaml'),
    novaYaml ?? 'project: imported-demo\ntitle: Imported Demo\n',
    'utf8',
  );
  await mkdir(join(root, 'chapters'), { recursive: true });
  await writeFile(join(root, 'chapters', 'ch1.md'), '# Chapter 1\n', 'utf8');
  await mkdir(join(root, '.git'), { recursive: true });
  await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  await mkdir(join(root, 'output'), { recursive: true });
  await writeFile(join(root, 'output', 'novel.md'), 'generated\n', 'utf8');
  return root;
}

async function importProject(harness: Harness, sourcePath: string): Promise<Response> {
  return harness.app.request(BROWSER_PROJECT_IMPORT_PATH, {
    method: 'POST',
    headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ sourcePath }),
  });
}

async function expectError(
  response: Response,
  status: number,
  code: BrowserApiErrorV1['error']['code'],
): Promise<void> {
  expect(response.status).toBe(status);
  const body = (await response.json()) as BrowserApiErrorV1;
  expect(body.error.code).toBe(code);
  expect(body.error.message.length).toBeGreaterThan(0);
}

describe('browser project import API', () => {
  it('copies a source tree into the managed root, drops author-internal dirs, and registers the project', async () => {
    const harness = await makeHarness();
    try {
      const source = await makeSource();
      const response = await importProject(harness, source);
      expect(response.status).toBe(200);
      const body = (await response.json()) as BrowserProjectImportResultV1;
      expect(body).toEqual({
        version: 1,
        projectId: 'imported-demo',
        displayName: 'Imported Demo',
      });

      const target = join(harness.home, 'projects', 'imported-demo');
      await expect(readFile(join(target, 'nova.yaml'), 'utf8')).resolves.toContain(
        'project: imported-demo',
      );
      await expect(readFile(join(target, 'chapters', 'ch1.md'), 'utf8')).resolves.toContain(
        '# Chapter 1',
      );
      await expect(stat(join(target, '.git'))).rejects.toThrow();
      await expect(stat(join(target, 'output'))).rejects.toThrow();

      const active = await harness.configuration.readActive();
      expect(active?.configuration.projects.map((project) => project.projectId)).toContain(
        'imported-demo',
      );
      expect(active?.configuration.projects[0]?.displayName).toBe('Imported Demo');
      expect(active?.configuration.defaultProjectId).toBe('imported-demo');
    } finally {
      await harness.close();
    }
  });

  it('rejects a repeated import with 409 PROJECT_IMPORT_CONFLICT', async () => {
    const harness = await makeHarness();
    try {
      const source = await makeSource();
      const first = await importProject(harness, source);
      expect(first.status).toBe(200);

      const second = await importProject(harness, source);
      await expectError(second, 409, 'PROJECT_IMPORT_CONFLICT');
    } finally {
      await harness.close();
    }
  });

  it('rejects a nonexistent source path with 404 PROJECT_IMPORT_NOT_FOUND', async () => {
    const harness = await makeHarness();
    try {
      const response = await importProject(harness, join(harness.home, 'missing-project'));
      await expectError(response, 404, 'PROJECT_IMPORT_NOT_FOUND');
    } finally {
      await harness.close();
    }
  });

  it('rejects a source without a parseable nova.yaml with 400 PROJECT_IMPORT_INVALID', async () => {
    const harness = await makeHarness();
    try {
      const source = await makeSource('not: [valid yaml');
      const response = await importProject(harness, source);
      await expectError(response, 400, 'PROJECT_IMPORT_INVALID');
    } finally {
      await harness.close();
    }
  });

  it('denies non-owner sessions with 403 PROJECT_MISMATCH', async () => {
    const harness = await makeHarness();
    try {
      const source = await makeSource();
      const response = await harness.app.request(BROWSER_PROJECT_IMPORT_PATH, {
        method: 'POST',
        headers: { [BROWSER_SESSION_HEADER]: 'session-user', 'content-type': 'application/json' },
        body: JSON.stringify({ sourcePath: source }),
      });
      await expectError(response, 403, 'PROJECT_MISMATCH');
    } finally {
      await harness.close();
    }
  });
});
