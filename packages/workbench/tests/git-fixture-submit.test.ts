import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileProject, type ProjectSourceSnapshotV1, validateNovel } from '@novalistically/core';
import { buildSourceSnapshot, computeSourceDocumentHash } from '@novalistically/core/source';
import { describe, expect, it, vi } from 'vitest';
import { GitBootstrap } from '../src/host/git/bootstrap.js';
import type { GitCapability } from '../src/host/git/capability.js';
import {
  type AuthoringEntry,
  AuthoringManifest,
  classifyAuthoringPath,
} from '../src/host/git/manifest.js';
import type { SubmitJournalPort } from '../src/host/git/recovery.js';
import { ControlledGitRunner, WORKBENCH_AUTHORING_REF } from '../src/host/git/runner.js';
import {
  type CandidateValidator,
  type GitAuthoringSubmitRequest,
  GitAuthoringSubmitService,
  type WorkingStateVectorConfirmer,
} from '../src/host/git/submit-service.js';
import type { PersistenceWorkerClient } from '../src/persistence/worker-client.js';
import { createRealPersistence } from './helpers/real-persistence.js';

// ─── Version-controlled fixture ─────────────────────────────────────────────

const FIXTURE_ROOT = fileURLToPath(
  new URL('../../../fixtures/workbench-authoring', import.meta.url),
);

/** Load the fixture as sorted `AuthoringEntry` bytes (raw file bytes, no re-encode). */
function loadFixtureEntries(root: string): AuthoringEntry[] {
  const entries: AuthoringEntry[] = [];
  const walk = (dir: string): void => {
    for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (item.isDirectory()) {
        walk(join(dir, item.name));
      } else if (/\.ya?ml$/i.test(item.name)) {
        const logicalPath = relative(root, join(dir, item.name)).split(sep).join('/');
        entries.push({ path: logicalPath, bytes: readFileSync(join(dir, item.name)) });
      }
    }
  };
  walk(root);
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

const FIXTURE_ENTRIES = loadFixtureEntries(FIXTURE_ROOT);
const FIXTURE_PATHS = FIXTURE_ENTRIES.map((item) => item.path);

// ─── Git boundary harness (mirrors git-submit-service.test.ts) ─────────────

const temp = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));
const utf8 = (content: string): Uint8Array => new TextEncoder().encode(content);
const decode = (bytes: Uint8Array): string => new TextDecoder('utf-8').decode(bytes);
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

