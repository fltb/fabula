// ============================================================================
// Novalistically — DURATION-1: Zod Schema Definitions (S6a)
//
// Schemas for DurationType and DurationProfile.
// ============================================================================

import { z } from 'zod';

// ─── Duration Type ────────────────────────────────────────────────────────────

export const durationTypeSchema = z.enum(['scene', 'summary', 'ellipsis', 'pause', 'stretch']);

// ─── Duration Profile ─────────────────────────────────────────────────────────

export const durationProfileSchema = z
  .object({
    type: durationTypeSchema,
    storyDuration: z.string().optional(),
    narrativeLength: z.number().nonnegative().optional(),
    ellipsisClarity: z.enum(['explicit', 'implicit', 'hypothetical']).optional(),
    compressionRatio: z.number().nonnegative().optional(),
  })
  .strict();
