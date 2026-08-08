// ============================================================================
// Novalistically — Character Definition Schema
// ============================================================================

import { z } from 'zod/v3';

export const characterDefinitionSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    archetype: z.string().optional(),
    faction: z.string().optional(),
    role: z.enum(['minor', 'supporting', 'antagonist', 'background']).optional(),
    description: z.string(),
    initialState: z.record(z.string(), z.unknown()).optional(),
    traits: z.array(z.string()),
    voiceNotes: z.string().optional(),
    backstory: z.string().optional(),
    knownSecrets: z.array(z.string()).optional(),
    appearance: z.string().optional(),
    aliases: z.array(z.string()).optional(),
    gender: z.string().optional(),
    age: z.union([z.string(), z.number()]).optional(),
    profession: z.string().optional(),
  })
  .strict();
