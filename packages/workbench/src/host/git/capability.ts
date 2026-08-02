/**
 * Verified system-Git capability probe.
 *
 * Startup and scaffold fail closed unless every Git plumbing primitive the
 * Workbench authoring flow depends on is proven to work inside a real
 * temporary repository: controlled init on the fixed authoring ref, a
 * temporary index, temporary worktrees, `write-tree`, `commit-tree`, atomic
 * `update-ref` compare-and-swap, and isolation of repository/global hooks,
 * external filters and attribute-driven byte rewriting.
 *
 * The probe actively installs a hostile repository configuration (hooks that
 * would write marker files, a filter script, `* text eol=crlf` attributes, a
 * hostile global `.gitconfig`) and verifies the controlled runner neutralizes
 * it while raw authoring bytes round-trip unchanged. Any missing primitive or
 * any isolation failure is reported as a structured check failure and the
 * overall probe is `ok: false` — Workbench must fail closed, never fall back
 * to unversioned direct writes.
 *
 * The runner and the temp-directory factory are injected so tests can drive
 * failure modes (e.g. an uncontrolled runner that lets hooks execute).
 */

import { spawn } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ControlledGitRunner,
  type GitCommandRunner,
  GitHostError,
  type GitRunResult,
  WORKBENCH_AUTHORING_REF,
} from './runner.js';

export interface GitCapabilityCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: string;
}

export interface GitCapability {
  readonly ok: boolean;
  readonly gitBinary: string;
  readonly gitVersion: string | null;
  readonly checks: readonly GitCapabilityCheck[];
  readonly errors: readonly string[];
}

export interface GitCapabilityProbeOptions {
  readonly runner: GitCommandRunner;
  /** Factory for throwaway probe directories; defaults to os.tmpdir(). */
  readonly makeTempDir?: () => Promise<string>;
}

/** Thrown by {@link requireGitCapability} when the probe reports missing capability. */
export class GitCapabilityError extends GitHostError {
  readonly capability: GitCapability;
  constructor(capability: GitCapability) {
    const failed = capability.checks
      .filter((check) => !check.ok)
      .map((check) => `${check.name}: ${check.detail ?? 'missing'}`)
      .join('; ');
    super('git-capability-missing', `Workbench Git capability probe failed: ${failed}`);
    this.capability = capability;
  }
}

const CHECK = {
  binary: 'git-binary',
  init: 'controlled-init',
  temporaryIndex: 'temporary-index',
  writeTree: 'write-tree',
  commitTree: 'commit-tree',
  updateRefCas: 'update-ref-cas',
  temporaryWorktree: 'temporary-worktree',
  byteIsolation: 'authoring-byte-isolation',
  hookIsolation: 'hook-isolation',
  configIsolation: 'config-isolation',
} as const;

const ABORTED = 'probe aborted';

const defaultMakeTempDir = (): Promise<string> => mkdtemp(join(tmpdir(), 'workbench-git-probe-'));

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function trim(text: string): string {
  return text.trim();
}

