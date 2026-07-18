// ============================================================================
// PronounValidator — Gender pronoun consistency in prose
// ============================================================================
//
// Checks that pronoun usage in prose matches the character's declared gender.
// Supports both English (he/she, him/her, his/her) and Chinese (他/她).
// ============================================================================

import type {
  PostRenderInput,
  Validator,
  ValidationIssue,
} from '../types/index.js';
import { makeIssue } from './base.js';

// ── Pronoun tables ────────────────────────────────────────────────────────────

interface PronounSet {
  male: RegExp;
  female: RegExp;
}

const PRONOUN_TABLES: PronounSet[] = [
  // English pronouns (case-insensitive)
  {
    male: /\b(?:he|him|his|himself)\b/i,
    female: /\b(?:she|her|hers|herself)\b/i,
  },
  // Chinese pronouns
  {
    male: /他/g,
    female: /她/g,
  },
];

// Characters commonly used to separate dialogue from narrative
const DIALOGUE_BOUNDARY = /[""''「」『』]/;

export class PronounValidator implements Validator {
  name = 'pronoun';
  category = 'characterization' as const;

  validatePost(input: PostRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const { event, prose, analysis, worldState } = input;

    // For each participant character that has a gender, check pronoun consistency
    const participants = event.participants.entities ?? [];

    for (const charId of participants) {
      const entityState = worldState.entities[charId];
      if (!entityState) continue;

      const gender = entityState['gender'] as string | undefined;
      if (!gender) continue;

      const lowerGender = gender.toLowerCase();

      // Only check binary gender pronouns for now
      if (lowerGender !== 'male' && lowerGender !== 'female' && lowerGender !== 'm' && lowerGender !== 'f') {
        continue;
      }

      const isMale = lowerGender === 'male' || lowerGender === 'm';

      // Get the character's name for context
      const charName = (entityState['name'] as string) ?? charId;

      // Count pronouns in narrative prose (skip dialogue)
      const narrativeParts = prose.split(DIALOGUE_BOUNDARY);
      // Even indices are narrative (dialogue is odd indices in balanced quotes)
      const narrativeProse = narrativeParts.filter((_, i) => i % 2 === 0).join(' ');

      for (const table of PRONOUN_TABLES) {
        const maleMatches = narrativeProse.match(table.male);
        const femaleMatches = narrativeProse.match(table.female);

        const maleCount = maleMatches?.length ?? 0;
        const femaleCount = femaleMatches?.length ?? 0;

        // If no pronouns found, skip
        if (maleCount === 0 && femaleCount === 0) continue;

        if (isMale && femaleCount > maleCount) {
          issues.push(makeIssue(
            this.name,
            event.id,
            charId,
            'warning',
            `Character "${charName}" (${charId}) is declared male/gender "${gender}" but prose uses ${femaleCount} female pronouns vs ${maleCount} male pronouns`,
            'Replace female pronouns with male pronouns when referring to this character.',
            'edit_file',
            undefined,
            undefined,
            { maleCount, femaleCount },
          ));
        } else if (!isMale && maleCount > femaleCount) {
          issues.push(makeIssue(
            this.name,
            event.id,
            charId,
            'warning',
            `Character "${charName}" (${charId}) is declared female/gender "${gender}" but prose uses ${maleCount} male pronouns vs ${femaleCount} female pronouns`,
            'Replace male pronouns with female pronouns when referring to this character.',
            'edit_file',
            undefined,
            undefined,
            { maleCount, femaleCount },
          ));
        }
      }
    }

    // Also check Pass 2 analysis for pronoun-related signals
    if (analysis) {
      const narrativeChecks = analysis.analysis.narrativeChecks ?? [];
      for (const check of narrativeChecks) {
        if (check.attribute === 'pronoun' || check.attribute === 'pronoun_consistency') {
          if (check.matchLevel === 'absent' || check.matchLevel === 'contradicted') {
            issues.push(makeIssue(
              this.name,
              event.id,
              check.entityId,
              'warning',
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
      schemaExample: { entityId: 'char_001', attribute: 'pronoun', hint: '...', evidence: '...', matchLevel: 'exact' },
      instruction: 'narrativeChecks[pronoun]: Track pronoun usage for each character (he/she/they/it) and report inconsistencies between the character\'s declared gender and the pronouns used in the prose. Use the narrativeChecks block with attribute "pronoun" or "pronoun_consistency" to flag mismatches, reporting matchLevel as "exact" for correct usage or "contradicted" for mismatches.',
    }];
  }
}
