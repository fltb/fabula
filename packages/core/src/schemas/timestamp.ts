import { z } from 'zod';
import type { LocatableStoryTimestamp, StoryTimestamp } from '../types/entity.js';

export const timeUnitSchema = z.enum(['minute', 'hour', 'day', 'week', 'month']);

const nonblankAuthoredStringSchema = z.string().refine((value) => value.trim().length > 0, {
  message: 'Timestamp must be nonblank',
});

export const authoredIndeterminateTimestampSchema = z
  .object({
    type: z.literal('indeterminate'),
    reason: nonblankAuthoredStringSchema.optional(),
  })
  .strict();

const authoredAtTimestampSchema = z.object({ at: nonblankAuthoredStringSchema }).strict();

const authoredAfterTimestampSchema = z
  .object({
    after: z
      .object({
        ref: nonblankAuthoredStringSchema,
        amount: z.number().finite().nonnegative(),
        unit: timeUnitSchema,
      })
      .strict(),
  })
  .strict();

const authoredOffsetTimestampSchema = z
  .object({
    offset: z.object({ amount: z.number().finite(), unit: timeUnitSchema }).strict(),
  })
  .strict();

const authoredChapterTimestampSchema = z
  .object({ chapter: z.number().finite().int().nonnegative() })
  .strict();

export const authoredLocatableStoryTimeSchema = z.union([
  nonblankAuthoredStringSchema,
  authoredAtTimestampSchema,
  authoredAfterTimestampSchema,
  authoredOffsetTimestampSchema,
  authoredChapterTimestampSchema,
]);

export const authoredStoryTimeSchema = z.union([
  authoredLocatableStoryTimeSchema,
  authoredIndeterminateTimestampSchema,
]);

export const absoluteTimestampSchema = z
  .object({ type: z.literal('absolute'), value: z.string().min(1) })
  .strict();

export const relativeTimestampSchema = z
  .object({
    type: z.literal('relative'),
    anchor: z.string().min(1),
    offset: z
      .object({ amount: z.number().finite().nonnegative(), unit: timeUnitSchema })
      .strict(),
  })
  .strict();

export const chapterTimestampSchema = z
  .object({ type: z.literal('chapter'), chapter: z.number().finite().int() })
  .strict();

export const storyOffsetTimestampSchema = z
  .object({ type: z.literal('offset'), amount: z.number().finite(), unit: timeUnitSchema })
  .strict();

export const locatableStoryTimestampSchema: z.ZodType<LocatableStoryTimestamp> = z.union([
  absoluteTimestampSchema,
  relativeTimestampSchema,
  chapterTimestampSchema,
  storyOffsetTimestampSchema,
]);

export const indeterminateTimestampSchema = z
  .object({
    type: z.literal('indeterminate'),
    mode: z.enum(['unspecified', 'intentional']),
    reason: z.string().min(1).optional(),
  })
  .strict();

export const storyTimestampSchema: z.ZodType<StoryTimestamp> = z.union([
  locatableStoryTimestampSchema,
  indeterminateTimestampSchema,
]);