/** Probe the runner's Git against every required plumbing primitive. */
export async function probeGitCapability(
  options: GitCapabilityProbeOptions,
): Promise<GitCapability> {
  const runner = options.runner;
  const makeTempDir = options.makeTempDir ?? defaultMakeTempDir;
  const checks: GitCapabilityCheck[] = [];
  const errors: string[] = [];
  const recorded = new Set<string>();
  const record = (name: string, ok: boolean, detail?: string): void => {
    recorded.add(name);
    checks.push({ name, ok, detail });
    if (!ok) errors.push(`${name}: ${detail ?? 'missing'}`);
  };
  const abort = (): void => {
    for (const name of Object.values(CHECK)) {
      if (!recorded.has(name)) record(name, false, ABORTED);
    }
  };
  const run = (args: readonly string[], env?: Record<string, string>): Promise<GitRunResult> =>
    runner.run({ args, env });
  // Positive control: execute git WITHOUT the controlled boundary so the
  // hostile repository hooksPath provably runs the marker hook. This is the
  // only invocation that bypasses the runner; it never carries user input.
  const runUncontrolled = (
    repoDir: string,
    args: readonly string[],
    globalConfigPath: string,
  ): Promise<{ exitCode: number; stderr: string }> => {
    const { promise, resolve, reject } = Promise.withResolvers<{
      exitCode: number;
      stderr: string;
    }>();
    const child = spawn(runner.gitBinary, ['-C', repoDir, ...args], {
      env: {
        PATH: process.env.PATH ?? '',
        LC_ALL: 'C',
        LANG: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: globalConfigPath,
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (exitCode) => resolve({ exitCode: exitCode ?? -1, stderr }));
    return promise;
  };
  const finish = (gitVersion: string | null): GitCapability => ({
    ok: checks.every((check) => check.ok),
    gitBinary: runner.gitBinary,
    gitVersion,
    checks,
    errors,
  });

  let uncontrolledEmptyConfig: string | null = null;
  let base: string | null = null;
  try {
    base = await makeTempDir();
    const repo = join(base, 'repo');
    const worktree = join(base, 'worktree');
    const hostileHome = join(base, 'home');
    const hostileHooks = join(base, 'hostile-hooks');
    const hostileGlobalHooks = join(base, 'hostile-global-hooks');
    const marker = join(base, 'hook-ran');
    const blobPath = join(base, 'probe.bin');
    const filterScript = join(base, 'filter.sh');
    const indexFile = join(base, 'index.tmp');
    await mkdir(hostileHome, { recursive: true });
    await mkdir(hostileHooks, { recursive: true });
    await mkdir(hostileGlobalHooks, { recursive: true });
    const emptyConfigPath = join(base, 'uncontrolled-empty-config');
    uncontrolledEmptyConfig = emptyConfigPath;
    await writeFile(emptyConfigPath, '');

    // --- git binary and version -------------------------------------------------
    let gitVersion: string | null = null;
    try {
      const version = await run(['--version']);
      const match = /^git version (\S+)/.exec(trim(version.stdout));
      if (version.exitCode !== 0 || !match) {
        record(
          CHECK.binary,
          false,
          `git --version failed (exit ${version.exitCode}): ${trim(version.stderr)}`,
        );
        abort();
        return finish(null);
      }
      gitVersion = match[1];
      record(CHECK.binary, true, gitVersion);
    } catch (error) {
      record(CHECK.binary, false, String(error));
      abort();
      return finish(null);
    }

    // --- controlled init on the fixed authoring ref ------------------------------
    const init = await run(['init', '--quiet', '--initial-branch=workbench', repo]);
    if (init.exitCode !== 0) {
      record(CHECK.init, false, `git init failed: ${trim(init.stderr) || `exit ${init.exitCode}`}`);
      abort();
      return finish(gitVersion);
    }
    const head = await run(['-C', repo, 'symbolic-ref', 'HEAD']);
    const fixedRef = head.exitCode === 0 && trim(head.stdout) === WORKBENCH_AUTHORING_REF;
    record(
      CHECK.init,
      fixedRef,
      fixedRef ? WORKBENCH_AUTHORING_REF : `HEAD points at ${JSON.stringify(trim(head.stdout))}`,
    );
    if (!fixedRef) {
      abort();
      return finish(gitVersion);
    }

    // --- hostile repository configuration ----------------------------------------
    // Attribute-driven rewriting plus an external filter and repo hooks. The
    // controlled pipeline must keep authoring bytes exactly as authored.
    await writeFile(join(repo, '.gitattributes'), '* text eol=crlf\n* filter=workbench-hostile\n');
    await writeFile(filterScript, `#!/bin/sh\necho hostile >> ${marker}\ncat\n`);
    await chmod(filterScript, 0o755);
    await writeFile(join(hostileHooks, 'post-commit'), `#!/bin/sh\necho ran >> ${marker}\n`);
    await chmod(join(hostileHooks, 'post-commit'), 0o755);
    await writeFile(join(hostileGlobalHooks, 'post-commit'), `#!/bin/sh\necho ran >> ${marker}\n`);
    await chmod(join(hostileGlobalHooks, 'post-commit'), 0o755);
    const hostileConfig: Array<Promise<GitRunResult>> = [
      run(['-C', repo, 'config', 'filter.workbench-hostile.clean', filterScript]),
      run(['-C', repo, 'config', 'filter.workbench-hostile.smudge', filterScript]),
      run(['-C', repo, 'config', 'core.hooksPath', hostileHooks]),
      run(['-C', repo, 'config', 'user.name', 'Probe']),
      run(['-C', repo, 'config', 'user.email', 'probe@workbench.test']),
    ];
    const hostileConfigResults = await Promise.all(hostileConfig);
    if (hostileConfigResults.some((result) => result.exitCode !== 0)) {
      record(
        CHECK.byteIsolation,
        false,
        `hostile repository setup failed: ${hostileConfigResults
          .filter((result) => result.exitCode !== 0)
          .map((result) => trim(result.stderr))
          .join('; ')}`,
      );
      abort();
      return finish(gitVersion);
    }
    // --- baseline tree/commit and ref creation ------------------------------------
    const treeA = await run(['-C', repo, 'write-tree']);
    if (treeA.exitCode !== 0) {
      record(CHECK.writeTree, false, `write-tree failed: ${trim(treeA.stderr)}`);
      abort();
      return finish(gitVersion);
    }
    const commitA = await run(['-C', repo, 'commit-tree', trim(treeA.stdout), '-m', 'baseline']);
    if (commitA.exitCode !== 0) {
      record(CHECK.commitTree, false, `commit-tree failed: ${trim(commitA.stderr)}`);
      abort();
      return finish(gitVersion);
    }
    const baseline = await run([
      '-C',
      repo,
      'update-ref',
      WORKBENCH_AUTHORING_REF,
      trim(commitA.stdout),
    ]);
    if (baseline.exitCode !== 0) {
      record(CHECK.commitTree, false, `baseline update-ref failed: ${trim(baseline.stderr)}`);
      abort();
      return finish(gitVersion);
    }
    record(CHECK.writeTree, true, trim(treeA.stdout));
    record(CHECK.commitTree, true, trim(commitA.stdout));

    // --- temporary index round-trip ------------------------------------------------
    const indexEnv = { GIT_INDEX_FILE: indexFile };
    const readTree = await run(['-C', repo, 'read-tree', WORKBENCH_AUTHORING_REF], indexEnv);
    const treeB = await run(['-C', repo, 'write-tree'], indexEnv);
    const tempIndexOk =
      readTree.exitCode === 0 && treeB.exitCode === 0 && trim(treeB.stdout) === trim(treeA.stdout);
    record(
      CHECK.temporaryIndex,
      tempIndexOk,
      tempIndexOk
        ? 'read-tree/write-tree round-trip preserved the tree'
        : `read-tree exit ${readTree.exitCode}, write-tree exit ${treeB.exitCode}, tree=${trim(treeB.stdout)}`,
    );

    // --- authoring byte isolation ---------------------------------------------------
    // Prove the hostile filter is real, then prove the controlled plumbing path
    // (hash-object --no-filters -> update-index --cacheinfo -> write-tree ->
    // cat-file) round-trips raw LF bytes untouched.
    const authoring = Buffer.from('project: probe\nchapter: 1\n');
    await writeFile(blobPath, authoring);
    await rm(marker, { force: true });
    const filtered = await run(['-C', repo, 'hash-object', '-w', blobPath]);
    const filterRan = await exists(marker);
    await rm(marker, { force: true });
    const raw = await run(['-C', repo, 'hash-object', '-w', '--no-filters', blobPath]);
    const rawSha = trim(raw.stdout);
    const addIndex = await run(
      ['-C', repo, 'update-index', '--add', '--cacheinfo', `100644,${rawSha},probe.yaml`],
      indexEnv,
    );
    const treeC = await run(['-C', repo, 'write-tree'], indexEnv);
    const lsTree = await run(['-C', repo, 'ls-tree', trim(treeC.stdout), 'probe.yaml']);
    const catFile = await run(['-C', repo, 'cat-file', 'blob', rawSha]);
    const byteOk =
      raw.exitCode === 0 &&
      addIndex.exitCode === 0 &&
      treeC.exitCode === 0 &&
      lsTree.exitCode === 0 &&
      lsTree.stdout.includes(`100644 blob ${rawSha}\tprobe.yaml`) &&
      catFile.exitCode === 0 &&
      catFile.stdout === authoring.toString('utf8');
    record(
      CHECK.byteIsolation,
      byteOk,
      byteOk
        ? `raw bytes preserved (hostile filter executed: ${filterRan}, filtered hash ${trim(filtered.stdout)})`
        : `raw ${rawSha} filtered ${trim(filtered.stdout)} ls-tree ${trim(lsTree.stdout)} cat-file ${catFile.exitCode}`,
    );

    // --- commit-tree with parent + update-ref CAS ------------------------------------
    const commitB = await run([
      '-C',
      repo,
      'commit-tree',
      trim(treeC.stdout),
      '-p',
      trim(commitA.stdout),
      '-m',
      'probe content',
    ]);
    const commitParentOk = commitB.exitCode === 0;
    const casOk = await run([
      '-C',
      repo,
      'update-ref',
      WORKBENCH_AUTHORING_REF,
      trim(commitB.stdout),
      trim(commitA.stdout),
    ]);
    const refAfter = await run(['-C', repo, 'rev-parse', WORKBENCH_AUTHORING_REF]);
    const casStale = await run([
      '-C',
      repo,
      'update-ref',
      WORKBENCH_AUTHORING_REF,
      trim(commitA.stdout),
      '0'.repeat(40),
    ]);
    const refAfterStale = await run(['-C', repo, 'rev-parse', WORKBENCH_AUTHORING_REF]);
    const casOkCheck =
      commitParentOk &&
      casOk.exitCode === 0 &&
      trim(refAfter.stdout) === trim(commitB.stdout) &&
      casStale.exitCode !== 0 &&
      trim(refAfterStale.stdout) === trim(commitB.stdout);
    record(
      CHECK.updateRefCas,
      casOkCheck,
      casOkCheck
        ? 'expected-old CAS accepted; stale CAS rejected atomically'
        : `commit ${commitB.exitCode} casOk ${casOk.exitCode} refAfter ${trim(refAfter.stdout)} casStale ${casStale.exitCode} refAfterStale ${trim(refAfterStale.stdout)}`,
    );

    // --- temporary worktree ------------------------------------------------------------
    const worktreeAdd = await run([
      '-C',
      repo,
      'worktree',
      'add',
      '--detach',
      '--no-checkout',
      worktree,
      WORKBENCH_AUTHORING_REF,
    ]);
    const wtHead = await run(['-C', worktree, 'rev-parse', 'HEAD']);
    const currentRef = await run(['-C', repo, 'rev-parse', WORKBENCH_AUTHORING_REF]);
    const worktreeOk =
      worktreeAdd.exitCode === 0 &&
      wtHead.exitCode === 0 &&
      trim(wtHead.stdout) === trim(currentRef.stdout);
    record(
      CHECK.temporaryWorktree,
      worktreeOk,
      worktreeOk
        ? `detached worktree at ${trim(currentRef.stdout)}`
        : `worktree add exit ${worktreeAdd.exitCode}, HEAD ${trim(wtHead.stdout)}`,
    );

    // --- hook isolation -----------------------------------------------------------------
    // The repo config points core.hooksPath at a hostile directory; the
    // controlled runner must neutralize it. Then run a positive control that
    // executes git WITHOUT the controlled boundary so the repository's hostile
    // hooksPath applies and the marker hook provably runs.
    await rm(marker, { force: true });
    const hookProbe = await run(['-C', repo, 'commit', '--allow-empty', '-m', 'hook probe']);
    const hookRan = await exists(marker);
    await rm(marker, { force: true });
    const control = await runUncontrolled(
      repo,
      ['commit', '--allow-empty', '-m', 'hook control'],
      emptyConfigPath,
    );
    const controlRan = await exists(marker);
    const hookOk = hookProbe.exitCode === 0 && !hookRan;
    record(
      CHECK.hookIsolation,
      hookOk,
      hookOk
        ? `repository hooksPath neutralized (uncontrolled control exit ${control.exitCode}, hook executed: ${controlRan})`
        : `hostile hook executed (marker=${hookRan}, commit exit ${hookProbe.exitCode})`,
    );

    // --- config isolation ----------------------------------------------------------------
    // A hostile HOME with a global .gitconfig must be ignored (GIT_CONFIG_GLOBAL
    // is pinned to an empty file) and the effective hooksPath must be the
    // controlled one, never the repository's hostile value.
    await writeFile(
      join(hostileHome, '.gitconfig'),
      `[core]\n\thooksPath = ${hostileGlobalHooks}\n[user]\n\tname = Hostile\n\temail = hostile@evil.test\n`,
    );
    const hooksRead = await run(['-C', repo, 'config', '--get', 'core.hooksPath'], {
      HOME: hostileHome,
    });
    const repoConfig = await readFile(join(repo, '.git', 'config'), 'utf8');
    const hostileRepoConfig =
      repoConfig.includes('workbench-hostile') && repoConfig.includes(hostileHooks);
    const effectiveHooks = trim(hooksRead.stdout);
    const configOk =
      hostileRepoConfig &&
      effectiveHooks.length > 0 &&
      effectiveHooks !== hostileHooks &&
      effectiveHooks !== hostileGlobalHooks;
    record(
      CHECK.configIsolation,
      configOk,
      configOk
        ? `global/user config ignored; effective hooksPath ${effectiveHooks}`
        : `hostileRepoConfig=${hostileRepoConfig} effectiveHooks=${JSON.stringify(effectiveHooks)}`,
    );

    return finish(gitVersion);
  } finally {
    if (uncontrolledEmptyConfig) {
      await rm(uncontrolledEmptyConfig, { force: true }).catch(() => undefined);
    }
    if (base) {
      await rm(base, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** Probe the system git binary through a default controlled runner. */
export async function probeSystemGit(
  options: { readonly gitBinary?: string } = {},
): Promise<GitCapability> {
  const runner = new ControlledGitRunner({ gitBinary: options.gitBinary });
  return probeGitCapability({ runner });
}

/** Fail closed unless the probe reports every primitive available. */
export function requireGitCapability(capability: GitCapability): void {
  if (!capability.ok) throw new GitCapabilityError(capability);
}
