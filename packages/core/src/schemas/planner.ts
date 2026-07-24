// ============================================================================
// Novalistically — S8: Planner Zod Schemas
// ============================================================================

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Placeholder pattern — reused from primitives
// ---------------------------------------------------------------------------
const PLACEHOLDER_PATTERN = /^(changed|resolved|updated|affected|modified|altered)$/i;

// ---------------------------------------------------------------------------
// Precondition schema
// ---------------------------------------------------------------------------
export const preconditionSchema = z
  .object({
    entity: z.string(),
    attribute: z.string(),
    value: z.unknown().optional().refine(
      (val) => {
        if (val === undefined) return true;
        if (typeof val === 'string' && PLACEHOLDER_PATTERN.test(val)) {
          return false;
        }
        return true;
      },
      { message: 'Placeholder values (changed, resolved, updated, affected, modified, altered) are not allowed. Use concrete values.' },
    ),
    narrativeHint: z.string().optional(),
    confidence: z.number().optional(),
    operator: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'not_contains', 'exists', 'not_exists']).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const hasValue = data.value !== undefined;
    const hasNarrativeHint = data.narrativeHint !== undefined;

    // Mutual exclusivity: value XOR narrativeHint
    if (hasValue && hasNarrativeHint) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Precondition must contain exactly one of value or narrativeHint',
      });
    }

    // exists / not_exists: value must be absent
    if (data.operator === 'exists' || data.operator === 'not_exists') {
      if (hasValue) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['value'],
          message: 'exists/not_exists operator must not have a value',
        });
      }
    }

    // Comparison operators require a value
    if (data.operator !== undefined && data.operator !== 'exists' && data.operator !== 'not_exists') {
      if (!hasValue) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['value'],
          message: `Operator '${data.operator}' requires a value`,
        });
      }
    }
  });

// ---------------------------------------------------------------------------
// Effect schema
// ---------------------------------------------------------------------------
export const effectSchema = z
  .object({
    entity: z.string(),
    attribute: z.string(),
    value: z.unknown().optional().refine(
      (val) => {
        if (val === undefined) return true;
        if (typeof val === 'string' && PLACEHOLDER_PATTERN.test(val)) {
          return false;
        }
        return true;
      },
      { message: 'Placeholder values (changed, resolved, updated, affected, modified, altered) are not allowed. Use concrete values.' },
    ),
    confidence: z.number().optional(),
    narrativeHint: z.string().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const hasValue = data.value !== undefined;
    const hasNarrativeHint = data.narrativeHint !== undefined;

    if (hasValue && hasNarrativeHint) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Effect must contain exactly one of value or narrativeHint',
      });
    }
  });

// ---------------------------------------------------------------------------
// NarrativePlannerMode schema
// ---------------------------------------------------------------------------
export const narrativePlannerModeSchema = z.enum(['manual', 'suggest', 'auto']);

// ---------------------------------------------------------------------------
// SuccessCondition schema
// ---------------------------------------------------------------------------
const successConditionSchema = z
  .object({
    entity: z.string(),
    attribute: z.string(),
    operator: z.enum(['eq', 'neq', 'gt', 'lt', 'contains', 'exists']),
    value: z.unknown(),
  })
  .strict();

// ---------------------------------------------------------------------------
// NarrativeGoal schema
// ---------------------------------------------------------------------------
export const narrativeGoalSchema = z
  .object({
    goalId: z.string(),
    threadId: z.string(),
    description: z.string(),
    type: z.enum(['achieve', 'maintain', 'avoid', 'resolve']),
    priority: z.number(),
    preconditions: z.array(z.any()).optional(),
    successCondition: successConditionSchema,
    suggestedEvents: z.array(z.string()).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// ActionDefinition schema
// ---------------------------------------------------------------------------
export const actionDefinitionSchema = z
  .object({
    actionId: z.string(),
    name: z.string(),
    description: z.string(),
    preconditions: z.array(preconditionSchema),
    effects: z.array(effectSchema),
    narrativeTags: z.array(z.string()),
    typicalDuration: z.number(),
    typicalArcPositions: z.array(z.string()),
    conflictTypes: z.array(z.string()).optional(),
    resolutionTypes: z.array(z.string()).optional(),
    relatedThreadTypes: z.array(z.string()).optional(),
  })
  .strict();
