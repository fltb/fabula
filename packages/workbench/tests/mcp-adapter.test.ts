import { createHash } from 'node:crypto';
import type { CoreRuntimeServices, ProjectCompilation } from '@novalistically/core';
import { buildSourceSnapshot, computeSourceDocumentHash } from '@novalistically/core/source';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import * as Y from 'yjs';
import { AUTHORING_CONTRACT_VERSION, type AuthoringOperationReceiptV1, type AuthoringStateV1 } from '../src/contracts/authoring.js';
import type { WorkingDocumentState } from '../src/contracts/index.js';
import {
  type AgentCapabilityGrant,
  AgentCapabilityService,
  type AgentCapabilityServiceOptions,
  createCapabilityPersistence,
  type IssueCapabilityInput,
} from '../src/host/agent/index.js';
import {
  type AuthoringWorkingDocumentStore,
  createAuthoringDocumentStore,
} from '../src/host/authoring/document-store.js';
import { createMcpAuthoringCoordinatorPort } from '../src/host/authoring/mcp-adapter.js';
import type {
  AuthoringCoordinator,
  AuthoringReconcileInput,
  AuthoringSubmitInput,
} from '../src/host/authoring/types.js';
import { createProjectCoreRuntime } from '../src/host/core-runtime.js';
import type { McpAuthorizedCaller } from '../src/host/mcp/auth.js';
import type { McpAuthoringCoordinatorPort } from '../src/host/mcp/registry.js';
import {
  createProjectSession,
  type ProjectionDerivationInput,
  type ProjectSession,
  type ProjectSessionProjectionV1,
  type SessionAuditRecord,
  type SessionAuditSink,
} from '../src/host/project-session.js';
import {
  createYjsWorkingDocumentCore,
  type YjsPersistencePort,
  type YjsWorkingDocumentCore,
} from '../src/host/yjs/index.js';
import { createRealPersistence } from './helpers/real-persistence.js';

// ─── Test doubles ────────────────────────────────────────────────────────────

const FIXED_NOW = '2026-08-02T00:00:00.000Z';
const PROJECT_ID = 'proj-a';
const DOCUMENT_ID = 'nova.yaml';
const ACCEPTED_CONTENT = 'project: demo\n';
const REPLACEMENT_CONTENT = 'project: demo\nversion: 1\n';

function sha256Hex(buffer: Uint8Array): string {
  return createHash('sha256').update(buffer).digest('hex');
}

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

/**
 * Real capability service that records every `issue` and can revoke each
 * freshly issued grant before the caller proceeds — the only deterministic
 * way to drive the session gate's denied path for an adapter-issued grant.
 */
class RecordingCapabilityService extends AgentCapabilityService {
  readonly issueCalls: IssueCapabilityInput[] = [];
  readonly issued: { token: string; grant: AgentCapabilityGrant }[] = [];

  constructor(
    options: AgentCapabilityServiceOptions,
    private readonly revokeAfterIssue = false,
  ) {
    super(options);
  }

  override async issue(input: IssueCapabilityInput) {
    this.issueCalls.push(input);
    const result = await super.issue(input);
    this.issued.push(result);
    if (this.revokeAfterIssue) await this.revoke(result.grant.capabilityId);
    return result;
  }
}

function authoringState(acceptedSourceHash: string): AuthoringStateV1 {
  return {
    version: AUTHORING_CONTRACT_VERSION,
    projectId: PROJECT_ID,
    phase: 'working-dirty',
    acceptedRevisionId: null,
    acceptedSourceHash,
    pendingOperationId: null,
    workingDirty: true,
    workspaceDigest: 'workspace-digest',
    externalCandidate: null,
    conflicts: [],
    diagnostics: [],
    canSubmit: true,
    submitBlockReason: 'none',
    generatedAt: FIXED_NOW,
  };
}

function receipt(
  overrides: Partial<AuthoringOperationReceiptV1> = {},
): AuthoringOperationReceiptV1 {
  return {
    version: AUTHORING_CONTRACT_VERSION,
    operationId: 'op-1',
    projectId: PROJECT_ID,
    kind: 'submit',
    status: 'completed',
    acceptedSourceHash: 'accepted-after',
    acceptedRevisionId: 'revision-before',
    pendingOperationId: null,
    revisionId: 'revision-1',
    receiptHash: 'receipt-1',
    errorCode: null,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  };
}


// ─── Harness ─────────────────────────────────────────────────────────────────

