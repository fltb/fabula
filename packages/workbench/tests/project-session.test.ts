import type {
  CoreExecutionRepository,
  CoreRuntimeServices,
  LLMProvider,
  ProjectCompilation,
  ProjectSourceSnapshotV1,
  ProjectStatusResult,
  RenderCacheRepository,
  StateLogRepository,
  StateSnapshotRepository,
} from '@novalistically/core';
import { describe, expect, it } from 'vitest';
import type { ProjectSessionProjectionV1 as ContractsProjectionV1 } from '../src/contracts/index.js';
import * as contracts from '../src/contracts/index.js';
import type {
  AgentCapabilityCheckResult,
  AgentCapabilityService,
  CheckCapabilityInput,
} from '../src/host/agent/index.js';
import {
  createProjectCoreRuntime,
  MAX_MEMOIZED_SNAPSHOTS,
  type ProjectCoreRuntime,
} from '../src/host/core-runtime.js';
import {
  type CreateProjectSessionOptions,
  createProjectSession,
  createProjectSessionRegistry,
  defaultProjectSessionRegistry,
  deriveProjectSessionProjection,
  type ProjectionDerivationInput,
  ProjectSessionExistsError,
  type ProjectSessionProjectionV1,
  type SessionAuditRecord,
  type SessionAuditSink,
  type SessionOperation,
} from '../src/host/project-session.js';

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

interface SnapshotOptions {
  readonly parsed?: boolean;
  readonly errorDiagnostics?: number;
  readonly warningDiagnostics?: number;
  readonly documents?: number;
}

