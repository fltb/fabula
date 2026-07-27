// ============================================================================
// Volume Summary Compiler Tests (Track 6F, D15)
// ============================================================================

import { describe, expect, it } from 'vitest';
import { VolumeSummaryCompiler } from '../src/summary/volume-summary.ts';
import type { ChapterMeta, SceneMeta, VolumeSummary } from '../src/types/summary.js';

// ============================================================================
// Helpers
// ============================================================================

function makeChapterMeta(overrides: Partial<ChapterMeta> & { chapter: number }): ChapterMeta {
  return {
    title: `Chapter ${overrides.chapter}`,
    summary: '',
    ...overrides,
  };
}

function makeSceneMeta(
  overrides: Partial<SceneMeta> & { eventId: string; chapter: number },
): SceneMeta {
  return {
    narrativeOrder: 0,
    ...overrides,
  };
}

// ============================================================================
// VolumeSummaryCompiler
// ============================================================================

describe('VolumeSummaryCompiler', () => {
  const compiler = new VolumeSummaryCompiler();

  describe('compile', () => {
    it('should produce an empty volume when given no scene summaries', () => {
      const result = compiler.compile([], []);
      expect(result.volumeId).toBe('volume-1');
      expect(result.keyArcs).toEqual([]);
      expect(result.characterTrajectory.size).toBe(0);
      expect(result.activeThreads).toEqual([]);
      expect(result.sceneCount).toBe(0);
    });

    it('should aggregate key arcs from chapter summaries', () => {
      const chapters: ChapterMeta[] = [
        makeChapterMeta({ chapter: 1, summary: 'The hero departs on a journey' }),
        makeChapterMeta({ chapter: 2, summary: 'The hero faces trials' }),
        makeChapterMeta({ chapter: 3, summary: 'The hero returns transformed' }),
      ];

      const result = compiler.compile(['scene 1', 'scene 2', 'scene 3'], chapters);

      expect(result.keyArcs).toEqual([
        'The hero departs on a journey',
        'The hero faces trials',
        'The hero returns transformed',
      ]);
      expect(result.sceneCount).toBe(3);
    });

    it('should skip empty chapter summaries', () => {
      const chapters: ChapterMeta[] = [
        makeChapterMeta({ chapter: 1, summary: 'Arc one' }),
        makeChapterMeta({ chapter: 2, summary: '' }),
      ];

      const result = compiler.compile(['scene'], chapters);

      expect(result.keyArcs).toEqual(['Arc one']);
    });

    it('should derive volumeId from chapter range', () => {
      const chapters: ChapterMeta[] = [
        makeChapterMeta({ chapter: 1 }),
        makeChapterMeta({ chapter: 5 }),
      ];

      const result = compiler.compile(['scene'], chapters);

      expect(result.volumeId).toBe('chapters-1-to-5');
    });

    it('should accept explicit volumeId', () => {
      const result = compiler.compile(['scene'], [], { volumeId: 'act-1' });
      expect(result.volumeId).toBe('act-1');
    });

    it('should extract active threads from scene summaries', () => {
      const sceneSummaries = [
        'Thread: mystery-of-amulet\nThe hero investigates.',
        'Thread: family-secret\nA family secret is revealed.',
        'The villain escapes.',
      ];

      const result = compiler.compile(sceneSummaries, []);

      expect(result.activeThreads).toContain('mystery-of-amulet');
      expect(result.activeThreads).toContain('family-secret');
      expect(result.activeThreads).toHaveLength(2);
    });

    it('should extract threads from "unresolved thread" heuristic markers', () => {
      const sceneSummaries = [
        'The hero ponders the unresolved thread: the ancient prophecy.',
        'Another line about unresolved thread: the lost heir.',
      ];

      const result = compiler.compile(sceneSummaries, []);

      expect(result.activeThreads).toContain('the ancient prophecy');
      expect(result.activeThreads).toContain('the lost heir');
    });

    it('should build character trajectory from most recent description', () => {
      const sceneSummaries = [
        // Earlier: character in initial state
        'Alice: eager and naive\nThe hero meets Alice.',
        // Later: character state evolves
        'Alice: battle-hardened and wise',
      ];

      const result = compiler.compile(sceneSummaries, []);

      expect(result.characterTrajectory.get('Alice')).toBe('battle-hardened and wise');
      expect(result.characterTrajectory.size).toBe(1);
    });

    it('should build character trajectory for multiple characters', () => {
      const sceneSummaries = ['Alice: curious\nBob: worried', 'Alice: tired'];

      const result = compiler.compile(sceneSummaries, []);

      expect(result.characterTrajectory.get('Alice')).toBe('tired');
      expect(result.characterTrajectory.get('Bob')).toBe('worried');
      expect(result.characterTrajectory.size).toBe(2);
    });
  });

  describe('detectVolumeBoundary', () => {
    it('should return [0] for empty scene list', () => {
      expect(compiler.detectVolumeBoundary([])).toEqual([0]);
    });

    it('should return [0] for a single scene', () => {
      const scenes: SceneMeta[] = [makeSceneMeta({ eventId: 'E1', chapter: 1 })];
      expect(compiler.detectVolumeBoundary(scenes)).toEqual([0]);
    });

    it('should detect chapter changes as volume boundaries', () => {
      const scenes: SceneMeta[] = [
        makeSceneMeta({ eventId: 'E1', chapter: 1 }),
        makeSceneMeta({ eventId: 'E2', chapter: 1 }),
        makeSceneMeta({ eventId: 'E3', chapter: 2 }),
        makeSceneMeta({ eventId: 'E4', chapter: 2 }),
        makeSceneMeta({ eventId: 'E5', chapter: 3 }),
      ];

      const boundaries = compiler.detectVolumeBoundary(scenes);

      expect(boundaries).toEqual([0, 2, 4]);
    });

    it('should detect climax transitions as volume boundaries', () => {
      const scenes: SceneMeta[] = [
        makeSceneMeta({ eventId: 'E1', chapter: 1, arcPosition: 'opening' }),
        makeSceneMeta({ eventId: 'E2', chapter: 1, arcPosition: 'rising' }),
        makeSceneMeta({ eventId: 'E3', chapter: 1, arcPosition: 'climax' }),
        makeSceneMeta({ eventId: 'E4', chapter: 1, arcPosition: 'falling' }),
        makeSceneMeta({ eventId: 'E5', chapter: 1, arcPosition: 'denouement' }),
      ];

      const boundaries = compiler.detectVolumeBoundary(scenes);

      expect(boundaries).toEqual([0, 3]);
    });

    it('should not create boundary between non-climax arc transitions', () => {
      const scenes: SceneMeta[] = [
        makeSceneMeta({ eventId: 'E1', chapter: 1, arcPosition: 'opening' }),
        makeSceneMeta({ eventId: 'E2', chapter: 1, arcPosition: 'rising' }),
        makeSceneMeta({ eventId: 'E3', chapter: 1, arcPosition: 'rising' }),
      ];

      const boundaries = compiler.detectVolumeBoundary(scenes);

      expect(boundaries).toEqual([0]);
    });

    it('should detect chapter-timestamp story time jumps', () => {
      const scenes: SceneMeta[] = [
        makeSceneMeta({
          eventId: 'E1',
          chapter: 1,
          storyTime: { type: 'chapter', chapter: 1, description: 'Year 1' },
        }),
        makeSceneMeta({
          eventId: 'E2',
          chapter: 1,
          storyTime: { type: 'chapter', chapter: 1, description: 'Year 1' },
        }),
        makeSceneMeta({
          eventId: 'E3',
          chapter: 1,
          storyTime: { type: 'chapter', chapter: 5, description: 'Year 5' },
        }),
      ];

      const boundaries = compiler.detectVolumeBoundary(scenes);

      expect(boundaries).toEqual([0, 2]);
    });

    it('should combine multiple boundary types', () => {
      const scenes: SceneMeta[] = [
        makeSceneMeta({ eventId: 'E1', chapter: 1, arcPosition: 'opening' }),
        makeSceneMeta({ eventId: 'E2', chapter: 1, arcPosition: 'climax' }),
        // climax→falling boundary
        makeSceneMeta({ eventId: 'E3', chapter: 1, arcPosition: 'falling' }),
        // chapter boundary
        makeSceneMeta({ eventId: 'E4', chapter: 2, arcPosition: 'denouement' }),
        makeSceneMeta({ eventId: 'E5', chapter: 2, arcPosition: 'opening' }),
      ];

      const boundaries = compiler.detectVolumeBoundary(scenes);

      expect(boundaries).toEqual([0, 2, 3]);
    });
  });

  describe('renderToMarkdown', () => {
    it('should render a complete VolumeSummary to markdown', () => {
      const summary: VolumeSummary = {
        volumeId: 'chapters-1-to-3',
        keyArcs: ['The hero departs', 'The hero returns'],
        characterTrajectory: new Map([
          ['Alice', 'tired but determined'],
          ['Bob', 'worried'],
        ]),
        activeThreads: ['mystery-of-amulet', 'family-secret'],
        sceneCount: 12,
      };

      const md = compiler.renderToMarkdown(summary);

      expect(md).toContain('## Volume Summary: chapters-1-to-3');
      expect(md).toContain('### Key Narrative Arcs');
      expect(md).toContain('- The hero departs');
      expect(md).toContain('- The hero returns');
      expect(md).toContain('### Character Trajectories');
      expect(md).toContain('Alice: tired but determined');
      expect(md).toContain('Bob: worried');
      expect(md).toContain('### Active Threads');
      expect(md).toContain('- mystery-of-amulet');
      expect(md).toContain('- family-secret');
      expect(md).toContain('Scene count: 12');
    });

    it('should handle empty VolumeSummary gracefully', () => {
      const summary: VolumeSummary = {
        volumeId: 'empty',
        keyArcs: [],
        characterTrajectory: new Map(),
        activeThreads: [],
        sceneCount: 0,
      };

      const md = compiler.renderToMarkdown(summary);

      expect(md).toContain('## Volume Summary: empty');
      expect(md).not.toContain('### Key Narrative Arcs');
      expect(md).not.toContain('### Character Trajectories');
      expect(md).not.toContain('### Active Threads');
      expect(md).toContain('Scene count: 0');
    });
  });
});
