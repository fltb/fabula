// ============================================================================
// Novalistically — Relationship Definition & Event Zod Schemas
// ============================================================================

import { z } from 'zod';

// ——— RelationshipDefinition (first-class entity) ———

export const relationshipDefinitionSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    participants: z.tuple([z.string(), z.string()]),
    bidirectional: z.boolean(),
    initialState: z
      .object({
        trust: z.number().min(-100).max(100),
        emotionalDistance: z.number().min(0).max(100),
        intensity: z.number().min(0).max(100),
        status: z.string(),
        notes: z.string().optional(),
      })
      .strict(),
    establishedEvent: z.string().optional(),
    breakingEvent: z.string().optional(),
  })
  .strict();

// ——— RelationshipEvent ———

export const relationshipEventSchema = z
  .object({
    id: z.string(),
    type: z.enum(['strengthen', 'weaken', 'break', 'form', 'shift']),
    relationshipId: z.string(),
    delta: z
      .object({
        trust: z.number().optional(),
        emotionalDistance: z.number().optional(),
        intensity: z.number().optional(),
        status: z.string().optional(),
      })
      .optional(),
    sourceEvent: z.string(),
  })
  .strict();
