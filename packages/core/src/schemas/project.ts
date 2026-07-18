// ============================================================================
// Novalistically — Project Config Schema (nova.yaml)
// ============================================================================

import { z } from 'zod';

export const projectConfigSchema = z
  .object({
    project: z.string(),
    title: z.string(),
    author: z.string(),
    defaultModel: z.string().optional(),
    defaultLanguage: z.string().optional(),
    genre: z.string().optional(),
    synopsis: z.string().optional(),
    tense: z.enum(['past', 'present']).optional(),
    validatorOverrides: z.record(z.string(), z.enum(['off', 'warning', 'error'])).optional(),
    circuitBreaker: z
      .object({
        maxRetries: z.number(),
      })
      .strict()
      .optional(),
    reviewExpiry: z
      .object({
        enabled: z.boolean(),
        autoResolveDays: z.number(),
      })
      .strict()
      .optional(),
    snapshotInterval: z.number().optional(),
  })
  .strict();
