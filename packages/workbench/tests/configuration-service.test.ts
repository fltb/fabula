import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WorkbenchConfigurationV1 } from '../src/contracts/configuration.js';
import {
  ConfigurationFileStore,
  normalizeWorkbenchConfiguration,
  serializeConfigurationYaml,
} from '../src/host/configuration-file-store.js';
import {
  ConfigurationChangeService,
  computeChangedFields,
  requiresRestart,
} from '../src/host/configuration-service.js';

async function tempProjectRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'fabula-project-root-'));
}

async function projectRoot(projectId = 'demo'): Promise<string> {
  const root = await tempProjectRoot();
  await writeFile(join(root, 'nova.yaml'), `project: ${projectId}\n`, 'utf8');
  return root;
}

function baseConfiguration(
  root: string,
  overrides: Partial<WorkbenchConfigurationV1> = {},
): WorkbenchConfigurationV1 {
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
    ...overrides,
  };
}

async function harness(overrides: { busyProjects?: string[] } = {}) {
  const home = await tempProjectRoot();
  const root = await projectRoot();
  const store = new ConfigurationFileStore({
    filePath: join(home, 'config', 'workbench.yaml'),
  });
  const busy = new Set(overrides.busyProjects ?? []);
  const service = new ConfigurationChangeService({
    store,
    isProjectBusy: (projectId) => busy.has(projectId),
  });
  return { store, service, busy, root };
}

describe('computeChangedFields / requiresRestart', () => {
  it('reports stable changed field paths and startup-bound restart detection', () => {
    const root = '/tmp/x';
    const current = baseConfiguration(root);
    const next = baseConfiguration(root, {
      projects: [
        ...baseConfiguration(root).projects,
        { projectId: 'second', displayName: 'Second', root: '/tmp/y' },
      ],
      network: { mode: 'lan', port: 8787, allowedHosts: [], allowedOrigins: [], unixSocket: null },
    });
    const fields = computeChangedFields(current, next);
    expect(fields).toEqual(['projects.second', 'network.mode']);
    expect(requiresRestart(fields)).toBe(true);
    expect(requiresRestart(computeChangedFields(current, baseConfiguration(root)))).toBe(false);
  });
});

