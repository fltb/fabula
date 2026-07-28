import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { analysisResultSchema } from '@novalistically/core';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const EVENT_IDS = ['E0', 'E1', 'E2', 'E3', 'E4', 'E5', 'E6'];

describe('built CLI mock full chain', () => {
  it('writes analyzed pending candidates without assembling when warnings lack waivers', () => {
    const project = mkdtempSync(join(tmpdir(), 'nova-cli-'));
    try {
      cpSync(join(root, 'fixtures/zhu-fu'), project, { recursive: true });
      // Force a cold render: copied fixture caches may have been produced by
      // an older validator/analysis contract and cannot prove this CLI run.
      rmSync(join(project, '.nova', 'render-cache'), { recursive: true, force: true });
      rmSync(join(project, 'scenes'), { recursive: true, force: true });
      rmSync(join(project, 'output'), { recursive: true, force: true });
      rmSync(join(project, '.nova', 'responses'), { recursive: true, force: true });

      // ── Run the full render pipeline ─────────────────────────────
      const run = spawnSync(
        process.execPath,
        [
          join(root, 'packages/cli/dist/index.js'),
          'render',
          'E0',
          '--all',
          '--provider',
          'mock-pass2',
          '--reference-dir',
          join(root, 'fixtures/zhu-fu/reference/data'),
        ],
        { cwd: project, encoding: 'utf8' },
      );

      // The fixture emits warning-only validation issues without waivers.
      // Candidates are analyzed and persisted, but release remains pending.
      expect(run.status).toBe(1);
      expect(run.stdout.match(/❌ E[0-6]:/g)).toHaveLength(7);

      const responsesDir = join(project, '.nova', 'responses');
      for (const id of EVENT_IDS) {
        const artifactPath = join(responsesDir, `${id}.json`);
        expect(existsSync(artifactPath), `Missing candidate artifact: ${id}`).toBe(true);
        const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
        expect(artifact.prose.trim().length).toBeGreaterThan(0);
        expect(artifact.released).toBe(false);
        expect(artifact.releaseDecision.status).toBe('pending_waiver');
        const analysisResult = analysisResultSchema.safeParse(artifact.analysis);
        expect(analysisResult.success, `Invalid analysis for ${id}`).toBe(true);
        expect(analysisResult.data?.eventId).toBe(id);
      }

      expect(existsSync(join(project, 'output', 'novel.md'))).toBe(false);
      expect(existsSync(join(project, 'scenes', 'chapter-01', 'E0.md'))).toBe(false);
      expect(existsSync(join(responsesDir, 'system:genesis.json'))).toBe(false);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
