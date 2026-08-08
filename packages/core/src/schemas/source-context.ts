// ============================================================================
// Novalistically — Source Context Zod Schemas (S4)
// ============================================================================

import { z } from 'zod/v3';
import type { SourceContext, SourceContextEntry } from '../types/source-context.ts';

// ── SourceContextEntry Schema ─────────────────────────────────────────────────

export const sourceContextEntrySchema = z
  .object({
    excerpt: z.string().min(1, 'Source excerpt must not be empty'),
    classification: z.enum(['STYLE', 'FACT', 'MIXED'], {
      required_error: 'Classification must be STYLE, FACT, or MIXED',
      invalid_type_error: 'Classification must be one of: STYLE, FACT, MIXED',
    }),
    styleNote: z.string().optional(),
  })
  .strict();

// ── SourceContext Schema ──────────────────────────────────────────────────────

export const sourceContextSchema = z
  .object({
    entries: z
      .array(sourceContextEntrySchema)
      .min(1, 'Source context must contain at least one entry'),
  })
  .strict();

// ── Parser function ───────────────────────────────────────────────────────────

/**
 * Parse and validate a raw object against the SourceContext schema.
 * Returns the validated data or throws a ZodError.
 */
export function parseSourceContext(raw: unknown): SourceContext {
  return sourceContextSchema.parse(raw) as SourceContext;
}

/**
 * Safe parse — returns a result object instead of throwing.
 */
export function safeParseSourceContext(raw: unknown) {
  return sourceContextSchema.safeParse(raw);
}

// ── Type re-exports for convenience ───────────────────────────────────────────

export type { SourceContext, SourceContextEntry };
