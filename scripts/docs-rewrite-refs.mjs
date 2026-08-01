#!/usr/bin/env node
// Rewrite old doc references to new dated filenames across the repo.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const RENAME_DATE = {
  'docs/report/drc-stress-report-final.md': '2026-07-27',
  'docs/report/drc-stress-report-run1.md': '2026-07-27',
  'docs/report/drc-stress-report-run2.md': '2026-07-27',
  'docs/report/drc-stress-stability-run2.md': '2026-07-27',
  'docs/report/expressiveness-audit.md': '2026-07-26',
  'docs/report/full-chain-wiring-acceptance.md': '2026-07-26',
  'docs/report/ir-completeness-and-fullchain-verification.md': '2026-07-26',
  'docs/report/stage-1-acceptance.md': '2026-07-21',
  'docs/report/stage-1.5-acceptance.md': '2026-07-22',
  'docs/report/stage-1.5v2-acceptance.md': '2026-07-22',
  'docs/report/stage-1.5v3-acceptance.md': '2026-07-24',
  'docs/report/stage-2-partial-acceptance.md': '2026-07-24',
  'docs/report/stage-3-audit.md': '2026-07-24',
  'docs/report/zhu-fu-original-fidelity.md': '2026-07-27',
  'docs/report/zhu-fu-original-fidelity-baseline-comparison.md': '2026-07-27',
  'docs/report/zhu-fu-original-fidelity-calibrated-comparison.md': '2026-07-27',
  'docs/report/zhu-fu-original-fidelity-comparison.md': '2026-07-27',
  'docs/audits/pass2-schema-template-audit.md': '2026-07-21',
  'docs/audits/project-walkthrough-audit.md': '2026-07-24',
  'docs/audits/project-walkthrough-audit.zh-CN.md': '2026-07-24',
  'docs/audits/stage-1.5-audit.md': '2026-07-22',
  'docs/audits/stage-1.5v2-audit.md': '2026-07-24',
  'docs/audits/stage-2-corpus-audit.md': '2026-07-24',
  'docs/audits/stage1-smoke-diagnosis.md': '2026-07-21',
  'docs/todos/annotation.md': '2026-07-24',
  'docs/todos/base-narratology.md': '2026-07-26',
  'docs/todos/corpus.md': '2026-07-22',
  'docs/todos/generation-pipeline.md': '2026-07-26',
  'docs/todos/modern-novel.md': '2026-07-26',
  'docs/todos/narrative-checklist.md': '2026-07-26',
  'docs/todos/planner.md': '2026-07-24',
  'docs/todos/stage-3.md': '2026-07-27',
  'docs/todos/thread-tracking.md': '2026-07-26',
  'docs/todos/upper-ir.md': '2026-07-26',
  'docs/todos/validator-bugs.md': '2026-07-26',
  'docs/handoffs/oh-my-pi.md': '2026-07-20',
  'docs/decisions/001-fact-dual-representation.md': '2026-07-18',
  'docs/decisions/002-dag-causal-edges.md': '2026-07-18',
  'docs/decisions/003-dynamic-analysis-blocks.md': '2026-07-18',
  'docs/decisions/004-ai-sdk-migration.md': '2026-07-18',
};

const DATED = (old) => {
  const date = RENAME_DATE[old];
  if (!date) return null;
  return old.replace(/\.md$/, `-${date}.md`);
};

const oldPaths = Object.keys(RENAME_DATE);
// Find all files in repo (excluding .git/, node_modules, dist) and update references.
const candidates = execSync('git ls-files | grep -E "\\.(md|mdx|json|yaml|yml|ts|mjs|js|sh)$"', {
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean);

// Build a fast lookup: which old paths appear in this file?
const fileToOlds = new Map();
for (const file of candidates) {
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const present = oldPaths.filter((old) => content.includes(old));
  if (present.length > 0) fileToOlds.set(file, present);
}

let changedFiles = 0;
let totalReplacements = 0;
for (const [file, olds] of fileToOlds) {
  let content = readFileSync(file, 'utf8');
  let local = 0;
  for (const old of olds) {
    const dated = DATED(old);
    if (!dated) continue;
    const escapedOld = old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escapedOld, 'g');
    const matches = content.match(re);
    if (matches) {
      content = content.replace(re, dated);
      local += matches.length;
    }
  }
  if (local > 0) {
    writeFileSync(file, content);
    changedFiles++;
    totalReplacements += local;
  }
}
console.log(JSON.stringify({ changedFiles, totalReplacements }));
