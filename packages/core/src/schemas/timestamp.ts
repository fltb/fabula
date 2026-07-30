import { z } from 'zod';
import type { LocatableStoryTimestamp, StoryTimestamp } from '../types/entity.js';

export const timeUnitSchema = z.enum(['minute', 'hour', 'day', 'week', 'month']);

export const authoredIndeterminateTimestampSchema = z
  .object({
    type: z.literal('indeterminate'),
    reason: z.string().min(1).optional(),
  })
  .strict();

export const authoredStoryTimeSchema = z.union([
  z.string().min(1),
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
