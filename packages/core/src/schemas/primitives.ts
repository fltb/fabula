// ============================================================================
// Novalistically — Shared primitive Zod schemas used by entity schemas
// ============================================================================

import { z } from 'zod/v3';

// ────────────────────────────────────────────────────────────────────────────
// Placeholder pattern — rejected in value fields
// ────────────────────────────────────────────────────────────────────────────

const PLACEHOLDER_PATTERN = /^(changed|resolved|updated|affected|modified|altered)$/i;

// ────────────────────────────────────────────────────────────────────────────
// Precondition Schema (exported)
// ────────────────────────────────────────────────────────────────────────────

export const preconditionSchema = z
  .object({
    entity: z.string(),
    attribute: z.string(),
    value: z
      .unknown()
      .optional()
      .refine(
        (val) => {
          if (val === undefined) return true;
          if (typeof val === 'string' && PLACEHOLDER_PATTERN.test(val)) {
            return false;
          }
          return true;
        },
        {
          message:
            'Placeholder values (changed, resolved, updated, affected, modified, altered) are not allowed. Use concrete values.',
        },
      ),
    narrativeHint: z.string().optional(),
    confidence: z.number().optional(),
    operator: z
      .enum([
        'eq',
        'neq',
        'gt',
        'gte',
        'lt',
        'lte',
        'contains',
        'not_contains',
        'exists',
        'not_exists',
      ])
      .optional(),
  })
  .strict()
  .superRefine((data, context) => {
    const hasValue = data.value !== undefined;
    const hasNarrativeHint = data.narrativeHint !== undefined;

    // Mutual exclusivity: value XOR narrativeHint for precondition facts
    if (hasValue && hasNarrativeHint) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Fact must contain exactly one of value or narrativeHint',
      });
    }

    // exists / not_exists: value must be absent
    if (data.operator === 'exists' || data.operator === 'not_exists') {
      if (hasValue) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['value'],
          message: 'exists/not_exists operator must not have a value',
        });
      }
    }

    // Comparison operators (eq/neq/gt/gte/lt/lte/contains/not_contains): value required
    if (
      data.operator !== undefined &&
      data.operator !== 'exists' &&
      data.operator !== 'not_exists'
    ) {
      if (!hasValue) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['value'],
          message: `Operator '${data.operator}' requires a value`,
        });
      }
    }
  });

// ────────────────────────────────────────────────────────────────────────────
// Postcondition Schema (exported)
// ────────────────────────────────────────────────────────────────────────────

export const postconditionSchema = z
  .object({
    entity: z.string(),
    attribute: z.string(),
    value: z
      .unknown()
      .optional()
      .refine(
        (val) => {
          if (val === undefined) return true;
          if (typeof val === 'string' && PLACEHOLDER_PATTERN.test(val)) {
            return false;
          }
          return true;
        },
        {
          message:
            'Placeholder values (changed, resolved, updated, affected, modified, altered) are not allowed. Use concrete values.',
        },
      ),
    narrativeHint: z.string().optional(),
    confidence: z.number().optional(),
    operation: z.enum(['set', 'unset']).optional(),
  })
  .strict()
  .superRefine((data, context) => {
    const hasValue = data.value !== undefined;
    const hasNarrativeHint = data.narrativeHint !== undefined;
    const op = data.operation;

    // Three forms:
    // 1. value + (omit 'set' or explicit 'set') → deterministic write
    // 2. 'unset' operation, no value, no narrativeHint → delete attribute
    // 3. narrativeHint only, no operation → semantic description only

    // Form 2: unset
    if (op === 'unset') {
      if (hasValue) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['value'],
          message: 'Unset operation must not have a value',
        });
      }
      if (hasNarrativeHint) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['narrativeHint'],
          message: 'Unset operation must not have a narrativeHint',
        });
      }
      return;
    }

    // Mutual exclusivity: value XOR narrativeHint
    if (hasValue && hasNarrativeHint) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Fact must contain exactly one of value or narrativeHint',
      });
    } else if (!hasValue && !hasNarrativeHint) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Fact must contain one of value, narrativeHint, or unset operation',
      });
    }
  });

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
    targetWordCount: z.number().optional(),
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
