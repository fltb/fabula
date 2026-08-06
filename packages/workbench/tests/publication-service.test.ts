import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type CoreRuntimeServices,
  compileProject,
  type JsonValue,
  type ProjectSourceSnapshotV1,
  type WorkflowPublicationProjectionV1,
} from '@novalistically/core';
import { computeReleaseGateId, type SceneRevisionEnvelopeV1 } from '@novalistically/core/editorial';
import { buildSourceSnapshot, computeSourceDocumentHash } from '@novalistically/core/source';
import { MemoryExecutionRepository } from '@novalistically/core/testing';
import { afterAll, describe, expect, it } from 'vitest';
import type { ProjectPublicationRecordV1 } from '../src/contracts/persistence.js';
import type { McpAuthorizedCaller } from '../src/host/mcp/auth.js';
import {
  createProjectOperationService,
  type ProjectOperationService,
} from '../src/host/operation-service.js';
import type { ProjectSession, ProjectSessionProjectionV1 } from '../src/host/project-session.js';
import {
  computeCustomPublicationId,
  createProjectPublicationService,
  type ProjectPublicationService,
} from '../src/host/publication/publication-service.js';
import { createHostReviewService } from '../src/host/review/review-service.js';
import { createInMemoryOperationStore } from './helpers/in-memory-operation-store.js';
import { createInMemoryPublicationStore } from './helpers/in-memory-publication-store.js';

const FIXTURE_ROOT = fileURLToPath(new URL('../../../fixtures/zhu-fu', import.meta.url));

const sha256Hex = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

/** Canonical JSON (sorted keys, arrays keep order) — matches Core identity hashing. */
function canonicalJson(value: unknown): string {
  if (typeof value !== 'object' || value === null) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

/** Mirrors Core `computeScopeHash(eventId, branchPath)`. */
const scopeHashOf = (eventId: string, branchPath: unknown = null): string =>
  sha256Hex(canonicalJson({ eventId, branchPath }));

/** Materialize the zhu-fu fixture into an immutable snapshot. */
function materializeFixture(root: string): ProjectSourceSnapshotV1 {
  const documents: ProjectSourceSnapshotV1['documents'][number][] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.isDirectory()) {
        if (entry.name === '.nova') continue;
        walk(join(dir, entry.name));
      } else if (/\.ya?ml$/i.test(entry.name)) {
        const logicalPath = relative(root, join(dir, entry.name)).split(sep).join('/');
        const content = readFileSync(join(dir, entry.name), 'utf8');
        documents.push({
          version: 1,
          logicalPath,
          content,
          contentHash: computeSourceDocumentHash(content),
          parseResult: { status: 'parsed', value: null },
          diagnostics: [],
        });
      }
    }
  };
  walk(root);
  return buildSourceSnapshot(documents);
}

const FIXTURE = materializeFixture(FIXTURE_ROOT);

/** Accepted-scene envelope that passes the strict Core envelope schema. */
function envelopeFor(
  eventId: string,
  prose: string,
  revisionId: string,
  branchPath: unknown = null,
): SceneRevisionEnvelopeV1 {
  const proseHash = sha256Hex(prose);
  const scopeHash = scopeHashOf(eventId, branchPath);
  return {
    version: 1,
    revisionId,
    parentRevisionId: null,
    operationId: '00000000-0000-4000-8000-00000000000e',
    planHash: sha256Hex(`plan:${eventId}`),
    actorId: 'renderer',
    eventId,
    origin: 'llm_draft',
    prose,
    proseHash,
    sceneHash: proseHash,
    editorialBasisHash: sha256Hex(`basis:${eventId}`),
    scopeHash,
    validationIdentity: 'validator-v1',
    feedbackHash: null,
    reviewIds: [],
    analysis: null,
    validation: null,
    releaseDecision: {
      status: 'accepted',
      scopeHash,
      validationIdentity: 'validator-v1',
      reasons: [],
    },
    released: true,
    cacheHit: false,
    errors: [],
    llmPass1: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    llmPass2: null,
    attempts: 1,
    needsReview: false,
    promptHash: sha256Hex(`prompt:${eventId}`),
    providerCalls: [],
    promotionReadSet: [],
    requestRecords: [],
    createdAt: '2026-08-02T00:00:00.000Z',
  };
}

