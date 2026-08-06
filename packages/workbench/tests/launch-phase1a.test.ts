/**
 * Phase 1A focused host tests: worker lifecycle (real worker thread, crash
 * propagation, bounded idempotent disposal), Host-only provider factory
 * (credential store boundary, no environment-key fallback, secret-free
 * readiness), and launch env policy (unconfigured setup runtime, loopback-only
 * first startup, packaged-assets default). These run against real esbuild
 * bundles and real worker threads; they are deliberately narrow and are not
 * part of any gate.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { WorkflowStatusV1 } from '@novalistically/core';
import {
  CANONICAL_WORLD_SCHEMA,
  CANONICAL_WORLD_SCHEMA_VERSION,
  compileProject,
  verifySnapshotRecord,
} from '@novalistically/core';
import { MockProvider } from '@novalistically/core/testing';
import { diffEvent } from '@novalistically/core/tooling';
import {
  FileProjectSourceLoader,
  ProjectAuthorityUnavailableError,
  ProjectWriteCoordinator,
} from '@novalistically/node-host';
import {
  DEFAULT_WORKBENCH_OPERATION_LIMITS_V3,
  DEFAULT_WORKBENCH_REFERENCE_LIMITS_V2,
} from '@novalistically/workbench-protocol';
import { build } from 'esbuild';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { MCP_ADMIN_SCOPE } from '../src/contracts/configuration.js';
import { createFileSourceViewMaterializer } from '../src/host/authoring/source-view-materializer.js';
import { serializeConfigurationYaml } from '../src/host/configuration-file-store.js';
import { HostProviderError, HostProviderFactory } from '../src/host/provider-factory.js';
import { XdgCredentialFileStore } from '../src/host/providers/index.js';
import {
  createPersistenceWorkerRuntime,
  parseWorkbenchLaunchConfig,
  resolveWorkbenchHostHome,
  startWorkbench,
  type WorkbenchLaunchConfig,
  type WorkbenchLaunchHandle,
} from '../src/host/workbench-launch.js';

// ─── Temp workspace helper ──────────────────────────────────────────────────

const packageRoot = resolve(import.meta.dirname, '..');
const ownedDirs: string[] = [];

function newTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  ownedDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of ownedDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Bundle the persistence worker entry once per test file, like build.host.mjs. */
let workerBundlePromise: Promise<string> | undefined;
function workerBundle(): Promise<string> {
  workerBundlePromise ??= (async () => {
    const bundleDir = mkdtempSync(join(packageRoot, 'worker-bundle-'));
    ownedDirs.push(bundleDir);
    await build({
      entryPoints: [resolve(packageRoot, 'src/persistence/worker.ts')],
      bundle: true,
      packages: 'external',
      platform: 'node',
      target: 'node26',
      format: 'esm',
      outfile: join(bundleDir, 'persistence-worker.js'),
      logLevel: 'silent',
    });
    return join(bundleDir, 'persistence-worker.js');
  })();
  return workerBundlePromise;
}

/** True when the SQLite file is absent or reopenable read-only (worker released it). */
function databaseReleased(databasePath: string): boolean {
  if (!existsSync(databasePath)) return true;
  const db = new DatabaseSync(databasePath, { readOnly: true });
  db.close();
  return true;
}
type AdminMcpResponse = {
  readonly result?: {
    readonly content?: readonly [{ readonly type: string; readonly text: string }];
    readonly tools?: readonly { readonly name: string }[];
    readonly isError?: boolean;
  };
};

type AdminMcpToolResult = {
  readonly isError: boolean;
  readonly body: unknown;
};