interface McpHarness {
  port: McpAuthoringCoordinatorPort;
  session: ProjectSession;
  documents: AuthoringWorkingDocumentStore;
  core: YjsWorkingDocumentCore;
  capabilities: RecordingCapabilityService;
  audit: { sink: SessionAuditSink; records: SessionAuditRecord[] };
  submit: Mock<(input: AuthoringSubmitInput) => Promise<AuthoringOperationReceiptV1>>;
  reconcileExternal: Mock<(input: AuthoringReconcileInput) => Promise<AuthoringOperationReceiptV1>>;
  refreshWorkingState: Mock<() => Promise<void>>;
  state: AuthoringStateV1;
  acceptedSourceHash: string;
  caller: McpAuthorizedCaller;
  dispose: () => Promise<void>;
}

async function createHarness(
  options: {
    submitResult?: AuthoringOperationReceiptV1;
    reconcileResult?: AuthoringOperationReceiptV1;
    revokeAfterIssue?: boolean;
  } = {},
): Promise<McpHarness> {
  const persistence = createRealPersistence();
  const capabilities = new RecordingCapabilityService(
    {
      persistence: createCapabilityPersistence(persistence.client),
      now: () => Date.parse(FIXED_NOW),
    },
    options.revokeAfterIssue,
  );
  const audit = recordingAudit();
  const runtime = createProjectCoreRuntime({
    projectId: PROJECT_ID,
    services: fakeServices({ now: () => FIXED_NOW }),
    compile: (snapshot) => ({ events: snapshot.documents.length }) as unknown as ProjectCompilation,
  });
  const session = createProjectSession({
    projectId: PROJECT_ID,
    runtime,
    capabilities: { checkGrant: (input) => capabilities.checkGrant(input) },
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
      content: ACCEPTED_CONTENT,
      contentHash: computeSourceDocumentHash(ACCEPTED_CONTENT),
      parseResult: { status: 'parsed' as const, value: null },
      diagnostics: [],
    },
  ]);
  await documents.seedFromAccepted(snapshot);

  const state = authoringState(snapshot.sourceHash);
  const submit = vi.fn<(input: AuthoringSubmitInput) => Promise<AuthoringOperationReceiptV1>>(
    async () => options.submitResult ?? receipt({ status: 'queued' }),
  );
  const reconcileExternal = vi.fn<
    (input: AuthoringReconcileInput) => Promise<AuthoringOperationReceiptV1>
  >(
    async () =>
      options.reconcileResult ?? receipt({ kind: 'reconcile-external', status: 'queued' }),
  );
  const refreshWorkingState = vi.fn<() => Promise<void>>(async () => undefined);
  const coordinator: AuthoringCoordinator = {
    projectId: PROJECT_ID,
    getState: () => state,
    listOperations: () => [],
    getOperation: () => null,
    isAgentPaused: () => false,
    refreshWorkingState,
    notifyExternalChange: async () => undefined,
    submit,
    reconcileExternal,
    refreshAccepted: async () => undefined,
    dispose: async () => undefined,
  };

  const issued = await capabilities.issue({
    userId: 'device-owner',
    projectId: PROJECT_ID,
    scopes: ['mcp:author'],
  });
  const caller: McpAuthorizedCaller = {
    sessionId: null,
    userId: issued.grant.userId,
    grant: issued.grant,
  };

  const port = createMcpAuthoringCoordinatorPort({ session, coordinator, documents, capabilities });
  const dispose = async () => {
    documents.dispose();
    await core.close();
    await persistence.dispose();
  };
  return {
    port,
    session,
    documents,
    core,
    capabilities,
    audit,
    submit,
    reconcileExternal,
    refreshWorkingState,
    state,
    acceptedSourceHash: snapshot.sourceHash,
    caller,
    dispose,
  };
}

let activeHarness: { dispose: () => Promise<void> } | undefined;

afterEach(async () => {
  const harness = activeHarness;
  activeHarness = undefined;
  await harness?.dispose();
});

// ─── Coordinator port contract ───────────────────────────────────────────────

