// ============================================================================
// FocalizationConsistencyValidator — Genette Focalization (S6c) cross-check
// ============================================================================
// validatePre: if event.focalization.type === 'internal' and
//   variation === 'multiple', characterSequence must have length >= 2.
// validatePost: if event.focalization is declared, compare its type against
//   Pass 2's focalizationDetected. Mismatch = warning.
// ============================================================================

import type {
  Validator,
  ValidationIssue,
  PostRenderInput,
  PreRenderInput,
  AnalysisBlockRequirement,
} from '../types/index.js';
import { makeIssue } from './base.js';
import { z } from 'zod';

export const focalizationDetectedSchema = z.enum(['zero', 'internal', 'external']);
export type FocalizationDetected = z.infer<typeof focalizationDetectedSchema>;

export class FocalizationConsistencyValidator implements Validator {
  name = 'focalization_consistency';
  category = 'narrative_style' as const;

  validatePre(input: PreRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const { event } = input;

    if (
      event.focalization?.type === 'internal' &&
      event.focalization.variation === 'multiple' &&
      (event.focalization.characterSequence?.length ?? 0) < 2
    ) {
      issues.push(
        makeIssue(
          this.name,
          event.id,
          'narrative_style',
          'warning',
          `Scene "${event.id}" declares multiple internal focalization but characterSequence has fewer than 2 entries`,
          'Add at least 2 entries to characterSequence to justify "multiple" variation.',
          'edit_file',
          'focalization',
        ),
      );
    }

    return issues;
  }

  validatePost(input: PostRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const { event, analysis } = input;

    if (!event.focalization || !analysis?.analysis) return issues;

    const detected = focalizationDetectedSchema.safeParse(
      (analysis.analysis as Record<string, unknown>).focalizationDetected,
    );
    if (!detected.success) return issues;

    if (detected.data !== event.focalization.type) {
      issues.push(
        makeIssue(
          this.name,
          event.id,
          'narrative_style',
          'warning',
          `Scene "${event.id}" declares focalization type "${event.focalization.type}" but Pass 2 detected "${detected.data}"`,
          'Update the prose to match the declared focalization, or change the focalization declaration.',
          'edit_file',
          'focalization',
        ),
      );
    }

    return issues;
  }

  getAnalysisRequirements(): AnalysisBlockRequirement[] {
    return [
      {
        field: 'focalizationDetected',
        schema: focalizationDetectedSchema.optional(),
        instruction:
          'focalizationDetected: Classify the point-of-view restriction in the prose: "zero" (omniscient, no restriction), "internal" (limited to one character\'s knowledge/perception), or "external" (camera-like, no access to any character\'s interiority). Report one value in the focalizationDetected field.',
      },
    ];
  }
}
