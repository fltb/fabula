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

    return issues;
  }

  validatePost(input: PostRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const { prose, event, worldState } = input;
    const povChar = event.pov.character;
    const lowerProse = prose.toLowerCase();

    // Build set of entity IDs the POV character knows about
    const knownEntities = new Set<string>();
    knownEntities.add(povChar.toLowerCase());

    const povKnowledge = worldState.knowledge?.[povChar]?.knownFacts ?? [];
    for (const factId of povKnowledge) {
      const fact = worldState.facts?.find((f) => f.id === factId);
      if (fact?.entityId) {
        knownEntities.add(fact.entityId.toLowerCase());
      }
    }

    // Only scan in limited POV modes — omniscient can reference anyone
    if (event.pov.type === 'omniscient') return issues;

    // Check each entity in the world state that the POV character doesn't know
    for (const entityId of Object.keys(worldState.entities)) {
      const lowerId = entityId.toLowerCase();
      if (knownEntities.has(lowerId)) continue;
      if (lowerId === povChar.toLowerCase()) continue;

      // Flag if the unknown entity name appears in prose outside of dialogue
      const namePos = lowerProse.indexOf(lowerId);
      if (namePos === -1) continue;

      // Skip if the name appears in dialogue (between quotes)
      const before = lowerProse.slice(Math.max(0, namePos - 60), namePos);
      const after = lowerProse.slice(namePos + lowerId.length, Math.min(lowerProse.length, namePos + lowerId.length + 60));
      const lineAround = before + lowerId + after;
      const quoteCount = (lineAround.match(/"/g) || []).length;
      if (quoteCount >= 2) continue; // Likely dialogue — other character said the name

      // Flag if the reference is in narrative/thought context
      const thoughtIndicators = /\b(thought|knew|remembered|realized|wondered|known|heard|recognized)\b/i;
      if (thoughtIndicators.test(before) || thoughtIndicators.test(after)) {
        issues.push(makeIssue(
          this.name, event.id, povChar, 'warning',
          `POV character "${povChar}" references "${entityId}" in narrative thought context but doesn't know about them yet`,
          'Either establish the character learning about this entity, or remove the internal reference.',
          'add_precondition',
          'knows',
        ));
      }
    }

    return issues;
  }
}
