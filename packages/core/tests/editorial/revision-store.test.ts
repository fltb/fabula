// ============================================================================
// SceneRevisionStore & SourceRevisionStore — V1 round-trip tests
//
// All tests use MemoryStorage, configured ProjectTransactionCoordinator, and
// deterministic data. No live LLM, filesystem, or network access.
// ============================================================================

import * as crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ProjectTransactionCoordinator,
  resolveProjectPaths,
  SceneRevisionStore,
  SourceRevisionStore,
  stableJson,
} from '../../src/editorial/index.ts';
import type { ProjectPaths } from '../../src/editorial/paths.ts';
import { ConfigError, StorageConflictError } from '../../src/errors.ts';
import { computeContentHash } from '../../src/storage/hash.ts';
import { MemoryStorage } from '../../src/storage/memory-storage.ts';
import type {
  AnalysisResult,
  SceneRevisionEnvelopeV1,
  SourceHeadV1,
  SourceRevisionV1,
  ValidationResult,
} from '../../src/types/editorial.ts';
import { makeObservations, makeProtocol } from '../fixtures/mock-pass2-helpers.ts';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TEST_EVENT_ID = 'E-test-001';
const TEST_ACTOR = 'test-actor';

function sha256Hex(): string {
  return crypto.randomBytes(32).toString('hex');
}

function uuid(): string {
  return crypto.randomUUID();
}

function makePaths(): ProjectPaths {
  return resolveProjectPaths('/test-project');
}

function makeCoordinator(storage: MemoryStorage): ProjectTransactionCoordinator {
  return new ProjectTransactionCoordinator(storage, makePaths());
}

function analysisResult(eventId: string, prose: string): AnalysisResult {
  const payload: Record<string, unknown> = {
    postconditions: { covered: [], dropped: [] },
    preconditions: { violated: [] },
    pov: { consistent: true, leaks: [] },
    inventedDetails: [],
    quality: {
      proseScore: 8,
      maxScore: 10,
      strengths: ['clear'],
      weaknesses: [],
      estimatedWordCount: 200,
    },
    threadProgressAchieved: [],
    foreshadowingDeployed: [],
    narrativeChecks: [],
    appearanceChecks: [],
    characterReferences: [],
    tenseDetected: 'past' as const,
    conflictAnalysis: { primaryType: 'none', resolutionAchieved: true },
    ruleChecks: [],
    knowledgeChecks: [],
  };
  return {
    eventId,
    protocol: makeProtocol(prose),
    observations: makeObservations(payload, prose),
    analysis: payload,
  };
}

function validationResult(passed: boolean = true): ValidationResult {
  return {
    passed,
    errors: [],
    warnings: [],
    infos: [],
  };
}

function makeSceneEnvelope(
  overrides: Partial<SceneRevisionEnvelopeV1> & {
    eventId: string;
    revisionId: string;
    prose: string;
  },
): SceneRevisionEnvelopeV1 {
  const proseHash = computeContentHash(overrides.prose);
  return {
    version: 1,
    parentRevisionId: null,
    operationId: uuid(),
    planHash: sha256Hex(),
    actorId: TEST_ACTOR,
    origin: 'llm_draft',
    proseHash,
    sceneHash: sha256Hex(),
    editorialBasisHash: sha256Hex(),
    scopeHash: sha256Hex(),
    validationIdentity: 'test-validator-v1',
    modelUsed: 'test-model',
    feedbackHash: null,
    reviewIds: [],
    analysis: analysisResult(overrides.eventId, overrides.prose),
    validation: validationResult(true),
    releaseDecision: {
      status: 'accepted',
      scopeHash: sha256Hex(),
      validationIdentity: 'test-validator-v1',
      reasons: [],
    },
    released: true,
    cacheHit: false,
    errors: [],
    llmPass1: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    llmPass2: { promptTokens: 200, completionTokens: 100, totalTokens: 300 },
    attempts: 1,
    needsReview: false,
    promptHash: sha256Hex(),
    providerCalls: [],
    promotionReadSet: [],
    requestRecords: [],
    createdAt: '2026-07-28T00:00:00.000Z',
    ...overrides,
  };
}

