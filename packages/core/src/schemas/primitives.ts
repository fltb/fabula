// ============================================================================
// Novalistically — Shared primitive Zod schemas used by entity schemas
// ============================================================================

import { z } from 'zod';

// ────────────────────────────────────────────────────────────────────────────
// Precondition Schema (exported)
// ────────────────────────────────────────────────────────────────────────────

export const preconditionSchema = z
  .object({
    entity: z.string(),
    attribute: z.string(),
    value: z.unknown(),
    operator: z.enum(['eq', 'neq', 'gt', 'lt', 'contains']).optional(),
  })
  .strict();

// ────────────────────────────────────────────────────────────────────────────
// Postcondition Schema (exported)
// ────────────────────────────────────────────────────────────────────────────

export const postconditionSchema = z
  .object({
    entity: z.string(),
    attribute: z.string(),
    value: z.unknown(),
    confidence: z.number().optional(),
  })
  .strict();

// ────────────────────────────────────────────────────────────────────────────
// Shared Sub-Schemas (internal)
// ────────────────────────────────────────────────────────────────────────────

export const styleGuidanceSchema = z
  .object({
    tone: z.string().optional(),
    characterVoice: z.record(z.string(), z.string()).optional(),
    avoid: z.string().optional(),
    scenePacing: z.string().optional(),
    atmosphere: z.string().optional(),
  })
  .strict();

export const threadProgressEntrySchema = z
  .object({
    thread: z.string(),
    advancement: z.string(),
    progressAfter: z.number(),
    progressTotal: z.number(),
  })
  .strict();

export const foreshadowEntrySchema = z
  .object({
    id: z.string(),
    hint: z.string(),
    targetRevealChapter: z.number(),
    thread: z.string().optional(),
  })
  .strict();

export const relationshipChangeSchema = z
  .object({
    participants: z.tuple([z.string(), z.string()]),
    effect: z.enum(['establish', 'change', 'dissolve', 'reinforce', 'complicate']),
    direction: z.string(),
    newState: z
      .object({
        type: z.string(),
        intensity: z.number(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const ruleEffectSchema = z
  .object({
    rule: z.string(),
    effect: z.enum(['reinforce', 'weaken', 'introduce_exception', 'nullify']),
    evidence: z.string(),
  })
  .strict();

export const introduceEntrySchema = z
  .object({
    type: z.enum(['character', 'location', 'item', 'concept']),
    id: z.string(),
    initialState: z.record(z.string(), z.unknown()),
  })
  .strict();

export const logicalConsequenceSchema = z
  .object({
    description: z.string(),
    check: z
      .object({
        type: z.enum(['state_invariant', 'transition_constraint', 'progression']),
        filter: z.string(),
        assert: z.string(),
        unlessEvent: z.string().optional(),
        direction: z.string().optional(),
        tolerance: z.number().optional(),
        severity: z.enum(['error', 'warning']),
      })
      .strict(),
  })
  .strict();
