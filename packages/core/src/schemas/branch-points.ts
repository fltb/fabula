// ============================================================================
// Novalistically — Branch Points File Schema (snake_case YAML → camelCase TS)
// ============================================================================

import { z } from 'zod';

export const branchChoiceSchema = z.object({
  path: z.string(),
  branchId: z.string(),
  label: z.string().optional(),
  condition: z.string().optional(),
});

export const branchPointSchema = z.object({
  id: z.string(),
  atEvent: z.string(),
  description: z.string().optional(),
  choices: z.array(branchChoiceSchema),
  defaultBranch: z.string().optional(),
});

export const branchPointsFileSchema = z.object({
  branchPoints: z.array(branchPointSchema),
});
