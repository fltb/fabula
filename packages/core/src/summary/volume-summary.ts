// ============================================================================
// Volume Summary Compiler — L0 aggregate from scene-level L1 summaries
//
// Deterministic, no LLM. Compiles volume-level context from:
//   - scene summaries (disclosure-safe, from Pass 1)
//   - chapter metadata (YAML source)
//   - scene metadata (narrative order, story time, arc position)
// ============================================================================

import type { VolumeSummary, ChapterMeta, SceneMeta } from '../types/summary.js';

export interface VolumeSummaryOptions {
  /** Label for the volume (derived from story time or chapter range) */
  volumeId?: string;
}

/**
 * VolumeSummaryCompiler — deterministic L0 summary aggregator.
 *
 * Compiles a VolumeSummary from an array of scene summaries and chapter
 * metadata.  All logic is pure and deterministic — no LLM calls.
 */
export class VolumeSummaryCompiler {
  /**
   * Aggregate scene summaries into a volume-level summary.
   *
   * @param sceneSummaries  Per-scene disclosure-safe summaries (L1)
   * @param chapterMetadata  Chapter metadata from YAML
   * @param options          Optional volume configuration
   * @returns                Aggregated VolumeSummary
   */
  compile(
    sceneSummaries: string[],
    chapterMetadata: ChapterMeta[],
    options?: VolumeSummaryOptions,
  ): VolumeSummary {
    // Collect key arcs from chapter summaries (each chapter summary describes
    // its narrative arc).
    const keyArcs: string[] = [];
    for (const ch of chapterMetadata) {
      if (ch.summary && ch.summary.trim().length > 0) {
        keyArcs.push(ch.summary.trim());
      }
    }

    // Derive volumeId from chapter range or explicit label.
    const volumeId =
      options?.volumeId ??
      this._deriveVolumeId(chapterMetadata);

    // Active threads: extract from scene summaries that mention unresolved
    // threads (lines prefixed with "Thread:" or containing "unresolved").
    const activeThreads = this._extractActiveThreads(sceneSummaries);

    // Character trajectory: for each unique character reference in scene
    // summaries, take the most recent description as the current state.
    const characterTrajectory = this._buildCharacterTrajectory(sceneSummaries);

    return {
      volumeId,
      keyArcs,
      characterTrajectory,
      activeThreads,
      sceneCount: sceneSummaries.length,
    };
  }

  /**
   * Derive volume boundaries from scene metadata.
   *
   * Returns an array of indices into the `scenes` array where a volume
   * boundary exists (the index of the first scene of each new volume).
   * A boundary is detected when:
   *   - chapter number changes
   *   - arcPosition transitions through 'climax' (climax → falling marks
   *     a major structural boundary)
   *   - storyTime has a significant jump (heuristic: different chapter
   *     timestamps)
   *
   * @param scenes  Ordered scene metadata array
   * @returns       Indices where new volumes begin (always includes 0)
   */
  detectVolumeBoundary(scenes: SceneMeta[]): number[] {
    if (scenes.length === 0) return [0];

    const boundaries: number[] = [0];

    for (let i = 1; i < scenes.length; i++) {
      const prev = scenes[i - 1];
      const curr = scenes[i];

      // Chapter boundary == volume boundary
      if (curr.chapter !== prev.chapter) {
        boundaries.push(i);
        continue;
      }

      // Major arc transition: climax → anything else signals a structural
      // boundary.
      if (
        prev.arcPosition === 'climax' &&
        curr.arcPosition !== prev.arcPosition
      ) {
        boundaries.push(i);
        continue;
      }

      // Significant story time jump: chapter-level time skip indicates a
      // new structural unit.  Check via ChapterTimestamp.
      if (
        prev.storyTime &&
        curr.storyTime &&
        prev.storyTime.type === 'chapter' &&
        curr.storyTime.type === 'chapter' &&
        curr.storyTime.chapter !== prev.storyTime.chapter
      ) {
        boundaries.push(i);
        continue;
      }
    }

    return boundaries;
  }

  /**
   * Render a VolumeSummary to a short markdown string suitable for
   * inclusion in a context package.
   */
  renderToMarkdown(summary: VolumeSummary): string {
    const lines: string[] = [];
    lines.push(`## Volume Summary: ${summary.volumeId}`);
    lines.push('');

    if (summary.keyArcs.length > 0) {
      lines.push('### Key Narrative Arcs');
      for (const arc of summary.keyArcs) {
        lines.push(`- ${arc}`);
      }
      lines.push('');
    }

    if (summary.characterTrajectory.size > 0) {
      lines.push('### Character Trajectories');
      for (const [entityId, state] of summary.characterTrajectory) {
        lines.push(`- ${entityId}: ${state}`);
      }
      lines.push('');
    }

    if (summary.activeThreads.length > 0) {
      lines.push('### Active Threads');
      for (const thread of summary.activeThreads) {
        lines.push(`- ${thread}`);
      }
      lines.push('');
    }

    lines.push(`_Scene count: ${summary.sceneCount}_`);

    return lines.join('\n');
  }

  // ─── Private Helpers ────────────────────────────────────────────────────

  private _deriveVolumeId(chapterMetadata: ChapterMeta[]): string {
    if (chapterMetadata.length === 0) return 'volume-1';

    const first = chapterMetadata[0].chapter;
    const last = chapterMetadata[chapterMetadata.length - 1].chapter;
    return `chapters-${first}-to-${last}`;
  }

  private _extractActiveThreads(sceneSummaries: string[]): string[] {
    const threadSet = new Set<string>();

    for (const summary of sceneSummaries) {
      for (const line of summary.split('\n')) {
        const trimmed = line.trim();

        // Lines starting with "Thread:" name a thread.
        if (trimmed.startsWith('Thread:')) {
          const name = trimmed.slice(7).trim();
          if (name) threadSet.add(name);
          continue;
        }

        // Lines mentioning "unresolved" and "thread" are heuristic markers.
        if (
          /\bunresolved\b/i.test(trimmed) &&
          /\bthread\b/i.test(trimmed)
        ) {
          // Try to extract a thread name after "thread:" or before ":"
          const match = trimmed.match(/thread[:\s]+([^,.]+)/i);
          if (match) {
            threadSet.add(match[1].trim());
          }
        }
      }
    }

    return [...threadSet].sort();
  }

  private _buildCharacterTrajectory(
    sceneSummaries: string[],
  ): Map<string, string> {
    const trajectory = new Map<string, string>();

    // Process in reverse so the most recent description wins.
    for (let i = sceneSummaries.length - 1; i >= 0; i--) {
      const summary = sceneSummaries[i];
      for (const line of summary.split('\n')) {
        const trimmed = line.trim();
        // Lines matching "<entityId>: <state>" describe character state.
        const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*):\s(.+)$/);
        if (match) {
          const entityId = match[1];
          const state = match[2].trim();
          // Only set if not already recorded (reverse order = first win
          // is most recent).
          if (!trajectory.has(entityId)) {
            trajectory.set(entityId, state);
          }
        }
      }
    }

    return trajectory;
  }
}
