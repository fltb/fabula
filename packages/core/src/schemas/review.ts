import { z } from 'zod/v3';

const nonEmptyString = z.string().trim().min(1);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const uuidSchema = z.string().uuid();

const reviewTargetBaseSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('novel'), id: z.literal('novel') }).strict(),
  z.object({ type: z.literal('chapter'), id: z.string().regex(/^chapter:[1-9]\d*$/) }).strict(),
  z.object({ type: z.literal('scene'), id: nonEmptyString }).strict(),
  z
    .object({
      type: z.literal('line'),
      id: nonEmptyString,
      lineRange: z.tuple([z.number().int().positive(), z.number().int().positive()]),
      lineBasis: z.object({ revisionId: uuidSchema, proseHash: hashSchema }).strict(),
    })
    .strict(),
  z.object({ type: z.literal('character'), id: nonEmptyString }).strict(),
  z.object({ type: z.literal('worldrule'), id: nonEmptyString }).strict(),
]);

const reviewTargetSchema = reviewTargetBaseSchema.superRefine((target, context) => {
  if (target.type === 'line' && target.lineRange[1] < target.lineRange[0]) {
    context.addIssue({ code: 'custom', message: 'lineRange end must be >= start' });
  }
});

export const newReviewCommentSchema = z
  .object({
    target: reviewTargetSchema,
    severity: z.enum(['nit', 'suggestion', 'blocking']),
    category: z.enum([
      'style',
      'pacing',
      'character_voice',
      'plot_logic',
      'world_consistency',
      'reader_experience',
    ]),
    content: nonEmptyString,
  })
  .strict();

export const reviewApplicationV1Schema = z
  .object({
    eventId: nonEmptyString,
    revisionId: uuidSchema,
    operationId: uuidSchema,
    appliedAt: z.string().datetime(),
  })
  .strict();

export const reviewCommentSchema = newReviewCommentSchema
  .extend({
    id: nonEmptyString,
    author: z.enum(['human', 'llm']),
    actorId: nonEmptyString,
    status: z.enum(['open', 'addressed', 'resolved', 'wontfix', 'superseded']),
    applications: z.array(reviewApplicationV1Schema),
    supersedesId: nonEmptyString.optional(),
    resolvedBy: z.string().optional(),
    createdAt: z.string().datetime(),
    resolvedAt: z.string().datetime().optional(),
  })
  .strict();

const patchChangeSchema = z
  .object({
    type: z.enum(['rewrite', 'insert', 'delete', 'attribute_change']),
    target: nonEmptyString,
    oldValue: z.unknown().optional(),
    newValue: z.unknown().refine((v) => v !== undefined, { message: 'Required' }),
    rationale: z.string(),
  })
  .strict();

const reviewPatchSchema = z
  .object({
    sourceReviewIds: z.array(nonEmptyString),
    description: z.string(),
    changes: z.array(patchChangeSchema),
  })
  .strict();

export const reviewLedgerV1Schema = z
  .object({
    version: z.literal(1),
    comments: z.array(reviewCommentSchema),
    patches: z.array(reviewPatchSchema),
  })
  .strict();

export const reviewEventKindSchema = z.enum([
  'comment_added',
  'comment_replaced',
  'comment_status_changed',
  'comment_applied',
  'gate_opened',
  'gate_decided',
  'gate_superseded',
]);

/** Event as submitted for append: the store assigns `sequence`. */
export const reviewEventDraftV1Schema = z
  .object({
    version: z.literal(1),
    projectId: z.string().trim().min(1),
    kind: reviewEventKindSchema,
    commentId: z.string().trim().min(1).optional(),
    gateId: z.string().trim().min(1).optional(),
    payload: z.unknown(),
    actorId: z.string().optional(),
    createdAt: z.string().datetime(),
  })
  .strict();

/** Immutable stored event with its store-assigned sequence. */
export const reviewEventRecordV1Schema = reviewEventDraftV1Schema.extend({
  sequence: z.number().int().positive(),
});
