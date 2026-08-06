// ============================================================================
// Workbench E2E — concurrency & recovery (plan 10.3 "concurrency")
// ============================================================================
// Deterministic scenarios over the BUILT composed Host via the shared harness
// (startHostFixture + the typed MCP client). One fixture (zhu-fu) throughout.
//
//  1. Authoring is never blocked by a pending render: a working edit + submit
//     completes synchronously (authoring lane) while a full-surface render is
//     mid-execute on the operation queue.
//  2. A source moved mid-render archives the old render as `stale`: the
//     render's commit re-verifies the captured sourceHash, sees SOURCE_MOVED,
//     and never promotes; the new accepted source binds the new sourceHash
//     and nothing is rendered under it until a fresh render runs.
//  3. Cancelling a running render never promotes a late result: the row stays
//     `cancelled` past the render's natural completion window; the accepted
//     layer is unchanged; the same idempotency key replays the terminal
//     record and a fresh key re-runs and completes.
//  4. Restart recovery over the SAME home: queued/running durable rows are
//     swept to `interrupted` on boot and never auto-replayed; an explicit
//     same-key render retry re-runs the SAME durable row and completes.
//  5. Dual-Host authority: a second Host over the same project root is
//     rejected at launch (fatal frame, HOST_START_FAILED) while the first
//     holds a ready lease; after the first Host releases, the same root
//     reopens.
//  6. Publication never overwrites the last current novel for a partial
//     scene set: after a full render makes the canonical novel current, a
//     newer accepted source with only some scenes rendered publishes as
//     `stale` and the `output/novel.md` bytes stay the previous novelHash.
//
// Expressibility notes:
//  - The *long render* is real, not injected: a full-surface zhu-fu render
//    spends ~400-500ms+ in Pass 2 work, giving deterministic in-flight
//    windows for scenarios 1-3 without any provider gate.
//  - The spawned host's deterministic mock is Pass-2-aware (per-project
//    construction wired to each project's `reference/` fixtures), so renders
//    DO promote accepted scenes here: render.completed fills under the
//    rendering sourceHash and the canonical novel auto-publishes once every
//    scene is accepted. Scenario 6 therefore asserts the full no-overwrite
//    contract against a real baseline novel.
//  - The deterministic *stalled-provider* semantics (hang gate, abort-signal
//    ignoring, late-result archival against a hung execute) are covered
//    in-process by `agent-parity-matrix.test.ts` test "3)" (GatedMockProvider)
//    and `operation-service.test.ts` ("cancels queued and running
//    operations; a late result can never overwrite the cancelled row",
//    "marks queued/running rows interrupted on start and never auto-replays;
//    same key retries explicitly").
// ============================================================================

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from '@playwright/test';
import {
  DEFAULT_BOOTSTRAP_PASSWORD,
  type HostFixture,
  HostFixtureError,
  type PairedDevice,
  startHostFixture,
} from './harness/host-fixture.js';
import type { McpTestClient } from './harness/mcp.js';

test.setTimeout(120_000);

// ─── Small wire helpers (narrowed accessors; no unchecked inline casts) ─────

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(value: unknown, key: string): string | null {
  const record = recordOf(value);
  if (record === null || !(key in record)) return null;
  const field = record[key];
  return typeof field === 'string' ? field : null;
}

/** Real platform-clock delay; required because operation status transitions
 * happen on the real persistence worker thread + queue drain loop of a
 * child process, so there is no event to await and fake timers cannot
 * advance the child's event loop. */
function delay(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
    await delay(100);
  }
}

async function mcpData(
  mcp: McpTestClient,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const result = await mcp.call(name, input);
  expect(result.ok, `${name} failed: ${JSON.stringify(result)}`).toBe(true);
  return result.data;
}

