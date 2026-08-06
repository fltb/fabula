import type { ProjectSourceSnapshotV1 } from '@novalistically/core';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectOperationRecordV1 } from '../src/contracts/persistence.js';
import {
  type AuthoringCoordinatorAssembly,
  createAuthoringCoordinator,
} from '../src/host/authoring/coordinator.js';
import type { AuthoringWorkingDocumentStore } from '../src/host/authoring/document-store.js';
import type { AuthoringCandidateStore } from '../src/host/authoring/filesystem-observer.js';
import type {
  AuthoringCoordinatorEvent,
  AuthoringEventPublisher,
  AuthoringSubmitInput,
} from '../src/host/authoring/types.js';
import type { ProjectOperationStore } from '../src/persistence/project-operation-store.js';
import { createInMemoryOperationStore } from './helpers/in-memory-operation-store.js';

const PROJECT_ID = 'project-a';
const FIXED_NOW = '2026-08-02T00:00:00.000Z';
const SOURCE_HASH = 'source-t';

type SubmitOutcome =
  | { readonly status: 'accepted'; readonly revisionId: string; readonly receiptHash: string }
  | { readonly status: 'stale'; readonly reason: string }
  | { readonly status: 'conflict'; readonly reason: string }
  | { readonly status: 'invalid'; readonly code: string; readonly reason: string };

interface StoreHarnessOptions {
  readonly store: ProjectOperationStore;
  readonly submitOutcome: SubmitOutcome;
  readonly events?: AuthoringEventPublisherStub;
  readonly initialAcceptedSourceHash?: string | null;
}

interface AuthoringEventPublisherStub extends AuthoringEventPublisher {
  readonly events: AuthoringCoordinatorEvent[];
}

function eventPublisher(): AuthoringEventPublisherStub {
  const events: AuthoringCoordinatorEvent[] = [];
  return {
    events,
    publish(event) {
      events.push(event);
    },
  };
}

/**
 * Submit-capable coordinator harness. The native revision backend is stubbed
 * to return a configurable outcome so the store adoption tests can exercise
 * every terminal mapping without a real source tree.
 */
async function createStoreHarness(options: StoreHarnessOptions): Promise<{
  coordinator: Awaited<ReturnType<typeof createAuthoringCoordinator>>;
  publisher: AuthoringEventPublisherStub;
}> {
  const publisher = options.events ?? eventPublisher();
  const documents = {
    projectId: PROJECT_ID,
    async isWorkingDirty() {
      return true;
    },
    async workspaceDigest() {
      return { digest: 'wd-1' };
    },
    descriptors() {
      return [
        {
          documentId: 'doc-1',
          logicalPath: 'nova.yaml',
          kind: 'raw-yaml' as const,
          state: 'live' as const,
          available: true,
        },
      ];
    },
    async materialize() {
      return { entries: [{ logicalPath: 'nova.yaml', content: 'content-1' }] };
    },
    async seedFromAccepted() {},
  } as unknown as AuthoringWorkingDocumentStore;
  const snapshot: ProjectSourceSnapshotV1 = {
    sourceHash: SOURCE_HASH,
    documents: [],
  } as unknown as ProjectSourceSnapshotV1;
  const assembly: AuthoringCoordinatorAssembly = {
    projectId: PROJECT_ID,
    materializer: documents,
    documents,
    staging: {
      async put() {},
      async delete() {},
      async get() {
        return null;
      },
    } as unknown as AuthoringCandidateStore,
    persistence: {
      async load() {
        return null;
      },
      async save() {},
    },
    operationStore: options.store,
    treeLoader: {
      async loadTree() {
        return { treeHash: SOURCE_HASH, entries: [] };
      },
    },
    sessions: {
      async enqueue(input) {
        await input.run({ operationId: 'lane-op-1' });
        return { status: 'completed', operationId: 'lane-op-1' };
      },
    },
    revision: {
      async loadAccepted() {
        return null;
      },
      async submit() {
        return options.submitOutcome;
      },
      async recover() {
        throw new Error('not used by store harness');
      },
      async list() {
        return { revisions: [] };
      },
      async get() {
        return null;
      },
      async diff() {
        return { changes: [] };
      },
      async restore() {
        throw new Error('not used by store harness');
      },
    },
    sourceViewMaterializer: {
      async inspect() {
        return {
          projectId: PROJECT_ID,
          treeHash: SOURCE_HASH,
          perPathHashes: [],
          materializedRevisionId: null,
        };
      },
      async materialize() {
        return { status: 'completed', treeHash: SOURCE_HASH };
      },
    },
    revisionContentStore: {
      async put() {},
      async get() {
        return null;
      },
    },
    events: publisher,
    buildSnapshot: () => snapshot,
    validate() {
      return [];
    },
    async adopt() {
      return { status: 'adopted' };
    },
    initialAccepted:
      options.initialAcceptedSourceHash === undefined
        ? undefined
        : (snapshot as ProjectSourceSnapshotV1),
    now: () => FIXED_NOW,
  };
  const coordinator = await createAuthoringCoordinator(assembly);
  return { coordinator, publisher };
}

