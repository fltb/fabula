// ============================================================================
// CausalOverloadValidator — Detect causal branching overload (S3)
// ============================================================================
// Pre-render: count outgoing causal edges from this event. If the count
// exceeds branchingThreshold (default: 5), emit a warning. A high branching
// factor means the event has too many possible consequences (Pynchon-style).
// ============================================================================

import type {
  Validator,
  ValidationIssue,
  PreRenderInput,
} from '../types/index.js';
import { makeIssue } from './base.js';

export class CausalOverloadValidator implements Validator {
  name = 'causalOverload';
  category = 'timeline_plot' as const;

  validatePre(input: PreRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const config = input.event.modernNovel?.causalOverload;
    if (!config?.enabled) return issues;

    const threshold = config.branchingThreshold ?? 5;
    // Count outgoing causal edges: the number of postconditions on this event
    const outgoingCount = input.event.postconditions.length;

    if (outgoingCount > threshold) {
      issues.push(
        makeIssue(
          this.name,
          input.event.id,
          input.event.pov.character,
          'warning',
          `Causal overload: ${outgoingCount} outgoing edges exceeds threshold of ${threshold}. This event branches too broadly — consider consolidating postconditions.`,
          'Reduce the number of expected postconditions to keep branching factor at or below the threshold.',
          'change_value',
          'expectedPostconditions',
          undefined,
          { outgoingCount, branchingThreshold: threshold },
        ),
      );
    }
    return issues;
  }

  validatePost(): ValidationIssue[] {
    return [];
  }

  getAnalysisRequirements() {
    return [];
  }
}