/** `nova_operation_get` receipt status for one operation (authoring vocabulary). */
async function receiptStatus(mcp: McpTestClient, operationHandle: string): Promise<string | null> {
  const data = await mcpData(mcp, 'nova_operation_get', {
    version: 2,
    operationHandle,
  });
  const outer = recordOf(data);
  const receipt = outer === null ? null : recordOf(outer.receipt);
  return receipt === null ? null : stringField(receipt, 'status');
}

/** Poll `nova_operation_get` until the receipt reaches a terminal status. */
async function waitForReceipt(
  mcp: McpTestClient,
  operationHandle: string,
  terminalStatuses: readonly string[],
  timeoutMs = 60_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const data = await mcpData(mcp, 'nova_operation_get', {
      version: 2,
      operationHandle,
    });
    const outer = recordOf(data);
    const receipt = outer === null ? null : recordOf(outer.receipt);
    const status = receipt === null ? null : stringField(receipt, 'status');
    if (status !== null && terminalStatuses.includes(status)) {
      if (receipt === null) {
        throw new Error(`operation ${operationHandle} reported status without a receipt`);
      }
      return receipt;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `operation ${operationHandle} did not reach ${terminalStatuses.join('/')} (last: ${String(status)})`,
      );
    }
    await delay(25);
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** `nova_status` render.completed (event ids accepted under the current source). */
function renderCompleted(statusData: unknown): readonly string[] {
  const status = recordOf(statusData);
  const render = status === null ? null : recordOf(status.render);
  const completed = render === null ? null : render.completed;
  return Array.isArray(completed) && completed.every((entry) => typeof entry === 'string')
    ? (completed as readonly string[])
    : [];
}

/** `nova_status` publication.status ('missing' | 'current' | 'stale'). */
function publicationStatus(statusData: unknown): string | null {
  const status = recordOf(statusData);
  const publication = status === null ? null : recordOf(status.publication);
  return publication === null ? null : stringField(publication, 'status');
}

/** One paired maintainer device + connected MCP client. */
async function mcpSurface(fixture: HostFixture): Promise<{
  readonly mcp: McpTestClient;
  readonly paired: PairedDevice;
}> {
  const paired = await fixture.pairDevice();
  const mcp = await fixture.mcpClient({ credential: paired.credential });
  return { mcp, paired };
}

/** Append a comment line to the working nova.yaml and submit the revision. */
async function submitWorkingRevision(mcp: McpTestClient, marker: string): Promise<void> {
  const authoring = recordOf(await mcpData(mcp, 'nova_authoring_status', { version: 2 }));
  const state = authoring === null ? null : recordOf(authoring.state);
  const acceptedSourceHash = state === null ? null : stringField(state, 'acceptedSourceHash');
  const list = recordOf(await mcpData(mcp, 'nova_authoring_document_list', { version: 2 }));
  const documents = Array.isArray(list?.documents) ? list.documents : [];
  const nova = documents
    .map((entry) => recordOf(entry))
    .find((entry) => entry !== null && stringField(entry, 'logicalPath') === 'nova.yaml');
  expect(nova, 'nova.yaml must exist in the working document store').not.toBeNull();
  const documentId = stringField(nova, 'documentId');
  expect(documentId).toBeTruthy();
  const read = recordOf(
    await mcpData(mcp, 'nova_authoring_document_read', { version: 2, documentId }),
  );
  const content = stringField(read, 'content') ?? '';
  const stateVectorHash = stringField(read, 'stateVectorHash');
  const workspaceDigest = stringField(read, 'workspaceDigest');
  expect(stateVectorHash).toBeTruthy();
  expect(workspaceDigest).toBeTruthy();
  const edited = recordOf(
    await mcpData(mcp, 'nova_authoring_document_edit', {
      version: 2,
      documentId,
      expectedWorkspaceDigest: workspaceDigest,
      expectedAcceptedSourceHash: acceptedSourceHash,
      expectedStateVectorHash: stateVectorHash,
      replacementText: `${content}\n# e2e-${marker}\n`,
    }),
  );
  expect(stringField(edited, 'status')).toBe('applied');
  const editedDigest = stringField(edited, 'workspaceDigest');
  expect(editedDigest).toBeTruthy();
  const submit = await mcpData(mcp, 'nova_authoring_submit', {
    version: 2,
    expectedWorkspaceDigest: editedDigest,
    message: `e2e ${marker}`,
  });
  expect(stringField(submit, 'status')).toBe('completed');
}

