import { createHash } from 'node:crypto';
import type {
  CompletionRequest,
  CompletionResponse,
  CoreRuntimeServices,
  ProjectCompilation,
} from '@novalistically/core';
import { buildSourceSnapshot, computeSourceDocumentHash } from '@novalistically/core/source';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import * as Y from 'yjs';
import {
  AGENT_CLIENT_CONTRACT_VERSION,
  BROWSER_AGENT_APPLY_PATH,
  BROWSER_AGENT_PROPOSAL_PATH,
} from '../src/client/agent-client.js';
import type { EditorAssistantContextV1 } from '../src/client/editor-assistant-contract.js';
import type { BrowserSessionPrincipalV1 } from '../src/contracts/browser-api.js';
import type { WorkingDocumentState } from '../src/contracts/index.js';
import {
  type AgentCapabilityGrant,
  AgentCapabilityService,
  type AgentSuggestionService,
  type AgentTaskProvider,
  AgentTaskService,
  createAgentCommandService,
  createAgentSuggestionService,
  createCapabilityPersistence,
} from '../src/host/agent/index.js';
import {
  type AuthoringWorkingDocumentStore,
  createAuthoringDocumentStore,
} from '../src/host/authoring/document-store.js';
import { createBrowserAgentApi } from '../src/host/browser-agent-api.js';
import type {
  BrowserPrincipalResolver,
  BrowserProjectAuthorization,
  BrowserProjectCatalog,
} from '../src/host/browser-read-api.js';
import { createProjectCoreRuntime } from '../src/host/core-runtime.js';
import {
  createProjectSession,
  type ProjectionDerivationInput,
  type ProjectSession,
  type ProjectSessionProjectionV1,
  type SessionAuditRecord,
  type SessionAuditSink,
} from '../src/host/project-session.js';
import type { HostServer } from '../src/host/server.js';
import {
  createYjsWorkingDocumentCore,
  type YjsPersistencePort,
  type YjsWorkingDocumentCore,
} from '../src/host/yjs/index.js';
import { createRealPersistence } from './helpers/real-persistence.js';

// ─── Test doubles ────────────────────────────────────────────────────────────

const FIXED_NOW = '2026-08-02T00:00:00.000Z';
const PROJECT_ID = 'proj-a';
const DOCUMENT_ID = 'doc-1';
const DOC_TEXT = 'original prose';
const DEFAULT_DIFF_RESPONSE = '[{"from":0,"length":8,"text":"edited"}]';

function fakeServices(options: { now?: () => string } = {}): CoreRuntimeServices {
  let sequence = 0;
  return {
    execution: {} as CoreRuntimeServices['execution'],
    renderCache: {} as CoreRuntimeServices['renderCache'],
    stateLog: {} as CoreRuntimeServices['stateLog'],
    stateSnapshots: {} as CoreRuntimeServices['stateSnapshots'],
    promptTemplates: {
      async get() {
        return null;
      },
    },
    clock: { now: () => options.now?.() ?? FIXED_NOW },
    ids: { next: (input) => `${input?.kind ?? 'id'}-${++sequence}` },
    llm: {} as CoreRuntimeServices['llm'],
  };
}

function testDerive(input: ProjectionDerivationInput): ProjectSessionProjectionV1 {
  const diagnostics = input.snapshot
    ? input.snapshot.documents.flatMap((document) => document.diagnostics)
    : [];
  return {
    version: 1,
    projectId: input.projectId,
    revision: input.revision,
    sourceHash: input.snapshot?.sourceHash ?? null,
    documents: input.snapshot?.documents.length ?? 0,
    events: input.snapshot?.documents.length ?? 0,
    rendered: 0,
    pending: 0,
    blocked: 0,
    errorCount: diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length,
    warningCount: diagnostics.filter((diagnostic) => diagnostic.severity === 'warning').length,
    diagnostics,
    presence: input.presence,
    generatedAt: input.generatedAt,
  };
}

function recordingAudit(): { sink: SessionAuditSink; records: SessionAuditRecord[] } {
  const records: SessionAuditRecord[] = [];
  return { sink: { record: (record) => void records.push(record) }, records };
}

