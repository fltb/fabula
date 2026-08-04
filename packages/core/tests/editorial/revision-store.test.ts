// ============================================================================
// Scene revision persistence — semantic CoreExecutionRepository tests
//
// Revisions are immutable JSON-safe SceneRevisionEnvelopeV1 records archived
// through CoreExecutionRepository compare-and-swap; the accepted scene is a
// separate semantic record that CAS-advances between revision IDs. No live
// LLM, filesystem, host paths, or network access.
// ============================================================================

import * as crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { JsonValue } from '../../src/contracts/json.js';
import { getSceneRevision } from '../../src/editorial/facade.ts';
import type {
  CoreExecutionRepository,
  SceneRevisionRecord,
} from '../../src/ports/execution-repository.ts';
import { sceneRevisionEnvelopeV1Schema } from '../../src/schemas/editorial.ts';
import {
  MemoryExecutionRepository,
  MemoryRenderCacheRepository,
  MemoryStateLogRepository,
  MemoryStateSnapshotRepository,
} from '../../src/testing/memory-repositories.ts';
import type {
  AnalysisResult,
  EditorialRuntime,
  SceneRevisionEnvelopeV1,
  ValidationResult,
} from '../../src/types/editorial.ts';
import { makeObservations, makeProtocol } from '../fixtures/mock-pass2-helpers.ts';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const PROJECT_ID = 'test-project';
const SOURCE_HASH = 'a'.repeat(64);
const TEST_EVENT_ID = 'E-test-001';
const TEST_ACTOR = 'test-actor';
const BASE_ISO = '2026-07-28T00:00:00.000Z';

function sha256Hex(): string {
  return crypto.randomBytes(32).toString('hex');
}

function uuid(): string {
  return crypto.randomUUID();
}

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
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
  const proseHash = hash(overrides.prose);
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
    createdAt: BASE_ISO,
    ...overrides,
  };
}

function makeRepository(): CoreExecutionRepository {
  return new MemoryExecutionRepository();
}

function revisionRecord(envelope: SceneRevisionEnvelopeV1): SceneRevisionRecord {
  return {
    version: 1,
    projectId: PROJECT_ID,
    eventId: envelope.eventId,
    revisionId: envelope.revisionId,
    parentRevisionId: envelope.parentRevisionId,
    sourceHash: SOURCE_HASH,
    value: envelope as unknown as JsonValue,
  };
}

/** Archive a revision with create-once CAS; throws if the revision already exists. */
async function archive(
  repository: CoreExecutionRepository,
  envelope: SceneRevisionEnvelopeV1,
): Promise<number> {
  const result = await repository.compareAndSwapSceneRevision({
    projectId: PROJECT_ID,
    eventId: envelope.eventId,
    revisionId: envelope.revisionId,
    expectedVersion: null,
    value: revisionRecord(envelope),
  });
  if (result.kind === 'conflict') {
    throw new Error(`conflict archiving revision ${envelope.revisionId}`);
  }
  return result.version;
}

/** Advance the accepted scene to the given envelope with an expected-version CAS. */
async function promoteAccepted(
  repository: CoreExecutionRepository,
  envelope: SceneRevisionEnvelopeV1,
  expectedVersion: number | null,
): Promise<number> {
  const result = await repository.compareAndSwapAcceptedScene({
    projectId: PROJECT_ID,
    eventId: envelope.eventId,
    expectedVersion,
    value: {
      version: 1,
      projectId: PROJECT_ID,
      eventId: envelope.eventId,
      sourceHash: SOURCE_HASH,
      revisionId: envelope.revisionId,
      prose: envelope.prose,
      proseHash: envelope.proseHash,
      sceneHash: envelope.sceneHash,
    },
  });
  if (result.kind === 'conflict') {
    throw new Error(`conflict promoting revision ${envelope.revisionId}`);
  }
  return result.version;
}

function runtimeWith(execution: CoreExecutionRepository): EditorialRuntime {
  return {
    services: {
      execution,
      renderCache: new MemoryRenderCacheRepository(),
      stateLog: new MemoryStateLogRepository(),
      stateSnapshots: new MemoryStateSnapshotRepository(),
      promptTemplates: { get: async () => null },
      clock: { now: () => BASE_ISO },
      ids: { next: () => uuid() },
      llm: {} as never,
    },
  };
}

async function readEnvelope(
  repository: CoreExecutionRepository,
  revisionId: string,
): Promise<SceneRevisionEnvelopeV1 | null> {
  const record = await repository.readSceneRevision({
    projectId: PROJECT_ID,
    eventId: TEST_EVENT_ID,
    revisionId,
  });
  return record ? (record.value.value as unknown as SceneRevisionEnvelopeV1) : null;
}

