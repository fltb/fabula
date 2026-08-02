import * as crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type MockPass2Entry, MockPass2Provider } from '../../src/ai/providers/mock-pass2.ts';
import { previewEditorialRun, renderNovel } from '../../src/api.ts';
import type { ProjectSourceSnapshotV1, SourceDocumentV1 } from '../../src/contracts/source.ts';
import { MemoryExecutionRepository, MemoryRenderCacheRepository, MemoryStateLogRepository, MemoryStateSnapshotRepository } from '../../src/testing/memory-repositories.ts';
import { makeCustomEntry, makeObservations, makeProtocol } from '../fixtures/mock-pass2-helpers.ts';

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const text = (id: string) => `Test prose for event ${id}. The morning light filtered through the tall windows.`;
const analysis: Record<string, unknown> = { postconditions: { covered: [], dropped: [] }, preconditions: { violated: [] }, pov: { consistent: true, leaks: [] }, inventedDetails: [], quality: { proseScore: 4, maxScore: 5, strengths: ['clear'], weaknesses: [], estimatedWordCount: 80 }, threadProgressAchieved: [], foreshadowingDeployed: [], narrativeChecks: [], appearanceChecks: [], characterReferences: [], tenseDetected: 'past', conflictAnalysis: { primaryType: 'none', resolutionAchieved: true }, ruleChecks: [], knowledgeChecks: [], checklistResults: [] };
function entry(id: string, prose = text(id)): MockPass2Entry { return makeCustomEntry(id, prose, { eventId: id, protocol: makeProtocol(prose), observations: makeObservations(analysis, prose), analysis }); }
function source(ids: string[], surface?: string): ProjectSourceSnapshotV1 {
  const events = ids.map((id, i) => `event: ${id}\nnarrativeOrder: ${i + 1}\ntitle: ${id} scene\nstoryTime: day_1\npov:\n  character: narrator\n  type: first_person\nsceneBrief: Test scene\nbeats:\n  - Test scene\npreconditions: []\nexpectedPostconditions: []\n`);
  const docs: Record<string, string> = {
    'nova.yaml': `project: test-project\ntitle: Test Novel\nauthor: Test Author\ndefaultModel: mock-pass2\ndefaultLanguage: en${surface ? `\nrenderSurface:\n${surface.split('\n').map((line) => `  ${line}`).join('\n')}` : ''}\n`,
    'definitions/state_initial.yaml': 'info:\n  currentEra: contemporary\n  politicalSituation: stable\ntimeAnchors:\n  - { id: day_1, at: day_1, description: Day 1 }\nthreads: []\nworldFacts: []\n',
    'definitions/entity-types.yaml': 'types:\n  character:\n    typeId: character\n    kind: character\n    attributes:\n      lifecycle:\n        attributeId: lifecycle\n        valueType: string\n        requiredAt: introduction\n        writePolicy: lifecycle_managed\n        allowedLifecycleStates: [active, inactive, retired]\n        unsetAllowed: false\n        semanticRole: lifecycle\n      traits:\n        attributeId: traits\n        valueType: string_list\n        requiredAt: never\n        writePolicy: immutable\n        unsetAllowed: true\n    lifecyclePolicy:\n      allowedTransitions:\n        - [active, inactive]\n        - [active, retired]\n        - [inactive, active]\n        - [inactive, retired]\n    referenceCapabilities:\n      defaultEligibility: live\n    typedInvariants: []\n',
    'definitions/characters/narrator.yaml': 'id: narrator\nname: Narrator\ntype: person\ndescription: narrator\ninitialState: {}\ntraits: []\n',
    'definitions/discourse-ledger.yaml': `id: test-ledger\nchapters:\n  - branch: main\n    chapter: 1\n    sceneIds: [${ids.join(', ')}]\nentries: []\n`,
    'chapters/chapter_01/_chapter.yaml': `chapter: 1\ntitle: Chapter 1\nsummary: Lifecycle\nintent: Test\nplannedScenes: ${ids.length}\n`,
  };
  ids.forEach((id, i) => { docs[`chapters/chapter_01/${id}.yaml`] = events[i]!; });
  const documents: SourceDocumentV1[] = Object.entries(docs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([logicalPath, content]) => ({ version: 1, logicalPath, content, contentHash: sha(content), parseResult: { status: 'parsed', value: { value: content } }, diagnostics: [] }));
  return { version: 1, documents, sourceHash: sha(documents.map((d) => `${d.logicalPath}\0${d.content}`).join('')) };
}
function services(provider: MockPass2Provider, execution = new MemoryExecutionRepository(), renderCache = new MemoryRenderCacheRepository()) { return { execution, renderCache, stateLog: new MemoryStateLogRepository(), stateSnapshots: new MemoryStateSnapshotRepository(), promptTemplates: { get: async () => null }, clock: { now: () => new Date().toISOString() }, ids: { next: () => crypto.randomUUID() }, llm: provider }; }
function tracked(provider: MockPass2Provider) { let calls = 0; const complete = provider.complete.bind(provider); provider.complete = async (r) => { calls++; return complete(r); }; return () => calls; }
const serial = (ids: string[], last = 'serial_surface') => `mode: manual\ngroups:\n${ids.map((id, i) => `  - groupId: group_${i}\n    sceneIds: [${id}]\n    surfacePolicy: ${i === ids.length - 1 && last !== 'serial_surface' ? last : 'serial_surface'}`).join('\n')}\nlanes:\n  - laneId: main_lane\n    groupIds: [${ids.map((_, i) => `group_${i}`).join(', ')}]`;