/** Env overrides that boot a second Host over the SAME home + project root. */
function sameHomeEnv(home: string, root: string, projectId: string): Record<string, string> {
  return {
    WORKBENCH_HOME: home,
    WORKBENCH_DATABASE_PATH: join(home, 'workbench.sqlite'),
    WORKBENCH_PROJECT_ROOT: root,
    WORKBENCH_PROJECT_ID: projectId,
    WORKBENCH_DISPLAY_NAME: projectId,
  };
}

// ─── Scenario 1 + 2: authoring vs. in-flight render; moved-source staleness ─

test('a pending render never blocks authoring; a source moved mid-render archives the render as stale', async () => {
  const fixture = await startHostFixture();
  try {
    await fixture.bootstrapOwner(DEFAULT_BOOTSTRAP_PASSWORD);
    const { mcp } = await mcpSurface(fixture);
    try {
      // Baseline: the accepted layer has a source and nothing rendered.
      const before = await mcpData(mcp, 'nova_status', {});
      const sourceBefore = stringField(before, 'sourceHash');
      expect(sourceBefore).toBeTruthy();
      expect(renderCompleted(before)).toEqual([]);

      // Pre-read the working document and stage the working edit BEFORE the
      // render starts, so the later submit (the only slow authoring step)
      // can land while the render is still executing.
      const authoring = recordOf(await mcpData(mcp, 'nova_authoring_status', { version: 2 }));
      const state = authoring === null ? null : recordOf(authoring.state);
      const acceptedSourceHash = state === null ? null : stringField(state, 'acceptedSourceHash');
      const list = recordOf(await mcpData(mcp, 'nova_authoring_document_list', { version: 2 }));
      const documents = Array.isArray(list?.documents) ? list.documents : [];
      const nova = documents
        .map((entry) => recordOf(entry))
        .find((entry) => entry !== null && stringField(entry, 'logicalPath') === 'nova.yaml');
      expect(nova, 'nova.yaml must exist in the working document store').not.toBeNull();
      const documentId = stringField(nova, 'documentId');
      expect(documentId).toBeTruthy();
      const read = recordOf(
        await mcpData(mcp, 'nova_authoring_document_read', { version: 2, documentId }),
      );
      const content = stringField(read, 'content') ?? '';
      const stateVectorHash = stringField(read, 'stateVectorHash');
      const workspaceDigest = stringField(read, 'workspaceDigest');
      expect(stateVectorHash).toBeTruthy();
      expect(workspaceDigest).toBeTruthy();
      const edited = recordOf(
        await mcpData(mcp, 'nova_authoring_document_edit', {
          version: 2,
          documentId,
          expectedWorkspaceDigest: workspaceDigest,
          expectedAcceptedSourceHash: acceptedSourceHash,
          expectedStateVectorHash: stateVectorHash,
          replacementText: `${content}\n# e2e-inflight\n`,
        }),
      );
      expect(stringField(edited, 'status')).toBe('applied');
      const editedDigest = stringField(edited, 'workspaceDigest');
      expect(editedDigest).toBeTruthy();

      // A full-surface render is enqueued; the mock provider's Pass 2
      // analysis (plus compile + validation of all seven scenes) keeps it
      // executing for a few hundred ms on this harness (the "long render"
      // the plan allows when the provider has no gate).
      const enqueued = await mcpData(mcp, 'nova_render', {
        sceneSelector: { type: 'all' },
        model: 'e2e-inflight',
      });
      const renderHandle = stringField(enqueued, 'operationHandle');
      expect(renderHandle).toBeTruthy();

      // Submit the pre-staged working edit immediately. The submit is
      // synchronous in the authoring lane: it completes while the render is
      // still executing, never queued behind the provider.
      const submit = await mcpData(mcp, 'nova_authoring_submit', {
        version: 2,
        expectedWorkspaceDigest: editedDigest,
        message: 'e2e concurrency inflight',
      });
      expect(stringField(submit, 'status')).toBe('completed');

      // The accepted source moved while the render ran: the old render's
      // commit re-verifies the captured identity, sees SOURCE_MOVED and
      // archives the candidate as `stale` (never promoted). A `stale`
      // outcome can only happen if the render was in flight (prepare
      // captured the pre-submit source) when the submit moved the source, so
      // this IS the in-flight proof.
      const stale = await waitForReceipt(mcp, renderHandle as string, [
        'stale',
        'completed',
        'failed',
      ]);
      expect(stringField(stale, 'status')).toBe('stale');

      // The new accepted source binds the new sourceHash; nothing is
      // rendered under it until a fresh render runs.
      const after = await mcpData(mcp, 'nova_status', {});
      const sourceAfter = stringField(after, 'sourceHash');
      expect(sourceAfter).not.toBe(sourceBefore);
      expect(renderCompleted(after)).toEqual([]);

      // The queue recovered: a fresh render under the new source re-runs and
      // completes, and its accepted scene binds the NEW sourceHash — the
      // scenario-2 binding proof under the new source.
      const fresh = await mcpData(mcp, 'nova_render', {
        sceneSelector: { type: 'events', eventIds: ['E0'] },
        model: 'e2e-after',
      });
      const freshHandle = stringField(fresh, 'operationHandle');
      expect(freshHandle).toBeTruthy();
      const freshDone = await waitForReceipt(mcp, freshHandle as string, [
        'completed',
        'failed',
        'stale',
      ]);
      expect(stringField(freshDone, 'status')).toBe('completed');
      const bound = await mcpData(mcp, 'nova_status', {});
      expect(stringField(bound, 'sourceHash')).toBe(sourceAfter);
      expect(renderCompleted(bound)).toContain('E0');
    } finally {
      await mcp.close();
    }
  } finally {
    await fixture.close();
  }
});

