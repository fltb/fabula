// ============================================================================
// Live smoke record builder — derives call ledger, totals, and failure summary
// exclusively from renderNovel providerCalls and results.
// ============================================================================

import { liveSmokeRecordSchema, sanitizeError } from '@novalistically/core';
import type { RenderNovelResult } from '@novalistically/core';
import { createHash } from 'node:crypto';
import { platform, arch, cpus } from 'node:os';

// ============================================================================
// Types
// ============================================================================

export interface LiveSmokeRecordInput {
  /** The full renderNovel result with providerCalls populated. */
  result: RenderNovelResult;
  /** Provider identifier (e.g. 'ai-sdk'). */
  provider: string;
  model: string;
  seed: number;
  command: string;
  /** Version fingerprints — code, fixture, schema, prompt, capability. */
  versions: {
    code: string;
    fixture: string;
    schema: number;
    prompt: string;
    capability: string;
  };
  /** Required event IDs for candidate success. */
  requiredEvents?: string[];
}

export interface LiveSmokeRecordOutput {
  /** The schema-validated smoke record, ready to serialize. */
  record: Record<string, unknown>;
  /** True if all required events are present, released, and errors are empty. */
  success: boolean;
}

// ============================================================================
// Builder
// ============================================================================

/**
 * Build a live smoke record from renderNovel results.
 *
 * Derives every `call.perEvent[].ledger` entry, `totalCalls`, and global
 * failure summary exclusively from the actual providerCalls / errors on the
 * result.  The output is validated against `liveSmokeRecordSchema` before
 * returning — any mismatch throws.
 *
 * Candidate success requires exactly the `requiredEvents` (default E0–E6) to
 * be present, released, and error-free.
 */
export function buildLiveSmokeRecord(input: LiveSmokeRecordInput): LiveSmokeRecordOutput {
  const { result, provider, model, seed, command, versions, requiredEvents } = input;
  const expectedEvents = requiredEvents ?? ['E0', 'E1', 'E2', 'E3', 'E4', 'E5', 'E6'];

  // ── Per-event ledger derived from providerCalls ──────────────────────
  const perEvent = result.results.map((r) => ({
    eventId: r.eventId,
    ledger: r.providerCalls.map((c) => ({
      phase: c.phase,
      attempt: c.attempt,
      outcome: c.outcome,
      requestHash: c.requestHash,
      model: c.model,
      seed: c.seed,
      ...(c.failureReason ? { failureReason: sanitizeError(c.failureReason) } : {}),
    })),
  }));

  // ── Total calls derived from ledger entries ──────────────────────────
  const totalCalls = perEvent.reduce((sum, ev) => sum + ev.ledger.length, 0);

  // ── Global failures — derived summary, never fabricates secrets ──────
  const failures: string[] = result.errors.map(e => sanitizeError(e));

  // Per-event release failure reasons (no secrets/prose in messages)
  for (const r of result.results) {
    if (!r.released) {
      const parts: string[] = [];
      if (r.prose.trim().length === 0) parts.push('empty prose');
      if (r.errors.length > 0) parts.push(`render errors: ${r.errors.map(e => sanitizeError(e)).join('; ')}`);
      if (r.analysis == null) parts.push('no analysis');
      if (r.validationErrors > 0) parts.push(`${r.validationErrors} validation error(s)`);
      if (parts.length > 0) {
        failures.push(sanitizeError(`${r.eventId}: ${parts.join(', ')}`));
      } else {
        failures.push(sanitizeError(`${r.eventId}: release gate (unspecified)`));
      }
    }
  }

  // ── Event hashes — full 64-hex SHA-256 ──────────────────────────────
  const eventHashes = result.results.map((r) => {
    const entry: { eventId: string; proseHash: string; analysisHash: string; promptHash: string } = {
      eventId: r.eventId,
      proseHash: createHash('sha256').update(r.prose).digest('hex'),
      analysisHash: createHash('sha256').update(JSON.stringify(r.analysis)).digest('hex'),
      promptHash: r.promptHash,
    };
    return entry;
  });

  // ── Cache stats ──────────────────────────────────────────────────────
  const cacheHits = result.results.filter((r) => r.cacheHit).length;
  const cacheMisses = result.results.filter((r) => !r.cacheHit).length;

  // ── Candidate success gate ───────────────────────────────────────────
  const renderedEventIds = new Set(result.results.filter((r) => r.released).map((r) => r.eventId));
  const allExpectedPresent = expectedEvents.every((id) => renderedEventIds.has(id));
  const success = result.errors.length === 0 && allExpectedPresent && renderedEventIds.size === expectedEvents.length;

  // ── Assemble record ──────────────────────────────────────────────────
  const record = {
    version: 1,
    provider,
    model,
    seed,
    events: result.results.length > 0 ? result.results.map((r) => r.eventId).sort() : ['NONE'],
    system: {
      nodeVersion: process.version,
      os: platform(),
      arch: arch(),
      cpu: cpus().length > 0 ? cpus()[0].model.trim() : 'unknown',
    },
    versions,
    command,
    call: {
      perEvent,
      totalCalls,
    },
    cache: {
      hits: cacheHits,
      misses: cacheMisses,
    },
    failures,
    hashes: { events: eventHashes },
    generatedAt: new Date().toISOString(),
    reviewStatus: success ? 'candidate' : 'failed',
  };

  // ── Schema validation — rejects secrets, mismatched totals, etc. ─────
  const parsed = liveSmokeRecordSchema.safeParse(record);
  if (!parsed.success) {
    throw new Error(
      `Smoke record schema validation failed: ${JSON.stringify(parsed.error.issues, null, 2)}`,
    );
  }

  // Return the parsed (strip-unknown) record so callers serialize a clean copy
  return { record: parsed.data as unknown as Record<string, unknown>, success };
}
