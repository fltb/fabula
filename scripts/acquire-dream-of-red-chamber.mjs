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

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

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

// Chapter markers in Gutenberg: "第N回" or "第NN回" or "第一二零回"
// The actual format: "第一回\t甄士隱..." or "第 一 回" with spaces
// Let's find all chapter headers
const chapterHeaderRe = /^第[一二三四五六七八九十百零\d]+回[\s　]*[^\n]*/gm;
const matches = [...text.matchAll(chapterHeaderRe)];

console.log(`  Found ${matches.length} chapter headers`);

// We want chapters 1-80 (indices 0-79)
const chapterHeaders = matches.slice(0, 80);
console.log(`  Using chapters 1-${chapterHeaders.length}`);

// Build chapter text: from each header to the next header (or end of text)
const chapters = [];
for (let i = 0; i < chapterHeaders.length; i++) {
  const match = chapterHeaders[i];
  const startPos = match.index;
  const nextMatch = chapterHeaders[i + 1];
  const endPos = nextMatch ? nextMatch.index : (i === chapterHeaders.length - 1 ? matches[80]?.index ?? text.length : text.length);

  const chapterTitle = match[0].replace(/\n/g, ' ').trim();
  const chapterNum = i + 1;
  const chapterText = text.slice(startPos, endPos).trim();

  chapters.push({
    num: chapterNum,
    title: chapterTitle,
    text: chapterText,
    startPos,
    endPos,
  });
  console.log(`  Ch ${String(chapterNum).padStart(2)}: "${chapterTitle.slice(0, 40)}..." (${chapterText.length} chars)`);
}

// ── 4. Write source.txt ──────────────────────────────────────────────────
console.log('\n=== Step 4: Write source.txt ===');
mkdirSync(CORPUS_DIR, { recursive: true });

const fullText = chapters.map(c => c.text).join('\n\n');
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
    { cwd: REPO_ROOT, timeout: 30000 }
  );
  console.log('  corpus-index test: PASS');
} catch (e) {
  console.log('  corpus-index test: FAILED');
  console.error(e.stderr?.toString().slice(0, 1000));
}

console.log('\nDone. Next: build WorkIndex with ChiNovelKE entities.');