describe('Surface Lifecycle — immutable source snapshot scheduling', () => {
  it('serial dependent receives packet when predecessor is accepted', async () => { const provider = new MockPass2Provider({ entries: { E1: entry('E1'), E2: entry('E2') } }); const result = await renderNovel({ version: 1, source: source(['E1', 'E2'], serial(['E1', 'E2'])), mutation: { operationId: '00000001-0001-4001-8001-000000000001', actorId: 'test' }, model: 'mock-pass2' }, { provider, services: services(provider) }); expect(result.errors).toHaveLength(0); expect(result.results).toHaveLength(2); expect(result.results.every((r) => r.released)).toBe(true); expect(result.publication.status).toBe('current'); });
  it('blocked predecessor blocks serial descendant', async () => { const provider = new MockPass2Provider({ entries: { E1: entry('E1', ''), E2: entry('E2') } }); const result = await renderNovel({ version: 1, source: source(['E1', 'E2'], serial(['E1', 'E2'])), mutation: { operationId: '00000002-0002-4002-8002-000000000002', actorId: 'test' }, model: 'mock-pass2' }, { provider, services: services(provider) }); expect(result.results).toHaveLength(2); expect(result.results.every((r) => !r.released)).toBe(true); expect(result.results[1]?.errors.some((e) => e.includes('not accepted and no surface source'))).toBe(true); expect(result.publication.status).toBe('stale'); });
  it('fallback_without_surface renders when predecessor is blocked', async () => { const provider = new MockPass2Provider({ entries: { E1: entry('E1', ''), E2: entry('E2') } }); const result = await renderNovel({ version: 1, source: source(['E1', 'E2'], serial(['E1', 'E2'], 'fallback_without_surface')), mutation: { operationId: '00000003-0003-4003-8003-000000000003', actorId: 'test' }, model: 'mock-pass2' }, { provider, services: services(provider) }); expect(result.results[0]?.released).toBe(false); expect(result.results[1]?.released).toBe(true); expect(result.publication.status).toBe('stale'); });
  it('subset render with missing predecessor is blocked', async () => { const provider = new MockPass2Provider({ entries: { E2: entry('E2') } }); const result = await renderNovel({ version: 1, source: source(['E1', 'E2'], serial(['E1', 'E2'])), selector: { type: 'events', eventIds: ['E2'] }, mutation: { operationId: '00000004-0004-4004-8004-000000000004', actorId: 'test' }, model: 'mock-pass2' }, { provider, services: services(provider) }); expect(result.results[0]?.released).toBe(false); expect(result.results[0]?.errors.some((e) => e.includes('not accepted and no surface source'))).toBe(true); });
  it('batch and non-batch produce equivalent release outcomes', async () => { const s = source(['E1', 'E2'], serial(['E1', 'E2'])); const a = new MockPass2Provider({ entries: { E1: entry('E1'), E2: entry('E2') } }); const b = new MockPass2Provider({ entries: { E1: entry('E1'), E2: entry('E2') } }); const ra = await renderNovel({ version: 1, source: s, mutation: { operationId: '0000000a-000a-400a-800a-00000000000a', actorId: 'test' }, model: 'mock-pass2' }, { provider: a, services: services(a) }); const rb = await renderNovel({ version: 1, source: s, batch: { batchSize: 1 }, mutation: { operationId: '0000000b-000b-400b-800b-00000000000b', actorId: 'test' }, model: 'mock-pass2' }, { provider: b, services: services(b) }); expect(ra.results.map((r) => r.released)).toEqual(rb.results.map((r) => r.released)); });
  it('preview compiles prompts without provider calls', async () => { const provider = new MockPass2Provider({ entries: {} }); const calls = tracked(provider); const result = await previewEditorialRun({ version: 1, source: source(['E1', 'E2'], serial(['E1', 'E2'])), model: 'mock-pass2' }, { provider, services: services(provider) }); expect(calls()).toBe(0); expect(result.selectedEventIds).toEqual(['E1', 'E2']); expect(result.prompts).toHaveLength(2); });
  it('parallel groups render independently', async () => { const provider = new MockPass2Provider({ entries: { E1: entry('E1', ''), E2: entry('E2') } }); const result = await renderNovel({ version: 1, source: source(['E1', 'E2']), mutation: { operationId: '00000005-0005-4005-8005-000000000005', actorId: 'test' }, model: 'mock-pass2' }, { provider, services: services(provider) }); expect(result.results[0]?.released).toBe(false); expect(result.results[1]?.released).toBe(true); });
});