function submitInput(overrides: Partial<AuthoringSubmitInput> = {}): AuthoringSubmitInput {
  return {
    expectedAcceptedSourceHash: SOURCE_HASH,
    expectedWorkspaceDigest: 'wd-1',
    actorId: 'actor-1',
    capabilityId: 'cap-1',
    capabilityScopes: ['mcp:submit'],
    expectedVersion: 3,
    ...overrides,
  };
}

/** Map a client receipt status onto the record status vocabulary. */
function recordStatusFor(status: string): ProjectOperationRecordV1['status'] {
  if (status === 'completed') return 'succeeded';
  if (status === 'conflict') return 'stale';
  return status as ProjectOperationRecordV1['status'];
}

describe('AuthoringCoordinator durable operation store adoption', () => {
  it('derives every receipt from the persisted record and persists before broadcasting', async () => {
    const store = createInMemoryOperationStore();
    const publisher = eventPublisher();
    // Snapshot the store row at the moment each event is delivered; because
    // the coordinator awaits the upsert before publishing, the row must
    // already exist with the broadcast status.
    const storeAtBroadcast: Array<{
      event: AuthoringCoordinatorEvent;
      record: ProjectOperationRecordV1 | null;
    }> = [];
    const tracingPublisher: AuthoringEventPublisherStub = {
      events: publisher.events,
      publish(event) {
        if (event.type !== 'operation-updated') {
          publisher.publish(event);
          return;
        }
        void store.get(PROJECT_ID, event.receipt.operationId).then((record) => {
          storeAtBroadcast.push({ event, record });
        });
        publisher.publish(event);
      },
    };
    const { coordinator } = await createStoreHarness({
      store,
      submitOutcome: { status: 'invalid', code: 'CANDIDATE_INVALID', reason: 'nope' },
      events: tracingPublisher,
      initialAcceptedSourceHash: SOURCE_HASH,
    });

    const receipt = await coordinator.submit(submitInput());

    // Client-facing shape: failed receipt with the backend error code.
    expect(receipt.status).toBe('failed');
    expect(receipt.errorCode).toBe('CANDIDATE_INVALID');
    expect(receipt.kind).toBe('submit');

    // The record is the single source of truth and is readable back.
    const stored = await store.get(PROJECT_ID, receipt.operationId);
    expect(stored).not.toBeNull();
    expect(stored?.status).toBe('failed');
    expect(stored?.actorId).toBe('actor-1');
    expect(stored?.capabilityVersion).toBe(3);
    expect(stored?.sourceHash).toBe(SOURCE_HASH);

    // listOperations returns the same derived receipt.
    const listed = await coordinator.listOperations();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual(receipt);

    // Every operation-updated broadcast happened after its record persisted.
    await vi.waitFor(() => expect(storeAtBroadcast.length).toBeGreaterThanOrEqual(2));
    for (const { event, record } of storeAtBroadcast) {
      expect(record).not.toBeNull();
      expect(record?.status).toBe(recordStatusFor(event.receipt.status));
    }
  });

  it('maps accepted outcomes to a completed receipt and a succeeded record', async () => {
    const store = createInMemoryOperationStore();
    const { coordinator } = await createStoreHarness({
      store,
      submitOutcome: { status: 'accepted', revisionId: 'revision-1', receiptHash: 'receipt-1' },
      initialAcceptedSourceHash: SOURCE_HASH,
    });

    const receipt = await coordinator.submit(submitInput());

    expect(receipt.status).toBe('completed');
    expect(receipt.revisionId).toBe('revision-1');
    expect(receipt.receiptHash).toBe('receipt-1');
    expect(receipt.acceptedRevisionId).toBe('revision-1');
    // acceptedSourceHash is the immutable CAS base the operation ran against.
    expect(receipt.acceptedSourceHash).toBe(SOURCE_HASH);

    const stored = await store.get(PROJECT_ID, receipt.operationId);
    expect(stored?.status).toBe('succeeded');
    expect(stored?.acceptedRevisionId).toBe('revision-1');
    expect(stored?.resultRef).toBe('receipt-1');
  });

  it('keeps the client-facing stale/conflict mapping unchanged', async () => {
    const staleStore = createInMemoryOperationStore();
    const staleHarness = await createStoreHarness({
      store: staleStore,
      submitOutcome: { status: 'stale', reason: 'accepted native revision changed' },
      initialAcceptedSourceHash: SOURCE_HASH,
    });
    const staleReceipt = await staleHarness.coordinator.submit(submitInput());
    expect(staleReceipt.status).toBe('stale');
    expect(staleReceipt.errorCode).toBe('WORKSPACE_STALE');
    expect((await staleStore.get(PROJECT_ID, staleReceipt.operationId))?.status).toBe('stale');

    const conflictStore = createInMemoryOperationStore();
    const conflictHarness = await createStoreHarness({
      store: conflictStore,
      submitOutcome: { status: 'conflict', reason: 'accepted native revision changed' },
      initialAcceptedSourceHash: SOURCE_HASH,
    });
    const conflictReceipt = await conflictHarness.coordinator.submit(submitInput());
    expect(conflictReceipt.status).toBe('conflict');
    expect(conflictReceipt.errorCode).toBe('CONFLICT_REQUIRES_RESOLUTION');
    // The durable queue has no conflict status; the record stores stale + code.
    expect((await conflictStore.get(PROJECT_ID, conflictReceipt.operationId))?.status).toBe(
      'stale',
    );
  });

  it('verifies the accepted native revision CAS and accepts a matching null binding', async () => {
    const store = createInMemoryOperationStore();
    const { coordinator } = await createStoreHarness({
      store,
      submitOutcome: { status: 'accepted', revisionId: 'revision-1', receiptHash: 'receipt-1' },
      initialAcceptedSourceHash: SOURCE_HASH,
    });
    // The coordinator has no accepted baseline yet (acceptedRevisionId null),
    // so a browser binding to a concrete revision is already stale.
    const moved = await coordinator.submit(submitInput({ expectedAcceptedRevisionId: 'rev-1' }));
    expect(moved.status).toBe('stale');
    expect(moved.errorCode).toBe('ACCEPTED_HASH_MISMATCH');
    expect((await store.get(PROJECT_ID, moved.operationId))?.status).toBe('stale');
    // A null binding matches the null accepted revision and submits normally.
    const matched = await coordinator.submit(submitInput({ expectedAcceptedRevisionId: null }));
    expect(matched.status).toBe('completed');
    expect(matched.errorCode).toBeNull();
  });

  it('recovers operation receipts from the store after a coordinator restart', async () => {
    const store = createInMemoryOperationStore();
    const first = await createStoreHarness({
      store,
      submitOutcome: { status: 'invalid', code: 'CANDIDATE_INVALID', reason: 'nope' },
      initialAcceptedSourceHash: SOURCE_HASH,
    });
    const receipt = await first.coordinator.submit(submitInput());
    await first.coordinator.dispose();

    // A brand-new coordinator over the same store (the Host-restart shape)
    // must serve the same derived receipt from the durable row.
    const second = await createStoreHarness({
      store,
      submitOutcome: { status: 'accepted', revisionId: 'revision-2', receiptHash: 'receipt-2' },
      initialAcceptedSourceHash: SOURCE_HASH,
    });
    expect(await second.coordinator.getOperation(receipt.operationId)).toEqual(receipt);
    expect(await second.coordinator.listOperations()).toContainEqual(receipt);
    await second.coordinator.dispose();
  });

  it('unified operation surface reads render/revise records from the same store', async () => {
    const store = createInMemoryOperationStore();
    const { coordinator } = await createStoreHarness({
      store,
      submitOutcome: { status: 'invalid', code: 'CANDIDATE_INVALID', reason: 'nope' },
      initialAcceptedSourceHash: SOURCE_HASH,
    });

    // A render record written by the sibling ProjectOperationService through
    // the same store becomes visible through the coordinator's unified reads.
    const renderRecord: ProjectOperationRecordV1 = {
      version: 1,
      projectId: PROJECT_ID,
      operationId: 'render-1',
      idempotencyKey: 'render-1',
      kind: 'render',
      status: 'queued',
      actorId: 'actor-1',
      capabilityVersion: 3,
      sourceHash: SOURCE_HASH,
      acceptedRevisionId: null,
      progress: null,
      resultRef: null,
      errorCode: null,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    };
    await store.upsert({ record: renderRecord });
    // The operation service moves the row through the canonical transition,
    // carrying durable progress along with it.
    await store.upsert({
      record: {
        ...renderRecord,
        status: 'running',
        progress: { completed: 2, total: 5 },
        updatedAt: FIXED_NOW,
      },
      expectedStatus: 'queued',
    });

    const receipt = await coordinator.getOperation('render-1');
    expect(receipt).not.toBeNull();
    expect(receipt?.kind).toBe('render');
    expect(receipt?.status).toBe('running');
    expect(receipt?.progress).toEqual({ completed: 2, total: 5 });
    expect(receipt?.pendingOperationId).toBe('render-1');
    expect(await coordinator.listOperations()).toContainEqual(receipt);

    const missing = await coordinator.getOperation('nope');
    expect(missing).toBeNull();
  });
});
