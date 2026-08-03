import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildArtifactManifest,
  loadArtifactManifest,
  verifyManifestIntegrity,
} from '../src/host/artifact-manifest.js';
import {
  buildLaunchDescriptor,
  LaunchDescriptorError,
} from '../src/host/launch-descriptor.js';
import { HostSupervisor } from '../src/host/supervisor.js';

const owned: string[] = [];

afterEach(() => {
  for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'fabula-host-boundary-'));
  owned.push(root);
  mkdirSync(join(root, 'dist', 'host'), { recursive: true });
  mkdirSync(join(root, 'dist', 'client'), { recursive: true });
  mkdirSync(join(root, 'config'), { recursive: true });
  mkdirSync(join(root, 'state', 'fabula', 'workbench'), { recursive: true });
  mkdirSync(join(root, 'state', 'fabula'), { recursive: true });
  return root;
}

describe('Host artifact manifests and launch descriptors', () => {
  it('generates, reloads, and verifies hashed Host outputs', () => {
    const root = fixtureRoot();
    const outputRoot = join(root, 'dist', 'host');
    writeFileSync(join(outputRoot, 'host.js'), 'host-entry');
    writeFileSync(join(outputRoot, 'worker.js'), 'worker-entry');
    const manifest = buildArtifactManifest({
      outputRoot,
      packageId: '@novalistically/workbench',
      buildId: 'test-build',
      entryPoints: { host: 'host.js', 'persistence-worker': 'worker.js' },
      outputFiles: ['host.js', 'worker.js'],
    });
    const manifestPath = join(outputRoot, 'artifact-manifest.json');
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(loadArtifactManifest(manifestPath)).toEqual(manifest);
    expect(verifyManifestIntegrity(manifest)).toEqual({ ok: true });

    const descriptor = buildLaunchDescriptor({
      manifestPath,
      env: {
        HOME: root,
        XDG_CONFIG_HOME: join(root, 'config'),
        XDG_STATE_HOME: join(root, 'state'),
      },
      assetsRootOverride: join(root, 'dist', 'client'),
      mode: 'listener',
    });
    expect(descriptor.manifestPath).toBe(resolve(manifestPath));
    expect(descriptor.mode).toBe('listener');
    expect(descriptor.paths.hostEntry).toBe(join(outputRoot, 'host.js'));

    writeFileSync(join(outputRoot, 'host.js'), 'tampered');
    expect(verifyManifestIntegrity(manifest)).toEqual({
      ok: false,
      errors: [expect.stringContaining('Size mismatch for host.js'), expect.stringContaining('Hash mismatch for host.js')],
    });
  });

  it('rejects artifact paths that escape the output root', () => {
    const root = fixtureRoot();
    expect(() => buildArtifactManifest({
      outputRoot: join(root, 'dist', 'host'),
      packageId: '@novalistically/workbench',
      entryPoints: { host: '../host.js' },
      outputFiles: [],
    })).toThrow(/escapes output root/);
  });

  it('fails descriptor construction when a required artifact is missing', () => {
    const root = fixtureRoot();
    const outputRoot = join(root, 'dist', 'host');
    writeFileSync(join(outputRoot, 'host.js'), 'host-entry');
    const manifest = buildArtifactManifest({
      outputRoot,
      packageId: '@novalistically/workbench',
      entryPoints: { host: 'host.js', 'persistence-worker': 'worker.js' },
      outputFiles: ['host.js'],
    });
    const manifestPath = join(outputRoot, 'artifact-manifest.json');
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => buildLaunchDescriptor({
      manifestPath,
      env: { HOME: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: join(root, 'state') },
      assetsRootOverride: join(root, 'dist', 'client'),
    })).toThrow(LaunchDescriptorError);
  });
});

describe('Host supervisor fd3 protocol', () => {
  it('uses only fd3 for ready and shutdown frames and bounds lifecycle', async () => {
    const root = fixtureRoot();
    const fakeHost = join(root, 'fake-host.mjs');
    const build = { version: 1 as const, packageId: '@novalistically/workbench', buildId: 'test-build', protocolVersion: 1 as const };
    writeFileSync(fakeHost, `
      import { createReadStream, writeSync } from 'node:fs';
      const build = ${JSON.stringify(build)};
      writeSync(3, Buffer.from(JSON.stringify({ version: 1, type: 'ready', endpoint: 'http://127.0.0.1:0', build, pid: process.pid, listenerMode: 'listener', bootstrapRequired: false }) + '\\n'));
      let buffer = '';
      createReadStream('/dev/null', { fd: 3, autoClose: false }).on('data', (chunk) => {
        buffer += chunk.toString();
        for (const line of buffer.split('\\n').slice(0, -1)) {
          const frame = JSON.parse(line);
          if (frame.type === 'shutdown') {
            writeSync(3, Buffer.from(JSON.stringify({ version: 1, type: 'stopped', requestId: frame.requestId, reason: 'shutdown' }) + '\\n'));
            process.exit(0);
          }
        }
        buffer = buffer.split('\\n').at(-1) ?? '';
      });
    `);
    chmodSync(fakeHost, 0o700);
    const descriptor = {
      version: 1 as const,
      manifestPath: join(root, 'manifest.json'),
      manifest: {} as never,
      hostEntry: { path: 'fake-host.mjs', hash: createHash('sha256').update(readFileSync(fakeHost)).digest('hex'), size: readFileSync(fakeHost).byteLength, entryPointFor: 'host' },
      workerEntry: { path: 'worker.js', hash: '0'.repeat(64), size: 0, entryPointFor: 'persistence-worker' },
      paths: {
        nodePath: process.execPath,
        hostEntry: fakeHost,
        workerEntry: fakeHost,
        assetsRoot: root,
        hostHome: root,
        databasePath: join(root, 'db.sqlite'),
        credentialBase: root,
      },
      build,
      mode: 'listener' as const,
      dev: true,
    };
    const supervisor = new HostSupervisor({ descriptor, startupTimeoutMs: 2_000, terminationGraceMs: 500 });
    await expect(supervisor.start()).resolves.toMatchObject({ listenerMode: 'listener', build });
    await expect(supervisor.shutdown('test-shutdown', 500)).resolves.toEqual({ requestId: 'test-shutdown', reason: 'shutdown' });
    expect(supervisor.state).toBe('stopped');
    await expect(supervisor.restart('test-restart', 500)).resolves.toMatchObject({ listenerMode: 'listener', build });
    await expect(supervisor.shutdown('test-restart-stop', 500)).resolves.toEqual({ requestId: 'test-restart-stop', reason: 'shutdown' });
    expect(supervisor.state).toBe('stopped');
  });
});