// ─── Accepted promotion CAS ────────────────────────────────────────────────
// A wrapper that lets a test simulate a concurrent writer winning the accepted
// head between this run's readAcceptedScene and its compareAndSwapAcceptedScene.

const PROSE_A = 'First accepted prose for E1. The morning light filtered through the tall windows.';
const PROSE_B = 'Second candidate prose for E1. The evening shadows crept across the quiet room.';
const PROSE_C = 'Concurrent head prose for E1. A different writer won the accepted head.';

class ConcurrentHeadExecutionRepository extends MemoryExecutionRepository {
  private armed = false;
  private injected = false;

  armConcurrentHead(): void {
    this.armed = true;
  }

  override async compareAndSwapAcceptedScene(
    input: Parameters<MemoryExecutionRepository['compareAndSwapAcceptedScene']>[0],
  ) {
    if (this.armed && !this.injected) {
      this.injected = true;
      const current = await super.readAcceptedScene({
        projectId: input.projectId,
        eventId: input.eventId,
      });
      if (current) {
        await super.compareAndSwapAcceptedScene({
          projectId: input.projectId,
          eventId: input.eventId,
          expectedVersion: current.revision,
          value: {
            version: 1,
            projectId: input.projectId,
            eventId: input.eventId,
            sourceHash: 'concurrent-source-hash',
            revisionId: 'concurrent-revision',
            prose: PROSE_C,
            proseHash: sha(PROSE_C),
            sceneHash: sha(PROSE_C),
          },
        });
      }
    }
    return super.compareAndSwapAcceptedScene(input);
  }
}

