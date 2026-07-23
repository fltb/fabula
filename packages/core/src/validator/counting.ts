// ============================================================================
// CountingValidator — Warns when scene count is below a minimum threshold
// ============================================================================
//
// Simple structural validator that checks whether the event list has enough
// scenes to constitute a meaningful narrative sequence.
// ============================================================================

import type {
  PreRenderInput,
  Validator,
  ValidationIssue,
} from '../types/index.js';
import { makeIssue } from './base.js';

/** Default minimum number of scenes before a warning is emitted. */
const MIN_SCENES = 3;

export class CountingValidator implements Validator {
  name = 'counting';
  category = 'narrative_style' as const;

  validatePre(input: PreRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const { events, event } = input;

    if (events.length < MIN_SCENES) {
      issues.push(makeIssue(
        this.name,
        event.id,
        'system',
        'warning',
        `Only ${events.length} scene(s) in event list; minimum recommended is ${MIN_SCENES}.`,
        `Add more scenes to reach at least ${MIN_SCENES} total events in the sequence.`,
        'add_field',
      ));
    }

    return issues;
  }
}
