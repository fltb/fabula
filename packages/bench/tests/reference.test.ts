import { createHash, randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type {
  CoreRuntimeServices,
  IdGenerator,
  LLMProvider,
  PromptTemplateCatalog,
} from '@novalistically/core';
import { renderNovel } from '@novalistically/core/editorial';
import {
  MemoryExecutionRepository,
  MemoryRenderCacheRepository,
  MemoryStateLogRepository,
  MemoryStateSnapshotRepository,
} from '@novalistically/core/testing';
import { liveSmokeRecordSchema } from '@novalistically/core/tooling';
import { FileProjectSourceLoader } from '@novalistically/node-host';
import { describe, expect, it } from 'vitest';
import { loadApprovedReferences } from '../src/reference.ts';

// ─── Constants ──────────────────────────────────────────────────────────

const H64_A = 'a'.repeat(64);
const H64_B = 'b'.repeat(64);
const H64_BAD = '0'.repeat(64);
const EVENT_IDS = ['E0', 'E1', 'E2', 'E3', 'E4', 'E5', 'E6'];

// ─── Helpers (replicate private functions from reference.ts) ────────────

function sha256hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Canonical JSON — arrays preserve order, object keys sorted, undefined omitted. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** Compute responses hash: ordered `E0.json\0<bytes>…E6.json\0<bytes>`. */
function computeResponseHash(dataDir: string, eventIds: readonly string[] = EVENT_IDS): string {
  const hash = createHash('sha256');
  for (const eventId of eventIds) {
    const content = readFileSync(join(dataDir, `${eventId}.json`));
    hash.update(`${eventId}.json`);
    hash.update(Buffer.from([0]));
    hash.update(content);
  }
  return hash.digest('hex');
}

/** Compute promptHash from an ordered array of ledger entry projections. */
function computePromptHash(
  ledger: Array<{
    phase: string;
    attempt: number;
    requestHash: string;
    model: string;
    seed: number | null;
  }>,
): string {
  return sha256hex(
    canonicalJson(
      ledger.map(({ phase, attempt, requestHash, model, seed }) => ({
        phase,
        attempt,
        requestHash,
        model,
        seed,
      })),
    ),
  );
}

// ─── Fixture builders ──────────────────────────────────────────────────

const MIN_ANALYSIS_CONTENT = {
  postconditions: { covered: [] as string[], dropped: [] as string[] },
  preconditions: {
    violated: [] as Array<{
      entityId: string;
      attribute: string;
      expectedValue: string;
      issue: string;
    }>,
  },
  pov: { consistent: true as const, leaks: [] as string[] },
  inventedDetails: [] as Array<{ detail: string; severity: 'minor' | 'major' }>,
  quality: {
    proseScore: 85,
    maxScore: 100,
    strengths: [] as string[],
    weaknesses: [] as string[],
    estimatedWordCount: 200,
  },
  threadProgressAchieved: [] as string[],
  foreshadowingDeployed: [] as string[],
  narrativeChecks: [] as Array<{
    entityId: string;
    attribute: string;
    matchLevel: 'exact' | 'similar' | 'absent' | 'contradicted';
    evidence: string;
  }>,
  appearanceChecks: [] as Array<{
    entityId: string;
    feature: string;
    declared: string;
    evidence: string;
    matchLevel: 'exact' | 'similar' | 'absent' | 'contradicted';
  }>,
  characterReferences: [] as Array<{ entityId: string; namesUsed: string[] }>,
  tenseDetected: 'past' as const,
  conflictAnalysis: { primaryType: '' as string, resolutionAchieved: false as boolean },
  ruleChecks: [] as Array<{ ruleId: string; satisfied: boolean; evidence: string }>,
  knowledgeChecks: [] as Array<{
    entityId: string;
    propositionId: string;
    matchLevel: 'exact' | 'similar' | 'absent' | 'contradicted';
    evidence: string;
  }>,
};

function makeAnalysis(eventId: string, prose: string) {
  const content = { ...MIN_ANALYSIS_CONTENT };
  // Every active analysis field carries exactly one produced observation with
  // an exact prose quote, per the current AnalysisResult contract.
  const quote = prose.trim().slice(0, 24) || prose;
  const observations: Record<string, unknown> = {};
  for (const field of Object.keys(content)) {
    observations[field] = { disposition: 'produced', evidence: [quote] };
  }
  return {
    eventId,
    protocol: {
      proseHash: sha256hex(prose),
      analysisSchema: 'stage1-v1',
      model: 'deepseek-v4-flash',
      provider: 'ai-sdk',
      analysisPromptHash: H64_A,
      samplingConfigHash: H64_B,
      validatorPolicy: 'stage1-policy-v1',
      referencePolicy: 'stage1-ref-v1',
    },
    observations,
    analysis: content,
  };
}

function makeMetadata(
  eventId: string,
  promptHash: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    eventId,
    provider: 'ai-sdk',
    model: 'deepseek-v4-flash',
    seed: 42,
    promptVersion: 'stage1-v1',
    promptHash,
    analysisSchemaVersion: 1,
    fixtureFormatVersion: 1,
    generatedAt: '2026-07-20T00:00:00.000Z',
    reviewStatus: 'approved' as const,
    attempts: 2,
    errors: [] as string[],
    ...overrides,
  };
}

