import type {
  CoreExecutionRepository,
  CoreRuntimeServices,
  LLMProvider,
  ProjectCompilation,
  RenderCacheRepository,
  StateLogRepository,
  StateSnapshotRepository,
} from '@novalistically/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkingDocumentState, YjsDocumentKey } from '../src/contracts/index.js';
import type { CapabilityState } from '../src/contracts/persistence.js';
import {
  type AgentCapabilityFailureCode,
  AgentCapabilityService,
  type AgentDocumentPort,
  type AgentEditEffectInput,
  type AgentEditEffectResult,
  type AgentPresencePort,
  type AgentRevertEffectInput,
  type AgentRevertEffectResult,
  createAgentCommandService,
  createCapabilityPersistence,
} from '../src/host/agent/index.js';
import { createProjectCoreRuntime } from '../src/host/core-runtime.js';
import {
  createProjectSession,
  type ProjectionDerivationInput,
  type ProjectSession,
  type ProjectSessionProjectionV1,
  type SessionAuditRecord,
  type SessionAuditSink,
} from '../src/host/project-session.js';
import { createRealPersistence, type RealPersistenceHarness } from './helpers/real-persistence.js';

// ─── Test doubles ────────────────────────────────────────────────────────────

function fakeServices(options: { now?: () => string } = {}): CoreRuntimeServices {
  let sequence = 0;
  return {
    execution: {} as CoreExecutionRepository,
    renderCache: {} as RenderCacheRepository,
    stateLog: {} as StateLogRepository,
    stateSnapshots: {} as StateSnapshotRepository,
    promptTemplates: {
      async get() {
        return null;
      },
    },
    clock: { now: () => options.now?.() ?? '2026-08-02T00:00:00.000Z' },
    ids: { next: (input) => `${input?.kind ?? 'id'}-${++sequence}` },
    llm: {} as LLMProvider,
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

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
let activeHarness: RealPersistenceHarness | undefined;

afterEach(async () => {
  const harness = activeHarness;
  activeHarness = undefined;
  await harness?.dispose();
});

/**
 * Deterministic in-memory document port simulating the Yjs adapter contract:
 * the state vector is the utf8 encoding of the current content, an update is
 * a utf8 JSON `{content}` payload replacing the targeted content, and the
 * compensating update is the pre-effect content. Both mutations are guarded
 * by a state-vector compare-and-swap, exactly like the real adapter.
 */
class FakeDocumentPort implements AgentDocumentPort {
  readonly contents = new Map<string, string>();
  /** Every project id the port was asked to mutate, in call order. */
  readonly seenProjects: string[] = [];
  /** Live human-presence generation; wired to the session in fixtures. */
  readonly #presenceGeneration: () => number;

  constructor(initial: Record<string, string> = {}, presenceGeneration: () => number = () => 0) {
    for (const [key, content] of Object.entries(initial)) this.contents.set(key, content);
    this.#presenceGeneration = presenceGeneration;
  }
  static vectorOf(content: string): Uint8Array {
    return textEncoder.encode(content);
  }

  contentOf(documentId: string): string {
    return this.contents.get(documentId) ?? '';
  }

  /** Simulates an external (e.g. human) writer moving the document vector. */
  write(documentId: string, content: string): void {
    this.contents.set(documentId, content);
  }

  async load(key: YjsDocumentKey): Promise<WorkingDocumentState | null> {
    const content = this.contents.get(key.documentId);
    if (content === undefined) return null;
    return {
      key,
      stateVector: FakeDocumentPort.vectorOf(content),
      update: textEncoder.encode(content),
      updatedAt: '2026-08-02T00:00:00.000Z',
    };
  }

  async applyScopedUpdate(input: {
    readonly projectId: string;
    readonly documentId: string;
    readonly expectedBaseVector: Uint8Array;
    readonly update: Uint8Array;
    readonly expectedHumanPresenceGeneration: number;
  }): Promise<
    | {
        ok: true;
        ticket: { stateVector: Uint8Array; update: Uint8Array; compensatingUpdate: Uint8Array };
      }
    | { ok: false; reason: 'stale-vector'; liveStateVector: Uint8Array }
    | { ok: false; reason: 'human-presence-changed'; liveStateVector: Uint8Array }
  > {
    this.seenProjects.push(input.projectId);
    const current = this.contents.get(input.documentId);
    const live = current === undefined ? '' : current;
    const liveVector = FakeDocumentPort.vectorOf(live);
    // Atomic with the mutation below (this method is synchronous): a
    // human-presence transition observed since the caller's precheck rejects
    // the mutation before anything is written.
    if (this.#presenceGeneration() !== input.expectedHumanPresenceGeneration) {
      return { ok: false, reason: 'human-presence-changed', liveStateVector: liveVector };
    }
    if (!bytesEqual(liveVector, input.expectedBaseVector)) {
      return { ok: false, reason: 'stale-vector', liveStateVector: liveVector };
    }
    const payload = JSON.parse(textDecoder.decode(input.update)) as { content: string };
    this.contents.set(input.documentId, payload.content);
    return {
      ok: true,
      ticket: {
        stateVector: FakeDocumentPort.vectorOf(payload.content),
        update: textEncoder.encode(payload.content),
        compensatingUpdate: textEncoder.encode(live),
      },
    };
  }

  async applyCompensatingUpdate(input: {
    readonly projectId: string;
    readonly documentId: string;
    readonly expectedVector: Uint8Array;
    readonly compensatingUpdate: Uint8Array;
    readonly expectedHumanPresenceGeneration: number;
  }): Promise<
    | { ok: true; stateVector: Uint8Array }
    | { ok: false; reason: 'stale-vector'; liveStateVector: Uint8Array }
    | { ok: false; reason: 'human-presence-changed'; liveStateVector: Uint8Array }
  > {
    this.seenProjects.push(input.projectId);
    const current = this.contents.get(input.documentId);
    const live = current === undefined ? '' : current;
    const liveVector = FakeDocumentPort.vectorOf(live);
    // Same atomic generation guard as apply: a presence transition observed
    // since the caller's precheck blocks the compensating update.
    if (this.#presenceGeneration() !== input.expectedHumanPresenceGeneration) {
      return { ok: false, reason: 'human-presence-changed', liveStateVector: liveVector };
    }
    if (!bytesEqual(liveVector, input.expectedVector)) {
      return { ok: false, reason: 'stale-vector', liveStateVector: liveVector };
    }
    const restored = textDecoder.decode(input.compensatingUpdate);
    this.contents.set(input.documentId, restored);
    return { ok: true, stateVector: FakeDocumentPort.vectorOf(restored) };
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => b[index] === byte);
}

interface Fixture {
  harness: RealPersistenceHarness;
  capabilityService: AgentCapabilityService;
  session: ProjectSession;
  audit: ReturnType<typeof recordingAudit>;
  documents: FakeDocumentPort;
  service: ReturnType<typeof createAgentCommandService>;
  now: string;
}

interface FixtureOptions {
  readonly projectId?: string;
  readonly presence?: AgentPresencePort;
  readonly initialDocuments?: Record<string, string>;
  readonly maxTrackedEffectTickets?: number;
}

function createFixture(options: FixtureOptions = {}): Fixture {
  const projectId = options.projectId ?? 'project-a';
  const now = '2026-08-02T00:00:00.000Z';
  const harness = createRealPersistence();
  const capabilityService = new AgentCapabilityService({
    persistence: createCapabilityPersistence(harness.client),
    now: () => Date.parse(now),
  });
  const audit = recordingAudit();
  const runtime = createProjectCoreRuntime({
    projectId,
    services: fakeServices({ now: () => now }),
    compile: (snapshot) => ({ events: snapshot.documents.length }) as unknown as ProjectCompilation,
  });
  const session = createProjectSession({
    projectId,
    runtime,
    capabilities: { checkGrant: (input) => capabilityService.checkGrant(input) },
    audit: audit.sink,
    derive: testDerive,
    now: () => now,
  });
  // The fake document layer shares the session's human-presence generation,
  // exactly like the real adapter wiring: the service observes it at precheck
  // and the port re-validates it atomically inside its own mutation section.
  const documents = new FakeDocumentPort(
    options.initialDocuments ?? { 'doc-1': 'original prose' },
    () => session.presenceGeneration,
  );
  let effectSequence = 0;
  const service = createAgentCommandService({
    session,
    documents,
    presence: options.presence,
    newEffectId: () => `fx-${++effectSequence}`,
    maxTrackedEffectTickets: options.maxTrackedEffectTickets,
  });
  return {
    harness,
    capabilityService,
    session,
    audit,
    documents,
    service,
    now,
  };
}

function issueCapability(capabilityService: AgentCapabilityService, projectId = 'project-a') {
  return capabilityService.issue({ userId: 'agent-1', projectId, scopes: ['edit:prose'] });
}

function makeEffectInput(options: {
  readonly documentId?: string;
  readonly capabilityId: string;
  readonly expectedBaseVector?: Uint8Array;
  readonly content?: string;
  readonly sceneId?: string;
  readonly expectedVersion?: number;
}): AgentEditEffectInput {
  const documentId = options.documentId ?? 'doc-1';
  return {
    documentId,
    ...(options.sceneId === undefined ? {} : { sceneId: options.sceneId }),
    capabilityId: options.capabilityId,
    scope: ['edit:prose'],
    ...(options.expectedVersion === undefined ? {} : { expectedVersion: options.expectedVersion }),
    expectedBaseVector: options.expectedBaseVector ?? FakeDocumentPort.vectorOf('original prose'),
    update: textEncoder.encode(JSON.stringify({ content: options.content ?? 'edited prose' })),
  };
}

function makeRevertInput(options: {
  readonly effectId: string;
  readonly capabilityId: string;
  readonly documentId?: string;
}): AgentRevertEffectInput {
  return {
    documentId: options.documentId ?? 'doc-1',
    capabilityId: options.capabilityId,
    scope: ['edit:prose'],
    effectId: options.effectId,
  };
}

function expectApplied(
  result: AgentEditEffectResult,
): Extract<AgentEditEffectResult, { status: 'applied' }> {
  expect(result.status).toBe('applied'); // assertion fails the test on any other status
  return result as Extract<AgentEditEffectResult, { status: 'applied' }>;
}

function expectReverted(
  result: AgentRevertEffectResult,
): Extract<AgentRevertEffectResult, { status: 'reverted' }> {
  expect(result.status).toBe('reverted'); // assertion fails the test on any other status
  return result as Extract<AgentRevertEffectResult, { status: 'reverted' }>;
}

function expectDenied(
  result: AgentEditEffectResult | AgentRevertEffectResult,
  reason: AgentCapabilityFailureCode,
): void {
  expect(result).toEqual({ status: 'denied', reason });
}

// ─── Capability + presence + vector gating ───────────────────────────────────

describe('AgentCommandService effect safeguards', () => {
  it('applies a scoped update when capability, presence, and vector all pass', async () => {
    const fixture = createFixture();
    activeHarness = fixture.harness;
    const { grant } = await issueCapability(fixture.capabilityService);
    const result = expectApplied(
      await fixture.service.applyEffect(
        makeEffectInput({ capabilityId: grant.capabilityId, content: 'edited prose' }),
      ),
    );
    expect(result).toMatchObject({ effectId: 'fx-1', projectId: 'project-a', documentId: 'doc-1' });
    expect(result.stateVector).toEqual(FakeDocumentPort.vectorOf('edited prose'));
    expect(textDecoder.decode(result.update)).toBe('edited prose');
    expect(fixture.documents.contentOf('doc-1')).toBe('edited prose');

    // The effect was audited through the shared session sink, grant-derived.
    expect(fixture.audit.records).toHaveLength(1);
    expect(fixture.audit.records[0]).toMatchObject({
      outcome: 'completed',
      kind: 'operation.edit.apply.completed',
      capabilityId: grant.capabilityId,
      actorId: 'agent-1',
      projectId: 'project-a',
      scopes: ['edit:prose'],
      version: 1,
      at: fixture.now,
    });
  });

  it('pauses on human presence and requires a fresh vector/replan before resume', async () => {
    let human = true;
    const fixture = createFixture({ presence: { isHumanEditing: () => human } });
    activeHarness = fixture.harness;
    const { grant } = await issueCapability(fixture.capabilityService);
    const result = await fixture.service.applyEffect(
      makeEffectInput({ capabilityId: grant.capabilityId, content: 'edited prose' }),
    );
    expect(result).toEqual({
      status: 'paused',
      reason: 'human-presence',
      projectId: 'project-a',
      documentId: 'doc-1',
      liveStateVector: FakeDocumentPort.vectorOf('original prose'),
      replanRequired: true,
    });
    expect(fixture.documents.contentOf('doc-1')).toBe('original prose'); // nothing applied

    // The caller replans against the fresh vector; the human has left.
    human = false;
    const resumed = expectApplied(
      await fixture.service.applyEffect(
        makeEffectInput({
          capabilityId: grant.capabilityId,
          expectedBaseVector: FakeDocumentPort.vectorOf('original prose'),
          content: 'edited prose',
        }),
      ),
    );
    expect(resumed.effectId).toBe('fx-1');
    expect(fixture.documents.contentOf('doc-1')).toBe('edited prose');
  });

  it('pauses on session presence (browser) even without an injected presence port', async () => {
    const fixture = createFixture();
    activeHarness = fixture.harness;
    const { grant } = await issueCapability(fixture.capabilityService);
    fixture.session.updatePresence({
      kind: 'join',
      actorId: 'human-1',
      surface: 'browser',
      at: fixture.now,
    });
    expect(fixture.session.hasHumanPresence).toBe(true);
    const paused = await fixture.service.applyEffect(
      makeEffectInput({ capabilityId: grant.capabilityId }),
    );
    expect(paused).toMatchObject({
      status: 'paused',
      reason: 'human-presence',
      replanRequired: true,
    });

    fixture.session.updatePresence({
      kind: 'leave',
      actorId: 'human-1',
      surface: 'browser',
      at: fixture.now,
    });
    expect(fixture.session.hasHumanPresence).toBe(false);
    const resumed = expectApplied(
      await fixture.service.applyEffect(makeEffectInput({ capabilityId: grant.capabilityId })),
    );
    expect(fixture.documents.contentOf('doc-1')).toBe('edited prose');
    expect(resumed.effectId).toBe('fx-1');
  });

  it('rejects a stale base vector with a typed conflict and applies nothing', async () => {
    const fixture = createFixture();
    activeHarness = fixture.harness;
    const { grant } = await issueCapability(fixture.capabilityService);
    // Another writer moved the document after the agent composed its effect.
    fixture.documents.write('doc-1', 'someone else wrote this');
    const result = await fixture.service.applyEffect(
      makeEffectInput({ capabilityId: grant.capabilityId, content: 'edited prose' }),
    );
    expect(result).toEqual({
      status: 'conflict',
      reason: 'stale-vector',
      projectId: 'project-a',
      documentId: 'doc-1',
      liveStateVector: FakeDocumentPort.vectorOf('someone else wrote this'),
    });
    expect(fixture.documents.contentOf('doc-1')).toBe('someone else wrote this');
    // The effect was audited as a completed (gated) checkpoint, never as data.
    expect(fixture.audit.records).toHaveLength(1);
  });

  it('denies the next effect when the capability is revoked between effects', async () => {
    const fixture = createFixture();
    activeHarness = fixture.harness;
    const { grant } = await issueCapability(fixture.capabilityService);
    const first = expectApplied(
      await fixture.service.applyEffect(
        makeEffectInput({ capabilityId: grant.capabilityId, content: 'first edit' }),
      ),
    );
    expect(first.effectId).toBe('fx-1');

    await fixture.capabilityService.revoke(grant.capabilityId, 'owner decision');

    const second = await fixture.service.applyEffect(
      makeEffectInput({
        capabilityId: grant.capabilityId,
        expectedBaseVector: FakeDocumentPort.vectorOf('first edit'),
        content: 'second edit',
      }),
    );
    expectDenied(second, 'REVOKED');
    expect(fixture.documents.contentOf('doc-1')).toBe('first edit'); // second effect never applied

    // Audit carries both the granted effect and the typed denial.
    expect(fixture.audit.records.map((record) => record.outcome)).toEqual(['completed', 'denied']);
    expect(fixture.audit.records[1]).toMatchObject({
      outcome: 'denied',
      reason: 'REVOKED',
      capabilityId: grant.capabilityId,
      projectId: 'project-a',
    });
  });

  it('denies when the persisted capability version no longer matches the expected version', async () => {
    const fixture = createFixture();
    activeHarness = fixture.harness;
    const { grant } = await issueCapability(fixture.capabilityService);
    const bumped: CapabilityState = {
      capabilityId: grant.capabilityId,
      userId: 'agent-1',
      projectId: 'project-a',
      scope: ['edit:prose'],
      version: 2,
      expiresAt: grant.expiresAt,
    };
    await fixture.harness.client.request('upsertCapability', bumped);
    const result = await fixture.service.applyEffect(
      makeEffectInput({ capabilityId: grant.capabilityId, expectedVersion: 1 }),
    );
    expectDenied(result, 'VERSION_MISMATCH');
    expect(fixture.documents.contentOf('doc-1')).toBe('original prose');
  });

  it('gates before presence: a revoked grant is denied, never paused', async () => {
    const fixture = createFixture({ presence: { isHumanEditing: () => true } });
    activeHarness = fixture.harness;
    const { grant } = await issueCapability(fixture.capabilityService);
    await fixture.capabilityService.revoke(grant.capabilityId);
    const result = await fixture.service.applyEffect(
      makeEffectInput({ capabilityId: grant.capabilityId }),
    );
    expectDenied(result, 'REVOKED');
    expect(fixture.audit.records.map((record) => record.outcome)).toEqual(['denied']);
  });

  it('serializes effects: a second effect composed on the same base conflicts deterministically', async () => {
    const fixture = createFixture();
    activeHarness = fixture.harness;
    const { grant } = await issueCapability(fixture.capabilityService);
    const base = FakeDocumentPort.vectorOf('original prose');
    const [first, second] = await Promise.all([
      fixture.service.applyEffect(
        makeEffectInput({
          capabilityId: grant.capabilityId,
          expectedBaseVector: base,
          content: 'first writer',
        }),
      ),
      fixture.service.applyEffect(
        makeEffectInput({
          capabilityId: grant.capabilityId,
          expectedBaseVector: base,
          content: 'second writer',
        }),
      ),
    ]);
    // The session queue serializes effects in enqueue order: the first
    // applies, the second sees the moved vector and conflicts without writing.
    expect(first).toMatchObject({ status: 'applied' });
    expect(second).toEqual({
      status: 'conflict',
      reason: 'stale-vector',
      projectId: 'project-a',
      documentId: 'doc-1',
      liveStateVector: FakeDocumentPort.vectorOf('first writer'),
    });
    expect(fixture.documents.contentOf('doc-1')).toBe('first writer');
  });

  it('addresses every document-port mutation with the bound session project, never caller input', async () => {
    const fixture = createFixture({ projectId: 'project-a' });
    activeHarness = fixture.harness;
    const { grant } = await issueCapability(fixture.capabilityService, 'project-a');
    const applied = expectApplied(
      await fixture.service.applyEffect(
        makeEffectInput({ capabilityId: grant.capabilityId, content: 'edited prose' }),
      ),
    );
    const reverted = expectReverted(
      await fixture.service.revertEffect(
        makeRevertInput({ effectId: applied.effectId, capabilityId: grant.capabilityId }),
      ),
    );
    // Both mutations were addressed with the session's project id: a caller
    // has no project input to override, so a session for project A can never
    // be pointed at project B's documents.
    expect(fixture.documents.seenProjects).toEqual(['project-a', 'project-a']);
    expect(reverted.stateVector).toEqual(FakeDocumentPort.vectorOf('original prose'));
  });

  it('denies an effect when the capability grant is scoped to a different project than the bound session', async () => {
    const fixture = createFixture({ projectId: 'project-a' });
    activeHarness = fixture.harness;
    const { grant } = await issueCapability(fixture.capabilityService, 'project-b');
    const result = await fixture.service.applyEffect(
      makeEffectInput({ capabilityId: grant.capabilityId, content: 'edited prose' }),
    );
    expectDenied(result, 'PROJECT_MISMATCH');
    expect(fixture.documents.contentOf('doc-1')).toBe('original prose'); // nothing touched
    expect(fixture.documents.seenProjects).toEqual([]); // the document port was never reached
    expect(fixture.audit.records).toEqual([
      expect.objectContaining({ outcome: 'denied', reason: 'PROJECT_MISMATCH' }),
    ]);
  });

  it('atomically rejects an edit when a human-presence transition occurs between precheck and document mutation', async () => {
    let arm = false;
    const fixture = createFixture({
      presence: {
        isHumanEditing: async () => {
          if (arm) {
            arm = false;
            // A human starts editing while the service prechecks: the session
            // generation advances after the service observed it, so the
            // document mutation must reject without applying anything.
            fixture.session.updatePresence({
              kind: 'join',
              actorId: 'human-1',
              surface: 'browser',
              at: fixture.now,
            });
          }
          return false;
        },
      },
    });
    activeHarness = fixture.harness;
    const { grant } = await issueCapability(fixture.capabilityService);
    arm = true;
    const result = await fixture.service.applyEffect(
      makeEffectInput({ capabilityId: grant.capabilityId, content: 'edited prose' }),
    );
    expect(result).toEqual({
      status: 'paused',
      reason: 'human-presence',
      projectId: 'project-a',
      documentId: 'doc-1',
      liveStateVector: FakeDocumentPort.vectorOf('original prose'),
      replanRequired: true,
    });
    expect(fixture.documents.contentOf('doc-1')).toBe('original prose'); // nothing applied

    // Nothing was applied, so no ticket was tracked: once the human leaves,
    // reverting the never-created effect is a typed unknown-effect conflict.
    fixture.session.updatePresence({
      kind: 'leave',
      actorId: 'human-1',
      surface: 'browser',
      at: fixture.now,
    });
    const reverted = await fixture.service.revertEffect(
      makeRevertInput({ effectId: 'fx-1', capabilityId: grant.capabilityId }),
    );
    expect(reverted).toMatchObject({ status: 'conflict', reason: 'unknown-effect' });
  });
});

// ─── Conditional compensating revert ─────────────────────────────────────────

describe('AgentCommandService conditional compensating revert', () => {
  it('conditionally reverts an applied effect when the document still matches the post-effect vector', async () => {
    const fixture = createFixture();
    activeHarness = fixture.harness;
    const { grant } = await issueCapability(fixture.capabilityService);
    const applied = expectApplied(
      await fixture.service.applyEffect(
        makeEffectInput({ capabilityId: grant.capabilityId, content: 'edited prose' }),
      ),
    );
    expect(fixture.documents.contentOf('doc-1')).toBe('edited prose');

    const reverted = expectReverted(
      await fixture.service.revertEffect(
        makeRevertInput({ effectId: applied.effectId, capabilityId: grant.capabilityId }),
      ),
    );
    expect(reverted.stateVector).toEqual(FakeDocumentPort.vectorOf('original prose'));
    expect(fixture.documents.contentOf('doc-1')).toBe('original prose'); // exactly the effect's changes compensated

    // The ticket is consumed: a second revert is a typed unknown-effect conflict.
    const again = await fixture.service.revertEffect(
      makeRevertInput({ effectId: applied.effectId, capabilityId: grant.capabilityId }),
    );
    expect(again).toEqual({
      status: 'conflict',
      reason: 'unknown-effect',
      projectId: 'project-a',
      documentId: 'doc-1',
    });

    // Every gated operation is audited through the shared sink: the applied
    // effect, the successful revert, and the unknown-effect conflict attempt
    // (a gated checkpoint) each emit exactly one deterministic record. The
    // operation queue audits the gated run, not the semantic outcome, so a
    // typed conflict is still a completed checkpoint, never effect data.
    expect(fixture.audit.records).toHaveLength(3);
    expect(fixture.audit.records.map((record) => record.outcome)).toEqual([
      'completed',
      'completed',
      'completed',
    ]);
    expect(
      fixture.audit.records.map((record) => ('kind' in record ? record.kind : undefined)),
    ).toEqual([
      'operation.edit.apply.completed',
      'operation.edit.revert.completed',
      'operation.edit.revert.completed',
    ]);

    // Grant-derived, secret-free metadata on every record: no token, no
    // digest, and no document content or state vectors.
    for (const record of fixture.audit.records) {
      expect(record).toMatchObject({
        outcome: 'completed',
        capabilityId: grant.capabilityId,
        actorId: 'agent-1',
        projectId: 'project-a',
        scopes: ['edit:prose'],
        version: 1,
        at: fixture.now,
      });
      expect(Object.keys(record)).not.toContain('token');
      expect(JSON.stringify(record)).not.toMatch(/digest|secret/);
      expect(JSON.stringify(record)).not.toContain('original prose');
      expect(JSON.stringify(record)).not.toContain('edited prose');
    }

    // The two revert records are distinct operations, not duplicates: they
    // are deterministically identical except for the session operation id.
    const revertRecords = fixture.audit.records.filter(
      (record) => 'kind' in record && record.kind === 'operation.edit.revert.completed',
    );
    expect(revertRecords).toHaveLength(2);
    const [successfulRevert, conflictRevert] = revertRecords;
    expect(successfulRevert.operationId).not.toBe(conflictRevert.operationId);
    expect({ ...successfulRevert, operationId: undefined }).toEqual({
      ...conflictRevert,
      operationId: undefined,
    });
  });

  it('never rewinds a document that moved after the effect: typed conflict, unrelated edits preserved', async () => {
    const fixture = createFixture();
    activeHarness = fixture.harness;
    const { grant } = await issueCapability(fixture.capabilityService);
    const applied = expectApplied(
      await fixture.service.applyEffect(
        makeEffectInput({ capabilityId: grant.capabilityId, content: 'edited prose' }),
      ),
    );
    // A human edits after the effect: the post-effect vector no longer matches.
    fixture.documents.write('doc-1', 'human continuation');
    const reverted = await fixture.service.revertEffect(
      makeRevertInput({ effectId: applied.effectId, capabilityId: grant.capabilityId }),
    );
    expect(reverted).toEqual({
      status: 'conflict',
      reason: 'stale-vector',
      projectId: 'project-a',
      documentId: 'doc-1',
      liveStateVector: FakeDocumentPort.vectorOf('human continuation'),
    });
    // The compensating update was never applied: the human's edit is intact
    // and the pre-effect content is NOT restored (no whole-document rewind).
    expect(fixture.documents.contentOf('doc-1')).toBe('human continuation');
  });

  it('returns a typed conflict for an unknown or foreign effect id', async () => {
    const fixture = createFixture({
      initialDocuments: { 'doc-1': 'original prose', 'doc-2': 'doc two original' },
    });
    activeHarness = fixture.harness;
    const { grant } = await issueCapability(fixture.capabilityService);

    const unknown = await fixture.service.revertEffect(
      makeRevertInput({ effectId: 'fx-does-not-exist', capabilityId: grant.capabilityId }),
    );
    expect(unknown).toEqual({
      status: 'conflict',
      reason: 'unknown-effect',
      projectId: 'project-a',
      documentId: 'doc-1',
    });

    // An effect applied to another document cannot be reverted against this one.
    const other = expectApplied(
      await fixture.service.applyEffect(
        makeEffectInput({
          documentId: 'doc-2',
          capabilityId: grant.capabilityId,
          expectedBaseVector: FakeDocumentPort.vectorOf('doc two original'),
          content: 'doc two edit',
        }),
      ),
    );
    const foreign = await fixture.service.revertEffect(
      makeRevertInput({
        effectId: other.effectId,
        capabilityId: grant.capabilityId,
        documentId: 'doc-1',
      }),
    );
    expect(foreign).toMatchObject({ status: 'conflict', reason: 'unknown-effect' });
    expect(fixture.documents.contentOf('doc-2')).toBe('doc two edit'); // untouched
  });

  it('pauses a revert on human presence and resumes after the human leaves', async () => {
    let human = false;
    const fixture = createFixture({ presence: { isHumanEditing: () => human } });
    activeHarness = fixture.harness;
    const { grant } = await issueCapability(fixture.capabilityService);
    const applied = expectApplied(
      await fixture.service.applyEffect(
        makeEffectInput({ capabilityId: grant.capabilityId, content: 'edited prose' }),
      ),
    );
    human = true;
    const paused = await fixture.service.revertEffect(
      makeRevertInput({ effectId: applied.effectId, capabilityId: grant.capabilityId }),
    );
    expect(paused).toEqual({
      status: 'paused',
      reason: 'human-presence',
      projectId: 'project-a',
      documentId: 'doc-1',
      liveStateVector: FakeDocumentPort.vectorOf('edited prose'),
      replanRequired: true,
    });
    expect(fixture.documents.contentOf('doc-1')).toBe('edited prose'); // no rewind while paused
    human = false;
    expectReverted(
      await fixture.service.revertEffect(
        makeRevertInput({ effectId: applied.effectId, capabilityId: grant.capabilityId }),
      ),
    );
    expect(fixture.documents.contentOf('doc-1')).toBe('original prose');
  });

  it('bounds tracked effect tickets: an evicted ticket cannot be reverted', async () => {
    const fixture = createFixture({
      initialDocuments: { 'doc-1': 'a', 'doc-2': 'b' },
      maxTrackedEffectTickets: 1,
    });
    activeHarness = fixture.harness;
    const { grant } = await issueCapability(fixture.capabilityService);
    const first = expectApplied(
      await fixture.service.applyEffect(
        makeEffectInput({
          documentId: 'doc-1',
          capabilityId: grant.capabilityId,
          expectedBaseVector: FakeDocumentPort.vectorOf('a'),
          content: 'a edited',
        }),
      ),
    );
    const second = expectApplied(
      await fixture.service.applyEffect(
        makeEffectInput({
          documentId: 'doc-2',
          capabilityId: grant.capabilityId,
          expectedBaseVector: FakeDocumentPort.vectorOf('b'),
          content: 'b edited',
        }),
      ),
    );
    expect(second.effectId).toBe('fx-2'); // fx-1 was evicted by the bound
    const reverted = await fixture.service.revertEffect(
      makeRevertInput({
        effectId: first.effectId,
        capabilityId: grant.capabilityId,
        documentId: 'doc-1',
      }),
    );
    expect(reverted).toMatchObject({ status: 'conflict', reason: 'unknown-effect' });
    expect(fixture.documents.contentOf('doc-1')).toBe('a edited');
  });

  it('atomically rejects a revert when a human-presence transition occurs between precheck and compensating mutation', async () => {
    let arm = false;
    const fixture = createFixture({
      presence: {
        isHumanEditing: async () => {
          if (arm) {
            arm = false;
            // A human starts editing while the revert prechecks: the session
            // generation advances after the service observed it, so the
            // compensating update must reject without rewinding anything.
            fixture.session.updatePresence({
              kind: 'join',
              actorId: 'human-1',
              surface: 'browser',
              at: fixture.now,
            });
          }
          return false;
        },
      },
    });
    activeHarness = fixture.harness;
    const { grant } = await issueCapability(fixture.capabilityService);
    const applied = expectApplied(
      await fixture.service.applyEffect(
        makeEffectInput({ capabilityId: grant.capabilityId, content: 'edited prose' }),
      ),
    );
    expect(fixture.documents.contentOf('doc-1')).toBe('edited prose');

    arm = true;
    const paused = await fixture.service.revertEffect(
      makeRevertInput({ effectId: applied.effectId, capabilityId: grant.capabilityId }),
    );
    expect(paused).toEqual({
      status: 'paused',
      reason: 'human-presence',
      projectId: 'project-a',
      documentId: 'doc-1',
      liveStateVector: FakeDocumentPort.vectorOf('edited prose'),
      replanRequired: true,
    });
    // The compensating update was never applied: the effect's edit is intact.
    expect(fixture.documents.contentOf('doc-1')).toBe('edited prose');

    // The ticket survives the paused revert: after the human leaves, the same
    // revert completes against the still-matching post-effect vector.
    fixture.session.updatePresence({
      kind: 'leave',
      actorId: 'human-1',
      surface: 'browser',
      at: fixture.now,
    });
    expectReverted(
      await fixture.service.revertEffect(
        makeRevertInput({ effectId: applied.effectId, capabilityId: grant.capabilityId }),
      ),
    );
    expect(fixture.documents.contentOf('doc-1')).toBe('original prose');
  });
});

// ─── Audit equivalence and boundary ──────────────────────────────────────────

describe('AgentCommandService audit and construction', () => {
  it('records equivalent secret-free audit metadata for equivalent effects', async () => {
    const fixture = createFixture({
      initialDocuments: { 'doc-1': 'original prose', 'doc-2': 'other original' },
    });
    activeHarness = fixture.harness;
    const { token, grant } = await issueCapability(fixture.capabilityService);
    const first = expectApplied(
      await fixture.service.applyEffect(
        makeEffectInput({
          documentId: 'doc-1',
          capabilityId: grant.capabilityId,
          content: 'edited prose',
        }),
      ),
    );
    const second = expectApplied(
      await fixture.service.applyEffect(
        makeEffectInput({
          documentId: 'doc-2',
          capabilityId: grant.capabilityId,
          expectedBaseVector: FakeDocumentPort.vectorOf('other original'),
          content: 'edited prose',
        }),
      ),
    );
    expect(first.effectId).toBe('fx-1');
    expect(second.effectId).toBe('fx-2');

    const applyRecords = fixture.audit.records.filter(
      (record) => 'kind' in record && record.kind === 'operation.edit.apply.completed',
    );
    expect(applyRecords).toHaveLength(2);
    // Equivalent effects produce equivalent audit records: identical
    // grant-derived metadata, differing only in the session operation id.
    for (const record of applyRecords) {
      expect(record).toMatchObject({
        outcome: 'completed',
        capabilityId: grant.capabilityId,
        actorId: 'agent-1',
        projectId: 'project-a',
        scopes: ['edit:prose'],
        version: 1,
        kind: 'operation.edit.apply.completed',
        at: fixture.now,
      });
    }
    expect(applyRecords[0].operationId).not.toBe(applyRecords[1].operationId);

    // Audit is secret-free: the token never appears, and no digest or
    // persistence internals leak into the record.
    for (const record of applyRecords) {
      expect(JSON.stringify(record)).not.toContain(token);
      expect(Object.keys(record)).not.toContain('token');
      expect(JSON.stringify(record)).not.toMatch(/digest|secret/);
    }
  });

  it('fails closed on missing or invalid injected ports', async () => {
    const fixture = createFixture();
    activeHarness = fixture.harness;
    const { session } = fixture;
    const documents = new FakeDocumentPort();
    const options = { session, documents } as Parameters<typeof createAgentCommandService>[0];

    expect(() =>
      createAgentCommandService({} as Parameters<typeof createAgentCommandService>[0]),
    ).toThrow(TypeError);
    expect(() =>
      createAgentCommandService({ documents } as Parameters<typeof createAgentCommandService>[0]),
    ).toThrow(TypeError);
    expect(() =>
      createAgentCommandService({ session } as Parameters<typeof createAgentCommandService>[0]),
    ).toThrow(TypeError);
    expect(() =>
      createAgentCommandService({
        session,
        documents,
        presence: {} as AgentPresencePort,
      }),
    ).toThrow(TypeError);
    expect(() => createAgentCommandService({ ...options, maxTrackedEffectTickets: 0 })).toThrow(
      TypeError,
    );
  });

  it('does not expose capability tokens or persistence internals through the browser contract barrel', async () => {
    // The agent boundary barrel re-exports the command service, but the
    // browser-safe contracts barrel must never surface host handles.
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const barrel = await readFile(
      fileURLToPath(new URL('../src/contracts/index.ts', import.meta.url)),
      'utf8',
    );
    expect(barrel).not.toMatch(/AgentCommandService|AgentCapabilityService/);
  });
});
