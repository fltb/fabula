import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CoreRuntimeServices,
  ProjectCoreRuntime,
  ProjectSourceSnapshotV1,
} from '@novalistically/core';
import type {
  EditorialRenderRequestV1,
  EditorialRuntime,
  RenderNovelResult,
} from '@novalistically/core/editorial';
import { buildSourceSnapshot, computeSourceDocumentHash } from '@novalistically/core/source';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentCapabilityGrant, AgentCapabilityService } from '../src/host/agent/index.js';
import {
  AgentCapabilityService as CapabilityService,
  createCapabilityPersistence,
} from '../src/host/agent/index.js';
import {
  createMcpAuthorizationPort,
  MCP_AUTH_FAILURE_STATUS,
  type McpAuthFailureCode,
  type McpAuthorizationPort,
  mcpAuthFailureStatus,
} from '../src/host/mcp/auth.js';
import {
  createProjectSessionMcpRegistry,
  MCP_READ_SCOPE,
  MCP_RENDER_SCOPE,
  type McpJsonInputSchema,
  type McpJsonSchemaProperty,
  type McpToolResult,
} from '../src/host/mcp/registry.js';
import type {
  ProjectSession,
  ProjectSessionProjectionV1,
  SessionOperation,
  SessionOperationResult,
} from '../src/host/project-session.js';
import { createRealPersistence, type RealPersistenceHarness } from './helpers/real-persistence.js';

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

interface FakeSessionOptions {
  source: ProjectSourceSnapshotV1 | null;
  enqueue?: (operation: SessionOperation) => Promise<SessionOperationResult>;
}

function fakeSession(options: FakeSessionOptions): {
  session: ProjectSession;
  operations: SessionOperation[];
} {
  const operations: SessionOperation[] = [];
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
    enqueueOperation: async (operation) => {
      operations.push(operation);
      if (options.enqueue) return options.enqueue(operation);
      throw new Error('enqueueOperation was not configured for this session double');
    },
  };
  return { session, operations };
}

