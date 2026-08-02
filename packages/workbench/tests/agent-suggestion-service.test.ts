import { createHash } from 'node:crypto';
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
import {
  type AgentCapabilityFailureCode,
  AgentCapabilityService,
  type AgentDocumentPort,
  type AgentPresencePort,
  createAgentCommandService,
  createAgentSuggestionService,
  createCapabilityPersistence,
  type AgentSuggestionChangeV1,
  type AgentSuggestionResult,
  type AgentSuggestionService,
  type AgentSuggestionInput,
  type AgentSuggestionV1,
  type AgentTaskProvider,
  type AgentTextSelectionV1,
  AgentSuggestionInputError,
  AgentTaskService,
  parseSuggestionChanges,
  suggestionHashOf,
  validateSuggestionChanges,
} from '../src/host/agent/index.js';
import type { CompletionRequest, CompletionResponse } from '@novalistically/core';
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
 * Deterministic in-memory document port mirroring the Yjs adapter contract:
 * the state vector is the utf8 encoding of the current content and mutations
 * are guarded by a state-vector compare-and-swap plus the shared
 * human-presence generation, exactly like the real adapter.
 */
class FakeDocumentPort implements AgentDocumentPort {
  readonly contents = new Map<string, string>();
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
    const current = this.contents.get(input.documentId);
    const live = current === undefined ? '' : current;
    const liveVector = FakeDocumentPort.vectorOf(live);
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
    const current = this.contents.get(input.documentId);
    const live = current === undefined ? '' : current;
    const liveVector = FakeDocumentPort.vectorOf(live);
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

class FakeTaskProvider implements AgentTaskProvider {
  readonly name = 'fake-provider';
  calls = 0;

  constructor(private readonly next: () => CompletionResponse | Error) {}

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.calls += 1;
    const result = this.next();
    if (result instanceof Error) throw result;
    return result;
  }
}

const DEFAULT_DIFF_RESPONSE = '[{"from":0,"length":8,"text":"edited"}]';

function diffResponse(content = DEFAULT_DIFF_RESPONSE): CompletionResponse {
  return {
    id: 'resp-1',
    model: 'fake-model',
    content,
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    finishReason: 'stop',
  };
}

interface Fixture {
  harness: RealPersistenceHarness;
  capabilityService: AgentCapabilityService;
  session: ProjectSession;
  audit: ReturnType<typeof recordingAudit>;
  documents: FakeDocumentPort;
  provider: FakeTaskProvider;
  suggestions: AgentSuggestionService;
  now: string;
}

interface FixtureOptions {
  readonly projectId?: string;
  readonly presence?: AgentPresencePort;
  readonly initialDocuments?: Record<string, string>;
  readonly providerResult?: () => CompletionResponse | Error;
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
  const documents = new FakeDocumentPort(
    options.initialDocuments ?? { 'doc-1': 'original prose' },
    () => session.presenceGeneration,
  );
  let effectSequence = 0;
  const command = createAgentCommandService({
    session,
    documents,
    presence: options.presence,
    newEffectId: () => `fx-${++effectSequence}`,
  });
  const provider = new FakeTaskProvider(
    options.providerResult ?? (() => diffResponse()),
  );
  const tasks = new AgentTaskService({ provider });
  const suggestions = createAgentSuggestionService({
    documents,
    tasks,
    command,
    presence: { isHumanEditing: () => session.hasHumanPresence },
    newSuggestionId: () => 'sg-1',
  });
  return {
    harness,
    capabilityService,
    session,
    audit,
    documents,
    provider,
    suggestions,
    now,
  };
}

function issueCapability(capabilityService: AgentCapabilityService, projectId = 'project-a') {
  return capabilityService.issue({ userId: 'agent-1', projectId, scopes: ['edit:prose'] });
}

function makeGenerateInput(options: {
  readonly documentText?: string;
  readonly baseVector?: Uint8Array;
  readonly selection?: AgentTextSelectionV1;
  readonly instruction?: string;
} = {}): AgentSuggestionInput {
  const documentText = options.documentText ?? 'original prose';
  return {
    projectId: 'project-a',
    documentId: 'doc-1',
    documentText,
    baseVector: options.baseVector ?? FakeDocumentPort.vectorOf(documentText),
    selection: options.selection ?? { from: 0, to: 6 },
    instruction: options.instruction ?? 'tighten the opening',
  };
}

function expectProposal(
  result: AgentSuggestionResult,
): Extract<AgentSuggestionResult, { status: 'proposal' }> {
  expect(result.status).toBe('proposal');
  return result as Extract<AgentSuggestionResult, { status: 'proposal' }>;
}

