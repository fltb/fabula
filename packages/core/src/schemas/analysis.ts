// ============================================================================
// Analysis Schema — Zod validation for LLM Pass 2 JSON output
// ============================================================================
//
// Sub-schemas live in their owning validator files.
// The aggregated content schema is exported from ../validator/index.js.
// This file owns:
//   - the AnalysisObservation disposition schemas (produced/abstained/ambiguous)
//   - the top-level AnalysisResult schema: eventId + protocol + observations
//     + analysis payload, with observation↔payload pairing enforced
//   - the Pass 2 parsers (fence stripping, JSON parse, schema validation,
//     optional expected-protocol comparison and exact-quote evidence checks)
//
// The top-level schema is built dynamically from the active analysis content
// schema so plugin-contributed fields keep working:
//   - every active field may be present (produced) or absent
//     (abstained/ambiguous), so payload fields are optional at top level
//   - the pairing refinement then enforces: produced ⇒ payload present and
//     schema-valid; abstained/ambiguous ⇒ payload absent; every present
//     payload and every required active field must carry exactly one
//     observation
//   - evidence quotes are validated as exact substrings of the rendered
//     prose when the parser has the prose

import { z } from 'zod/v3';
import type { AnalysisObservation, AnalysisResult } from '../types/analysis.js';
import type { ValidationKey } from '../types/discourse.js';
import { analysisContentSchema } from '../validator/index.js';
import { validationKeySchema } from './discourse.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Cache repositories preserve opaque plugin analysis fields, so they validate
 * only the invariant AnalysisResult envelope. The active pipeline contract
 * performs the full schema validation before a record becomes cacheable.
 */
export function hasAnalysisResultShape(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    typeof value.eventId === 'string' &&
    value.eventId.length > 0 &&
    isRecord(value.protocol) &&
    Object.keys(value.protocol).length > 0 &&
    isRecord(value.observations) &&
    isRecord(value.analysis) &&
    Object.keys(value.analysis).length > 0
  );
}

// ── Observation schemas ───────────────────────────────────────────────────────

/**
 * String schema for an evidence quote. Every quote must be a non-empty exact
 * substring of the rendered prose (protocol.proseHash) — checked when the
 * parser is given the prose.
 */
function evidenceStringSchema(prose?: string | null): z.ZodType<string> {
  let schema: z.ZodType<string> = z.string().min(1);
  if (prose) {
    schema = schema.refine(
      (quote) => prose.includes(quote),
      (quote) => ({
        message:
          `observation evidence "${quote}" is not an exact substring of the rendered prose ` +
          '(protocol.proseHash)',
      }),
    );
  }
  return schema;
}

/**
 * Build the observation schemas, optionally validating every evidence quote
 * as an exact substring of the given prose.
 */
function buildObservationSchema(prose?: string | null): z.ZodType<AnalysisObservation> {
  const quote = evidenceStringSchema(prose);
  const evidenceTuple = z.tuple([quote]).rest(quote);

  const alternativeSchema = z
    .object({
      summary: z.string().min(1),
      evidence: evidenceTuple,
    })
    .strict();

  const producedSchema = z
    .object({
      disposition: z.literal('produced'),
      evidence: evidenceTuple,
    })
    .strict();

  const abstainedSchema = z
    .object({
      disposition: z.literal('abstained'),
      reason: z.string().min(1),
      evidence: z.array(quote),
    })
    .strict();

  const ambiguousSchema = z
    .object({
      disposition: z.literal('ambiguous'),
      alternatives: z.tuple([alternativeSchema, alternativeSchema]).rest(alternativeSchema),
      evidence: z.array(quote),
    })
    .strict();

  return z.discriminatedUnion('disposition', [producedSchema, abstainedSchema, ambiguousSchema]);
}

/**
 * Schema for one ambiguous alternative (summary + exact prose quotes).
 * Static form without prose-based evidence checks.
 */
export const analysisAlternativeSchema = z
  .object({
    summary: z.string().min(1),
    evidence: z.tuple([z.string().min(1)]).rest(z.string().min(1)),
  })
  .strict();

/**
 * Schema for a single observation. Static form without prose-based evidence
 * checks — use {@link buildAnalysisResultSchema} to enable exact-quote
 * validation.
 */
export const analysisObservationSchema: z.ZodType<AnalysisObservation> = buildObservationSchema();

