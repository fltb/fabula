// ============================================================================
// Validator shared schemas — used by multiple validators
// ============================================================================

import { z } from 'zod';

export const matchLevelSchema = z.enum(['exact', 'similar', 'absent', 'contradicted']);

export const narrativeCheckSchema = z.object({
  entityId: z.string(),
  attribute: z.string(),
  hint: z.string(),
  evidence: z.string(),
  matchLevel: matchLevelSchema,
});

export type MatchLevel = z.infer<typeof matchLevelSchema>;
export type NarrativeCheckBlock = z.infer<typeof narrativeCheckSchema>;