/** Seed accepted scenes for every compiled event of the snapshot. */
async function seedAcceptedScenes(
  execution: MemoryExecutionRepository,
  source: ProjectSourceSnapshotV1,
  excludedEventId?: string,
  branchPath: unknown = null,
): Promise<void> {
  const compilation = compileProject(source);
  for (const event of compilation.events) {
    if (event.id === excludedEventId) continue;
    const prose = `Prose for ${event.id}. The quick brown fox jumps over the lazy dog.`;
    const envelope = envelopeFor(event.id, prose, randomUUID(), branchPath);
    await execution.compareAndSwapAcceptedScene({
      projectId: 'p1',
      eventId: event.id,
      expectedVersion: null,
      value: {
        version: 1,
        projectId: 'p1',
        eventId: event.id,
        sourceHash: source.sourceHash,
        revisionId: envelope.revisionId,
        prose,
        proseHash: envelope.proseHash,
        sceneHash: envelope.sceneHash,
        value: envelope as unknown as JsonValue,
      },
    });
  }
}

function fixtureEventIds(): readonly string[] {
  return compileProject(FIXTURE).events.map((event) => event.id);
}

function makeProjection(source: ProjectSourceSnapshotV1 | null): ProjectSessionProjectionV1 {
  return {
    version: 1,
    projectId: 'p1',
    revision: 1,
    sourceHash: source?.sourceHash ?? null,
    documents: source?.documents.length ?? 0,
    events: 0,
    rendered: 0,
    pending: 0,
    blocked: 0,
    errorCount: 0,
    warningCount: 0,
    diagnostics: source ? source.documents.flatMap((document) => document.diagnostics) : [],
    presence: [],
    generatedAt: '2026-08-02T00:00:00.000Z',
  };
}

function callerFor(overrides: Record<string, unknown> = {}): McpAuthorizedCaller {
  return {
    sessionId: null,
    userId: 'u-1',
    grant: {
      capabilityId: 'cap-publish',
      userId: 'u-1',
      projectId: 'p1',
      scopes: ['mcp:submit'],
      version: 1,
      expiresAt: '2099-01-01T00:00:00.000Z',
      ...overrides,
    },
  } as unknown as McpAuthorizedCaller;
}

const ownedTempDirs: string[] = [];

function newTempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  ownedTempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of ownedTempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Session double with a live MemoryExecutionRepository + real Core compile. */
function reviewSession(source: ProjectSourceSnapshotV1): {
  session: ProjectSession;
  execution: MemoryExecutionRepository;
  runtimeServices: CoreRuntimeServices;
} {
  const execution = new MemoryExecutionRepository();
  const runtimeServices = {
    execution,
    clock: { now: () => '2026-08-02T00:00:00.000Z' },
    ids: { next: () => `test-id-${Math.random()}` },
  } as unknown as CoreRuntimeServices;
  const session = {
    projectId: 'p1',
    runtime: {
      projectId: 'p1',
      services: runtimeServices,
      compile: (snapshot: ProjectSourceSnapshotV1) => compileProject(snapshot),
      has: () => false,
      memoizedHashes: [],
      memoSize: 0,
    },
    source,
    projection: makeProjection(source),
    busy: false,
    hasHumanPresence: false,
    presenceGeneration: 0,
    refreshSource: () => {
      throw new Error('refreshSource is not exercised by the publication service');
    },
    updatePresence: () => {
      throw new Error('updatePresence is not exercised by the publication service');
    },
    adoptSourceWithinOperation: () => {
      throw new Error('adoptSourceWithinOperation is not exercised by the publication service');
    },
    enqueueOperation: async () => {
      throw new Error('enqueueOperation is not exercised by the publication service');
    },
    enqueueDetachedOperation: async () => {
      throw new Error('enqueueDetachedOperation is not exercised by the publication service');
    },
  } as unknown as ProjectSession;
  return { session, execution, runtimeServices };
}

interface PublicationHarness {
  session: ProjectSession;
  execution: MemoryExecutionRepository;
  operations: ProjectOperationService;
  service: ProjectPublicationService;
  store: ReturnType<typeof createInMemoryPublicationStore>;
  root: string;
  setSource: (source: ProjectSourceSnapshotV1) => void;
  setExecution: (execution: MemoryExecutionRepository) => void;
}