function expectDenied(
  result: { status: string },
  reason: AgentCapabilityFailureCode,
): void {
  expect(result).toEqual({ status: 'denied', reason });
}

/** Applies the strict changes to the base text, mirroring the materializer contract. */
function applyChanges(baseText: string, changes: readonly AgentSuggestionChangeV1[]): string {
  let out = '';
  let cursor = 0;
  for (const change of changes) {
    out += baseText.slice(cursor, change.from);
    out += change.text;
    cursor = change.from + change.length;
  }
  out += baseText.slice(cursor);
  return out;
}

const materialize = (input: {
  readonly baseText: string;
  readonly changes: readonly AgentSuggestionChangeV1[];
}): Uint8Array =>
  textEncoder.encode(JSON.stringify({ content: applyChanges(input.baseText, input.changes) }));

// ─── Generation: proposal-only ───────────────────────────────────────────────

describe('AgentSuggestionService generation', () => {
  it('returns a revision-bound proposal without mutating any document state', async () => {
    const fixture = createFixture();
    activeHarness = fixture.harness;
    const result = expectProposal(await fixture.suggestions.generate(makeGenerateInput()));
    const suggestion = result.suggestion;
    expect(suggestion).toMatchObject({
      version: 1,
      suggestionId: 'sg-1',
      projectId: 'project-a',
      documentId: 'doc-1',
      selection: { from: 0, to: 6 },
      changes: [{ from: 0, length: 8, text: 'edited' }],
    });
    expect(suggestion.baseVector).toEqual(FakeDocumentPort.vectorOf('original prose'));
    expect(suggestion.baseTextHash).toMatch(/^[0-9a-f]{64}$/);
    expect(suggestion.baseTextHash).toBe(
      createHash('sha256').update('original prose', 'utf8').digest('hex'),
    );
    expect(suggestionHashOf(suggestion)).toBe(suggestion.suggestionHash);
    // The working document and accepted projection are untouched by generation.
    expect(fixture.documents.contentOf('doc-1')).toBe('original prose');
    expect(fixture.session.projection.sourceHash).toBeNull();
    expect(fixture.provider.calls).toBe(1);
    expect(fixture.audit.records).toHaveLength(0); // proposals are not audited effects
  });

  it('pauses on human presence before any provider call', async () => {
    const fixture = createFixture();
    activeHarness = fixture.harness;
    fixture.session.updatePresence({
      kind: 'join',
      actorId: 'human-1',
      surface: 'browser',
      at: fixture.now,
    });
    const result = await fixture.suggestions.generate(makeGenerateInput());
    expect(result).toEqual({
      status: 'paused',
      reason: 'human-presence',
      projectId: 'project-a',
      documentId: 'doc-1',
      liveStateVector: FakeDocumentPort.vectorOf('original prose'),
      replanRequired: true,
    });
    expect(fixture.provider.calls).toBe(0);
    expect(fixture.documents.contentOf('doc-1')).toBe('original prose');
  });

  it('reports a stale vector with the live vector when the document moved', async () => {
    const fixture = createFixture();
    activeHarness = fixture.harness;
    fixture.documents.write('doc-1', 'someone else wrote this');
    const result = await fixture.suggestions.generate(makeGenerateInput());
    expect(result).toEqual({
      status: 'stale',
      reason: 'stale-vector',
      projectId: 'project-a',
      documentId: 'doc-1',
      liveStateVector: FakeDocumentPort.vectorOf('someone else wrote this'),
    });
    expect(fixture.provider.calls).toBe(0);
  });

  it('fails typed when the document text exceeds the cap or instruction is too long', async () => {
    const fixture = createFixture({ providerResult: () => diffResponse() });
    activeHarness = fixture.harness;
    const oversized = 'x'.repeat(70_000);
    const tooBig = await fixture.suggestions.generate(
      makeGenerateInput({
        documentText: oversized,
        baseVector: FakeDocumentPort.vectorOf(oversized),
      }),
    );
    expect(tooBig).toMatchObject({
      status: 'failed',
      errorCode: 'agent.suggestion.input-too-large',
    });
    const tooLongInstruction = await fixture.suggestions.generate(
      makeGenerateInput({ instruction: 'y'.repeat(5_000) }),
    );
    expect(tooLongInstruction).toMatchObject({
      status: 'failed',
      errorCode: 'agent.suggestion.instruction-too-long',
    });
    expect(fixture.provider.calls).toBe(0);
  });

  it('treats an unparseable or out-of-bounds response as a typed invalid-response', async () => {
    let content = 'prose, not JSON';
    const fixture = createFixture({ providerResult: () => diffResponse(content) });
    activeHarness = fixture.harness;
    const unparseable = await fixture.suggestions.generate(makeGenerateInput());
    expect(unparseable).toMatchObject({
      status: 'failed',
      errorCode: 'agent.suggestion.invalid-response',
    });

    content = '[{"from":0,"length":99,"text":"x"}]';
    const result = await fixture.suggestions.generate(makeGenerateInput());
    expect(result).toMatchObject({
      status: 'failed',
      errorCode: 'agent.suggestion.invalid-response',
    });
    expect(fixture.documents.contentOf('doc-1')).toBe('original prose');
  });

  it('propagates a provider failure as a typed failed result', async () => {
    const error = new Error('provider exploded');
    (error as { code?: string }).code = 'E_RATE_LIMIT';
    const fixture = createFixture({ providerResult: () => error });
    activeHarness = fixture.harness;
    const result = await fixture.suggestions.generate(makeGenerateInput());
    expect(result).toMatchObject({ status: 'failed', errorCode: 'E_RATE_LIMIT' });
  });

  it('rejects unknown fields and invalid selections before any provider call', async () => {
    const fixture = createFixture();
    activeHarness = fixture.harness;
    await expect(
      fixture.suggestions.generate({
        ...makeGenerateInput(),
        token: 'fc_secret',
      } as unknown as AgentSuggestionInput),
    ).rejects.toThrow(AgentSuggestionInputError);
    await expect(
      fixture.suggestions.generate(makeGenerateInput({ selection: { from: 10, to: 4 } })),
    ).rejects.toThrow(AgentSuggestionInputError);
    await expect(
      fixture.suggestions.generate(
        makeGenerateInput({ selection: { from: 0, to: 999 } }),
      ),
    ).rejects.toThrow(AgentSuggestionInputError);
    expect(fixture.provider.calls).toBe(0);
  });
});

