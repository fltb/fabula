import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GitBootstrap,
  GitBootstrapConflictError,
  GitBootstrapDirtyError,
  GitBootstrapRefConflictError,
  GIT_BASELINE_SUBJECT,
} from '../src/host/git/bootstrap.js';
import type { GitCapability } from '../src/host/git/capability.js';
import {
  AuthoringManifest,
  ManifestValidationError,
  type AuthoringEntry,
} from '../src/host/git/manifest.js';
import {
  ControlledGitRunner,
  GitIsolationError,
  WORKBENCH_AUTHORING_REF,
  type GitRunRequest,
  type GitRunResult,
} from '../src/host/git/runner.js';
import {
  GitBootstrap as BarrelGitBootstrap,
  GitBootstrapDirtyError as BarrelGitBootstrapDirtyError,
  GitBootstrapRefConflictError as BarrelGitBootstrapRefConflictError,
  GIT_BASELINE_SUBJECT as BarrelGIT_BASELINE_SUBJECT,
  WORKBENCH_AUTHORING_REF as BarrelWORKBENCH_AUTHORING_REF,
} from '../src/host/git/index.js';

/** All-zero OID used by `git update-ref <ref> <new> <zero>` as CAS-create. */
const ZERO_OID = '0'.repeat(40);

const temp = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));
const utf8 = (content: string): Uint8Array => new TextEncoder().encode(content);
const entry = (path: string, content: string): AuthoringEntry => ({ path, bytes: utf8(content) });

/** Capability is exercised by its own probe tests; bootstrap only requires `ok`. */
const CAPABILITY: GitCapability = {
  ok: true,
  gitBinary: 'git',
  gitVersion: 'test',
  checks: [],
  errors: [],
};

const MANIFEST = new AuthoringManifest();

const baselineEntries = (): AuthoringEntry[] => [
  entry('nova.yaml', 'project: probe\nchapter: 1\n'),
  entry('definitions/state_initial.yaml', 'initial:\n  scene: scene-one\n'),
  entry('definitions/characters/ada.yaml', 'characters:\n  ada:\n    name: Ada\n'),
  entry('chapters/chapter_01/_chapter.yaml', 'title: Opening\n'),
];

const sortedEntryPaths = (): string[] => baselineEntries().map((item) => item.path).sort();

const bootstrapFor = (runner: ControlledGitRunner, projectRoot: string): GitBootstrap =>
  new GitBootstrap({
    runner,
    projectRoot,
    projectId: 'probe-project',
    manifest: MANIFEST,
    entries: baselineEntries(),
    capability: CAPABILITY,
  });

/**
 * A controlled runner that lets the fixed ref appear between the read-only
 * probe and the atomic CAS-create, exactly the race the bootstrap must fail
 * closed on with a typed ref-conflict error.
 */
class RefRacingRunner extends ControlledGitRunner {
  private raced = false;

  override async run(request: GitRunRequest): Promise<GitRunResult> {
    const { args } = request;
    // The bootstrap CAS-create is `update-ref <ref> <new> <all-zero>`.
    if (args[0] === 'update-ref' && args.length === 4 && args[3] === ZERO_OID && !this.raced) {
      this.raced = true;
      // Pre-create the ref without the expected-old guard; the real CAS call
      // below then fails because the ref already exists.
      await super.run({ args: ['update-ref', args[1], args[2]], cwd: request.cwd });
    }
    return super.run(request);
  }
}

