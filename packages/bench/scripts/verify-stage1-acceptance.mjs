// ============================================================================
// Stage 1 Acceptance Verifier — hash-bound deterministic gate
// ============================================================================
// Usage:
//   node packages/bench/scripts/verify-stage1-acceptance.mjs [project] [flags]
//
// Flags:
//   --print-reference-hashes   Print four SHA-256 hashes then exit (does not
//                              require review.json). Validates schemas and
//                              prompt-ledger consistency.
//   --exclude-live-smoke       Skip live-smoke-record.json validation in
//                              default mode.
//
//
// recomputes L1+L2 outcome identities, and optionally validates the independent
// live-smoke-record.json.
//
// Constraints enforced:
//   - Never uses environment variables or reads credentials.
//   - Never creates or modifies approval artifacts.
//   - Never prints prose, prompts, secrets, or raw failure strings.
//   - Exits nonzero on any contract defect.
// ============================================================================

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '../../..');

import {
  expectedOutcomeManifestSchema,
  liveSmokeRecordSchema,
  provenanceManifestSchema,
  ReferenceFormatError,
  responseReferenceSchema,
} from '../../core/dist/index.js';
// dist imports (follow same pattern as generate-reference.mjs)
import { collectReferenceIssueIdentities, loadApprovedReferences } from '../dist/index.js';

// ─── Constants ─────────────────────────────────────────────────────────

const EXPECTED_EVENT_IDS = ['E0', 'E1', 'E2', 'E3', 'E4', 'E5', 'E6'];
const H64 = /^[0-9a-f]{64}$/;
const SECRET_VALUE_PATTERN =
  /(?:^|[^a-z])(?:sk-|api[_-]key|auth[_-]token|secret|password|credential)(?:$|[^a-z])/i;

// ─── Helpers (replicated from reference.ts — not exported) ─────────────

/** Lexicographic sort key for identity comparisons. */
function identityKey(id) {
  return `${id.validator}\x00${id.eventId}\x00${id.category}\x00${id.entityId ?? ''}\x00${id.attribute ?? ''}\x00${id.severity}`;
}

/** Human-readable identity for diagnostic messages. */
function idStr(id) {
  return `${id.validator}/${id.eventId}/${id.category}/${id.entityId ?? '-'}/${id.attribute ?? '-'}/${id.severity}`;
}

/**
 * Canonical JSON — arrays preserve order, plain-object keys sorted
 * lexicographically, undefined members omitted.
 */
function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Compute responses hash: ordered `E0.json\0<bytes>…E6.json\0<bytes>`. */
function computeResponsesHash(dataDir) {
  const hash = createHash('sha256');
  for (const eventId of EXPECTED_EVENT_IDS) {
    const content = readFileSync(join(dataDir, `${eventId}.json`));
    hash.update(`${eventId}.json`);
    hash.update(Buffer.from([0]));
    hash.update(content);
  }
  return hash.digest('hex');
}

/** Recompute promptHash from an ordered array of ledger entry projections. */
function computePromptHash(ledger) {
  const projection = ledger.map(({ phase, attempt, requestHash, model, seed }) => ({
    phase,
    attempt,
    requestHash,
    model,
    seed,
  }));
  return createHash('sha256').update(canonicalJson(projection)).digest('hex');
}

/**
 * Validate that a string value does not look like a credential.
 * Returns true if the string contains a secret-like pattern.
 */
function containsSecret(value) {
  return typeof value === 'string' && SECRET_VALUE_PATTERN.test(value);
}

/** Check string is 64 lowercase hex chars. */
function is64hex(s) {
  return H64.test(s);
}

/** Parse JSON with a descriptive error wrapper. */
function parseJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`Invalid JSON in ${filePath}: ${err.message}`);
  }
}

/** Read raw bytes of a file and return both bytes and hex. */
function fileSha256(filePath) {
  const bytes = readFileSync(filePath);
  return { bytes, hex: createHash('sha256').update(bytes).digest('hex') };
}

// ─── Mode 1: Hash-print (--print-reference-hashes) ────────────────────

