// ============================================================================
// EditorialWorkspace — read-only query facade tests
//
// All tests use MemoryStorage with configured paths and deterministic data.
// No live LLM, filesystem, or network access.
// ============================================================================

import { describe, expect, it } from 'vitest';
import * as crypto from 'node:crypto';
import { MemoryStorage } from '../../src/storage/memory-storage.ts';
import { computeContentHash } from '../../src/storage/hash.ts';
import type { Storage } from '../../src/storage/types.ts';
import {
  EditorialWorkspace,
  getEditorialWorkspace,
  type LegacySceneInspection,
} from '../../src/editorial/workspace.ts';
import { QueryService } from '../../src/editorial/query-service.ts';
import { resolveProjectPaths } from '../../src/editorial/paths.ts';
import type { ProjectPaths } from '../../src/editorial/paths.ts';
import {
  ProjectTransactionCoordinator,
  stableJson,
} from '../../src/editorial/transaction.ts';
import type {
  EditorialOperationV1,
  PublicationManifestV1,
  SceneInspection,
  SourceHeadV1,
  SourceRevisionV1,
} from '../../src/types/editorial.ts';
import type { ReviewComment } from '../../src/types/review.ts';

// ─── Helpers ────────────────────────────────────────────────────────────────

const PROJECT = '/test-project';

function sha256Hex(): string {
  return crypto.randomBytes(32).toString('hex');
}

function uuid(): string {
  return crypto.randomUUID();
}

/** Seed a complete realistic project layout. */
function seedFullProject(storage: MemoryStorage, outputDir: string = '.nova'): void {
  const paths = resolveProjectPaths(PROJECT, outputDir);
  const prose = '# Scene One\n\nThis is the first scene.\n';
  const proseHash = computeContentHash(prose);
  const revisionId = uuid();
  const revisionOperationId = uuid();
  const scopeHash = sha256Hex();
  const basisHash = sha256Hex();
  const sceneEnvelope = {
    version: 1,
    revisionId,
    parentRevisionId: null,
    operationId: revisionOperationId,
    planHash: sha256Hex(),
    actorId: 'test-actor',
    eventId: 'E001',
    origin: 'llm_draft',
    prose,
    proseHash,
    sceneHash: proseHash,
    editorialBasisHash: basisHash,
    scopeHash,
    validationIdentity: 'test-vi',
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
          estimatedWordCount: 8,
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
      validationIdentity: 'test-vi',
      reasons: [],
    },
    released: true,
    cacheHit: false,
    errors: [],
    llmPass1: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    llmPass2: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
    attempts: 1,
    needsReview: false,
    promptHash: sha256Hex(),
    providerCalls: [],
    promotionReadSet: [],
    requestRecords: [],
    createdAt: '2026-07-28T00:00:00.000Z',
  };

  storage.write(`${PROJECT}/nova.yaml`, 'title: "Test Novel"\n');
  storage.write(`${PROJECT}/definitions/characters/hero.yaml`, 'name: "Hero"\n');
  storage.write(`${PROJECT}/chapters/chapter_01/_chapter.yaml`, 'title: "Chapter 1"\n');
  storage.write(`${PROJECT}/chapters/chapter_01/E001.yaml`, 'event: E001\n');
  storage.write(`${PROJECT}/chapters/chapter_01/E002.yaml`, 'event: E002\n');
  storage.write(`${PROJECT}/scenes/chapter-01/E001.md`, prose);
  storage.write(`${PROJECT}/scenes/chapter-01/E001.yaml`,
    `schema_version: 1\nevent: E001\nnarrative_order: 1\nrevision_id: ${revisionId}\nprose_source: llm\nprose_hash: ${proseHash}\nscene_hash: ${proseHash}\neditorial_basis_hash: ${basisHash}\nscope_hash: ${scopeHash}\nvalidation_identity: test-vi\nrendered_at: \"2026-07-28T00:00:00.000Z\"\nword_count: 8\ntext_count_version: 1\nedit_history: []\nbranch_existence:\n  type: all\n`);
  storage.write(`${PROJECT}/scenes/chapter-01/E002.md`, '# Scene Two\n');
  storage.write(paths.responsesDir + '/E001.json', stableJson(sceneEnvelope));
  storage.write(
    `${paths.sceneRevisionsDir}/E001/${revisionId}.json`,
    stableJson(sceneEnvelope),
  );

  const sourceRevisionId = uuid();
  const sourceOperationId = uuid();
  const projectHash = sha256Hex();
  storage.write(paths.sourceHeadPath, stableJson({
    version: 1,
    revisionId: sourceRevisionId,
    projectSourceHash: projectHash,
    documents: { 'nova.yaml': computeContentHash('title: "Test Novel"\n') },
  } as SourceHeadV1));
  storage.write(paths.sourceRevisionsDir + '/' + sourceRevisionId + '.json', stableJson({
    version: 1,
    revisionId: sourceRevisionId,
    parentRevisionId: null,
    operationId: sourceOperationId,
    actorId: 'test-actor',
    origin: 'api_edit',
    projectBeforeHash: sha256Hex(),
    projectAfterHash: projectHash,
    changeSetHash: sha256Hex(),
    documents: [{
      path: 'nova.yaml',
      beforeHash: null,
      afterHash: computeContentHash('title: "Test Novel"\n'),
      beforeContent: null,
      afterContent: 'title: "Test Novel"\n',
    }],
    affectedEventIds: [],
    createdAt: '2026-07-28T00:00:00.000Z',
  } as SourceRevisionV1));

  const operationId = uuid();
  storage.write(paths.operationsDir + '/' + operationId + '.json', stableJson({
    version: 1,
    operationId,
    kind: 'render',
    actorId: 'test-actor',
    requestHash: sha256Hex(),
    status: 'succeeded',
    startedAt: '2026-07-28T00:00:00.000Z',
    heartbeatAt: '2026-07-28T00:05:00.000Z',
    leaseExpiresAt: '2026-07-28T00:30:00.000Z',
    lastSequence: 1,
    completedAt: '2026-07-28T00:10:00.000Z',
    result: null,
    errors: [],
  } as EditorialOperationV1));

  storage.write(paths.reviewLedgerPath, stableJson({
    version: 1,
    comments: [{
      id: `rev_${uuid()}`,
      author: 'human',
      actorId: 'reviewer-1',
      target: { type: 'scene', id: 'E001' },
      severity: 'suggestion',
      category: 'style',
      content: 'Consider making the opening more dramatic.',
      status: 'open',
      applications: [],
      createdAt: '2026-07-28T00:15:00.000Z',
    }] as ReviewComment[],
    patches: [],
  }));
  storage.write(paths.publicationPath, stableJson({
    version: 1,
    status: 'current',
    branch_scope_hash: scopeHash,
    novel_hash: sha256Hex(),
    revision_ids: { E001: revisionId },
    last_assembled_at: '2026-07-28T00:10:00.000Z',
    reasons: [],
  } as PublicationManifestV1));
}

