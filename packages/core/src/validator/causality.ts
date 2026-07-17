// ============================================================================
// CausalityValidator — LLM-assisted causal reasoning
// ============================================================================

import type {
  PostRenderInput,
  PreRenderInput,
  Validator,
  ValidationIssue,
} from '../types/index.js';
import { makeIssue } from './base.js';

export class CausalityValidator implements Validator {
  name = 'causality';
  category = 'timeline_plot' as const;

  validatePre(input: PreRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const event = input.event;

    // Deterministic part: check that preconditions are satisfied in current state
    for (const pc of event.preconditions) {
      const currentValue = input.queryState(pc.entityId, pc.attribute);

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

  validatePost(input: PostRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const analysis = input.analysis;

    if (!analysis) return issues;

    const { covered, dropped } = analysis.analysis.postconditions;
    const totalPostconditions = input.event.postconditions.length;
    const coveredCount = covered.length;
    const droppedCount = dropped.length;

    // Warning: any postcondition dropped
    for (const pc of input.event.postconditions) {
      if (!covered.some((c) => c.includes(pc.entityId) && c.includes(pc.attribute))) {
        issues.push(makeIssue(
          this.name, input.event.id, pc.entityId, 'warning',
          `Postcondition "${pc.entityId}.${pc.attribute}=${pc.value}" not covered in rendered prose.`,
          'Add explicit mention of this state change in the scene.',
          'manual',
          pc.attribute,
        ));
      }
    }

    // Error: majority of postconditions dropped
    if (droppedCount > totalPostconditions * 0.5) {
      issues.push(makeIssue(
        this.name, input.event.id, 'system', 'error',
        `Majority of postconditions dropped: ${droppedCount}/${totalPostconditions} (${coveredCount} covered).`,
        'Scene needs rewrite — too many expected state changes are missing.',
        'manual',
      ));
    }

    return issues;
  }
}
