import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { analysisResultSchema, countNarrativeText } from '@novalistically/core';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const EVENT_IDS = ['E0', 'E1', 'E2', 'E3', 'E4', 'E5', 'E6'];

describe('built CLI mock full chain', () => {
  it('renders E0–E6 with Pass 2, validates all artifacts, rejects genesis, and assembles complete novel', () => {
    const project = mkdtempSync(join(tmpdir(), 'nova-cli-'));
    try {
      cpSync(join(root, 'fixtures/zhu-fu'), project, { recursive: true });
      // Force a cold render: copied fixture caches may have been produced by
      // an older validator/analysis contract and cannot prove this CLI run.
      rmSync(join(project, '.nova', 'render-cache'), { recursive: true, force: true });

      // ── Run the full render pipeline ─────────────────────────────
      const stdout = execFileSync(
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

      // All seven events must have successfully completed (✅ prefix)
      expect(stdout.match(/✅ E[0-6]:/g)).toHaveLength(7);

      const sceneDir = join(project, 'scenes', 'chapter-01');
      const responsesDir = join(project, '.nova', 'responses');
      const outputDir = join(project, 'output');

      // ── Scene prose files ────────────────────────────────────────
      // Every authored event must produce a non-empty .md file.
      for (const id of EVENT_IDS) {
        const prosePath = join(sceneDir, `${id}.md`);
        expect(existsSync(prosePath), `Missing scene prose: ${id}`).toBe(true);
        const prose = readFileSync(prosePath, 'utf8');
        expect(prose.trim().length, `Empty scene prose: ${id}`).toBeGreaterThan(0);
      }

      // ── Scene text count ─────────────────────────────────────────
      // Each scene must reach the word count of its reference prose.
      // The reference data defines the baseline; any regression in
      // mock prose length is caught here.
      const refDir = join(root, 'fixtures/zhu-fu/reference/data');
      for (const id of EVENT_IDS) {
        const ref = JSON.parse(readFileSync(join(refDir, `${id}.json`), 'utf8'));
        const expected = countNarrativeText(ref.prose, 'zh');
        const prose = readFileSync(join(sceneDir, `${id}.md`), 'utf8');
        const count = countNarrativeText(prose, 'zh');
        expect(
          count,
          `${id} narrative text count regressed (got ${count}, expected >= ${expected})`,
        ).toBeGreaterThanOrEqual(expected);
      }

      // ── Scene metadata files ─────────────────────────────────────
      // Every scene must have a companion YAML metadata file.
      for (const id of EVENT_IDS) {
        expect(existsSync(join(sceneDir, `${id}.yaml`)), `Missing scene metadata: ${id}`).toBe(
          true,
        );
      }

      // ── Pass 2 analysis artifacts ────────────────────────────────
      // Each event persists its raw LLM response (prose + metadata)
      // to .nova/responses/{eventId}.json.
      for (const id of EVENT_IDS) {
        const artifactPath = join(responsesDir, `${id}.json`);
        expect(existsSync(artifactPath), `Missing Pass 2 artifact: ${id}`).toBe(true);
        const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
        expect(artifact, `Pass 2 artifact ${id} missing prose`).toHaveProperty('prose');
        expect(typeof artifact.prose).toBe('string');
        expect(artifact.prose.trim().length, `Empty Pass 2 artifact prose: ${id}`).toBeGreaterThan(
          0,
        );
        expect(artifact, `Pass 2 artifact ${id} missing cacheHit`).toHaveProperty('cacheHit');
        expect(typeof artifact.cacheHit).toBe('boolean');
        // Analysis must be present and schema-valid with matching eventId
        expect(artifact, `Pass 2 artifact ${id} missing analysis`).toHaveProperty('analysis');
        const analysisResult = analysisResultSchema.safeParse(artifact.analysis);
        expect(
          analysisResult.success,
          `Pass 2 artifact ${id} analysis schema invalid: ${analysisResult.error}`,
        ).toBe(true);
        expect(
          analysisResult.data!.eventId,
          `Pass 2 artifact ${id} analysis eventId mismatch`,
        ).toBe(id);
      }

      // ── No genesis scene output ──────────────────────────────────
      // The system:genesis event must never produce narrative output.
      const sceneFiles = readdirSync(sceneDir);
      const genesisInScenes = sceneFiles.filter((f) => f.includes('system:genesis'));
      expect(genesisInScenes, 'Genesis scene files must not exist in scenes/').toHaveLength(0);

      const outputFiles = readdirSync(outputDir);
      const genesisInOutput = outputFiles.filter((f) => f.includes('system:genesis'));
      expect(genesisInOutput, 'Genesis output must not exist in output/').toHaveLength(0);

      // ── Assembled novel ──────────────────────────────────────────
      const novel = readFileSync(join(outputDir, 'novel.md'), 'utf8');
      expect(novel.trim().length, 'Assembled novel is empty').toBeGreaterThan(0);

      // Every scene is included exactly once: 7 scenes → 6 separators
      const separators = novel.match(/\n---\n/g);
      expect(separators, 'Novel missing scene separators').not.toBeNull();
      expect(separators!.length, 'Expected 6 scene separators for 7 scenes').toBe(6);

      // No scene prose is omitted or duplicated in the assembly.
      for (const id of EVENT_IDS) {
        const prose = readFileSync(join(sceneDir, `${id}.md`), 'utf8').trim();
        const occurrences = novel.split(prose).length - 1;
        expect(occurrences, `${id} must appear exactly once in the assembled novel`).toBe(1);
      }

      // Exactly seven authored scene .md files (no extras, no missing).
      const sceneMdFiles = sceneFiles.filter((f) => /^E\d\.md$/.test(f));
      expect(sceneMdFiles, 'Expected exactly 7 scene .md files').toHaveLength(7);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
