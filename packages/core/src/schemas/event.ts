// ============================================================================
// Novalistically — Event File Schema
// ============================================================================

import { z } from 'zod';
import {
  preconditionSchema,
  postconditionSchema,
  styleGuidanceSchema,
  threadProgressEntrySchema,
  foreshadowEntrySchema,
  relationshipChangeSchema,
  ruleEffectSchema,
  introduceEntrySchema,
} from './primitives.js';

export const eventFileSchema = z
  .object({
    event: z.string(),
    narrativeOrder: z.number(),
    title: z.string(),
    storyTime: z.string(),
    sceneType: z.enum(['linear', 'flashback', 'flashforward', 'dream', 'parallel']).optional(),
    pov: z
      .object({
        character: z.string(),
        type: z.enum(['first_person', 'third_person_limited', 'omniscient']),
      })
      .strict(),
    sceneBrief: z.string(),
    preconditions: z.array(preconditionSchema),
    expectedPostconditions: z.array(postconditionSchema),
    styleGuidance: styleGuidanceSchema.optional(),
    threadProgress: z.array(threadProgressEntrySchema).optional(),
    foreshadowing: z.array(foreshadowEntrySchema).optional(),
    relationshipEffects: z.array(relationshipChangeSchema).optional(),
    ruleEffects: z.array(ruleEffectSchema).optional(),
    introduces: z.array(introduceEntrySchema).optional(),
  })
  .strict();
