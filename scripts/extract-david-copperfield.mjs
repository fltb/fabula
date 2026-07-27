#!/usr/bin/env node
// ============================================================================
// extract-david-copperfield.mjs — Extract 64 chapters from Gutenberg text
//
// Usage: node scripts/extract-david-copperfield.mjs
//
// Steps:
// 1. Read cached file, NFC normalize, LF line endings
// 2. Split into lines, find chapter markers
// 3. Extract 64 chapters
// 4. Write source.txt with byte-offset ChapterLocation[] tracking during join
// 5. Write source-manifest.json
// 6. Run 8 gate checks
// ============================================================================

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const CORPUS_DIR = join(REPO_ROOT, 'bench-data', 'corpus', 'david-copperfield');
const CACHE_FILE = join(
  REPO_ROOT,
  'bench-data',
  'corpus',
  '.cache',
  'david_copperfield_gutenberg.txt',
);
const OUTPUT_FILE = join(CORPUS_DIR, 'source.txt');
const MANIFEST_FILE = join(CORPUS_DIR, 'source-manifest.json');
const SOURCE_URL = 'https://www.gutenberg.org/ebooks/766.txt.utf-8';
const CHAPTER_COUNT = 64;

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

// ── 1. Read & normalize ──────────────────────────────────────────────────
console.log('=== Step 1: Read & normalize ===');
if (!existsSync(CACHE_FILE)) {
  console.error(`FATAL: Cache file not found: ${CACHE_FILE}`);
  process.exit(1);
}

const rawText = readFileSync(CACHE_FILE, 'utf-8');
let text = rawText.normalize('NFC');
text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
const lines = text.split('\n');
console.log(`  Lines: ${lines.length}`);
console.log(`  Bytes: ${Buffer.byteLength(text, 'utf-8')}`);

// ── 2. Find chapter markers ──────────────────────────────────────────────
console.log('\n=== Step 2: Find chapter markers ===');
const chapterHeaderRe = /^CHAPTER \d+\./;
const headerLineIdxs = [];
for (let i = 0; i < lines.length; i++) {
  if (chapterHeaderRe.test(lines[i])) {
    headerLineIdxs.push(i);
  }
}
console.log(`  Found ${headerLineIdxs.length} chapter headers`);
if (headerLineIdxs.length !== CHAPTER_COUNT) {
  console.error(`FATAL: Expected ${CHAPTER_COUNT} chapters, found ${headerLineIdxs.length}`);
  process.exit(1);
}

// Print first and last headers for verification
const printHeaders = (idxs) => {
  for (let i = 0; i < Math.min(3, idxs.length); i++) {
    console.log(`    ch${String(i + 1).padStart(2, '0')}: line ${idxs[i]} — ${lines[idxs[i]]}`);
  }
  if (idxs.length > 6) {
    console.log('    ...');
  }
  for (let i = Math.max(3, idxs.length - 3); i < idxs.length; i++) {
    console.log(`    ch${String(i + 1).padStart(2, '0')}: line ${idxs[i]} — ${lines[idxs[i]]}`);
  }
};
printHeaders(headerLineIdxs);

// ── 3. Extract chapter texts ─────────────────────────────────────────────
console.log('\n=== Step 3: Extract chapters ===');
const chapters = [];
for (let i = 0; i < headerLineIdxs.length; i++) {
  const startLine = headerLineIdxs[i];
  const endLine = i + 1 < headerLineIdxs.length ? headerLineIdxs[i + 1] : lines.length;
  const chLines = lines.slice(startLine, endLine);
  const chText = chLines.join('\n');
  const chTitle = lines[startLine];
  chapters.push({ text: chText, title: chTitle });
  if (i < 3 || i >= headerLineIdxs.length - 3) {
    console.log(
      `  ch${String(i + 1).padStart(2, '0')}: ${chTitle} — ${chText.length} chars, ${Buffer.byteLength(chText, 'utf-8')} bytes`,
    );
  } else if (i === 3) {
    console.log('  ...');
  }
}
console.log(`  Total chapters extracted: ${chapters.length}`);

// ── 4. Write source.txt with byte-offset tracking during join ────────────
console.log('\n=== Step 4: Write source.txt ===');
mkdirSync(CORPUS_DIR, { recursive: true });

const SEP = '\n\n';
const SEP_BYTES = Buffer.byteLength(SEP, 'utf-8'); // 2

const chapterLocations = [];
let currentPos = 0;
const textParts = [];

for (let i = 0; i < chapters.length; i++) {
  const chText = chapters[i].text;
  const chBytes = Buffer.byteLength(chText, 'utf-8');

  if (i > 0) {
    // Append separator
    textParts.push(SEP);
    currentPos += SEP_BYTES;
  }

  const startByte = currentPos;
  textParts.push(chText);
  currentPos += chBytes;
  const endByte = currentPos;

  // Word count: English content words
  const words = chText.split(/\s+/).filter((w) => /[a-zA-Z]+/.test(w));
  const wordCount = words.length;

  const chapterId = `ch${String(i + 1).padStart(2, '0')}`;
  chapterLocations.push({ chapterId, startByte, endByte, wordCount, title: chText.split('\n')[0] });
}

