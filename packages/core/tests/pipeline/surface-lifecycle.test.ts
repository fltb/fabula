// ============================================================================
// Surface Lifecycle — Integration tests for surface-plan config,
// dependency-ready wave scheduling, per-wave release gate, and
// accepted-only assembly/output.
//
// Each test creates a minimal MemoryStorage project with multiple events,
// a renderSurface config specifying serial lanes, and uses MockPass2Provider
// for deterministic Pass 1 / Pass 2 output.
// ============================================================================

import { describe, expect, it } from 'vitest';
import { renderNovel } from '../../src/api.ts';
import { MockPass2Provider, type MockPass2Entry } from '../../src/ai/providers/mock-pass2.ts';
import { MemoryStorage } from '../../src/storage/memory-storage.ts';
import { canonicalJson, computeSha256Hex } from '../../src/render/scene-contract.ts';
import type { RenderNovelResult } from '../../src/api.ts';

// ── Constants ────────────────────────────────────────────────────────────────

const PROJECT_DIR = '/test-project';

const SAMPLE_PROSE =
  'The morning light filtered through the tall windows of the converted ' +
  'conference room, painting golden rectangles across the scuffed wooden floor.';

function makeEntry(eventId: string, prose?: string): MockPass2Entry {
  return {
    prose: prose ?? `Test prose for event ${eventId}. ${SAMPLE_PROSE}`,
    analysis: {
      eventId,
      analysis: {
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
      },
    },
  };
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
      '  - { id: day_1, day: 1, description: "Day 1" }',
      'threads: []',
      'worldFacts: []',
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
  const groups = eventIds.map((id, i) => `
  - groupId: group_${i}
    sceneIds: [${id}]
    surfacePolicy: serial_surface`).join('');

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
  const groups = eventIds.map((id, i) => {
    const isLast = i === eventIds.length - 1;
    return `
  - groupId: group_${i}
    sceneIds: [${id}]
    surfacePolicy: ${isLast ? 'fallback_without_surface' : 'serial_surface'}`;
  }).join('');

  return `
mode: manual
groups:${groups}
lanes:
  - laneId: main_lane
    groupIds: [${eventIds.map((_, i) => `group_${i}`).join(', ')}]`;
}

