// ============================================================================
// ChecklistValidator — Validates that required narrative checklist items
// are covered by Pass 2 analysis results.
// ============================================================================
// For each event with narrativeChecklist items, checks that every required
// item has a matching checklistResults entry with covered: true.
// Events without narrativeChecklist are skipped (backward compatible).
// ============================================================================

import { z } from 'zod';
import { checklistResultSchema } from '../schemas/narrative-checklist.js';
import type { PostRenderInput, ValidationIssue, Validator } from '../types/index.js';
import { makeIssue } from './base.js';

export class ChecklistValidator implements Validator {
  name = 'checklist' as const;
  category = 'narrative_style' as const;

  validatePre(): ValidationIssue[] {
    return []; // No pre-render checks for checklist
  }

  validatePost(input: PostRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const { event, analysis } = input;

    // Skip events without analysis (no Pass 2 output to check)
    if (!analysis) return issues;

    // Skip events without a narrative checklist
    const checklist = (event as unknown as Record<string, unknown>).narrativeChecklist as
      | { items: Array<{ dimension: string; description: string; required: boolean }> }
      | undefined;
    if (!checklist?.items?.length) return issues;
    // Parse the checklistResults from the analysis payload
    const rawChecklistResults = (analysis.analysis as Record<string, unknown>).checklistResults;
    const checklistResults =
      z.array(checklistResultSchema).safeParse(rawChecklistResults).data ?? [];
    // For each required item, find a matching coverage result
    for (const item of checklist.items) {
      if (!item.required) continue;
      const result = checklistResults.find((r) => r.dimension === item.dimension);
      if (!result) {
        // Required item was not evaluated by Pass 2
        issues.push(
          makeIssue(
            this.name,
            event.id,
            'system',
            'warning',
            `Required narrative checklist item "${item.dimension}" was not evaluated by the analysis pass: ${item.description}`,
            `Ensure Pass 2 produces a checklistResult for dimension "${item.dimension}" with covered: true.`,
            'change_value',
            'narrativeChecklist',
            undefined,
            undefined,
            'evidence_mismatch',
            { field: 'checklistResults' },
          ),
        );
      } else if (!result.covered) {
        // Required item was evaluated but marked as not covered
        const evidence = result.evidence ? ` (evidence: "${result.evidence}")` : '';
        const resultIndex = checklistResults.indexOf(result);
        issues.push(
          makeIssue(
            this.name,
            event.id,
            'system',
            'warning',
            `Required narrative checklist item "${item.dimension}" is not covered: ${item.description}${evidence}`,
            `Revise the prose to cover dimension "${item.dimension}".`,
            'change_value',
            'narrativeChecklist',
            undefined,
            undefined,
            'evidence_mismatch',
            resultIndex >= 0
              ? { field: 'checklistResults', analysisPointer: `/checklistResults/${resultIndex}` }
              : { field: 'checklistResults' },
          ),
        );
      }
    }
    return issues;
  }

  getAnalysisRequirements() {
    return [
      {
        field: 'checklistResults',
        schema: z.array(checklistResultSchema),
        instruction:
          "checklistResults: For each item declared in the event's narrativeChecklist, " +
          'evaluate whether the prose covers that dimension. Report each dimension with ' +
          'covered=true/false and an optional evidence quote from the prose.',
      },
    ];
  }
}
