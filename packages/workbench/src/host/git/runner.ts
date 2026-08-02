/**
 * Controlled system-Git command runner.
 *
 * Git is the Workbench Host's authoring-history engine and is only ever invoked
 * through this runner: a fixed binary, a minimal environment, and per-invocation
 * `-c` configuration that neutralize project/user hooks, external filters and
 * attribute-driven byte rewriting. Replace refs (`refs/replace/*`) are never
 * honored and system-wide attributes are disabled, so object substitution and
 * byte rewriting stay deterministic. Arguments are passed as an argv array and
 * are never interpolated into a shell; no user, browser, MCP or Agent input
 * ever reaches a shell through this boundary.
 *
 * The runner is intentionally dumb and deterministic: it never throws for a
 * nonzero exit (callers inspect `exitCode`), it rejects only on spawn failure
 * or timeout, and every invocation carries the same controlled configuration.
 *
 * Before any authoring mutation callers run `requireAuthoringPreconditions`
 * to fail closed on repository divergence (external dirty state, moved or
 * missing fixed ref, detached checkout, external commits) and on unsafe
 * isolation (byte-rewriting config/attributes/filters or replace refs, or a
 * capability mismatch where the controlled environment is not effective).
 * `run` itself
 * rejects arguments and environment overrides that could re-expose hooks,
 * filters, aliases, pagers or an external repository, so user-controlled
 * input can never weaken the controlled boundary.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Fixed authoring identity used for every commit created by the Workbench Host. */
export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

export const WORKBENCH_GIT_IDENTITY: Readonly<GitIdentity> = {
  name: 'Fabula Workbench',
  email: 'workbench@novalistically.local',
};

/** Fixed authoring ref owned by the Workbench Host; never switched by callers. */
export const WORKBENCH_AUTHORING_REF = 'refs/heads/workbench';

export interface GitCommandRunnerOptions {
  /** Fixed git binary; defaults to `git` resolved through PATH. */
  readonly gitBinary?: string;
  /** Authoring identity; defaults to {@link WORKBENCH_GIT_IDENTITY}. */
  readonly identity?: Readonly<GitIdentity>;
  /** Extra environment variables merged over the minimal controlled environment. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Scratch directory that owns the hookless hooks path and the empty config /
   * attributes files used to isolate Git. Created on demand when omitted.
   */
  readonly scratchDir?: string;
  /** Default per-command timeout in milliseconds (default 30s). */
  readonly timeoutMs?: number;
  /** Additional `-c key=value` pairs applied to every invocation (Host-internal use). */
  readonly extraConfig?: readonly (readonly [string, string])[];
}

export interface GitRunRequest {
  /** Git subcommand and arguments, e.g. `['rev-parse', 'HEAD']`. Never shell-interpolated. */
  readonly args: readonly string[];
  /** Working directory for the child process; defaults to the Host's current directory. */
  readonly cwd?: string;
  /** Per-call environment overrides merged over the controlled base environment. */
  readonly env?: Readonly<Record<string, string>>;
  /** Per-call timeout in milliseconds. */
  readonly timeoutMs?: number;
}

export interface GitRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitCommandRunner {
  readonly gitBinary: string;
  run(request: GitRunRequest): Promise<GitRunResult>;
}

