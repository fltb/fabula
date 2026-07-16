import type { ChapterMetadata } from '../types/index.js';
import type { SortedScene } from './types.js';

// ────────────────────────────────────────────────────────────────────────────
// ProseConcatenator
// ────────────────────────────────────────────────────────────────────────────

/**
 * Produces the final novel markdown by concatenating sorted scenes with
 * chapter headings, scene separators, and optional chapter summaries.
 *
 * Output format:
 *
 *   # Novel Title
 *
 *   ## Chapter 1: Chapter Title
 *
 *   > Chapter summary (if available)
 *
 *   (scene prose)
 *
 *   ---
 *
 *   (next scene prose)
 *
 *   ## Chapter 2: Chapter Title
 *
 *   ...
 */
export class ProseConcatenator {
  /**
   * Concatenate sorted scenes into a full novel markdown document.
   *
   * @param sorted           Scenes sorted by narrativeOrder ascending
   * @param chapterMetadata  Optional map of chapter number → metadata
   * @param title            Optional novel title (default: "Untitled")
   */
  concatenate(
    sorted: SortedScene[],
    chapterMetadata?: Map<number, ChapterMetadata>,
    title?: string,
  ): string {
    if (sorted.length === 0) {
      if (title) {
        return `# ${title}\n\n_No scenes have been committed yet._\n`;
      }
      return '';
    }

    const blocks: string[] = [];

    // ── Title ────────────────────────────────────────────────────
    if (title) {
      blocks.push(`# ${title}`, '');
    }

    let currentChapter = -1;

    for (let i = 0; i < sorted.length; i++) {
      const scene = sorted[i];

      if (scene.chapter !== currentChapter) {
        // Close previous chapter if we were in one (no extra blank line
        // needed because the separator already provides spacing)
        currentChapter = scene.chapter;

        const meta = chapterMetadata?.get(currentChapter);
        let heading = `## Chapter ${currentChapter}`;
        if (meta?.title) {
          heading += `: ${meta.title}`;
        }
        blocks.push(heading, '');

        if (meta?.summary) {
          const quoted = meta.summary
            .trim()
            .split('\n')
            .map((l) => `> ${l}`)
            .join('\n');
          blocks.push(quoted, '');
        }
      }

      // Scene prose
      const prose = scene.prose.trim();
      if (prose) {
        blocks.push(prose, '');
      }

      // Separator between scenes (not after the last scene)
      if (i < sorted.length - 1) {
        blocks.push('---', '');
      }
    }

    return blocks.join('\n').trimEnd() + '\n';
  }
}
