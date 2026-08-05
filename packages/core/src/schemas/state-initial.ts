// ============================================================================
// Novalistically — World Initial State Schema
// ============================================================================

import { z } from 'zod';
import { knowledgeInitialStateSchema } from './knowledge.js';
import { threadDeclarationSchema } from './thread.js';
import { authoredLocatableStoryTimeSchema } from './timestamp.js';

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
            at: authoredLocatableStoryTimeSchema,
            description: z.string().optional(),
            significance: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
    threads: z.array(threadDeclarationSchema),
    knowledge: knowledgeInitialStateSchema,
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
