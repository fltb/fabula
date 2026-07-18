// ============================================================================
// WorldRuleValidator — Consume Pass 2 AnalysisResult rule checks
// ============================================================================

import type {
  PostRenderInput,
  PreRenderInput,
  Validator,
  ValidationIssue,
} from '../types/index.js';
import { makeIssue } from './base.js';

export class WorldRuleValidator implements Validator {
  name = 'world_rule';
  category = 'worldbuilding' as const;

  validatePre(_input: PreRenderInput): ValidationIssue[] {
    return [];
  }

  validatePost(input: PostRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    if (!input.analysis) return issues;

    const ruleChecks = input.analysis.analysis.ruleChecks ?? [];
    for (const check of ruleChecks) {
      if (check.violated) {
        issues.push(makeIssue(
          'world_rule',
          input.event.id,
          check.ruleId,
          check.severity === 'major' ? 'error' : 'warning',
          `World rule violation: ${check.evidence}`,
          'Review scene for rule compliance',
          'edit_file',
          'ruleEffects',
        ));
      }
    }
    return issues;
  }

  getAnalysisRequirements() {
    return [{
      field: 'ruleChecks',
      schemaExample: { ruleId: 'R1', violated: false, evidence: '...', severity: 'minor' },
      instruction: 'ruleChecks: For each active world rule, check if the prose complies with or violates the stated rule. Report in the ruleChecks block with the ruleId, whether the rule was violated (true/false), a direct quote from the prose as evidence, and severity as "minor" or "major". A rule is violated if the prose depicts an action, event, or state that directly contradicts the rule\'s statement.',
    }];
  }
}