// ─── Scene revision archive tests ───────────────────────────────────────────

describe('scene revision archive (create-once via CAS)', () => {
  it('archives a new revision and reads it back', async () => {
    const repository = makeRepository();
    const revUuid = uuid();
    const envelope = makeSceneEnvelope({
      eventId: TEST_EVENT_ID,
      revisionId: revUuid,
      prose: 'Scene revision prose content.',
    });

    const version = await archive(repository, envelope);
    expect(version).toBe(1);

    const loaded = await readEnvelope(repository, revUuid);
    expect(loaded).not.toBeNull();
    expect(loaded?.revisionId).toBe(revUuid);
    expect(loaded?.prose).toBe('Scene revision prose content.');
    // Stored value stays JSON-safe and schema-clean after the repository round-trip.
    expect(sceneRevisionEnvelopeV1Schema.safeParse(loaded).success).toBe(true);
  });

  it('rejects duplicate revisionId (create-once via CAS)', async () => {
    const repository = makeRepository();
    const revUuid = uuid();
    const envelope = makeSceneEnvelope({
      eventId: TEST_EVENT_ID,
      revisionId: revUuid,
      prose: 'First revision.',
    });
    await archive(repository, envelope);

    const dup = makeSceneEnvelope({
      eventId: TEST_EVENT_ID,
      revisionId: revUuid,
      prose: 'Duplicate revision.',
    });
    const result = await repository.compareAndSwapSceneRevision({
      projectId: PROJECT_ID,
      eventId: TEST_EVENT_ID,
      revisionId: revUuid,
      expectedVersion: null,
      value: revisionRecord(dup),
    });
    expect(result.kind).toBe('conflict');

    // The original immutable revision is unaffected.
    const loaded = await readEnvelope(repository, revUuid);
    expect(loaded?.prose).toBe('First revision.');
  });
});

describe('immutable revision vs accepted scene separation', () => {
  it('archived revision persists even after the accepted scene advances', async () => {
    const repository = makeRepository();
    const uuid1 = uuid();
    const uuid2 = uuid();

    const env1 = makeSceneEnvelope({
      eventId: TEST_EVENT_ID,
      revisionId: uuid1,
      prose: 'Version 1.',
    });
    await archive(repository, env1);
    const acceptedVersion1 = await promoteAccepted(repository, env1, null);

    const env2 = makeSceneEnvelope({
      eventId: TEST_EVENT_ID,
      revisionId: uuid2,
      prose: 'Version 2.',
    });
    await archive(repository, env2);
    await promoteAccepted(repository, env2, acceptedVersion1);

    // Revision 1 is still readable from the archive.
    const loaded1 = await readEnvelope(repository, uuid1);
    expect(loaded1).not.toBeNull();
    expect(loaded1?.revisionId).toBe(uuid1);
    expect(loaded1?.prose).toBe('Version 1.');

    // The accepted scene and resolved artifact point to revision 2.
    const accepted = await repository.readAcceptedScene({
      projectId: PROJECT_ID,
      eventId: TEST_EVENT_ID,
    });
    expect(accepted).not.toBeNull();
    expect(accepted?.value.revisionId).toBe(uuid2);

    const artifact = await repository.resolveAcceptedArtifact({
      projectId: PROJECT_ID,
      eventId: TEST_EVENT_ID,
    });
    expect(artifact).not.toBeNull();
    expect(artifact?.revisionId).toBe(uuid2);
    expect(artifact?.prose).toBe('Version 2.');
  });
});

describe('blocked revision does not displace the accepted scene', () => {
  it('archives a blocked revision while the accepted scene keeps the accepted one', async () => {
    const repository = makeRepository();
    const uuid1 = uuid();
    const uuid2 = uuid();

    const env1 = makeSceneEnvelope({
      eventId: TEST_EVENT_ID,
      revisionId: uuid1,
      prose: 'Accepted version.',
    });
    await archive(repository, env1);
    await promoteAccepted(repository, env1, null);

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
    await archive(repository, env2);

    // Both revisions remain archived.
    const loaded1 = await readEnvelope(repository, uuid1);
    const loaded2 = await readEnvelope(repository, uuid2);
    expect(loaded1?.prose).toBe('Accepted version.');
    expect(loaded2?.releaseDecision.status).toBe('blocked');
    expect(loaded2?.released).toBe(false);

    // The accepted scene still resolves to the accepted revision.
    const accepted = await repository.readAcceptedScene({
      projectId: PROJECT_ID,
      eventId: TEST_EVENT_ID,
    });
    expect(accepted?.value.revisionId).toBe(uuid1);
    const artifact = await repository.resolveAcceptedArtifact({
      projectId: PROJECT_ID,
      eventId: TEST_EVENT_ID,
    });
    expect(artifact?.prose).toBe('Accepted version.');
  });
});

