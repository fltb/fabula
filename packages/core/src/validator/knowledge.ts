// ============================================================================
// KnowledgeValidator — Knowledge boundary enforcement
// ============================================================================

import type {
  Validator,
  ValidationIssue,
  PreRenderInput,
  PostRenderInput,
} from '../types/index.js';
import { makeIssue } from './base.js';

export class KnowledgeValidator implements Validator {
  name = 'knowledge';
  category = 'characterization' as const;

  validatePre(input: PreRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const { event, events, getKnowledge } = input;
    const povChar = event.pov.character;
    const knowledge = getKnowledge(povChar);
    const charKnowledge = knowledge.characterKnowledge[povChar];

    // For each postcondition that sets "knows" on the POV character,
    // check if they could have learned this at this point in time
    for (const pc of event.postconditions) {
      if (pc.attribute !== 'knows' || pc.entityId !== povChar) continue;

      const knownFacts = charKnowledge?.knownFacts ?? [];
      const alreadyKnown = knownFacts.some((k) => k.fact.id === pc.id);

      if (alreadyKnown) {
        issues.push(makeIssue(
          this.name, event.id, povChar, 'info',
          `Character "${povChar}" already knows fact "${pc.value}"`,
          'This is a duplicate knowledge acquisition. Consider removing if redundant.',
          'manual',
        ));
      }
    }

    // Check: POV character shouldn't know facts from future events
    for (const pc of event.postconditions) {
      if (pc.entityId !== povChar || pc.attribute !== 'knows') continue;

      // Check if this fact was established in a future event (impossible)
      // Only check deterministic value facts; narrativeHint facts are deferred
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

    const knowledgeChecks = input.analysis.analysis.knowledgeChecks ?? [];
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
      schemaExample: { entityId: 'char_001', leakedEntity: 'char_002', leakedInfo: '...', evidence: '...', matchLevel: 'exact' },
      instruction: 'knowledgeChecks: For the POV character, check if the prose reveals information they could not know given their established knowledge boundaries. Report leaks in the knowledgeChecks block with the POV character entityId, the leaked entity, what information was leaked, a direct quote as evidence, and matchLevel. A knowledge leak occurs when prose describes facts, observations, internal states of other characters, or historical events that the POV character has not acquired through direct experience, being told, or inference.',
    }];
  }
}
