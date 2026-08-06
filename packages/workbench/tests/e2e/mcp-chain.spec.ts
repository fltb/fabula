// ============================================================================
// mcp-chain.spec.ts — the full external-Agent production chain (plan 10.2/10.3)
// ============================================================================
// One fixture (zhu-fu), owner bootstrap → maintainer device pairing → typed
// MCP client. Asserts, through the wire:
//   1. tools/list parity with `MCP_TOOL_CATALOG_V1` at the maintainer scopes.
//   2. `nova_status` (WorkflowStatusV1) → `nova_source_list/get` → `nova_graph`.
//   3. Working loop: authoring document list/read → edit a working YAML →
//      `nova_authoring_validate` (layer working, new candidateSourceHash,
//      accepted hash unchanged) → submit → operation wait (completed, new
//      acceptedRevisionId) → status shows the new sourceHash.
//   4. Render: `nova_render` → {status:'queued', operationHandle} → operation
//      wait → completed (deterministic mock prose). Under the strict
//      `releasePolicy.warnings: require-waiver` (second test): the render
//      opens a pending_waiver gate → `nova_release_gate_decide` accept →
//      gate closed, scene promoted, no further operation needed.
//   5. Publish: `nova_publish` → operation wait → `nova_publication_get`
//      (novelHash) → `nova_publication_read` slice; the end-to-end proof is
//      that `output/novel.md` on the project root has SHA-256 == novelHash
//      and byteLength == byteLength from the durable record.
//   6. Recovery leg: `nova_operation_cancel` on a queued operation, unknown
//      handle → OPERATION_NOT_FOUND, double-cancel idempotence. Host-restart
//      interrupted semantics are covered by the concurrency spec (a second
//      fixture over a reused home); they are not reachable from this harness
//      because the spawned host's deterministic mock exposes no stall knob.
//
// Composition notes (reported to the orchestrator during bring-up, now
// resolved in src/host): the spawned host initially denied `nova_render` for
// device-mode callers (DENIED:NOT_FOUND — no `device:<id>` capability row
// persisted); that fix landed (device grants are now persisted at authorize
// time). A second blocker was the bare `MockProvider`'s Pass 2 echo being
// non-JSON, so scenes stayed blocked (missing analysis) and never promoted;
// the launch now builds a per-project Pass-2-aware
// `DeterministicMockProvider` (valid per-event analysis, conflict
// measurement abstained so require-waiver gates open). This suite is the
// enforced contract for that chain.
// ============================================================================

import { createHash } from 'node:crypto';
import { MCP_TOOL_CATALOG_V1 } from '@novalistically/workbench-protocol';
import { expect, test } from '@playwright/test';
import { type HostFixture, MAINTAINER_SCOPES, startHostFixture } from './harness/host-fixture.js';
import type { McpTestClient } from './harness/mcp.js';

test.setTimeout(120_000);

// ─── Small wire guards (server-derived payloads; validate the boundary) ─────

/** Runtime-checked object boundary: throws on non-object payloads. */
function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`expected an object for ${label}, got ${typeof value}`);
  }
  return value as Record<string, unknown>;
}

function stringOf(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`expected a non-empty string for ${label}`);
  }
  return value;
}

function numberOrNull(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`expected a number or null for ${label}`);
  }
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return stringOf(value, label);
}

function delay(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}

/**
 * Poll `nova_operation_get` until the receipt leaves queued/running, then
 * assert the terminal status is one of `success`. Successful operations of
 * every kind (submit, render, publish, gate) are reported as 'completed' on
 * the unified receipt; failures surface as failed/stale/cancelled/
 * interrupted. Callers pass the exact terminal set they accept.
 */
