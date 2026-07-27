import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { logger } from '../observability/logger.ts';
import { FsStorage, type Storage } from '../storage/index.ts';
import type { ChapterMetadata } from '../types/index.js';

// ────────────────────────────────────────────────────────────────────────────
// Chapter Metadata Loader
// ────────────────────────────────────────────────────────────────────────────

/**
 * Load chapter metadata from the `chapters/chapter_NN/_chapter.yaml` files.
 */
export function loadChapterMetadata(
  projectDir: string,
  storage?: Storage,
): Map<number, ChapterMetadata> {
  const st = storage ?? new FsStorage();
  const map = new Map<number, ChapterMetadata>();
  const chaptersDir = path.join(projectDir, 'chapters');

  if (!st.exists(chaptersDir)) {
    logger.warn('Chapter metadata directory not found', { module: 'assembler', path: chaptersDir });
    return map;
  }

  const dirs = st
    .list(chaptersDir)
    .filter((e) => e.isDirectory() && /^chapter_\d+/i.test(e.name))
    .map((e) => path.join(chaptersDir, e.name))
    .sort();

  for (const dir of dirs) {
    const metaPath = path.join(dir, '_chapter.yaml');
    if (!st.exists(metaPath)) continue;

    try {
      const raw = st.read(metaPath);
      const parsed = parseYaml(raw) as Record<string, unknown>;

      const metadata: ChapterMetadata = {
        chapter: parsed.chapter as number,
        title: (parsed.title as string) ?? '',
        summary: (parsed.summary as string) ?? '',
        intent: (parsed.intent as string) ?? '',
        plannedScenes: ((parsed.planned_scenes ?? parsed.plannedScenes) as number) ?? 0,
        ...(parsed.style_guidance
          ? { styleGuidance: parsed.style_guidance as ChapterMetadata['styleGuidance'] }
          : {}),
      };

      map.set(metadata.chapter, metadata);
    } catch {
      logger.warn('Chapter metadata could not be read', { module: 'assembler', path: metaPath });
    }
  }

  return map;
}
