// ============================================================================
// AnachronyConsistencyValidator — Genette Anachrony (S6e) cross-check
// ============================================================================
// validatePre: if event.anachrony.type === 'analepsis' or 'prolepsis',
//   distance must be set (schema already allows it to be absent; this is a
//   stronger authoring-quality check, not a schema re-check).
// validatePost: if event.anachrony is declared, compare its `type` against
//   Pass 2's anachronyDetected. Mismatch = warning (not error — Pass 2 detection
//   is advisory, matching TenseConsistencyValidator's severity choice).
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

export const anachronyDetectedSchema = z.enum(['analepsis', 'prolepsis', 'none']);
export type AnachronyDetected = z.infer<typeof anachronyDetectedSchema>;

export class AnachronyConsistencyValidator implements Validator {
  name = 'anachrony_consistency';
  category = 'narrative_style' as const;

  validatePre(input: PreRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const { event } = input;

    // Check: if anachrony type is analepsis or prolepsis, distance must be set
    if (event.anachrony?.type === 'analepsis' || event.anachrony?.type === 'prolepsis') {
      if (!event.anachrony.distance) {
        issues.push(makeIssue(
          this.name,
          event.id,
          'narrative_style',
          'warning',
          `Scene "${event.id}" declares a ${event.anachrony.type} anachrony without distance`,
          'Set distance to describe how far the anachrony reaches.',
          'edit_file',
          'anachrony',
        ));
      }
    }

    return issues;
  }

  validatePost(input: PostRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const { event, analysis } = input;

    // Early return if event.anachrony is not declared
    if (!event.anachrony) return issues;

    if (!analysis?.analysis) return issues;

    const detected = anachronyDetectedSchema.safeParse(
      (analysis.analysis as Record<string, unknown>).anachronyDetected,
    );
    if (!detected.success) return issues;

    if (detected.data !== event.anachrony.type) {
      issues.push(makeIssue(
        this.name,
        event.id,
        'narrative_style',
        'warning',
        `Scene "${event.id}" declares anachrony type "${event.anachrony.type}" but Pass 2 detected "${detected.data}"`,
        'Update the prose to match the declared anachrony, or change the anachrony declaration.',
        'edit_file',
        'anachrony',
      ));
    }

    return issues;
  }

  getAnalysisRequirements(): AnalysisBlockRequirement[] {
    return [{
      field: 'anachronyDetected',
      schema: anachronyDetectedSchema.optional(),
      instruction: 'anachronyDetected: Classify temporal order deviation in the prose relative to story chronology: "analepsis" (flashback — narrating earlier story time out of order), "prolepsis" (flashforward — narrating later story time out of order), or "none" (no anachrony, chronological). Report one value in the anachronyDetected field.',
    }];
  }
}