// ─── Scenario 3: cancel a running render; late result never promoted ────────

test('cancelling a running render never promotes a late result; the accepted layer is unchanged', async () => {
  const fixture = await startHostFixture();
  try {
    await fixture.bootstrapOwner(DEFAULT_BOOTSTRAP_PASSWORD);
    const { mcp } = await mcpSurface(fixture);
    try {
      const before = await mcpData(mcp, 'nova_status', {});
      expect(renderCompleted(before)).toEqual([]);

      // Enqueue a full-surface render and cancel it while it is mid-flight
      // (queued → running; the durable cancel path handles both).
      const enqueued = await mcpData(mcp, 'nova_render', {
        sceneSelector: { type: 'all' },
        model: 'e2e-cancel',
      });
      const handle = stringField(enqueued, 'operationHandle');
      expect(handle).toBeTruthy();
      const cancelled = await mcpData(mcp, 'nova_operation_cancel', {
        version: 2,
        operationHandle: handle,
      });
      expect(stringField(cancelled, 'status')).toBe('cancelled');

      // The late provider result (the mock ignores the abort signal, so its
      // execute still finishes ~150-250ms after the cancel) is archived, never
      // promoted: the row must stay `cancelled` past the render's natural
      // completion window.
      const first = await waitForReceipt(mcp, handle as string, ['cancelled']);
      expect(stringField(first, 'status')).toBe('cancelled');
      const cancelledAt = stringField(first, 'updatedAt');
      for (let index = 0; index < 8; index += 1) {
        await delay(250); // platform-clock window; see delay() note
        const again = await waitForReceipt(mcp, handle as string, ['cancelled']);
        expect(stringField(again, 'status')).toBe('cancelled');
        expect(stringField(again, 'updatedAt')).toBe(cancelledAt);
      }

      // The accepted scene is unchanged: nothing was ever promoted.
      const after = await mcpData(mcp, 'nova_status', {});
      expect(renderCompleted(after)).toEqual([]);

      // Same idempotency key after a terminal cancel replays the terminal
      // record (same durable row, no re-execution).
      const replay = await mcpData(mcp, 'nova_render', {
        sceneSelector: { type: 'all' },
        model: 'e2e-cancel',
      });
      expect(stringField(replay, 'operationHandle')).toBe(handle);
      expect(await receiptStatus(mcp, handle as string)).toBe('cancelled');

      // A fresh idempotency key (different payload) re-runs and completes.
      const fresh = await mcpData(mcp, 'nova_render', {
        sceneSelector: { type: 'events', eventIds: ['E0'] },
        model: 'e2e-cancel-fresh',
      });
      const freshHandle = stringField(fresh, 'operationHandle');
      expect(freshHandle).toBeTruthy();
      const freshDone = await waitForReceipt(mcp, freshHandle as string, [
        'completed',
        'failed',
        'stale',
      ]);
      expect(stringField(freshDone, 'status')).toBe('completed');
    } finally {
      await mcp.close();
    }
  } finally {
    await fixture.close();
  }
});

