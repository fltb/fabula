import { afterEach, describe, expect, it } from 'vitest';
import type { AuditSurface } from '../src/contracts/index.js';
import {
  type AgentAuditAppendInput,
  AgentAuditInputError,
  AgentDurableAudit,
  createAgentDurableAudit,
  createDurableAuditSink,
} from '../src/host/agent/index.js';
import type { SessionAuditRecord } from '../src/host/project-session.js';
import { createRealPersistence, type RealPersistenceHarness } from './helpers/real-persistence.js';

let activeHarness: RealPersistenceHarness | undefined;

afterEach(async () => {
  const harness = activeHarness;
  activeHarness = undefined;
  await harness?.dispose();
});

const H64 = 'a'.repeat(64);
const H128 = 'b'.repeat(128);

function makeAppendInput(overrides: Partial<AgentAuditAppendInput> = {}): AgentAuditAppendInput {
  return {
    surface: 'agent',
    operationKind: 'operation.edit.apply.completed',
    outcome: 'completed',
    actorId: 'agent-1',
    projectId: 'project-a',
    documentScope: 'nova.yaml',
    capabilityVersion: 2,
    baseSourceHash: H64,
    resultSourceHash: H64,
    workspaceDigest: H64,
    submitId: 'sub-1',
    gitReceiptHash: H128,
    ...overrides,
  };
}

function createFixture(overrides: { auditId?: string } = {}) {
  const harness = createRealPersistence();
  let sequence = 0;
  const audit = new AgentDurableAudit({
    client: harness.client,
    now: () => '2026-08-02T00:00:00.000Z',
    newAuditId: () => overrides.auditId ?? `audit-${++sequence}`,
  });
  return { harness, audit };
}

// ─── Append and query over real persistence ─────────────────────────────────

describe('AgentDurableAudit append/list over Phase 0 persistence', () => {
  it('appends a validated record and returns the exact persisted projection', async () => {
    const { harness, audit } = createFixture();
    activeHarness = harness;
    const record = await audit.append(makeAppendInput());
    expect(record).toEqual({
      auditId: 'audit-1',
      at: '2026-08-02T00:00:00.000Z',
      actorId: 'agent-1',
      surface: 'agent',
      operationKind: 'operation.edit.apply.completed',
      outcome: 'completed',
      projectId: 'project-a',
      documentScope: 'nova.yaml',
      capabilityVersion: 2,
      baseSourceHash: H64,
      resultSourceHash: H64,
      workspaceDigest: H64,
      submitId: 'sub-1',
      gitReceiptHash: H128,
    });
    const listed = await audit.list({ limit: 10 });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual(record);
  });

  it('is append-only: repeated appends accumulate and list newest first', async () => {
    const { harness, audit } = createFixture();
    activeHarness = harness;
    const first = await audit.append(
      makeAppendInput({ operationKind: 'operation.one', at: '2026-08-02T00:00:00.000Z' }),
    );
    const second = await audit.append(
      makeAppendInput({ operationKind: 'operation.two', at: '2026-08-02T00:00:01.000Z' }),
    );
    expect(first.auditId).not.toBe(second.auditId);
    const listed = await audit.list({ limit: 10 });
    expect(listed.map((entry) => entry.operationKind)).toEqual(['operation.two', 'operation.one']);
  });

  it('lists filtered by surface and projectId', async () => {
    const { harness, audit } = createFixture();
    activeHarness = harness;
    await audit.append(makeAppendInput({ surface: 'agent', projectId: 'project-a' }));
    await audit.append(makeAppendInput({ surface: 'mcp', projectId: 'project-a' }));
    await audit.append(makeAppendInput({ surface: 'agent', projectId: 'project-b' }));
    const agents = await audit.list({ limit: 10, surface: 'agent' });
    expect(agents).toHaveLength(2);
    expect(agents.every((entry) => entry.surface === 'agent')).toBe(true);
    const projectA = await audit.list({ limit: 10, projectId: 'project-a' });
    expect(projectA).toHaveLength(2);
    const projectAagents = await audit.list({
      limit: 10,
      surface: 'agent',
      projectId: 'project-a',
    });
    expect(projectAagents).toHaveLength(1);
  });

  it('keeps optional fields absent rather than writing empty strings', async () => {
    const { harness, audit } = createFixture();
    activeHarness = harness;
    const record = await audit.append({
      surface: 'system',
      operationKind: 'operation.health',
      outcome: 'completed',
    });
    expect(record).toEqual({
      auditId: 'audit-1',
      at: '2026-08-02T00:00:00.000Z',
      surface: 'system',
      operationKind: 'operation.health',
      outcome: 'completed',
    });
    expect('actorId' in record).toBe(false);
    expect('projectId' in record).toBe(false);
    expect('documentScope' in record).toBe(false);
  });

  it('fails closed at construction without a persistence client', () => {
    expect(() => createAgentDurableAudit({ client: undefined as never })).toThrow(TypeError);
  });
});

