import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CoreRuntimeServices,
  JsonValue,
  NovelValidationResult,
  ProjectCoreRuntime,
  ProjectSourceSnapshotV1,
  ValidationIssue,
  WorkflowStatusV1,
} from '@novalistically/core';
import { compileProject, PluginExtensionSchemaRegistrar } from '@novalistically/core';
import type {
  EditorialRenderRequestV1,
  EditorialRuntime,
  RenderNovelResult,
} from '@novalistically/core/editorial';
import { buildSourceSnapshot, computeSourceDocumentHash } from '@novalistically/core/source';
import {
  DEFAULT_WORKBENCH_AGENT_CONFIGURATION,
  DEFAULT_WORKBENCH_OPERATION_LIMITS,
  DEFAULT_WORKBENCH_REFERENCE_LIMITS,
  DEFAULT_WORKBENCH_RENDER_POLICY,
  MCP_TOOL_CATALOG_V1,
  type McpReferencePort,
} from '@novalistically/workbench-protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AuthoringStateV1,
  McpAuthoringApplyOutputV1,
  McpAuthoringSubmitOutputV1,
  McpOperationGetOutputV1,
} from '../src/contracts/authoring.js';
import type { ConfigOperationReceiptV1 } from '../src/contracts/configuration.js';
import type { ProjectOperationRecordV1 } from '../src/contracts/persistence.js';
import {
  type AgentCapabilityGrant,
  AgentCapabilityService,
  createCapabilityPersistence,
} from '../src/host/agent/index.js';
import type { AuthoringRevisionPort } from '../src/host/authoring/types.js';
import {
  createMcpAuthorizationPort,
  DeviceGrantPersistenceError,
  MCP_AUTH_FAILURE_STATUS,
  type McpAuthFailureCode,
  type McpAuthorizationResult,
  type McpAuthorizeInput,
  mcpAuthFailureStatus,
} from '../src/host/mcp/auth.js';
import {
  createDeviceVerifierPersistence,
  createMcpDevicePairingService,
  type McpDevicePairingService,
} from '../src/host/mcp/index.js';
import {
  buildWorkflowStatusForSession,
  createProjectSessionMcpRegistry,
  MCP_ADMIN_SCOPE,
  MCP_AUTHOR_SCOPE,
  MCP_READ_SCOPE,
  MCP_REFERENCE_READ_SCOPE,
  MCP_RENDER_SCOPE,
  MCP_SUBMIT_SCOPE,
  type McpAdminConfigurationPort,
  type McpAdminPort,
  type McpAuthoringCoordinatorPort,
  type McpJsonInputSchema,
  type McpJsonSchemaProperty,
  type McpToolResult,
} from '../src/host/mcp/registry.js';
import {
  createProjectOperationService,
  type ProjectOperationService,
} from '../src/host/operation-service.js';
import { ProjectAccessService } from '../src/host/project-access-service.js';
import {
  createProjectSession,
  type ProjectSession,
  type ProjectSessionProjectionV1,
  type SessionAuditRecord,
  type SessionDetachedOperation,
  type SessionDetachedOperationResult,
  type SessionDetachedOperationRunContext,
  type SessionOperation,
  type SessionOperationResult,
} from '../src/host/project-session.js';
import { createProjectOperationStore } from '../src/persistence/project-operation-store.js';

import { createRealPersistence, type RealPersistenceHarness } from './helpers/real-persistence.js';

const MCP_TOOL_AUTHORING_STATUS = 'nova_authoring_status';
const MCP_TOOL_AUTHORING_DOCUMENT_READ = 'nova_authoring_document_read';
const MCP_TOOL_AUTHORING_DOCUMENT_EDIT = 'nova_authoring_document_edit';
const MCP_TOOL_AUTHORING_SUBMIT = 'nova_authoring_submit';
const MCP_TOOL_OPERATION_GET = 'nova_operation_get';
const MCP_TOOL_CONFLICT_RESOLVE = 'nova_conflict_resolve';
const MCP_TOOL_ADMIN_CONFIG_PREVIEW = 'nova_admin_config_preview';
const MCP_TOOL_ADMIN_CONFIG_APPLY = 'nova_admin_config_apply';

// ─── Real compilable project snapshot (zhu-fu fixture) ───────────────────────

const FIXTURE_ROOT = fileURLToPath(new URL('../../../fixtures/zhu-fu', import.meta.url));