// ─── Scenario 4: restart over the same home → interrupted, never replayed ───

test('a Host restart sweeps queued/running operations to interrupted and never auto-replays; a same-key retry re-runs and completes', async () => {
  // Boot once to establish the durable home (SQLite + config), then close.
  const first = await startHostFixture({ keepAlive: true });
  const home = first.home;
  const root = first.projectRoot;
  const projectId = first.projectId;
  const databasePath = join(home, 'workbench.sqlite');
  let ownerUserId: string | null = null;
  try {
    try {
      const owner = await first.bootstrapOwner(DEFAULT_BOOTSTRAP_PASSWORD);
      ownerUserId = owner.userId;
    } finally {
      await first.close();
    }

    // A mid-flight durable operation at crash time cannot be produced through
    // the public surface (the harness provider completes renders too fast to
    // leave a live row), so seed the durable store directly — the same row the
    // operation queue writes, which is the single source of truth the restart
    // sweep reads.
    const seededOperationId = '11111111-2222-4333-8444-555555555555';
    // The request hash of nova_render({sceneSelector:{type:'all'}}) with no
    // model — the identity the same-key retry must reproduce. The queue's
    // idempotency key is sha256(requestHash) (registry enqueue), while
    // result_ref stores the request hash itself.
    const requestHash = sha256Hex(JSON.stringify({ selector: { type: 'all' } }));
    const idempotencyKey = sha256Hex(requestHash);
    const now = new Date().toISOString();
    const db = new DatabaseSync(databasePath);
    try {
      db.prepare(
        `INSERT INTO project_operations (
           project_id, operation_id, idempotency_key, kind, status, actor_id,
           capability_version, source_hash, accepted_revision_id, progress,
           result_ref, error_code, version, created_at, updated_at
         ) VALUES (?, ?, ?, 'render', 'queued', 'e2e-seed', 1, NULL, NULL, NULL,
           ?, NULL, 1, ?, ?)`,
      ).run(projectId, seededOperationId, idempotencyKey, requestHash, now, now);
    } finally {
      db.close();
    }

    const restarted = await startHostFixture({
      skipConfigFile: true,
      env: sameHomeEnv(home, root, projectId),
    });
    try {
      // The owner account persisted in the SQLite home; log in instead of
      // bootstrapping a second owner.
      await restarted.login(ownerUserId as string, DEFAULT_BOOTSTRAP_PASSWORD);
      const { mcp } = await mcpSurface(restarted);
      try {
        // The boot sweep marked the seeded row interrupted.
        expect(await receiptStatus(mcp, seededOperationId)).toBe('interrupted');

        // Never auto-replayed: it stays interrupted past a generous window,
        // and nothing was rendered.
        await delay(1_500); // platform-clock window; see delay() note
        expect(await receiptStatus(mcp, seededOperationId)).toBe('interrupted');
        const status = await mcpData(mcp, 'nova_status', {});
        expect(renderCompleted(status)).toEqual([]);

        // Explicit retry with the SAME idempotency key re-runs the SAME
        // durable row (interrupted → queued) and completes.
        const retried = await mcpData(mcp, 'nova_render', {
          sceneSelector: { type: 'all' },
        });
        expect(stringField(retried, 'operationHandle')).toBe(seededOperationId);
        const done = await waitForReceipt(mcp, seededOperationId, ['completed']);
        expect(stringField(done, 'status')).toBe('completed');
      } finally {
        await mcp.close();
      }
    } finally {
      await restarted.close();
    }
  } finally {
    // keepAlive dirs from the first boot: remove them now (also on failure).
    rmSync(home, { recursive: true, force: true });
    rmSync(first.projectsRoot, { recursive: true, force: true });
  }
});

