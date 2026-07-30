import * as crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AnalysisResult, EditorialRuntime, SceneRevisionEnvelopeV1 } from '../../src/index.ts';
import {
  adoptSceneProse,
  getEditorialOperation,
  getSceneRevision,
  inspectScenes,
  listSceneRevisions,
  MemoryStorage,
  MockPass2Provider,
  ProjectTransactionCoordinator,
  reconcileSourceWorkingCopy,
  resolveProjectPaths,
  rollbackSceneRevision,
  SceneRevisionStore,
  setSceneLock,
} from '../../src/index.ts';

const PROJECT = '/manual-edit-project';

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function seedProject(storage: MemoryStorage): void {
  storage.write(
    `${PROJECT}/nova.yaml`,
    'project: manual-edit\nschemaVersion: 1\ntitle: "Manual Edit"\nauthor: "Tester"\n',
  );
  storage.write(
    `${PROJECT}/definitions/state_initial.yaml`,
    'info:\n  currentEra: modern\n  politicalSituation: stable\nthreads: []\nworldFacts: []\n',
  );
  storage.write(
    `${PROJECT}/definitions/characters/alice.yaml`,
    'id: alice\nname: "Alice"\ntype: human\ndescription: "Protagonist"\ninitialState: {}\ntraits: []\n',
  );
  storage.write(
    `${PROJECT}/definitions/discourse-ledger.yaml`,
    [
      'id: manual_edit_test_ledger',
      'chapters:',
      '  - branch: main',
      '    chapter: 1',
      '    sceneIds:',
      '      - E001',
      'entries: []',
    ].join('\n'),
  );
  storage.write(
    `${PROJECT}/chapters/chapter_01/_chapter.yaml`,
    'chapter: 1\ntitle: "Opening"\nsummary: "Alice begins."\nintent: "Setup"\nplannedScenes: 1\n',
  );
  storage.write(
    `${PROJECT}/chapters/chapter_01/E001.yaml`,
    'event: E001\nformatVersion: 1\nnarrativeOrder: 1\ntitle: "Opening"\nstoryTime: "day 1"\nsceneBrief: "Alice begins."\npov:\n  character: alice\n  type: third_person_limited\npreconditions: []\nexpectedPostconditions: []\n',
  );
}

