// ============================================================================
// Narrative Checklist Zod Schemas
// ============================================================================

import { z } from 'zod';

/**
 * Schema for a single narrative checklist item.
 */
export const narrativeChecklistItemSchema = z.object({
  dimension: z.string(),
  description: z.string(),
  required: z.boolean(),
}).strict();

/**
 * Schema for a full narrative checklist attached to an event.
 */
export const narrativeChecklistSchema = z.object({
  items: z.array(narrativeChecklistItemSchema),
}).strict();

/**
 * Schema for a per-dimension coverage result from Pass 2 analysis.
 */
export const checklistResultSchema = z.object({
  dimension: z.string(),
  covered: z.boolean(),
  evidence: z.string().optional(),
}).strict();
