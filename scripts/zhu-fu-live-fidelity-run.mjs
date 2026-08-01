#!/usr/bin/env node
// ============================================================================
// zhu-fu-live-fidelity-run.mjs — Isolated full-pipeline capture for fidelity
//
// Unlike the promotion-only smoke runner, this script persists every Pass 1
// prose result (including a scene rejected by Pass 2) so direct source-fidelity
// scoring can distinguish prose divergence from release-gate failures.
// It never updates approved mock references.
// ============================================================================

import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { AiSdkProvider, renderNovel, sanitizeError } from '../packages/core/dist/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const FIXTURE_DIR = join(REPO_ROOT, 'fixtures', 'zhu-fu');
const model = process.env.NOVALISTICALLY_AI_MODEL || 'deepseek-v4-flash';
const apiKey = process.env.NOVALISTICALLY_AI_API_KEY;
const baseUrl = process.env.NOVALISTICALLY_AI_BASE_URL;
const label = process.argv[2];

if (!label || !/^[a-z0-9][a-z0-9-]*$/i.test(label)) {
  console.error('Usage: node scripts/zhu-fu-live-fidelity-run.mjs <baseline|expanded>');
  process.exit(1);
}
if (!apiKey) {
  console.error('ERROR: NOVALISTICALLY_AI_API_KEY is not set. No fidelity capture was written.');
  process.exit(1);
}

let workDir;

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  workDir = mkdtempSync(join(tmpdir(), 'novalistically-zhufu-fidelity-'));
  const runDir = join(FIXTURE_DIR, '.nova', 'fidelity-runs', `${timestamp()}-${label}`);
  mkdirSync(runDir, { recursive: true });

  cpSync(FIXTURE_DIR, workDir, {
    recursive: true,
    filter: (source) => {
      const rest = source.startsWith(`${FIXTURE_DIR}/`) ? source.slice(FIXTURE_DIR.length + 1) : '';
      const topLevel = rest.split('/')[0];
      return topLevel !== '.nova' && topLevel !== 'scenes' && topLevel !== 'output';
    },
  });

  console.log(`Live fidelity capture for zhu-fu (${label}; model: ${model})`);
  console.log(`  Work dir: ${workDir}`);
  console.log(`  Capture:  ${runDir}`);

  const provider = new AiSdkProvider({ apiKey, baseURL: baseUrl, model });
  let result;
  try {
    result = await renderNovel(
      {
        version: 1,
        projectDir: workDir,
        model,
        selector: { type: 'all' },
        mutation: { operationId: randomUUID(), actorId: 'fidelity-runner' },
        maxRounds: 1,
      },
      { provider },
    );
  } catch (error) {
    writeJson(join(runDir, 'fatal-error.json'), {
      label,
      generatedAt: new Date().toISOString(),
      error: sanitizeError(error),
    });
    throw error;
  }

  const generatedAt = new Date().toISOString();
  const sorted = [...result.results].sort((left, right) =>
    left.eventId.localeCompare(right.eventId, undefined, { numeric: true }),
  );
  for (const scene of sorted) {
    const attempts =
      scene.providerCalls.length === 0
        ? 0
        : Math.max(...scene.providerCalls.map((call) => call.attempt));
    writeJson(join(runDir, `${scene.eventId}.json`), {
      prose: scene.prose,
      released: scene.released,
      validationErrors: scene.validationErrors,
      validationIssueMessages: scene.validationIssueMessages,
      errors: scene.errors,
      pass2Rejection: scene.pass2Rejection ?? null,
      analysis: scene.analysis,
      validation: scene.validation,
      needsReview: scene.needsReview,
      providerCalls: scene.providerCalls,
      metadata: {
        eventId: scene.eventId,
        generatedAt,
        provider: 'ai-sdk',
        model,
        attempts,
        promptHash: scene.promptHash,
      },
    });
  }

  const novelPath = join(workDir, 'output', 'novel.md');
  try {
    writeFileSync(join(runDir, 'novel.md'), readFileSync(novelPath));
  } catch {
    // A strict release gate can intentionally suppress novel assembly.
  }

  const released = result.results.filter((scene) => scene.released).length;
  const rejected = result.results.filter((scene) => !scene.released).map((scene) => scene.eventId);
  writeJson(join(runDir, 'run.json'), {
    label,
    generatedAt,
    provider: 'ai-sdk',
    model,
    pipeline: 'renderNovel(eventId: all, isolated fixture copy, no runtime cache)',
    events: result.results.length,
    released,
    rejected,
    errors: result.errors,
  });

  console.log(
    `Captured ${result.results.length} scenes; release gate: ${released}/${result.results.length}.`,
  );
  console.log(`  Results: ${runDir}`);
}

main()
  .then(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((error) => {
    console.error(`ERROR: ${sanitizeError(error)}`);
    if (workDir) rmSync(workDir, { recursive: true, force: true });
    process.exit(1);
  });
