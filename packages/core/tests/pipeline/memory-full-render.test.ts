// ============================================================================
// MemoryStorage full render — MemoryStorage-backed renderNovel contract test
//
// Verifies that renderNovel with dryRun omitted correctly:
//   1. Resolves project data from the injected MemoryStorage backend
//   2. Calls the provider for Pass 1 + Pass 2 on a cold render
//   3. Writes scenes, responses, derived artifacts, render cache, and
//      assembled novel to the same MemoryStorage instance
//   4. On a warm render (same storage), hits the cache with zero provider calls
//   5. A second MemoryStorage at the same project path has no source/cache/
//      project data or outputs
//   6. Dry-run writes prompt files without calling provider
//
// Uses MockPass2Provider for event-aware Pass 1 prose / Pass 2 analysis with
// matching eventId. A single-event project avoids static response-pair issues.
// ============================================================================

import { describe, expect, it } from 'vitest';
import { renderNovel } from '../../src/api.ts';
import { MockPass2Provider } from '../../src/ai/providers/mock-pass2.ts';
import { MemoryStorage } from '../../src/storage/memory-storage.ts';
import type { MockPass2Entry } from '../../src/ai/providers/mock-pass2.ts';

// ── Constants ────────────────────────────────────────────────────────────────

const PROJECT_DIR = '/test-project';

const SAMPLE_PROSE =
  'The morning light filtered through the tall windows of the converted ' +
  'conference room, painting golden rectangles across the scuffed wooden floor. ' +
  'Seraphine sat cross-legged on a cushion in the center of the room, eyes closed, ' +
  'hands resting on her knees. She had been trying to clear her mind for twenty ' +
  'minutes. It was not going well.';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal MockPass2Entry with all required analysis fields.
 * Callers override quality to get a clean pass from the QualityValidator.
 */
