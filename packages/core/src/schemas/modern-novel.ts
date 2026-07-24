// ============================================================================
// Novalistically — Modern Novel Structural Field Schemas (S3)
// ============================================================================
// All 9 field schemas with .strict() to reject unknown properties.
// ============================================================================

import { z } from 'zod';

// ── A-class: Structural metadata schemas ─────────────────────────────────

export const antiCausalEdgeConfigSchema = z.object({
  enabled: z.boolean(),
  threshold: z.number().min(0).max(1).default(0.5),
}).strict();

export const chapterOrderContestedSchema = z.object({
  orderContested: z.boolean(),
  renderingVariants: z.array(z.string()).optional(),
}).strict();

export const surfaceModeConfigSchema = z.object({
  enabled: z.boolean(),
}).strict();

export const causalOverloadConfigSchema = z.object({
  enabled: z.boolean(),
  branchingThreshold: z.number().int().min(1).default(5),
}).strict();

// ── B-class: Semantic effect schemas ────────────────────────────────────

export const irresolvableIndeterminacySchema = z.object({
  enabled: z.boolean(),
  description: z.string().optional(),
}).strict();

export const absentApparatusSchema = z.object({
  enabled: z.boolean(),
  entityId: z.string().optional(),
  description: z.string().optional(),
}).strict();

export const voiceDissonanceSchema = z.object({
  enabled: z.boolean(),
  description: z.string().optional(),
}).strict();

export const multiplicitySchema = z.object({
  enabled: z.boolean(),
  description: z.string().optional(),
}).strict();

export const metanarrativeLevelSchema = z.object({
  enabled: z.boolean(),
  description: z.string().optional(),
}).strict();

// ── Unified config schema ───────────────────────────────────────────────

export const modernNovelConfigSchema = z.object({
  antiCausalEdge: antiCausalEdgeConfigSchema.optional(),
  chapterOrder: chapterOrderContestedSchema.optional(),
  surfaceMode: surfaceModeConfigSchema.optional(),
  causalOverload: causalOverloadConfigSchema.optional(),
  irresolvableIndeterminacy: irresolvableIndeterminacySchema.optional(),
  absentApparatus: absentApparatusSchema.optional(),
  voiceDissonance: voiceDissonanceSchema.optional(),
  multiplicity: multiplicitySchema.optional(),
  metanarrativeLevel: metanarrativeLevelSchema.optional(),
}).strict();