describe('MCP authoring coordinator port', () => {
  it('issues a caller-derived mcp:author capability and mutates the working document through the session queue', async () => {
    const h = await createHarness();
    activeHarness = h;
    const digest = await h.documents.workspaceDigest();
    if (digest === null) throw new Error('expected a seeded workspace digest');

    const result = await h.port.apply(
      {
        version: 1,
        projectId: PROJECT_ID,
        documentId: DOCUMENT_ID,
        expectedWorkspaceDigest: digest.digest,
        expectedAcceptedSourceHash: h.acceptedSourceHash,
        replacementText: REPLACEMENT_CONTENT,
      },
      h.caller,
    );
    if (result.status !== 'applied') throw new Error(`expected applied, got ${result.status}`);

    // Caller-derived capability: the adapter issues exactly mcp:author for the
    // caller's userId against the bound session project — never client input.
    expect(h.capabilities.issueCalls.at(-1)).toEqual({
      userId: 'device-owner',
      projectId: PROJECT_ID,
      scopes: ['mcp:author'],
    });
    const adapterGrant = h.capabilities.issued.at(-1)!.grant;
    // Session-queued effect: the durable audit proves the mutation ran inside
    // the capability-gated serialized operation queue.
    expect(h.audit.records).toContainEqual(
      expect.objectContaining({
        outcome: 'completed',
        kind: 'operation.mcp.authoring.apply.completed',
        capabilityId: adapterGrant.capabilityId,
        actorId: 'device-owner',
        projectId: PROJECT_ID,
        scopes: ['mcp:author'],
      }),
    );
    // Observable working-layer mutation.
    expect(await h.documents.materializeDocument(DOCUMENT_ID)).toBe(REPLACEMENT_CONTENT);
    expect(await h.documents.isWorkingDirty()).toBe(true);
    expect(h.refreshWorkingState).toHaveBeenCalledTimes(1);
    const live = await h.documents.load({ projectId: PROJECT_ID, documentId: DOCUMENT_ID });
    if (live === null) throw new Error('expected live working state');
    const updatedDigest = await h.documents.workspaceDigest();
    expect(result.workspaceDigest).toBe(updatedDigest?.digest);
    expect(result.stateVectorHash).toBe(sha256Hex(live.stateVector));
  });

  it('rejects a stale accepted-source hash inside the queued slot without mutating the document', async () => {
    const h = await createHarness();
    activeHarness = h;
    const digest = await h.documents.workspaceDigest();
    if (digest === null) throw new Error('expected a seeded workspace digest');

    const result = await h.port.apply(
      {
        version: 1,
        projectId: PROJECT_ID,
        documentId: DOCUMENT_ID,
        expectedWorkspaceDigest: digest.digest,
        expectedAcceptedSourceHash: 'not-the-accepted-hash',
        replacementText: REPLACEMENT_CONTENT,
      },
      h.caller,
    );
    expect(result).toMatchObject({
      status: 'stale',
      failure: { code: 'ACCEPTED_HASH_MISMATCH' },
    });
    expect(await h.documents.materializeDocument(DOCUMENT_ID)).toBe(ACCEPTED_CONTENT);
    expect(h.refreshWorkingState).not.toHaveBeenCalled();
    // The typed rejection still ran inside the serialized session queue.
    expect(h.audit.records).toHaveLength(1);
    expect(h.audit.records[0]).toMatchObject({
      outcome: 'completed',
      kind: 'operation.mcp.authoring.apply.completed',
    });
  });

  it('rejects a stale workspace digest as WORKSPACE_STALE, preserving the concurrent edit', async () => {
    const h = await createHarness();
    activeHarness = h;
    const live = await h.documents.load({ projectId: PROJECT_ID, documentId: DOCUMENT_ID });
    if (live === null) throw new Error('expected seeded working state');
    // A concurrent (e.g. human) edit moves the working layer.
    const edited = new Y.Doc();
    Y.applyUpdate(edited, live.update);
    edited.getText('prose').insert(edited.getText('prose').length, '# concurrent edit\n');
    const applied = await h.documents.applyScopedUpdate({
      projectId: PROJECT_ID,
      documentId: DOCUMENT_ID,
      expectedBaseVector: live.stateVector,
      expectedHumanPresenceGeneration: h.session.presenceGeneration,
      update: Y.encodeStateAsUpdate(edited),
    });
    expect(applied.ok).toBe(true);

    const result = await h.port.apply(
      {
        version: 1,
        projectId: PROJECT_ID,
        documentId: DOCUMENT_ID,
        expectedWorkspaceDigest: 'f'.repeat(64),
        expectedAcceptedSourceHash: h.acceptedSourceHash,
        replacementText: REPLACEMENT_CONTENT,
      },
      h.caller,
    );
    expect(result).toMatchObject({ status: 'stale', failure: { code: 'WORKSPACE_STALE' } });
    // CAS is never last-writer-wins: the concurrent edit survives untouched.
    expect(await h.documents.materializeDocument(DOCUMENT_ID)).toContain('# concurrent edit');
    expect(h.refreshWorkingState).not.toHaveBeenCalled();
  });

  it('rejects an unknown document id before issuing or enqueueing', async () => {
    const h = await createHarness();
    activeHarness = h;
    const result = await h.port.apply(
      {
        version: 1,
        projectId: PROJECT_ID,
        documentId: 'missing.yaml',
        expectedWorkspaceDigest: 'f'.repeat(64),
        expectedAcceptedSourceHash: h.acceptedSourceHash,
        replacementText: 'x',
      },
      h.caller,
    );
    expect(result).toMatchObject({ status: 'rejected', failure: { code: 'DOCUMENT_NOT_FOUND' } });
    // Only the harness's caller pre-issue happened — the adapter never issued.
    expect(h.capabilities.issueCalls).toHaveLength(1);
    expect(h.audit.records).toHaveLength(0);
  });

  it('maps a denied session gate to SUBMIT_BLOCKED for the apply effect', async () => {
    const h = await createHarness({ revokeAfterIssue: true });
    activeHarness = h;
    const digest = await h.documents.workspaceDigest();
    if (digest === null) throw new Error('expected a seeded workspace digest');

    const result = await h.port.apply(
      {
        version: 1,
        projectId: PROJECT_ID,
        documentId: DOCUMENT_ID,
        expectedWorkspaceDigest: digest.digest,
        expectedAcceptedSourceHash: h.acceptedSourceHash,
        replacementText: REPLACEMENT_CONTENT,
      },
      h.caller,
    );
    expect(result).toMatchObject({ status: 'rejected', failure: { code: 'SUBMIT_BLOCKED' } });
    expect(h.audit.records).toContainEqual(
      expect.objectContaining({ outcome: 'denied', reason: 'REVOKED' }),
    );
    expect(await h.documents.materializeDocument(DOCUMENT_ID)).toBe(ACCEPTED_CONTENT);
  });

  it('returns hashes-only identity for a known working document', async () => {
    const h = await createHarness();
    activeHarness = h;
    const live = await h.documents.load({ projectId: PROJECT_ID, documentId: DOCUMENT_ID });
    if (live === null) throw new Error('expected seeded working state');
    const result = await h.port.getDocument({
      version: 2,
      projectId: PROJECT_ID,
      documentId: DOCUMENT_ID,
    });
    expect(result).toEqual({
      version: 2,
      projectId: PROJECT_ID,
      documentId: DOCUMENT_ID,
      logicalPath: DOCUMENT_ID,
      available: true,
      stateVectorHash: sha256Hex(live.stateVector),
      acceptedSourceHash: h.acceptedSourceHash,
    });
  });

  it('returns DOCUMENT_NOT_FOUND for an unknown document', async () => {
    const h = await createHarness();
    activeHarness = h;
    const result = await h.port.getDocument({
      version: 1,
      projectId: PROJECT_ID,
      documentId: 'missing.yaml',
    });
    expect(result).toEqual({
      code: 'DOCUMENT_NOT_FOUND',
      message: 'The working document is unavailable.',
    });
  });

  it('derives the actor and mcp:submit capability for submit and forwards the CAS fields', async () => {
    const completed = receipt({
      status: 'completed',
      operationId: 'op-1',
      revisionId: 'revision-1',
      acceptedSourceHash: 'accepted-after',
      receiptHash: 'receipt-1',
    });
    const h = await createHarness({ submitResult: completed });
    activeHarness = h;

    const result = await h.port.submit(
      {
        version: 1,
        projectId: PROJECT_ID,
        expectedWorkspaceDigest: 'wd-1',
        message: 'ship it',
      },
      h.caller,
    );
    const adapterGrant = h.capabilities.issued.at(-1)!.grant;
    expect(h.capabilities.issueCalls.at(-1)).toEqual({
      userId: 'device-owner',
      projectId: PROJECT_ID,
      scopes: ['mcp:submit'],
    });
    expect(h.submit).toHaveBeenCalledWith({
      expectedAcceptedSourceHash: h.acceptedSourceHash,
      expectedWorkspaceDigest: 'wd-1',
      message: 'ship it',
      actorId: 'device-owner',
      capabilityId: adapterGrant.capabilityId,
      capabilityScopes: ['mcp:submit'],
    });
    if (result.status !== 'completed') throw new Error(`expected completed, got ${result.status}`);
    expect(result).toEqual({
      status: 'completed',
      receipt: completed,
      submit: {
        version: 2,
        projectId: PROJECT_ID,
        operationId: 'op-1',
        revisionId: 'revision-1',
        acceptedSourceHash: 'accepted-after',
        receiptHash: 'receipt-1',
        acceptedAt: FIXED_NOW,
      },
    });
  });

  it('omits the message field when the client sends none', async () => {
    const h = await createHarness();
    activeHarness = h;
    await h.port.submit(
      { version: 1, projectId: PROJECT_ID, expectedWorkspaceDigest: 'wd-1' },
      h.caller,
    );
    expect(h.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedWorkspaceDigest: 'wd-1',
        actorId: 'device-owner',
        capabilityScopes: ['mcp:submit'],
      }),
    );
    expect(h.submit.mock.calls[0][0]).not.toHaveProperty('message');
  });

  it('maps a stale submit to a typed WORKSPACE_STALE rejection', async () => {
    const h = await createHarness({
      submitResult: receipt({
        status: 'stale',
        errorCode: 'WORKSPACE_STALE',
        gitSubmitId: null,
        gitCommit: null,
        gitReceiptHash: null,
      }),
    });
    activeHarness = h;
    const result = await h.port.submit(
      { version: 1, projectId: PROJECT_ID, expectedWorkspaceDigest: 'wd-1' },
      h.caller,
    );
    expect(result).toMatchObject({ status: 'rejected', failure: { code: 'WORKSPACE_STALE' } });
  });

  it('maps a queued submit to a queued output', async () => {
    const queued = receipt({
      status: 'queued',
      gitSubmitId: null,
      gitCommit: null,
      gitReceiptHash: null,
    });
    const h = await createHarness({ submitResult: queued });
    activeHarness = h;
    const result = await h.port.submit(
      { version: 1, projectId: PROJECT_ID, expectedWorkspaceDigest: 'wd-1' },
      h.caller,
    );
    expect(result).toEqual({ status: 'queued', receipt: queued });
  });

  it('maps an internal submit failure to SUBMIT_BLOCKED', async () => {
    const h = await createHarness({
      submitResult: receipt({
        status: 'failed',
        errorCode: 'INTERNAL',
        gitSubmitId: null,
        gitCommit: null,
        gitReceiptHash: null,
      }),
    });
    activeHarness = h;
    const result = await h.port.submit(
      { version: 1, projectId: PROJECT_ID, expectedWorkspaceDigest: 'wd-1' },
      h.caller,
    );
    expect(result).toMatchObject({ status: 'rejected', failure: { code: 'SUBMIT_BLOCKED' } });
  });

  it('resolves a conflict through reconcileExternal with the caller-derived mcp:submit grant', async () => {
    const resolved = receipt({
      kind: 'reconcile-external',
      status: 'completed',
      gitSubmitId: null,
      gitCommit: null,
      gitReceiptHash: null,
    });
    const h = await createHarness({ reconcileResult: resolved });
    activeHarness = h;

    const result = await h.port.resolveConflict(
      {
        version: 1,
        projectId: PROJECT_ID,
        choice: 'accept-external',
        candidateHash: 'candidate-1',
      },
      h.caller,
    );
    const adapterGrant = h.capabilities.issued.at(-1)!.grant;
    expect(h.capabilities.issueCalls.at(-1)).toEqual({
      userId: 'device-owner',
      projectId: PROJECT_ID,
      scopes: ['mcp:submit'],
    });
    expect(h.reconcileExternal).toHaveBeenCalledWith({
      choice: 'accept-external',
      candidateHash: 'candidate-1',
      expectedAcceptedSourceHash: h.acceptedSourceHash,
      actorId: 'device-owner',
      capabilityId: adapterGrant.capabilityId,
      capabilityScopes: ['mcp:submit'],
    });
    expect(result).toEqual({ status: 'completed', receipt: resolved });
  });

  it('rejects an unresolved conflict', async () => {
    const h = await createHarness({
      reconcileResult: receipt({
        kind: 'resolve-conflict',
        status: 'conflict',
        errorCode: 'CONFLICT_REQUIRES_RESOLUTION',
        gitSubmitId: null,
        gitCommit: null,
        gitReceiptHash: null,
      }),
    });
    activeHarness = h;
    const result = await h.port.resolveConflict(
      {
        version: 1,
        projectId: PROJECT_ID,
        choice: 'keep-working',
        candidateHash: null,
      },
      h.caller,
    );
    expect(result).toMatchObject({
      status: 'rejected',
      failure: { code: 'CONFLICT_REQUIRES_RESOLUTION' },
    });
  });
});
