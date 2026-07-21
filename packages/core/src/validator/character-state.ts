// ============================================================================
// CharacterStateValidator — Dead/alive status, state contradictions
// ============================================================================

import type {
  PostRenderInput,
  PreRenderInput,
  Validator,
  ValidationIssue,
} from '../types/index.js';
import { makeIssue, getAttributeSemanticRole, getAttributesBySemanticRole } from './base.js';
import { z } from 'zod';
import { narrativeCheckSchema } from './schemas.js';

export class CharacterStateValidator implements Validator {
  name = 'character_state';
  category = 'characterization' as const;

  validatePre(input: PreRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    for (const pc of input.event.preconditions) {
      const entity = input.entityRegistry.resolve(pc.entityId);
      if (!entity || entity.kind !== 'character') continue;

      // Catalog-driven: check all lifecycle attributes for death/cessation signals
      const lifecycleAttrs = getAttributesBySemanticRole('character', 'lifecycle');
      let isDead = false;
      for (const attr of lifecycleAttrs) {
        const val = input.queryState(pc.entityId, attr);
        if (val === 'dead' || val === 'deceased' || val === false) {
          isDead = true;
          break;
        }
      }

      // If character is dead, can't appear in scenes
      if (isDead) {
        issues.push(makeIssue(
          this.name, input.event.id, pc.entityId, 'error',
          `Character "${pc.entityId}" is dead but appears in this scene`,
          `Remove this character from the scene, or this character's death must have been revealed as false.`,
          'remove_line',
          'status',
        ));
      }
    }

    return issues;
  }

  validatePost(input: PostRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    if (!input.analysis) return issues;

    const narrativeChecks = z.array(narrativeCheckSchema).safeParse(input.analysis.analysis.narrativeChecks).data ?? [];
    for (const check of narrativeChecks) {
      if (check.attribute !== 'character_state') {
        // Catalog-driven: check if this is a lifecycle attribute via semanticRole
        const entity = input.entityRegistry?.resolve(check.entityId);
        if (entity && getAttributeSemanticRole(entity.kind, check.attribute) !== 'lifecycle') continue;
      }
      if (check.matchLevel === 'absent' || check.matchLevel === 'contradicted') {
        issues.push(makeIssue(
          'character_state',
          input.event.id,
          check.entityId,
          'warning',
          `Character state mismatch: ${check.hint} — ${check.evidence}`,
          'Review character state consistency in prose',
          'edit_file',
          'state',
        ));
      }
    }
    return issues;
  }

  getAnalysisRequirements() {
    return [{
      field: 'narrativeChecks',
      attributes: ['character_state'],
      instruction: 'narrativeChecks[character_state]: For each character, check if the prose depicts their state (alive/dead status, location, emotional state) consistently with the event\'s preconditions. Use the narrativeChecks block with attribute "character_state" to report any contradictions where the prose shows a character in a state that conflicts with established preconditions.',
      schema: z.array(narrativeCheckSchema),
    }];
  }
}
