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
import { greyLineSchema } from './grey-line.js';
import { narrativeChecklistSchema } from './narrative-checklist.js';
import { sourceContextSchema } from './source-context.js';
import { durationProfileSchema } from './duration.js';
import { frequencyProfileSchema } from './frequency.js';
import { anachronySchema, voiceProfileSchema } from './discourse.js';
import { modernNovelConfigSchema } from './modern-novel.js';
export const eventFileSchema = z
  .object({
    event: z.string(),
    formatVersion: z.number().default(1),
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
    greyLines: z.array(greyLineSchema).optional(),
    foreshadowing: z.array(foreshadowEntrySchema).optional(),
    relationshipEffects: z.array(relationshipChangeSchema).optional(),
    ruleEffects: z.array(ruleEffectSchema).optional(),
    introduces: z.array(introduceEntrySchema).optional(),
    targetAudience: z.string().optional(),
    cast: z.object({
      onScreen: z.array(z.string()),
      affected: z.array(z.string()),
    }).optional(),
    narrativeChecklist: narrativeChecklistSchema.optional(),
    sourceContext: sourceContextSchema.optional(),
    duration: durationProfileSchema.optional(),
    frequency: frequencyProfileSchema.optional(),
    anachrony: anachronySchema.optional(),
    voice: voiceProfileSchema.optional(),
    narratorProfileRef: z.string().optional(),
    focalization: z.object({
      type: z.enum(['zero', 'internal', 'external']),
      variation: z.enum(['fixed', 'variable', 'multiple']).optional(),
      characterSequence: z.array(z.object({
        character: z.string(),
        scope: z.string(),
      })).optional(),
    }).optional(),
    modernNovel: modernNovelConfigSchema.optional(),
  })
  .strict();
