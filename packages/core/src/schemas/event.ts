// ============================================================================
// Novalistically — Event File Schema
// ============================================================================

import { z } from 'zod';
import { anachronySchema, voiceProfileSchema } from './discourse.js';
import { durationProfileSchema } from './duration.js';
import { frequencyProfileSchema } from './frequency.js';
import { gameDialogueChoicesSchema } from './game-dialogue.js';
import { greyLineSchema } from './grey-line.js';
import { narrativeChecklistSchema } from './narrative-checklist.js';
import {
  absentApparatusSchema,
  causalDiscontinuitySchema,
  causalMultiplicitySchema,
  irresolvableIndeterminacySchema,
  metanarrativeLevelSchema,
  multiplicitySchema,
  surfaceModeSchema,
  voiceDissonanceSchema,
} from './narrative-techniques.js';
import {
  foreshadowEntrySchema,
  introduceEntrySchema,
  postconditionSchema,
  preconditionSchema,
  relationshipChangeSchema,
  ruleEffectSchema,
  styleGuidanceSchema,
  threadProgressEntrySchema,
} from './primitives.js';
import { sourceContextSchema } from './source-context.js';
import { authoredStoryTimeSchema } from './timestamp.js';
export const eventFileSchema = z
  .object({
    event: z.string(),
    narrativeOrder: z.number(),
    title: z.string(),
    storyTime: authoredStoryTimeSchema.optional(),
    narrationTime: authoredStoryTimeSchema.optional(),
    causalPredecessors: z
      .array(z.string().refine((id) => id.trim().length > 0, 'causalPredecessors must be nonblank'))
      .min(1)
      .optional()
      .superRefine((value, ctx) => {
        if (value && new Set(value).size !== value.length) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'causalPredecessors must be unique',
          });
        }
      }),
    sceneType: z.enum(['linear', 'flashback', 'flashforward', 'dream', 'parallel']).optional(),
    discourseMode: z
      .enum(['action', 'dialogue', 'description', 'exposition', 'reflection', 'transition'])
      .optional(),
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
    beats: z.tuple([z.string().min(1)]).rest(z.string().min(1)),
    preconditions: z.array(preconditionSchema),
    expectedPostconditions: z.array(postconditionSchema),
    styleGuidance: styleGuidanceSchema.optional(),
    choices: gameDialogueChoicesSchema.optional(),
    threadProgress: z.array(threadProgressEntrySchema).optional(),
    greyLines: z.array(greyLineSchema).optional(),
    foreshadowing: z.array(foreshadowEntrySchema).optional(),
    relationshipEffects: z.array(relationshipChangeSchema).optional(),
    ruleEffects: z.array(ruleEffectSchema).optional(),
    introduces: z.array(introduceEntrySchema).optional(),
    authorNotes: z.array(z.string()).optional(),
    targetAudience: z.string().optional(),
    cast: z
      .object({
        onScreen: z.array(z.string()),
        affected: z.array(z.string()),
      })
      .optional(),
    narrativeChecklist: narrativeChecklistSchema.optional(),
    sourceContext: sourceContextSchema.optional(),
    duration: durationProfileSchema.optional(),
    frequency: frequencyProfileSchema.optional(),
    anachrony: anachronySchema.optional(),
    voice: voiceProfileSchema.optional(),
    narratorProfileRef: z.string().optional(),
    focalization: z
      .object({
        type: z.enum(['zero', 'internal', 'external']),
        variation: z.enum(['fixed', 'variable', 'multiple']).optional(),
        characterSequence: z
          .array(
            z.object({
              character: z.string(),
              scope: z.string(),
            }),
          )
          .optional(),
      })
      .optional(),
    causalDiscontinuity: causalDiscontinuitySchema.optional(),
    surfaceMode: surfaceModeSchema.optional(),
    causalMultiplicity: causalMultiplicitySchema.optional(),
    irresolvableIndeterminacy: irresolvableIndeterminacySchema.optional(),
    absentApparatus: absentApparatusSchema.optional(),
    voiceDissonance: voiceDissonanceSchema.optional(),
    multiplicity: multiplicitySchema.optional(),
    metanarrativeLevel: metanarrativeLevelSchema.optional(),
  })
  .strict();
