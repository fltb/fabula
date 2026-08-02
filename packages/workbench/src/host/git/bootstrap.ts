/**
 * Controlled Workbench Git bootstrap: the only way a project acquires its fixed
 * authoring history.
 *
 * Given an existing project root, a validated {@link AuthoringManifest} and the
 * Workbench service identity, bootstrap either initializes a brand-new
 * repository or verifies an existing one — always anchored to the fixed
 * `refs/heads/workbench` ref. The baseline tree is built ONLY from
 * manifest-approved author files through a temporary index (`GIT_INDEX_FILE`)
 * populated with `hash-object --no-filters` + `update-index --cacheinfo` +
 * `write-tree`; the primary index and worktree are never staged through.
 * Exactly one root commit is created with the fixed service identity and a
 * deterministic message via `commit-tree`, then the fixed ref is created
 * atomically with `update-ref <ref> <commit> <all-zero>` (compare-and-swap
 * create). Only afterwards is the primary worktree synced with `reset --hard`.
 * The worktree's `.gitignore` is a bootstrap-owned control file: it is created
 * with fixed managed content only when absent (never part of the baseline
 * tree, whose content is exclusively manifest-approved). A pre-existing file
 * with exactly that content is reused verbatim; any different user content is
 * a typed conflict thrown BEFORE `git init`, so bootstrap never overwrites a
 * user-owned file. The exact content is verified again on every reopen, so a
 * missing or modified file fails closed instead of silently drifting.
 *
 * Reopen is idempotent: when the repository already sits on the fixed ref and
 * is clean, bootstrap returns the existing baseline (the ref head) without
 * creating a single object. Dirty, external, divergent or invalid input is
 * rejected with a typed error BEFORE any primary-worktree mutation, and a
 * reopened history must still begin at the Workbench baseline root commit, so
 * foreign or rewritten history fails closed instead of being silently adopted.
 *
 * The typed result records only non-secret commit provenance (ref, commit,
 * tree, count, timestamp, message, paths) — never credentials or provider
 * keys. The baseline is byte-deterministic when the runner is constructed with
 * fixed `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` (per-call date overrides are
 * protected by the runner); identity, tree and message are always fixed.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { GitBaselineRecord } from '../../contracts/persistence.js';
import { requireGitCapability, type GitCapability } from './capability.js';
import { AuthoringManifest, type AuthoringEntry } from './manifest.js';
import {
  ControlledGitRunner,
  GitHostError,
  GitIsolationError,
  WORKBENCH_AUTHORING_REF,
  WORKBENCH_GIT_IDENTITY,
  type GitIdentity,
  type GitPreflightCondition,
  type GitRepositoryPreflight,
  type GitRunResult,
} from './runner.js';

/** Fixed subject of the single baseline commit; reopen verifies history roots against it. */
export const GIT_BASELINE_SUBJECT = 'chore(workbench): baseline authoring tree';

/** Default patterns for the managed `.gitignore` written on first bootstrap. */
export const DEFAULT_BOOTSTRAP_IGNORE_PATTERNS = [
  '/.nova/',
  '/output/',
  '/cache/',
  '/responses/',
  '/operations/',
  '/journals/',
  '/.yjs/',
  '/node_modules/',
  '*.sqlite',
  '*.sqlite3',
  '*.db',
  '.gitignore',
] as const;

export interface GitBootstrapOptions {
  /** The only Git authority; must be a controlled runner pinning the fixed identity. */
  readonly runner: ControlledGitRunner;
  /** Primary worktree / project root to bootstrap. */
  readonly projectRoot: string;
  /** Non-secret project identifier recorded in the baseline commit provenance. */
  readonly projectId: string;
  /** The strict manifest; its `validate` is the sole gate for staged content. */
  readonly manifest: AuthoringManifest;
  /** Author entries that make up the baseline tree. */
  readonly entries: readonly AuthoringEntry[];
  /** Verified Git capability; bootstrap fails closed without it. */
  readonly capability: GitCapability;
  /** Fixed authoring ref; defaults to `refs/heads/workbench`. */
  readonly ref?: string;
  /** Service identity that must author the baseline; defaults to the workbench identity. */
  readonly identity?: Readonly<GitIdentity>;
  /** Patterns for the managed `.gitignore`; defaults to the runtime-artifact set. */
  readonly ignorePatterns?: readonly string[];
}