/** In-memory Yjs persistence port (mirrors tests/yjs-gateway.test.ts). */
function fakePersistence(): YjsPersistencePort {
  const stored = new Map<string, WorkingDocumentState>();
  return {
    async loadWorkingDocument(key) {
      return stored.get(`${key.projectId}:${key.documentId}`) ?? null;
    },
    async persistYjsUpdate(input) {
      const state: WorkingDocumentState = {
        key: { projectId: input.projectId, documentId: input.documentId },
        stateVector: input.stateVector ?? new Uint8Array(),
        update: input.update,
        updatedAt: FIXED_NOW,
      };
      stored.set(`${input.projectId}:${input.documentId}`, state);
      return state;
    },
  };
}

class FakeTaskProvider implements AgentTaskProvider {
  readonly name = 'fake-provider';
  calls = 0;
  lastRequest: CompletionRequest | null = null;

  constructor(private readonly next: () => CompletionResponse | Error) {}

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.calls += 1;
    this.lastRequest = request;
    const result = this.next();
    if (result instanceof Error) throw result;
    return result;
  }
}

function diffResponse(content = DEFAULT_DIFF_RESPONSE): CompletionResponse {
  return {
    id: 'resp-1',
    model: 'fake-model',
    content,
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    finishReason: 'stop',
  };
}

// ─── Harness ─────────────────────────────────────────────────────────────────

interface BrowserAgentFixture {
  documents: AuthoringWorkingDocumentStore;
  core: YjsWorkingDocumentCore;
  session: ProjectSession;
  capabilityService: AgentCapabilityService;
  audit: { sink: SessionAuditSink; records: SessionAuditRecord[] };
  provider: FakeTaskProvider;
  suggestions: AgentSuggestionService;
  app: Hono;
  registeredPaths: readonly string[];
  issueCapability: Mock<
    (input: {
      readonly principal: BrowserSessionPrincipalV1;
    }) => Promise<{ readonly capabilityId: string; readonly scopes: readonly string[] }>
  >;
  grant: AgentCapabilityGrant;
  principal: BrowserSessionPrincipalV1;
  humanEditing: { value: boolean };
  dispose: () => Promise<void>;
}

