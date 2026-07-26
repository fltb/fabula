// ============================================================================
// FrequencyConsistencyValidator — Genette Frequency (S6b) cross-check
// ============================================================================
// validatePre: if event.frequency.type === 'repeating' or 'iterative',
//   iterationScope must be set (a non-empty object with start/end).
// validatePost: if event.frequency is declared, compare its `type` against
//   Pass 2's frequencyDetected. Mismatch = warning (not error — Pass 2 detection
//   is advisory, matching DurationConsistencyValidator's severity choice).
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

export const frequencyDetectedSchema = z.enum(['singulative', 'repeating', 'iterative']);
export type FrequencyDetected = z.infer<typeof frequencyDetectedSchema>;

export class FrequencyConsistencyValidator implements Validator {
  name = 'frequency_consistency';
  category = 'narrative_style' as const;

  validatePre(input: PreRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const { event } = input;
    if (
      event.frequency &&
      (event.frequency.type === 'repeating' || event.frequency.type === 'iterative') &&
      !event.frequency.iterationScope
    ) {
      issues.push(
        makeIssue(
          this.name,
          event.id,
          'narrative_style',
          'warning',
          `Scene "${event.id}" declares a ${event.frequency.type} frequency without iterationScope`,
          'Set iterationScope to describe the repeated/iterated span.',
          'edit_file',
          'frequency',
        ),
      );
    }
    return issues;
  }

  validatePost(input: PostRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const { event, analysis } = input;
    if (!event.frequency || !analysis?.analysis) return issues;
    const detected = frequencyDetectedSchema.safeParse(
      (analysis.analysis as Record<string, unknown>).frequencyDetected,
    );
    if (!detected.success) return issues;
    if (detected.data !== event.frequency.type) {
      issues.push(
        makeIssue(
          this.name,
          event.id,
          'narrative_style',
          'warning',
          `Scene "${event.id}" declares frequency type "${event.frequency.type}" but Pass 2 detected "${detected.data}"`,
          'Update the prose to match the declared frequency, or change the frequency declaration.',
          'edit_file',
          'frequency',
        ),
      );
    }
    return issues;
  }

  getAnalysisRequirements(): AnalysisBlockRequirement[] {
    return [
      {
        field: 'frequencyDetected',
        schema: frequencyDetectedSchema.optional(),
        instruction:
          'frequencyDetected: Classify how many times the prose narrates the event relative to how many times it occurred in story time: "singulative" (narrated once, happened once — or narrated N times, happened N times), "repeating" (narrated multiple times, happened once), or "iterative" (narrated once, happened multiple times/habitually). Report one value in the frequencyDetected field.',
      },
    ];
  }
}