/** Non-secret provenance of a created or reopened authoring baseline. */
export interface GitBootstrapResult extends GitBaselineRecord {
  /** Absolute primary worktree root that was bootstrapped. */
  readonly repoRoot: string;
}

/** Base class for all structured errors thrown by the Git bootstrap boundary. */
export class GitBootstrapError extends GitHostError {}

/** Invalid bootstrap input (root, identity, ref, manifest shape) — thrown before any git command. */
export class GitBootstrapInputError extends GitBootstrapError {
  constructor(message: string) {
    super('git-bootstrap-input-invalid', message);
  }
}

/** The repository exists but is in a wrong/divergent state (branch, HEAD, foreign or external repo), or a pre-existing user-owned `.gitignore` differs from the managed content bootstrap must not overwrite. */
export class GitBootstrapConflictError extends GitBootstrapError {
  constructor(message: string) {
    super('git-bootstrap-conflict', message);
  }
}

/** The repository on the fixed ref carries external staged, unstaged or untracked changes. */
export class GitBootstrapDirtyError extends GitBootstrapError {
  constructor(message: string) {
    super('git-bootstrap-dirty', message);
  }
}

/** The fixed ref appeared between the read-only probe and the atomic CAS-create. */
export class GitBootstrapRefConflictError extends GitBootstrapError {
  constructor(message: string) {
    super('git-bootstrap-ref-conflict', message);
  }
}

/** All-zero old OID: `git update-ref <ref> <new> <zero>` creates the ref only if it does not exist. */
const ZERO_OID = '0'.repeat(40);

type RepoProbe = {
  readonly preflight: GitRepositoryPreflight;
  readonly isBare: boolean;
  readonly unborn: boolean;
  readonly stagedClean: boolean;
  readonly unstagedClean: boolean;
  readonly ident: GitRunResult;
};

type RepoState = { readonly kind: 'not-a-repo' } | { readonly kind: 'create' } | { readonly kind: 'reopen' };

export class GitBootstrap {
  readonly #runner: ControlledGitRunner;
  readonly #root: string;
  readonly #projectId: string;
  readonly #manifest: AuthoringManifest;
  readonly #entries: readonly AuthoringEntry[];
  readonly #ref: string;
  readonly #identity: Readonly<GitIdentity>;
  readonly #ignorePatterns: readonly string[];

