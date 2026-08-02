import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GitBootstrap } from '../src/host/git/bootstrap.js';
import type { GitCapability } from '../src/host/git/capability.js';
import {
  AuthoringSubmitInputError as BarrelAuthoringSubmitInputError,
  AuthoringSubmitPreflightError as BarrelAuthoringSubmitPreflightError,
  AuthoringSubmitRecoveryError as BarrelAuthoringSubmitRecoveryError,
  GitAuthoringSubmitError as BarrelGitAuthoringSubmitError,
  GitAuthoringSubmitService as BarrelGitAuthoringSubmitService,
} from '../src/host/git/index.js';
import { type AuthoringEntry, AuthoringManifest } from '../src/host/git/manifest.js';
import type { SubmitJournalPort } from '../src/host/git/recovery.js';
import { ControlledGitRunner, WORKBENCH_AUTHORING_REF } from '../src/host/git/runner.js';
import {
  AuthoringSubmitInputError,
  type CandidateValidator,
  GitAuthoringSubmitError,
  type GitAuthoringSubmitRequest,
  GitAuthoringSubmitService,
  type WorkingStateVectorConfirmer,
} from '../src/host/git/submit-service.js';
import type { PersistenceWorkerClient } from '../src/persistence/worker-client.js';
import { createRealPersistence } from './helpers/real-persistence.js';

const temp = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));
const utf8 = (content: string): Uint8Array => new TextEncoder().encode(content);
const entry = (path: string, content: string): AuthoringEntry => ({ path, bytes: utf8(content) });
const sha256 = (content: string): string =>
  createHash('sha256').update(content, 'utf8').digest('hex');

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

const bootstrapFor = (runner: ControlledGitRunner, projectRoot: string): GitBootstrap =>
  new GitBootstrap({
    runner,
    projectRoot,
    projectId: 'probe-project',
    manifest: MANIFEST,
    entries: baselineEntries(),
    capability: CAPABILITY,
  });

const refHead = async (runner: ControlledGitRunner, cwd: string): Promise<string> =>
  (await runner.runStrict({ args: ['rev-parse', WORKBENCH_AUTHORING_REF], cwd })).stdout.trim();

const commitCount = async (runner: ControlledGitRunner, cwd: string): Promise<number> =>
  Number(
    (
      await runner.runStrict({ args: ['rev-list', '--count', WORKBENCH_AUTHORING_REF], cwd })
    ).stdout.trim(),
  );

const hasSubmitCommit = async (
  runner: ControlledGitRunner,
  cwd: string,
  submitId: string,
): Promise<boolean> => {
  const probe = await runner.run({
    args: [
      'log',
      '--format=%H',
      '--fixed-strings',
      '--grep',
      `Submit-Id: ${submitId}`,
      WORKBENCH_AUTHORING_REF,
    ],
    cwd,
  });
  return probe.stdout.trim().length > 0;
};

/** Real persistence worker wired to the typed journal port the service requires. */
const journalPort = (client: PersistenceWorkerClient): SubmitJournalPort => ({
  load: (submitId) => client.request('loadGitSubmission', { submitId }),
  checkpoint: (record) => client.request('checkpointGitSubmission', record),
  complete: (receipt) => client.request('completeGitSubmission', receipt),
});

const VECTOR = new Uint8Array([0, 1, 2]);
let submitSequence = 0;

const submitRequest = (
  overrides: Partial<GitAuthoringSubmitRequest> = {},
): GitAuthoringSubmitRequest => {
  submitSequence += 1;
  return {
    submitId: `submit-${submitSequence}`,
    projectId: 'probe-project',
    expectedGitHead: '',
    expectedWorkingStateVector: VECTOR,
    manifest: new AuthoringManifest(),
    entries: [
      entry('nova.yaml', 'project: probe\nchapter: 2\n'),
      entry('definitions/characters/grace.yaml', 'characters:\n  grace:\n    name: Grace\n'),
    ],
    sourceHash: sha256('candidate'),
    provenance: { actorId: 'actor-owner', capabilityId: 'cap-write' },
    ...overrides,
  };
};

