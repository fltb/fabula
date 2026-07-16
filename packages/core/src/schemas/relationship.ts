// ============================================================================
// Novalistically — Relationship Definition Schema
// ============================================================================

import { z } from 'zod';

export const relationshipDefinitionSchema = z
  .object({
    participants: z.tuple([z.string(), z.string()]),
    type: z.string(),
    description: z.string(),
    initialState: z.record(z.string(), z.record(z.string(), z.unknown())),
    establishedEvent: z.string(),
  })
  .strict();
