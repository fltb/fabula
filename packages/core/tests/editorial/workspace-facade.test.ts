import * as crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  EditorialOperationError,
  MockPass2Provider,
  MemoryStorage,
  ProjectTransactionCoordinator,
  SceneRevisionStore,
  addReviewComment,
  adoptSceneProse,
  getSceneRevision,
  inspectScenes,
  listReviewComments,
  listSceneRevisions,
  resolveProjectPaths,
  applySourceChange,
  getEditorialOperation,
  getSourceDocument,
  listEditorialOperations,
  listSourceDocuments,
  listSourceRevisions,
  previewSourceChange,
  reconcileSourceWorkingCopy,
  replaceReviewComment,
  rollbackSceneRevision,
  setSceneLock,
  updateReviewComment,
} from '../../src/index.ts';
import type {
  SourceChangeSetV1,
  SceneRevisionEnvelopeV1,
  SourceDocumentV1,
} from '../../src/index.ts';

const PROJECT = '/public-workspace-project';

function seedProject(storage: MemoryStorage): void {
  storage.write(
    `${PROJECT}/nova.yaml`,
    'project: public-workspace\nschemaVersion: 1\ntitle: "Public Workspace"\nauthor: "Tester"\n',
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
    `${PROJECT}/chapters/chapter_01/_chapter.yaml`,
    'chapter: 1\ntitle: "Opening"\nsummary: "Alice begins."\nintent: "Setup"\nplannedScenes: 1\n',
  );
  storage.write(
    `${PROJECT}/chapters/chapter_01/E001.yaml`,
    'event: E001\nformatVersion: 1\nnarrativeOrder: 1\ntitle: "Opening"\nstoryTime: "day 1"\nsceneBrief: "Alice begins."\npov:\n  character: alice\n  type: third_person_limited\npreconditions: []\nexpectedPostconditions: []\n',
  );
  // discourse-ledger.yaml (mandatory reader-order source)
  storage.write(
    `${PROJECT}/definitions/discourse-ledger.yaml`,
    [
      'id: workspace-ledger',
      'chapters:',
      '  - branch: main',
      '    chapter: 1',
      '    sceneIds:',
      '      - E001',
      'entries: []',
    ].join('\n'),
  );
}

function projectHash(documents: readonly SourceDocumentV1[]): string {
  const hash = crypto.createHash('sha256');
  for (const document of [...documents].sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(`${document.path}\0${document.contentHash}\0`);
  }
  return hash.digest('hex');
}

function replacementChange(document: SourceDocumentV1): SourceChangeSetV1 {
  return {
    version: 1,
    expectedProjectSourceHash: '',
    changes: [{
      type: 'put',
      path: document.path,
      expectedHash: document.contentHash,
      content: document.content.replace('Alice', 'Alicia'),
    }],
  };
}

