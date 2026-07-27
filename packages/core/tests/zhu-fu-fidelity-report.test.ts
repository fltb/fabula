// ============================================================================
// zhu-fu-fidelity-report — direct original-text scoring
// ============================================================================

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'zhu-fu-fidelity-report.mjs');
const ORIGINAL = fs.readFileSync(
  path.join(REPO_ROOT, 'fixtures', 'zhu-fu', 'reference', 'original.txt'),
  'utf-8',
);

const EVENT_LINES: Record<string, readonly [number, number]> = {
  E0: [4, 36],
  E1: [38, 66],
  E2: [68, 78],
  E3: [80, 128],
  E4: [130, 172],
  E5: [174, 214],
  E6: [216, 220],
};
const EVENT_FILES: Record<string, string> = {
  E0: 'E0_encounter.yaml',
  E1: 'E1_death_news.yaml',
  E2: 'E2_first_arrival.yaml',
  E3: 'E3_kidnapping.yaml',
  E4: 'E4_return_to_lu.yaml',
  E5: 'E5_threshold_rejection.yaml',
  E6: 'E6_expulsion_death.yaml',
};

function setupFixture(): {
  fixtureDir: string;
  candidateDir: string;
  reportPath: string;
  comparisonPath: string;
} {
  const fixtureDir = fs.mkdtempSync(path.join(tmpdir(), 'zhu-fu-fidelity-test-'));
  const chaptersDir = path.join(fixtureDir, 'chapters', 'chapter_01');
  const referenceDir = path.join(fixtureDir, 'reference');
  const candidateDir = path.join(fixtureDir, 'candidate');
  fs.mkdirSync(chaptersDir, { recursive: true });
  fs.mkdirSync(referenceDir, { recursive: true });
  fs.mkdirSync(candidateDir, { recursive: true });
  fs.writeFileSync(path.join(referenceDir, 'original.txt'), ORIGINAL);

  for (const [eventId, [start, end]] of Object.entries(EVENT_LINES)) {
    fs.writeFileSync(
      path.join(chaptersDir, EVENT_FILES[eventId]),
      `event: ${eventId}\ntitle: ${eventId}\nnarrativeOrder: ${Number(eventId.slice(1)) + 1}\n`,
    );
    fs.writeFileSync(
      path.join(candidateDir, `${eventId}.json`),
      JSON.stringify({
        prose: ORIGINAL.split('\n')
          .slice(start - 1, end)
          .join('\n'),
        released: eventId !== 'E6',
        validationErrors: 0,
        errors:
          eventId === 'E6'
            ? [
                'Attempt 1 failed validation (1 errors), round 1, strategy: retry',
                'Pass 2 attempt 2 failed: ai-sdk error: No object generated: could not parse the response.',
              ]
            : [],
        metadata: { attempts: eventId === 'E6' ? 2 : 1 },
      }),
    );
  }

  return {
    fixtureDir,
    candidateDir,
    reportPath: path.join(fixtureDir, 'fidelity.md'),
    comparisonPath: path.join(fixtureDir, 'comparison.md'),
  };
}

describe('zhu-fu-fidelity-report', () => {
  it('scores exact original scene spans at 100% and writes a paired JSON report', () => {
    const { fixtureDir, candidateDir, reportPath, comparisonPath } = setupFixture();
    try {
      const stdout = execFileSync(
        'node',
        [
          SCRIPT,
          fixtureDir,
          '--render-dir',
          candidateDir,
          '--label',
          'exact',
          '--output',
          reportPath,
          '--comparison-output',
          comparisonPath,
        ],
        { cwd: REPO_ROOT, encoding: 'utf-8', timeout: 30_000 },
      );

      expect(stdout).toContain('Work LCS-F1: 100.0%');
      const report = fs.readFileSync(reportPath, 'utf-8');
      expect(report).toContain('| E0 | E0 | candidate |');
      expect(report).toContain('| E6 | E6 | candidate |');
      expect(report).toContain('**全文 LCS-F1（拼接 E0→E6）**：100.0%');
      const comparison = fs.readFileSync(comparisonPath, 'utf-8');
      expect(comparison).toContain('## E6 — E6');
      expect(comparison).toContain(
        'Attempt 1 failed validation (1 errors), round 1, strategy: retry',
      );
      expect(comparison).toContain(
        'Pass 2 attempt 2 failed: ai-sdk error: No object generated: could not parse the response.',
      );
      expect(comparison).toContain('最终 Pass 2 provider exception 令 `analysis === null`');

      const metrics = JSON.parse(
        fs.readFileSync(path.join(fixtureDir, 'fidelity.json'), 'utf-8'),
      ) as {
        aggregate: { workDirectScore: number; missingEventIds: string[] };
        events: Array<{ directScore: number; bigramF1: number }>;
      };
      expect(metrics.aggregate.workDirectScore).toBe(1);
      expect(metrics.aggregate.missingEventIds).toEqual([]);
      expect(metrics.events).toHaveLength(7);
      expect(metrics.events.every((event) => event.directScore === 1 && event.bigramF1 === 1)).toBe(
        true,
      );
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
