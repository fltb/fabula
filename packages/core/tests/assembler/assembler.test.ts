import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import {
  countWords,
  SceneCollector,
  NarrativeSorter,
  ProseConcatenator,
  loadChapterMetadata,
  filterScenesByBranchPath,
  assembleNovel,
  type SceneEntry,
  type SortedScene,
} from '../../src/assembler/index.js';

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
  let chaptersDir: string;

  beforeEach(() => {
    projectDir = createTempProject();
    scenesDir = path.join(projectDir, 'scenes');
    chaptersDir = path.join(projectDir, 'chapters');
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('returns empty map when scenes directory is missing', () => {
    const collector = new SceneCollector();
    const result = collector.collectFrom('/nonexistent');
    expect(result.size).toBe(0);
  });

  it('collects scenes from chapter directories', () => {
    // Write scene metadata
    writeFile(scenesDir, 'chapter-01', 'E1a.yaml', JSON.stringify({
      event: 'E1a',
      proseSource: 'llm',
      editHistory: [],
      narrativeOrder: 1,
    }));
    writeFile(scenesDir, 'chapter-01', 'E1a.md', 'This is the first scene.');

    const collector = new SceneCollector();
    const result = collector.collectFrom(scenesDir);

    expect(result.size).toBe(1);
    const entry = result.get('E1a')!;
    expect(entry.prose).toBe('This is the first scene.');
    expect(entry.narrativeOrder).toBe(1);
    expect(entry.chapter).toBe(1);
  });

  it('cross-references narrativeOrder from chapters dir when missing in metadata', () => {
    // Scene metadata without narrativeOrder
    writeFile(scenesDir, 'chapter-01', 'E1a.yaml', JSON.stringify({
      event: 'E1a',
      proseSource: 'llm',
      editHistory: [],
    }));
    writeFile(scenesDir, 'chapter-01', 'E1a.md', 'Scene prose text.');

    // Event file with narrativeOrder
    writeFile(chaptersDir, 'chapter_01', 'E1a.yaml', JSON.stringify({
      event: 'E1a',
      narrative_order: 42,
      title: 'First Event',
      storyTime: 'day 1',
      pov: { character: 'hero', type: 'third_person_limited' },
      sceneBrief: 'Brief',
      preconditions: [],
      expectedPostconditions: [],
    }));

    const collector = new SceneCollector();
    const result = collector.collectFrom(scenesDir, chaptersDir);

    expect(result.size).toBe(1);
    expect(result.get('E1a')!.narrativeOrder).toBe(42);
  });

  it('skips scenes when .md file is missing (logs warning)', () => {
    writeFile(scenesDir, 'chapter-01', 'E1a.yaml', JSON.stringify({
      event: 'E1a',
      proseSource: 'llm',
      editHistory: [],
      narrativeOrder: 1,
    }));
    // No .md file

    const collector = new SceneCollector();
    const result = collector.collectFrom(scenesDir);

    expect(result.size).toBe(0);
  });

  it('handles multiple chapters', () => {
    // Chapter 1
    writeFile(scenesDir, 'chapter-01', 'E1a.yaml', JSON.stringify({
      event: 'E1a', proseSource: 'llm', editHistory: [], narrativeOrder: 1,
    }));
    writeFile(scenesDir, 'chapter-01', 'E1a.md', 'Scene one.');
    writeFile(scenesDir, 'chapter-01', 'E1b.yaml', JSON.stringify({
      event: 'E1b', proseSource: 'llm', editHistory: [], narrativeOrder: 2,
    }));
    writeFile(scenesDir, 'chapter-01', 'E1b.md', 'Scene two.');

    // Chapter 2
    writeFile(scenesDir, 'chapter-02', 'E2a.yaml', JSON.stringify({
      event: 'E2a', proseSource: 'llm', editHistory: [], narrativeOrder: 3,
    }));
    writeFile(scenesDir, 'chapter-02', 'E2a.md', 'Scene three.');

    const collector = new SceneCollector();
    const result = collector.collectFrom(scenesDir);

    expect(result.size).toBe(3);
    expect(result.get('E1a')!.chapter).toBe(1);
    expect(result.get('E2a')!.chapter).toBe(2);
  });
});

describe('NarrativeSorter', () => {
  it('sorts scenes by narrativeOrder ascending', () => {
    const map = new Map<string, SceneEntry>([
      ['E3', { prose: 'Third', metadata: {} as any, narrativeOrder: 3, chapter: 2 }],
      ['E1', { prose: 'First', metadata: {} as any, narrativeOrder: 1, chapter: 1 }],
      ['E2', { prose: 'Second', metadata: {} as any, narrativeOrder: 2, chapter: 1 }],
    ]);

    const sorter = new NarrativeSorter();
    const sorted = sorter.sortByOrder(map);

    expect(sorted.map((s) => s.narrativeOrder)).toEqual([1, 2, 3]);
    expect(sorted.map((s) => s.prose)).toEqual(['First', 'Second', 'Third']);
  });

  it('preserves chapter grouping', () => {
    const map = new Map<string, SceneEntry>([
      ['E2', { prose: 'Ch2-scene', metadata: {} as any, narrativeOrder: 10, chapter: 2 }],
      ['E1', { prose: 'Ch1-scene', metadata: {} as any, narrativeOrder: 5, chapter: 1 }],
    ]);

    const sorter = new NarrativeSorter();
    const sorted = sorter.sortByOrder(map);

    expect(sorted[0].chapter).toBe(1);
    expect(sorted[1].chapter).toBe(2);
  });
});

