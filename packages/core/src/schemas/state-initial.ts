// ============================================================================
// Novalistically — World Initial State Schema
// ============================================================================

import { z } from 'zod';

export const worldInitialStateSchema = z
  .object({
    info: z
      .object({
        currentEra: z.string(),
        politicalSituation: z.string(),
      })
      .strict(),
    timeAnchors: z
      .array(
        z
          .object({
            id: z.string(),
            day: z.number(),
            description: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
    threads: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          description: z.string(),
          type: z.string(),
          targetRevealChapter: z.number(),
          initialProgress: z.string(),
        })
        .strict(),
    ),
    worldFacts: z.array(
      z
        .object({
          id: z.string(),
          value: z.unknown(),
          description: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
