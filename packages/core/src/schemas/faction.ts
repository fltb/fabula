// ============================================================================
// Novalistically — Faction Definition Schema
// ============================================================================

import { z } from 'zod';

export const factionDefinitionSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: z.string(),
    description: z.string(),
    initialState: z.record(z.string(), z.unknown()),
  })
  .strict();
