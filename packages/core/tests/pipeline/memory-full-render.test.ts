import * as crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { MockPass2Entry } from '../../src/ai/providers/mock-pass2.ts';
import { MockPass2Provider } from '../../src/ai/providers/mock-pass2.ts';
import { previewEditorialRun, renderNovel } from '../../src/api.ts';
import type { ProjectSourceSnapshotV1, SourceDocumentV1 } from '../../src/contracts/source.ts';
import type { RenderCacheRecord } from '../../src/ports/render-cache-repository.ts';
import {
  MemoryExecutionRepository,
  MemoryRenderCacheRepository,
  MemoryStateLogRepository,
  MemoryStateSnapshotRepository,
} from '../../src/testing/memory-repositories.ts';
import { makeCustomEntry, makeObservations, makeProtocol } from '../fixtures/mock-pass2-helpers.ts';

const hash = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');
const prose =
  'The morning light filtered through the tall windows of the converted conference room, painting golden rectangles across the scuffed wooden floor.';
const payload: Record<string, unknown> = {
  postconditions: { covered: [], dropped: [] },
  preconditions: { violated: [] },
  pov: { consistent: true, leaks: [] },
  inventedDetails: [],
  quality: {
    proseScore: 4,
    maxScore: 5,
    strengths: ['clear prose'],
    weaknesses: [],
    estimatedWordCount: 80,
  },
  threadProgressAchieved: [],
  foreshadowingDeployed: [],
  narrativeChecks: [],
  appearanceChecks: [],
  characterReferences: [],
  tenseDetected: 'past',
  conflictAnalysis: { primaryType: 'none', resolutionAchieved: true },
  ruleChecks: [],
  knowledgeChecks: [],
  checklistResults: [],
};

function source(title = 'Test Novel'): ProjectSourceSnapshotV1 {
  const entries: Record<string, string> = {
    'nova.yaml': `project: test-project\ntitle: ${title}\nauthor: Test Author\ndefaultModel: mock-pass2\ndefaultLanguage: en\n`,
    'definitions/state_initial.yaml':
      'info:\n  currentEra: contemporary\n  politicalSituation: stable\ntimeAnchors:\n  - { id: day_1, at: day_1, description: Day 1 }\nthreads: []\nworldFacts: []\n',
    'definitions/entity-types.yaml':
      'types:\n  character:\n    typeId: character\n    kind: character\n    attributes:\n      lifecycle:\n        attributeId: lifecycle\n        valueType: string\n        requiredAt: introduction\n        writePolicy: lifecycle_managed\n        allowedLifecycleStates: [active, inactive, retired]\n        unsetAllowed: false\n        semanticRole: lifecycle\n      traits:\n        attributeId: traits\n        valueType: string_list\n        requiredAt: never\n        writePolicy: immutable\n        unsetAllowed: true\n    lifecyclePolicy:\n      allowedTransitions:\n        - [active, inactive]\n        - [active, retired]\n        - [inactive, active]\n        - [inactive, retired]\n    referenceCapabilities:\n      defaultEligibility: live\n    typedInvariants: []\n',
    'definitions/characters/narrator.yaml':
      'id: narrator\nname: Narrator\ntype: person\ndescription: The narrator\ninitialState: {}\ntraits: []\n',
    'definitions/discourse-ledger.yaml':
      'id: test-ledger\nchapters:\n  - branch: main\n    chapter: 1\n    sceneIds: [E1]\nentries: []\n',
    'chapters/chapter_01/_chapter.yaml':
      'chapter: 1\ntitle: Chapter 1\nsummary: First chapter\nintent: Introduction\nplannedScenes: 1\n',
    'chapters/chapter_01/E1.yaml':
      'event: E1\nnarrativeOrder: 1\ntitle: First Event\nstoryTime: day_1\npov:\n  character: narrator\n  type: first_person\nsceneBrief: A test scene.\nbeats:\n  - A test scene.\npreconditions: []\nexpectedPostconditions: []\n',
  };
  const documents: SourceDocumentV1[] = Object.entries(entries)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([logicalPath, content]) => ({
      version: 1,
      logicalPath,
      content,
      contentHash: hash(content),
      parseResult: { status: 'parsed', value: { value: content } },
      diagnostics: [],
    }));
  return {
    version: 1,
    documents,
    sourceHash: hash(
      documents.map((document) => `${document.logicalPath}\0${document.content}`).join(''),
    ),
  };
}

