// ============================================================================
// BranchMergeValidator — Check branch merge precondition consistency
// ============================================================================

import type {
  NarrativeEvent,
  Validator,
  ValidatorContext,
  ValidationIssue,
} from '../types/index.js';
import { makeIssue } from './base.js';

export class BranchMergeValidator implements Validator {
  name = 'branch_merge';
  category = 'timeline_plot' as const;
  requiresLLM = false;

  validate(event: NarrativeEvent, context: ValidatorContext): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // For branch events: check if this is a merge point
    // A merge point is where multiple incoming branch paths converge
    const incomingBranches = context.events.filter(
      (e) =>
        e.narrativeOrder < event.narrativeOrder &&
        e.branchExistence.type !== 'all',
    );

    if (incomingBranches.length === 0) return issues;

    // Check each precondition against each incoming branch's final state
    for (const pc of event.preconditions) {
      const currentValue = context.queryState(pc.entityId, pc.attribute);

      if (currentValue === undefined || currentValue === null) {
        issues.push(makeIssue(
          this.name, event.id, pc.entityId, 'warning',
          `Merge precondition "${pc.entityId}.${pc.attribute} = ${pc.value}" is not satisfied (current: ${JSON.stringify(currentValue)}) on branch path`,
          'Ensure the precondition is satisfied on all incoming branch paths before merging.',
          'add_precondition',
          pc.attribute,
        ));
      }
    }

    return issues;
  }
}
