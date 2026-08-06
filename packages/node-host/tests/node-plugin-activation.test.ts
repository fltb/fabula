import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PluginHooksManager } from '@novalistically/core';
import { describe, expect, it } from 'vitest';
import { activateNodePlugins, shutdownNodePlugins } from '../src/plugins/activate.js';
import { PluginIdentityMismatchError } from '../src/plugins/node-plugin-catalog.js';
import { writePluginFixture } from './fixtures.js';

const moduleHashOf = (root: string, name: string): string =>
  createHash('sha256')
    .update(readFileSync(path.join(root, 'plugins', name, 'index.js')))
    .digest('hex');

const trusted = (
  name: string,
  options: {
    readonly version?: string;
    readonly moduleHash?: string;
    readonly required?: boolean;
  } = {},
) => ({
  name,
  version: options.version ?? '1.0.0',
  moduleHash: options.moduleHash ?? '',
  required: options.required ?? true,
});

const capturedError = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
};

describe('activateNodePlugins', () => {
  it('loads a plugin whose name/version/moduleHash match the allowlist exactly', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'node-plugin-activate-'));
    try {
      writePluginFixture(root, [{ name: 'alpha', hooksExtra: '  async onLoad() {},\n' }]);
      const result = await activateNodePlugins({
        projectRoot: root,
        trustedPlugins: [trusted('alpha', { moduleHash: moduleHashOf(root, 'alpha') })],
      });

      expect(result.hooksManager).toBeInstanceOf(PluginHooksManager);
      expect(result.blocked).toEqual([]);
      expect(result.disabled).toEqual([]);
      expect(result.active).toEqual([
        {
          name: 'alpha',
          version: '1.0.0',
          manifestHash: expect.any(String),
          moduleHash: moduleHashOf(root, 'alpha'),
          hookNames: ['onLoad'],
          validatorNames: [],
          required: true,
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails activation when a required plugin fails identity verification', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'node-plugin-activate-'));
    try {
      writePluginFixture(root, [{ name: 'alpha' }]);
      const error = await capturedError(
        activateNodePlugins({
          projectRoot: root,
          trustedPlugins: [trusted('alpha', { moduleHash: '0'.repeat(64) })],
        }),
      );
      expect(error).toBeInstanceOf(PluginIdentityMismatchError);
      expect((error as PluginIdentityMismatchError).code).toBe('PLUGIN_IDENTITY_MISMATCH');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('disables an optional plugin whose identity does not match, never loading it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'node-plugin-activate-'));
    try {
      writePluginFixture(root, [{ name: 'alpha' }]);
      const result = await activateNodePlugins({
        projectRoot: root,
        trustedPlugins: [trusted('alpha', { moduleHash: '0'.repeat(64), required: false })],
      });
      expect(result.hooksManager).toBeNull();
      expect(result.active).toEqual([]);
      expect(result.blocked).toEqual([]);
      expect(result.disabled).toEqual([
        { name: 'alpha', reason: expect.stringContaining('module hash') },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails activation when a required allowlist entry is not installed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'node-plugin-activate-'));
    try {
      const error = await capturedError(
        activateNodePlugins({
          projectRoot: root,
          trustedPlugins: [trusted('ghost', { moduleHash: 'a'.repeat(64) })],
        }),
      );
      expect(error).toBeInstanceOf(PluginIdentityMismatchError);
      expect((error as PluginIdentityMismatchError).message).toContain('not installed');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('disables a discovered plugin that is absent from the allowlist', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'node-plugin-activate-'));
    try {
      writePluginFixture(root, [{ name: 'alpha' }]);
      const result = await activateNodePlugins({ projectRoot: root, trustedPlugins: [] });
      expect(result.hooksManager).toBeNull();
      expect(result.active).toEqual([]);
      expect(result.blocked).toEqual([]);
      expect(result.disabled).toEqual([
        { name: 'alpha', reason: 'not present in the trusted plugin allowlist' },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('blocks render on a conflict requiring human arbitration, never picking a winner', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'node-plugin-activate-'));
    try {
      writePluginFixture(root, [
        { name: 'conflict-a', conflicts: ['conflict-b'] },
        { name: 'conflict-b' },
      ]);
      const result = await activateNodePlugins({
        projectRoot: root,
        trustedPlugins: [
          trusted('conflict-a', { moduleHash: moduleHashOf(root, 'conflict-a') }),
          trusted('conflict-b', { moduleHash: moduleHashOf(root, 'conflict-b') }),
        ],
      });
      expect(result.hooksManager).toBeNull();
      expect(result.active).toEqual([]);
      expect(result.blocked.map((entry) => entry.name).sort()).toEqual([
        'conflict-a',
        'conflict-b',
      ]);
      for (const entry of result.blocked) {
        expect(entry.reason).toContain('requires human arbitration');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the project open with a blocking diagnostic when a required plugin fails init', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'node-plugin-activate-'));
    try {
      writePluginFixture(root, [
        { name: 'boom', hooksExtra: "  async onLoad() { throw new Error('init exploded'); },\n" },
      ]);
      const result = await activateNodePlugins({
        projectRoot: root,
        trustedPlugins: [trusted('boom', { moduleHash: moduleHashOf(root, 'boom') })],
      });
      expect(result.blocked).toEqual([
        { name: 'boom', reason: expect.stringContaining('init exploded') },
      ]);
      expect(result.active).toEqual([]);
      expect(result.disabled).toEqual([]);
      // Project stays open: the activation resolved and the manager is present.
      expect(result.hooksManager).toBeInstanceOf(PluginHooksManager);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('disables an optional plugin that fails init', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'node-plugin-activate-'));
    try {
      writePluginFixture(root, [
        { name: 'boom', hooksExtra: "  async onLoad() { throw new Error('init exploded'); },\n" },
      ]);
      const result = await activateNodePlugins({
        projectRoot: root,
        trustedPlugins: [
          trusted('boom', { moduleHash: moduleHashOf(root, 'boom'), required: false }),
        ],
      });
      expect(result.blocked).toEqual([]);
      expect(result.active).toEqual([]);
      expect(result.disabled).toEqual([
        { name: 'boom', reason: expect.stringContaining('init exploded') },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('records plugins that never got initialized as disabled when an earlier init aborts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'node-plugin-activate-'));
    try {
      // Registration follows name-sorted discovery order: "boom" comes before
      // "zeta-tail", so the failure aborts before zeta-tail is initialized.
      writePluginFixture(root, [
        { name: 'boom', hooksExtra: "  async onLoad() { throw new Error('init exploded'); },\n" },
        { name: 'zeta-tail', hooksExtra: '  async onLoad() {},\n' },
      ]);
      const result = await activateNodePlugins({
        projectRoot: root,
        trustedPlugins: [
          trusted('boom', { moduleHash: moduleHashOf(root, 'boom'), required: false }),
          trusted('zeta-tail', { moduleHash: moduleHashOf(root, 'zeta-tail') }),
        ],
      });
      // The optional failure must not silently drop the tail plugin: it is
      // recorded as disabled, and never half-initialized.
      expect(result.blocked).toEqual([]);
      expect(result.active).toEqual([]);
      expect(result.disabled.map((entry) => entry.name).sort()).toEqual(['boom', 'zeta-tail']);
      const aborted = result.disabled.find((entry) => entry.name === 'zeta-tail');
      expect(aborted?.reason).toContain('activation aborted after "boom"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('blocks a required plugin whose async hook exceeds the hook timeout', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'node-plugin-activate-'));
    try {
      writePluginFixture(root, [
        { name: 'hang', hooksExtra: '  async onLoad() { await new Promise(() => {}); },\n' },
      ]);
      const result = await activateNodePlugins({
        projectRoot: root,
        trustedPlugins: [trusted('hang', { moduleHash: moduleHashOf(root, 'hang') })],
        hookTimeoutMs: 50,
      });
      expect(result.blocked).toEqual([
        { name: 'hang', reason: expect.stringContaining('Timed out after 50ms') },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('disables an optional plugin whose async hook exceeds the hook timeout', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'node-plugin-activate-'));
    try {
      writePluginFixture(root, [
        { name: 'hang', hooksExtra: '  async onLoad() { await new Promise(() => {}); },\n' },
      ]);
      const result = await activateNodePlugins({
        projectRoot: root,
        trustedPlugins: [
          trusted('hang', { moduleHash: moduleHashOf(root, 'hang'), required: false }),
        ],
        hookTimeoutMs: 50,
      });
      expect(result.disabled).toEqual([
        { name: 'hang', reason: expect.stringContaining('Timed out after 50ms') },
      ]);
      expect(result.blocked).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports validator names registered by the effective set', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'node-plugin-activate-'));
    try {
      writePluginFixture(root, [
        {
          name: 'validator-plugin',
          hooksExtra:
            '  registerValidators(registrar) {\n' +
            "    registrar.register({ name: 'extra-check', category: 'factual_detail', validatePre() { return []; } });\n" +
            '  },\n',
        },
      ]);
      const result = await activateNodePlugins({
        projectRoot: root,
        trustedPlugins: [
          trusted('validator-plugin', { moduleHash: moduleHashOf(root, 'validator-plugin') }),
        ],
      });
      expect(result.active).toEqual([
        {
          name: 'validator-plugin',
          version: '1.0.0',
          manifestHash: expect.any(String),
          moduleHash: moduleHashOf(root, 'validator-plugin'),
          hookNames: ['registerValidators'],
          validatorNames: ['extra-check'],
          required: true,
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('shuts hooks down in reverse registration order', async () => {
    const state = globalThis as { __shutdownOrder?: string[] };
    state.__shutdownOrder = [];
    const root = await mkdtemp(path.join(os.tmpdir(), 'node-plugin-activate-'));
    try {
      writePluginFixture(root, [
        {
          name: 'alpha',
          hooksExtra: "  onUnload() { globalThis.__shutdownOrder.push('alpha'); },\n",
        },
        {
          name: 'beta',
          hooksExtra: "  onUnload() { globalThis.__shutdownOrder.push('beta'); },\n",
        },
      ]);
      const result = await activateNodePlugins({
        projectRoot: root,
        trustedPlugins: [
          trusted('alpha', { moduleHash: moduleHashOf(root, 'alpha') }),
          trusted('beta', { moduleHash: moduleHashOf(root, 'beta') }),
        ],
      });
      const errors = await shutdownNodePlugins(result.hooksManager);
      expect(errors).toEqual([]);
      expect(state.__shutdownOrder).toEqual(['beta', 'alpha']);
    } finally {
      delete state.__shutdownOrder;
      await rm(root, { recursive: true, force: true });
    }
  });
});