// ─── Strict diff parsing ─────────────────────────────────────────────────────

describe('parseSuggestionChanges', () => {
  it('parses a plain JSON array of strict changes', () => {
    expect(parseSuggestionChanges('[{"from":0,"length":3,"text":"hi"}]')).toEqual([
      { from: 0, length: 3, text: 'hi' },
    ]);
  });

  it('parses a fenced json block', () => {
    const fenced = '```json\n[{"from":2,"length":0,"text":"!"}]\n```';
    expect(parseSuggestionChanges(fenced)).toEqual([{ from: 2, length: 0, text: '!' }]);
  });

  it('accepts adjacent non-overlapping edits in ascending order', () => {
    const text = '[{"from":0,"length":2,"text":"a"},{"from":2,"length":1,"text":"b"}]';
    expect(parseSuggestionChanges(text)).toEqual([
      { from: 0, length: 2, text: 'a' },
      { from: 2, length: 1, text: 'b' },
    ]);
  });

  it('rejects empty, non-array, and malformed inputs', () => {
    expect(parseSuggestionChanges('')).toBeNull();
    expect(parseSuggestionChanges('   ')).toBeNull();
    expect(parseSuggestionChanges('[]')).toBeNull();
    expect(parseSuggestionChanges('{"from":0}')).toBeNull();
    expect(parseSuggestionChanges('not json at all')).toBeNull();
    expect(parseSuggestionChanges('[{"from":0,"length":1,"text":"a"}, 42]')).toBeNull();
  });

  it('rejects unknown fields, bad value types, and negative offsets', () => {
    expect(parseSuggestionChanges('[{"from":0,"length":1,"text":"a","secret":"x"}]')).toBeNull();
    expect(parseSuggestionChanges('[{"from":"0","length":1,"text":"a"}]')).toBeNull();
    expect(parseSuggestionChanges('[{"from":-1,"length":1,"text":"a"}]')).toBeNull();
    expect(parseSuggestionChanges('[{"from":0,"length":1.5,"text":"a"}]')).toBeNull();
    expect(parseSuggestionChanges('[{"from":0,"length":1,"text":42}]')).toBeNull();
  });

  it('rejects unsorted, duplicate-offset, and overlapping edits', () => {
    const unsorted =
      '[{"from":5,"length":1,"text":"a"},{"from":0,"length":1,"text":"b"}]';
    expect(parseSuggestionChanges(unsorted)).toBeNull();
    const duplicate =
      '[{"from":0,"length":1,"text":"a"},{"from":0,"length":1,"text":"b"}]';
    expect(parseSuggestionChanges(duplicate)).toBeNull();
    const overlapping =
      '[{"from":0,"length":5,"text":"a"},{"from":3,"length":1,"text":"b"}]';
    expect(parseSuggestionChanges(overlapping)).toBeNull();
  });

  it('enforces the per-change text cap and the change count cap', () => {
    const longText = `[{"from":0,"length":1,"text":"${'z'.repeat(9_000)}"}]`;
    expect(parseSuggestionChanges(longText)).toBeNull();
    const many = `[${Array.from({ length: 300 }, (_, i) =>
      `{"from":${i},"length":0,"text":"x"}`,
    ).join(',')}]`;
    expect(parseSuggestionChanges(many)).toBeNull();
    expect(
      parseSuggestionChanges(
        `[${Array.from({ length: 3 }, (_, i) => `{"from":${i},"length":0,"text":"x"}`).join(',')}]`,
        { maxChanges: 2 },
      ),
    ).toBeNull();
  });
});

