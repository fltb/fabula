#!/usr/bin/env node

// ============================================================================
// acquire-dream-of-red-chamber.mjs — Download & process 红楼梦 前80回
//
// Usage: node scripts/acquire-dream-of-red-chamber.mjs
//
// Steps:
// 1. Download from Project Gutenberg (or use cached file)
// 2. Extract chapters 1-80
// 3. Unicode NFC normalize
// 4. Compute byte-offset chapter locations
// 5. Write source.txt + source-manifest.json
// 6. Run gate validation
// ============================================================================

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const CORPUS_DIR = join(REPO_ROOT, 'bench-data', 'corpus', 'dream-of-red-chamber');
const SOURCE_URL = 'https://www.gutenberg.org/ebooks/24264.txt.utf-8';
const CACHE_FILE = join(REPO_ROOT, 'bench-data', 'corpus', '.cache', 'hlm_gutenberg.txt');
const OUTPUT_FILE = join(CORPUS_DIR, 'source.txt');
const MANIFEST_FILE = join(CORPUS_DIR, 'source-manifest.json');

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

// ── 1. Download ──────────────────────────────────────────────────────────
console.log('=== Step 1: Download ===');
mkdirSync(dirname(CACHE_FILE), { recursive: true });

let rawText;
if (existsSync(CACHE_FILE)) {
  console.log(`  Using cached: ${CACHE_FILE}`);
  rawText = readFileSync(CACHE_FILE, 'utf-8');
} else {
  console.log(`  Downloading from: ${SOURCE_URL}`);
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  rawText = await res.text();
  writeFileSync(CACHE_FILE, rawText, 'utf-8');
  console.log(`  Cached to: ${CACHE_FILE} (${rawText.length} bytes)`);
}

// ── 2. Unicode NFC normalize, LF line endings ───────────────────────────
console.log('\n=== Step 2: Normalize ===');
let text = rawText.normalize('NFC');
text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
console.log(`  Normalized: ${text.length} bytes`);

// ── 3. Extract chapters 1-80 ─────────────────────────────────────────────
console.log('\n=== Step 3: Chapter split ===');

// Chinese numeral parser for chapter numbers
// Supports traditional form (十一=11, 二十=20, 九十九=99) and digit form (一零零=100, 一一五=115)
function parseChapterNum(chineseNum) {
  const d = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const numStr = chineseNum.match(/[一二三四五六七八九十百零]+/)[0];

  // Digit form: every char is a decimal digit; used for chapters 100+
  const allAreDigits = [...numStr].every((ch) => ch in d);
  if (allAreDigits && numStr.length >= 3) {
    let n = 0;
    for (const ch of numStr) n = n * 10 + d[ch];
    return n;
  }

  // Traditional Chinese positional form (1-99)
  let total = 0,
    acc = 0;
  for (const ch of numStr) {
    if (ch === '百') {
      acc = acc === 0 ? 100 : acc * 100;
    } else if (ch === '十') {
      acc = acc === 0 ? 10 : acc * 10;
    } else {
      if (acc > 0) {
        total += acc;
        acc = 0;
      }
      acc = d[ch];
    }
  }
  return total + acc;
}

// Match chapter headers: require same-line whitespace/fullwidth-space or EOL after 回
// This rejects false positives like "第四回中..." and "第二回了...".
// NOTE: \n must NOT be in the separator class — it would swallow the next line
// and break raw-offset header validation (title must be a literal source slice).
const chapterHeaderRe = /^第[一二三四五六七八九十百零\d]+回(?:[　 \t][^\n]*)?$/gm;
const allMatches = [...text.matchAll(chapterHeaderRe)];
console.log(`  Found ${allMatches.length} chapter headers (raw regex)`);

// Filter to chapters 1-80, deduplicate by chapter number (keep first occurrence)
const selected = [];
const seenNums = new Set();
for (const m of allMatches) {
  const num = parseChapterNum(m[0]);
  if (num >= 1 && num <= 80 && !seenNums.has(num)) {
    seenNums.add(num);
    selected.push({ num, match: m });
  }
}
selected.sort((a, b) => a.match.index - b.match.index);

if (selected.length !== 80) {
  throw new Error(
    `FAIL: expected 80 chapter headers for 1-80, found ${selected.length}. ` +
      `Check regex against Gutenberg source.`,
  );
}
console.log(`  Selected chapters 1-80 (deduplicated): ${selected.length}`);

// Collect ALL heading positions (including chapters 81-120) for range boundary calculation
const allPositions = allMatches
  .map((m) => ({
    num: parseChapterNum(m[0]),
    index: m.index,
  }))
  .sort((a, b) => a.index - b.index);

// Build chapter text: from each header to the next heading with a different chapter number
const chapters = [];
for (let i = 0; i < selected.length; i++) {
  const { num, match } = selected[i];
  const startPos = match.index;

  // End at the next heading whose chapter number differs (skipping duplicate headings)
  const nextDiff = allPositions.find((p) => p.index > startPos && p.num !== num);
  const endPos = nextDiff ? nextDiff.index : text.length;

  const chapterTitle = match[0].replace(/\n/g, ' ').trim();
  const chapterText = text.slice(startPos, endPos).trim();

  chapters.push({
    num,
    title: chapterTitle,
    text: chapterText,
    startPos,
    endPos,
  });
  console.log(
    `  Ch ${String(num).padStart(2)}: "${chapterTitle.slice(0, 40)}..." (${chapterText.length} chars)`,
  );
}

// ── Invariant validation before writing ──────────────────────────────────────
console.log('\n=== Invariant validation ===');
const MIN_CJK = 500;

