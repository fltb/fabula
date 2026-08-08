// ============================================================================
// Novalistically — Faction Definition Schema
// ============================================================================

import { z } from 'zod/v3';

export const factionDefinitionSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: z.string(),
    description: z.string(),
    initialState: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
