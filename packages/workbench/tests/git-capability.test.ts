import { access, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GitCapabilityError,
  probeGitCapability,
  probeSystemGit,
  requireGitCapability,
} from '../src/host/git/capability.js';
import {
  ControlledGitRunner,
  type GitCommandRunner,
  type GitRunRequest,
  type GitRunResult,
} from '../src/host/git/runner.js';
import {
  SUBMIT_PHASE_COMPLETE,
  SubmitRecovery,
  normalizeSubmitJournal,
  receiptFromRecord,
  resolveSubmitRecovery,
  type SubmitJournalPort,
  type SubmitRecoveryProbe,
} from '../src/host/git/recovery.js';
import type { GitSubmissionJournal, GitSubmissionReceipt } from '../src/contracts/persistence.js';

/** A runner that executes git without any of the controlled flags or environment. */
class UncontrolledGitRunner implements GitCommandRunner {
  readonly gitBinary = 'git';
  async run(request: GitRunRequest): Promise<GitRunResult> {
    const child = spawn('git', request.args, {
      cwd: request.cwd,
      env: { ...process.env, ...request.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return new Promise<GitRunResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('close', (exitCode) => resolve({ exitCode: exitCode ?? -1, stdout, stderr }));
    });
  }
}

/** A runner that breaks the compare-and-swap path (expected-old update-ref). */
class CasBreakingRunner implements GitCommandRunner {
  readonly gitBinary: string;
  constructor(private readonly inner: GitCommandRunner) {
    this.gitBinary = inner.gitBinary;
  }
  async run(request: GitRunRequest): Promise<GitRunResult> {
    // Probe invocations are `git -C <repo> update-ref <ref> <new> [<old>]`; the
    // expected-old CAS form carries the trailing <old> argument.
    if (request.args.includes('update-ref') && request.args.length === 6) {
      return { exitCode: 128, stdout: '', stderr: 'injected CAS failure' };
    }
    return this.inner.run(request);
  }
}

async function dirExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('probeGitCapability', () => {
  it('passes every required primitive under a controlled runner', async () => {
    const capability = await probeGitCapability({ runner: new ControlledGitRunner() });
    expect(capability.ok).toBe(true);
    expect(capability.gitVersion).toMatch(/^\d+\.\d+/);
    expect(capability.checks.every((check) => check.ok)).toBe(true);
    expect(capability.errors).toEqual([]);
    expect(capability.checks.map((check) => check.name)).toContain('hook-isolation');
    expect(capability.checks.map((check) => check.name)).toContain('config-isolation');
    expect(capability.checks.map((check) => check.name)).toContain('update-ref-cas');
    expect(() => requireGitCapability(capability)).not.toThrow();
  });

  it('fails closed when an uncontrolled runner lets hooks execute', async () => {
    const capability = await probeGitCapability({ runner: new UncontrolledGitRunner() });
    expect(capability.ok).toBe(false);
    const hookIsolation = capability.checks.find((check) => check.name === 'hook-isolation');
    expect(hookIsolation?.ok).toBe(false);
    const configIsolation = capability.checks.find((check) => check.name === 'config-isolation');
    expect(configIsolation?.ok).toBe(false);
    expect(() => requireGitCapability(capability)).toThrow(GitCapabilityError);
  });

  it('fails closed when update-ref compare-and-swap is broken', async () => {
    const capability = await probeGitCapability({
      runner: new CasBreakingRunner(new ControlledGitRunner()),
    });
    expect(capability.ok).toBe(false);
    const cas = capability.checks.find((check) => check.name === 'update-ref-cas');
    expect(cas?.ok).toBe(false);
  });

  it('fails closed when the git binary is unavailable', async () => {
    const capability = await probeGitCapability({
      runner: new ControlledGitRunner({ gitBinary: join(tmpdir(), 'no-such-git-binary') }),
    });
    expect(capability.ok).toBe(false);
    expect(capability.gitVersion).toBeNull();
    const binary = capability.checks.find((check) => check.name === 'git-binary');
    expect(binary?.ok).toBe(false);
  });

  it('cleans up its probe scratch directories', async () => {
    const created: string[] = [];
    const capability = await probeGitCapability({
      runner: new ControlledGitRunner(),
      makeTempDir: async () => {
        const dir = await mkdtemp(join(tmpdir(), 'wb-probe-clean-'));
        created.push(dir);
        return dir;
      },
    });
    expect(capability.ok).toBe(true);
    expect(created.length).toBeGreaterThan(0);
    for (const dir of created) {
      expect(await dirExists(dir)).toBe(false);
    }
  });
  it('probes the system git binary end to end', async () => {
    const capability = await probeSystemGit();
    expect(capability.ok).toBe(true);
  });
});

const EXPECTED_HEAD = 'base-head-1';
const CANDIDATE = 'candidate-commit-1';
const RECEIPT = {
  submitId: 'submit-1',
  projectId: 'proj-1',
  commit: CANDIDATE,
  sourceHash: 'source-hash-1',
  receiptHash: 'receipt-hash-1',
  acceptedAt: '2026-08-02T00:00:00.000Z',
} as const;
const journal = (overrides: Partial<GitSubmissionJournal> = {}): GitSubmissionJournal => ({
  submitId: 'submit-1',
  projectId: 'proj-1',
  phase: 'acked',
  expectedGitHead: EXPECTED_HEAD,
  updatedAt: '2026-08-02T00:00:00.000Z',
  ...overrides,
});
const probe = (overrides: Partial<SubmitRecoveryProbe> = {}): SubmitRecoveryProbe => ({
  fixedRefHead: null,
  commitWithSubmitTrailer: null,
  ...overrides,
});
/** An in-flight journal that journaled the candidate, receipt hash and source hash. */
const COMMITTED = journal({
  phase: 'committed',
  candidateCommit: CANDIDATE,
  receiptHash: RECEIPT.receiptHash,
  diagnostic: RECEIPT.sourceHash,
});

describe('submit recovery decision', () => {
  it('allows a fresh submit only when no journal record exists', () => {
    expect(resolveSubmitRecovery(null, probe())).toEqual({ kind: 'proceed' });
    expect(resolveSubmitRecovery(normalizeSubmitJournal(RECEIPT), probe())).not.toEqual({ kind: 'proceed' });
    expect(resolveSubmitRecovery(normalizeSubmitJournal(journal()), probe())).not.toEqual({ kind: 'proceed' });
  });

  it('returns the exact same accepted receipt on every retry after completion', () => {
    const first = resolveSubmitRecovery(normalizeSubmitJournal(RECEIPT), probe());
    const second = resolveSubmitRecovery(normalizeSubmitJournal(RECEIPT), probe());
    expect(first).toEqual({ kind: 'accepted', receipt: RECEIPT });
    expect(second).toEqual(first);
    expect(receiptFromRecord(normalizeSubmitJournal(RECEIPT))).toEqual(RECEIPT);
  });

  it('replays the same typed stale and conflict outcomes from the journal', () => {
    const stale = normalizeSubmitJournal(journal({ phase: 'stale' }));
    const conflict = normalizeSubmitJournal(journal({ phase: 'conflict' }));
    expect(resolveSubmitRecovery(stale, probe())).toEqual({ kind: 'stale' });
    expect(resolveSubmitRecovery(stale, probe())).toEqual({ kind: 'stale' });
    expect(resolveSubmitRecovery(conflict, probe())).toEqual({ kind: 'conflict' });
    expect(resolveSubmitRecovery(conflict, probe())).toEqual({ kind: 'conflict' });
  });

  it('accepts an in-flight submit whose candidate commit landed on the fixed ref', () => {
    const record = normalizeSubmitJournal(COMMITTED);
    expect(resolveSubmitRecovery(record, { fixedRefHead: CANDIDATE, commitWithSubmitTrailer: CANDIDATE })).toEqual({
      kind: 'accepted',
      receipt: RECEIPT,
    });
  });

  it('reports cas-pending when the commit exists but the fixed ref has not moved', () => {
    expect(resolveSubmitRecovery(normalizeSubmitJournal(COMMITTED), { fixedRefHead: EXPECTED_HEAD, commitWithSubmitTrailer: CANDIDATE })).toEqual({
      kind: 'cas-pending',
    });
  });

  it('permits a full protocol retry only when nothing was committed and the base ref is unchanged', () => {
    const acked = normalizeSubmitJournal(journal());
    expect(resolveSubmitRecovery(acked, { fixedRefHead: EXPECTED_HEAD, commitWithSubmitTrailer: null })).toEqual({ kind: 'retry' });
    // A retry is NEVER authorized once a candidate commit was recorded...
    expect(resolveSubmitRecovery(normalizeSubmitJournal(COMMITTED), { fixedRefHead: EXPECTED_HEAD, commitWithSubmitTrailer: null })).not.toEqual({ kind: 'retry' });
    // ...or once a commit with the submitId trailer exists...
    expect(resolveSubmitRecovery(acked, { fixedRefHead: EXPECTED_HEAD, commitWithSubmitTrailer: CANDIDATE })).not.toEqual({ kind: 'retry' });
    // ...or when the base ref moved.
    expect(resolveSubmitRecovery(acked, { fixedRefHead: 'other-head', commitWithSubmitTrailer: null })).toEqual({ kind: 'stale' });
  });

  it('fails closed when a different commit claims the same submitId', () => {
    expect(resolveSubmitRecovery(normalizeSubmitJournal(COMMITTED), { fixedRefHead: 'other-head', commitWithSubmitTrailer: 'other-commit' })).toEqual({
      kind: 'conflict',
    });
  });

  it('fails closed without Git state instead of risking a second commit', () => {
    expect(resolveSubmitRecovery(normalizeSubmitJournal(COMMITTED), null)).toEqual({ kind: 'in-progress' });
    expect(resolveSubmitRecovery(normalizeSubmitJournal(journal()), null)).toEqual({ kind: 'in-progress' });
  });

  it('never treats a malformed completed row as accepted', () => {
    const malformed = normalizeSubmitJournal(journal({ phase: SUBMIT_PHASE_COMPLETE }));
    expect(resolveSubmitRecovery(malformed, probe())).toEqual({ kind: 'in-progress' });
  });

  it('never authorizes a second commit or a fresh submit for any stored record', () => {
    const records: Array<GitSubmissionJournal | GitSubmissionReceipt> = [
      journal(),
      COMMITTED,
      journal({ phase: 'stale' }),
      journal({ phase: 'conflict' }),
      journal({ phase: SUBMIT_PHASE_COMPLETE }),
      RECEIPT,
    ];
    const probes: Array<SubmitRecoveryProbe | null> = [
      null,
      { fixedRefHead: EXPECTED_HEAD, commitWithSubmitTrailer: null },
      { fixedRefHead: EXPECTED_HEAD, commitWithSubmitTrailer: CANDIDATE },
      { fixedRefHead: CANDIDATE, commitWithSubmitTrailer: CANDIDATE },
      { fixedRefHead: 'other-head', commitWithSubmitTrailer: null },
      { fixedRefHead: 'other-head', commitWithSubmitTrailer: 'other-commit' },
    ];
    for (const record of records) {
      for (const current of probes) {
        const outcome = resolveSubmitRecovery(normalizeSubmitJournal(record), current);
        // A journal record exists: a fresh submit is never authorized again.
        expect(outcome.kind).not.toBe('proceed');
        // A full retry is only the path to a NEW commit, and it is only ever
        // safe when no commit evidence exists and the base ref is unchanged.
        if (outcome.kind === 'retry') {
          expect(current).not.toBeNull();
          expect(current?.commitWithSubmitTrailer).toBeNull();
          expect(current?.fixedRefHead).toBe(EXPECTED_HEAD);
          expect(record).not.toHaveProperty('candidateCommit');
        }
        // An accepted receipt must always claim the journaled/trailer commit.
        if (outcome.kind === 'accepted') {
          expect(outcome.receipt.submitId).toBe(RECEIPT.submitId);
          expect(outcome.receipt.commit).toBe(CANDIDATE);
        }
      }
    }
  });
});

function memoryJournal(
  initial: Map<string, GitSubmissionJournal | GitSubmissionReceipt> = new Map(),
): SubmitJournalPort & { calls: { load: number; checkpoint: number; complete: number } } {
  const calls = { load: 0, checkpoint: 0, complete: 0 };
  return {
    calls,
    async load(submitId) {
      calls.load += 1;
      return initial.get(submitId) ?? null;
    },
    async checkpoint(record) {
      calls.checkpoint += 1;
      initial.set(record.submitId, record);
      return record;
    },
    async complete(receipt) {
      calls.complete += 1;
      initial.set(receipt.submitId, receipt);
      return receipt;
    },
  };
}

describe('SubmitRecovery journal service', () => {
  it('returns a stored receipt without touching the journal again', async () => {
    const store = memoryJournal(new Map([[RECEIPT.submitId, RECEIPT]]));
    const recovery = new SubmitRecovery({ journal: store });
    const outcome = await recovery.recover(RECEIPT.submitId, { fixedRefHead: 'elsewhere', commitWithSubmitTrailer: null });
    expect(outcome).toEqual({ kind: 'accepted', receipt: RECEIPT });
    expect(store.calls.load).toBe(1);
    expect(store.calls.checkpoint).toBe(0);
    expect(store.calls.complete).toBe(0);
  });

  it('completes a landed in-flight submit exactly once and replays the stored receipt', async () => {
    const store = memoryJournal(new Map([[COMMITTED.submitId, COMMITTED]]));
    const recovery = new SubmitRecovery({ journal: store, now: () => '2026-08-02T00:00:00.000Z' });
    const outcome = await recovery.recover(COMMITTED.submitId, { fixedRefHead: CANDIDATE, commitWithSubmitTrailer: CANDIDATE });
    expect(outcome).toEqual({ kind: 'accepted', receipt: RECEIPT });
    expect(store.calls.complete).toBe(1);
    // A retry — even with contradictory Git state — replays the stored
    // receipt and never creates a second commit or a duplicate receipt.
    const retried = await recovery.recover(COMMITTED.submitId, { fixedRefHead: 'elsewhere', commitWithSubmitTrailer: 'other' });
    expect(retried).toEqual({ kind: 'accepted', receipt: RECEIPT });
    expect(store.calls.complete).toBe(1);
    expect(store.calls.checkpoint).toBe(0);
  });

  it('records a probe-derived conflict once and replays the same typed outcome', async () => {
    const store = memoryJournal(new Map([[COMMITTED.submitId, COMMITTED]]));
    const recovery = new SubmitRecovery({ journal: store, now: () => '2026-08-02T00:00:01.000Z' });
    const outcome = await recovery.recover(COMMITTED.submitId, { fixedRefHead: 'other-head', commitWithSubmitTrailer: 'other-commit' });
    expect(outcome).toEqual({ kind: 'conflict' });
    expect(store.calls.checkpoint).toBe(1);
    expect(store.calls.complete).toBe(0);
    const replayed = await recovery.recover(COMMITTED.submitId, probe());
    expect(replayed).toEqual({ kind: 'conflict' });
    expect(store.calls.checkpoint).toBe(1);
  });

  it('re-resolves identically after a simulated restart against the same journal data', async () => {
    const before = await new SubmitRecovery({ journal: memoryJournal(new Map([[RECEIPT.submitId, RECEIPT]])) }).recover(RECEIPT.submitId, probe());
    // A restarted Host rebuilds the recovery service over the same durable
    // journal rows; the outcome and receipt must be identical.
    const after = await new SubmitRecovery({ journal: memoryJournal(new Map([[RECEIPT.submitId, RECEIPT]])) }).recover(
      RECEIPT.submitId,
      { fixedRefHead: 'elsewhere', commitWithSubmitTrailer: null },
    );
    expect(before).toEqual({ kind: 'accepted', receipt: RECEIPT });
    expect(after).toEqual(before);
  });
});