function runHashPrint(referenceDir) {
  const dataDir = join(referenceDir, 'data');
  const provenancePath = join(referenceDir, 'provenance.json');
  const outcomesPath = join(referenceDir, 'expected-outcomes.json');
  const genRecordPath = join(referenceDir, 'generation-record.json');

  // ── File existence checks ────────────────────────────────────────
  if (!existsSync(dataDir)) {
    console.error('ERROR: Reference data directory not found:', dataDir);
    process.exit(1);
  }
  if (!existsSync(provenancePath)) {
    console.error('ERROR: provenance.json not found:', provenancePath);
    process.exit(1);
  }
  if (!existsSync(outcomesPath)) {
    console.error('ERROR: expected-outcomes.json not found:', outcomesPath);
    process.exit(1);
  }
  if (!existsSync(genRecordPath)) {
    console.error('ERROR: generation-record.json not found:', genRecordPath);
    process.exit(1);
  }

  const files = readdirSync(dataDir)
    .filter((f) => f.endsWith('.json'))
    .filter((n) => EXPECTED_EVENT_IDS.includes(n.replace('.json', '')))
    .sort();
  const expectedFiles = EXPECTED_EVENT_IDS.map((eid) => `${eid}.json`);
  if (JSON.stringify(files) !== JSON.stringify(expectedFiles)) {
    console.error('ERROR: Reference data must contain exactly E0–E6.');
    console.error('  Found:', files.join(', '));
    console.error('  Expected:', expectedFiles.join(', '));
    process.exit(1);
  }

  // ── Validate each response schema ────────────────────────────────
  for (const eventId of EXPECTED_EVENT_IDS) {
    const eventPath = join(dataDir, `${eventId}.json`);
    const raw = parseJson(eventPath);

    const parsed = responseReferenceSchema.safeParse(raw);
    if (!parsed.success) {
      const reasons = parsed.error.issues.map((i) => i.message).join('; ');
      console.error(`ERROR: Response ${eventId} schema validation failed: ${reasons}`);
      process.exit(1);
    }

    // Reject placeholder values
    if (parsed.data.metadata.model === 'unknown') {
      console.error(`ERROR: Response ${eventId} uses placeholder model "unknown"`);
      process.exit(1);
    }
    if (parsed.data.metadata.promptHash === 'reviewed') {
      console.error(`ERROR: Response ${eventId} uses placeholder promptHash "reviewed"`);
      process.exit(1);
    }

    // Reject secret-like metadata
    for (const [key, val] of Object.entries(parsed.data.metadata)) {
      if (containsSecret(val)) {
        console.error(
          `ERROR: Response ${eventId} metadata field '${key}' contains a secret-like value`,
        );
        process.exit(1);
      }
    }

    // Hash fields must be 64 hex
    if (parsed.data.metadata.promptHash && !is64hex(parsed.data.metadata.promptHash)) {
      console.error(`ERROR: Response ${eventId} promptHash is not 64 lowercase hex`);
      process.exit(1);
    }

    // Analysis eventId must match file eventId
    if (parsed.data.analysis.eventId !== eventId) {
      console.error(`ERROR: Response ${eventId} analysis eventId mismatch`);
      process.exit(1);
    }

    // Only 'candidate' or 'approved' allowed in hash-print mode
    if (!['candidate', 'approved'].includes(parsed.data.metadata.reviewStatus)) {
      console.error(`ERROR: Response ${eventId} reviewStatus must be "candidate" or "approved"`);
      process.exit(1);
    }
  }

  // ── Validate provenance schema ───────────────────────────────────
  const provenanceRaw = parseJson(provenancePath);
  const provenanceParsed = provenanceManifestSchema.safeParse(provenanceRaw);
  if (!provenanceParsed.success) {
    const reasons = provenanceParsed.error.issues.map((i) => i.message).join('; ');
    console.error(`ERROR: Provenance manifest is invalid: ${reasons}`);
    process.exit(1);
  }

  // Check for duplicate event IDs
  const provByEvent = new Map(provenanceParsed.data.entries.map((e) => [e.eventId, e]));
  if (provenanceParsed.data.entries.length !== provByEvent.size) {
    console.error('ERROR: Provenance manifest contains duplicate event IDs');
    process.exit(1);
  }

  // Check every expected event is in provenance
  for (const eventId of EXPECTED_EVENT_IDS) {
    if (!provByEvent.has(eventId)) {
      console.error(`ERROR: Missing provenance entry for event ${eventId}`);
      process.exit(1);
    }
    const entry = provByEvent.get(eventId);
    if (entry.kind === 'generated' && !entry.runHash) {
      console.error(`ERROR: Provenance entry for ${eventId} must have runHash`);
      process.exit(1);
    }
  }

  // ── Validate expected-outcomes schema ────────────────────────────
  const outcomesRaw = parseJson(outcomesPath);
  const outcomesParsed = expectedOutcomeManifestSchema.safeParse(outcomesRaw);
  if (!outcomesParsed.success) {
    const reasons = outcomesParsed.error.issues.map((i) => i.message).join('; ');
    console.error(`ERROR: Expected-outcomes manifest is invalid: ${reasons}`);
    process.exit(1);
  }

  // Check duplicate identities
  const seenKeys = new Set();
  for (const issue of outcomesParsed.data.issues) {
    const key = identityKey(issue);
    if (seenKeys.has(key)) {
      console.error(`ERROR: Duplicate issue identity in expected-outcomes: ${key}`);
      process.exit(1);
    }
    seenKeys.add(key);
  }

  // ── Validate generation record and prompt-ledger consistency ─────
  const genRecord = parseJson(genRecordPath);

  // Basic structural validation
  if (typeof genRecord !== 'object' || genRecord === null) {
    console.error('ERROR: generation-record.json must be a JSON object');
    process.exit(1);
  }
  if (typeof genRecord.provider !== 'string' || genRecord.provider.length === 0) {
    console.error('ERROR: generation-record.json must have a non-empty provider');
    process.exit(1);
  }
  if (typeof genRecord.model !== 'string' || genRecord.model.length === 0) {
    console.error('ERROR: generation-record.json must have a non-empty model');
    process.exit(1);
  }
  if (typeof genRecord.seed !== 'number' || !Number.isInteger(genRecord.seed)) {
    console.error('ERROR: generation-record.json must have an integer seed');
    process.exit(1);
  }
  if (!genRecord.call || !Array.isArray(genRecord.call.perEvent)) {
    console.error('ERROR: generation-record.json must have call.perEvent array');
    process.exit(1);
  }
  if (!genRecord.hashes || !Array.isArray(genRecord.hashes.events)) {
    console.error('ERROR: generation-record.json must have hashes.events array');
    process.exit(1);
  }

  // Build ledger-by-event and hash-by-event maps
  const ledgerByEvent = new Map();
  for (const ev of genRecord.call.perEvent) {
    if (!EXPECTED_EVENT_IDS.includes(ev.eventId)) continue;
    if (ledgerByEvent.has(ev.eventId)) {
      console.error(`ERROR: Duplicate event ${ev.eventId} in generation-record call.perEvent`);
      process.exit(1);
    }
    ledgerByEvent.set(ev.eventId, ev);
  }

  const hashByEvent = new Map();
  for (const h of genRecord.hashes.events) {
    hashByEvent.set(h.eventId, h);
  }

  // Verify each event's promptHash against recomputed value from ledger
  for (const eventId of EXPECTED_EVENT_IDS) {
    const eventPath = join(dataDir, `${eventId}.json`);
    const raw = parseJson(eventPath);
    const parsed = responseReferenceSchema.safeParse(raw);
    if (!parsed.success) continue; // already reported above

    const responsePH = parsed.data.metadata.promptHash;
    const genLedger = ledgerByEvent.get(eventId);

    if (!genLedger) {
      console.error(`ERROR: Event ${eventId} not found in generation-record call.perEvent`);
      process.exit(1);
    }

    const computedPH = computePromptHash(
      genLedger.ledger.map((e) => ({
        phase: e.phase,
        attempt: e.attempt,
        requestHash: e.requestHash,
        model: e.model,
        seed: e.seed,
      })),
    );

    if (computedPH !== responsePH) {
      // Also check the generation-record's hash entry
      const genHashEntry = hashByEvent.get(eventId);
      if (!genHashEntry || genHashEntry.promptHash !== responsePH) {
        console.error(
          `ERROR: Response promptHash for ${eventId} cannot be verified against generation-record ledger ` +
            `(computed=${computedPH}, response=${responsePH})`,
        );
        process.exit(1);
      }
    }
  }

  // ── Compute hashes ───────────────────────────────────────────────
  const responsesSha256 = computeResponsesHash(dataDir);
  const generationRecordSha256 = fileSha256(genRecordPath).hex;
  const provenanceSha256 = fileSha256(provenancePath).hex;
  const expectedOutcomesSha256 = fileSha256(outcomesPath).hex;

  // ── Print only the four hashes ───────────────────────────────────
  console.log(`responsesSha256=${responsesSha256}`);
  console.log(`generationRecordSha256=${generationRecordSha256}`);
  console.log(`provenanceSha256=${provenanceSha256}`);
  console.log(`expectedOutcomesSha256=${expectedOutcomesSha256}`);
}

