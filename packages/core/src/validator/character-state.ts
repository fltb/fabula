// ============================================================================
// CharacterStateValidator — Dead/alive status, state contradictions
// ============================================================================

import type {
  PostRenderInput,
  PreRenderInput,
  Validator,
  ValidationIssue,
} from '../types/index.js';
import { makeIssue, getAttributeSemanticRole, getAttributesBySemanticRole, consumeNarrativeChecks } from './base.js';
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

    // ── 1. Pass 2 narrativeCheck consumption ──
    if (input.analysis) {
      const narrativeChecks = z.array(narrativeCheckSchema).safeParse(input.analysis.analysis.narrativeChecks).data ?? [];
      issues.push(...consumeNarrativeChecks(narrativeChecks,
        (check) => {
          if (check.attribute !== 'character_state') {
            // Catalog-driven: check if this is a lifecycle attribute via semanticRole
            const entity = input.entityRegistry?.resolve(check.entityId);
            if (entity && getAttributeSemanticRole(entity.kind, check.attribute) !== 'lifecycle') return false;
          }
          return check.matchLevel === 'absent' || check.matchLevel === 'contradicted';
        },
        (check) => makeIssue(
          'character_state',
          input.event.id,
          check.entityId,
          'warning',
          `Character state mismatch: ${check.hint} — ${check.evidence}`,
          'Review character state consistency in prose',
          'edit_file',
          'state',
        ),
      ));
    }

    // ── 2. Deterministic dead-character action check ──
    // If a character is dead per world state, the prose should not describe them acting
    const prose = input.prose;
    for (const [entityId, entityState] of Object.entries(input.worldState.entities)) {
      const status = entityState.status as string | undefined;
      if (status !== 'dead' && status !== 'deceased') continue;

      const nameParts = entityId.split(/[_-]/);
      const namePat = new RegExp(`\\b(${nameParts.join('|')})\\b`, 'i');
      if (!namePat.test(prose)) continue;

      // Check if the dead character is described performing actions
      const actionVerbs = /\b(spoke|said|walked|ran|thought|felt|decided|nodded|smiled|frowned|looked|grabbed|stepped|sat|stood|replied|asked|whispered|shouted|moved)\b/i;
      const sentences = prose.split(/[.!?]+/);
      for (const sentence of sentences) {
        if (namePat.test(sentence) && actionVerbs.test(sentence)) {
          // Allow if the sentence is explicitly a flashback or memory
          const isFlashback = /\b(remembered|recalled|flashback|memory|thought back|imagined)\b/i.test(sentence);
          if (!isFlashback) {
            issues.push(makeIssue(
              this.name, input.event.id, entityId, 'error',
              `"${entityId}" is ${status} per world state but prose describes them performing actions`,
              'Remove actions attributed to this character or mark the segment as a flashback/memory.',
              'edit_file',
              getAttributesBySemanticRole('character', 'lifecycle')[0] ?? 'status',
            ));
            break;
          }
        }
      }
    }

    return issues;
  }

  getAnalysisRequirements() {
    return [{
      field: 'narrativeChecks',
      attributes: ['character_state'],
      instruction: 'narrativeChecks[character_state]: For each character, check if the prose depicts their state (alive/dead status, location, emotional state) consistently with the event\'s preconditions. Use the narrativeChecks block with attribute "character_state" to report any contradictions where the prose shows a character in a state that conflicts with established preconditions. Specifically flag if a character known to be dead is described performing actions (speaking, walking, thinking, etc.) unless the context is explicitly a flashback or memory.',
      schema: z.array(narrativeCheckSchema),
    }];
  }
}
