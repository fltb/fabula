// ============================================================================
// DRC Stress Report — Stability mode with nested scenes and response fallback
//
// Invokes the real scripts/drc-stress-report.mjs with --stability against
// three temporary run directories: one with a nested chapter-NN/ scene,
// two with only .nova/responses/{id}.json prose.  Asserts pairwise bigram
// containment is computed (not "No pairwise comparisons possible").
// ============================================================================

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'drc-stress-report.mjs');

describe('DRC Stress Report — stability (nested scene + response fallback)', () => {
  it('computes pairwise bigram containment across run dirs with nested scenes and response fallback', () => {
    const tmpDir = fs.mkdtempSync(path.join(tmpdir(), 'drc-stability-test-'));

    try {
      // ── Minimal fixture ────────────────────────────────────────────────
      // One event E01 — enough to exercise the stability walker.
      const chaptersDir = path.join(tmpDir, 'chapters', 'chapter_01');
      fs.mkdirSync(chaptersDir, { recursive: true });
      fs.writeFileSync(
        path.join(chaptersDir, '_chapter.yaml'),
        'chapter: 1\ntitle: "红楼梦"\nplannedScenes: 1\n',
      );
      fs.writeFileSync(
        path.join(chaptersDir, 'E01.yaml'),
        [
          'event: E01',
          'title: 甄士隱夢幻識通靈',
          'chapter: 1',
          'metadata:',
          '  type: main',
        ].join('\n') + '\n',
      );

      // No reference/original dir → excerptStatus = 'N/A (no reference)'.
      // source.txt exists on disk → loadSourceBuffer() succeeds, but without
      // reference excerpts there is nothing to validate (no EXCERPT_INVALID).

      // ── Run 1: nested scene path (release layout) ─────────────────────
      //   scenes/chapter-01/E01.md  (the script's buildStabilitySection
      //   scans scenes/chapter-NN/ subdirectories for the nested layout).
      const run1 = path.join(tmpDir, 'run1');
      const nestedSceneDir = path.join(run1, 'scenes', 'chapter-01');
      fs.mkdirSync(nestedSceneDir, { recursive: true });
      fs.writeFileSync(
        path.join(nestedSceneDir, 'E01.md'),
        [
          '甄士隱夢幻識通靈 賈雨村風塵怀閨秀',
          '',
          '話說那女媧氏煉石補天之時於大荒山無稽崖煉成高經十二丈方經二十四丈頑石三萬六千五百零一塊',
          '',
        ].join('\n'),
      );

      // ── Run 2: response-only (no scene file) ──────────────────────────
      //   .nova/responses/E01.json  with a prose field.
      const run2 = path.join(tmpDir, 'run2');
      const respDir2 = path.join(run2, '.nova', 'responses');
      fs.mkdirSync(respDir2, { recursive: true });
      fs.writeFileSync(
        path.join(respDir2, 'E01.json'),
        JSON.stringify({
          prose:
            '甄士隱夢幻識通靈 賈雨村風塵怀閨秀 此開卷第一回也作者自云曾歷過一番夢幻之後故將真事隱去而借通靈說此石頭記一書也',
        }) + '\n',
      );

      // ── Run 3: also response-only (different prose) ───────────────────
      const run3 = path.join(tmpDir, 'run3');
      const respDir3 = path.join(run3, '.nova', 'responses');
      fs.mkdirSync(respDir3, { recursive: true });
      fs.writeFileSync(
        path.join(respDir3, 'E01.json'),
        JSON.stringify({
          prose:
            '甄士隱夢幻識通靈 賈雨村風塵怀閨秀 列位看官你道此書從何而起說來雖近荒唐細玩頗有趣味',
        }) + '\n',
      );

      // ── Invoke the real script ─────────────────────────────────────────
      const stdout = execSync(
        `node "${SCRIPT}" "${tmpDir}" --stability "${run1},${run2},${run3}"`,
        { cwd: REPO_ROOT, encoding: 'utf-8', timeout: 30_000 },
      );

      expect(stdout).toContain('Done.');
      expect(stdout).toContain('Found 1 events');

      // ── Read the report ────────────────────────────────────────────────
      const reportPath = path.join(tmpDir, 'output', 'stress-report.md');
      const report = fs.readFileSync(reportPath, 'utf-8');

      // ── Assert stability section content ───────────────────────────────
      // Header must be present.
      expect(report).toContain('## Stability (Run Comparison)');

      // Must NOT say "No pairwise comparisons possible".
      expect(report).not.toContain('No pairwise comparisons possible');

      // Must list the Pairwise comparisons count (≥3 pairs from 3 dirs).
      expect(report).toMatch(/- \*\*Pairwise comparisons\*\*: [3-9]/);

      // Must list Mean pairwise containment as a percentage.
      expect(report).toMatch(/- \*\*Mean pairwise containment\*\*: \d+\.\d+%/);

      // Each run-dir pair for E01 must appear with a numeric percentage.
      // The stability section has one | E01 | ... | N.N% | per pair.
      const e01PairLines = [...report.matchAll(/\| E01 \| .+? \| \d+\.\d+% \|/g)];
      expect(e01PairLines.length).toBe(3); // 3 choose 2 = 3 pairwise rows

      // Labels are the basenames of each run dir (run1, run2, run3).
      // Verify at least one pair mentions the response-fallback dirs.
      const pairText = e01PairLines.map(m => m[0]).join(' ');
      expect(pairText).toContain('run2');
      expect(pairText).toContain('run3');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
