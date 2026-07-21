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


