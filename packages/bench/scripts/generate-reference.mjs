// ============================================================================
// Live smoke runner for Stage 1 — real-provider candidate generation.
// Usage (credentials required):
//   NOVALISTICALLY_AI_API_KEY=... NOVALISTICALLY_AI_MODEL=... npm run smoke:stage1:live
//
// Credentials must be exported in the shell: NOVALISTICALLY_AI_API_KEY,
// NOVALISTICALLY_AI_BASE_URL, and NOVALISTICALLY_AI_MODEL are read directly
// from process.env — this script intentionally does NOT load .env.
//
// Creates a temporary copy of the fixture without .nova/scenes/output so no
// developer cache can satisfy the run.  Results are written to the ORIGINAL
// fixture's .nova/smoke-candidates/{timestamp}/ directory.
// NEVER writes to the approved reference/data directory.
// ============================================================================

import { createHash, randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderNovel } from '../../core/dist/editorial.js';
import { sanitizeError } from '../../core/dist/index.js';
import { provenanceManifestSchema, responseReferenceSchema } from '../../core/dist/tooling.js';
import {
  createFileCoreRuntimeServices,
  FileProjectSourceLoader,
  PiOpenAICompatibleProvider,
} from '../../node-host/dist/index.js';
import { buildLiveSmokeRecord, collectReferenceIssueIdentities } from '../dist/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '../../..');

// ── Config ──────────────────────────────────────────────────────────────
const projectName = process.argv[2] || 'zhu-fu';
const projectDir = join(rootDir, 'fixtures', projectName);
const model = process.env.NOVALISTICALLY_AI_MODEL || 'deepseek-v4-flash';
const apiKey = process.env.NOVALISTICALLY_AI_API_KEY;
const baseUrl = process.env.NOVALISTICALLY_AI_BASE_URL;

// Pass 2 seed is fixed at 42; Pass 1 is explicitly unseeded (null).
const SEED = 42;

// ── Credential check (MUST exit nonzero without writing any record) ────
if (!apiKey) {
  console.error('ERROR: NOVALISTICALLY_AI_API_KEY is not set.');
  console.error('Set it in your environment or .env file to run the live smoke.');
  console.error('No smoke record was written.');
  process.exit(1);
}

let workDir;