// ─── Scenario 5: dual Host over the same root → authority lease rejection ───

test('a second Host on the same project root is rejected by the authority lease; the root reopens after release', async () => {
  const first = await startHostFixture({ keepAlive: true });
  const home = first.home;
  const root = first.projectRoot;
  const projectId = first.projectId;
  const leaseFile = join(root, '.nova', 'locks', 'authority.json');
  let ownerUserId: string | null = null;
  try {
    try {
      const owner = await first.bootstrapOwner(DEFAULT_BOOTSTRAP_PASSWORD);
      ownerUserId = owner.userId;

      // The first Host holds a ready lease on the root.
      const lease = JSON.parse(readFileSync(leaseFile, 'utf8')) as Record<string, unknown>;
      expect(lease.state).toBe('ready');
      expect(lease.endpoint).toBe(first.endpoint);

      // A second Host pointed at the SAME root while the lease is live must
      // fail during launch (authority-unavailable), before any ready frame.
      let secondError: unknown = null;
      try {
        await startHostFixture({
          fixtures: ['zhu-fu'],
          skipConfigFile: true,
          env: {
            WORKBENCH_PROJECT_ROOT: root,
            WORKBENCH_PROJECT_ID: projectId,
            WORKBENCH_DISPLAY_NAME: projectId,
          },
        });
        throw new Error('the second Host unexpectedly booted');
      } catch (error) {
        secondError = error;
      }
      expect(secondError).toBeInstanceOf(HostFixtureError);
      const bootFailure = secondError as HostFixtureError;
      expect(bootFailure.code).toBe('HOST_FATAL');
      expect(bootFailure.message).toContain('fatal frame (HOST_START_FAILED)');
    } finally {
      await first.close();
    }

    // Close released the lease: the authority file is removed.
    expect(existsSync(leaseFile)).toBe(false);

    // The same root (and the same persisted home) reopens after release.
    const reopened = await startHostFixture({
      skipConfigFile: true,
      env: sameHomeEnv(home, root, projectId),
    });
    try {
      await reopened.login(ownerUserId as string, DEFAULT_BOOTSTRAP_PASSWORD);
      const { mcp } = await mcpSurface(reopened);
      try {
        const status = await mcpData(mcp, 'nova_status', {});
        expect(stringField(status, 'projectId')).toBe(projectId);
      } finally {
        await mcp.close();
      }
    } finally {
      await reopened.close();
    }
  } finally {
    // keepAlive dirs from the first boot: remove them now (also on failure).
    rmSync(home, { recursive: true, force: true });
    rmSync(first.projectsRoot, { recursive: true, force: true });
  }
});

// ─── Scenario 6: publication never overwrites the last current novel ────────

