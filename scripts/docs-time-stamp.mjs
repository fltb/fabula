#!/usr/bin/env node
// Strict docs time-stamping. Run from repo root.
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SKIP_RENAME = new Set([
  'docs/handoffs/2026-07-27-drc-stress-session.md', // already has date prefix
  'docs/report/game-dialogue-tree-plan-and-verification-2026-07-28.md', // today's untracked
  'docs/report/wiring-remediation-verification-2026-07-27.md', // already has date suffix
]);

function gitLogDate(path) {
  try {
    const iso = execSync(`git log -1 --format=%ai -- ${path}`, { encoding: 'utf8' }).trim();
    if (!iso) return null;
    // Format: 2026-07-27 14:19:18 +0800
    const m = iso.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}):\d{2} ([+-]\d{4})/);
    if (!m) return null;
    const tzHours = parseInt(m[3].slice(1, 3), 10);
    const tzSign = m[3][0] === '-' ? -1 : 1;
    let hh = parseInt(m[2].slice(0, 2), 10);
    let mm = parseInt(m[2].slice(3, 5), 10);
    if (tzHours !== 8 || tzSign !== 1) {
      // Convert to CST
      const offset =
        tzSign * (parseInt(m[3].slice(1, 3), 10) * 60 + parseInt(m[3].slice(3, 5), 10));
      const cstOffset = 8 * 60;
      const delta = cstOffset - offset;
      const total = hh * 60 + mm + delta;
      const t = ((total % 1440) + 1440) % 1440;
      hh = Math.floor(t / 60);
      mm = t % 60;
    }
    return {
      date: m[1],
      time: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`,
      line: `> **时间**: ${m[1]} ${hh}:${String(mm).padStart(2, '0')} CST`,
    };
  } catch {
    return null;
  }
}

function mtimeInfo(path) {
  const m = statSync(path);
  const d = new Date(m.mtimeMs);
  // Best-effort CST display
  const fmt = (n) => String(n).padStart(2, '0');
  return {
    date: `${d.getUTCFullYear()}-${fmt(d.getUTCMonth() + 1)}-${fmt(d.getUTCDate())}`,
    time: `${fmt(d.getUTCHours())}:${fmt(d.getUTCMinutes())}`,
    line: `> **时间**: ${d.getUTCFullYear()}-${fmt(d.getUTCMonth() + 1)}-${fmt(d.getUTCDate())} ${fmt(d.getUTCHours())}:${fmt(d.getUTCMinutes())} CST`,
  };
}

function listFiles() {
  const roots = ['docs/report', 'docs/audits', 'docs/todos', 'docs/handoffs', 'docs/decisions'];
  const out = [];
  for (const root of roots) {
    try {
      const ls = execSync(`ls -1 ${root}`, { encoding: 'utf8' });
      for (const f of ls.split('\n').filter(Boolean)) out.push(`${root}/${f}`);
    } catch {}
  }
  return out;
}

function ensureHeader(path, timeLine) {
  const original = readFileSync(path, 'utf8');
  const lines = original.split('\n');
  // Find first H1.
  const h1Idx = lines.findIndex((l) => /^#\s/.test(l));
  // Find first matching existing time-line, in any common form.
  const timeRe =
    /^(\s*)(>+\s*)?(\*\*?)(?:时间|Time|Date|日期|TIME|DATE|DATE)\1?(?:[:：]\s*)(.+?)\*?$/;
  let existingIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 12); i++) {
    if (timeRe.test(lines[i])) {
      existingIdx = i;
      break;
    }
  }
  let next = lines;
  if (existingIdx >= 0) {
    // Replace the time-line with the canonical line.
    next = [...lines];
    next[existingIdx] = timeLine;
  } else {
    // Insert after H1 (or at top).
    const insertAt = h1Idx >= 0 ? h1Idx + 1 : 0;
    next = [...lines.slice(0, insertAt), '', timeLine, ...lines.slice(insertAt)];
  }
  const updated = next.join('\n');
  if (updated !== original) {
    writeFileSync(path, updated);
    return true;
  }
  return false;
}

function renameFile(oldPath, newPath) {
  if (oldPath === newPath) return false;
  if (!existsSync(newPath)) {
    try {
      execSync(`git mv ${oldPath} ${newPath}`);
      return true;
    } catch {
      renameSync(oldPath, newPath);
      return true;
    }
  }
  return false;
}

const files = listFiles();
let renamedCount = 0;
let updatedCount = 0;
const plan = [];

for (const f of files) {
  let info = SKIP_RENAME.has(f) ? null : gitLogDate(f);
  if (!info) {
    if (existsSync(f)) info = mtimeInfo(f);
  }
  if (!info) continue;

  let newPath = f;
  if (!SKIP_RENAME.has(f)) {
    const date = info.date;
    const name = f.split('/').pop();
    const base = name.replace(/\.md$/, '');
    if (!new RegExp(`-${date}(\\.md)?$`).test(name) && !name.startsWith(`${date}-`)) {
      newPath = `${f.split('/').slice(0, -1).join('/')}/${base}-${date}.md`;
    }
  }
  plan.push({ oldPath: f, newPath, timeLine: info.line, info });
  if (newPath !== f) {
    if (renameFile(f, newPath)) renamedCount++;
  }
}

for (const { newPath, timeLine } of plan) {
  if (existsSync(newPath)) {
    if (ensureHeader(newPath, timeLine)) updatedCount++;
  }
}

console.log(
  JSON.stringify(
    {
      renamedCount,
      updatedCount,
      plan: plan.map(({ oldPath, newPath }) => ({ oldPath, newPath })),
    },
    null,
    2,
  ),
);
