// ============================================================================
// VoiceDriftDetector — LLM-required (optional, default WARNING)
// ============================================================================

import type {
  NarrativeEvent,
  Validator,
  ValidatorContext,
  ValidationIssue,
} from '../types/index.js';
import { makeIssue } from './base.js';

export class VoiceDriftDetector implements Validator {
  name = 'voice_drift';
  category = 'narrative_style' as const;
  requiresLLM = true;

  validate(event: NarrativeEvent, context: ValidatorContext): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // Deterministic part: check forbidden words if specified in style guidance
    if (event.styleGuidance?.avoid) {
      const forbidden = event.styleGuidance.avoid.split(',').map((w) => w.trim().toLowerCase());
      // This would need the actual prose text to check — only possible after rendering
      // For now, flag as needing LLM check
      if (forbidden.length > 0) {
        issues.push(makeIssue(
          this.name, event.id, event.pov.character, 'info',
          'Voice drift check requires LLM evaluation of rendered prose.',
          'After rendering, run voice drift analysis on the prose text.',
          'manual',
        ));
      }
    }

    return issues;
  }
}