describe('ProseConcatenator', () => {
  it('produces a markdown document with chapter headings', () => {
    const sorted: SortedScene[] = [
      { eventId: 'E1a', prose: 'First scene.', narrativeOrder: 1, chapter: 1 },
      { eventId: 'E1b', prose: 'Second scene.', narrativeOrder: 2, chapter: 1 },
      { eventId: 'E2a', prose: 'Third scene.', narrativeOrder: 3, chapter: 2 },
    ];

    const chapterMetadata = new Map<number, any>([
      [1, { chapter: 1, title: 'The Beginning', summary: 'Start of story.', intent: '', plannedScenes: 2 }],
      [2, { chapter: 2, title: 'The Middle', summary: 'Rising action.', intent: '', plannedScenes: 1 }],
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
      { eventId: 'E1', prose: 'Only scene.', narrativeOrder: 1, chapter: 1 },
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
    writeFile(projectDir, 'chapters', 'chapter_01', '_chapter.yaml', JSON.stringify({
      chapter: 1,
      title: 'First Chapter',
      summary: 'Summary of chapter one.',
      intent: 'Set up the world.',
      planned_scenes: 3,
    }));

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
  const scenes: SortedScene[] = [
    { eventId: 'E1', prose: '', narrativeOrder: 1, chapter: 1 },
    { eventId: 'E2', prose: '', narrativeOrder: 2, chapter: 1 },
    { eventId: 'E3', prose: '', narrativeOrder: 3, chapter: 2 },
    { eventId: 'E4', prose: '', narrativeOrder: 4, chapter: 2 },
  ];

  it('returns all scenes when no branch path given', () => {
    expect(filterScenesByBranchPath(scenes)).toEqual(scenes);
    expect(filterScenesByBranchPath(scenes, undefined)).toEqual(scenes);
  });

  it('returns all scenes when branch path has no decisions', () => {
    const bp: BranchPath = { decisions: [] };
    expect(filterScenesByBranchPath(scenes, bp)).toEqual(scenes);
  });

  it('includes scenes up to last decision point', () => {
    const bp: BranchPath = {
      decisions: [{ atEventId: 'E2', choiceId: 'c1', narrativeOrder: 2 }],
    };
    const filtered = filterScenesByBranchPath(scenes, bp);
    expect(filtered.length).toBe(4); // all scenes at or before order 2
  });
});

describe('assembleNovel', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = createTempProject();

    // Project config
    writeFile(projectDir, 'nova.yaml', JSON.stringify({
      project: 'test',
      title: 'Test Novel',
      author: 'Tester',
    }));

    // Chapter metadata
    writeFile(projectDir, 'chapters', 'chapter_01', '_chapter.yaml', JSON.stringify({
      chapter: 1,
      title: 'The Beginning',
      summary: 'How it all started.',
      intent: 'Introduce the world.',
      planned_scenes: 2,
    }));
    writeFile(projectDir, 'chapters', 'chapter_02', '_chapter.yaml', JSON.stringify({
      chapter: 2,
      title: 'The Middle',
      summary: 'Things get complicated.',
      intent: 'Raise the stakes.',
      planned_scenes: 1,
    }));

    // Event files (for narrativeOrder cross-ref)
    writeFile(projectDir, 'chapters', 'chapter_01', 'E1a.yaml', JSON.stringify({
      event: 'E1a',
      narrative_order: 1,
      title: 'First Event',
      storyTime: 'day 1',
      pov: { character: 'hero', type: 'third_person_limited' },
      sceneBrief: 'The hero wakes up.',
      preconditions: [],
      expectedPostconditions: [],
    }));
    writeFile(projectDir, 'chapters', 'chapter_01', 'E1b.yaml', JSON.stringify({
      event: 'E1b',
      narrative_order: 2,
      title: 'Second Event',
      storyTime: 'day 1',
      pov: { character: 'hero', type: 'third_person_limited' },
      sceneBrief: 'The hero meets the mentor.',
      preconditions: [],
      expectedPostconditions: [],
    }));
    writeFile(projectDir, 'chapters', 'chapter_02', 'E2a.yaml', JSON.stringify({
      event: 'E2a',
      narrative_order: 3,
      title: 'Third Event',
      storyTime: 'day 3',
      pov: { character: 'hero', type: 'third_person_limited' },
      sceneBrief: 'The conflict escalates.',
      preconditions: [],
      expectedPostconditions: [],
    }));

    // Scene prose and metadata
    writeFile(projectDir, 'scenes', 'chapter-01', 'E1a.yaml', JSON.stringify({
      event: 'E1a',
      proseSource: 'llm',
      editHistory: [],
    }));
    writeFile(projectDir, 'scenes', 'chapter-01', 'E1a.md', 'The hero woke up to a beautiful morning.\n\nSunlight streamed through the window.');

    writeFile(projectDir, 'scenes', 'chapter-01', 'E1b.yaml', JSON.stringify({
      event: 'E1b',
      proseSource: 'llm',
      editHistory: [],
    }));
    writeFile(projectDir, 'scenes', 'chapter-01', 'E1b.md', 'The mentor stood in the doorway, cloaked in shadow.');

    writeFile(projectDir, 'scenes', 'chapter-02', 'E2a.yaml', JSON.stringify({
      event: 'E2a',
      proseSource: 'llm',
      editHistory: [],
    }));
    writeFile(projectDir, 'scenes', 'chapter-02', 'E2a.md', 'The battle had begun. There was no turning back now.');
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

  it('returns empty result for project with no scenes', () => {
    const emptyDir = createTempProject();
    const result = assembleNovel({ projectDir: emptyDir, title: 'Empty Book' });
    expect(result.sceneCount).toBe(0);
    // The placeholder message contains words itself
    expect(result.wordCount).toBeGreaterThan(0);
    expect(result.markdown).toContain('No scenes have been committed yet.');
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });
});
