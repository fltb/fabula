// ============================================================================
// Novalistically — Location Definition Schema
// ============================================================================

import { z } from 'zod';

export const locationDefinitionSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: z.string(),
    parent: z.string().optional(),
    description: z.string(),
    initialState: z.record(z.string(), z.unknown()),
    notableFeatures: z.array(z.string()).optional(),
  })
  .strict();