// ─── Mode 2: Full verification (default) ──────────────────────────────

function runVerify(referenceDir, fixtureDir) {
  const excludeLiveSmoke = process.argv.slice(2).includes('--exclude-live-smoke');

  // ── 1. Load approved references (validates schemas, review, hashes,
  //      prompt-ledger consistency) ─────────────────────────────────
  let refSet;
  try {
    refSet = loadApprovedReferences(referenceDir);
  } catch (err) {
    if (err instanceof ReferenceFormatError) {
      console.error(`ERROR: Reference loading failed: ${err.message}`);
      process.exit(1);
    }
    console.error(`ERROR: Unexpected error loading references: ${err.message}`);
    process.exit(1);
  }

  // Verify that all four review hashes match current files
  const dataDir = join(referenceDir, 'data');
  const review = refSet.review;

  // responses hash
  const computedResponsesHash = computeResponsesHash(dataDir);
  if (computedResponsesHash !== review.responsesSha256) {
    console.error(
      `ERROR: Response data hash mismatch: review expects ${review.responsesSha256}, ` +
        `computed ${computedResponsesHash}`,
    );
    process.exit(1);
  }

  // generation-record hash
  const genRecordPath = join(referenceDir, 'generation-record.json');
  if (!existsSync(genRecordPath)) {
    console.error('ERROR: generation-record.json not found');
    process.exit(1);
  }
  const computedGenHash = fileSha256(genRecordPath).hex;
  if (computedGenHash !== review.generationRecordSha256) {
    console.error(
      `ERROR: generation-record.json hash mismatch: review expects ${review.generationRecordSha256}, ` +
        `computed ${computedGenHash}`,
    );
    process.exit(1);
  }

  // provenance hash
  const provenancePath = join(referenceDir, 'provenance.json');
  const computedProvHash = fileSha256(provenancePath).hex;
  if (computedProvHash !== review.provenanceSha256) {
    console.error(
      `ERROR: Provenance hash mismatch: review expects ${review.provenanceSha256}, ` +
        `computed ${computedProvHash}`,
    );
    process.exit(1);
  }

  // expected-outcomes hash
  const outcomesPath = join(referenceDir, 'expected-outcomes.json');
  const computedOutHash = fileSha256(outcomesPath).hex;
  if (computedOutHash !== review.expectedOutcomesSha256) {
    console.error(
      `ERROR: Expected-outcomes hash mismatch: review expects ${review.expectedOutcomesSha256}, ` +
        `computed ${computedOutHash}`,
    );
    process.exit(1);
  }

  // ── 2. Collect L1+L2 issue identities and compare with approved ──
  let actualIdentities;
  try {
    actualIdentities = collectReferenceIssueIdentities(fixtureDir, refSet.references);
  } catch (err) {
    console.error(`ERROR: Failed to collect reference issue identities: ${err.message}`);
    process.exit(1);
  }

  const approvedIdentities = refSet.expectedIssues;

  const actualKeySet = new Set(actualIdentities.map(identityKey));
  const approvedKeySet = new Set(approvedIdentities.map(identityKey));

  const missing = [];
  const unexpected = [];

  for (const id of approvedIdentities) {
    if (!actualKeySet.has(identityKey(id))) {
      missing.push(id);
    }
  }
  for (const id of actualIdentities) {
    if (!approvedKeySet.has(identityKey(id))) {
      unexpected.push(id);
    }
  }

  if (missing.length > 0 || unexpected.length > 0) {
    // Special case: empty approved list is valid only when actual is also empty
    // and review notes contain the literal "approved empty outcome set"
    if (
      approvedIdentities.length === 0 &&
      actualIdentities.length === 0 &&
      refSet.review.notes.includes('approved empty outcome set')
    ) {
      // Allowed
    } else {
      if (missing.length > 0) {
        console.error(`ERROR: Missing ${missing.length} expected identities:`);
        for (const id of missing) {
          console.error(`  ${idStr(id)}`);
        }
      }
      if (unexpected.length > 0) {
        console.error(`ERROR: ${unexpected.length} unexpected identities:`);
        for (const id of unexpected) {
          console.error(`  ${idStr(id)}`);
        }
      }
      process.exit(1);
    }
  }

  // Report identity summary
  console.log(`Approved identities: ${approvedIdentities.length}`);
  console.log(`Actual identities: ${actualIdentities.length}`);
  console.log(`Missing: ${missing.length}`);
  console.log(`Unexpected: ${unexpected.length}`);

  // ── 3. Validate review.json metadata ─────────────────────────────
  if (review.version !== 1) {
    console.error('ERROR: review.json version must be 1');
    process.exit(1);
  }
  if (review.decision !== 'approved') {
    console.error('ERROR: review.json decision must be "approved"');
    process.exit(1);
  }
  if (typeof review.reviewer !== 'string' || review.reviewer.length === 0) {
    console.error('ERROR: review.json reviewer must be a non-empty string');
    process.exit(1);
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(review.reviewedAt)) {
    console.error('ERROR: review.json reviewedAt must be ISO-8601 datetime');
    process.exit(1);
  }
  if (typeof review.notes !== 'string' || review.notes.trim().length === 0) {
    console.error('ERROR: review.json notes must be non-empty');
    process.exit(1);
  }
  for (const field of [
    'responsesSha256',
    'generationRecordSha256',
    'provenanceSha256',
    'expectedOutcomesSha256',
  ]) {
    if (!is64hex(review[field])) {
      console.error(`ERROR: review.json.${field} must be 64 lowercase hex`);
      process.exit(1);
    }
  }

  // ── 4. Validate live-smoke-record.json (optional) ────────────────
  if (!excludeLiveSmoke) {
    const livePath = join(referenceDir, 'live-smoke-record.json');
    if (existsSync(livePath)) {
      validateLiveSmokeRecord(livePath, review);
    } else {
      console.log('live-smoke-record.json not present — skipping live smoke validation');
    }
  }

  console.log('\nStage 1 acceptance verification: PASSED');
}

