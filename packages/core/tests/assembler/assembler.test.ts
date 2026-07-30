import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AssemblyError,
  AssemblyErrorCode,
  assembleNovel,
  countWords,
  filterScenesByBranchPath,
  loadChapterMetadata,
  ProseConcatenator,
  SceneCollector,
  type SceneEntry,
  type SortedScene,
} from '../../src/assembler/index.js';
import type { BranchPath, BranchSet } from '../../src/types/index.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────
function createTempProject(): string {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'novalistically-test-'));
  fs.mkdirSync(path.join(dir, 'scenes', 'chapter-01'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'scenes', 'chapter-02'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'chapters', 'chapter_01'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'chapters', 'chapter_02'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'output'), { recursive: true });
  return dir;
}

function writeFile(dir: string, ...parts: string[]): void {
  const content = parts.pop()!;
  const fullPath = path.join(dir, ...parts);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf-8');
}

/** Minimal strict V1 committed metadata required for every scene. */
const committedMeta = (overrides: Record<string, unknown> = {}) => {
  const normalized = { ...overrides };
  if ('narrativeOrder' in normalized) {
    normalized.narrative_order = normalized.narrativeOrder;
    delete normalized.narrativeOrder;
  }
  if ('branchExistence' in normalized) {
    normalized.branch_existence = normalized.branchExistence;
    delete normalized.branchExistence;
  }
  return JSON.stringify({
    schema_version: 1,
    event: 'E1a',
    narrative_order: 1,
    revision_id: '00000000-0000-4000-8000-000000000001',
    prose_source: 'llm',
    prose_hash: '0'.repeat(64),
    scene_hash: '1'.repeat(64),
    editorial_basis_hash: '2'.repeat(64),
    scope_hash: '3'.repeat(64),
    validation_identity: 'test',
    rendered_at: '2026-07-28T00:00:00.000Z',
    word_count: 1,
    text_count_version: 1,
    edit_history: [],
    branch_existence: { type: 'all' },
    ...normalized,
  });
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('countWords', () => {
  it('counts words in plain text', () => {
    expect(countWords('hello world')).toBe(2);
  });

  it('ignores markdown headings', () => {
    expect(countWords('# Chapter 1\nSome text here.')).toBe(5);
  });

  it('strips markdown links', () => {
    expect(countWords('See [this link](http://example.com) here.')).toBe(4);
  });

  it('returns 0 for empty string', () => {
    expect(countWords('')).toBe(0);
  });

  it('handles complex markdown', () => {
    const md = `# Title\n\nSome **bold** and *italic* text.\n\n> A blockquote\n\n- List item\n\n---\n\nMore text.`;
    expect(countWords(md)).toBe(12);
  });
});

describe('SceneCollector', () => {
  let projectDir: string;
  let scenesDir: string;

  beforeEach(() => {
    projectDir = createTempProject();
    scenesDir = path.join(projectDir, 'scenes');
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('throws NO_SCENES when scenes directory is missing', () => {
    const collector = new SceneCollector();
    expect(() => collector.collectFrom('/nonexistent')).toThrow(AssemblyError);
    try {
      collector.collectFrom('/nonexistent');
    } catch (e: any) {
      expect(e.code).toBe(AssemblyErrorCode.NO_SCENES);
    }
  });

  it('collects scenes from chapter directories', () => {
    writeFile(scenesDir, 'chapter-01', 'E1a.yaml', committedMeta());
    writeFile(scenesDir, 'chapter-01', 'E1a.md', 'This is the first scene.');

    const collector = new SceneCollector();
    const result = collector.collectFrom(scenesDir);

    expect(result.size).toBe(1);
    const entry = result.get('E1a')!;
    expect(entry.prose).toBe('This is the first scene.');
    expect(entry.narrativeOrder).toBe(1);
    expect(entry.chapter).toBe(1);
    expect(entry.branchExistence).toEqual({ type: 'all' });
  });

  it('throws MISSING_NARRATIVE_ORDER when narrativeOrder is missing', () => {
    writeFile(scenesDir, 'chapter-01', 'E1a.yaml', committedMeta({ narrativeOrder: undefined }));
    writeFile(scenesDir, 'chapter-01', 'E1a.md', 'Prose.');

    const collector = new SceneCollector();
    expect(() => collector.collectFrom(scenesDir)).toThrow(AssemblyError);
  });

  it('throws MISSING_PROSE when .md file is missing', () => {
    writeFile(scenesDir, 'chapter-01', 'E1a.yaml', committedMeta());
    // No .md file

    const collector = new SceneCollector();
    expect(() => collector.collectFrom(scenesDir)).toThrow(AssemblyError);
  });

  it('throws EMPTY_PROSE for empty prose content', () => {
    writeFile(scenesDir, 'chapter-01', 'E1a.yaml', committedMeta());
    writeFile(scenesDir, 'chapter-01', 'E1a.md', '   \n');

    const collector = new SceneCollector();
    expect(() => collector.collectFrom(scenesDir)).toThrow(AssemblyError);
  });

  it('throws MISSING_BRANCH_EXISTENCE when branchExistence is missing', () => {
    writeFile(scenesDir, 'chapter-01', 'E1a.yaml', committedMeta({ branchExistence: undefined }));
    writeFile(scenesDir, 'chapter-01', 'E1a.md', 'Prose.');

    const collector = new SceneCollector();
    expect(() => collector.collectFrom(scenesDir)).toThrow(AssemblyError);
  });

  it('throws UNKNOWN_COUNT_VERSION for missing text count version', () => {
    writeFile(
      scenesDir,
      'chapter-01',
      'E1a.yaml',
      committedMeta({ text_count_version: undefined }),
    );
    writeFile(scenesDir, 'chapter-01', 'E1a.md', 'Prose.');

    const collector = new SceneCollector();
    expect(() => collector.collectFrom(scenesDir)).toThrow(AssemblyError);
  });

  it('throws UNKNOWN_COUNT_VERSION for mismatched count version', () => {
    writeFile(scenesDir, 'chapter-01', 'E1a.yaml', committedMeta({ text_count_version: 99 }));
    writeFile(scenesDir, 'chapter-01', 'E1a.md', 'Prose.');

    const collector = new SceneCollector();
    expect(() => collector.collectFrom(scenesDir)).toThrow(AssemblyError);
  });

  it('handles multiple chapters', () => {
    writeFile(
      scenesDir,
      'chapter-01',
      'E1a.yaml',
      committedMeta({ event: 'E1a', narrativeOrder: 1 }),
    );
    writeFile(scenesDir, 'chapter-01', 'E1a.md', 'Scene one.');
    writeFile(
      scenesDir,
      'chapter-01',
      'E1b.yaml',
      committedMeta({ event: 'E1b', narrativeOrder: 2 }),
    );
    writeFile(scenesDir, 'chapter-01', 'E1b.md', 'Scene two.');
    writeFile(
      scenesDir,
      'chapter-02',
      'E2a.yaml',
      committedMeta({ event: 'E2a', narrativeOrder: 3 }),
    );
    writeFile(scenesDir, 'chapter-02', 'E2a.md', 'Scene three.');

    const collector = new SceneCollector();
    const result = collector.collectFrom(scenesDir);

    expect(result.size).toBe(3);
    expect(result.get('E1a')!.chapter).toBe(1);
    expect(result.get('E2a')!.chapter).toBe(2);
  });
});

describe('ProseConcatenator', () => {
  const allBranch: BranchSet = { type: 'all' };

  it('produces a markdown document with chapter headings', () => {
    const sorted: SortedScene[] = [
      {
        eventId: 'E1a',
        prose: 'First scene.',
        narrativeOrder: 1,
        chapter: 1,
        branchExistence: allBranch,
      },
      {
        eventId: 'E1b',
        prose: 'Second scene.',
        narrativeOrder: 2,
        chapter: 1,
        branchExistence: allBranch,
      },
      {
        eventId: 'E2a',
        prose: 'Third scene.',
        narrativeOrder: 3,
        chapter: 2,
        branchExistence: allBranch,
      },
    ];

    const concatenator = new ProseConcatenator();
    const markdown = concatenator.concatenate(sorted);

    expect(markdown).toContain('## Chapter 1');
    expect(markdown).toContain('First scene.');
    expect(markdown).toContain('Second scene.');
    expect(markdown).toContain('---');
    expect(markdown).toContain('## Chapter 2');
    expect(markdown).toContain('Third scene.');
  });

  it('includes chapter summary when provided', () => {
    const sorted: SortedScene[] = [
      {
        eventId: 'E1a',
        prose: 'Scene text.',
        narrativeOrder: 1,
        chapter: 1,
        branchExistence: allBranch,
      },
    ];
    const meta = new Map<number, { title: string; summary: string }>();
    meta.set(1, { title: 'Chapter One', summary: 'This is chapter one.' });

    const concatenator = new ProseConcatenator();
    const markdown = concatenator.concatenate(sorted, meta);

    expect(markdown).toContain('## Chapter 1: Chapter One');
    expect(markdown).toContain('> This is chapter one.');
  });

  it('handles empty scene list', () => {
    const concatenator = new ProseConcatenator();
    expect(concatenator.concatenate([])).toBe('');
  });
});

describe('loadChapterMetadata', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = createTempProject();
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('loads chapter metadata from _chapter.yaml files', () => {
    writeFile(
      projectDir,
      'chapters',
      'chapter_01',
      '_chapter.yaml',
      JSON.stringify({
        chapter: 1,
        title: 'The Beginning',
        summary: 'How it all started.',
        intent: 'Introduce the world.',
        plannedScenes: 2,
      }),
    );

    const result = loadChapterMetadata(projectDir);
    expect(result.size).toBe(1);
    const meta = result.get(1)!;
    expect(meta.title).toBe('The Beginning');
    expect(meta.summary).toBe('How it all started.');
  });

  it('returns empty map for missing chapters directory', () => {
    const noChapters = createTempProject();
    const result = loadChapterMetadata(noChapters);
    expect(result.size).toBe(0);
    fs.rmSync(noChapters, { recursive: true, force: true });
  });

  it('skips malformed _chapter.yaml files without throwing', () => {
    writeFile(projectDir, 'chapters', 'chapter_01', '_chapter.yaml', 'not: valid: yaml: [');
    const result = loadChapterMetadata(projectDir);
    expect(result.size).toBe(0);
  });
});

describe('filterScenesByBranchPath', () => {
  const allBranch: BranchSet = { type: 'all' };

  it('returns all scenes for "all" branch existence', () => {
    const scenes: SortedScene[] = [
      { eventId: 'E1', prose: '', narrativeOrder: 1, chapter: 1, branchExistence: allBranch },
    ];

    const result = filterScenesByBranchPath(scenes, { decisions: [] });
    expect(result).toHaveLength(1);
  });

  it('filters scenes by branch path', () => {
    const pathA: BranchSet = {
      type: 'paths',
      paths: [
        {
          decisions: [{ atEventId: 'E1', choiceId: 'a', narrativeOrder: 1 }],
        },
      ],
    };
    const pathB: BranchSet = {
      type: 'paths',
      paths: [
        {
          decisions: [{ atEventId: 'E1', choiceId: 'b', narrativeOrder: 1 }],
        },
      ],
    };

    const scenes: SortedScene[] = [
      { eventId: 'E1a', prose: '', narrativeOrder: 1, chapter: 1, branchExistence: pathA },
      { eventId: 'E1b', prose: '', narrativeOrder: 1, chapter: 1, branchExistence: pathB },
    ];

    const result = filterScenesByBranchPath(scenes, {
      decisions: [{ atEventId: 'E1', choiceId: 'a', narrativeOrder: 1 }],
    });
    expect(result).toHaveLength(1);
    expect(result[0].eventId).toBe('E1a');
  });

  it('excludes scene with unrecognized branch existence type', () => {
    const scenes: SortedScene[] = [
      {
        eventId: 'E1',
        prose: '',
        narrativeOrder: 1,
        chapter: 1,
        branchExistence: { type: 'invalid' } as unknown as BranchSet,
      },
    ];

    // Unrecognized type is not included in any path (includesPath returns false)
    const result = filterScenesByBranchPath(scenes, { decisions: [] });
    expect(result).toHaveLength(0);
  });
});

describe('assembleNovel', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = createTempProject();

    // Project config
    writeFile(
      projectDir,
      'nova.yaml',
      [
        'project: test',
        'title: Test Novel',
        'author: Tester',
      ].join('\n'),
    );

    // Chapter metadata
    writeFile(
      projectDir,
      'chapters',
      'chapter_01',
      '_chapter.yaml',
      JSON.stringify({
        chapter: 1,
        title: 'The Beginning',
        summary: 'How it all started.',
        intent: 'Introduce the world.',
        plannedScenes: 2,
      }),
    );
    writeFile(
      projectDir,
      'chapters',
      'chapter_02',
      '_chapter.yaml',
      JSON.stringify({
        chapter: 2,
        title: 'The Middle',
        summary: 'Things get complicated.',
        intent: 'Raise the stakes.',
        plannedScenes: 1,
      }),
    );

    // Scene prose and metadata (self-contained, no chapters/ cross-ref needed)
    writeFile(
      projectDir,
      'scenes',
      'chapter-01',
      'E1a.yaml',
      committedMeta({
        event: 'E1a',
        narrativeOrder: 1,
        branchExistence: { type: 'all' },
      }),
    );
    writeFile(
      projectDir,
      'scenes',
      'chapter-01',
      'E1a.md',
      'The hero woke up to a beautiful morning.\n\nSunlight streamed through the window.',
    );

    writeFile(
      projectDir,
      'scenes',
      'chapter-01',
      'E1b.yaml',
      committedMeta({
        event: 'E1b',
        narrativeOrder: 2,
        branchExistence: { type: 'all' },
      }),
    );
    writeFile(
      projectDir,
      'scenes',
      'chapter-01',
      'E1b.md',
      'The mentor stood in the doorway, cloaked in shadow.',
    );

    writeFile(
      projectDir,
      'scenes',
      'chapter-02',
      'E2a.yaml',
      committedMeta({
        event: 'E2a',
        narrativeOrder: 3,
        branchExistence: { type: 'all' },
      }),
    );
    writeFile(
      projectDir,
      'scenes',
      'chapter-02',
      'E2a.md',
      'The battle had begun. There was no turning back now.',
    );

    // ── Mandatory definitions directory ──────────────────────────
    writeFile(
      projectDir,
      'definitions',
      'discourse-ledger.yaml',
      [
        'id: test-novel',
        'chapters:',
        '  - branch: main',
        '    chapter: 1',
        '    sceneIds:',
        '      - E1a',
        '      - E1b',
        '  - branch: main',
        '    chapter: 2',
        '    sceneIds:',
        '      - E2a',
        'entries: []',
      ].join('\n'),
    );
    writeFile(
      projectDir,
      'definitions',
      'state_initial.yaml',
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

    // ── Event source files (required by EntityMapper) ───────────
    writeFile(
      projectDir,
      'chapters',
      'chapter_01',
      'E1a.yaml',
      [
        'event: E1a',
        'narrativeOrder: 1',
        'title: "First Event"',
        'storyTime: day_1',
        'pov:',
        '  character: narrator',
        '  type: first_person',
        'sceneBrief: "The hero wakes up."',
        'preconditions: []',
        'expectedPostconditions: []',
      ].join('\n'),
    );
    writeFile(
      projectDir,
      'chapters',
      'chapter_01',
      'E1b.yaml',
      [
        'event: E1b',
        'narrativeOrder: 2',
        'title: "Second Event"',
        'storyTime: day_1',
        'pov:',
        '  character: narrator',
        '  type: first_person',
        'sceneBrief: "The mentor arrives."',
        'preconditions: []',
        'expectedPostconditions: []',
      ].join('\n'),
    );
    writeFile(
      projectDir,
      'chapters',
      'chapter_02',
      'E2a.yaml',
      [
        'event: E2a',
        'narrativeOrder: 3',
        'title: "Third Event"',
        'storyTime: day_1',
        'pov:',
        '  character: narrator',
        '  type: first_person',
        'sceneBrief: "The battle begins."',
        'preconditions: []',
        'expectedPostconditions: []',
      ].join('\n'),
    );
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('assembles a complete novel', () => {
    const result = assembleNovel({ projectDir });

    expect(result.sceneCount).toBe(3);
    expect(result.wordCount).toBeGreaterThan(0);
    expect(result.markdown).toContain('# Test Novel');
    expect(result.markdown).toContain('## Chapter 1: The Beginning');
    expect(result.markdown).toContain('> How it all started.');
    expect(result.markdown).toContain('The hero woke up');
    expect(result.markdown).toContain('---');
    expect(result.markdown).toContain('The mentor stood');
    expect(result.markdown).toContain('## Chapter 2: The Middle');
    expect(result.markdown).toContain('> Things get complicated.');
    expect(result.markdown).toContain('The battle had begun');

    // Verify output file was written
    const outputPath = path.join(projectDir, 'output', 'novel.md');
    expect(fs.existsSync(outputPath)).toBe(true);
    const written = fs.readFileSync(outputPath, 'utf-8');
    expect(written).toBe(result.markdown);

    // Verify scene metadata in result
    expect(result.scenes).toHaveLength(3);
    expect(result.scenes[0].eventId).toBe('E1a');
    expect(result.scenes[0].branchExistence).toEqual({ type: 'all' });
  });

  it('supports custom output path', () => {
    const customPath = path.join(projectDir, 'my-book.md');
    const result = assembleNovel({ projectDir, outputPath: customPath });
    expect(fs.existsSync(customPath)).toBe(true);
    expect(result.sceneCount).toBe(3);
  });

  it('supports custom title override', () => {
    const result = assembleNovel({ projectDir, title: 'My Custom Title' });
    expect(result.markdown).toContain('# My Custom Title');
    expect(result.markdown).not.toContain('# Test Novel');
  });

  it('throws NO_SCENES with no committed scenes', () => {
    const emptyDir = createTempProject();
    expect(() => assembleNovel({ projectDir: emptyDir, title: 'Empty Book' })).toThrow(
      AssemblyError,
    );
    try {
      assembleNovel({ projectDir: emptyDir, title: 'Empty Book' });
    } catch (e: any) {
      expect(e.code).toBe(AssemblyErrorCode.NO_SCENES);
    }
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  it('throws when discourse-ledger.yaml is missing (fails before write)', () => {
    const noLedgerDir = createTempProject();
    // Set up chapter metadata and scenes (same as beforeEach)
    writeFile(
      noLedgerDir,
      'nova.yaml',
      [
        'project: test',
        'title: Missing Ledger',
        'author: Tester',
      ].join('\n'),
    );
    writeFile(
      noLedgerDir,
      'chapters',
      'chapter_01',
      '_chapter.yaml',
      JSON.stringify({
        chapter: 1,
        title: 'The Beginning',
        summary: 'How it all started.',
        intent: 'Introduce the world.',
        plannedScenes: 1,
      }),
    );
    writeFile(
      noLedgerDir,
      'chapters',
      'chapter_01',
      'E1.yaml',
      [
        'event: E1',
        'narrativeOrder: 1',
        'title: "Only Event"',
        'storyTime: day_1',
        'pov:',
        '  character: narrator',
        '  type: first_person',
        'sceneBrief: "A test scene."',
        'preconditions: []',
        'expectedPostconditions: []',
      ].join('\n'),
    );
    writeFile(
      noLedgerDir,
      'scenes',
      'chapter-01',
      'E1.yaml',
      committedMeta({ event: 'E1', narrativeOrder: 1 }),
    );
    writeFile(
      noLedgerDir,
      'scenes',
      'chapter-01',
      'E1.md',
      'Scene prose.',
    );

    // No definitions/discourse-ledger.yaml — must fail before write
    expect(() => assembleNovel({ projectDir: noLedgerDir })).toThrow(AssemblyError);
    try {
      assembleNovel({ projectDir: noLedgerDir });
    } catch (e: any) {
      expect(e.message).toContain('discourse scene sequence');
    }
    // Verify no output file was written
    expect(fs.existsSync(path.join(noLedgerDir, 'output', 'novel.md'))).toBe(false);
    fs.rmSync(noLedgerDir, { recursive: true, force: true });
  });

  it('includes all scenes in result.scenes array', () => {
    const result = assembleNovel({ projectDir });

    const sceneIds = result.scenes.map((s) => s.eventId);
    expect(sceneIds).toEqual(['E1a', 'E1b', 'E2a']);
    expect(result.scenes.every((s) => s.branchExistence)).toBe(true);
  });
});
