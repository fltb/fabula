// ============================================================================
// Novalistically — Chapter Metadata & Scene Metadata Schemas
// ============================================================================

import { z } from 'zod';
import { styleGuidanceSchema } from './primitives.js';

export const chapterMetadataSchema = z
  .object({
    chapter: z.number(),
    title: z.string(),
    summary: z.string(),
    intent: z.string(),
    plannedScenes: z.number(),
    styleGuidance: styleGuidanceSchema.optional(),
  })
  .strict();

export const sceneMetadataSchema = z
  .object({
    event: z.string(),
    proseSource: z.enum(['llm', 'human_edited', 'human_locked']),
    modelUsed: z.string().optional(),
    renderedAt: z.string().optional(),
    wordCount: z.number().optional(),
    editHistory: z.array(
      z
        .object({
          timestamp: z.string(),
          notes: z.string(),
        })
        .strict(),
    ),
    quality: z
      .object({
        proseQuality: z.number().optional(),
        voiceAdherence: z.number().optional(),
        pacingScore: z.number().optional(),
        continuityScore: z.number().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
