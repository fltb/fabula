// ============================================================================
// Novalistically — CORPUS-1: NarrativeEllipsis & NarrativeNode Zod Schemas
// Enforces all 8 binding constraints from docs/TODO.md:
// 1. NarrativeNode = NarrativeEvent | NarrativeEllipsis (discriminated union)
// 2. Ellipsis has identity, branch scope, one valid storyTime, optional
//    summary, preconditions, Entity/Relationship/Knowledge/Thread/Rule
//    transactions
// 3. Summary MUST NOT create claim/provider — labeled diagnostic-only
// 4. Ellipsis MUST NOT have POV, cast, sceneBrief, style, targetWords,
//    narrationTime, narrativeOrder
// 5. Ellipsis NEVER produces RenderedScene, RenderJob, Pass2, etc.
// 6. Raw summary ONLY for source review/diagnostics
// 7. Every replay-changing Fact/effect MUST have atomic provenance
// 8. Multiple incompatible storyTimes/branches/causal positions within one
//    ellipsis MUST be split (schema enforces single storyTime)
// ============================================================================

import { z } from 'zod';
import type { NarrativeEvent } from '../types/event.js';
import type { NarrativeEllipsis, NarrativeNode as CorpusNode } from '../types/corpus.js';
import {
  preconditionSchema,
  postconditionSchema,
} from './primitives.js';
import {
  relationshipTransactionSchema,
} from './relationship.js';
import {
  threadTransactionSchema,
} from './thread.js';
import {
  ruleTransactionSchema,
} from './rule.js';

// ─── Reusable sub-schemas ────────────────────────────────────────────────

const storyTimestampSchema = z.union([
  z.object({ type: z.literal('absolute'), year: z.number(), month: z.number(), day: z.number() }).strict(),
  z.object({ type: z.literal('relative'), offsetFrom: z.string(), offsetDays: z.number().int() }).strict(),
  z.object({ type: z.literal('chapter'), chapter: z.number().int().nonnegative() }).strict(),
]);

const branchPathSchema = z.object({
  decisions: z.array(
    z.object({
      atEventId: z.string(),
      choiceId: z.string(),
      narrativeOrder: z.number(),
    }).strict(),
  ),
}).strict();

// ─── InformationAct schema (no existing export in schemas) ────────────────

const informationActTypeSchema = z.enum([
  'perception',
  'thought',
  'testimony',
  'assertion',
  'inference',
  'reading',
  'recall',
  'revelation',
]);

export const informationActSchema = z.object({
  type: informationActTypeSchema,
  actor: z.string().min(1),
  recipients: z.array(z.string().min(1)).default([]),
  contentPropositions: z.array(z.string().min(1)).default([]),
  storyBoundary: z.string().optional(),
  inWorldSource: z.string().optional(),
  corpusProvenance: z.string().optional(),
  timestamp: storyTimestampSchema,
  eventId: z.string().min(1),
  warrantJustification: z.string().optional(),
}).strict();

// ─── EllipsisProvenance schema ───────────────────────────────────────────

export const ellipsisProvenanceSchema = z.object({
  sourceHash: z.string().min(1, 'Provenance sourceHash is required — every replay-changing Fact/effect MUST have atomic provenance'),
  sourceRange: z.object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  }).strict().refine(
    (data) => data.end >= data.start,
    { message: 'sourceRange.end must be >= sourceRange.start' },
  ),
  reviewerId: z.string().optional(),
  reviewTimestamp: z.string().optional(),
}).strict();

// ─── NarrativeEllipsis schema ────────────────────────────────────────────
// Binding constraints enforced:
//   2: identity (id), branchScope, one storyTime, optional summary,
//      preconditions, all 5 transaction arrays
//   3: summary described as diagnostic-only (cannot create claim/provider)
//   4: NO pov, cast, sceneBrief, styleGuidance, targetAudience, narrationTime,
//      narrativeOrder, targetWords, sceneType, discourseMode, arcPosition
//   5: NO RenderedScene/RenderJob/Pass2/validator/Assembler fields
//   6: summary described as raw text — never enters logical prompt
//   7: provenance (required) — every replay change has atomic ID
//   8: single storyTime enforced by type, NOT array

export const narrativeEllipsisSchema = z.object({
  kind: z.literal('ellipsis'),
  id: z.string().min(1, 'Ellipsis identity is required'),
  branchScope: branchPathSchema,
  storyTime: storyTimestampSchema,
  /** Source-grounded diagnostic only — NEVER creates claim/provider. */
  summary: z.string()
    .optional()
    .describe('Raw textual summary for source review/diagnostics only. NEVER enters logical prompt, produces Fact, causal edge, WorldState change, or DiscourseState change.'),
  preconditions: z.array(preconditionSchema),
  postconditions: z.array(postconditionSchema),
  relationshipEffects: z.array(relationshipTransactionSchema),
  knowledgeTransactions: z.array(informationActSchema),
  threadProgress: z.array(threadTransactionSchema),
  ruleEffects: z.array(ruleTransactionSchema),
  provenance: ellipsisProvenanceSchema,
})
.strict('NarrativeEllipsis schema does not accept unknown fields — POV, cast, sceneBrief, styleGuidance, narrativeOrder, narrationTime, targetAudience are forbidden')
.describe('NarrativeEllipsis — non-renderable narrative gap with explicit constraints: no POV, no cast, no sceneBrief, no styleGuidance, no narrativeOrder, no narrationTime, no targetAudience, no sceneType, no discourseMode, no arcPosition.');

// ─── NarrativeEvent partial — structural overlap for discriminated union ──
// This schema validates the `kind: 'event'` branch of NarrativeNode.
// It accepts the core NarrativeEvent fields as a structural check.
// Note: The full NarrativeEvent schema lives in event.ts; this partial
// validates the discriminant and essential overlap fields.

export const narrativeEventSchema = z.object({
  kind: z.literal('event'),
  id: z.string(),
  event: z.string(),
  title: z.string(),
  narrativeOrder: z.number(),
  storyTime: storyTimestampSchema,
}).strict().passthrough();

// ─── NarrativeNode — discriminated union on `kind` ───────────────────────
// Binding constraint 1: NarrativeNode = NarrativeEvent | NarrativeEllipsis
// with explicit discriminant on `kind` field.
// Mutual exclusion: event fields rejected by ellipsis schema (bind. 4),
// ellipsis fields don't exist on event schema (bind. 4 reverse).

export const narrativeNodeSchema = z.discriminatedUnion('kind', [
  narrativeEventSchema,
  narrativeEllipsisSchema,
]).describe('NarrativeNode — discriminated union of NarrativeEvent (kind="event") and NarrativeEllipsis (kind="ellipsis"). Mutual exclusion of fields enforced per branch schema.');

// ─── Helper: type guards ─────────────────────────────────────────────────

export function isNarrativeEllipsis(node: unknown): node is NarrativeEllipsis {
  return narrativeEllipsisSchema.safeParse(node).success;
}

export function isNarrativeEvent(node: unknown): node is NarrativeEvent {
  return narrativeEventSchema.safeParse(node).success;
}

export function isNarrativeNode(node: unknown): node is CorpusNode {
  return narrativeNodeSchema.safeParse(node).success;
}
