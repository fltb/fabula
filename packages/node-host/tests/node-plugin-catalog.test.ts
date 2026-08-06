import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compileCanonicalRuntime,
  loadCanonicalProject,
} from '../../core/src/entity/project-runtime.ts';
import { PluginHooksManager, ValidatorRegistry } from '../../core/src/plugin/index.ts';
import { ResultAggregator } from '../../core/src/validator/aggregator.ts';
import { createBuiltInValidators } from '../../core/src/validator/builtins.ts';
import {
  discoverNodePlugins,
  NodePluginCatalog,
  PluginIdentityMismatchError,
} from '../src/plugins/node-plugin-catalog.js';
import { FileProjectSourceLoaderImpl } from '../src/source/file-project-source-loader.js';
import { writePluginFixture } from './fixtures.js';

const fixtureRoot = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'fixtures',
  'zhu-fu-variants',
  'plugin-check',
);

const hashFile = async (file: string): Promise<string> =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');

const fixturePluginDir = path.join(fixtureRoot, 'plugins', 'valence-guard');
const trustedFixtureEntry = async () => {
  const [plugin] = await new NodePluginCatalog(fixtureRoot).load();
  if (!plugin) throw new Error('fixture plugin missing');
  return {
    plugin,
    trusted: {
      name: plugin.manifest.name,
      version: plugin.manifest.version,
      moduleHash: plugin.moduleHash ?? '',
      required: true,
    },
  };
};

const log = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const providers = {
  register() {},
  getProvider() {
    return undefined;
  },
};

describe('NodePluginCatalog', () => {
  it('discovers a real plugin and activates its validator through Core hooks', async () => {
    const [plugin] = await new NodePluginCatalog(fixtureRoot).load();
    expect(plugin?.manifest.name).toBe('valence-guard');
    expect(plugin?.hooks?.name).toBe('valence-guard');
    if (!plugin?.hooks) throw new Error('fixture plugin did not provide hooks');

    // Identity: hashes are computed from the exact on-disk bytes.
    const manifestHash = await hashFile(path.join(fixturePluginDir, 'manifest.yaml'));
    const moduleHash = await hashFile(path.join(fixturePluginDir, 'index.js'));
    expect(plugin.manifestHash).toBe(manifestHash);
    expect(plugin.moduleHash).toBe(moduleHash);
    // The stamps ride on the hook record for Core cache-scoping.
    expect(plugin.hooks.version).toBe('0.1.0');
    expect(plugin.hooks.manifestHash).toBe(manifestHash);
    expect(plugin.hooks.moduleHash).toBe(moduleHash);

    const source = new FileProjectSourceLoaderImpl().load(fixtureRoot);
    const project = loadCanonicalProject(source);
    const validators = new ValidatorRegistry();
    const manager = new PluginHooksManager({ log }, validators, providers);
    manager.register(plugin.hooks);
    await manager.initialize();
    const boundaries = compileCanonicalRuntime(project).boundaries;
    const results = new ResultAggregator(
      [...createBuiltInValidators(), ...validators.list()],
      project.entityTypes,
    ).validateAll(project.authoredEvents, boundaries.finalState, project.registry, {
      overrides: project.data.config?.validatorOverrides,
      stateBeforeByEventId: boundaries.stateBeforeByEventId,
    });

    expect(results.get('E1')?.errors).toContainEqual(
      expect.objectContaining({
        validator: 'valence-guard',
        severity: 'error',
        event: 'E1',
      }),
    );
  });

  it('skips ordinary files in the plugin directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'node-plugin-catalog-'));
    try {
      await mkdir(path.join(root, 'plugins'));
      await writeFile(path.join(root, 'plugins', 'README.txt'), 'not a plugin');
      await expect(new NodePluginCatalog(root).load()).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a symlinked plugin directory escape', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'node-plugin-catalog-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'node-plugin-outside-'));
    try {
      await mkdir(path.join(root, 'plugins'));
      await symlink(outside, path.join(root, 'plugins', 'escape'), 'dir');
      await expect(new NodePluginCatalog(root).load()).rejects.toThrow('must not be a symlink');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('accepts an exact trusted identity match', async () => {
    const { plugin, trusted } = await trustedFixtureEntry();
    expect(() => new NodePluginCatalog(fixtureRoot).verifyTrusted(plugin, trusted)).not.toThrow();
  });

  it('rejects a trusted entry whose version differs', async () => {
    const { plugin, trusted } = await trustedFixtureEntry();
    expect(() =>
      new NodePluginCatalog(fixtureRoot).verifyTrusted(plugin, {
        ...trusted,
        version: '9.9.9',
      }),
    ).toThrow(PluginIdentityMismatchError);
  });

  it('rejects a trusted entry whose module hash differs', async () => {
    const { plugin, trusted } = await trustedFixtureEntry();
    let error: unknown;
    try {
      new NodePluginCatalog(fixtureRoot).verifyTrusted(plugin, {
        ...trusted,
        moduleHash: '0'.repeat(64),
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PluginIdentityMismatchError);
    expect((error as PluginIdentityMismatchError).code).toBe('PLUGIN_IDENTITY_MISMATCH');
  });

  it('rejects a trusted entry whose name differs', async () => {
    const { plugin, trusted } = await trustedFixtureEntry();
    expect(() =>
      new NodePluginCatalog(fixtureRoot).verifyTrusted(plugin, {
        ...trusted,
        name: 'other-plugin',
      }),
    ).toThrow(PluginIdentityMismatchError);
  });

  it('discovers plugins with identity fields and hook names', async () => {
    const discovered = await discoverNodePlugins(fixtureRoot);
    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toMatchObject({
      name: 'valence-guard',
      version: '0.1.0',
      hookNames: ['afterRender', 'beforeRender', 'registerValidators'],
    });
    expect(discovered[0]?.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(discovered[0]?.moduleHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('sorts discovered plugins by name', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'node-plugin-discover-'));
    try {
      writePluginFixture(root, [{ name: 'zeta-plugin' }, { name: 'alpha-plugin' }]);
      const discovered = await discoverNodePlugins(root);
      expect(discovered.map((plugin) => plugin.name)).toEqual(['alpha-plugin', 'zeta-plugin']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports manifest-only plugins without a module hash or hooks', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'node-plugin-manifest-only-'));
    try {
      writePluginFixture(root, [{ name: 'manifest-only', module: false }]);
      const [plugin] = await new NodePluginCatalog(root).load();
      expect(plugin?.manifest.name).toBe('manifest-only');
      expect(plugin?.moduleHash).toBeNull();
      expect(plugin?.hooks).toBeNull();
      await expect(discoverNodePlugins(root)).resolves.toEqual([
        {
          name: 'manifest-only',
          version: '1.0.0',
          manifestHash: expect.any(String),
          moduleHash: null,
          hookNames: [],
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
