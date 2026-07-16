// ============================================================================
// CausalityValidator — LLM-assisted causal reasoning
// ============================================================================

import type {
  NarrativeEvent,
  Validator,
  ValidatorContext,
  ValidationIssue,
  WorldState,
} from '../types/index.js';
import { makeIssue } from './base.js';

export class CausalityValidator implements Validator {
  name = 'causality';
  category = 'timeline_plot' as const;
  requiresLLM = true;

  validate(event: NarrativeEvent, context: ValidatorContext): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // Deterministic part: check that preconditions are satisfied in current state
    for (const pc of event.preconditions) {
      const currentValue = context.queryState(pc.entityId, pc.attribute);

      if (currentValue === undefined || currentValue === null) {
        issues.push(makeIssue(
          this.name, event.id, pc.entityId, 'warning',
          `Precondition "${pc.entityId}.${pc.attribute} = ${pc.value}" is not satisfied — current value is ${JSON.stringify(currentValue)}`,
          'Add a preceding event that establishes this precondition, or adjust the expected preconditions.',
          'add_precondition',
          pc.attribute,
          undefined,
          pc.value,
        ));
      }
    }

    // Check: postconditions should logically follow from preconditions
    // Deterministic check: if postconditions are identical to preconditions, that's suspicious
    const preKeys = new Set(event.preconditions.map((p) => `${p.entityId}.${p.attribute}`));
    const postKeys = event.postconditions.map((p) => `${p.entityId}.${p.attribute}`);
    const allInPre = postKeys.every((k) => preKeys.has(k));

    if (allInPre && event.postconditions.length === event.preconditions.length) {
      issues.push(makeIssue(
        this.name, event.id, event.pov.character, 'warning',
        'All postconditions match preconditions — scene has no causal effect on the world',
        'This scene does not advance the story. Add meaningful state changes to expected_postconditions.',
        'change_value',
        'expected_postconditions',
      ));
    }

    return issues;
  }

  validateRender(prose: string, event: NarrativeEvent, state: WorldState): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const proseLower = prose.toLowerCase();

    const mentionsFact = (entityId: string, attribute: string, value: unknown): boolean => {
      const terms: string[] = [];
      if (typeof value === 'string') terms.push(value);
      const attrClean = attribute.replace(/^is_/, '').replace(/_/g, ' ');
      terms.push(attrClean);
      const parts = entityId.split('.');
      terms.push(parts[parts.length - 1]);
      return terms.some((t) => proseLower.includes(t.toLowerCase()));
    };

    for (const pc of event.preconditions) {
      if (!mentionsFact(pc.entityId, pc.attribute, pc.value)) {
        issues.push(makeIssue(
          this.name, event.id, pc.entityId, 'warning',
          `Prose does not describe precondition "${pc.entityId}.${pc.attribute} = ${JSON.stringify(pc.value)}" — this cause should be evident in the rendered scene`,
          'Add description of this precondition to the narrative prose.',
          'edit_file',
          pc.attribute,
        ));
      }
    }

    for (const pc of event.postconditions) {
      if (!mentionsFact(pc.entityId, pc.attribute, pc.value)) {
        issues.push(makeIssue(
          this.name, event.id, pc.entityId, 'warning',
          `Prose does not describe postcondition "${pc.entityId}.${pc.attribute} = ${JSON.stringify(pc.value)}" — this effect should be evident in the rendered scene`,
          'Add description of this postcondition to the narrative prose.',
          'edit_file',
          pc.attribute,
        ));
      }
    }

    return issues;
  }
}
