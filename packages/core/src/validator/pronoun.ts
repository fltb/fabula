// ============================================================================
// PronounValidator — Gender pronoun consistency in prose
// ============================================================================
// Checks that pronoun usage in prose matches the character's declared gender.
// Uses structured Pass 2 analysis (narrativeChecks) for entity-scoped
// pronoun consistency detection. No regex prose scanning.

import { z } from 'zod/v3';
import type { PostRenderInput, ValidationIssue, Validator } from '../types/index.js';
import {
  consumeNarrativeChecks,
  getAttributeSemanticRole,
  getAttributesBySemanticRole,
  makeIssue,
} from './base.js';
import { narrativeCheckSchema } from './schemas.js';

export class PronounValidator implements Validator {
  name = 'pronoun';
  category = 'characterization' as const;

  validatePost(input: PostRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // Check Pass 2 analysis for pronoun-related signals
    if (input.analysis) {
      const narrativeChecks =
        z.array(narrativeCheckSchema).safeParse(input.analysis.analysis.narrativeChecks).data ?? [];
      issues.push(
        ...consumeNarrativeChecks(
          narrativeChecks,
          (check) => {
            // Catalog-driven: verify attribute is a known narrative attribute
            const entityKind = input.entities?.resolve(check.entityId)?.kind;
            if (entityKind) {
              const role = getAttributeSemanticRole(
                input.entityTypeCatalog,
                entityKind,
                check.attribute,
              );
              if (role !== 'narrative') return false;
              // Further narrow to pronoun-specific narrative attributes from catalog
              const narrativeAttrs = getAttributesBySemanticRole(
                input.entityTypeCatalog,
                entityKind,
                'narrative',
              );
              const pronounAttrs: string[] = narrativeAttrs.filter(
                (a) => a === 'pronoun' || a === 'pronoun_consistency',
              );
              if (!pronounAttrs.includes(check.attribute)) return false;
            } else if (check.attribute !== 'pronoun' && check.attribute !== 'pronoun_consistency') {
              return false;
            }
            return check.matchLevel === 'absent' || check.matchLevel === 'contradicted';
          },
          (check, index) => {
            const severity = check.matchLevel === 'contradicted' ? 'error' : 'warning';
            return makeIssue(
              this.name,
              input.event.id,
              check.entityId,
              severity,
              `Pronoun consistency: "${check.hint}" — ${check.matchLevel}`,
              check.evidence,
              'manual',
              undefined,
              undefined,
              undefined,
              'evidence_mismatch',
              {
                field: 'narrativeChecks',
                analysisPointer: `/narrativeChecks/${index}`,
              },
            );
          },
        ),
      );
    }

    return issues;
  }

  getAnalysisRequirements() {
    return [
      {
        field: 'narrativeChecks',
        attributes: ['pronoun', 'pronoun_consistency'],
        schema: z.array(narrativeCheckSchema),
        instruction:
          'narrativeChecks[pronoun]: Track pronoun usage for each character (he/she/they/it) and report inconsistencies between the character\'s declared gender and the pronouns used in the prose. Use the narrativeChecks block with attribute "pronoun" or "pronoun_consistency" to flag mismatches, reporting matchLevel as "exact" for correct usage or "contradicted" for mismatches.',
      },
    ];
  }
}
