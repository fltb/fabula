// ============================================================================
// EditorialWorkspace — custom output directory tests
//
// Verifies that with a custom outputDir (e.g. "my-work"):
//   - All artifact paths (responses, revisions, source-head, operations,
//     transactions, conflicts, traces, dry-runs, derived, publication)
//     resolve under the configured workDir.
//   - No files are written to the default .nova/ directory.
//   - The workspace remains strictly read-only.
// ============================================================================

import { describe, expect, it } from 'vitest';
import * as crypto from 'node:crypto';
import { MemoryStorage } from '../../src/storage/memory-storage.ts';
import { computeContentHash } from '../../src/storage/hash.ts';
import { getEditorialWorkspace } from '../../src/editorial/workspace.ts';
import { resolveProjectPaths } from '../../src/editorial/paths.ts';
import { stableJson } from '../../src/editorial/transaction.ts';

// ─── Constants ──────────────────────────────────────────────────────────────

const PROJECT = '/test-project';
const CUSTOM_DIR = 'my-work';

function sha256Hex(): string {
  return crypto.randomBytes(32).toString('hex');
}

function uuid(): string {
  return crypto.randomUUID();
}

/** Verify that a path is contained within the custom workDir and avoids .nova. */
function assertInCustomDir(workDir: string, artifactPath: string): void {
  expect(artifactPath).toContain(workDir);
  expect(artifactPath).not.toContain('.nova');
}

/** Count files stored in a MemoryStorage. */
function countStorageFiles(storage: MemoryStorage): number {
  const s = storage as unknown as { files: Map<string, string> };
  return s.files?.size ?? 0;
}