function makeEntry(eventId: string): MockPass2Entry {
  return {
    prose: `Test prose for event ${eventId}. ${SAMPLE_PROSE}`,
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
 * Write a minimal YAML project to the given MemoryStorage.
 * Every required file is created so EntityMapper.loadProject() succeeds.
 */
function setupMinimalProject(storage: MemoryStorage): void {
  // ── Project config ─────────────────────────────────────────────
  storage.write(
    `${PROJECT_DIR}/nova.yaml`,
    [
      'project: test-project',
      'title: Test Novel',
      'author: Test Author',
      'defaultModel: mock-pass2',
      'defaultLanguage: en',
    ].join('\n'),
  );

  // ── Definitions ────────────────────────────────────────────────
  storage.mkdirp(`${PROJECT_DIR}/definitions`);

  // state_initial.yaml (required — non-optional readYamlFile)
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

  // Character definition (POV character for the event)
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

  // ── Chapter & event ────────────────────────────────────────────
  storage.mkdirp(`${PROJECT_DIR}/chapters/chapter_01`);
  storage.write(
    `${PROJECT_DIR}/chapters/chapter_01/_chapter.yaml`,
    [
      'chapter: 1',
      'title: "Chapter 1"',
      'summary: "First chapter"',
      'intent: "Introduction"',
      'plannedScenes: 1',
    ].join('\n'),
  );

  storage.write(
    `${PROJECT_DIR}/chapters/chapter_01/E1.yaml`,
    [
      'event: E1',
      'narrativeOrder: 1',
      'title: "First Event"',
      'storyTime: day_1',
      'pov:',
      '  character: narrator',
      '  type: first_person',
      'sceneBrief: "A test scene."',
      'preconditions: []',
      'expectedPostconditions: []',
    ].join('\n'),
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('MemoryStorage — renderNovel full contract', () => {
  // * Static wrapper tracks calls to a MockPass2Provider for assertion.
  //   The test uses this wrapper so we can observe callCount without
  //   modifying the provider itself.
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

  // ── Cold render ─────────────────────────────────────────────────

  it('cold render — calls provider, releases scene, writes all artifacts to MemoryStorage', async () => {
    const storage = new MemoryStorage();
    setupMinimalProject(storage);

    const entry = makeEntry('E1');
    const { provider, callCount } = trackProvider(
      new MockPass2Provider({ entries: { E1: entry } }),
    );

    const result = await renderNovel({
      projectDir: PROJECT_DIR,
      model: 'mock-pass2',
      provider,
      storage,
    });

    // renderNovel succeeded with no errors
    expect(result.errors).toHaveLength(0);
    expect(result.results).toHaveLength(1);

    const scene = result.results[0]!;
    expect(scene.eventId).toBe('E1');
    expect(scene.released).toBe(true);
    expect(scene.prose).toBe(entry.prose);
    expect(scene.prose.length).toBeGreaterThan(0);
    expect(scene.analysis).not.toBeNull();
    expect(scene.analysis!.eventId).toBe('E1');
    expect(scene.cacheHit).toBe(false);

    // Provider was called for Pass 1 and Pass 2 (no cache on cold render)
    expect(callCount()).toBeGreaterThanOrEqual(2);

    // ── Storage artifact assertions ───────────────────────────

    // Response file (.nova/responses/)
    const responsePath = `${PROJECT_DIR}/.nova/responses/E1.json`;
    expect(storage.exists(responsePath)).toBe(true);
    const responseData = JSON.parse(storage.read(responsePath));
    expect(responseData.prose).toBe(entry.prose);
    expect(responseData.released).toBe(true);

    // Scene prose file
    const sceneProsePath = `${PROJECT_DIR}/scenes/chapter-01/E1.md`;
    expect(storage.exists(sceneProsePath)).toBe(true);
    expect(storage.read(sceneProsePath)).toBe(entry.prose);

    // Scene metadata YAML
    const sceneMetaPath = `${PROJECT_DIR}/scenes/chapter-01/E1.yaml`;
    expect(storage.exists(sceneMetaPath)).toBe(true);
    const metaContent = storage.read(sceneMetaPath);
    expect(metaContent).toContain('narrativeOrder: 1');
    expect(metaContent).toContain('E1');

    // Scene render request YAML
    const renderReqPath = `${PROJECT_DIR}/scenes/chapter-01/E1_render_request.yaml`;
    expect(storage.exists(renderReqPath)).toBe(true);

    // Derived artifacts
    const derivedDir = `${PROJECT_DIR}/.nova/derived`;
    expect(storage.exists(`${derivedDir}/threads.yaml`)).toBe(true);
    expect(storage.exists(`${derivedDir}/foreshadowing.yaml`)).toBe(true);
    expect(storage.exists(`${derivedDir}/relationships.yaml`)).toBe(true);
    expect(storage.exists(`${derivedDir}/rules.yaml`)).toBe(true);

    // Render cache (meta + data)
    const cacheDir = `${PROJECT_DIR}/.nova/render-cache/E1`;
    expect(storage.exists(`${cacheDir}/cache.meta.json`)).toBe(true);
    expect(storage.exists(`${cacheDir}/data.render.json`)).toBe(true);

    // Assembled novel written to output/
    const novelPath = `${PROJECT_DIR}/output/novel.md`;
    expect(storage.exists(novelPath)).toBe(true);
    const novelContent = storage.read(novelPath);
    expect(novelContent).toContain(entry.prose);

    // Scene prose in the novel matches the rendered prose
    expect(novelContent.length).toBeGreaterThan(entry.prose.length);
  });

  // ── Warm render ─────────────────────────────────────────────────

  it('warm render — zero provider calls, same accepted outputs on same MemoryStorage', async () => {
    const storage = new MemoryStorage();
    setupMinimalProject(storage);

    // Cold render — populate cache, outputs
    const coldEntry = makeEntry('E1');
    const coldTracker = trackProvider(
      new MockPass2Provider({ entries: { E1: coldEntry } }),
    );
    const coldResult = await renderNovel({
      projectDir: PROJECT_DIR,
      model: 'mock-pass2',
      provider: coldTracker.provider,
      storage,
    });
    expect(coldResult.errors).toHaveLength(0);
    expect(coldResult.results).toHaveLength(1);
    expect(coldResult.results[0]!.released).toBe(true);
    const coldProse = coldResult.results[0]!.prose;
    expect(coldTracker.callCount()).toBeGreaterThanOrEqual(2);

    // Warm render — same storage, fresh provider that should never be invoked
    const warmEntry = makeEntry('E1');
    const warmTracker = trackProvider(
      new MockPass2Provider({ entries: { E1: warmEntry } }),
    );
    const warmResult = await renderNovel({
      projectDir: PROJECT_DIR,
      model: 'mock-pass2',
      provider: warmTracker.provider,
      storage,
    });

    expect(warmResult.errors).toHaveLength(0);
    expect(warmResult.results).toHaveLength(1);

    const warmScene = warmResult.results[0]!;
    expect(warmScene.eventId).toBe('E1');
    expect(warmScene.released).toBe(true);
    expect(warmScene.cacheHit).toBe(true);
    // Prose returned from cache matches cold render
    expect(warmScene.prose).toBe(coldProse);

    // Provider was NEVER called — cache satisfied the request
    expect(warmTracker.callCount()).toBe(0);

    // Scene file unchanged from cold render
    expect(storage.read(`${PROJECT_DIR}/scenes/chapter-01/E1.md`)).toBe(coldProse);

    // Response file written again with same prose
    const responsePath = `${PROJECT_DIR}/.nova/responses/E1.json`;
    expect(storage.exists(responsePath)).toBe(true);
    const responseData = JSON.parse(storage.read(responsePath));
    expect(responseData.prose).toBe(coldProse);
  });

  // ── Storage isolation ──────────────────────────────────────────

  it('second MemoryStorage at same project path has no data from first', async () => {
    const storageA = new MemoryStorage();
    setupMinimalProject(storageA);

    const entry = makeEntry('E1');
    const { provider } = trackProvider(
      new MockPass2Provider({ entries: { E1: entry } }),
    );
    const result = await renderNovel({
      projectDir: PROJECT_DIR,
      model: 'mock-pass2',
      provider,
      storage: storageA,
    });
    expect(result.errors).toHaveLength(0);

    // Storage A has all project data and outputs
    expect(storageA.exists(`${PROJECT_DIR}/nova.yaml`)).toBe(true);
    expect(storageA.exists(`${PROJECT_DIR}/.nova/responses/E1.json`)).toBe(true);
    expect(storageA.exists(`${PROJECT_DIR}/scenes/chapter-01/E1.md`)).toBe(true);
    expect(storageA.exists(`${PROJECT_DIR}/.nova/render-cache/E1/cache.meta.json`)).toBe(true);

    // Storage B (different instance, same path) has nothing
    const storageB = new MemoryStorage();
    expect(storageB.exists(`${PROJECT_DIR}/nova.yaml`)).toBe(false);
    expect(storageB.exists(`${PROJECT_DIR}/chapters/chapter_01/E1.yaml`)).toBe(false);
    expect(storageB.exists(`${PROJECT_DIR}/definitions/state_initial.yaml`)).toBe(false);
    expect(storageB.exists(`${PROJECT_DIR}/.nova/responses/E1.json`)).toBe(false);
    expect(storageB.exists(`${PROJECT_DIR}/scenes/chapter-01/E1.md`)).toBe(false);
    expect(storageB.exists(`${PROJECT_DIR}/.nova/derived/threads.yaml`)).toBe(false);
    expect(storageB.exists(`${PROJECT_DIR}/.nova/render-cache/E1/cache.meta.json`)).toBe(false);
    expect(storageB.exists(`${PROJECT_DIR}/output/novel.md`)).toBe(false);

    // Storage B has no files at all under the project dir
    expect(storageB.list(PROJECT_DIR)).toHaveLength(0);

    // Writing to B does not affect A
    storageB.mkdirp(`${PROJECT_DIR}/other`);
    storageB.write(`${PROJECT_DIR}/other/test.txt`, 'B-only');
    expect(storageA.exists(`${PROJECT_DIR}/other/test.txt`)).toBe(false);
  });

  // ── Supplemental: dry-run ──────────────────────────────────────

  it('dry-run renders prompt files without calling provider', async () => {
    const storage = new MemoryStorage();
    setupMinimalProject(storage);

    // Dry-run should NOT invoke the provider
    const entry = makeEntry('E1');
    const tracker = trackProvider(
      new MockPass2Provider({ entries: { E1: entry } }),
    );

    const result = await renderNovel({
      projectDir: PROJECT_DIR,
      model: 'mock-pass2',
      provider: tracker.provider,
      storage,
      dryRun: true,
    });

    expect(result.errors).toHaveLength(0);
    expect(result.results).toHaveLength(1);
    // Dry run returns empty prose
    const scene = result.results[0]!;
    expect(scene.eventId).toBe('E1');
    expect(scene.prose).toBe('');

    // Provider was never called (dry-run skips LLM)
    expect(tracker.callCount()).toBe(0);

    // Prompt file written to .nova/dry-runs/
    const promptPath = `${PROJECT_DIR}/.nova/dry-runs/E1_prompt.md`;
    expect(storage.exists(promptPath)).toBe(true);
    const promptContent = storage.read(promptPath);
    expect(promptContent.length).toBeGreaterThan(0);
    expect(promptContent).toContain('E1');

    // No scene or response artifacts from dry run
    expect(storage.exists(`${PROJECT_DIR}/scenes/chapter-01/E1.md`)).toBe(false);
    expect(storage.exists(`${PROJECT_DIR}/.nova/responses/E1.json`)).toBe(false);
    expect(storage.exists(`${PROJECT_DIR}/.nova/render-cache/E1/cache.meta.json`)).toBe(false);
    expect(storage.exists(`${PROJECT_DIR}/output/novel.md`)).toBe(false);
  });
});