async function createFixture(
  options: {
    principalOk?: boolean;
    canAccessProject?: boolean;
    projectRole?: 'reader' | 'author';
    inCatalog?: boolean;
    projectReady?: boolean;
    humanEditing?: boolean;
    providerResult?: () => CompletionResponse | Error;
  } = {},
): Promise<BrowserAgentFixture> {
  const principal: BrowserSessionPrincipalV1 = {
    version: 1,
    userId: 'owner-1',
    role: 'owner',
    displayName: 'Owner',
    capabilityVersion: 3,
    expiresAt: '2099-01-01T00:00:00.000Z',
  };
  const persistence = createRealPersistence();
  const capabilityService = new AgentCapabilityService({
    persistence: createCapabilityPersistence(persistence.client),
    now: () => Date.parse(FIXED_NOW),
  });
  const audit = recordingAudit();
  const runtime = createProjectCoreRuntime({
    projectId: PROJECT_ID,
    services: fakeServices({ now: () => FIXED_NOW }),
    compile: (snapshot) => ({ events: snapshot.documents.length }) as unknown as ProjectCompilation,
  });
  const session = createProjectSession({
    projectId: PROJECT_ID,
    runtime,
    capabilities: { checkGrant: (input) => capabilityService.checkGrant(input) },
    audit: audit.sink,
    derive: testDerive,
    now: () => FIXED_NOW,
  });
  const core = createYjsWorkingDocumentCore({
    persistence: fakePersistence(),
    now: () => FIXED_NOW,
  });
  const documents = createAuthoringDocumentStore({
    projectId: PROJECT_ID,
    core,
    presenceGeneration: () => session.presenceGeneration,
    now: () => FIXED_NOW,
  });
  const snapshot = buildSourceSnapshot([
    {
      version: 1 as const,
      logicalPath: DOCUMENT_ID,
      content: DOC_TEXT,
      contentHash: computeSourceDocumentHash(DOC_TEXT),
      parseResult: { status: 'parsed' as const, value: null },
      diagnostics: [],
    },
  ]);
  await documents.seedFromAccepted(snapshot);

  const humanEditing = { value: options.humanEditing ?? false };
  const provider = new FakeTaskProvider(options.providerResult ?? (() => diffResponse()));
  const tasks = new AgentTaskService({ provider });
  const command = createAgentCommandService({
    session,
    documents,
    presence: { isHumanEditing: () => humanEditing.value },
    newEffectId: () => 'fx-1',
  });
  const suggestions = createAgentSuggestionService({
    documents,
    tasks,
    command,
    presence: { isHumanEditing: () => humanEditing.value },
    newSuggestionId: () => 'sg-1',
  });

  const { grant } = await capabilityService.issue({
    userId: principal.userId,
    projectId: PROJECT_ID,
    scopes: ['edit:prose'],
  });
  const issueCapability = vi.fn<
    (input: {
      readonly principal: BrowserSessionPrincipalV1;
    }) => Promise<{ readonly capabilityId: string; readonly scopes: readonly string[] }>
  >(async () => ({
    capabilityId: grant.capabilityId,
    scopes: grant.scopes,
  }));
  const project = { projectId: PROJECT_ID, documents, suggestions, issueCapability };
  const projects = {
    get: async (id: string) =>
      options.projectReady === false ? null : id === PROJECT_ID ? project : null,
  };
  const principalResolver: BrowserPrincipalResolver = {
    resolve: async () =>
      options.principalOk === false
        ? { ok: false as const, failure: 'SESSION_NOT_FOUND' as const }
        : { ok: true as const, principal },
  };
  const authorization: BrowserProjectAuthorization = {
    canAccessProject: (_userId, _projectId, requiredRole = 'reader') =>
      options.canAccessProject !== false &&
      ((options.projectRole ?? 'author') === 'author' || requiredRole === 'reader'),
  };
  const catalog: BrowserProjectCatalog = {
    listProjects: async () =>
      options.inCatalog === false
        ? []
        : [
            {
              version: 1,
              projectId: PROJECT_ID,
              displayName: 'Project A',
              createdAt: FIXED_NOW,
              updatedAt: FIXED_NOW,
              open: true,
            },
          ],
  };

  const registered = { mutations: new Map<string, (context: unknown) => unknown>() };
  const host = {
    registerMutationRoute(_method: string, path: string, handler: (context: unknown) => unknown) {
      registered.mutations.set(path, handler);
    },
  } as unknown as HostServer;
  createBrowserAgentApi({
    principal: principalResolver,
    authorization,
    catalog,
    projects,
  }).register(host);
  const app = new Hono();
  for (const [path, handler] of registered.mutations) app.post(path, handler as never);

  const registeredPaths = [...registered.mutations.keys()];
  const dispose = async () => {
    documents.dispose();
    await core.close();
    await persistence.dispose();
  };
  return {
    documents,
    core,
    session,
    capabilityService,
    audit,
    provider,
    suggestions,
    app,
    issueCapability,
    registeredPaths,
    grant,
    principal,
    humanEditing,
    dispose,
  };
}

async function makeContext(
  documents: AuthoringWorkingDocumentStore,
): Promise<EditorAssistantContextV1> {
  const digest = await documents.workspaceDigest();
  if (digest === null) throw new Error('expected a seeded workspace digest');
  return {
    version: 1,
    projectId: PROJECT_ID,
    documentId: DOCUMENT_ID,
    selection: { from: 0, to: 6 },
    baseVector: digest.digest,
  };
}
function proposalBody(
  context: EditorAssistantContextV1,
  instruction = 'tighten the opening',
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { version: AGENT_CLIENT_CONTRACT_VERSION, context, instruction, ...extra };
}

function applyBody(
  context: EditorAssistantContextV1,
  suggestionId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: AGENT_CLIENT_CONTRACT_VERSION,
    context,
    proposal: {
      version: 1,
      suggestionId,
      projectId: context.projectId,
      documentId: context.documentId,
    },
    ...extra,
  };
}