/** Base class for all structured errors thrown by the Git boundary. */
export class GitHostError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** The configured binary could not be spawned (missing or not executable). */
export class GitSpawnError extends GitHostError {
  readonly gitBinary: string;
  constructor(gitBinary: string, cause: unknown) {
    super(
      'git-spawn-failed',
      `Failed to spawn git binary ${gitBinary}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.gitBinary = gitBinary;
  }
}

/** A command exceeded its deadline and was terminated. */
export class GitTimeoutError extends GitHostError {
  readonly args: readonly string[];
  readonly timeoutMs: number;
  constructor(args: readonly string[], timeoutMs: number) {
    super('git-timeout', `git ${args.join(' ')} timed out after ${timeoutMs}ms`);
    this.args = args;
    this.timeoutMs = timeoutMs;
  }
}

/** A checked command exited nonzero. */
export class GitCommandError extends GitHostError {
  readonly args: readonly string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  constructor(args: readonly string[], result: GitRunResult) {
    super(
      'git-command-failed',
      `git ${args.join(' ')} exited with code ${result.exitCode}: ${result.stderr.trim() || '(no stderr)'}`,
    );
    this.args = args;
    this.exitCode = result.exitCode;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
  }
}

/** Repository-state conditions validated before any authoring mutation. */
export type GitPreflightCondition =
  | 'inside-work-tree'
  | 'fixed-ref-present'
  | 'head-on-fixed-ref'
  | 'head-matches-ref'
  | 'expected-head-match'
  | 'primary-clean'
  | 'controlled-config'
  | 'isolation-clean';

export interface GitPreflightCheck {
  readonly condition: GitPreflightCondition;
  readonly ok: boolean;
  readonly detail?: string;
}

export interface GitRepositoryPreflight {
  readonly ok: boolean;
  /** Primary worktree root when `inside-work-tree` holds, otherwise null. */
  readonly repoRoot: string | null;
  /** The fixed authoring ref that was validated. */
  readonly ref: string;
  readonly checks: readonly GitPreflightCheck[];
}

export interface GitRepositoryPreflightOptions {
  /** Primary worktree directory to validate (must be inside the repository). */
  readonly cwd: string;
  /** Fixed authoring ref; defaults to {@link WORKBENCH_AUTHORING_REF}. */
  readonly ref?: string;
  /**
   * Host-known commit the fixed ref must still resolve to. Detects an
   * external commit made outside the Host: any mismatch is divergence.
   */
  readonly expectedHead?: string;
}

function describeFailedChecks(preflight: GitRepositoryPreflight): string {
  return preflight.checks
    .filter((check) => !check.ok)
    .map((check) => `${check.condition}: ${check.detail ?? 'failed'}`)
    .join('; ');
}

/** Thrown when repository state diverges from the fixed authoring preconditions. */
export class GitDivergenceError extends GitHostError {
  readonly preflight: GitRepositoryPreflight;
  constructor(preflight: GitRepositoryPreflight) {
    super('git-divergence', `authoring repository divergence: ${describeFailedChecks(preflight)}`);
    this.preflight = preflight;
  }
}

/**
 * Thrown when the repository carries unsafe config/attributes/filter or the
 * controlled environment is not effective (capability mismatch).
 */
export class GitIsolationError extends GitHostError {
  readonly preflight: GitRepositoryPreflight;
  constructor(preflight: GitRepositoryPreflight) {
    super(
      'git-isolation-unsafe',
      `authoring repository isolation unsafe: ${describeFailedChecks(preflight)}`,
    );
    this.preflight = preflight;
  }
}

/** Thrown when a call passes arguments that could re-expose hooks, filters or an external repo. */
export class GitArgsRejectedError extends GitHostError {
  readonly args: readonly string[];
  readonly rejected: readonly string[];
  constructor(args: readonly string[], rejected: readonly string[]) {
    super(
      'git-args-rejected',
      `refusing controlled git invocation with config/repo-redirect argument(s): ${rejected.join(', ')}`,
    );
    this.args = args;
    this.rejected = rejected;
  }
}

/** Thrown when a call overrides environment variables the controlled boundary pins. */
export class GitEnvironmentRejectedError extends GitHostError {
  readonly keys: readonly string[];
  constructor(keys: readonly string[]) {
    super(
      'git-env-rejected',
      `refusing controlled git invocation overriding protected environment: ${keys.join(', ')}`,
    );
    this.keys = keys;
  }
}

/** Git argument forms that can re-expose hooks/filters/aliases or redirect the repository. */
const REJECTED_ARG_FORMS: Record<string, true> = {
  '-c': true,
  '--config': true,
  '--config-env': true,
  '--git-dir': true,
  '--work-tree': true,
  '--namespace': true,
  '--exec-path': true,
};
const REJECTED_ARG_PREFIXES = [
  '--config=',
  '--config-env=',
  '--git-dir=',
  '--work-tree=',
  '--namespace=',
  '--exec-path=',
] as const;

/** Environment variables the controlled boundary pins; per-call overrides are rejected. */
const PROTECTED_ENV: Record<string, true> = {
  GIT_CONFIG_NOSYSTEM: true,
  GIT_CONFIG_SYSTEM: true,
  GIT_CONFIG_GLOBAL: true,
  GIT_CONFIG_COUNT: true,
  GIT_CONFIG_PARAMETERS: true,
  GIT_DIR: true,
  GIT_WORK_TREE: true,
  GIT_OBJECT_DIRECTORY: true,
  GIT_ALTERNATE_OBJECT_DIRECTORIES: true,
  GIT_NAMESPACE: true,
  GIT_ASKPASS: true,
  GIT_SSH: true,
  GIT_SSH_COMMAND: true,
  GIT_SSH_VARIANT: true,
  GIT_EDITOR: true,
  GIT_SEQUENCE_EDITOR: true,
  GIT_PAGER: true,
  GIT_REDIRECT_STDERR: true,
  GIT_REDIRECT_STDOUT: true,
  GIT_EXTERNAL_DIFF: true,
  GIT_TERMINAL_PROMPT: true,
  GIT_PROTOCOL_FROM_USER: true,
  GIT_OPTIONAL_LOCKS: true,
  GIT_EXEC_PATH: true,
  GIT_ATTR_NOSYSTEM: true,
  GIT_INDEX_VERSION: true,
  GIT_AUTHOR_NAME: true,
  GIT_AUTHOR_EMAIL: true,
  GIT_AUTHOR_DATE: true,
  GIT_COMMITTER_NAME: true,
  GIT_COMMITTER_EMAIL: true,
  GIT_COMMITTER_DATE: true,
  LC_ALL: true,
  LANG: true,
};

/** Environment variables a controlled call may still override (temporary-index isolation). */
const ALLOWED_GIT_ENV: Record<string, true> = { GIT_INDEX_FILE: true };

function assertControlledArgs(args: readonly string[]): void {
  const rejected: string[] = [];
  for (const arg of args) {
    if (
      REJECTED_ARG_FORMS[arg] === true ||
      REJECTED_ARG_PREFIXES.some((prefix) => arg.startsWith(prefix))
    ) {
      rejected.push(arg);
    }
  }
  if (rejected.length > 0) throw new GitArgsRejectedError(args, rejected);
}

function assertControlledEnv(env: Readonly<Record<string, string>> | undefined): void {
  if (!env) return;
  const rejected: string[] = [];
  for (const key of Object.keys(env)) {
    if (ALLOWED_GIT_ENV[key] === true) continue;
    if (
      PROTECTED_ENV[key] === true ||
      /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key) ||
      /^GIT_TRACE/.test(key)
    ) {
      rejected.push(key);
    }
  }
  if (rejected.length > 0) throw new GitEnvironmentRejectedError(rejected);
}

/** Repo-local core config keys that can rewrite authoring bytes or execute external programs. */
const UNSAFE_CORE_KEYS: Record<string, true> = {
  'core.hookspath': true,
  'core.attributesfile': true,
  'core.autocrlf': true,
  'core.eol': true,
  'core.safecrlf': true,
  'core.fsmonitor': true,
  'core.untrackedcache': true,
  'core.pager': true,
  'core.editor': true,
  'core.sshcommand': true,
  'core.askpass': true,
};

function isUnsafeConfigKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    normalized.startsWith('filter.') ||
    normalized.startsWith('alias.') ||
    normalized.startsWith('pager.') ||
    normalized.startsWith('credential.') ||
    normalized.startsWith('diff.') ||
    normalized.startsWith('merge.') ||
    UNSAFE_CORE_KEYS[normalized] === true
  );
}

/** Default timeout applied to every command unless overridden. */
const DEFAULT_TIMEOUT_MS = 30_000;

export class ControlledGitRunner implements GitCommandRunner {
  readonly gitBinary: string;
  /** Scratch directory owning the isolation files (hookless hooks path, empty config/attributes). */
  readonly scratchDir: string;
  private readonly identity: Readonly<GitIdentity>;
  private readonly baseEnv: Record<string, string>;
  private readonly controlledArgs: readonly string[];
  private readonly defaultTimeoutMs: number;
  private readonly hooklessDir: string;
  private readonly emptyConfigPath: string;
  private readonly emptyAttributesPath: string;

  constructor(options: GitCommandRunnerOptions = {}) {
    this.gitBinary = options.gitBinary ?? 'git';
    this.identity = options.identity ?? WORKBENCH_GIT_IDENTITY;
    this.scratchDir = options.scratchDir ?? mkdtempSync(join(tmpdir(), 'workbench-git-runner-'));
    this.hooklessDir = join(this.scratchDir, 'hookless');
    this.emptyConfigPath = join(this.scratchDir, 'empty-config');
    this.emptyAttributesPath = join(this.scratchDir, 'empty-attributes');
    mkdirSync(this.hooklessDir, { recursive: true });
    writeFileSync(this.emptyConfigPath, '');
    writeFileSync(this.emptyAttributesPath, '');
    this.controlledArgs = [
      // Replace refs (refs/replace/*) can silently substitute objects; the
      // authoring boundary never honors them, and preflight additionally
      // fails closed when an external process has created any.
      '--no-replace-objects',
      '-c',
      `core.hooksPath=${this.hooklessDir}`,
      '-c',
      `core.attributesFile=${this.emptyAttributesPath}`,
      '-c',
      'core.autocrlf=false',
      '-c',
      'core.eol=lf',
      '-c',
      'core.safecrlf=false',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.untrackedCache=false',
      ...(options.extraConfig ?? []).flatMap(([key, value]) => ['-c', `${key}=${value}`]),
    ];
    this.baseEnv = {
      PATH: process.env.PATH ?? '',
      LC_ALL: 'C',
      LANG: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_ATTR_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: this.emptyConfigPath,
      GIT_TERMINAL_PROMPT: '0',
      GIT_EDITOR: 'true',
      GIT_PAGER: 'cat',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_AUTHOR_NAME: this.identity.name,
      GIT_AUTHOR_EMAIL: this.identity.email,
      GIT_COMMITTER_NAME: this.identity.name,
      GIT_COMMITTER_EMAIL: this.identity.email,
      ...options.env,
    };
    this.defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Run a command; never throws for a nonzero exit. */
  async run(request: GitRunRequest): Promise<GitRunResult> {
    assertControlledArgs(request.args);
    assertControlledEnv(request.env);
    const args = [...this.controlledArgs, ...request.args];
    const env = { ...this.baseEnv, ...request.env };
    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;
    const child = spawn(this.gitBinary, args, {
      cwd: request.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const { promise, resolve, reject } = Promise.withResolvers<GitRunResult>();
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new GitTimeoutError(request.args, timeoutMs));
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new GitSpawnError(this.gitBinary, error));
    });
    child.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: exitCode ?? -1, stdout, stderr });
    });
    return promise;
  }

  /** Run a command and throw {@link GitCommandError} when it exits nonzero. */
  async runStrict(request: GitRunRequest): Promise<GitRunResult> {
    const result = await this.run(request);
    if (result.exitCode !== 0) {
      throw new GitCommandError(request.args, result);
    }
    return result;
  }

  /**
   * Validate the fixed authoring preconditions for a primary worktree without
   * mutating anything. Never throws for divergence; callers inspect `ok` and
   * the per-condition checks.
   */
  async preflightRepository(
    options: GitRepositoryPreflightOptions,
  ): Promise<GitRepositoryPreflight> {
    const ref = options.ref ?? WORKBENCH_AUTHORING_REF;
    const checks: GitPreflightCheck[] = [];
    const record = (condition: GitPreflightCondition, ok: boolean, detail?: string): void => {
      checks.push({ condition, ok, detail });
    };
    const run = (args: readonly string[]): Promise<GitRunResult> =>
      this.run({ args, cwd: options.cwd });
    const trimOut = (result: GitRunResult): string => result.stdout.trim();

    let repoRoot: string | null = null;

    const isWorkTree = await run(['rev-parse', '--is-inside-work-tree']);
    const isBare = await run(['rev-parse', '--is-bare-repository']);
    const topLevel = await run(['rev-parse', '--show-toplevel']);
    const insideOk =
      isWorkTree.exitCode === 0 &&
      isWorkTree.stdout.trim() === 'true' &&
      isBare.exitCode === 0 &&
      isBare.stdout.trim() === 'false' &&
      topLevel.exitCode === 0 &&
      trimOut(topLevel).length > 0;
    if (insideOk) repoRoot = trimOut(topLevel);
    record(
      'inside-work-tree',
      insideOk,
      insideOk
        ? trimOut(topLevel)
        : `is-inside-work-tree=${JSON.stringify(trimOut(isWorkTree))} is-bare=${JSON.stringify(trimOut(isBare))}`,
    );

    const refRev = await run(['rev-parse', '--verify', '--quiet', ref]);
    const refPresent = refRev.exitCode === 0 && trimOut(refRev).length > 0;
    record(
      'fixed-ref-present',
      refPresent,
      refPresent ? trimOut(refRev) : `ref ${ref} not resolvable`,
    );

    const symRef = await run(['symbolic-ref', '--quiet', 'HEAD']);
    const headOnRef = symRef.exitCode === 0 && trimOut(symRef) === ref;
    record(
      'head-on-fixed-ref',
      headOnRef,
      headOnRef
        ? ref
        : trimOut(symRef).length > 0
          ? `HEAD points at ${trimOut(symRef)}`
          : 'HEAD is detached',
    );

    const head = await run(['rev-parse', 'HEAD']);
    const refNow = await run(['rev-parse', ref]);
    const headMatches =
      head.exitCode === 0 && refNow.exitCode === 0 && trimOut(head) === trimOut(refNow);
    record(
      'head-matches-ref',
      headMatches,
      headMatches
        ? trimOut(head)
        : `HEAD=${trimOut(head) || 'unborn'} ref=${trimOut(refNow) || 'missing'}`,
    );

    if (options.expectedHead !== undefined) {
      const expected = options.expectedHead.trim();
      const match = refPresent && refNow.exitCode === 0 && trimOut(refNow) === expected;
      record(
        'expected-head-match',
        match,
        match ? expected : `expected ${expected} actual ${trimOut(refNow) || '(missing)'}`,
      );
    }

    const staged = await run(['diff', '--cached', '--quiet']);
    const unstaged = await run(['diff', '--quiet']);
    const untracked = await run(['ls-files', '--others', '--exclude-standard']);
    const clean =
      staged.exitCode === 0 &&
      unstaged.exitCode === 0 &&
      untracked.exitCode === 0 &&
      trimOut(untracked).length === 0;
    if (clean) {
      record('primary-clean', true, 'primary index and worktree clean');
    } else {
      const status = await run(['status', '--porcelain=v1']);
      record(
        'primary-clean',
        false,
        `staged=${staged.exitCode} unstaged=${unstaged.exitCode} untracked=${JSON.stringify(trimOut(untracked))} status=${JSON.stringify(trimOut(status))}`,
      );
    }

    const hooksPath = await run(['config', '--get', 'core.hooksPath']);
    const autocrlf = await run(['config', '--get', 'core.autocrlf']);
    const eol = await run(['config', '--get', 'core.eol']);
    const attributesFile = await run(['config', '--get', 'core.attributesFile']);
    const globalUser = await run(['config', '--get', '--global', 'user.name']);
    const ident = await run(['var', 'GIT_AUTHOR_IDENT']);
    const controlledOk =
      hooksPath.exitCode === 0 &&
      trimOut(hooksPath) === this.hooklessDir &&
      autocrlf.exitCode === 0 &&
      trimOut(autocrlf) === 'false' &&
      eol.exitCode === 0 &&
      trimOut(eol) === 'lf' &&
      attributesFile.exitCode === 0 &&
      trimOut(attributesFile) === this.emptyAttributesPath &&
      globalUser.exitCode !== 0 &&
      ident.exitCode === 0 &&
      ident.stdout.includes(this.identity.name) &&
      ident.stdout.includes(this.identity.email);
    record(
      'controlled-config',
      controlledOk,
      controlledOk
        ? 'controlled hooks/config/attributes/identity effective'
        : `hooksPath=${JSON.stringify(trimOut(hooksPath))} autocrlf=${JSON.stringify(trimOut(autocrlf))} eol=${JSON.stringify(trimOut(eol))} attributesFile=${JSON.stringify(trimOut(attributesFile))} globalUser=${globalUser.exitCode} ident=${ident.exitCode}`,
    );

    const findings: string[] = [];
    const unsafeLocal = await run([
      'config',
      '--local',
      '--get-regexp',
      '^(filter|alias|pager|diff|merge|credential|core)\\.',
    ]);
    if (unsafeLocal.exitCode === 0 && trimOut(unsafeLocal).length > 0) {
      for (const line of unsafeLocal.stdout.split('\n')) {
        const key = line.split(/\s+/, 1)[0];
        if (key && isUnsafeConfigKey(key)) findings.push(`config ${key}`);
      }
    }
    const replaceRefs = await run(['for-each-ref', '--format=%(refname)', 'refs/replace']);
    if (replaceRefs.exitCode === 0 && trimOut(replaceRefs).length > 0) {
      findings.push(`replace-refs ${trimOut(replaceRefs).split('\n').join(', ')}`);
    }
    if (repoRoot) {
      for (const attributesPath of [
        join(repoRoot, '.gitattributes'),
        join(repoRoot, '.git', 'info', 'attributes'),
      ]) {
        let size = 0;
        try {
          size = statSync(attributesPath).size;
        } catch {
          // Missing attribute file: nothing to isolate.
        }
        if (size > 0) findings.push(`attributes ${attributesPath}`);
      }
    }
    const isolationOk = findings.length === 0;
    record(
      'isolation-clean',
      isolationOk,
      isolationOk
        ? 'no byte-rewriting or code-execution config/attributes'
        : `unsafe: ${findings.join(', ')}`,
    );

    return { ok: checks.every((check) => check.ok), repoRoot, ref, checks };
  }

  /**
   * Run {@link preflightRepository} and fail closed with a typed error:
   * repository-state divergence throws {@link GitDivergenceError}; unsafe
   * config/attributes/filter or a capability mismatch throws
   * {@link GitIsolationError}.
   */
  async requireAuthoringPreconditions(
    options: GitRepositoryPreflightOptions,
  ): Promise<GitRepositoryPreflight> {
    const preflight = await this.preflightRepository(options);
    if (preflight.ok) return preflight;
    const failed = preflight.checks.filter((check) => !check.ok);
    if (
      failed.some(
        (check) => check.condition === 'controlled-config' || check.condition === 'isolation-clean',
      )
    ) {
      throw new GitIsolationError(preflight);
    }
    throw new GitDivergenceError(preflight);
  }
}