async function postAdminMcp(
  endpoint: string,
  credential: string,
  method: string,
  params: Record<string, unknown>,
): Promise<AdminMcpResponse> {
  const response = await fetch(`${endpoint}/mcp/admin`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${credential}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as AdminMcpResponse;
}

async function callAdminMcpTool(
  endpoint: string,
  credential: string,
  name: string,
  arguments_: Record<string, unknown>,
): Promise<AdminMcpToolResult> {
  const payload = await postAdminMcp(endpoint, credential, 'tools/call', {
    name,
    arguments: arguments_,
  });
  const content = payload.result?.content?.[0];
  expect(content?.type).toBe('text');
  expect(typeof content?.text).toBe('string');
  return {
    isError: payload.result?.isError === true,
    body: JSON.parse(content?.text ?? ''),
  };
}

async function postProjectMcp(
  endpoint: string,
  credential: string,
  projectId: string,
  method: string,
  params: Record<string, unknown>,
): Promise<AdminMcpResponse> {
  const response = await fetch(`${endpoint}/mcp/projects/${projectId}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${credential}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as AdminMcpResponse;
}

async function callProjectMcpTool(
  endpoint: string,
  credential: string,
  projectId: string,
  name: string,
  arguments_: Record<string, unknown>,
): Promise<AdminMcpToolResult> {
  const payload = await postProjectMcp(endpoint, credential, projectId, 'tools/call', {
    name,
    arguments: arguments_,
  });
  const content = payload.result?.content?.[0];
  expect(content?.type).toBe('text');
  expect(typeof content?.text).toBe('string');
  return {
    isError: payload.result?.isError === true,
    body: JSON.parse(content?.text ?? ''),
  };
}

/** Crash the worker deterministically: its database parent directory is missing. */
function crashingDatabasePath(): string {
  return join(newTempDir('fabula-launch-crash-'), 'missing', 'db.sqlite');
}

// ─── Launch env policy ──────────────────────────────────────────────────────

describe('parseWorkbenchLaunchConfig env policy', () => {
  it('parses an unconfigured dev launch without project root, database path or API key', () => {
    const config = parseWorkbenchLaunchConfig({
      WORKBENCH_MODE: 'workbench',
      WORKBENCH_DEV: 'true',
      XDG_STATE_HOME: '/state',
      HOME: '/home/test',
    });
    expect(config.projectRoot).toBeUndefined();
    expect(config.assetsRoot).toBeUndefined();
    expect(config.provider).toBe('ai-sdk');
    expect(config.hostHome).toBe(resolve('/state/fabula/workbench'));
    expect(config.databasePath).toBe(resolve('/state/fabula/workbench/workbench.sqlite'));
  });

  it('defaults production assets to the packaged dist/client and does not require an env file', () => {
    const config = parseWorkbenchLaunchConfig({
      WORKBENCH_MODE: 'workbench',
      XDG_STATE_HOME: '/state',
      HOME: '/home/test',
    });
    expect(config.assetsRoot).toBe(resolve(packageRoot, 'dist/client'));
  });

  it('honours WORKBENCH_HOME and explicit database path overrides', () => {
    const config = parseWorkbenchLaunchConfig({
      WORKBENCH_MODE: 'workbench',
      WORKBENCH_DEV: 'true',
      WORKBENCH_HOME: '/custom/home',
      WORKBENCH_DATABASE_PATH: '/custom/db/workbench.sqlite',
      HOME: '/home/test',
    });
    expect(config.hostHome).toBe(resolve('/custom/home'));
    expect(config.databasePath).toBe(resolve('/custom/db/workbench.sqlite'));
  });

  it('derives project id and display name from a legacy env project root', () => {
    const config = parseWorkbenchLaunchConfig({
      WORKBENCH_MODE: 'workbench',
      WORKBENCH_DEV: 'true',
      WORKBENCH_PROJECT_ROOT: '/srv/nova/world-of-ash',
      HOME: '/home/test',
    });
    expect(config.projectRoot).toBe(resolve('/srv/nova/world-of-ash'));
    expect(config.projectId).toBe('world-of-ash');
    expect(config.displayName).toBe('world-of-ash');
  });

  it('keeps an unconfigured first startup loopback-only', () => {
    expect(() =>
      parseWorkbenchLaunchConfig({
        WORKBENCH_MODE: 'workbench',
        WORKBENCH_DEV: 'true',
        WORKBENCH_LAN: 'true',
        HOME: '/home/test',
      }),
    ).toThrow(/loopback-only/);
    expect(() =>
      parseWorkbenchLaunchConfig({
        WORKBENCH_MODE: 'workbench',
        WORKBENCH_DEV: 'true',
        WORKBENCH_UNIX_SOCKET: '/run/fabula/wb.sock',
        HOME: '/home/test',
      }),
    ).toThrow(/loopback-only/);
  });

  it('rejects mock provider without the explicit dev override', () => {
    expect(() =>
      parseWorkbenchLaunchConfig({
        WORKBENCH_MODE: 'workbench',
        WORKBENCH_DEV: 'true',
        WORKBENCH_PROVIDER: 'mock',
        HOME: '/home/test',
      }),
    ).toThrow(/WORKBENCH_ALLOW_MOCK_PROVIDER/);
  });

  it('fails closed when no Host home base exists', () => {
    expect(() =>
      parseWorkbenchLaunchConfig({ WORKBENCH_MODE: 'workbench', WORKBENCH_DEV: 'true' }),
    ).toThrow(/Host home/);
  });

  it('resolves the Host home through XDG_STATE_HOME then HOME', () => {
    expect(resolveWorkbenchHostHome({ XDG_STATE_HOME: '/s', HOME: '/h' })).toBe(
      resolve('/s/fabula/workbench'),
    );
    expect(resolveWorkbenchHostHome({ HOME: '/h' })).toBe(
      resolve('/h/.local/state/fabula/workbench'),
    );
    expect(resolveWorkbenchHostHome({ WORKBENCH_HOME: '/w' })).toBe(resolve('/w'));
  });
});

// ─── Host-only provider factory ─────────────────────────────────────────────

describe('HostProviderFactory credential boundary', () => {
  it('reports unconfigured and refuses to build a provider without stored credentials', async () => {
    const factory = new HostProviderFactory({
      store: new XdgCredentialFileStore({ configDir: newTempDir('fabula-launch-credential-') }),
      configuration: null,
    });
    expect(factory.configured).toBe(false);
    const readiness = await factory.readiness();
    expect(readiness.configured).toBe(false);
    expect(readiness.endpoint).toBeNull();
    const error = await factory.create().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HostProviderError);
    expect((error as HostProviderError).code).toBe('PROVIDER_NOT_CONFIGURED');
  });

  it('never falls back to a process-environment API key', async () => {
    const previous = process.env.NOVALISTICALLY_AI_API_KEY;
    process.env.NOVALISTICALLY_AI_API_KEY = 'env-key-must-not-be-used';
    try {
      const factory = new HostProviderFactory({
        store: new XdgCredentialFileStore({ configDir: newTempDir('fabula-launch-credential-') }),
        configuration: { kind: 'ai-sdk', baseUrl: 'https://provider.test/v1', model: 'm-1' },
      });
      const error = await factory.create().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HostProviderError);
      expect((error as HostProviderError).code).toBe('PROVIDER_CREDENTIAL_UNAVAILABLE');
    } finally {
      if (previous === undefined) delete process.env.NOVALISTICALLY_AI_API_KEY;
      else process.env.NOVALISTICALLY_AI_API_KEY = previous;
    }
  });

  it('constructs the AI-SDK provider from the stored credential with explicit options', async () => {
    const store = new XdgCredentialFileStore({
      configDir: newTempDir('fabula-launch-credential-'),
    });
    await store.set('ai-sdk:default', 'store-secret');
    const factory = new HostProviderFactory({
      store,
      configuration: { kind: 'ai-sdk', baseUrl: 'https://provider.test/v1', model: 'm-1' },
    });
    const provider = await factory.create();
    expect(provider.name).toBe('ai-sdk');
    const readiness = await factory.readiness();
    expect(readiness.configured).toBe(true);
    expect(readiness.endpoint).toBe('https://provider.test');
    expect(readiness.model).toBe('m-1');
    expect(JSON.stringify(readiness)).not.toContain('store-secret');
  });

  it('constructs a per-profile provider from its own profile-scoped credential', async () => {
    const store = new XdgCredentialFileStore({
      configDir: newTempDir('fabula-launch-credential-'),
    });
    await store.set('ai-sdk:prod-eu', 'prod-eu-secret');
    const factory = new HostProviderFactory({
      store,
      configuration: { kind: 'ai-sdk', baseUrl: 'https://default.test/v1', model: 'm-default' },
    });
    const provider = await factory.createForProfile('prod-eu', {
      kind: 'ai-sdk',
      baseUrl: 'https://prod-eu.test/v1',
      model: 'm-prod-eu',
    });
    expect(provider.name).toBe('ai-sdk');
    // The default profile has no credential; per-profile construction is isolated.
    const defaultError = await factory.create().catch((e: unknown) => e);
    expect(defaultError).toBeInstanceOf(HostProviderError);
    expect((defaultError as HostProviderError).code).toBe('PROVIDER_CREDENTIAL_UNAVAILABLE');
  });

  it('rejects an unconfigured profile without touching the credential store', async () => {
    const factory = new HostProviderFactory({
      store: new XdgCredentialFileStore({ configDir: newTempDir('fabula-launch-credential-') }),
      configuration: { kind: 'ai-sdk', baseUrl: 'https://provider.test/v1', model: 'm-1' },
    });
    const error = await factory
      .createForProfile('missing-profile', undefined)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HostProviderError);
    expect((error as HostProviderError).code).toBe('PROVIDER_NOT_CONFIGURED');
  });

  it('accepts an injected override without touching the credential store', async () => {
    const mock = new MockProvider();
    const factory = new HostProviderFactory({
      store: new XdgCredentialFileStore({ configDir: newTempDir('fabula-launch-credential-') }),
      configuration: null,
      override: mock,
    });
    expect(factory.configured).toBe(true);
    await expect(factory.create()).resolves.toBe(mock);
    const diagnostics = await factory.validate();
    expect(diagnostics).toEqual([]);
    const readiness = await factory.readiness();
    expect(readiness.configured).toBe(true);
    expect(readiness.lastValidation).toBe('valid');
  });

  it('reports typed, secret-free diagnostics when validation has no provider', async () => {
    const factory = new HostProviderFactory({
      store: new XdgCredentialFileStore({ configDir: newTempDir('fabula-launch-credential-') }),
      configuration: null,
    });
    const diagnostics = await factory.validate();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe('PROVIDER_NOT_CONFIGURED');
    expect(JSON.stringify(diagnostics)).not.toContain('api_key');
  });
});

// ─── Persistence worker lifecycle (real worker thread) ──────────────────────

describe('persistence worker lifecycle', () => {
  it('roundtrips RPC through a real worker thread and disposes idempotently within a bound', async () => {
    const databasePath = join(newTempDir('fabula-launch-hosthome-'), 'workbench.sqlite');
    const runtime = createPersistenceWorkerRuntime({
      entry: await workerBundle(),
      databasePath,
      terminationTimeoutMs: 2_000,
    });
    expect(runtime.threadId).toBeGreaterThan(0);
    const state = await runtime.client.request('getAuthState', undefined);
    expect(state).toEqual({ ownerUserId: null });
    await runtime.dispose();
    await runtime.dispose(); // idempotent
    expect(databaseReleased(databasePath)).toBe(true);
  });

  it('propagates an unexpected worker crash to in-flight and future callers', async () => {
    const entry = await workerBundle();
    const databasePath = crashingDatabasePath();
    let crash: Error | null = null;
    let inFlight: unknown;
    const crashed = new Promise<void>((resolve) => {
      const runtime = createPersistenceWorkerRuntime({
        entry,
        databasePath,
        terminationTimeoutMs: 1_000,
        onCrash: (error) => {
          crash = error;
          resolve();
        },
      });
      // Issued before the crash lands; must reject with the crash error.
      inFlight = runtime.client.request('getAuthState', undefined).catch((e: unknown) => e);
    });
    await crashed;
    expect(String(crash?.message)).toMatch(/persistence worker (crashed|exited)/i);
    const inFlightError = await inFlight;
    expect(inFlightError).toBeInstanceOf(Error);
    expect(String((inFlightError as Error).message)).toMatch(
      /persistence worker (crashed|exited)/i,
    );
    // A fresh runtime over the same broken worker crashes too: requests after
    // the crash must fail fast instead of hanging on the closed port.
    const future = await (async () => {
      const runtime = createPersistenceWorkerRuntime({
        entry,
        databasePath,
        terminationTimeoutMs: 1_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const error = await runtime.client
        .request('getAuthState', undefined)
        .catch((e: unknown) => e);
      await runtime.dispose();
      return String(error instanceof Error ? error.message : error);
    })();
    expect(future).toMatch(/persistence worker (crashed|exited)/i);
  });
});

// ─── Unconfigured setup runtime + partial-launch cleanup ────────────────────

describe('startWorkbench setup runtime', () => {
  it('starts an unconfigured loopback Host without a project or provider', async () => {
    const hostHome = newTempDir('fabula-launch-hosthome-');
    const assetsRoot = join(hostHome, 'assets');
    await mkdir(assetsRoot, { recursive: true });
    await writeFile(join(assetsRoot, 'index.html'), '<!doctype html><title>wb</title>');
    const handle = await startWorkbench({
      mode: 'workbench',
      provider: 'ai-sdk',
      allowMockProvider: false,
      hostHome,
      databasePath: join(hostHome, 'workbench.sqlite'),
      assetsRoot,
      allowBootstrap: false,
      persistenceWorkerEntry: await workerBundle(),
      workerTerminationTimeoutMs: 2_000,
      host: 'loopback',
      port: 0,
    });
    try {
      expect(handle.projectId).toBeNull();
      const health = await fetch(`${handle.endpoint}/health`);
      expect(health.status).toBe(200);
      const status = await fetch(`${handle.endpoint}/status`);
      expect(status.status).toBe(200);
    } finally {
      await handle.close();
    }
    expect(databaseReleased(join(hostHome, 'workbench.sqlite'))).toBe(true);
  });

  it('disposes the worker and database handle on a partial-launch failure', async () => {
    const hostHome = newTempDir('fabula-launch-hosthome-');
    const assetsRoot = join(hostHome, 'assets');
    await mkdir(assetsRoot, { recursive: true });
    await writeFile(join(assetsRoot, 'index.html'), '<!doctype html>');
    const databasePath = join(hostHome, 'workbench.sqlite');
    const config: WorkbenchLaunchConfig = {
      mode: 'workbench',
      provider: 'mock',
      allowMockProvider: true,
      hostHome,
      databasePath,
      assetsRoot,
      allowBootstrap: false,
      // Nonexistent project root: FileProjectSourceLoader.load -> realpathSync
      // throws after the worker has already been spawned.
      projectRoot: join(hostHome, 'no-such-project'),
      projectId: 'missing-project',
      persistenceWorkerEntry: await workerBundle(),
      workerTerminationTimeoutMs: 2_000,
      host: 'loopback',
      port: 0,
    };
    await expect(startWorkbench(config)).rejects.toThrow(/ENOENT|no such file/i);
    // The worker must be terminated and its database handle released even
    // though startup failed mid-composition.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(databaseReleased(databasePath)).toBe(true);
  });
  it('opens two configured project bundles and recreates a closed secondary bundle through admin', async () => {
    const hostHome = newTempDir('fabula-launch-configured-');
    const assetsRoot = join(hostHome, 'assets');
    await mkdir(assetsRoot, { recursive: true });
    await writeFile(join(assetsRoot, 'index.html'), '<!doctype html><title>wb</title>');
    const fixtureRoot = resolve(packageRoot, '..', '..', 'fixtures', 'workbench-authoring');
    const rootA = join(newTempDir('fabula-launch-project-a-'), 'project-a');
    const rootB = join(newTempDir('fabula-launch-project-b-'), 'project-b');
    await Promise.all([
      cp(fixtureRoot, rootA, { recursive: true }),
      cp(fixtureRoot, rootB, { recursive: true }),
    ]);
    await Promise.all(
      [
        [rootA, 'project-a'],
        [rootB, 'project-b'],
      ].map(async ([root, projectId]) => {
        const novaPath = join(root, 'nova.yaml');
        await writeFile(
          novaPath,
          (await readFile(novaPath, 'utf8')).replace(
            /^project: workbench-authoring$/m,
            `project: ${projectId}`,
          ),
        );
      }),
    );
    const configuration = {
      version: 1 as const,
      projects: [
        { projectId: 'project-a', displayName: 'Project A', root: rootA },
        { projectId: 'project-b', displayName: 'Project B', root: rootB },
      ],
      defaultProjectId: 'project-a',
      provider: null,
      network: {
        mode: 'loopback' as const,
        port: 0,
        allowedHosts: [],
        allowedOrigins: [],
        unixSocket: null,
      },
    };
    await mkdir(join(hostHome, 'config'), { recursive: true });
    await writeFile(
      join(hostHome, 'config', 'workbench.yaml'),
      serializeConfigurationYaml(configuration),
      'utf8',
    );
    const handle = await startWorkbench({
      mode: 'workbench',
      provider: 'mock',
      allowMockProvider: true,
      hostHome,
      databasePath: join(hostHome, 'workbench.sqlite'),
      assetsRoot,
      allowBootstrap: true,
      persistenceWorkerEntry: await workerBundle(),
      workerTerminationTimeoutMs: 2_000,
      host: 'loopback',
      port: 0,
    });
    try {
      expect(handle.projectId).toBe('project-a');
      const bootstrap = await fetch(`${handle.endpoint}/api/v1/auth/bootstrap`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'a-strong-owner-password', displayName: 'Owner' }),
      });
      expect(bootstrap.status).toBe(200);
      const { sessionId } = (await bootstrap.json()) as { sessionId: string };
      const headers = { 'x-fabula-session': sessionId };
      const projects = await fetch(`${handle.endpoint}/api/v1/projects`, { headers });
      expect(projects.status).toBe(200);
      expect((await projects.json()) as { projects: unknown[] }).toMatchObject({
        projects: [
          { projectId: 'project-a', open: true },
          { projectId: 'project-b', open: true },
        ],
      });

      const novaPath = join(rootA, 'nova.yaml');
      await writeFile(novaPath, `${await readFile(novaPath, 'utf8')}# external authoring edit\n`);
      await vi.waitFor(async () => {
        const state = await fetch(`${handle.endpoint}/api/v1/projects/project-a/authoring/state`, {
          headers,
        });
        expect(state.status).toBe(200);
        expect(
          (await state.json()) as {
            phase: string;
            externalCandidate: { candidateHash: string } | null;
          },
        ).toMatchObject({
          phase: 'external-pending',
          externalCandidate: { candidateHash: expect.any(String) },
        });
      });

      const overview = await fetch(`${handle.endpoint}/api/v1/admin/overview`, { headers });
      expect(overview.status).toBe(200);
      expect((await overview.json()) as { openProjects: number }).toMatchObject({
        openProjects: 2,
      });

      const close = await fetch(`${handle.endpoint}/api/v1/admin/projects/project-b/close`, {
        method: 'POST',
        headers,
      });
      expect(close.status).toBe(200);
      const reopen = await fetch(`${handle.endpoint}/api/v1/admin/projects/project-b/open`, {
        method: 'POST',
        headers,
      });
      expect(reopen.status).toBe(200);
      const reopened = await fetch(`${handle.endpoint}/api/v1/projects`, { headers });
      expect((await reopened.json()) as { projects: unknown[] }).toMatchObject({
        projects: [
          { projectId: 'project-a', open: true },
          { projectId: 'project-b', open: true },
        ],
      });

      const removed = await fetch(`${handle.endpoint}/api/v1/admin/projects/project-b`, {
        method: 'DELETE',
        headers,
      });
      expect(await removed.json()).toMatchObject({
        removed: true,
        receipt: { status: 'restart-required' },
      });
      expect(await readFile(join(hostHome, 'config', 'workbench.yaml'), 'utf8')).not.toContain(
        'project-b',
      );
      const remaining = await fetch(`${handle.endpoint}/api/v1/projects`, { headers });
      expect(
        ((await remaining.json()) as { projects: { projectId: string }[] }).projects.map(
          (project) => project.projectId,
        ),
      ).toEqual(['project-a']);
    } finally {
      await handle.close();
    }
  });
  it('mounts the production admin MCP adapter with owner-paired authentication', async () => {
    const hostHome = newTempDir('fabula-launch-admin-mcp-');
    const assetsRoot = join(hostHome, 'assets');
    await mkdir(assetsRoot, { recursive: true });
    await writeFile(join(assetsRoot, 'index.html'), '<!doctype html><title>wb</title>');
    const fixtureRoot = resolve(packageRoot, '..', '..', 'fixtures', 'workbench-authoring');
    const projectRoot = join(newTempDir('fabula-launch-admin-project-'), 'launch-project');
    await cp(fixtureRoot, projectRoot, { recursive: true });
    const configuration = {
      version: 1 as const,
      projects: [
        {
          projectId: 'launch-project',
          displayName: 'Launch Project',
          root: projectRoot,
        },
      ],
      defaultProjectId: 'launch-project',
      provider: null,
      network: {
        mode: 'loopback' as const,
        port: 0,
        allowedHosts: [],
        allowedOrigins: [],
        unixSocket: null,
      },
    };
    await mkdir(join(hostHome, 'config'), { recursive: true });
    await writeFile(
      join(hostHome, 'config', 'workbench.yaml'),
      serializeConfigurationYaml(configuration),
      'utf8',
    );

    const handle = await startWorkbench({
      mode: 'workbench',
      provider: 'mock',
      allowMockProvider: true,
      hostHome,
      databasePath: join(hostHome, 'workbench.sqlite'),
      assetsRoot,
      allowBootstrap: true,
      persistenceWorkerEntry: await workerBundle(),
      workerTerminationTimeoutMs: 2_000,
      host: 'loopback',
      port: 0,
    });
    try {
      expect(handle.projectId).toBe('launch-project');
      expect(handle.host.endpoints().mcp).toEqual(
        expect.arrayContaining([
          { method: 'GET', path: '/mcp/admin', kind: 'mcp', guarded: true },
          { method: 'POST', path: '/mcp/admin', kind: 'mcp', guarded: true },
          { method: 'DELETE', path: '/mcp/admin', kind: 'mcp', guarded: true },
        ]),
      );

      // Browser owner bootstrap is the server-derived authority used only to
      // issue and claim an admin MCP device credential.
      const bootstrap = await fetch(`${handle.endpoint}/api/v1/auth/bootstrap`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'a-strong-owner-password', displayName: 'Owner' }),
      });
      expect(bootstrap.status).toBe(200);
      const owner = (await bootstrap.json()) as { sessionId: string; userId: string };
      const ownerHeaders = { 'x-fabula-session': owner.sessionId };
      const issue = await fetch(`${handle.endpoint}/api/v1/admin/mcp-devices/issue`, {
        method: 'POST',
        headers: { ...ownerHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ version: 1, kind: 'admin', ttlMs: 60_000 }),
      });
      expect(issue.status).toBe(200);
      const pairing = (await issue.json()) as { pairingCode: string };
      const claim = await fetch(`${handle.endpoint}/api/v1/admin/mcp-devices`, {
        method: 'POST',
        headers: { ...ownerHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({
          pairingCode: pairing.pairingCode,
          label: 'launch-admin-mcp',
          scopes: [MCP_ADMIN_SCOPE],
          version: 1,
          ttlMs: 60_000,
        }),
      });
      expect(claim.status).toBe(200);
      const claimed = (await claim.json()) as { credential: string };
      const adminCredential = claimed.credential;

      const discovery = await postAdminMcp(handle.endpoint, adminCredential, 'tools/list', {});
      const toolNames = discovery.result?.tools?.map((tool) => tool.name) ?? [];
      expect(toolNames).toEqual(
        expect.arrayContaining([
          'nova_admin_config_get',
          'nova_admin_project_list',
          'nova_admin_membership_upsert',
          'nova_admin_invite_create',
          'nova_admin_device_pair_begin',
          'nova_admin_operation_list',
        ]),
      );
      expect(toolNames.every((name) => name.startsWith('nova_admin_'))).toBe(true);

      const config = await callAdminMcpTool(
        handle.endpoint,
        adminCredential,
        'nova_admin_config_get',
        {},
      );
      expect(config).toMatchObject({
        isError: false,
        body: {
          version: 1,
          status: expect.objectContaining({
            configurationPresent: true,
            ownerCreated: true,
          }),
        },
      });

      const projects = await callAdminMcpTool(
        handle.endpoint,
        adminCredential,
        'nova_admin_project_list',
        { version: 1 },
      );
      expect(projects).toMatchObject({
        isError: false,
        body: {
          version: 1,
          projects: [
            expect.objectContaining({
              projectId: 'launch-project',
              displayName: 'Launch Project',
              open: true,
              defaultProject: true,
            }),
          ],
        },
      });

      const membership = await callAdminMcpTool(
        handle.endpoint,
        adminCredential,
        'nova_admin_membership_upsert',
        {
          version: 1,
          userId: owner.userId,
          projectId: 'launch-project',
          role: 'reader',
        },
      );
      expect(membership).toMatchObject({
        isError: false,
        body: {
          version: 1,
          membership: {
            userId: owner.userId,
            projectId: 'launch-project',
            role: 'reader',
          },
        },
      });

      const invite = await callAdminMcpTool(
        handle.endpoint,
        adminCredential,
        'nova_admin_invite_create',
        { version: 1, projectId: 'launch-project', role: 'reader', ttlMs: 60_000 },
      );
      expect(invite).toMatchObject({
        isError: false,
        body: {
          version: 1,
          invite: {
            projectId: 'launch-project',
            role: 'reader',
            consumedAt: null,
          },
        },
      });

      const pairingBegin = await callAdminMcpTool(
        handle.endpoint,
        adminCredential,
        'nova_admin_device_pair_begin',
        { version: 1, kind: 'admin', ttlMs: 60_000 },
      );
      expect(pairingBegin).toMatchObject({
        isError: false,
        body: { version: 1, expiresAt: expect.any(String) },
      });
      expect(pairingBegin.body).not.toHaveProperty('pairingCode');

      const operations = await callAdminMcpTool(
        handle.endpoint,
        adminCredential,
        'nova_admin_operation_list',
        { version: 1, limit: 10 },
      );
      expect(operations).toMatchObject({
        isError: false,
        body: {
          version: 1,
          configuration: expect.any(Array),
          audit: expect.any(Array),
        },
      });

      // Invalid input is rejected by the mounted production registry before
      // the adapter runs, with a typed nonsecret error and no side effect.
      const invalid = await callAdminMcpTool(
        handle.endpoint,
        adminCredential,
        'nova_admin_device_pair_begin',
        { version: 1, kind: 'project' },
      );
      expect(invalid.isError).toBe(true);
      expect(invalid.body).toEqual({
        code: 'INVALID_INPUT',
        message: 'project device pairing requires projectId.',
      });
    } finally {
      await handle.close();
    }
  });

  it('composes the full workflow status through the project MCP endpoint', async () => {
    const hostHome = newTempDir('fabula-launch-status-');
    const assetsRoot = join(hostHome, 'assets');
    await mkdir(assetsRoot, { recursive: true });
    await writeFile(join(assetsRoot, 'index.html'), '<!doctype html><title>wb</title>');
    const fixtureRoot = resolve(packageRoot, '..', '..', 'fixtures', 'workbench-authoring');
    const projectRoot = join(newTempDir('fabula-launch-status-project-'), 'launch-project');
    await cp(fixtureRoot, projectRoot, { recursive: true });
    const configuration = {
      version: 1 as const,
      projects: [
        {
          projectId: 'launch-project',
          displayName: 'Launch Status Project',
          root: projectRoot,
        },
      ],
      defaultProjectId: 'launch-project',
      provider: null,
      network: {
        mode: 'loopback' as const,
        port: 0,
        allowedHosts: [],
        allowedOrigins: [],
        unixSocket: null,
      },
    };
    await mkdir(join(hostHome, 'config'), { recursive: true });
    await writeFile(
      join(hostHome, 'config', 'workbench.yaml'),
      serializeConfigurationYaml(configuration),
      'utf8',
    );

    const handle = await startWorkbench({
      mode: 'workbench',
      provider: 'mock',
      allowMockProvider: true,
      hostHome,
      databasePath: join(hostHome, 'workbench.sqlite'),
      assetsRoot,
      allowBootstrap: true,
      persistenceWorkerEntry: await workerBundle(),
      workerTerminationTimeoutMs: 2_000,
      host: 'loopback',
      port: 0,
    });
    try {
      expect(handle.projectId).toBe('launch-project');
      const bootstrap = await fetch(`${handle.endpoint}/api/v1/auth/bootstrap`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'a-strong-owner-password', displayName: 'Owner' }),
      });
      expect(bootstrap.status).toBe(200);
      const owner = (await bootstrap.json()) as { sessionId: string };
      const ownerHeaders = { 'x-fabula-session': owner.sessionId };

      const issue = await fetch(`${handle.endpoint}/api/v1/admin/mcp-devices/issue`, {
        method: 'POST',
        headers: { ...ownerHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          kind: 'project',
          projectId: 'launch-project',
          role: 'reader',
          ttlMs: 60_000,
        }),
      });
      expect(issue.status).toBe(200);
      const pairing = (await issue.json()) as { pairingCode: string };
      const claim = await fetch(`${handle.endpoint}/api/v1/admin/mcp-devices`, {
        method: 'POST',
        headers: { ...ownerHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          pairingCode: pairing.pairingCode,
          label: 'launch-status-mcp',
          scopes: ['mcp:read'],
          ttlMs: 60_000,
        }),
      });
      expect(claim.status).toBe(200);
      const claimed = (await claim.json()) as { credential: string };

      const status = await callProjectMcpTool(
        handle.endpoint,
        claimed.credential,
        'launch-project',
        'nova_status',
        {},
      );
      expect(status.isError).toBe(false);
      const workflow = status.body as WorkflowStatusV1;
      expect(workflow.version).toBe(1);
      expect(workflow.projectId).toBe('launch-project');
      expect(workflow.layer).toBe('accepted');
      expect(workflow.sourceHash).toBe(new FileProjectSourceLoader().load(projectRoot).sourceHash);
      // Nothing is rendered yet, so every planned event is ready; no review or
      // publication store exists at this step, so the projections are honest
      // zeros / 'missing' and the deterministic action chain asks to render.
      expect(workflow.validation.passed).toBe(true);
      expect(workflow.render.completed).toEqual([]);
      expect(workflow.render.ready.length).toBeGreaterThan(0);
      expect(workflow.review).toEqual({ open: 0, blocking: 0, pendingGates: 0 });
      expect(workflow.publication).toEqual({
        status: 'missing',
        publicationId: null,
        novelHash: null,
      });
      expect(workflow.nextActions.some((next) => next.code === 'RENDER')).toBe(true);
      expect(typeof workflow.guidance).toBe('string');
      expect(typeof workflow.generatedAt).toBe('string');
    } finally {
      await handle.close();
    }
  });

  it('wires the canonical state projection service and honors snapshotInterval', async () => {
    const hostHome = newTempDir('fabula-launch-projection-');
    const assetsRoot = join(hostHome, 'assets');
    await mkdir(assetsRoot, { recursive: true });
    await writeFile(join(assetsRoot, 'index.html'), '<!doctype html><title>wb</title>');
    // zhu-fu carries `snapshotInterval: 3` in nova.yaml and 14 canonical
    // events — the service must persist snapshots at 3, 6, 9, 12.
    const fixtureRoot = resolve(packageRoot, '..', '..', 'fixtures', 'zhu-fu');
    const projectRoot = join(newTempDir('fabula-launch-projection-project-'), 'launch-project');
    await cp(fixtureRoot, projectRoot, { recursive: true });
    const configuration = {
      version: 1 as const,
      projects: [
        {
          projectId: 'launch-project',
          displayName: 'Launch Projection Project',
          root: projectRoot,
        },
      ],
      defaultProjectId: 'launch-project',
      provider: null,
      network: {
        mode: 'loopback' as const,
        port: 0,
        allowedHosts: [],
        allowedOrigins: [],
        unixSocket: null,
      },
    };
    await mkdir(join(hostHome, 'config'), { recursive: true });
    await writeFile(
      join(hostHome, 'config', 'workbench.yaml'),
      serializeConfigurationYaml(configuration),
      'utf8',
    );

    const handle = await startWorkbench({
      mode: 'workbench',
      provider: 'mock',
      allowMockProvider: true,
      hostHome,
      databasePath: join(hostHome, 'workbench.sqlite'),
      assetsRoot,
      allowBootstrap: true,
      persistenceWorkerEntry: await workerBundle(),
      workerTerminationTimeoutMs: 2_000,
      host: 'loopback',
      port: 0,
    });
    try {
      const bootstrap = await fetch(`${handle.endpoint}/api/v1/auth/bootstrap`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'a-strong-owner-password', displayName: 'Owner' }),
      });
      expect(bootstrap.status).toBe(200);
      const owner = (await bootstrap.json()) as { sessionId: string };
      const ownerHeaders = { 'x-fabula-session': owner.sessionId };
      const issue = await fetch(`${handle.endpoint}/api/v1/admin/mcp-devices/issue`, {
        method: 'POST',
        headers: { ...ownerHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          kind: 'project',
          projectId: 'launch-project',
          role: 'reader',
          ttlMs: 60_000,
        }),
      });
      expect(issue.status).toBe(200);
      const pairing = (await issue.json()) as { pairingCode: string };
      const claim = await fetch(`${handle.endpoint}/api/v1/admin/mcp-devices`, {
        method: 'POST',
        headers: { ...ownerHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          pairingCode: pairing.pairingCode,
          label: 'launch-projection-mcp',
          scopes: ['mcp:read'],
          ttlMs: 60_000,
        }),
      });
      expect(claim.status).toBe(200);
      const claimed = (await claim.json()) as { credential: string };

      // The first event-diff query lazily builds the derived stream through
      // the per-project service and persists interval snapshots.
      const diff = await callProjectMcpTool(
        handle.endpoint,
        claimed.credential,
        'launch-project',
        'nova_event_state_diff',
        { eventId: 'E0' },
      );
      expect(diff.isError).toBe(false);
      const expected = diffEvent(new FileProjectSourceLoader().load(projectRoot), 'E0');
      expect(expected).not.toBeNull();
      if (expected !== null) {
        expect(diff.body).toEqual({
          eventId: 'E0',
          before: expected.before,
          after: expected.after,
          changed: expected.changed,
        });
      }

      // Status reads also flow through the service (per-event canonical
      // order) without disturbing the render path.
      const status = await callProjectMcpTool(
        handle.endpoint,
        claimed.credential,
        'launch-project',
        'nova_status',
        {},
      );
      expect(status.isError).toBe(false);

      // The derived runtime area holds the durable stream + interval
      // snapshots: zhu-fu's 14 canonical events at snapshotInterval 3 →
      // records at sequences 3, 6, 9, 12, each with a verifiable hash.
      const runtimeRoot = join(hostHome, 'projects', 'launch-project', 'runtime');
      const snapshotDir = join(runtimeRoot, 'state-snapshots');
      const snapshotFiles = (await readdir(snapshotDir)).filter((name) => name.endsWith('.json'));
      expect(snapshotFiles.length).toBe(1);
      const stored = JSON.parse(
        await readFile(join(snapshotDir, snapshotFiles[0] ?? ''), 'utf8'),
      ) as {
        key: { streamId: string; branchId: string };
        records: {
          sequence: number;
          schema: string;
          schemaVersion: number;
          state: unknown;
          snapshotHash: string;
        }[];
      };
      expect(stored.key.streamId).toBe(new FileProjectSourceLoader().load(projectRoot).sourceHash);
      expect(stored.records.map((record) => record.sequence)).toEqual([3, 6, 9, 12]);
      const logDir = join(runtimeRoot, 'state-log');
      const logFiles = (await readdir(logDir)).filter((name) => name.endsWith('.json'));
      expect(logFiles.length).toBe(1);
      const log = JSON.parse(await readFile(join(logDir, logFiles[0] ?? ''), 'utf8')) as {
        events: unknown[];
      };
      expect(log.events).toHaveLength(14);
      const sourceHash = new FileProjectSourceLoader().load(projectRoot).sourceHash;
      const eventCount = compileProject(new FileProjectSourceLoader().load(projectRoot)).boundaries
        .orderedEventIds.length;
      expect(eventCount).toBe(14);
      for (const record of stored.records) {
        expect(record.schema).toBe(CANONICAL_WORLD_SCHEMA);
        expect(record.schemaVersion).toBe(CANONICAL_WORLD_SCHEMA_VERSION);
        expect(
          verifySnapshotRecord({
            version: 1,
            key: {
              projectId: 'launch-project',
              streamId: sourceHash,
              branchId: stored.key.branchId,
            },
            schema: record.schema,
            schemaVersion: record.schemaVersion,
            sequence: record.sequence,
            state: record.state,
            snapshotHash: record.snapshotHash,
          }).valid,
        ).toBe(true);
      }
    } finally {
      await handle.close();
    }
  });

  it('exposes review-hub in capabilities and reflects real review counts in nova_status', async () => {
    const hostHome = newTempDir('fabula-launch-review-');
    const assetsRoot = join(hostHome, 'assets');
    await mkdir(assetsRoot, { recursive: true });
    await writeFile(join(assetsRoot, 'index.html'), '<!doctype html><title>wb</title>');
    const fixtureRoot = resolve(packageRoot, '..', '..', 'fixtures', 'workbench-authoring');
    const projectRoot = join(newTempDir('fabula-launch-review-project-'), 'launch-project');
    await cp(fixtureRoot, projectRoot, { recursive: true });
    const configuration = {
      version: 1 as const,
      projects: [
        {
          projectId: 'launch-project',
          displayName: 'Launch Review Project',
          root: projectRoot,
        },
      ],
      defaultProjectId: 'launch-project',
      provider: null,
      network: {
        mode: 'loopback' as const,
        port: 0,
        allowedHosts: [],
        allowedOrigins: [],
        unixSocket: null,
      },
    };
    await mkdir(join(hostHome, 'config'), { recursive: true });
    await writeFile(
      join(hostHome, 'config', 'workbench.yaml'),
      serializeConfigurationYaml(configuration),
      'utf8',
    );

    const handle = await startWorkbench({
      mode: 'workbench',
      provider: 'mock',
      allowMockProvider: true,
      hostHome,
      databasePath: join(hostHome, 'workbench.sqlite'),
      assetsRoot,
      allowBootstrap: true,
      persistenceWorkerEntry: await workerBundle(),
      workerTerminationTimeoutMs: 2_000,
      host: 'loopback',
      port: 0,
    });
    try {
      const bootstrap = await fetch(`${handle.endpoint}/api/v1/auth/bootstrap`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'a-strong-owner-password', displayName: 'Owner' }),
      });
      expect(bootstrap.status).toBe(200);
      const owner = (await bootstrap.json()) as { sessionId: string };
      const ownerHeaders = { 'x-fabula-session': owner.sessionId };

      // The review MCP tools + status projection are wired, so the browser
      // surface may advertise review-hub through the capabilities route.
      const capabilities = await fetch(
        `${handle.endpoint}/api/v1/projects/launch-project/capabilities`,
        { headers: ownerHeaders },
      );
      expect(capabilities.status).toBe(200);
      const capabilitiesBody = (await capabilities.json()) as {
        version: number;
        projectId: string;
        features: string[];
      };
      expect(capabilitiesBody.features).toContain('review-hub');
      // The publication service + MCP tools + browser routes are wired, so
      // the browser surface advertises the publication capability (plan 6.6).
      expect(capabilitiesBody.features).toContain('publication');

      const issue = await fetch(`${handle.endpoint}/api/v1/admin/mcp-devices/issue`, {
        method: 'POST',
        headers: { ...ownerHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          kind: 'project',
          projectId: 'launch-project',
          role: 'author',
          ttlMs: 60_000,
        }),
      });
      expect(issue.status).toBe(200);
      const pairing = (await issue.json()) as { pairingCode: string };
      const claim = await fetch(`${handle.endpoint}/api/v1/admin/mcp-devices`, {
        method: 'POST',
        headers: { ...ownerHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          pairingCode: pairing.pairingCode,
          label: 'launch-review-mcp',
          scopes: ['mcp:read', 'mcp:author'],
          ttlMs: 60_000,
        }),
      });
      expect(claim.status).toBe(200);
      const claimed = (await claim.json()) as { credential: string };

      const added = await callProjectMcpTool(
        handle.endpoint,
        claimed.credential,
        'launch-project',
        'nova_review_add',
        {
          version: 1,
          target: { type: 'novel', id: 'novel' },
          severity: 'suggestion',
          category: 'style',
          content: 'Consider tightening the opening chapter.',
        },
      );
      expect(added.isError).toBe(false);
      expect(added.body).toMatchObject({ version: 1, comment: { status: 'open' } });

      const listed = await callProjectMcpTool(
        handle.endpoint,
        claimed.credential,
        'launch-project',
        'nova_review_list',
        { version: 1 },
      );
      expect(listed.isError).toBe(false);
      expect(listed.body.items).toHaveLength(1);
      expect(listed.body.items[0]).toMatchObject({
        target: { type: 'novel', id: 'novel' },
        severity: 'suggestion',
        status: 'open',
      });

      // nova_status reads the live review projection, not honest zeros.
      const status = await callProjectMcpTool(
        handle.endpoint,
        claimed.credential,
        'launch-project',
        'nova_status',
        {},
      );
      expect(status.isError).toBe(false);
      const workflow = status.body as WorkflowStatusV1;
      expect(workflow.review).toEqual({ open: 1, blocking: 0, pendingGates: 0 });
    } finally {
      await handle.close();
    }
  });

  it('completes a device-mode nova_render through the project MCP endpoint, not DENIED', async () => {
    const hostHome = newTempDir('fabula-launch-device-render-');
    const assetsRoot = join(hostHome, 'assets');
    await mkdir(assetsRoot, { recursive: true });
    await writeFile(join(assetsRoot, 'index.html'), '<!doctype html><title>wb</title>');
    const fixtureRoot = resolve(packageRoot, '..', '..', 'fixtures', 'zhu-fu');
    const projectRoot = join(newTempDir('fabula-launch-device-render-project-'), 'launch-project');
    await cp(fixtureRoot, projectRoot, { recursive: true });
    // The zhu-fu fixture declares `project: zhu-fu`; the session/execution
    // repo key accepted scenes by the SOURCE's project id, so the copied
    // fixture must carry the configured project id for the promotion to be
    // observable through nova_status (same rewrite as the lease tests).
    await writeFile(
      join(projectRoot, 'nova.yaml'),
      (await readFile(join(projectRoot, 'nova.yaml'), 'utf8')).replace(
        /^project: zhu-fu$/m,
        'project: launch-project',
      ),
    );
    const configuration = {
      version: 1 as const,
      projects: [
        {
          projectId: 'launch-project',
          displayName: 'Launch Device Render',
          root: projectRoot,
        },
      ],
      defaultProjectId: 'launch-project',
      provider: null,
      network: {
        mode: 'loopback' as const,
        port: 0,
        allowedHosts: [],
        allowedOrigins: [],
        unixSocket: null,
      },
    };
    await mkdir(join(hostHome, 'config'), { recursive: true });
    await writeFile(
      join(hostHome, 'config', 'workbench.yaml'),
      serializeConfigurationYaml(configuration),
      'utf8',
    );

    const handle = await startWorkbench({
      mode: 'workbench',
      provider: 'mock',
      allowMockProvider: true,
      hostHome,
      databasePath: join(hostHome, 'workbench.sqlite'),
      assetsRoot,
      allowBootstrap: true,
      persistenceWorkerEntry: await workerBundle(),
      workerTerminationTimeoutMs: 2_000,
      host: 'loopback',
      port: 0,
    });
    try {
      const bootstrap = await fetch(`${handle.endpoint}/api/v1/auth/bootstrap`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'a-strong-owner-password', displayName: 'Owner' }),
      });
      expect(bootstrap.status).toBe(200);
      const owner = (await bootstrap.json()) as { sessionId: string };
      const ownerHeaders = { 'x-fabula-session': owner.sessionId };
      const issue = await fetch(`${handle.endpoint}/api/v1/admin/mcp-devices/issue`, {
        method: 'POST',
        headers: { ...ownerHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          kind: 'project',
          projectId: 'launch-project',
          role: 'maintainer',
          ttlMs: 60_000,
        }),
      });
      expect(issue.status).toBe(200);
      const pairing = (await issue.json()) as { pairingCode: string };
      const claim = await fetch(`${handle.endpoint}/api/v1/admin/mcp-devices`, {
        method: 'POST',
        headers: { ...ownerHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          pairingCode: pairing.pairingCode,
          label: 'launch-device-render-mcp',
          scopes: ['mcp:render', 'mcp:submit', 'mcp:read'],
          ttlMs: 60_000,
        }),
      });
      expect(claim.status).toBe(200);
      const claimed = (await claim.json()) as { credential: string };

      // The device caller's grant is persisted at authorize time; the session
      // gate re-loads the durable row for the render prepare/commit phases.
      const render = await callProjectMcpTool(
        handle.endpoint,
        claimed.credential,
        'launch-project',
        'nova_render',
        { sceneSelector: { type: 'events', eventIds: ['E0'] } },
      );
      expect(render.isError).toBe(false);
      const enqueued = render.body;
      if (
        enqueued === null ||
        typeof enqueued !== 'object' ||
        Array.isArray(enqueued) ||
        !('status' in enqueued) ||
        !('operationHandle' in enqueued) ||
        typeof enqueued.operationHandle !== 'string'
      ) {
        throw new Error(`nova_render enqueue payload is malformed: ${JSON.stringify(enqueued)}`);
      }
      expect(enqueued.status).toBe('queued');
      const operationHandle = enqueued.operationHandle;

      // Poll the durable operation. A NOT_FOUND denial from the session gate
      // would surface here as failed/DENIED; the persisted device row must
      // carry the operation to a terminal completed status. The operation
      // runs on the host's async queue with no event surface to await, so a
      // short real-time poll is required (same convention as `waitFor` in
      // mcp-auth-registry.test.ts).
      const deadline = Date.now() + 30_000;
      let terminalStatus: string | null = null;
      let terminalErrorCode: string | null = null;
      for (;;) {
        const poll = await callProjectMcpTool(
          handle.endpoint,
          claimed.credential,
          'launch-project',
          'nova_operation_get',
          { version: 2, operationHandle },
        );
        expect(poll.isError, JSON.stringify(poll.body)).toBe(false);
        const body = poll.body;
        if (
          body !== null &&
          typeof body === 'object' &&
          !Array.isArray(body) &&
          'receipt' in body &&
          body.receipt !== null &&
          typeof body.receipt === 'object' &&
          'status' in body.receipt &&
          typeof body.receipt.status === 'string'
        ) {
          terminalStatus = body.receipt.status;
          terminalErrorCode =
            'errorCode' in body.receipt && typeof body.receipt.errorCode === 'string'
              ? body.receipt.errorCode
              : null;
        }
        if (terminalStatus !== null && !['queued', 'running'].includes(terminalStatus)) break;
        if (Date.now() > deadline) {
          throw new Error(`device render did not reach a terminal status: ${JSON.stringify(body)}`);
        }
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 50);
        await promise;
      }
      // Not DENIED: the durable receipt is terminal and carries no gate error.
      expect(terminalStatus).toBe('completed');
      expect(terminalErrorCode).toBeNull();

      // The deterministic mock resolves the Pass-2 analysis per event from
      // the project's `reference/data` fixtures, so the release decision
      // ACCEPTS and the scene is promoted into the accepted layer: the
      // composed workflow must now report the rendered event as completed
      // (this is the regression the bare shared MockProvider broke — its
      // non-JSON Pass-2 echo left analysis null and every release blocked).
      const status = await callProjectMcpTool(
        handle.endpoint,
        claimed.credential,
        'launch-project',
        'nova_status',
        {},
      );
      expect(status.isError).toBe(false);
      const workflow = status.body as WorkflowStatusV1;
      expect(workflow.render.completed).toContain('E0');
      expect(workflow.render.ready).not.toContain('E0');
      expect(workflow.layer).toBe('accepted');
    } finally {
      await handle.close();
    }
  });
});

