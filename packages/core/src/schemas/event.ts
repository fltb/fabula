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
    narrationTime: z.string().optional(),
    sceneType: z.enum(['linear', 'flashback', 'flashforward', 'dream', 'parallel']).optional(),
    discourseMode: z.enum(['action', 'dialogue', 'description', 'exposition', 'reflection', 'transition']).optional(),
    arcPosition: z.enum(['opening', 'rising', 'climax', 'falling', 'denouement']).optional(),
    emotionalValence: z.string().optional(),
    conflictType: z.string().optional(),
    resolutionType: z.string().optional(),
    tense: z.enum(['past', 'present']).optional(),
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
    targetAudience: z.string().optional(),
    cast: z.object({
      onScreen: z.array(z.string()),
      affected: z.array(z.string()),
    }).optional(),
  })
  .strict();