// ─── Strict no-secret boundary ───────────────────────────────────────────────

describe('AgentDurableAudit strict no-secret boundary', () => {
  it('rejects unknown fields before any write', async () => {
    const { harness, audit } = createFixture();
    activeHarness = harness;
    await expect(
      audit.append({
        ...makeAppendInput(),
        apiKey: 'sk-secret',
      } as unknown as AgentAuditAppendInput),
    ).rejects.toThrow(AgentAuditInputError);
    await expect(audit.list({ limit: 1, token: 'x' } as never)).rejects.toThrow(
      AgentAuditInputError,
    );
    expect(await audit.list({ limit: 10 })).toHaveLength(0); // nothing was written
  });

  it('rejects invalid surfaces, outcomes, and operation kinds', async () => {
    const { harness, audit } = createFixture();
    activeHarness = harness;
    await expect(
      audit.append(makeAppendInput({ surface: 'admin' as AuditSurface })),
    ).rejects.toThrow(AgentAuditInputError);
    await expect(audit.append(makeAppendInput({ outcome: 'pending' as never }))).rejects.toThrow(
      AgentAuditInputError,
    );
    await expect(audit.append(makeAppendInput({ operationKind: '' }))).rejects.toThrow(
      AgentAuditInputError,
    );
    await expect(audit.append(makeAppendInput({ operationKind: 'x\ny' }))).rejects.toThrow(
      AgentAuditInputError,
    );
    await expect(await audit.list({ limit: 10 })).toHaveLength(0);
  });

  it('rejects secret-like or malformed hash fields', async () => {
    const { harness, audit } = createFixture();
    activeHarness = harness;
    await expect(
      audit.append(makeAppendInput({ baseSourceHash: 'sk-secret-not-a-hash' })),
    ).rejects.toThrow(AgentAuditInputError);
    await expect(audit.append(makeAppendInput({ baseSourceHash: 'A'.repeat(64) }))).rejects.toThrow(
      AgentAuditInputError,
    );
    await expect(
      audit.append(makeAppendInput({ workspaceDigest: 'zz'.repeat(32) })),
    ).rejects.toThrow(AgentAuditInputError);
    await expect(audit.append(makeAppendInput({ gitReceiptHash: 'not-hex' }))).rejects.toThrow(
      AgentAuditInputError,
    );
    expect(await audit.list({ limit: 10 })).toHaveLength(0);
  });

  it('rejects absolute paths and traversal in documentScope', async () => {
    const { harness, audit } = createFixture();
    activeHarness = harness;
    await expect(
      audit.append(makeAppendInput({ documentScope: '/home/float/secret.yaml' })),
    ).rejects.toThrow(AgentAuditInputError);
    await expect(
      audit.append(makeAppendInput({ documentScope: 'chapters/../nova.yaml' })),
    ).rejects.toThrow(AgentAuditInputError);
    await expect(
      audit.append(makeAppendInput({ documentScope: 'C:\\secret.yaml' })),
    ).rejects.toThrow(AgentAuditInputError);
    expect(await audit.list({ limit: 10 })).toHaveLength(0);
  });

  it('rejects oversized detail and control characters', async () => {
    const { harness, audit } = createFixture();
    activeHarness = harness;
    await expect(audit.append(makeAppendInput({ detail: 'd'.repeat(2_000) }))).rejects.toThrow(
      AgentAuditInputError,
    );
    await expect(
      audit.append(makeAppendInput({ detail: 'raw token: fc_abc\u0000' })),
    ).rejects.toThrow(AgentAuditInputError);
    expect(await audit.list({ limit: 10 })).toHaveLength(0);
  });

  it('rejects invalid list queries (limit bounds, bad surface)', async () => {
    const { harness, audit } = createFixture();
    activeHarness = harness;
    await expect(audit.list({ limit: 0 })).rejects.toThrow(AgentAuditInputError);
    await expect(audit.list({ limit: 501 })).rejects.toThrow(AgentAuditInputError);
    await expect(audit.list({ limit: 1.5 })).rejects.toThrow(AgentAuditInputError);
    await expect(audit.list({ limit: 1, surface: 'owner' as AuditSurface })).rejects.toThrow(
      AgentAuditInputError,
    );
  });
});

