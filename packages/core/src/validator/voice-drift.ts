// ============================================================================
// VoiceDriftDetector — Consumes Pass 2 AnalysisResult narrativeChecks
// ============================================================================

import type {
  PreRenderInput,
  Validator,
  ValidationIssue,
  PostRenderInput,
} from '../types/index.js';
import { makeIssue } from './base.js';

export class VoiceDriftDetector implements Validator {
  name = 'voice_drift';
  category = 'narrative_style' as const;

  validatePre(_input: PreRenderInput): ValidationIssue[] {
    return [];
  }

  validatePost(input: PostRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    if (!input.analysis) return issues;

    const narrativeChecks = input.analysis.analysis.narrativeChecks ?? [];
    for (const check of narrativeChecks) {
      if (!check.attribute.startsWith('voice_')) continue;
      if (check.matchLevel === 'absent' || check.matchLevel === 'contradicted') {
        issues.push(makeIssue(
          'voice_drift',
          input.event.id,
          check.entityId,
          check.matchLevel === 'contradicted' ? 'warning' : 'info',
          `Voice drift detected: ${check.hint} — ${check.evidence}`,
          'Review character voice consistency',
          'edit_file',
          'voiceNotes',
        ));
      }
    }
    return issues;
  }

  getAnalysisRequirements() {
    return [{
      field: 'narrativeChecks',
      attributes: ['voice_formality', 'voice_vocabulary', 'voice_anachronism', 'voice_action_verbs'],
      schemaExample: { entityId: 'char_001', attribute: 'voice_formality', hint: '...', evidence: '...', matchLevel: 'exact' },
      instruction: 'narrativeChecks[voice_*]: For each character, compare the prose against their expected voice characteristics from the character profile. Check formality level (voice_formality), vocabulary patterns (voice_vocabulary), anachronisms (voice_anachronism), and action verb usage (voice_action_verbs). Use the narrativeChecks block with the appropriate attribute name and report matchLevel as "exact", "similar", "absent", or "contradicted". Pay attention to distinctions between dialogue and internal narration.',
    }];
  }
}