function post(app: Hono, path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

let activeHarness: { dispose: () => Promise<void> } | undefined;

afterEach(async () => {
  const harness = activeHarness;
  activeHarness = undefined;
  await harness?.dispose();
});

// ─── Authorization boundary ──────────────────────────────────────────────────

describe('browser Agent API authorization boundary', () => {
  it('registers the guarded proposal and apply mutations under the contract paths', async () => {
    const h = await createFixture();
    activeHarness = h;
    expect(h.registeredPaths).toEqual(
      expect.arrayContaining([BROWSER_AGENT_PROPOSAL_PATH, BROWSER_AGENT_APPLY_PATH]),
    );
  });
  it('rejects unauthenticated requests before touching the project or capability services', async () => {
    const h = await createFixture({ principalOk: false });
    activeHarness = h;
    const context = await makeContext(h.documents);
    const proposal = await post(
      h.app,
      '/api/v1/projects/proj-a/agent/proposals',
      proposalBody(context),
    );
    expect(proposal.status).toBe(401);
    const apply = await post(
      h.app,
      '/api/v1/projects/proj-a/agent/proposals/sg-1/apply',
      applyBody(context, 'sg-1'),
    );
    expect(apply.status).toBe(401);
    expect(h.provider.calls).toBe(0);
    expect(h.issueCapability).not.toHaveBeenCalled();
  });

  it('hides projects the principal cannot access or that are not catalogued', async () => {
    const unauthorized = await createFixture({ canAccessProject: false });
    activeHarness = unauthorized;
    const context = await makeContext(unauthorized.documents);
    const denied = await post(
      unauthorized.app,
      '/api/v1/projects/proj-a/agent/proposals',
      proposalBody(context),
    );
    expect(denied.status).toBe(404);
    expect(unauthorized.provider.calls).toBe(0);

    await unauthorized.dispose();
    const uncatalogued = await createFixture({ inCatalog: false });
    activeHarness = uncatalogued;
    const missing = await post(
      uncatalogued.app,
      '/api/v1/projects/proj-a/agent/proposals',
      proposalBody(context),
    );
    expect(missing.status).toBe(404);
    expect(uncatalogued.provider.calls).toBe(0);
  });

  it('returns PROJECT_NOT_READY when the runtime has no project object', async () => {
    const h = await createFixture({ projectReady: false });
    activeHarness = h;
    const context = await makeContext(h.documents);
    const response = await post(
      h.app,
      '/api/v1/projects/proj-a/agent/proposals',
      proposalBody(context),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: 'PROJECT_NOT_READY' } });
  });
});

// ─── Proposal surface ────────────────────────────────────────────────────────

