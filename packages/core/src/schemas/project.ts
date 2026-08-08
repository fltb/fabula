// ============================================================================
// Novalistically — Project Config Schema (nova.yaml)
// ============================================================================

import { z } from 'zod/v3';
import { ideaIRSchema } from './idea-ir.js';
import { renderSurfaceConfigSchema } from './render-surface.js';

/**
 * Project release policy (nova.yaml `releasePolicy`). `warnings` defaults to
 * `accept-and-record` when the key is absent, so legacy projects without a
 * policy behave exactly like the canonical default and are NEVER inferred
 * from historical pending_waiver records. `openBlockingReviews` is a fixed
 * literal for now.
 */
export const releasePolicySchema = z
  .object({
    warnings: z.enum(['accept-and-record', 'require-waiver']).default('accept-and-record'),
    openBlockingReviews: z.literal('block').default('block'),
  })
  .strict();

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
    logLevel: z.enum(['debug', 'info', 'warn', 'error']).optional(),
    traceLevel: z.enum(['off', 'basic', 'detailed']).optional(),
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
    concurrency: z.number().int().positive().optional(),
    defaultSceneTextTarget: z.number().int().positive().optional(),
    cacheEnabled: z.boolean().optional(),
    styleProfile: z
      .object({
        voice: z.string().optional(),
        diction: z.string().optional(),
        rhythm: z.string().optional(),
        paragraphing: z.string().optional(),
        typography: z.string().optional(),
        dialogue: z.string().optional(),
        avoid: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    ideaIR: ideaIRSchema.optional(),
    plugins: z
      .object({
        enabled: z.boolean(),
      })
      .strict()
      .optional(),
    releasePolicy: releasePolicySchema.optional(),
    renderSurface: renderSurfaceConfigSchema.optional(),
  })
  .strict();