async function createPublicationHarness(): Promise<PublicationHarness> {
  const { session, execution, runtimeServices } = reviewSession(FIXTURE);
  const root = newTempRoot('fabula-publication-');
  const operations = createProjectOperationService({
    projectId: 'p1',
    store: createInMemoryOperationStore(),
    session,
    limits: { maxQueuedPerProject: 64, maxConcurrentRendersPerHost: 2 },
  });
  await operations.start();
  const store = createInMemoryPublicationStore();
  const service = createProjectPublicationService({
    projectId: 'p1',
    session,
    projectRoot: root,
    publicationStore: store,
    operations,
  });
  return {
    session,
    execution,
    operations,
    service,
    store,
    root,
    setSource: (source) => {
      (session as { source: ProjectSourceSnapshotV1 | null }).source = source;
    },
    setExecution: (next) => {
      runtimeServices.execution = next;
    },
  };
}

async function waitForTerminal(
  operations: ProjectOperationService,
  operationId: string,
): Promise<import('../src/contracts/persistence.js').ProjectOperationRecordV1> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const record = await operations.get(operationId);
    if (record !== null && record.status !== 'queued' && record.status !== 'running') {
      return record;
    }
    if (Date.now() > deadline) {
      throw new Error(`operation ${operationId} did not reach a terminal status`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const novelFile = (root: string): string => join(root, 'output', 'novel.md');
const customFile = (root: string, id: string): string => join(root, 'output', `${id}.md`);

/** A newer accepted source: one fixture document gets a content suffix. */
function changedSource(): ProjectSourceSnapshotV1 {
  return buildSourceSnapshot(
    FIXTURE.documents.map((document, index) => {
      const content = index === 0 ? `${document.content}\n# changed` : document.content;
      return {
        version: 1 as const,
        logicalPath: document.logicalPath,
        content,
        contentHash: computeSourceDocumentHash(content),
        parseResult: { status: 'parsed' as const, value: null },
        diagnostics: [],
      };
    }),
  );
}

describe('ProjectPublicationService', () => {
  it('publishes the canonical novel: file bytes hash equals the record novelHash', async () => {
    const harness = await createPublicationHarness();
    await seedAcceptedScenes(harness.execution, FIXTURE);

    const result = await harness.service.publish({}, callerFor());
    expect(result.publicationId).toBe('canonical');
    expect(result.kind).toBe('canonical');
    expect(result.enqueue.status).toBe('queued');
    const operationId =
      result.enqueue.status === 'queued' ? result.enqueue.operationHandle : undefined;
    expect(operationId).toBeTruthy();
    const operation = await waitForTerminal(harness.operations, operationId as string);
    expect(operation.status).toBe('succeeded');

    const record = await harness.service.get('canonical');
    expect(record).not.toBeNull();
    expect(record?.value.relativeOutputPath).toBe('output/novel.md');
    expect(record?.value.status).toBe('current');
    expect(record?.value.sourceHash).toBe(FIXTURE.sourceHash);
    expect(record?.value.revisionIds.length).toBeGreaterThan(0);

    const fileBytes = readFileSync(novelFile(harness.root));
    expect(sha256Hex(fileBytes.toString('utf8'))).toBe(record?.value.novelHash);
    expect(fileBytes.byteLength).toBe(record?.value.byteLength);
    const text = fileBytes.toString('utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('Prose for E0.');
  });

  it('re-publishes idempotently for the same accepted source (replay)', async () => {
    const harness = await createPublicationHarness();
    await seedAcceptedScenes(harness.execution, FIXTURE);
    const first = await harness.service.publish({}, callerFor());
    const firstId = first.enqueue.status === 'queued' ? first.enqueue.operationHandle : '';
    await waitForTerminal(harness.operations, firstId);
    const before = await harness.service.get('canonical');

    // Identical request + identical accepted state: the durable operation
    // queue replays the existing result (plan 6.2 idempotency contract).
    const second = await harness.service.publish({}, callerFor());
    expect(second.enqueue.status).toBe('replayed');
    if (second.enqueue.status === 'replayed') {
      expect(second.enqueue.record.operationId).toBe(firstId);
    }

    const after = await harness.service.get('canonical');
    expect(after?.value.novelHash).toBe(before?.value.novelHash);
    expect(after?.value.byteLength).toBe(before?.value.byteLength);
    expect(sha256Hex(readFileSync(novelFile(harness.root)).toString('utf8'))).toBe(
      after?.value.novelHash,
    );
  });

  it('marks a missing scene stale and never overwrites the last current novel', async () => {
    const harness = await createPublicationHarness();
    await seedAcceptedScenes(harness.execution, FIXTURE);
    const first = await harness.service.publish({}, callerFor());
    const firstId = first.enqueue.status === 'queued' ? first.enqueue.operationHandle : '';
    await waitForTerminal(harness.operations, firstId);
    const before = await harness.service.get('canonical');
    const beforeBytes = readFileSync(novelFile(harness.root));

    // One scene loses its accepted head: the assembly is incomplete, so the
    // publish must be stale with no partial file and the previous current
    // novel intact.
    const eventIds = fixtureEventIds();
    const next = new MemoryExecutionRepository();
    await seedAcceptedScenes(next, FIXTURE, eventIds[0]);
    harness.setExecution(next);

    const second = await harness.service.publish({}, callerFor());
    const secondId = second.enqueue.status === 'queued' ? second.enqueue.operationHandle : '';
    const secondOperation = await waitForTerminal(harness.operations, secondId);
    expect(secondOperation.status).toBe('stale');

    const after = await harness.service.get('canonical');
    // The record is demoted to stale (plan 6.5) but keeps the last good
    // artifact identity; the file is never overwritten by a partial novel.
    expect(after?.value.status).toBe('stale');
    expect(after?.value.novelHash).toBe(before?.value.novelHash);
    expect(readFileSync(novelFile(harness.root))).toEqual(beforeBytes);
    expect(sha256Hex(readFileSync(novelFile(harness.root)).toString('utf8'))).toBe(
      before?.value.novelHash,
    );
  });

  it('marks an old-source publish stale without touching the record or file', async () => {
    const harness = await createPublicationHarness();
    await seedAcceptedScenes(harness.execution, FIXTURE);
    const first = await harness.service.publish({}, callerFor());
    const firstId = first.enqueue.status === 'queued' ? first.enqueue.operationHandle : '';
    await waitForTerminal(harness.operations, firstId);
    const beforeBytes = readFileSync(novelFile(harness.root));

    // A newer accepted source exists; every accepted scene is old-source, so
    // the assembly is invalid → stale and the record/file stay untouched.
    harness.setSource(changedSource());

    const second = await harness.service.publish({}, callerFor());
    const secondId = second.enqueue.status === 'queued' ? second.enqueue.operationHandle : '';
    const secondOperation = await waitForTerminal(harness.operations, secondId);
    expect(secondOperation.status).toBe('stale');

    const record = await harness.service.get('canonical');
    // Demoted to stale (newer accepted source exists) with the artifact and
    // file of the last current novel intact.
    expect(record?.value.status).toBe('stale');
    expect(readFileSync(novelFile(harness.root))).toEqual(beforeBytes);
  });

  it('publishes a custom branch artifact under a deterministic sha256 id', async () => {
    const harness = await createPublicationHarness();
    const branchPath = {
      decisions: [{ atEventId: fixtureEventIds()[0], choiceId: 'a', narrativeOrder: 1 }],
    };
    const request = { branchPath, discourseBranch: 'branch-a', title: 'Branch Novel' };
    await seedAcceptedScenes(harness.execution, FIXTURE, undefined, branchPath);
    const expectedId = computeCustomPublicationId(branchPath, 'branch-a', 'Branch Novel');
    expect(expectedId).toMatch(/^[0-9a-f]{64}$/);

    const result = await harness.service.publish(request, callerFor());
    expect(result.publicationId).toBe(expectedId);
    expect(result.kind).toBe('custom');
    const operationId = result.enqueue.status === 'queued' ? result.enqueue.operationHandle : '';
    const operation = await waitForTerminal(harness.operations, operationId);
    expect(operation.status).toBe('succeeded');

    const record = await harness.service.get(expectedId);
    expect(record?.value.relativeOutputPath).toBe(`output/${expectedId}.md`);
    expect(record?.value.status).toBe('current');
    const fileBytes = readFileSync(customFile(harness.root, expectedId));
    expect(sha256Hex(fileBytes.toString('utf8'))).toBe(record?.value.novelHash);
    expect(fileBytes.toString('utf8')).toContain('# Branch Novel');
    // The canonical novel file is untouched by a custom publish.
    expect(existsSync(novelFile(harness.root))).toBe(false);
  });

  it('reads bounded markdown slices with offsets and enforces read bounds', async () => {
    const harness = await createPublicationHarness();
    await seedAcceptedScenes(harness.execution, FIXTURE);
    const result = await harness.service.publish({}, callerFor());
    const operationId = result.enqueue.status === 'queued' ? result.enqueue.operationHandle : '';
    await waitForTerminal(harness.operations, operationId);
    const fullText = readFileSync(novelFile(harness.root)).toString('utf8');
    const totalBytes = Buffer.byteLength(fullText, 'utf8');

    const head = await harness.service.read('canonical', 0, 100);
    expect(head.totalByteLength).toBe(totalBytes);
    expect(head.content).toBe([...fullText].slice(0, 100).join(''));

    const paged = await harness.service.read('canonical', 50, 40);
    expect(paged.content).toBe([...fullText].slice(50, 90).join(''));

    const pastEnd = await harness.service.read('canonical', totalBytes + 1000, 100);
    expect(pastEnd.content).toBe('');
    expect(pastEnd.byteLength).toBe(0);

    await expect(harness.service.read('canonical', 0, 256 * 1024 + 1)).rejects.toMatchObject({
      code: 'PUBLICATION_INVALID',
    });
    await expect(harness.service.read('canonical', -1, 10)).rejects.toMatchObject({
      code: 'PUBLICATION_INVALID',
    });
    await expect(harness.service.read('missing-id', 0, 10)).rejects.toMatchObject({
      code: 'PUBLICATION_NOT_FOUND',
    });
  });

  it('auto-refreshes the canonical publication after an accepted scene commit', async () => {
    const harness = await createPublicationHarness();
    expect(await harness.service.workflowPublicationProjection()).toEqual({
      status: 'missing',
      publicationId: null,
      novelHash: null,
    });

    // The launch wiring pattern: a render operation's success fires the
    // best-effort refresh (plan 6.5), which publishes once the full set is
    // ready.
    const renderOp = await harness.operations.enqueue({
      kind: 'render',
      idempotencyKey: 'render-seed-1',
      actorId: 'u1',
      capabilityVersion: 1,
      sourceHash: FIXTURE.sourceHash,
      acceptedRevisionId: null,
      requestHash: 'render-seed-hash-1',
      runner: async () => {
        await seedAcceptedScenes(harness.execution, FIXTURE);
        return { status: 'succeeded', result: {} };
      },
    });
    const renderId = renderOp.status === 'queued' ? renderOp.operationHandle : '';
    await waitForTerminal(harness.operations, renderId);
    await harness.service.refreshCanonical({ actorId: 'u1', operationId: renderId });

    const record = await harness.service.get('canonical');
    expect(record).not.toBeNull();
    expect(record?.value.status).toBe('current');
    expect(sha256Hex(readFileSync(novelFile(harness.root)).toString('utf8'))).toBe(
      record?.value.novelHash,
    );
  });

  it('demotes the canonical record to stale when the refresh finds an incomplete set', async () => {
    const harness = await createPublicationHarness();
    await seedAcceptedScenes(harness.execution, FIXTURE);
    const result = await harness.service.publish({}, callerFor());
    const operationId = result.enqueue.status === 'queued' ? result.enqueue.operationHandle : '';
    await waitForTerminal(harness.operations, operationId);
    const beforeBytes = readFileSync(novelFile(harness.root));

    const eventIds = fixtureEventIds();
    const next = new MemoryExecutionRepository();
    await seedAcceptedScenes(next, FIXTURE, eventIds[0]);
    harness.setExecution(next);

    await harness.service.refreshCanonical();
    const record = await harness.service.get('canonical');
    expect(record?.value.status).toBe('stale');
    // No partial novel: the file still holds the last current artifact.
    expect(readFileSync(novelFile(harness.root))).toEqual(beforeBytes);
  });

  it('fires the canonical refresh from a release-gate acceptance (plan 6.5 hook)', async () => {
    const { session, execution } = reviewSession(FIXTURE);
    let fired = 0;
    const service = createHostReviewService({
      projectId: 'p1',
      session,
      operationStore: createInMemoryOperationStore(),
      onGateAccepted: () => {
        fired += 1;
      },
    });

    // Archive a pending candidate envelope for event E1, then accept it.
    const eventId = 'E1';
    const prose = 'The morning light filtered through the tall windows.';
    const proseHash = sha256Hex(prose);
    const scopeHash = scopeHashOf(eventId);
    const validationIdentity = 'validator-v1';
    const revisionId = 'candidate-rev-1';
    const gateId = computeReleaseGateId({
      projectId: 'p1',
      sourceHash: FIXTURE.sourceHash,
      eventId,
      proseHash,
      scopeHash,
      validationIdentity,
      warnings: [],
    });
    const envelope: SceneRevisionEnvelopeV1 = {
      version: 1,
      revisionId,
      parentRevisionId: null,
      operationId: 'op-1',
      planHash: sha256Hex('plan'),
      actorId: 'renderer',
      eventId,
      origin: 'llm_draft',
      prose,
      proseHash,
      sceneHash: proseHash,
      editorialBasisHash: sha256Hex('basis'),
      scopeHash,
      validationIdentity,
      feedbackHash: null,
      reviewIds: [],
      analysis: { eventId },
      validation: { passed: true, errors: [], warnings: [], infos: [] },
      releaseDecision: {
        status: 'accepted',
        scopeHash,
        validationIdentity,
        reasons: [],
        gateId,
        releasePolicy: { warnings: 'accept-and-record', openBlockingReviews: 'block' },
      },
      released: false,
      cacheHit: false,
      errors: [],
      llmPass1: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      llmPass2: null,
      attempts: 1,
      needsReview: false,
      promptHash: sha256Hex('prompt'),
      providerCalls: [],
      promotionReadSet: [],
      requestRecords: [],
      createdAt: '2026-08-02T00:00:00.000Z',
    };
    await execution.compareAndSwapSceneRevision({
      projectId: 'p1',
      eventId,
      revisionId,
      expectedVersion: null,
      value: {
        version: 1,
        projectId: 'p1',
        eventId,
        revisionId,
        parentRevisionId: null,
        sourceHash: FIXTURE.sourceHash,
        value: envelope as unknown as JsonValue,
      },
    });

    const resolution = await service.decideGate(
      { eventId, candidateRevisionId: revisionId, decision: 'accept', reason: 'approved' },
      callerFor() as McpAuthorizedCaller,
    );
    expect(resolution.outcome).toBe('accepted');
    expect(fired).toBe(1);
  });

  it('projects current/stale/missing status from the store', async () => {
    const harness = await createPublicationHarness();
    await seedAcceptedScenes(harness.execution, FIXTURE);

    expect(await harness.service.workflowPublicationProjection()).toEqual({
      status: 'missing',
      publicationId: null,
      novelHash: null,
    });

    const result = await harness.service.publish({}, callerFor());
    const operationId = result.enqueue.status === 'queued' ? result.enqueue.operationHandle : '';
    await waitForTerminal(harness.operations, operationId);
    const record = await harness.service.get('canonical');
    expect(await harness.service.workflowPublicationProjection()).toEqual({
      status: 'current',
      publicationId: 'canonical',
      novelHash: record?.value.novelHash,
    } satisfies WorkflowPublicationProjectionV1);

    // Stale once a newer accepted source exists (assembly hash diverges).
    harness.setSource(changedSource());
    expect(await harness.service.workflowPublicationProjection()).toEqual({
      status: 'stale',
      publicationId: 'canonical',
      novelHash: record?.value.novelHash,
    } satisfies WorkflowPublicationProjectionV1);
  });

  it('projects the record for the browser surface with scene/word counts', async () => {
    const harness = await createPublicationHarness();
    await seedAcceptedScenes(harness.execution, FIXTURE);
    const result = await harness.service.publish({}, callerFor());
    const operationId = result.enqueue.status === 'queued' ? result.enqueue.operationHandle : '';
    await waitForTerminal(harness.operations, operationId);
    const record = await harness.service.get('canonical');
    const projected = await harness.service.projectRecord(record as ProjectPublicationRecordV1);
    expect(projected.status).toBe('current');
    expect(projected.staleReasons).toEqual([]);
    expect(projected.sceneCount).toBe(fixtureEventIds().length);
    expect(projected.wordCount).toBeGreaterThan(0);
  });
});