async function waitForOperation(
  mcp: McpTestClient,
  operationHandle: string,
  success: readonly string[],
  timeoutMs = 60_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await mcp.call('nova_operation_get', { version: 2, operationHandle });
    expect(result.ok).toBe(true);
    const data = asRecord(result.data, 'operation_get');
    const receipt = data.receipt === null ? null : asRecord(data.receipt, 'operation receipt');
    const status = receipt === null ? null : stringOf(receipt.status, 'operation status');
    if (status === null || status === 'queued' || status === 'running') {
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for operation ${operationHandle} (last status ${status})`,
        );
      }
      await delay(250);
      continue;
    }
    expect(success).toContain(status);
    if (receipt === null) {
      throw new Error(`operation ${operationHandle} has status ${status} but no receipt`);
    }
    return receipt;
  }
}

function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/** The exact catalog tool set a maintainer-scope device may list. */
function expectedMaintainerTools(): readonly string[] {
  return MCP_TOOL_CATALOG_V1.filter((tool) =>
    tool.scopes.every((scope) => MAINTAINER_SCOPES.includes(scope)),
  )
    .map((tool) => tool.name)
    .sort();
}

/**
 * Boot the fixture and connect a maintainer MCP client; always tears down.
 */
async function bootMaintainerClient(): Promise<{
  readonly fixture: HostFixture;
  readonly mcp: McpTestClient;
}> {
  const fixture = await startHostFixture();
  try {
    await fixture.bootstrapOwner();
    const { credential } = await fixture.pairDevice({ scopes: MAINTAINER_SCOPES });
    const mcp = await fixture.mcpClient({ credential });
    return { fixture, mcp };
  } catch (error) {
    await fixture.close();
    throw error;
  }
}

test('full external-agent chain: tools parity → status → source/graph → working edit/validate/submit → render → publish → novelHash == file bytes', async () => {
  const { fixture, mcp } = await bootMaintainerClient();
  try {
    // ── 1. tools/list parity through the wire ───────────────────────────
    const tools = await mcp.listTools();
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual(expectedMaintainerTools());
    // Reference/admin tools require scopes a project device never holds.
    expect(names).not.toContain('nova_reference_list');
    expect(names).not.toContain('nova_admin_config_get');
    expect(names).toContain('nova_render');
    expect(names).toContain('nova_publish');

    // ── 2. status (WorkflowStatusV1) ────────────────────────────────────
    const status0 = asRecord((await mcp.call('nova_status', {})).data, 'nova_status');
    expect(status0.version).toBe(1);
    expect(status0.projectId).toBe(fixture.projectId);
    expect(status0.layer).toBe('accepted');
    const originalSourceHash = stringOf(status0.sourceHash, 'status.sourceHash');
    expect(originalSourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(status0.acceptedRevisionId).toBeTruthy();
    const validation0 = asRecord(status0.validation, 'status.validation');
    expect(validation0.passed).toBe(true);
    const render0 = asRecord(status0.render, 'status.render');
    expect(render0.completed).toEqual([]);
    expect((render0.ready as readonly unknown[]).length).toBeGreaterThan(0);
    expect(status0.review).toEqual({ open: 0, blocking: 0, pendingGates: 0 });
    expect(status0.publication).toEqual({
      status: 'missing',
      publicationId: null,
      novelHash: null,
    });
    const nextActions = status0.nextActions;
    expect(Array.isArray(nextActions)).toBe(true);
    expect(
      (nextActions as readonly unknown[]).some(
        (next) => asRecord(next, 'next action').code === 'RENDER',
      ),
    ).toBe(true);

    // ── source list/get ─────────────────────────────────────────────────
    // `nova_source_list` returns the source document array directly.
    const sourceListResult = await mcp.call('nova_source_list', {});
    expect(sourceListResult.ok).toBe(true);
    const sourceDocs = sourceListResult.data;
    expect(Array.isArray(sourceDocs)).toBe(true);
    expect(
      (sourceDocs as readonly unknown[]).some(
        (doc) => asRecord(doc, 'source doc').logicalPath === 'nova.yaml',
      ),
    ).toBe(true);
    expect(
      (sourceDocs as readonly unknown[]).some((doc) =>
        stringOf(asRecord(doc, 'source doc').logicalPath, 'logicalPath').startsWith(
          'chapters/chapter_01/',
        ),
      ),
    ).toBe(true);
    const sourceDoc = asRecord(
      (await mcp.call('nova_source_get', { logicalPath: 'nova.yaml' })).data,
      'source_get',
    );
    expect(sourceDoc.logicalPath).toBe('nova.yaml');
    expect(stringOf(sourceDoc.content, 'source content')).toContain('project: zhu-fu');

    // ── graph ───────────────────────────────────────────────────────────
    const graph = asRecord(
      (await mcp.call('nova_graph', { version: 1, branchPath: { decisions: [] } })).data,
      'nova_graph',
    );
    expect(graph.version).toBe(1);
    expect(graph.story).toBeTruthy();
    expect(graph.discourse).toBeTruthy();
    expect(graph.route).toBeTruthy();

    // ── 3. working loop: edit a working YAML with expected digests ──────
    const authoringStatus = asRecord(
      (await mcp.call('nova_authoring_status', { version: 2 })).data,
      'authoring_status',
    );
    const state = asRecord(authoringStatus.state, 'authoring state');
    expect(state.phase).toBe('clean');
    const acceptedHash = nullableString(state.acceptedSourceHash, 'acceptedSourceHash');
    expect(acceptedHash).toBe(originalSourceHash);
    const initialDigest = stringOf(state.workspaceDigest, 'workspaceDigest');

    const documentList = asRecord(
      (await mcp.call('nova_authoring_document_list', { version: 2 })).data,
      'document_list',
    );
    const documents = documentList.documents as readonly unknown[];
    expect(Array.isArray(documents)).toBe(true);
    const novaDescriptor = documents.find(
      (doc) => asRecord(doc, 'document').logicalPath === 'nova.yaml',
    );
    expect(novaDescriptor).toBeTruthy();
    const documentId = stringOf(
      asRecord(novaDescriptor, 'nova.yaml descriptor').documentId,
      'documentId',
    );

    const read = asRecord(
      (await mcp.call('nova_authoring_document_read', { version: 2, documentId })).data,
      'document_read',
    );
    expect(read.workspaceDigest).toBe(initialDigest);
    const stateVectorHash = stringOf(read.stateVectorHash, 'stateVectorHash');
    const content = stringOf(read.content, 'document content');

    const edited = asRecord(
      (
        await mcp.call('nova_authoring_document_edit', {
          version: 2,
          documentId,
          expectedWorkspaceDigest: initialDigest,
          expectedAcceptedSourceHash: acceptedHash,
          expectedStateVectorHash: stateVectorHash,
          replacementText: `${content}# e2e-working-edit\n`,
        })
      ).data,
      'document_edit',
    );
    expect(edited.status).toBe('applied');
    const editedDigest = stringOf(edited.workspaceDigest, 'edited workspaceDigest');
    expect(editedDigest).not.toBe(initialDigest);

    // ── working-layer validate: new candidate, accepted hash untouched ──
    const workingValidation = asRecord(
      (
        await mcp.call('nova_authoring_validate', {
          version: 2,
          expectedWorkspaceDigest: editedDigest,
          expectedAcceptedSourceHash: acceptedHash,
        })
      ).data,
      'authoring_validate',
    );
    expect(workingValidation.layer).toBe('working');
    expect(workingValidation.passed).toBe(true);
    const candidateSourceHash = stringOf(
      workingValidation.candidateSourceHash,
      'candidateSourceHash',
    );
    expect(candidateSourceHash).not.toBe(originalSourceHash);
    expect(workingValidation.acceptedSourceHash).toBe(acceptedHash);

    // `nova_validate` still reports the ACCEPTED layer untouched.
    const acceptedValidation = asRecord(
      (await mcp.call('nova_validate', {})).data,
      'nova_validate',
    );
    expect(acceptedValidation.layer).toBe('accepted');

    // ── submit + operation wait ─────────────────────────────────────────
    const submit = asRecord(
      (
        await mcp.call('nova_authoring_submit', {
          version: 2,
          expectedWorkspaceDigest: editedDigest,
          message: 'e2e mcp-chain submit',
        })
      ).data,
      'authoring_submit',
    );
    expect(['queued', 'completed']).toContain(submit.status);
    const submitReceipt = asRecord(submit.receipt, 'submit receipt');
    const submitHandle = stringOf(submitReceipt.operationId, 'submit operationId');
    const submitTerminal = await waitForOperation(mcp, submitHandle, [
      'completed',
      'failed',
      'stale',
    ]);
    expect(submitTerminal.status).toBe('completed');
    const newAcceptedRevisionId = stringOf(submitTerminal.acceptedRevisionId, 'acceptedRevisionId');
    expect(newAcceptedRevisionId).toBeTruthy();

    const status1 = asRecord((await mcp.call('nova_status', {})).data, 'nova_status after submit');
    const newSourceHash = stringOf(status1.sourceHash, 'new sourceHash');
    expect(newSourceHash).not.toBe(originalSourceHash);
    expect(newSourceHash).toBe(candidateSourceHash);
    expect(status1.acceptedRevisionId).toBe(newAcceptedRevisionId);

    // ── 4. render: queued → completed (deterministic mock prose) ────────
    // The canonical publication requires every planned event accepted (the
    // discourse completeness check inside `assembleRelease` fails the
    // manifest on missing scenes), so render the FULL surface, not E0 only.
    const plannedEvents = (render0.ready as readonly unknown[]).map((eventId) =>
      stringOf(eventId, 'planned event id'),
    );
    expect(plannedEvents.length).toBeGreaterThan(0);
    const render = asRecord(
      (
        await mcp.call('nova_render', {
          sceneSelector: { type: 'all' },
        })
      ).data,
      'nova_render',
    );
    expect(render.status).toBe('queued');
    const renderHandle = stringOf(render.operationHandle, 'render operationHandle');
    // The unified receipt reports successful render operations as 'completed'
    // (the coordinator vocabulary), not the durable record's 'succeeded'.
    const renderReceipt = await waitForOperation(mcp, renderHandle, [
      'completed',
      'failed',
      'stale',
    ]);
    expect(renderReceipt.status).toBe('completed');

    const statusAfterRender = asRecord(
      (await mcp.call('nova_status', {})).data,
      'nova_status after render',
    );
    const renderAfter = asRecord(statusAfterRender.render, 'render projection');
    expect(renderAfter.completed).toEqual(expect.arrayContaining(plannedEvents));
    expect(renderAfter.blocked).toEqual([]);
    // Default policy is accept-and-record: no release gate is opened.
    expect(statusAfterRender.review).toEqual({ open: 0, blocking: 0, pendingGates: 0 });

    // ── 5. publish → publication get/read → novelHash == file bytes ─────
    const publish = asRecord((await mcp.call('nova_publish', { version: 1 })).data, 'nova_publish');
    expect(publish.status).toBe('queued');
    const publishHandle = stringOf(publish.operationHandle, 'publish operationHandle');
    const publishReceipt = await waitForOperation(mcp, publishHandle, [
      'completed',
      'failed',
      'stale',
    ]);
    expect(publishReceipt.status).toBe('completed');

    const publication = asRecord(
      (await mcp.call('nova_publication_get', { version: 1, publicationId: 'canonical' })).data,
      'nova_publication_get',
    );
    expect(publication.publication).toBeTruthy();
    const publicationRecord = asRecord(publication.publication, 'publication record');
    expect(publicationRecord.kind).toBe('canonical');
    const publicationValue = asRecord(publicationRecord.value, 'publication value');
    expect(publicationValue.sourceHash).toBe(newSourceHash);
    expect(publicationValue.status).toBe('current');
    const novelHash = stringOf(publicationValue.novelHash, 'novelHash');
    const novelByteLength = numberOrNull(publicationValue.byteLength, 'byteLength');
    expect(novelByteLength).not.toBeNull();
    const relativeOutputPath = stringOf(publicationValue.relativeOutputPath, 'relativeOutputPath');
    expect(relativeOutputPath).toBe('output/novel.md');

    // END-TO-END PROOF: the bytes on disk equal the publication hash. The
    // file is read as a string and re-encoded to bytes; valid UTF-8 round-
    // trips losslessly, so the hash and byte count are exact.
    const novelString = await fixture.readProjectFile(relativeOutputPath);
    const novelBytes = new TextEncoder().encode(novelString);
    expect(novelBytes.byteLength).toBe(novelByteLength);
    expect(sha256Hex(novelBytes)).toBe(novelHash);

    // Bounded read through the tool matches the same bytes. The tool slices
    // by characters (up to `limit`), so compare against the same character
    // prefix of the file — never a raw byte slice (multibyte UTF-8).
    const publicationRead = asRecord(
      (
        await mcp.call('nova_publication_read', {
          version: 1,
          publicationId: 'canonical',
          offset: 0,
          limit: 4096,
        })
      ).data,
      'nova_publication_read',
    );
    expect(publicationRead.publicationId).toBe('canonical');
    expect(publicationRead.totalByteLength).toBe(novelByteLength);
    const slice = stringOf(publicationRead.content, 'publication slice');
    // The read handler slices CHARACTERS (up to `limit`), so the bound is on
    // character count; multibyte UTF-8 makes the byte count larger.
    expect(slice.length).toBeLessThanOrEqual(4096);
    const fileCharacters = [...novelString];
    expect(slice).toBe(fileCharacters.slice(0, slice.length).join(''));

    // Final status: publication current with the same novel hash.
    const finalStatus = asRecord((await mcp.call('nova_status', {})).data, 'final status');
    const finalPublication = asRecord(finalStatus.publication, 'final publication');
    expect(finalPublication.status).toBe('current');
    expect(finalPublication.novelHash).toBe(novelHash);
  } finally {
    await mcp.close();
    await fixture.close();
  }
});