function acceptedAnalysis(eventId = 'E001'): AnalysisResult {
  return {
    eventId,
    analysis: {
      postconditions: { covered: [], dropped: [] },
      preconditions: { violated: [] },
      pov: { consistent: true, leaks: [] },
      inventedDetails: [],
      quality: {
        proseScore: 8,
        maxScore: 10,
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
    },
  };
}

function runtime(
  storage: MemoryStorage,
  analysis: AnalysisResult = acceptedAnalysis(),
): EditorialRuntime {
  return {
    storage,
    provider: new MockPass2Provider({
      entries: {
        E001: { prose: 'unused-pass1', analysis },
      },
    }),
  };
}

function seedAcceptedHead(
  storage: MemoryStorage,
  prose = 'Original accepted prose.',
): SceneRevisionEnvelopeV1 {
  const paths = resolveProjectPaths(PROJECT);
  const proseHash = hash(prose);
  const revision: SceneRevisionEnvelopeV1 = {
    version: 1,
    revisionId: crypto.randomUUID(),
    parentRevisionId: null,
    operationId: crypto.randomUUID(),
    planHash: hash('seed-plan'),
    actorId: 'seed',
    eventId: 'E001',
    origin: 'llm_draft',
    prose,
    proseHash,
    sceneHash: proseHash,
    editorialBasisHash: hash('seed-basis'),
    scopeHash: hash('seed-scope'),
    validationIdentity: 'validator-v1',
    feedbackHash: null,
    reviewIds: [],
    analysis: acceptedAnalysis(),
    validation: { passed: true, errors: [], warnings: [], infos: [] },
    releaseDecision: {
      status: 'accepted',
      scopeHash: hash('seed-scope'),
      validationIdentity: 'validator-v1',
      reasons: [],
    },
    released: true,
    cacheHit: false,
    errors: [],
    llmPass1: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    llmPass2: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    attempts: 1,
    needsReview: false,
    promptHash: hash('seed-prompt'),
    providerCalls: [],
    promotionReadSet: [
      {
        kind: 'file',
        path: resolveProjectPaths(PROJECT).sourceHeadPath,
        expectedHash: storage.exists(resolveProjectPaths(PROJECT).sourceHeadPath)
          ? hash(storage.read(resolveProjectPaths(PROJECT).sourceHeadPath))
          : null,
      },
    ],
    requestRecords: [],
    createdAt: new Date().toISOString(),
  };
  new SceneRevisionStore(
    new ProjectTransactionCoordinator(storage, paths),
    paths,
  ).archiveAndUpdateLatest(revision, null);
  storage.write(`${PROJECT}/scenes/chapter-01/E001.md`, prose);
  storage.write(
    `${PROJECT}/scenes/chapter-01/E001.yaml`,
    `schema_version: 1\nevent: E001\nnarrative_order: 1\nrevision_id: ${revision.revisionId}\nprose_source: llm\nprose_hash: ${revision.proseHash}\nscene_hash: ${revision.sceneHash}\neditorial_basis_hash: ${revision.editorialBasisHash}\nscope_hash: ${revision.scopeHash}\nvalidation_identity: ${revision.validationIdentity}\nrendered_at: "${revision.createdAt}"\nword_count: 3\ntext_count_version: 1\nedit_history: []\nbranch_existence:\n  type: all\n`,
  );
  return revision;
}

async function inspection(storage: MemoryStorage) {
  const [scene] = await inspectScenes(
    {
      version: 1,
      projectDir: PROJECT,
      selector: { type: 'events', eventIds: ['E001'] },
    },
    { storage },
  );
  return scene;
}

describe('public scene editorial actions', () => {
  it('evaluates replacement prose with Pass 1 skipped and promotes accepted output', async () => {
    const storage = new MemoryStorage();
    seedProject(storage);
    const original = seedAcceptedHead(storage);

    const operationId = crypto.randomUUID();
    const request = {
      version: 1 as const,
      projectDir: PROJECT,
      eventId: 'E001',
      input: {
        type: 'replacement' as const,
        prose: 'Human replacement prose.',
        expectedRevisionId: original.revisionId,
        expectedSceneHash: original.sceneHash,
      },
      mutation: { operationId, actorId: 'editor' },
      model: 'mock-pass2',
    };
    const result = await adoptSceneProse(request, runtime(storage));

    expect(result.promoted).toBe(true);
    expect(result.revisionId).not.toBeNull();
    if (result.revisionId === null) throw new Error('Expected promoted revision');
    const revision = getSceneRevision(
      {
        projectDir: PROJECT,
        eventId: 'E001',
        revisionId: result.revisionId,
      },
      { storage },
    );
    expect(revision.parentRevisionId).toBe(original.revisionId);
    expect(revision.origin).toBe('human_edit');
    expect(revision.prose).toBe('Human replacement prose.');
    expect(revision.llmPass1.totalTokens).toBe(0);
    expect(revision.providerCalls.every((call) => call.phase !== 'pass1')).toBe(true);
    expect(storage.read(`${PROJECT}/scenes/chapter-01/E001.md`)).toBe('Human replacement prose.');
    const replay = await adoptSceneProse(request, {
      storage,
      provider: {
        name: 'mock-pass2',
        complete: async () => {
          throw new Error('provider must not be called on idempotent replay');
        },
      },
    });
    expect(replay).toEqual(result);
    expect(
      getEditorialOperation(
        {
          projectDir: PROJECT,
          operationId,
        },
        { storage },
      ).result,
    ).toEqual(result);
  });

  it('adopts exact working-copy bytes and rejects stale working-copy hashes', async () => {
    const storage = new MemoryStorage();
    seedProject(storage);
    seedAcceptedHead(storage);
    const edited = 'Externally edited working copy.';
    storage.write(`${PROJECT}/scenes/chapter-01/E001.md`, edited);

    const stale = await adoptSceneProse(
      {
        version: 1,
        projectDir: PROJECT,
        eventId: 'E001',
        input: { type: 'working_copy', expectedSceneHash: hash('other') },
        mutation: { operationId: crypto.randomUUID(), actorId: 'editor' },
        model: 'mock-pass2',
      },
      runtime(storage),
    );
    expect(stale.editorialErrors[0].code).toBe('SCENE_CONTENT_CONFLICT');

    const adopted = await adoptSceneProse(
      {
        version: 1,
        projectDir: PROJECT,
        eventId: 'E001',
        input: { type: 'working_copy', expectedSceneHash: hash(edited) },
        mutation: { operationId: crypto.randomUUID(), actorId: 'editor' },
        model: 'mock-pass2',
      },
      runtime(storage),
    );
    expect(adopted.promoted).toBe(true);
    expect((await inspection(storage)).prose).toBe(edited);
  });

  it('rejects system choice markers in replacement prose before provider work', async () => {
    const storage = new MemoryStorage();
    seedProject(storage);
    const original = seedAcceptedHead(storage);
    const result = await adoptSceneProse(
      {
        version: 1,
        projectDir: PROJECT,
        eventId: 'E001',
        input: {
          type: 'replacement',
          prose: 'Draft\n<!-- FABULA:PLAYER_CHOICES:v1 -->',
          expectedRevisionId: original.revisionId,
          expectedSceneHash: original.sceneHash,
        },
        mutation: { operationId: crypto.randomUUID(), actorId: 'editor' },
        model: 'mock-pass2',
      },
      runtime(storage),
    );
    expect(result.promoted).toBe(false);
    expect(result.editorialErrors[0].code).toBe('INVALID_OPERATION');
    expect(listSceneRevisions({ projectDir: PROJECT, eventId: 'E001' }, { storage })).toHaveLength(
      1,
    );
  });

  it('locks and unlocks metadata without creating content revisions', async () => {
    const storage = new MemoryStorage();
    seedProject(storage);
    const original = seedAcceptedHead(storage);
    const lock = await setSceneLock(
      {
        version: 1,
        projectDir: PROJECT,
        eventId: 'E001',
        locked: true,
        expectedSceneHash: original.sceneHash,
        mutation: { operationId: crypto.randomUUID(), actorId: 'editor' },
      },
      { storage },
    );
    expect(lock.locked).toBe(true);
    expect(lock.publication.status).toBe('unchanged');
    expect((await inspection(storage)).proseSource).toBe('human_locked');

    const unlock = await setSceneLock(
      {
        version: 1,
        projectDir: PROJECT,
        eventId: 'E001',
        locked: false,
        expectedSceneHash: original.sceneHash,
        mutation: { operationId: crypto.randomUUID(), actorId: 'editor' },
      },
      { storage },
    );
    expect(unlock.locked).toBe(false);
    expect((await inspection(storage)).proseSource).toBe('human_edited');
    expect(listSceneRevisions({ projectDir: PROJECT, eventId: 'E001' }, { storage })).toHaveLength(
      1,
    );
  });

  it('marks a locked head stale after a tracked source change', async () => {
    const storage = new MemoryStorage();
    seedProject(storage);
    await reconcileSourceWorkingCopy(
      {
        projectDir: PROJECT,
        mutation: { operationId: crypto.randomUUID(), actorId: 'editor' },
      },
      { storage },
    );
    const original = seedAcceptedHead(storage);
    await setSceneLock(
      {
        version: 1,
        projectDir: PROJECT,
        eventId: 'E001',
        locked: true,
        expectedSceneHash: original.sceneHash,
        mutation: { operationId: crypto.randomUUID(), actorId: 'editor' },
      },
      { storage },
    );
    storage.write(
      `${PROJECT}/chapters/chapter_01/E001.yaml`,
      storage
        .read(`${PROJECT}/chapters/chapter_01/E001.yaml`)
        .replace('Alice begins.', 'Alice begins cautiously.'),
    );
    await reconcileSourceWorkingCopy(
      {
        projectDir: PROJECT,
        mutation: { operationId: crypto.randomUUID(), actorId: 'editor' },
      },
      { storage },
    );
    const stale = await inspection(storage);
    expect(stale.state).toBe('stale');
    expect(stale.staleReasons.some((reason) => reason.code === 'SCENE_LOCK_STALE')).toBe(true);
    const unlocked = await setSceneLock(
      {
        version: 1,
        projectDir: PROJECT,
        eventId: 'E001',
        locked: false,
        expectedSceneHash: original.sceneHash,
        mutation: { operationId: crypto.randomUUID(), actorId: 'editor' },
      },
      { storage },
    );
    expect(unlocked.locked).toBe(false);
    expect(unlocked.editorialErrors).toEqual([]);
  });

  it('reevaluates rollback prose and records parent/restored-from lineage', async () => {
    const storage = new MemoryStorage();
    seedProject(storage);
    const original = seedAcceptedHead(storage, 'Historical prose.');
    const adopted = await adoptSceneProse(
      {
        version: 1,
        projectDir: PROJECT,
        eventId: 'E001',
        input: {
          type: 'replacement',
          prose: 'New accepted prose.',
          expectedRevisionId: original.revisionId,
          expectedSceneHash: original.sceneHash,
        },
        mutation: { operationId: crypto.randomUUID(), actorId: 'editor' },
        model: 'mock-pass2',
      },
      runtime(storage),
    );
    const rollback = await rollbackSceneRevision(
      {
        version: 1,
        projectDir: PROJECT,
        eventId: 'E001',
        revisionId: original.revisionId,
        mutation: { operationId: crypto.randomUUID(), actorId: 'editor' },
        model: 'mock-pass2',
      },
      runtime(storage),
    );
    expect(rollback.promoted).toBe(true);
    expect(rollback.revisionId).not.toBeNull();
    if (rollback.revisionId === null) throw new Error('Expected rollback revision');
    const revision = getSceneRevision(
      {
        projectDir: PROJECT,
        eventId: 'E001',
        revisionId: rollback.revisionId,
      },
      { storage },
    );
    expect(revision.parentRevisionId).toBe(adopted.revisionId);
    expect(revision.restoredFromRevisionId).toBe(original.revisionId);
    expect(revision.origin).toBe('rollback');
    expect(revision.prose).toBe('Historical prose.');
  });
});
