// ============================================================================
// Novalistically — Mood Definition Schema
// ============================================================================
//
// Defines a first-class "mood" type for scenes: named emotional tones with
// intensity and trigger keywords. Importable as both a Zod schema for
// runtime validation and a TypeScript type for static usage.
// ============================================================================

import { z } from 'zod';

export const moodDefinitionSchema = z
  .object({
    name: z.string().min(1, 'Mood name must be non-empty'),
    intensity: z.number().min(0).max(1),
    triggers: z.array(z.string()).default([]),
  })
  .strict();

/** Inferred TypeScript type for a single mood definition. */
export type MoodDefinition = z.infer<typeof moodDefinitionSchema>;

/**
 * Validates an unknown value against the MoodDefinition schema.
 * Returns a structured result with `valid` boolean and a list of error messages.
 */
export function validateMood(value: unknown): { valid: boolean; errors: string[] } {
  const result = moodDefinitionSchema.safeParse(value);
  if (result.success) return { valid: true, errors: [] };
  return { valid: false, errors: result.error.issues.map((i) => i.message) };
}
