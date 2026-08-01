// ============================================================================
// Editorial Product-Boundary Tests
//
// Approved flows (MemoryStorage only, no LLM/filesystem/network):
//   1. Same operation request is terminal-idempotent with zero provider
//   2. Different request with same operation ID returns different result
//   3. Abort signal cancels an operation
//   4. DTO round-trip: EditorialRenderRequestV1 → JSON → parsed
//   5. Progress event JSON round-trip
//   6. Preview twice → deep-equal, zero storage writes, zero provider calls
// ============================================================================

import * as crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  Clock,
  EditorialError,
  EditorialOperationV1,
  EditorialProgressEventV1,
  EditorialRenderRequestV1,
  EditorialRuntime,
  LLMProvider,
  ProjectPaths,
  RenderNovelResult,
} from '../../src/index.ts';
import {
  EditorialOperationError,
  editorialMutationContextSchema,
  editorialPreviewRequestV1Schema,
  editorialProgressEventV1Schema,
  editorialRenderRequestV1Schema,
  MemoryStorage,
  OperationStore,
  ProjectTransactionCoordinator,
  previewEditorialRun,
  renderNovel,
  resolveProjectPaths,
  TypedEventBus,
} from '../../src/index.ts';

// ============================================================================
// Fake clock — deterministic time progression
// ============================================================================

class FakeClock implements Clock {
  private _now: number;
  constructor(base: number) {
    this._now = base;
  }
  now(): number {
    return this._now;
  }
  advance(ms: number): void {
    this._now += ms;
  }
}

// ============================================================================
function setupMinimalProject(storage: MemoryStorage): void {
  storage.mkdirp('/test-project/definitions');
  storage.mkdirp('/test-project/chapters/chapter_01');
  storage.mkdirp('/test-project/.nova/work/responses');
  storage.write(
    '/test-project/nova.yaml',
    'project: test-project\ntitle: Test Project\nauthor: Tester\n',
  );
  storage.write(
    '/test-project/definitions/state_initial.yaml',
    'info:\n  currentEra: modern\n  politicalSituation: stable\nthreads: []\nworldFacts: []\n',
  );
  storage.write(
    '/test-project/definitions/entity-types.yaml',
    [
      'types:',
      '  character:',
      '    typeId: character',
      '    kind: character',
      '    attributes:',
      '      lifecycle:',
      '        attributeId: lifecycle',
      '        valueType: string',
      '        requiredAt: introduction',
      '        writePolicy: lifecycle_managed',
      '        allowedLifecycleStates: [active, inactive, retired]',
      '        unsetAllowed: false',
      '        semanticRole: lifecycle',
      '      traits:',
      '        attributeId: traits',
      '        valueType: string_list',
      '        requiredAt: never',
      '        writePolicy: immutable',
      '        unsetAllowed: true',
      '    lifecyclePolicy:',
      '      allowedTransitions:',
      '        - [active, inactive]',
      '        - [active, retired]',
      '        - [inactive, active]',
      '        - [inactive, retired]',
      '    referenceCapabilities:',
      '      defaultEligibility: live',
      '    typedInvariants: []',
    ].join('\n'),
  );
  // POV participant — declared so the baseline activation makes it live
  // before the event replay (validateParticipants requires live participants).
  storage.write(
    '/test-project/definitions/characters/narrator.yaml',
    [
      'id: narrator',
      'name: Narrator',
      'type: person',
      'description: "The story narrator"',
      'initialState: {}',
      'traits: []',
    ].join('\n'),
  );
  storage.write(
    '/test-project/chapters/chapter_01/_chapter.yaml',
    'chapter: 1\ntitle: Chapter 1\nsummary: First chapter\nintent: Setup\nplannedScenes: 1\n',
  );
  // discourse-ledger.yaml (mandatory reader-order source)
  storage.write(
    '/test-project/definitions/discourse-ledger.yaml',
    [
      'id: test-project-ledger',
      'chapters:',
      '  - branch: main',
      '    chapter: 1',
      '    sceneIds:',
      '      - E001',
      'entries: []',
    ].join('\n'),
  );
  // Minimal event file so ledger sceneId matches
  storage.write(
    '/test-project/chapters/chapter_01/E001.yaml',
    [
      'event: E001',
      'narrativeOrder: 1',
      'title: "Minimal Event"',
      'storyTime: "day 1"',
      'sceneBrief: "Test"',
      'beats:',
      '  - "Test"',
      'pov:',
      '  character: narrator',
      '  type: third_person_limited',
      'preconditions: []',
      'expectedPostconditions: []',
    ].join('\n'),
  );
}
// ============================================================================

const BASE_TIME = Date.parse('2026-07-28T00:00:00.000Z');