/** Standard two-call ledger used for every event in basic fixtures. */
const BASIC_LEDGER = [
  {
    phase: 'pass1' as const,
    attempt: 1,
    outcome: 'success' as const,
    requestHash: H64_A,
    model: 'deepseek-v4-flash',
    seed: null,
  },
  {
    phase: 'pass2' as const,
    attempt: 1,
    outcome: 'success' as const,
    requestHash: H64_B,
    model: 'deepseek-v4-flash',
    seed: 42,
  },
];

const BASIC_PROMPT_HASH = computePromptHash(BASIC_LEDGER);

function makeEventBody(eventId: string, overrides: Record<string, unknown> = {}) {
  const prose = `Generated mock prose for ${eventId}.`;
  return {
    prose,
    analysis: makeAnalysis(eventId, prose),
    metadata: makeMetadata(eventId, BASIC_PROMPT_HASH, overrides),
  };
}

function makeProvenance(opts: { runHash?: string; entries?: unknown[] } = {}) {
  const runHash = opts.runHash ?? H64_A;
  return {
    version: 1,
    entries:
      opts.entries ??
      EVENT_IDS.map((eid) => ({ eventId: eid, kind: 'generated' as const, runHash })),
  };
}

function makeOutcomes(issues: Array<Record<string, unknown>> = []) {
  return { version: 1, issues };
}

function makeGenerationRecord(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    provider: 'ai-sdk',
    model: 'deepseek-v4-flash',
    seed: 42,
    events: [...EVENT_IDS],
    system: { nodeVersion: 'v24.0.0', os: 'linux', arch: 'x64' },
    versions: { code: '0.1.0', fixture: '1', schema: 1, prompt: '1', capability: '1' },
    command: 'node packages/bench/scripts/generate-reference.mjs zhu-fu',
    call: {
      perEvent: EVENT_IDS.map((eid) => ({
        eventId: eid,
        ledger: BASIC_LEDGER.map((e) => ({ ...e })),
      })),
      totalCalls: 14,
    },
    cache: { hits: 0, misses: 7 },
    failures: [],
    hashes: {
      events: EVENT_IDS.map((eid) => ({
        eventId: eid,
        proseHash: H64_A,
        analysisHash: H64_B,
        promptHash: BASIC_PROMPT_HASH,
      })),
    },
    generatedAt: '2026-07-20T00:00:00.000Z',
    reviewStatus: 'candidate',
    ...overrides,
  };
}

function makeReview(
  responsesSha256: string,
  generationRecordSha256: string,
  provenanceSha256: string,
  expectedOutcomesSha256: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    version: 1,
    reviewer: 'test-reviewer',
    reviewedAt: '2026-07-20T12:00:00.000Z',
    decision: 'approved',
    notes: 'Test review for unit tests.',
    responsesSha256,
    generationRecordSha256,
    provenanceSha256,
    expectedOutcomesSha256,
    ...overrides,
  };
}

// ─── createTempReference ──────────────────────────────────────────────

/**
 * Create a temporary reference directory with completely consistent fixtures.
 * Writes data/E0–E6.json, provenance.json, expected-outcomes.json,
 * generation-record.json, and review.json with correct SHA-256 hashes
 * throughout.  Returns the temp directory path.
 */
