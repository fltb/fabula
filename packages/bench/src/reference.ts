import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EntityMapper,
  InMemoryEntityRegistry,
  ResultAggregator,
  compileStoryBoundaries,
  expectedOutcomeManifestSchema,
  provenanceManifestSchema,
  ReferenceFormatError,
  responseReferenceSchema,
  type AnalysisResult,
  type Fact,
  type NarrativeEvent,
  type ProjectData,
  type Validator,
  type ValidationIssue,
} from '@novalistically/core';

/** Patterns that look like secrets in metadata values. */
const SECRET_VALUE_PATTERN = /(?:^|[^a-z])(?:sk-|api[_-]key|auth[_-]token|secret|password|credential)(?:$|[^a-z])/i;

const EXPECTED_EVENT_IDS = ['E0', 'E1', 'E2', 'E3', 'E4', 'E5', 'E6'];

/** 64-character lowercase hex pattern. */
const H64 = /^[0-9a-f]{64}$/;

// ─── Exported types ───────────────────────────────────────────────────

/** Typed metadata shape for an approved reference entry. */
interface ApprovedReferenceMeta {
  readonly eventId: string;
  readonly provider: string;
  readonly model: string;
  readonly seed: number;
  readonly promptVersion: string;
  readonly promptHash: string;
  readonly analysisSchemaVersion: number;
  readonly fixtureFormatVersion: number;
  readonly generatedAt: string;
  readonly reviewStatus: 'approved';
  readonly attempts: number;
  readonly errors: readonly string[];
}

export interface ApprovedReference {
  readonly prose: string;
  readonly analysis: AnalysisResult;
  readonly metadata: ApprovedReferenceMeta;
  readonly provenanceKind: 'generated' | 'source_quotation';
}

/**
 * The six-field identity used for exact deterministic matching.
 * Messages, order, and multiplicity never participate.
 */
export interface ValidatorIssueIdentity {
  validator: string;
  eventId: string;
  category: Validator['category'];
  entityId?: string;
  attribute?: string;
  severity: ValidationIssue['severity'];
}

/** Shape of the version-1 review.json file. */
export interface Stage1ReferenceReview {
  version: 1;
  reviewer: string;
  reviewedAt: string;
  decision: 'approved';
  notes: string;
  responsesSha256: string;
  generationRecordSha256: string;
  provenanceSha256: string;
  expectedOutcomesSha256: string;
}

/** Shape of the provenance manifest (read-only view). */
export interface ProvenanceManifest {
  version: number;
  entries: Array<{
    eventId: string;
    kind: 'generated' | 'source_quotation';
    runHash?: string;
    edition?: string;
    url?: string;
    rights?: string;
    sourceHash?: string;
    overlap?: { start: number; end: number; hash: string };
  }>;
}

/** The complete approved reference set returned by loadApprovedReferences. */
export interface ApprovedReferenceSet {
  references: Map<string, ApprovedReference>;
  expectedIssues: ValidatorIssueIdentity[];
  provenance: ProvenanceManifest;
  review: Stage1ReferenceReview;
}

// ─── Internal helpers ─────────────────────────────────────────────────

/** Check that a string is 64 hex chars. */
function is64hex(s: string): boolean {
  return H64.test(s);
}

/** Canonical JSON — arrays preserve order, plain-object keys sorted lexicographically, undefined members omitted. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Compute responses hash: ordered `E0.json\0<bytes>…E6.json\0<bytes>`. */
function computeResponsesHash(dataDir: string): string {
  const hash = createHash('sha256');
  for (const eventId of EXPECTED_EVENT_IDS) {
    const content = readFileSync(join(dataDir, `${eventId}.json`));
    hash.update(`${eventId}.json`);
    hash.update(Buffer.from([0]));
    hash.update(content);
  }
  return hash.digest('hex');
}

/** Recompute a promptHash from an ordered array of ledger entry projections. */
function computePromptHash(
  ledger: Array<{ phase: string; attempt: number; requestHash: string; model: string; seed: number | null }>,
): string {
  const projection = ledger.map(({ phase, attempt, requestHash, model, seed }) => ({
    phase,
    attempt,
    requestHash,
    model,
    seed,
  }));
  return createHash('sha256').update(canonicalJson(projection)).digest('hex');
}