if (chapters.length !== 80) {
  throw new Error(`FAIL: expected 80 chapters, got ${chapters.length}`);
}

for (let i = 0; i < chapters.length; i++) {
  const c = chapters[i];
  const expectedNum = i + 1;

  // 1. Exactly chapters 1-80, each once, in ascending order
  if (c.num !== expectedNum) {
    throw new Error(
      `FAIL: ordering at index ${i}: expected ch${expectedNum}, got ch${c.num} (byte ${c.startPos})`,
    );
  }

  // 2. Ranges strictly ascending, non-overlapping
  if (i > 0 && c.startPos < chapters[i - 1].endPos) {
    throw new Error(
      `FAIL: overlap ch${c.num}: start=${c.startPos} < ch${chapters[i - 1].num} end=${chapters[i - 1].endPos}`,
    );
  }
  if (c.endPos <= c.startPos) {
    throw new Error(`FAIL: empty range ch${c.num}: start=${c.startPos}, end=${c.endPos}`);
  }

  // 3. Header text matches source at claimed offset
  const headerInSrc = text.slice(c.startPos, c.startPos + c.title.length);
  if (headerInSrc !== c.title) {
    throw new Error(`FAIL: header mismatch ch${c.num}: source at ${c.startPos} != "${c.title}"`);
  }

  // 4. Minimum CJK content (reject false chapters)
  const cjkCount = (c.text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  if (cjkCount < MIN_CJK) {
    throw new Error(`FAIL: ch${c.num} has only ${cjkCount} CJK chars (min ${MIN_CJK})`);
  }
}

console.log(`  All ${chapters.length} chapters pass invariant checks`);

// ── 4. Write source.txt ──────────────────────────────────────────────────
console.log('\n=== Step 4: Write source.txt ===');
mkdirSync(CORPUS_DIR, { recursive: true });

const fullText = chapters.map((c) => c.text).join('\n\n');
writeFileSync(OUTPUT_FILE, fullText, 'utf-8');
const sourceHash = sha256(fullText);
console.log(`  Written: ${OUTPUT_FILE}`);
console.log(`  Size: ${fullText.length} bytes`);
console.log(`  SHA-256: ${sourceHash}`);

// ── 5. Build ChapterLocation[] ──────────────────────────────────────────
console.log('\n=== Step 5: Chapter locations ===');

const chapterLocations = [];
let currentByte = 0;

for (let i = 0; i < chapters.length; i++) {
  const chText = chapters[i].text;
  const byteLen = Buffer.byteLength(chText, 'utf-8');
  // CJK character count for wordCount (Chinese)
  const cjkCount = (chText.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;

  chapterLocations.push({
    chapterId: `ch${String(i + 1).padStart(2, '0')}`,
    title: chapters[i].title,
    startByte: currentByte,
    endByte: currentByte + byteLen,
    wordCount: cjkCount,
  });

  currentByte += byteLen + 2; // +2 for '\n\n' separator
}

// Verify the last endByte matches file size
const fileSize = Buffer.byteLength(fullText, 'utf-8');
console.log(`  Chapters: ${chapterLocations.length}`);
console.log(`  Last endByte: ${chapterLocations[chapterLocations.length - 1].endByte}`);
console.log(`  File size: ${fileSize}`);
console.log(`  Match: ${chapterLocations[chapterLocations.length - 1].endByte === fileSize}`);

// ── 6. Write source-manifest.json ────────────────────────────────────────
console.log('\n=== Step 6: Write source-manifest.json ===');

const manifest = {
  workId: 'dream-of-red-chamber',
  editionId: 'gutenberg-24264',
  language: 'zh',
  legalMode: 'public_domain',
  jurisdiction: 'US',
  sourceUrl: SOURCE_URL,
  downloadDate: new Date().toISOString().split('T')[0],
  sourceHash,
  cleaningVersion: '1.0.0',
  adapterVersion: '1.0.0',
  schemaVersion: '1.0.0',
  legalReviewDate: new Date().toISOString().split('T')[0],
  chapters: chapterLocations,
};

writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2), 'utf-8');
const manifestHash = sha256(JSON.stringify(manifest));
console.log(`  Written: ${MANIFEST_FILE}`);
console.log(`  SHA-256: ${manifestHash}`);

// ── Summary ──────────────────────────────────────────────────────────────
console.log('\n=== Summary ===');
console.log(`  Work:    ${manifest.workId}`);
console.log(`  Edition: ${manifest.editionId}`);
console.log(`  Chapters: ${chapters.length}`);
console.log(`  Total CJK chars: ${chapterLocations.reduce((s, c) => s + c.wordCount, 0)}`);
console.log(`  Source hash: ${sourceHash}`);

// ── 7. Run gate validation (if corpus-gate.ts is available) ──────────────
console.log('\n=== Step 7: Gate validation ===');
try {
  // Build and run
  execSync('npm run build', { cwd: REPO_ROOT, stdio: 'pipe' });
  console.log('  Build: OK');
} catch (e) {
  console.log('  Build: FAILED (gate validation skipped)');
  console.error(e.stderr?.toString().slice(0, 500));
}

// Run corpus tests to verify manifest integrity
try {
  const result = execSync(
    'npx vitest run --config vitest.config.ts packages/core/tests/state/corpus-index.test.ts 2>&1',
    { cwd: REPO_ROOT, timeout: 30000 },
  );
  console.log('  corpus-index test: PASS');
} catch (e) {
  console.log('  corpus-index test: FAILED');
  console.error(e.stderr?.toString().slice(0, 1000));
}

console.log('\nDone. Next: build WorkIndex with ChiNovelKE entities.');
