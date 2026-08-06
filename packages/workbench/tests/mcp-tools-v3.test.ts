import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CoreRuntimeServices,
  JsonValue,
  ProjectSourceSnapshotV1,
  ReviewGateV1,
  WorkflowStatusV1,
} from '@novalistically/core';
import { compileProject } from '@novalistically/core';
import {
  computeReleaseGateId,
  type EditorialRenderRequestV1,
  type EditorialRuntime,
  type ReleaseGateResolutionV1,
  type RenderGameDialogueTreeRequestV1,
  type RenderGameDialogueTreeResult,
  type RenderNovelResult,
} from '@novalistically/core/editorial';
import { buildSourceSnapshot, computeSourceDocumentHash } from '@novalistically/core/source';
import {
  MemoryExecutionRepository,
  MemoryRenderCacheRepository,
  MemoryStateLogRepository,
  MemoryStateSnapshotRepository,
} from '@novalistically/core/testing';
import { diffEvent } from '@novalistically/core/tooling';
import { describe, expect, it } from 'vitest';
import type { WorkingValidationResultV1 } from '../src/contracts/authoring.js';
import type {
  AuthoringStateRecord,
  ProjectOperationRecordV1,
} from '../src/contracts/persistence.js';
import {
  type AuthoringCoordinatorAssembly,
  createAuthoringCoordinator,
  WorkingValidationFailure,
} from '../src/host/authoring/coordinator.js';
import type { AuthoringWorkingDocumentStore } from '../src/host/authoring/document-store.js';
import type { AuthoringCandidateStore } from '../src/host/authoring/filesystem-observer.js';
import { createProjectCoreRuntime, type ProjectCoreRuntime } from '../src/host/core-runtime.js';
import type { McpAuthorizedCaller } from '../src/host/mcp/auth.js';
import {
  createProjectSessionMcpRegistry,
  MCP_AUTHOR_SCOPE,
  MCP_READ_SCOPE,
  MCP_RENDER_SCOPE,
  MCP_SUBMIT_SCOPE,
  type McpAuthoringCoordinatorPort,
  type McpPublicationPort,
  type McpReviewPort,
  type McpToolResult,
} from '../src/host/mcp/registry.js';
import {
  createProjectOperationService,
  type ProjectOperationService,
} from '../src/host/operation-service.js';
import type {
  ProjectSession,
  ProjectSessionProjectionV1,
  SessionDetachedOperation,
  SessionDetachedOperationResult,
  SessionDetachedOperationRunContext,
  SessionOperation,
  SessionOperationResult,
} from '../src/host/project-session.js';
import type {
  PublicationReadResultV1,
  PublishEnqueueResultV1,
  PublishPublicationRequestV1,
} from '../src/host/publication/publication-service.js';
import {
  createHostReviewService,
  type HostNewReviewCommentV1,
  type HostReviewCommentV1,
} from '../src/host/review/review-service.js';
import { createCanonicalStateProjectionService } from '../src/host/state/canonical-state-projection.js';
import { createInMemoryOperationStore } from './helpers/in-memory-operation-store.js';

// ─── Real compilable project snapshot (zhu-fu fixture) ───────────────────────

const FIXTURE_ROOT = fileURLToPath(new URL('../../../fixtures/zhu-fu', import.meta.url));

/** Materialize the version-controlled zhu-fu project into an immutable snapshot. */
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

// ─── Session double ──────────────────────────────────────────────────────────

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

interface FakeSessionOptions {
  source: ProjectSourceSnapshotV1 | null;
  enqueue?: (operation: SessionOperation) => Promise<SessionOperationResult>;
  detached?: (
    operation: SessionDetachedOperation<unknown, unknown, unknown>,
  ) => Promise<SessionDetachedOperationResult<unknown>>;
}