describe('validateSuggestionChanges', () => {
  it('accepts in-bounds spans including a terminal insert', () => {
    expect(
      validateSuggestionChanges(
        [
          { from: 0, length: 3, text: 'a' },
          { from: 5, length: 0, text: '!' },
        ],
        5,
      ),
    ).toBe(true);
  });

  it('rejects spans beyond the document length', () => {
    expect(validateSuggestionChanges([{ from: 0, length: 6, text: 'a' }], 5)).toBe(false);
    expect(validateSuggestionChanges([{ from: 6, length: 0, text: 'a' }], 5)).toBe(false);
  });
});

// ─── Apply: explicit, safety-gated ───────────────────────────────────────────

describe('AgentSuggestionService applySuggestion', () => {
  it('applies a proposal through the AgentCommandService when the human confirms', async () => {
    const fixture = createFixture();
    activeHarness = fixture.harness;
    const { grant } = await issueCapability(fixture.capabilityService);
    const { suggestion } = expectProposal(await fixture.suggestions.generate(makeGenerateInput()));

    const result = await fixture.suggestions.applySuggestion({
      suggestion,
      documentText: 'original prose',
      capabilityId: grant.capabilityId,
      scope: ['edit:prose'],
      materialize,
    });
    expect(result).toMatchObject({
      status: 'applied',
      effectId: 'fx-1',
      projectId: 'project-a',
      documentId: 'doc-1',
    });
    expect(result.status === 'applied' && textDecoder.decode(result.update)).toBe('edited prose');
    expect(fixture.documents.contentOf('doc-1')).toBe('edited prose');
    expect(fixture.audit.records).toHaveLength(1);
    expect(fixture.audit.records[0]).toMatchObject({
      outcome: 'completed',
      kind: 'operation.edit.apply.completed',
      capabilityId: grant.capabilityId,
    });
  });

  it('rejects a tampered proposal via the suggestion-hash integrity binding', async () => {
    const fixture = createFixture();
    activeHarness = fixture.harness;
    const { grant } = await issueCapability(fixture.capabilityService);
    const { suggestion } = expectProposal(await fixture.suggestions.generate(makeGenerateInput()));
    const tampered: AgentSuggestionV1 = {
      ...suggestion,
      changes: [{ from: 1, length: 2, text: 'xx' }],
    };
    const result = await fixture.suggestions.applySuggestion({
      suggestion: tampered,
      documentText: 'original prose',
      capabilityId: grant.capabilityId,
      scope: ['edit:prose'],
      materialize,
    });
    expect(result).toMatchObject({
      status: 'failed',
      errorCode: 'agent.suggestion.integrity-mismatch',
    });
    expect(fixture.documents.contentOf('doc-1')).toBe('original prose');
  });

  it('rejects a proposal applied against different base text (hash mismatch)', async () => {
    const fixture = createFixture();
    activeHarness = fixture.harness;
    const { grant } = await issueCapability(fixture.capabilityService);
    const { suggestion } = expectProposal(await fixture.suggestions.generate(makeGenerateInput()));
    const result = await fixture.suggestions.applySuggestion({
      suggestion,
      documentText: 'different text entirely',
      capabilityId: grant.capabilityId,
      scope: ['edit:prose'],
      materialize,
    });
    expect(result).toMatchObject({
      status: 'failed',
      errorCode: 'agent.suggestion.base-text-mismatch',
    });
    expect(fixture.documents.contentOf('doc-1')).toBe('original prose');
  });

  it('rejects a hand-built suggestion whose changes fall outside its base text', async () => {
    const fixture = createFixture();
    activeHarness = fixture.harness;
    const { grant } = await issueCapability(fixture.capabilityService);
    // A correctly hashed but out-of-bounds proposal (e.g. a buggy adapter or
    // hand-rolled suggestion) must never apply: the change span exceeds the
    // base text the hash binds it to.
    const baseText = 'abc';
    const baseVector = FakeDocumentPort.vectorOf(baseText);
    const baseTextHash = createHash('sha256').update(baseText, 'utf8').digest('hex');
    const changes: AgentSuggestionChangeV1[] = [{ from: 0, length: 10, text: 'x' }];
    const suggestion: AgentSuggestionV1 = {
      version: 1,
      suggestionId: 'manual-1',
      projectId: 'project-a',
      documentId: 'doc-1',
      baseVector,
      baseTextHash,
      selection: { from: 0, to: 1 },
      changes,
      generatedAt: '2026-08-02T00:00:00.000Z',
      suggestionHash: suggestionHashOf({
        suggestionId: 'manual-1',
        projectId: 'project-a',
        documentId: 'doc-1',
        baseVector,
        baseTextHash,
        selection: { from: 0, to: 1 },
        changes,
      }),
    };
    const result = await fixture.suggestions.applySuggestion({
      suggestion,
      documentText: baseText,
      capabilityId: grant.capabilityId,
      scope: ['edit:prose'],
      materialize,
    });
    expect(result).toMatchObject({
      status: 'failed',
      errorCode: 'agent.suggestion.invalid-changes',
    });
    expect(fixture.documents.contentOf('doc-1')).toBe('original prose');
  });

  it('keeps human pause and stale-vector as typed outcomes at apply time', async () => {
    const fixture = createFixture();
    activeHarness = fixture.harness;
    const { grant } = await issueCapability(fixture.capabilityService);
    const { suggestion } = expectProposal(await fixture.suggestions.generate(makeGenerateInput()));

    // A human starts typing between proposal and apply → typed paused, nothing applied.
    fixture.session.updatePresence({
      kind: 'join',
      actorId: 'human-1',
      surface: 'browser',
      at: fixture.now,
    });
    const paused = await fixture.suggestions.applySuggestion({
      suggestion,
      documentText: 'original prose',
      capabilityId: grant.capabilityId,
      scope: ['edit:prose'],
      materialize,
    });
    expect(paused).toMatchObject({
      status: 'paused',
      reason: 'human-presence',
      replanRequired: true,
    });
    expect(fixture.documents.contentOf('doc-1')).toBe('original prose');

    // The human leaves, then another writer moves the vector → typed conflict.
    fixture.session.updatePresence({
      kind: 'leave',
      actorId: 'human-1',
      surface: 'browser',
      at: fixture.now,
    });
    fixture.documents.write('doc-1', 'someone else wrote this');
    const conflicted = await fixture.suggestions.applySuggestion({
      suggestion,
      documentText: 'original prose',
      capabilityId: grant.capabilityId,
      scope: ['edit:prose'],
      materialize,
    });
    expect(conflicted).toEqual({
      status: 'conflict',
      reason: 'stale-vector',
      projectId: 'project-a',
      documentId: 'doc-1',
      liveStateVector: FakeDocumentPort.vectorOf('someone else wrote this'),
    });
    expect(fixture.documents.contentOf('doc-1')).toBe('someone else wrote this');
  });

  it('denies the apply when the capability was revoked before it', async () => {
    const fixture = createFixture();
    activeHarness = fixture.harness;
    const { grant } = await issueCapability(fixture.capabilityService);
    const { suggestion } = expectProposal(await fixture.suggestions.generate(makeGenerateInput()));
    await fixture.capabilityService.revoke(grant.capabilityId, 'owner decision');
    const result = await fixture.suggestions.applySuggestion({
      suggestion,
      documentText: 'original prose',
      capabilityId: grant.capabilityId,
      scope: ['edit:prose'],
      materialize,
    });
    expectDenied(result, 'REVOKED');
    expect(fixture.documents.contentOf('doc-1')).toBe('original prose');
  });

  it('rejects malformed apply input including a missing materializer', async () => {
    const fixture = createFixture();
    activeHarness = fixture.harness;
    const { grant } = await issueCapability(fixture.capabilityService);
    const { suggestion } = expectProposal(await fixture.suggestions.generate(makeGenerateInput()));
    await expect(
      fixture.suggestions.applySuggestion({
        suggestion,
        documentText: 'original prose',
        capabilityId: grant.capabilityId,
        scope: ['edit:prose'],
        materialize: undefined as never,
      }),
    ).rejects.toThrow(AgentSuggestionInputError);
    await expect(
      fixture.suggestions.applySuggestion({
        suggestion,
        documentText: 'original prose',
        capabilityId: grant.capabilityId,
        scope: ['edit:prose'],
        materialize,
        token: 'fc_secret',
      } as never),
    ).rejects.toThrow(AgentSuggestionInputError);
  });
});
