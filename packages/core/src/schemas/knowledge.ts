// ============================================================================
// Novalistically — Knowledge Definition & Event Zod Schemas
// ============================================================================

import { z } from 'zod';

// ——— KnowledgeDefinition ———

export const knowledgeDefinitionSchema = z
  .object({
    id: z.string(),
    type: z.enum(['fact', 'belief', 'secret', 'rumor', 'discovery']),
    subject: z.string(),
    object: z.string(),
    content: z.string(),
    confidence: z.number().min(0).max(1),
    acquiredAt: z.string(),
    source: z.enum(['direct_experience', 'hearsay', 'deduction', 'deception', 'default']),
    isVerified: z.boolean(),
    verificationEvent: z.string().optional(),
  })
  .strict();

// ——— KnowledgeEvent ———

export const knowledgeEventSchema = z
  .object({
    id: z.string(),
    type: z.enum(['learn', 'forget', 'misbelieve', 'deceive', 'confirm']),
    knowledgeId: z.string(),
    targetEntity: z.string(),
    sourceEvent: z.string().optional(),
    data: z.record(z.string(), z.unknown()),
  })
  .strict();
