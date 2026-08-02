// ============================================================================
// VoiceDriftDetector — Consumes Pass 2 AnalysisResult narrativeChecks
// ============================================================================

import { z } from 'zod';
import type {
  PostRenderInput,
  PreRenderInput,
  ValidationIssue,
  Validator,
} from '../types/index.js';
import { consumeNarrativeChecks, getAttributeSemanticRole, makeIssue } from './base.js';
import { narrativeCheckSchema } from './schemas.js';

export class VoiceDriftDetector implements Validator {
  name = 'voice_drift';
  category = 'narrative_style' as const;

  validatePre(_input: PreRenderInput): ValidationIssue[] {
    return [];
  }

  validatePost(input: PostRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    if (!input.analysis) return issues;

    const narrativeChecks =
      z.array(narrativeCheckSchema).safeParse(input.analysis.analysis.narrativeChecks).data ?? [];
    issues.push(
      ...consumeNarrativeChecks(
        narrativeChecks,
        (check) => {
          // Prefix match via catalog: verify voice_ attributes exist in catalog
          // Catalog has 'voice_*' template entry with semanticRole: 'narrative'
          if (!check.attribute.startsWith('voice_')) return false;

          // Catalog validation: if entity kind is known, verify the attribute is a narrative attribute
          const entityKind = input.entities?.resolve(check.entityId)?.kind;
          if (entityKind) {
            const role = getAttributeSemanticRole(
              input.entityTypeCatalog,
              entityKind,
              check.attribute,
            );
            // Accept if found with narrative role, or if undefined (wildcard 'voice_*' template)
            if (role !== undefined && role !== 'narrative') return false;
          }

          return check.matchLevel === 'absent' || check.matchLevel === 'contradicted';
        },
        (check, index) =>
          makeIssue(
            'voice_drift',
            input.event.id,
            check.entityId,
            check.matchLevel === 'contradicted' ? 'warning' : 'info',
            `Voice drift detected: ${check.hint} — ${check.evidence}`,
            'Review character voice consistency',
            'edit_file',
            'voiceNotes',
            undefined,
            undefined,
            'evidence_mismatch',
            {
              field: 'narrativeChecks',
              analysisPointer: `/narrativeChecks/${index}`,
            },
          ),
      ),
    );
    return issues;
  }

  getAnalysisRequirements() {
    return [
      {
        field: 'narrativeChecks',
        attributes: [
          'voice_formality',
          'voice_vocabulary',
          'voice_anachronism',
          'voice_action_verbs',
        ],
        schema: z.array(narrativeCheckSchema),
        instruction:
          'narrativeChecks[voice_*]: For each character, compare the prose against their expected voice characteristics from the character profile. Check formality level (voice_formality), vocabulary patterns (voice_vocabulary), anachronisms (voice_anachronism), and action verb usage (voice_action_verbs). Use the narrativeChecks block with the appropriate attribute name and report matchLevel as "exact", "similar", "absent", or "contradicted". Pay attention to distinctions between dialogue and internal narration.',
      },
    ];
  }
}