/** Seed minimal project data into the custom workDir with schema-valid values. */
function seedCustomProject(storage: MemoryStorage, outputDir: string): void {
  const paths = resolveProjectPaths(PROJECT, outputDir);
  const ph = sha256Hex;
  const prose = '# Scene Content\n';
  const proseHash = computeContentHash(prose);
  const revisionId = uuid();
  const revisionOperationId = uuid();
  const scopeHash = ph();
  const basisHash = ph();
  const envelope = {
    version: 1,
    revisionId,
    parentRevisionId: null,
    operationId: revisionOperationId,
    planHash: ph(),
    actorId: 'actor',
    eventId: 'E001',
    origin: 'llm_draft',
    prose,
    proseHash,
    sceneHash: proseHash,
    editorialBasisHash: basisHash,
    scopeHash,
    validationIdentity: 'vi',
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
      },
    },
    validation: { passed: true, errors: [], warnings: [], infos: [] },
    releaseDecision: {
      status: 'accepted',
      scopeHash,
      validationIdentity: 'vi',
      reasons: [],
    },
    released: true,
    cacheHit: false,
    errors: [],
    llmPass1: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    llmPass2: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    attempts: 1,
    needsReview: false,
    promptHash: ph(),
    providerCalls: [],
    promotionReadSet: [],
    requestRecords: [],
    createdAt: '2026-07-28T00:00:00.000Z',
  };

  storage.write(`${PROJECT}/nova.yaml`, 'title: "Test"\n');
  storage.write(`${PROJECT}/chapters/chapter_01/E001.yaml`, 'event: E001\n');
  storage.write(`${PROJECT}/scenes/chapter-01/E001.md`, prose);
  storage.write(`${PROJECT}/scenes/chapter-01/E001.yaml`,
    `schema_version: 1\nevent: E001\nnarrative_order: 1\nrevision_id: ${revisionId}\nprose_source: llm\nprose_hash: ${proseHash}\nscene_hash: ${proseHash}\neditorial_basis_hash: ${basisHash}\nscope_hash: ${scopeHash}\nvalidation_identity: vi\nrendered_at: \"2026-07-28T00:00:00.000Z\"\nword_count: 3\ntext_count_version: 1\nedit_history: []\nbranch_existence:\n  type: all\n`);
  storage.write(`${paths.responsesDir}/E001.json`, stableJson(envelope));
  storage.write(
    `${paths.sceneRevisionsDir}/E001/${revisionId}.json`,
    stableJson(envelope),
  );

  const sourceRevisionId = uuid();
  const sourceOperationId = uuid();
  const projectHash = ph();
  storage.write(paths.sourceHeadPath, stableJson({
    version: 1,
    revisionId: sourceRevisionId,
    projectSourceHash: projectHash,
    documents: { 'nova.yaml': computeContentHash('title: "Test"\n') },
  }));
  storage.write(`${paths.sourceRevisionsDir}/${sourceRevisionId}.json`, stableJson({
    version: 1,
    revisionId: sourceRevisionId,
    parentRevisionId: null,
    operationId: sourceOperationId,
    actorId: 'actor',
    origin: 'api_edit',
    projectBeforeHash: ph(),
    projectAfterHash: projectHash,
    changeSetHash: ph(),
    documents: [{
      path: 'nova.yaml',
      beforeHash: null,
      afterHash: computeContentHash('title: "Test"\n'),
      beforeContent: null,
      afterContent: 'title: "Test"\n',
    }],
    affectedEventIds: [],
    createdAt: '2026-07-28T00:00:00.000Z',
  }));

  const operationId = uuid();
  storage.write(`${paths.operationsDir}/${operationId}.json`, stableJson({
    version: 1,
    operationId,
    kind: 'render',
    actorId: 'actor',
    requestHash: ph(),
    status: 'succeeded',
    startedAt: '2026-07-28T00:00:00.000Z',
    heartbeatAt: '2026-07-28T00:05:00.000Z',
    leaseExpiresAt: '2026-07-28T00:30:00.000Z',
    lastSequence: 1,
    completedAt: '2026-07-28T00:10:00.000Z',
    result: null,
    errors: [],
  }));
  storage.write(`${paths.transactionsDir}/tx-001.json`, stableJson({
    transactionId: 'tx-001',
    writes: [],
  }));
  storage.write(`${paths.conflictsDir}/conflict-001.json`, stableJson({
    version: 1,
    operationId,
    recoveredAt: '2026-07-28T00:00:00.000Z',
    reason: 'test',
  }));
  storage.write(`${paths.tracesDir}/trace-001.json`, stableJson({
    operationId,
    events: [],
  }));
  storage.write(`${paths.dryRunsDir}/op-001_prompt.md`, '# Dry run prompt\n');
  storage.write(`${paths.derivedDir}/derived-001.json`, stableJson({ key: 'value' }));
  storage.write(paths.publicationPath, stableJson({
    version: 1,
    status: 'current',
    branch_scope_hash: scopeHash,
    novel_hash: ph(),
    revision_ids: { E001: revisionId },
    last_assembled_at: '2026-07-28T00:10:00.000Z',
    reasons: [],
  }));
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('EditorialWorkspace — custom output directory', () => {
  it('resolves paths under custom workDir', () => {
    const paths = resolveProjectPaths(PROJECT, CUSTOM_DIR);

    expect(paths.workDir).toBe(`${PROJECT}/${CUSTOM_DIR}`);

    assertInCustomDir(paths.workDir, paths.responsesDir);
    assertInCustomDir(paths.workDir, paths.sceneRevisionsDir);
    assertInCustomDir(paths.workDir, paths.sourceRevisionsDir);
    assertInCustomDir(paths.workDir, paths.operationsDir);
    assertInCustomDir(paths.workDir, paths.transactionsDir);
    assertInCustomDir(paths.workDir, paths.conflictsDir);
    assertInCustomDir(paths.workDir, paths.tracesDir);
    assertInCustomDir(paths.workDir, paths.dryRunsDir);
    assertInCustomDir(paths.workDir, paths.derivedDir);
    assertInCustomDir(paths.workDir, paths.renderCacheDir);
    assertInCustomDir(paths.workDir, paths.renderPlansDir);
    assertInCustomDir(paths.workDir, paths.snapshotsDir);
    assertInCustomDir(paths.workDir, paths.publicationPath);
    assertInCustomDir(paths.workDir, paths.sourceHeadPath);
  });

  it('uses default .nova paths when no custom dir given', () => {
    const paths = resolveProjectPaths(PROJECT);
    expect(paths.workDir).toBe(`${PROJECT}/.nova`);
    expect(paths.responsesDir).toContain('.nova');
    expect(paths.operationsDir).toContain('.nova');
    expect(paths.sourceHeadPath).toContain('.nova');
  });

  it('stores responses in custom workDir (not .nova)', () => {
    const storage = new MemoryStorage();
    seedCustomProject(storage, CUSTOM_DIR);
    const ws = getEditorialWorkspace(PROJECT, CUSTOM_DIR, storage);

    const scene = ws.inspectScene('E001');
    expect(scene.artifactPaths.latestResponse).toContain(CUSTOM_DIR);
    expect(scene.artifactPaths.latestResponse).not.toContain('.nova');
  });

  it('stores revisions in custom workDir', () => {
    const storage = new MemoryStorage();
    seedCustomProject(storage, CUSTOM_DIR);
    const ws = getEditorialWorkspace(PROJECT, CUSTOM_DIR, storage);

    const scene = ws.inspectScene('E001');
    if (scene.artifactPaths.revision) {
      expect(scene.artifactPaths.revision).toContain(CUSTOM_DIR);
      expect(scene.artifactPaths.revision).not.toContain('.nova');
    }
  });

  it('reads source head from custom workDir', () => {
    const storage = new MemoryStorage();
    seedCustomProject(storage, CUSTOM_DIR);
    const ws = getEditorialWorkspace(PROJECT, CUSTOM_DIR, storage);

    const head = ws.getSourceHead();
    expect(head).not.toBeNull();
    expect(head!.projectSourceHash).toBeTruthy();
  });

  it('lists operations from custom workDir', () => {
    const storage = new MemoryStorage();
    seedCustomProject(storage, CUSTOM_DIR);
    const ws = getEditorialWorkspace(PROJECT, CUSTOM_DIR, storage);

    const ops = ws.listOperations();
    expect(ops.length).toBe(1);
  });

  it('reads publication from custom workDir', () => {
    const storage = new MemoryStorage();
    seedCustomProject(storage, CUSTOM_DIR);
    const ws = getEditorialWorkspace(PROJECT, CUSTOM_DIR, storage);

    const pub = ws.getPublication();
    expect(pub.status).toBe('current');
    expect(pub.revision_ids).toHaveProperty('E001');
  });

  it('persists no writes to .nova when reading from custom dir', () => {
    const storage = new MemoryStorage();
    seedCustomProject(storage, CUSTOM_DIR);

    expect(storage.exists(`${PROJECT}/.nova`)).toBe(false);

    const ws = getEditorialWorkspace(PROJECT, CUSTOM_DIR, storage);

    ws.listSources();
    ws.getSource('nova.yaml');
    ws.listSourceRevisions();
    ws.getSourceHead();
    ws.listScenes();
    ws.inspectScene('E001');
    ws.listOperations();
    ws.getPublication();
    ws.snapshot();
    ws.inspectLegacyScene('E001');

    expect(storage.exists(`${PROJECT}/.nova`)).toBe(false);
    expect(storage.exists(`${PROJECT}/.nova/responses`)).toBe(false);
  });

  it('no new files created during read-only queries', () => {
    const storage = new MemoryStorage();
    seedCustomProject(storage, CUSTOM_DIR);

    const before = countStorageFiles(storage);
    const ws = getEditorialWorkspace(PROJECT, CUSTOM_DIR, storage);

    ws.listSources();
    ws.getSource('nova.yaml');
    ws.listSourceRevisions();
    ws.getSourceHead();
    ws.listScenes();
    ws.inspectScene('E001');
    ws.listOperations();
    ws.getPublication();
    ws.snapshot();
    ws.inspectLegacyScene('E001');

    expect(countStorageFiles(storage)).toBe(before);
  });

  it('custom dir workspace survives JSON round-trip', () => {
    const storage = new MemoryStorage();
    seedCustomProject(storage, CUSTOM_DIR);
    const ws = getEditorialWorkspace(PROJECT, CUSTOM_DIR, storage);

    const snap = ws.snapshot();
    const json = JSON.stringify(snap);
    const parsed = JSON.parse(json);
    expect(parsed.scenes.length).toBe(1);
    expect(parsed.publication.status).toBe('current');
  });

  it('falls back to .nova response when custom response missing for legacy inspection', () => {
    const storage = new MemoryStorage();
    storage.write(`${PROJECT}/scenes/chapter-01/E001.yaml`,
      'schema_version: 1\nevent: "E001"\nnarrative_order: 1\nprose_source: "llm"\n');
    storage.write(`${PROJECT}/scenes/chapter-01/E001.md`, '# Match\n');
    storage.write(`${PROJECT}/chapters/chapter_01/E001.yaml`,
      'id: "E001"\nchoices:\n  - id: "c1"\n    label: "A"\n    description: "D"\n');
    storage.write(`${PROJECT}/.nova/responses/E001.json`, stableJson({
      version: 1,
      eventId: 'E001',
      revisionId: uuid(),
      prose: '# Match\n',
      playerChoices: [{ id: 'c1', label: 'A', description: 'D' }],
      releaseDecision: { status: 'accepted', scopeHash: sha256Hex(), validationIdentity: 'vi' },
      released: true,
      origin: 'llm_draft',
      proseHash: computeContentHash('# Match\n'),
      sceneHash: sha256Hex(),
      editorialBasisHash: sha256Hex(),
      scopeHash: sha256Hex(),
      validationIdentity: 'vi',
      analysis: null,
      validation: null,
      cacheHit: false,
      errors: [],
      feedbackHash: null,
      reviewIds: [],
      llmPass1: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      llmPass2: null,
      attempts: 1,
      needsReview: false,
      promptHash: sha256Hex(),
      providerCalls: [],
      promotionReadSet: [],
      requestRecords: [],
      createdAt: '2026-07-28T00:00:00.000Z',
    }));

    const ws = getEditorialWorkspace(PROJECT, CUSTOM_DIR, storage);
    const result = ws.inspectLegacyScene('E001');
    expect(result.migratable).toBe(true);
    expect(result.configuredResponse.exists).toBe(false);
    expect(result.historicalResponse.exists).toBe(true);
  });
});