function makeSourceRevision(
  overrides: Partial<SourceRevisionV1> & { revisionId: string },
): SourceRevisionV1 {
  return {
    version: 1,
    parentRevisionId: null,
    operationId: uuid(),
    actorId: TEST_ACTOR,
    origin: 'api_edit',
    note: 'test revision',
    projectBeforeHash: sha256Hex(),
    projectAfterHash: sha256Hex(),
    changeSetHash: sha256Hex(),
    documents: [
      {
        path: 'definitions/characters/alice.yaml',
        beforeHash: null,
        afterHash: sha256Hex(),
        beforeContent: null,
        afterContent: 'name: Alice\nage: 30\n',
      },
    ],
    affectedEventIds: [TEST_EVENT_ID],
    createdAt: '2026-07-28T00:00:00.000Z',
    ...overrides,
  };
}

function makeSourceHead(
  revisionId: string | null,
  docHashes?: Record<string, string>,
): SourceHeadV1 {
  return {
    version: 1,
    revisionId,
    projectSourceHash: sha256Hex(),
    documents: docHashes ?? {},
  };
}

// ─── SceneRevisionStore Tests ───────────────────────────────────────────────

describe('SceneRevisionStore', () => {
  describe('archive (create-only)', () => {
    it('archives a new revision and reads it back', () => {
      const storage = new MemoryStorage();
      const store = new SceneRevisionStore(makeCoordinator(storage), makePaths());
      const revUuid = uuid();
      const envelope = makeSceneEnvelope({
        eventId: TEST_EVENT_ID,
        revisionId: revUuid,
        prose: 'Scene revision prose content.',
      });

      const revPath = store.archive(envelope);
      expect(revPath).toContain(revUuid);

      const loaded = store.get(TEST_EVENT_ID, revUuid);
      expect(loaded.revisionId).toBe(revUuid);
      expect(loaded.prose).toBe('Scene revision prose content.');
    });

    it('rejects duplicate UUID (create-once via CAS)', () => {
      const storage = new MemoryStorage();
      const store = new SceneRevisionStore(makeCoordinator(storage), makePaths());
      const revUuid = uuid();
      const envelope = makeSceneEnvelope({
        eventId: TEST_EVENT_ID,
        revisionId: revUuid,
        prose: 'First revision.',
      });

      store.archive(envelope);

      const dup = makeSceneEnvelope({
        eventId: TEST_EVENT_ID,
        revisionId: revUuid,
        prose: 'Duplicate revision.',
      });
      expect(() => store.archive(dup)).toThrow(StorageConflictError);
    });
  });

  describe('immutable revision vs latest separation', () => {
    it('archived revision persists even after latest is updated with a new revision', () => {
      const storage = new MemoryStorage();
      const store = new SceneRevisionStore(makeCoordinator(storage), makePaths());
      const uuid1 = uuid();
      const uuid2 = uuid();

      const env1 = makeSceneEnvelope({
        eventId: TEST_EVENT_ID,
        revisionId: uuid1,
        prose: 'Version 1.',
      });
      store.archiveAndUpdateLatest(env1, null);
      const latestHash1 = store.latestHash(TEST_EVENT_ID);

      const env2 = makeSceneEnvelope({
        eventId: TEST_EVENT_ID,
        revisionId: uuid2,
        prose: 'Version 2.',
      });
      store.archiveAndUpdateLatest(env2, latestHash1);

      // Revision 1 still readable from archive
      const loaded1 = store.get(TEST_EVENT_ID, uuid1);
      expect(loaded1.revisionId).toBe(uuid1);
      expect(loaded1.prose).toBe('Version 1.');

      // Latest points to revision 2
      const latest = store.getLatest(TEST_EVENT_ID);
      expect(latest).not.toBeNull();
      expect(latest!.revisionId).toBe(uuid2);
      expect(latest!.prose).toBe('Version 2.');
    });
  });

  describe('blocked latest does not imply head', () => {
    it('stores a blocked release as latest, previous revision remains archived', () => {
      const storage = new MemoryStorage();
      const store = new SceneRevisionStore(makeCoordinator(storage), makePaths());
      const uuid1 = uuid();
      const uuid2 = uuid();

      const env1 = makeSceneEnvelope({
        eventId: TEST_EVENT_ID,
        revisionId: uuid1,
        prose: 'Accepted version.',
      });
      store.archiveAndUpdateLatest(env1, null);
      const latestHash1 = store.latestHash(TEST_EVENT_ID);

      const env2 = makeSceneEnvelope({
        eventId: TEST_EVENT_ID,
        revisionId: uuid2,
        prose: 'Blocked version.',
        releaseDecision: {
          status: 'blocked',
          scopeHash: sha256Hex(),
          validationIdentity: 'test-validator-v1',
          reasons: ['Content rejected by gate'],
        },
        released: false,
      });
      store.archiveAndUpdateLatest(env2, latestHash1);

      // Latest is now the blocked revision
      const latest = store.getLatest(TEST_EVENT_ID);
      expect(latest).not.toBeNull();
      expect(latest!.revisionId).toBe(uuid2);
      expect(latest!.releaseDecision.status).toBe('blocked');
      expect(latest!.released).toBe(false);

      // Revision 1 still readable from archive
      const loaded1 = store.get(TEST_EVENT_ID, uuid1);
      expect(loaded1.prose).toBe('Accepted version.');

      // Both revisions appear in list
      const all = store.list(TEST_EVENT_ID);
      expect(all).toHaveLength(2);
    });
  });

  describe('latest CAS conflict leaves immutable revision readable', () => {
    it('archive succeeds but concurrent latest update fails, archived revision persists', () => {
      const storage = new MemoryStorage();
      const store = new SceneRevisionStore(makeCoordinator(storage), makePaths());
      const uuid1 = uuid();
      const uuid2 = uuid();

      const env1 = makeSceneEnvelope({
        eventId: TEST_EVENT_ID,
        revisionId: uuid1,
        prose: 'Base revision.',
      });
      store.archiveAndUpdateLatest(env1, null);

      // Archive a new revision
      const env2 = makeSceneEnvelope({
        eventId: TEST_EVENT_ID,
        revisionId: uuid2,
        prose: 'New revision.',
      });
      store.archive(env2);

      // updateLatest with stale expectedHash fails
      expect(() => store.updateLatest(env2, 'stalehash')).toThrow(StorageConflictError);

      // Archived revision is still readable
      const loaded = store.get(TEST_EVENT_ID, uuid2);
      expect(loaded.revisionId).toBe(uuid2);
      expect(loaded.prose).toBe('New revision.');

      // Latest still points to original
      const latest = store.getLatest(TEST_EVENT_ID);
      expect(latest).not.toBeNull();
      expect(latest!.revisionId).toBe(uuid1);
    });
  });

  describe('malformed envelope rejected', () => {
    it('throws ZodError when revisionId is not a UUID', () => {
      const storage = new MemoryStorage();
      const store = new SceneRevisionStore(makeCoordinator(storage), makePaths());

      const envelope = makeSceneEnvelope({
        eventId: TEST_EVENT_ID,
        revisionId: 'not-a-uuid',
        prose: 'Bad UUID.',
      });

      expect(() => store.archive(envelope)).toThrow();
    });

    it('throws ConfigError when proseHash does not match prose', () => {
      const storage = new MemoryStorage();
      const store = new SceneRevisionStore(makeCoordinator(storage), makePaths());

      const envelope = makeSceneEnvelope({
        eventId: TEST_EVENT_ID,
        revisionId: uuid(),
        prose: 'Some prose.',
      });
      // Override the correct hash with a wrong one using type coercion
      const bad = {
        ...envelope,
        proseHash: '0000000000000000000000000000000000000000000000000000000000000000',
      };

      expect(() => store.archive(bad)).toThrow(ConfigError);
      expect(() => store.archive(bad)).toThrow(/proseHash does not match prose/);
    });

    it('throws ConfigError when release.status=accepted but released=false', () => {
      const storage = new MemoryStorage();
      const store = new SceneRevisionStore(makeCoordinator(storage), makePaths());

      const envelope = makeSceneEnvelope({
        eventId: TEST_EVENT_ID,
        revisionId: uuid(),
        prose: 'Inconsistent release.',
        released: false,
      });

      expect(() => store.archive(envelope)).toThrow(ConfigError);
      expect(() => store.archive(envelope)).toThrow(/release fields are inconsistent/);
    });

    it('throws ConfigError when released=true but analysis is null', () => {
      const storage = new MemoryStorage();
      const store = new SceneRevisionStore(makeCoordinator(storage), makePaths());

      const envelope = makeSceneEnvelope({
        eventId: TEST_EVENT_ID,
        revisionId: uuid(),
        prose: 'Missing analysis.',
        analysis: null,
      });

      expect(() => store.archive(envelope)).toThrow(ConfigError);
      expect(() => store.archive(envelope)).toThrow(/release fields are inconsistent/);
    });

    it('throws ConfigError when release.status=blocked but released=true', () => {
      const storage = new MemoryStorage();
      const store = new SceneRevisionStore(makeCoordinator(storage), makePaths());

      const envelope = makeSceneEnvelope({
        eventId: TEST_EVENT_ID,
        revisionId: uuid(),
        prose: 'Inconsistent blocked.',
        releaseDecision: {
          status: 'blocked',
          scopeHash: sha256Hex(),
          validationIdentity: 'test-validator-v1',
          reasons: ['Blocked'],
        },
        released: true,
      });

      expect(() => store.archive(envelope)).toThrow(ConfigError);
      expect(() => store.archive(envelope)).toThrow(/release fields are inconsistent/);
    });

    it('throws ConfigError when envelope JSON is malformed on read', () => {
      const storage = new MemoryStorage();
      const paths = makePaths();
      const store = new SceneRevisionStore(makeCoordinator(storage), paths);
      const revUuid = uuid();

      const revPath = store.revisionPath(TEST_EVENT_ID, revUuid);
      storage.mkdirp(paths.sceneRevisionsDir + '/' + TEST_EVENT_ID);
      storage.write(revPath, '{not valid json}');

      expect(() => store.get(TEST_EVENT_ID, revUuid)).toThrow(ConfigError);
    });
  });

  describe('get — nonexistent revision throws', () => {
    it('throws EditorialOperationError for unknown revision', () => {
      const storage = new MemoryStorage();
      const store = new SceneRevisionStore(makeCoordinator(storage), makePaths());

      expect(() => store.get(TEST_EVENT_ID, uuid())).toThrow('Scene revision not found');
    });
  });

  describe('getLatest — returns null when no latest', () => {
    it('returns null when no latest file exists', () => {
      const storage = new MemoryStorage();
      const store = new SceneRevisionStore(makeCoordinator(storage), makePaths());

      const latest = store.getLatest(TEST_EVENT_ID);
      expect(latest).toBeNull();
    });
  });

  describe('latestHash', () => {
    it('returns null when no latest file exists', () => {
      const storage = new MemoryStorage();
      const store = new SceneRevisionStore(makeCoordinator(storage), makePaths());

      expect(store.latestHash(TEST_EVENT_ID)).toBeNull();
    });

    it('returns a content hash after writing latest', () => {
      const storage = new MemoryStorage();
      const store = new SceneRevisionStore(makeCoordinator(storage), makePaths());
      const revUuid = uuid();
      const envelope = makeSceneEnvelope({
        eventId: TEST_EVENT_ID,
        revisionId: revUuid,
        prose: 'Hash check.',
      });

      store.archiveAndUpdateLatest(envelope, null);
      const hash = store.latestHash(TEST_EVENT_ID);
      expect(hash).toBeTruthy();
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('list — sorted by createdAt then revisionId', () => {
    it('returns revisions sorted chronologically', () => {
      const storage = new MemoryStorage();
      const store = new SceneRevisionStore(makeCoordinator(storage), makePaths());

      const uuid1 = uuid();
      const uuid2 = uuid();
      const uuid3 = uuid();

      const env3 = makeSceneEnvelope({
        eventId: TEST_EVENT_ID,
        revisionId: uuid3,
        prose: 'Third (oldest timestamp).',
        createdAt: '2026-07-28T00:00:01.000Z',
      });
      store.archive(env3);

      const env1 = makeSceneEnvelope({
        eventId: TEST_EVENT_ID,
        revisionId: uuid1,
        prose: 'First (latest timestamp).',
        createdAt: '2026-07-28T00:00:03.000Z',
      });
      store.archive(env1);

      const env2 = makeSceneEnvelope({
        eventId: TEST_EVENT_ID,
        revisionId: uuid2,
        prose: 'Second (middle timestamp).',
        createdAt: '2026-07-28T00:00:02.000Z',
      });
      store.archive(env2);

      const all = store.list(TEST_EVENT_ID);
      expect(all).toHaveLength(3);
      expect(all[0].revisionId).toBe(uuid3);
      expect(all[1].revisionId).toBe(uuid2);
      expect(all[2].revisionId).toBe(uuid1);
    });

    it('returns empty array for event with no revisions', () => {
      const storage = new MemoryStorage();
      const store = new SceneRevisionStore(makeCoordinator(storage), makePaths());

      expect(store.list(TEST_EVENT_ID)).toEqual([]);
    });
  });

  describe('archiveAndUpdateLatest', () => {
    it('archives revision and updates latest atomically', () => {
      const storage = new MemoryStorage();
      const store = new SceneRevisionStore(makeCoordinator(storage), makePaths());
      const revUuid = uuid();
      const envelope = makeSceneEnvelope({
        eventId: TEST_EVENT_ID,
        revisionId: revUuid,
        prose: 'Atomic archive+latest.',
      });

      store.archiveAndUpdateLatest(envelope, null);

      const loaded = store.get(TEST_EVENT_ID, revUuid);
      expect(loaded.revisionId).toBe(revUuid);

      const latest = store.getLatest(TEST_EVENT_ID);
      expect(latest).not.toBeNull();
      expect(latest!.revisionId).toBe(revUuid);
    });
  });

  describe('separate archive then updateLatest', () => {
    it('updateLatest succeeds after archive', () => {
      const storage = new MemoryStorage();
      const store = new SceneRevisionStore(makeCoordinator(storage), makePaths());
      const revUuid = uuid();
      const envelope = makeSceneEnvelope({
        eventId: TEST_EVENT_ID,
        revisionId: revUuid,
        prose: 'Separate steps.',
      });

      store.archive(envelope);
      store.updateLatest(envelope, null);

      const latest = store.getLatest(TEST_EVENT_ID);
      expect(latest).not.toBeNull();
      expect(latest!.revisionId).toBe(revUuid);
    });
  });
});

// ─── SourceRevisionStore Tests ───────────────────────────────────────────────

describe('SourceRevisionStore', () => {
  describe('save (create-only)', () => {
    it('saves a new source revision and head, reads both back', () => {
      const storage = new MemoryStorage();
      const store = new SourceRevisionStore(makeCoordinator(storage), makePaths());
      const revUuid = uuid();
      const revision = makeSourceRevision({ revisionId: revUuid });
      const head = makeSourceHead(revUuid);

      store.save(revision, head, null);

      const loaded = store.get(revUuid);
      expect(loaded.revisionId).toBe(revUuid);
      expect(loaded.origin).toBe('api_edit');
      expect(loaded.documents).toHaveLength(1);
      expect(loaded.documents[0].path).toBe('definitions/characters/alice.yaml');

      const loadedHead = store.getHead();
      expect(loadedHead).not.toBeNull();
      expect(loadedHead!.revisionId).toBe(revUuid);
    });

    it('rejects duplicate UUID (create-once via CAS)', () => {
      const storage = new MemoryStorage();
      const store = new SourceRevisionStore(makeCoordinator(storage), makePaths());
      const revUuid = uuid();
      const revision = makeSourceRevision({ revisionId: revUuid });
      const head = makeSourceHead(revUuid);

      store.save(revision, head, null);

      const dupRevision = makeSourceRevision({ revisionId: revUuid, note: 'duplicate' });
      const dupHead = makeSourceHead(revUuid);
      expect(() => store.save(dupRevision, dupHead, null)).toThrow(StorageConflictError);
    });
  });

  describe('immutable revision vs head separation', () => {
    it('archived revision persists even after head is updated with a new revision', () => {
      const storage = new MemoryStorage();
      const store = new SourceRevisionStore(makeCoordinator(storage), makePaths());
      const uuid1 = uuid();
      const uuid2 = uuid();

      const docHash1 = sha256Hex();
      const docHash2 = sha256Hex();

      const rev1 = makeSourceRevision({
        revisionId: uuid1,
        documents: [
          {
            path: 'definitions/characters/alice.yaml',
            beforeHash: null,
            afterHash: docHash1,
            beforeContent: null,
            afterContent: 'name: Alice\nage: 30\n',
          },
        ],
      });
      const head1 = makeSourceHead(uuid1, { 'definitions/characters/alice.yaml': docHash1 });
      store.save(rev1, head1, null);
      const headHash1 = store.headHash();

      const rev2 = makeSourceRevision({
        revisionId: uuid2,
        documents: [
          {
            path: 'definitions/characters/alice.yaml',
            beforeHash: docHash1,
            afterHash: docHash2,
            beforeContent: 'name: Alice\nage: 30\n',
            afterContent: 'name: Alice\nage: 31\n',
          },
        ],
        parentRevisionId: uuid1,
      });
      const head2 = makeSourceHead(uuid2, { 'definitions/characters/alice.yaml': docHash2 });
      store.save(rev2, head2, headHash1);

      // Revision 1 is still readable
      const loaded1 = store.get(uuid1);
      expect(loaded1.revisionId).toBe(uuid1);
      expect(loaded1.documents[0].afterContent).toBe('name: Alice\nage: 30\n');

      // Head points to revision 2
      const loadedHead = store.getHead();
      expect(loadedHead).not.toBeNull();
      expect(loadedHead!.revisionId).toBe(uuid2);
    });
  });

  describe('head CAS conflict', () => {
    it('save fails on stale head hash', () => {
      const storage = new MemoryStorage();
      const store = new SourceRevisionStore(makeCoordinator(storage), makePaths());
      const uuid1 = uuid();
      const uuid2 = uuid();

      const rev1 = makeSourceRevision({ revisionId: uuid1 });
      const head1 = makeSourceHead(uuid1);
      store.save(rev1, head1, null);

      const rev2 = makeSourceRevision({ revisionId: uuid2 });
      const head2 = makeSourceHead(uuid2);
      expect(() => store.save(rev2, head2, 'staleheadhash')).toThrow(StorageConflictError);
    });
  });

  describe('schema validation', () => {
    it('throws ConfigError when head revisionId does not match saved revision', () => {
      const storage = new MemoryStorage();
      const store = new SourceRevisionStore(makeCoordinator(storage), makePaths());
      const revUuid = uuid();
      const revision = makeSourceRevision({ revisionId: revUuid });
      const head = makeSourceHead(uuid()); // different UUID

      expect(() => store.save(revision, head, null)).toThrow(ConfigError);
      expect(() => store.save(revision, head, null)).toThrow(/head revisionId must identify/);
    });

    it('throws ConfigError when revision JSON is malformed on read', () => {
      const storage = new MemoryStorage();
      const paths = makePaths();
      const store = new SourceRevisionStore(makeCoordinator(storage), paths);
      const revUuid = uuid();
      const revPath = store.revisionPath(revUuid);

      storage.mkdirp(paths.sourceRevisionsDir);
      storage.write(revPath, '{not valid json}');

      expect(() => store.get(revUuid)).toThrow(ConfigError);
    });

    it('throws ConfigError when head JSON is malformed', () => {
      const storage = new MemoryStorage();
      const paths = makePaths();
      const store = new SourceRevisionStore(makeCoordinator(storage), paths);

      storage.mkdirp(paths.sourceRevisionsDir);
      storage.write(paths.sourceHeadPath, '{not valid json}');

      expect(() => store.getHead()).toThrow(ConfigError);
    });
  });

  describe('get — nonexistent revision throws', () => {
    it('throws EditorialOperationError for unknown revision', () => {
      const storage = new MemoryStorage();
      const store = new SourceRevisionStore(makeCoordinator(storage), makePaths());

      expect(() => store.get(uuid())).toThrow('Source revision not found');
    });
  });

  describe('getHead — returns null when no head', () => {
    it('returns null when no head file exists', () => {
      const storage = new MemoryStorage();
      const store = new SourceRevisionStore(makeCoordinator(storage), makePaths());

      expect(store.getHead()).toBeNull();
    });
  });

  describe('headHash', () => {
    it('returns null when no head file exists', () => {
      const storage = new MemoryStorage();
      const store = new SourceRevisionStore(makeCoordinator(storage), makePaths());

      expect(store.headHash()).toBeNull();
    });

    it('returns a content hash after saving head', () => {
      const storage = new MemoryStorage();
      const store = new SourceRevisionStore(makeCoordinator(storage), makePaths());
      const revUuid = uuid();
      const revision = makeSourceRevision({ revisionId: revUuid });
      const head = makeSourceHead(revUuid);
      store.save(revision, head, null);

      const hash = store.headHash();
      expect(hash).toBeTruthy();
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('list — sorted by createdAt then revisionId', () => {
    it('returns revisions sorted chronologically', () => {
      const storage = new MemoryStorage();
      const store = new SourceRevisionStore(makeCoordinator(storage), makePaths());

      const uuid1 = uuid();
      const uuid2 = uuid();
      const uuid3 = uuid();

      const rev3 = makeSourceRevision({
        revisionId: uuid3,
        createdAt: '2026-07-28T00:00:01.000Z',
      });
      store.save(rev3, makeSourceHead(uuid3), null);
      const headHash3 = store.headHash();

      const rev1 = makeSourceRevision({
        revisionId: uuid1,
        createdAt: '2026-07-28T00:00:03.000Z',
      });
      store.save(rev1, makeSourceHead(uuid1), headHash3);
      const headHash1 = store.headHash();

      const rev2 = makeSourceRevision({
        revisionId: uuid2,
        createdAt: '2026-07-28T00:00:02.000Z',
      });
      store.save(rev2, makeSourceHead(uuid2), headHash1);

      const all = store.list();
      expect(all).toHaveLength(3);
      expect(all[0].revisionId).toBe(uuid3);
      expect(all[1].revisionId).toBe(uuid2);
      expect(all[2].revisionId).toBe(uuid1);
    });

    it('returns empty array when no revisions exist', () => {
      const storage = new MemoryStorage();
      const store = new SourceRevisionStore(makeCoordinator(storage), makePaths());

      expect(store.list()).toEqual([]);
    });
  });

  describe('list with pathFilter', () => {
    it('filters revisions by document path', () => {
      const storage = new MemoryStorage();
      const store = new SourceRevisionStore(makeCoordinator(storage), makePaths());

      const uuid1 = uuid();
      const rev1 = makeSourceRevision({
        revisionId: uuid1,
        documents: [
          {
            path: 'definitions/characters/alice.yaml',
            beforeHash: null,
            afterHash: sha256Hex(),
            beforeContent: null,
            afterContent: 'name: Alice\n',
          },
        ],
      });
      store.save(rev1, makeSourceHead(uuid1), null);
      const headHash1 = store.headHash();

      const uuid2 = uuid();
      const rev2 = makeSourceRevision({
        revisionId: uuid2,
        documents: [
          {
            path: 'definitions/locations/room.yaml',
            beforeHash: null,
            afterHash: sha256Hex(),
            beforeContent: null,
            afterContent: 'name: Room\n',
          },
        ],
      });
      store.save(rev2, makeSourceHead(uuid2), headHash1);

      const aliceRevisions = store.list('definitions/characters/alice.yaml');
      expect(aliceRevisions).toHaveLength(1);
      expect(aliceRevisions[0].revisionId).toBe(uuid1);

      const roomRevisions = store.list('definitions/locations/room.yaml');
      expect(roomRevisions).toHaveLength(1);
      expect(roomRevisions[0].revisionId).toBe(uuid2);

      const noMatch = store.list('definitions/characters/bob.yaml');
      expect(noMatch).toHaveLength(0);
    });
  });
});