const alwaysOkConfirm = vi.fn<WorkingStateVectorConfirmer>(async () => ({ ok: true }));
const alwaysOkValidate = vi.fn<CandidateValidator>(async () => ({ ok: true }));

describe('GitAuthoringSubmitService', () => {
  it('submits manifest entries as one commit with non-secret trailers and syncs the primary', async () => {
    const dir = temp('wb-submit-ok-');
    const harness = createRealPersistence();
    try {
      const runner = new ControlledGitRunner();
      await bootstrapFor(runner, dir).bootstrap();
      const head = await refHead(runner, dir);

      const confirm = vi.fn<WorkingStateVectorConfirmer>(async () => ({ ok: true }));
      const validate = vi.fn<CandidateValidator>(async () => ({ ok: true }));
      const service = new GitAuthoringSubmitService({
        runner,
        projectRoot: dir,
        journal: journalPort(harness.client),
        confirmWorkingStateVector: confirm,
        validateCandidate: validate,
      });

      const request = submitRequest({ submitId: 'submit-ok-1', expectedGitHead: head });
      const outcome = await service.submit(request);
      if (outcome.kind !== 'accepted')
        throw new Error(`expected accepted outcome, got ${outcome.kind}`);

      const receipt = outcome.receipt;
      expect(receipt.submitId).toBe('submit-ok-1');
      expect(receipt.projectId).toBe('probe-project');
      expect(receipt.sourceHash).toBe(sha256('candidate'));
      expect(receipt.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(receipt.receiptHash).toMatch(/^[0-9a-f]{64}$/);
      expect(receipt.acceptedAt).toBeTruthy();
      expect(receipt.commit).not.toBe(head);

      // Exactly one submit commit on top of the baseline, and the ref moved to it.
      expect(await commitCount(runner, dir)).toBe(2);
      expect(await refHead(runner, dir)).toBe(receipt.commit);

      // The commit message carries the sanitized non-secret trailers.
      const message = (
        await runner.runStrict({
          args: ['log', '-1', '--format=%B', WORKBENCH_AUTHORING_REF],
          cwd: dir,
        })
      ).stdout;
      expect(message).toContain('Submit-Id: submit-ok-1');
      expect(message).toContain(`Source-Hash: ${sha256('candidate')}`);
      expect(message).toContain('Actor-Id: actor-owner');
      expect(message).toContain('Capability-Id: cap-write');

      // The tree preserves the baseline files and applies the manifest delta.
      const treeFiles = (
        await runner.runStrict({
          args: ['ls-tree', '-r', '--name-only', WORKBENCH_AUTHORING_REF],
          cwd: dir,
        })
      ).stdout
        .trim()
        .split('\n');
      expect(treeFiles).toEqual(
        expect.arrayContaining([
          ...baselineEntries().map((item) => item.path),
          'definitions/characters/grace.yaml',
        ]),
      );
      const novaInTree = (
        await runner.runStrict({ args: ['show', `${WORKBENCH_AUTHORING_REF}:nova.yaml`], cwd: dir })
      ).stdout;
      expect(novaInTree).toBe('project: probe\nchapter: 2\n');

      // Primary worktree synced after the CAS and left clean.
      expect(readFileSync(join(dir, 'nova.yaml'), 'utf8')).toBe('project: probe\nchapter: 2\n');
      expect(readFileSync(join(dir, 'definitions/characters/grace.yaml'), 'utf8')).toBe(
        'characters:\n  grace:\n    name: Grace\n',
      );
      const status = await runner.runStrict({ args: ['status', '--porcelain=v1'], cwd: dir });
      expect(status.stdout).toBe('');

      // The journal completed exactly one receipt for this submitId.
      const stored = await harness.client.request('loadGitSubmission', { submitId: 'submit-ok-1' });
      expect(stored).toEqual(receipt);

      // Both injected gates ran, and each received the exact request object.
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(validate).toHaveBeenCalledTimes(1);
      expect(confirm.mock.calls[0][0]).toBe(request);
      expect(validate.mock.calls[0][0]).toBe(request);
    } finally {
      await harness.dispose();
    }
  });

  it('rejects before any git mutation when the working state vector is not confirmed', async () => {
    const dir = temp('wb-submit-vector-');
    const harness = createRealPersistence();
    try {
      const runner = new ControlledGitRunner();
      await bootstrapFor(runner, dir).bootstrap();
      const head = await refHead(runner, dir);

      const confirm = vi.fn<WorkingStateVectorConfirmer>(async () => ({
        ok: false,
        reason: 'working state diverged',
      }));
      const validate = vi.fn<CandidateValidator>(async () => ({ ok: true }));
      const service = new GitAuthoringSubmitService({
        runner,
        projectRoot: dir,
        journal: journalPort(harness.client),
        confirmWorkingStateVector: confirm,
        validateCandidate: validate,
      });

      const outcome = await service.submit(
        submitRequest({ submitId: 'submit-vector-1', expectedGitHead: head }),
      );

      expect(outcome).toEqual({
        kind: 'rejected',
        code: 'working-state-vector-unconfirmed',
        reason: 'working state diverged',
      });
      // No Git mutation of any kind: ref, history and worktree are untouched.
      expect(await refHead(runner, dir)).toBe(head);
      expect(await commitCount(runner, dir)).toBe(1);
      expect(await hasSubmitCommit(runner, dir, 'submit-vector-1')).toBe(false);
      // The rejection precedes every later gate: Core validation never ran.
      expect(validate).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('rejects before any git mutation when Core candidate validation fails', async () => {
    const dir = temp('wb-submit-validate-');
    const harness = createRealPersistence();
    try {
      const runner = new ControlledGitRunner();
      await bootstrapFor(runner, dir).bootstrap();
      const head = await refHead(runner, dir);

      const validate = vi.fn<CandidateValidator>(async () => ({
        ok: false,
        code: 'schema-invalid',
        reason: 'scene missing required field',
      }));
      const service = new GitAuthoringSubmitService({
        runner,
        projectRoot: dir,
        journal: journalPort(harness.client),
        confirmWorkingStateVector: alwaysOkConfirm,
        validateCandidate: validate,
      });

      const outcome = await service.submit(
        submitRequest({ submitId: 'submit-validate-1', expectedGitHead: head }),
      );

      expect(outcome).toEqual({
        kind: 'rejected',
        code: 'candidate-invalid',
        reason: 'scene missing required field',
      });
      expect(await refHead(runner, dir)).toBe(head);
      expect(await commitCount(runner, dir)).toBe(1);
      expect(await hasSubmitCommit(runner, dir, 'submit-validate-1')).toBe(false);
    } finally {
      await harness.dispose();
    }
  });

  it('returns a typed stale outcome and never mutates when the expected head no longer matches', async () => {
    const dir = temp('wb-submit-stale-');
    const harness = createRealPersistence();
    try {
      const runner = new ControlledGitRunner();
      await bootstrapFor(runner, dir).bootstrap();
      const head = await refHead(runner, dir);

      // An external commit moves the fixed ref while the Host is not writing.
      await runner.runStrict({
        args: ['commit', '--allow-empty', '-m', 'external change'],
        cwd: dir,
      });
      const externalHead = await refHead(runner, dir);
      expect(externalHead).not.toBe(head);

      const service = new GitAuthoringSubmitService({
        runner,
        projectRoot: dir,
        journal: journalPort(harness.client),
        confirmWorkingStateVector: alwaysOkConfirm,
        validateCandidate: alwaysOkValidate,
      });
      const request = submitRequest({ submitId: 'submit-stale-1', expectedGitHead: head });

      const outcome = await service.submit(request);
      expect(outcome.kind).toBe('stale');
      if (outcome.kind !== 'stale') throw new Error('unreachable');
      expect(outcome.reason).toContain('submit-stale-1');

      // No second commit was created and the ref was not moved back.
      expect(await refHead(runner, dir)).toBe(externalHead);
      expect(await commitCount(runner, dir)).toBe(2);
      expect(await hasSubmitCommit(runner, dir, 'submit-stale-1')).toBe(false);

      // The journal recorded the terminal stale outcome, and a retry of the
      // same submitId replays it without touching Git again.
      const stored = await harness.client.request('loadGitSubmission', {
        submitId: 'submit-stale-1',
      });
      expect(stored).toMatchObject({ phase: 'stale', expectedGitHead: head });
      const retry = await service.submit(request);
      expect(retry.kind).toBe('stale');
      expect(await commitCount(runner, dir)).toBe(2);
    } finally {
      await harness.dispose();
    }
  });

  it('replays the same receipt for a duplicate submitId and never creates a second commit', async () => {
    const dir = temp('wb-submit-dup-');
    const harness = createRealPersistence();
    try {
      const runner = new ControlledGitRunner();
      await bootstrapFor(runner, dir).bootstrap();
      const head = await refHead(runner, dir);

      const confirm = vi.fn<WorkingStateVectorConfirmer>(async () => ({ ok: true }));
      const validate = vi.fn<CandidateValidator>(async () => ({ ok: true }));
      const service = new GitAuthoringSubmitService({
        runner,
        projectRoot: dir,
        journal: journalPort(harness.client),
        confirmWorkingStateVector: confirm,
        validateCandidate: validate,
      });

      const request = submitRequest({ submitId: 'submit-dup-1', expectedGitHead: head });
      const first = await service.submit(request);
      const second = await service.submit(request);
      if (first.kind !== 'accepted' || second.kind !== 'accepted') {
        throw new Error(`expected accepted outcomes, got ${first.kind} and ${second.kind}`);
      }

      // The duplicate returns the identical receipt (same commit and hash).
      expect(second.receipt).toEqual(first.receipt);
      expect(second.receipt.commit).toBe(first.receipt.commit);
      expect(second.receipt.receiptHash).toBe(first.receipt.receiptHash);
      expect(second.receipt.acceptedAt).toBe(first.receipt.acceptedAt);

      // Exactly one submit commit exists, and the injected gates ran only once:
      // the duplicate replays the stored receipt instead of re-running.
      expect(await commitCount(runner, dir)).toBe(2);
      expect(await refHead(runner, dir)).toBe(first.receipt.commit);
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(validate).toHaveBeenCalledTimes(1);

      // The journal holds exactly one receipt row for the submitId.
      const stored = await harness.client.request('loadGitSubmission', {
        submitId: 'submit-dup-1',
      });
      expect(stored).toEqual(first.receipt);
    } finally {
      await harness.dispose();
    }
  });

  it('serializes concurrent submits of the same submitId into one commit and one receipt', async () => {
    const dir = temp('wb-submit-concurrent-');
    const harness = createRealPersistence();
    try {
      const runner = new ControlledGitRunner();
      await bootstrapFor(runner, dir).bootstrap();
      const head = await refHead(runner, dir);

      // The first submit pauses inside the injected validator; the concurrent
      // second call must replay the in-flight run instead of racing it.
      let release!: () => void;
      let entered!: () => void;
      const enteredPromise = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const validate = vi.fn<CandidateValidator>(async () => {
        entered();
        await gate;
        return { ok: true };
      });
      const confirm = vi.fn<WorkingStateVectorConfirmer>(async () => ({ ok: true }));
      const service = new GitAuthoringSubmitService({
        runner,
        projectRoot: dir,
        journal: journalPort(harness.client),
        confirmWorkingStateVector: confirm,
        validateCandidate: validate,
      });

      const request = submitRequest({ submitId: 'submit-concurrent-1', expectedGitHead: head });
      const first = service.submit(request);
      await enteredPromise; // the first run is now parked inside validateCandidate

      // The second call resolves synchronously to the in-flight run: it never
      // re-enters the gates or the journal protocol.
      const second = service.submit(request);
      expect(validate).toHaveBeenCalledTimes(1);
      expect(confirm).toHaveBeenCalledTimes(1);

      release();
      const [firstOutcome, secondOutcome] = await Promise.all([first, second]);
      if (firstOutcome.kind !== 'accepted' || secondOutcome.kind !== 'accepted') {
        throw new Error(
          `expected accepted outcomes, got ${firstOutcome.kind} and ${secondOutcome.kind}`,
        );
      }
      expect(secondOutcome.receipt).toEqual(firstOutcome.receipt);

      // Exactly one submit commit landed; no second commit object was ever
      // created before the ref CAS.
      expect(await commitCount(runner, dir)).toBe(2);
      expect(await refHead(runner, dir)).toBe(firstOutcome.receipt.commit);
      const fsck = await runner.run({
        args: ['fsck', '--no-reflogs', '--unreachable', '--no-progress'],
        cwd: dir,
      });
      expect(fsck.exitCode).toBe(0);
      expect(`${fsck.stdout}\n${fsck.stderr}`).not.toContain('unreachable commit');

      const stored = await harness.client.request('loadGitSubmission', {
        submitId: 'submit-concurrent-1',
      });
      expect(stored).toEqual(firstOutcome.receipt);
    } finally {
      await harness.dispose();
    }
  });

  it('rejects manifest runtime paths before any git mutation and journals the rejection', async () => {
    const dir = temp('wb-submit-runtime-');
    const harness = createRealPersistence();
    try {
      const runner = new ControlledGitRunner();
      await bootstrapFor(runner, dir).bootstrap();
      const head = await refHead(runner, dir);

      const service = new GitAuthoringSubmitService({
        runner,
        projectRoot: dir,
        journal: journalPort(harness.client),
        confirmWorkingStateVector: alwaysOkConfirm,
        validateCandidate: alwaysOkValidate,
      });
      const request = submitRequest({
        submitId: 'submit-runtime-1',
        expectedGitHead: head,
        entries: [entry('.nova/cache/secret.yaml', 'key: value\n')],
      });

      const outcome = await service.submit(request);
      if (outcome.kind !== 'rejected')
        throw new Error(`expected rejected outcome, got ${outcome.kind}`);
      expect(outcome.code).toBe('manifest-rejected');
      expect(outcome.reason).toContain('.nova/cache/secret.yaml');

      // No Git mutation: ref, history and the runtime file on disk are untouched.
      expect(await refHead(runner, dir)).toBe(head);
      expect(await commitCount(runner, dir)).toBe(1);
      expect(await hasSubmitCommit(runner, dir, 'submit-runtime-1')).toBe(false);

      // The journal recorded the manifest rejection; a retry of the same
      // submitId reproduces the same typed rejection without a commit.
      const stored = await harness.client.request('loadGitSubmission', {
        submitId: 'submit-runtime-1',
      });
      expect(stored).toMatchObject({ phase: 'manifest-rejected' });
      const retry = await service.submit(request);
      expect(retry).toMatchObject({ kind: 'rejected', code: 'manifest-rejected' });
      expect(await commitCount(runner, dir)).toBe(1);
    } finally {
      await harness.dispose();
    }
  });

  it('reconciles an exact handwritten full candidate including a tracked-file deletion', async () => {
    const dir = temp('wb-submit-external-delete-');
    const harness = createRealPersistence();
    try {
      const runner = new ControlledGitRunner();
      await bootstrapFor(runner, dir).bootstrap();
      const head = await refHead(runner, dir);
      const candidate = baselineEntries()
        .filter((item) => item.path !== 'definitions/characters/ada.yaml')
        .map((item) =>
          item.path === 'nova.yaml' ? entry(item.path, 'project: probe\nchapter: 3\n') : item,
        );
      writeFileSync(join(dir, 'nova.yaml'), 'project: probe\nchapter: 3\n');
      rmSync(join(dir, 'definitions/characters/ada.yaml'));

      const service = new GitAuthoringSubmitService({
        runner,
        projectRoot: dir,
        journal: journalPort(harness.client),
        confirmWorkingStateVector: alwaysOkConfirm,
        validateCandidate: alwaysOkValidate,
      });
      const outcome = await service.submit(
        submitRequest({
          submitId: 'submit-external-delete-1',
          expectedGitHead: head,
          entries: candidate,
          externalReconciliation: true,
        }),
      );

      if (outcome.kind !== 'accepted')
        throw new Error(`expected accepted outcome, got ${outcome.kind}`);
      expect(await refHead(runner, dir)).toBe(outcome.receipt.commit);
      expect(readFileSync(join(dir, 'nova.yaml'), 'utf8')).toBe('project: probe\nchapter: 3\n');
      expect(existsSync(join(dir, 'definitions/characters/ada.yaml'))).toBe(false);
      const tree = (
        await runner.runStrict({
          args: ['ls-tree', '-r', '--name-only', WORKBENCH_AUTHORING_REF],
          cwd: dir,
        })
      ).stdout.split('\n');
      expect(tree).not.toContain('definitions/characters/ada.yaml');
      expect(
        (await runner.runStrict({ args: ['status', '--porcelain=v1'], cwd: dir })).stdout,
      ).toBe('');
    } finally {
      await harness.dispose();
    }
  });

  it('preserves a handwritten candidate when an unknown path is present', async () => {
    const dir = temp('wb-submit-external-unknown-');
    const harness = createRealPersistence();
    try {
      const runner = new ControlledGitRunner();
      await bootstrapFor(runner, dir).bootstrap();
      const head = await refHead(runner, dir);
      const candidate = baselineEntries().map((item) =>
        item.path === 'nova.yaml' ? entry(item.path, 'project: probe\nchapter: 4\n') : item,
      );
      writeFileSync(join(dir, 'nova.yaml'), 'project: probe\nchapter: 4\n');
      writeFileSync(join(dir, 'notes.txt'), 'must remain local\n');

      const service = new GitAuthoringSubmitService({
        runner,
        projectRoot: dir,
        journal: journalPort(harness.client),
        confirmWorkingStateVector: alwaysOkConfirm,
        validateCandidate: alwaysOkValidate,
      });
      const outcome = await service.submit(
        submitRequest({
          submitId: 'submit-external-unknown-1',
          expectedGitHead: head,
          entries: candidate,
          externalReconciliation: true,
        }),
      );

      expect(outcome.kind).toBe('conflict');
      expect(await refHead(runner, dir)).toBe(head);
      expect(readFileSync(join(dir, 'nova.yaml'), 'utf8')).toBe('project: probe\nchapter: 4\n');
      expect(readFileSync(join(dir, 'notes.txt'), 'utf8')).toBe('must remain local\n');
      expect(await hasSubmitCommit(runner, dir, 'submit-external-unknown-1')).toBe(false);
    } finally {
      await harness.dispose();
    }
  });

  it('rejects construction when either required callback is absent', async () => {
    const dir = temp('wb-submit-ctor-');
    const harness = createRealPersistence();
    try {
      const runner = new ControlledGitRunner();
      const base = { runner, projectRoot: dir, journal: journalPort(harness.client) };
      const okConfirm: WorkingStateVectorConfirmer = async () => ({ ok: true });
      const okValidate: CandidateValidator = async () => ({ ok: true });

      expect(
        () =>
          new GitAuthoringSubmitService({
            ...base,
            confirmWorkingStateVector: undefined as never,
            validateCandidate: okValidate,
          }),
      ).toThrow(AuthoringSubmitInputError);

      expect(
        () =>
          new GitAuthoringSubmitService({
            ...base,
            confirmWorkingStateVector: okConfirm,
            validateCandidate: undefined as never,
          }),
      ).toThrow(AuthoringSubmitInputError);

      // No repository was ever touched by construction alone.
      expect(existsSync(join(dir, '.git'))).toBe(false);
    } finally {
      await harness.dispose();
    }
  });

  it('exposes the submit service and its error types from the host git barrel', () => {
    expect(BarrelGitAuthoringSubmitService).toBe(GitAuthoringSubmitService);
    expect(BarrelGitAuthoringSubmitError).toBe(GitAuthoringSubmitError);
    expect(BarrelAuthoringSubmitInputError).toBe(AuthoringSubmitInputError);
    expect(BarrelAuthoringSubmitPreflightError).not.toBe(AuthoringSubmitInputError);
    expect(BarrelAuthoringSubmitRecoveryError).not.toBe(AuthoringSubmitInputError);
  });
});
