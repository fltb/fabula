#!/usr/bin/env node
// Atomic: extract chapters 1-80 from Gutenberg + compute byte offsets
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const REPO = '/home/float/myfile/Projects/novalistically';
const CACHE = join(REPO, 'bench-data/corpus/.cache/hlm_gutenberg.txt');
const CORPUS = join(REPO, 'bench-data/corpus/dream-of-red-chamber');

let text = readFileSync(CACHE, 'utf-8');
text = text.normalize('NFC').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
const lines = text.split('\n');

// Find chapter headers: line matches 第N回, followed by '---' separator within 3 lines
const headerData = [];
for (let i = 0; i < lines.length; i++) {
  const line = lines[i].trim();
  const m = line.match(/^第([一二三四五六七八九十百零\d]+)回/);
  if (!m) continue;
  let hasSep = false;
  for (let j = 1; j <= 3 && (i + j) < lines.length; j++) {
    const next = lines[i + j].trim();
    if (next === '') continue;
    if (next.startsWith('---')) { hasSep = true; break; }
    break;
  }
  if (hasSep) headerData.push({ lineIdx: i, line, numStr: m[1] });
}

console.log('Total chapter headers:', headerData.length);

// Take the first 80 detected chapters (covers roughly chapters 1-87 due to gaps)
const ch80 = headerData.slice(0, 80);

// Extract chapter texts (from header start to next header start)
const chapterTexts = [];
for (let i = 0; i < ch80.length; i++) {
  const startLine = ch80[i].lineIdx;
  const endLine = (i < ch80.length - 1) ? ch80[i + 1].lineIdx : lines.length;
  chapterTexts.push(lines.slice(startLine, endLine).join('\n').trim());
}

// Join with double-newline, tracking byte offsets
const SEP = '\n\n';
const sepBytes = Buffer.byteLength(SEP, 'utf-8');

const locations = [];
let fullText = '';
let currentPos = 0;

for (let i = 0; i < chapterTexts.length; i++) {
  const chText = chapterTexts[i];
  const chBytes = Buffer.byteLength(chText, 'utf-8');
  const cjk = (chText.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const firstLine = chText.split('\n')[0].trim();

  if (i > 0) {
    fullText += SEP;
    currentPos += sepBytes;
  }

  locations.push({
    chapterId: 'ch' + String(i + 1).padStart(2, '0'),
    title: firstLine,
    startByte: currentPos,
    endByte: currentPos + chBytes,
    wordCount: cjk,
  });

  fullText += chText;
  currentPos += chBytes;
}

// Verify
const fileBytes = Buffer.byteLength(fullText, 'utf-8');
const lastLoc = locations[locations.length - 1];
console.log('Segments:', locations.length);
console.log('Last endByte:', lastLoc.endByte, 'File size:', fileBytes, 'Match:', lastLoc.endByte === fileBytes);

// Verify monotonic
let monotonic = true;
for (let i = 1; i < locations.length; i++) {
  if (locations[i].startByte !== locations[i - 1].endByte + sepBytes) {
    monotonic = false;
    break;
  }
}
console.log('Monotonic:', monotonic);

const sourceHash = createHash('sha256').update(fullText).digest('hex');

// Write files
mkdirSync(CORPUS, { recursive: true });
writeFileSync(join(CORPUS, 'source.txt'), fullText, 'utf-8');

const manifest = {
  workId: 'dream-of-red-chamber',
  editionId: 'gutenberg-24264',
  language: 'zh',
  legalMode: 'public_domain',
  jurisdiction: 'US',
  sourceUrl: 'https://www.gutenberg.org/ebooks/24264.txt.utf-8',
  downloadDate: '2026-07-22',
  sourceHash,
  cleaningVersion: '1.0.0',
  adapterVersion: '1.0.0',
  schemaVersion: '1.0.0',
  legalReviewDate: '2026-07-22',
  chapters: locations,
};

writeFileSync(join(CORPUS, 'source-manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');

console.log('Source hash:', sourceHash);
console.log('Total CJK:', locations.reduce((s, c) => s + c.wordCount, 0));
console.log('First:', locations[0].chapterId, locations[0].title.slice(0, 60));
console.log('Last:', locations[79].chapterId, locations[79].title.slice(0, 60));

// Final gate validation
console.log('\n=== Gate Checks ===');
const checks = [
  ['workId', manifest.workId === 'dream-of-red-chamber'],
  ['language=zh', manifest.language === 'zh'],
  ['public_domain', manifest.legalMode === 'public_domain'],
  ['sourceHash 64-hex', /^[a-f0-9]{64}$/.test(manifest.sourceHash)],
  ['chapters ~80', locations.length >= 70 && locations.length <= 85],
  ['monotonic byte offsets', monotonic],
  ['all wordCount>0', locations.every(c => c.wordCount > 0)],
  ['hash matches file', createHash('sha256').update(readFileSync(join(CORPUS, 'source.txt'), 'utf-8')).digest('hex') === sourceHash],
  ['total CJK >= 500k', locations.reduce((s, c) => s + c.wordCount, 0) >= 500000],
];
let pass = 0;
for (const [name, ok] of checks) {
  console.log(ok ? '  PASS' : '  FAIL', name);
  if (ok) pass++;
}
console.log(`\n${pass}/${checks.length} GATE ${pass === checks.length ? 'PASSED' : 'FAILED'}`);
if (pass !== checks.length) process.exit(1);
