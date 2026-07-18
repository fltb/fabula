// ============================================================================
// Analysis Schema — Zod validation for LLM Pass 2 JSON output
// ============================================================================

import { z } from 'zod';
import type { AnalysisResult } from '../types/analysis.js';

// ── New block schemas (P0g) ───────────────────────────────────────────────────

export const matchLevelSchema = z.enum(['exact', 'similar', 'absent', 'contradicted']);

export const narrativeCheckSchema = z.object({
  entityId: z.string(),
  attribute: z.string(),
  hint: z.string(),
  evidence: z.string(),
  matchLevel: matchLevelSchema,
});

export const appearanceCheckSchema = z.object({
  entityId: z.string(),
  feature: z.string(),
  declared: z.string(),
  evidence: z.string(),
  matchLevel: matchLevelSchema,
});

export const characterReferenceSchema = z.object({
  entityId: z.string(),
  namesUsed: z.array(z.string()),
});

export const tenseDetectedSchema = z.enum(['past', 'present', 'mixed']);

export const conflictAnalysisSchema = z.object({
  primaryType: z.string(),
  resolutionAchieved: z.boolean(),
});

export const ruleCheckSchema = z.object({
  ruleId: z.string(),
  violated: z.boolean(),
  evidence: z.string(),
  severity: z.enum(['minor', 'major']),
});

export const knowledgeCheckSchema = z.object({
  entityId: z.string(),
  leakedEntity: z.string(),
  leakedInfo: z.string(),
  evidence: z.string(),
  matchLevel: matchLevelSchema,
});

// ── Individual schemas (existing) ─────────────────────────────────────────────

export const postconditionAnalysisSchema = z.object({
  covered: z.array(z.string()),
  dropped: z.array(z.string()),
});

export const violatedPreconditionSchema = z.object({
  entityId: z.string(),
  attribute: z.string(),
  expectedValue: z.string(),
  issue: z.string(),
});

export const preconditionAnalysisSchema = z.object({
  violated: z.array(violatedPreconditionSchema),
});

export const povAnalysisSchema = z.object({
  consistent: z.boolean(),
  leaks: z.array(z.string()),
});

export const inventedDetailSchema = z.object({
  detail: z.string(),
  severity: z.enum(['minor', 'major']),
});

export const qualityAnalysisSchema = z.object({
  proseScore: z.number(),
  maxScore: z.number(),
  strengths: z.array(z.string()),
  weaknesses: z.array(z.string()),
  estimatedWordCount: z.number(),
});

export const analysisContentSchema = z.object({
  postconditions: postconditionAnalysisSchema,
  preconditions: preconditionAnalysisSchema,
  pov: povAnalysisSchema,
  inventedDetails: z.array(inventedDetailSchema),
  quality: qualityAnalysisSchema,
  threadProgressAchieved: z.array(z.string()),
  foreshadowingDeployed: z.array(z.string()),
  // ── New 5 optional blocks (P0g) ──────────────────────────────────
  narrativeChecks: z.array(narrativeCheckSchema).optional(),
  appearanceChecks: z.array(appearanceCheckSchema).optional(),
  characterReferences: z.array(characterReferenceSchema).optional(),
  tenseDetected: tenseDetectedSchema.optional(),
  conflictAnalysis: conflictAnalysisSchema.optional(),
  ruleChecks: z.array(ruleCheckSchema).optional(),
  knowledgeChecks: z.array(knowledgeCheckSchema).optional(),
});

export const analysisResultSchema = z.object({
  eventId: z.string(),
  analysis: analysisContentSchema,
});

// ── Parser (existing) ─────────────────────────────────────────────────────────

/**
 * Parse and validate a raw JSON string from LLM Pass 2 into an AnalysisResult.
 * Returns `null` if parsing or validation fails.
 * Log warning (via callback) on first failure; caller may retry Pass 2.
 */
export function parseAnalysisJSON(
  raw: string,
  warn?: (msg: string) => void,
): AnalysisResult | null {
  // Strip markdown code fences if present.
  // Handles: ```json\n{...}\n```, ```\n{...}\n```,
  //          text before ```\n{...}\n``` text after
  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i);
  const cleaned = fenceMatch
    ? fenceMatch[1].trim()
    : raw.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    warn?.(`Analysis JSON parse failed: invalid JSON`);
    return null;
  }

  const result = analysisResultSchema.safeParse(parsed);
  if (result.success) {
    return result.data as AnalysisResult;
  }

  warn?.(`Analysis JSON validation failed: ${result.error.message}`);
  return null;
}

// ── Parser with error detail (P0g: retry-with-feedback) ───────────────────────

/**
 * Parse a raw JSON string and return detailed error information.
 * Unlike parseAnalysisJSON(), this returns the Zod errors for retry-with-feedback.
 */
export function parseAnalysisJSONWithErrors(raw: string): {
  result: AnalysisResult | null;
  zodErrors?: z.ZodError;
  parseError?: string;
} {
  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i);
  const cleaned = fenceMatch
    ? fenceMatch[1].trim()
    : raw.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    return {
      result: null,
      parseError: `Invalid JSON: ${(e as Error).message}`,
    };
  }

  const result = analysisResultSchema.safeParse(parsed);
  if (result.success) {
    return { result: result.data as AnalysisResult };
  }

  return {
    result: null,
    zodErrors: result.error,
  };
}
