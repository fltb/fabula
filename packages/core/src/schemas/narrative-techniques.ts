// ============================================================================
// Novalistically — Narrative Technique Contract Schemas
// ============================================================================

import { z } from 'zod/v3';

const nonBlankString = z.string().trim().min(1);
const uniqueStrings = (values: string[]): boolean => new Set(values).size === values.length;

export const causalDiscontinuitySchema = z
  .object({
    predecessor: nonBlankString,
    dependent: nonBlankString,
    instruction: nonBlankString,
    requiredEvidence: nonBlankString,
  })
  .strict();

export const surfaceModeSchema = z
  .object({
    instruction: nonBlankString,
    requiredEvidence: nonBlankString,
  })
  .strict();

export const causalMultiplicitySchema = z
  .object({
    minimumOutgoingEdges: z.number().int().min(2),
    instruction: nonBlankString,
    requiredEvidence: nonBlankString,
  })
  .strict();

export const irresolvableIndeterminacySchema = z
  .object({
    assertionIds: z.array(nonBlankString).min(1).refine(uniqueStrings, {
      message: 'assertionIds must not contain duplicates',
    }),
    instruction: nonBlankString,
    requiredEvidence: nonBlankString,
  })
  .strict();

export const absentApparatusSchema = z
  .object({
    readId: nonBlankString,
    instruction: nonBlankString,
    requiredEvidence: nonBlankString,
  })
  .strict();

export const voiceDissonanceSchema = z
  .object({
    assertionId: nonBlankString,
    storyOutputId: nonBlankString,
    instruction: nonBlankString,
    requiredEvidence: nonBlankString,
  })
  .strict();

export const multiplicitySchema = z
  .object({
    assertionIds: z.array(nonBlankString).min(2).refine(uniqueStrings, {
      message: 'assertionIds must not contain duplicates',
    }),
    instruction: nonBlankString,
    requiredEvidence: nonBlankString,
  })
  .strict();

export const metanarrativeLevelSchema = z
  .object({
    instruction: nonBlankString,
    requiredEvidence: nonBlankString,
  })
  .strict();