// ── Top-level AnalysisResult schema ───────────────────────────────────────────

export interface AnalysisResultSchemaOptions {
  /**
   * Active analysis content schema (built-in aggregated schema plus any
   * plugin-contributed fields). Defaults to the built-in analysisContentSchema.
   */
  analysisSchema?: z.ZodObject<Record<string, z.ZodTypeAny>>;
  /**
   * Expected measurement protocol. When provided, EVERY protocol field is
   * compared fail-closed against the parsed protocol.
   */
  expectedProtocol?: ValidationKey | null;
  /**
   * Rendered prose for exact-quote evidence validation. When provided, every
   * evidence quote in every observation must be an exact substring.
   */
  prose?: string | null;
}

/**
 * Compare every field of the parsed protocol against the expected protocol.
 * Any missing, extra, or differing field fails closed.
 */
function protocolMatches(actual: ValidationKey, expected: ValidationKey): boolean {
  const actualFields = actual as unknown as Record<string, unknown>;
  const expectedFields = expected as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(actualFields), ...Object.keys(expectedFields)]);
  for (const key of keys) {
    if (
      !Object.hasOwn(actualFields, key) ||
      !Object.hasOwn(expectedFields, key) ||
      actualFields[key] !== expectedFields[key]
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Enforce the top-level response contract:
 *   - every observation references an active analysis field
 *   - produced  ⇒ canonical payload present (and schema-valid via payloadSchema)
 *   - abstained/ambiguous ⇒ canonical payload absent
 *   - every present payload field carries exactly one observation
 *   - every REQUIRED active field carries exactly one observation (optional
 *     plugin fields may be missing entirely — observation AND payload)
 */
function pairObservationsWithPayload(
  result: {
    observations?: Record<string, AnalysisObservation>;
    analysis?: Record<string, unknown>;
  },
  contentShape: Record<string, z.ZodTypeAny>,
  ctx: z.RefinementCtx,
): void {
  const observations = result.observations ?? {};
  const payloadFields = new Set(Object.keys(result.analysis ?? {}));

  for (const [field, observation] of Object.entries(observations)) {
    if (!(field in contentShape)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['observations', field],
        message:
          `Observation for unknown analysis field "${field}" — observation keys ` +
          'must be active top-level analysis fields.',
      });
      continue;
    }
    const hasPayload = payloadFields.has(field);
    if (observation.disposition === 'produced' && !hasPayload) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['observations', field],
        message:
          `produced observation for "${field}" requires a schema-valid payload ` +
          `at analysis["${field}"] — payload is missing.`,
      });
    } else if (observation.disposition !== 'produced' && hasPayload) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['observations', field],
        message:
          `${observation.disposition} observation for "${field}" requires the canonical ` +
          `payload to be absent — found analysis["${field}"].`,
      });
    }
  }

  for (const field of payloadFields) {
    if (!Object.hasOwn(observations, field)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['analysis', field],
        message:
          `analysis["${field}"] has no matching observations["${field}"] — every active ` +
          'field must carry exactly one observation.',
      });
    }
  }

  for (const [field, fieldSchema] of Object.entries(contentShape)) {
    const required = !(fieldSchema.isOptional?.() ?? false);
    if (required && !Object.hasOwn(observations, field)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['observations', field],
        message:
          `Missing observation for active field "${field}" — every active field must ` +
          'carry exactly one observation.',
      });
    }
  }
}

/**
 * Top-level payload wrapper: every active field becomes optional so that
 * abstained/ambiguous fields can omit their canonical payload, while any
 * PRESENT payload is still validated against its original block schema.
 */
function makeAnalysisPayloadSchema(
  contentShape: Record<string, z.ZodTypeAny>,
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [field, fieldSchema] of Object.entries(contentShape)) {
    shape[field] = fieldSchema.isOptional?.() ? fieldSchema : fieldSchema.optional();
  }
  return z.object(shape);
}

/**
 * Build the top-level AnalysisResult schema for the active analysis contract.
 *
 * - `analysisSchema` defaults to the built-in aggregated schema; pass the
 *   aggregator's combined schema (which includes plugin fields) to validate
 *   plugin-contributed payloads.
 * - `expectedProtocol` enables fail-closed full-field protocol comparison.
 * - `prose` enables exact-quote evidence validation.
 */