describe('Accepted promotion CAS — no false current on concurrent head', () => {
  it('serial re-render advances the accepted head through its read revision', async () => {
    const execution = new ConcurrentHeadExecutionRepository();
    const cache = new MemoryRenderCacheRepository();
    const first = new MockPass2Provider({ entries: { E1: entry('E1', PROSE_A) } });
    const cold = await renderNovel(
      { version: 1, source: source(['E1']), mutation: { operationId: crypto.randomUUID(), actorId: 'test' }, model: 'mock-pass2' },
      { provider: first, services: services(first, execution, cache) },
    );
    expect(cold.errors).toHaveLength(0);
    expect(cold.results[0]?.disposition).toBe('candidate_promoted');
    expect(cold.results[0]?.released).toBe(true);
    expect(cold.publication.status).toBe('current');

    // A fresh cache forces a cold re-render with new prose. The accepted head
    // must advance via the CAS revision (read revision 1 -> commit revision 2),
    // not silently keep the stale first head while reporting current.
    const second = new MockPass2Provider({ entries: { E1: entry('E1', PROSE_B) } });
    const rerun = await renderNovel(
      { version: 1, source: source(['E1']), mutation: { operationId: crypto.randomUUID(), actorId: 'test' }, model: 'mock-pass2' },
      { provider: second, services: services(second, execution, new MemoryRenderCacheRepository()) },
    );
    expect(rerun.errors).toHaveLength(0);
    expect(rerun.results[0]?.released).toBe(true);
    expect(rerun.results[0]?.disposition).toBe('candidate_promoted');
    expect(rerun.publication.status).toBe('current');

    const head = await execution.readAcceptedScene({ projectId: 'test-project', eventId: 'E1' });
    expect(head?.revision).toBe(2);
    expect(head?.value.prose).toBe(PROSE_B);
  });

  it('concurrent accepted-head write surfaces a stale candidate, not current', async () => {
    const execution = new ConcurrentHeadExecutionRepository();
    const cache = new MemoryRenderCacheRepository();
    const first = new MockPass2Provider({ entries: { E1: entry('E1', PROSE_A) } });
    const cold = await renderNovel(
      { version: 1, source: source(['E1']), mutation: { operationId: crypto.randomUUID(), actorId: 'test' }, model: 'mock-pass2' },
      { provider: first, services: services(first, execution, cache) },
    );
    expect(cold.results[0]?.disposition).toBe('candidate_promoted');
    expect(cold.publication.status).toBe('current');

    // Between this run's read and its accepted-scene CAS, a concurrent writer
    // takes the head. The promotion must fail closed instead of claiming
    // candidate_promoted/current over a contested candidate.
    execution.armConcurrentHead();
    const second = new MockPass2Provider({ entries: { E1: entry('E1', PROSE_B) } });
    const conflicted = await renderNovel(
      { version: 1, source: source(['E1']), mutation: { operationId: crypto.randomUUID(), actorId: 'test' }, model: 'mock-pass2' },
      { provider: second, services: services(second, execution, new MemoryRenderCacheRepository()) },
    );

    expect(conflicted.results[0]?.disposition).toBe('candidate_stale');
    expect(conflicted.results[0]?.promoted).toBe(false);
    expect(conflicted.results[0]?.released).toBe(false);
    expect(conflicted.results[0]?.revisionId).toBeNull();
    expect(conflicted.results[0]?.releaseDecision?.status).toBe('blocked');
    expect(conflicted.publication.status).toBe('stale');
    expect(conflicted.errors.some((message) => message.includes('ACCEPTED_HEAD_CONFLICT'))).toBe(true);

    // The contested candidate was never accepted: the concurrent head survives
    // verbatim and is not overwritten by the failed promotion.
    const head = await execution.readAcceptedScene({ projectId: 'test-project', eventId: 'E1' });
    expect(head?.revision).toBe(2);
    expect(head?.value.prose).toBe(PROSE_C);
    expect(head?.value.revisionId).toBe('concurrent-revision');

    const operation = await execution.readOperation({ projectId: 'test-project', operationId: conflicted.operationId });
    expect(operation).not.toBeNull();
    expect(((operation?.value as { value?: { status?: unknown } })?.value)?.status).toBe('failed');
  });
});