const bootstrapFor = (runner: ControlledGitRunner, projectRoot: string): GitBootstrap =>
  new GitBootstrap({
    runner,
    projectRoot,
    projectId: 'workbench-authoring',
    manifest: MANIFEST,
    entries: FIXTURE_ENTRIES,
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
/** Fixed clock so receipts, journal rows and commit timing are fully deterministic. */
const FIXED_NOW = '2026-08-02T00:00:00.000Z';

// ─── Core snapshot derivation from authoring entries ────────────────────────

/** Canonical immutable Core snapshot derived from the actual entry bytes. */
function snapshotFromEntries(entries: readonly AuthoringEntry[]): ProjectSourceSnapshotV1 {
  const documents = entries.map((item) => {
    const content = decode(item.bytes);
    return {
      version: 1 as const,
      logicalPath: item.path,
      content,
      contentHash: computeSourceDocumentHash(content),
      parseResult: { status: 'parsed' as const, value: null },
      diagnostics: [],
    };
  });
  return buildSourceSnapshot(documents);
}

const canonicalSourceHash = (entries: readonly AuthoringEntry[]): string =>
  snapshotFromEntries(entries).sourceHash;

/**
 * The test's Core candidate gate: derives the candidate snapshot from the
 * submitted entries, verifies the request sourceHash is the canonical hash of
 * those exact entries, and runs Core source loading (`compileProject`) — any
 * YAML/schema/config violation throws and rejects before Git is touched.
 */
function createCoreCandidateValidator(): CandidateValidator {
  return async (request) => {
    try {
      const snapshot = snapshotFromEntries(request.entries);
      if (snapshot.sourceHash !== request.sourceHash) {
        return {
          ok: false,
          code: 'source-hash-mismatch',
          reason: 'candidate sourceHash must be the canonical hash of the submitted entries',
        };
      }
      compileProject(snapshot);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        code: 'candidate-invalid',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Workbench Git authoring boundary — version-controlled fixture', () => {
  it('accepts the fixture as canonical Core source and Git manifest topology', () => {
    // Every fixture path is authoring topology: mandatory root files, the
    // optional ledger, recursive entity YAML, chapter metadata and events.
    for (const item of FIXTURE_ENTRIES) {
      expect(classifyAuthoringPath(item.path).ok).toBe(true);
    }
    expect(() => MANIFEST.validate(FIXTURE_ENTRIES)).not.toThrow();

    // The fixture derives one canonical snapshot whose documents are sorted
    // by logical path and whose sourceHash is pure content identity.
    const snapshot = snapshotFromEntries(FIXTURE_ENTRIES);
    expect(snapshot.documents.map((document) => document.logicalPath)).toEqual(FIXTURE_PATHS);
    expect(snapshot.sourceHash).toMatch(/^[0-9a-f]{64}$/);

    // Core source loading accepts the fixture deterministically (offline).
    const compilation = compileProject(snapshot);
    expect(compilation.data.config?.project).toBe('workbench-authoring');
    expect(compilation.events.map((event) => event.id)).toEqual(['E0']);
    expect(compilation.data.characters.map((character) => character.id).sort()).toEqual([
      'ada',
      'narrator',
    ]);
    expect(compilation.data.locations.map((location) => location.id)).toEqual(['small_town']);
  });

  it('runs deterministic offline Core validation over the fixture snapshot', async () => {
    const validation = await validateNovel(snapshotFromEntries(FIXTURE_ENTRIES));
    expect(typeof validation.passed).toBe('boolean');
    expect(validation.results.size).toBe(1);
    for (const result of validation.results.values()) {
      expect(Array.isArray(result.errors)).toBe(true);
      expect(Array.isArray(result.warnings)).toBe(true);
    }
    expect(validation.iss).toBeDefined();
  });

  it('bootstraps the fixture and submits a Core-validated delta tracking only authoring files', async () => {
    const dir = temp('wb-fixture-ok-');
    // Runtime material present in the project root before bootstrap: it must
    // survive on disk but never enter the manifest or author history.
    mkdirSync(join(dir, '.nova/cache'), { recursive: true });
    mkdirSync(join(dir, 'output'), { recursive: true });
    writeFileSync(join(dir, '.nova/cache/derived.yaml'), 'key: secret\n');
    writeFileSync(join(dir, 'output/novel.md'), '# generated prose\n');
    const harness = createRealPersistence();
    try {
      const runner = new ControlledGitRunner();
      const result = await bootstrapFor(runner, dir).bootstrap();

      // The baseline tree is exactly the fixture authoring files, sorted.
      expect(result.status).toBe('created');
      expect(result.commitCount).toBe(1);
      expect(result.entries).toEqual(FIXTURE_PATHS);
      const tracked = (await runner.runStrict({ args: ['ls-files'], cwd: dir })).stdout
        .trim()
        .split('\n')
        .sort();
      expect(tracked).toEqual(FIXTURE_PATHS);

      // Excluded runtime material stayed on disk but never entered history.
      expect(existsSync(join(dir, '.nova/cache/derived.yaml'))).toBe(true);
      expect(existsSync(join(dir, 'output/novel.md'))).toBe(true);

      // The managed ignore covers the runtime paths, so the primary worktree
      // is porcelain-clean after bootstrap.
      const ignore = readFileSync(join(dir, '.gitignore'), 'utf8');
      expect(ignore).toContain('/.nova/');
      expect(ignore).toContain('/output/');
      const status = await runner.runStrict({ args: ['status', '--porcelain=v1'], cwd: dir });
      expect(status.stdout).toBe('');

      const head = await refHead(runner, dir);

      // Candidate delta: the same fixture with one authored file revised.
      const revisedEntries = FIXTURE_ENTRIES.map((item) =>
        item.path === 'nova.yaml'
          ? entry(
              'nova.yaml',
              decode(item.bytes).replace(
                /^title:.*$/m,
                'title: "Workbench Authoring Fixture — Revised"',
              ),
            )
          : item,
      );
      const candidateHash = canonicalSourceHash(revisedEntries);

      const confirm = vi.fn<WorkingStateVectorConfirmer>(async () => ({ ok: true }));
      const validate = vi.fn<CandidateValidator>(createCoreCandidateValidator());
      const service = new GitAuthoringSubmitService({
        runner,
        projectRoot: dir,
        journal: journalPort(harness.client),
        confirmWorkingStateVector: confirm,
        validateCandidate: validate,
        now: () => FIXED_NOW,
      });

      const request: GitAuthoringSubmitRequest = {
        submitId: 'fixture-submit-1',
        projectId: 'workbench-authoring',
        expectedGitHead: head,
        expectedWorkingStateVector: VECTOR,
        manifest: new AuthoringManifest(),
        entries: revisedEntries,
        sourceHash: candidateHash,
        provenance: { actorId: 'actor-owner', capabilityId: 'cap-write' },
      };

      const outcome = await service.submit(request);
      if (outcome.kind !== 'accepted')
        throw new Error(`expected accepted outcome, got ${outcome.kind}`);
      const receipt = outcome.receipt;

      // The receipt carries the canonical hash of the actual candidate entries.
      expect(receipt.sourceHash).toBe(candidateHash);
      expect(receipt.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(receipt.acceptedAt).toBe(FIXED_NOW);
      expect(receipt.commit).not.toBe(head);

      // Exactly one submit commit on top of the baseline, and the ref moved.
      expect(await commitCount(runner, dir)).toBe(2);
      expect(await refHead(runner, dir)).toBe(receipt.commit);

      // Commit trailers carry the derived source hash.
      const message = (
        await runner.runStrict({
          args: ['log', '-1', '--format=%B', WORKBENCH_AUTHORING_REF],
          cwd: dir,
        })
      ).stdout;
      expect(message).toContain('Submit-Id: fixture-submit-1');
      expect(message).toContain(`Source-Hash: ${candidateHash}`);

      // The accepted tree is exactly the fixture authoring files — no runtime
      // material (`.nova`, output, caches, Git metadata) ever entered it.
      const treeFiles = (
        await runner.runStrict({
          args: ['ls-tree', '-r', '--name-only', WORKBENCH_AUTHORING_REF],
          cwd: dir,
        })
      ).stdout
        .trim()
        .split('\n')
        .sort();
      expect(treeFiles).toEqual(FIXTURE_PATHS);
      expect(
        treeFiles.some(
          (path) => path.includes('.nova') || path.includes('output') || path.includes('.git'),
        ),
      ).toBe(false);

      // The revised file landed in the tree and the primary worktree, which
      // stays porcelain-clean (runtime material remains ignored on disk).
      const novaInTree = (
        await runner.runStrict({ args: ['show', `${WORKBENCH_AUTHORING_REF}:nova.yaml`], cwd: dir })
      ).stdout;
      expect(novaInTree).toContain('Workbench Authoring Fixture — Revised');
      expect(readFileSync(join(dir, 'nova.yaml'), 'utf8')).toContain(
        'Workbench Authoring Fixture — Revised',
      );
      const cleanStatus = await runner.runStrict({ args: ['status', '--porcelain=v1'], cwd: dir });
      expect(cleanStatus.stdout).toBe('');

      // The journal completed exactly one receipt for this submitId.
      const stored = await harness.client.request('loadGitSubmission', {
        submitId: 'fixture-submit-1',
      });
      expect(stored).toEqual(receipt);

      // Both injected gates ran, and Core validation received the request.
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(validate).toHaveBeenCalledTimes(1);
      expect(validate.mock.calls[0][0]).toBe(request);
    } finally {
      await harness.dispose();
    }
  });

  it('rejects an intentionally invalid candidate through the real Core gate before any Git mutation', async () => {
    const dir = temp('wb-fixture-invalid-');
    const harness = createRealPersistence();
    try {
      const runner = new ControlledGitRunner();
      await bootstrapFor(runner, dir).bootstrap();
      const head = await refHead(runner, dir);

      // Intentionally invalid candidate: the event file loses its required
      // `sceneBrief` field. The bytes still pass the manifest (path + UTF-8
      // shape only), so any rejection must come from Core candidate
      // validation — not from the manifest gate.
      const invalidEntries = FIXTURE_ENTRIES.map((item) =>
        item.path === 'chapters/chapter_01/E0_arrival.yaml'
          ? entry(item.path, decode(item.bytes).replace(/^sceneBrief:.*$/m, ''))
          : item,
      );
      expect(() => MANIFEST.validate(invalidEntries)).not.toThrow();

      const service = new GitAuthoringSubmitService({
        runner,
        projectRoot: dir,
        journal: journalPort(harness.client),
        confirmWorkingStateVector: vi.fn<WorkingStateVectorConfirmer>(async () => ({ ok: true })),
        validateCandidate: createCoreCandidateValidator(),
        now: () => FIXED_NOW,
      });

      const outcome = await service.submit({
        submitId: 'fixture-submit-invalid',
        projectId: 'workbench-authoring',
        expectedGitHead: head,
        expectedWorkingStateVector: VECTOR,
        manifest: new AuthoringManifest(),
        entries: invalidEntries,
        sourceHash: canonicalSourceHash(invalidEntries),
        provenance: { actorId: 'actor-owner', capabilityId: 'cap-write' },
      });

      // Rejected by Core before any Git mutation: ref, history and worktree
      // are untouched, and no submit commit exists.
      if (outcome.kind !== 'rejected')
        throw new Error(`expected rejected outcome, got ${outcome.kind}`);
      expect(outcome.code).toBe('candidate-invalid');
      expect(outcome.reason).toContain('sceneBrief');
      expect(await refHead(runner, dir)).toBe(head);
      expect(await commitCount(runner, dir)).toBe(1);
      expect(await hasSubmitCommit(runner, dir, 'fixture-submit-invalid')).toBe(false);

      // The journal reached working-state confirmation, then Core rejected
      // before tree materialization, commit creation, or ref mutation.
      const stored = await harness.client.request('loadGitSubmission', {
        submitId: 'fixture-submit-invalid',
      });
      expect(stored).toMatchObject({ phase: 'yjs-acked' });
      expect(stored).not.toHaveProperty('candidateCommit');
    } finally {
      await harness.dispose();
    }
  });

  it('never lets excluded runtime material enter the manifest', async () => {
    const dir = temp('wb-fixture-runtime-');
    const harness = createRealPersistence();
    try {
      const runner = new ControlledGitRunner();
      await bootstrapFor(runner, dir).bootstrap();
      const head = await refHead(runner, dir);

      // A submit that tries to smuggle a runtime artifact into the candidate
      // passes the real Core gate (the mapper ignores `.nova` documents) but
      // must be stopped by the manifest before any Git mutation.
      const smuggled = [...FIXTURE_ENTRIES, entry('.nova/cache/derived.yaml', 'key: secret\n')];

      const service = new GitAuthoringSubmitService({
        runner,
        projectRoot: dir,
        journal: journalPort(harness.client),
        confirmWorkingStateVector: vi.fn<WorkingStateVectorConfirmer>(async () => ({ ok: true })),
        validateCandidate: createCoreCandidateValidator(),
        now: () => FIXED_NOW,
      });

      const outcome = await service.submit({
        submitId: 'fixture-submit-runtime',
        projectId: 'workbench-authoring',
        expectedGitHead: head,
        expectedWorkingStateVector: VECTOR,
        manifest: new AuthoringManifest(),
        entries: smuggled,
        sourceHash: canonicalSourceHash(smuggled),
        provenance: { actorId: 'actor-owner', capabilityId: 'cap-write' },
      });

      if (outcome.kind !== 'rejected')
        throw new Error(`expected rejected outcome, got ${outcome.kind}`);
      expect(outcome.code).toBe('manifest-rejected');
      expect(outcome.reason).toContain('.nova/cache/derived.yaml');

      // No Git mutation: ref, history and the runtime file on disk untouched.
      expect(await refHead(runner, dir)).toBe(head);
      expect(await commitCount(runner, dir)).toBe(1);
      expect(await hasSubmitCommit(runner, dir, 'fixture-submit-runtime')).toBe(false);

      // The journal recorded the manifest rejection.
      const stored = await harness.client.request('loadGitSubmission', {
        submitId: 'fixture-submit-runtime',
      });
      expect(stored).toMatchObject({ phase: 'manifest-rejected' });
    } finally {
      await harness.dispose();
    }
  });
});
