import { describe, expect, it } from 'vitest';
import {
  AssemblyError,
  AssemblyErrorCode,
  assembleNovel,
  countWords,
  filterScenesByBranchPath,
  ProseConcatenator,
  type SceneEntry,
  type SortedScene,
} from '../../src/assembler/index.js';
import type { ProjectSourceSnapshotV1 } from '../../src/contracts/source.ts';
import type { ChapterMetadata } from '../../src/types/chapter.ts';
import type { BranchPath, BranchSet } from '../../src/types/index.js';

const allBranch: BranchSet = { type: 'all' };
const snapshot: ProjectSourceSnapshotV1 = {
  version: 1,
  sourceHash: 'source-assembly-test',
  documents: [],
};

function source(overrides: Partial<{
  scenes: ReadonlyMap<string, SceneEntry>;
  discourseSequence: readonly { sceneId: string; sequence: number; chapter: number }[];
  chapterTitles: ReadonlyMap<number, ChapterMetadata>;
  projectTitle: string;
}> = {}) {
  return {
    snapshot,
    scenes: overrides.scenes ?? new Map<string, SceneEntry>(),
    discourseSequence: overrides.discourseSequence ?? [],
    chapterTitles: overrides.chapterTitles,
    projectTitle: overrides.projectTitle,
  };
}

function scene(prose: string, chapter: number, narrativeOrder: number, branchExistence: BranchSet = allBranch): SceneEntry {
  return { prose, metadata: {}, chapter, narrativeOrder, branchExistence };
}

describe('countWords', () => {
  it('counts words in plain text', () => expect(countWords('hello world')).toBe(2));
  it('ignores markdown headings', () => expect(countWords('# Chapter 1\nSome text here.')).toBe(5));
  it('strips markdown links', () => expect(countWords('See [this link](http://example.com) here.')).toBe(4));
  it('returns 0 for empty string', () => expect(countWords('')).toBe(0));
});

describe('ProseConcatenator', () => {
  it('produces chapter headings and separators', () => {
    const sorted: SortedScene[] = [
      { eventId: 'E1a', prose: 'First scene.', narrativeOrder: 1, chapter: 1, branchExistence: allBranch },
      { eventId: 'E1b', prose: 'Second scene.', narrativeOrder: 2, chapter: 1, branchExistence: allBranch },
      { eventId: 'E2a', prose: 'Third scene.', narrativeOrder: 3, chapter: 2, branchExistence: allBranch },
    ];
    const markdown = new ProseConcatenator().concatenate(sorted);
    expect(markdown).toContain('## Chapter 1');
    expect(markdown).toContain('First scene.');
    expect(markdown).toContain('---');
    expect(markdown).toContain('## Chapter 2');
  });
  it('uses supplied chapter titles', () => {
    const markdown = new ProseConcatenator().concatenate([
      { eventId: 'E1', prose: 'Scene text.', narrativeOrder: 1, chapter: 1, branchExistence: allBranch },
    ], new Map([[1, { title: 'Chapter One' }]]));
    expect(markdown).toContain('## Chapter 1: Chapter One');
  });
});

describe('filterScenesByBranchPath', () => {
  it('retains all-branch scenes', () => expect(filterScenesByBranchPath([
    { eventId: 'E1', prose: '', narrativeOrder: 1, chapter: 1, branchExistence: allBranch },
  ], { decisions: [] })).toHaveLength(1));
  it('selects only scenes containing the requested path', () => {
    const pathA: BranchSet = { type: 'paths', paths: [{ decisions: [{ atEventId: 'E1', choiceId: 'a', narrativeOrder: 1 }] }] };
    const pathB: BranchSet = { type: 'paths', paths: [{ decisions: [{ atEventId: 'E1', choiceId: 'b', narrativeOrder: 1 }] }] };
    const result = filterScenesByBranchPath([
      { eventId: 'E1a', prose: '', narrativeOrder: 1, chapter: 1, branchExistence: pathA },
      { eventId: 'E1b', prose: '', narrativeOrder: 1, chapter: 1, branchExistence: pathB },
    ], { decisions: [{ atEventId: 'E1', choiceId: 'a', narrativeOrder: 1 }] });
    expect(result.map((item) => item.eventId)).toEqual(['E1a']);
  });
});

describe('assembleNovel', () => {
  const scenes = new Map<string, SceneEntry>([
    ['E1a', scene('First scene.', 1, 1)],
    ['E1b', scene('Second scene.', 1, 2)],
    ['E2a', scene('Third scene.', 2, 3)],
  ]);

  it('assembles ordered chapters from an immutable source snapshot', () => {
    const result = assembleNovel({
      source: source({ scenes, discourseSequence: [{ sceneId: 'E1a', sequence: 0, chapter: 1 }, { sceneId: 'E1b', sequence: 1, chapter: 1 }, { sceneId: 'E2a', sequence: 2, chapter: 2 }], chapterTitles: new Map([[1, { chapter: 1, title: 'Opening', summary: '', intent: '', plannedScenes: 2 }], [2, { chapter: 2, title: 'Conclusion', summary: '', intent: '', plannedScenes: 1 }]]), projectTitle: 'Test Novel' }),
      title: 'Canonical Title',
    });
    expect(result.sceneCount).toBe(3);
    expect(result.scenes.map(({ eventId }) => eventId)).toEqual(['E1a', 'E1b', 'E2a']);
    expect(result.markdown).toContain('# Canonical Title');
    expect(result.markdown).toContain('## Chapter 1: Opening');
    expect(result.markdown).toContain('## Chapter 2: Conclusion');
    expect(result.sourceHash).toBe(snapshot.sourceHash);
  });

  it('filters branch-scoped scenes without changing discourse ordering', () => {
    const result = assembleNovel({
      source: source({ scenes: new Map([...scenes, ['E1b', scene('Branch B.', 1, 2, { type: 'paths', paths: [{ decisions: [{ atEventId: 'E1', choiceId: 'b', narrativeOrder: 1 }] }] })]]), discourseSequence: [{ sceneId: 'E1a', sequence: 0, chapter: 1 }, { sceneId: 'E1b', sequence: 1, chapter: 1 }, { sceneId: 'E2a', sequence: 2, chapter: 2 }] }),
      branchPath: { decisions: [{ atEventId: 'E1', choiceId: 'a', narrativeOrder: 1 }] } as BranchPath,
    });
    expect(result.scenes.map(({ eventId }) => eventId)).toEqual(['E1a', 'E2a']);
  });

  it('rejects empty and incomplete discourse sequences', () => {
    expect(() => assembleNovel({ source: source() })).toThrowError(AssemblyError);
    try { assembleNovel({ source: source() }); } catch (error) { expect((error as AssemblyError).code).toBe(AssemblyErrorCode.NO_SCENES); }
    expect(() => assembleNovel({ source: source({ scenes: new Map([['E1', scene('text', 1, 1)]]), discourseSequence: [] }) })).toThrowError(/not in discourse sequence/);
  });
});