function fakeSession(options: FakeSessionOptions): {
  session: ProjectSession;
  operations: SessionOperation[];
  detachedOperations: SessionDetachedOperation<unknown, unknown, unknown>[];
} {
  const operations: SessionOperation[] = [];
  const detachedOperations: SessionDetachedOperation<unknown, unknown, unknown>[] = [];
  let detachedSequence = 0;
  const session: ProjectSession = {
    projectId: 'p1',
    runtime: {
      projectId: 'p1',
      services: {} as CoreRuntimeServices,
      compile: () => {
        throw new Error('compile is not exercised through the MCP registry');
      },
      has: () => false,
      memoizedHashes: [],
      memoSize: 0,
    } as ProjectCoreRuntime,
    source: options.source,
    projection: makeProjection(options.source),
    busy: false,
    hasHumanPresence: false,
    presenceGeneration: 0,
    refreshSource: () => {
      throw new Error('refreshSource is not exercised through the MCP registry');
    },
    updatePresence: () => {
      throw new Error('updatePresence is not exercised through the MCP registry');
    },
    adoptSourceWithinOperation: () => {
      throw new Error('adoptSourceWithinOperation is not exercised through the MCP registry');
    },
    enqueueOperation: (async (operation: SessionOperation) => {
      operations.push(operation);
      if (options.enqueue) return options.enqueue(operation);
      throw new Error('enqueueOperation was not configured for this session double');
    }) as ProjectSession['enqueueOperation'],
    enqueueDetachedOperation: async (operation) => {
      detachedOperations.push(operation);
      if (options.detached) return options.detached(operation);
      const context: SessionDetachedOperationRunContext = {
        projectId: 'p1',
        operationId: operation.operationId ?? `srv-detached-${++detachedSequence}`,
        actorId: 'u1',
        capabilityVersion: 2,
        scopes: operation.scope,
        signal: operation.signal ?? new AbortController().signal,
      };
      const capture = await operation.prepare(context);
      const candidate = await operation.execute(context, capture, context.signal);
      const committed = await operation.commit(context, capture, candidate);
      return committed.status === 'completed'
        ? { status: 'completed', operationId: context.operationId, result: committed.result }
        : { status: 'stale', operationId: context.operationId, reason: committed.reason };
    },
  };
  return { session, operations, detachedOperations };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message = 'condition',
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${message}`);
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 5);
    await promise;
  }
}

async function createOperationService(session: ProjectSession): Promise<ProjectOperationService> {
  const service = createProjectOperationService({
    projectId: session.projectId,
    store: createInMemoryOperationStore(),
    session,
    limits: { maxQueuedPerProject: 64, maxConcurrentRendersPerHost: 2 },
  });
  await service.start();
  return service;
}

async function waitForTerminal(
  service: ProjectOperationService,
  operationId: string,
): Promise<import('../src/contracts/persistence.js').ProjectOperationRecordV1> {
  let record: import('../src/contracts/persistence.js').ProjectOperationRecordV1 | null = null;
  await waitFor(async () => {
    record = await service.get(operationId);
    return record !== null && record.status !== 'queued' && record.status !== 'running';
  }, `operation ${operationId} to reach a terminal status`);
  if (record === null) throw new Error(`operation ${operationId} disappeared`);
  return record;
}

interface TestGrant {
  capabilityId: string;
  version: number;
  userId: string;
  projectId: string;
  scopes: readonly string[];
  expiresAt: string;
}

function callerFor(grant: TestGrant, sessionId = 'session-live') {
  return { sessionId, userId: grant.userId, grant };
}

function grantWith(overrides: Partial<TestGrant>): TestGrant {
  return {
    capabilityId: 'cap-1',
    version: 1,
    userId: 'u1',
    projectId: 'p1',
    scopes: [MCP_READ_SCOPE],
    expiresAt: '2099-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function expectError(result: McpToolResult, code: string): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe(code);
}

function renderStubResult(operationId = 'echoed'): RenderNovelResult {
  return {
    operationId,
    results: [],
    errors: [],
    editorialErrors: [],
    publication: { status: 'current', outputPath: 'out.md', novelHash: null, reasons: [] },
  };
}

function treeStubResult(operationId = 'echoed'): RenderGameDialogueTreeResult {
  return {
    operationId,
    tree: { eventScopes: {}, representativePathByEventId: {}, choicesByEventId: {} },
    results: [],
    errors: [],
    editorialErrors: [],
    publication: { status: 'current', outputPath: 'out.md', novelHash: null, reasons: [] },
  };
}

// ─── Coordinator assembly (working-layer validation + expectedVersion) ───────

interface StubDocumentsOptions {
  dirty: boolean;
  digest: string | null;
}

/** Fixture entries with one optional document modified by a content suffix. */
function fixtureEntries(
  modified: { readonly logicalPath: string; readonly suffix: string } | null,
): readonly { readonly logicalPath: string; readonly content: string }[] {
  return FIXTURE.documents.map((document) =>
    modified !== null && document.logicalPath === modified.logicalPath
      ? { logicalPath: document.logicalPath, content: `${document.content}${modified.suffix}` }
      : { logicalPath: document.logicalPath, content: document.content },
  );
}

/** Minimal working-document store double; only the submit/validate surfaces. */
function stubDocuments(
  options: StubDocumentsOptions,
  modifiedState: { value: { readonly logicalPath: string; readonly suffix: string } | null },
): AuthoringWorkingDocumentStore {
  const documents = {
    projectId: 'project-a',
    async isWorkingDirty() {
      return options.dirty;
    },
    async workspaceDigest() {
      return options.digest === null ? null : { digest: options.digest };
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
      return { entries: fixtureEntries(modifiedState.value) };
    },
  } as unknown as AuthoringWorkingDocumentStore;
  return documents;
}

interface CoordinatorHarness {
  coordinator: Awaited<ReturnType<typeof createAuthoringCoordinator>>;
  enqueued: Array<{
    projectId: string;
    capabilityId: string;
    scopes: readonly string[];
    expectedVersion?: number;
    kind: string;
  }>;
  saves: AuthoringStateRecord[];
  setDigest: (digest: string | null) => void;
  /** Modify one materialized fixture document; changes the candidate source hash. */
  setVariant: (logicalPath: string, suffix: string) => void;
}

async function createCoordinatorHarness(
  options: StubDocumentsOptions,
): Promise<CoordinatorHarness> {
  const modifiedState: { value: { readonly logicalPath: string; readonly suffix: string } | null } =
    { value: null };
  const documents = stubDocuments(options, modifiedState);
  const enqueued: CoordinatorHarness['enqueued'] = [];
  const saves: AuthoringStateRecord[] = [];
  const assembly: AuthoringCoordinatorAssembly = {
    projectId: 'project-a',
    materializer: documents,
    documents,
    operationStore: createInMemoryOperationStore(),
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
      async save(record) {
        saves.push(record);
      },
    },
    treeLoader: {
      async loadTree() {
        throw new Error('not used by working validation');
      },
    },
    sessions: {
      async enqueue(input) {
        enqueued.push({
          projectId: input.projectId,
          capabilityId: input.capabilityId,
          scopes: input.scopes,
          ...(input.expectedVersion === undefined
            ? {}
            : { expectedVersion: input.expectedVersion }),
          kind: input.kind,
        });
        return { status: 'completed', operationId: 'op-1' };
      },
    },
    revision: {
      async loadAccepted() {
        return null;
      },
      async submit() {
        return {
          status: 'invalid' as const,
          code: 'STOP',
          reason: 'validation harness stops here',
        };
      },
      async recover() {
        throw new Error('not used by working validation');
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
        throw new Error('not used by working validation');
      },
    },
    sourceViewMaterializer: {
      async inspect() {
        return {
          projectId: 'project-a',
          treeHash: '',
          perPathHashes: [],
          materializedRevisionId: null,
        };
      },
      async materialize() {
        return { status: 'recovery-required' as const, reason: 'not used by working validation' };
      },
    },
    revisionContentStore: {
      async put() {},
      async get() {
        return null;
      },
    },
    events: { publish() {} },
    buildSnapshot: ({ entries }) =>
      buildSourceSnapshot(
        entries.map((entry) => ({
          version: 1 as const,
          logicalPath: entry.logicalPath,
          content: entry.content,
          contentHash: computeSourceDocumentHash(entry.content),
          parseResult: { status: 'parsed' as const, value: null },
          diagnostics: [],
        })),
      ),
    validate() {
      return [];
    },
    async adopt() {
      throw new Error('not used by working validation');
    },
    now: () => '2026-08-02T00:00:00.000Z',
  };
  const coordinator = await createAuthoringCoordinator(assembly);
  return {
    coordinator,
    enqueued,
    saves,
    setDigest: (digest) => {
      options.digest = digest;
    },
    setVariant: (logicalPath, suffix) => {
      modifiedState.value = { logicalPath, suffix };
    },
  };
}

// ─── nova_graph ──────────────────────────────────────────────────────────────

describe('nova_graph', () => {
  it('projects the canonical graph runtime for a strict empty route selector', async () => {
    const { session } = fakeSession({ source: FIXTURE });
    const registry = createProjectSessionMcpRegistry(session);
    const caller = callerFor(grantWith({ capabilityId: 'cap-graph', scopes: [MCP_READ_SCOPE] }));

    const result = await registry.run('nova_graph', caller, {
      version: 1,
      branchPath: { decisions: [] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data;
    if (typeof data !== 'object' || data === null)
      throw new Error('graph result must be an object');
    expect(data).toHaveProperty('version', 1);
    expect(data).toHaveProperty('story');
    expect(data).toHaveProperty('discourse');
    expect(data).toHaveProperty('route');
    const route = (data as { route: { branchPath: { decisions: unknown[] } } }).route;
    expect(route.branchPath.decisions).toEqual([]);
  });

  it('accepts an explicit discourse branch alongside the empty branch path', async () => {
    const { session } = fakeSession({ source: FIXTURE });
    const registry = createProjectSessionMcpRegistry(session);
    const caller = callerFor(grantWith({ capabilityId: 'cap-graph', scopes: [MCP_READ_SCOPE] }));

    const result = await registry.run('nova_graph', caller, {
      version: 1,
      branchPath: { decisions: [] },
      discourseBranch: 'main',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const route = (
      result.data as { route: { branchPath: { decisions: unknown[] }; discourseBranch: string } }
    ).route;
    expect(route.branchPath.decisions).toEqual([]);
    expect(route.discourseBranch).toBe('main');
  });

  it('rejects malformed route selectors before any graph work', async () => {
    const { session } = fakeSession({ source: FIXTURE });
    const registry = createProjectSessionMcpRegistry(session);
    const caller = callerFor(grantWith({ capabilityId: 'cap-graph', scopes: [MCP_READ_SCOPE] }));

    const invalid = [
      {},
      { version: 1 },
      { version: 1, branchPath: { decisions: [] }, extra: true },
      { version: 2, branchPath: { decisions: [] } },
      { version: 1, branchPath: { decisions: 'not-an-array' } },
      { version: 1, branchPath: { decisions: [{ atEventId: 'E0' }] } },
      {
        version: 1,
        branchPath: {
          decisions: [{ atEventId: 'E0', choiceId: 'c', narrativeOrder: '1' }],
        },
      },
      { version: 1, branchPath: { decisions: [] }, discourseBranch: '' },
    ];
    for (const input of invalid) {
      const result = await registry.run('nova_graph', caller, input);
      expectError(result, 'INVALID_INPUT');
    }
  });

  it('answers NO_ACCEPTED_SOURCE without an accepted source', async () => {
    const { session } = fakeSession({ source: null });
    const registry = createProjectSessionMcpRegistry(session);
    const caller = callerFor(grantWith({ capabilityId: 'cap-graph', scopes: [MCP_READ_SCOPE] }));
    expectError(
      await registry.run('nova_graph', caller, { version: 1, branchPath: { decisions: [] } }),
      'NO_ACCEPTED_SOURCE',
    );
  });
});

// ─── nova_revise ─────────────────────────────────────────────────────────────

describe('nova_revise', () => {
  it('forwards bounded instruction and reviewIds into the actual render request', async () => {
    const requests: Array<{ request: EditorialRenderRequestV1; runtime: EditorialRuntime }> = [];
    const { session, detachedOperations } = fakeSession({ source: FIXTURE });
    const service = await createOperationService(session);
    const registry = createProjectSessionMcpRegistry(session, {
      operations: service,
      candidates: {
        execute: async (request, runtime) => {
          requests.push({ request, runtime });
          return { kind: 'failed', result: renderStubResult(request.mutation.operationId) };
        },
        commit: async () => {
          throw new Error('commit must not run for a failed preflight outcome');
        },
      },
    });
    const caller = callerFor(
      grantWith({
        capabilityId: 'cap-revise',
        version: 3,
        scopes: [MCP_RENDER_SCOPE],
      }),
    );

    const result = await registry.run('nova_revise', caller, {
      sceneSelector: { type: 'all' },
      instruction: 'tighten the prose',
      reviewIds: ['review-1', 'review-2'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const operationHandle = (result.data as { operationHandle: string }).operationHandle;
    const terminal = await waitForTerminal(service, operationHandle);
    expect(terminal.status).toBe('succeeded');

    expect(requests).toHaveLength(1);
    expect(requests[0]?.request.revision).toEqual({
      instruction: 'tighten the prose',
      reviewIds: ['review-1', 'review-2'],
    });
    expect(requests[0]?.request.source).toBe(FIXTURE);
    expect(requests[0]?.request.selector).toEqual({ type: 'all' });
    expect(requests[0]?.request.mutation.actorId).toBe('u1');
    expect(requests[0]?.runtime.signal).toBeInstanceOf(AbortSignal);

    // The queued operation carries the capability generation and the revision.
    await waitFor(() => detachedOperations.length === 1, 'revise operation to be created');
    const operation = detachedOperations[0];
    if (operation === undefined) throw new Error('detached revise operation is missing');
    expect(operation.kind).toBe('revise');
    expect(operation.expectedVersion).toBe(3);
    expect(operation.scope).toEqual([MCP_RENDER_SCOPE]);
    const payload = operation.payload;
    if (typeof payload !== 'object' || payload === null) throw new Error('payload missing');
    expect((payload as { revision?: unknown }).revision).toEqual({
      instruction: 'tighten the prose',
      reviewIds: ['review-1', 'review-2'],
    });
    await service.close();
  });

  it('omits revision entirely when neither instruction nor reviewIds is present', async () => {
    const requests: Array<{ request: EditorialRenderRequestV1; runtime: EditorialRuntime }> = [];
    const { session } = fakeSession({ source: FIXTURE });
    const service = await createOperationService(session);
    const registry = createProjectSessionMcpRegistry(session, {
      operations: service,
      candidates: {
        execute: async (request, runtime) => {
          requests.push({ request, runtime });
          return { kind: 'failed', result: renderStubResult(request.mutation.operationId) };
        },
        commit: async () => {
          throw new Error('commit must not run for a failed preflight outcome');
        },
      },
    });
    const caller = callerFor(grantWith({ capabilityId: 'cap-revise', scopes: [MCP_RENDER_SCOPE] }));

    const result = await registry.run('nova_revise', caller, {
      sceneSelector: { type: 'all' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const operationHandle = (result.data as { operationHandle: string }).operationHandle;
    await waitForTerminal(service, operationHandle);
    expect(requests[0]?.request.revision).toBeUndefined();
    await service.close();
  });

  it('rejects unbounded instruction, duplicate reviewIds and unknown fields', async () => {
    const { session, detachedOperations } = fakeSession({ source: FIXTURE });
    const registry = createProjectSessionMcpRegistry(session);
    const caller = callerFor(grantWith({ capabilityId: 'cap-revise', scopes: [MCP_RENDER_SCOPE] }));

    expectError(
      await registry.run('nova_revise', caller, {
        sceneSelector: { type: 'all' },
        instruction: 'x'.repeat(4097),
      }),
      'INVALID_INPUT',
    );
    expectError(
      await registry.run('nova_revise', caller, {
        sceneSelector: { type: 'all' },
        reviewIds: ['a', 'a'],
      }),
      'INVALID_INPUT',
    );
    expectError(
      await registry.run('nova_revise', caller, {
        sceneSelector: { type: 'all' },
        reviewIds: 'not-an-array',
      }),
      'INVALID_INPUT',
    );
    expectError(
      await registry.run('nova_revise', caller, {
        sceneSelector: { type: 'all' },
        revision: { instruction: 'smuggled' },
      }),
      'UNKNOWN_FIELD',
    );
    expect(detachedOperations).toHaveLength(0);
  });

  it('answers NO_ACCEPTED_SOURCE without an accepted source', async () => {
    const { session } = fakeSession({ source: null });
    const registry = createProjectSessionMcpRegistry(session);
    const caller = callerFor(grantWith({ capabilityId: 'cap-revise', scopes: [MCP_RENDER_SCOPE] }));
    expectError(
      await registry.run('nova_revise', caller, { sceneSelector: { type: 'all' } }),
      'NO_ACCEPTED_SOURCE',
    );
  });
});

// ─── nova_render_tree ────────────────────────────────────────────────────────

describe('nova_render_tree', () => {
  it('queues a render-tree operation that calls the dialogue-tree render seam', async () => {
    const requests: Array<{
      request: RenderGameDialogueTreeRequestV1;
      runtime: EditorialRuntime;
    }> = [];
    const { session, detachedOperations } = fakeSession({ source: FIXTURE });
    const service = await createOperationService(session);
    const registry = createProjectSessionMcpRegistry(session, {
      operations: service,
      renderTree: async (request, runtime) => {
        requests.push({ request, runtime });
        return treeStubResult(request.mutation.operationId);
      },
    });
    const caller = callerFor(grantWith({ capabilityId: 'cap-tree', scopes: [MCP_RENDER_SCOPE] }));

    const result = await registry.run('nova_render_tree', caller, {
      sceneSelector: { type: 'all' },
      model: 'mock',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const operationHandle = (result.data as { operationHandle: string }).operationHandle;
    const terminal = await waitForTerminal(service, operationHandle);
    expect(terminal.status).toBe('succeeded');

    expect(requests).toHaveLength(1);
    expect(requests[0]?.request.source).toBe(FIXTURE);
    expect(requests[0]?.request.mutation.actorId).toBe('u1');
    expect(requests[0]?.request.mutation.operationId).toBe(operationHandle);
    expect(requests[0]?.request.model).toBe('mock');
    // The tree request carries no selector/revision (Core schema rejects them).
    expect(requests[0]?.request).not.toHaveProperty('selector');
    expect(requests[0]?.request).not.toHaveProperty('revision');

    await waitFor(() => detachedOperations.length === 1, 'tree operation to be created');
    const operation = detachedOperations[0];
    if (operation === undefined) throw new Error('detached tree operation is missing');
    expect(operation.kind).toBe('render-tree');
    expect(operation.expectedVersion).toBe(1);
    expect(operation.scope).toEqual([MCP_RENDER_SCOPE]);
    expect(service.getResult(operationHandle)).toMatchObject({ operationId: operationHandle });
    await service.close();
  });

  it('shares the strict scene selector with nova_render', async () => {
    const { session, detachedOperations } = fakeSession({ source: FIXTURE });
    const registry = createProjectSessionMcpRegistry(session);
    const caller = callerFor(grantWith({ capabilityId: 'cap-tree', scopes: [MCP_RENDER_SCOPE] }));
    expectError(
      await registry.run('nova_render_tree', caller, {
        sceneSelector: { type: 'events', eventIds: 'not-an-array' },
      }),
      'INVALID_INPUT',
    );
    expect(detachedOperations).toHaveLength(0);
  });
});

// ─── nova_validate layer ─────────────────────────────────────────────────────

describe('nova_validate', () => {
  it('explicitly reports the accepted layer and keeps all existing fields', async () => {
    const { session } = fakeSession({ source: FIXTURE });
    const registry = createProjectSessionMcpRegistry(session);
    const caller = callerFor(grantWith({ capabilityId: 'cap-validate', scopes: [MCP_READ_SCOPE] }));

    const result = await registry.run('nova_validate', caller, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data;
    if (typeof data !== 'object' || data === null) throw new Error('validation result missing');
    expect(data).toHaveProperty('layer', 'accepted');
    expect(data).toHaveProperty('passed');
    expect(typeof (data as { passed: unknown }).passed).toBe('boolean');
    expect(data).toHaveProperty('iss');
    expect(data).toHaveProperty('results');
  });
});

// ─── nova_authoring_validate ─────────────────────────────────────────────────

describe('nova_authoring_validate', () => {
  const workingResult = (
    overrides: Partial<WorkingValidationResultV1> = {},
  ): WorkingValidationResultV1 => ({
    version: 2,
    layer: 'working',
    projectId: 'p1',
    workspaceDigest: 'wd-1',
    acceptedSourceHash: null,
    candidateSourceHash: 'candidate-1',
    passed: true,
    diagnostics: [],
    iss: { overall: 100, target: 100, dimensions: [] },
    results: {},
    ...overrides,
  });

  function coordinatorWith(
    validateWorking: McpAuthoringCoordinatorPort['validateWorking'],
  ): McpAuthoringCoordinatorPort {
    return {
      projectId: 'p1',
      getState: () => ({
        version: 2,
        projectId: 'p1',
        phase: 'working-dirty',
        acceptedRevisionId: null,
        acceptedSourceHash: null,
        pendingOperationId: null,
        workingDirty: true,
        workspaceDigest: 'wd-1',
        externalCandidate: null,
        conflicts: [],
        diagnostics: [],
        canSubmit: true,
        submitBlockReason: 'none',
        generatedAt: '2026-08-02T00:00:00.000Z',
      }),
      getDocument: async () => {
        throw new Error('not used');
      },
      apply: async () => {
        throw new Error('not used');
      },
      submit: async () => {
        throw new Error('not used');
      },
      getOperation: async () => {
        throw new Error('not used');
      },
      resolveConflict: async () => {
        throw new Error('not used');
      },
      validateWorking,
    };
  }

  it('returns the working-layer validation result with all identity fields', async () => {
    const { session } = fakeSession({ source: FIXTURE });
    const registry = createProjectSessionMcpRegistry(session, {
      coordinator: coordinatorWith(async (input) =>
        workingResult({
          workspaceDigest: input.expectedWorkspaceDigest,
          acceptedSourceHash: input.expectedAcceptedSourceHash,
          candidateSourceHash: 'candidate-new',
        }),
      ),
    });
    const caller = callerFor(
      grantWith({ capabilityId: 'cap-authoring', scopes: [MCP_AUTHOR_SCOPE] }),
    );

    const result = await registry.run('nova_authoring_validate', caller, {
      version: 2,
      expectedWorkspaceDigest: 'wd-1',
      expectedAcceptedSourceHash: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data;
    if (typeof data !== 'object' || data === null) throw new Error('result missing');
    expect(data).toMatchObject({
      version: 2,
      layer: 'working',
      projectId: 'p1',
      workspaceDigest: 'wd-1',
      acceptedSourceHash: null,
      candidateSourceHash: 'candidate-new',
      passed: true,
    });
    expect((data as { diagnostics: unknown }).diagnostics).toEqual([]);
    expect(data).toHaveProperty('iss');
    expect(data).toHaveProperty('results');
  });

  it('maps typed coordinator CAS failures to the same error codes', async () => {
    const { session } = fakeSession({ source: FIXTURE });
    const registry = createProjectSessionMcpRegistry(session, {
      coordinator: coordinatorWith(async () => {
        throw new WorkingValidationFailure('WORKSPACE_STALE', 'The working layer changed.');
      }),
    });
    const caller = callerFor(
      grantWith({ capabilityId: 'cap-authoring', scopes: [MCP_AUTHOR_SCOPE] }),
    );

    expectError(
      await registry.run('nova_authoring_validate', caller, {
        version: 2,
        expectedWorkspaceDigest: 'stale-digest',
        expectedAcceptedSourceHash: null,
      }),
      'WORKSPACE_STALE',
    );
  });

  it('fails closed without a coordinator and rejects malformed inputs', async () => {
    const { session } = fakeSession({ source: FIXTURE });
    const caller = callerFor(
      grantWith({ capabilityId: 'cap-authoring', scopes: [MCP_AUTHOR_SCOPE] }),
    );

    // Without a coordinator the tool fails closed before any input work.
    const bare = createProjectSessionMcpRegistry(session);
    expectError(
      await bare.run('nova_authoring_validate', caller, {
        version: 2,
        expectedWorkspaceDigest: 'wd-1',
        expectedAcceptedSourceHash: null,
      }),
      'PROJECT_NOT_READY',
    );

    // With a coordinator, malformed inputs are rejected before the port runs.
    const registry = createProjectSessionMcpRegistry(session, {
      coordinator: coordinatorWith(async () => workingResult()),
    });
    expectError(
      await registry.run('nova_authoring_validate', caller, {
        version: 2,
        expectedWorkspaceDigest: 'wd-1',
      }),
      'INVALID_INPUT',
    );
    expectError(
      await registry.run('nova_authoring_validate', caller, {
        version: 1,
        expectedWorkspaceDigest: 'wd-1',
        expectedAcceptedSourceHash: null,
      }),
      'INVALID_INPUT',
    );
    expectError(
      await registry.run('nova_authoring_validate', caller, {
        version: 2,
        expectedWorkspaceDigest: 42,
        expectedAcceptedSourceHash: null,
      }),
      'INVALID_INPUT',
    );
  });

  it('requires the mcp:author scope', async () => {
    const { session } = fakeSession({ source: FIXTURE });
    const registry = createProjectSessionMcpRegistry(session, {
      coordinator: coordinatorWith(async () => workingResult()),
    });
    const readOnly = callerFor(grantWith({ capabilityId: 'cap-read', scopes: [MCP_READ_SCOPE] }));
    expectError(
      await registry.run('nova_authoring_validate', readOnly, {
        version: 2,
        expectedWorkspaceDigest: 'wd-1',
        expectedAcceptedSourceHash: null,
      }),
      'SCOPE_MISMATCH',
    );
  });
});

// ─── nova_event_state_diff ───────────────────────────────────────────────────

describe('nova_event_state_diff', () => {
  it('returns before/after world state and changed paths for a known event', async () => {
    const { session } = fakeSession({ source: FIXTURE });
    const registry = createProjectSessionMcpRegistry(session);
    const caller = callerFor(grantWith({ capabilityId: 'cap-diff', scopes: [MCP_READ_SCOPE] }));

    const result = await registry.run('nova_event_state_diff', caller, { eventId: 'E0' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data;
    if (typeof data !== 'object' || data === null) throw new Error('diff result missing');
    expect(data).toHaveProperty('eventId', 'E0');
    expect(data).toHaveProperty('before');
    expect(data).toHaveProperty('after');
    expect(data).toHaveProperty('changed');
    expect(Array.isArray((data as { changed: unknown }).changed)).toBe(true);
  });

  it('returns a typed not-found error for an unknown event id', async () => {
    const { session } = fakeSession({ source: FIXTURE });
    const registry = createProjectSessionMcpRegistry(session);
    const caller = callerFor(grantWith({ capabilityId: 'cap-diff', scopes: [MCP_READ_SCOPE] }));

    const result = await registry.run('nova_event_state_diff', caller, {
      eventId: 'NO_SUCH_EVENT',
    });
    expectError(result, 'EVENT_NOT_FOUND');
  });

  it('answers NO_ACCEPTED_SOURCE and rejects malformed input', async () => {
    const { session } = fakeSession({ source: null });
    const registry = createProjectSessionMcpRegistry(session);
    const caller = callerFor(grantWith({ capabilityId: 'cap-diff', scopes: [MCP_READ_SCOPE] }));
    expectError(
      await registry.run('nova_event_state_diff', caller, { eventId: 'E0' }),
      'NO_ACCEPTED_SOURCE',
    );
    const { session: withSource } = fakeSession({ source: FIXTURE });
    const registryWithSource = createProjectSessionMcpRegistry(withSource);
    expectError(await registryWithSource.run('nova_event_state_diff', caller, {}), 'INVALID_INPUT');
    expectError(
      await registryWithSource.run('nova_event_state_diff', caller, { eventId: 'E0', extra: 1 }),
      'UNKNOWN_FIELD',
    );
  });
});

// ─── Coordinator working validation ──────────────────────────────────────────

describe('AuthoringCoordinator.validateWorking', () => {
  it('validates the working layer without freezing, submitting or changing phase', async () => {
    const harness = await createCoordinatorHarness({
      dirty: false,
      digest: 'digest-1',
    });
    const { coordinator } = harness;

    expect(coordinator.getState().phase).toBe('clean');
    const first = await coordinator.validateWorking({
      expectedWorkspaceDigest: 'digest-1',
      expectedAcceptedSourceHash: null,
    });
    expect(first.layer).toBe('working');
    expect(first.projectId).toBe('project-a');
    expect(first.workspaceDigest).toBe('digest-1');
    expect(first.acceptedSourceHash).toBeNull();
    // The unmodified working layer projects the exact accepted fixture hash.
    expect(first.candidateSourceHash).toBe(FIXTURE.sourceHash);
    expect(typeof first.passed).toBe('boolean');
    expect(first.diagnostics).toEqual([]);
    expect(first.iss.overall).toBeGreaterThanOrEqual(0);
    expect(typeof first.results).toBe('object');

    // Accepted layer and phase must be untouched by a pure validation.
    expect(coordinator.getState().acceptedSourceHash).toBeNull();
    expect(coordinator.getState().phase).toBe('clean');
    expect(harness.enqueued).toHaveLength(0);
  });

  it('reports a new candidate hash after the working layer changes, accepted still untouched', async () => {
    const harness = await createCoordinatorHarness({
      dirty: false,
      digest: 'digest-1',
    });
    const { coordinator, setDigest, setVariant } = harness;

    const before = await coordinator.validateWorking({
      expectedWorkspaceDigest: 'digest-1',
      expectedAcceptedSourceHash: null,
    });
    setVariant('chapters/chapter_01/E0_encounter.yaml', '\n# working variant\n');
    setDigest('digest-2');
    const after = await coordinator.validateWorking({
      expectedWorkspaceDigest: 'digest-2',
      expectedAcceptedSourceHash: null,
    });
    expect(after.candidateSourceHash).not.toBe(before.candidateSourceHash);
    expect(coordinator.getState().acceptedSourceHash).toBeNull();
    expect(coordinator.getState().phase).toBe('clean');
  });

  it('fails closed with WORKSPACE_STALE when the client digest is stale', async () => {
    const harness = await createCoordinatorHarness({
      dirty: false,
      digest: 'digest-2',
    });
    const { coordinator } = harness;

    await expect(
      coordinator.validateWorking({
        expectedWorkspaceDigest: 'digest-1',
        expectedAcceptedSourceHash: null,
      }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_STALE' });
  });

  it('fails closed with ACCEPTED_HASH_MISMATCH when the accepted layer moved', async () => {
    const harness = await createCoordinatorHarness({
      dirty: false,
      digest: 'digest-1',
    });
    const { coordinator } = harness;

    await expect(
      coordinator.validateWorking({
        expectedWorkspaceDigest: 'digest-1',
        expectedAcceptedSourceHash: 'some-other-accepted-hash',
      }),
    ).rejects.toMatchObject({ code: 'ACCEPTED_HASH_MISMATCH' });
  });
});

// ─── Mutation expectedVersion wiring ─────────────────────────────────────────

describe('authoring mutation capability generation', () => {
  it('forwards expectedVersion from submit into the session enqueue', async () => {
    const harness = await createCoordinatorHarness({
      dirty: true,
      digest: 'wd-1',
    });
    const { coordinator, enqueued } = harness;

    const receipt = await coordinator.submit({
      expectedAcceptedSourceHash: null,
      expectedWorkspaceDigest: 'wd-1',
      actorId: 'u1',
      capabilityId: 'cap-1',
      capabilityScopes: ['mcp:submit'],
      expectedVersion: 7,
    });
    expect(receipt.status).toBe('failed');
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      projectId: 'project-a',
      capabilityId: 'cap-1',
      scopes: ['mcp:submit'],
      kind: 'submit',
      expectedVersion: 7,
    });
  });
});

// ─── Review & release-gate MCP tools (plan Step 5) ──────────────────────────

const REVIEW_SHA = createHash('sha256').update('review-test').digest('hex');

const FAKE_REVIEW_COMMENT: HostReviewCommentV1 = {
  id: 'rev-1',
  author: 'human',
  actorId: 'u1',
  target: { type: 'scene', id: 'E1' },
  severity: 'blocking',
  category: 'plot_logic',
  content: 'The scene contradicts the established world rules.',
  status: 'open',
  applications: [],
  createdAt: '2026-08-02T00:00:00.000Z',
};

const FAKE_REVIEW_GATE: ReviewGateV1 = {
  gateId: 'gate-1',
  sourceHash: REVIEW_SHA,
  eventId: 'E1',
  proseHash: REVIEW_SHA,
  scopeHash: REVIEW_SHA,
  validationIdentity: 'validator-v1',
  warningFingerprints: ['fp-1'],
  revisionId: 'rev-1',
  openedAt: '2026-08-02T00:00:00.000Z',
  openedBy: 'u1',
  status: 'open',
  decision: null,
};

const FAKE_GATE_RESOLUTION: ReleaseGateResolutionV1 = {
  version: 1,
  projectId: 'p1',
  gateId: 'gate-1',
  eventId: 'E1',
  candidateRevisionId: 'rev-1',
  outcome: 'accepted',
  acceptedRevisionId: 'rev-1',
  decision: {
    status: 'accepted',
    scopeHash: REVIEW_SHA,
    validationIdentity: 'validator-v1',
    reasons: [],
  },
  reason: 'Reviewed and accepted.',
  actorId: 'u1',
  capabilityVersion: 1,
  decidedAt: '2026-08-02T00:00:00.000Z',
};

function fakeReviewPort(overrides: Partial<McpReviewPort> = {}): McpReviewPort {
  return {
    projectId: 'p1',
    listComments: async () => [FAKE_REVIEW_COMMENT],
    getComment: async (commentId) =>
      commentId === FAKE_REVIEW_COMMENT.id ? FAKE_REVIEW_COMMENT : null,
    addComment: async (input, caller) => ({
      ...FAKE_REVIEW_COMMENT,
      id: 'rev-2',
      actorId: caller.grant.userId,
      target: input.target,
      severity: input.severity,
      category: input.category,
      content: input.content,
    }),
    updateComment: async (input) => ({
      ...FAKE_REVIEW_COMMENT,
      id: input.commentId,
      status:
        input.action === 'replace'
          ? 'open'
          : input.action === 'resolve'
            ? 'resolved'
            : input.action === 'wontfix'
              ? 'wontfix'
              : 'open',
    }),
    listGates: async (eventId) =>
      eventId === undefined || FAKE_REVIEW_GATE.eventId === eventId ? [FAKE_REVIEW_GATE] : [],
    decideGate: async (input, caller) => ({
      ...FAKE_GATE_RESOLUTION,
      eventId: input.eventId,
      candidateRevisionId: input.candidateRevisionId,
      reason: input.reason,
      actorId: caller.grant.userId,
    }),
    ...overrides,
  };
}

describe('nova_review_* and nova_release_gate_*', () => {
  it('lists and gets comments with project-scoped filters and an eventId filter', async () => {
    const { session } = fakeSession({ source: FIXTURE });
    const registry = createProjectSessionMcpRegistry(session, {
      review: fakeReviewPort(),
    });
    const caller = callerFor(grantWith({ capabilityId: 'cap-review', scopes: [MCP_READ_SCOPE] }));

    const listed = await registry.run('nova_review_list', caller, {
      version: 1,
      status: 'open',
      severity: 'blocking',
      targetType: 'scene',
      eventId: 'E1',
    });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    // Wire serialization adds explicit nulls for the optional comment fields.
    expect(listed.data).toMatchObject({ version: 1, items: [FAKE_REVIEW_COMMENT] });

    const found = await registry.run('nova_review_get', caller, {
      version: 1,
      commentId: 'rev-1',
    });
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.data).toMatchObject({ version: 1, comment: FAKE_REVIEW_COMMENT });

    const missing = await registry.run('nova_review_get', caller, {
      version: 1,
      commentId: 'rev-999',
    });
    expect(missing.ok).toBe(true);
    if (!missing.ok) return;
    expect(missing.data).toEqual({ version: 1, comment: null });
  });

  it('adds a review comment with the caller grant and no server identity fields', async () => {
    const { session } = fakeSession({ source: FIXTURE });
    const seen: Array<{ input: HostNewReviewCommentV1; caller: McpAuthorizedCaller }> = [];
    const registry = createProjectSessionMcpRegistry(session, {
      review: fakeReviewPort({
        addComment: async (input, caller) => {
          seen.push({ input, caller });
          return { ...FAKE_REVIEW_COMMENT, id: 'rev-2', actorId: caller.grant.userId };
        },
      }),
    });
    const caller = callerFor(
      grantWith({ capabilityId: 'cap-review', userId: 'u-author', scopes: [MCP_AUTHOR_SCOPE] }),
    );
    const result = await registry.run('nova_review_add', caller, {
      version: 1,
      target: { type: 'scene', id: 'E1' },
      severity: 'suggestion',
      category: 'style',
      content: 'Consider tightening this beat.',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(seen).toHaveLength(1);
    expect(seen[0].input).toEqual({
      target: { type: 'scene', id: 'E1' },
      severity: 'suggestion',
      category: 'style',
      content: 'Consider tightening this beat.',
    });
    expect(seen[0].caller.grant.userId).toBe('u-author');
    expect(result.data).toMatchObject({
      version: 1,
      comment: { id: 'rev-2', actorId: 'u-author' },
    });
  });

  it('updates a comment by status action or full replacement', async () => {
    const { session } = fakeSession({ source: FIXTURE });
    const registry = createProjectSessionMcpRegistry(session, {
      review: fakeReviewPort(),
    });
    const caller = callerFor(grantWith({ capabilityId: 'cap-review', scopes: [MCP_AUTHOR_SCOPE] }));
    const resolved = await registry.run('nova_review_update', caller, {
      version: 1,
      commentId: 'rev-1',
      action: 'resolve',
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.data).toMatchObject({
      version: 1,
      comment: { id: 'rev-1', status: 'resolved' },
    });

    const replaced = await registry.run('nova_review_update', caller, {
      version: 1,
      commentId: 'rev-1',
      action: 'replace',
      target: { type: 'scene', id: 'E2' },
      severity: 'nit',
      category: 'pacing',
      content: 'Replacement text.',
    });
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) return;
    expect(replaced.data).toMatchObject({ version: 1, comment: { id: 'rev-1', status: 'open' } });
  });

  it('rejects malformed review input and wrong versions fail closed', async () => {
    const { session } = fakeSession({ source: FIXTURE });
    const registry = createProjectSessionMcpRegistry(session, {
      review: fakeReviewPort(),
    });
    const caller = callerFor(
      grantWith({ capabilityId: 'cap-review', scopes: [MCP_AUTHOR_SCOPE, MCP_READ_SCOPE] }),
    );

    // replace without the required content fields
    expectError(
      await registry.run('nova_review_update', caller, {
        version: 1,
        commentId: 'rev-1',
        action: 'replace',
      }),
      'INVALID_INPUT',
    );
    // a line target requires a line basis
    expectError(
      await registry.run('nova_review_add', caller, {
        version: 1,
        target: { type: 'line', id: 'E1' },
        severity: 'nit',
        category: 'style',
        content: 'Line nit.',
      }),
      'INVALID_INPUT',
    );
    // an unknown action is rejected
    expectError(
      await registry.run('nova_review_update', caller, {
        version: 1,
        commentId: 'rev-1',
        action: 'address',
      }),
      'INVALID_INPUT',
    );
    // wrong version
    expectError(await registry.run('nova_review_list', caller, { version: 2 }), 'INVALID_INPUT');
    // unknown field
    expectError(
      await registry.run('nova_review_list', caller, { version: 1, actorId: 'u1' }),
      'UNKNOWN_FIELD',
    );
    // an unbounded reason is rejected on gate decide (submit-scoped caller)
    const maintainer = callerFor(
      grantWith({ capabilityId: 'cap-review', scopes: [MCP_SUBMIT_SCOPE] }),
    );
    expectError(
      await registry.run('nova_release_gate_decide', maintainer, {
        version: 1,
        eventId: 'E1',
        candidateRevisionId: 'rev-1',
        decision: 'accept',
        reason: 'x'.repeat(4097),
      }),
      'INVALID_INPUT',
    );
  });

  it('fails closed with REVIEW_SERVICE_UNAVAILABLE when the review port is absent', async () => {
    const { session } = fakeSession({ source: FIXTURE });
    const registry = createProjectSessionMcpRegistry(session);
    const caller = callerFor(
      grantWith({
        capabilityId: 'cap-review',
        scopes: [MCP_READ_SCOPE, MCP_AUTHOR_SCOPE, MCP_SUBMIT_SCOPE],
      }),
    );
    for (const [name, input] of [
      ['nova_review_list', { version: 1 }],
      ['nova_review_get', { version: 1, commentId: 'rev-1' }],
      [
        'nova_review_add',
        {
          version: 1,
          target: { type: 'scene', id: 'E1' },
          severity: 'nit',
          category: 'style',
          content: 'x',
        },
      ],
      ['nova_review_update', { version: 1, commentId: 'rev-1', action: 'resolve' }],
      ['nova_release_gate_list', { version: 1 }],
      [
        'nova_release_gate_decide',
        {
          version: 1,
          eventId: 'E1',
          candidateRevisionId: 'rev-1',
          decision: 'accept',
          reason: 'r',
        },
      ],
    ] as const) {
      expectError(await registry.run(name, caller, input), 'REVIEW_SERVICE_UNAVAILABLE');
    }
  });

  it('enforces scopes: a reader cannot add or update, an author cannot decide', async () => {
    const { session } = fakeSession({ source: FIXTURE });
    const registry = createProjectSessionMcpRegistry(session, {
      review: fakeReviewPort(),
    });
    const reader = callerFor(grantWith({ capabilityId: 'cap-review', scopes: [MCP_READ_SCOPE] }));
    expectError(
      await registry.run('nova_review_add', reader, {
        version: 1,
        target: { type: 'scene', id: 'E1' },
        severity: 'nit',
        category: 'style',
        content: 'x',
      }),
      'SCOPE_MISMATCH',
    );
    expectError(
      await registry.run('nova_review_update', reader, {
        version: 1,
        commentId: 'rev-1',
        action: 'resolve',
      }),
      'SCOPE_MISMATCH',
    );
    const author = callerFor(grantWith({ capabilityId: 'cap-review', scopes: [MCP_AUTHOR_SCOPE] }));
    expectError(
      await registry.run('nova_release_gate_decide', author, {
        version: 1,
        eventId: 'E1',
        candidateRevisionId: 'rev-1',
        decision: 'accept',
        reason: 'r',
      }),
      'SCOPE_MISMATCH',
    );
  });

  it('lists release gates with an optional eventId filter', async () => {
    const { session } = fakeSession({ source: FIXTURE });
    const registry = createProjectSessionMcpRegistry(session, {
      review: fakeReviewPort(),
    });
    const caller = callerFor(grantWith({ capabilityId: 'cap-review', scopes: [MCP_READ_SCOPE] }));
    const all = await registry.run('nova_release_gate_list', caller, { version: 1 });
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    // Wire serialization adds explicit nulls for the optional supersede fields.
    expect(all.data).toMatchObject({ version: 1, items: [FAKE_REVIEW_GATE] });
    const filtered = await registry.run('nova_release_gate_list', caller, {
      version: 1,
      eventId: 'E2',
    });
    expect(filtered.ok).toBe(true);
    if (!filtered.ok) return;
    expect(filtered.data).toEqual({ version: 1, items: [] });
  });

  it('decides a release gate through the review port with the maintainer scope', async () => {
    const { session } = fakeSession({ source: FIXTURE });
    const seen: Array<{ caller: McpAuthorizedCaller }> = [];
    const registry = createProjectSessionMcpRegistry(session, {
      review: fakeReviewPort({
        decideGate: async (input, caller) => {
          seen.push({ caller });
          return { ...FAKE_GATE_RESOLUTION, reason: input.reason };
        },
      }),
    });
    const maintainer = callerFor(
      grantWith({ capabilityId: 'cap-review', userId: 'u-maintainer', scopes: [MCP_SUBMIT_SCOPE] }),
    );
    const result = await registry.run('nova_release_gate_decide', maintainer, {
      version: 1,
      eventId: 'E1',
      candidateRevisionId: 'rev-1',
      decision: 'accept',
      reason: 'Approved after review.',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(seen).toHaveLength(1);
    expect(seen[0].caller.grant.userId).toBe('u-maintainer');
    expect(result.data).toMatchObject({
      version: 1,
      resolution: { outcome: 'accepted', acceptedRevisionId: 'rev-1' },
    });
  });
});

// ─── nova_publish / nova_publication_get / nova_publication_read (plan 6.6) ──

describe('nova_publish and nova_publication_*', () => {
  const FAKE_PUBLICATION_RECORD = {
    version: 1,
    projectId: 'p1',
    publicationId: 'canonical',
    kind: 'canonical',
    value: {
      sourceHash: 'a'.repeat(64),
      scopeHash: 'b'.repeat(64),
      revisionIds: ['rev-1'],
      novelHash: 'c'.repeat(64),
      relativeOutputPath: 'output/novel.md',
      byteLength: 42,
      actorId: 'u1',
      operationId: 'op-1',
      createdAt: '2026-08-02T00:00:00.000Z',
      status: 'current',
    },
    updatedAt: '2026-08-02T00:00:00.000Z',
  } as const;

  function fakePublicationPort(
    overrides: {
      publish?: (
        input: PublishPublicationRequestV1,
        caller: McpAuthorizedCaller,
      ) => Promise<PublishEnqueueResultV1>;
      get?: (publicationId: string) => Promise<ProjectPublicationRecordV1 | null>;
      read?: () => Promise<PublicationReadResultV1>;
    } = {},
  ): McpPublicationPort {
    return {
      projectId: 'p1',
      publish:
        overrides.publish ??
        (async (input, caller) => ({
          enqueue: {
            status: 'queued',
            operationHandle: 'op-publish',
            record: {
              version: 1,
              projectId: 'p1',
              operationId: 'op-publish',
              idempotencyKey: 'ik',
              kind: 'publish',
              status: 'queued',
              actorId: caller.grant.userId,
              capabilityVersion: caller.grant.version,
              sourceHash: 'a'.repeat(64),
              acceptedRevisionId: null,
              progress: null,
              resultRef: 'rh',
              errorCode: null,
              createdAt: '2026-08-02T00:00:00.000Z',
              updatedAt: '2026-08-02T00:00:00.000Z',
            },
          },
          publicationId: 'canonical',
          kind: 'canonical',
        })),
      get:
        overrides.get ??
        (async (publicationId) =>
          publicationId === 'canonical'
            ? (FAKE_PUBLICATION_RECORD as unknown as ProjectPublicationRecordV1)
            : null),
      read:
        overrides.read ??
        (async () => ({
          publicationId: 'canonical',
          offset: 0,
          limit: 10,
          content: 'Chapter one.',
          byteLength: 12,
          totalByteLength: 42,
        })),
    };
  }

  it('queues a publish operation through the publication port with the caller grant', async () => {
    const seen: Array<{ input: PublishPublicationRequestV1; caller: McpAuthorizedCaller }> = [];
    const { session } = fakeSession({ source: FIXTURE });
    const registry = createProjectSessionMcpRegistry(session, {
      publication: fakePublicationPort({
        publish: async (input, caller) => {
          seen.push({ input, caller });
          return {
            enqueue: {
              status: 'queued',
              operationHandle: 'op-publish',
              record: FAKE_PUBLICATION_RECORD as unknown as ProjectPublicationRecordV1,
            },
            publicationId: 'canonical',
            kind: 'canonical',
          };
        },
      }),
    });
    const maintainer = callerFor(
      grantWith({ capabilityId: 'cap-publish', scopes: [MCP_SUBMIT_SCOPE] }),
    );
    const result = await registry.run('nova_publish', maintainer, { version: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({ status: 'queued', operationHandle: 'op-publish' });
    expect(seen).toHaveLength(1);
    expect(seen[0].input).toEqual({});
    expect(seen[0].caller.grant.userId).toBe('u1');
  });

  it('forwards branch identity and title to a custom publish request', async () => {
    const seen: Array<{ input: PublishPublicationRequestV1 }> = [];
    const { session } = fakeSession({ source: FIXTURE });
    const registry = createProjectSessionMcpRegistry(session, {
      publication: fakePublicationPort({
        publish: async (input) => {
          seen.push({ input });
          return {
            enqueue: {
              status: 'queued',
              operationHandle: 'op',
              record: FAKE_PUBLICATION_RECORD as unknown as ProjectPublicationRecordV1,
            },
            publicationId: 'custom-id',
            kind: 'custom',
          };
        },
      }),
    });
    const maintainer = callerFor(
      grantWith({ capabilityId: 'cap-publish', scopes: [MCP_SUBMIT_SCOPE] }),
    );
    const result = await registry.run('nova_publish', maintainer, {
      version: 1,
      branchPath: {
        version: 1,
        branchPath: { decisions: [{ atEventId: 'E1', choiceId: 'a', narrativeOrder: 1 }] },
      },
      title: 'Branch Novel',
    });
    expect(result.ok).toBe(true);
    expect(seen[0].input).toEqual({
      branchPath: { decisions: [{ atEventId: 'E1', choiceId: 'a', narrativeOrder: 1 }] },
      title: 'Branch Novel',
    });
  });

  it('rejects malformed publish input and enforces the submit scope', async () => {
    const { session } = fakeSession({ source: FIXTURE });
    const registry = createProjectSessionMcpRegistry(session, {
      publication: fakePublicationPort(),
    });
    const maintainer = callerFor(
      grantWith({ capabilityId: 'cap-publish', scopes: [MCP_SUBMIT_SCOPE] }),
    );
    const author = callerFor(grantWith({ capabilityId: 'cap-author', scopes: [MCP_AUTHOR_SCOPE] }));
    expectError(await registry.run('nova_publish', maintainer, { version: 2 }), 'INVALID_INPUT');
    expectError(
      await registry.run('nova_publish', maintainer, { version: 1, unknown: true }),
      'UNKNOWN_FIELD',
    );
    expectError(
      await registry.run('nova_publish', maintainer, {
        version: 1,
        branchPath: {
          version: 1,
          branchPath: { decisions: [{ atEventId: 'E1', choiceId: 'a', narrativeOrder: 1 }] },
          discourseBranch: 'x',
        },
        discourseBranch: 'y',
      }),
      'INVALID_INPUT',
    );
    expectError(
      await registry.run('nova_publish', maintainer, { version: 1, title: '' }),
      'INVALID_INPUT',
    );
    expectError(await registry.run('nova_publish', author, { version: 1 }), 'SCOPE_MISMATCH');
  });

  it('fails closed without an accepted source or without the publication port', async () => {
    const { session } = fakeSession({ source: null });
    const registry = createProjectSessionMcpRegistry(session, {
      publication: fakePublicationPort(),
    });
    const maintainer = callerFor(
      grantWith({ capabilityId: 'cap-publish', scopes: [MCP_SUBMIT_SCOPE] }),
    );
    expectError(
      await registry.run('nova_publish', maintainer, { version: 1 }),
      'NO_ACCEPTED_SOURCE',
    );

    const { session: sourced } = fakeSession({ source: FIXTURE });
    const bare = createProjectSessionMcpRegistry(sourced);
    expectError(
      await bare.run('nova_publish', maintainer, { version: 1 }),
      'PUBLICATION_UNAVAILABLE',
    );
    const reader = callerFor(grantWith({ capabilityId: 'cap-read', scopes: [MCP_READ_SCOPE] }));
    expectError(
      await bare.run('nova_publication_get', reader, { version: 1, publicationId: 'canonical' }),
      'PUBLICATION_UNAVAILABLE',
    );
  });

  it('gets one publication record and maps a missing record to an explicit null', async () => {
    const { session } = fakeSession({ source: FIXTURE });
    const registry = createProjectSessionMcpRegistry(session, {
      publication: fakePublicationPort(),
    });
    const reader = callerFor(grantWith({ capabilityId: 'cap-read', scopes: [MCP_READ_SCOPE] }));
    const found = await registry.run('nova_publication_get', reader, {
      version: 1,
      publicationId: 'canonical',
    });
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.data).toMatchObject({
      version: 1,
      publication: {
        publicationId: 'canonical',
        kind: 'canonical',
        value: { relativeOutputPath: 'output/novel.md', status: 'current' },
      },
    });

    const missing = await registry.run('nova_publication_get', reader, {
      version: 1,
      publicationId: 'nope',
    });
    expect(missing.ok).toBe(true);
    if (!missing.ok) return;
    expect(missing.data).toEqual({ version: 1, publication: null });
  });

  it('reads a bounded markdown slice and rejects unbounded reads', async () => {
    const { session } = fakeSession({ source: FIXTURE });
    const registry = createProjectSessionMcpRegistry(session, {
      publication: fakePublicationPort(),
    });
    const reader = callerFor(grantWith({ capabilityId: 'cap-read', scopes: [MCP_READ_SCOPE] }));
    const result = await registry.run('nova_publication_read', reader, {
      version: 1,
      publicationId: 'canonical',
      offset: 0,
      limit: 10,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      version: 1,
      publicationId: 'canonical',
      offset: 0,
      limit: 10,
      content: 'Chapter one.',
      totalByteLength: 42,
    });

    expectError(
      await registry.run('nova_publication_read', reader, {
        version: 1,
        publicationId: 'canonical',
        offset: -1,
        limit: 10,
      }),
      'INVALID_INPUT',
    );
    expectError(
      await registry.run('nova_publication_read', reader, {
        version: 1,
        publicationId: 'canonical',
        offset: 0,
        limit: 256 * 1024 + 1,
      }),
      'INVALID_INPUT',
    );
    expectError(
      await registry.run('nova_publication_read', reader, {
        version: 1,
        publicationId: 'x'.repeat(129),
        offset: 0,
        limit: 10,
      }),
      'INVALID_INPUT',
    );
  });
});

// ─── HostReviewService over the Core review stream (plan Step 5) ─────────────

function reviewSession(source: ProjectSourceSnapshotV1): {
  session: ProjectSession;
  execution: MemoryExecutionRepository;
} {
  const execution = new MemoryExecutionRepository();
  const session: ProjectSession = {
    projectId: 'p1',
    runtime: {
      projectId: 'p1',
      services: {
        execution,
        clock: { now: () => '2026-08-02T00:00:00.000Z' },
        ids: { next: () => `test-id-${Math.random()}` },
      } as CoreRuntimeServices,
      compile: (snapshot) => compileProject(snapshot),
      has: () => false,
      memoizedHashes: [],
      memoSize: 0,
    } as ProjectCoreRuntime,
    source,
    projection: makeProjection(source),
    busy: false,
    hasHumanPresence: false,
    presenceGeneration: 0,
    refreshSource: () => {
      throw new Error('refreshSource is not exercised by the review service');
    },
    updatePresence: () => {
      throw new Error('updatePresence is not exercised by the review service');
    },
    adoptSourceWithinOperation: () => {
      throw new Error('adoptSourceWithinOperation is not exercised by the review service');
    },
    enqueueOperation: async () => {
      throw new Error('enqueueOperation is not exercised by the review service');
    },
    enqueueDetachedOperation: async () => {
      throw new Error('enqueueDetachedOperation is not exercised by the review service');
    },
  } as ProjectSession;
  return { session, execution };
}

describe('HostReviewService over the Core review stream', () => {
  it('records review mutations as durable operation records under the caller grant', async () => {
    const { session } = reviewSession(FIXTURE);
    const store = createInMemoryOperationStore();
    const service = createHostReviewService({ projectId: 'p1', session, operationStore: store });
    const caller = callerFor(grantWith({ userId: 'u-42', version: 3, scopes: [MCP_AUTHOR_SCOPE] }));

    const comment = await service.addComment(
      {
        target: { type: 'scene', id: 'E1' },
        severity: 'suggestion',
        category: 'style',
        content: 'Consider tightening this beat.',
      },
      caller as McpAuthorizedCaller,
    );
    expect(comment.status).toBe('open');
    expect(comment.actorId).toBe('u-42');

    let records: ProjectOperationRecordV1[] = await store.list({ projectId: 'p1' });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: 'review',
      status: 'succeeded',
      actorId: 'u-42',
      capabilityVersion: 3,
      sourceHash: FIXTURE.sourceHash,
    });

    await service.updateComment(
      { action: 'resolve', commentId: comment.id },
      caller as McpAuthorizedCaller,
    );
    records = await store.list({ projectId: 'p1' });
    expect(records).toHaveLength(2);
    expect(
      records.every((record) => record.kind === 'review' && record.status === 'succeeded'),
    ).toBe(true);
  });

  it('resolves a release gate through Core with zero provider calls and records a release-gate operation', async () => {
    const { session, execution } = reviewSession(FIXTURE);
    const store = createInMemoryOperationStore();
    const service = createHostReviewService({ projectId: 'p1', session, operationStore: store });
    // The runtime carries no provider at all — any provider access would fail
    // the resolution instead of succeeding.
    const revisionId = 'candidate-rev-1';
    const eventId = 'E1';
    const proseHash = createHash('sha256').update('prose').digest('hex');
    const scopeHash = createHash('sha256').update('scope').digest('hex');
    const validationIdentity = 'validator-v1';
    const gateId = computeReleaseGateId({
      projectId: 'p1',
      sourceHash: FIXTURE.sourceHash,
      eventId,
      proseHash,
      scopeHash,
      validationIdentity,
      warnings: [],
    });
    // Archive the pending candidate envelope (append-only scene revision).
    const archived = await execution.compareAndSwapSceneRevision({
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
        value: {
          version: 1,
          revisionId,
          parentRevisionId: null,
          operationId: 'op-1',
          planHash: createHash('sha256').update('plan').digest('hex'),
          actorId: 'renderer',
          eventId,
          origin: 'llm_draft',
          prose: 'The morning light filtered through the tall windows.',
          proseHash,
          sceneHash: createHash('sha256').update('scene').digest('hex'),
          editorialBasisHash: createHash('sha256').update('basis').digest('hex'),
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
          promptHash: createHash('sha256').update('prompt').digest('hex'),
          providerCalls: [],
          promotionReadSet: [],
          requestRecords: [],
          createdAt: '2026-08-02T00:00:00.000Z',
        } as unknown as JsonValue,
      },
    });
    expect(archived.kind).toBe('committed');

    const caller = callerFor(
      grantWith({ userId: 'u-maintainer', version: 2, scopes: [MCP_SUBMIT_SCOPE] }),
    );
    const resolution = await service.decideGate(
      {
        eventId,
        candidateRevisionId: revisionId,
        decision: 'accept',
        reason: 'Approved after review.',
      },
      caller as McpAuthorizedCaller,
    );
    expect(resolution.outcome).toBe('accepted');
    expect(resolution.acceptedRevisionId).toBe(revisionId);

    const records: ProjectOperationRecordV1[] = await store.list({ projectId: 'p1' });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: 'release-gate',
      status: 'succeeded',
      actorId: 'u-maintainer',
      capabilityVersion: 2,
      acceptedRevisionId: revisionId,
    });
    // The accepted head advanced to the candidate through the detached CAS.
    const head = await execution.readAcceptedScene({ projectId: 'p1', eventId });
    expect(head?.value.revisionId).toBe(revisionId);
  });

  it('projects real review counts for nova_status from the append-only stream', async () => {
    const { session, execution } = reviewSession(FIXTURE);
    const store = createInMemoryOperationStore();
    const service = createHostReviewService({ projectId: 'p1', session, operationStore: store });
    expect(await service.workflowReviewProjection()).toEqual({
      open: 0,
      blocking: 0,
      pendingGates: 0,
    });
    const caller = callerFor(grantWith({ userId: 'u1', scopes: [MCP_AUTHOR_SCOPE] }));
    await service.addComment(
      {
        target: { type: 'novel', id: 'novel' },
        severity: 'blocking',
        category: 'plot_logic',
        content: 'Blocking issue.',
      },
      caller as McpAuthorizedCaller,
    );
    await service.addComment(
      {
        target: { type: 'scene', id: 'E2' },
        severity: 'nit',
        category: 'style',
        content: 'Tiny nit.',
      },
      caller as McpAuthorizedCaller,
    );
    expect(await service.workflowReviewProjection()).toEqual({
      open: 2,
      blocking: 1,
      pendingGates: 0,
    });

    // An open (pending) gate blocks release independently of comments.
    const appended = await execution.appendReviewEvents({
      projectId: 'p1',
      expectedVersion: 2,
      events: [
        {
          version: 1,
          projectId: 'p1',
          kind: 'gate_opened',
          gateId: 'gate-1',
          payload: {
            gate: {
              gateId: 'gate-1',
              sourceHash: FIXTURE.sourceHash,
              eventId: 'E1',
              proseHash: REVIEW_SHA,
              scopeHash: REVIEW_SHA,
              validationIdentity: 'validator-v1',
              warningFingerprints: ['fp-1'],
              revisionId: 'rev-1',
            },
          } as unknown as JsonValue,
          actorId: 'renderer',
          createdAt: '2026-08-02T00:00:00.000Z',
        },
      ],
    });
    expect(appended.kind).toBe('committed');
    expect(await service.workflowReviewProjection()).toEqual({
      open: 2,
      blocking: 2,
      pendingGates: 1,
    });
  });

  it('wires the live review projection into nova_status review counts', async () => {
    const { session } = reviewSession(FIXTURE);
    const store = createInMemoryOperationStore();
    const service = createHostReviewService({ projectId: 'p1', session, operationStore: store });
    const registry = createProjectSessionMcpRegistry(session, {
      review: service,
      status: { review: () => service.workflowReviewProjection() },
    });
    const caller = callerFor(
      grantWith({ userId: 'u1', scopes: [MCP_READ_SCOPE, MCP_AUTHOR_SCOPE] }),
    );
    const added = await registry.run('nova_review_add', caller, {
      version: 1,
      target: { type: 'novel', id: 'novel' },
      severity: 'suggestion',
      category: 'style',
      content: 'A suggestion.',
    });
    expect(added.ok).toBe(true);
    const statusResult = await registry.run('nova_status', caller, {});
    expect(statusResult.ok).toBe(true);
    if (!statusResult.ok) return;
    expect((statusResult.data as WorkflowStatusV1).review).toEqual({
      open: 1,
      blocking: 0,
      pendingGates: 0,
    });
  });
});

// ─── nova_status plugin activation health (plan 7.3) ─────────────────────────

describe('nova_status plugin activation health', () => {
  it('adds a PLUGIN_BLOCKED blocker and health guidance when a required plugin is blocked', async () => {
    const { session } = reviewSession(FIXTURE);
    const registry = createProjectSessionMcpRegistry(session, {
      plugins: {
        hooksManager: null,
        active: [],
        blocked: [
          {
            name: 'novelty-validator',
            reason: 'Required plugin failed trusted identity verification: module hash mismatch',
          },
        ],
        disabled: [{ name: 'archiver', reason: 'not present in the trusted plugin allowlist' }],
      },
    });
    const caller = callerFor(grantWith({ userId: 'u1', scopes: [MCP_READ_SCOPE] }));
    const result = await registry.run('nova_status', caller, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const status = result.data as WorkflowStatusV1;
    expect(status.blockers.some((blocker) => blocker.code === 'PLUGIN_BLOCKED')).toBe(true);
    expect(status.blockers.some((blocker) => blocker.message.includes('novelty-validator'))).toBe(
      true,
    );
    expect(status.guidance.startsWith('Plugin health: 0 active, 1 blocked, 1 disabled.')).toBe(
      true,
    );
    // Plugin blockers never invent next actions; the deterministic chain is
    // untouched and the wire shape is unchanged.
    expect(status.version).toBe(1);
    expect(status.nextActions.some((next) => next.code === 'RENDER')).toBe(true);
  });

  it('names active/disabled health in guidance when every required plugin activated', async () => {
    const { session } = reviewSession(FIXTURE);
    const registry = createProjectSessionMcpRegistry(session, {
      plugins: {
        hooksManager: null,
        active: [
          {
            name: 'novelty-validator',
            version: '1.0.0',
            manifestHash: 'manifest-hash',
            moduleHash: 'module-hash',
            hookNames: ['onLoad'],
            validatorNames: ['novelty-validator'],
            required: true,
          },
        ],
        blocked: [],
        disabled: [{ name: 'archiver', reason: 'not trusted' }],
      },
    });
    const caller = callerFor(grantWith({ userId: 'u1', scopes: [MCP_READ_SCOPE] }));
    const result = await registry.run('nova_status', caller, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const status = result.data as WorkflowStatusV1;
    expect(status.guidance.startsWith('Plugin health: 1 active, 0 blocked, 1 disabled.')).toBe(
      true,
    );
    expect(status.blockers.some((blocker) => blocker.code === 'PLUGIN_BLOCKED')).toBe(false);
  });

  it('omits plugin health entirely when plugins were never activated', async () => {
    const { session } = reviewSession(FIXTURE);
    const registry = createProjectSessionMcpRegistry(session);
    const caller = callerFor(grantWith({ userId: 'u1', scopes: [MCP_READ_SCOPE] }));
    const result = await registry.run('nova_status', caller, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const status = result.data as WorkflowStatusV1;
    expect(status.guidance.startsWith('Plugin health:')).toBe(false);
    expect(status.blockers.some((blocker) => blocker.code === 'PLUGIN_BLOCKED')).toBe(false);
  });
});

// ─── nova_event_state_diff through the state projection service (plan 8.4) ──

describe('nova_event_state_diff through the state projection service', () => {
  /** A session double whose runtime carries the full Core runtime surface. */
  function projectionSession(): { session: ProjectSession; services: CoreRuntimeServices } {
    const services = {
      execution: new MemoryExecutionRepository(),
      renderCache: new MemoryRenderCacheRepository(),
      stateLog: new MemoryStateLogRepository(),
      stateSnapshots: new MemoryStateSnapshotRepository(),
      promptTemplates: { get: async () => null },
      clock: { now: () => '2026-08-02T00:00:00.000Z' },
      ids: { next: () => `test-id-${Math.random()}` },
      llm: {},
    } as unknown as CoreRuntimeServices;
    const runtime = createProjectCoreRuntime({ projectId: 'p1', services });
    const session: ProjectSession = {
      projectId: 'p1',
      runtime,
      source: FIXTURE,
      projection: makeProjection(FIXTURE),
      busy: false,
      hasHumanPresence: false,
      presenceGeneration: 0,
      refreshSource: () => {
        throw new Error('refreshSource is not exercised by the diff projection test');
      },
      updatePresence: () => {
        throw new Error('updatePresence is not exercised by the diff projection test');
      },
      adoptSourceWithinOperation: () => {
        throw new Error('adoptSourceWithinOperation is not exercised by the diff projection test');
      },
      enqueueOperation: async () => {
        throw new Error('enqueueOperation is not exercised by the diff projection test');
      },
      enqueueDetachedOperation: async () => {
        throw new Error('enqueueDetachedOperation is not exercised by the diff projection test');
      },
    } as ProjectSession;
    return { session, services };
  }

  it('returns before/after/changed identical to diffEvent for a sampled fixture', async () => {
    const { session } = projectionSession();
    const projection = createCanonicalStateProjectionService({
      projectId: 'p1',
      runtime: session.runtime,
      snapshotInterval: 3,
    });
    const registry = createProjectSessionMcpRegistry(session, { stateProjection: projection });
    const caller = callerFor(grantWith({ capabilityId: 'cap-diff', scopes: [MCP_READ_SCOPE] }));

    const eventIds = compileProject(FIXTURE).events.map((event) => event.id);
    expect(eventIds.length).toBeGreaterThan(0);
    for (const eventId of eventIds) {
      const result = await registry.run('nova_event_state_diff', caller, { eventId });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      const raw = diffEvent(FIXTURE, eventId);
      expect(raw).not.toBeNull();
      if (raw === null) continue;
      expect(result.data).toEqual({
        eventId,
        before: raw.before,
        after: raw.after,
        changed: raw.changed,
      });
    }

    // Unknown events still answer the typed not-found error through the service.
    const missing = await registry.run('nova_event_state_diff', caller, {
      eventId: 'NO_SUCH_EVENT',
    });
    expectError(missing, 'EVENT_NOT_FOUND');
  });

  it('falls back to the raw diffEvent path when the service is not wired', async () => {
    const { session } = fakeSession({ source: FIXTURE });
    const registry = createProjectSessionMcpRegistry(session);
    const caller = callerFor(grantWith({ capabilityId: 'cap-diff', scopes: [MCP_READ_SCOPE] }));
    const result = await registry.run('nova_event_state_diff', caller, { eventId: 'E0' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.data as { eventId: string }).eventId).toBe('E0');
  });
});
