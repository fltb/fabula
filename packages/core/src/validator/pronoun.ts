// ============================================================================
// PronounValidator — Gender pronoun consistency in prose
// ============================================================================
// Checks that pronoun usage in prose matches the character's declared gender.
// Uses structured Pass 2 analysis (narrativeChecks) for entity-scoped
// pronoun consistency detection. No regex prose scanning.

import type {
  PostRenderInput,
  Validator,
  ValidationIssue,
} from '../types/index.js';
import { makeIssue } from './base.js';
import { z } from 'zod';
import { narrativeCheckSchema } from './schemas.js';


export class PronounValidator implements Validator {
  name = 'pronoun';
  category = 'characterization' as const;

  validatePost(input: PostRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // Check Pass 2 analysis for pronoun-related signals
    if (input.analysis) {
      const narrativeChecks = z.array(narrativeCheckSchema).safeParse(input.analysis.analysis.narrativeChecks).data ?? [];
      for (const check of narrativeChecks) {
        if (check.attribute === 'pronoun' || check.attribute === 'pronoun_consistency') {
          if (check.matchLevel === 'absent' || check.matchLevel === 'contradicted') {
            const severity = check.matchLevel === 'contradicted' ? 'error' : 'warning';
            issues.push(makeIssue(
              this.name,
              input.event.id,
              check.entityId,
              severity,
              `Pronoun consistency: "${check.hint}" — ${check.matchLevel}`,
              check.evidence,
              'manual',
            ));
          }
        }
      }
    }

    return issues;
  }

  getAnalysisRequirements() {
    return [{
      field: 'narrativeChecks',
      attributes: ['pronoun', 'pronoun_consistency'],
      schema: z.array(narrativeCheckSchema),
      instruction: 'narrativeChecks[pronoun]: Track pronoun usage for each character (he/she/they/it) and report inconsistencies between the character\'s declared gender and the pronouns used in the prose. Use the narrativeChecks block with attribute "pronoun" or "pronoun_consistency" to flag mismatches, reporting matchLevel as "exact" for correct usage or "contradicted" for mismatches.',
    }];
  }
}