test('publication with a partial scene set stays stale and never overwrites the last current novel', async () => {
  const fixture = await startHostFixture();
  try {
    await fixture.bootstrapOwner(DEFAULT_BOOTSTRAP_PASSWORD);
    const { mcp } = await mcpSurface(fixture);
    try {
      const novelPath = join(fixture.projectRoot, 'output', 'novel.md');
      const validationBefore = await fixture
        .readProjectFile('output/validation.md')
        .catch(() => null);

      // Baseline: render every scene so the canonical novel becomes current.
      const baselineRender = await mcpData(mcp, 'nova_render', {
        sceneSelector: { type: 'all' },
        model: 'e2e-publish-baseline',
      });
      const baselineHandle = stringField(baselineRender, 'operationHandle');
      expect(baselineHandle).toBeTruthy();
      const baselineDone = await waitForReceipt(mcp, baselineHandle as string, [
        'completed',
        'failed',
        'stale',
      ]);
      expect(stringField(baselineDone, 'status')).toBe('completed');

      // The accepted-scene commit auto-refreshes the canonical publication
      // (plan 6.5): the novel file exists and its bytes match the record.
      await waitFor(async () => existsSync(novelPath), 'the canonical novel file to be written');
      const baselineBytes = readFileSync(novelPath);
      const baselineHash = sha256Hex(baselineBytes.toString('utf8'));
      const baselinePub = await mcpData(mcp, 'nova_publication_get', {
        version: 1,
        publicationId: 'canonical',
      });
      const baselineRecord = recordOf(recordOf(baselinePub)?.publication);
      const baselineValue = baselineRecord === null ? null : recordOf(baselineRecord.value);
      expect(baselineValue !== null && stringField(baselineValue, 'novelHash')).toBe(baselineHash);
      expect(stringField(baselineValue, 'status')).toBe('current');
      const statusAfterBaseline = await mcpData(mcp, 'nova_status', {});
      expect(publicationStatus(statusAfterBaseline)).toBe('current');

      // A newer accepted source with a PARTIAL scene set (only E0 rendered
      // under it): the required artifacts are incomplete, so publish must
      // stay stale and never overwrite the last current novel.
      await submitWorkingRevision(mcp, 'publish-partial');
      const partialRender = await mcpData(mcp, 'nova_render', {
        sceneSelector: { type: 'events', eventIds: ['E0'] },
        model: 'e2e-publish-partial',
      });
      const partialHandle = stringField(partialRender, 'operationHandle');
      expect(partialHandle).toBeTruthy();
      const partialDone = await waitForReceipt(mcp, partialHandle as string, [
        'completed',
        'failed',
        'stale',
      ]);
      expect(stringField(partialDone, 'status')).toBe('completed');

      const published = await mcpData(mcp, 'nova_publish', { version: 1 });
      expect(stringField(published, 'status')).toBe('queued');
      const handle = stringField(published, 'operationHandle');
      expect(handle).toBeTruthy();
      const done = await waitForReceipt(mcp, handle as string, ['stale', 'completed', 'failed']);
      expect(stringField(done, 'status')).toBe('stale');

      // The last current novel is untouched: exact bytes still hash to the
      // previous novelHash, the record keeps its artifact identity, and the
      // fixture's other output artifact is unchanged.
      const afterBytes = readFileSync(novelPath);
      expect(sha256Hex(afterBytes.toString('utf8'))).toBe(baselineHash);
      const afterPub = await mcpData(mcp, 'nova_publication_get', {
        version: 1,
        publicationId: 'canonical',
      });
      const afterRecord = recordOf(recordOf(afterPub)?.publication);
      const afterValue = afterRecord === null ? null : recordOf(afterRecord.value);
      expect(afterValue !== null && stringField(afterValue, 'novelHash')).toBe(baselineHash);
      expect(stringField(afterValue, 'status')).toBe('stale');
      const statusAfter = await mcpData(mcp, 'nova_status', {});
      expect(publicationStatus(statusAfter)).toBe('stale');
      const validationAfter = await fixture
        .readProjectFile('output/validation.md')
        .catch(() => null);
      expect(validationAfter).toBe(validationBefore);
    } finally {
      await mcp.close();
    }
  } finally {
    await fixture.close();
  }
});