// ─── Load and validate review.json ────────────────────────────────────

function loadReview(referenceDir: string): Stage1ReferenceReview {
  const reviewPath = join(referenceDir, 'review.json');
  if (!existsSync(reviewPath)) {
    throw new ReferenceFormatError('Missing review.json — required for closed reference set', { path: referenceDir });
  }

  let raw: ReturnType<typeof JSON.parse>;
  try {
    raw = JSON.parse(readFileSync(reviewPath, 'utf8'));
  } catch {
    throw new ReferenceFormatError('review.json is not valid JSON', { path: reviewPath });
  }

  if (typeof raw !== 'object' || raw === null) {
    throw new ReferenceFormatError('review.json must be a JSON object', { path: reviewPath });
  }

  // version
  if (raw.version !== 1) {
    throw new ReferenceFormatError('review.json version must be 1', { path: reviewPath });
  }

  // decision
  if (raw.decision !== 'approved') {
    throw new ReferenceFormatError('review.json decision must be "approved"', { path: reviewPath });
  }

  // Required string fields
  for (const field of ['reviewer', 'reviewedAt', 'notes'] as const) {
    if (typeof raw[field] !== 'string' || raw[field].length === 0) {
      throw new ReferenceFormatError(`review.json.${field} must be a non-empty string`, { path: reviewPath });
    }
  }

  // notes must be non-empty
  if (raw.notes.trim().length === 0) {
    throw new ReferenceFormatError('review.json.notes must be non-empty', { path: reviewPath });
  }

  // reviewedAt should be ISO-8601 format
  if (!/^\d{4}-\d{2}-\d{2}T/.test(raw.reviewedAt)) {
    throw new ReferenceFormatError('review.json.reviewedAt must be an ISO-8601 datetime', { path: reviewPath });
  }

  // Required hash fields — each must be exactly 64 lowercase hex chars
  const hashFields = ['responsesSha256', 'generationRecordSha256', 'provenanceSha256', 'expectedOutcomesSha256'] as const;
  for (const field of hashFields) {
    if (typeof raw[field] !== 'string' || !is64hex(raw[field])) {
      throw new ReferenceFormatError(
        `review.json.${field} must be a 64-character lowercase hex string`,
        { path: reviewPath },
      );
    }
  }

  return raw as Stage1ReferenceReview;
}

// ─── Load generation-record.json (first live run's smoke record) ─────

interface GenerationRecordEventLedger {
  eventId: string;
  ledger: Array<{
    phase: string;
    attempt: number;
    outcome: string;
    requestHash: string;
    model: string;
    seed: number | null;
    failureReason?: string;
  }>;
}

interface GenerationRecord {
  provider: string;
  model: string;
  seed: number;
  call: {
    perEvent: GenerationRecordEventLedger[];
  };
  hashes: {
    events: Array<{
      eventId: string;
      proseHash: string;
      analysisHash: string;
      promptHash: string;
    }>;
  };
}

function loadGenerationRecord(referenceDir: string, genHashFromReview: string): GenerationRecord {
  const genPath = join(referenceDir, 'generation-record.json');
  if (!existsSync(genPath)) {
    throw new ReferenceFormatError('Missing generation-record.json — required for closed reference set', {
      path: referenceDir,
    });
  }

  const genBytes = readFileSync(genPath);
  const actualHash = createHash('sha256').update(genBytes).digest('hex');
  if (actualHash !== genHashFromReview) {
    throw new ReferenceFormatError(
      `generation-record.json SHA-256 mismatch: review expects ${genHashFromReview}, computed ${actualHash}`,
      { path: genPath },
    );
  }

  let raw: GenerationRecord;
  try {
    raw = JSON.parse(genBytes.toString('utf8'));
  } catch {
    throw new ReferenceFormatError('generation-record.json is not valid JSON', { path: genPath });
  }

  // Basic structural validation
  if (typeof raw !== 'object' || raw === null) {
    throw new ReferenceFormatError('generation-record.json must be a JSON object', { path: genPath });
  }
  if (typeof raw.provider !== 'string' || raw.provider.length === 0) {
    throw new ReferenceFormatError('generation-record.json must have a non-empty provider', { path: genPath });
  }
  if (typeof raw.model !== 'string' || raw.model.length === 0) {
    throw new ReferenceFormatError('generation-record.json must have a non-empty model', { path: genPath });
  }
  if (typeof raw.seed !== 'number' || !Number.isInteger(raw.seed)) {
    throw new ReferenceFormatError('generation-record.json must have an integer seed', { path: genPath });
  }
  if (!raw.call || !Array.isArray(raw.call.perEvent)) {
    throw new ReferenceFormatError('generation-record.json must have call.perEvent array', { path: genPath });
  }
  if (!raw.hashes || !Array.isArray(raw.hashes.events)) {
    throw new ReferenceFormatError('generation-record.json must have hashes.events array', { path: genPath });
  }

  return raw;
}

