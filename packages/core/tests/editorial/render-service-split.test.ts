// ============================================================================
// Editorial render candidate/commit split
//
// executeEditorialCandidates computes everything short of the accepted-scene
// CAS (compile, provider calls, Pass 2, validation, release decision, and the
// append-only scene revision archive); commitEditorialCandidates performs only
// the per-head compareAndSwapAcceptedScene and publication readiness.
// executeEditorialRender composes the two and must stay byte-identical to the
// pre-split behavior for every existing caller.
//
// Covers:
//   1. candidates + commit in separate steps == composed facade final state
//   2. accepted head moved between compute and commit → stale, head
//      untouched, appended candidate revision retained
//   3. stale-source accepted head → NO_ACCEPTED_BASE on explicit revise
//   4. in-run candidate scenes never appear as repository accepted heads
//      before commit (surface waves consume them via the in-memory map)
// ============================================================================

import * as crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type MockPass2Entry, MockPass2Provider } from '../../src/ai/providers/mock-pass2.ts';
import type { ProjectSourceSnapshotV1, SourceDocumentV1 } from '../../src/contracts/source.ts';
import {
  commitEditorialCandidates,
  executeEditorialCandidates,
  executeEditorialRender,
} from '../../src/editorial/render-service.ts';
import {
  MemoryExecutionRepository,
  MemoryRenderCacheRepository,
  MemoryStateLogRepository,
  MemoryStateSnapshotRepository,
} from '../../src/testing/memory-repositories.ts';
import type { EditorialRuntime } from '../../src/types/editorial.ts';
import { makeCustomEntry, makeObservations, makeProtocol } from '../fixtures/mock-pass2-helpers.ts';

const PROJECT_ID = 'test-project';
const FIXED_NOW = '2026-01-01T00:00:00.000Z';
const sha = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');
const text = (id: string) =>
  `Test prose for event ${id}. The morning light filtered through the tall windows.`;
