// ============================================================================
// POVValidator — POV consistency checks
// ============================================================================

import type {
  NarrativeEvent,
  Validator,
  ValidatorContext,
  ValidationIssue,
} from '../types/index.js';
import { makeIssue } from './base.js';

export class POVValidator implements Validator {
  name = 'pov';
  category = 'narrative_style' as const;
  requiresLLM = false;

  validate(event: NarrativeEvent, context: ValidatorContext): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const povType = event.pov.type;
    const povChar = event.pov.character;

    // Check: POV character must exist in entity registry
    const povEntity = context.entityRegistry.resolve(povChar);
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
}
