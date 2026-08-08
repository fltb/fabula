// ============================================================================
// Novalistically — S7b: Story IR — Zod Schema Definitions
// ============================================================================

import { z } from 'zod/v3';

// ─── StructuralFunction ─────────────────────────────────────────────────────

export const structuralFunctionSchema = z.enum([
  'absentation',
  'interdiction',
  'violation',
  'departure',
  'first_function_of_donor',
  'hero_reaction',
  'acquisition',
  'spatial_translocation',
  'villainy',
  'mediation',
  'beginning_counteraction',
  'first_villainy',
  'hero_departure',
  'donor_test',
  'hero_reaction_donor',
  'receipt_of_agent',
  'guidance',
  'arrival',
  'unrecognized_arrival',
  'unfounded_claims',
  'difficult_task',
  'solution',
  'recognition',
  'exposure',
  'punishment',
  'wedding',
]);

// ─── ActantModel ────────────────────────────────────────────────────────────

export const actantModelSchema = z
  .object({
    subject: z.string(),
    object: z.string(),
    sender: z.string(),
    receiver: z.string(),
    helper: z.string(),
    opponent: z.string(),
  })
  .strict();

// ─── StoryArchetype ─────────────────────────────────────────────────────────

export const storyArchetypeSchema = z.enum([
  'hero_journey',
  'tragedy',
  'quest',
  'descent',
  'rebirth',
  'comedy',
]);
