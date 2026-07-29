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
  NarrativeSorter,
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

describe('NarrativeSorter', () => {
  const allBranch: BranchSet = { type: 'all' };
  const mkEntry = (prose: string, order: number, ch: number): SceneEntry => ({
    prose,
    metadata: {} as any,
    narrativeOrder: order,
    chapter: ch,
    branchExistence: allBranch,
  });

  it('sorts scenes by narrativeOrder ascending', () => {
    const map = new Map<string, SceneEntry>([
      ['E3', mkEntry('Third', 3, 2)],
      ['E1', mkEntry('First', 1, 1)],
      ['E2', mkEntry('Second', 2, 1)],
    ]);

    const sorter = new NarrativeSorter();
    const sorted = sorter.sortByOrder(map);

    expect(sorted.map((s) => s.narrativeOrder)).toEqual([1, 2, 3]);
    expect(sorted.map((s) => s.prose)).toEqual(['First', 'Second', 'Third']);
  });

  it('preserves chapter grouping', () => {
    const map = new Map<string, SceneEntry>([
      ['E2', mkEntry('Ch2-scene', 10, 2)],
      ['E1', mkEntry('Ch1-scene', 5, 1)],
    ]);

    const sorter = new NarrativeSorter();
    const sorted = sorter.sortByOrder(map);

    expect(sorted[0].chapter).toBe(1);
    expect(sorted[1].chapter).toBe(2);
  });

  it('propagates branchExistence to sorted scenes', () => {
    const paths: BranchSet = {
      type: 'paths',
      paths: [
        {
          decisions: [{ atEventId: 'E', choiceId: 'a', narrativeOrder: 1 }],
        },
      ],
    };
    const map = new Map<string, SceneEntry>([
      [
        'E1',
        { prose: 'A', metadata: {} as any, narrativeOrder: 1, chapter: 1, branchExistence: paths },
      ],
    ]);

    const sorter = new NarrativeSorter();
    const sorted = sorter.sortByOrder(map);

    expect(sorted[0].branchExistence).toEqual(paths);
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

    const chapterMetadata = new Map<number, any>([
      [
        1,
        {
          chapter: 1,
          title: 'The Beginning',
          summary: 'Start of story.',
          intent: '',
          plannedScenes: 2,
        },
      ],
      [
        2,
        {
          chapter: 2,
          title: 'The Middle',
          summary: 'Rising action.',
          intent: '',
          plannedScenes: 1,
        },
      ],
    ]);

    const concat = new ProseConcatenator();
    const md = concat.concatenate(sorted, chapterMetadata, 'Test Novel');

    expect(md).toContain('# Test Novel');
    expect(md).toContain('## Chapter 1: The Beginning');
    expect(md).toContain('> Start of story.');
    expect(md).toContain('First scene.');
    expect(md).toContain('---');
    expect(md).toContain('Second scene.');
    expect(md).toContain('## Chapter 2: The Middle');
    expect(md).toContain('> Rising action.');
    expect(md).toContain('Third scene.');
  });

  it('handles single scene without separator at end', () => {
    const sorted: SortedScene[] = [
      {
        eventId: 'E1',
        prose: 'Only scene.',
        narrativeOrder: 1,
        chapter: 1,
        branchExistence: allBranch,
      },
    ];

    const concat = new ProseConcatenator();
    const md = concat.concatenate(sorted, undefined, 'Title');

    expect(md).toContain('# Title');
    expect(md).toContain('## Chapter 1');
    expect(md).toContain('Only scene.');
    expect(md).not.toContain('---');
    expect(md.endsWith('\n')).toBe(true);
  });

  it('returns empty string for empty input without title', () => {
    const concat = new ProseConcatenator();
    expect(concat.concatenate([])).toBe('');
  });

  it('returns placeholder for empty input with title', () => {
    const concat = new ProseConcatenator();
    const md = concat.concatenate([], undefined, 'Empty Book');
    expect(md).toContain('# Empty Book');
    expect(md).toContain('No scenes have been committed yet.');
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
        title: 'First Chapter',
        summary: 'Summary of chapter one.',
        intent: 'Set up the world.',
        planned_scenes: 3,
      }),
    );

    const meta = loadChapterMetadata(projectDir);
    expect(meta.size).toBe(1);
    expect(meta.get(1)!.title).toBe('First Chapter');
    expect(meta.get(1)!.summary).toBe('Summary of chapter one.');
  });

  it('returns empty map when chapters directory is missing', () => {
    fs.rmSync(path.join(projectDir, 'chapters'), { recursive: true, force: true });
    const meta = loadChapterMetadata(projectDir);
    expect(meta.size).toBe(0);
  });
});

describe('filterScenesByBranchPath', () => {
  const laneA: BranchPath = { decisions: [{ atEventId: 'E2', choiceId: 'a', narrativeOrder: 2 }] };
  const laneB: BranchPath = { decisions: [{ atEventId: 'E2', choiceId: 'b', narrativeOrder: 2 }] };
  const scenes: SortedScene[] = [
    { eventId: 'E1', prose: '', narrativeOrder: 1, chapter: 1, branchExistence: { type: 'all' } },
    {
      eventId: 'E2a',
      prose: '',
      narrativeOrder: 2,
      chapter: 1,
      branchExistence: { type: 'paths', paths: [laneA] },
    },
    {
      eventId: 'E2b',
      prose: '',
      narrativeOrder: 3,
      chapter: 1,
      branchExistence: { type: 'paths', paths: [laneB] },
    },
  ];

  it('includes only linear scenes for an empty path', () => {
    expect(filterScenesByBranchPath(scenes).map((scene) => scene.eventId)).toEqual(['E1']);
  });

  it('includes exactly the selected lane without leakage', () => {
    expect(filterScenesByBranchPath(scenes, laneA).map((scene) => scene.eventId)).toEqual([
      'E1',
      'E2a',
    ]);
    expect(filterScenesByBranchPath(scenes, laneB).map((scene) => scene.eventId)).toEqual([
      'E1',
      'E2b',
    ]);
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
      JSON.stringify({
        project: 'test',
        title: 'Test Novel',
        author: 'Tester',
      }),
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
        planned_scenes: 2,
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
        planned_scenes: 1,
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

  it('throws DUPLICATE_NARRATIVE_ORDER for duplicate orders', () => {
    writeFile(
      projectDir,
      'scenes',
      'chapter-02',
      'E2a.yaml',
      committedMeta({
        event: 'E2a',
        narrativeOrder: 1, // Same as E1a
        branchExistence: { type: 'all' },
      }),
    );

    expect(() => assembleNovel({ projectDir })).toThrow(AssemblyError);
    try {
      assembleNovel({ projectDir });
    } catch (e: any) {
      expect(e.code).toBe(AssemblyErrorCode.DUPLICATE_NARRATIVE_ORDER);
    }
  });

  it('includes all scenes in result.scenes array', () => {
    const result = assembleNovel({ projectDir });

    const sceneIds = result.scenes.map((s) => s.eventId);
    expect(sceneIds).toEqual(['E1a', 'E1b', 'E2a']);
    expect(result.scenes.every((s) => s.branchExistence)).toBe(true);
  });
});
