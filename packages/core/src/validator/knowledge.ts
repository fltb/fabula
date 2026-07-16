// ============================================================================
// KnowledgeValidator — Knowledge boundary enforcement
// ============================================================================

import type {
  NarrativeEvent,
  Validator,
  ValidatorContext,
  ValidationIssue,
} from '../types/index.js';
import { makeIssue } from './base.js';

export class KnowledgeValidator implements Validator {
  name = 'knowledge';
  category = 'characterization' as const;
  requiresLLM = false;

  validate(event: NarrativeEvent, context: ValidatorContext): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const povChar = event.pov.character;
    const knowledge = context.getKnowledge(povChar);
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
      const factEvents = context.events.filter(
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

    return issues;
  }
}
