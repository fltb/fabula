import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { PersistenceWorkerClient } from '../../persistence/worker-client.js';
import { type AuthoringEntry, AuthoringManifest } from '../authoring/manifest.js';
import type { AuthoringRevisionMirror } from '../authoring/types.js';
import { type ControlledGitRunner, WORKBENCH_AUTHORING_REF } from './runner.js';

async function writeManifestTree(
  runner: ControlledGitRunner,
  projectRoot: string,
  entries: readonly AuthoringEntry[],
  expectedHead: string,
): Promise<string> {
  const scratch = mkdtempSync(join(runner.scratchDir, 'workbench-mirror-'));
  try {
    const env = { GIT_INDEX_FILE: join(scratch, 'index') };
    await runner.runStrict({ args: ['read-tree', expectedHead], cwd: projectRoot, env });
    const paths = new Set(entries.map((entry) => entry.path));
    const baseline = await runner.runStrict({
      args: ['ls-tree', '-r', '--name-only', expectedHead],
      cwd: projectRoot,
    });
    for (const path of baseline.stdout
      .split('\n')
      .map((item) => item.trim())
      .filter(Boolean)) {
      if (!paths.has(path)) {
        await runner.runStrict({
          args: ['update-index', '--force-remove', '--', path],
          cwd: projectRoot,
          env,
        });
      }
    }
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const blobFile = join(scratch, `blob-${index}`);
      writeFileSync(blobFile, entry.bytes);
      const blob = (
        await runner.runStrict({
          args: ['hash-object', '-w', '--no-filters', blobFile],
          cwd: projectRoot,
        })
      ).stdout.trim();
      const mode = entry.mode === 'executable' ? '100755' : '100644';
      await runner.runStrict({
        args: ['update-index', '--add', '--cacheinfo', `${mode},${blob},${entry.path}`],
        cwd: projectRoot,
        env,
      });
    }
    return (await runner.runStrict({ args: ['write-tree'], cwd: projectRoot, env })).stdout.trim();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export interface GitRevisionMirrorOptions {
  readonly runner: ControlledGitRunner;
  readonly projectRoot: string;
  readonly persistence: PersistenceWorkerClient;
  readonly ref?: string;
  readonly now?: () => string;
}

/** Exports an already-accepted native revision to Git; Git never decides acceptance. */
export function createGitRevisionMirror(
  options: GitRevisionMirrorOptions,
): AuthoringRevisionMirror {
  const root = resolve(options.projectRoot);
  const ref = options.ref ?? WORKBENCH_AUTHORING_REF;
  const now = options.now ?? (() => new Date().toISOString());
  const backend = 'git-best-effort';
  const checkpoint = async (input: {
    readonly projectId: string;
    readonly revisionId: string;
    readonly state: 'pending' | 'exported' | 'failed';
    readonly externalId?: string;
    readonly diagnostic?: string;
  }): Promise<void> => {
    await options.persistence.request('checkpointRevisionMirrorExport', {
      projectId: input.projectId,
      revisionId: input.revisionId,
      backend,
      state: input.state,
      ...(input.externalId === undefined ? {} : { externalId: input.externalId }),
      ...(input.diagnostic === undefined ? {} : { diagnostic: input.diagnostic }),
      updatedAt: now(),
    });
  };
  const fail = async (projectId: string, revisionId: string, diagnostic: string) => {
    await options.persistence
      .request('createRevisionMirrorExport', {
        projectId,
        revisionId,
        backend,
        state: 'pending',
        updatedAt: now(),
      })
      .catch(() => undefined);
    await checkpoint({ projectId, revisionId, state: 'failed', diagnostic }).catch(() => undefined);
    return { status: 'failed' as const, diagnostic };
  };
  return {
    async probe() {
      const result = await options.runner.run({
        args: ['rev-parse', '--verify', '--quiet', ref],
        cwd: root,
      });
      return result.exitCode === 0
        ? { available: true }
        : { available: false, reason: 'the configured authoring ref is unavailable' };
    },
    async export(input) {
      const previous = await options.persistence.request('loadRevisionMirrorExport', {
        projectId: input.projectId,
        revisionId: input.revisionId,
        backend,
      });
      if (previous?.state === 'exported' && previous.externalId !== undefined) {
        return { status: 'exported' as const, externalId: previous.externalId };
      }
      await options.persistence.request('createRevisionMirrorExport', {
        projectId: input.projectId,
        revisionId: input.revisionId,
        backend,
        state: 'pending',
        updatedAt: now(),
      });
      try {
        const head = await options.runner.run({
          args: ['rev-parse', '--verify', '--quiet', ref],
          cwd: root,
        });
        const expectedHead = head.stdout.trim();
        if (head.exitCode !== 0 || expectedHead.length === 0) {
          return fail(
            input.projectId,
            input.revisionId,
            'the configured authoring ref is unavailable',
          );
        }
        const manifest = new AuthoringManifest();
        const entries: AuthoringEntry[] = input.bundle.entries.map((entry) => ({
          path: entry.logicalPath,
          bytes: Buffer.from(entry.content, 'utf8'),
        }));
        manifest.validate(entries);
        const tree = await writeManifestTree(options.runner, root, entries, expectedHead);
        const commit = (
          await options.runner.runStrict({
            args: [
              'commit-tree',
              tree,
              '-p',
              expectedHead,
              '-m',
              `chore(workbench): mirror revision ${input.revisionId}`,
            ],
            cwd: root,
          })
        ).stdout.trim();
        const cas = await options.runner.run({
          args: ['update-ref', ref, commit, expectedHead],
          cwd: root,
        });
        if (cas.exitCode !== 0) {
          return fail(
            input.projectId,
            input.revisionId,
            `mirror ref CAS failed: ${cas.stderr.trim()}`,
          );
        }
        await checkpoint({
          projectId: input.projectId,
          revisionId: input.revisionId,
          state: 'exported',
          externalId: commit,
        });
        return { status: 'exported' as const, externalId: commit };
      } catch (error) {
        return fail(
          input.projectId,
          input.revisionId,
          error instanceof Error ? error.message : 'Git mirror export failed',
        );
      }
    },
    async inspect() {
      const result = await options.runner.run({
        args: ['rev-parse', '--verify', '--quiet', ref],
        cwd: root,
      });
      return result.exitCode !== 0
        ? { status: 'failed' as const, diagnostic: 'the configured authoring ref is unavailable' }
        : { status: 'active' as const, externalHeadId: result.stdout.trim() };
    },
  };
}
