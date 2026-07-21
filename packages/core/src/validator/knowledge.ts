// ============================================================================
// KnowledgeValidator — Knowledge boundary enforcement
// ============================================================================

import type {
  Validator,
  ValidationIssue,
  PreRenderInput,
  PostRenderInput,
} from '../types/index.js';
import { makeIssue, getAttributeSemanticRole } from './base.js';
import { z } from 'zod';
import { matchLevelSchema } from './schemas.js';

export const knowledgeCheckSchema = z.object({
  entityId: z.string(),
  leakedEntity: z.string(),
  leakedInfo: z.string(),
  evidence: z.string(),
  matchLevel: matchLevelSchema,
});

export type KnowledgeCheck = z.infer<typeof knowledgeCheckSchema>;

export class KnowledgeValidator implements Validator {
  name = 'knowledge';
  category = 'characterization' as const;

  validatePre(input: PreRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const { event, events, getKnowledge } = input;
    const povChar = event.pov.character;
    const ledger = getKnowledge(povChar);


    // For each postcondition that sets "knows" on the POV character,
    // check if they could have learned this at this point in time
    for (const pc of event.postconditions) {
      if (pc.entityId !== povChar) continue;
      if (getAttributeSemanticRole('character', pc.attribute) !== 'knowledge') continue;

      // Check if the character already has a settled claim for this proposition
      const claimKey = `${povChar}:${pc.id}`;
      const existingClaim = ledger.claims[claimKey];
      const alreadyKnown =
        existingClaim?.assessment.type === 'settled' &&
        existingClaim.assessment.polarity === 'affirmative';

      if (alreadyKnown) {
        issues.push(makeIssue(
          this.name, event.id, povChar, 'info',
          `Character "${povChar}" already knows proposition "${pc.value}" (fact: ${pc.id})`,
          'This is a duplicate knowledge acquisition. Consider removing if redundant.',
          'manual',
        ));
      }
    }

    // Future-event check: if the fact this postcondition references is only
    // established in a later event, flag impossible foreknowledge.
    for (const pc of event.postconditions) {
      if (pc.entityId !== povChar) continue;
      if (getAttributeSemanticRole('character', pc.attribute) !== 'knowledge') continue;

      if (pc.value !== undefined) {
        const factEvents = events.filter(
          (e) =>
            e.narrativeOrder > event.narrativeOrder &&
            e.postconditions.some(
              (p) => p.entityId === pc.entityId && p.attribute === pc.attribute && p.value === pc.value,
            ),
        );

        if (factEvents.length > 0) {
          issues.push(makeIssue(
            this.name, event.id, povChar, 'error',
            `Character "${povChar}" appears to know fact "${pc.value}" before it is established (in ${factEvents[0].id})`,
            'Reorder events so the fact is established before the character learns it.',
            'add_precondition',
            'knows',
          ));
        }
      }
    }

    return issues;
  }

  validatePost(input: PostRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    if (!input.analysis) return issues;

    const knowledgeChecks = z.array(knowledgeCheckSchema).safeParse(input.analysis.analysis.knowledgeChecks).data ?? [];
    for (const check of knowledgeChecks) {
      if (check.matchLevel === 'contradicted') {
        issues.push(makeIssue(
          'knowledge',
          input.event.id,
          check.entityId,
          'warning',
          `Knowledge boundary violation: ${check.entityId} knows about ${check.leakedEntity} — ${check.leakedInfo}`,
          `${check.evidence}`,
          'edit_file',
          'knowledge',
        ));
      }
    }
    return issues;
  }

  getAnalysisRequirements() {
    return [{
      field: 'knowledgeChecks',
      schema: z.array(knowledgeCheckSchema),
      instruction: 'knowledgeChecks: For the POV character, check if the prose reveals information they could not know given their established knowledge boundaries. Report leaks in the knowledgeChecks block with the POV character entityId, the leaked entity, what information was leaked, a direct quote as evidence, and matchLevel. A knowledge leak occurs when prose describes facts, observations, internal states of other characters, or historical events that the POV character has not acquired through direct experience, being told, or inference.',
    }];
  }
}