// ─── Identity key for deduplication / ordered comparison ──────────────

function identityKey(id: ValidatorIssueIdentity): string {
  // Lexicographic sort key: validator, eventId, category, entityId-or-empty, attribute-or-empty, severity
  return `${id.validator}\x00${id.eventId}\x00${id.category}\x00${id.entityId ?? ''}\x00${id.attribute ?? ''}\x00${id.severity}`;
}

function compareIdentities(a: ValidatorIssueIdentity, b: ValidatorIssueIdentity): number {
  const ka = identityKey(a);
  const kb = identityKey(b);
  if (ka < kb) return -1;
  if (ka > kb) return 1;
  return 0;
}

function normalizeIssueIdentity(
  issue: ValidationIssue,
  aggregator: ResultAggregator,
): ValidatorIssueIdentity {
  return {
    validator: issue.validator,
    eventId: issue.event,
    category: aggregator.getValidatorCategory(issue.validator),
    entityId: issue.entity === 'system' ? undefined : issue.entity,
    attribute: issue.attribute,
    severity: issue.severity,
  };
}

// ─── Chapter lookup —──────────────────────────────────────────────────

function findChapterForEvent(data: ProjectData, eventId: string): number {
  for (const [ch, chapter] of data.chapters) {
    if (chapter.events.some((e) => e.event === eventId)) return ch;
  }
  return 1;
}

// ─── Initial facts (mirrors regression.ts initialFactsFor) ────────────

function initialFactsFor(registry: InMemoryEntityRegistry, genesis?: NarrativeEvent): Fact[] {
  return [
    ...(genesis?.postconditions ?? []),
    ...registry.getAll().flatMap((entity) =>
      Object.entries(entity.state ?? {}).map(([attribute, value]) => ({
        id: `${entity.id}.${attribute}`,
        entityId: entity.id,
        attribute,
        value,
        validity: {
          temporal: { start: { type: 'absolute' as const, value: 'day_0' }, end: null },
          branches: { type: 'all' as const },
        },
      })),
    ),
  ];
}

// ─── Public functions ─────────────────────────────────────────────────

/**
 * Load and validate a closed Stage-1 approved reference set, or fail closed
 * with a ReferenceFormatError on any contract violation.
 */
