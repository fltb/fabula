// ============================================================================
// Novalistically — S7a: Idea IR — Zod Schema Definitions
// ============================================================================

import { z } from 'zod';

// ─── ThematicIntent ─────────────────────────────────────────────────────────

export const thematicIntentSchema = z.object({
  primaryTheme: z.string(),
  subThemes: z.array(z.string()),
}).strict();

// ─── EmotionalArcDefinition ─────────────────────────────────────────────────

export const emotionalBeatSchema = z.object({
  position: z.string(),
  emotion: z.string(),
}).strict();

export const emotionalArcDefinitionSchema = z.object({
  arcType: z.string(),
  emotionalBeats: z.array(emotionalBeatSchema),
}).strict();

// ─── IdeaIR ─────────────────────────────────────────────────────────────────

export const ideaIRSchema = z.object({
  thematicIntent: thematicIntentSchema,
  emotionalArc: emotionalArcDefinitionSchema,
  targetAudience: z.string().optional(),
  coreConflict: z.string().optional(),
}).strict();
