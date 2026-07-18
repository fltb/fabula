// ============================================================================
// POVValidator — POV consistency checks
// ============================================================================

import type {
  PreRenderInput,
  PostRenderInput,
  Validator,
  ValidationIssue,
} from '../types/index.js';
import { makeIssue } from './base.js';

export class POVValidator implements Validator {
  name = 'pov';
  category = 'narrative_style' as const;

  validatePre(input: PreRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const event = input.event;
    const povType = event.pov.type;
    const povChar = event.pov.character;

    // Check: POV character must exist in entity registry
    const povEntity = input.entityRegistry.resolve(povChar);
    if (!povEntity) {
      issues.push(makeIssue(
        this.name, event.id, povChar, 'error',
        `POV character "${povChar}" is not defined in entity registry`,
        'Define this character in definitions/characters/ or use an existing character.',
        'create_file',
        'character',
        `definitions/characters/${povChar}.yaml`,
      ));
    }

    // For third_person_limited: POV character should be in the scene
    if (povType === 'third_person_limited' || povType === 'first_person') {
      const inScene = event.participants.entities.includes(povChar);
      if (!inScene) {
        issues.push(makeIssue(
          this.name, event.id, povChar, 'warning',
          `POV character "${povChar}" is not listed as a participant in this scene (${povType} POV)`,
          'Add the POV character to the scene participants.',
          'change_value',
          'participants',
        ));
      }
    }

    // For omniscient: should not use omniscient for character-heavy scenes without reason
    if (povType === 'omniscient') {
      issues.push(makeIssue(
        this.name, event.id, povChar, 'info',
        'Using omniscient POV — ensure this is intentional. Limited POV often creates stronger reader engagement.',
        'Consider switching to third_person_limited for a specific character.',
        'manual',
      ));
    }

    return issues;
  }

  validatePost(input: PostRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const event = input.event;
    const prose = input.prose;
    const povType = event.pov.type;
    const povChar = event.pov.character;

    // First-person pronoun check (deterministic, cross-language)
    if (povType === 'first_person') {
      const hasFirstPerson = /\b(?:I|my|me|myself|mine)\b/i.test(prose);
      if (!hasFirstPerson) {
        issues.push(makeIssue(
          this.name, event.id, povChar, 'warning',
          `First-person POV for "${povChar}" but prose does not contain first-person pronouns ("I", "my", "me")`,
          'Use first-person narration consistently throughout the scene.',
          'edit_file',
          'pov.type',
        ));
      }
    }

    // Consume Pass 2 analysis for POV leaks (semantic checks)
    if (input.analysis) {
      const leaks = input.analysis.analysis.pov.leaks ?? [];
      for (const leak of leaks) {
        issues.push(makeIssue(
          this.name,
          event.id,
          event.pov.character,
          'warning',
          `POV leak detected: ${leak}`,
          'Review POV consistency',
          'edit_file',
          'pov',
        ));
      }
    }

    // Check POV consistency from Pass 2 analysis
    if (input.analysis && !input.analysis.analysis.pov.consistent) {
      issues.push(makeIssue(
        'pov', input.event.id, input.event.pov.character, 'warning',
        'POV inconsistency detected: the prose does not maintain consistent point of view.',
        'Review POV consistency throughout the scene.',
        'edit_file', 'pov',
      ));
    }

    return issues;
  }

  getAnalysisRequirements() {
    return [{
      field: 'pov.leaks',
      schemaExample: { consistent: true, leaks: ['any phrases that enter another character\'s inner thoughts'] },
      instruction: 'pov.leaks: Determine if the prose maintains the specified POV type throughout. List any phrases where the narration leaks into another character\'s internal thoughts, perceptions, or knowledge that the POV character could not access. Report in the pov block with consistent (true/false) and an array of leaked phrases. Pay attention to free indirect discourse that might blur POV boundaries.',
    }];
  }
}