export function loadApprovedReferences(referenceDir: string): ApprovedReferenceSet {
  const dataDir = join(referenceDir, 'data');

  // ── 1. Load review.json and generation-record.json ──────────────
  const review = loadReview(referenceDir);
  const generationRecord = loadGenerationRecord(referenceDir, review.generationRecordSha256);

  // ── 2. Verify file set: exactly E0–E6 ───────────────────────────
  if (!existsSync(dataDir)) {
    throw new ReferenceFormatError('Reference data directory not found', { path: dataDir });
  }
  const files = readdirSync(dataDir).filter((file) => file.endsWith('.json')).sort();
  const expectedFiles = EXPECTED_EVENT_IDS.map((eid) => `${eid}.json`);
  if (JSON.stringify(files) !== JSON.stringify(expectedFiles)) {
    throw new ReferenceFormatError('Reference data must contain exactly E0–E6', { path: dataDir });
  }

  // ── 3. Verify response hashes match review ─────────────────────
  const computedResponsesHash = computeResponsesHash(dataDir);
  if (computedResponsesHash !== review.responsesSha256) {
    throw new ReferenceFormatError(
      `Response data hash mismatch: review expects ${review.responsesSha256}, computed ${computedResponsesHash}`,
      { path: dataDir },
    );
  }

  // ── 4. Load and validate provenance manifest ───────────────────
  const provenanceRaw = JSON.parse(readFileSync(join(referenceDir, 'provenance.json'), 'utf8'));
  const provenance = provenanceManifestSchema.safeParse(provenanceRaw);
  if (!provenance.success) {
    const reasons = provenance.error.issues.map((i) => i.message).join('; ');
    throw new ReferenceFormatError(`Provenance manifest is invalid: ${reasons}`, {
      path: join(referenceDir, 'provenance.json'),
    });
  }

  // Verify provenance SHA-256
  const provBytes = readFileSync(join(referenceDir, 'provenance.json'));
  const computedProvHash = createHash('sha256').update(provBytes).digest('hex');
  if (computedProvHash !== review.provenanceSha256) {
    throw new ReferenceFormatError(
      `Provenance hash mismatch: review expects ${review.provenanceSha256}, computed ${computedProvHash}`,
      { path: join(referenceDir, 'provenance.json') },
    );
  }

  // Validate provenance covers every expected event
  const provenanceByEvent = new Map(provenance.data.entries.map((e: { eventId: string; kind: string; runHash?: string }) => [e.eventId, e]));
  // Check for duplicate event IDs in provenance
  if (provenance.data.entries.length !== provenanceByEvent.size) {
    throw new ReferenceFormatError('Provenance manifest contains duplicate event IDs', {
      path: join(referenceDir, 'provenance.json'),
    });
  }

  for (const eventId of EXPECTED_EVENT_IDS) {
    const entry = provenanceByEvent.get(eventId);
    if (!entry) {
      throw new ReferenceFormatError(`Missing provenance entry for event ${eventId}`, {
        path: join(referenceDir, 'provenance.json'),
        eventId,
      });
    }
    if (entry.kind === 'generated') {
      if (!entry.runHash) {
        throw new ReferenceFormatError(`Provenance entry for ${eventId} must have runHash`, {
          path: join(referenceDir, 'provenance.json'),
          eventId,
        });
      }
      // runHash must be the full SHA-256 of generation-record bytes
      if (entry.runHash !== review.generationRecordSha256) {
        throw new ReferenceFormatError(
          `Provenance runHash for ${eventId} does not match generation-record SHA-256`,
          { path: join(referenceDir, 'provenance.json'), eventId },
        );
      }
    }
  }

  // ── 5. Load and validate expected-outcomes manifest ────────────
  const outcomesRaw = JSON.parse(readFileSync(join(referenceDir, 'expected-outcomes.json'), 'utf8'));
  const outcomes = expectedOutcomeManifestSchema.safeParse(outcomesRaw);
  if (!outcomes.success) {
    const reasons = outcomes.error.issues.map((i) => i.message).join('; ');
    throw new ReferenceFormatError(`Expected-outcomes manifest is invalid: ${reasons}`, {
      path: join(referenceDir, 'expected-outcomes.json'),
    });
  }

  // Verify expected-outcomes SHA-256
  const outBytes = readFileSync(join(referenceDir, 'expected-outcomes.json'));
  const computedOutHash = createHash('sha256').update(outBytes).digest('hex');
  if (computedOutHash !== review.expectedOutcomesSha256) {
    throw new ReferenceFormatError(
      `Expected-outcomes hash mismatch: review expects ${review.expectedOutcomesSha256}, computed ${computedOutHash}`,
      { path: join(referenceDir, 'expected-outcomes.json') },
    );
  }

  if (outcomes.data.version !== 1) {
    throw new ReferenceFormatError('Expected-outcomes manifest version must be 1', {
      path: join(referenceDir, 'expected-outcomes.json'),
    });
  }

  // Check for duplicate issue identities in the approved manifest
  const seenKeys = new Set<string>();
  for (const issue of outcomes.data.issues) {
    const key = identityKey(issue as ValidatorIssueIdentity);
    if (seenKeys.has(key)) {
      throw new ReferenceFormatError(
        `Duplicate issue identity in expected-outcomes manifest: ${key}`,
        { path: join(referenceDir, 'expected-outcomes.json') },
      );
    }
    seenKeys.add(key);
  }

  // Build ledger-by-event map from generation record
  const ledgerByEvent = new Map<string, GenerationRecordEventLedger>();
  for (const ev of generationRecord.call.perEvent) {
    if (!EXPECTED_EVENT_IDS.includes(ev.eventId)) continue; // skip non-reference events
    if (ledgerByEvent.has(ev.eventId)) {
      throw new ReferenceFormatError(
        `Duplicate event ${ev.eventId} in generation-record call.perEvent`,
        { path: join(referenceDir, 'generation-record.json') },
      );
    }
    ledgerByEvent.set(ev.eventId, ev);
  }

  // Build hash-by-event map from generation record
  const hashByEvent = new Map<string, GenerationRecord['hashes']['events'][0]>();
  for (const h of generationRecord.hashes.events) {
    hashByEvent.set(h.eventId, h);
  }

  // ── 6. Load and validate each response ─────────────────────────
  const references = new Map<string, ApprovedReference>();

  for (const eventId of EXPECTED_EVENT_IDS) {
    const eventPath = join(dataDir, `${eventId}.json`);
    const raw = JSON.parse(readFileSync(eventPath, 'utf8'));
    const parsed = responseReferenceSchema.safeParse(raw);
    if (!parsed.success) {
      const reasons = parsed.error.issues.map((i) => i.message).join('; ');
      throw new ReferenceFormatError(`Reference response is invalid: ${reasons}`, { path: eventPath, eventId });
    }

    // Business rule: only approved reviewStatus passes loading
    if (parsed.data.metadata.reviewStatus !== 'approved') {
      throw new ReferenceFormatError('Reference response must have reviewStatus "approved"', {
        path: eventPath,
        eventId,
      });
    }

    // Consistency: analysis eventId must match the file eventId
    if (parsed.data.analysis.eventId !== eventId) {
      throw new ReferenceFormatError('Reference response event ID mismatch', {
        path: eventPath,
        eventId,
      });
    }

    // Reject placeholder values
    if (parsed.data.metadata.model === 'unknown') {
      throw new ReferenceFormatError('Reference response uses placeholder model "unknown"', {
        path: eventPath,
        eventId,
      });
    }
    if (parsed.data.metadata.promptHash === 'reviewed') {
      throw new ReferenceFormatError('Reference response uses placeholder promptHash "reviewed"', {
        path: eventPath,
        eventId,
      });
    }

    // All hash values must be 64 lowercase hex
    for (const field of ['promptHash'] as const) {
      const val = parsed.data.metadata[field];
      if (!is64hex(val)) {
        throw new ReferenceFormatError(
          `Reference response metadata.${field} must be 64-character lowercase hex`,
          { path: eventPath, eventId },
        );
      }
    }

    // Double-check metadata values for secret-like patterns
    for (const [key, val] of Object.entries(parsed.data.metadata)) {
      if (typeof val === 'string' && SECRET_VALUE_PATTERN.test(val)) {
        throw new ReferenceFormatError(`Metadata field '${key}' contains a secret-like value`, {
          path: eventPath,
          eventId,
        });
      }
    }

    // ── Verify provider/model/seed consistency with generation record ──
    const genLedger = ledgerByEvent.get(eventId)!;
    if (!genLedger) {
      throw new ReferenceFormatError(
        `Event ${eventId} not found in generation-record call.perEvent`,
        { path: eventPath, eventId },
      );
    }

    // All ledger models must equal the response model
    for (const entry of genLedger.ledger) {
      if (entry.model !== parsed.data.metadata.model) {
        throw new ReferenceFormatError(
          `Ledger model "${entry.model}" for ${eventId} does not match response model "${parsed.data.metadata.model}"`,
          { path: eventPath, eventId },
        );
      }
    }

    // Seed: verify the response seed matches the generation-record top-level seed
    if (parsed.data.metadata.seed !== generationRecord.seed) {
      throw new ReferenceFormatError(
        `Response seed ${parsed.data.metadata.seed} for ${eventId} does not match generation-record seed ${generationRecord.seed}`,
        { path: eventPath, eventId },
      );
    }

    // Provider consistency: response provider must equal generation-record provider
    if (parsed.data.metadata.provider !== generationRecord.provider) {
      throw new ReferenceFormatError(
        `Response provider "${parsed.data.metadata.provider}" for ${eventId} does not match generation-record provider "${generationRecord.provider}"`,
        { path: eventPath, eventId },
      );
    }

    // ── Verify promptHash matches recomputed value from ledger ──
    const computedPH = computePromptHash(
      genLedger.ledger.map((e) => ({
        phase: e.phase,
        attempt: e.attempt,
        requestHash: e.requestHash,
        model: e.model,
        seed: e.seed,
      })),
    );
    const responsePH = parsed.data.metadata.promptHash;
    if (computedPH !== responsePH) {
      // Also check if it matches the generation-record's hashes.events promptHash
      const genHashEntry = hashByEvent.get(eventId);
      if (!genHashEntry || genHashEntry.promptHash !== responsePH) {
        throw new ReferenceFormatError(
          `Response promptHash for ${eventId} cannot be verified against generation-record ledger (computed=${computedPH}, response=${responsePH})`,
          { path: eventPath, eventId },
        );
      }
    }

    const provEntry = provenanceByEvent.get(eventId)!;
    references.set(eventId, {
      prose: parsed.data.prose,
      analysis: parsed.data.analysis as AnalysisResult,
      metadata: parsed.data.metadata as unknown as ApprovedReferenceMeta,
      provenanceKind: provEntry.kind as 'generated' | 'source_quotation',
    });
  }

  return {
    references,
    expectedIssues: outcomes.data.issues as ValidatorIssueIdentity[],
    provenance: provenance.data as unknown as ProvenanceManifest,
    review,
  };
}

