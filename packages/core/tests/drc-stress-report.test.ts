// ============================================================================
// DRC Stress Report — Scene discovery, fallback precedence, false-release check
//
// Invokes the real scripts/drc-stress-report.mjs against a ephemeral fixture
// to verify: nested scene paths (chapter-NN/ dirs), response prose fallback
// when no scene file exists, and scene-metadata winning over response metadata.
// ============================================================================

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'drc-stress-report.mjs');

/**
 * A known substring of bench-data/corpus/dream-of-red-chamber/source.txt
 * used as reference excerpts so excerpt validation passes without
 * EXCERPT_INVALID.
 */
const SOURCE_EXCERPT = '第一回　甄士隱夢幻識通靈　賈雨村風塵怀閨秀';

/** Build the temp fixture directory and return its path. */
function setupFixture(): string {
  const tmpDir = fs.mkdtempSync(path.join(tmpdir(), 'drc-stress-report-test-'));

  // ── chapters/chapter_01/_chapter.yaml ──────────────────────────────────
  const chaptersDir = path.join(tmpDir, 'chapters', 'chapter_01');
  fs.mkdirSync(chaptersDir, { recursive: true });
  fs.writeFileSync(
    path.join(chaptersDir, '_chapter.yaml'),
    'chapter: 1\ntitle: "红楼梦"\nplannedScenes: 2\n',
  );

  // ── E01 event ──────────────────────────────────────────────────────────
  fs.writeFileSync(
    path.join(chaptersDir, 'E01_sample.yaml'),
    [
      'event: E01',
      'title: "甄士隐梦幻识通灵"',
      'narrativeOrder: 1',
      '',
    ].join('\n'),
  );

  // ── E02 event ──────────────────────────────────────────────────────────
  fs.writeFileSync(
    path.join(chaptersDir, 'E02_sample.yaml'),
    [
      'event: E02',
      'title: "冷子兴演说荣国府"',
      'narrativeOrder: 2',
      '',
    ].join('\n'),
  );

  // ── Scenes (nested per actual pipeline output: scenes/chapter-NN/) ─────
  const scenesDir = path.join(tmpDir, 'scenes', 'chapter-01');
  fs.mkdirSync(scenesDir, { recursive: true });

  // E01: rendered scene file exists → should be source = scene
  fs.writeFileSync(
    path.join(scenesDir, 'E01.md'),
    '甄士隱夢幻識通靈 賈雨村風塵怀閨秀\n\n話說那女媧氏煉石補天之時...\n',
  );
  // Scene metadata: released true, 2 attempts → must win over response JSON
  fs.writeFileSync(
    path.join(scenesDir, 'E01.yaml'),
    'released: true\nattempts: 2\n',
  );

  // E02 deliberately has NO scene files → falls back to response

  // ── Reference excerpts (substrings of actual source.txt) ───────────────
  const refDir = path.join(tmpDir, 'reference', 'original');
  fs.mkdirSync(refDir, { recursive: true });
  fs.writeFileSync(path.join(refDir, 'E01.txt'), SOURCE_EXCERPT);
  fs.writeFileSync(path.join(refDir, 'E02.txt'), SOURCE_EXCERPT);

  // ── Response JSONs ────────────────────────────────────────────────────
  const responsesDir = path.join(tmpDir, '.nova', 'responses');
  fs.mkdirSync(responsesDir, { recursive: true });

  // E01 response exists (released: false, attempts: 6) but scene metadata
  // should shadow it → reported source=scene, released=true, attempts=2
  fs.writeFileSync(
    path.join(responsesDir, 'E01.json'),
    JSON.stringify({
      prose: 'Response prose for E01 (should be shadowed by scene)',
      released: false,
      attempts: 6,
    }),
  );

  // E02 only has response JSON (no scene files) → falls back here
  fs.writeFileSync(
    path.join(responsesDir, 'E02.json'),
    JSON.stringify({
      prose: '冷子興演說榮國府 賈雨村風塵怀閨秀',
      released: false,
      attempts: 6,
    }),
  );

  return tmpDir;
}

describe('DRC Stress Report — scene discovery & fallback', () => {
  it('discovers nested scenes, respects response fallback, prevents false release', () => {
    const tmpDir = setupFixture();

    try {
      // Run the real script against the temp fixture
      const stdout = execSync(`node "${SCRIPT}" "${tmpDir}"`, {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
        timeout: 30_000,
      });

      expect(stdout).toContain('Done.');
      expect(stdout).toContain('Found 2 events');

      const reportPath = path.join(tmpDir, 'output', 'stress-report.md');
      const report = fs.readFileSync(reportPath, 'utf-8');

      // ── E01: scene source wins over response ───────────────────────
      // Row format: | ID | Ch | R_Han | O_Han | Cont% | Released | Attempts | Source | Excerpt
      const e01Row = report.match(/\| E01 \| 1 \| [\d,]+ \| [\d,]+ \| [\d.]+% \| true \| 2 \| scene \|/);
      expect(e01Row).toBeTruthy();

      // ── E02: response fallback ─────────────────────────────────────
      const e02Row = report.match(/\| E02 \| 1 \| [\d,]+ \| [\d,]+ \| [\d.]+% \| false \| 6 \| response \|/);
      expect(e02Row).toBeTruthy();

      // ── No invalid rows in the table ──────────────────────────────
      expect(report).not.toContain('| EXCERPT_INVALID');

      // ── Aggregate lines ────────────────────────────────────────────
      expect(report).toContain('- **With render (scene)**: 1');
      expect(report).toContain('- **With response fallback**: 1');
      expect(report).toContain('- **EXCERPT_INVALID count**: 0');

      // Sanity: total events
      expect(report).toContain('- **Events**: 2');
    } finally {
      // Clean up the ephemeral fixture
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
