// ============================================================================
// Novalistically — FREQUENCY-1: Zod Schema Definitions (S6b)
//
// Schemas for FrequencyType and FrequencyProfile.
// ============================================================================

import { z } from 'zod';

// ─── Frequency Type ───────────────────────────────────────────────────────────

export const frequencyTypeSchema = z.enum([
  'singulative',
  'repeating',
  'iterative',
]);

// ─── Frequency Profile ────────────────────────────────────────────────────────

export const frequencyProfileSchema = z.object({
  type: frequencyTypeSchema,
  sourceEventCount: z.number().int().nonnegative().optional(),
  occurrenceCount: z.number().int().nonnegative().optional(),
  iterationScope: z
    .object({
      start: z.string(),
      end: z.string(),
    })
    .strict()
    .optional(),
  otherOccurrences: z.array(z.string()).optional(),
}).strict();