function createTempReference(
  overrides: {
    /** Per-event raw body overrides (key = eventId, value = the entire JSON body). */
    events?: Record<string, unknown>;
    /** Per-event metadata overrides (key = eventId, value = metadata overrides). */
    eventOverrides?: Record<string, Record<string, unknown>>;
    /** Additional files to write into data/ (e.g. `['E7.json']`). */
    extraFiles?: string[];
    /** Event IDs to skip entirely. */
    missingEvents?: string[];
    /** Full provenance content. */
    provenance?: unknown;
    /** Full expected-outcomes content. */
    outcomes?: unknown;
    /** Full generation-record content (applied on top of defaults). */
    generationRecord?: Record<string, unknown>;
    /** review.json field overrides (applied on top of computed values). */
    review?: Record<string, unknown>;
  } = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), 'ref-test-'));
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });

  const skipEvents = new Set(overrides.missingEvents ?? []);
  const writtenEventIds = EVENT_IDS.filter((id) => !skipEvents.has(id));

  // Pick which events to write via raw body or via metadata overrides
  const rawEventBodies = overrides.events ?? {};
  const metaOverrides = overrides.eventOverrides ?? {};

  for (const eventId of writtenEventIds) {
    if (rawEventBodies[eventId] !== undefined) {
      writeFileSync(join(dataDir, `${eventId}.json`), JSON.stringify(rawEventBodies[eventId]));
    } else {
      writeFileSync(
        join(dataDir, `${eventId}.json`),
        JSON.stringify(makeEventBody(eventId, metaOverrides[eventId] ?? {})),
      );
    }
  }

  // Extra files
  for (const name of overrides.extraFiles ?? []) {
    writeFileSync(join(dataDir, name), '{}');
  }

  // Write generation-record first (its hash is needed for provenance runHash)
  const genFinal = overrides.generationRecord ?? {};
  const generationRecord = makeGenerationRecord(genFinal);
  const genBytes = Buffer.from(JSON.stringify(generationRecord));
  writeFileSync(join(dir, 'generation-record.json'), genBytes);
  const genHash = sha256hex(genBytes);

  // Write provenance — ensure runHash matches gen-record hash
  let provData: unknown;
  if (overrides.provenance !== undefined) {
    provData = overrides.provenance;
    // Fix up runHash on generated entries when it's the test-default placeholder,
    // preserving intentional mismatches where the caller chose a different value.
    const raw = provData as Record<string, unknown>;
    if (raw && typeof raw === 'object' && Array.isArray(raw.entries)) {
      raw.entries = raw.entries.map((e: Record<string, unknown>) => {
        if (e.kind === 'generated' && e.runHash === H64_A) {
          return { ...e, runHash: genHash };
        }
        return e;
      });
    }
  } else {
    provData = makeProvenance({ runHash: genHash });
  }
  writeFileSync(join(dir, 'provenance.json'), JSON.stringify(provData));

  // Write expected-outcomes
  writeFileSync(
    join(dir, 'expected-outcomes.json'),
    JSON.stringify(overrides.outcomes ?? makeOutcomes()),
  );

  // Compute hashes
  const responsesSha256 =
    writtenEventIds.length === EVENT_IDS.length
      ? computeResponseHash(dataDir, EVENT_IDS)
      : computeResponseHash(dataDir, writtenEventIds);
  const provBytes = readFileSync(join(dir, 'provenance.json'));
  const provHash = sha256hex(provBytes);
  const outBytes = readFileSync(join(dir, 'expected-outcomes.json'));
  const outHash = sha256hex(outBytes);

  // Write review
  writeFileSync(
    join(dir, 'review.json'),
    JSON.stringify(makeReview(responsesSha256, genHash, provHash, outHash, overrides.review ?? {})),
  );

  return dir;
}

// ─── Tests: approved zhu-fu references ─────────────────────────────────