// ─── Live smoke record validator ──────────────────────────────────────

function validateLiveSmokeRecord(livePath, review) {
  const raw = parseJson(livePath);

  // Schema validation
  const parsed = liveSmokeRecordSchema.safeParse(raw);
  if (!parsed.success) {
    const reasons = parsed.error.issues.map((i) => i.message).join('; ');
    console.error(`ERROR: live-smoke-record.json schema validation failed: ${reasons}`);
    process.exit(1);
  }

  const record = parsed.data;

  // ── 4a. reviewStatus cannot be 'failed' for a valid record ──────
  if (record.reviewStatus !== 'candidate' && record.reviewStatus !== 'approved') {
    console.error('ERROR: live-smoke-record reviewStatus must be "candidate" or "approved"');
    process.exit(1);
  }

  // ── 4b. Must be a second run after the first review ─────────────
  if (new Date(record.generatedAt) <= new Date(review.reviewedAt)) {
    console.error('ERROR: live-smoke-record generatedAt must be later than review.reviewedAt');
    process.exit(1);
  }

  // ── 4c. Exactly E0–E6, no cache hits, 7 misses ──────────────────
  const eventIds = record.events;
  const expectedSet = new Set(EXPECTED_EVENT_IDS);
  if (eventIds.length !== expectedSet.size || !eventIds.every((id) => expectedSet.has(id))) {
    console.error('ERROR: live-smoke-record events must be exactly E0–E6');
    console.error(`  Found: [${eventIds.join(', ')}]`);
    process.exit(1);
  }

  if (record.cache.hits !== 0) {
    console.error(`ERROR: live-smoke-record cache.hits must be 0, got ${record.cache.hits}`);
    process.exit(1);
  }
  if (record.cache.misses !== 7) {
    console.error(`ERROR: live-smoke-record cache.misses must be 7, got ${record.cache.misses}`);
    process.exit(1);
  }

  // ── 4d. Every event released with non-empty analysis ──────────────
  const perEventMap = new Map(record.call.perEvent.map((e) => [e.eventId, e]));
  for (const eventId of EXPECTED_EVENT_IDS) {
    if (!perEventMap.has(eventId)) {
      console.error(`ERROR: live-smoke-record missing call entry for ${eventId}`);
      process.exit(1);
    }
  }

  // Find matching events in hashes
  const hashByEvent = new Map(record.hashes.events.map((e) => [e.eventId, e]));
  for (const eventId of EXPECTED_EVENT_IDS) {
    if (!hashByEvent.has(eventId)) {
      console.error(`ERROR: live-smoke-record missing hash entry for ${eventId}`);
      process.exit(1);
    }
    const h = hashByEvent.get(eventId);

    // proseHash and analysisHash must be 64 hex
    if (!is64hex(h.proseHash)) {
      console.error(`ERROR: live-smoke-record ${eventId} proseHash is not 64 lowercase hex`);
      process.exit(1);
    }
    if (!is64hex(h.analysisHash)) {
      console.error(`ERROR: live-smoke-record ${eventId} analysisHash is not 64 lowercase hex`);
      process.exit(1);
    }
    if (!is64hex(h.promptHash)) {
      console.error(`ERROR: live-smoke-record ${eventId} promptHash is not 64 lowercase hex`);
      process.exit(1);
    }
  }

  // ── 4e. At least one successful Pass 1 and Pass 2 per event ──────
  for (const eventId of EXPECTED_EVENT_IDS) {
    const ev = perEventMap.get(eventId);
    const ledger = ev.ledger;

    if (ledger.length === 0) {
      console.error(`ERROR: live-smoke-record ${eventId} has empty ledger`);
      process.exit(1);
    }

    const hasPass1Success = ledger.some((e) => e.phase === 'pass1' && e.outcome === 'success');
    const hasPass2Success = ledger.some((e) => e.phase === 'pass2' && e.outcome === 'success');

    if (!hasPass1Success) {
      console.error(`ERROR: live-smoke-record ${eventId} missing successful pass1`);
      process.exit(1);
    }
    if (!hasPass2Success) {
      console.error(`ERROR: live-smoke-record ${eventId} missing successful pass2`);
      process.exit(1);
    }

    // Verify all Pass 2 seeds equal record.seed
    for (const entry of ledger) {
      if (entry.phase === 'pass2' && entry.seed !== record.seed) {
        console.error(
          `ERROR: live-smoke-record ${eventId} pass2 seed ${entry.seed} does not match ` +
            `record seed ${record.seed}`,
        );
        process.exit(1);
      }
    }

    // Verify all ledger models equal record.model
    for (const entry of ledger) {
      if (entry.model !== record.model) {
        console.error(
          `ERROR: live-smoke-record ${eventId} ledger model "${entry.model}" does not ` +
            `match record model "${record.model}"`,
        );
        process.exit(1);
      }
    }

    // Verify prompt hash recomputable from ledger
    const computedPH = computePromptHash(
      ledger.map((e) => ({
        phase: e.phase,
        attempt: e.attempt,
        requestHash: e.requestHash,
        model: e.model,
        seed: e.seed,
      })),
    );
    const recordPH = hashByEvent.get(eventId).promptHash;
    if (computedPH !== recordPH) {
      console.error(
        `ERROR: live-smoke-record ${eventId} promptHash mismatch: ` +
          `computed=${computedPH}, record=${recordPH}`,
      );
      process.exit(1);
    }
  }

  // ── 4f. Positive totalCalls ──────────────────────────────────────
  if (record.call.totalCalls <= 0) {
    console.error(
      `ERROR: live-smoke-record totalCalls must be positive, got ${record.call.totalCalls}`,
    );
    process.exit(1);
  }

  // ── 4g. No failures ──────────────────────────────────────────────
  if (record.failures.length > 0) {
    // Print only the count and IDs — never raw failure strings
    console.error(`ERROR: live-smoke-record has ${record.failures.length} failures`);
    process.exit(1);
  }

  console.log('Live smoke record validation: PASSED');
}

// ─── Entry point ──────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const printHashes = args.includes('--print-reference-hashes');
  const projectName = args.find((a) => !a.startsWith('--')) || 'zhu-fu';
  const fixtureDir = join(rootDir, 'fixtures', projectName);
  const referenceDir = join(fixtureDir, 'reference');

  if (!existsSync(referenceDir)) {
    console.error(`ERROR: Reference directory not found: ${referenceDir}`);
    process.exit(1);
  }

  if (printHashes) {
    runHashPrint(referenceDir);
  } else {
    runVerify(referenceDir, fixtureDir);
  }
}

// Run
main();