describe('browser Agent proposal surface', () => {
  it('rejects malformed payloads before any provider call or capability use', async () => {
    const h = await createFixture();
    activeHarness = h;
    const context = await makeContext(h.documents);
    const cases: { label: string; body: unknown }[] = [
      { label: 'unknown field', body: { ...proposalBody(context), actorId: 'spoofed' } },
      { label: 'wrong version', body: { ...proposalBody(context), version: 2 } },
      { label: 'empty instruction', body: proposalBody(context, '') },
      {
        label: 'non-hex baseVector',
        body: proposalBody({ ...context, baseVector: 'not-a-vector' }),
      },
      {
        label: 'invalid selection',
        body: proposalBody({ ...context, selection: { from: 5, to: 2 } }),
      },
      { label: 'non-object body', body: [1, 2, 3] },
    ];
    for (const { label, body } of cases) {
      const response = await post(h.app, '/api/v1/projects/proj-a/agent/proposals', body);
      expect(response.status, label).toBe(400);
    }
    const malformed = await h.app.request('/api/v1/projects/proj-a/agent/proposals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(malformed.status).toBe(400);
    expect(h.provider.calls).toBe(0);
    expect(h.issueCapability).not.toHaveBeenCalled();
  });

  it('rejects a stale workspace digest before generating', async () => {
    const h = await createFixture();
    activeHarness = h;
    const stale = await makeContext(h.documents);
    // A concurrent (e.g. human) edit moves the working layer.
    const live = await h.documents.load({ projectId: PROJECT_ID, documentId: DOCUMENT_ID });
    if (live === null) throw new Error('expected seeded working state');
    const edited = new Y.Doc();
    Y.applyUpdate(edited, live.update);
    edited.getText('prose').insert(edited.getText('prose').length, '!');
    const applied = await h.documents.applyScopedUpdate({
      projectId: PROJECT_ID,
      documentId: DOCUMENT_ID,
      expectedBaseVector: live.stateVector,
      expectedHumanPresenceGeneration: h.session.presenceGeneration,
      update: Y.encodeStateAsUpdate(edited),
    });
    expect(applied.ok).toBe(true);

    const response = await post(
      h.app,
      '/api/v1/projects/proj-a/agent/proposals',
      proposalBody(stale),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: 'stale', reason: 'stale-vector', replanRequired: true });
    expect(typeof body.currentVector).toBe('string');
    expect(h.provider.calls).toBe(0);
  });

  it('proposes a revision-bound suggestion from the caller context without mutating anything', async () => {
    const h = await createFixture();
    activeHarness = h;
    const context = await makeContext(h.documents);
    const response = await post(
      h.app,
      '/api/v1/projects/proj-a/agent/proposals',
      proposalBody(context),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: 'proposed',
      proposal: {
        version: 1,
        suggestionId: 'sg-1',
        projectId: PROJECT_ID,
        documentId: DOCUMENT_ID,
        baseVector: context.baseVector,
        selection: { from: 0, to: 6 },
        changes: [{ from: 0, length: 8, text: 'edited' }],
      },
    });
    const proposal = body.proposal as Record<string, unknown>;
    expect(proposal.baseTextHash).toBe(createHash('sha256').update(DOC_TEXT, 'utf8').digest('hex'));
    // The provider task carried the addressed document text and the instruction.
    expect(h.provider.calls).toBe(1);
    expect(JSON.stringify(h.provider.lastRequest)).toContain('tighten the opening');
    expect(JSON.stringify(h.provider.lastRequest)).toContain(DOC_TEXT);
    // Proposal-only: no working-layer mutation, no capability, no effect audit.
    expect(await h.documents.materializeDocument(DOCUMENT_ID)).toBe(DOC_TEXT);
    expect(h.issueCapability).not.toHaveBeenCalled();
    expect(h.audit.records).toHaveLength(0);
  });

  it('pauses generation while a human is editing the document', async () => {
    const h = await createFixture({ humanEditing: true });
    activeHarness = h;
    const context = await makeContext(h.documents);
    const response = await post(
      h.app,
      '/api/v1/projects/proj-a/agent/proposals',
      proposalBody(context),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'paused',
      reason: 'human-presence',
      replanRequired: true,
    });
    expect(h.provider.calls).toBe(0);
  });

  it('fails with a typed error when the provider response is invalid', async () => {
    const h = await createFixture({ providerResult: () => diffResponse('not a diff at all') });
    activeHarness = h;
    const context = await makeContext(h.documents);
    const response = await post(
      h.app,
      '/api/v1/projects/proj-a/agent/proposals',
      proposalBody(context),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      status: 'failed',
      errorCode: 'agent.suggestion.invalid-response',
    });
    expect(h.audit.records).toHaveLength(0);
  });
});

// ─── Apply surface ───────────────────────────────────────────────────────────