// ─── Project write authority lease (single-authority guarantee) ─────────────

describe('project write authority lease', () => {
  const leaseFixtureRoot = resolve(packageRoot, '..', '..', 'fixtures', 'workbench-authoring');

  /** Copy the authoring fixture into a fresh root and rewrite its project id. */
  async function leaseProjectRoot(prefix: string, projectId: string): Promise<string> {
    const root = join(newTempDir(prefix), projectId);
    await cp(leaseFixtureRoot, root, { recursive: true });
    const novaPath = join(root, 'nova.yaml');
    await writeFile(
      novaPath,
      (await readFile(novaPath, 'utf8')).replace(
        /^project: workbench-authoring$/m,
        `project: ${projectId}`,
      ),
    );
    return root;
  }

  async function leaseLaunchConfig(
    hostHome: string,
    projectRoot: string,
    projectId: string,
  ): Promise<WorkbenchLaunchConfig> {
    const assetsRoot = join(hostHome, 'assets');
    await mkdir(assetsRoot, { recursive: true });
    await writeFile(join(assetsRoot, 'index.html'), '<!doctype html><title>wb</title>');
    return {
      mode: 'workbench',
      provider: 'mock',
      allowMockProvider: true,
      hostHome,
      databasePath: join(hostHome, 'workbench.sqlite'),
      assetsRoot,
      allowBootstrap: false,
      persistenceWorkerEntry: await workerBundle(),
      workerTerminationTimeoutMs: 2_000,
      host: 'loopback',
      port: 0,
      projectRoot,
      projectId,
    };
  }

  it('rejects a second Host opening the same project root while authority is held', async () => {
    const sharedRoot = await leaseProjectRoot('fabula-lease-shared-', 'shared-project');
    const first = await startWorkbench(
      await leaseLaunchConfig(newTempDir('fabula-lease-host1-'), sharedRoot, 'shared-project'),
    );
    try {
      const secondConfig = await leaseLaunchConfig(
        newTempDir('fabula-lease-host2-'),
        sharedRoot,
        'shared-project',
      );
      // A different WORKBENCH_HOME with the same project root must not become
      // a second authority: the project open fails with the typed error.
      const error = await startWorkbench(secondConfig).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ProjectAuthorityUnavailableError);
      expect(String((error as Error).message)).toMatch(/authority/i);
    } finally {
      await first.close();
    }
  });

  it('releases the project authority on close so another Host can re-acquire', async () => {
    const sharedRoot = await leaseProjectRoot('fabula-lease-reacquire-', 'shared-project');
    const first = await startWorkbench(
      await leaseLaunchConfig(newTempDir('fabula-lease-rehost1-'), sharedRoot, 'shared-project'),
    );
    await first.close();
    // After close the instance-CAS release removed the lease; a fresh Host
    // over the same root opens normally.
    const second = await startWorkbench(
      await leaseLaunchConfig(newTempDir('fabula-lease-rehost2-'), sharedRoot, 'shared-project'),
    );
    await second.close();
  });

  it('surfaces recovery-required and never writes when the lease is lost during materialize', async () => {
    const root = await leaseProjectRoot('fabula-lease-materialize-', 'lease-project');
    const coordinator = new ProjectWriteCoordinator(root, { projectId: 'lease-project' });
    const nonce = 'materialize-test-nonce';
    const token = await coordinator.acquireWorkbenchAuthority(nonce);
    await coordinator.release(nonce); // lease lost while the project is open
    const materializer = createFileSourceViewMaterializer({
      projectRoot: root,
      coordinator,
      authorityToken: token,
    });
    const before = await readFile(join(root, 'nova.yaml'), 'utf8');
    const snapshot = new FileProjectSourceLoader().load(root);
    const request = {
      projectId: 'lease-project',
      expectedMaterializedRevisionId: null,
      expectedTreeHash: snapshot.sourceHash,
      bundle: {
        bundleHash: 'lease-test-bundle',
        entries: snapshot.documents.map((document) => ({
          logicalPath: document.logicalPath,
          content: document.content,
        })),
      },
    };
    const outcome = await materializer.materialize(request);
    expect(outcome).toEqual({
      status: 'recovery-required',
      reason: 'project authority lease lost; recovery required',
    });
    // No write happened: tree bytes and the materialized marker are untouched.
    expect(await readFile(join(root, 'nova.yaml'), 'utf8')).toBe(before);
    expect(existsSync(join(root, '.nova', 'authoring', 'materialized-revision.json'))).toBe(false);
    // With a live lease the same materialization completes, proving the
    // authority path writes through and is not just failing closed.
    const liveToken = await coordinator.acquireWorkbenchAuthority(nonce);
    const completed = await materializer.materialize(request);
    expect(completed).toEqual({ status: 'completed', treeHash: snapshot.sourceHash });
    expect(existsSync(join(root, '.nova', 'authoring', 'materialized-revision.json'))).toBe(true);
    void liveToken;
  });

  it('constructs a distinct provider per project profile and passes it into each session', async () => {
    const hostHome = newTempDir('fabula-lease-profiles-');
    const assetsRoot = join(hostHome, 'assets');
    await mkdir(assetsRoot, { recursive: true });
    await writeFile(join(assetsRoot, 'index.html'), '<!doctype html><title>wb</title>');
    const rootA = await leaseProjectRoot('fabula-lease-profile-a-', 'profile-a');
    const rootB = await leaseProjectRoot('fabula-lease-profile-b-', 'profile-b');
    const configuration = {
      version: 3 as const,
      projects: [
        {
          projectId: 'profile-a',
          displayName: 'Profile A',
          root: rootA,
          revisionMirror: { mode: 'disabled' as const },
          providerProfile: 'alpha',
          trustedPlugins: [],
        },
        {
          projectId: 'profile-b',
          displayName: 'Profile B',
          root: rootB,
          revisionMirror: { mode: 'disabled' as const },
          providerProfile: 'beta',
          trustedPlugins: [],
        },
      ],
      defaultProjectId: 'profile-a',
      providers: {
        alpha: { kind: 'ai-sdk' as const, baseUrl: 'https://alpha.test/v1', model: 'm-alpha' },
        beta: { kind: 'ai-sdk' as const, baseUrl: 'https://beta.test/v1', model: 'm-beta' },
      },
      network: {
        mode: 'loopback' as const,
        port: 0,
        allowedHosts: [],
        allowedOrigins: [],
        unixSocket: null,
      },
      referenceLimits: DEFAULT_WORKBENCH_REFERENCE_LIMITS_V2,
      operationLimits: {
        maxQueuedPerProject: 64,
        maxConcurrentRendersPerProject: 1 as const,
        maxConcurrentRendersPerHost: 2,
      },
      agent: { enabled: false, maxTurns: 16, maxToolCalls: 64 },
    };
    await mkdir(join(hostHome, 'config'), { recursive: true });
    await writeFile(
      join(hostHome, 'config', 'workbench.yaml'),
      serializeConfigurationYaml(configuration),
      'utf8',
    );
    const constructed: { profileId: string; profileConfig: unknown }[] = [];
    const factoryDouble = {
      createForProfile: vi.fn(async (profileId: string, profileConfig: unknown) => {
        constructed.push({ profileId, profileConfig });
        return {
          name: `provider-${profileId}`,
          complete: async () => 'ok',
        };
      }),
    } as unknown as HostProviderFactory;
    const handle = await startWorkbench({
      mode: 'workbench',
      provider: 'mock',
      allowMockProvider: true,
      hostHome,
      databasePath: join(hostHome, 'workbench.sqlite'),
      assetsRoot,
      allowBootstrap: false,
      persistenceWorkerEntry: await workerBundle(),
      workerTerminationTimeoutMs: 2_000,
      host: 'loopback',
      port: 0,
      providerFactory: factoryDouble,
    });
    try {
      // The injected factory is the handle's admin validation surface.
      expect(handle.provider).toBe(factoryDouble);
      // Each configured project built its own provider from its own profile:
      // one session never reuses another session's runtime provider.
      expect(constructed).toHaveLength(2);
      expect(constructed[0]).toMatchObject({
        profileId: 'alpha',
        profileConfig: { baseUrl: 'https://alpha.test/v1', model: 'm-alpha' },
      });
      expect(constructed[1]).toMatchObject({
        profileId: 'beta',
        profileConfig: { baseUrl: 'https://beta.test/v1', model: 'm-beta' },
      });
      expect(constructed[0]?.profileId).not.toBe(constructed[1]?.profileId);
    } finally {
      await handle.close();
    }
  });
});

