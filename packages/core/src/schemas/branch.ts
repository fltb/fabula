// ============================================================================
// Novalistically — Branch Points File Schema
// ============================================================================

import { z } from 'zod';

export const branchPointsFileSchema = z
  .object({
    branchPoints: z.array(
      z
        .object({
          id: z.string(),
          atEvent: z.string(),
          description: z.string(),
          choices: z.array(
            z
              .object({
                path: z.string(),
                label: z.string(),
                branchId: z.string(),
                description: z.string(),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict();