/**
 * Collect the deterministic six-field issue identities from L1 (validate)
 * and L2 (validateRender) for every E0–E6 reference entry.
 * Excludes `system:genesis`. Chapter is derived from project data.
 * Returns a deduplicated, lexicographically-sorted array.
 */
export function collectReferenceIssueIdentities(
  fixturePath: string,
  references: ReadonlyMap<string, ApprovedReference>,
): ValidatorIssueIdentity[] {
  // ── 1. Load fixture data ────────────────────────────────────────
  const mapper = new EntityMapper(fixturePath);
  const projectData = mapper.loadProject();
  const registry = new InMemoryEntityRegistry();
  registry.load(fixturePath);
  const allEvents = mapper.loadAllEvents(projectData.chapters);
  const genesis = allEvents.find((e) => e.id === 'system:genesis');
  const narrativeEvents = allEvents.filter((e) => e.id !== 'system:genesis');

  // ── 2. Compile story boundaries ─────────────────────────────────
  const boundaries = compileStoryBoundaries(
    narrativeEvents,
    initialFactsFor(registry, genesis),
    new Map((projectData.timeAnchors ?? []).map((a) => [a.id, a.day])),
  );

  const stateBeforeByEventId = boundaries.stateBeforeByEventId;
  const aggregator = new ResultAggregator();

  // Build chapter-by-event lookup
  const chapterByEventId = new Map<string, number>();
  for (const evt of narrativeEvents) {
    chapterByEventId.set(evt.id, findChapterForEvent(projectData, evt.id));
  }

  // Build event-by-id lookup
  const eventById = new Map(allEvents.map((e) => [e.id, e]));

  const allIdentities: ValidatorIssueIdentity[] = [];

  for (const [eventId, ref] of references) {
    const event = eventById.get(eventId);
    if (!event) continue;

    const stateBefore = stateBeforeByEventId.get(eventId);
    if (!stateBefore) continue;

    const chapter = chapterByEventId.get(eventId) ?? 1;

    // L1: validate
    const l1Result = aggregator.validate(event, stateBefore, registry, narrativeEvents, chapter);
    const l1Issues = [...l1Result.errors, ...l1Result.warnings, ...l1Result.infos];

    // L2: validateRender
    const l2Result = aggregator.validateRender(
      ref.prose,
      event,
      stateBefore,
      ref.analysis,
      undefined,
      registry,
      chapter,
    );
    const l2Issues = [...l2Result.errors, ...l2Result.warnings, ...l2Result.infos];

    const combined = [...l1Issues, ...l2Issues];

    for (const issue of combined) {
      allIdentities.push(normalizeIssueIdentity(issue, aggregator));
    }
  }

  // Deduplicate by full six-field identity
  const seen = new Set<string>();
  const unique: ValidatorIssueIdentity[] = [];
  for (const id of allIdentities) {
    const key = identityKey(id);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(id);
    }
  }

  // Sort lexicographically
  unique.sort(compareIdentities);

  return unique;
}