function seedAcceptedScene(storage: MemoryStorage): SceneRevisionEnvelopeV1 {
  const paths = resolveProjectPaths(PROJECT);
  const prose = 'Accepted raw prose.';
  const contentHash = (value: string): string =>
    crypto.createHash('sha256').update(value).digest('hex');
  const proseHash = contentHash(prose);
  const scopeHash = contentHash('scope');
  const revision: SceneRevisionEnvelopeV1 = {
    version: 1,
    revisionId: crypto.randomUUID(),
    parentRevisionId: null,
    operationId: crypto.randomUUID(),
    planHash: contentHash('plan'),
    actorId: 'renderer',
    eventId: 'E001',
    origin: 'llm_draft',
    prose,
    proseHash,
    sceneHash: proseHash,
    editorialBasisHash: contentHash('basis'),
    scopeHash,
    validationIdentity: 'validator-v1',
    feedbackHash: null,
    reviewIds: [],
    analysis: {
      eventId: 'E001',
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
          estimatedWordCount: 3,
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
    },
    validation: { passed: true, errors: [], warnings: [], infos: [] },
    releaseDecision: {
      status: 'accepted',
      scopeHash,
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
    promptHash: contentHash('prompt'),
    providerCalls: [],
    promotionReadSet: [],
    requestRecords: [],
    createdAt: '2026-07-28T00:00:00.000Z',
  };
  new SceneRevisionStore(
    new ProjectTransactionCoordinator(storage, paths),
    paths,
  ).archiveAndUpdateLatest(revision, null);
  storage.write(`${PROJECT}/scenes/chapter-01/E001.md`, prose);
  storage.write(
    `${PROJECT}/scenes/chapter-01/E001.yaml`,
    `schema_version: 1\nevent: E001\nnarrative_order: 1\nrevision_id: ${revision.revisionId}\nprose_source: llm\nprose_hash: ${revision.proseHash}\nscene_hash: ${revision.sceneHash}\neditorial_basis_hash: ${revision.editorialBasisHash}\nscope_hash: ${revision.scopeHash}\nvalidation_identity: ${revision.validationIdentity}\nrendered_at: \"${revision.createdAt}\"\nword_count: 3\ntext_count_version: 1\nedit_history: []\nbranch_existence:\n  type: all\n`,
  );
  return revision;
}

describe('root editorial workspace facade', () => {
  it('lists and gets source documents as JSON-safe read-only DTOs', async () => {
    const storage = new MemoryStorage();
    seedProject(storage);
    const before = (storage as unknown as { files: Map<string, string> }).files.size;

    const documents = await listSourceDocuments({ projectDir: PROJECT }, { storage });
    const alice = await getSourceDocument(
      { projectDir: PROJECT, path: 'definitions/characters/alice.yaml' },
      { storage },
    );

    expect(documents.map((document) => document.path)).toContain(alice.path);
    expect(alice.tracked).toBe(false);
    expect(JSON.parse(JSON.stringify(alice))).toEqual(alice);
    expect((storage as unknown as { files: Map<string, string> }).files.size).toBe(before);
  });

  it('previews deterministically with zero writes', async () => {
    const storage = new MemoryStorage();
    seedProject(storage);
    const documents = await listSourceDocuments({ projectDir: PROJECT }, { storage });
    const alice = documents.find((document) => document.path.endsWith('/alice.yaml'))!;
    const changeSet = replacementChange(alice);
    changeSet.expectedProjectSourceHash = projectHash(documents);
    const before = (storage as unknown as { files: Map<string, string> }).files.size;

    const first = await previewSourceChange({ projectDir: PROJECT, changeSet }, { storage });
    const second = await previewSourceChange({ projectDir: PROJECT, changeSet }, { storage });

    expect(second).toEqual(first);
    expect(first.validation.valid).toBe(true);
    expect((storage as unknown as { files: Map<string, string> }).files.size).toBe(before);
  });

  it('applies one browser session and rejects another stale preview', async () => {
    const storage = new MemoryStorage();
    seedProject(storage);
    const documents = await listSourceDocuments({ projectDir: PROJECT }, { storage });
    const alice = documents.find((document) => document.path.endsWith('/alice.yaml'))!;
    const changeSet = replacementChange(alice);
    changeSet.expectedProjectSourceHash = projectHash(documents);
    const previewA = await previewSourceChange({ projectDir: PROJECT, changeSet }, { storage });
    const previewB = await previewSourceChange({ projectDir: PROJECT, changeSet }, { storage });
    const mutationA = { operationId: crypto.randomUUID(), actorId: 'browser-a' };

    const applied = await applySourceChange(
      { projectDir: PROJECT, preview: previewA, mutation: mutationA },
      { storage },
    );
    await expect(
      applySourceChange(
        {
          projectDir: PROJECT,
          preview: previewB,
          mutation: { operationId: crypto.randomUUID(), actorId: 'browser-b' },
        },
        { storage },
      ),
    ).rejects.toMatchObject({ code: 'STORAGE_CONFLICT' });

    expect(storage.read(`${PROJECT}/${alice.path}`)).toBe(changeSet.changes[0].type === 'put'
      ? changeSet.changes[0].content
      : '');
    expect(listSourceRevisions({ projectDir: PROJECT }, { storage })).toHaveLength(2);
    expect(getEditorialOperation(
      { projectDir: PROJECT, operationId: mutationA.operationId },
      { storage },
    ).result).toEqual(applied);
    expect(listEditorialOperations({ projectDir: PROJECT }, { storage })).toHaveLength(1);
  });

  it('reconciles an external edit and updates document tracking', async () => {
    const storage = new MemoryStorage();
    seedProject(storage);
    const baselineMutation = { operationId: crypto.randomUUID(), actorId: 'reconciler' };
    await reconcileSourceWorkingCopy(
      { projectDir: PROJECT, mutation: baselineMutation },
      { storage },
    );
    storage.write(
      `${PROJECT}/definitions/characters/alice.yaml`,
      'id: alice\nname: "Alice External"\ntype: human\ndescription: "Protagonist"\ninitialState: {}\ntraits: []\n',
    );
    const untracked = await getSourceDocument(
      { projectDir: PROJECT, path: 'definitions/characters/alice.yaml' },
      { storage },
    );
    expect(untracked.tracked).toBe(false);

    const result = await reconcileSourceWorkingCopy(
      {
        projectDir: PROJECT,
        mutation: { operationId: crypto.randomUUID(), actorId: 'reconciler' },
      },
      { storage },
    );
    const tracked = await getSourceDocument(
      { projectDir: PROJECT, path: 'definitions/characters/alice.yaml' },
      { storage },
    );
    expect(result?.changedDocuments.map((document) => document.path)).toEqual([
      'definitions/characters/alice.yaml',
    ]);
    expect(tracked.tracked).toBe(true);
    expect(tracked.sourceRevisionId).toBe(result?.sourceRevisionId);
  });

  it('throws the public not-found error for a missing source document', async () => {
    const storage = new MemoryStorage();
    seedProject(storage);
    await expect(
      getSourceDocument({ projectDir: PROJECT, path: 'definitions/items/missing.yaml' }, { storage }),
    ).rejects.toBeInstanceOf(EditorialOperationError);
  });

  it('inspects accepted scenes and immutable history through root exports', async () => {
    const storage = new MemoryStorage();
    seedProject(storage);
    const revision = seedAcceptedScene(storage);

    const [inspection] = await inspectScenes(
      {
        version: 1,
        projectDir: PROJECT,
        selector: { type: 'events', eventIds: ['E001'] },
      },
      { storage },
    );
    expect(inspection.state).toBe('current');
    expect(inspection.prose).toBe(revision.prose);
    expect(inspection.sceneContent).toBe(revision.prose);
    expect(inspection.artifactPaths.scene).toBe('scenes/chapter-01/E001.md');

    const history = listSceneRevisions(
      { projectDir: PROJECT, eventId: 'E001' },
      { storage },
    );
    expect(history).toHaveLength(1);
    expect(history[0].isHead).toBe(true);
    expect(getSceneRevision(
      { projectDir: PROJECT, eventId: 'E001', revisionId: revision.revisionId },
      { storage },
    )).toEqual(revision);
  });

  it('adopts, locks, unlocks, and rolls back through root actions', async () => {
    const storage = new MemoryStorage();
    seedProject(storage);
    const original = seedAcceptedScene(storage);
    const provider = new MockPass2Provider({
      entries: {
        E001: {
          prose: 'unused-pass1-prose',
          analysis: original.analysis!,
        },
      },
    });
    const adopted = await adoptSceneProse(
      {
        version: 1,
        projectDir: PROJECT,
        eventId: 'E001',
        input: {
          type: 'replacement',
          prose: 'Human-authored replacement prose.',
          expectedRevisionId: original.revisionId,
          expectedSceneHash: original.sceneHash,
        },
        mutation: { operationId: crypto.randomUUID(), actorId: 'browser-editor' },
        model: 'mock-pass2',
        lockAfter: true,
      },
      { storage, provider },
    );
    expect(adopted.promoted).toBe(true);
    expect(adopted.locked).toBe(true);
    expect(adopted.proseSource).toBe('human_locked');
    const adoptedRevision = getSceneRevision({
      projectDir: PROJECT,
      eventId: 'E001',
      revisionId: adopted.revisionId!,
    }, { storage });
    expect(adoptedRevision.prose).toBe('Human-authored replacement prose.');
    expect(adoptedRevision.llmPass1.totalTokens).toBe(0);
    expect(
      adoptedRevision.providerCalls.every((call) => call.phase !== 'pass1'),
    ).toBe(true);

    const unlocked = await setSceneLock(
      {
        version: 1,
        projectDir: PROJECT,
        eventId: 'E001',
        locked: false,
        expectedSceneHash: adopted.sceneHash!,
        mutation: { operationId: crypto.randomUUID(), actorId: 'browser-editor' },
      },
      { storage },
    );
    expect(unlocked.publication.status).toBe('unchanged');
    expect(unlocked.locked).toBe(false);
    expect(unlocked.proseSource).toBe('human_edited');

    const rolledBack = await rollbackSceneRevision(
      {
        version: 1,
        projectDir: PROJECT,
        eventId: 'E001',
        revisionId: original.revisionId,
        mutation: { operationId: crypto.randomUUID(), actorId: 'browser-editor' },
        model: 'mock-pass2',
      },
      {
        storage,
        provider: new MockPass2Provider({
          entries: {
            E001: {
              prose: 'unused-pass1-prose',
              analysis: original.analysis!,
            },
          },
        }),
      },
    );
    expect(rolledBack.promoted).toBe(true);
    expect(
      getSceneRevision({
        projectDir: PROJECT,
        eventId: 'E001',
        revisionId: rolledBack.revisionId!,
      }, { storage }).restoredFromRevisionId,
    ).toBe(original.revisionId);
  });

  it('persists review add/replace/status with audit chains and idempotent operations', () => {
    const storage = new MemoryStorage();
    seedProject(storage);
    const addMutation = {
      operationId: crypto.randomUUID(),
      actorId: 'browser-reviewer',
    };
    const input = {
      target: { type: 'scene' as const, id: 'E001' },
      severity: 'suggestion' as const,
      category: 'style' as const,
      content: 'Use a quieter opening.',
    };
    const added = addReviewComment(
      { projectDir: PROJECT, input, mutation: addMutation },
      { storage },
    );
    expect(addReviewComment(
      { projectDir: PROJECT, input, mutation: addMutation },
      { storage },
    )).toEqual(added);

    const replacement = replaceReviewComment(
      {
        projectDir: PROJECT,
        commentId: added.id,
        input: { ...input, content: 'Use a quieter, shorter opening.' },
        mutation: {
          operationId: crypto.randomUUID(),
          actorId: 'browser-reviewer',
        },
      },
      { storage },
    );
    const reviews = listReviewComments({ projectDir: PROJECT }, { storage });
    expect(reviews).toHaveLength(2);
    expect(reviews.find((review) => review.id === added.id)?.status)
      .toBe('superseded');
    expect(replacement.supersedesId).toBe(added.id);

    const resolved = updateReviewComment(
      {
        projectDir: PROJECT,
        commentId: replacement.id,
        action: 'resolve',
        mutation: {
          operationId: crypto.randomUUID(),
          actorId: 'browser-reviewer',
        },
      },
      { storage },
    );
    expect(resolved.status).toBe('resolved');
    expect(getEditorialOperation(
      {
        projectDir: PROJECT,
        operationId: addMutation.operationId,
      },
      { storage },
    ).result).toEqual(added);
  });
});
