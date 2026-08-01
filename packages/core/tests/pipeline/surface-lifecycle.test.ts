// ============================================================================
// Surface Lifecycle — Integration tests for surface-plan config,
// dependency-ready wave scheduling, per-wave release gate, and
// accepted-only assembly/output.
//
// Each test creates a minimal MemoryStorage project with multiple events,
// a renderSurface config specifying serial lanes, and uses MockPass2Provider
// for deterministic Pass 1 / Pass 2 output.
// ============================================================================

import * as crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type MockPass2Entry, MockPass2Provider } from '../../src/ai/providers/mock-pass2.ts';
import type { RenderNovelResult } from '../../src/api.ts';
import { previewEditorialRun, renderNovel } from '../../src/api.ts';
import { sha256Canonical } from '../../src/cache/render-cache.ts';
import { AcceptedArtifactResolver } from '../../src/pipeline/surface-scheduler.ts';
import { canonicalJson, computeSha256Hex } from '../../src/render/scene-contract.ts';
import { MemoryStorage } from '../../src/storage/memory-storage.ts';
import type { ReleaseDecision } from '../../src/types/index.ts';
import { makeCustomEntry, makeObservations, makeProtocol } from '../fixtures/mock-pass2-helpers.ts';

// ── Constants ────────────────────────────────────────────────────────────────

const PROJECT_DIR = '/test-project';

const SAMPLE_PROSE =
  'The morning light filtered through the tall windows of the converted ' +
  'conference room, painting golden rectangles across the scuffed wooden floor.';

