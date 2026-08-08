// ============================================================================
// Novalistically — Event-local game dialogue choice schemas
// ============================================================================

import { z } from 'zod/v3';
import { postconditionSchema } from './primitives.js';

/**
 * Effects intentionally reuse ordinary postcondition validation so deterministic,
 * semantic-hint, and unset mutations share one authoring contract.
 */
export const gameDialogueEffectSchema = postconditionSchema;

export const gameDialogueChoiceSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    description: z.string(),
    targetEvent: z.string(),
    effects: z.array(gameDialogueEffectSchema).default([]),
  })
  .strict();

/** Optional at EventFile level; explicit decision nodes must be nonempty and unique. */
export const gameDialogueChoicesSchema = z
  .array(gameDialogueChoiceSchema)
  .nonempty('A decision event must declare at least one choice')
  .superRefine((choices, context) => {
    const seen = new Set<string>();
    for (const [index, choice] of choices.entries()) {
      if (seen.has(choice.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'id'],
          message: `Choice id '${choice.id}' must be unique within its event`,
        });
      }
      seen.add(choice.id);
    }
  });