describe('accepted-scene CAS conflict leaves immutable revision readable', () => {
  it('stale expected version conflicts without losing the archived revision', async () => {
    const repository = makeRepository();
    const uuid1 = uuid();
    const uuid2 = uuid();

    const env1 = makeSceneEnvelope({
      eventId: TEST_EVENT_ID,
      revisionId: uuid1,
      prose: 'Base revision.',
    });
    await archive(repository, env1);
    await promoteAccepted(repository, env1, null);

    const env2 = makeSceneEnvelope({
      eventId: TEST_EVENT_ID,
      revisionId: uuid2,
      prose: 'New revision.',
    });
    await archive(repository, env2);

    // Another worker already advanced the accepted scene (version 1); a stale
    // expected version must conflict instead of clobbering it.
    const stale = await repository.compareAndSwapAcceptedScene({
      projectId: PROJECT_ID,
      eventId: TEST_EVENT_ID,
      expectedVersion: 0,
      value: {
        version: 1,
        projectId: PROJECT_ID,
        eventId: TEST_EVENT_ID,
        sourceHash: SOURCE_HASH,
        revisionId: uuid2,
        prose: env2.prose,
        proseHash: env2.proseHash,
        sceneHash: env2.sceneHash,
      },
    });
    expect(stale.kind).toBe('conflict');

    // The archived revision remains readable and the accepted scene is intact.
    const loaded = await readEnvelope(repository, uuid2);
    expect(loaded).not.toBeNull();
    expect(loaded?.revisionId).toBe(uuid2);
    const accepted = await repository.readAcceptedScene({
      projectId: PROJECT_ID,
      eventId: TEST_EVENT_ID,
    });
    expect(accepted?.value.revisionId).toBe(uuid1);
  });
});

describe('facade reads and error contract', () => {
  it('reads an archived revision through getSceneRevision', async () => {
    const repository = makeRepository();
    const revUuid = uuid();
    const envelope = makeSceneEnvelope({
      eventId: TEST_EVENT_ID,
      revisionId: revUuid,
      prose: 'Facade read.',
    });
    await archive(repository, envelope);

    const loaded = await getSceneRevision(
      { projectId: PROJECT_ID, eventId: TEST_EVENT_ID, revisionId: revUuid },
      runtimeWith(repository),
    );
    expect(loaded.revisionId).toBe(revUuid);
    expect(loaded.prose).toBe('Facade read.');
  });

  it('throws REVISION_NOT_FOUND for an unknown revision', async () => {
    const repository = makeRepository();
    await expect(
      getSceneRevision(
        { projectId: PROJECT_ID, eventId: TEST_EVENT_ID, revisionId: uuid() },
        runtimeWith(repository),
      ),
    ).rejects.toThrow('was not found');
  });

  it('requires an explicit semantic runtime', async () => {
    await expect(
      getSceneRevision({ projectId: PROJECT_ID, eventId: TEST_EVENT_ID, revisionId: uuid() }),
    ).rejects.toThrow('CoreExecutionRepository is required');
  });
});

describe('malformed envelope rejected at the schema boundary', () => {
  it('rejects a revisionId that is not a UUID', () => {
    const envelope = makeSceneEnvelope({
      eventId: TEST_EVENT_ID,
      revisionId: 'not-a-uuid',
      prose: 'Bad UUID.',
    });
    expect(sceneRevisionEnvelopeV1Schema.safeParse(envelope).success).toBe(false);
  });

  it('accepts a consistent envelope and rejects stray fields', () => {
    const envelope = makeSceneEnvelope({
      eventId: TEST_EVENT_ID,
      revisionId: uuid(),
      prose: 'Clean envelope.',
    });
    expect(sceneRevisionEnvelopeV1Schema.safeParse(envelope).success).toBe(true);

    const stray = { ...envelope, unexpectedField: true };
    expect(sceneRevisionEnvelopeV1Schema.safeParse(stray).success).toBe(false);
  });

  it('keeps prose content-hash identity intact through the repository', async () => {
    const repository = makeRepository();
    const revUuid = uuid();
    const envelope = makeSceneEnvelope({
      eventId: TEST_EVENT_ID,
      revisionId: revUuid,
      prose: 'Hash-consistent prose.',
    });
    await archive(repository, envelope);

    const loaded = await readEnvelope(repository, revUuid);
    expect(loaded?.proseHash).toBe(hash(loaded?.prose));
    expect(loaded?.sceneHash).toBeTruthy();
  });
});