describe('approved zhu-fu references', () => {
  it('loads exactly E0–E6 with metadata and provenance', () => {
    const dir = createTempReference();
    const set = loadApprovedReferences(dir);
    expect([...set.references.keys()]).toEqual(EVENT_IDS);
    // Each entry carries provenanceKind
    for (const ref of set.references.values()) {
      expect(ref.provenanceKind).toBe('generated');
      expect(ref.metadata).toBeDefined();
      expect(ref.metadata.reviewStatus).toBe('approved');
    }
    // Expected issues present
    expect(Array.isArray(set.expectedIssues)).toBe(true);
    expect(set.provenance).toBeDefined();
    expect(set.provenance.version).toBe(1);
    expect(set.review).toBeDefined();
    expect(set.review.decision).toBe('approved');
    rmSync(dir, { recursive: true });
  });

  it('rejects references with extra data files', () => {
    const dir = createTempReference({ extraFiles: ['E7.json'] });
    expect(() => loadApprovedReferences(dir)).toThrow('exactly E0–E6');
    rmSync(dir, { recursive: true });
  });

  it('rejects references with missing data files', () => {
    const dir = createTempReference({ missingEvents: ['E3'] });
    expect(() => loadApprovedReferences(dir)).toThrow('exactly E0–E6');
    rmSync(dir, { recursive: true });
  });

  it('rejects references with non-approved reviewStatus', () => {
    const dir = createTempReference({
      eventOverrides: { E0: { reviewStatus: 'candidate' } },
    });
    expect(() => loadApprovedReferences(dir)).toThrow('reviewStatus "approved"');
    rmSync(dir, { recursive: true });
  });

  it('rejects references with secret-like metadata values', () => {
    const dir = createTempReference({
      eventOverrides: { E0: { provider: 'sk-12345' } },
    });
    expect(() => loadApprovedReferences(dir)).toThrow('secret');
    rmSync(dir, { recursive: true });
  });

  it('rejects references with missing provenance entry for an event', () => {
    const dir = createTempReference({
      provenance: {
        version: 1,
        entries: EVENT_IDS.filter((id) => id !== 'E6').map((eid) => ({
          eventId: eid,
          kind: 'generated',
          runHash: H64_A,
        })),
      },
    });
    expect(() => loadApprovedReferences(dir)).toThrow('Missing provenance');
    rmSync(dir, { recursive: true });
  });

  it('rejects references with provenance missing runHash for generated kind', () => {
    // Omitting runHash makes provenance schema-invalid
    const dir = createTempReference({
      provenance: {
        version: 1,
        entries: EVENT_IDS.map((eid) =>
          eid === 'E6'
            ? { eventId: eid, kind: 'generated' }
            : { eventId: eid, kind: 'generated', runHash: H64_A },
        ),
      },
    });
    expect(() => loadApprovedReferences(dir)).toThrow();
    rmSync(dir, { recursive: true });
  });

  it('rejects references with structurally invalid provenance', () => {
    const dir = createTempReference({
      provenance: { version: 1, entries: 'not-an-array' },
    });
    expect(() => loadApprovedReferences(dir)).toThrow('invalid');
    rmSync(dir, { recursive: true });
  });

  it('rejects references with structurally invalid expected-outcomes', () => {
    const dir = createTempReference({
      outcomes: { version: 'one', issues: null },
    });
    expect(() => loadApprovedReferences(dir)).toThrow('invalid');
    rmSync(dir, { recursive: true });
  });

  it('rejects reference response with invalid structure', () => {
    const dir = createTempReference({
      events: { E0: { invalidField: true } },
    });
    expect(() => loadApprovedReferences(dir)).toThrow('invalid');
    rmSync(dir, { recursive: true });
  });

  it('rejects references with duplicate expected outcome identities', () => {
    // Two identities sharing the same 6-field key even though they would
    // differ in message/order if messages existed — proves identity
    // matching ignores everything beyond the six fields.
    const dir = createTempReference({
      outcomes: {
        version: 1,
        issues: [
          { validator: 'scene', eventId: 'E0', category: 'structural', severity: 'error' },
          { validator: 'scene', eventId: 'E0', category: 'structural', severity: 'error' },
        ],
      },
    });
    expect(() => loadApprovedReferences(dir)).toThrow('Duplicate issue identity');
    rmSync(dir, { recursive: true });
  });

  it('rejects references with placeholder model "unknown"', () => {
    const dir = createTempReference({
      eventOverrides: { E0: { model: 'unknown' } },
    });
    expect(() => loadApprovedReferences(dir)).toThrow('placeholder model "unknown"');
    rmSync(dir, { recursive: true });
  });

  it('rejects references with placeholder promptHash "reviewed"', () => {
    const dir = createTempReference({
      eventOverrides: { E0: { promptHash: 'reviewed' } },
    });
    expect(() => loadApprovedReferences(dir)).toThrow('placeholder promptHash "reviewed"');
    rmSync(dir, { recursive: true });
  });

  it('rejects references where response data hash does not match review', () => {
    const dir = createTempReference({
      review: { responsesSha256: H64_BAD },
    });
    expect(() => loadApprovedReferences(dir)).toThrow('hash mismatch');
    rmSync(dir, { recursive: true });
  });

  it('rejects references where provenance hash does not match review', () => {
    const dir = createTempReference({
      review: { provenanceSha256: H64_BAD },
    });
    expect(() => loadApprovedReferences(dir)).toThrow('hash mismatch');
    rmSync(dir, { recursive: true });
  });

  it('rejects references where generation-record hash does not match review', () => {
    const dir = createTempReference({
      review: { generationRecordSha256: H64_BAD },
    });
    expect(() => loadApprovedReferences(dir)).toThrow('SHA-256 mismatch');
    rmSync(dir, { recursive: true });
  });

  it('rejects references where expected-outcomes hash does not match review', () => {
    const dir = createTempReference({
      review: { expectedOutcomesSha256: H64_BAD },
    });
    expect(() => loadApprovedReferences(dir)).toThrow('hash mismatch');
    rmSync(dir, { recursive: true });
  });

  it('rejects references with provenance runHash not matching generation-record SHA-256', () => {
    // The generation-record is written with its real SHA-256, but we force
    // provenance entries to use a different runHash via the override.
    const dir = createTempReference({
      provenance: makeProvenance({ runHash: H64_B }),
    });
    expect(() => loadApprovedReferences(dir)).toThrow('does not match generation-record');
    rmSync(dir, { recursive: true });
  });

  it('accepts references with valid source_quotation provenance', () => {
    const dir = createTempReference({
      provenance: {
        version: 1,
        entries: EVENT_IDS.map((eid) => ({
          eventId: eid,
          kind: 'source_quotation',
          edition: '1st',
          url: 'https://example.com/source',
          rights: 'public domain',
          sourceHash: H64_A,
          overlap: { start: 0, end: 10, hash: H64_B },
        })),
      },
    });
    const set = loadApprovedReferences(dir);
    for (const ref of set.references.values()) {
      expect(ref.provenanceKind).toBe('source_quotation');
    }
    rmSync(dir, { recursive: true });
  });

  it('rejects references missing review.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ref-test-'));
    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(join(dir, 'data/E0.json'), JSON.stringify(makeEventBody('E0')));
    expect(() => loadApprovedReferences(dir)).toThrow('Missing review.json');
    rmSync(dir, { recursive: true });
  });

  it('rejects references with invalid review decision', () => {
    const dir = createTempReference({
      review: { decision: 'rejected' },
    });
    expect(() => loadApprovedReferences(dir)).toThrow('decision must be "approved"');
    rmSync(dir, { recursive: true });
  });

  it('rejects references with non-64-hex review hashes', () => {
    const dir = createTempReference({
      review: { responsesSha256: 'short-hash' },
    });
    expect(() => loadApprovedReferences(dir)).toThrow('64-character lowercase hex');
    rmSync(dir, { recursive: true });
  });

  it('rejects references with invalid expected-outcomes version', () => {
    const dir = createTempReference({
      outcomes: { version: 999, issues: [] },
    });
    expect(() => loadApprovedReferences(dir)).toThrow('invalid');
    rmSync(dir, { recursive: true });
  });
});