function makeSnapshot(sourceHash: string, options: SnapshotOptions = {}): ProjectSourceSnapshotV1 {
  const documentCount = options.documents ?? 1;
  const parsed = options.parsed ?? true;
  return {
    version: 1,
    sourceHash,
    documents: Array.from({ length: documentCount }, (_, index) => ({
      version: 1 as const,
      logicalPath: `definitions/test-${index}.yaml`,
      content: `key${index}: value`,
      contentHash: `content-${index}`,
      parseResult: {
        status: parsed ? ('parsed' as const) : ('invalid' as const),
        value: parsed ? { key: 'value' } : null,
      },
      diagnostics: [
        ...Array.from({ length: options.errorDiagnostics ?? 0 }, (_, d) => ({
          code: `test.error.${d}`,
          severity: 'error' as const,
          message: `error ${d}`,
          logicalPath: `definitions/test-${index}.yaml`,
        })),
        ...Array.from({ length: options.warningDiagnostics ?? 0 }, (_, d) => ({
          code: `test.warning.${d}`,
          severity: 'warning' as const,
          message: `warning ${d}`,
          logicalPath: `definitions/test-${index}.yaml`,
        })),
      ],
    })),
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

function allowedVerdict(
  userId: string,
  projectId: string,
  scopes: readonly string[],
  version = 1,
  expiresAt = '2099-01-01T00:00:00.000Z',
): AgentCapabilityCheckResult {
  return {
    allowed: true,
    grant: { capabilityId: 'cap-1', userId, projectId, scopes, version, expiresAt },
  };
}

function fakeCapabilities(
  verdict: AgentCapabilityCheckResult,
): Pick<AgentCapabilityService, 'checkGrant'> {
  return { checkGrant: async () => verdict };
}

function recordingAudit(): { sink: SessionAuditSink; records: SessionAuditRecord[] } {
  const records: SessionAuditRecord[] = [];
  return { sink: { record: (record) => void records.push(record) }, records };
}

interface FixtureOptions {
  readonly projectId?: string;
  readonly sourceHash?: string;
  readonly compile?: (snapshot: ProjectSourceSnapshotV1) => ProjectCompilation;
  readonly verdict?: AgentCapabilityCheckResult;
  readonly derive?: (input: ProjectionDerivationInput) => ProjectSessionProjectionV1;
  readonly now?: () => string;
  readonly maxMemoizedSnapshots?: number;
  readonly capabilities?: Pick<AgentCapabilityService, 'checkGrant'>;
}

function fakeCompile(calls: string[]): (snapshot: ProjectSourceSnapshotV1) => ProjectCompilation {
  return (snapshot) => {
    calls.push(snapshot.sourceHash);
    return { events: snapshot.documents.length } as unknown as ProjectCompilation;
  };
}

function createFixture(options: FixtureOptions = {}) {
  const projectId = options.projectId ?? 'project-a';
  const compileCalls: string[] = [];
  const compile = options.compile ?? fakeCompile(compileCalls);
  const now = options.now ?? (() => '2026-08-02T00:00:00.000Z');
  const audit = recordingAudit();
  const runtime = createProjectCoreRuntime({
    projectId,
    services: fakeServices({ now }),
    compile,
    maxMemoizedSnapshots: options.maxMemoizedSnapshots,
  });
  const session = createProjectSession({
    projectId,
    runtime,
    capabilities:
      options.capabilities ??
      fakeCapabilities(options.verdict ?? allowedVerdict('user-1', projectId, ['scene:edit'])),
    audit: audit.sink,
    initialSource: options.sourceHash ? makeSnapshot(options.sourceHash) : undefined,
    derive: options.derive ?? testDerive,
    now,
  });
  return { session, runtime, compileCalls, audit, now };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function fixtureOptions(projectId: string): CreateProjectSessionOptions {
  const audit = recordingAudit();
  return {
    projectId,
    runtime: createProjectCoreRuntime({
      projectId,
      services: fakeServices(),
      compile: fakeCompile([]),
    }),
    capabilities: fakeCapabilities(allowedVerdict('user-1', projectId, ['scene:edit'])),
    audit: audit.sink,
  };
}

// ─── Registry singleton ──────────────────────────────────────────────────────

describe('ProjectSession registry', () => {
  it('enforces one session per project id with singleton lookup', () => {
    const registry = createProjectSessionRegistry();
    expect(registry.size).toBe(0);
    expect(registry.get('p1')).toBeNull();
    expect(registry.list()).toEqual([]);

    const first = registry.create(fixtureOptions('p1'));
    expect(registry.get('p1')).toBe(first);
    expect(registry.size).toBe(1);

    expect(() => registry.create(fixtureOptions('p1'))).toThrow(ProjectSessionExistsError);
    expect(registry.get('p1')).toBe(first);

    // open is a singleton lookup-or-create: existing options are ignored.
    expect(registry.open(fixtureOptions('p1'))).toBe(first);
    const second = registry.open(fixtureOptions('p2'));
    expect(second).not.toBe(first);
    expect(registry.list()).toEqual([first, second]);

    expect(registry.remove('p1')).toBe(true);
    expect(registry.remove('p1')).toBe(false);
    expect(registry.get('p1')).toBeNull();
    expect(registry.size).toBe(1);
  });

  it('exposes a stable shared process-wide registry', () => {
    expect(defaultProjectSessionRegistry()).toBe(defaultProjectSessionRegistry());
  });
});

// ─── Core runtime memoization ────────────────────────────────────────────────

describe('ProjectCoreRuntime', () => {
  it('compiles each sourceHash once and reports the memo', () => {
    const calls: string[] = [];
    const runtime = createProjectCoreRuntime({
      projectId: 'p',
      services: fakeServices(),
      compile: (snapshot) => {
        calls.push(snapshot.sourceHash);
        return { events: snapshot.documents.length } as unknown as ProjectCompilation;
      },
    });
    const a = makeSnapshot('hash-a');
    runtime.compile(a);
    runtime.compile(a); // same identity → memo hit
    runtime.compile(makeSnapshot('hash-b'));
    expect(calls).toEqual(['hash-a', 'hash-b']);
    expect(runtime.memoizedHashes).toEqual(['hash-a', 'hash-b']);
    expect(runtime.memoSize).toBe(2);
    expect(runtime.has('hash-a')).toBe(true);
    expect(runtime.has('hash-nope')).toBe(false);
  });

  it('bounds the memo and evicts the oldest entry first', () => {
    const runtime = createProjectCoreRuntime({
      projectId: 'p',
      services: fakeServices(),
      compile: (snapshot) =>
        ({ events: snapshot.documents.length }) as unknown as ProjectCompilation,
      maxMemoizedSnapshots: 2,
    });
    runtime.compile(makeSnapshot('a'));
    runtime.compile(makeSnapshot('b'));
    runtime.compile(makeSnapshot('c'));
    expect(runtime.memoizedHashes).toEqual(['b', 'c']);
    expect(runtime.has('a')).toBe(false);
    expect(runtime.memoSize).toBe(2);
    expect(MAX_MEMOIZED_SNAPSHOTS).toBe(8);
  });

  it('never memoizes a failed compile', () => {
    let calls = 0;
    const runtime = createProjectCoreRuntime({
      projectId: 'p',
      services: fakeServices(),
      compile: () => {
        calls += 1;
        throw new Error('bad source');
      },
    });
    const snapshot = makeSnapshot('hash-a');
    expect(() => runtime.compile(snapshot)).toThrow('bad source');
    expect(() => runtime.compile(snapshot)).toThrow('bad source');
    expect(calls).toBe(2);
    expect(runtime.memoSize).toBe(0);
  });

  it('fails closed on a missing port or empty project id', () => {
    const services = fakeServices();
    delete (services as unknown as { llm?: unknown }).llm;
    expect(() => createProjectCoreRuntime({ projectId: 'p', services })).toThrow(TypeError);
    expect(() => createProjectCoreRuntime({ projectId: '', services: fakeServices() })).toThrow(
      TypeError,
    );
  });
});

// ─── Source refresh: memoization and validity ────────────────────────────────

describe('ProjectSession source refresh', () => {
  it('adopts valid compiled snapshots and memoizes by sourceHash', () => {
    const fixture = createFixture();
    const { session, compileCalls } = fixture;
    expect(session.source).toBeNull();
    expect(session.projection.revision).toBe(0);

    const first = session.refreshSource(makeSnapshot('hash-a'));
    expect(first.status).toBe('accepted');
    expect(session.source?.sourceHash).toBe('hash-a');
    expect(session.projection.revision).toBe(1);
    expect(compileCalls).toEqual(['hash-a']);

    // Same sourceHash → memoized no-op: identical projection, no recompile.
    const again = session.refreshSource(makeSnapshot('hash-a'));
    expect(again.status).toBe('unchanged');
    expect(again.projection).toBe(first.projection);
    expect(compileCalls).toEqual(['hash-a']);

    const second = session.refreshSource(makeSnapshot('hash-b'));
    expect(second.status).toBe('accepted');
    expect(session.projection.sourceHash).toBe('hash-b');
    expect(session.projection.revision).toBe(2);
    expect(compileCalls).toEqual(['hash-a', 'hash-b']);

    // Re-accepting an earlier hash reuses the compile memo but still adopts.
    const back = session.refreshSource(makeSnapshot('hash-a'));
    expect(back.status).toBe('accepted');
    expect(session.projection.sourceHash).toBe('hash-a');
    expect(session.projection.revision).toBe(3);
    expect(compileCalls).toEqual(['hash-a', 'hash-b']);

    // The accepted snapshot is deeply frozen and never handed out mutable.
    expect(Object.isFrozen(session.source)).toBe(true);
    expect(Object.isFrozen(session.source?.documents)).toBe(true);
  });

  it('preserves the last-valid projection across invalid refreshes', () => {
    const fixture = createFixture({ sourceHash: 'hash-valid' });
    const { session } = fixture;
    const before = session.projection;
    const beforeSource = session.source;

    // Unparseable working bytes → diagnostics, accepted state untouched.
    const rejected = session.refreshSource(makeSnapshot('hash-broken', { parsed: false }));
    expect(rejected.status).toBe('rejected');
    expect(rejected.projection).toBe(before); // identical object
    expect(session.source).toBe(beforeSource);
    expect(session.projection.revision).toBe(before.revision);
    expect(rejected.diagnostics.some((d) => d.severity === 'error')).toBe(true);

    // Error-severity diagnostics reject even when every document parses.
    const errorSnapshot = makeSnapshot('hash-errors', { errorDiagnostics: 2 });
    const rejectedErrors = session.refreshSource(errorSnapshot);
    expect(rejectedErrors.status).toBe('rejected');
    expect(rejectedErrors.projection).toBe(before);
    expect(rejectedErrors.diagnostics).toHaveLength(2);

    // Warnings do not block acceptance.
    const acceptedWarnings = session.refreshSource(
      makeSnapshot('hash-warn', { warningDiagnostics: 1 }),
    );
    expect(acceptedWarnings.status).toBe('accepted');
    expect(acceptedWarnings.projection.warningCount).toBe(1);
    expect(session.projection.revision).toBe(before.revision + 1);

    // A snapshot that fails to compile is rejected with a synthetic diagnostic.
    const compileFixture = createFixture({
      sourceHash: 'hash-valid',
      compile: (snapshot) => {
        if (snapshot.sourceHash === 'hash-new') throw new Error('structure broken');
        return { events: 0 } as unknown as ProjectCompilation;
      },
    });
    const failed = compileFixture.session.refreshSource(makeSnapshot('hash-new'));
    expect(failed.status).toBe('rejected');
    expect(failed.diagnostics[0]).toMatchObject({
      code: 'source.compile_failed',
      severity: 'error',
    });
    expect(compileFixture.session.projection.sourceHash).toBe('hash-valid');
  });
});

// ─── Serialized operation queue ──────────────────────────────────────────────

describe('ProjectSession operation queue', () => {
  it('runs operations strictly serially in enqueue order', async () => {
    const { session } = createFixture();
    const started: string[] = [];
    const finished: string[] = [];
    let active = 0;
    let maxActive = 0;
    const release: Array<() => void> = [];

    const op = (name: string): SessionOperation<never, string> => ({
      kind: name,
      capabilityId: 'cap-1',
      scope: ['scene:edit'],
      run: () =>
        new Promise<string>((resolve) => {
          started.push(name);
          active += 1;
          maxActive = Math.max(maxActive, active);
          release.push(() => {
            active -= 1;
            finished.push(name);
            resolve(name);
          });
        }),
    });

    const results = Promise.all([
      session.enqueueOperation(op('a')),
      session.enqueueOperation(op('b')),
      session.enqueueOperation(op('c')),
    ]);
    expect(session.busy).toBe(true);

    await flush();
    expect(started).toEqual(['a']); // only the first slot may begin
    expect(finished).toEqual([]);

    const releaseFirst = release[0];
    if (releaseFirst === undefined) throw new Error('first operation release is missing');
    releaseFirst();
    await flush();
    expect(started).toEqual(['a', 'b']);
    expect(finished).toEqual(['a']);

    const releaseSecond = release[1];
    if (releaseSecond === undefined) throw new Error('second operation release is missing');
    releaseSecond();
    await flush();
    expect(started).toEqual(['a', 'b', 'c']);
    expect(finished).toEqual(['a', 'b']);

    const releaseThird = release[2];
    if (releaseThird === undefined) throw new Error('third operation release is missing');
    releaseThird();
    await expect(results).resolves.toEqual([
      { status: 'completed', operationId: 'operation-1', result: 'a' },
      { status: 'completed', operationId: 'operation-2', result: 'b' },
      { status: 'completed', operationId: 'operation-3', result: 'c' },
    ]);
    expect(maxActive).toBe(1); // strictly serialized: never two effects at once
    expect(finished).toEqual(['a', 'b', 'c']);
    expect(session.busy).toBe(false);
  });

  it('keeps enqueue order even when capability checks settle out of order', async () => {
    const checks: string[] = [];
    const runOrder: string[] = [];
    const checkGrant = async (input: CheckCapabilityInput) => {
      checks.push(input.capabilityId);
      // Simulate a slow gate for the middle operation: settlement order can
      // never reorder slots because each check runs inside its serialized slot.
      if (input.capabilityId === 'cap-b') await new Promise((resolve) => setTimeout(resolve, 5));
      return allowedVerdict('user-1', 'project-a', ['scene:edit']);
    };
    const session = createProjectSession({
      projectId: 'project-a',
      runtime: createProjectCoreRuntime({
        projectId: 'project-a',
        services: fakeServices(),
        compile: (snapshot) =>
          ({ events: snapshot.documents.length }) as unknown as ProjectCompilation,
      }),
      capabilities: { checkGrant },
      audit: recordingAudit().sink,
    });

    const results = await Promise.all([
      session.enqueueOperation({
        kind: 'x',
        capabilityId: 'cap-a',
        scope: ['scene:edit'],
        run: async () => runOrder.push('a'),
      }),
      session.enqueueOperation({
        kind: 'y',
        capabilityId: 'cap-b',
        scope: ['scene:edit'],
        run: async () => runOrder.push('b'),
      }),
      session.enqueueOperation({
        kind: 'z',
        capabilityId: 'cap-c',
        scope: ['scene:edit'],
        run: async () => runOrder.push('c'),
      }),
    ]);

    expect(checks).toEqual(['cap-a', 'cap-b', 'cap-c']);
    expect(runOrder).toEqual(['a', 'b', 'c']);
    expect(results.map((result) => result.status)).toEqual(['completed', 'completed', 'completed']);
  });

  it('denies without running when the grant is revoked or expired', async () => {
    for (const reason of [
      'REVOKED',
      'EXPIRED',
      'NOT_FOUND',
      'PROJECT_MISMATCH',
      'SCOPE_MISMATCH',
      'VERSION_MISMATCH',
    ] as const) {
      const runCalls: string[] = [];
      const fixture = createFixture({ verdict: { allowed: false, reason } });
      const result = await fixture.session.enqueueOperation({
        kind: 'edit',
        capabilityId: 'cap-1',
        scope: ['scene:edit'],
        expectedVersion: 2,
        run: () => {
          runCalls.push('ran');
          return 'x';
        },
      });
      expect(result).toEqual({ status: 'denied', operationId: 'operation-1', reason });
      expect(runCalls).toEqual([]);
      expect(fixture.audit.records).toHaveLength(1);
      expect(fixture.audit.records[0]).toMatchObject({
        outcome: 'denied',
        operationId: 'operation-1',
        capabilityId: 'cap-1',
        reason,
      });
    }
  });

  it('passes the server-resolved grant into the run context and audits it', async () => {
    const fixture = createFixture({
      verdict: allowedVerdict('user-7', 'project-a', ['scene:edit', 'scene:review'], 3),
    });
    let context: unknown;
    const result = await fixture.session.enqueueOperation({
      kind: 'edit',
      capabilityId: 'cap-1',
      scope: ['scene:edit'],
      payload: { note: 'not-a-secret-and-never-audited' },
      run: (ctx) => {
        context = ctx;
        return 'done';
      },
    });
    expect(result).toEqual({ status: 'completed', operationId: 'operation-1', result: 'done' });
    expect(context).toEqual({
      projectId: 'project-a',
      operationId: 'operation-1',
      actorId: 'user-7',
      capabilityVersion: 3,
      scopes: ['scene:edit', 'scene:review'],
    });
    expect(fixture.audit.records).toHaveLength(1);
    const record = fixture.audit.records[0] as SessionAuditRecord & { kind: string };
    expect(record).toMatchObject({
      outcome: 'completed',
      operationId: 'operation-1',
      capabilityId: 'cap-1',
      actorId: 'user-7',
      version: 3,
      kind: 'operation.edit.completed',
      scopes: ['scene:edit', 'scene:review'],
      projectId: 'project-a',
    });
    // Audit is secret-free: no payload, token, or digest ever appears.
    expect(record).not.toHaveProperty('payload');
    expect(record).not.toHaveProperty('token');
    expect(record).not.toHaveProperty('digest');
  });

  it('reports failed effects without blocking later operations', async () => {
    const fixture = createFixture();
    const boom = new Error('boom') as Error & { code: string };
    boom.code = 'TEST_BROKE';
    const first = await fixture.session.enqueueOperation({
      kind: 'render',
      capabilityId: 'cap-1',
      scope: ['scene:edit'],
      run: () => {
        throw boom;
      },
    });
    expect(first).toEqual({
      status: 'failed',
      operationId: 'operation-1',
      errorCode: 'TEST_BROKE',
      message: 'boom',
    });
    const second = await fixture.session.enqueueOperation({
      kind: 'query',
      capabilityId: 'cap-1',
      scope: ['scene:edit'],
      run: () => 'still works',
    });
    expect(second).toEqual({
      status: 'completed',
      operationId: 'operation-2',
      result: 'still works',
    });
    expect(fixture.audit.records.map((record) => record.outcome)).toEqual(['failed', 'completed']);
    expect(fixture.audit.records[0]).toMatchObject({
      outcome: 'failed',
      kind: 'operation.render.failed',
      detail: 'TEST_BROKE',
    });
    expect(fixture.session.busy).toBe(false);
  });

  it('reports busy only while work is queued or in flight', async () => {
    const { session } = createFixture();
    let release: (() => void) | undefined;
    const pending = new Promise<string>((resolve) => {
      release = () => resolve('done');
    });
    const result = session.enqueueOperation({
      kind: 'long',
      capabilityId: 'cap-1',
      scope: ['scene:edit'],
      run: () => pending,
    });
    expect(session.busy).toBe(true);
    if (release === undefined) throw new Error('operation release is missing');
    release();
    await expect(result).resolves.toMatchObject({ status: 'completed' });
    expect(session.busy).toBe(false);
  });
});

// ─── Detached (two-phase) operations ────────────────────────────────────────

describe('ProjectSession detached operations', () => {
  it('runs prepare/commit inside the lane and execute outside it without blocking authoring', async () => {
    const fixture = createFixture({ sourceHash: 'hash-a' });
    const { session } = fixture;
    const events: string[] = [];
    let releaseExecute: (() => void) | undefined;
    const executeGate = new Promise<void>((resolve) => {
      releaseExecute = () => resolve();
    });

    const detached = session.enqueueDetachedOperation({
      kind: 'render',
      capabilityId: 'cap-1',
      scope: ['scene:edit'],
      prepare: async () => {
        events.push('prepare');
        return { sourceHash: session.source?.sourceHash ?? null };
      },
      execute: async () => {
        events.push('execute-start');
        await executeGate;
        events.push('execute-end');
        return 'candidate';
      },
      commit: async () => {
        events.push('commit');
        return { status: 'completed', result: 'done' };
      },
    });

    // While the render's execute is pending, the authoring lane stays free:
    // a regular operation enqueued afterwards runs before the commit slot.
    const authoring = session.enqueueOperation({
      kind: 'edit',
      capabilityId: 'cap-1',
      scope: ['scene:edit'],
      run: () => {
        events.push('authoring');
        return 'ok';
      },
    });

    await flush();
    expect(events).toEqual(['prepare', 'execute-start', 'authoring']);
    await expect(authoring).resolves.toEqual({
      status: 'completed',
      operationId: 'operation-2',
      result: 'ok',
    });
    expect(events).toEqual(['prepare', 'execute-start', 'authoring']);
    expect(session.busy).toBe(true);

    if (releaseExecute === undefined) throw new Error('execute gate is missing');
    releaseExecute();
    await expect(detached).resolves.toEqual({
      status: 'completed',
      operationId: 'operation-1',
      result: 'done',
    });
    expect(events).toEqual(['prepare', 'execute-start', 'authoring', 'execute-end', 'commit']);
    expect(session.busy).toBe(false);
    // Prepare and commit each record their own capability-gated audit entry.
    expect(fixture.audit.records.map((record) => record.outcome)).toEqual([
      'completed',
      'completed',
      'completed',
    ]);
    const kinds = fixture.audit.records.map((record) => (record as { kind?: string }).kind);
    expect(kinds).toEqual([
      'operation.render.prepare.completed',
      'operation.edit.completed',
      'operation.render.commit.completed',
    ]);
  });

  it('returns stale without promoting when the source moved between prepare and commit', async () => {
    const fixture = createFixture({ sourceHash: 'hash-a' });
    const { session } = fixture;
    let releaseExecute: (() => void) | undefined;
    const executeGate = new Promise<void>((resolve) => {
      releaseExecute = () => resolve();
    });

    const detached = session.enqueueDetachedOperation({
      kind: 'render',
      capabilityId: 'cap-1',
      scope: ['scene:edit'],
      prepare: async () => ({ sourceHash: session.source?.sourceHash ?? null }),
      execute: async () => {
        await executeGate;
        return 'candidate';
      },
      commit: async (_context, capture) => {
        // The runner's identity re-check: the accepted source moved while the
        // render executed, so the candidate is archived and never promoted.
        if (session.source?.sourceHash !== capture.sourceHash) {
          return { status: 'stale', reason: 'SOURCE_MOVED: candidate archived.' };
        }
        return { status: 'completed', result: 'promoted' };
      },
    });

    // Adopt a newer source through the lane while the render executes.
    const adopt = session.enqueueOperation({
      kind: 'adopt',
      capabilityId: 'cap-1',
      scope: ['scene:edit'],
      run: () => {
        const adopted = session.adoptSourceWithinOperation(makeSnapshot('hash-b'));
        return adopted.status;
      },
    });
    await flush();
    if (releaseExecute === undefined) throw new Error('execute gate is missing');
    releaseExecute();

    await expect(adopt).resolves.toMatchObject({
      status: 'completed',
      result: 'accepted',
    });
    expect(session.source?.sourceHash).toBe('hash-b');
    await expect(detached).resolves.toEqual({
      status: 'stale',
      operationId: 'operation-1',
      reason: 'SOURCE_MOVED: candidate archived.',
    });
  });

  it('revokes the commit token on cancellation so a late result is never promoted', async () => {
    const fixture = createFixture({ sourceHash: 'hash-a' });
    const { session } = fixture;
    const controller = new AbortController();
    let commitCalled = false;

    const pending = session.enqueueDetachedOperation({
      kind: 'render',
      capabilityId: 'cap-1',
      scope: ['scene:edit'],
      signal: controller.signal,
      prepare: async () => ({ sourceHash: session.source?.sourceHash ?? null }),
      execute: async () => 'late-candidate',
      commit: async () => {
        commitCalled = true;
        return { status: 'completed', result: 'promoted' };
      },
    });
    // Abort before the commit slot runs: the execute result may still arrive
    // late, but the commit token is already revoked.
    controller.abort();

    await expect(pending).resolves.toEqual({
      status: 'cancelled',
      operationId: 'operation-1',
    });
    expect(commitCalled).toBe(false);
    expect(fixture.audit.records.map((record) => record.outcome)).toEqual(['completed']);
  });

  it('re-gates the commit phase when the grant is revoked mid-render', async () => {
    // The first gate call (prepare) is allowed; the second (commit) is revoked.
    let checks = 0;
    const fixture = createFixture({
      sourceHash: 'hash-a',
      capabilities: {
        checkGrant: async () => {
          checks += 1;
          return checks === 1
            ? allowedVerdict('user-1', 'project-a', ['scene:edit'])
            : { allowed: false, reason: 'REVOKED' };
        },
      },
    });
    const { session } = fixture;
    const events: string[] = [];

    const result = await session.enqueueDetachedOperation({
      kind: 'render',
      capabilityId: 'cap-a',
      scope: ['scene:edit'],
      prepare: async () => {
        events.push('prepare');
        return { sourceHash: session.source?.sourceHash ?? null };
      },
      execute: async () => {
        events.push('execute');
        return 'candidate';
      },
      commit: async () => {
        events.push('commit');
        return { status: 'completed', result: 'promoted' };
      },
    });

    // The commit phase runs its own fresh capability gate (cap-a is denied
    // on the second check) so the candidate is never promoted.
    expect(result).toEqual({ status: 'denied', operationId: 'operation-1', reason: 'REVOKED' });
    expect(events).toEqual(['prepare', 'execute']);
  });

  it('reports a failing prepare/execute as failed without running commit', async () => {
    const fixture = createFixture({ sourceHash: 'hash-a' });
    const { session } = fixture;
    let commitCalled = false;

    const result = await session.enqueueDetachedOperation({
      kind: 'render',
      capabilityId: 'cap-1',
      scope: ['scene:edit'],
      prepare: async () => {
        throw Object.assign(new Error('boom'), { code: 'PROVIDER_REQUIRED' });
      },
      execute: async () => 'candidate',
      commit: async () => {
        commitCalled = true;
        return { status: 'completed', result: 'promoted' };
      },
    });

    expect(result).toEqual({
      status: 'failed',
      operationId: 'operation-1',
      errorCode: 'PROVIDER_REQUIRED',
      message: 'boom',
    });
    expect(commitCalled).toBe(false);
  });
});

// ─── Presence immutability ───────────────────────────────────────────────────

describe('ProjectSession presence', () => {
  it('updates presence immutably and bumps the projection revision', () => {
    const { session } = createFixture({ sourceHash: 'hash-a' });
    const before = session.projection;
    const initialRevision = before.revision;

    const joined = session.updatePresence({
      kind: 'join',
      actorId: 'user-1',
      surface: 'browser',
      at: '2026-08-02T00:00:01.000Z',
    });
    expect(joined).not.toBe(before);
    expect(joined.revision).toBe(initialRevision + 1);
    expect(joined.presence).toEqual([
      { actorId: 'user-1', surface: 'browser', since: '2026-08-02T00:00:01.000Z' },
    ]);
    expect(Object.isFrozen(joined)).toBe(true);
    expect(session.projection).toBe(joined);

    // Rejoining the same actor+surface replaces `since` instead of duplicating.
    const rejoined = session.updatePresence({
      kind: 'join',
      actorId: 'user-1',
      surface: 'browser',
      at: '2026-08-02T00:00:02.000Z',
    });
    expect(rejoined.presence).toEqual([
      { actorId: 'user-1', surface: 'browser', since: '2026-08-02T00:00:02.000Z' },
    ]);
    expect(rejoined.presence).toHaveLength(1);

    const withAgent = session.updatePresence({
      kind: 'join',
      actorId: 'agent-9',
      surface: 'agent',
      at: '2026-08-02T00:00:03.000Z',
    });
    expect(withAgent.presence).toHaveLength(2);

    const left = session.updatePresence({
      kind: 'leave',
      actorId: 'user-1',
      surface: 'browser',
      at: '2026-08-02T00:00:04.000Z',
    });
    expect(left.presence).toEqual([
      { actorId: 'agent-9', surface: 'agent', since: '2026-08-02T00:00:03.000Z' },
    ]);

    // Leaving an absent entry is a no-op: same projection object, same revision.
    const noop = session.updatePresence({
      kind: 'leave',
      actorId: 'nobody',
      surface: 'browser',
      at: '2026-08-02T00:00:05.000Z',
    });
    expect(noop).toBe(left);
    expect(noop.revision).toBe(left.revision);

    // Earlier projections are untouched by later updates.
    expect(before.presence).toEqual([]);
    expect(before.revision).toBe(initialRevision);
  });

  it('advances a human-presence generation on human transitions only', () => {
    const { session } = createFixture();
    expect(session.presenceGeneration).toBe(0);

    // Agent presence is not human presence: no generation bump.
    session.updatePresence({
      kind: 'join',
      actorId: 'agent-9',
      surface: 'agent',
      at: '2026-08-02T00:00:01.000Z',
    });
    expect(session.presenceGeneration).toBe(0);

    // A human joining advances the generation...
    session.updatePresence({
      kind: 'join',
      actorId: 'human-1',
      surface: 'browser',
      at: '2026-08-02T00:00:02.000Z',
    });
    expect(session.presenceGeneration).toBe(1);
    expect(session.hasHumanPresence).toBe(true);

    // ...and so does a human leaving, even when another human remains.
    session.updatePresence({
      kind: 'join',
      actorId: 'human-2',
      surface: 'mcp',
      at: '2026-08-02T00:00:03.000Z',
    });
    session.updatePresence({
      kind: 'leave',
      actorId: 'human-1',
      surface: 'browser',
      at: '2026-08-02T00:00:04.000Z',
    });
    expect(session.presenceGeneration).toBe(3);
    expect(session.hasHumanPresence).toBe(true); // human-2 still present

    // Rejoining the same human surface is still a presence event of a human.
    session.updatePresence({
      kind: 'join',
      actorId: 'human-1',
      surface: 'browser',
      at: '2026-08-02T00:00:05.000Z',
    });
    expect(session.presenceGeneration).toBe(4);

    // Leaving an absent entry changes nothing: same generation, same revision.
    const before = session.presenceGeneration;
    session.updatePresence({
      kind: 'leave',
      actorId: 'nobody',
      surface: 'browser',
      at: '2026-08-02T00:00:06.000Z',
    });
    expect(session.presenceGeneration).toBe(before);
  });
});

// ─── Projection derivation (pure) ────────────────────────────────────────────

describe('deriveProjectSessionProjection', () => {
  const snapshot = makeSnapshot('hash-a', {
    errorDiagnostics: 1,
    warningDiagnostics: 2,
    documents: 1,
  });
  const status: ProjectStatusResult = {
    events: [
      { id: 'e1', narrativeOrder: 1, status: 'rendered', chapter: 1 },
      { id: 'e2', narrativeOrder: 2, status: 'pending', chapter: 1 },
    ],
    threads: [],
    summary: { totalEvents: 2, renderedCount: 1, blockedCount: 0 },
  };

  it('maps a compiled snapshot and status into the browser-safe projection', () => {
    const projection = deriveProjectSessionProjection(
      {
        projectId: 'p',
        revision: 5,
        snapshot,
        presence: [],
        generatedAt: '2026-08-02T00:00:00.000Z',
      },
      status,
    );
    expect(projection).toEqual({
      version: 1,
      projectId: 'p',
      revision: 5,
      sourceHash: 'hash-a',
      documents: 1,
      events: 2,
      rendered: 1,
      pending: 1,
      blocked: 0,
      errorCount: 1,
      warningCount: 2,
      diagnostics: expect.any(Array),
      presence: [],
      generatedAt: '2026-08-02T00:00:00.000Z',
    });
    expect(Object.isFrozen(projection)).toBe(true);
  });

  it('produces an empty projection before any accepted source', () => {
    const projection = deriveProjectSessionProjection(
      {
        projectId: 'p',
        revision: 0,
        snapshot: null,
        presence: [{ actorId: 'u', surface: 'browser', since: 't' }],
        generatedAt: 't',
      },
      null,
    );
    expect(projection.sourceHash).toBeNull();
    expect(projection.documents).toBe(0);
    expect(projection.events).toBe(0);
    expect(projection.presence).toEqual([{ actorId: 'u', surface: 'browser', since: 't' }]);
  });

  it('clamps an inconsistent pending count to zero', () => {
    const projection = deriveProjectSessionProjection(
      { projectId: 'p', revision: 1, snapshot, presence: [], generatedAt: 't' },
      {
        events: [],
        threads: [],
        summary: { totalEvents: 2, renderedCount: 5, blockedCount: 0 },
      },
    );
    expect(projection.pending).toBe(0);
  });

  it('fails closed when a snapshot is given without a status', () => {
    expect(() =>
      deriveProjectSessionProjection(
        { projectId: 'p', revision: 1, snapshot, presence: [], generatedAt: 't' },
        null,
      ),
    ).toThrow(TypeError);
  });
});

// ─── Fail-closed creation ────────────────────────────────────────────────────

describe('ProjectSession creation', () => {
  it('fails closed on malformed options', () => {
    const runtime = createProjectCoreRuntime({
      projectId: 'p',
      services: fakeServices(),
      compile: (snapshot) =>
        ({ events: snapshot.documents.length }) as unknown as ProjectCompilation,
    });
    const base: CreateProjectSessionOptions = {
      projectId: 'p',
      runtime,
      capabilities: fakeCapabilities(allowedVerdict('u', 'p', ['x'])),
      audit: recordingAudit().sink,
    };
    expect(() => createProjectSession({ ...base, projectId: '' })).toThrow(TypeError);
    expect(() =>
      createProjectSession({
        ...base,
        capabilities: {} as Pick<AgentCapabilityService, 'checkGrant'>,
      }),
    ).toThrow(TypeError);
    expect(() => createProjectSession({ ...base, audit: {} as SessionAuditSink })).toThrow(
      TypeError,
    );
    expect(() =>
      createProjectSession({ ...base, initialSource: makeSnapshot('bad', { parsed: false }) }),
    ).toThrow(TypeError);
    const brokenCompile = createProjectCoreRuntime({
      projectId: 'p',
      services: fakeServices(),
      compile: () => {
        throw new Error('nope');
      },
    });
    expect(() =>
      createProjectSession({
        ...base,
        runtime: brokenCompile,
        initialSource: makeSnapshot('h'),
      }),
    ).toThrow(TypeError);
  });

  it('fails closed when the injected runtime belongs to a different project', () => {
    const base: CreateProjectSessionOptions = {
      projectId: 'project-a',
      runtime: createProjectCoreRuntime({
        projectId: 'project-a',
        services: fakeServices(),
        compile: (snapshot) =>
          ({ events: snapshot.documents.length }) as unknown as ProjectCompilation,
      }),
      capabilities: fakeCapabilities(allowedVerdict('u', 'project-a', ['x'])),
      audit: recordingAudit().sink,
    };
    expect(() =>
      createProjectSession({
        ...base,
        runtime: createProjectCoreRuntime({
          projectId: 'project-b',
          services: fakeServices(),
          compile: (snapshot) =>
            ({ events: snapshot.documents.length }) as unknown as ProjectCompilation,
        }),
      }),
    ).toThrow(/does not match the injected runtime project "project-b"/);

    // A structurally complete runtime without any project id also fails closed.
    expect(() =>
      createProjectSession({
        ...base,
        runtime: {
          compile: (snapshot) =>
            ({ events: snapshot.documents.length }) as unknown as ProjectCompilation,
          services: fakeServices(),
        } as ProjectCoreRuntime,
      }),
    ).toThrow(TypeError);

    // The matching runtime project still constructs.
    expect(() => createProjectSession({ ...base })).not.toThrow();
  });

  it('opens with an initialSource as the first accepted revision', () => {
    const fixture = createFixture({ sourceHash: 'hash-init' });
    expect(fixture.session.source?.sourceHash).toBe('hash-init');
    expect(fixture.session.projection.revision).toBe(1);
  });
});

// ─── Browser-safe contract boundary ──────────────────────────────────────────

describe('contracts boundary', () => {
  it('exposes no runtime values from the browser-safe barrel', () => {
    // The barrel is type-only by construction: no host implementation (session,
    // runtime, capability service, persistence client) leaks at runtime.
    expect(Object.keys(contracts)).toEqual([]);
  });

  it('resolves session projection DTO types through the barrel only', () => {
    const projection: ContractsProjectionV1 = {
      version: 1,
      projectId: 'p',
      revision: 1,
      sourceHash: 'h',
      documents: 0,
      events: 0,
      rendered: 0,
      pending: 0,
      blocked: 0,
      errorCount: 0,
      warningCount: 0,
      diagnostics: [],
      presence: [],
      generatedAt: 't',
    };
    expect(projection.projectId).toBe('p');
    // Raw snapshots (parsed author content) and host handles never cross.
    expect((contracts as Record<string, unknown>).ProjectSourceSnapshotV1).toBeUndefined();
    expect((contracts as Record<string, unknown>).createProjectSession).toBeUndefined();
  });
});
