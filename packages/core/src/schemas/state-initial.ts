// ============================================================================
// Novalistically — World Initial State Schema
// ============================================================================

import { z } from 'zod';
import { structuralFunctionSchema } from './story-ir.js';
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
            id: z.string().min(1),
            at: z.string().min(1),
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
          structuralFunction: structuralFunctionSchema.optional(),
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