// ─── Durable session-sink bridge ─────────────────────────────────────────────

describe('AgentDurableAudit session sink bridge', () => {
  it('maps a granted session record onto a durable agent-surface entry', async () => {
    const { harness, audit } = createFixture({ auditId: 'fx-audit' });
    activeHarness = harness;
    const sink = createDurableAuditSink(audit);
    const record: SessionAuditRecord = {
      capabilityId: 'cap-1',
      actorId: 'agent-1',
      projectId: 'project-a',
      scopes: ['edit:prose'],
      version: 3,
      kind: 'operation.edit.apply.completed',
      detail: 'E_PROVIDER_DOWN',
      at: '2026-08-02T00:00:00.000Z',
      operationId: 'op-1',
      outcome: 'completed',
    };
    await sink.record(record);
    const listed = await audit.list({ limit: 10, surface: 'agent' });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      auditId: 'fx-audit',
      surface: 'agent',
      operationKind: 'operation.edit.apply.completed',
      outcome: 'completed',
      actorId: 'agent-1',
      projectId: 'project-a',
      capabilityVersion: 3,
      detail: 'E_PROVIDER_DOWN',
      at: '2026-08-02T00:00:00.000Z',
    });
  });

  it('maps a typed denial with no actor or token, only the opaque capability id', async () => {
    const { harness, audit } = createFixture({ auditId: 'denied-audit' });
    activeHarness = harness;
    const sink = audit.createSink();
    const record: SessionAuditRecord = {
      outcome: 'denied',
      operationId: 'op-2',
      projectId: 'project-a',
      capabilityId: 'cap-revoked',
      reason: 'REVOKED',
      at: '2026-08-02T00:00:01.000Z',
    };
    await sink.record(record);
    const listed = await audit.list({ limit: 10 });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual({
      auditId: 'denied-audit',
      at: '2026-08-02T00:00:01.000Z',
      surface: 'agent',
      operationKind: 'operation.denied',
      outcome: 'denied',
      projectId: 'project-a',
      detail: 'capability:cap-revoked; reason:REVOKED',
    });
    expect('token' in listed[0]).toBe(false);
    expect('capabilityId' in listed[0]).toBe(false); // opaque id only in detail, never a column
  });

  it('never stores raw source, vectors, updates, tokens, or keys through the sink', async () => {
    const { harness, audit } = createFixture();
    activeHarness = harness;
    const sink = audit.createSink();
    await sink.record({
      capabilityId: 'cap-1',
      actorId: 'agent-1',
      projectId: 'project-a',
      scopes: ['edit:prose'],
      version: 1,
      kind: 'operation.edit.apply.completed',
      at: '2026-08-02T00:00:00.000Z',
      operationId: 'op-1',
      outcome: 'completed',
    });
    const [entry] = await audit.list({ limit: 10 });
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain('fc_'); // no capability token
    expect(serialized).not.toContain('sk-'); // no provider key
    expect(serialized).not.toContain('/home/'); // no host path
    expect(serialized).not.toContain('original prose'); // no raw source text
    expect(serialized).not.toContain('stateVector'); // no raw vector
    expect(serialized).not.toContain('update'); // no raw Yjs update
  });
});
