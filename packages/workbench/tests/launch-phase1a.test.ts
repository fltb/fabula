/**
 * Phase 1A focused host tests: worker lifecycle (real worker thread, crash
 * propagation, bounded idempotent disposal), Host-only provider factory
 * (credential store boundary, no environment-key fallback, secret-free
 * readiness), and launch env policy (unconfigured setup runtime, loopback-only
 * first startup, packaged-assets default). These run against real esbuild
 * bundles and real worker threads; they are deliberately narrow and are not
 * part of any gate.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { MockProvider } from '@novalistically/core/testing';
import { XdgCredentialFileStore } from '../src/host/providers/index.js';
import { HostProviderError, HostProviderFactory } from '../src/host/provider-factory.js';
import {
  createPersistenceWorkerRuntime,
  parseWorkbenchLaunchConfig,
  resolveWorkbenchHostHome,
  startWorkbench,
  type WorkbenchLaunchConfig,
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
    const bundleDir = mkdtempSync(join(packageRoot, '.nova', 'worker-bundle-'));
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
    const store = new XdgCredentialFileStore({ configDir: newTempDir('fabula-launch-credential-') });
    await store.set('ai-sdk', 'store-secret');
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
});
