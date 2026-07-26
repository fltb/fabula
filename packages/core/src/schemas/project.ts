// ============================================================================
// Novalistically — Project Config Schema (nova.yaml)
// ============================================================================

import type { StyleProfile } from '../style/default-profile.ts';
import { z } from 'zod';
import { ideaIRSchema } from './idea-ir.js';

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
    outputDir: z.string().optional(),
    defaultSceneTextTarget: z.number().int().positive().optional(),
    cacheEnabled: z.boolean().optional(),
    schemaVersion: z.number().default(1),
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
        directory: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