const fullText = textParts.join('');
writeFileSync(OUTPUT_FILE, fullText, 'utf-8');
const sourceHash = sha256(fullText);
const fileSize = Buffer.byteLength(fullText, 'utf-8');

console.log(`  Written: ${OUTPUT_FILE}`);
console.log(`  Size: ${fileSize} bytes`);
console.log(`  SHA-256: ${sourceHash}`);

// Verify last endByte matches file size
const lastEndByte = chapterLocations[chapterLocations.length - 1].endByte;
console.log(`  Last endByte: ${lastEndByte}`);
console.log(`  File size: ${fileSize}`);
console.log(`  Match: ${lastEndByte === fileSize}`);

// ── 5. Build source-manifest.json ────────────────────────────────────────
console.log('\n=== Step 5: Write source-manifest.json ===');

const manifest = {
  workId: 'david-copperfield',
  editionId: 'gutenberg-766',
  language: 'en',
  legalMode: 'public_domain',
  jurisdiction: 'US',
  sourceUrl: SOURCE_URL,
  downloadDate: '2026-07-22',
  sourceHash,
  cleaningVersion: '1.0.0',
  adapterVersion: '1.0.0',
  schemaVersion: '1.0.0',
  legalReviewDate: '2026-07-22',
  chapters: chapterLocations,
};

writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2), 'utf-8');
console.log(`  Written: ${MANIFEST_FILE}`);

// ── 6. Gate checks ──────────────────────────────────────────────────────
console.log('\n=== Step 6: Gate checks ===');

let allPass = true;
const results = [];

// Gate 1: workId matches
const g1 = manifest.workId === 'david-copperfield';
results.push({ gate: 'workId matches', pass: g1, detail: manifest.workId });
allPass &&= g1;

// Gate 2: language === 'en'
const g2 = manifest.language === 'en';
results.push({ gate: 'language = en', pass: g2, detail: manifest.language });
allPass &&= g2;

// Gate 3: public_domain
const g3 = manifest.legalMode === 'public_domain';
results.push({ gate: 'legalMode = public_domain', pass: g3, detail: manifest.legalMode });
allPass &&= g3;

// Gate 4: chapters === 64
const g4 = manifest.chapters.length === CHAPTER_COUNT;
results.push({
  gate: `chapters = ${CHAPTER_COUNT}`,
  pass: g4,
  detail: String(manifest.chapters.length),
});
allPass &&= g4;

// Gate 5: monotonic byte offsets
let g5 = true;
for (let i = 0; i < chapterLocations.length; i++) {
  const c = chapterLocations[i];
  if (
    c.startByte < 0 ||
    c.endByte <= c.startByte ||
    (i > 0 && c.startByte !== chapterLocations[i - 1].endByte + SEP_BYTES)
  ) {
    // Allow first chapter startByte === 0
    if (i === 0 && c.startByte === 0) continue;
    g5 = false;
    break;
  }
}
// Simpler check: startByte >= 0, endByte > startByte, and endByte <= fileSize
g5 = chapterLocations.every((c, i) => {
  if (c.startByte < 0 || c.endByte <= c.startByte || c.endByte > fileSize) return false;
  if (i > 0 && c.startByte !== chapterLocations[i - 1].endByte + SEP_BYTES) return false;
  return true;
});
results.push({
  gate: 'monotonic byte offsets',
  pass: g5,
  detail: `startBytes: [${chapterLocations[0].startByte}..${chapterLocations[CHAPTER_COUNT - 1].startByte}]`,
});
allPass &&= g5;

// Gate 6: all wordCount > 0
const g6 = chapterLocations.every((c) => c.wordCount > 0);
const zeroWords = chapterLocations.filter((c) => c.wordCount === 0).map((c) => c.chapterId);
results.push({
  gate: 'all wordCount > 0',
  pass: g6,
  detail: zeroWords.length > 0 ? `zero: ${zeroWords.join(',')}` : 'ok',
});
allPass &&= g6;

// Gate 7: hash matches
const reRead = readFileSync(OUTPUT_FILE, 'utf-8');
const g7 = sha256(reRead) === sourceHash;
results.push({ gate: 'hash matches file', pass: g7, detail: sourceHash.substring(0, 16) + '...' });
allPass &&= g7;

// Gate 8: total wordCount > 100000
const totalWords = chapterLocations.reduce((s, c) => s + c.wordCount, 0);
const g8 = totalWords > 100000;
results.push({ gate: 'total wordCount > 100000', pass: g8, detail: String(totalWords) });
allPass &&= g8;

// Print results
for (const r of results) {
  const icon = r.pass ? 'PASS' : 'FAIL';
  console.log(`  ${icon}: ${r.gate} — ${r.detail}`);
}

console.log(`\n  ${results.filter((r) => r.pass).length}/${results.length} gates passed`);
if (allPass) {
  console.log('\n  All 8 gates PASS');
} else {
  console.error('\n  Some gates FAILED — see above');
  process.exit(1);
}