async function main() {
  workDir = mkdtempSync(join(tmpdir(), 'novalistically-smoke-'));

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const candidateDir = join(projectDir, '.nova', 'smoke-candidates', timestamp);
  mkdirSync(candidateDir, { recursive: true });

  const command = `node ${process.argv.slice(1).join(' ')}`;

  // ── Temp fixture copy (no .nova/scenes/output) ──────────────────────
  try {
    // Copy everything except .nova, scenes, output — ensures no cache can
    // satisfy the run and no stale intermediate artifacts influence it.
    cpSync(projectDir, workDir, {
      recursive: true,
      filter: (src) => {
        const rest =
          src[projectDir.length] === '/'
            ? src.slice(projectDir.length + 1)
            : src.slice(projectDir.length);
        const top = rest.split('/')[0];
        return top !== '.nova' && top !== 'scenes' && top !== 'output';
      },
    });
  } catch (err) {
    throw new Error(
      `Failed to copy fixture to temp directory: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const source = new FileProjectSourceLoader().load(workDir);

  // ── Render via public API ───────────────────────────────────────────
  console.log(`\nLive smoke for ${projectName} (model: ${model}, seed: ${SEED})`);
  console.log(`  Work dir:     ${workDir}`);
  console.log(`  Candidate dir: ${candidateDir}\n`);
  const provider = new PiOpenAICompatibleProvider({ apiKey, baseURL: baseUrl, model });

  let result;
  try {
    result = await renderNovel(
      {
        version: 1,
        source,
        model,
        selector: { type: 'all' },
        mutation: { operationId: randomUUID(), actorId: 'smoke-runner' },
        maxRounds: 1,
      },
      { provider, services: createFileCoreRuntimeServices(workDir, { provider }) },
    );
  } catch (err) {
    // Write fatal-error.json even when renderNovel threw
    const fatal = { error: sanitizeError(err), generatedAt: new Date().toISOString() };
    writeFileSync(join(candidateDir, 'fatal-error.json'), JSON.stringify(fatal, null, 2));
    throw new Error(`Fatal error during renderNovel: ${sanitizeError(err)}`);
  }

  // ── Handle zero results ─────────────────────────────────────────────
  if (!result || result.results.length === 0) {
    const fatal = {
      error: (result?.errors ?? []).join('; ') || 'Unknown: renderNovel returned no results',
      generatedAt: new Date().toISOString(),
    };
    writeFileSync(join(candidateDir, 'fatal-error.json'), JSON.stringify(fatal, null, 2));
    throw new Error(`renderNovel returned no results for ${projectName}: ${fatal.error}`);
  }

  // ── Build smoke record ───────────────────────────────────────────────
  let smokeOutput;
  try {
    smokeOutput = buildLiveSmokeRecord({
      result,
      provider: 'ai-sdk',
      model,
      seed: SEED,
      command,
      versions: {
        code: '0.1.0',
        fixture: '1',
        schema: 1,
        prompt: '1',
        capability: '1',
      },
    });
  } catch (err) {
    throw new Error(
      `Smoke record build failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── Serialise smoke record and compute runHash ────────────────────────
  // runHash is the full SHA-256 of the byte-identical smoke record JSON,
  // used in every provenance entry.  We compute it before writing so the
  // file is written exactly once.
  const recordStr = JSON.stringify(smokeOutput.record, null, 2);
  const runHash = createHash('sha256').update(recordStr).digest('hex');
  const generatedAt = new Date().toISOString();

  // ── Validate all candidate scene outputs before writing any ──────────
  // Validating every candidate first prevents partial candidate sets
  // when one event cannot form a schema-valid response (e.g. null analysis).
  const validatedEntries = [];
  const failures = [];
  for (const r of result.results) {
    const attempts =
      r.providerCalls && r.providerCalls.length > 0
        ? Math.max(...r.providerCalls.map((c) => c.attempt))
        : 1;

    const entry = {
      prose: r.prose,
      analysis: r.analysis,
      metadata: {
        eventId: r.eventId,
        provider: 'ai-sdk',
        model,
        seed: SEED,
        promptVersion: 'stage1-v1',
        promptHash: r.promptHash,
        analysisSchemaVersion: 1,
        fixtureFormatVersion: 1,
        generatedAt,
        reviewStatus: 'candidate',
        attempts,
        errors: (r.errors ?? []).map((e) => sanitizeError(e)),
      },
    };

    const parsed = responseReferenceSchema.safeParse(entry);
    if (!parsed.success) {
      failures.push({
        eventId: r.eventId,
        reason: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        pass2Rejection: r.pass2Rejection ?? null,
      });
    } else {
      validatedEntries.push({ eventId: r.eventId, data: parsed.data, original: r });
    }
  }

  // If any candidate failed validation, write fatal-error.json with only
  // safe diagnostics (event IDs, counts, release state, sanitized reasons)
  // and exit nonzero — never leave a partial promotable candidate set.
  if (failures.length > 0) {
    const released = result.results.filter((ev) => ev.prose && ev.prose.length > 0).length;
    const fatal = {
      fatalType: 'candidate_validation_failure',
      generatedAt: new Date().toISOString(),
      events: {
        total: result.results.length,
        valid: validatedEntries.length,
        failed: failures.length,
        released,
      },
      failures,
      errors: (result.errors ?? []).map((e) => sanitizeError(e)),
    };
    writeFileSync(join(candidateDir, 'fatal-error.json'), JSON.stringify(fatal, null, 2));
    const detail = failures.map((f) => `${f.eventId}: ${f.reason}`).join('; ');
    throw new Error(
      `Candidate validation failed: ${failures.length}/${result.results.length} events invalid. ${detail}`,
    );
  }

  // ── All validated — write candidate scene outputs ─────────────────────
  const referenceMap = new Map();
  for (const { eventId, data, original } of validatedEntries) {
    writeFileSync(join(candidateDir, `${eventId}.json`), JSON.stringify(data, null, 2));
    referenceMap.set(eventId, { prose: original.prose, analysis: original.analysis });
  }

  // ── Write observed-outcomes.json ─────────────────────────────────────
  const identities = collectReferenceIssueIdentities(projectDir, referenceMap);
  const outcomes = { version: 1, issues: identities };
  writeFileSync(join(candidateDir, 'observed-outcomes.json'), JSON.stringify(outcomes, null, 2));

  // ── Write candidate-provenance.json ──────────────────────────────────
  const provenance = {
    version: 1,
    entries: result.results.map((r) => ({
      eventId: r.eventId,
      kind: 'generated',
      runHash,
    })),
  };
  const provParsed = provenanceManifestSchema.safeParse(provenance);
  if (!provParsed.success) {
    throw new Error(`Invalid provenance manifest: ${JSON.stringify(provParsed.error.issues)}`);
  }
  writeFileSync(
    join(candidateDir, 'candidate-provenance.json'),
    JSON.stringify(provParsed.data, null, 2),
  );

  // ── Write smoke record ───────────────────────────────────────────────
  const recordPath = join(candidateDir, 'smoke-record.json');
  writeFileSync(recordPath, recordStr);

  // ── Report ──────────────────────────────────────────────────────────
  if (smokeOutput.success) {
    console.log(`\n✓ Live smoke passed for ${projectName} E0–E6`);
    console.log(`  Candidate output: ${candidateDir}/`);
    console.log(`  Smoke record:    ${recordPath}`);
    console.log(`  Provenance hash: ${runHash}`);
  } else {
    const released = result.results.filter((r) => r.prose.length > 0);
    console.error(`\n✗ Live smoke FAILED for ${projectName}`);
    console.error(`  Released: ${released.length}/${result.results.length}`);
    console.error(`  Errors:   ${result.errors.map((e) => sanitizeError(e)).join('; ')}`);
    console.error(`  Failure record: ${recordPath}`);
    throw new Error('Live smoke did not pass — see failure record for details');
  }
}

main()
  .then(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\nERROR: ${msg}`);
    if (workDir) rmSync(workDir, { recursive: true, force: true });
    process.exit(1);
  });