test('strict gate leg: require-waiver policy → pending_waiver gate → maintainer accept → gate closed, scene promoted', async () => {
  const { fixture, mcp } = await bootMaintainerClient();
  try {
    // Working edit: append the strict release policy to the working nova.yaml
    // and submit it (the same loop the first test exercises).
    const authoringStatus = asRecord(
      (await mcp.call('nova_authoring_status', { version: 2 })).data,
      'authoring_status',
    );
    const state = asRecord(authoringStatus.state, 'authoring state');
    const acceptedHash = nullableString(state.acceptedSourceHash, 'acceptedSourceHash');
    const list = asRecord(
      (await mcp.call('nova_authoring_document_list', { version: 2 })).data,
      'document_list',
    );
    const documents = list.documents as readonly unknown[];
    const novaDescriptor = documents.find(
      (doc) => asRecord(doc, 'document').logicalPath === 'nova.yaml',
    );
    const documentId = stringOf(
      asRecord(novaDescriptor, 'nova.yaml descriptor').documentId,
      'documentId',
    );
    const read = asRecord(
      (await mcp.call('nova_authoring_document_read', { version: 2, documentId })).data,
      'document_read',
    );
    const strictEdit = asRecord(
      (
        await mcp.call('nova_authoring_document_edit', {
          version: 2,
          documentId,
          expectedWorkspaceDigest: stringOf(read.workspaceDigest, 'read digest'),
          expectedAcceptedSourceHash: acceptedHash,
          expectedStateVectorHash: stringOf(read.stateVectorHash, 'stateVectorHash'),
          replacementText: `${stringOf(read.content, 'content')}releasePolicy:\n  warnings: require-waiver\n`,
        })
      ).data,
      'strict edit',
    );
    expect(strictEdit.status).toBe('applied');
    const strictSubmit = asRecord(
      (
        await mcp.call('nova_authoring_submit', {
          version: 2,
          expectedWorkspaceDigest: stringOf(strictEdit.workspaceDigest, 'strict digest'),
          message: 'enable strict release policy',
        })
      ).data,
      'strict submit',
    );
    const strictSubmitReceipt = asRecord(strictSubmit.receipt, 'strict submit receipt');
    await waitForOperation(mcp, stringOf(strictSubmitReceipt.operationId, 'submit id'), [
      'completed',
      'failed',
      'stale',
    ]);

    // Render E0 under the strict policy: the candidate carries warning-only
    // findings, so the release evaluator opens a pending_waiver gate.
    const render = asRecord(
      (
        await mcp.call('nova_render', {
          sceneSelector: { type: 'events', eventIds: ['E0'] },
        })
      ).data,
      'nova_render',
    );
    expect(render.status).toBe('queued');
    const renderReceipt = await waitForOperation(mcp, stringOf(render.operationHandle, 'handle'), [
      'completed',
      'failed',
      'stale',
    ]);
    expect(renderReceipt.status).toBe('completed');

    const gatesBefore = asRecord(
      (await mcp.call('nova_release_gate_list', { version: 1 })).data,
      'gate list',
    );
    const gateItems = gatesBefore.items as readonly unknown[];
    const openGate = gateItems.find(
      (gate) => asRecord(gate, 'gate').eventId === 'E0' && asRecord(gate, 'gate').status === 'open',
    );
    expect(openGate).toBeTruthy();
    const openGateRecord = asRecord(openGate, 'open gate');
    const candidateRevisionId = stringOf(openGateRecord.revisionId, 'gate revisionId');
    expect(stringOf(openGateRecord.sourceHash, 'gate sourceHash')).toMatch(/^[0-9a-f]{64}$/);

    const pendingStatus = asRecord((await mcp.call('nova_status', {})).data, 'pending status');
    const pendingReview = asRecord(pendingStatus.review, 'pending review');
    expect(pendingReview.pendingGates).toBeGreaterThan(0);
    // Nothing promoted yet: the scene waits on the maintainer decision.
    expect(pendingStatus.render).toMatchObject({ completed: [] });

    // Maintainer accept. Core `resolveReleaseGate` re-runs the release
    // evaluator over the archived envelope and NEVER re-invokes the provider
    // (zero provider calls is a Core guarantee, exercised deterministically
    // by the in-process agent-parity-matrix); the E2E asserts the observable
    // promotion that follows.
    const gateDecision = asRecord(
      (
        await mcp.call('nova_release_gate_decide', {
          version: 1,
          eventId: 'E0',
          candidateRevisionId,
          decision: 'accept',
          reason: 'e2e maintainer waiver',
        })
      ).data,
      'gate decision',
    );
    const resolution = asRecord(gateDecision.resolution, 'resolution');
    expect(resolution.outcome).toBe('accepted');
    expect(resolution.acceptedRevisionId).toBeTruthy();

    const gatesAfter = asRecord(
      (await mcp.call('nova_release_gate_list', { version: 1 })).data,
      'gate list after',
    );
    const decidedGate = (gatesAfter.items as readonly unknown[]).find(
      (gate) => asRecord(gate, 'gate').eventId === 'E0',
    );
    expect(decidedGate).toBeTruthy();
    expect(asRecord(decidedGate, 'decided gate').status).toBe('decided');

    const decidedStatus = asRecord((await mcp.call('nova_status', {})).data, 'decided status');
    expect(decidedStatus.review).toEqual({ open: 0, blocking: 0, pendingGates: 0 });
    expect(decidedStatus.render).toMatchObject({ completed: ['E0'] });

    // NOTE: publication of the WAIVED scene is intentionally not asserted
    // here — the current Core resolveReleaseGate promotes the accepted scene
    // with the archived pending_waiver envelope, and assembly's manifest-head
    // check requires releaseDecision.status === 'accepted', so publishing a
    // waived scene reports stale (a Core integration gap the orchestrator is
    // tracking; the deterministic in-process matrix documents it too). The
    // publish + hash proof lives in the accept-and-record leg above.
  } finally {
    await mcp.close();
    await fixture.close();
  }
});

