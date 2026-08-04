#!/usr/bin/env node
// Fix docs headers: restore original content from HEAD by old name, then re-insert one canonical 时间 line.
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const RENAMES = [
  ['docs/report/drc-stress-report-final.md', 'docs/report/drc-stress-report-final-2026-07-27.md'],
  ['docs/report/drc-stress-report-run1.md', 'docs/report/drc-stress-report-run1-2026-07-27.md'],
  ['docs/report/drc-stress-report-run2.md', 'docs/report/drc-stress-report-run2-2026-07-27.md'],
  [
    'docs/report/drc-stress-stability-run2.md',
    'docs/report/drc-stress-stability-run2-2026-07-27.md',
  ],
  ['docs/report/expressiveness-audit.md', 'docs/report/expressiveness-audit-2026-07-26.md'],
  [
    'docs/report/full-chain-wiring-acceptance.md',
    'docs/report/full-chain-wiring-acceptance-2026-07-26.md',
  ],
  [
    'docs/report/ir-completeness-and-fullchain-verification.md',
    'docs/report/ir-completeness-and-fullchain-verification-2026-07-26.md',
  ],
  ['docs/report/stage-1-acceptance.md', 'docs/report/stage-1-acceptance-2026-07-21.md'],
  ['docs/report/stage-1.5-acceptance.md', 'docs/report/stage-1.5-acceptance-2026-07-22.md'],
  ['docs/report/stage-1.5v2-acceptance.md', 'docs/report/stage-1.5v2-acceptance-2026-07-22.md'],
  ['docs/report/stage-1.5v3-acceptance.md', 'docs/report/stage-1.5v3-acceptance-2026-07-24.md'],
  [
    'docs/report/stage-2-partial-acceptance.md',
    'docs/report/stage-2-partial-acceptance-2026-07-24.md',
  ],
  ['docs/report/stage-3-audit.md', 'docs/report/stage-3-audit-2026-07-24.md'],
  ['docs/report/zhu-fu-original-fidelity.md', 'docs/report/zhu-fu-original-fidelity-2026-07-27.md'],
  [
    'docs/report/zhu-fu-original-fidelity-baseline-comparison.md',
    'docs/report/zhu-fu-original-fidelity-baseline-comparison-2026-07-27.md',
  ],
  [
    'docs/report/zhu-fu-original-fidelity-calibrated-comparison.md',
    'docs/report/zhu-fu-original-fidelity-calibrated-comparison-2026-07-27.md',
  ],
  [
    'docs/report/zhu-fu-original-fidelity-comparison.md',
    'docs/report/zhu-fu-original-fidelity-comparison-2026-07-27.md',
  ],
  [
    'docs/audits/pass2-schema-template-audit.md',
    'docs/audits/pass2-schema-template-audit-2026-07-21.md',
  ],
  [
    'docs/audits/project-walkthrough-audit.md',
    'docs/audits/project-walkthrough-audit-2026-07-24.md',
  ],
  [
    'docs/audits/project-walkthrough-audit.zh-CN.md',
    'docs/audits/project-walkthrough-audit.zh-CN-2026-07-24.md',
  ],
  ['docs/audits/stage-1.5-audit.md', 'docs/audits/stage-1.5-audit-2026-07-22.md'],
  ['docs/audits/stage-1.5v2-audit.md', 'docs/audits/stage-1.5v2-audit-2026-07-24.md'],
  ['docs/audits/stage-2-corpus-audit.md', 'docs/audits/stage-2-corpus-audit-2026-07-24.md'],
  ['docs/audits/stage1-smoke-diagnosis.md', 'docs/audits/stage1-smoke-diagnosis-2026-07-21.md'],
  ['docs/todos/annotation.md', 'docs/todos/annotation-2026-07-24.md'],
  ['docs/todos/base-narratology.md', 'docs/todos/base-narratology-2026-07-26.md'],
  ['docs/todos/corpus.md', 'docs/todos/corpus-2026-07-22.md'],
  ['docs/todos/generation-pipeline.md', 'docs/todos/generation-pipeline-2026-07-26.md'],
  ['docs/todos/modern-novel.md', 'docs/todos/modern-novel-2026-07-26.md'],
  ['docs/todos/narrative-checklist.md', 'docs/todos/narrative-checklist-2026-07-26.md'],
  ['docs/todos/planner.md', 'docs/todos/planner-2026-07-24.md'],
  ['docs/todos/stage-3.md', 'docs/todos/stage-3-2026-07-27.md'],
  ['docs/todos/thread-tracking.md', 'docs/todos/thread-tracking-2026-07-26.md'],
  ['docs/todos/upper-ir.md', 'docs/todos/upper-ir-2026-07-26.md'],
  ['docs/todos/validator-bugs.md', 'docs/todos/validator-bugs-2026-07-26.md'],
  ['docs/handoffs/oh-my-pi.md', 'docs/handoffs/oh-my-pi-2026-07-20.md'],
  [
    'docs/decisions/001-fact-dual-representation.md',
    'docs/decisions/001-fact-dual-representation-2026-07-18.md',
  ],
  ['docs/decisions/002-dag-causal-edges.md', 'docs/decisions/002-dag-causal-edges-2026-07-18.md'],
  [
    'docs/decisions/003-dynamic-analysis-blocks.md',
    'docs/decisions/003-dynamic-analysis-blocks-2026-07-18.md',
  ],
  ['docs/decisions/004-ai-sdk-migration.md', 'docs/decisions/004-ai-sdk-migration-2026-07-18.md'],
];

const timeLineFor = (oldPath) => {
  const iso = execSync(`git log -1 --format=%ai -- ${oldPath}`, { encoding: 'utf8' }).trim();
  const m = iso.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}):\d{2} ([+-]\d{4})/);
  if (!m) return null;
  return `> **时间**: ${m[1]} ${m[2]}:${m[3]} CST`;
};

let restored = 0,
  inserted = 0;
for (const [oldPath, newPath] of RENAMES) {
  // 1. Restore original content from HEAD under the old name.
  let original;
  try {
    original = execSync(`git show HEAD:${oldPath}`, { encoding: 'utf8' });
  } catch {
    console.error('skip (not in HEAD):', oldPath);
    continue;
  }
  // 2. Build canonical header: H1 + (blank?) + 时间 + (original remaining body)
  const lines = original.split('\n');
  // Find first non-empty line; assume it's H1.
  let h1Idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      h1Idx = i;
      break;
    }
  }
  if (h1Idx < 0 || !/^#\s/.test(lines[h1Idx])) {
    // No H1 — skip canonical header injection.
    writeFileSync(newPath, original);
    restored++;
    continue;
  }
  const timeLine = timeLineFor(oldPath);
  if (!timeLine) {
    restored++;
    continue;
  }
  // Header block: H1, blank, time line, blank, ...rest
  const head = [lines[h1Idx], '', timeLine];
  const rest = lines.slice(h1Idx + 1);
  // Strip leading blank lines from rest to avoid double blank.
  while (rest.length > 0 && rest[0].trim() === '') rest.shift();
  const rebuilt = [...head, ...rest].join('\n');
  writeFileSync(newPath, rebuilt);
  restored++;
  inserted++;
}

console.log(JSON.stringify({ restored, inserted }));