describe('ConfigurationChangeService apply', () => {
  it('persists the first setup under expectedRevision null and requires restart', async () => {
    const { service } = await harness();
    const candidate = baseConfiguration(await projectRoot());
    const receipt = await service.apply({ candidate, expectedRevision: null, origin: 'setup' });
    expect(receipt.status).toBe('restart-required');
    expect(receipt.activeRevision).toBe(receipt.candidateRevision);
    expect(receipt.changedFields).toEqual([
      'projects',
      'defaultProjectId',
      'provider',
      'network',
      'referenceLimits',
    ]);
    expect(receipt.diagnostics).toEqual([]);
    expect(await service.readActive()).toEqual({
      configuration: normalizeWorkbenchConfiguration(candidate),
      revision: receipt.activeRevision,
    });
    const active = await service.readActive();
    expect(active?.configuration.version).toBe(2);
    expect(active?.configuration.projects[0]?.revisionMirror).toEqual({ mode: 'disabled' });
    expect(active?.configuration.referenceLimits.enabled).toBe(true);
  });

  it('rejects expectedRevision null once the file exists (CAS)', async () => {
    const { service } = await harness();
    await service.apply({
      candidate: baseConfiguration(await projectRoot()),
      expectedRevision: null,
      origin: 'setup',
    });
    const receipt = await service.apply({
      candidate: baseConfiguration(await projectRoot(), { defaultProjectId: null }),
      expectedRevision: null,
      origin: 'dotenv-import',
    });
    expect(receipt.status).toBe('stale');
    expect(receipt.diagnostics.map((d) => d.code)).toContain('CONFIG_STALE');
  });

  it('rejects a wrong expectedRevision and never modifies the file', async () => {
    const { store, service } = await harness();
    const first = await service.apply({
      candidate: baseConfiguration(await projectRoot()),
      expectedRevision: null,
      origin: 'setup',
    });
    const before = await readFile(store.filePath, 'utf8');
    const receipt = await service.apply({
      candidate: baseConfiguration(await projectRoot(), { defaultProjectId: null }),
      expectedRevision: 'not-the-revision',
      origin: 'dashboard',
    });
    expect(receipt.status).toBe('stale');
    expect(receipt.activeRevision).toBe(first.activeRevision);
    expect(await readFile(store.filePath, 'utf8')).toBe(before);
  });

  it('serializes concurrent applies so only one same-revision caller wins', async () => {
    const { service } = await harness();
    const first = await service.apply({
      candidate: baseConfiguration(await projectRoot()),
      expectedRevision: null,
      origin: 'setup',
    });
    const winning = baseConfiguration(await projectRoot(), { defaultProjectId: null });
    const losing = baseConfiguration(await projectRoot(), {
      provider: { kind: 'ai-sdk', baseUrl: null, model: null },
    });

    // Deterministically pause the first apply inside its validation step, then
    // launch a second apply carrying the SAME expectedRevision. The service
    // serializes apply/observe, so the second apply must observe the first
    // apply's write and fail the CAS instead of overwriting it.
    const gate = Promise.withResolvers<void>();
    const pausedSignal = Promise.withResolvers<void>();
    const originalValidate = service.validateCandidate.bind(service);
    let paused = false;
    service.validateCandidate = async (candidate) => {
      if (!paused) {
        paused = true;
        pausedSignal.resolve();
        await gate.promise;
      }
      return originalValidate(candidate);
    };

    const firstApply = service.apply({
      candidate: winning,
      expectedRevision: first.activeRevision,
      origin: 'dashboard',
    });
    await pausedSignal.promise; // first apply is now inside the critical section
    const secondApply = service.apply({
      candidate: losing,
      expectedRevision: first.activeRevision,
      origin: 'dashboard',
    });
    gate.resolve();

    const [ra, rb] = await Promise.all([firstApply, secondApply]);
    expect([ra.status, rb.status].sort()).toEqual(['restart-required', 'stale']);
    const active = await service.readActive();
    expect(active?.configuration.defaultProjectId).toBeNull(); // the first apply won
    expect(active?.configuration.provider).toBeNull();
  });

  it('returns invalid with diagnostics for a malformed candidate without writing', async () => {
    const { store, service } = await harness();
    await service.apply({
      candidate: baseConfiguration(await projectRoot()),
      expectedRevision: null,
      origin: 'setup',
    });
    const before = await readFile(store.filePath, 'utf8');
    const receipt = await service.apply({
      candidate: baseConfiguration(await projectRoot(), {
        network: {
          mode: 'loopback',
          port: 99999,
          allowedHosts: [],
          allowedOrigins: [],
          unixSocket: null,
        },
      }),
      expectedRevision: (await service.readActive())?.revision ?? null,
      origin: 'dashboard',
    });
    expect(receipt.status).toBe('invalid');
    expect(receipt.diagnostics.map((d) => d.code)).toContain('NETWORK_INVALID');
    expect(await readFile(store.filePath, 'utf8')).toBe(before);
  });

  it('refuses to remove a busy project', async () => {
    const { service, busy } = await harness();
    await service.apply({
      candidate: baseConfiguration(await projectRoot(), {
        projects: [
          { projectId: 'demo', displayName: 'Demo', root: await projectRoot() },
          { projectId: 'other', displayName: 'Other', root: await projectRoot('other') },
        ],
        defaultProjectId: 'demo',
      }),
      expectedRevision: null,
      origin: 'setup',
    });
    busy.add('demo');
    const active = await service.readActive();
    const receipt = await service.apply({
      candidate: baseConfiguration(await projectRoot(), {
        projects: [],
        defaultProjectId: null,
      }),
      expectedRevision: active?.revision ?? null,
      origin: 'dashboard',
    });
    expect(receipt.status).toBe('invalid');
    expect(receipt.diagnostics.map((d) => d.code)).toContain('PROJECT_BUSY');
  });

  it('reports restart-required for startup-bound configuration changes and persists them', async () => {
    const { service } = await harness();
    const first = await service.apply({
      candidate: baseConfiguration(await projectRoot()),
      expectedRevision: null,
      origin: 'setup',
    });
    const receipt = await service.apply({
      candidate: baseConfiguration(await projectRoot(), {
        network: {
          mode: 'lan',
          port: 8787,
          allowedHosts: ['127.0.0.1'],
          allowedOrigins: [],
          unixSocket: null,
        },
      }),
      expectedRevision: first.activeRevision,
      origin: 'dashboard',
    });
    expect(receipt.status).toBe('restart-required');
    expect(receipt.changedFields).toContain('network.mode');
    expect((await service.readActive())?.configuration.network.mode).toBe('lan');
  });

  it('requires restart when provider construction changes', async () => {
    const { service } = await harness();
    const root = await projectRoot();
    const first = await service.apply({
      candidate: baseConfiguration(root),
      expectedRevision: null,
      origin: 'setup',
    });
    const receipt = await service.apply({
      candidate: baseConfiguration(root, {
        provider: { kind: 'ai-sdk', baseUrl: 'https://api.example.com', model: 'm' },
      }),
      expectedRevision: first.activeRevision,
      origin: 'dashboard',
    });
    expect(receipt.status).toBe('restart-required');
    expect(receipt.changedFields).toEqual(['provider']);
  });
});

