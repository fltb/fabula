import { mkdtemp, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKBENCH_REFERENCE_LIMITS_V2,
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

function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      if (condition()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('waitFor timed out'));
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
    const revision = await store.write(configuration);

    const info = await stat(store.filePath);
    expect(info.isFile()).toBe(true);
    expect(info.mode & 0o777).toBe(0o600);

    const names = await readdir(join(home, 'config'));
    expect(names).toEqual(['workbench.yaml']); // no .tmp-* residue

    const roundTrip = await store.read();
    expect(roundTrip).not.toBeNull();
    expect(roundTrip?.revision).toBe(revision);
    expect(roundTrip?.configuration).toEqual({
      version: 2,
      projects: [
        {
          projectId: 'demo',
          displayName: 'Demo',
          root: configuration.projects[0]?.root,
          revisionMirror: { mode: 'disabled' },
        },
      ],
      defaultProjectId: 'demo',
      provider: null,
      network: configuration.network,
      referenceLimits: DEFAULT_WORKBENCH_REFERENCE_LIMITS_V2,
    });
  });

  it('derives a stable content-hash revision that changes with content', () => {
    const root = '/tmp/irrelevant-root';
    const a = baseConfiguration(root);
    const b = baseConfiguration(root, { defaultProjectId: null });
    expect(configurationRevision(a)).toBe(configurationRevision(a));
    expect(configurationRevision(a)).not.toBe(configurationRevision(b));
  });

  it('serializes to canonical V2 YAML with normalized mirror and reference limits', () => {
    const configuration = baseConfiguration('/srv/project', {
      provider: { kind: 'ai-sdk', baseUrl: 'https://api.example.com', model: 'fast-model' },
      network: {
        mode: 'unix',
        port: 0,
        allowedHosts: ['localhost'],
        allowedOrigins: [],
        unixSocket: '/run/workbench.sock',
      },
    });
    const yaml = serializeConfigurationYaml(configuration);
    expect(yaml).toContain('version: 2');
    expect(yaml).toContain('revisionMirror:');
    expect(yaml).toContain('mode: disabled');
    expect(yaml).toContain('referenceLimits:');
    const parsed = parseConfigurationYaml(yaml);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.configuration.version).toBe(2);
      expect(parsed.configuration.projects[0]?.revisionMirror).toEqual({ mode: 'disabled' });
      expect(parsed.configuration.referenceLimits).toEqual(DEFAULT_WORKBENCH_REFERENCE_LIMITS_V2);
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
      serializeConfigurationYaml(baseConfiguration(await tempHome(), { port: 9999 })),
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
        'version: 2',
        'version: 2\nsurprise: true',
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.map((d) => d.code)).toContain('UNKNOWN_FIELD');
    }
  });

  it('requires explicit defaultProjectId and provider keys', () => {
    const yaml = serializeConfigurationYaml(baseConfiguration(root));
    const missingDefault = parseConfigurationYaml(yaml.replace(/defaultProjectId: demo\n/, ''));
    expect(missingDefault.ok).toBe(false);
    if (!missingDefault.ok) {
      expect(missingDefault.diagnostics.map((d) => d.code)).toContain('CONFIG_INVALID');
    }
    const missingProvider = parseConfigurationYaml(yaml.replace(/provider: null\n/, ''));
    expect(missingProvider.ok).toBe(false);
    if (!missingProvider.ok) {
      expect(missingProvider.diagnostics.map((d) => d.code)).toContain('CONFIG_INVALID');
    }
  });

  it('rejects duplicate project ids and relative roots', () => {
    const duplicated = {
      ...baseConfiguration(root),
      projects: [
        { projectId: 'a', displayName: 'A', root },
        { projectId: 'a', displayName: 'A2', root },
      ],
    };
    const dup = parseConfigurationYaml(serializeConfigurationYaml(duplicated));
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.diagnostics.map((d) => d.code)).toContain('PROJECT_DUPLICATE_ID');

    const relative = parseConfigurationYaml(serializeConfigurationYaml(baseConfiguration('relative/path')));
    expect(relative.ok).toBe(false);
    if (!relative.ok) {
      expect(relative.diagnostics.map((d) => d.code)).toContain('PROJECT_INVALID_ROOT');
    }
  });

  it('rejects malformed listener policies', () => {
    const badPort = parseConfigurationYaml(
      serializeConfigurationYaml(
        baseConfiguration(root, {
          network: { mode: 'loopback', port: 99999, allowedHosts: [], allowedOrigins: [], unixSocket: null },
        }),
      ),
    );
    expect(badPort.ok).toBe(false);
    if (!badPort.ok) expect(badPort.diagnostics.map((d) => d.code)).toContain('NETWORK_INVALID');

    const unixWithoutSocket = parseConfigurationYaml(
      serializeConfigurationYaml(
        baseConfiguration(root, {
          network: { mode: 'unix', port: 8787, allowedHosts: [], allowedOrigins: [], unixSocket: null },
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
          network: { mode: 'loopback', port: 8787, allowedHosts: [], allowedOrigins: [], unixSocket: '/run/x.sock' },
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
      ...baseConfiguration(root, { provider: { kind: 'ai-sdk', baseUrl: null, model: null } }),
      provider: { kind: 'ai-sdk', baseUrl: null, model: null, apiKey: 'sk-secret' },
    });
    expect(providerExtra.ok).toBe(false);
    if (!providerExtra.ok) {
      expect(providerExtra.diagnostics.map((d) => d.code)).toContain('UNKNOWN_FIELD');
    }
  });
});