/** Materialize the version-controlled zhu-fu project into an immutable snapshot. */
function materializeFixture(root: string): ProjectSourceSnapshotV1 {
  const documents: ProjectSourceSnapshotV1['documents'] = [];
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

/** Planned event ids of the zhu-fu fixture in canonical compile order. */
const FIXTURE_EVENT_IDS = compileProject(FIXTURE).events.map((event) => event.id);

function fixtureDocument(logicalPath: string): ProjectSourceSnapshotV1['documents'][number] {
  const document = FIXTURE.documents.find((candidate) => candidate.logicalPath === logicalPath);
  if (!document) throw new Error(`Fixture document not found: ${logicalPath}`);
  return document;
}

/** Fresh snapshot with one document's content replaced (new content identity). */
function withContent(
  snapshot: ProjectSourceSnapshotV1,
  logicalPath: string,
  content: string,
): ProjectSourceSnapshotV1 {
  return buildSourceSnapshot([
    ...snapshot.documents.filter((document) => document.logicalPath !== logicalPath),
    {
      version: 1,
      logicalPath,
      content,
      contentHash: computeSourceDocumentHash(content),
      parseResult: { status: 'parsed', value: null },
      diagnostics: [],
    },
  ]);
}

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

/**
 * Session double runtime: real deterministic `compileProject` over the
 * accepted snapshot, a stub execution repository (no accepted scenes unless a
 * test overrides it), and a fixed Host clock. `nova_status` compiles the
 * accepted source and reads per-event execution state; every other tool keeps
 * working exactly as before.
 */
function fakeRuntime(
  _source: ProjectSourceSnapshotV1 | null,
  overrides: {
    readonly readAcceptedScene?: (input: {
      readonly projectId: string;
      readonly eventId: string;
    }) => Promise<unknown>;
  } = {},
): ProjectCoreRuntime {
  return {
    projectId: 'p1',
    services: {
      execution: {
        readAcceptedScene: overrides.readAcceptedScene ?? (async () => null),
      },
      clock: { now: () => '2026-08-02T00:00:00.000Z' },
    } as CoreRuntimeServices,
    compile: (snapshot) => compileProject(snapshot),
    has: () => false,
    memoizedHashes: [],
    memoSize: 0,
  } as ProjectCoreRuntime;
}

interface FakeSessionOptions {
  source: ProjectSourceSnapshotV1 | null;
  enqueue?: (operation: SessionOperation) => Promise<SessionOperationResult>;
  /** Canned outcome for the two-phase detached lane; defaults to running the phases. */
  detached?: (
    operation: SessionDetachedOperation<unknown, unknown, unknown>,
  ) => Promise<SessionDetachedOperationResult<unknown>>;
  readAcceptedScene?: (input: {
    readonly projectId: string;
    readonly eventId: string;
  }) => Promise<unknown>;
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
    runtime: fakeRuntime(options.source, {
      readAcceptedScene: options.readAcceptedScene,
    }),
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
    enqueueOperation: async (operation) => {
      operations.push(operation);
      if (options.enqueue) return options.enqueue(operation);
      throw new Error('enqueueOperation was not configured for this session double');
    },
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

function callerFor(grant: AgentCapabilityGrant, sessionId = 'session-live') {
  return { sessionId, userId: grant.userId, grant };
}

// ─── Durable operation service fixture (render tools now enqueue) ───────────

const trackedHarnesses: RealPersistenceHarness[] = [];

afterEach(() => {
  const pending = [...trackedHarnesses];
  trackedHarnesses.length = 0;
  for (const harness of pending) void harness.dispose();
});

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

async function waitForTerminal(
  service: ProjectOperationService,
  operationId: string,
): Promise<ProjectOperationRecordV1> {
  let record: ProjectOperationRecordV1 | null = null;
  await waitFor(async () => {
    record = await service.get(operationId);
    return record !== null && record.status !== 'queued' && record.status !== 'running';
  }, `operation ${operationId} to reach a terminal status`);
  if (record === null) throw new Error(`operation ${operationId} disappeared`);
  return record;
}

async function createOperationService(
  session: ProjectSession,
  overrides: { readonly maxQueuedPerProject?: number } = {},
): Promise<{ service: ProjectOperationService; harness: RealPersistenceHarness }> {
  const harness = createRealPersistence();
  trackedHarnesses.push(harness);
  const service = createProjectOperationService({
    projectId: session.projectId,
    store: createProjectOperationStore(harness.client),
    session,
    limits: {
      maxQueuedPerProject: overrides.maxQueuedPerProject ?? 64,
      maxConcurrentRendersPerHost: 2,
    },
  });
  await service.start();
  return { service, harness };
}

function stubRenderResult(operationId: string): RenderNovelResult {
  return {
    operationId,
    results: [],
    errors: [],
    editorialErrors: [],
    publication: { status: 'current', outputPath: 'out.md', novelHash: null, reasons: [] },
  };
}

function gate(): { promise: Promise<void>; release: () => void } {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, release: resolve };
}

function grantWith(
  overrides: Partial<AgentCapabilityGrant> &
    Pick<AgentCapabilityGrant, 'userId' | 'projectId' | 'scopes'>,
): AgentCapabilityGrant {
  return {
    capabilityId: 'cap-1',
    version: 1,
    expiresAt: '2099-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function expectError(result: McpToolResult, code: string): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe(code);
}

/** Narrow the enqueue wire payload to its operation handle (checked access, no cast). */
function enqueueHandle(data: JsonValue): string {
  if (
    data !== null &&
    typeof data === 'object' &&
    !Array.isArray(data) &&
    'operationHandle' in data &&
    typeof data.operationHandle === 'string'
  ) {
    return data.operationHandle;
  }
  throw new Error(`enqueue payload is missing a string operationHandle: ${JSON.stringify(data)}`);
}

// ─── Scoped authoring/admin tool doubles ─────────────────────────────────────

const FAKE_AUTHORING_STATE: AuthoringStateV1 = {
  version: 2,
  projectId: 'p1',
  phase: 'clean',
  acceptedRevisionId: null,
  acceptedSourceHash: null,
  pendingOperationId: null,
  workingDirty: false,
  workspaceDigest: null,
  externalCandidate: null,
  conflicts: [],
  diagnostics: [],
  canSubmit: false,
  submitBlockReason: 'not-dirty',
  generatedAt: '2026-08-02T00:00:00.000Z',
};

const FAKE_RECEIPT = {
  version: 2,
  operationId: 'op-1',
  projectId: 'p1',
  kind: 'submit' as const,
  status: 'queued' as const,
  acceptedSourceHash: null,
  acceptedRevisionId: null,
  pendingOperationId: null,
  revisionId: null,
  receiptHash: null,
  errorCode: null,
  createdAt: '2026-08-02T00:00:00.000Z',
  updatedAt: '2026-08-02T00:00:00.000Z',
};

function fakeCoordinator(
  overrides: Partial<McpAuthoringCoordinatorPort> = {},
): McpAuthoringCoordinatorPort {
  return {
    projectId: 'p1',
    getState: () => FAKE_AUTHORING_STATE,
    getDocument: async () => ({
      version: 2,
      projectId: 'p1',
      documentId: 'doc-1',
      logicalPath: 'nova.yaml',
      available: true,
      stateVectorHash: 'svh-1',
      acceptedSourceHash: 'ash-1',
    }),
    apply: async () => ({ status: 'applied', workspaceDigest: 'wd-2', stateVectorHash: 'svh-2' }),
    readDocument: async () => ({
      version: 2,
      documentId: 'doc-1',
      logicalPath: 'nova.yaml',
      offset: 0,
      limit: 64,
      content: 'document text',
      totalLength: 13,
      contentHash: 'content-hash',
      stateVectorHash: 'svh-1',
      workspaceDigest: 'wd-1',
      acceptedSourceHash: 'ash-1',
    }),
    editDocument: async () => ({
      status: 'applied',
      workspaceDigest: 'wd-2',
      stateVectorHash: 'svh-2',
    }),
    submit: async () => ({ status: 'queued', receipt: FAKE_RECEIPT }),
    getOperation: async () => ({ version: 2, operationId: 'op-1', receipt: FAKE_RECEIPT }),
    resolveConflict: async () => ({ status: 'completed', receipt: FAKE_RECEIPT }),
    validateWorking: async () => ({
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
    }),
    ...overrides,
  };
}

const FAKE_CONFIG_REQUEST = {
  version: 1,
  expectedRevision: 'rev-1',
  configuration: {
    version: 1,
    projects: [{ projectId: 'p1', displayName: 'Project One' }],
    defaultProjectId: 'p1',
    provider: { kind: 'pi', baseUrl: null, model: null },
    network: {
      mode: 'loopback',
      port: 8787,
      allowedHosts: [],
      allowedOrigins: [],
      unixSocket: null,
    },
  },
};

/**
 * The MCP admin wire envelope keeps its legacy shape — 3-field projects, a
 * single `provider` key, network only — and the Host normalizes it to the
 * canonical `WorkbenchConfigurationV1` (full projects, `providers` map,
 * render policy and quota defaults) before the request reaches the admin
 * port. This is the exact request the port must observe for
 * {@link FAKE_CONFIG_REQUEST}.
 */
const EXPECTED_CANONICAL_CONFIG_REQUEST = {
  version: 1,
  expectedRevision: 'rev-1',
  configuration: {
    version: 1,
    projects: [
      {
        projectId: 'p1',
        displayName: 'Project One',
        revisionMirror: { mode: 'disabled' },
        providerProfile: 'default',
        trustedPlugins: [],
      },
    ],
    defaultProjectId: 'p1',
    providers: { default: { kind: 'pi', baseUrl: null, model: null } },
    network: {
      mode: 'loopback',
      port: 8787,
      allowedHosts: [],
      allowedOrigins: [],
      unixSocket: null,
    },
    referenceLimits: { ...DEFAULT_WORKBENCH_REFERENCE_LIMITS },
    operationLimits: { ...DEFAULT_WORKBENCH_OPERATION_LIMITS },
    agent: { ...DEFAULT_WORKBENCH_AGENT_CONFIGURATION },
    renderPolicy: { ...DEFAULT_WORKBENCH_RENDER_POLICY },
  },
};

const FAKE_RECEIPT_OK: ConfigOperationReceiptV1 = {
  status: 'applied',
  activeRevision: 'rev-1',
  candidateRevision: 'rev-2',
  changedFields: ['network.port'],
  diagnostics: [],
};

function fakeAdmin(overrides: Partial<McpAdminConfigurationPort> = {}): McpAdminConfigurationPort {
  return {
    preview: async () => FAKE_RECEIPT_OK,
    apply: async () => ({ ...FAKE_RECEIPT_OK, status: 'restart-required' }),
    ...overrides,
  };
}

// ─── McpAuthorizationPort over real persistence ──────────────────────────────
type FixtureMcpAuthorizeInput = Omit<McpAuthorizeInput, 'route'> & {
  readonly route?: McpAuthorizeInput['route'];
};

describe('McpAuthorizationPort', () => {
  let harness: RealPersistenceHarness;
  let now: number;
  let capabilities: AgentCapabilityService;
  let authorize: (input: FixtureMcpAuthorizeInput) => Promise<McpAuthorizationResult>;

  beforeEach(() => {
    harness = createRealPersistence();
    now = Date.parse('2026-08-02T00:00:00.000Z');
    capabilities = new AgentCapabilityService({
      persistence: createCapabilityPersistence(harness.client),
      now: () => now,
    });
    const port = createMcpAuthorizationPort({
      sessions: {
        getSession: async (sessionId) => harness.client.request('loadSession', { sessionId }),
      },
      access: new ProjectAccessService({
        projects: [
          { projectId: 'p1', displayName: 'Project 1' },
          { projectId: 'p2', displayName: 'Project 2' },
        ],
        memberships: [
          { projectId: 'p1', userId: 'u1', role: 'reader' },
          { projectId: 'p1', userId: 'u2', role: 'reader' },
          { projectId: 'p2', userId: 'u1', role: 'reader' },
          { projectId: 'p2', userId: 'u2', role: 'reader' },
        ],
      }),
      capabilities,
      now: () => new Date(now).toISOString(),
    });
    authorize = (input) => port.authorize({ ...input, route: input.route ?? 'project' });
  });

  afterEach(async () => {
    await harness.dispose();
  });

  async function createSession(
    userId: string,
    expiresAt = '2099-01-01T00:00:00.000Z',
  ): Promise<string> {
    const sessionId = `session-${userId}-${Math.random().toString(36).slice(2)}`;
    await harness.client.request('createSession', {
      sessionId,
      userId,
      expiresAt,
      capabilityVersion: 1,
    });
    return sessionId;
  }
  it('authorizes a live session with a matching capability token and returns only server-derived fields', async () => {
    const sessionId = await createSession('u1');
    const issued = await capabilities.issue({
      userId: 'u1',
      projectId: 'p1',
      scopes: [MCP_READ_SCOPE, MCP_RENDER_SCOPE],
    });

    const result = await authorize({
      sessionId,
      token: issued.token,
      projectId: 'p1',
      scopes: [MCP_READ_SCOPE],
    });
    expect(result.caller).toEqual({
      sessionId,
      userId: 'u1',
      role: 'reader',
      projectGrant: { projectId: 'p1', role: 'reader' },
      grant: issued.grant,
    });
    // The caller projection never carries the opaque token or its digest.
    expect(JSON.stringify(result.caller)).not.toContain(issued.token);
  });

  it('rejects an absent or revoked session as SESSION_NOT_FOUND (401)', async () => {
    const missing = await authorize({
      sessionId: 'session-nope',
      token: 'fc_whatever',
      projectId: 'p1',
      scopes: [MCP_READ_SCOPE],
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.failure.code).toBe('SESSION_NOT_FOUND');

    const sessionId = await createSession('u1');
    const issued = await capabilities.issue({
      userId: 'u1',
      projectId: 'p1',
      scopes: [MCP_READ_SCOPE],
    });
    await harness.client.request('revokeSession', { sessionId });

    const revoked = await authorize({
      sessionId,
      token: issued.token,
      projectId: 'p1',
      scopes: [MCP_READ_SCOPE],
    });
    expect(revoked.ok).toBe(false);
    if (revoked.ok) return;
    expect(revoked.failure.code).toBe('SESSION_NOT_FOUND');
  });

  it('rejects an expired session as SESSION_EXPIRED (401)', async () => {
    const sessionId = await createSession('u1', '2000-01-01T00:00:00.000Z');
    const issued = await capabilities.issue({
      userId: 'u1',
      projectId: 'p1',
      scopes: [MCP_READ_SCOPE],
    });

    const result = await authorize({
      sessionId,
      token: issued.token,
      projectId: 'p1',
      scopes: [MCP_READ_SCOPE],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('SESSION_EXPIRED');
  });

  it('rejects unknown, expired, and revoked tokens with typed 401 codes', async () => {
    const sessionId = await createSession('u1');

    const unknown = await authorize({
      sessionId,
      token: 'fc_not_issued',
      projectId: 'p1',
      scopes: [MCP_READ_SCOPE],
    });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.failure.code).toBe('TOKEN_INVALID');

    const expiring = await capabilities.issue({
      userId: 'u1',
      projectId: 'p1',
      scopes: [MCP_READ_SCOPE],
      ttlMs: 1000,
    });
    now += 1001;
    const expired = await authorize({
      sessionId,
      token: expiring.token,
      projectId: 'p1',
      scopes: [MCP_READ_SCOPE],
    });
    expect(expired.ok).toBe(false);
    if (expired.ok) return;
    expect(expired.failure.code).toBe('TOKEN_EXPIRED');

    const revocable = await capabilities.issue({
      userId: 'u1',
      projectId: 'p1',
      scopes: [MCP_READ_SCOPE],
    });
    await capabilities.revoke(revocable.grant.capabilityId);
    const revoked = await authorize({
      sessionId,
      token: revocable.token,
      projectId: 'p1',
      scopes: [MCP_READ_SCOPE],
    });
    expect(revoked.ok).toBe(false);
    if (revoked.ok) return;
    expect(revoked.failure.code).toBe('TOKEN_REVOKED');
  });

  it('rejects a token presented for the wrong project or beyond the caller role with 403 codes', async () => {
    const sessionId = await createSession('u1');
    const issued = await capabilities.issue({
      userId: 'u1',
      projectId: 'p1',
      scopes: [MCP_READ_SCOPE],
    });

    const wrongProject = await authorize({
      sessionId,
      token: issued.token,
      projectId: 'p2',
      scopes: [MCP_READ_SCOPE],
    });
    expect(wrongProject.ok).toBe(false);
    if (wrongProject.ok) return;
    expect(wrongProject.failure.code).toBe('PROJECT_MISMATCH');

    // mcp:render is an author+ scope, so a reader asking for it fails the
    // role gate before the capability coverage check ever runs.
    const wrongScope = await authorize({
      sessionId,
      token: issued.token,
      projectId: 'p1',
      scopes: [MCP_RENDER_SCOPE],
    });
    expect(wrongScope.ok).toBe(false);
    if (wrongScope.ok) return;
    expect(wrongScope.failure.code).toBe('INSUFFICIENT_ROLE');
  });

  it("rejects a reader's mcp:render capability with INSUFFICIENT_ROLE", async () => {
    const sessionId = await createSession('u1');
    const issued = await capabilities.issue({
      userId: 'u1',
      projectId: 'p1',
      scopes: [MCP_RENDER_SCOPE],
    });

    const result = await authorize({
      sessionId,
      token: issued.token,
      projectId: 'p1',
      scopes: [MCP_RENDER_SCOPE],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('INSUFFICIENT_ROLE');
  });

  it('rejects a capability token that does not cover the requested scope with SCOPE_MISMATCH', async () => {
    // An author may legitimately request mcp:render; a token that only covers
    // mcp:read must still be denied by the capability coverage check.
    const sessionId = await createSession('u1');
    const authorPort = createMcpAuthorizationPort({
      sessions: {
        getSession: async (id) => harness.client.request('loadSession', { sessionId: id }),
      },
      access: new ProjectAccessService({
        projects: [{ projectId: 'p1', displayName: 'Project 1' }],
        memberships: [{ projectId: 'p1', userId: 'u1', role: 'author' }],
      }),
      capabilities,
      now: () => new Date(now).toISOString(),
    });
    const issued = await capabilities.issue({
      userId: 'u1',
      projectId: 'p1',
      scopes: [MCP_READ_SCOPE],
    });

    const result = await authorPort.authorize({
      sessionId,
      token: issued.token,
      projectId: 'p1',
      route: 'project',
      scopes: [MCP_RENDER_SCOPE],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('SCOPE_MISMATCH');
  });

  it('rejects a token bound to a different user than the live session (session spoof)', async () => {
    // The attacker holds a valid token issued to another user plus a session
    // of their own; the grant user must equal the live session user.
    const sessionId = await createSession('u1');
    const issued = await capabilities.issue({
      userId: 'u2',
      projectId: 'p1',
      scopes: [MCP_READ_SCOPE],
    });

    const result = await authorize({
      sessionId,
      token: issued.token,
      projectId: 'p1',
      scopes: [MCP_READ_SCOPE],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('USER_MISMATCH');
  });

  it('maps every failure code to the 401/403 status classes', () => {
    const expected: Record<McpAuthFailureCode, 401 | 403> = {
      SESSION_NOT_FOUND: 401,
      SESSION_EXPIRED: 401,
      TOKEN_INVALID: 401,
      TOKEN_REVOKED: 401,
      TOKEN_EXPIRED: 401,
      USER_MISMATCH: 403,
      PROJECT_MISMATCH: 403,
      SCOPE_MISMATCH: 403,
      INSUFFICIENT_ROLE: 403,
      ADMIN_ROUTE_REQUIRED: 403,
    };
    for (const [code, status] of Object.entries(expected)) {
      expect(MCP_AUTH_FAILURE_STATUS[code as McpAuthFailureCode]).toBe(status);
      expect(mcpAuthFailureStatus(code as McpAuthFailureCode)).toBe(status);
    }
  });

  it("rejects a reader's mcp:author capability with INSUFFICIENT_ROLE", async () => {
    const sessionId = await createSession('u1');
    const issued = await capabilities.issue({
      userId: 'u1',
      projectId: 'p1',
      scopes: [MCP_AUTHOR_SCOPE],
    });

    const result = await authorize({
      sessionId,
      token: issued.token,
      projectId: 'p1',
      scopes: [MCP_AUTHOR_SCOPE],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('INSUFFICIENT_ROLE');
  });

  it("rejects a reader's mcp:submit capability with INSUFFICIENT_ROLE", async () => {
    const sessionId = await createSession('u1');
    const issued = await capabilities.issue({
      userId: 'u1',
      projectId: 'p1',
      scopes: [MCP_SUBMIT_SCOPE],
    });

    const result = await authorize({
      sessionId,
      token: issued.token,
      projectId: 'p1',
      scopes: [MCP_SUBMIT_SCOPE],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('INSUFFICIENT_ROLE');
  });

  it("accepts a reader's mcp:read capability", async () => {
    const sessionId = await createSession('u1');
    const issued = await capabilities.issue({
      userId: 'u1',
      projectId: 'p1',
      scopes: [MCP_READ_SCOPE],
    });

    const result = await authorize({
      sessionId,
      token: issued.token,
      projectId: 'p1',
      scopes: [MCP_READ_SCOPE],
    });
    expect(result.ok).toBe(true);
  });

  it('rejects unknown scopes with SCOPE_MISMATCH', async () => {
    const sessionId = await createSession('u1');

    const result = await authorize({
      sessionId,
      token: 'fc_any',
      projectId: 'p1',
      scopes: ['mcp:unknown'],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('SCOPE_MISMATCH');
  });

  it('rejects admin scope on project route with browser session', async () => {
    const sessionId = await createSession('u1');

    const result = await authorize({
      sessionId,
      token: 'fc_any',
      projectId: 'p1',
      scopes: [MCP_ADMIN_SCOPE],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('ADMIN_ROUTE_REQUIRED');
  });
});

// ─── McpAuthorizationPort over real persistence (device mode) ────────────────

describe('McpAuthorizationPort device mode', () => {
  let harness: RealPersistenceHarness;
  let now: number;
  let devices: McpDevicePairingService;
  let capabilities: AgentCapabilityService;
  let deviceSequence = 0;

  beforeEach(() => {
    harness = createRealPersistence();
    now = Date.parse('2026-08-02T00:00:00.000Z');
    deviceSequence = 0;
    devices = createMcpDevicePairingService({
      persistence: createDeviceVerifierPersistence(harness.client),
      now: () => now,
      newId: () => `device-${++deviceSequence}`,
    });
    capabilities = new AgentCapabilityService({
      persistence: createCapabilityPersistence(harness.client),
      now: () => now,
    });
  });

  afterEach(async () => {
    await harness.dispose();
  });

  async function pairedDevice(
    scopes: string[],
    ttlMs = 60_000,
    kind: 'project' | 'admin' = 'project',
    projectId = 'p1',
  ): Promise<string> {
    const pairing = await devices.createPairing({
      ownerUserId: 'owner-1',
      kind,
      ...(kind === 'project' ? { projectId, role: 'maintainer' as const } : {}),
    });
    const claimed = await devices.claim({
      pairingCode: pairing.pairingCode,
      clientLabel: 'editor-laptop',
      scopes,
      ttlMs,
    });
    if (!claimed.ok) throw new Error('pairing claim failed');
    return claimed.credential;
  }

  function port(overrides: Partial<Parameters<typeof createMcpAuthorizationPort>[0]> = {}) {
    const authorization = createMcpAuthorizationPort({
      sessions: {
        getSession: async () => null,
      },
      access: new ProjectAccessService({
        projects: [
          { projectId: 'p1', displayName: 'Project 1' },
          { projectId: 'p2', displayName: 'Project 2' },
          { projectId: 'admin', displayName: 'Project Admin' },
        ],
        ownerUserId: 'owner-1',
      }),
      capabilities,
      devices,
      owner: {
        loadOwner: async () => ({
          userId: 'owner-1',
          displayName: 'Owner',
          role: 'owner' as const,
          capabilityVersion: 1,
          createdAt: '2026-08-01T00:00:00.000Z',
          passwordHash: null,
        }),
      },
      now: () => new Date(now).toISOString(),
      ...overrides,
    });
    return {
      authorize: (input: FixtureMcpAuthorizeInput) =>
        authorization.authorize({ ...input, route: input.route ?? 'project' }),
    };
  }

  it('authorizes an owner-paired device credential without any browser session', async () => {
    const credential = await pairedDevice([MCP_READ_SCOPE, MCP_RENDER_SCOPE]);
    const result = await port().authorize({
      sessionId: null,
      token: credential,
      projectId: 'p1',
      scopes: [MCP_READ_SCOPE],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.caller).toEqual({
      sessionId: null,
      userId: 'owner-1',
      role: 'owner',
      projectGrant: { projectId: 'p1', role: 'owner' },
      grant: {
        capabilityId: 'device:device-1',
        userId: 'owner-1',
        projectId: 'p1',
        scopes: [MCP_READ_SCOPE, MCP_RENDER_SCOPE],
        version: 1,
        expiresAt: new Date(now + 60_000).toISOString(),
      },
      device: { deviceId: 'device-1' },
    });
    // No token or digest ever reaches the caller projection.
    expect(JSON.stringify(result.caller)).not.toContain(credential);
    expect(JSON.stringify(result.caller)).not.toContain(
      createHash('sha256').update(credential, 'utf8').digest('hex'),
    );
  });

  it('treats a project id named admin as a project route', async () => {
    const credential = await pairedDevice([MCP_READ_SCOPE], 60_000, 'project', 'admin');
    const result = await port().authorize({
      sessionId: null,
      token: credential,
      projectId: 'admin',
      route: 'project',
      scopes: [MCP_READ_SCOPE],
    });

    expect(result.ok).toBe(true);
  });

  it('rejects revoked, expired, wrong-scope, and unknown device credentials', async () => {
    const credential = await pairedDevice([MCP_READ_SCOPE]);
    const revoked = await pairedDevice([MCP_READ_SCOPE]);
    await devices.revoke('device-2');
    await expect(
      port().authorize({
        sessionId: null,
        token: revoked,
        projectId: 'p1',
        scopes: [MCP_READ_SCOPE],
      }),
    ).resolves.toMatchObject({ ok: false, failure: { code: 'TOKEN_REVOKED' } });

    const expiredCredential = await pairedDevice([MCP_READ_SCOPE], 1000);
    now += 1001;
    await expect(
      port().authorize({
        sessionId: null,
        token: expiredCredential,
        projectId: 'p1',
        scopes: [MCP_READ_SCOPE],
      }),
    ).resolves.toMatchObject({ ok: false, failure: { code: 'TOKEN_EXPIRED' } });

    await expect(
      port().authorize({
        sessionId: null,
        token: credential,
        projectId: 'p1',
        scopes: [MCP_SUBMIT_SCOPE],
      }),
    ).resolves.toMatchObject({ ok: false, failure: { code: 'SCOPE_MISMATCH' } });
    await expect(
      port().authorize({
        sessionId: null,
        token: 'wbd_never-issued',
        projectId: 'p1',
        scopes: [MCP_READ_SCOPE],
      }),
    ).resolves.toMatchObject({ ok: false, failure: { code: 'TOKEN_INVALID' } });
  });

  it('never treats a capability token as a device credential or vice versa', async () => {
    const issued = await capabilities.issue({
      userId: 'owner-1',
      projectId: 'p1',
      scopes: ['edit:prose'],
    });
    await expect(
      port().authorize({
        sessionId: null,
        token: issued.token,
        projectId: 'p1',
        scopes: [MCP_READ_SCOPE],
      }),
    ).resolves.toMatchObject({ ok: false, failure: { code: 'TOKEN_INVALID' } });

    const credential = await pairedDevice([MCP_READ_SCOPE]);
    await expect(
      port({
        sessions: {
          getSession: async () =>
            ({
              sessionId: 'session-live',
              userId: 'owner-1',
              createdAt: '2026-08-02T00:00:00.000Z',
              expiresAt: '2099-01-01T00:00:00.000Z',
              revokedAt: null,
            }) as never,
        },
      }).authorize({
        sessionId: 'session-live',
        token: credential,
        projectId: 'p1',
        scopes: [MCP_READ_SCOPE],
      }),
    ).resolves.toMatchObject({ ok: false, failure: { code: 'TOKEN_INVALID' } });
  });

  it('fails closed when the owner cannot be resolved or the device store is absent', async () => {
    const credential = await pairedDevice([MCP_READ_SCOPE]);
    await expect(
      port({ owner: { loadOwner: async () => null } }).authorize({
        sessionId: null,
        token: credential,
        projectId: 'p1',
        scopes: [MCP_READ_SCOPE],
      }),
    ).resolves.toMatchObject({ ok: false, failure: { code: 'TOKEN_INVALID' } });
    const withoutDevices = createMcpAuthorizationPort({
      sessions: { getSession: async () => null },
      capabilities,
      owner: { loadOwner: async () => null },
    });
    await expect(
      withoutDevices.authorize({
        sessionId: null,
        token: credential,
        projectId: 'p1',
        route: 'project',
        scopes: [MCP_READ_SCOPE],
      }),
    ).resolves.toMatchObject({ ok: false, failure: { code: 'TOKEN_INVALID' } });
  });

  it('persists the device grant so the session render gate passes for prepare and commit, not DENIED', async () => {
    const credential = await pairedDevice([MCP_RENDER_SCOPE]);
    const result = await port().authorize({
      sessionId: null,
      token: credential,
      projectId: 'p1',
      scopes: [MCP_RENDER_SCOPE],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const caller = result.caller;

    // The durable device row is what the session gate re-loads: the caller
    // grant and the persisted row must agree on id/version/expiry/project/
    // scopes or the gate denies.
    const row = await harness.client.request('loadCapability', {
      capabilityId: 'device:device-1',
    });
    expect(row).toMatchObject({
      capabilityId: 'device:device-1',
      userId: 'owner-1',
      projectId: 'p1',
      scope: [MCP_RENDER_SCOPE],
      version: 1,
      expiresAt: new Date(now + 60_000).toISOString(),
    });

    // A real session (real #grantGate → checkGrant over the same store) fed
    // by the device caller's grant: enqueued render prepare AND commit must
    // both pass the gate instead of denying with NOT_FOUND.
    const audit: SessionAuditRecord[] = [];
    const session = createProjectSession({
      projectId: 'p1',
      runtime: fakeRuntime(FIXTURE),
      capabilities,
      audit: { record: (record) => void audit.push(record) },
      initialSource: FIXTURE,
      now: () => new Date(now).toISOString(),
    });
    const { service } = await createOperationService(session);
    try {
      const registry = createProjectSessionMcpRegistry(session, {
        operations: service,
        candidates: {
          execute: async (request) => ({
            kind: 'failed',
            result: stubRenderResult(request.mutation.operationId),
          }),
          commit: async () => {
            throw new Error('commit must not run for a failed preflight outcome');
          },
        },
      });
      const run = await registry.run('nova_render', caller, {
        sceneSelector: { type: 'all' },
        model: 'mock',
      });
      expect(run.ok).toBe(true);
      if (!run.ok) return;
      const handle = enqueueHandle(run.data);
      const terminal = await waitForTerminal(service, handle);
      // Not DENIED: the persisted device row satisfied both gates, and the
      // typed audit records the completed prepare/commit phases.
      expect(terminal.status).toBe('succeeded');
      expect(terminal.errorCode).toBeNull();
      expect(audit.some((record) => record.outcome === 'completed')).toBe(true);
      expect(audit.some((record) => record.outcome === 'denied')).toBe(false);
    } finally {
      await service.close();
    }
  });

  it('fails the request with a typed error when the device grant cannot be persisted', async () => {
    const credential = await pairedDevice([MCP_READ_SCOPE]);
    const failingCapabilities: Pick<AgentCapabilityService, 'validate' | 'persistGrant'> = {
      validate: async () => ({
        ok: false,
        failure: { code: 'INVALID_TOKEN', message: 'unused in device mode' },
      }),
      persistGrant: async () => {
        throw new Error('capability store unavailable');
      },
    };
    // A failed persist is a server-side storage failure, not a credential
    // failure: the caller must see a retryable typed error now instead of a
    // confusing NOT_FOUND denial when the session gate re-loads the row.
    await expect(
      port({ capabilities: failingCapabilities }).authorize({
        sessionId: null,
        token: credential,
        projectId: 'p1',
        scopes: [MCP_READ_SCOPE],
      }),
    ).rejects.toBeInstanceOf(DeviceGrantPersistenceError);
    // The credential itself verified, so the denial must NOT look like a
    // credential problem (401-class): no typed auth failure is returned.
    await expect(
      port({ capabilities: failingCapabilities }).authorize({
        sessionId: null,
        token: credential,
        projectId: 'p1',
        scopes: [MCP_READ_SCOPE],
      }),
    ).rejects.not.toMatchObject({ ok: false, failure: expect.anything() });
  });
});

// ─── createProjectSessionMcpRegistry ─────────────────────────────────────────

describe('createProjectSessionMcpRegistry', () => {
  it('exposes the eight canonical tools with exact scopes and JSON input schemas', () => {
    const { session } = fakeSession({ source: FIXTURE });
    const registry = createProjectSessionMcpRegistry(session);
    expect(registry.projectId).toBe('p1');
    expect(registry.session).toBe(session);

    const readOnly = registry.list([MCP_READ_SCOPE]).map((tool) => tool.name);
    expect(readOnly).toEqual([
      'nova_status',
      'nova_validate',
      'nova_source_list',
      'nova_source_get',
      'nova_source_preview',
      'nova_entity_get',
      'nova_entity_list',
      'nova_graph',
      'nova_revision_list',
      'nova_revision_get',
      'nova_revision_diff',
      'nova_event_state_diff',
      'nova_review_list',
      'nova_review_get',
      'nova_release_gate_list',
      'nova_publication_get',
      'nova_publication_read',
    ]);

    const all = registry.list([MCP_READ_SCOPE, MCP_RENDER_SCOPE]).map((tool) => tool.name);
    expect(all).toHaveLength(20);
    expect(all).toContain('nova_render');

    // A render-only grant exposes only the three render-surface tools.
    expect(registry.list([MCP_RENDER_SCOPE]).map((tool) => tool.name)).toEqual([
      'nova_render',
      'nova_revise',
      'nova_render_tree',
    ]);

    for (const name of all) {
      const tool = registry.get(name);
      expect(tool).not.toBeNull();
      if (!tool) continue;
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.requiredScopes.length).toBeGreaterThan(0);
      const schema: McpJsonInputSchema = tool.inputSchema;
      expect(schema.type).toBe('object');
      expect(schema.additionalProperties).toBe(false);
      expect(typeof schema.properties).toBe('object');
    }

    expect(registry.get('nova_render')?.requiredScopes).toEqual([MCP_RENDER_SCOPE]);
    expect(registry.get('nova_source_get')?.requiredScopes).toEqual([MCP_READ_SCOPE]);
    expect(registry.get('nova_entity_list')?.requiredScopes).toEqual([MCP_READ_SCOPE]);
    expect(registry.get('nonexistent')).toBeNull();

    // The render input schema never exposes server identity fields.
    const renderSchema = registry.get('nova_render')?.inputSchema;
    if (renderSchema === undefined) throw new Error('Missing nova_render input schema');
    expect(renderSchema.required).toEqual(['sceneSelector']);
    expect('actorId' in renderSchema.properties).toBe(false);
    expect('operationId' in renderSchema.properties).toBe(false);
  });

  it('reads source documents from the accepted session only', async () => {
    const nova = fixtureDocument('nova.yaml');
    const variant = withContent(FIXTURE, 'nova.yaml', `${nova.content}\n# variant\n`);
    const { session } = fakeSession({ source: FIXTURE });
    const { session: otherSession } = fakeSession({ source: variant });
    const registry = createProjectSessionMcpRegistry(session);
    const otherRegistry = createProjectSessionMcpRegistry(otherSession);
    const caller = callerFor(
      grantWith({ userId: 'u1', projectId: 'p1', scopes: [MCP_READ_SCOPE] }),
    );

    const result = await registry.run('nova_source_get', caller, { logicalPath: 'nova.yaml' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual(nova);

    // A different accepted session serves its own source for the same path.
    const other = await otherRegistry.run('nova_source_get', caller, { logicalPath: 'nova.yaml' });
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    expect((other.data as { content: string }).content).toContain('# variant');

    const listed = await registry.run('nova_source_list', caller, {});
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.data as unknown[]).toHaveLength(FIXTURE.documents.length);

    const missing = await registry.run('nova_source_get', caller, {
      logicalPath: 'definitions/characters/nobody.yaml',
    });
    expectError(missing, 'SOURCE_DOCUMENT_NOT_FOUND');
  });

  it('reads entities and status/validation from the accepted source', async () => {
    const { session } = fakeSession({ source: FIXTURE });
    const registry = createProjectSessionMcpRegistry(session);
    const caller = callerFor(
      grantWith({ userId: 'u1', projectId: 'p1', scopes: [MCP_READ_SCOPE] }),
    );

    const listResult = await registry.run('nova_entity_list', caller, {});
    expect(listResult.ok).toBe(true);
    if (!listResult.ok) return;
    const entities = listResult.data as Array<{ id: string; kind: string; name: string }>;
    expect(entities.length).toBeGreaterThan(0);
    const first = entities[0];
    expect(first.id.length).toBeGreaterThan(0);

    const getResult = await registry.run('nova_entity_get', caller, { entityId: first.id });
    expect(getResult.ok).toBe(true);
    if (!getResult.ok) return;
    const detail = getResult.data as {
      id: string;
      kind: string;
      name: string;
      definitionFile: string;
      state: unknown;
    };
    expect(detail.id).toBe(first.id);
    expect(detail.definitionFile.length).toBeGreaterThan(0);
    expect(typeof detail.state).toBe('object');

    const kindResult = await registry.run('nova_entity_list', caller, { kind: first.kind });
    expect(kindResult.ok).toBe(true);
    if (!kindResult.ok) return;
    const filtered = kindResult.data as Array<{ kind: string }>;
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every((entity) => entity.kind === first.kind)).toBe(true);

    const status = await registry.run('nova_status', caller, {});
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    const workflow = status.data as WorkflowStatusV1;
    expect(workflow.version).toBe(1);
    expect(workflow.projectId).toBe('p1');
    expect(workflow.layer).toBe('accepted');
    expect(workflow.sourceHash).toBe(FIXTURE.sourceHash);
    // The zhu-fu fixture validates clean; every planned event is renderable
    // but nothing is rendered yet, so all events are ready.
    expect(workflow.validation.passed).toBe(true);
    expect(workflow.render.completed).toEqual([]);
    expect([...workflow.render.ready, ...workflow.render.waiting].sort()).toEqual(
      FIXTURE_EVENT_IDS,
    );
    expect(workflow.review).toEqual({ open: 0, blocking: 0, pendingGates: 0 });
    expect(workflow.publication).toEqual({
      status: 'missing',
      publicationId: null,
      novelHash: null,
    });
    expect(workflow.nextActions.some((next) => next.code === 'RENDER')).toBe(true);
    expect(typeof workflow.guidance).toBe('string');
    expect(typeof workflow.generatedAt).toBe('string');

    const validation = await registry.run('nova_validate', caller, {});
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    const validationData = validation.data as {
      passed: boolean;
      iss: unknown;
      results: Record<string, unknown>;
    };
    expect(typeof validationData.passed).toBe('boolean');
    expect(typeof validationData.results).toBe('object');
    expect(validationData.iss).not.toBeUndefined();
  });

  it('buckets render state from accepted-scene records keyed to the current sourceHash', async () => {
    const [completedEvent, staleEvent, ...rest] = FIXTURE_EVENT_IDS;
    const { session } = fakeSession({
      source: FIXTURE,
      readAcceptedScene: async ({ eventId }) => {
        if (eventId === completedEvent)
          return {
            revision: 1,
            value: {
              version: 1 as const,
              projectId: 'p1',
              eventId,
              sourceHash: FIXTURE.sourceHash,
              revisionId: 'rev-current',
              prose: 'prose',
              proseHash: 'ph',
              sceneHash: 'sh',
            },
          };
        if (eventId === staleEvent)
          return {
            revision: 1,
            value: {
              version: 1 as const,
              projectId: 'p1',
              eventId,
              sourceHash: 'stale-source-hash',
              revisionId: 'rev-stale',
              prose: 'prose',
              proseHash: 'ph',
              sceneHash: 'sh',
            },
          };
        return null;
      },
    });
    const registry = createProjectSessionMcpRegistry(session);
    const caller = callerFor(
      grantWith({ userId: 'u1', projectId: 'p1', scopes: [MCP_READ_SCOPE] }),
    );

    const result = await registry.run('nova_status', caller, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const workflow = result.data as WorkflowStatusV1;
    // Only the scene rendered for the CURRENT sourceHash counts as completed;
    // the stale-scene event is not rendered for this source and stays ready.
    expect(workflow.render.completed).toEqual([completedEvent]);
    expect(workflow.render.blocked).toEqual([]);
    expect(workflow.render.ready.sort()).toEqual([staleEvent, ...rest].sort());
    expect(workflow.render.waiting).toEqual([]);
    expect(workflow.blockers).toEqual([]);
  });

  it('surfaces accepted-source validation errors as FIX_ACCEPTED_SOURCE blockers', async () => {
    const issue: ValidationIssue = {
      validator: 'test-validator',
      severity: 'error',
      kind: 'compiler_invariant',
      event: 'E0',
      entity: '',
      message: 'precondition cannot be satisfied',
      fixSuggestion: 'fix the precondition',
      fixAction: 'edit_file',
      fixTarget: { file: 'chapters/chapter_01/E0.yaml' },
    };
    const failingValidation: NovelValidationResult = {
      passed: false,
      results: new Map([['E0', { passed: false, errors: [issue], warnings: [], infos: [] }]]),
      iss: { overall: 100, target: 100, dimensions: [] },
    };
    const { session } = fakeSession({ source: FIXTURE });
    const status = await buildWorkflowStatusForSession(session, {
      validate: async () => failingValidation,
    });
    expect(status).not.toBeNull();
    if (status === null) return;
    expect(status.validation.passed).toBe(false);
    expect(status.validation.errors).toEqual([issue]);
    expect(status.blockers.some((blocker) => blocker.code === 'VALIDATION_ERROR')).toBe(true);
    expect(status.nextActions.some((next) => next.code === 'FIX_ACCEPTED_SOURCE')).toBe(true);
    expect(status.guidance).toContain('Fix the accepted source');
    // Honest zeros: no review or publication store exists at this step.
    expect(status.review).toEqual({ open: 0, blocking: 0, pendingGates: 0 });
    expect(status.publication).toEqual({
      status: 'missing',
      publicationId: null,
      novelHash: null,
    });
  });

  // ─── Enabled-plugin extension gate (plan 7.5) ────────────────────────────

  describe('enabled-plugin extension gate', () => {
    const EVENT_PATH = 'chapters/chapter_01/E5_threshold_rejection.yaml';
    const extensionBlock = (name: string): string =>
      `\nextensions:\n  ${name}:\n    enabled: true\n    provenance: unit-test\n`;

    const withExtension = (
      snapshot: ProjectSourceSnapshotV1,
      name: string,
    ): ProjectSourceSnapshotV1 =>
      withContent(
        snapshot,
        EVENT_PATH,
        `${fixtureDocument(EVENT_PATH).content}${extensionBlock(name)}`,
      );

    it('reports an unknown extension namespace as a source error through nova_validate', async () => {
      const { session } = fakeSession({ source: withExtension(FIXTURE, 'unknown-plugin') });
      const registry = createProjectSessionMcpRegistry(session, {
        extensionRegistrar: new PluginExtensionSchemaRegistrar([]),
      });
      const caller = callerFor(
        grantWith({ userId: 'u1', projectId: 'p1', scopes: [MCP_READ_SCOPE] }),
      );

      const result = await registry.run('nova_validate', caller, {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as {
        passed?: boolean;
        sourceDiagnostics?: ReadonlyArray<{ readonly code: string; readonly severity: string }>;
      };
      expect(data.passed).toBe(false);
      const diagnostic = data.sourceDiagnostics?.find(
        (entry) => entry.code === 'SOURCE_EXTENSION_NAMESPACE_UNKNOWN',
      );
      expect(diagnostic).toBeDefined();
      expect(diagnostic?.severity).toBe('error');
    });

    it('surfaces an unknown extension namespace as FIX_ACCEPTED_SOURCE through nova_status', async () => {
      const { session } = fakeSession({ source: withExtension(FIXTURE, 'unknown-plugin') });
      const registry = createProjectSessionMcpRegistry(session, {
        extensionRegistrar: new PluginExtensionSchemaRegistrar([]),
      });
      const caller = callerFor(
        grantWith({ userId: 'u1', projectId: 'p1', scopes: [MCP_READ_SCOPE] }),
      );

      const result = await registry.run('nova_status', caller, {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const status = result.data as WorkflowStatusV1;
      expect(status.validation.passed).toBe(false);
      const sourceError = status.validation.errors.find((issue) =>
        issue.message.includes('SOURCE_EXTENSION_NAMESPACE_UNKNOWN'),
      );
      expect(sourceError).toBeDefined();
      // The authoritative event id (`event:` field), not the file stem.
      expect(sourceError?.event).toBe('E5');
      expect(status.nextActions.some((next) => next.code === 'FIX_ACCEPTED_SOURCE')).toBe(true);
      expect(status.blockers.some((blocker) => blocker.code === 'VALIDATION_ERROR')).toBe(true);
      // The scene carrying the unknown namespace is blocked, not renderable.
      expect(status.render.blocked).toContain('E5');
    });

    it('accepts an enabled plugin namespace with no source diagnostics', async () => {
      const { session } = fakeSession({ source: withExtension(FIXTURE, 'e2e-plugin') });
      const registry = createProjectSessionMcpRegistry(session, {
        extensionRegistrar: new PluginExtensionSchemaRegistrar([{ name: 'e2e-plugin' }]),
      });
      const caller = callerFor(
        grantWith({ userId: 'u1', projectId: 'p1', scopes: [MCP_READ_SCOPE] }),
      );

      const validate = await registry.run('nova_validate', caller, {});
      expect(validate.ok).toBe(true);
      if (!validate.ok) return;
      const data = validate.data as { passed?: boolean; sourceDiagnostics?: unknown };
      expect(data.passed).toBe(true);
      expect(data.sourceDiagnostics).toBeUndefined();

      const statusResult = await registry.run('nova_status', caller, {});
      expect(statusResult.ok).toBe(true);
      if (!statusResult.ok) return;
      const status = statusResult.data as WorkflowStatusV1;
      expect(status.validation.passed).toBe(true);
      expect(status.nextActions.some((next) => next.code === 'FIX_ACCEPTED_SOURCE')).toBe(false);
    });

    it('keeps the no-registrar path unchanged: unknown namespaces stay structurally accepted', async () => {
      const { session } = fakeSession({ source: withExtension(FIXTURE, 'unknown-plugin') });
      const registry = createProjectSessionMcpRegistry(session);
      const caller = callerFor(
        grantWith({ userId: 'u1', projectId: 'p1', scopes: [MCP_READ_SCOPE] }),
      );

      const result = await registry.run('nova_validate', caller, {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as { passed?: boolean; sourceDiagnostics?: unknown };
      expect(data.passed).toBe(true);
      expect(data.sourceDiagnostics).toBeUndefined();
    });
  });

  it('reports the accepted revision id from the coordinator state and the revision port', async () => {
    const { session } = fakeSession({ source: FIXTURE });
    const registry = createProjectSessionMcpRegistry(session, {
      coordinator: fakeCoordinator({
        getState: () => ({
          ...FAKE_AUTHORING_STATE,
          acceptedRevisionId: 'coordinator-rev',
          acceptedSourceHash: FIXTURE.sourceHash,
        }),
      }),
    });
    const caller = callerFor(
      grantWith({ userId: 'u1', projectId: 'p1', scopes: [MCP_READ_SCOPE] }),
    );
    const viaCoordinator = await registry.run('nova_status', caller, {});
    expect(viaCoordinator.ok).toBe(true);
    if (!viaCoordinator.ok) return;
    expect((viaCoordinator.data as WorkflowStatusV1).acceptedRevisionId).toBe('coordinator-rev');

    // Without a coordinator the native revision port supplies the identity.
    const revision: AuthoringRevisionPort = {
      loadAccepted: async () => ({
        revisionId: 'revision-port-rev',
        sourceHash: FIXTURE.sourceHash,
        bundleHash: 'bundle-1',
      }),
      submit: async () => ({
        status: 'accepted',
        revisionId: 'child-1',
        receiptHash: 'receipt-child',
      }),
      recover: async () => ({
        status: 'completed',
        revisionId: 'revision-port-rev',
        materializedRevisionId: 'revision-port-rev',
      }),
      list: async () => ({ revisions: [] }),
      get: async () => null,
      diff: async () => ({ changes: [] }),
      restore: async () => ({
        status: 'accepted',
        revisionId: 'child-1',
        receiptHash: 'receipt-child',
      }),
    };
    const registryViaRevision = createProjectSessionMcpRegistry(session, { revision });
    const viaRevision = await registryViaRevision.run('nova_status', caller, {});
    expect(viaRevision.ok).toBe(true);
    if (!viaRevision.ok) return;
    expect((viaRevision.data as WorkflowStatusV1).acceptedRevisionId).toBe('revision-port-rev');
  });

  it('derives the next working-layer action from the coordinator state', async () => {
    const { session } = fakeSession({ source: FIXTURE });
    const caller = callerFor(
      grantWith({ userId: 'u1', projectId: 'p1', scopes: [MCP_AUTHOR_SCOPE] }),
    );
    const registry = createProjectSessionMcpRegistry(session, {
      coordinator: fakeCoordinator({
        getState: () => ({ ...FAKE_AUTHORING_STATE, workingDirty: true }),
      }),
    });
    const dirty = await registry.run(MCP_TOOL_AUTHORING_STATUS, caller, { version: 2 });
    expect(dirty.ok).toBe(true);
    if (!dirty.ok) return;
    expect((dirty.data as { nextWorkingAction: string | null }).nextWorkingAction).toBe(
      'VALIDATE_WORKING',
    );

    const conflictRegistry = createProjectSessionMcpRegistry(session, {
      coordinator: fakeCoordinator({
        getState: () => ({
          ...FAKE_AUTHORING_STATE,
          conflicts: [
            {
              logicalPath: 'nova.yaml',
              kind: 'working-vs-external' as const,
              baseSourceHash: FIXTURE.sourceHash,
              workingHash: 'w',
              externalHash: 'e',
              proposedDisjointMerge: false,
            },
          ],
        }),
      }),
    });
    const conflicted = await conflictRegistry.run(MCP_TOOL_AUTHORING_STATUS, caller, {
      version: 2,
    });
    expect(conflicted.ok).toBe(true);
    if (!conflicted.ok) return;
    expect((conflicted.data as { nextWorkingAction: string | null }).nextWorkingAction).toBe(
      'RESOLVE_CONFLICT',
    );
  });

  it('previews source changes against the accepted source without persisting', async () => {
    const { session } = fakeSession({ source: FIXTURE });
    const registry = createProjectSessionMcpRegistry(session);
    const caller = callerFor(
      grantWith({ userId: 'u1', projectId: 'p1', scopes: [MCP_READ_SCOPE] }),
    );
    const nova = fixtureDocument('nova.yaml');
    const proposed = `${nova.content}\n# preview proposal\n`;

    const result = await registry.run('nova_source_preview', caller, {
      changes: [
        {
          logicalPath: nova.logicalPath,
          beforeContent: nova.content,
          beforeHash: nova.contentHash,
          afterContent: proposed,
          afterHash: computeSourceDocumentHash(proposed),
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const analysis = result.data as {
      current: { sourceHash: string };
      candidate: { sourceHash: string };
      changes: unknown[];
    };
    expect(analysis.current.sourceHash).toBe(FIXTURE.sourceHash);
    expect(analysis.candidate.sourceHash).not.toBe(FIXTURE.sourceHash);
    expect(analysis.changes).toHaveLength(1);

    const malformed = await registry.run('nova_source_preview', caller, { changes: 'nope' });
    expectError(malformed, 'INVALID_INPUT');
  });

  it('rejects reads when the session has no accepted source', async () => {
    const { session } = fakeSession({ source: null });
    const registry = createProjectSessionMcpRegistry(session);
    const caller = callerFor(
      grantWith({ userId: 'u1', projectId: 'p1', scopes: [MCP_READ_SCOPE] }),
    );

    expectError(await registry.run('nova_source_list', caller, {}), 'NO_ACCEPTED_SOURCE');
    expectError(
      await registry.run('nova_source_get', caller, { logicalPath: 'nova.yaml' }),
      'NO_ACCEPTED_SOURCE',
    );
    expectError(
      await registry.run('nova_source_preview', caller, { changes: [] }),
      'NO_ACCEPTED_SOURCE',
    );
    expectError(await registry.run('nova_entity_list', caller, {}), 'NO_ACCEPTED_SOURCE');
    expectError(
      await registry.run('nova_entity_get', caller, { entityId: 'x' }),
      'NO_ACCEPTED_SOURCE',
    );
    expectError(await registry.run('nova_validate', caller, {}), 'NO_ACCEPTED_SOURCE');

    // status requires an accepted source; without one it fails closed exactly
    // like the other accepted-layer read tools.
    expectError(await registry.run('nova_status', caller, {}), 'NO_ACCEPTED_SOURCE');
  });

  it('enforces the tool scope per call and rejects unknown tools', async () => {
    const { session } = fakeSession({ source: FIXTURE });
    const registry = createProjectSessionMcpRegistry(session);
    const readOnly = callerFor(
      grantWith({ userId: 'u1', projectId: 'p1', scopes: [MCP_READ_SCOPE] }),
    );
    const renderOnly = callerFor(
      grantWith({ userId: 'u1', projectId: 'p1', scopes: [MCP_RENDER_SCOPE] }),
    );

    expectError(
      await registry.run('nova_render', readOnly, { sceneSelector: { type: 'all' } }),
      'SCOPE_MISMATCH',
    );
    expectError(await registry.run('nova_source_list', renderOnly, {}), 'SCOPE_MISMATCH');
    expectError(await registry.run('nova_nonexistent', readOnly, {}), 'TOOL_NOT_FOUND');
  });

  it('enqueues render as a durable queued operation and resolves it with the render result', async () => {
    const requests: Array<{ request: EditorialRenderRequestV1; runtime: EditorialRuntime }> = [];
    const { session, detachedOperations } = fakeSession({ source: FIXTURE });
    const { service } = await createOperationService(session);
    const registry = createProjectSessionMcpRegistry(session, {
      operations: service,
      candidates: {
        execute: async (request, runtime) => {
          requests.push({ request, runtime });
          // A preflight failure is a complete result: nothing to promote.
          return { kind: 'failed', result: stubRenderResult(request.mutation.operationId) };
        },
        commit: async () => {
          throw new Error('commit must not run for a failed preflight outcome');
        },
      },
    });
    const caller = callerFor(
      grantWith({
        capabilityId: 'cap-render',
        userId: 'u1',
        projectId: 'p1',
        scopes: [MCP_RENDER_SCOPE],
        version: 2,
      }),
    );

    const result = await registry.run('nova_render', caller, {
      sceneSelector: { type: 'all' },
      model: 'mock',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({ status: 'queued', operationHandle: expect.any(String) });
    const operationHandle = (result.data as { operationHandle: string }).operationHandle;

    // The detached operation carries server-derived identity only.
    await waitFor(() => detachedOperations.length === 1, 'render operation to be created');
    const operation = detachedOperations[0];
    if (operation === undefined) throw new Error('detached render operation is missing');
    expect(operation.kind).toBe('render');
    expect(operation.capabilityId).toBe('cap-render');
    expect(operation.scope).toEqual([MCP_RENDER_SCOPE]);
    expect(operation.expectedVersion).toBe(2);
    // The queued payload carries the client's selection only — never identity.
    expect(operation.payload).toEqual({ selector: { type: 'all' }, model: 'mock' });
    expect(operation.payload).not.toHaveProperty('actorId');
    expect(operation.payload).not.toHaveProperty('operationId');

    // The operation resolves via the durable service with the render result.
    const terminal = await waitForTerminal(service, operationHandle);
    expect(terminal.status).toBe('succeeded');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.request.mutation).toEqual({
      operationId: terminal.operationId,
      actorId: 'u1',
    });
    expect(requests[0]?.request.source).toBe(FIXTURE);
    // The render runtime is the session's shared Core runtime services plus
    // the caller-owned abort signal.
    expect(requests[0]?.runtime.services).toBe(session.runtime.services);
    expect(requests[0]?.runtime.signal).toBeInstanceOf(AbortSignal);
    expect(service.getResult(operationHandle)).toMatchObject({ operationId: terminal.operationId });
    await service.close();
  });

  it('resolves render reference chunks only after queue authorization with a project-bound tenant', async () => {
    const requests: Array<{ request: EditorialRenderRequestV1; runtime: EditorialRuntime }> = [];
    const getChunk = vi.fn(async () => {
      return {
        version: 1 as const,
        chunk: {
          version: 1 as const,
          referenceId: 'guide',
          chunkId: 'guide:0',
          ordinal: 0,
          range: { version: 1 as const, offset: 0, length: 14 },
          byteLength: 14,
          contentHash: 'a'.repeat(64),
          chunkHash: 'b'.repeat(64),
          locator: 'guide.txt#0',
          quote: 'A bounded quote',
        },
      };
    });
    const unsupported = async (): Promise<never> => {
      throw new Error('Reference operation is not exercised by this test.');
    };
    const reference: McpReferencePort = {
      list: unsupported,
      get: unsupported,
      search: unsupported,
      getChunk,
      readContent: unsupported,
      importBegin: unsupported,
      importChunk: unsupported,
      importCommit: unsupported,
      jobGet: unsupported,
      retry: unsupported,
      delete: unsupported,
    };
    const source = withContent(
      FIXTURE,
      'nova.yaml',
      fixtureDocument('nova.yaml').content.replace('project: zhu-fu', 'project: p1'),
    );
    const { session, detachedOperations } = fakeSession({ source });
    const { service } = await createOperationService(session);
    const registry = createProjectSessionMcpRegistry(session, {
      reference,
      operations: service,
      candidates: {
        execute: async (request, runtime) => {
          requests.push({ request, runtime });
          return { kind: 'failed', result: stubRenderResult(request.mutation.operationId) };
        },
        commit: async () => {
          throw new Error('commit must not run for a failed preflight outcome');
        },
      },
    });
    const caller = callerFor(
      grantWith({
        userId: 'u1',
        projectId: 'p1',
        scopes: [MCP_RENDER_SCOPE, MCP_REFERENCE_READ_SCOPE],
        version: 2,
      }),
    );

    const result = await registry.run('nova_render', caller, {
      sceneSelector: { type: 'all' },
      referenceChunks: [{ referenceId: 'guide', chunkId: 'guide:0' }],
    });

    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    // Chunk resolution is deferred to the queued runner: nothing is read at
    // enqueue time, only after the operation is authorized and running.
    expect(getChunk).not.toHaveBeenCalled();
    const operationHandle = (result.data as { operationHandle: string }).operationHandle;
    await waitFor(() => detachedOperations.length === 1, 'render operation to be created');
    const operation = detachedOperations[0];
    if (operation === undefined) throw new Error('detached render operation is missing');
    expect(operation.scope).toEqual([MCP_RENDER_SCOPE, MCP_REFERENCE_READ_SCOPE]);
    await waitForTerminal(service, operationHandle);
    expect(getChunk).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.request.referencePacket).toEqual({
      version: 1,
      projectId: 'p1',
      citations: [
        {
          version: 1,
          citationId: 'guide:guide:0:0',
          referenceId: 'guide',
          chunkId: 'guide:0',
          contentHash: 'a'.repeat(64),
          chunkHash: 'b'.repeat(64),
          quote: 'A bounded quote',
          locator: 'guide.txt#0',
          authoritative: false,
        },
      ],
    });
    await service.close();
  });

  it('rejects client-supplied actorId/operationId and invalid render input without touching the queue', async () => {
    const { session, operations, detachedOperations } = fakeSession({ source: FIXTURE });
    const { service } = await createOperationService(session);
    const registry = createProjectSessionMcpRegistry(session, { operations: service });
    const caller = callerFor(
      grantWith({ userId: 'u1', projectId: 'p1', scopes: [MCP_RENDER_SCOPE] }),
    );

    expectError(
      await registry.run('nova_render', caller, {
        sceneSelector: { type: 'all' },
        actorId: 'attacker',
        operationId: 'spoofed',
      }),
      'UNKNOWN_FIELD',
    );
    expectError(await registry.run('nova_render', caller, {}), 'INVALID_INPUT');
    expectError(
      await registry.run('nova_render', caller, {
        sceneSelector: { type: 'events', eventIds: 'not-an-array' },
      }),
      'INVALID_INPUT',
    );
    expect(operations).toHaveLength(0);
    expect(detachedOperations).toHaveLength(0);
    expect(await service.list()).toHaveLength(0);
    await service.close();
  });

  it('maps detached outcomes onto the durable operation record: denied, failed, succeeded', async () => {
    const runWith = async (
      detached: SessionDetachedOperationResult<unknown>,
    ): Promise<{ result: McpToolResult; service: ProjectOperationService; handle: string }> => {
      const { session } = fakeSession({ source: FIXTURE, detached: async () => detached });
      const { service } = await createOperationService(session);
      const registry = createProjectSessionMcpRegistry(session, { operations: service });
      const caller = callerFor(
        grantWith({ userId: 'u1', projectId: 'p1', scopes: [MCP_RENDER_SCOPE] }),
      );
      const result = await registry.run('nova_render', caller, { sceneSelector: { type: 'all' } });
      const handle = result.ok ? (result.data as { operationHandle: string }).operationHandle : '';
      return { result, service, handle };
    };

    // Denied at the detached gate: the tool still returns a queued handle and
    // the durable record ends failed with the typed denial code.
    const denied = await runWith({ status: 'denied', operationId: 'op-1', reason: 'REVOKED' });
    expect(denied.result.ok).toBe(true);
    if (denied.result.ok) {
      const record = await waitForTerminal(denied.service, denied.handle);
      expect(record.status).toBe('failed');
      expect(record.errorCode).toBe('DENIED:REVOKED');
    }

    const failed = await runWith({
      status: 'failed',
      operationId: 'op-1',
      errorCode: 'PROVIDER_REQUIRED',
      message: 'No provider configured for this runtime.',
    });
    expect(failed.result.ok).toBe(true);
    if (failed.result.ok) {
      const record = await waitForTerminal(failed.service, failed.handle);
      expect(record.status).toBe('failed');
      expect(record.errorCode).toBe('PROVIDER_REQUIRED');
    }

    const completed = await runWith({
      status: 'completed',
      operationId: 'op-1',
      result: { operationId: 'op-1' },
    });
    expect(completed.result.ok).toBe(true);
    if (completed.result.ok) {
      const record = await waitForTerminal(completed.service, completed.handle);
      expect(record.status).toBe('succeeded');
      expect(completed.service.getResult(completed.handle)).toEqual({ operationId: 'op-1' });
    }
  });
  it('rejects every invalid scene selector shape as INVALID_INPUT with zero queued operations', async () => {
    const { session, operations } = fakeSession({ source: FIXTURE });
    const registry = createProjectSessionMcpRegistry(session);
    const caller = callerFor(
      grantWith({ userId: 'u1', projectId: 'p1', scopes: [MCP_RENDER_SCOPE] }),
    );

    // Mirrors Core `sceneSelectorSchema`: a discriminated union of strict
    // shapes, so every variant also rejects the other variants' keys.
    const invalidSelectors: readonly unknown[] = [
      // "all" accepts no extra chapter/eventIds keys.
      { type: 'all', chapter: 1 },
      { type: 'all', eventIds: ['E0'] },
      // "chapter" requires a positive integer and nothing else.
      { type: 'chapter' },
      { type: 'chapter', chapter: 0 },
      { type: 'chapter', chapter: -3 },
      { type: 'chapter', chapter: 1.5 },
      { type: 'chapter', chapter: NaN },
      { type: 'chapter', chapter: 2, eventIds: ['E0'] },
      // "events" requires non-empty unique non-empty strings and nothing else.
      { type: 'events' },
      { type: 'events', eventIds: [] },
      { type: 'events', eventIds: ['E0', 'E0'] },
      { type: 'events', eventIds: [''] },
      { type: 'events', eventIds: ['   '] },
      { type: 'events', eventIds: ['E0', 7] },
      { type: 'events', eventIds: 'E0' },
      // Unknown discriminator or missing type.
      { type: 'bogus' },
      {},
    ];

    for (const sceneSelector of invalidSelectors) {
      const result = await registry.run('nova_render', caller, { sceneSelector });
      expectError(result, 'INVALID_INPUT');
    }
    expect(operations).toHaveLength(0);
  });

  it('queues exactly one render operation per valid scene selector shape', async () => {
    const { session, detachedOperations } = fakeSession({ source: FIXTURE });
    const { service } = await createOperationService(session);
    const registry = createProjectSessionMcpRegistry(session, {
      operations: service,
      candidates: {
        execute: async (request) => ({
          kind: 'failed',
          result: stubRenderResult(request.mutation.operationId),
        }),
        commit: async () => {
          throw new Error('commit must not run for a failed preflight outcome');
        },
      },
    });
    const caller = callerFor(
      grantWith({ userId: 'u1', projectId: 'p1', scopes: [MCP_RENDER_SCOPE] }),
    );

    const selectors = [
      { type: 'all' },
      { type: 'chapter', chapter: 1 },
      { type: 'events', eventIds: ['E0', 'E1'] },
    ];
    const handles: string[] = [];
    for (const selector of selectors) {
      const result = await registry.run('nova_render', caller, { sceneSelector: selector });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      handles.push((result.data as { operationHandle: string }).operationHandle);
    }
    await waitFor(() => detachedOperations.length === 3, 'three render operations to be created');
    expect(detachedOperations).toHaveLength(3);
    // Each queued render payload is the server-built `{ selector, ... }`
    // envelope; narrow instead of casting so the access is type-checked.
    const queuedSelectors = detachedOperations.map((operation) => {
      const payload = operation.payload;
      if (typeof payload !== 'object' || payload === null || !('selector' in payload)) {
        throw new Error('queued render operation payload must carry a selector');
      }
      return payload.selector;
    });
    expect(queuedSelectors).toEqual(selectors);
    for (const handle of handles) {
      expect((await waitForTerminal(service, handle)).status).toBe('succeeded');
    }
    await service.close();
  });

  it('advertises exact JSON-schema bounds for the render scene selector', () => {
    const { session } = fakeSession({ source: FIXTURE });
    const registry = createProjectSessionMcpRegistry(session);
    const renderSchema = registry.get('nova_render')?.inputSchema;
    if (renderSchema === undefined) throw new Error('Missing nova_render input schema');

    const sceneSelector: McpJsonSchemaProperty = renderSchema.properties.sceneSelector;
    expect(sceneSelector.properties?.chapter?.minimum).toBe(1);
    expect(sceneSelector.properties?.chapter?.multipleOf).toBe(1);
    expect(sceneSelector.properties?.eventIds?.minItems).toBe(1);
    expect(sceneSelector.properties?.eventIds?.uniqueItems).toBe(true);
    expect(sceneSelector.properties?.eventIds?.items?.minLength).toBe(1);
  });

  it('nova_operation_cancel carries mcp:submit scope and cancels a queued render operation', async () => {
    const { session } = fakeSession({ source: FIXTURE });
    const { service } = await createOperationService(session);
    const registry = createProjectSessionMcpRegistry(session, { operations: service });

    const definition = registry.get('nova_operation_cancel');
    expect(definition?.requiredScopes).toEqual([MCP_SUBMIT_SCOPE]);
    expect(definition?.inputSchema.required).toEqual(['version', 'operationHandle']);

    const hang = gate();
    const enqueued = await service.enqueue({
      kind: 'render',
      idempotencyKey: 'cancel-1',
      actorId: 'u1',
      capabilityVersion: 1,
      sourceHash: 'hash-a',
      acceptedRevisionId: null,
      requestHash: 'cancel-req',
      runner: async () => {
        await hang.promise;
        return { status: 'succeeded', result: 'x' };
      },
    });
    expect(enqueued.status).toBe('queued');
    if (enqueued.status !== 'queued') return;

    const caller = callerFor(
      grantWith({ userId: 'u1', projectId: 'p1', scopes: [MCP_SUBMIT_SCOPE] }),
    );
    const result = await registry.run('nova_operation_cancel', caller, {
      version: 2,
      operationHandle: enqueued.operationHandle,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      version: 2,
      operationId: enqueued.operationHandle,
      status: 'cancelled',
    });
    expect((await service.get(enqueued.operationHandle))?.status).toBe('cancelled');
    // The late runner outcome cannot overwrite the cancelled row.
    hang.release();
    await waitFor(
      async () => (await service.get(enqueued.operationHandle))?.status === 'cancelled',
      'cancelled row to stay cancelled',
    );
    await service.close();
  });

  it('nova_operation_cancel requires mcp:submit and returns a typed not-found error', async () => {
    const { session } = fakeSession({ source: FIXTURE });
    const { service } = await createOperationService(session);
    const registry = createProjectSessionMcpRegistry(session, { operations: service });
    const readCaller = callerFor(
      grantWith({ userId: 'u1', projectId: 'p1', scopes: [MCP_READ_SCOPE] }),
    );
    const submitCaller = callerFor(
      grantWith({ userId: 'u1', projectId: 'p1', scopes: [MCP_SUBMIT_SCOPE] }),
    );

    expectError(
      await registry.run('nova_operation_cancel', readCaller, {
        version: 2,
        operationHandle: 'op-1',
      }),
      'SCOPE_MISMATCH',
    );
    expectError(
      await registry.run('nova_operation_cancel', submitCaller, {
        version: 2,
        operationHandle: 'missing-op',
      }),
      'OPERATION_NOT_FOUND',
    );
    await service.close();
  });

  it('serializes validateNovel results so an event id of "__proto__" becomes an own data property', async () => {
    const protoEvent = [
      'event: __proto__',
      'narrativeOrder: 99',
      'title: "prototype-key serialization test event"',
      'pov:',
      '  character: narrator',
      '  type: first_person',
      'sceneBrief: "Minimal event used to verify prototype-key-safe validation serialization."',
      'beats:',
      '  - "test beat"',
      'preconditions: []',
      'expectedPostconditions: []',
      '',
    ].join('\n');
    // The discourse ledger must cover every reachable event (Core throws
    // "omits reachable scene" otherwise), so add the synthetic scene id to
    // the fixture ledger's chapter in a snapshot-local copy.
    const ledger = fixtureDocument('definitions/discourse-ledger.yaml');
    const ledgerWithProto = ledger.content.replace(
      '      - E6\n',
      '      - E6\n      - __proto__\n',
    );
    const snapshot = buildSourceSnapshot([
      ...FIXTURE.documents.map((document) =>
        document.logicalPath === 'definitions/discourse-ledger.yaml'
          ? {
              ...document,
              content: ledgerWithProto,
              contentHash: computeSourceDocumentHash(ledgerWithProto),
            }
          : document,
      ),
      {
        version: 1,
        logicalPath: 'chapters/chapter_01/E99_proto.yaml',
        content: protoEvent,
        contentHash: computeSourceDocumentHash(protoEvent),
        parseResult: { status: 'parsed', value: null },
        diagnostics: [],
      },
    ]);
    const { session } = fakeSession({ source: snapshot });
    const registry = createProjectSessionMcpRegistry(session);
    const caller = callerFor(
      grantWith({ userId: 'u1', projectId: 'p1', scopes: [MCP_READ_SCOPE] }),
    );

    const result = await registry.run('nova_validate', caller, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data;
    if (typeof data !== 'object' || data === null || !('results' in data)) {
      throw new Error('nova_validate result must carry a results record');
    }
    const results = data.results;
    if (typeof results !== 'object' || results === null) {
      throw new Error('nova_validate results must be an object');
    }

    // "__proto__" must be an own JSON data property, not a prototype mutation
    // (the old `{}` + `results[key] = value` pattern silently lost it).
    expect(Object.hasOwn(results, '__proto__')).toBe(true);
    expect(Object.keys(results)).toContain('__proto__');
    expect(JSON.stringify(result.data)).toContain('"__proto__"');

    const protoResultValue = Object.getOwnPropertyDescriptor(results, '__proto__')?.value;
    if (
      typeof protoResultValue !== 'object' ||
      protoResultValue === null ||
      !('passed' in protoResultValue) ||
      !('errors' in protoResultValue) ||
      !('warnings' in protoResultValue) ||
      !('infos' in protoResultValue)
    ) {
      throw new Error('validateNovel result for "__proto__" has an unexpected shape');
    }
    expect(typeof protoResultValue.passed).toBe('boolean');
    expect(Array.isArray(protoResultValue.errors)).toBe(true);
    expect(Array.isArray(protoResultValue.warnings)).toBe(true);
    expect(Array.isArray(protoResultValue.infos)).toBe(true);
  });

  it('exposes author, submit, and admin tool families with exact non-substitutable scopes', async () => {
    const { session } = fakeSession({ source: FIXTURE });
    const registry = createProjectSessionMcpRegistry(session, {
      coordinator: fakeCoordinator(),
      admin: fakeAdmin(),
    });

    expect(registry.list([MCP_AUTHOR_SCOPE]).map((tool) => tool.name)).toEqual([
      'nova_authoring_document_list',
      MCP_TOOL_AUTHORING_STATUS,
      MCP_TOOL_AUTHORING_DOCUMENT_READ,
      MCP_TOOL_AUTHORING_DOCUMENT_EDIT,
      'nova_authoring_document_create',
      'nova_authoring_document_move',
      'nova_authoring_document_delete',
      'nova_authoring_validate',
      'nova_review_add',
      'nova_review_update',
    ]);
    expect(registry.list([MCP_SUBMIT_SCOPE]).map((tool) => tool.name)).toEqual([
      MCP_TOOL_AUTHORING_SUBMIT,
      MCP_TOOL_OPERATION_GET,
      'nova_operation_cancel',
      'nova_authoring_conflict_read',
      MCP_TOOL_CONFLICT_RESOLVE,
      'nova_revision_restore',
      'nova_release_gate_decide',
      'nova_publish',
    ]);
    expect(registry.list([MCP_ADMIN_SCOPE]).map((tool) => tool.name)).toEqual([
      'nova_admin_config_get',
      'nova_admin_project_list',
      'nova_admin_project_validate',
      'nova_admin_project_create',
      'nova_admin_project_update',
      'nova_admin_project_delete',
      'nova_admin_project_open',
      'nova_admin_project_close',
      'nova_admin_project_recover',
      'nova_admin_membership_list',
      'nova_admin_membership_upsert',
      'nova_admin_membership_revoke',
      'nova_admin_invite_list',
      'nova_admin_invite_create',
      'nova_admin_invite_revoke',
      'nova_admin_device_list',
      'nova_admin_device_pair_begin',
      'nova_admin_device_revoke',
      'nova_admin_operation_list',
      'nova_admin_operation_get',
      'nova_admin_plugins_discovered',
      MCP_TOOL_ADMIN_CONFIG_PREVIEW,
      MCP_TOOL_ADMIN_CONFIG_APPLY,
    ]);
    expect(registry.availableScopes).toEqual([
      MCP_READ_SCOPE,
      MCP_RENDER_SCOPE,
      MCP_AUTHOR_SCOPE,
      MCP_SUBMIT_SCOPE,
      MCP_ADMIN_SCOPE,
    ]);

    const authorOnly = callerFor(
      grantWith({ userId: 'u1', projectId: 'p1', scopes: [MCP_AUTHOR_SCOPE] }),
    );
    const submitOnly = callerFor(
      grantWith({ userId: 'u1', projectId: 'p1', scopes: [MCP_SUBMIT_SCOPE] }),
    );
    const adminOnly = callerFor(
      grantWith({ userId: 'u1', projectId: 'p1', scopes: [MCP_ADMIN_SCOPE] }),
    );

    // author cannot submit/resolve; submit cannot author; admin cannot do either.
    expectError(
      await registry.run(MCP_TOOL_AUTHORING_SUBMIT, authorOnly, {
        version: 2,
        expectedWorkspaceDigest: 'wd-1',
      }),
      'SCOPE_MISMATCH',
    );
    expectError(
      await registry.run(MCP_TOOL_AUTHORING_DOCUMENT_EDIT, submitOnly, {
        version: 2,
        documentId: 'doc-1',
        expectedWorkspaceDigest: 'wd-1',
        expectedAcceptedSourceHash: null,
        expectedStateVectorHash: 'vector-1',
        replacementText: 'x',
      }),
      'SCOPE_MISMATCH',
    );
    expectError(
      await registry.run(MCP_TOOL_ADMIN_CONFIG_PREVIEW, authorOnly, FAKE_CONFIG_REQUEST),
      'SCOPE_MISMATCH',
    );
    expectError(
      await registry.run(MCP_TOOL_AUTHORING_STATUS, adminOnly, { version: 2 }),
      'SCOPE_MISMATCH',
    );
  });

  it('fails closed when the coordinator or admin port is not injected', async () => {
    const { session } = fakeSession({ source: FIXTURE });
    const registry = createProjectSessionMcpRegistry(session);
    const authorOnly = callerFor(
      grantWith({ userId: 'u1', projectId: 'p1', scopes: [MCP_AUTHOR_SCOPE] }),
    );
    const submitOnly = callerFor(
      grantWith({ userId: 'u1', projectId: 'p1', scopes: [MCP_SUBMIT_SCOPE] }),
    );
    const adminOnly = callerFor(
      grantWith({ userId: 'u1', projectId: 'p1', scopes: [MCP_ADMIN_SCOPE] }),
    );

    expectError(
      await registry.run(MCP_TOOL_AUTHORING_STATUS, authorOnly, { version: 2 }),
      'PROJECT_NOT_READY',
    );
    expectError(
      await registry.run(MCP_TOOL_AUTHORING_SUBMIT, submitOnly, {
        version: 2,
        expectedWorkspaceDigest: 'wd-1',
      }),
      'PROJECT_NOT_READY',
    );
    expectError(
      await registry.run(MCP_TOOL_ADMIN_CONFIG_PREVIEW, adminOnly, FAKE_CONFIG_REQUEST),
      'NO_ADMIN_CONFIGURATION',
    );
    expectError(
      await registry.run(MCP_TOOL_ADMIN_CONFIG_APPLY, adminOnly, FAKE_CONFIG_REQUEST),
      'NO_ADMIN_CONFIGURATION',
    );
  });

  it('rejects unknown fields, wrong versions, and wrong projects on scoped tools', async () => {
    const { session } = fakeSession({ source: FIXTURE });
    const registry = createProjectSessionMcpRegistry(session, {
      coordinator: fakeCoordinator(),
      admin: fakeAdmin(),
    });
    const caller = callerFor(
      grantWith({
        userId: 'u1',
        projectId: 'p1',
        scopes: [MCP_AUTHOR_SCOPE, MCP_SUBMIT_SCOPE, MCP_ADMIN_SCOPE],
      }),
    );

    // No actorId, path, token, or raw Yjs field may smuggle through.
    expectError(
      await registry.run(MCP_TOOL_AUTHORING_DOCUMENT_EDIT, caller, {
        version: 2,
        projectId: 'p1',
        documentId: 'doc-1',
        expectedWorkspaceDigest: 'wd-1',
        expectedAcceptedSourceHash: null,
        replacementText: 'x',
        actorId: 'u2',
      }),
      'UNKNOWN_FIELD',
    );
    expectError(
      await registry.run(MCP_TOOL_AUTHORING_STATUS, caller, { version: 1 }),
      'INVALID_INPUT',
    );
    expectError(
      await registry.run(MCP_TOOL_AUTHORING_DOCUMENT_READ, caller, {
        version: 2,
        projectId: 'p-other',
        documentId: 'doc-1',
        offset: 0,
        limit: 1,
      }),
      'UNKNOWN_FIELD',
    );
    expectError(
      await registry.run(MCP_TOOL_AUTHORING_DOCUMENT_EDIT, caller, {
        version: 2,
        documentId: 'doc-1',
        expectedWorkspaceDigest: 'wd-1',
        expectedAcceptedSourceHash: 7,
        expectedStateVectorHash: 'vector-1',
        replacementText: 'x',
      }),
      'INVALID_INPUT',
    );
    expectError(
      await registry.run(MCP_TOOL_CONFLICT_RESOLVE, caller, {
        version: 2,
        choice: 'merge-everything',
        candidateHash: null,
      }),
      'INVALID_INPUT',
    );
    expectError(
      await registry.run(MCP_TOOL_ADMIN_CONFIG_PREVIEW, caller, {
        ...FAKE_CONFIG_REQUEST,
        configuration: {
          ...FAKE_CONFIG_REQUEST.configuration,
          projects: [{ projectId: 'p1', displayName: 'P', token: 'secret' }],
        },
      }),
      'UNKNOWN_FIELD',
    );
    expectError(
      await registry.run(MCP_TOOL_ADMIN_CONFIG_APPLY, caller, {
        ...FAKE_CONFIG_REQUEST,
        expectedRevision: 42,
      }),
      'INVALID_INPUT',
    );
  });

  it('routes authoring effects through the coordinator with typed stale-vector failure, never last-writer-wins', async () => {
    const { session } = fakeSession({ source: FIXTURE });
    const applied: McpAuthoringApplyOutputV1[] = [];
    const submitted: McpAuthoringSubmitOutputV1[] = [];
    const coordinator = fakeCoordinator({
      editDocument: async (_input) => {
        applied.push({
          status: 'stale',
          failure: { code: 'WORKSPACE_STALE', message: 'The workspace digest moved.' },
        });
        return applied[applied.length - 1];
      },
      submit: async (_input) => {
        submitted.push({
          status: 'rejected',
          failure: { code: 'SUBMIT_BLOCKED', message: 'blocked' },
        });
        return submitted[submitted.length - 1];
      },
    });
    const registry = createProjectSessionMcpRegistry(session, { coordinator });
    const caller = callerFor(
      grantWith({
        userId: 'u1',
        projectId: 'p1',
        scopes: [MCP_AUTHOR_SCOPE, MCP_SUBMIT_SCOPE],
      }),
    );

    // A stale digest is a typed failure; the coordinator CAS is authoritative.
    const applyResult = await registry.run(MCP_TOOL_AUTHORING_DOCUMENT_EDIT, caller, {
      version: 2,
      documentId: 'doc-1',
      expectedWorkspaceDigest: 'wd-stale',
      expectedAcceptedSourceHash: 'ash-1',
      expectedStateVectorHash: 'vector-1',
      replacementText: 'new text',
    });
    expectError(applyResult, 'WORKSPACE_STALE');
    expect(applied).toHaveLength(1);
    expect(applied[0].status).toBe('stale');

    const submitResult = await registry.run(MCP_TOOL_AUTHORING_SUBMIT, caller, {
      version: 2,
      expectedWorkspaceDigest: 'wd-stale',
    });
    expectError(submitResult, 'SUBMIT_BLOCKED');
    expect(submitted).toHaveLength(1);
    expect(submitted[0].status).toBe('rejected');

    // Queued/status/document reads flow through unchanged.
    const queued = await registry.run(MCP_TOOL_OPERATION_GET, caller, {
      version: 2,
      operationHandle: 'op-1',
    });
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    expect((queued.data as McpOperationGetOutputV1).receipt?.operationId).toBe('op-1');
  });

  it('reads coordinator state and document identity for author tools', async () => {
    const { session } = fakeSession({ source: FIXTURE });
    const registry = createProjectSessionMcpRegistry(session, {
      coordinator: fakeCoordinator(),
    });
    const caller = callerFor(
      grantWith({ userId: 'u1', projectId: 'p1', scopes: [MCP_AUTHOR_SCOPE] }),
    );

    const status = await registry.run(MCP_TOOL_AUTHORING_STATUS, caller, {
      version: 2,
    });
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.data).toEqual({
      version: 2,
      projectId: 'p1',
      state: FAKE_AUTHORING_STATE,
      nextWorkingAction: null,
      generatedAt: FAKE_AUTHORING_STATE.generatedAt,
    });

    const document = await registry.run(MCP_TOOL_AUTHORING_DOCUMENT_READ, caller, {
      version: 2,
      documentId: 'doc-1',
      offset: 0,
      limit: 64,
    });
    expect(document.ok).toBe(true);
    if (!document.ok) return;
    expect(document.data).toMatchObject({
      documentId: 'doc-1',
      logicalPath: 'nova.yaml',
    });
  });

  it('binds project-scoped native revision reads and forward restore', async () => {
    const { session } = fakeSession({ source: FIXTURE });
    let restoreInput: Parameters<AuthoringRevisionPort['restore']>[0] | null = null;
    const revision: AuthoringRevisionPort = {
      loadAccepted: async () => ({
        revisionId: 'head-1',
        sourceHash: 'source-1',
        bundleHash: 'bundle-1',
      }),
      submit: async () => ({
        status: 'accepted',
        revisionId: 'child-1',
        receiptHash: 'receipt-child',
      }),
      recover: async () => ({
        status: 'completed',
        revisionId: 'head-1',
        materializedRevisionId: 'head-1',
      }),
      list: async () => ({
        revisions: [
          {
            revisionId: 'rev-1',
            sourceHash: 'source-1',
            bundleHash: 'bundle-1',
            createdAt: '2026-08-02T00:00:00.000Z',
            acceptedAt: '2026-08-02T00:00:00.000Z',
          },
        ],
      }),
      get: async (_projectId, revisionId) =>
        revisionId === 'rev-1'
          ? {
              revisionId,
              sourceHash: 'source-1',
              bundleHash: 'bundle-1',
              createdAt: '2026-08-02T00:00:00.000Z',
              acceptedAt: '2026-08-02T00:00:00.000Z',
            }
          : null,
      diff: async () => ({
        changes: [{ logicalPath: 'nova.yaml', beforeHash: 'before', afterHash: 'after' }],
      }),
      restore: async (input) => {
        restoreInput = input;
        return { status: 'accepted', revisionId: 'child-1', receiptHash: 'receipt-child' };
      },
    };
    const registry = createProjectSessionMcpRegistry(session, { revision });
    const reader = callerFor(
      grantWith({ userId: 'u1', projectId: 'p1', scopes: [MCP_READ_SCOPE] }),
    );
    const maintainer = callerFor(
      grantWith({ userId: 'u1', projectId: 'p1', scopes: [MCP_SUBMIT_SCOPE] }),
    );
    await expect(registry.run('nova_revision_list', reader, { version: 2 })).resolves.toMatchObject(
      { ok: true },
    );
    await expect(
      registry.run('nova_revision_get', reader, { version: 2, revisionId: 'rev-1' }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      registry.run('nova_revision_diff', reader, {
        version: 2,
        fromRevisionId: 'rev-1',
        toRevisionId: 'head-1',
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      registry.run('nova_revision_restore', maintainer, {
        version: 2,
        revisionId: 'rev-1',
        expectedAcceptedRevisionId: 'head-1',
        expectedSourceHash: 'source-1',
      }),
    ).resolves.toMatchObject({ ok: true, data: { revisionId: 'child-1' } });
    expect(restoreInput).toMatchObject({
      projectId: 'p1',
      revisionId: 'rev-1',
      expectedAcceptedRevisionId: 'head-1',
      expectedSourceHash: 'source-1',
      actorId: 'u1',
    });
  });

  it('validates admin config requests strictly and routes preview/apply to the admin port', async () => {
    const { session } = fakeSession({ source: FIXTURE });
    const seen: unknown[] = [];
    const admin = fakeAdmin({
      preview: async (input) => {
        seen.push({ surface: 'preview', input });
        return FAKE_RECEIPT_OK;
      },
      apply: async (input) => {
        seen.push({ surface: 'apply', input });
        return { ...FAKE_RECEIPT_OK, status: 'restart-required' };
      },
    });
    const registry = createProjectSessionMcpRegistry(session, { admin });
    const caller = callerFor(
      grantWith({ userId: 'u1', projectId: 'p1', scopes: [MCP_ADMIN_SCOPE] }),
    );

    const preview = await registry.run(MCP_TOOL_ADMIN_CONFIG_PREVIEW, caller, FAKE_CONFIG_REQUEST);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.data).toEqual(FAKE_RECEIPT_OK);

    const apply = await registry.run(MCP_TOOL_ADMIN_CONFIG_APPLY, caller, FAKE_CONFIG_REQUEST);
    expect(apply.ok).toBe(true);
    if (!apply.ok) return;
    expect(apply.data).toMatchObject({ status: 'restart-required' });

    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({ surface: 'preview', input: EXPECTED_CANONICAL_CONFIG_REQUEST });
    expect(seen[1]).toMatchObject({ surface: 'apply' });
  });
  it('advertises provider null in the admin config schema and accepts that valid envelope', async () => {
    const descriptor = MCP_TOOL_CATALOG_V1.find(
      (tool) => tool.name === MCP_TOOL_ADMIN_CONFIG_APPLY,
    );
    if (descriptor === undefined) throw new Error('Missing admin config apply descriptor');
    expect(descriptor.inputSchema.properties.configuration.properties?.provider.type).toEqual([
      'object',
      'null',
    ]);

    const { session } = fakeSession({ source: FIXTURE });
    const registry = createProjectSessionMcpRegistry(session, { admin: fakeAdmin() });
    const caller = callerFor(
      grantWith({ userId: 'u1', projectId: 'p1', scopes: [MCP_ADMIN_SCOPE] }),
    );
    await expect(
      registry.run(MCP_TOOL_ADMIN_CONFIG_APPLY, caller, {
        ...FAKE_CONFIG_REQUEST,
        configuration: { ...FAKE_CONFIG_REQUEST.configuration, provider: null },
      }),
    ).resolves.toMatchObject({ ok: true });
  });
  it('routes every owner-admin family through its injected service port', async () => {
    const { session } = fakeSession({ source: FIXTURE });
    const calls: string[] = [];
    const admin: McpAdminPort = {
      get: async () => ({ version: 1, configuration: null }),
      preview: async () => FAKE_RECEIPT_OK,
      apply: async () => FAKE_RECEIPT_OK,
      projectList: async () => ({ projects: [] }),
      projectValidate: async () => ({ valid: true }),
      projectCreate: async () => ({ created: true }),
      projectUpdate: async () => ({ updated: true }),
      projectDelete: async () => ({ deleted: true }),
      projectOpen: async () => ({ open: true }),
      projectClose: async () => ({ open: false }),
      projectRecover: async () => ({ recovered: true }),
      membershipList: async () => ({ memberships: [] }),
      membershipUpsert: async () => ({ membership: null }),
      membershipRevoke: async () => ({ revoked: true }),
      inviteList: async () => ({ invites: [] }),
      inviteCreate: async () => ({ invite: null }),
      inviteRevoke: async () => ({ revoked: true }),
      deviceList: async () => ({ devices: [] }),
      devicePairBegin: async () => ({ pairingCode: 'pair', expiresAt: '2099-01-01T00:00:00.000Z' }),
      deviceRevoke: async () => ({ revoked: true }),
      operationList: async () => ({ operations: [] }),
      operationGet: async () => ({ operation: null }),
      pluginsDiscovered: async () => ({
        version: 1,
        projectId: 'p1',
        plugins: [{ name: 'plugin-a', version: '1.0.0' }],
      }),
    };
    const registry = createProjectSessionMcpRegistry(session, { family: 'admin', admin });
    const caller = callerFor(
      grantWith({ userId: 'owner-1', projectId: 'p1', scopes: [MCP_ADMIN_SCOPE] }),
    );
    const invoke = async (name: string, input: unknown) => {
      const result = await registry.run(name, caller, input);
      expect(result.ok).toBe(true);
      calls.push(name);
    };
    await invoke('nova_admin_config_get', {});
    await invoke('nova_admin_project_list', { version: 1 });
    await invoke('nova_admin_project_create', {
      version: 1,
      projectId: 'p2',
      displayName: 'Project Two',
    });
    await invoke('nova_admin_membership_upsert', {
      version: 1,
      userId: 'u2',
      projectId: 'p1',
      role: 'author',
    });
    await invoke('nova_admin_invite_create', {
      version: 1,
      projectId: 'p1',
      role: 'reader',
      ttlMs: 3600000,
    });
    await invoke('nova_admin_device_pair_begin', {
      version: 1,
      kind: 'project',
      projectId: 'p1',
      role: 'reader',
      ttlMs: 3600000,
    });
    await invoke('nova_admin_operation_list', { version: 1, limit: 10 });
    await invoke('nova_admin_plugins_discovered', { version: 1, projectId: 'p1' });
    expect(calls).toHaveLength(8);
    await expect(
      registry.run('nova_admin_plugins_discovered', caller, { version: 1, projectId: 7 }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    });
    await expect(
      registry.run('nova_admin_project_open', caller, { version: 1, projectId: 7 }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    });
  });
});
