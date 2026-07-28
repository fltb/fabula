// ============================================================================
// Storage isolation — initializeProject WeakMap partition contract test
//
// Proves that:
//   1. Two separate MemoryStorage instances at the same project path each
//      produce fresh mutable runtime objects (registry, StateManager, state).
//   2. Stable source data (ProjectData, events) are structurally equivalent
//      across instances but never share object identity.
//   3. The WeakMap-based projectCache isolates source data by Storage
//      instance: the first backend's cache entry is invisible to the second.
//   4. Writing project files to the second backend does not affect the first.
//
// No providers, mocks, or render pipeline — direct initializeProject calls.
// ============================================================================

import { describe, expect, it } from 'vitest';
import { initializeProject } from '../src/api.ts';
import { MemoryStorage } from '../src/storage/memory-storage.ts';

// ── Constants ────────────────────────────────────────────────────────────────

const PROJECT_DIR = '/test-project';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Write a minimal YAML project to the given MemoryStorage so that
 * initializeProject can load it via EntityMapper.
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

  // state_initial.yaml (required — EntityMapper reads it via readYamlFile)
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

describe('MemoryStorage — initializeProject storage isolation', () => {
  it('two separate MemoryStorage instances produce fresh runtime objects', () => {
    const storageA = new MemoryStorage();
    const storageB = new MemoryStorage();
    setupMinimalProject(storageA);
    setupMinimalProject(storageB);

    const resultA = initializeProject(PROJECT_DIR, storageA);
    const resultB = initializeProject(PROJECT_DIR, storageB);

    // ── Fresh mutable runtime objects ───────────────────────────────
    // Each initializeProject creates new registry, StateManager, and WorldState.

    expect(resultA.registry).not.toBe(resultB.registry);
    expect(resultA.stateManager).not.toBe(resultB.stateManager);
    expect(resultA.state).not.toBe(resultB.state);

    // Object identity of state fields is also fresh
    expect(resultA.state.entities).not.toBe(resultB.state.entities);
    expect(resultA.state.relationships).not.toBe(resultB.state.relationships);
    expect(resultA.state.knowledge).not.toBe(resultB.state.knowledge);

    // ── Source data is structurally equivalent but cloned ────────────
    // Same project files → same source data.

    expect(resultA.data).not.toBe(resultB.data); // distinct clone
    expect(resultA.data.config?.project).toBe(resultB.data.config?.project);
    expect(resultA.data.config?.title).toBe(resultB.data.config?.title);
    expect(resultA.data.chapters.size).toBe(resultB.data.chapters.size);
    expect(resultA.data.characters).toHaveLength(resultB.data.characters.length);

    expect(resultA.events).not.toBe(resultB.events); // distinct clone
    expect(resultA.events).toHaveLength(resultB.events.length);
    for (let i = 0; i < resultA.events.length; i++) {
      expect(resultA.events[i].id).toBe(resultB.events[i].id);
      expect(resultA.events[i].narrativeOrder).toBe(resultB.events[i].narrativeOrder);
    }
  });

  it('second MemoryStorage at same path has no source cache or data from first', () => {
    const storageA = new MemoryStorage();
    const storageB = new MemoryStorage();
    setupMinimalProject(storageA);
    setupMinimalProject(storageB);

    // Call initializeProject on A — populates A's WeakMap cache entry
    initializeProject(PROJECT_DIR, storageA);

    // Storage B has its own project files (we wrote them above in setupMinimalProject),
    // but it should have NO residual cache data from A and no A-only files.
    // Write an extra file to A after initialization to prove isolation.
    storageA.write(`${PROJECT_DIR}/A-only-marker.txt`, 'from A');

    // Storage B must not see A-only content
    expect(storageB.exists(`${PROJECT_DIR}/A-only-marker.txt`)).toBe(false);

    // Storage B files are what we wrote in setupMinimalProject — not A's delta
    expect(storageB.exists(`${PROJECT_DIR}/nova.yaml`)).toBe(true);
    expect(storageB.read(`${PROJECT_DIR}/nova.yaml`)).toBe(
      storageA.read(`${PROJECT_DIR}/nova.yaml`),
    );

    const resultB = initializeProject(PROJECT_DIR, storageB);
    // EntityMapper always prepends the synthetic genesis event from
    // definitions/state_initial.yaml to authored chapter events.
    expect(resultB.events).toHaveLength(2);
    expect(resultB.events.map((event) => event.id)).toEqual([
      'system:genesis',
      'E1',
    ]);
    const authoredEvent = resultB.events.find((event) => event.id === 'E1');
    expect(authoredEvent?.id).toBe('E1');
  });

  it('repeated initializeProject on same Storage produces fresh runtime objects but cached source', () => {
    const storage = new MemoryStorage();
    setupMinimalProject(storage);

    const first = initializeProject(PROJECT_DIR, storage);
    const second = initializeProject(PROJECT_DIR, storage);

    // ── Fresh runtime on every call ──────────────────────────────────
    expect(first.registry).not.toBe(second.registry);
    expect(first.stateManager).not.toBe(second.stateManager);
    expect(first.state).not.toBe(second.state);
    expect(first.mapper).not.toBe(second.mapper);

    // ── Source data is cloned from the same cache entry ──────────────
    // Same storage instance + same project files = same hash = cache hit.
    // But each caller gets a separate structuredClone.
    expect(first.data).not.toBe(second.data);
    expect(first.events).not.toBe(second.events);
    // Structural equivalence includes synthetic genesis plus authored E1.
    expect(first.events).toHaveLength(2);
    expect(second.events).toHaveLength(2);
    expect(first.events.map((event) => event.id)).toEqual([
      'system:genesis',
      'E1',
    ]);
    expect(second.events.map((event) => event.id)).toEqual([
      'system:genesis',
      'E1',
    ]);
    const firstAuthoredEvent = first.events.find((event) => event.id === 'E1');
    const secondAuthoredEvent = second.events.find((event) => event.id === 'E1');
    expect(firstAuthoredEvent?.id).toBe(secondAuthoredEvent?.id);

    // ── Registry content is equivalent across calls ──────────────────
    // registry.load reads from storage, so both should have the same entities.
    expect(first.registry.resolve('narrator')).not.toBe(
      second.registry.resolve('narrator'),
    );
    expect(first.registry.resolve('narrator')?.name).toBe(
      second.registry.resolve('narrator')?.name,
    );
  });

  it('modified source on second call produces fresh cache entry', () => {
    const storage = new MemoryStorage();
    setupMinimalProject(storage);

    // First call — populates cache with initial project content
    const first = initializeProject(PROJECT_DIR, storage);
    expect(first.data.config?.title).toBe('Test Novel');

    // Modify project config on the same storage
    storage.write(
      `${PROJECT_DIR}/nova.yaml`,
      [
        'project: test-project',
        'title: Modified Novel Title',
        'author: Test Author',
        'defaultModel: mock-pass2',
        'defaultLanguage: en',
      ].join('\n'),
    );

    // Second call — hash changed, fresh cache entry
    const second = initializeProject(PROJECT_DIR, storage);
    expect(second.data.config?.title).toBe('Modified Novel Title');
    expect(second.data).not.toBe(first.data);
    expect(second.events).not.toBe(first.events);

    // Fresh runtime objects still
    expect(second.registry).not.toBe(first.registry);
    expect(second.stateManager).not.toBe(first.stateManager);
    expect(second.state).not.toBe(first.state);
  });
});