function makeRequest(overrides?: Partial<EditorialRenderRequestV1>): EditorialRenderRequestV1 {
  return {
    version: 1,
    projectDir: '/test-project',
    selector: { type: 'all' },
    mutation: {
      operationId: crypto.randomUUID(),
      actorId: 'test-actor',
    },
    model: 'test-model',
    ...overrides,
  };
}

function makeRuntime(overrides?: Partial<EditorialRuntime>): EditorialRuntime {
  return {
    storage: new MemoryStorage(),
    ...overrides,
  };
}

function makePreviewRequest(): Omit<EditorialRenderRequestV1, 'mutation'> {
  return {
    version: 1,
    projectDir: '/test-project',
    selector: { type: 'all' },
    model: 'test-model',
  };
}

describe('Editorial product-boundary', () => {
  // ── Flow 1: Same operation request terminal-idempotent, zero provider ──
  // When no model/config provides an LLM and no events need provider,
  // the render should succeed with an empty result.
  it('succeeds with empty result when no provider and no events need rendering', async () => {
    const storage = new MemoryStorage();
    setupMinimalProject(storage);
    const request = makeRequest({ model: undefined });
    const runtime = makeRuntime({ storage });

    const result = await renderNovel(request, runtime);
    expect(result.operationId).toBe(request.mutation!.operationId);
    expect(result.results).toEqual([]);
    expect(result.editorialErrors).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('same request is idempotent after terminal completion', async () => {
    const storage = new MemoryStorage();
    setupMinimalProject(storage);
    const request = makeRequest({ model: undefined });
    const runtime = makeRuntime({ storage });

    const result1 = await renderNovel(request, runtime);
    expect(result1.operationId).toBe(request.mutation!.operationId);
    expect(result1.results).toEqual([]);
    expect(result1.editorialErrors).toEqual([]);

    // Second call with identical request — operation already terminal,
    // should return idempotently (same operationId, same result)
    const result2 = await renderNovel(request, runtime);
    expect(result2.operationId).toBe(result1.operationId);
    expect(result2.results).toEqual(result1.results);
    expect(result2.editorialErrors).toEqual(result1.editorialErrors);
  });

  // ── Flow 2: Different request with same operation ID is rejected ──
  // When the same operationId is used with a different request (different
  // model/planHash), the store rejects it with INVALID_OPERATION because
  // the operation is already terminal with a different request.
  it('rejects different request with same operationId as INVALID_OPERATION', async () => {
    const storage = new MemoryStorage();
    setupMinimalProject(storage);

    const opId = crypto.randomUUID();
    const request1 = makeRequest({
      projectDir: '/test-project',
      mutation: { operationId: opId, actorId: 'test-actor' },
      model: undefined,
    });
    const request2 = makeRequest({
      projectDir: '/test-project',
      mutation: { operationId: opId, actorId: 'test-actor' },
      model: 'different-model',
    });
    const runtime = makeRuntime({ storage });

    // First call — empty catalog, succeeds with zero results
    const result1 = await renderNovel(request1, runtime);
    expect(result1.operationId).toBe(opId);
    expect(result1.editorialErrors).toEqual([]);

    // Second call with same opId but different model/planHash
    // The operation is terminal with a different requestHash → INVALID_OPERATION
    const result2 = await renderNovel(request2, runtime);
    expect(result2.operationId).toBe(opId);
    expect(result2.editorialErrors).toHaveLength(1);
    expect(result2.editorialErrors[0].code).toBe('INVALID_OPERATION');
    expect(result2.results).toEqual([]);
  });

  // ── Flow 3: Abort signal cancels ──
  it('abort signal immediately cancels the operation', async () => {
    const storage = new MemoryStorage();
    setupMinimalProject(storage);

    const abortController = new AbortController();
    const request = makeRequest({ projectDir: '/test-project' });
    const runtime = makeRuntime({ storage, signal: abortController.signal });

    // Cancel before execution
    abortController.abort();

    const result = await renderNovel(request, runtime);
    expect(result.editorialErrors).toHaveLength(1);
    expect(result.editorialErrors[0].code).toBe('OPERATION_CANCELLED');
    expect(result.results).toEqual([]);
    expect(result.operationId).toBe(request.mutation!.operationId);
  });

  // ── Flow 4: DTO JSON round-trip ──
  it('EditorialRenderRequestV1 JSON round-trips through schema', () => {
    const request: EditorialRenderRequestV1 = {
      version: 1,
      projectDir: '/projects/test',
      selector: { type: 'events', eventIds: ['E001', 'E002'] },
      mutation: {
        operationId: '550e8400-e29b-41d4-a716-446655440000',
        actorId: 'author-1',
      },
      model: 'deepseek-v4',
      providerProfile: 'fast',
      branchPath: { decisions: [{ atEventId: 'E001', choiceId: 'a', narrativeOrder: 1 }] },
      discourseBranch: 'main',
      waivers: [
        {
          gateId: 'gate-1',
          signedBy: 'reviewer',
          signedAt: '2026-07-28T00:00:00.000Z',
          reason: 'Allow minor continuity issues',
        },
      ],
      maxRounds: 3,
    };

    const json = JSON.stringify(request);
    const parsed = JSON.parse(json);
    const validated = editorialRenderRequestV1Schema.parse(parsed);

    expect(validated.version).toBe(1);
    expect(validated.projectDir).toBe('/projects/test');
    expect(validated.mutation.actorId).toBe('author-1');
    expect(validated.model).toBe('deepseek-v4');
    expect(validated.branchPath).toEqual({
      decisions: [{ atEventId: 'E001', choiceId: 'a', narrativeOrder: 1 }],
    });
    expect(validated.waivers![0].gateId).toBe('gate-1');

    // Full round-trip: serialize validated back to JSON
    const roundTrip = JSON.parse(JSON.stringify(validated));
    expect(roundTrip.projectDir).toBe('/projects/test');
  });

  // ── Flow 5: Progress event JSON round-trip ──
  it('EditorialProgressEventV1 JSON round-trips through schema', () => {
    const progress: EditorialProgressEventV1 = {
      version: 1,
      sequence: 42,
      timestamp: '2026-07-28T12:00:00.000Z',
      kind: 'scene_promoted',
      operationId: '550e8400-e29b-41d4-a716-446655440000',
      eventId: 'E001',
      phase: 'promotion',
      disposition: 'candidate_promoted',
      completedScenes: 5,
      totalScenes: 10,
    };

    const json = JSON.stringify(progress);
    const parsed = JSON.parse(json);
    const validated = editorialProgressEventV1Schema.parse(parsed);

    expect(validated.version).toBe(1);
    expect(validated.sequence).toBe(42);
    expect(validated.kind).toBe('scene_promoted');
    expect(validated.eventId).toBe('E001');
    expect(validated.disposition).toBe('candidate_promoted');
    expect(validated.completedScenes).toBe(5);
    expect(validated.totalScenes).toBe(10);

    // Round-trip: serialize back and verify equivalence
    const roundTrip = JSON.parse(JSON.stringify(validated));
    expect(roundTrip).toEqual(parsed);
  });

  // ── Schema Validation ──────────────────────────────────────────────────
  describe('schema validation', () => {
    it('editorialRenderRequestV1Schema rejects unknown fields', () => {
      const input = {
        version: 1,
        projectDir: '/test',
        mutation: { operationId: crypto.randomUUID(), actorId: 'test' },
        unknownField: 'should-not-pass',
      };
      expect(() => editorialRenderRequestV1Schema.parse(input)).toThrow();
    });

    it('editorialRenderRequestV1Schema rejects missing mutation', () => {
      const input = { version: 1, projectDir: '/test' };
      expect(() => editorialRenderRequestV1Schema.parse(input)).toThrow();
    });

    it('editorialMutationContextSchema rejects invalid UUID', () => {
      const input = { operationId: 'not-a-uuid', actorId: 'test' };
      expect(() => editorialMutationContextSchema.parse(input)).toThrow();
    });

    it('editorialMutationContextSchema rejects blank actorId', () => {
      const input = { operationId: crypto.randomUUID(), actorId: '' };
      expect(() => editorialMutationContextSchema.parse(input)).toThrow();
    });

    it('editorialPreviewRequestV1Schema accepts request without mutation', () => {
      const input = {
        version: 1,
        projectDir: '/test',
      };
      const result = editorialPreviewRequestV1Schema.parse(input);
      expect(result.version).toBe(1);
      expect(result.projectDir).toBe('/test');
      // mutation must not be present in the parsed result
      expect('mutation' in result).toBe(false);
    });

    it('editorialPreviewRequestV1Schema rejects unknown fields', () => {
      const input = {
        version: 1,
        projectDir: '/test',
        extra: true,
      };
      expect(() => editorialPreviewRequestV1Schema.parse(input)).toThrow();
    });

    it('editorialRenderRequestV1Schema rejects blank model', () => {
      const input = {
        version: 1,
        projectDir: '/test',
        mutation: { operationId: crypto.randomUUID(), actorId: 'test' },
        model: '',
      };
      expect(() => editorialRenderRequestV1Schema.parse(input)).toThrow();
    });

    it('editorialRenderRequestV1Schema rejects blank providerProfile', () => {
      const input = {
        version: 1,
        projectDir: '/test',
        mutation: { operationId: crypto.randomUUID(), actorId: 'test' },
        providerProfile: '  ',
      };
      expect(() => editorialRenderRequestV1Schema.parse(input)).toThrow();
    });
  });

  // ── Runtime validation: simultaneous provider + providerFactory ────────
  it('rejects simultaneous runtime.provider and runtime.providerFactory with INVALID_OPERATION', async () => {
    const mockProvider = {
      name: 'mock',
      complete: async () => ({
        id: '',
        model: '',
        content: '',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      }),
    } satisfies LLMProvider;
    const mockFactory = { create: async () => mockProvider };

    const request: EditorialRenderRequestV1 = {
      version: 1,
      projectDir: '/test-project',
      mutation: { operationId: crypto.randomUUID(), actorId: 'test' },
    };

    let err: unknown;
    try {
      await renderNovel(request, { provider: mockProvider, providerFactory: mockFactory });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EditorialOperationError);
    expect((err as EditorialOperationError).code).toBe('INVALID_OPERATION');
  });

  // ── Flow 6: Preview twice → deep-equal, zero writes, zero provider ──
  it('preview twice produces deep-equal results with no storage writes and no provider', async () => {
    const storage = new MemoryStorage();
    setupMinimalProject(storage);

    const listAll = (dir: string): string[] => {
      const result: string[] = [];
      const entries = storage.list(dir);
      for (const entry of entries) {
        const fullPath = dir + '/' + entry.name;
        if (entry.isFile()) result.push(fullPath);
      }
      return result;
    };
    const filesBefore = listAll('/test-project');

    const request = makePreviewRequest();
    const runtime = makeRuntime({ storage });

    // First preview — no provider, no writes
    const preview1 = await previewEditorialRun(request, runtime);

    // Verify zero storage writes
    expect(listAll('/test-project')).toEqual(filesBefore);

    // Second preview — identical input → deep-equal output
    const preview2 = await previewEditorialRun(request, runtime);
    // Full deep equality is required for the same read-only request.
    expect(preview2).toEqual(preview1);
    expect(preview2.planHash).toBe(preview1.planHash);
    expect(preview2.selectedEventIds).toEqual(preview1.selectedEventIds);
    expect(preview2.scenes).toEqual(preview1.scenes);
    expect(preview2.errors).toEqual(preview1.errors);
    expect(preview2.prompts).toEqual(preview1.prompts);

    // Verify no provider state leaks into preview result (no mutation field in result shape)
    expect('mutations' in preview1).toBe(false);
  });

  // ── Flow 7: Strictly increasing JSON-safe progress sequence ──────────
  it('emits strictly increasing JSON-safe progress sequence per operation', async () => {
    const storage = new MemoryStorage();
    setupMinimalProject(storage);
    const eventBus = new TypedEventBus();
    const events: EditorialProgressEventV1[] = [];
    eventBus.on('editorial:progress', (e) => events.push(e));

    const request = makeRequest({ model: undefined });
    const runtime = makeRuntime({ storage, eventBus });

    await renderNovel(request, runtime);

    // At minimum operation_started + operation_completed
    expect(events.length).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < events.length; i++) {
      expect(events[i].sequence).toBe(i + 1);
    }
    // Every event survives JSON round-trip through the schema
    for (const ev of events) {
      const json = JSON.stringify(ev);
      const parsed = JSON.parse(json);
      const validated = editorialProgressEventV1Schema.parse(parsed);
      expect(validated.sequence).toBeGreaterThan(0);
    }
  });

  // ── Flow 8: Cancelled durable operation persists to store ────────────
  it('persists cancelled operation status durable to OperationStore query', async () => {
    const storage = new MemoryStorage();
    const paths = resolveProjectPaths('/test-project');
    const coordinator = new ProjectTransactionCoordinator(storage, paths);
    const clock = new FakeClock(BASE_TIME);
    const store = new OperationStore(coordinator, paths, clock);
    const opId = crypto.randomUUID();

    storage.mkdirp(paths.operationsDir);

    store.register({
      operationId: opId,
      kind: 'render',
      actorId: 'test-actor',
      requestHash: 'a'.repeat(64),
    });
    store.cancel(opId, 'test-actor');

    const op = store.get(opId);
    expect(op.status).toBe('cancelled');
    expect(op.lastSequence).toBeGreaterThan(0);
  });

  // ── Flow 9: No late heartbeat overwrite ──────────────────────────────
  it('rejects heartbeat after terminal finalization', async () => {
    const storage = new MemoryStorage();
    const paths = resolveProjectPaths('/test-project');
    const coordinator = new ProjectTransactionCoordinator(storage, paths);
    const clock = new FakeClock(BASE_TIME);
    const store = new OperationStore(coordinator, paths, clock);
    const opId = crypto.randomUUID();

    storage.mkdirp(paths.operationsDir);

    store.register({
      operationId: opId,
      kind: 'render',
      actorId: 'test-actor',
      requestHash: 'a'.repeat(64),
    });
    store.succeed(opId, 'test-actor', null);

    // Late heartbeat must throw — terminal status prevents overwrite
    expect(() => store.heartbeat(opId, 'test-actor')).toThrow(EditorialOperationError);
  });
});
