import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ControlledGitRunner,
  GitArgsRejectedError,
  GitCommandError,
  GitDivergenceError,
  GitEnvironmentRejectedError,
  GitIsolationError,
  GitSpawnError,
  GitTimeoutError,
  WORKBENCH_AUTHORING_REF,
  WORKBENCH_GIT_IDENTITY,
} from '../src/host/git/runner.js';

const temp = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));
const initRepo = async (runner: ControlledGitRunner, dir: string): Promise<void> => {
  await runner.runStrict({
    args: ['init', '--quiet', '--initial-branch=workbench', dir],
    cwd: dir,
  });
};

const seedCommit = async (runner: ControlledGitRunner, dir: string): Promise<string> => {
  writeFileSync(join(dir, 'nova.yaml'), 'project: probe\nchapter: 1\n');
  await runner.runStrict({ args: ['add', 'nova.yaml'], cwd: dir });
  await runner.runStrict({ args: ['commit', '-m', 'seed'], cwd: dir });
  return (await runner.runStrict({ args: ['rev-parse', 'HEAD'], cwd: dir })).stdout.trim();
};

describe('ControlledGitRunner', () => {
  it('runs a controlled git command and returns its output', async () => {
    const runner = new ControlledGitRunner();
    const result = await runner.run({ args: ['--version'] });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^git version \d+\.\d+/);
  });

  it('returns a nonzero exit as a result instead of throwing', async () => {
    const dir = temp('wb-runner-exit-');
    const runner = new ControlledGitRunner();
    await initRepo(runner, dir);
    const result = await runner.run({
      args: ['rev-parse', '--verify', 'definitely-not-a-real-rev'],
      cwd: dir,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it('never interpolates arguments through a shell', async () => {
    const dir = temp('wb-runner-shell-');
    const marker = join(dir, 'pwned');
    const runner = new ControlledGitRunner();
    await initRepo(runner, dir);
    const result = await runner.run({
      args: ['rev-parse', '--verify', `$(touch ${marker}); echo hi`],
      cwd: dir,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain('hi');
    expect(existsSync(marker)).toBe(false);
  });

  it('isolates global and user configuration', async () => {
    const dir = temp('wb-runner-cfg-');
    const home = temp('wb-runner-home-');
    writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = Evil\n\temail = evil@test\n');
    const runner = new ControlledGitRunner();
    await initRepo(runner, dir);
    const result = await runner.run({
      args: ['config', '--get', 'user.name'],
      cwd: dir,
      env: { HOME: home },
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
  });

  it('applies the fixed workbench authoring identity', async () => {
    const dir = temp('wb-runner-ident-');
    const runner = new ControlledGitRunner();
    await initRepo(runner, dir);
    const result = await runner.runStrict({ args: ['var', 'GIT_AUTHOR_IDENT'], cwd: dir });
    expect(result.stdout).toContain(WORKBENCH_GIT_IDENTITY.name);
    expect(result.stdout).toContain(WORKBENCH_GIT_IDENTITY.email);
  });

  it('rejects a missing binary with a typed spawn error', async () => {
    const runner = new ControlledGitRunner({ gitBinary: join(temp('wb-runner-'), 'no-such-git') });
    await expect(runner.run({ args: ['--version'] })).rejects.toBeInstanceOf(GitSpawnError);
    await expect(runner.run({ args: ['--version'] })).rejects.toMatchObject({
      code: 'git-spawn-failed',
    });
  });

  it('times out a hung command with a typed timeout error', async () => {
    const dir = temp('wb-runner-timeout-');
    const script = join(dir, 'hung.sh');
    writeFileSync(script, '#!/bin/sh\nsleep 30\n');
    chmodSync(script, 0o755);
    const runner = new ControlledGitRunner({ gitBinary: script, timeoutMs: 200 });
    await expect(runner.run({ args: [] })).rejects.toBeInstanceOf(GitTimeoutError);
    await expect(runner.run({ args: [] })).rejects.toMatchObject({ code: 'git-timeout' });
  });

  it('throws a typed command error from runStrict on nonzero exit', async () => {
    const dir = temp('wb-runner-strict-');
    const runner = new ControlledGitRunner();
    await initRepo(runner, dir);
    await expect(
      runner.runStrict({ args: ['rev-parse', '--verify', 'definitely-not-a-real-rev'], cwd: dir }),
    ).rejects.toBeInstanceOf(GitCommandError);
    await expect(
      runner.runStrict({ args: ['rev-parse', '--verify', 'definitely-not-a-real-rev'], cwd: dir }),
    ).rejects.toMatchObject({ code: 'git-command-failed' });
  });

  it('honors per-call cwd and environment overrides', async () => {
    const dir = temp('wb-runner-cwd-');
    mkdirSync(join(dir, 'sub'));
    const runner = new ControlledGitRunner();
    await initRepo(runner, join(dir, 'sub'));
    const inside = await runner.runStrict({
      args: ['rev-parse', '--is-inside-work-tree'],
      cwd: join(dir, 'sub'),
    });
    expect(inside.stdout.trim()).toBe('true');
    const probe = await runner.runStrict({
      args: ['config', '--get', 'core.hooksPath'],
      cwd: join(dir, 'sub'),
    });
    expect(probe.stdout.trim().length).toBeGreaterThan(0);
  });
});

describe('authoring preconditions (divergence safeguards)', () => {
  it('accepts a clean repository on the fixed authoring ref', async () => {
    const dir = temp('wb-preflight-ok-');
    const runner = new ControlledGitRunner();
    await initRepo(runner, dir);
    await seedCommit(runner, dir);
    const preflight = await runner.requireAuthoringPreconditions({ cwd: dir });
    expect(preflight.ok).toBe(true);
    expect(preflight.repoRoot).toBe(dir);
    expect(preflight.ref).toBe(WORKBENCH_AUTHORING_REF);
    expect(preflight.checks.length).toBeGreaterThan(0);
    for (const check of preflight.checks) {
      expect(check.ok, `${check.condition}: ${check.detail ?? ''}`).toBe(true);
    }
  });

  it('rejects a detached checkout with a typed divergence error', async () => {
    const dir = temp('wb-preflight-detached-');
    const runner = new ControlledGitRunner();
    await initRepo(runner, dir);
    await seedCommit(runner, dir);
    await runner.runStrict({ args: ['checkout', '--detach', 'HEAD'], cwd: dir });
    const preflight = await runner.preflightRepository({ cwd: dir });
    expect(preflight.ok).toBe(false);
    expect(preflight.checks.find((c) => c.condition === 'head-on-fixed-ref')?.ok).toBe(false);
    await expect(runner.requireAuthoringPreconditions({ cwd: dir })).rejects.toBeInstanceOf(
      GitDivergenceError,
    );
    await expect(runner.requireAuthoringPreconditions({ cwd: dir })).rejects.toMatchObject({
      code: 'git-divergence',
    });
  });

  it('rejects external dirty state in the primary worktree', async () => {
    const dir = temp('wb-preflight-dirty-');
    const runner = new ControlledGitRunner();
    await initRepo(runner, dir);
    await seedCommit(runner, dir);
    writeFileSync(join(dir, 'nova.yaml'), 'project: externally tampered\n');
    const preflight = await runner.preflightRepository({ cwd: dir });
    expect(preflight.ok).toBe(false);
    expect(preflight.checks.find((c) => c.condition === 'primary-clean')?.ok).toBe(false);
    await expect(runner.requireAuthoringPreconditions({ cwd: dir })).rejects.toMatchObject({
      code: 'git-divergence',
    });
  });

  it('rejects an externally moved fixed ref against the expected head', async () => {
    const dir = temp('wb-preflight-refmove-');
    const runner = new ControlledGitRunner();
    await initRepo(runner, dir);
    const original = await seedCommit(runner, dir);
    // Simulate an external commit that advances the fixed ref while leaving the
    // worktree and index byte-identical: only the Host-known expected head can
    // detect the divergence.
    const tree = (await runner.runStrict({ args: ['write-tree'], cwd: dir })).stdout.trim();
    const external = (
      await runner.runStrict({
        args: ['commit-tree', tree, '-p', original, '-m', 'external commit'],
        cwd: dir,
      })
    ).stdout.trim();
    await runner.runStrict({ args: ['update-ref', WORKBENCH_AUTHORING_REF, external], cwd: dir });
    const preflight = await runner.preflightRepository({ cwd: dir, expectedHead: original });
    expect(preflight.checks.find((c) => c.condition === 'head-matches-ref')?.ok).toBe(true);
    expect(preflight.checks.find((c) => c.condition === 'primary-clean')?.ok).toBe(true);
    expect(preflight.checks.find((c) => c.condition === 'expected-head-match')?.ok).toBe(false);
    expect(preflight.ok).toBe(false);
    await expect(
      runner.requireAuthoringPreconditions({ cwd: dir, expectedHead: original }),
    ).rejects.toMatchObject({ code: 'git-divergence' });
  });

  it('rejects a directory that is not inside a work tree', async () => {
    const dir = temp('wb-preflight-norepo-');
    const runner = new ControlledGitRunner();
    const preflight = await runner.preflightRepository({ cwd: dir });
    expect(preflight.ok).toBe(false);
    expect(preflight.checks.find((c) => c.condition === 'inside-work-tree')?.ok).toBe(false);
    await expect(runner.requireAuthoringPreconditions({ cwd: dir })).rejects.toMatchObject({
      code: 'git-divergence',
    });
  });

  it('fails closed on byte-rewriting worktree attributes', async () => {
    const dir = temp('wb-preflight-attrs-');
    const runner = new ControlledGitRunner();
    await initRepo(runner, dir);
    await seedCommit(runner, dir);
    writeFileSync(join(dir, '.gitattributes'), '* text eol=crlf\n');
    const preflight = await runner.preflightRepository({ cwd: dir });
    expect(preflight.checks.find((c) => c.condition === 'isolation-clean')?.ok).toBe(false);
    await expect(runner.requireAuthoringPreconditions({ cwd: dir })).rejects.toBeInstanceOf(
      GitIsolationError,
    );
    await expect(runner.requireAuthoringPreconditions({ cwd: dir })).rejects.toMatchObject({
      code: 'git-isolation-unsafe',
    });
  });

  it('fails closed on repository-local filter configuration', async () => {
    const dir = temp('wb-preflight-filter-');
    const runner = new ControlledGitRunner();
    await initRepo(runner, dir);
    await seedCommit(runner, dir);
    await runner.runStrict({ args: ['config', 'filter.hostile.clean', 'cat'], cwd: dir });
    const preflight = await runner.preflightRepository({ cwd: dir });
    expect(preflight.ok).toBe(false);
    expect(preflight.checks.find((c) => c.condition === 'isolation-clean')?.ok).toBe(false);
    await expect(runner.requireAuthoringPreconditions({ cwd: dir })).rejects.toMatchObject({
      code: 'git-isolation-unsafe',
    });
  });

  it('still enforces the controlled byte policy when repository config overrides it', async () => {
    const dir = temp('wb-preflight-autocrlf-');
    const runner = new ControlledGitRunner();
    await initRepo(runner, dir);
    await seedCommit(runner, dir);
    await runner.runStrict({ args: ['config', 'core.autocrlf', 'true'], cwd: dir });
    const preflight = await runner.preflightRepository({ cwd: dir });
    const config = preflight.checks.find((c) => c.condition === 'controlled-config');
    expect(config?.ok).toBe(true); // per-invocation -c core.autocrlf=false still wins
    expect(preflight.checks.find((c) => c.condition === 'isolation-clean')?.ok).toBe(false);
  });
  it('fails closed on external replace refs and never honors them', async () => {
    const dir = temp('wb-preflight-replace-');
    const runner = new ControlledGitRunner();
    await initRepo(runner, dir);
    const original = await seedCommit(runner, dir);
    const tree = (await runner.runStrict({ args: ['write-tree'], cwd: dir })).stdout.trim();
    const replacement = (
      await runner.runStrict({ args: ['commit-tree', tree, '-m', 'replaced content'], cwd: dir })
    ).stdout.trim();
    await runner.runStrict({
      args: ['update-ref', `refs/replace/${original}`, replacement],
      cwd: dir,
    });
    // The controlled boundary ignores refs/replace/*: the original object is
    // still what the runner resolves, never the substituted one.
    const content = await runner.runStrict({ args: ['cat-file', 'commit', original], cwd: dir });
    expect(content.stdout).toContain('seed');
    // Every SHA-based check still passes; only the replace-ref isolation check
    // detects the external substitution and fails closed.
    const preflight = await runner.preflightRepository({ cwd: dir, expectedHead: original });
    expect(preflight.checks.find((c) => c.condition === 'expected-head-match')?.ok).toBe(true);
    expect(preflight.checks.find((c) => c.condition === 'isolation-clean')?.ok).toBe(false);
    await expect(runner.requireAuthoringPreconditions({ cwd: dir })).rejects.toBeInstanceOf(
      GitIsolationError,
    );
  });
});

describe('controlled invocation guards', () => {
  it('rejects config-injection arguments with a typed error', async () => {
    const runner = new ControlledGitRunner();
    await expect(
      runner.run({ args: ['-c', 'core.hooksPath=/evil', 'rev-parse', 'HEAD'] }),
    ).rejects.toBeInstanceOf(GitArgsRejectedError);
    await expect(
      runner.run({ args: ['--config-env=core.hooksPath=EVIL_HOOKS', 'rev-parse', 'HEAD'] }),
    ).rejects.toMatchObject({ code: 'git-args-rejected' });
  });

  it('rejects repo-redirect arguments with a typed error', async () => {
    const runner = new ControlledGitRunner();
    await expect(
      runner.run({ args: ['--git-dir=/evil', 'rev-parse', 'HEAD'] }),
    ).rejects.toMatchObject({ code: 'git-args-rejected' });
  });

  it('rejects protected environment overrides with a typed error', async () => {
    const runner = new ControlledGitRunner();
    await expect(
      runner.run({ args: ['rev-parse', 'HEAD'], env: { GIT_AUTHOR_NAME: 'Evil' } }),
    ).rejects.toBeInstanceOf(GitEnvironmentRejectedError);
    await expect(
      runner.run({
        args: ['rev-parse', 'HEAD'],
        env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Evil' },
      }),
    ).rejects.toMatchObject({ code: 'git-env-rejected' });
    await expect(
      runner.run({ args: ['rev-parse', 'HEAD'], env: { GIT_CONFIG_GLOBAL: '/evil/gitconfig' } }),
    ).rejects.toMatchObject({ code: 'git-env-rejected' });
    await expect(
      runner.run({ args: ['rev-parse', 'HEAD'], env: { GIT_REDIRECT_STDERR: '/evil/trace' } }),
    ).rejects.toMatchObject({ code: 'git-env-rejected' });
    await expect(
      runner.run({ args: ['rev-parse', 'HEAD'], env: { GIT_TRACE2_EVENT: '/evil/trace' } }),
    ).rejects.toMatchObject({ code: 'git-env-rejected' });
  });

  it('still allows GIT_INDEX_FILE for temporary-index isolation', async () => {
    const dir = temp('wb-runner-index-');
    const runner = new ControlledGitRunner();
    await initRepo(runner, dir);
    await seedCommit(runner, dir);
    const indexFile = join(dir, 'tmp-index');
    await runner.runStrict({
      args: ['read-tree', 'HEAD'],
      cwd: dir,
      env: { GIT_INDEX_FILE: indexFile },
    });
    const result = await runner.runStrict({
      args: ['write-tree'],
      cwd: dir,
      env: { GIT_INDEX_FILE: indexFile },
    });
    expect(result.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
  });
});