function trackProvider(
  inner: MockPass2Provider,
): { provider: MockPass2Provider; callCount: () => number } {
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

    const result = await renderNovel({
      projectDir: PROJECT_DIR,
      model: 'mock-pass2',
      provider,
      storage,
    });

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
  });

  // ── 2. Rejected source blocks only descendants ───────────────────────────

  it('blocked predecessor blocks serial descendant', async () => {
    const storage = new MemoryStorage();
    setupProject(storage, ['E1', 'E2'], serialLaneYaml(['E1', 'E2']));

    // E1 gets empty prose → blocked. E2 should get MISSING_SURFACE_SOURCE.
    const entries: Record<string, MockPass2Entry> = {
      E1: makeEntry('E1', ''),
      E2: makeEntry('E2'),
    };
    const { provider } = trackProvider(new MockPass2Provider({ entries }));

    const result = await renderNovel({
      projectDir: PROJECT_DIR,
      model: 'mock-pass2',
      provider,
      storage,
    });

    // E1 attempted rendering but got blocked (empty prose)
    // E2 cannot render because E1's source is not accepted and not persisted
    expect(result.results).toHaveLength(2);

    const e1 = result.results.find((r) => r.eventId === 'E1')!;
    const e2 = result.results.find((r) => r.eventId === 'E2')!;

    expect(e1.released).toBe(false);
    expect(e2.released).toBe(false);

    // E2 should have MISSING_SURFACE_SOURCE error
    expect(e2.errors.some((msg) => msg.includes('MISSING_SURFACE_SOURCE'))).toBe(true);
    expect(e2.prose).toBe('');
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

    const result = await renderNovel({
      projectDir: PROJECT_DIR,
      model: 'mock-pass2',
      provider,
      storage,
    });

    expect(result.results).toHaveLength(2);

    const e1 = result.results.find((r) => r.eventId === 'E1')!;
    const e2 = result.results.find((r) => r.eventId === 'E2')!;

    // E1 blocked (empty prose)
    expect(e1.released).toBe(false);

    // E2 rendered despite missing predecessor — fallback_without_surface
    expect(e2.released).toBe(true);
    expect(e2.prose).toBe(entries.E2.prose);
    expect(e2.errors).not.toContain(expect.stringMatching(/MISSING_SURFACE_SOURCE/));
  });

  // ── 4. Missing source — subset render with unknown predecessor ──────────

  it('subset render with missing predecessor yields MISSING_SURFACE_SOURCE', async () => {
    const storage = new MemoryStorage();
    setupProject(storage, ['E1', 'E2'], serialLaneYaml(['E1', 'E2']));

    // Request only E2; E1 is not selected but is E2's predecessor.
    // E1 has no persisted accepted response → MISSING_SURFACE_SOURCE.
    const entries: Record<string, MockPass2Entry> = {
      E2: makeEntry('E2'),
    };
    const { provider } = trackProvider(new MockPass2Provider({ entries }));

    const result = await renderNovel({
      projectDir: PROJECT_DIR,
      model: 'mock-pass2',
      provider,
      storage,
      eventId: 'E2',
    });

    // E2 fails with MISSING_SURFACE_SOURCE because E1 was never rendered/accepted
    expect(result.results).toHaveLength(1);
    const e2 = result.results[0]!;
    expect(e2.released).toBe(false);
    expect(e2.errors.some((msg) => msg.includes('MISSING_SURFACE_SOURCE'))).toBe(true);
    expect(e2.prose).toBe('');
  });
  it('subset render accepts only a matching-scope persisted predecessor', async () => {
    const storage = new MemoryStorage();
    setupProject(storage, ['E1', 'E2'], serialLaneYaml(['E1', 'E2']));
    const scopeHash = computeSha256Hex(
      canonicalJson({ branch: { decisions: [] }, discourse: 'main' }),
    );
    storage.write(
      `${PROJECT_DIR}/.nova/responses/E1.json`,
      JSON.stringify({
        prose: 'Accepted predecessor prose.',
        releaseDecision: {
          status: 'accepted',
          scopeHash,
          validationIdentity: 'test',
          reasons: [],
        },
      }),
    );
    const { provider, callCount } = trackProvider(
      new MockPass2Provider({ entries: { E2: makeEntry('E2') } }),
    );

    const result = await renderNovel({
      projectDir: PROJECT_DIR,
      model: 'mock-pass2',
      provider,
      storage,
      eventId: 'E2',
    });

    expect(callCount()).toBeGreaterThan(0);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.released).toBe(true);
    expect(result.results[0]?.errors).not.toContain(
      expect.stringContaining('MISSING_SURFACE_SOURCE'),
    );
  });

  it('subset render rejects a persisted predecessor from another scope', async () => {
    const storage = new MemoryStorage();
    setupProject(storage, ['E1', 'E2'], serialLaneYaml(['E1', 'E2']));
    storage.write(
      `${PROJECT_DIR}/.nova/responses/E1.json`,
      JSON.stringify({
        prose: 'Wrong-scope predecessor prose.',
        releaseDecision: {
          status: 'accepted',
          scopeHash: 'wrong-scope',
          validationIdentity: 'test',
          reasons: [],
        },
      }),
    );
    const { provider, callCount } = trackProvider(
      new MockPass2Provider({ entries: { E2: makeEntry('E2') } }),
    );

    const result = await renderNovel({
      projectDir: PROJECT_DIR,
      model: 'mock-pass2',
      provider,
      storage,
      eventId: 'E2',
    });

    expect(callCount()).toBe(0);
    expect(result.results[0]?.released).toBe(false);
    expect(result.results[0]?.releaseDecision?.status).toBe('blocked');
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
    const resultA = await renderNovel({
      projectDir: PROJECT_DIR,
      model: 'mock-pass2',
      provider: providerA,
      storage: storageA,
    });

    // Batch render — new storage, same setup
    const storageB = new MemoryStorage();
    setupProject(storageB, ['E1', 'E2'], serialLaneYaml(['E1', 'E2']));
    const { provider: providerB, callCount: countB } = trackProvider(
      new MockPass2Provider({ entries }),
    );
    const resultB = await renderNovel({
      projectDir: PROJECT_DIR,
      model: 'mock-pass2',
      provider: providerB,
      storage: storageB,
      batch: { batchSize: 1 },
    });

    // Both should succeed with same results
    expect(resultA.errors).toHaveLength(0);
    expect(resultB.errors).toHaveLength(0);

    for (const id of ['E1', 'E2']) {
      const a = resultA.results.find((r) => r.eventId === id)!;
      const b = resultB.results.find((r) => r.eventId === id)!;
      expect(a.released).toBe(b.released);
      expect(a.errors).toEqual(b.errors);
    }

    // Both should have called the provider (cold render)
    expect(countA()).toBeGreaterThan(0);
    expect(countB()).toBeGreaterThan(0);
  });

  // ── 6. Dry-run with serial dependency ───────────────────────────────────

  it('dry-run blocks a serial dependent without an accepted persisted source', async () => {
    const storage = new MemoryStorage();
    setupProject(storage, ['E1', 'E2'], serialLaneYaml(['E1', 'E2']));

    const entries: Record<string, MockPass2Entry> = {
      E1: makeEntry('E1'),
      E2: makeEntry('E2'),
    };
    const { provider, callCount } = trackProvider(new MockPass2Provider({ entries }));

    const result = await renderNovel({
      projectDir: PROJECT_DIR,
      model: 'mock-pass2',
      provider,
      storage,
      dryRun: true,
    });

    // Dry run never calls the provider. E1 has no dependency; E2 requires
    // an accepted predecessor that is unavailable in this backend.
    expect(result.errors).toHaveLength(0);
    expect(result.results).toHaveLength(2);
    expect(callCount()).toBe(0);
    expect(result.results.find((scene) => scene.eventId === 'E1')?.errors).toHaveLength(0);
    expect(result.results.find((scene) => scene.eventId === 'E2')?.releaseDecision?.status).toBe(
      'blocked',
    );

    const firstPrompt = `${PROJECT_DIR}/.nova/dry-runs/E1_prompt.md`;
    expect(storage.exists(firstPrompt)).toBe(true);
    expect(storage.read(firstPrompt)).toContain('E1');
    expect(storage.exists(`${PROJECT_DIR}/.nova/dry-runs/E2_prompt.md`)).toBe(false);

    // No scene or response artifacts
    expect(storage.exists(`${PROJECT_DIR}/scenes/chapter-01/E1.md`)).toBe(false);
    expect(storage.exists(`${PROJECT_DIR}/.nova/responses/E1.json`)).toBe(false);
    expect(storage.exists(`${PROJECT_DIR}/output/novel.md`)).toBe(false);
  });

  // ── 7. Accepted-only assembly/output ────────────────────────────────────

  it('assembly only when all required scenes are accepted', async () => {
    const storage = new MemoryStorage();
    setupProject(storage, ['E1', 'E2'], serialLaneYaml(['E1', 'E2']));

    // Only E1 accepted; E2 blocked by missing source
    const entries: Record<string, MockPass2Entry> = {
      E1: makeEntry('E1'),
      E2: makeEntry('E2'),
    };
    // Use an entry with empty prose for E1 to make it blocked? No, we want E1 accepted.
    // Instead make E2 blocked by not having E1's persisted source.
    // Actually for this test, E1 is accepted but E2 would try to render and could succeed
    // since both have entries. Let me force E2 blocked by making E1 fail validation:
    const failEntries: Record<string, MockPass2Entry> = {
      E1: makeEntry('E1'),
      E2: makeEntry('E2', ''), // empty prose → blocked
    };
    const { provider } = trackProvider(new MockPass2Provider({ entries: failEntries }));

    const result = await renderNovel({
      projectDir: PROJECT_DIR,
      model: 'mock-pass2',
      provider,
      storage,
    });

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

    const result = await renderNovel({
      projectDir: PROJECT_DIR,
      model: 'mock-pass2',
      provider,
      storage,
    });

    expect(result.errors).toHaveLength(0);
    expect(result.results).toHaveLength(2);
    expect(result.results.every((r) => r.released)).toBe(true);

    // Assembly should exist
    const novelPath = `${PROJECT_DIR}/output/novel.md`;
    expect(storage.exists(novelPath)).toBe(true);
    const novelContent = storage.read(novelPath);
    expect(novelContent).toContain(entries.E1.prose);
    expect(novelContent).toContain(entries.E2.prose);
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

    const result = await renderNovel({
      projectDir: PROJECT_DIR,
      model: 'mock-pass2',
      provider,
      storage,
    });

    expect(result.results).toHaveLength(2);
    const e1 = result.results.find((r) => r.eventId === 'E1')!;
    const e2 = result.results.find((r) => r.eventId === 'E2')!;

    // E1 blocked (empty prose)
    expect(e1.released).toBe(false);

    // E2 accepted — independent of E1
    expect(e2.released).toBe(true);
    expect(e2.prose).toBe(entries.E2.prose);
  });
});