function callerFor(grant: AgentCapabilityGrant, sessionId = 'session-live') {
  return { sessionId, userId: grant.userId, grant };
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

// ─── McpAuthorizationPort over real persistence ──────────────────────────────

describe('McpAuthorizationPort', () => {
  let harness: RealPersistenceHarness;
  let now: number;
  let capabilities: AgentCapabilityService;
  let authorize: McpAuthorizationPort['authorize'];

  beforeEach(() => {
    harness = createRealPersistence();
    now = Date.parse('2026-08-02T00:00:00.000Z');
    capabilities = new CapabilityService({
      persistence: createCapabilityPersistence(harness.client),
      now: () => now,
    });
    const port = createMcpAuthorizationPort({
      sessions: {
        getSession: async (sessionId) => harness.client.request('loadSession', { sessionId }),
      },
      capabilities,
      now: () => new Date(now).toISOString(),
    });
    authorize = (input) => port.authorize(input);
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

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.caller).toEqual({
      sessionId,
      userId: 'u1',
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

  it('rejects a token presented for the wrong project or uncovered scopes with 403 codes', async () => {
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

    const wrongScope = await authorize({
      sessionId,
      token: issued.token,
      projectId: 'p1',
      scopes: [MCP_RENDER_SCOPE],
    });
    expect(wrongScope.ok).toBe(false);
    if (wrongScope.ok) return;
    expect(wrongScope.failure.code).toBe('SCOPE_MISMATCH');
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
    };
    for (const [code, status] of Object.entries(expected)) {
      expect(MCP_AUTH_FAILURE_STATUS[code as McpAuthFailureCode]).toBe(status);
      expect(mcpAuthFailureStatus(code as McpAuthFailureCode)).toBe(status);
    }
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
    ]);

    const all = registry.list([MCP_READ_SCOPE, MCP_RENDER_SCOPE]).map((tool) => tool.name);
    expect(all).toHaveLength(8);
    expect(all).toContain('nova_render');

    // A render-only grant exposes only the render tool.
    expect(registry.list([MCP_RENDER_SCOPE]).map((tool) => tool.name)).toEqual(['nova_render']);

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
    const statusData = status.data as {
      projection: { sourceHash: string | null };
      status: { summary: { totalEvents: number } } | null;
    };
    expect(statusData.projection.sourceHash).toBe(FIXTURE.sourceHash);
    const currentStatus = statusData.status;
    if (currentStatus === null)
      throw new Error('Status tool did not return accepted-source status');
    expect(currentStatus.summary.totalEvents).toBeGreaterThan(0);

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

    // status is defined over the projection and reports a null core status.
    const status = await registry.run('nova_status', caller, {});
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect((status.data as { status: unknown }).status).toBeNull();
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

  it('queues render through the session with server-derived identity and services', async () => {
    const requests: Array<{ request: EditorialRenderRequestV1; runtime: EditorialRuntime }> = [];
    const renderStub: (
      request: EditorialRenderRequestV1,
      runtime: EditorialRuntime,
    ) => Promise<RenderNovelResult> = async (request, runtime) => {
      requests.push({ request, runtime });
      return {
        operationId: 'echoed',
        results: [],
        errors: [],
        editorialErrors: [],
        publication: { status: 'current', outputPath: 'out.md', novelHash: null, reasons: [] },
      };
    };
    const { session, operations } = fakeSession({
      source: FIXTURE,
      enqueue: async (operation) => {
        const result = await operation.run({
          projectId: 'p1',
          operationId: 'srv-op-7',
          actorId: 'u1',
          capabilityVersion: 2,
          scopes: [MCP_RENDER_SCOPE],
        });
        return { status: 'completed', operationId: 'srv-op-7', result };
      },
    });
    const registry = createProjectSessionMcpRegistry(session, { render: renderStub });
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
    expect(operations).toHaveLength(1);
    const operation = operations[0];
    expect(operation.kind).toBe('render');
    expect(operation.capabilityId).toBe('cap-render');
    expect(operation.scope).toEqual([MCP_RENDER_SCOPE]);
    expect(operation.expectedVersion).toBe(2);
    // The queued payload carries the client's selection only — never identity.
    expect(operation.payload).toEqual({ selector: { type: 'all' }, model: 'mock' });
    expect(operation.payload).not.toHaveProperty('actorId');
    expect(operation.payload).not.toHaveProperty('operationId');

    expect(requests).toHaveLength(1);
    expect(requests[0].request.mutation).toEqual({ operationId: 'srv-op-7', actorId: 'u1' });
    expect(requests[0].request.source).toBe(FIXTURE);
    // The render runtime is the session's shared Core runtime services.
    expect(requests[0].runtime).toEqual({ services: session.runtime.services });
  });

  it('rejects client-supplied actorId/operationId and invalid render input without touching the queue', async () => {
    const { session, operations } = fakeSession({ source: FIXTURE });
    const registry = createProjectSessionMcpRegistry(session, {
      render: async () => ({
        operationId: 'echoed',
        results: [],
        errors: [],
        editorialErrors: [],
        publication: { status: 'current', outputPath: 'out.md', novelHash: null, reasons: [] },
      }),
    });
    const caller = callerFor(
      grantWith({ userId: 'u1', projectId: 'p1', scopes: [MCP_RENDER_SCOPE] }),
    );

    expectError(
      await registry.run('nova_render', caller, {
        sceneSelector: { type: 'all' },
        actorId: 'attacker',
        operationId: 'spoofed',
      }),
      'INVALID_INPUT',
    );
    expectError(await registry.run('nova_render', caller, {}), 'INVALID_INPUT');
    expectError(
      await registry.run('nova_render', caller, {
        sceneSelector: { type: 'events', eventIds: 'not-an-array' },
      }),
      'INVALID_INPUT',
    );
    expect(operations).toHaveLength(0);
  });

  it('surfaces typed session outcomes: denied, failed, and completed', async () => {
    const runWith = async (outcome: SessionOperationResult): Promise<McpToolResult> => {
      const { session } = fakeSession({
        source: FIXTURE,
        enqueue: async () => outcome,
      });
      const registry = createProjectSessionMcpRegistry(session);
      const caller = callerFor(
        grantWith({ userId: 'u1', projectId: 'p1', scopes: [MCP_RENDER_SCOPE] }),
      );
      return registry.run('nova_render', caller, { sceneSelector: { type: 'all' } });
    };

    const deniedResult = await runWith({
      status: 'denied',
      operationId: 'op-1',
      reason: 'REVOKED',
    });
    expectError(deniedResult, 'DENIED:REVOKED');

    const failedResult = await runWith({
      status: 'failed',
      operationId: 'op-1',
      errorCode: 'PROVIDER_REQUIRED',
      message: 'No provider configured for this runtime.',
    });
    expect(failedResult.ok).toBe(false);
    if (failedResult.ok) return;
    expect(failedResult.error.code).toBe('PROVIDER_REQUIRED');
    expect(failedResult.error.message).toContain('No provider configured');

    const completedResult = await runWith({
      status: 'completed',
      operationId: 'op-1',
      result: { operationId: 'op-1' },
    });
    expect(completedResult.ok).toBe(true);
    if (!completedResult.ok) return;
    expect(completedResult.data).toEqual({ operationId: 'op-1' });
  });
  it('rejects every invalid scene selector shape as INVALID_INPUT with zero queued operations', async () => {
    const { session, operations } = fakeSession({ source: FIXTURE });
    const registry = createProjectSessionMcpRegistry(session, {
      render: async () => ({
        operationId: 'echoed',
        results: [],
        errors: [],
        editorialErrors: [],
        publication: { status: 'current', outputPath: 'out.md', novelHash: null, reasons: [] },
      }),
    });
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
    const { session, operations } = fakeSession({
      source: FIXTURE,
      enqueue: async (operation) => {
        const result = await operation.run({
          projectId: 'p1',
          operationId: 'srv-op-7',
          actorId: 'u1',
          capabilityVersion: 2,
          scopes: [MCP_RENDER_SCOPE],
        });
        return { status: 'completed', operationId: 'srv-op-7', result };
      },
    });
    const registry = createProjectSessionMcpRegistry(session, {
      render: async () => ({
        operationId: 'echoed',
        results: [],
        errors: [],
        editorialErrors: [],
        publication: { status: 'current', outputPath: 'out.md', novelHash: null, reasons: [] },
      }),
    });
    const caller = callerFor(
      grantWith({ userId: 'u1', projectId: 'p1', scopes: [MCP_RENDER_SCOPE] }),
    );

    const selectors = [
      { type: 'all' },
      { type: 'chapter', chapter: 1 },
      { type: 'events', eventIds: ['E0', 'E1'] },
    ];
    for (const selector of selectors) {
      const result = await registry.run('nova_render', caller, { sceneSelector: selector });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
    }
    expect(operations).toHaveLength(3);
    // Each queued render payload is the server-built `{ selector, ... }`
    // envelope; narrow instead of casting so the access is type-checked.
    const queuedSelectors = operations.map((operation) => {
      const payload = operation.payload;
      if (typeof payload !== 'object' || payload === null || !('selector' in payload)) {
        throw new Error('queued render operation payload must carry a selector');
      }
      return payload.selector;
    });
    expect(queuedSelectors).toEqual(selectors);
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
});