const ANALYSIS_PAYLOAD: Record<string, unknown> = {
  postconditions: { covered: [], dropped: [] },
  preconditions: { violated: [] },
  pov: { consistent: true, leaks: [] },
  inventedDetails: [],
  quality: {
    proseScore: 4,
    maxScore: 5,
    strengths: ['clear prose'],
    weaknesses: ['slightly dry'],
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

function makeEntry(eventId: string, prose?: string): MockPass2Entry {
  const text = prose ?? `Test prose for event ${eventId}. ${SAMPLE_PROSE}`;
  return makeCustomEntry(eventId, text, {
    eventId,
    protocol: makeProtocol(text),
    observations: makeObservations(ANALYSIS_PAYLOAD, text),
    analysis: ANALYSIS_PAYLOAD,
  });
}

/**
 * Build a minimal YAML project with the given event IDs and optional
 * renderSurface YAML block. Each event gets a basic scene definition.
 */
function setupProject(
  storage: MemoryStorage,
  eventIds: string[],
  renderSurfaceYaml?: string,
): void {
  // ── Project config ─────────────────────────────────────────────
  const lines = [
    'project: test-project',
    'title: Test Novel',
    'author: Test Author',
    'defaultModel: mock-pass2',
    'defaultLanguage: en',
  ];
  if (renderSurfaceYaml) {
    lines.push('renderSurface:');
    for (const line of renderSurfaceYaml.split('\n')) {
      lines.push(`  ${line}`);
    }
  }
  storage.write(`${PROJECT_DIR}/nova.yaml`, lines.join('\n'));

  // ── Definitions ────────────────────────────────────────────────
  storage.mkdirp(`${PROJECT_DIR}/definitions`);
  storage.write(
    `${PROJECT_DIR}/definitions/state_initial.yaml`,
    [
      'info:',
      '  currentEra: "contemporary"',
      '  politicalSituation: "stable"',
      'timeAnchors:',
      '  - { id: day_1, at: day_1, description: "Day 1" }',
      'threads: []',
      'worldFacts: []',
    ].join('\n'),
  );
  // entity-types.yaml (required — EntityMapper reads it via readYamlFile; the
  // runtime kernel compiles it into the EntityTypeCatalog that write-policy
  // validation checks, so the fixture must declare the character kind and the
  // lifecycle attribute the baseline activation writes)
  storage.write(
    `${PROJECT_DIR}/definitions/entity-types.yaml`,
    [
      'types:',
      '  character:',
      '    typeId: character',
      '    kind: character',
      '    attributes:',
      '      lifecycle:',
      '        attributeId: lifecycle',
      '        valueType: string',
      '        requiredAt: introduction',
      '        writePolicy: lifecycle_managed',
      '        allowedLifecycleStates: [active, inactive, retired]',
      '        unsetAllowed: false',
      '        semanticRole: lifecycle',
      '      traits:',
      '        attributeId: traits',
      '        valueType: string_list',
      '        requiredAt: never',
      '        writePolicy: immutable',
      '        unsetAllowed: true',
      '    lifecyclePolicy:',
      '      allowedTransitions:',
      '        - [active, inactive]',
      '        - [active, retired]',
      '        - [inactive, active]',
      '        - [inactive, retired]',
      '    referenceCapabilities:',
      '      defaultEligibility: live',
      '    typedInvariants: []',
    ].join('\n'),
  );

  // POV character — declared so the entity registry resolves the narrator
  // (POVValidator emits an error otherwise) and the baseline activation
  // writes its lifecycle initial fact.
  storage.mkdirp(`${PROJECT_DIR}/definitions/characters`);
  storage.write(
    `${PROJECT_DIR}/definitions/characters/narrator.yaml`,
    [
      'id: narrator',
      'name: Narrator',
      'type: person',
      'description: "The story narrator"',
      'initialState: {}',
      'traits: []',
    ].join('\n'),
  );

  // ── Discourse ledger ───────────────────────────────────────────
  const sceneIdsYaml = eventIds.map((id: string) => `      - ${id}`).join('\n');
  storage.write(
    `${PROJECT_DIR}/definitions/discourse-ledger.yaml`,
    [
      'id: test_ledger',
      'chapters:',
      '  - branch: main',
      '    chapter: 1',
      '    sceneIds:',
      sceneIdsYaml,
      'entries: []',
    ].join('\n'),
  );

  // ── Chapters & events ──────────────────────────────────────────
  storage.mkdirp(`${PROJECT_DIR}/chapters/chapter_01`);
  const chapterEvents = eventIds.map((id, i) => {
    const fileContent = [
      `event: ${id}`,
      `narrativeOrder: ${i + 1}`,
      `title: "${id} scene"`,
      'storyTime: day_1',
      'pov:',
      '  character: narrator',
      '  type: first_person',
      'sceneBrief: "Test scene"',
      'beats:',
      '  - "Test scene"',
      'preconditions: []',
      'expectedPostconditions: []',
    ].join('\n');
    storage.write(`${PROJECT_DIR}/chapters/chapter_01/${id}.yaml`, fileContent);
    return { event: id };
  });

  storage.write(
    `${PROJECT_DIR}/chapters/chapter_01/_chapter.yaml`,
    [
      'chapter: 1',
      'title: "Chapter 1"',
      'summary: "Lifecycle fixture"',
      'intent: "Exercise surface scheduling"',
      `plannedScenes: ${eventIds.length}`,
    ].join('\n'),
  );
}

/**
 * Configure a serial lane surface plan for the given event IDs.
 * Each event becomes its own serial_surface group in the lane.
 */
function serialLaneYaml(eventIds: string[]): string {
  const groups = eventIds
    .map(
      (id, i) => `
  - groupId: group_${i}
    sceneIds: [${id}]
    surfacePolicy: serial_surface`,
    )
    .join('');

  return `
mode: manual
groups:${groups}
lanes:
  - laneId: main_lane
    groupIds: [${eventIds.map((_, i) => `group_${i}`).join(', ')}]`;
}

/**
 * Configure a serial lane where the last event uses fallback_without_surface.
 */
function fallbackLaneYaml(eventIds: string[]): string {
  const groups = eventIds
    .map((id, i) => {
      const isLast = i === eventIds.length - 1;
      return `
  - groupId: group_${i}
    sceneIds: [${id}]
    surfacePolicy: ${isLast ? 'fallback_without_surface' : 'serial_surface'}`;
    })
    .join('');

  return `
mode: manual
groups:${groups}
lanes:
  - laneId: main_lane
    groupIds: [${eventIds.map((_, i) => `group_${i}`).join(', ')}]`;
}

function trackProvider(inner: MockPass2Provider): {
  provider: MockPass2Provider;
  callCount: () => number;
} {
  let count = 0;
  const originalComplete = inner.complete.bind(inner);
  inner.complete = async (req) => {
    count++;
    return originalComplete(req);
  };
  return {
    provider: inner,
    callCount: () => count,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('Surface Lifecycle — serial dependency scheduling', () => {
  // ── 1. Serial packet only after accepted source ──────────────────────────

  it('serial dependent receives packet when predecessor is accepted', async () => {
    const storage = new MemoryStorage();
    setupProject(storage, ['E1', 'E2'], serialLaneYaml(['E1', 'E2']));

    const entries: Record<string, MockPass2Entry> = {
      E1: makeEntry('E1'),
      E2: makeEntry('E2'),
    };
    const { provider, callCount } = trackProvider(new MockPass2Provider({ entries }));

    const result = await renderNovel(
      {
        version: 1,
        projectDir: PROJECT_DIR,
        mutation: { operationId: '00000001-0001-4001-8001-000000000001', actorId: 'test' },
        model: 'mock-pass2',
      },
      { storage, provider },
    );

    // Both scenes should render and be accepted
    expect(result.errors).toHaveLength(0);
    expect(result.results).toHaveLength(2);

    const e1 = result.results.find((r) => r.eventId === 'E1')!;
    const e2 = result.results.find((r) => r.eventId === 'E2')!;

    expect(e1.released).toBe(true);
    expect(e2.released).toBe(true);
    expect(e1.prose).toBeTruthy();
    expect(e2.prose).toBeTruthy();

    // E2's response file should reference predecessor context
    const responseDir = `${PROJECT_DIR}/.nova/responses`;
    const e2Response = JSON.parse(storage.read(`${responseDir}/E2.json`));
    expect(e2Response).toBeTruthy();
    expect(e2Response.prose).toBe(entries.E2.prose);

    // V1 result fields
    expect(result.operationId).toBe('00000001-0001-4001-8001-000000000001');
    expect(result.publication.status).toBe('current');
    expect(result.publication.novelHash).toBeTruthy();
    expect(result.editorialErrors).toHaveLength(0);
    expect(e1.disposition).toBe('candidate_promoted');
    expect(e2.disposition).toBe('candidate_promoted');
  });

  // ── 2. Rejected source blocks only descendants ───────────────────────────

  it('blocked predecessor blocks serial descendant', async () => {
    const storage = new MemoryStorage();
    setupProject(storage, ['E1', 'E2'], serialLaneYaml(['E1', 'E2']));

    // E1 gets empty prose → blocked. E2 gets predecessor error.
    const entries: Record<string, MockPass2Entry> = {
      E1: makeEntry('E1', ''),
      E2: makeEntry('E2'),
    };
    const { provider } = trackProvider(new MockPass2Provider({ entries }));

    const result = await renderNovel(
      {
        version: 1,
        projectDir: PROJECT_DIR,
        mutation: { operationId: '00000002-0002-4002-8002-000000000002', actorId: 'test' },
        model: 'mock-pass2',
      },
      { storage, provider },
    );

    // E1 attempted rendering but got blocked (empty prose)
    // E2 cannot render because E1's source is not accepted and not persisted
    expect(result.results).toHaveLength(2);

    const e1 = result.results.find((r) => r.eventId === 'E1')!;
    const e2 = result.results.find((r) => r.eventId === 'E2')!;

    expect(e1.released).toBe(false);
    expect(e2.released).toBe(false);

    // E2 should have predecessor-blocked error
    expect(
      e2.errors.some((msg) => msg.includes('not accepted and no surface source available')),
    ).toBe(true);
    expect(e2.prose).toBe('');

    // V1 result fields
    expect(result.operationId).toBe('00000002-0002-4002-8002-000000000002');
    expect(result.publication.status).toBe('stale');
    expect(result.publication.novelHash).toBeNull();
    expect(e1.disposition).toBe('candidate_blocked');
    expect(e2.disposition).toBe('candidate_blocked');
  });

  // ── 3. Fallback — dependent renders without packet ───────────────────────

  it('fallback_without_surface renders when predecessor is blocked', async () => {
    const storage = new MemoryStorage();
    setupProject(storage, ['E1', 'E2'], fallbackLaneYaml(['E1', 'E2']));

    // E1 blocked (empty prose), E2 should still render because of fallback policy
    const entries: Record<string, MockPass2Entry> = {
      E1: makeEntry('E1', ''),
      E2: makeEntry('E2'),
    };
    const { provider } = trackProvider(new MockPass2Provider({ entries }));

    const result = await renderNovel(
      {
        version: 1,
        projectDir: PROJECT_DIR,
        mutation: { operationId: '00000003-0003-4003-8003-000000000003', actorId: 'test' },
        model: 'mock-pass2',
      },
      { storage, provider },
    );

    expect(result.results).toHaveLength(2);

    const e1 = result.results.find((r) => r.eventId === 'E1')!;
    const e2 = result.results.find((r) => r.eventId === 'E2')!;

    // E1 blocked (empty prose)
    expect(e1.released).toBe(false);

    // E2 rendered despite missing predecessor — fallback_without_surface
    expect(e2.released).toBe(true);
    expect(e2.prose).toBe(entries.E2.prose);
    expect(e2.errors).not.toContain(expect.stringMatching(/not accepted and no surface source/));

    // V1 result fields
    expect(result.operationId).toBe('00000003-0003-4003-8003-000000000003');
    expect(result.publication.status).toBe('stale');
    expect(result.publication.novelHash).toBeNull();
    expect(e1.disposition).toBe('candidate_blocked');
    expect(e2.disposition).toBe('candidate_promoted');
  });

  // ── 4. Missing source — subset render with unknown predecessor ──────────

  it('subset render with missing predecessor yields blocked with predecessor error', async () => {
    const storage = new MemoryStorage();
    setupProject(storage, ['E1', 'E2'], serialLaneYaml(['E1', 'E2']));

    // Request only E2; E1 is not selected but is E2's predecessor.
    // E1 has no persisted accepted response → E2 blocked.
    const entries: Record<string, MockPass2Entry> = {
      E2: makeEntry('E2'),
    };
    const { provider } = trackProvider(new MockPass2Provider({ entries }));

    const result = await renderNovel(
      {
        version: 1,
        projectDir: PROJECT_DIR,
        mutation: { operationId: '00000004-0004-4004-8004-000000000004', actorId: 'test' },
        model: 'mock-pass2',
        selector: { type: 'events', eventIds: ['E2'] },
      },
      { storage, provider },
    );

    // E2 fails with predecessor error because E1 was never rendered/accepted
    expect(result.results).toHaveLength(1);
    const e2 = result.results[0]!;
    expect(e2.released).toBe(false);
    expect(
      e2.errors.some((msg) => msg.includes('not accepted and no surface source available')),
    ).toBe(true);
    expect(e2.prose).toBe('');

    // V1 result fields
    expect(result.operationId).toBe('00000004-0004-4004-8004-000000000004');
    expect(result.publication.status).toBe('stale');
    expect(result.publication.novelHash).toBeNull();
    expect(e2.disposition).toBe('candidate_blocked');
  });
  it('subset render accepts a persisted predecessor with matching scope', async () => {
    const storage = new MemoryStorage();
    setupProject(storage, ['E1', 'E2'], serialLaneYaml(['E1', 'E2']));
    const ledgerHash = sha256Canonical({
      id: 'test_ledger',
      chapters: [{ branch: 'main', chapter: 1, sceneIds: ['E1', 'E2'] }],
      entries: [],
    });
    const scopeHash = computeSha256Hex(
      canonicalJson({ branch: { decisions: [] }, discourse: 'main', ledgerHash }),
    );
    const prose = 'Accepted predecessor prose.';
    const revisionId = '00000000-0000-4000-8000-0000000000e1';
    const envelope = {
      version: 1 as const,
      revisionId,
      parentRevisionId: null,
      operationId: '00000000-0000-4000-8000-0000000000a1',
      planHash: computeSha256Hex('plan-e1'),
      actorId: 'test',
      eventId: 'E1',
      origin: 'llm_draft' as const,
      prose,
      proseHash: computeSha256Hex(prose),
      sceneHash: computeSha256Hex(prose),
      editorialBasisHash: computeSha256Hex('basis-e1'),
      scopeHash,
      validationIdentity: 'test',
      modelUsed: 'mock-pass2',
      feedbackHash: null,
      reviewIds: [],
      analysis: makeEntry('E1').analysis,
      validation: { passed: true, errors: [], warnings: [], infos: [] },
      releaseDecision: {
        status: 'accepted' as const,
        scopeHash,
        validationIdentity: 'test',
        reasons: [],
      },
      released: true,
      cacheHit: false,
      errors: [],
      llmPass1: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      llmPass2: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      attempts: 1,
      needsReview: false,
      promptHash: computeSha256Hex('prompt-e1'),
      providerCalls: [],
      promotionReadSet: [],
      requestRecords: [],
      createdAt: '2025-01-01T00:00:00.000Z',
    };
    storage.write(`${PROJECT_DIR}/.nova/responses/E1.json`, JSON.stringify(envelope));
    storage.write(
      `${PROJECT_DIR}/.nova/revisions/scenes/E1/${revisionId}.json`,
      JSON.stringify(envelope),
    );
    storage.write(`${PROJECT_DIR}/scenes/chapter-01/E1.md`, prose);
    storage.write(
      `${PROJECT_DIR}/scenes/chapter-01/E1.yaml`,
      JSON.stringify({
        schema_version: 1,
        event: 'E1',
        narrative_order: 1,
        revision_id: revisionId,
        prose_source: 'llm',
        prose_hash: envelope.proseHash,
        scene_hash: envelope.sceneHash,
        editorial_basis_hash: envelope.editorialBasisHash,
        scope_hash: scopeHash,
        validation_identity: 'test',
        model_used: 'mock-pass2',
        rendered_at: envelope.createdAt,
        word_count: prose.split(/\s+/).length,
        text_count_version: 1,
        edit_history: [],
        branch_existence: { type: 'all' },
      }),
    );
    const { provider, callCount } = trackProvider(
      new MockPass2Provider({ entries: { E2: makeEntry('E2') } }),
    );

    const result = await renderNovel(
      {
        version: 1,
        projectDir: PROJECT_DIR,
        mutation: { operationId: '00000005-0005-4005-8005-000000000005', actorId: 'test' },
        model: 'mock-pass2',
        selector: { type: 'events', eventIds: ['E2'] },
      },
      { storage, provider },
    );

    expect(callCount()).toBeGreaterThan(0);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.released).toBe(true);
    expect(result.results[0]?.errors).not.toContain(expect.stringContaining('not accepted'));

    // V1 result fields
    expect(result.operationId).toBe('00000005-0005-4005-8005-000000000005');
    expect(result.publication.status).toBe('current');
    expect(result.publication.novelHash).toBeTruthy();
    expect(result.results[0]?.disposition).toBe('candidate_promoted');
  });

  it('subset render rejects a persisted predecessor with mismatched scope (AcceptedArtifactResolver enforces scope match)', () => {
    const storage = new MemoryStorage();
    setupProject(storage, ['E1', 'E2'], serialLaneYaml(['E1', 'E2']));

    const HEAD_DIR = `${PROJECT_DIR}/.nova/responses`;
    const ARCHIVE_DIR = `${PROJECT_DIR}/.nova/revisions/scenes`;

    const prose = 'Wrong-scope predecessor prose.';
    const proseHash = computeSha256Hex(prose);
    const revisionId = '00000000-0000-4000-8000-0000000000e2';
    const wrongScope = computeSha256Hex('wrong-scope');
    const envelope = {
      version: 1 as const,
      revisionId,
      parentRevisionId: null,
      operationId: '00000000-0000-4000-8000-0000000000a2',
      planHash: computeSha256Hex('plan-wrong-scope'),
      actorId: 'test',
      eventId: 'E1',
      origin: 'llm_draft' as const,
      prose,
      proseHash,
      sceneHash: computeSha256Hex(prose),
      editorialBasisHash: computeSha256Hex('basis-wrong-scope'),
      scopeHash: wrongScope,
      validationIdentity: 'test',
      modelUsed: 'mock-pass2',
      feedbackHash: null,
      reviewIds: [],
      analysis: makeEntry('E1').analysis,
      validation: { passed: true, errors: [], warnings: [], infos: [] },
      releaseDecision: {
        status: 'accepted' as const,
        scopeHash: wrongScope,
        validationIdentity: 'test',
        reasons: [],
      },
      released: true,
      cacheHit: false,
      errors: [],
      llmPass1: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      llmPass2: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      attempts: 1,
      needsReview: false,
      promptHash: computeSha256Hex('prompt-wrong-scope'),
      providerCalls: [],
      promotionReadSet: [],
      requestRecords: [],
      createdAt: '2025-01-01T00:00:00.000Z',
    };
    storage.write(`${HEAD_DIR}/E1.json`, JSON.stringify(envelope));
    storage.write(`${ARCHIVE_DIR}/E1/${revisionId}.json`, JSON.stringify(envelope));

    const resolver = new AcceptedArtifactResolver(storage, HEAD_DIR, ARCHIVE_DIR);

    // Without requestedScopeHash, internally consistent wrong-scope is accepted
    const accepted = resolver.resolve('E1');
    expect(accepted).not.toBeNull();
    expect(accepted!.scopeHash).toBe(wrongScope);

    // With a requestedScopeHash that differs, scope mismatch → null (rejected)
    const correctScopeHash = computeSha256Hex(
      canonicalJson({ branch: { decisions: [] }, discourse: 'main' }),
    );
    const rejected = resolver.resolve('E1', correctScopeHash);
    expect(rejected).toBeNull();

    // With requestedScopeHash matching the envelope's scope, accepted
    const matching = resolver.resolve('E1', wrongScope);
    expect(matching).not.toBeNull();
    expect(matching!.scopeHash).toBe(wrongScope);
  });

  // ── 5. Batch/non-batch equivalence ──────────────────────────────────────

  it('batch and non-batch produce same release outcomes', async () => {
    const storage = new MemoryStorage();
    setupProject(storage, ['E1', 'E2'], serialLaneYaml(['E1', 'E2']));

    const entries: Record<string, MockPass2Entry> = {
      E1: makeEntry('E1'),
      E2: makeEntry('E2'),
    };

    // Non-batch render
    const storageA = storage;
    const { provider: providerA, callCount: countA } = trackProvider(
      new MockPass2Provider({ entries }),
    );
    const resultA = await renderNovel(
      {
        version: 1,
        projectDir: PROJECT_DIR,
        mutation: { operationId: '0000000a-000a-400a-800a-00000000000a', actorId: 'test' },
        model: 'mock-pass2',
      },
      { storage: storageA, provider: providerA },
    );

    // Batch render — new storage, same setup
    const storageB = new MemoryStorage();
    setupProject(storageB, ['E1', 'E2'], serialLaneYaml(['E1', 'E2']));
    const { provider: providerB, callCount: countB } = trackProvider(
      new MockPass2Provider({ entries }),
    );
    const resultB = await renderNovel(
      {
        version: 1,
        projectDir: PROJECT_DIR,
        mutation: { operationId: '0000000b-000b-400b-800b-00000000000b', actorId: 'test' },
        model: 'mock-pass2',
        batch: { batchSize: 1 },
      },
      { storage: storageB, provider: providerB },
    );

    // Both should succeed with same results
    expect(resultA.errors).toHaveLength(0);
    expect(resultB.errors).toHaveLength(0);

    for (const id of ['E1', 'E2']) {
      const a = resultA.results.find((r) => r.eventId === id)!;
      const b = resultB.results.find((r) => r.eventId === id)!;
      expect(a.released).toBe(b.released);
      expect(a.errors).toEqual(b.errors);
      expect(a.disposition).toBe(b.disposition);
    }

    // Both should have called the provider (cold render)
    expect(countA()).toBeGreaterThan(0);
    expect(countB()).toBeGreaterThan(0);

    // V1 result fields
    expect(resultA.operationId).toBe('0000000a-000a-400a-800a-00000000000a');
    expect(resultB.operationId).toBe('0000000b-000b-400b-800b-00000000000b');
    expect(resultA.publication.status).toBe('current');
    expect(resultB.publication.status).toBe('current');
    expect(resultA.publication.novelHash).toBeTruthy();
    expect(resultB.publication.novelHash).toBeTruthy();
  });

  it('preview compiles plan and assembles prompts without provider calls', async () => {
    const storage = new MemoryStorage();
    setupProject(storage, ['E1', 'E2'], serialLaneYaml(['E1', 'E2']));

    const entries: Record<string, MockPass2Entry> = {
      E1: makeEntry('E1'),
      E2: makeEntry('E2'),
    };
    const { provider, callCount } = trackProvider(new MockPass2Provider({ entries }));

    const result = await previewEditorialRun(
      {
        version: 1,
        projectDir: PROJECT_DIR,
        model: 'mock-pass2',
      },
      { storage, provider },
    );

    // No provider calls (preview never calls provider)
    expect(callCount()).toBe(0);

    // Preview has deterministic plan identity but no mutation operation identity.
    expect(result.planHash).toBeTruthy();
    expect(result.planSummary.planHash).toBe(result.planHash);

    // Both events are selected for planning
    expect(result.selectedEventIds).toContain('E1');
    expect(result.selectedEventIds).toContain('E2');

    // Both scenes are in plan state will_render (surface dependency checks
    // happen during execution, not compilation)
    const e1Scene = result.scenes.find((s) => s.eventId === 'E1')!;
    const e2Scene = result.scenes.find((s) => s.eventId === 'E2')!;
    expect(e1Scene.state).toBe('will_render');
    expect(e2Scene.state).toBe('will_render');
    expect(e1Scene.editorialBasisHash).toBeTruthy();
    expect(e2Scene.editorialBasisHash).toBeTruthy();

    // Both events have prompts assembled (requiresProvider = true for both)
    expect(result.prompts).toHaveLength(2);
    expect(result.prompts.find((p) => p.eventId === 'E1')?.userPrompt).toBeTruthy();
    expect(result.prompts.find((p) => p.eventId === 'E2')?.userPrompt).toBeTruthy();

    // No storage artifacts written by preview
    expect(storage.exists(`${PROJECT_DIR}/scenes/chapter-01/E1.md`)).toBe(false);
    expect(storage.exists(`${PROJECT_DIR}/.nova/responses/E1.json`)).toBe(false);
    expect(storage.exists(`${PROJECT_DIR}/output/novel.md`)).toBe(false);
  });

  // ── 7. Accepted-only assembly/output ────────────────────────────────────

  it('assembly only when all required scenes are accepted', async () => {
    const storage = new MemoryStorage();
    setupProject(storage, ['E1', 'E2'], serialLaneYaml(['E1', 'E2']));

    // Only E1 accepted; E2 blocked by missing source
    // Force E2 blocked by making its prose empty → blocked
    const failEntries: Record<string, MockPass2Entry> = {
      E1: makeEntry('E1'),
      E2: makeEntry('E2', ''), // empty prose → blocked
    };
    const { provider } = trackProvider(new MockPass2Provider({ entries: failEntries }));

    const result = await renderNovel(
      {
        version: 1,
        projectDir: PROJECT_DIR,
        mutation: { operationId: '0000000d-000d-400d-800d-00000000000d', actorId: 'test' },
        model: 'mock-pass2',
      },
      { storage, provider },
    );

    // E1 accepted, E2 blocked (empty prose)
    const e1 = result.results.find((r) => r.eventId === 'E1')!;
    const e2 = result.results.find((r) => r.eventId === 'E2')!;
    expect(e1.released).toBe(true);
    expect(e2.released).toBe(false);

    // E1's scene output exists
    expect(storage.exists(`${PROJECT_DIR}/scenes/chapter-01/E1.md`)).toBe(true);
    expect(storage.exists(`${PROJECT_DIR}/.nova/responses/E1.json`)).toBe(true);

    // E2 has response (it was attempted) but no scene output
    expect(storage.exists(`${PROJECT_DIR}/.nova/responses/E2.json`)).toBe(true);
    expect(storage.exists(`${PROJECT_DIR}/scenes/chapter-01/E2.md`)).toBe(false);

    // Assembly should NOT happen because not all scenes are accepted
    expect(storage.exists(`${PROJECT_DIR}/output/novel.md`)).toBe(false);

    // Error list includes blocked diagnostic
    expect(result.errors.length).toBeGreaterThan(0);

    // V1 result fields
    expect(result.operationId).toBe('0000000d-000d-400d-800d-00000000000d');
    expect(result.publication.status).toBe('stale');
    expect(e1.disposition).toBe('candidate_promoted');
    expect(e2.disposition).toBe('candidate_blocked');
  });

  it('all accepted produces assembly with correct word count', async () => {
    const storage = new MemoryStorage();
    setupProject(storage, ['E1', 'E2'], serialLaneYaml(['E1', 'E2']));

    // Both accepted
    const entries: Record<string, MockPass2Entry> = {
      E1: makeEntry('E1'),
      E2: makeEntry('E2'),
    };
    const { provider } = trackProvider(new MockPass2Provider({ entries }));

    const result = await renderNovel(
      {
        version: 1,
        projectDir: PROJECT_DIR,
        mutation: { operationId: '0000000e-000e-400e-800e-00000000000e', actorId: 'test' },
        model: 'mock-pass2',
      },
      { storage, provider },
    );

    expect(result.errors).toHaveLength(0);
    expect(result.results).toHaveLength(2);
    expect(result.results.every((r) => r.released)).toBe(true);

    // Assembly should exist
    const novelPath = `${PROJECT_DIR}/output/novel.md`;
    expect(storage.exists(novelPath)).toBe(true);
    const novelContent = storage.read(novelPath);
    expect(novelContent).toContain(entries.E1.prose);
    expect(novelContent).toContain(entries.E2.prose);

    // V1 result fields
    expect(result.operationId).toBe('0000000e-000e-400e-800e-00000000000e');
    expect(result.publication.status).toBe('current');
    expect(result.publication.novelHash).toBeTruthy();
    expect(result.results.every((r) => r.disposition === 'candidate_promoted')).toBe(true);
  });
});

describe('Surface Lifecycle — parallel groups and independent waves', () => {
  it('parallel group events render independently (E2 renders even if E1 blocked)', async () => {
    const storage = new MemoryStorage();
    // No renderSurface = default parallel: each event in its own parallel group
    setupProject(storage, ['E1', 'E2']);

    const entries: Record<string, MockPass2Entry> = {
      E1: makeEntry('E1', ''), // blocked
      E2: makeEntry('E2'),
    };
    const { provider } = trackProvider(new MockPass2Provider({ entries }));

    const result = await renderNovel(
      {
        version: 1,
        projectDir: PROJECT_DIR,
        mutation: { operationId: '0000000f-000f-400f-800f-00000000000f', actorId: 'test' },
        model: 'mock-pass2',
      },
      { storage, provider },
    );

    expect(result.results).toHaveLength(2);
    const e1 = result.results.find((r) => r.eventId === 'E1')!;
    const e2 = result.results.find((r) => r.eventId === 'E2')!;

    // E1 blocked (empty prose)
    expect(e1.released).toBe(false);

    // E2 accepted — independent of E1
    expect(e2.released).toBe(true);
    expect(e2.prose).toBe(entries.E2.prose);

    // V1 result fields
    expect(result.operationId).toBe('0000000f-000f-400f-800f-00000000000f');
    expect(result.publication.status).toBe('stale');
    expect(e1.disposition).toBe('candidate_blocked');
    expect(e2.disposition).toBe('candidate_promoted');
  });
});
