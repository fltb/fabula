import { mkdtemp, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKBENCH_AGENT_CONFIGURATION,
  DEFAULT_WORKBENCH_OPERATION_LIMITS,
  DEFAULT_WORKBENCH_REFERENCE_LIMITS,
  DEFAULT_WORKBENCH_RENDER_POLICY,
  type WorkbenchConfigurationV1,
} from '../src/contracts/configuration.js';
import {
  ConfigurationFileParseError,
  ConfigurationFileStore,
  configurationRevision,
  parseConfigurationYaml,
  resolveWorkbenchHome,
  serializeConfigurationYaml,
  validateConfigurationShape,
} from '../src/host/configuration-file-store.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

async function tempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'fabula-config-store-'));
}

function baseConfiguration(
  _root: string,
  overrides: Partial<WorkbenchConfigurationV1> = {},
): WorkbenchConfigurationV1 {
  return {
    version: 1,
    projects: [
      {
        projectId: 'demo',
        displayName: 'Demo',
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
    referenceLimits: { ...DEFAULT_WORKBENCH_REFERENCE_LIMITS },
    operationLimits: { ...DEFAULT_WORKBENCH_OPERATION_LIMITS },
    agent: { ...DEFAULT_WORKBENCH_AGENT_CONFIGURATION },
    renderPolicy: { ...DEFAULT_WORKBENCH_RENDER_POLICY },
    ...overrides,
  };
}
function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      if (condition()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error('waitFor timed out'));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

describe('resolveWorkbenchHome', () => {
  it('prefers WORKBENCH_HOME, then XDG_STATE_HOME, then HOME fallback', () => {
    expect(resolveWorkbenchHome({ WORKBENCH_HOME: '/opt/wb' })).toBe('/opt/wb');
    expect(resolveWorkbenchHome({ XDG_STATE_HOME: '/state', HOME: '/home/x' })).toBe(
      '/state/fabula/workbench',
    );
    expect(resolveWorkbenchHome({ HOME: '/home/x' })).toBe('/home/x/.local/state/fabula/workbench');
    expect(resolveWorkbenchHome({})).toBeNull();
  });

  it('uses config/workbench.yaml beneath the resolved home', () => {
    const home = '/home/wb';
    const store = new ConfigurationFileStore({ filePath: join(home, 'config', 'workbench.yaml') });
    expect(store.filePath).toBe('/home/wb/config/workbench.yaml');
  });
});

describe('configuration file store', () => {
  it('writes atomically with 0600 mode and no leftover temporary files', async () => {
    const home = await tempHome();
    const store = new ConfigurationFileStore({ filePath: join(home, 'config', 'workbench.yaml') });
    const configuration = baseConfiguration(await tempHome());
    const _revision = await store.write(configuration);

    const info = await stat(store.filePath);
    expect(info.isFile()).toBe(true);
    expect(info.mode & 0o777).toBe(0o600);

    const names = await readdir(join(home, 'config'));
    expect(names).toEqual(['workbench.yaml']); // no .tmp-* residue

    const roundTrip = await store.read();
    expect(roundTrip).not.toBeNull();
    expect(roundTrip?.configuration).toEqual({
      version: 1,
      projects: [
        {
          projectId: 'demo',
          displayName: 'Demo',
          revisionMirror: { mode: 'disabled' },
          providerProfile: 'default',
          trustedPlugins: [],
        },
      ],
      defaultProjectId: 'demo',
      providers: {},
      network: configuration.network,
      referenceLimits: DEFAULT_WORKBENCH_REFERENCE_LIMITS,
      operationLimits: DEFAULT_WORKBENCH_OPERATION_LIMITS,
      agent: DEFAULT_WORKBENCH_AGENT_CONFIGURATION,
      renderPolicy: DEFAULT_WORKBENCH_RENDER_POLICY,
    });
  });

  it('derives a stable content-hash revision that changes with content', () => {
    const root = '/tmp/irrelevant-root';
    const a = baseConfiguration(root);
    const b = baseConfiguration(root, { defaultProjectId: null });
    expect(configurationRevision(a)).toBe(configurationRevision(a));
    expect(configurationRevision(a)).not.toBe(configurationRevision(b));
  });

  it('serializes to canonical V1 YAML with mirror and reference limits', () => {
    const configuration = baseConfiguration('/srv/project', {
      providers: {
        default: { kind: 'pi', baseUrl: 'https://api.example.com', model: 'fast-model' },
      },
      network: {
        mode: 'unix',
        port: 0,
        allowedHosts: ['localhost'],
        allowedOrigins: [],
        unixSocket: '/run/workbench.sock',
      },
    });
    const yaml = serializeConfigurationYaml(configuration);
    expect(yaml).toContain('version: 1');
    expect(yaml).toContain('revisionMirror:');
    expect(yaml).toContain('mode: disabled');
    expect(yaml).toContain('referenceLimits:');
    expect(yaml).toContain('providers:');
    expect(yaml).toContain('providerProfile: default');
    expect(yaml).toContain('trustedPlugins: []');
    expect(yaml).toContain('operationLimits:');
    expect(yaml).toContain('agent:');
    expect(yaml).toContain('renderPolicy:');
    const parsed = parseConfigurationYaml(yaml);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.configuration.version).toBe(1);
      expect(parsed.configuration.projects[0]?.revisionMirror).toEqual({ mode: 'disabled' });
      expect(parsed.configuration.projects[0]?.providerProfile).toBe('default');
      expect(parsed.configuration.projects[0]?.trustedPlugins).toEqual([]);
      expect(parsed.configuration.referenceLimits).toEqual(DEFAULT_WORKBENCH_REFERENCE_LIMITS);
      expect(parsed.configuration.renderPolicy).toEqual(DEFAULT_WORKBENCH_RENDER_POLICY);
      expect(parsed.configuration.providers).toEqual({
        default: { kind: 'pi', baseUrl: 'https://api.example.com', model: 'fast-model' },
      });
    }
  });

  it('round-trips optional provider advanced fields through parse/serialize', () => {
    const root = '/tmp/irrelevant-root';
    const configuration = baseConfiguration(root, {
      providers: {
        default: {
          kind: 'pi',
          baseUrl: 'https://api.example.com/v1',
          model: 'fast-model',
          reasoning: true,
          contextWindow: 32000,
          maxTokens: 8000,
          headers: { 'x-custom': 'v' },
        },
      },
    });
    const parsed = parseConfigurationYaml(serializeConfigurationYaml(configuration));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.configuration.providers).toEqual({
        default: {
          kind: 'pi',
          baseUrl: 'https://api.example.com/v1',
          model: 'fast-model',
          reasoning: true,
          contextWindow: 32000,
          maxTokens: 8000,
          headers: { 'x-custom': 'v' },
        },
      });
    }
  });

  it('rejects malformed provider advanced fields', () => {
    const root = '/tmp/irrelevant-root';
    const bad = validateConfigurationShape({
      ...baseConfiguration(root),
      providers: {
        default: {
          kind: 'pi',
          baseUrl: 'https://api.example.com/v1',
          model: 'fast-model',
          reasoning: 'yes',
          contextWindow: -4,
          maxTokens: 2.5,
          headers: { 'x-custom': 7 },
        },
      },
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.diagnostics.map((d) => d.code)).toEqual(
        expect.arrayContaining([
          'CONFIG_INVALID',
          'CONFIG_INVALID',
          'CONFIG_INVALID',
          'CONFIG_INVALID',
        ]),
      );
    }
  });

  it('returns null when the file does not exist yet', async () => {
    const home = await tempHome();
    const store = new ConfigurationFileStore({
      filePath: join(home, 'config', 'workbench.yaml'),
    });
    expect(await store.read()).toBeNull();
    expect(await store.readRaw()).toBeNull();
  });

  it('throws a typed parse error for an invalid stored file', async () => {
    const home = await tempHome();
    const store = new ConfigurationFileStore({ filePath: join(home, 'config', 'workbench.yaml') });
    await store.write(baseConfiguration(await tempHome()));
    await writeFile(store.filePath, 'not: [valid yaml', 'utf8');
    await expect(store.read()).rejects.toBeInstanceOf(ConfigurationFileParseError);
  });

  it('emits a debounced external-change callback for hand-edited files', async () => {
    const home = await tempHome();
    const store = new ConfigurationFileStore({
      filePath: join(home, 'config', 'workbench.yaml'),
      debounceMs: 10,
    });
    await store.write(baseConfiguration(await tempHome()));
    let fired = 0;
    const watcher = store.watch(() => {
      fired += 1;
    });
    cleanups.push(async () => watcher.dispose());
    await writeFile(
      store.filePath,
      serializeConfigurationYaml(baseConfiguration(await tempHome(), { defaultProjectId: null })),
      'utf8',
    );
    await waitFor(() => fired > 0);
    expect(fired).toBeGreaterThan(0);
  });
});

