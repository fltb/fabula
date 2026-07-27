// ============================================================================
// Analysis Schema — Zod validation for LLM Pass 2 JSON output
// ============================================================================
//
// Sub-schemas live in their owning validator files.
// The aggregated content schema is exported from ../validator/index.js.
// This file retains only the top-level eventId wrapper and the parsers.

import { z } from 'zod';
import type { AnalysisResult } from '../types/analysis.js';
import { analysisContentSchema } from '../validator/index.js';
import { checklistResultSchema } from './narrative-checklist.js';

export { checklistResultSchema } from './narrative-checklist.js';

export const analysisResultSchema = z.object({
  eventId: z.string(),
  analysis: analysisContentSchema,
});

// ── Parser ──────────────────────────────────────────────────────────────────

/**
 * Parse and validate a raw JSON string from LLM Pass 2 into an AnalysisResult.
 * Returns `null` if parsing or validation fails.
 */
export function parseAnalysisJSON(
  raw: string,
  warn?: (msg: string) => void,
): AnalysisResult | null {
  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i);
  const cleaned = fenceMatch ? fenceMatch[1].trim() : raw.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    warn?.('Analysis JSON parse failed: invalid JSON');
    return null;
  }

  const result = analysisResultSchema.safeParse(parsed);
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
 * Optionally accepts a combined validation schema that includes plugin-built
 * fields. When omitted, the built-in aggregated schema is used.
 */
export function parseAnalysisJSONWithErrors(
  raw: string,
  /** Dynamic schema including plugin fields (defaults to built-in). */
  combinedSchema?: z.ZodObject<Record<string, z.ZodTypeAny>>,
): {
  result: AnalysisResult | null;
  zodErrors?: z.ZodError;
  parseError?: string;
} {
  const schema = combinedSchema
    ? z.object({ eventId: z.string(), analysis: combinedSchema })
    : analysisResultSchema;

  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i);
  const cleaned = fenceMatch ? fenceMatch[1].trim() : raw.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
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