const analysis: Record<string, unknown> = {
  postconditions: { covered: [], dropped: [] },
  preconditions: { violated: [] },
  pov: { consistent: true, leaks: [] },
  inventedDetails: [],
  quality: {
    proseScore: 4,
    maxScore: 5,
    strengths: ['clear'],
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

function entry(id: string, prose = text(id)): MockPass2Entry {
  return makeCustomEntry(id, prose, {
    eventId: id,
    protocol: makeProtocol(prose),
    observations: makeObservations(analysis, prose),
    analysis,
  });
}

function source(ids: string[], surface?: string): ProjectSourceSnapshotV1 {
  const events = ids.map(
    (id, i) =>
      `event: ${id}\nnarrativeOrder: ${i + 1}\ntitle: ${id} scene\nstoryTime: day_1\npov:\n  character: narrator\n  type: first_person\nsceneBrief: Test scene\nbeats:\n  - Test scene\npreconditions: []\nexpectedPostconditions: []\n`,
  );
  const docs: Record<string, string> = {
    'nova.yaml': `project: ${PROJECT_ID}\ntitle: Test Novel\nauthor: Test Author\ndefaultModel: mock-pass2\ndefaultLanguage: en${
      surface
        ? `\nrenderSurface:\n${surface
            .split('\n')
            .map((line) => `  ${line}`)
            .join('\n')}`
        : ''
    }\n`,
    'definitions/state_initial.yaml':
      'info:\n  currentEra: contemporary\n  politicalSituation: stable\ntimeAnchors:\n  - { id: day_1, at: day_1, description: Day 1 }\nthreads: []\nworldFacts: []\nknowledge: { claims: [], commonGround: [] }\n',
    'definitions/thread-types.yaml':
      'types:\n  primary:\n    typeId: primary\n    description: Primary narrative thread type\n    allowedPhases: [opening, development, resolution]\n    lifecyclePolicy: { reopenPolicy: forbidden }\n    timeDomain: story\n    stableGoals: []\n    stableMilestones: []\n',
    'definitions/propositions.yaml': 'version: 1\npropositions: {}\ndependencyGraph: {}\n',
    'definitions/relationship-types.yaml': 'types: {}\n',
    'definitions/rule-types.yaml': 'types: {}\n',
    'definitions/entity-types.yaml':
      'types:\n  character:\n    typeId: character\n    kind: character\n    attributes:\n      lifecycle:\n        attributeId: lifecycle\n        valueType: string\n        requiredAt: introduction\n        writePolicy: lifecycle_managed\n        allowedLifecycleStates: [active, inactive, retired]\n        unsetAllowed: false\n        semanticRole: lifecycle\n      traits:\n        attributeId: traits\n        valueType: string_list\n        requiredAt: never\n        writePolicy: immutable\n        unsetAllowed: true\n    lifecyclePolicy:\n      allowedTransitions:\n        - [active, inactive]\n        - [active, retired]\n        - [inactive, active]\n        - [inactive, retired]\n    referenceCapabilities:\n      defaultEligibility: live\n    typedInvariants: []\n',
    'definitions/characters/narrator.yaml':
      'id: narrator\nname: Narrator\ntype: person\ndescription: narrator\ninitialState: {}\ntraits: []\n',
    'definitions/discourse-ledger.yaml': `id: test-ledger\nchapters:\n  - branch: main\n    chapter: 1\n    sceneIds: [${ids.join(', ')}]\nentries: []\n`,
    'chapters/chapter_01/_chapter.yaml': `chapter: 1\ntitle: Chapter 1\nsummary: Lifecycle\nintent: Test\nplannedScenes: ${ids.length}\n`,
  };
  ids.forEach((id, i) => {
    const event = events[i];
    if (event === undefined) {
      throw new Error(`Missing generated event document for ${id}`);
    }
    docs[`chapters/chapter_01/${id}.yaml`] = event;
  });
  const documents: SourceDocumentV1[] = Object.entries(docs)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([logicalPath, content]) => ({
      version: 1,
      logicalPath,
      content,
      contentHash: sha(content),
      parseResult: { status: 'parsed', value: { value: content } },
      diagnostics: [],
    }));
  return {
    version: 1,
    documents,
    sourceHash: sha(documents.map((d) => `${d.logicalPath}\0${d.content}`).join('')),
  };
}

const serial = (ids: string[]) =>
  `mode: manual\ngroups:\n${ids
    .map(
      (id, i) =>
        `  - groupId: group_${i}\n    sceneIds: [${id}]\n    surfacePolicy: serial_surface`,
    )
    .join(
      '\n',
    )}\nlanes:\n  - laneId: main_lane\n    groupIds: [${ids.map((_, i) => `group_${i}`).join(', ')}]`;

/**
 * Deterministic services: fixed clock + a per-instance id counter, so two
 * independent service instances (facade path vs split path) generate
 * byte-identical revision ids and timestamps for the same render.
 */
function services(
  provider: MockPass2Provider,
  execution = new MemoryExecutionRepository(),
  renderCache = new MemoryRenderCacheRepository(),
): EditorialRuntime['services'] {
  let idCounter = 0;
  return {
    execution,
    renderCache,
    stateLog: new MemoryStateLogRepository(),
    stateSnapshots: new MemoryStateSnapshotRepository(),
    promptTemplates: { get: async () => null },
    clock: { now: () => FIXED_NOW },
    ids: { next: () => `rev-${(++idCounter).toString().padStart(4, '0')}` },
    llm: provider,
  };
}

/** Wrap complete() to count provider calls. */
function trackCalls(provider: MockPass2Provider): () => number {
  let calls = 0;
  const complete = provider.complete.bind(provider);
  provider.complete = async (request) => {
    calls++;
    return complete(request);
  };
  return () => calls;
}

const BASE_PROSE = 'The old accepted prose for E1, settled in a prior pass.';
const REVISED_PROSE = 'Revised prose for E1, freshly generated by the revision pass.';

async function seedAcceptedBase(
  execution: MemoryExecutionRepository,
  sourceHash: string,
): Promise<void> {
  await execution.compareAndSwapAcceptedScene({
    projectId: PROJECT_ID,
    eventId: 'E1',
    expectedVersion: null,
    value: {
      version: 1,
      projectId: PROJECT_ID,
      eventId: 'E1',
      sourceHash,
      revisionId: 'rev-base-1',
      prose: BASE_PROSE,
      proseHash: sha(BASE_PROSE),
      sceneHash: sha(BASE_PROSE),
    },
  });
}

const PROSE_C = 'Concurrent head prose for E1. A different writer won the accepted head.';

/** Inject a concurrent accepted head on the first accepted-scene CAS after arming. */
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

describe('editorial candidate/commit split', () => {
  it('candidates + commit in separate steps produce the same final state as the composed facade', async () => {
    const src = source(['E1', 'E2'], serial(['E1', 'E2']));
    const request = {
      version: 1 as const,
      source: src,
      mutation: { operationId: '0000000a-000a-400a-800a-00000000000a', actorId: 'test' },
      model: 'mock-pass2',
    };

    // Pre-existing first-render-in-process validator/schema state mutation
    // (observed before this split, independent of it) makes the FIRST render
    // in a process compute a different validation identity/plan hash than all
    // later renders. Warm up once so both paths below run on the stable
    // identity and the byte-for-byte comparison is meaningful.
    const warmup = new MemoryExecutionRepository();
    const warmupProvider = new MockPass2Provider({ entries: { E1: entry('E1'), E2: entry('E2') } });
    const warmupOutcome = await executeEditorialCandidates(request, {
      provider: warmupProvider,
      services: services(warmupProvider, warmup),
    });
    if (warmupOutcome.kind !== 'candidates') {
      throw new Error('Expected the warm-up candidate set');
    }

    // ── Facade path: executeEditorialRender end to end ──────────────────
    const executionA = new MemoryExecutionRepository();
    const providerA = new MockPass2Provider({ entries: { E1: entry('E1'), E2: entry('E2') } });
    const resultA = await executeEditorialRender(request, {
      provider: providerA,
      services: services(providerA, executionA),
    });

    // ── Split path: candidates, then commit ─────────────────────────────
    const executionB = new MemoryExecutionRepository();
    const providerB = new MockPass2Provider({ entries: { E1: entry('E1'), E2: entry('E2') } });
    const runtimeB: EditorialRuntime = {
      provider: providerB,
      services: services(providerB, executionB),
    };
    const outcome = await executeEditorialCandidates(request, runtimeB);
    expect(outcome.kind).toBe('candidates');
    if (outcome.kind !== 'candidates') return;
    const commitResult = await commitEditorialCandidates(outcome.candidateSet, runtimeB);

    // The split path produces the same release summary as the facade.
    expect(resultA.errors).toHaveLength(0);
    expect(commitResult.stale).toBe(false);
    expect(resultA.publication).toEqual(commitResult.publication);
    expect(commitResult.outcomes.map((o) => o.status)).toEqual(['accepted', 'accepted']);

    // Identical repository state: same accepted heads AND same archived
    // revisions (deterministic ids/clock + warm-up make them byte-identical).
    for (const eventId of ['E1', 'E2']) {
      const headA = await executionA.readAcceptedScene({ projectId: PROJECT_ID, eventId });
      const headB = await executionB.readAcceptedScene({ projectId: PROJECT_ID, eventId });
      expect(headA).not.toBeNull();
      expect(headB).not.toBeNull();
      if (headA === null || headB === null) {
        throw new Error(`Expected accepted heads for ${eventId}`);
      }
      expect(headB.value).toEqual(headA.value);
      const revisionA = await executionA.readSceneRevision({
        projectId: PROJECT_ID,
        eventId,
        revisionId: headA.value.revisionId,
      });
      const revisionB = await executionB.readSceneRevision({
        projectId: PROJECT_ID,
        eventId,
        revisionId: headB.value.revisionId,
      });
      expect(revisionA).not.toBeNull();
      expect(revisionB).not.toBeNull();
      if (revisionA === null || revisionB === null) {
        throw new Error(`Expected archived revisions for ${eventId}`);
      }
      expect(revisionB.value).toEqual(revisionA.value);
    }

    // Same per-scene decisions/revision ids the facade mapped into results.
    for (const scene of resultA.results) {
      expect(commitResult.decisions.get(scene.eventId)).toEqual(scene.releaseDecision);
      expect(commitResult.revisionIds.get(scene.eventId)).toBe(scene.revisionId);
      expect(commitResult.sceneDispositions.get(scene.eventId)).toBe(scene.disposition);
    }

    // Operation completion is facade-only: the split path never writes one.
    expect(
      await executionB.readOperation({
        projectId: PROJECT_ID,
        operationId: request.mutation.operationId,
      }),
    ).toBeNull();
    expect(
      await executionA.readOperation({
        projectId: PROJECT_ID,
        operationId: request.mutation.operationId,
      }),
    ).not.toBeNull();
  });

  it('head moved between candidate compute and commit → stale commit, head untouched, revision retained', async () => {
    const src = source(['E1']);
    const execution = new ConcurrentHeadExecutionRepository();
    await seedAcceptedBase(execution, src.sourceHash);
    const provider = new MockPass2Provider({ entries: { E1: entry('E1', REVISED_PROSE) } });
    const runtime: EditorialRuntime = { provider, services: services(provider, execution) };

    const outcome = await executeEditorialCandidates(
      {
        version: 1,
        source: src,
        revision: { instruction: 'Make it stronger.' },
        mutation: { operationId: '0000000b-000b-400b-800b-00000000000b', actorId: 'test' },
        model: 'mock-pass2',
      },
      runtime,
    );
    expect(outcome.kind).toBe('candidates');
    if (outcome.kind !== 'candidates') return;
    const candidateSet = outcome.candidateSet;
    expect(candidateSet.commits).toHaveLength(1);
    const commit = candidateSet.commits[0];
    if (commit === undefined) {
      throw new Error('Expected one commit entry');
    }
    expect(commit.expectedVersion).toBe(1);

    // The revision archive happened in the candidate phase (append-only).
    const archived = await execution.readSceneRevision({
      projectId: PROJECT_ID,
      eventId: 'E1',
      revisionId: commit.revisionId,
    });
    expect(archived).not.toBeNull();

    // A concurrent writer wins the head between compute and commit.
    execution.armConcurrentHead();
    const commitResult = await commitEditorialCandidates(candidateSet, runtime);

    expect(commitResult.stale).toBe(true);
    expect(commitResult.outcomes).toEqual([
      { eventId: 'E1', status: 'conflict', revisionId: commit.revisionId },
    ]);
    expect(commitResult.publication.status).toBe('stale');
    expect(commitResult.editorialErrors.some((e) => e.code === 'STORAGE_CONFLICT')).toBe(true);
    expect(commitResult.decisions.get('E1')?.status).toBe('blocked');
    expect(commitResult.sceneDispositions.get('E1')).toBe('candidate_stale');
    expect(commitResult.revisionIds.get('E1')).toBeNull();

    // The concurrent head survives verbatim — the stale candidate never won.
    const head = await execution.readAcceptedScene({ projectId: PROJECT_ID, eventId: 'E1' });
    expect(head).not.toBeNull();
    if (head === null) {
      throw new Error('Expected the concurrent accepted head');
    }
    expect(head.revision).toBe(2);
    expect(head.value.prose).toBe(PROSE_C);
    expect(head.value.revisionId).toBe('concurrent-revision');

    // The appended candidate revision is retained as an auditable stale
    // candidate — it is never deleted by the failed commit.
    const retained = await execution.readSceneRevision({
      projectId: PROJECT_ID,
      eventId: 'E1',
      revisionId: commit.revisionId,
    });
    expect(retained).not.toBeNull();
    if (retained === null) {
      throw new Error('Expected the stale candidate revision to be retained');
    }
    expect(retained.value.value.revisionId).toBe(commit.revisionId);
  });

  it('stale-source accepted head blocks explicit revise with NO_ACCEPTED_BASE', async () => {
    const src = source(['E1']);
    const execution = new MemoryExecutionRepository();
    // Accepted head bound to an OLDER source hash than the render request.
    await execution.compareAndSwapAcceptedScene({
      projectId: PROJECT_ID,
      eventId: 'E1',
      expectedVersion: null,
      value: {
        version: 1,
        projectId: PROJECT_ID,
        eventId: 'E1',
        sourceHash: 'old-source-hash',
        revisionId: 'rev-old',
        prose: BASE_PROSE,
        proseHash: sha(BASE_PROSE),
        sceneHash: sha(BASE_PROSE),
      },
    });
    const provider = new MockPass2Provider({ entries: { E1: entry('E1', REVISED_PROSE) } });
    const calls = trackCalls(provider);
    const runtime: EditorialRuntime = { provider, services: services(provider, execution) };

    const result = await executeEditorialRender(
      {
        version: 1,
        source: src,
        revision: { instruction: 'Rewrite the opening.' },
        mutation: { operationId: '0000000c-000c-400c-800c-00000000000c', actorId: 'test' },
        model: 'mock-pass2',
      },
      runtime,
    );

    expect(result.editorialErrors).toHaveLength(1);
    expect(result.editorialErrors[0]?.code).toBe('NO_ACCEPTED_BASE');
    expect(result.editorialErrors[0]?.eventId).toBe('E1');
    expect(calls()).toBe(0);
    // The stale-source head was never treated as a base.
    const head = await execution.readAcceptedScene({ projectId: PROJECT_ID, eventId: 'E1' });
    expect(head?.value.revisionId).toBe('rev-old');
  });

  it('in-run candidate scenes never appear as repository accepted heads before commit', async () => {
    const src = source(['E1', 'E2'], serial(['E1', 'E2']));
    const execution = new MemoryExecutionRepository();
    const provider = new MockPass2Provider({ entries: { E1: entry('E1'), E2: entry('E2') } });
    const runtime: EditorialRuntime = { provider, services: services(provider, execution) };

    const outcome = await executeEditorialCandidates(
      {
        version: 1,
        source: src,
        mutation: { operationId: '0000000d-000d-400d-800d-00000000000d', actorId: 'test' },
        model: 'mock-pass2',
      },
      runtime,
    );
    expect(outcome.kind).toBe('candidates');
    if (outcome.kind !== 'candidates') return;
    const candidateSet = outcome.candidateSet;

    // E2 consumed E1's in-run candidate via the in-memory acceptedByEventId
    // map: both scenes have accepted decisions + commit entries, so E2 was
    // NOT blocked by a missing repository predecessor.
    expect(candidateSet.decisions.get('E1')?.status).toBe('accepted');
    expect(candidateSet.decisions.get('E2')?.status).toBe('accepted');
    expect(candidateSet.commits.map((c) => c.eventId)).toEqual(['E1', 'E2']);

    // Before commit: no accepted heads exist in the repository...
    expect(await execution.readAcceptedScene({ projectId: PROJECT_ID, eventId: 'E1' })).toBeNull();
    expect(await execution.readAcceptedScene({ projectId: PROJECT_ID, eventId: 'E2' })).toBeNull();

    // ...but the append-only revisions ARE archived already.
    for (const commit of candidateSet.commits) {
      const revision = await execution.readSceneRevision({
        projectId: PROJECT_ID,
        eventId: commit.eventId,
        revisionId: commit.revisionId,
      });
      expect(revision).not.toBeNull();
    }

    // Commit promotes both heads.
    const commitResult = await commitEditorialCandidates(candidateSet, runtime);
    expect(commitResult.stale).toBe(false);
    expect(commitResult.outcomes.map((o) => o.status)).toEqual(['accepted', 'accepted']);
    const head1 = await execution.readAcceptedScene({ projectId: PROJECT_ID, eventId: 'E1' });
    const head2 = await execution.readAcceptedScene({ projectId: PROJECT_ID, eventId: 'E2' });
    expect(head1?.value.revisionId).toBe('rev-0001');
    expect(head2?.value.revisionId).toBe('rev-0002');
    expect(head1?.value.prose).toBe(text('E1'));
    expect(head2?.value.prose).toBe(text('E2'));
  });
});