describe('strict configuration shape validation', () => {
  const root = '/tmp/shape-root';

  it('rejects unknown top-level fields', () => {
    const result = parseConfigurationYaml(
      serializeConfigurationYaml(baseConfiguration(root)).replace(
        'version: 1',
        'version: 1\nsurprise: true',
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.map((d) => d.code)).toContain('UNKNOWN_FIELD');
    }
  });

  it('requires explicit defaultProjectId and providers keys', () => {
    const yaml = serializeConfigurationYaml(baseConfiguration(root));
    const missingDefault = parseConfigurationYaml(yaml.replace(/defaultProjectId: demo\n/, ''));
    expect(missingDefault.ok).toBe(false);
    if (!missingDefault.ok) {
      expect(missingDefault.diagnostics.map((d) => d.code)).toContain('CONFIG_INVALID');
    }
    const missingProviders = parseConfigurationYaml(yaml.replace(/providers: {}\n/, ''));
    expect(missingProviders.ok).toBe(false);
    if (!missingProviders.ok) {
      expect(missingProviders.diagnostics.map((d) => d.code)).toContain('CONFIG_INVALID');
    }
  });

  it('rejects duplicate project ids and accepts a root-free v1 project entry', () => {
    const duplicated = {
      ...baseConfiguration(root),
      projects: [
        {
          projectId: 'a',
          displayName: 'A',
          revisionMirror: { mode: 'disabled' },
          providerProfile: 'default',
          trustedPlugins: [],
        },
        {
          projectId: 'a',
          displayName: 'A2',
          revisionMirror: { mode: 'disabled' },
          providerProfile: 'default',
          trustedPlugins: [],
        },
      ],
    };
    const dup = parseConfigurationYaml(serializeConfigurationYaml(duplicated));
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.diagnostics.map((d) => d.code)).toContain('PROJECT_DUPLICATE_ID');

    // Project roots are Host-derived now; a v1 entry without `root` parses.
    const noRoot = parseConfigurationYaml(serializeConfigurationYaml(baseConfiguration(root)));
    expect(noRoot.ok).toBe(true);
  });

  it('rejects malformed listener policies', () => {
    const badPort = parseConfigurationYaml(
      serializeConfigurationYaml(
        baseConfiguration(root, {
          network: {
            mode: 'loopback',
            port: 99999,
            allowedHosts: [],
            allowedOrigins: [],
            unixSocket: null,
          },
        }),
      ),
    );
    expect(badPort.ok).toBe(false);
    if (!badPort.ok) expect(badPort.diagnostics.map((d) => d.code)).toContain('NETWORK_INVALID');

    const unixWithoutSocket = parseConfigurationYaml(
      serializeConfigurationYaml(
        baseConfiguration(root, {
          network: {
            mode: 'unix',
            port: 8787,
            allowedHosts: [],
            allowedOrigins: [],
            unixSocket: null,
          },
        }),
      ),
    );
    expect(unixWithoutSocket.ok).toBe(false);
    if (!unixWithoutSocket.ok) {
      expect(unixWithoutSocket.diagnostics.map((d) => d.code)).toContain('NETWORK_INVALID');
    }

    const loopbackWithSocket = parseConfigurationYaml(
      serializeConfigurationYaml(
        baseConfiguration(root, {
          network: {
            mode: 'loopback',
            port: 8787,
            allowedHosts: [],
            allowedOrigins: [],
            unixSocket: '/run/x.sock',
          },
        }),
      ),
    );
    expect(loopbackWithSocket.ok).toBe(false);
  });

  it('rejects unknown keys inside projects and provider mappings', () => {
    const projectExtra = validateConfigurationShape({
      ...baseConfiguration(root),
      projects: [{ ...baseConfiguration(root).projects[0], capabilityToken: 'x' }],
    });
    expect(projectExtra.ok).toBe(false);
    if (!projectExtra.ok) {
      expect(projectExtra.diagnostics.map((d) => d.code)).toContain('UNKNOWN_FIELD');
    }

    const providerExtra = validateConfigurationShape({
      ...baseConfiguration(root),
      providers: {
        default: { kind: 'pi', baseUrl: null, model: null, apiKey: 'sk-secret' },
      },
    });
    expect(providerExtra.ok).toBe(false);
    if (!providerExtra.ok) {
      expect(providerExtra.diagnostics.map((d) => d.code)).toContain('UNKNOWN_FIELD');
    }
  });
});
