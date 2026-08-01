// ============================================================================
// DurationConsistencyValidator — Genette Duration (S6a) cross-check
// ============================================================================
// validatePre: if event.duration.type === 'ellipsis', ellipsisClarity must be set
//   (schema already allows it to be absent; this is a stronger authoring-quality
//   check, not a schema re-check).
// validatePost: if event.duration is declared, compare its `type` against
//   Pass 2's durationDetected. Mismatch = warning (not error — Pass 2 detection
//   is advisory, matching TenseConsistencyValidator's severity choice).
// ============================================================================

import { z } from 'zod';
import type {
  AnalysisBlockRequirement,
  PostRenderInput,
  PreRenderInput,
  ValidationIssue,
  Validator,
} from '../types/index.js';
import { makeIssue } from './base.js';

export const durationDetectedSchema = z.enum(['scene', 'summary', 'ellipsis', 'pause', 'stretch']);
export type DurationDetected = z.infer<typeof durationDetectedSchema>;

export class DurationConsistencyValidator implements Validator {
  name = 'duration_consistency';
  category = 'narrative_style' as const;

  validatePre(input: PreRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const { event } = input;

    if (event.duration?.type === 'ellipsis' && !event.duration.ellipsisClarity) {
      issues.push(
        makeIssue(
          this.name,
          event.id,
          'narrative_style',
          'warning',
          `Scene "${event.id}" declares an ellipsis duration without ellipsisClarity`,
          'Set ellipsisClarity to "explicit", "implicit", or "hypothetical".',
          'edit_file',
          'duration',
        ),
      );
    }

    return issues;
  }

  validatePost(input: PostRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const { event, analysis } = input;

    if (!event.duration || !analysis?.analysis) return issues;

    const detected = durationDetectedSchema.safeParse(
      (analysis.analysis as Record<string, unknown>).durationDetected,
    );
    if (!detected.success) return issues;

    if (detected.data !== event.duration.type) {
      issues.push(
        makeIssue(
          this.name,
          event.id,
          'narrative_style',
          'warning',
          `Scene "${event.id}" declares duration type "${event.duration.type}" but Pass 2 detected "${detected.data}"`,
          'Update the prose to match the declared duration, or change the duration declaration.',
          'edit_file',
          'duration',
          undefined,
          undefined,
          'interpretive_assessment',
        ),
      );
    }

    return issues;
  }

  getAnalysisRequirements(): AnalysisBlockRequirement[] {
    return [
      {
        field: 'durationDetected',
        schema: durationDetectedSchema.optional(),
        instruction:
          'durationDetected: Classify how the prose treats story time relative to narrative length: "scene" (roughly 1:1), "summary" (compressed), "ellipsis" (a gap, time skipped), "pause" (description with no story time passing), or "stretch" (narrative time exceeds story time). Report one value in the durationDetected field.',
      },
    ];
  }
}
