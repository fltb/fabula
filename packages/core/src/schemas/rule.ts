// ============================================================================
// Novalistically — Rule Definition Schema
// ============================================================================

import { z } from 'zod';
import { logicalConsequenceSchema, ruleEffectSchema } from './primitives.js';

export const ruleDefinitionSchema = z
  .object({
    ruleId: z.string(),
    name: z.string(),
    category: z.string(),
    type: z.string(),
    statement: z.string(),
    logicalConsequences: z.array(logicalConsequenceSchema),
    exceptions: z
      .array(
        z
          .object({
            condition: z.string(),
            note: z.string(),
          })
          .strict(),
      )
      .optional(),
    evidenceChain: z.array(ruleEffectSchema),
  })
  .strict();