export function buildAnalysisResultSchema(
  options: AnalysisResultSchemaOptions = {},
): z.ZodType<AnalysisResult> {
  const contentSchema = options.analysisSchema ?? analysisContentSchema;
  const contentShape = contentSchema.shape as Record<string, z.ZodTypeAny>;
  const payloadSchema = makeAnalysisPayloadSchema(contentShape);

  // The protocol object is validated against validationKeySchema with a
  // passthrough wrapper: all schema-declared fields stay required, while
  // extra fields (e.g. newly added protocol dimensions) are tolerated until
  // the schema catches up. The authoritative fail-closed gate is the
  // expectedProtocol comparison below — when the expected protocol is
  // provided, every field must match exactly.
  const protocolSchema = options.expectedProtocol
    ? validationKeySchema.passthrough().superRefine((protocol, ctx) => {
        if (!protocolMatches(protocol, options.expectedProtocol as ValidationKey)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['protocol'],
            message:
              'protocol does not match the expected measurement protocol — analysis was ' +
              'not produced under the exact protocol.',
          });
        }
      })
    : validationKeySchema.passthrough();

  return z
    .object({
      eventId: z.string(),
      protocol: protocolSchema,
      observations: z.record(z.string(), buildObservationSchema(options.prose)),
      analysis: payloadSchema,
    })
    .strict()
    .superRefine((data, ctx) => {
      if (!data) return;
      pairObservationsWithPayload(data, contentShape, ctx);
    }) as z.ZodType<AnalysisResult>;
}

/**
 * Top-level AnalysisResult schema for the built-in analysis contract
 * (no plugin fields, no expected-protocol comparison, no prose evidence
 * checks). Persisted contracts and cache re-parses use this shape.
 */
export const analysisResultSchema: z.ZodType<AnalysisResult> = buildAnalysisResultSchema();

// ── Parser ──────────────────────────────────────────────────────────────────

function stripFences(raw: string): string {
  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i);
  return fenceMatch ? fenceMatch[1].trim() : raw.trim();
}

/**
 * Parse and validate a raw JSON string from LLM Pass 2 into an AnalysisResult.
 * Returns `null` if parsing or validation fails.
 *
 * - `expectedProtocol`: when provided, every protocol field is compared
 *   fail-closed against the parsed protocol.
 * - `prose`: when provided, every observation evidence quote must be an
 *   exact substring of the prose.
 */
export function parseAnalysisJSON(
  raw: string,
  warn?: (msg: string) => void,
  expectedProtocol?: ValidationKey | null,
  prose?: string | null,
): AnalysisResult | null {
  const schema = buildAnalysisResultSchema({ expectedProtocol, prose });

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(raw));
  } catch {
    warn?.('Analysis JSON parse failed: invalid JSON');
    return null;
  }

  const result = schema.safeParse(parsed);
  if (result.success) {
    return result.data as AnalysisResult;
  }

  warn?.(`Analysis JSON validation failed: ${result.error.message}`);
  return null;
}

// ── Parser with error detail (retry-with-feedback) ──────────────────────────

/**
 * Parse a raw JSON string and return detailed error information.
 * Unlike parseAnalysisJSON(), this returns the Zod errors for retry-with-feedback.
 *
 * - `combinedSchema`: dynamic analysis content schema including plugin-built
 *   fields (defaults to the built-in aggregated schema).
 * - `expectedProtocol`: when provided, every protocol field is compared
 *   fail-closed against the parsed protocol.
 * - `prose`: when provided, every observation evidence quote must be an
 *   exact substring of the prose.
 */
export function parseAnalysisJSONWithErrors(
  raw: string,
  /** Dynamic schema including plugin fields (defaults to built-in). */
  combinedSchema?: z.ZodObject<Record<string, z.ZodTypeAny>>,
  expectedProtocol?: ValidationKey | null,
  prose?: string | null,
): {
  result: AnalysisResult | null;
  zodErrors?: z.ZodError;
  parseError?: string;
} {
  const schema = buildAnalysisResultSchema({
    analysisSchema: combinedSchema,
    expectedProtocol,
    prose,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(raw));
  } catch (e) {
    return {
      result: null,
      parseError: `Invalid JSON: ${(e as Error).message}`,
    };
  }

  const result = schema.safeParse(parsed);
  if (result.success) {
    return { result: result.data as AnalysisResult };
  }

  return {
    result: null,
    zodErrors: result.error,
  };
}