  constructor(options: GitBootstrapOptions) {
    const root = resolve(options.projectRoot);
    if (typeof options.projectId !== 'string' || options.projectId.length === 0) {
      throw new GitBootstrapInputError('projectId must be a non-empty string');
    }
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      throw new GitBootstrapInputError(`project root is not an existing directory: ${root}`);
    }
    const ref = options.ref ?? WORKBENCH_AUTHORING_REF;
    if (!ref.startsWith('refs/heads/') || ref.length <= 'refs/heads/'.length) {
      throw new GitBootstrapInputError(`fixed authoring ref must be a branch under refs/heads/: ${ref}`);
    }
    const identity = options.identity ?? WORKBENCH_GIT_IDENTITY;
    if (typeof identity.name !== 'string' || identity.name.length === 0 || typeof identity.email !== 'string' || identity.email.length === 0) {
      throw new GitBootstrapInputError('service identity must carry a non-empty name and email');
    }
    if (!options.entries || options.entries.length === 0) {
      throw new GitBootstrapInputError('baseline manifest must contain at least one author entry');
    }
    if (!(options.runner instanceof ControlledGitRunner)) {
      throw new GitBootstrapInputError('runner must be a ControlledGitRunner (the only Git authority)');
    }
    if (!(options.manifest instanceof AuthoringManifest)) {
      throw new GitBootstrapInputError('manifest must be an AuthoringManifest');
    }
    this.#runner = options.runner;
    this.#root = root;
    this.#projectId = options.projectId;
    this.#manifest = options.manifest;
    this.#entries = options.entries;
    this.#ref = ref;
    this.#identity = identity;
    this.#ignorePatterns = options.ignorePatterns ?? DEFAULT_BOOTSTRAP_IGNORE_PATTERNS;
    // The manifest is the sole stage source: reject invalid content before any
    // git command or filesystem mutation.
    this.#manifest.validate(this.#entries);
    // Fail closed when Git capability was not proven by a real repository probe.
    requireGitCapability(options.capability);
  }

  /** Create the baseline or reopen the existing one; never rewrites existing history. */
  async bootstrap(): Promise<GitBootstrapResult> {
    let probe = await this.#probeState();
    let state = this.#classify(probe);
    if (state.kind === 'not-a-repo') {
      // First primary-worktree mutation, only after every rejection path above.
      // An existing user `.gitignore` must be byte-identical managed content
      // (reused verbatim) or bootstrap fails with a typed conflict before
      // `git init`; user content is never overwritten.
      this.#verifyIgnoreBeforeMutation();
      await this.#init();
      probe = await this.#probeState();
      state = this.#classify(probe);
      if (state.kind === 'reopen' || state.kind === 'not-a-repo') {
        throw new GitBootstrapConflictError(`git init did not produce an authoring repository at ${this.#root}`);
      }
    }
    return state.kind === 'reopen' ? this.#reopen() : this.#create();
  }

  // --- read-only repository probe ---------------------------------------------

  async #probeState(): Promise<RepoProbe> {
    const preflight = await this.#runner.preflightRepository({ cwd: this.#root, ref: this.#ref });
    const isBare =
      (await this.#run(['rev-parse', '--is-bare-repository'])).exitCode === 0 &&
      (await this.#run(['rev-parse', '--is-bare-repository'])).stdout.trim() === 'true';
    const unborn = (await this.#run(['rev-parse', '--verify', '--quiet', 'HEAD'])).exitCode !== 0;
    const stagedClean = (await this.#run(['diff', '--cached', '--quiet'])).exitCode === 0;
    const unstagedClean = (await this.#run(['diff', '--quiet'])).exitCode === 0;
    const ident = await this.#run(['var', 'GIT_AUTHOR_IDENT']);
    return { preflight, isBare, unborn, stagedClean, unstagedClean, ident };
  }

  /** Classify the probed repository; throws a typed error for any rejected state. */
  #classify(probe: RepoProbe): RepoState {
    const { preflight } = probe;
    const check = (condition: GitPreflightCondition): boolean =>
      preflight.checks.find((entry) => entry.condition === condition)?.ok ?? false;

    if (!check('inside-work-tree')) {
      if (probe.isBare) {
        throw new GitBootstrapConflictError(`bare repository at ${this.#root} is not an authoring worktree`);
      }
      return { kind: 'not-a-repo' };
    }
    if (preflight.repoRoot && resolve(preflight.repoRoot) !== this.#root) {
      throw new GitBootstrapConflictError(
        `project root ${this.#root} is inside external repository ${preflight.repoRoot}`,
      );
    }
    if (!check('controlled-config') || !check('isolation-clean')) {
      throw new GitIsolationError(preflight);
    }
    this.#verifyIdentity(probe);
    if (!check('head-on-fixed-ref')) {
      throw new GitBootstrapConflictError(`HEAD is not on ${this.#ref} (detached or wrong branch)`);
    }
    if (!check('fixed-ref-present')) {
      if (!probe.unborn) {
        throw new GitBootstrapConflictError(`fixed ref ${this.#ref} is missing while HEAD resolves`);
      }
      if (!probe.stagedClean || !probe.unstagedClean) {
        throw new GitBootstrapDirtyError(
          `unborn ${this.#ref} repository has staged or unstaged changes; nothing may be staged outside the manifest`,
        );
      }
      return { kind: 'create' };
    }
    // Reopen preflight-exempts the bootstrap-owned `.gitignore` from the
    // untracked-file check only when its content is exactly the managed bytes;
    // verify it before the generic clean check so tampering is a typed
    // conflict, not a silent drift or an ambiguous dirty error.
    this.#verifyManagedIgnore();
    if (!check('primary-clean')) {
      throw new GitBootstrapDirtyError(
        `repository on ${this.#ref} has external changes (staged, unstaged or untracked)`,
      );
    }
    return { kind: 'reopen' };
  }

  #verifyIdentity(probe: RepoProbe): void {
    const ident = probe.ident;
    if (
      ident.exitCode !== 0 ||
      !ident.stdout.includes(this.#identity.name) ||
      !ident.stdout.includes(this.#identity.email)
    ) {
      throw new GitBootstrapInputError(
        `effective git identity does not match the Workbench service identity ${this.#identity.name} <${this.#identity.email}>; the controlled runner must pin the fixed identity`,
      );
    }
  }

  // --- create path --------------------------------------------------------------

  async #init(): Promise<void> {
    const branch = this.#ref.slice('refs/heads/'.length);
    await this.#strict(['init', '--quiet', `--initial-branch=${branch}`, '.']);
  }

  async #create(): Promise<GitBootstrapResult> {
    // Also guards pre-existing unborn repositories: an existing user
    // `.gitignore` must be exactly the managed content before any tree/ref
    // is created.
    this.#verifyIgnoreBeforeMutation();
    const scratch = mkdtempSync(join(this.#runner.scratchDir, 'workbench-bootstrap-'));
    try {
      const indexEnv = { GIT_INDEX_FILE: join(scratch, 'index') };
      for (let index = 0; index < this.#entries.length; index += 1) {
        const entry = this.#entries[index];
        const blobFile = join(scratch, `blob-${index}`);
        writeFileSync(blobFile, entry.bytes);
        const blob = (await this.#strict(['hash-object', '-w', '--no-filters', blobFile])).stdout.trim();
        const mode = entry.mode === 'executable' ? '100755' : '100644';
        await this.#strict(
          ['update-index', '--add', '--cacheinfo', `${mode},${blob},${entry.path}`],
          indexEnv,
        );
      }
      const tree = (await this.#strict(['write-tree'], indexEnv)).stdout.trim();
      const commit = (
        await this.#strict([
          'commit-tree',
          tree,
          '-m',
          GIT_BASELINE_SUBJECT,
          '-m',
          [
            `Project: ${this.#projectId}`,
            `Ref: ${this.#ref}`,
            `Entries: ${this.#entries.length}`,
            'Workbench-Baseline: true',
          ].join('\n'),
        ])
      ).stdout.trim();
      const cas = await this.#run(['update-ref', this.#ref, commit, ZERO_OID]);
      if (cas.exitCode !== 0) {
        throw new GitBootstrapRefConflictError(
          `fixed ref ${this.#ref} appeared during bootstrap (CAS-create rejected): ${cas.stderr.trim()}`,
        );
      }
      // Only now sync the primary index and worktree to the new baseline.
      await this.#strict(['reset', '--hard', commit]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    this.#writeManagedIgnore();
    return this.#readBaseline('created');
  }

  /**
   * Deterministic content of the bootstrap-owned `.gitignore`. The file is
   * never part of the baseline tree (whose content is exclusively
   * manifest-approved); it exists only for primary-worktree hygiene. The
   * self-ignore pattern is always included so the file itself can never make
   * the worktree dirty, regardless of the caller-provided patterns.
   */
  #managedIgnoreContent(): string {
    const patterns = this.#ignorePatterns.includes('.gitignore')
      ? this.#ignorePatterns
      : [...this.#ignorePatterns, '.gitignore'];
    return [
      '# Fabula Workbench managed authoring ignore (owned by Git bootstrap).',
      '# Runtime and derived artifacts never enter author history; the AuthoringManifest',
      '# is the staging authority and this file is a bootstrap control file, not author content.',
      ...patterns,
      '',
    ].join('\n');
  }

  /**
   * Create the managed ignore file only when absent. A pre-existing file was
   * verified before any repository mutation to be byte-identical managed
   * content and is reused verbatim; user content is never overwritten.
   */
  #writeManagedIgnore(): void {
    const ignoreFile = join(this.#root, '.gitignore');
    if (this.#existingIgnoreContent() !== null) {
      return;
    }
    writeFileSync(ignoreFile, this.#managedIgnoreContent());
  }

  /**
   * Pre-mutation guard for the bootstrap-owned `.gitignore`: absent is fine
   * (create writes it afterwards), byte-identical managed content is reused
   * as-is, and any different user content is a typed conflict thrown before
   * `git init` / tree/ref creation. Bootstrap never overwrites a user-owned
   * file.
   */
  #verifyIgnoreBeforeMutation(): void {
    const ignoreFile = join(this.#root, '.gitignore');
    const actual = this.#existingIgnoreContent();
    if (actual !== null && actual !== this.#managedIgnoreContent()) {
      throw new GitBootstrapConflictError(
        `existing .gitignore at ${ignoreFile} contains user content; refusing to overwrite it (expected exactly the Workbench bootstrap content)`,
      );
    }
  }

  /** Raw UTF-8 content of the root `.gitignore`, or `null` when the file is absent. */
  #existingIgnoreContent(): string | null {
    const ignoreFile = join(this.#root, '.gitignore');
    try {
      return readFileSync(ignoreFile, 'utf8');
    } catch {
      return null;
    }
  }

  /**
   * Reopen preflight-exempts the managed `.gitignore` from the untracked-file
   * check only when its bytes are exactly the bootstrap-owned content; a
   * missing or modified file is a typed conflict, never silent drift.
   */
  #verifyManagedIgnore(): void {
    const ignoreFile = join(this.#root, '.gitignore');
    const actual = this.#existingIgnoreContent();
    const expected = this.#managedIgnoreContent();
    if (actual !== expected) {
      throw new GitBootstrapConflictError(
        actual === null
          ? `managed .gitignore is missing at ${ignoreFile}; expected the Workbench bootstrap content`
          : `managed .gitignore at ${ignoreFile} was modified; expected the Workbench bootstrap content`,
      );
    }
  }

  // --- reopen path ----------------------------------------------------------------

  async #reopen(): Promise<GitBootstrapResult> {
    const roots = (await this.#strict(['rev-list', '--max-parents=0', this.#ref])).stdout
      .trim()
      .split('\n')
      .filter((line) => line.length > 0);
    if (roots.length !== 1) {
      throw new GitBootstrapConflictError(
        `history at ${this.#ref} has ${roots.length} root commits; expected exactly the single Workbench baseline`,
      );
    }
    const rootSubject = (await this.#strict(['log', '-1', '--format=%s', roots[0]])).stdout.trim();
    if (rootSubject !== GIT_BASELINE_SUBJECT) {
      throw new GitBootstrapConflictError(
        `history at ${this.#ref} does not begin with the Workbench baseline (root subject ${JSON.stringify(rootSubject)})`,
      );
    }
    return this.#readBaseline('reopened');
  }

  // --- shared readback --------------------------------------------------------------

  async #readBaseline(status: 'created' | 'reopened'): Promise<GitBootstrapResult> {
    const commit = (await this.#strict(['rev-parse', this.#ref])).stdout.trim();
    const tree = (await this.#strict(['rev-parse', `${this.#ref}^{tree}`])).stdout.trim();
    const commitCount = Number((await this.#strict(['rev-list', '--count', this.#ref])).stdout.trim());
    const committedAt = (await this.#strict(['log', '-1', '--format=%cI', this.#ref])).stdout.trim();
    const message = (await this.#strict(['log', '-1', '--format=%B', this.#ref])).stdout;
    const entries = (await this.#strict(['ls-tree', '-r', '--name-only', '-z', this.#ref]))
      .stdout.split('\0')
      .filter((path) => path.length > 0);
    return {
      status,
      projectId: this.#projectId,
      repoRoot: this.#root,
      ref: this.#ref,
      commit,
      tree,
      commitCount,
      committedAt,
      message,
      entries,
    };
  }

  // --- controlled invocation helpers -------------------------------------------------

  #run(args: readonly string[], env?: Record<string, string>): Promise<GitRunResult> {
    return this.#runner.run({ args, cwd: this.#root, ...(env === undefined ? {} : { env }) });
  }

  #strict(args: readonly string[], env?: Record<string, string>): Promise<GitRunResult> {
    return this.#runner.runStrict({ args, cwd: this.#root, ...(env === undefined ? {} : { env }) });
  }
}