// ─── Trusted plugin activation (plan 7) ──────────────────────────────────────

describe('trusted plugin activation and discovery (plan 7)', () => {
  const pluginFixtureRoot = resolve(packageRoot, '..', '..', 'fixtures', 'workbench-authoring');

  /** index.js for one on-disk plugin: logs load/unload to a lifecycle file. */
  function pluginIndexSource(name: string): string {
    return [
      "import { appendFileSync } from 'node:fs';",
      "const logFile = new URL('../../plugin-lifecycle.log', import.meta.url);",
      `const line = (text) => appendFileSync(logFile, text + '\\n');`,
      'export const hooks = {',
      `  name: '${name}',`,
      `  onLoad: async () => { line('load:${name}'); },`,
      `  onUnload: async () => { line('unload:${name}'); },`,
      '};',
      '',
    ].join('\n');
  }

  const moduleHashOf = (name: string): string =>
    createHash('sha256').update(pluginIndexSource(name)).digest('hex');

  async function pluginProjectRoot(
    prefix: string,
    options: { enabled: boolean; pluginNames: readonly string[] },
  ): Promise<{ root: string; lifecycleLog: string }> {
    const root = join(newTempDir(prefix), 'launch-project');
    await cp(pluginFixtureRoot, root, { recursive: true });
    const nova = await readFile(join(root, 'nova.yaml'), 'utf8');
    await writeFile(
      join(root, 'nova.yaml'),
      options.enabled ? `${nova}plugins:\n  enabled: true\n` : nova,
      'utf8',
    );
    if (options.pluginNames.length > 0) {
      await mkdir(join(root, 'plugins'), { recursive: true });
      for (const name of options.pluginNames) {
        const dir = join(root, 'plugins', name);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'index.js'), pluginIndexSource(name), 'utf8');
        await writeFile(
          join(dir, 'manifest.yaml'),
          [
            `name: ${name}`,
            'version: 1.0.0',
            'priority: 1',
            'provides: []',
            'requires: []',
            'conflicts: []',
            'authority:',
            '  dimensions: []',
            '  exclusive: false',
            'observes:',
            '  eventTypes: []',
            '  stateDomains: []',
            '',
          ].join('\n'),
          'utf8',
        );
      }
    }
    return { root, lifecycleLog: join(root, 'plugin-lifecycle.log') };
  }

  type TestTrustedPlugin = {
    readonly name: string;
    readonly version: string;
    readonly moduleHash: string;
    readonly required: boolean;
  };

  function v3Configuration(
    root: string,
    trustedPlugins: readonly TestTrustedPlugin[],
  ): Parameters<typeof serializeConfigurationYaml>[0] {
    return {
      version: 3,
      projects: [
        {
          projectId: 'launch-project',
          displayName: 'Plugin Project',
          root,
          revisionMirror: { mode: 'disabled' },
          providerProfile: 'default',
          trustedPlugins,
        },
      ],
      defaultProjectId: 'launch-project',
      providers: {},
      network: {
        mode: 'loopback',
        port: 0,
        allowedHosts: [],
        allowedOrigins: [],
        unixSocket: null,
      },
      referenceLimits: DEFAULT_WORKBENCH_REFERENCE_LIMITS_V2,
      operationLimits: DEFAULT_WORKBENCH_OPERATION_LIMITS_V3,
      agent: { enabled: false, maxTurns: 16, maxToolCalls: 64 },
    };
  }

  async function bootPluginHost(
    prefix: string,
    root: string,
    trustedPlugins: readonly TestTrustedPlugin[],
  ): Promise<{
    handle: WorkbenchLaunchHandle;
    credential: string;
    ownerHeaders: Record<string, string>;
  }> {
    const hostHome = newTempDir(prefix);
    const assetsRoot = join(hostHome, 'assets');
    await mkdir(assetsRoot, { recursive: true });
    await writeFile(join(assetsRoot, 'index.html'), '<!doctype html><title>wb</title>');
    await mkdir(join(hostHome, 'config'), { recursive: true });
    await writeFile(
      join(hostHome, 'config', 'workbench.yaml'),
      serializeConfigurationYaml(v3Configuration(root, trustedPlugins)),
      'utf8',
    );
    const handle = await startWorkbench({
      mode: 'workbench',
      provider: 'mock',
      allowMockProvider: true,
      hostHome,
      databasePath: join(hostHome, 'workbench.sqlite'),
      assetsRoot,
      allowBootstrap: true,
      persistenceWorkerEntry: await workerBundle(),
      workerTerminationTimeoutMs: 2_000,
      host: 'loopback',
      port: 0,
    });
    try {
      const bootstrap = await fetch(`${handle.endpoint}/api/v1/auth/bootstrap`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'a-strong-owner-password', displayName: 'Owner' }),
      });
      expect(bootstrap.status).toBe(200);
      const owner = (await bootstrap.json()) as { sessionId: string };
      const ownerHeaders = { 'x-fabula-session': owner.sessionId };
      const issue = await fetch(`${handle.endpoint}/api/v1/admin/mcp-devices/issue`, {
        method: 'POST',
        headers: { ...ownerHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          kind: 'project',
          projectId: 'launch-project',
          role: 'reader',
          ttlMs: 60_000,
        }),
      });
      expect(issue.status).toBe(200);
      const pairing = (await issue.json()) as { pairingCode: string };
      const claim = await fetch(`${handle.endpoint}/api/v1/admin/mcp-devices`, {
        method: 'POST',
        headers: { ...ownerHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          pairingCode: pairing.pairingCode,
          label: 'plugin-launch-mcp',
          scopes: ['mcp:read'],
          ttlMs: 60_000,
        }),
      });
      expect(claim.status).toBe(200);
      const claimed = (await claim.json()) as { credential: string };
      return { handle, credential: claimed.credential, ownerHeaders };
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  it('activates matching trusted plugins, injects the hooks manager, and shuts down in reverse order', async () => {
    const { root, lifecycleLog } = await pluginProjectRoot('fabula-plugin-active-', {
      enabled: true,
      pluginNames: ['plugin-a', 'plugin-b'],
    });
    const host = await bootPluginHost('fabula-plugin-active-host-', root, [
      { name: 'plugin-a', version: '1.0.0', moduleHash: moduleHashOf('plugin-a'), required: true },
      { name: 'plugin-b', version: '1.0.0', moduleHash: moduleHashOf('plugin-b'), required: false },
    ]);
    try {
      expect(host.handle.projectId).toBe('launch-project');
      // Both plugins loaded in name-sorted registration order.
      expect(await readFile(lifecycleLog, 'utf8')).toBe('load:plugin-a\nload:plugin-b\n');
      const status = await callProjectMcpTool(
        host.handle.endpoint,
        host.credential,
        'launch-project',
        'nova_status',
        {},
      );
      expect(status.isError).toBe(false);
      const workflow = status.body as WorkflowStatusV1;
      expect(workflow.guidance.startsWith('Plugin health: 2 active, 0 blocked, 0 disabled.')).toBe(
        true,
      );
      expect(workflow.blockers.some((blocker) => blocker.code === 'PLUGIN_BLOCKED')).toBe(false);
    } finally {
      await host.handle.close();
    }
    // Host close runs onUnload in reverse registration order: b before a.
    expect(await readFile(lifecycleLog, 'utf8')).toBe(
      'load:plugin-a\nload:plugin-b\nunload:plugin-b\nunload:plugin-a\n',
    );
  });

  it('keeps the project open with a blocking diagnostic when a required plugin fails identity verification', async () => {
    const { root, lifecycleLog } = await pluginProjectRoot('fabula-plugin-mismatch-', {
      enabled: true,
      pluginNames: ['plugin-a'],
    });
    const host = await bootPluginHost('fabula-plugin-mismatch-host-', root, [
      { name: 'plugin-a', version: '9.9.9', moduleHash: moduleHashOf('plugin-a'), required: true },
    ]);
    try {
      // The project still opens despite the required-plugin failure.
      expect(host.handle.projectId).toBe('launch-project');
      // The plugin never loaded: no onLoad side effects.
      expect(existsSync(lifecycleLog)).toBe(false);
      const status = await callProjectMcpTool(
        host.handle.endpoint,
        host.credential,
        'launch-project',
        'nova_status',
        {},
      );
      expect(status.isError).toBe(false);
      const workflow = status.body as WorkflowStatusV1;
      expect(workflow.guidance.startsWith('Plugin health: 0 active, 1 blocked, 0 disabled.')).toBe(
        true,
      );
      const pluginBlocker = workflow.blockers.find((blocker) => blocker.code === 'PLUGIN_BLOCKED');
      expect(pluginBlocker).toBeDefined();
      expect(pluginBlocker?.message).toContain('plugin-a');
      expect(pluginBlocker?.severity).toBe('error');
    } finally {
      await host.handle.close();
    }
    // A blocked activation has no hooks manager: nothing to shut down.
    expect(existsSync(lifecycleLog)).toBe(false);
  });

  it('never activates plugins when nova.yaml.plugins.enabled is false', async () => {
    const { root, lifecycleLog } = await pluginProjectRoot('fabula-plugin-disabled-', {
      enabled: false,
      pluginNames: ['plugin-a'],
    });
    const host = await bootPluginHost('fabula-plugin-disabled-host-', root, [
      { name: 'plugin-a', version: '1.0.0', moduleHash: moduleHashOf('plugin-a'), required: true },
    ]);
    try {
      const status = await callProjectMcpTool(
        host.handle.endpoint,
        host.credential,
        'launch-project',
        'nova_status',
        {},
      );
      expect(status.isError).toBe(false);
      const workflow = status.body as WorkflowStatusV1;
      // No activation: no plugin health line, no plugin blockers.
      expect(workflow.guidance.startsWith('Plugin health:')).toBe(false);
      expect(workflow.blockers.some((blocker) => blocker.code === 'PLUGIN_BLOCKED')).toBe(false);
      expect(existsSync(lifecycleLog)).toBe(false);
    } finally {
      await host.handle.close();
    }
    expect(existsSync(lifecycleLog)).toBe(false);
  });

  it('exposes name-sorted discovered plugin identities through the owner admin route', async () => {
    // Discovery is independent of the activation intent flag: the owner admin
    // must see on-disk identities before deciding what to trust.
    const { root } = await pluginProjectRoot('fabula-plugin-discovery-', {
      enabled: false,
      pluginNames: ['plugin-zeta', 'plugin-alpha'],
    });
    const host = await bootPluginHost('fabula-plugin-discovery-host-', root, []);
    try {
      const discovered = await fetch(
        `${host.handle.endpoint}/api/v1/admin/plugins/discovered/launch-project`,
        { headers: host.ownerHeaders },
      );
      expect(discovered.status).toBe(200);
      const body = (await discovered.json()) as {
        version: number;
        projectId: string;
        plugins: readonly {
          name: string;
          version: string;
          manifestHash: string;
          moduleHash: string | null;
          hookNames: readonly string[];
        }[];
      };
      expect(body.version).toBe(1);
      expect(body.projectId).toBe('launch-project');
      expect(body.plugins.map((plugin) => plugin.name)).toEqual(['plugin-alpha', 'plugin-zeta']);
      for (const plugin of body.plugins) {
        expect(plugin.version).toBe('1.0.0');
        expect(plugin.moduleHash).toBe(moduleHashOf(plugin.name));
        expect(plugin.manifestHash).toMatch(/^[0-9a-f]{64}$/);
        expect([...plugin.hookNames].sort()).toEqual(['onLoad', 'onUnload']);
      }
      // Unknown project maps to the typed not-found error.
      const missing = await fetch(`${host.handle.endpoint}/api/v1/admin/plugins/discovered/nope`, {
        headers: host.ownerHeaders,
      });
      expect(missing.status).toBe(404);
    } finally {
      await host.handle.close();
    }
  });
});

