import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
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
import { NodePluginCatalog } from '../src/plugins/node-plugin-catalog.js';
import { FileProjectSourceLoaderImpl } from '../src/source/file-project-source-loader.js';

const fixtureRoot = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'fixtures',
  'zhu-fu-variants',
  'plugin-check',
);

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
});
