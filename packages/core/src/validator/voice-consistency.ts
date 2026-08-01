// ============================================================================
// VoiceConsistencyValidator — Genette Voice (S6d) cross-check
// ============================================================================
// validatePre: no pre-check needed for this dimension.
// validatePost: if event.voice is declared, compare its `level` and `relation`
//   against Pass 2's voiceDetected. Mismatch on either sub-field = warning
//   (not error — Pass 2 detection is advisory, matching TenseConsistencyValidator's
//   severity choice).
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

export const voiceDetectedSchema = z.object({
  level: z.enum(['extradiegetic', 'intradiegetic', 'metadiegetic', 'hypodiegetic']),
  relation: z.enum(['heterodiegetic', 'homodiegetic']),
});
export type VoiceDetected = z.infer<typeof voiceDetectedSchema>;

export class VoiceConsistencyValidator implements Validator {
  name = 'voice_consistency';
  category = 'narrative_style' as const;

  validatePre(_input: PreRenderInput): ValidationIssue[] {
    // No pre-check needed for this dimension
    return [];
  }

  validatePost(input: PostRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const { event, analysis } = input;
    if (!event.voice || !analysis?.analysis) return issues;

    const detected = voiceDetectedSchema.safeParse(
      (analysis.analysis as Record<string, unknown>).voiceDetected,
    );
    if (!detected.success) return issues;

    // Check level mismatch
    if (detected.data.level !== event.voice.level) {
      issues.push(
        makeIssue(
          this.name,
          event.id,
          'narrative_style',
          'warning',
          `Scene "${event.id}" declares narrative level "${event.voice.level}" but Pass 2 detected "${detected.data.level}"`,
          'Update the prose to match the declared voice, or change the voice declaration.',
          'edit_file',
          'voice.level',
          undefined,
          undefined,
          'interpretive_assessment',
        ),
      );
    }

    // Check relation mismatch
    if (detected.data.relation !== event.voice.relation) {
      issues.push(
        makeIssue(
          this.name,
          event.id,
          'narrative_style',
          'warning',
          `Scene "${event.id}" declares diegetic relation "${event.voice.relation}" but Pass 2 detected "${detected.data.relation}"`,
          'Update the prose to match the declared voice, or change the voice declaration.',
          'edit_file',
          'voice.relation',
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
        field: 'voiceDetected',
        schema: voiceDetectedSchema.optional(),
        instruction:
          'voiceDetected: Classify the narrating voice. level: "extradiegetic" (narrator outside the story), "intradiegetic" (narrator is a character telling a story within the story), "metadiegetic" (a story within the intradiegetic story), or "hypodiegetic" (nested further). relation: "heterodiegetic" (narrator absent from the story told) or "homodiegetic" (narrator present as a character). Report both in the voiceDetected object with level and relation fields.',
      },
    ];
  }
}