describe('ConfigurationChangeService watcher path', () => {
  it('requires restart for a valid hand-edited project configuration', async () => {
    const { store, service, root } = await harness();
    await service.apply({
      candidate: baseConfiguration(root),
      expectedRevision: null,
      origin: 'setup',
    });
    const edited = baseConfiguration(root, {
      projects: [
        ...baseConfiguration(root).projects,
        { projectId: 'second', displayName: 'Second', root: await projectRoot('second') },
      ],
    });
    await writeFile(store.filePath, serializeConfigurationYaml(edited), 'utf8');
    const receipt = await service.observeExternalChange();
    expect(receipt?.status).toBe('restart-required');
    expect(receipt?.changedFields).toEqual(['projects.second']);
    expect((await service.readActive())?.configuration.projects.map((p) => p.projectId)).toEqual([
      'demo',
      'second',
    ]);
  });

  it('reports CONFIG_INVALID when parsed YAML omits defaultProjectId or provider', async () => {
    const { store, service } = await harness();
    await service.apply({
      candidate: baseConfiguration(await projectRoot()),
      expectedRevision: null,
      origin: 'setup',
    });
    const yaml = serializeConfigurationYaml(baseConfiguration('/tmp/unused'));

    const withoutDefault = yaml.replace(/defaultProjectId: demo\n/, '');
    await writeFile(store.filePath, withoutDefault, 'utf8');
    const receiptDefault = await service.observeExternalChange();
    expect(receiptDefault).not.toBeNull();
    expect(receiptDefault?.status).toBe('invalid');
    expect(receiptDefault?.diagnostics.map((d) => d.code)).toContain('CONFIG_INVALID');

    const withoutProvider = yaml.replace(/provider: null\n/, '');
    await writeFile(store.filePath, withoutProvider, 'utf8');
    const receiptProvider = await service.observeExternalChange();
    expect(receiptProvider).not.toBeNull();
    expect(receiptProvider?.status).toBe('invalid');
    expect(receiptProvider?.diagnostics.map((d) => d.code)).toContain('CONFIG_INVALID');
    // The hand-edited file is never rewritten.
    expect(await readFile(store.filePath, 'utf8')).toBe(withoutProvider);
  });

  it('keeps the last valid active revision when the hand-edited file is invalid', async () => {
    const { store, service } = await harness();
    const first = await service.apply({
      candidate: baseConfiguration(await projectRoot()),
      expectedRevision: null,
      origin: 'setup',
    });
    await writeFile(store.filePath, 'totally: [not: valid', 'utf8');
    const receipt = await service.observeExternalChange();
    expect(receipt?.status).toBe('invalid');
    expect(receipt?.activeRevision).toBe(first.activeRevision);
    // File content is preserved byte-for-byte.
    expect(await readFile(store.filePath, 'utf8')).toBe('totally: [not: valid');
  });

  it('suppresses its own writes (self-write suppression)', async () => {
    const { service } = await harness();
    await service.apply({
      candidate: baseConfiguration(await projectRoot()),
      expectedRevision: null,
      origin: 'setup',
    });
    expect(await service.observeExternalChange()).toBeNull();
  });

  it('reports restart-required for hand-edited listener policy', async () => {
    const { store, service, root } = await harness();
    await service.apply({
      candidate: baseConfiguration(root),
      expectedRevision: null,
      origin: 'setup',
    });
    await writeFile(
      store.filePath,
      serializeConfigurationYaml(
        baseConfiguration(root, {
          network: {
            mode: 'unix',
            port: 8787,
            allowedHosts: [],
            allowedOrigins: [],
            unixSocket: '/run/wb.sock',
          },
        }),
      ),
      'utf8',
    );
    const receipt = await service.observeExternalChange();
    expect(receipt?.status).toBe('restart-required');
    expect(receipt?.changedFields).toContain('network.mode');
    expect(receipt?.changedFields).toContain('network.unixSocket');
  });
});
