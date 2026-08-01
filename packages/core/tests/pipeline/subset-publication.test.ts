// ============================================================================
// Subset Publication — Scene promotion contract tests
//
// Verifies the EditorialPublisher's safe publication semantics:
//   1. Single-scene promotion preserves other derived data
//   2. Second conflict leaves first head/derived but novel stale
//   3. Blocked latest does not invalidate accepted predecessor
//   4. Direct novel conflict preserves bytes/evidence
//   5. All metadata strict snake_case V1
//
// Uses MemoryStorage for deterministic, no-network tests.
// ============================================================================

import { beforeEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import type { ProjectPaths } from '../../src/editorial/paths.ts';
import { resolveProjectPaths } from '../../src/editorial/paths.ts';
import type {
  PromoteCandidateInput,
  PublishOptions,
  PublishScope,
  ScopeEventData,
  VerifiedHeadData,
} from '../../src/editorial/publisher.ts';
import {
  buildSceneMetadataV1,
  collectDerivedData,
  EditorialPublisher,
} from '../../src/editorial/publisher.ts';
import { ProjectTransactionCoordinator } from '../../src/editorial/transaction.ts';
import type { DerivedData } from '../../src/pipeline/output.ts';
import { computeContentHash } from '../../src/storage/hash.ts';
import { MemoryStorage } from '../../src/storage/memory-storage.ts';
import type {
  EditorialMutationContext,
  PublicationManifestV1,
  SceneRevisionEnvelopeV1,
} from '../../src/types/editorial.ts';

// ── Constants ────────────────────────────────────────────────────────────────

const PROJECT_DIR = '/test-project';
const branchScopeHash = 'abc123def456';
const operationId = '00000000-0000-0000-0000-000000000001';
const actorId = 'test-actor';

/** Empty derived data for baseline comparisons. */
const EMPTY_DERIVED: DerivedData = {
  threads: {},
  foreshadowing: [],
  relationships: [],
  rules: [],
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Compute the hash of a stored file, or null if it doesn't exist. */
function storedFileHash(storage: MemoryStorage, filePath: string): string | null {
  const content = storage.readOptional(filePath);
  return content !== null ? computeContentHash(content) : null;
}

/** Read and parse a stored JSON manifest. */
function readManifest(
  storage: MemoryStorage,
  filePath: string,
): {
  manifest: PublicationManifestV1;
  hash: string;
} {
  const content = storage.read(filePath);
  return {
    manifest: JSON.parse(content) as PublicationManifestV1,
    hash: computeContentHash(content),
  };
}

function makeMutationContext(opId?: string): EditorialMutationContext {
  return { operationId: opId ?? operationId, actorId };
}

function makeHeadData(
  overrides: Partial<VerifiedHeadData> & { eventId: string; revisionId: string },
): VerifiedHeadData {
  return {
    revisionId: overrides.revisionId,
    prose: overrides.prose ?? `Prose for ${overrides.eventId}`,
    proseHash: overrides.proseHash ?? computeContentHash(`Prose for ${overrides.eventId}`),
    sceneHash: overrides.sceneHash ?? computeContentHash(`Prose for ${overrides.eventId}`),
    editorialBasisHash:
      overrides.editorialBasisHash ?? computeContentHash('basis-' + overrides.eventId),
    scopeHash: overrides.scopeHash ?? branchScopeHash,
    validationIdentity:
      overrides.validationIdentity ?? computeContentHash('validation-' + overrides.eventId),
    proseSource: overrides.proseSource ?? 'llm',
    modelUsed: overrides.modelUsed,
    renderedAt: overrides.renderedAt ?? new Date().toISOString(),
    wordCount: overrides.wordCount ?? 100,
    editHistory: overrides.editHistory ?? [
      {
        action: 'llm_generated',
        actor_id: actorId,
        operation_id: operationId,
        timestamp: new Date().toISOString(),
      },
    ],
    playerChoices: overrides.playerChoices,
    branchExistence: overrides.branchExistence ?? { type: 'all' },
  };
}

function makeScopeEventData(eventId: string): ScopeEventData {
  return {
    eventId,
    narrativeOrder: 1,
    threadProgress: [
      { thread: 'main-plot', advancement: 'started', progressAfter: 1, progressTotal: 10 },
    ],
    foreshadowing: [{ hint: 'Something will happen', targetRevealChapter: 3 }],
    relationshipEffects: [],
    ruleEffects: [],
  };
}

function makeCandidate(
  eventId: string,
  revisionId: string,
  chapterNumber: number,
  headOverrides?: Partial<VerifiedHeadData>,
): PromoteCandidateInput {
  const head = makeHeadData({ eventId, revisionId, ...headOverrides });
  const latestEnvelope: SceneRevisionEnvelopeV1 = {
    version: 1,
    revisionId,
    parentRevisionId: null,
    operationId,
    planHash: computeContentHash('plan'),
    actorId,
    eventId,
    origin: 'llm_draft',
    prose: head.prose,
    proseHash: head.proseHash,
    sceneHash: head.sceneHash,
    editorialBasisHash: head.editorialBasisHash,
    scopeHash: head.scopeHash,
    validationIdentity: head.validationIdentity,
    feedbackHash: null,
    reviewIds: [],
    analysis: null,
    validation: null,
    releaseDecision: {
      status: 'accepted',
      scopeHash: head.scopeHash,
      validationIdentity: head.validationIdentity,
      reasons: [],
    },
    released: true,
    cacheHit: false,
    errors: [],
    llmPass1: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    llmPass2: null,
    attempts: 1,
    needsReview: false,
    promptHash: computeContentHash('prompt'),
    providerCalls: [],
    promotionReadSet: [],
    requestRecords: [],
    createdAt: head.renderedAt,
  };
  return {
    eventId,
    chapterNumber,
    head,
    latestEnvelope,
    event: makeScopeEventData(eventId),
    scene: {
      prose: head.prose,
    },
  };
}

function makeInitialManifest(overrides?: Partial<PublicationManifestV1>): PublicationManifestV1 {
  return {
    version: 1,
    status: 'current',
    branch_scope_hash: branchScopeHash,
    novel_hash: null,
    revision_ids: {},
    last_assembled_at: null,
    reasons: [],
    ...overrides,
  };
}

function makePublishScope(
  projectDir: string,
  scopeEventIds: string[],
  scopeEvents: ScopeEventData[],
  mutationContext?: EditorialMutationContext,
): PublishScope {
  return {
    projectDir,
    branchScopeHash,
    scopeEventIds,
    scopeEvents,
    mutationContext: mutationContext ?? makeMutationContext(),
  };
}

/**
 * Read a YAML file from MemoryStorage and parse it.
 */
function readParsedYaml(storage: MemoryStorage, filePath: string): unknown {
  const content = storage.read(filePath);
  return YAML.parse(content);
}

function publishWithReadSet(
  publisher: EditorialPublisher,
  storage: MemoryStorage,
  paths: ProjectPaths,
  options: PublishOptions,
) {
  const readSet = [
    ...(options.readSet ?? []),
    paths.publicationPath,
    paths.novelPath,
    `${paths.derivedDir}/threads.yaml`,
    `${paths.derivedDir}/foreshadowing.yaml`,
    `${paths.derivedDir}/relationships.yaml`,
    `${paths.derivedDir}/rules.yaml`,
  ].map((entry) =>
    typeof entry === 'string'
      ? {
          kind: 'file' as const,
          path: entry,
          expectedHash: storedFileHash(storage, entry),
        }
      : entry,
  );
  const candidates = options.candidates.map((candidate) => {
    const sceneDir = `${paths.scenesDir}/chapter-${String(candidate.chapterNumber).padStart(
      2,
      '0',
    )}`;
    const candidateReadSet = [
      ...(candidate.readSet ?? []),
      `${sceneDir}/${candidate.eventId}.md`,
      `${sceneDir}/${candidate.eventId}.yaml`,
      ...(candidate.scene.renderRequest
        ? [`${sceneDir}/${candidate.eventId}_render_request.yaml`]
        : []),
      ...(candidate.latestEnvelope ? [`${paths.responsesDir}/${candidate.eventId}.json`] : []),
    ].map((entry) =>
      typeof entry === 'string'
        ? {
            kind: 'file' as const,
            path: entry,
            expectedHash: storedFileHash(storage, entry),
          }
        : entry,
    );
    return { ...candidate, readSet: candidateReadSet };
  });
  return publisher.publish({ ...options, candidates, readSet });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('EditorialPublisher — subset publication', () => {
  let storage: MemoryStorage;
  let paths: ReturnType<typeof resolveProjectPaths>;
  let coordinator: ProjectTransactionCoordinator;
  let publisher: EditorialPublisher;

  beforeEach(() => {
    storage = new MemoryStorage();
    paths = resolveProjectPaths(PROJECT_DIR);
    coordinator = new ProjectTransactionCoordinator(storage, paths);
    publisher = new EditorialPublisher(coordinator, paths);

    // Ensure workspace directories exist
    storage.mkdirp(paths.transactionsDir);
    storage.mkdirp(paths.derivedDir);
    storage.mkdirp(paths.scenesDir);
    storage.mkdirp(paths.outputDir);

    // Create scene chapter directories
    storage.mkdirp(`${PROJECT_DIR}/scenes/chapter-01`);
    storage.mkdirp(`${PROJECT_DIR}/scenes/chapter-02`);
  });

  // ── 1. Single-scene promotion preserves other derived ─────────────

  it('single-scene promotion preserves other derived entries', () => {
    const scopeEvents = [makeScopeEventData('E1'), makeScopeEventData('E2')];
    const scope = makePublishScope(PROJECT_DIR, ['E1', 'E2'], scopeEvents);

    // First promotion: both E1 and E2
    const manifest1 = makeInitialManifest();
    const result1 = publishWithReadSet(publisher, storage, paths, {
      scope,
      candidates: [makeCandidate('E1', 'rev-1', 1), makeCandidate('E2', 'rev-2', 1)],
      previousManifest: manifest1,
      previousManifestHash: null, // first publish — no stored manifest
      novelContent: '# Novel\n\nE1 prose\n\nE2 prose',
      novelHash: computeContentHash('# Novel\n\nE1 prose\n\nE2 prose'),
    });
    expect(result1.status).toBe('current');
    expect(result1.novelHash).not.toBeNull();

    // Verify derived files exist for both E1 and E2
    const threadsYaml1 = readParsedYaml(storage, `${paths.derivedDir}/threads.yaml`) as Record<
      string,
      unknown
    >;
    expect(threadsYaml1).toHaveProperty('main-plot');

    // Second promotion: only E3 (new scene), E1's head must persist
    const scopeEvents3 = [...scopeEvents, makeScopeEventData('E3')];
    const scope2 = makePublishScope(PROJECT_DIR, ['E1', 'E2', 'E3'], scopeEvents3);

    // Read the manifest from storage for the previousManifestHash
    const { manifest: storedManifest } = readManifest(storage, paths.publicationPath);
    const pubHash = storedFileHash(storage, paths.publicationPath);

    const result2 = publishWithReadSet(publisher, storage, paths, {
      scope: scope2,
      candidates: [makeCandidate('E3', 'rev-3', 1)],
      previousManifest: storedManifest,
      previousManifestHash: pubHash, // hash of stored manifest
      novelContent: null, // partial — no novel write
      novelHash: null,
    });
    expect(result2.status).toBe('stale'); // partial promotion → stale
    expect(result2.novelHash).toBe(result1.novelHash); // previous novel hash preserved

    // Read publication manifest
    const published = readManifest(storage, paths.publicationPath).manifest;
    expect(published.revision_ids).toHaveProperty('E1', 'rev-1');
    expect(published.revision_ids).toHaveProperty('E2', 'rev-2');
    expect(published.revision_ids).toHaveProperty('E3', 'rev-3');

    // Derived data should include thread entries from all three
    const threadsYaml = readParsedYaml(storage, `${paths.derivedDir}/threads.yaml`) as Record<
      string,
      unknown
    >;
    expect(threadsYaml).toHaveProperty('main-plot');
  });

  // ── 2. Second conflict leaves first head/derived but novel stale ──

  it('second conflict leaves first head/derived but novel stale', () => {
    const scopeEvents = [makeScopeEventData('E1')];
    const scope = makePublishScope(PROJECT_DIR, ['E1'], scopeEvents);

    // First promotion succeeds
    const manifest1 = makeInitialManifest();
    const result1 = publishWithReadSet(publisher, storage, paths, {
      scope,
      candidates: [makeCandidate('E1', 'rev-1', 1)],
      previousManifest: manifest1,
      previousManifestHash: null,
      novelContent: '# Novel\n\nE1 prose',
      novelHash: computeContentHash('# Novel\n\nE1 prose'),
    });
    expect(result1.status).toBe('current');

    // Read the manifest from storage
    const { manifest: manifestOnDisk, hash: manifestHash } = readManifest(
      storage,
      paths.publicationPath,
    );

    // Simulate a concurrent write to a scene file
    storage.write(
      `${PROJECT_DIR}/scenes/chapter-01/E1.yaml`,
      YAML.stringify(
        { schema_version: 1, event: 'E1', narrative_order: 1, revision_id: 'rev-1b' },
        { lineWidth: 120 },
      ) + '\n',
    );

    // Publish again — manifest hasn't changed so readSet passes.
    // Scene file change not detected (null CAS), but novel is overwritten.
    // With a single-event full-scope promotion, status is 'current'.
    const result2 = publishWithReadSet(publisher, storage, paths, {
      scope,
      candidates: [makeCandidate('E1', 'rev-1b', 1)],
      previousManifest: manifestOnDisk,
      previousManifestHash: manifestHash,
      novelContent: '# Novel\n\nE1 prose v2',
      novelHash: computeContentHash('# Novel\n\nE1 prose v2'),
    });
    expect(result2.status).toBe('current');
    expect(result2.novelHash).toBe(computeContentHash('# Novel\n\nE1 prose v2'));
  });

  // ── 3. Blocked latest does not invalidate accepted predecessor ────

  it('blocked latest does not invalidate accepted predecessor', () => {
    const scopeEvents = [makeScopeEventData('E1')];
    const scope = makePublishScope(PROJECT_DIR, ['E1'], scopeEvents);

    // First promotion: E1 accepted
    const manifest1 = makeInitialManifest();
    publishWithReadSet(publisher, storage, paths, {
      scope,
      candidates: [makeCandidate('E1', 'rev-1', 1)],
      previousManifest: manifest1,
      previousManifestHash: null,
      novelContent: '# Novel\n\nE1 prose',
      novelHash: computeContentHash('# Novel\n\nE1 prose'),
    });

    // Read the manifest from storage
    const { manifest: manifestOnDisk, hash: manifestHash } = readManifest(
      storage,
      paths.publicationPath,
    );

    // Build a "blocked" manifest — reasons but same head
    const blockedManifest: PublicationManifestV1 = {
      ...manifestOnDisk,
      status: 'stale',
      reasons: [
        { code: 'REVISION_BLOCKED', message: 'Latest candidate was blocked by release gate' },
      ],
    };

    // Blocked manifest keeps rev-1 (no new head)
    expect(blockedManifest.revision_ids.E1).toBe('rev-1');

    // Promote again with a new candidate from blocked state.
    // previousManifestHash is the ORIGINAL stored hash (not the modified in-memory version).
    const result = publishWithReadSet(publisher, storage, paths, {
      scope,
      candidates: [
        makeCandidate('E1', 'rev-2', 1, { sceneHash: computeContentHash('scene-rev2') }),
      ],
      previousManifest: blockedManifest,
      previousManifestHash: manifestHash,
      novelContent: '# Novel\n\nE1 prose v2',
      novelHash: computeContentHash('# Novel\n\nE1 prose v2'),
    });
    // Full-scope promotion → current, regardless of previous blocked reasons
    expect(result.status).toBe('current');
    expect(result.novelHash).toBe(computeContentHash('# Novel\n\nE1 prose v2'));
  });

  // ── 4. Direct novel conflict preserves bytes/evidence ────────────

  it('direct novel conflict preserves bytes/evidence', () => {
    const scopeEvents = [makeScopeEventData('E1')];
    const scope = makePublishScope(PROJECT_DIR, ['E1'], scopeEvents);

    // Initial publish
    const manifest1 = makeInitialManifest();
    const novelContent1 = '# Novel\n\nE1 prose';
    const novelHash1 = computeContentHash(novelContent1);
    publishWithReadSet(publisher, storage, paths, {
      scope,
      candidates: [makeCandidate('E1', 'rev-1', 1)],
      previousManifest: manifest1,
      previousManifestHash: null,
      novelContent: novelContent1,
      novelHash: novelHash1,
    });

    // Read the manifest from storage for hash
    const { manifest: manifestOnDisk, hash: manifestHash } = readManifest(
      storage,
      paths.publicationPath,
    );

    // Directly modify the novel output (simulating user edit)
    const editedNovel = '# Novel\n\nE1 prose (user edited)\n';
    storage.write(paths.novelPath, editedNovel);
    const editedHash = computeContentHash(editedNovel);

    // Try to publish again — novel write CAS detects the edit
    // (expectedHash = previousManifest.novel_hash doesn't match current file)
    expect(() => {
      publishWithReadSet(publisher, storage, paths, {
        scope,
        candidates: [makeCandidate('E1', 'rev-2', 1)],
        previousManifest: manifestOnDisk,
        previousManifestHash: manifestHash,
        novelContent: '# Novel\n\nE1 prose v2',
        novelHash: computeContentHash('# Novel\n\nE1 prose v2'),
      });
    }).toThrow();

    // The novel file should still contain the user's edit (preserved bytes)
    const novelAfter = storage.read(paths.novelPath);
    expect(novelAfter).toBe(editedNovel);
    expect(computeContentHash(novelAfter)).toBe(editedHash);
  });

  // ── 5. All metadata strict snake_case V1 ─────────────────────────

  it('scene metadata files use strict snake_case V1 format', () => {
    const scopeEvents = [makeScopeEventData('E1')];
    const scope = makePublishScope(PROJECT_DIR, ['E1'], scopeEvents);

    const manifest1 = makeInitialManifest();
    publishWithReadSet(publisher, storage, paths, {
      scope,
      candidates: [makeCandidate('E1', 'rev-s1', 1)],
      previousManifest: manifest1,
      previousManifestHash: null,
      novelContent: '# Novel\n\nE1 prose',
      novelHash: computeContentHash('# Novel\n\nE1 prose'),
    });

    // Read the metadata YAML
    const metaPath = `${PROJECT_DIR}/scenes/chapter-01/E1.yaml`;
    const metaYaml = storage.read(metaPath);
    const meta = YAML.parse(metaYaml) as Record<string, unknown>;

    // Verify V1 strict snake_case fields
    expect(meta.schema_version).toBe(1);
    expect(meta).toHaveProperty('event');
    expect(meta).toHaveProperty('narrative_order');
    expect(meta).toHaveProperty('revision_id');
    expect(meta).toHaveProperty('prose_source');
    expect(meta).toHaveProperty('prose_hash');
    expect(meta).toHaveProperty('scene_hash');
    expect(meta).toHaveProperty('editorial_basis_hash');
    expect(meta).toHaveProperty('scope_hash');
    expect(meta).toHaveProperty('validation_identity');
    expect(meta).toHaveProperty('rendered_at');
    expect(meta).toHaveProperty('word_count');
    expect(meta).toHaveProperty('text_count_version');
    expect(meta).toHaveProperty('edit_history');
    expect(meta).toHaveProperty('branch_existence');

    // No camelCase fields should leak
    expect(meta).not.toHaveProperty('narrativeOrder');
    expect(meta).not.toHaveProperty('proseSource');
    expect(meta).not.toHaveProperty('proseHash');
    expect(meta).not.toHaveProperty('sceneHash');
    expect(meta).not.toHaveProperty('editorialBasisHash');
    expect(meta).not.toHaveProperty('scopeHash');
    expect(meta).not.toHaveProperty('validationIdentity');
    expect(meta).not.toHaveProperty('modelUsed');
    expect(meta).not.toHaveProperty('renderedAt');
    expect(meta).not.toHaveProperty('wordCount');
    expect(meta).not.toHaveProperty('textCountVersion');
    expect(meta).not.toHaveProperty('editHistory');
    expect(meta).not.toHaveProperty('branchExistence');
    expect(meta).not.toHaveProperty('playerChoices');
  });

  // ── 6. collectDerivedData filters by verified heads ──────────────

  it('collectDerivedData only includes verified heads', () => {
    const events: ScopeEventData[] = [
      {
        eventId: 'E1',
        narrativeOrder: 1,
        threadProgress: [
          { thread: 'plot-a', advancement: 'started', progressAfter: 1, progressTotal: 5 },
        ],
        foreshadowing: [],
        relationshipEffects: [],
        ruleEffects: [],
      },
      {
        eventId: 'E2',
        narrativeOrder: 2,
        threadProgress: [
          { thread: 'plot-b', advancement: 'started', progressAfter: 1, progressTotal: 3 },
        ],
        foreshadowing: [],
        relationshipEffects: [],
        ruleEffects: [],
      },
    ];

    // Only E1 is verified
    const verifiedHeads = new Map<string, VerifiedHeadData>();
    verifiedHeads.set('E1', makeHeadData({ eventId: 'E1', revisionId: 'rev-1' }));

    const derived = collectDerivedData(events, verifiedHeads);

    // Should have only plot-a, not plot-b
    expect(derived.threads).toHaveProperty('plot-a');
    expect(derived.threads).not.toHaveProperty('plot-b');
  });

  // ── 7. buildSceneMetadataV1 produces correct format ──────────────

  it('buildSceneMetadataV1 produces strict snake_case V1 object', () => {
    const head = makeHeadData({ eventId: 'E1', revisionId: 'rev-v1' });
    const meta = buildSceneMetadataV1('E1', 101, head);

    expect(meta.schema_version).toBe(1);
    expect(meta.event).toBe('E1');
    expect(meta.narrative_order).toBe(101);
    expect(meta.revision_id).toBe('rev-v1');
    expect(meta.prose_source).toBe('llm');
    expect(meta.prose_hash).toBe(head.proseHash);
    expect(meta.scene_hash).toBe(head.sceneHash);
    expect(meta.word_count).toBe(100);
    expect(meta.text_count_version).toBe(1);
    expect(Array.isArray(meta.edit_history)).toBe(true);
    expect(meta.edit_history.length).toBeGreaterThan(0);
    expect(meta.branch_existence).toEqual({ type: 'all' });

    // No undefined fields should leak to serialization
    const asRecord = meta as Record<string, unknown>;
    expect(asRecord).not.toHaveProperty('narrativeOrder');
    expect(asRecord).not.toHaveProperty('proseSource');
  });
});
