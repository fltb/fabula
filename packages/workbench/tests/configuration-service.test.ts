import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKBENCH_REFERENCE_LIMITS_V2,
  type WorkbenchConfigurationV1,
  type WorkbenchConfigurationV3,
} from '../src/contracts/configuration.js';
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

function baseConfigurationV3(
  root: string,
  overrides: Partial<WorkbenchConfigurationV3> = {},
): WorkbenchConfigurationV3 {
  return {
    version: 3,
    projects: [
      {
        projectId: 'demo',
        displayName: 'Demo',
        root,
        revisionMirror: { mode: 'disabled' },
        providerProfile: 'default',
        trustedPlugins: [],
      },
    ],
    defaultProjectId: 'demo',
    providers: {},
    network: {
      mode: 'loopback',
      port: 8787,
      allowedHosts: [],
      allowedOrigins: [],
      unixSocket: null,
    },
    referenceLimits: { ...DEFAULT_WORKBENCH_REFERENCE_LIMITS_V2 },
    operationLimits: {
      maxQueuedPerProject: 8,
      maxConcurrentRendersPerProject: 1,
      maxConcurrentRendersPerHost: 2,
    },
    agent: { enabled: false, maxTurns: 8, maxToolCalls: 24 },
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

  it('normalizes legacy provider edits to the default profile path', () => {
    const root = '/tmp/x';
    const current = baseConfiguration(root);
    const next = baseConfiguration(root, {
      provider: { kind: 'ai-sdk', baseUrl: 'https://api.example.com', model: 'm' },
    });
    const fields = computeChangedFields(current, next);
    expect(fields).toEqual(['providers.default']);
    expect(requiresRestart(fields)).toBe(true);
  });

  it('reports every V3 domain change with stable paths', () => {
    const root = '/tmp/x';
    const current = baseConfigurationV3(root);
    const next = baseConfigurationV3(root, {
      providers: {
        default: { kind: 'ai-sdk', baseUrl: 'https://api.example.com', model: 'm-1' },
      },
      projects: [
        {
          projectId: 'demo',
          displayName: 'Demo',
          root,
          revisionMirror: { mode: 'disabled' },
          providerProfile: 'fast',
          trustedPlugins: [
            { name: 'arc', version: '1.0.0', moduleHash: 'abc123', required: false },
          ],
        },
      ],
      operationLimits: {
        maxQueuedPerProject: 16,
        maxConcurrentRendersPerProject: 1,
        maxConcurrentRendersPerHost: 3,
      },
      agent: { enabled: true, maxTurns: 4, maxToolCalls: 8 },
    });
    const fields = computeChangedFields(current, next);
    expect(fields).toEqual([
      'projects.demo.providerProfile',
      'projects.demo.trustedPlugins',
      'providers.default',
      'operationLimits.maxQueuedPerProject',
      'operationLimits.maxConcurrentRendersPerHost',
      'agent.enabled',
      'agent.maxTurns',
      'agent.maxToolCalls',
    ]);
    expect(requiresRestart(fields)).toBe(true);
  });

  it('ignores an unchanged trusted plugin allowlist', () => {
    const root = '/tmp/x';
    const current = baseConfigurationV3(root, {
      projects: [
        {
          projectId: 'demo',
          displayName: 'Demo',
          root,
          revisionMirror: { mode: 'disabled' },
          providerProfile: 'default',
          trustedPlugins: [{ name: 'arc', version: '1.0.0', moduleHash: 'abc123', required: true }],
        },
      ],
    });
    expect(computeChangedFields(current, current)).toEqual([]);
  });

  it('requires restart for every V3 domain field', () => {
    expect(requiresRestart(['providers.default.baseUrl'])).toBe(true);
    expect(requiresRestart(['projects.demo.providerProfile'])).toBe(true);
    expect(requiresRestart(['projects.demo.trustedPlugins'])).toBe(true);
    expect(requiresRestart(['operationLimits.maxQueuedPerProject'])).toBe(true);
    expect(requiresRestart(['agent.enabled'])).toBe(true);
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
      'providers',
      'network',
      'referenceLimits',
      'operationLimits',
      'agent',
    ]);
    expect(receipt.diagnostics).toEqual([]);
    expect(await service.readActive()).toEqual({
      configuration: normalizeWorkbenchConfiguration(candidate),
      revision: receipt.activeRevision,
    });
    const active = await service.readActive();
    expect(active?.configuration.version).toBe(3);
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
    expect(active?.configuration.providers).toEqual({});
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
    expect(receipt.changedFields).toEqual(['providers.default']);
  });

  it('applies a V3 configuration with all new domains under the revision CAS', async () => {
    const { service } = await harness();
    const root = await projectRoot();
    const candidate = baseConfigurationV3(root, {
      providers: {
        default: { kind: 'ai-sdk', baseUrl: 'https://api.example.com', model: 'm-1' },
      },
      projects: [
        {
          projectId: 'demo',
          displayName: 'Demo',
          root,
          revisionMirror: { mode: 'disabled' },
          providerProfile: 'default',
          trustedPlugins: [{ name: 'arc', version: '1.0.0', moduleHash: 'abc123', required: true }],
        },
      ],
      operationLimits: {
        maxQueuedPerProject: 4,
        maxConcurrentRendersPerProject: 1,
        maxConcurrentRendersPerHost: 1,
      },
      agent: { enabled: true, maxTurns: 16, maxToolCalls: 48 },
    });
    const receipt = await service.apply({ candidate, expectedRevision: null, origin: 'setup' });
    expect(receipt.status).toBe('restart-required');
    expect(receipt.changedFields).toEqual([
      'projects',
      'defaultProjectId',
      'providers',
      'network',
      'referenceLimits',
      'operationLimits',
      'agent',
    ]);
    const active = await service.readActive();
    expect(active?.configuration.version).toBe(3);
    expect(active?.configuration.providers.default).toEqual({
      kind: 'ai-sdk',
      baseUrl: 'https://api.example.com',
      model: 'm-1',
    });
    expect(active?.configuration.projects[0]?.providerProfile).toBe('default');
    expect(active?.configuration.projects[0]?.trustedPlugins).toEqual([
      { name: 'arc', version: '1.0.0', moduleHash: 'abc123', required: true },
    ]);
    expect(active?.configuration.operationLimits.maxQueuedPerProject).toBe(4);
    expect(active?.configuration.operationLimits.maxConcurrentRendersPerHost).toBe(1);
    expect(active?.configuration.agent).toEqual({ enabled: true, maxTurns: 16, maxToolCalls: 48 });
  });

  it('rejects a stale V3-domain apply and keeps the file untouched', async () => {
    const { service } = await harness();
    const root = await projectRoot();
    const first = await service.apply({
      candidate: baseConfigurationV3(root),
      expectedRevision: null,
      origin: 'setup',
    });
    const receipt = await service.apply({
      candidate: baseConfigurationV3(root, {
        agent: { enabled: true, maxTurns: 8, maxToolCalls: 24 },
      }),
      expectedRevision: 'stale-revision',
      origin: 'dashboard',
    });
    expect(receipt.status).toBe('stale');
    expect(receipt.diagnostics.map((d) => d.code)).toContain('CONFIG_STALE');
    expect((await service.readActive())?.configuration.agent.enabled).toBe(false);
    expect(first.activeRevision).toBe((await service.readActive())?.revision);
  });

  it('reports restart-required for an agent-only change on a V3 configuration', async () => {
    const { service } = await harness();
    const root = await projectRoot();
    const first = await service.apply({
      candidate: baseConfigurationV3(root),
      expectedRevision: null,
      origin: 'setup',
    });
    const receipt = await service.apply({
      candidate: baseConfigurationV3(root, {
        agent: { enabled: true, maxTurns: 8, maxToolCalls: 24 },
      }),
      expectedRevision: first.activeRevision,
      origin: 'dashboard',
    });
    expect(receipt.status).toBe('restart-required');
    expect(receipt.changedFields).toEqual(['agent.enabled']);
  });

  it('reports operation limit and profile binding changes on a V3 configuration', async () => {
    const { service } = await harness();
    const root = await projectRoot();
    const first = await service.apply({
      candidate: baseConfigurationV3(root),
      expectedRevision: null,
      origin: 'setup',
    });
    const receipt = await service.apply({
      candidate: baseConfigurationV3(root, {
        projects: [
          {
            projectId: 'demo',
            displayName: 'Demo',
            root,
            revisionMirror: { mode: 'disabled' },
            providerProfile: 'fast',
            trustedPlugins: [],
          },
        ],
        operationLimits: {
          maxQueuedPerProject: 16,
          maxConcurrentRendersPerProject: 1,
          maxConcurrentRendersPerHost: 2,
        },
      }),
      expectedRevision: first.activeRevision,
      origin: 'dashboard',
    });
    expect(receipt.status).toBe('restart-required');
    expect(receipt.changedFields).toEqual([
      'projects.demo.providerProfile',
      'operationLimits.maxQueuedPerProject',
    ]);
  });

  it('rejects trusted plugin identities that carry paths, URLs, or whitespace', async () => {
    const { service } = await harness();
    const root = await projectRoot();
    await service.apply({
      candidate: baseConfigurationV3(root),
      expectedRevision: null,
      origin: 'setup',
    });
    const active = await service.readActive();
    const cases: readonly { name: string; version: string; moduleHash: string }[] = [
      { name: 'arc', version: '1.0.0', moduleHash: '/etc/passwd' },
      { name: 'arc', version: '1.0.0', moduleHash: 'https://example.com/index.js' },
      { name: 'arc/plugin', version: '1.0.0', moduleHash: 'abc123' },
      { name: 'arc', version: '1.0.0', moduleHash: 'abc 123' },
      { name: '', version: '1.0.0', moduleHash: 'abc123' },
    ];
    for (const entry of cases) {
      const receipt = await service.apply({
        candidate: baseConfigurationV3(root, {
          projects: [
            {
              projectId: 'demo',
              displayName: 'Demo',
              root,
              revisionMirror: { mode: 'disabled' },
              providerProfile: 'default',
              trustedPlugins: [{ ...entry, required: true }],
            },
          ],
        }),
        expectedRevision: active?.revision ?? null,
        origin: 'dashboard',
      });
      expect(receipt.status).toBe('invalid');
      expect(receipt.diagnostics.map((d) => d.code)).toContain('CONFIG_INVALID');
      expect(receipt.diagnostics.some((d) => d.message.includes('pathless'))).toBe(true);
    }
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

  it('reports CONFIG_INVALID when parsed YAML omits required top-level fields', async () => {
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

    // A hand-edited document missing required V3 fields is rejected and preserved.
    const missingFields = 'version: 3\nprojects: []\n';
    await writeFile(store.filePath, missingFields, 'utf8');
    const receiptMissing = await service.observeExternalChange();
    expect(receiptMissing).not.toBeNull();
    expect(receiptMissing?.status).toBe('invalid');
    expect(receiptMissing?.diagnostics.map((d) => d.code)).toContain('CONFIG_INVALID');
    // The hand-edited file is never rewritten.
    expect(await readFile(store.filePath, 'utf8')).toBe(missingFields);
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
