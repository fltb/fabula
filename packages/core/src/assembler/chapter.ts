import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ChapterMetadata } from '../types/index.js';

// ────────────────────────────────────────────────────────────────────────────
// Chapter Metadata Loader
// ────────────────────────────────────────────────────────────────────────────

/**
 * Load chapter metadata from the `chapters/chapter_NN/_chapter.yaml` files.
 */
export function loadChapterMetadata(
  projectDir: string,
): Map<number, ChapterMetadata> {
  const map = new Map<number, ChapterMetadata>();
  const chaptersDir = path.join(projectDir, 'chapters');

  if (!fs.existsSync(chaptersDir)) {
    console.warn(`[Assembler] Chapters directory not found: ${chaptersDir}`);
    return map;
  }

  const dirs = fs
    .readdirSync(chaptersDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^chapter_\d+/i.test(e.name))
    .map((e) => path.join(chaptersDir, e.name))
    .sort();

  for (const dir of dirs) {
    const metaPath = path.join(dir, '_chapter.yaml');
    if (!fs.existsSync(metaPath)) continue;

    try {
      const raw = fs.readFileSync(metaPath, 'utf-8');
      const parsed = parseYaml(raw) as Record<string, unknown>;

      const metadata: ChapterMetadata = {
        chapter: parsed.chapter as number,
        title: (parsed.title as string) ?? '',
        summary: (parsed.summary as string) ?? '',
        intent: (parsed.intent as string) ?? '',
        plannedScenes:
          ((parsed.planned_scenes ?? parsed.plannedScenes) as number) ?? 0,
        ...(parsed.style_guidance
          ? { styleGuidance: parsed.style_guidance as ChapterMetadata['styleGuidance'] }
          : {}),
      };

      map.set(metadata.chapter, metadata);
    } catch (err) {
      console.warn(
        `[Assembler] Error reading chapter metadata ${metaPath}: ` +
        `${(err as Error).message}`,
      );
    }
  }

  return map;
}