// ─── Tests: live smoke record schema (offline) ────────────────────

describe('live smoke record schema (offline)', () => {
  const validHash64 = 'a'.repeat(64);
  const validRecord = {
    version: 1,
    provider: 'ai-sdk',
    model: 'deepseek-v4-flash',
    seed: 42,
    events: ['E0', 'E1', 'E2', 'E3', 'E4', 'E5', 'E6'],
    system: {
      nodeVersion: 'v24.0.0',
      os: 'linux',
      arch: 'x64',
      cpu: '12th Gen Intel(R) Core(TM) i5-12400F',
    },
    versions: { code: '0.1.0', fixture: '1', schema: 1, prompt: '1', capability: '1' },
    command: 'node packages/bench/scripts/generate-reference.mjs zhu-fu',
    call: {
      perEvent: [
        {
          eventId: 'E0',
          ledger: [
            {
              phase: 'pass1',
              attempt: 1,
              outcome: 'success',
              requestHash: validHash64,
              model: 'deepseek-v4-flash',
              seed: null,
            },
            {
              phase: 'pass2',
              attempt: 1,
              outcome: 'success',
              requestHash: validHash64,
              model: 'deepseek-v4-flash',
              seed: 42,
            },
          ],
        },
        {
          eventId: 'E1',
          ledger: [
            {
              phase: 'pass1',
              attempt: 1,
              outcome: 'success',
              requestHash: validHash64,
              model: 'deepseek-v4-flash',
              seed: null,
            },
            {
              phase: 'pass2',
              attempt: 1,
              outcome: 'success',
              requestHash: validHash64,
              model: 'deepseek-v4-flash',
              seed: 42,
            },
          ],
        },
        {
          eventId: 'E2',
          ledger: [
            {
              phase: 'pass1',
              attempt: 1,
              outcome: 'success',
              requestHash: validHash64,
              model: 'deepseek-v4-flash',
              seed: null,
            },
            {
              phase: 'pass2',
              attempt: 1,
              outcome: 'success',
              requestHash: validHash64,
              model: 'deepseek-v4-flash',
              seed: 42,
            },
          ],
        },
        {
          eventId: 'E3',
          ledger: [
            {
              phase: 'pass1',
              attempt: 1,
              outcome: 'success',
              requestHash: validHash64,
              model: 'deepseek-v4-flash',
              seed: null,
            },
            {
              phase: 'pass2',
              attempt: 1,
              outcome: 'success',
              requestHash: validHash64,
              model: 'deepseek-v4-flash',
              seed: 42,
            },
          ],
        },
        {
          eventId: 'E4',
          ledger: [
            {
              phase: 'pass1',
              attempt: 1,
              outcome: 'success',
              requestHash: validHash64,
              model: 'deepseek-v4-flash',
              seed: null,
            },
            {
              phase: 'pass2',
              attempt: 1,
              outcome: 'success',
              requestHash: validHash64,
              model: 'deepseek-v4-flash',
              seed: 42,
            },
          ],
        },
        {
          eventId: 'E5',
          ledger: [
            {
              phase: 'pass1',
              attempt: 1,
              outcome: 'success',
              requestHash: validHash64,
              model: 'deepseek-v4-flash',
              seed: null,
            },
            {
              phase: 'pass2',
              attempt: 1,
              outcome: 'success',
              requestHash: validHash64,
              model: 'deepseek-v4-flash',
              seed: 42,
            },
          ],
        },
        {
          eventId: 'E6',
          ledger: [
            {
              phase: 'pass1',
              attempt: 1,
              outcome: 'success',
              requestHash: validHash64,
              model: 'deepseek-v4-flash',
              seed: null,
            },
            {
              phase: 'pass2',
              attempt: 1,
              outcome: 'success',
              requestHash: validHash64,
              model: 'deepseek-v4-flash',
              seed: 42,
            },
          ],
        },
      ],
      totalCalls: 14,
    },
    cache: { hits: 0, misses: 7 },
    failures: [],
    hashes: {
      events: [
        {
          eventId: 'E0',
          proseHash: validHash64,
          analysisHash: validHash64,
          promptHash: validHash64,
        },
        {
          eventId: 'E1',
          proseHash: validHash64,
          analysisHash: validHash64,
          promptHash: validHash64,
        },
        {
          eventId: 'E2',
          proseHash: validHash64,
          analysisHash: validHash64,
          promptHash: validHash64,
        },
        {
          eventId: 'E3',
          proseHash: validHash64,
          analysisHash: validHash64,
          promptHash: validHash64,
        },
        {
          eventId: 'E4',
          proseHash: validHash64,
          analysisHash: validHash64,
          promptHash: validHash64,
        },
        {
          eventId: 'E5',
          proseHash: validHash64,
          analysisHash: validHash64,
          promptHash: validHash64,
        },
        {
          eventId: 'E6',
          proseHash: validHash64,
          analysisHash: validHash64,
          promptHash: validHash64,
        },
      ],
    },
    reviewStatus: 'candidate',
    generatedAt: '2026-07-20T00:00:00.000Z',
  };

  it('validates a complete candidate record', () => {
    const result = liveSmokeRecordSchema.safeParse(validRecord);
    if (!result.success) {
      throw new Error(`Schema validation failed: ${JSON.stringify(result.error.issues)}`);
    }
    expect(result.success).toBe(true);
  });

  it('validates a failed record with reviewStatus:failed', () => {
    const failed = {
      ...validRecord,
      reviewStatus: 'failed' as const,
      failures: ['E3: release gate'],
    };
    const result = liveSmokeRecordSchema.safeParse(failed);
    expect(result.success).toBe(true);
    expect(result.data?.reviewStatus).toBe('failed');
  });

  it('rejects records with extra secret-like fields (redaction)', () => {
    const bad = { ...validRecord, apiKey: 'sk-12345', authHeader: 'Bearer xyz' };
    const result = liveSmokeRecordSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('rejects records missing required fields', () => {
    const result = liveSmokeRecordSchema.safeParse({ version: 1 });
    expect(result.success).toBe(false);
  });

  it('rejects empty provider', () => {
    const result = liveSmokeRecordSchema.safeParse({ ...validRecord, provider: '' });
    expect(result.success).toBe(false);
  });

  it('rejects empty model', () => {
    const result = liveSmokeRecordSchema.safeParse({ ...validRecord, model: '' });
    expect(result.success).toBe(false);
  });

  it('rejects non-array events', () => {
    const result = liveSmokeRecordSchema.safeParse({ ...validRecord, events: 'E0' });
    expect(result.success).toBe(false);
  });

  it('rejects negative totalCalls count', () => {
    const result = liveSmokeRecordSchema.safeParse({
      ...validRecord,
      call: { ...validRecord.call, totalCalls: -1 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid reviewStatus', () => {
    const result = liveSmokeRecordSchema.safeParse({ ...validRecord, reviewStatus: 'invalid' });
    expect(result.success).toBe(false);
  });

  it('accepts approved reviewStatus', () => {
    const result = liveSmokeRecordSchema.safeParse({ ...validRecord, reviewStatus: 'approved' });
    expect(result.success).toBe(true);
  });

  it('rejects non-datetime generatedAt', () => {
    const result = liveSmokeRecordSchema.safeParse({ ...validRecord, generatedAt: 'yesterday' });
    expect(result.success).toBe(false);
  });

  it('rejects records with empty events array', () => {
    const result = liveSmokeRecordSchema.safeParse({ ...validRecord, events: [] });
    expect(result.success).toBe(false);
  });
});

// ─── Tests: credential absence (offline) ──────────────────────────────

describe('credential absence (offline)', () => {
  it('renderNovel returns errors without API key in env', async () => {
    const previousApiKey = process.env.NOVALISTICALLY_AI_API_KEY;
    delete process.env.NOVALISTICALLY_AI_API_KEY;
    const projectDir = mkdtempSync(join(tmpdir(), 'nova-offline-provider-'));
    cpSync(resolve(__dirname, '../../../fixtures/zhu-fu'), projectDir, { recursive: true });
    rmSync(join(projectDir, '.nova'), { recursive: true, force: true });
    try {
      // Explicit semantic runtime with an unavailable provider — the bench
      // never constructs provider credentials; the pipeline must fail closed
      // with PROVIDER_REQUIRED before any real LLM call.
      const unavailableProvider: LLMProvider = {
        name: 'unavailable',
        complete: async () => {
          throw new Error('PROVIDER_REQUIRED: No provider or providerFactory configured');
        },
      };
      const ids: IdGenerator = { next: () => randomUUID() };
      const promptTemplates: PromptTemplateCatalog = { get: async () => null };
      const services: CoreRuntimeServices = {
        execution: new MemoryExecutionRepository(),
        renderCache: new MemoryRenderCacheRepository(),
        stateLog: new MemoryStateLogRepository(),
        stateSnapshots: new MemoryStateSnapshotRepository(),
        promptTemplates,
        clock: { now: () => new Date().toISOString() },
        ids,
        llm: unavailableProvider,
      };

      const source = new FileProjectSourceLoader().load(projectDir);
      const result = await renderNovel(
        {
          version: 1,
          source,
          model: 'test-model',
          selector: { type: 'all' },
          mutation: { operationId: randomUUID(), actorId: 'test' },
        },
        { services },
      );
      const allErrors = [
        ...result.errors,
        ...result.results.flatMap((r) => r.errors ?? []),
      ];
      expect(allErrors.some((error) => error.includes('PROVIDER_REQUIRED'))).toBe(true);
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.NOVALISTICALLY_AI_API_KEY;
      } else {
        process.env.NOVALISTICALLY_AI_API_KEY = previousApiKey;
      }
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
