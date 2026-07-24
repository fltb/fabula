// ============================================================================
// Grey Line Zod Schemas — Multi-point motif tracking
// ============================================================================

import { z } from 'zod';

export const greyLineNodeSchema = z
  .object({
    eventId: z.string().min(1, 'eventId must be a non-empty string'),
    semanticAccumulation: z.string().min(1, 'semanticAccumulation must be a non-empty string'),
    narrativeOrder: z.number().int().nonnegative(),
  })
  .strict();

export const greyLineSchema = z
  .object({
    id: z.string().min(1, 'id must be a non-empty string'),
    imagery: z.string().min(1, 'imagery must be a non-empty string'),
    nodes: z.array(greyLineNodeSchema).min(1, 'A grey line must have at least one node'),
  })
  .strict();
