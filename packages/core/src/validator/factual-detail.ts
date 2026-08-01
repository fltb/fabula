// ============================================================================
// FactualDetailValidator — LLM-assisted detail checking
// ============================================================================

import { z } from 'zod';
import type {
  PostRenderInput,
  PreRenderInput,
  ValidationIssue,
  Validator,
} from '../types/index.js';
import { makeIssue } from './base.js';

export const inventedDetailSchema = z.object({
  detail: z.string(),
  severity: z.enum(['minor', 'major']),
});
export type InventedDetail = z.infer<typeof inventedDetailSchema>;

export class FactualDetailValidator implements Validator {
  name = 'factual_detail';
  category = 'factual_detail' as const;

  validatePre(_input: PreRenderInput): ValidationIssue[] {
    return [];
  }

  validatePost(input: PostRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const analysis = input.analysis;

    if (!analysis) return issues;

    const inventedResult = z
      .array(inventedDetailSchema)
      .safeParse(analysis.analysis.inventedDetails);
    const details = inventedResult.success ? inventedResult.data : [];
    for (const detail of details) {
      if (detail.severity !== 'major') continue;

      const detailIndex = details.indexOf(detail);
      issues.push(
        makeIssue(
          this.name,
          input.event.id,
          'system',
          'warning',
          `Major invented detail: "${detail.detail}" — not specified in event definitions.`,
          'Add this detail to event preconditions/postconditions, or mark it intentional.',
          'manual',
          undefined,
          undefined,
          undefined,
          'evidence_mismatch',
          detailIndex >= 0
            ? { field: 'inventedDetails', analysisPointer: `/inventedDetails/${detailIndex}` }
            : { field: 'inventedDetails' },
        ),
      );
    }

    return issues;
  }

  getAnalysisRequirements() {
    return [
      {
        field: 'inventedDetails',
        schema: z.array(inventedDetailSchema),
        instruction:
          'inventedDetails: List any significant details in the prose that are not present in the event specification. For each invented detail, note the detail text and whether its severity is "minor" (e.g., atmospheric description) or "major" (plot or character change not in the specification). Report in the inventedDetails block.',
      },
    ];
  }
}
