#!/usr/bin/env node
// ============================================================================
// Bridge: Raw InteractiveNovels3K (Arrow) → Adapter-compatible IN3KNovel format
// ============================================================================
//
// The real dataset (mrzjy/Chinese_interactive_novels_3k) contains:
//   book_title, book_author, book_tag[], book_intro, collect, popularity,
//   book_chapter[]:
//     chapter_title, content[]:
//       {content_tag: "dialog"|"narration"|"img", role: string, content: string}
//
// The adapter expects:
//   IN3KNovel: {novel_id, title, author, genre, chapters[]}
//   IN3KChapter: {novel_id, chapter_id, chapter_index, title, content,
//                 word_count, time_markers[], location_changes[],
//                 character_appearances: Record<string,number>}
//
// This script bridges the two: extracts time markers from text patterns,
// counts character appearances from dialogue roles, and estimates word counts.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tableFromIPC } from 'apache-arrow';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');

// ─── Time marker extraction ────────────────────────────────────────────────

const TIME_PATTERNS = [
  /第[一二三四五六七八九十百千万\d]+[章回节天年月日]/g,
  /[次当]日/g,
  /[早中晚]上/g,
  /[一俩两]?[个半]?[时辰小时月天年]/g,
  /[春夏秋冬][季天日]/g,
  /[昨今明]天/g,
  /片刻/g,
  /转眼/g,
  /不久[之后]/g,
  /过了[一会半晌儿]/g,
  /[清早凌晨午黄昏夜傍][晚晨后夜]/g,
  /半[夜晚]/g,
  /天亮/g,
  /天黑/g,
];

function extractTimeMarkers(text) {
  const markers = new Set();
  for (const pattern of TIME_PATTERNS) {
    const matches = text.match(pattern);
    if (matches) for (const m of matches) markers.add(m);
  }
  return [...markers].slice(0, 20); // limit per chapter
}

// ─── Location change detection ─────────────────────────────────────────────

const LOCATION_PATTERNS = [
  /[来到去了进出回到至]+[了]?[\u4e00-\u9fff]{1,8}(?:[殿阁楼堂院室厅房园村城镇市山岭河海湖岛寺庙观庵])/g,
  /[\u4e00-\u9fff]{1,6}(?:[殿阁楼堂院室厅房园村城镇市山岭河海湖岛寺庙观庵])[里中内外前后]/g,
];

function extractLocationChanges(text) {
  const changes = new Set();
  for (const pattern of LOCATION_PATTERNS) {
    const matches = text.match(pattern);
    if (matches) for (const m of matches) changes.add(m);
  }
  return [...changes].slice(0, 10);
}

// ─── Word count (Chinese characters) ────────────────────────────────────────

function countChineseWords(text) {
  return (text.match(/[\u4e00-\u9fff]/g) || []).length;
}

// ─── Main bridge ───────────────────────────────────────────────────────────

async function bridgeInteractiveNovels3K(
  arrowDir,
  outputDir,
  maxNovels = 50,
  maxChaptersPerNovel = 200,
) {
  const shard0 = path.join(arrowDir, 'data-00000-of-00002.arrow');
  const shard1 = path.join(arrowDir, 'data-00001-of-00002.arrow');

  if (!fs.existsSync(shard0)) {
    console.error('Arrow shard 0 not found at', shard0);
    process.exit(1);
  }

  const allNovels = [];
  let novelsProcessed = 0;
  let totalChapters = 0;
  let totalEvents = 0;

  for (const shardPath of [shard0, shard1]) {
    if (!fs.existsSync(shardPath)) continue;

    const buf = fs.readFileSync(shardPath);
    const table = tableFromIPC(buf);
    const numRows = table.numRows;
    console.error(`Reading shard: ${path.basename(shardPath)} (${numRows} rows)`);

    for (let i = 0; i < Math.min(numRows, maxNovels); i++) {
      const row = table.get(i).toJSON();
      const novelId = `in3k_${novelsProcessed}`;
      // Arrow Vectors remain as array-like objects after toJSON — use Array.from
      const bookChapters = Array.from(row.book_chapter || []);
      const chapters = [];

      for (let ci = 0; ci < Math.min(bookChapters.length, maxChaptersPerNovel); ci++) {
        const ch = bookChapters[ci];
        const contentItems = Array.from(ch.content || []);

        // Build full text
        const fullText = contentItems.map((c) => c.content || '').join('\n');
        const wordCount = countChineseWords(fullText);
        if (wordCount < 20) continue; // skip empty/tiny chapters

        // Count character appearances from dialogue roles
        const charApps = {};
        for (const item of contentItems) {
          if (item.content_tag === 'dialog' && item.role) {
            const role = item.role.trim();
            if (role && role.length <= 20) {
              charApps[role] = (charApps[role] || 0) + 1;
            }
          }
        }

        // Skip if text content field isn't available - use fullText as content
        const chapterContent = fullText;

        chapters.push({
          novel_id: novelId,
          chapter_id: `ch_${novelsProcessed}_${ci}`,
          chapter_index: ci,
          title: ch.chapter_title || `Chapter ${ci + 1}`,
          content: chapterContent,
          word_count: wordCount,
          time_markers: extractTimeMarkers(chapterContent),
          location_changes: extractLocationChanges(chapterContent),
          character_appearances: charApps,
        });

        totalChapters++;
        totalEvents += Math.max(1, extractTimeMarkers(chapterContent).length); // estimate converted events
      }

      if (chapters.length === 0) continue;

      allNovels.push({
        novel_id: novelId,
        title: row.book_title || `Unknown Novel ${novelsProcessed}`,
        author: row.book_author || 'Unknown',
        genre: (row.book_tag || ['未分类'])[0],
        chapters,
      });

      novelsProcessed++;
      if (novelsProcessed >= maxNovels) break;
    }
    if (novelsProcessed >= maxNovels) break;
  }

  // Save bridged data
  fs.mkdirSync(outputDir, { recursive: true });

  // Save in batches of 10 novels per file to avoid huge files
  const BATCH_SIZE = 10;
  for (let b = 0; b < allNovels.length; b += BATCH_SIZE) {
    const batch = allNovels.slice(b, b + BATCH_SIZE);
    const batchPath = path.join(outputDir, `bridged_batch_${Math.floor(b / BATCH_SIZE)}.json`);
    fs.writeFileSync(batchPath, JSON.stringify(batch, null, 2), 'utf-8');
  }

  // Save metadata
  fs.writeFileSync(
    path.join(outputDir, 'bridged_meta.json'),
    JSON.stringify(
      {
        totalNovels: allNovels.length,
        totalChapters,
        estimatedEvents: totalEvents,
        totalChineseChars: allNovels.reduce(
          (sum, n) => sum + n.chapters.reduce((cs, ch) => cs + ch.word_count, 0),
          0,
        ),
      },
      null,
      2,
    ),
  );

  console.log(
    `Bridged InteractiveNovels3K: ${allNovels.length} novels, ${totalChapters} chapters, ~${totalEvents} estimated events → ${outputDir}/`,
  );
}

// ─── Run ────────────────────────────────────────────────────────────────────

const arrowDir = path.join(ROOT, 'bench-data/interactive-novels-3k');
const outputDir = path.join(ROOT, 'bench-data/interactive-novels-3k/bridged');

bridgeInteractiveNovels3K(arrowDir, outputDir).catch((err) => {
  console.error('Bridge failed:', err);
  process.exit(1);
});