function entry(eventId: string): MockPass2Entry {
  const text = `Test prose for event ${eventId}. ${prose}`;
  return makeCustomEntry(eventId, text, {
    eventId,
    protocol: makeProtocol(text),
    observations: makeObservations(payload, text),
    analysis: payload,
  });
}
function services(provider: MockPass2Provider) {
  return {
    execution: new MemoryExecutionRepository(),
    renderCache: new MemoryRenderCacheRepository(),
    stateLog: new MemoryStateLogRepository(),
    stateSnapshots: new MemoryStateSnapshotRepository(),
    promptTemplates: { get: async () => null },
    clock: { now: () => new Date().toISOString() },
    ids: { next: () => crypto.randomUUID() },
    llm: provider,
  };
}
function track(provider: MockPass2Provider) {
  let calls = 0;
  const complete = provider.complete.bind(provider);
  provider.complete = async (request) => {
    calls++;
    return complete(request);
  };
  return () => calls;
}

describe('immutable source snapshot — renderNovel full contract', () => {
  it('cold render calls provider and releases the accepted scene', async () => {
    const provider = new MockPass2Provider({ entries: { E1: entry('E1') } });
    const calls = track(provider);
    const result = await renderNovel(
      {
        version: 1,
        source: source(),
        selector: { type: 'all' },
        mutation: { operationId: crypto.randomUUID(), actorId: 'test' },
        model: 'mock-pass2',
      },
      { provider, services: services(provider) },
    );
    expect(result.errors).toHaveLength(0);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.eventId).toBe('E1');
    expect(result.results[0]?.released).toBe(true);
    expect(result.results[0]?.cacheHit).toBe(false);
    expect(calls()).toBeGreaterThanOrEqual(2);
  });

  it('warm render reuses the semantic cache without provider calls', async () => {
    const execution = new MemoryExecutionRepository();
    const cache = new MemoryRenderCacheRepository();
    const first = new MockPass2Provider({ entries: { E1: entry('E1') } });
    const firstCalls = track(first);
    const runtime = {
      services: { ...services(first), execution, renderCache: cache },
      provider: first,
    };
    const cold = await renderNovel(
      {
        version: 1,
        source: source(),
        selector: { type: 'all' },
        mutation: { operationId: crypto.randomUUID(), actorId: 'test' },
        model: 'mock-pass2',
      },
      runtime,
    );
    expect(cold.errors).toHaveLength(0);
    expect(firstCalls()).toBeGreaterThanOrEqual(2);
    const second = new MockPass2Provider({ entries: { E1: entry('E1') } });
    const secondCalls = track(second);
    const warm = await renderNovel(
      {
        version: 1,
        source: source(),
        selector: { type: 'all' },
        mutation: { operationId: crypto.randomUUID(), actorId: 'test' },
        model: 'mock-pass2',
      },
      { services: { ...services(second), execution, renderCache: cache }, provider: second },
    );
    expect(warm.errors).toHaveLength(0);
    expect(warm.results[0]?.cacheHit).toBe(true);
    expect(warm.results[0]?.prose).toBe(cold.results[0]?.prose);
    expect(secondCalls()).toBe(0);
  });

  it('different immutable snapshots have isolated source identity and cache records', async () => {
    const a = source('A');
    const b = source('B');
    expect(a.sourceHash).not.toBe(b.sourceHash);
    const cache = new MemoryRenderCacheRepository();
    const key = { version: 1 as const, sourceHash: a.sourceHash, layers: { render: 'same' } };
    const record = { version: 1 as const, key, recordHash: hash('record'), output: { prose } };
    await cache.put({ key, record });
    expect(await cache.get({ key })).not.toBeNull();
    expect(await cache.get({ key: { ...key, sourceHash: b.sourceHash } })).toBeNull();
  });

  it('preview compiles prompts without provider calls or persistence', async () => {
    const provider = new MockPass2Provider({ entries: { E1: entry('E1') } });
    const calls = track(provider);
    const result = await previewEditorialRun(
      { version: 1, source: source(), selector: { type: 'all' }, model: 'mock-pass2' },
      { provider, services: services(provider) },
    );
    expect(result.errors).toHaveLength(0);
    expect(result.selectedEventIds).toEqual(['E1']);
    expect(result.prompts).toHaveLength(1);
    expect(result.prompts[0]?.userPrompt).toContain('E1');
    expect(calls()).toBe(0);
  });

  it('fixed injected clock/ids stabilize cache records and revision IDs', async () => {
    const FIXED_NOW = '2026-03-04T05:06:07.000Z';
    const run = async () => {
      const cache = new MemoryRenderCacheRepository();
      const captured: RenderCacheRecord[] = [];
      const put = cache.put.bind(cache);
      cache.put = async (input) => {
        captured.push(input.record);
        return put(input);
      };
      const provider = new MockPass2Provider({ entries: { E1: entry('E1') } });
      const runtime = {
        provider,
        services: {
          ...services(provider),
          execution: new MemoryExecutionRepository(),
          renderCache: cache,
          clock: { now: () => FIXED_NOW },
          ids: { next: () => 'deterministic-rev-1' },
        },
      };
      const result = await renderNovel(
        {
          version: 1,
          source: source(),
          selector: { type: 'all' },
          mutation: { operationId: '11111111-1111-4111-8111-111111111111', actorId: 'test' },
          model: 'mock-pass2',
        },
        runtime,
      );
      return { result, captured };
    };
    const a = await run();
    const b = await run();
    expect(a.result.errors).toHaveLength(0);
    expect(b.result.errors).toHaveLength(0);
    // Revision IDs and promotion come from the injected IdGenerator.
    expect(a.result.results[0]?.revisionId).toBe('deterministic-rev-1');
    expect(b.result.results[0]?.revisionId).toBe('deterministic-rev-1');
    // Cache records (renderedAt, recordHash, full output) are identical.
    expect(a.captured).toHaveLength(1);
    expect(a.captured[0]).toEqual(b.captured[0]);
    const recordOutput = a.captured[0]!.output;
    if (typeof recordOutput === 'object' && recordOutput !== null && 'renderedAt' in recordOutput) {
      expect(recordOutput.renderedAt).toBe(FIXED_NOW);
    }
  });

  it('cache renderedAt follows the injected clock, never the wall clock', async () => {
    const capture = async (now: string) => {
      const cache = new MemoryRenderCacheRepository();
      let record: RenderCacheRecord | null = null;
      const put = cache.put.bind(cache);
      cache.put = async (input) => {
        record = input.record;
        return put(input);
      };
      const provider = new MockPass2Provider({ entries: { E1: entry('E1') } });
      await renderNovel(
        {
          version: 1,
          source: source(),
          selector: { type: 'all' },
          mutation: { operationId: '22222222-2222-4222-8222-222222222222', actorId: 'test' },
          model: 'mock-pass2',
        },
        {
          provider,
          services: {
            ...services(provider),
            renderCache: cache,
            clock: { now: () => now },
            ids: { next: () => 'deterministic-rev-1' },
          },
        },
      );
      return record;
    };
    const early = await capture('2026-01-01T00:00:00.000Z');
    const late = await capture('2026-12-31T23:59:59.000Z');
    const earlyOutput = early!.output;
    const lateOutput = late!.output;
    if (typeof earlyOutput === 'object' && earlyOutput !== null && 'renderedAt' in earlyOutput) {
      expect(earlyOutput.renderedAt).toBe('2026-01-01T00:00:00.000Z');
    }
    if (typeof lateOutput === 'object' && lateOutput !== null && 'renderedAt' in lateOutput) {
      expect(lateOutput.renderedAt).toBe('2026-12-31T23:59:59.000Z');
    }
  });
});