describe('GitBootstrap', () => {
  it('creates exactly one baseline commit from manifest entries only', async () => {
    const dir = temp('wb-boot-create-');
    const runner = new ControlledGitRunner();
    const result = await bootstrapFor(runner, dir).bootstrap();

    expect(result.status).toBe('created');
    expect(result.ref).toBe(WORKBENCH_AUTHORING_REF);
    expect(result.commitCount).toBe(1);
    expect(result.message).toContain(GIT_BASELINE_SUBJECT);
    expect(result.entries).toEqual(sortedEntryPaths());

    // The fixed ref resolves to the reported baseline commit.
    const head = await runner.runStrict({ args: ['rev-parse', WORKBENCH_AUTHORING_REF], cwd: dir });
    expect(head.stdout.trim()).toBe(result.commit);

    // Exactly one commit exists in the whole reachable history.
    const count = await runner.runStrict({
      args: ['rev-list', '--count', WORKBENCH_AUTHORING_REF],
      cwd: dir,
    });
    expect(count.stdout.trim()).toBe('1');

    // The authored files are materialized in the primary worktree.
    expect(readFileSync(join(dir, 'nova.yaml'), 'utf8')).toBe('project: probe\nchapter: 1\n');
  });

  it('reopens the existing baseline idempotently without creating new objects', async () => {
    const dir = temp('wb-boot-reopen-');
    const runner = new ControlledGitRunner();
    const created = await bootstrapFor(runner, dir).bootstrap();
    const reopened = await bootstrapFor(runner, dir).bootstrap();

    expect(reopened.status).toBe('reopened');
    expect(reopened.commit).toBe(created.commit);
    expect(reopened.tree).toBe(created.tree);
    expect(reopened.commitCount).toBe(1);
    expect(reopened.entries).toEqual(created.entries);
  });

  it('leaves the primary worktree clean after create so reopen stays idempotent (managed .gitignore regression)', async () => {
    const dir = temp('wb-boot-clean-');
    const runner = new ControlledGitRunner();
    await bootstrapFor(runner, dir).bootstrap();

    // The bootstrap-owned .gitignore must self-ignore so create leaves a
    // porcelain-clean worktree; otherwise reopen would reject its own output.
    const status = await runner.runStrict({ args: ['status', '--porcelain=v1'], cwd: dir });
    expect(status.stdout).toBe('');
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toContain('.gitignore');

    const reopened = await bootstrapFor(runner, dir).bootstrap();
    expect(reopened.status).toBe('reopened');
    expect(reopened.commitCount).toBe(1);
  });

  it('refuses to author runtime or derived artifacts that live in the project', async () => {
    const dir = temp('wb-boot-runtime-');
    mkdirSync(join(dir, '.nova/cache'), { recursive: true });
    mkdirSync(join(dir, 'output'), { recursive: true });
    writeFileSync(join(dir, '.nova/cache/secret.json'), '{"providerKey":"hunter2"}');
    writeFileSync(join(dir, 'output/novel.md'), '# generated prose\n');

    const runner = new ControlledGitRunner();
    const result = await bootstrapFor(runner, dir).bootstrap();

    expect(result.status).toBe('created');
    expect(result.entries).toEqual(sortedEntryPaths());
    const tracked = await runner.runStrict({ args: ['ls-files'], cwd: dir });
    expect(tracked.stdout.trim().split('\n')).toEqual(sortedEntryPaths());

    // Runtime artifacts survive on disk but never enter author history.
    expect(existsSync(join(dir, '.nova/cache/secret.json'))).toBe(true);
    expect(existsSync(join(dir, 'output/novel.md'))).toBe(true);
  });

  it('rejects external changes on the fixed ref with a typed dirty error', async () => {
    const dir = temp('wb-boot-dirty-');
    const runner = new ControlledGitRunner();
    await bootstrapFor(runner, dir).bootstrap();

    // A modified tracked file.
    writeFileSync(join(dir, 'nova.yaml'), 'project: tampered\n');
    await expect(bootstrapFor(runner, dir).bootstrap()).rejects.toBeInstanceOf(
      GitBootstrapDirtyError,
    );

    // An untracked file the managed ignore does not cover.
    writeFileSync(join(dir, 'nova.yaml'), 'project: probe\nchapter: 1\n');
    writeFileSync(join(dir, 'README.md'), 'not authored\n');
    await expect(bootstrapFor(runner, dir).bootstrap()).rejects.toBeInstanceOf(
      GitBootstrapDirtyError,
    );
  });

  it('fails with a typed ref conflict when the fixed ref appears during CAS-create', async () => {
    const dir = temp('wb-boot-race-');
    const runner = new RefRacingRunner();
    await expect(bootstrapFor(runner, dir).bootstrap()).rejects.toBeInstanceOf(
      GitBootstrapRefConflictError,
    );
  });

  it('fails closed when the managed .gitignore content is modified or removed', async () => {
    const dir = temp('wb-boot-ignore-tamper-');
    const runner = new ControlledGitRunner();
    await bootstrapFor(runner, dir).bootstrap();

    writeFileSync(join(dir, '.gitignore'), '# tampered\n');
    await expect(bootstrapFor(runner, dir).bootstrap()).rejects.toBeInstanceOf(
      GitBootstrapConflictError,
    );

    rmSync(join(dir, '.gitignore'));
    await expect(bootstrapFor(runner, dir).bootstrap()).rejects.toBeInstanceOf(
      GitBootstrapConflictError,
    );
  });

  it('fails with a typed conflict on a user-owned .gitignore before any repository mutation', async () => {
    const dir = temp('wb-boot-ignore-user-');
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n.env\n');

    const runner = new ControlledGitRunner();
    await expect(bootstrapFor(runner, dir).bootstrap()).rejects.toBeInstanceOf(
      GitBootstrapConflictError,
    );

    // No repository, ref or tree was ever created, and the user file is untouched.
    expect(existsSync(join(dir, '.git'))).toBe(false);
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('node_modules/\n.env\n');
  });

  it('reuses a pre-existing .gitignore with exactly the managed content and stays idempotent', async () => {
    const seed = temp('wb-boot-ignore-seed-');
    const runner = new ControlledGitRunner();
    await bootstrapFor(runner, seed).bootstrap();
    const managedIgnore = readFileSync(join(seed, '.gitignore'), 'utf8');

    const dir = temp('wb-boot-ignore-managed-');
    writeFileSync(join(dir, '.gitignore'), managedIgnore);

    const created = await bootstrapFor(runner, dir).bootstrap();
    expect(created.status).toBe('created');
    expect(created.commitCount).toBe(1);
    // The pre-existing file was reused verbatim, not rewritten.
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe(managedIgnore);

    // Reopen stays clean and idempotent with the reused control file.
    const reopened = await bootstrapFor(runner, dir).bootstrap();
    expect(reopened.status).toBe('reopened');
    expect(reopened.commit).toBe(created.commit);
    const status = await runner.runStrict({ args: ['status', '--porcelain=v1'], cwd: dir });
    expect(status.stdout).toBe('');
  });

  it('refuses a repository whose HEAD sits on a different branch', async () => {
    const dir = temp('wb-boot-wrongbranch-');
    const runner = new ControlledGitRunner();
    await runner.runStrict({ args: ['init', '--quiet', '--initial-branch=main', dir], cwd: dir });

    await expect(bootstrapFor(runner, dir).bootstrap()).rejects.toBeInstanceOf(
      GitBootstrapConflictError,
    );
  });

  it('rejects an unsafe filter/attributes configuration before any primary write', async () => {
    const dir = temp('wb-boot-isolation-');
    const runner = new ControlledGitRunner();
    await runner.runStrict({
      args: ['init', '--quiet', '--initial-branch=workbench', dir],
      cwd: dir,
    });
    writeFileSync(join(dir, '.gitattributes'), '*.yaml filter=evil\n');

    await expect(bootstrapFor(runner, dir).bootstrap()).rejects.toBeInstanceOf(GitIsolationError);

    // Nothing was created: the fixed ref must still be absent.
    const refProbe = await runner.run({
      args: ['rev-parse', '--verify', '--quiet', WORKBENCH_AUTHORING_REF],
      cwd: dir,
    });
    expect(refProbe.exitCode).not.toBe(0);
  });

  it('rejects a manifest violation before any git command or repository write', async () => {
    const dir = temp('wb-boot-manifest-');
    const runner = new ControlledGitRunner();
    const manifest = new AuthoringManifest();
    const badEntries = [...baselineEntries(), entry('.git/config', 'x')];

    expect(
      () =>
        new GitBootstrap({
          runner,
          projectRoot: dir,
          projectId: 'probe-project',
          manifest,
          entries: badEntries,
          capability: CAPABILITY,
        }),
    ).toThrow(ManifestValidationError);

    // No repository was ever initialized.
    expect(existsSync(join(dir, '.git'))).toBe(false);
  });

  it('exposes bootstrap result and error types from the git barrel', () => {
    expect(BarrelGitBootstrap).toBe(GitBootstrap);
    expect(BarrelGitBootstrapRefConflictError).toBe(GitBootstrapRefConflictError);
    expect(BarrelGitBootstrapDirtyError).toBe(GitBootstrapDirtyError);
    expect(BarrelGIT_BASELINE_SUBJECT).toBe(GIT_BASELINE_SUBJECT);
    expect(BarrelWORKBENCH_AUTHORING_REF).toBe(WORKBENCH_AUTHORING_REF);
  });
});