// ─── Agent chat capability gate (plan 9.4-9.6) ───────────────────────────────
// The `agent-chat` feature must be derived ONLY from the full gate: V3
// agent.enabled === true AND the tool-calling model port AND the parity
// flag. Disabled Agent ⇒ no feature, no route. Enabled + parity ⇒ feature
// present and the guarded routes are mounted.

describe('agent-chat launch capability gate', () => {
  /** Shared V1 launch (agent defaults to disabled under normalization). */
  async function bootDisabledAgent(): Promise<{
    handle: WorkbenchLaunchHandle;
    ownerHeaders: Record<string, string>;
    endpoint: string;
  }> {
    const hostHome = newTempDir('fabula-launch-agent-off-');
    const assetsRoot = join(hostHome, 'assets');
    await mkdir(assetsRoot, { recursive: true });
    await writeFile(join(assetsRoot, 'index.html'), '<!doctype html><title>wb</title>');
    const fixtureRoot = resolve(packageRoot, '..', '..', 'fixtures', 'workbench-authoring');
    const projectRoot = join(newTempDir('fabula-launch-agent-project-'), 'agent-project');
    await cp(fixtureRoot, projectRoot, { recursive: true });
    await writeFile(
      join(projectRoot, 'nova.yaml'),
      (await readFile(join(projectRoot, 'nova.yaml'), 'utf8')).replace(
        /^project: workbench-authoring$/m,
        'project: agent-project',
      ),
    );
    const configuration = {
      version: 1 as const,
      projects: [{ projectId: 'agent-project', displayName: 'Agent Project', root: projectRoot }],
      defaultProjectId: 'agent-project',
      provider: null,
      network: {
        mode: 'loopback' as const,
        port: 0,
        allowedHosts: [],
        allowedOrigins: [],
        unixSocket: null,
      },
    };
    await mkdir(join(hostHome, 'config'), { recursive: true });
    await writeFile(
      join(hostHome, 'config', 'workbench.yaml'),
      serializeConfigurationYaml(configuration),
      'utf8',
    );
    const handle = await startWorkbench({
      mode: 'workbench',
      provider: 'mock',
      allowMockProvider: true,
      hostHome,
      databasePath: join(hostHome, 'workbench.sqlite'),
      assetsRoot,
      allowBootstrap: true,
      persistenceWorkerEntry: await workerBundle(),
      workerTerminationTimeoutMs: 2_000,
      host: 'loopback',
      port: 0,
    });
    const bootstrap = await fetch(`${handle.endpoint}/api/v1/auth/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'a-strong-owner-password', displayName: 'Owner' }),
    });
    expect(bootstrap.status).toBe(200);
    const { sessionId } = (await bootstrap.json()) as { sessionId: string };
    return { handle, ownerHeaders: { 'x-fabula-session': sessionId }, endpoint: handle.endpoint };
  }

  it('keeps agent-chat absent when the Agent is disabled (no feature, no route)', async () => {
    const { handle, ownerHeaders, endpoint } = await bootDisabledAgent();
    try {
      const capabilities = await fetch(`${endpoint}/api/v1/projects/agent-project/capabilities`, {
        headers: ownerHeaders,
      });
      expect(capabilities.status).toBe(200);
      const body = (await capabilities.json()) as { features: readonly string[] };
      expect(body.features).not.toContain('agent-chat');

      // The guarded agent routes are not registered at all: 404 at the listener.
      const conversations = await fetch(
        `${endpoint}/api/v1/projects/agent-project/agent/conversations`,
        {
          method: 'POST',
          headers: { ...ownerHeaders, 'content-type': 'application/json' },
          body: JSON.stringify({ version: 1 }),
        },
      );
      expect(conversations.status).toBe(404);
      const history = await fetch(
        `${endpoint}/api/v1/projects/agent-project/agent/conversations/conv-1/history`,
        { headers: ownerHeaders },
      );
      expect(history.status).toBe(404);
    } finally {
      await handle.close();
    }
  });

  it('exposes agent-chat only when enabled + parity flag pass, and keeps it absent without the flag', async () => {
    const hostHome = newTempDir('fabula-launch-agent-on-');
    const assetsRoot = join(hostHome, 'assets');
    await mkdir(assetsRoot, { recursive: true });
    await writeFile(join(assetsRoot, 'index.html'), '<!doctype html><title>wb</title>');
    const fixtureRoot = resolve(packageRoot, '..', '..', 'fixtures', 'workbench-authoring');
    const projectRoot = join(newTempDir('fabula-launch-agent-on-project-'), 'agent-project');
    await cp(fixtureRoot, projectRoot, { recursive: true });
    await writeFile(
      join(projectRoot, 'nova.yaml'),
      (await readFile(join(projectRoot, 'nova.yaml'), 'utf8')).replace(
        /^project: workbench-authoring$/m,
        'project: agent-project',
      ),
    );
    const v3Configuration = {
      version: 3 as const,
      projects: [
        {
          projectId: 'agent-project',
          displayName: 'Agent Project',
          root: projectRoot,
          providerProfile: 'default',
          revisionMirror: { mode: 'disabled' as const },
          trustedPlugins: [],
        },
      ],
      defaultProjectId: 'agent-project',
      providers: {},
      network: {
        mode: 'loopback' as const,
        port: 0,
        allowedHosts: [],
        allowedOrigins: [],
        unixSocket: null,
      },
      referenceLimits: { ...DEFAULT_WORKBENCH_REFERENCE_LIMITS_V2 },
      operationLimits: { ...DEFAULT_WORKBENCH_OPERATION_LIMITS_V3 },
      agent: { enabled: true, maxTurns: 4, maxToolCalls: 8 },
    };
    await mkdir(join(hostHome, 'config'), { recursive: true });
    // The V3 configuration is persisted directly: the launch's projectAccess
    // catalog and the agent gate both read it.
    await writeFile(
      join(hostHome, 'config', 'workbench.yaml'),
      serializeConfigurationYaml(v3Configuration as never),
      'utf8',
    );

    const workerEntry = await workerBundle();
    const boot = (agentReady: boolean | undefined, databasePath: string) =>
      startWorkbench({
        mode: 'workbench',
        provider: 'mock',
        allowMockProvider: true,
        hostHome,
        databasePath,
        assetsRoot,
        allowBootstrap: true,
        persistenceWorkerEntry: workerEntry,
        workerTerminationTimeoutMs: 2_000,
        host: 'loopback',
        port: 0,
        // Deterministic tool-calling port (parity fixture shape); the real
        // launch constructs the credential-backed adapter.
        agentModel: {
          supportsToolCalls: true,
          run: async function* () {
            yield { type: 'finish', finishReason: 'stop' };
          },
        },
        ...(agentReady === undefined ? {} : { agentReady }),
      });

    // Without the parity flag the gate fails even though agent.enabled is true.
    const noFlagDatabase = join(newTempDir('fabula-launch-agent-on-db-'), 'workbench.sqlite');
    const noFlag = await boot(undefined, noFlagDatabase);
    try {
      const bootstrap = await fetch(`${noFlag.endpoint}/api/v1/auth/bootstrap`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'a-strong-owner-password', displayName: 'Owner' }),
      });
      const { sessionId } = (await bootstrap.json()) as { sessionId: string };
      const capabilities = await fetch(
        `${noFlag.endpoint}/api/v1/projects/agent-project/capabilities`,
        {
          headers: { 'x-fabula-session': sessionId },
        },
      );
      const body = (await capabilities.json()) as { features: readonly string[] };
      expect(body.features).not.toContain('agent-chat');
    } finally {
      await noFlag.close();
    }

    // With enabled + parity the feature appears and the conversation route lives.
    const flagged = await boot(true, join(hostHome, 'workbench.sqlite'));
    try {
      const bootstrap = await fetch(`${flagged.endpoint}/api/v1/auth/bootstrap`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'a-strong-owner-password', displayName: 'Owner' }),
      });
      const { sessionId } = (await bootstrap.json()) as { sessionId: string };
      const headers = { 'x-fabula-session': sessionId };
      const capabilities = await fetch(
        `${flagged.endpoint}/api/v1/projects/agent-project/capabilities`,
        {
          headers,
        },
      );
      expect(capabilities.status).toBe(200);
      const body = (await capabilities.json()) as { features: readonly string[] };
      expect(body.features).toContain('agent-chat');

      const conversations = await fetch(
        `${flagged.endpoint}/api/v1/projects/agent-project/agent/conversations`,
        {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ version: 1 }),
        },
      );
      expect(conversations.status).toBe(201);
      const created = (await conversations.json()) as {
        conversation: { conversationId: string; projectId: string; title: string | null };
      };
      expect(created.conversation.projectId).toBe('agent-project');
    } finally {
      await flagged.close();
    }
  });
});