describe('browser Agent apply surface', () => {
  it('allows reader proposals but denies apply before issuing a capability', async () => {
    const h = await createFixture({ projectRole: 'reader' });
    activeHarness = h;
    const context = await makeContext(h.documents);
    const proposed = await post(
      h.app,
      '/api/v1/projects/proj-a/agent/proposals',
      proposalBody(context),
    );
    expect(proposed.status).toBe(200);

    const response = await post(
      h.app,
      '/api/v1/projects/proj-a/agent/proposals/sg-1/apply',
      applyBody(context, 'sg-1'),
    );
    expect(response.status).toBe(404);
    expect(h.issueCapability).not.toHaveBeenCalled();
    expect(await h.documents.materializeDocument(DOCUMENT_ID)).toBe(DOC_TEXT);
  });
  it('rejects an apply for an unknown suggestion before any capability or effect', async () => {
    const h = await createFixture();
    activeHarness = h;
    const context = await makeContext(h.documents);
    const response = await post(
      h.app,
      '/api/v1/projects/proj-a/agent/proposals/sg-1/apply',
      applyBody(context, 'never-proposed'),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      status: 'stale',
      reason: 'context-changed',
      replanRequired: true,
      currentVector: null,
    });
    expect(h.issueCapability).not.toHaveBeenCalled();
    expect(h.audit.records).toHaveLength(0);
  });

  it('rejects a stale apply before any effect', async () => {
    const h = await createFixture();
    activeHarness = h;
    const context = await makeContext(h.documents);
    const proposed = await post(
      h.app,
      '/api/v1/projects/proj-a/agent/proposals',
      proposalBody(context),
    );
    expect(proposed.status).toBe(200);

    // A concurrent human edit moves the workspace digest after the proposal.
    const live = await h.documents.load({ projectId: PROJECT_ID, documentId: DOCUMENT_ID });
    if (live === null) throw new Error('expected seeded working state');
    const edited = new Y.Doc();
    Y.applyUpdate(edited, live.update);
    edited.getText('prose').insert(edited.getText('prose').length, '!');
    const applied = await h.documents.applyScopedUpdate({
      projectId: PROJECT_ID,
      documentId: DOCUMENT_ID,
      expectedBaseVector: live.stateVector,
      expectedHumanPresenceGeneration: h.session.presenceGeneration,
      update: Y.encodeStateAsUpdate(edited),
    });
    expect(applied.ok).toBe(true);

    const response = await post(
      h.app,
      '/api/v1/projects/proj-a/agent/proposals/sg-1/apply',
      applyBody(context, 'sg-1'),
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: 'stale', reason: 'stale-vector', replanRequired: true });
    const digest = await h.documents.workspaceDigest();
    expect(body.currentVector).toBe(digest?.digest ?? null);
    expect(h.audit.records).toHaveLength(0);
  });

  it('applies a stored proposal through the server capability and consumes it', async () => {
    const h = await createFixture({ projectRole: 'author' });
    activeHarness = h;
    const context = await makeContext(h.documents);
    const proposed = await post(
      h.app,
      '/api/v1/projects/proj-a/agent/proposals',
      proposalBody(context),
    );
    expect(proposed.status).toBe(200);

    const response = await post(
      h.app,
      '/api/v1/projects/proj-a/agent/proposals/sg-1/apply',
      applyBody(context, 'sg-1'),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'applied', suggestionId: 'sg-1' });
    // The capability is derived server-side from the authenticated principal;
    // the browser payload never carries a capability or actor.
    expect(h.issueCapability).toHaveBeenCalledWith({ principal: h.principal });
    expect(h.audit.records).toContainEqual(
      expect.objectContaining({
        outcome: 'completed',
        kind: 'operation.edit.apply.completed',
        capabilityId: h.grant.capabilityId,
        actorId: 'owner-1',
        scopes: ['edit:prose'],
      }),
    );
    // Observable session-queued working-layer mutation.
    expect(await h.documents.materializeDocument(DOCUMENT_ID)).toBe('edited prose');

    // The proposal is consumed: a second apply cannot reuse it.
    const replay = await post(
      h.app,
      '/api/v1/projects/proj-a/agent/proposals/sg-1/apply',
      applyBody(context, 'sg-1'),
    );
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ status: 'stale', reason: 'context-changed' });
  });

  it('maps a revoked capability to SUBMIT_BLOCKED without applying', async () => {
    const h = await createFixture();
    activeHarness = h;
    const context = await makeContext(h.documents);
    const proposed = await post(
      h.app,
      '/api/v1/projects/proj-a/agent/proposals',
      proposalBody(context),
    );
    expect(proposed.status).toBe(200);

    await h.capabilityService.revoke(h.grant.capabilityId);
    const response = await post(
      h.app,
      '/api/v1/projects/proj-a/agent/proposals/sg-1/apply',
      applyBody(context, 'sg-1'),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ status: 'failed', errorCode: 'SUBMIT_BLOCKED' });
    expect(await h.documents.materializeDocument(DOCUMENT_ID)).toBe(DOC_TEXT);
  });

  it('pauses an apply while a human is editing', async () => {
    const h = await createFixture();
    activeHarness = h;
    const context = await makeContext(h.documents);
    const proposed = await post(
      h.app,
      '/api/v1/projects/proj-a/agent/proposals',
      proposalBody(context),
    );
    expect(proposed.status).toBe(200);

    h.humanEditing.value = true;
    const response = await post(
      h.app,
      '/api/v1/projects/proj-a/agent/proposals/sg-1/apply',
      applyBody(context, 'sg-1'),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      status: 'paused',
      reason: 'human-presence',
      replanRequired: true,
    });
    expect(await h.documents.materializeDocument(DOCUMENT_ID)).toBe(DOC_TEXT);
  });
});