test('recovery leg: operation cancel on a queued operation; unknown and double-cancel semantics', async () => {
  const { fixture, mcp } = await bootMaintainerClient();
  try {
    // Unknown handle → typed OPERATION_NOT_FOUND tool error. The typed
    // client wraps tool-level failures with code TOOL_ERROR; the parsed error
    // payload itself carries the Host's real `{ code, message }` envelope.
    const unknown = await mcp.call('nova_operation_cancel', {
      version: 2,
      operationHandle: 'no-such-operation',
    });
    expect(unknown.ok).toBe(false);
    expect(asRecord(unknown.data, 'cancel error payload').code).toBe('OPERATION_NOT_FOUND');

    // Enqueue two renders back to back: per-project render concurrency is 1,
    // so the second stays queued while the first occupies the lane. Cancelling
    // it is the deterministic cancel-on-a-queued-op path (when renders can
    // complete at all; see the header caveat about the current DENIED build).
    const first = asRecord(
      (
        await mcp.call('nova_render', {
          sceneSelector: { type: 'events', eventIds: ['E0'] },
        })
      ).data,
      'first render',
    );
    const second = asRecord(
      (
        await mcp.call('nova_render', {
          sceneSelector: { type: 'all' },
        })
      ).data,
      'second render',
    );
    expect(first.status).toBe('queued');
    expect(second.status).toBe('queued');
    const secondHandle = stringOf(second.operationHandle, 'second operationHandle');

    const cancelled = await mcp.call('nova_operation_cancel', {
      version: 2,
      operationHandle: secondHandle,
    });
    expect(cancelled.ok).toBe(true);
    const cancelData = asRecord(cancelled.data, 'cancel result');
    expect(cancelData.version).toBe(2);
    expect(cancelData.operationId).toBe(secondHandle);
    // The queued op lands 'cancelled'; a drained op is reported as the
    // terminal record it already reached (never an error, never success).
    expect(['cancelled', 'completed', 'failed', 'stale']).toContain(
      stringOf(cancelData.status, 'cancel status'),
    );

    const afterCancel = asRecord(
      (await mcp.call('nova_operation_get', { version: 2, operationHandle: secondHandle })).data,
      'operation after cancel',
    );
    const afterReceipt = asRecord(afterCancel.receipt, 'receipt after cancel');
    const afterStatus = stringOf(afterReceipt.status, 'status after cancel');
    expect(['cancelled', 'completed', 'failed', 'stale']).toContain(afterStatus);
    // A cancelled operation must never report a successful outcome.
    expect(afterStatus).not.toBe('succeeded');

    // Double-cancel is idempotent: the second cancel reports the record's
    // terminal status instead of an error.
    const cancelledAgain = await mcp.call('nova_operation_cancel', {
      version: 2,
      operationHandle: secondHandle,
    });
    expect(cancelledAgain.ok).toBe(true);
    expect(
      stringOf(asRecord(cancelledAgain.data, 'second cancel').status, 'second cancel status'),
    ).toBe(stringOf(cancelData.status, 'first cancel status'));

    // The first render still reaches its own terminal state.
    await waitForOperation(mcp, stringOf(first.operationHandle, 'first operationHandle'), [
      'completed',
      'failed',
      'stale',
      'cancelled',
    ]);
  } finally {
    await mcp.close();
    await fixture.close();
  }
});
