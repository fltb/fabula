#!/usr/bin/env node
// Dedupe `> **时间**:` lines in docs (keep canonical git-committer time; drop older duplicate).
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const FILES = [
  ['docs/report/drc-stress-report-run1-2026-07-27.md', 'docs/report/drc-stress-report-run1.md'],
  ['docs/report/drc-stress-report-run2-2026-07-27.md', 'docs/report/drc-stress-report-run2.md'],
  ['docs/report/drc-stress-stability-run2-2026-07-27.md', 'docs/report/drc-stress-stability-run2.md'],
];

const canonicalFor = (oldPath) => {
  const iso = execSync(`git log -1 --format=%ai -- ${oldPath}`, { encoding: 'utf8' }).trim();
  const m = iso.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})/);
  return m ? `> **时间**: ${m[1]} ${m[2]}:${m[3]} CST` : null;
};

let changed = 0;
for (const [newPath, oldPath] of FILES) {
  const canonical = canonicalFor(oldPath);
  if (!canonical) continue;
  const expected = canonical.replace(/^>\s*\*\*时间\*\*:\s*/, '').trim();
  const original = readFileSync(newPath, 'utf8');
  const lines = original.split('\n');
  const newLines = [];
  let canonicalSeen = false;
  for (const line of lines) {
    const m = line.match(/^>\s*\*\*时间\*\*:\s*(.+?)\s*$/);
    if (m) {
      const dt = m[1].trim();
      if (!canonicalSeen && dt === expected) {
        newLines.push(canonical);
        canonicalSeen = true;
      }
      // drop other time lines
      continue;
    }
    newLines.push(line);
  }
  if (!canonicalSeen) {
    const h1Idx = newLines.findIndex((l) => /^#\s/.test(l));
    if (h1Idx >= 0) newLines.splice(h1Idx + 1, 0, '', canonical);
    else newLines.unshift(canonical);
  }
  const updated = newLines.join('\n');
  if (updated !== original) {
    writeFileSync(newPath, updated);
    changed++;
  }
}
console.log(JSON.stringify({ changed }));