/** Assert that a value survives JSON round-trip. */
function assertJsonRoundTrip<T>(value: T): void {
  const json = JSON.stringify(value);
  const parsed = JSON.parse(json) as T;
  expect(parsed).toEqual(value);
}

/** Count total entries in a MemoryStorage. */
function countStorageFiles(storage: MemoryStorage): number {
  const s = storage as unknown as { files: Map<string, string>; dirs: Set<string> };
  return (s.files?.size ?? 0) + (s.dirs?.size ?? 0);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('EditorialWorkspace — query facade', () => {
  describe('listSources / getSource', () => {
    it('lists all project source documents', () => {
      const storage = new MemoryStorage();
      const ws = getEditorialWorkspace(PROJECT, '.nova', storage);
      storage.write(`${PROJECT}/nova.yaml`, 'title: "Test"\n');
      storage.write(`${PROJECT}/definitions/characters/hero.yaml`, 'name: "Hero"\n');

      const sources = ws.listSources();
      const srcPaths = sources.map((s) => s.path);
      expect(srcPaths).toContain('nova.yaml');
      expect(srcPaths).toContain('definitions/characters/hero.yaml');
      for (const s of sources) {
        expect(s.tracked).toBe(false);
      }
      assertJsonRoundTrip(sources);
    });

    it('gets a single source document by relative path', () => {
      const storage = new MemoryStorage();
      const ws = getEditorialWorkspace(PROJECT, '.nova', storage);
      storage.write(`${PROJECT}/nova.yaml`, 'title: "Test"\n');

      const doc = ws.getSource('nova.yaml');
      expect(doc).not.toBeNull();
      expect(doc!.path).toBe('nova.yaml');
      expect(doc!.tracked).toBe(false);
      assertJsonRoundTrip(doc!);
    });

    it('returns null for missing source', () => {
      const ws = getEditorialWorkspace(PROJECT, '.nova', new MemoryStorage());
      expect(ws.getSource('nonexistent.yaml')).toBeNull();
    });
  });

  describe('source revisions', () => {
    it('lists source revisions', () => {
      const storage = new MemoryStorage();
      seedFullProject(storage);
      const ws = getEditorialWorkspace(PROJECT, '.nova', storage);

      const revs = ws.listSourceRevisions();
      expect(revs.length).toBe(1);
      expect(revs[0].revisionId).toBeTruthy();
      assertJsonRoundTrip(revs);
    });

    it('gets a source revision by ID', () => {
      const storage = new MemoryStorage();
      seedFullProject(storage);
      const ws = getEditorialWorkspace(PROJECT, '.nova', storage);

      const revId = ws.getSourceHead()!.revisionId;
      const rev = ws.getSourceRevision(revId);
      expect(rev.revisionId).toBe(revId);
      assertJsonRoundTrip(rev);
    });

    it('throws on missing source revision', () => {
      const ws = getEditorialWorkspace(PROJECT, '.nova', new MemoryStorage());
      expect(() => ws.getSourceRevision(uuid())).toThrow();
    });

    it('gets source head', () => {
      const storage = new MemoryStorage();
      seedFullProject(storage);
      const ws = getEditorialWorkspace(PROJECT, '.nova', storage);

      const head = ws.getSourceHead();
      expect(head).not.toBeNull();
      expect(head!.projectSourceHash).toBeTruthy();
      assertJsonRoundTrip(head!);
    });

    it('returns null source head when absent', () => {
      const ws = getEditorialWorkspace(PROJECT, '.nova', new MemoryStorage());
      expect(ws.getSourceHead()).toBeNull();
    });
  });

  describe('scene queries', () => {
    it('lists scenes from scenes/ directory', () => {
      const storage = new MemoryStorage();
      seedFullProject(storage);
      const ws = getEditorialWorkspace(PROJECT, '.nova', storage);

      const scenes = ws.listScenes();
      const eventIds = scenes.map((s) => s.eventId).sort();
      expect(eventIds).toEqual(['E001', 'E002']);
      assertJsonRoundTrip(scenes);
    });

    it('inspects a single scene by eventId', () => {
      const storage = new MemoryStorage();
      seedFullProject(storage);
      const ws = getEditorialWorkspace(PROJECT, '.nova', storage);

      const scene = ws.inspectScene('E001');
      expect(scene.eventId).toBe('E001');
      expect(scene.chapter).toBe(1);
      expect(scene.prose).toContain('Scene One');
      expect(scene.proseHash).toBeTruthy();
      expect(scene.artifactPaths.scene).toContain('E001.md');
      expect(scene.artifactPaths.metadata).toContain('E001.yaml');
      expect(scene.artifactPaths.latestResponse).toContain('E001.json');
      assertJsonRoundTrip(scene);
    });

    it('returns missing scene for unknown eventId', () => {
      const storage = new MemoryStorage();
      seedFullProject(storage);
      const ws = getEditorialWorkspace(PROJECT, '.nova', storage);

      const scene = ws.inspectScene('UNKNOWN');
      expect(scene.state).toBe('missing');
      expect(scene.eventId).toBe('UNKNOWN');
      assertJsonRoundTrip(scene);
    });

    it('shows manual_change_untracked after direct prose editing', () => {
      const storage = new MemoryStorage();
      seedFullProject(storage);
      storage.write(
        `${PROJECT}/scenes/chapter-01/E001.md`,
        '# Scene One\n\nExternally edited.\n',
      );

      const ws = getEditorialWorkspace(PROJECT, '.nova', storage);
      const scene = ws.inspectScene('E001');
      expect(scene.state).toBe('manual_change_untracked');
      assertJsonRoundTrip(scene);
    });
  });

  describe('operation queries', () => {
    it('lists operations sorted by startedAt', () => {
      const storage = new MemoryStorage();
      seedFullProject(storage);
      const ws = getEditorialWorkspace(PROJECT, '.nova', storage);

      const ops = ws.listOperations();
      expect(ops.length).toBeGreaterThanOrEqual(1);
      for (let i = 1; i < ops.length; i++) {
        expect(ops[i - 1].startedAt.localeCompare(ops[i].startedAt)).toBeLessThanOrEqual(0);
      }
      assertJsonRoundTrip(ops);
    });

    it('gets a single operation by ID', () => {
      const storage = new MemoryStorage();
      seedFullProject(storage);
      const ws = getEditorialWorkspace(PROJECT, '.nova', storage);

      const ops = ws.listOperations();
      expect(ops.length).toBeGreaterThanOrEqual(1);
      const op = ws.getOperation(ops[0].operationId);
      expect(op.operationId).toBe(ops[0].operationId);
      assertJsonRoundTrip(op);
    });

    it('throws for missing operation', () => {
      const ws = getEditorialWorkspace(PROJECT, '.nova', new MemoryStorage());
      expect(() => ws.getOperation(uuid())).toThrow();
    });
  });

  describe('review queries', () => {
    it('lists reviews sorted by creation time', () => {
      const storage = new MemoryStorage();
      seedFullProject(storage);
      const ws = getEditorialWorkspace(PROJECT, '.nova', storage);

      const reviews = ws.listReviews();
      expect(reviews.length).toBe(1);
      assertJsonRoundTrip(reviews);
    });

    it('gets a review by ID', () => {
      const storage = new MemoryStorage();
      seedFullProject(storage);
      const ws = getEditorialWorkspace(PROJECT, '.nova', storage);

      const reviews = ws.listReviews();
      const review = ws.getReview(reviews[0].id);
      expect(review).not.toBeNull();
      assertJsonRoundTrip(review!);
    });

    it('returns null for missing review', () => {
      const ws = getEditorialWorkspace(PROJECT, '.nova', new MemoryStorage());
      expect(ws.getReview('nonexistent')).toBeNull();
    });

    it('returns empty list when ledger is absent', () => {
      const ws = getEditorialWorkspace(PROJECT, '.nova', new MemoryStorage());
      expect(ws.listReviews()).toEqual([]);
    });
  });

  describe('publication', () => {
    it('returns synthetic stale when no manifest exists', () => {
      const ws = getEditorialWorkspace(PROJECT, '.nova', new MemoryStorage());
      const pub = ws.getPublication();
      expect(pub.status).toBe('stale');
      expect(pub.reasons.length).toBeGreaterThan(0);
      assertJsonRoundTrip(pub);
    });

    it('returns manifest when it exists', () => {
      const storage = new MemoryStorage();
      seedFullProject(storage);
      const ws = getEditorialWorkspace(PROJECT, '.nova', storage);

      const pub = ws.getPublication();
      expect(pub.status).toBe('current');
      expect(pub.novel_hash).toBeTruthy();
      assertJsonRoundTrip(pub);
    });
  });

  describe('snapshot', () => {
    it('builds a complete workspace snapshot', () => {
      const storage = new MemoryStorage();
      seedFullProject(storage);
      const ws = getEditorialWorkspace(PROJECT, '.nova', storage);

      const snap = ws.snapshot();
      expect(snap.version).toBe(1);
      expect(snap.scenes.length).toBe(2);
      expect(snap.publication.status).toBe('current');
      expect(snap.sourceTracked).toBe(true);
      expect(snap.reviewSummary.open).toBe(1);
      assertJsonRoundTrip(snap);
    });

    it('handles empty project gracefully', () => {
      const ws = getEditorialWorkspace(PROJECT, '.nova', new MemoryStorage());
      const snap = ws.snapshot();
      expect(snap.scenes).toEqual([]);
      expect(snap.publication.status).toBe('stale');
      expect(snap.sourceTracked).toBe(false);
      expect(snap.activeOperation).toBeNull();
      assertJsonRoundTrip(snap);
    });
  });

  describe('legacy migration inspection', () => {
    it('reports non-migratable when no historical response exists', () => {
      const ws = getEditorialWorkspace(PROJECT, '.nova', new MemoryStorage());
      const result = ws.inspectLegacyScene('E001');
      expect(result.migratable).toBe(false);
      expect(result.historicalResponse.exists).toBe(false);
      expect(result.reason).toContain('historical');
      assertJsonRoundTrip(result);
    });

    it('detects migratable scene when prose and choices match', () => {
      const storage = new MemoryStorage();

      storage.write(`${PROJECT}/scenes/chapter-01/E001.yaml`,
        'schema_version: 1\nevent: "E001"\nnarrative_order: 1\nprose_source: "llm"\n');
      storage.write(`${PROJECT}/scenes/chapter-01/E001.md`, '# Scene One\n\nContent.\n');
      storage.write(`${PROJECT}/chapters/chapter_01/E001.yaml`,
        'id: "E001"\nchoices:\n  - id: "c1"\n    label: "Go left"\n    description: "Left path"\n');
      storage.write(`${PROJECT}/.nova/responses/E001.json`, stableJson({
        version: 1,
        eventId: 'E001',
        revisionId: uuid(),
        prose: '# Scene One\n\nContent.\n',
        playerChoices: [{ id: 'c1', label: 'Go left', description: 'Left path' }],
        releaseDecision: { status: 'accepted', scopeHash: sha256Hex(), validationIdentity: 'vi' },
        released: true,
        origin: 'llm_draft',
        proseHash: computeContentHash('# Scene One\n\nContent.\n'),
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

      const ws = getEditorialWorkspace(PROJECT, '.nova', storage);
      const result = ws.inspectLegacyScene('E001');
      expect(result.migratable).toBe(true);
      expect(result.matchedProse).toBe(true);
      expect(result.matchedChoices).toBe(true);
      expect(result.hasAcceptedRelease).toBe(true);
      expect(result.reason).toBeUndefined();
      assertJsonRoundTrip(result);
    });
  });

  describe('read-only guarantee', () => {
    it('produces no storage writes through reads', () => {
      const storage = new MemoryStorage();
      seedFullProject(storage);
      const initialFiles = countStorageFiles(storage);
      const ws = getEditorialWorkspace(PROJECT, '.nova', storage);

      ws.listSources();
      ws.getSource('nova.yaml');
      ws.listSourceRevisions();
      ws.getSourceHead();
      ws.listScenes();
      ws.inspectScene('E001');
      ws.listOperations();
      ws.listReviews();
      ws.getPublication();
      ws.snapshot();
      ws.inspectLegacyScene('E001');

      expect(countStorageFiles(storage)).toBe(initialFiles);
    });
  });

  describe('invalid artifacts fail closed', () => {
    it('does not let malformed latest-candidate JSON displace the accepted head', () => {
      const storage = new MemoryStorage();
      seedFullProject(storage);
      const paths = resolveProjectPaths(PROJECT, '.nova');
      storage.write(paths.responsesDir + '/E001.json', '{{invalid json}}');

      const ws = getEditorialWorkspace(PROJECT, '.nova', storage);
      const scene = ws.inspectScene('E001');
      expect(scene.revisionId).not.toBeNull();
      expect(scene.state).toBe('current');
      expect(scene.latestCandidate).toBeNull();
      assertJsonRoundTrip(scene);
    });

    it('skips malformed operation entries in list', () => {
      const storage = new MemoryStorage();
      seedFullProject(storage);
      const paths = resolveProjectPaths(PROJECT, '.nova');
      storage.write(paths.operationsDir + '/bad-op.json', '{{{garbage}}}');

      const ws = getEditorialWorkspace(PROJECT, '.nova', storage);
      const ops = ws.listOperations();
      expect(ops.every((o) => o.operationId !== 'bad-op')).toBe(true);
      assertJsonRoundTrip(ops);
    });
  });
});

describe('EditorialWorkspace — custom output dir', () => {
  it('resolves custom outputDir in paths', () => {
    const ws = getEditorialWorkspace(PROJECT, 'custom-work', new MemoryStorage());
    expect(ws.outputDir).toBe('custom-work');
    expect(ws.workDir).toContain('custom-work');
    expect(ws.workDir).not.toContain('.nova');
  });

  it('defaults to .nova when no outputDir given', () => {
    const ws = getEditorialWorkspace(PROJECT, undefined, new MemoryStorage());
    expect(ws.outputDir).toBe('.nova');
  });

  it('stores responses/revisions in custom workDir', () => {
    const storage = new MemoryStorage();
    seedFullProject(storage, 'my-work');
    const ws = getEditorialWorkspace(PROJECT, 'my-work', storage);

    const scene = ws.inspectScene('E001');
    expect(scene.artifactPaths.latestResponse).toContain('my-work/responses');
    expect(scene.artifactPaths.latestResponse).not.toContain('.nova');
    if (scene.artifactPaths.revision) {
      expect(scene.artifactPaths.revision).toContain('my-work/revisions');
    }
  });
});

describe('QueryService — error-safe wrapper', () => {
  it('wraps workspace queries in QueryResult', () => {
    const qs = new QueryService(PROJECT, '.nova', new MemoryStorage());
    const result = qs.listSources();
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
  });

  it('returns not-found error for missing getSource', () => {
    const qs = new QueryService(PROJECT, '.nova', new MemoryStorage());
    const result = qs.getSource('nonexistent.yaml');
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('REVISION_NOT_FOUND');
  });

  it('returns not-found error for missing getReview', () => {
    const qs = new QueryService(PROJECT, '.nova', new MemoryStorage());
    const result = qs.getReview('bad-id');
    expect(result.ok).toBe(false);
    expect(result.error!.code).toBe('REVISION_NOT_FOUND');
  });

  it('snapshot error-safe', () => {
    const qs = new QueryService(PROJECT, '.nova', new MemoryStorage());
    const result = qs.snapshot();
    expect(result.ok).toBe(true);
    expect(result.data!.scenes).toEqual([]);
  });
});
