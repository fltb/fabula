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
import { z } from 'zod';

export const ruleCheckSchema = z.object({
  ruleId: z.string(),
  violated: z.boolean(),
  evidence: z.string(),
  severity: z.enum(['minor', 'major']),
});

export type RuleCheck = z.infer<typeof ruleCheckSchema>;

export class WorldRuleValidator implements Validator {
  name = 'world_rule';
  category = 'worldbuilding' as const;

  validatePre(input: PreRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const { event, worldState } = input;

    // Deterministic check: ruleEffects that nullify established rules
    for (const re of event.ruleEffects) {
      if (re.effect === 'nullify') {
        const ruleState = worldState.rules[re.rule];
        if (ruleState && ruleState.activeEvidence > 0) {
          issues.push(makeIssue(
            this.name, event.id, re.rule, 'error',
            `World rule "${re.rule}" is being nullified but has been reinforced ${ruleState.activeEvidence} time(s)`,
            'Either remove the nullify effect or add enough weaken/nullify evidence.',
            'edit_file',
            'ruleEffects',
          ));
        }
      }
    }

    // Check postconditions: if a postcondition sets marital_status=remarried
    // and the entity's current marital_status in state differs, flag as rule violation
    for (const pc of event.postconditions) {
      if (pc.attribute === 'marital_status') {
        const entity = input.entityRegistry.resolve(pc.entityId);
        if (entity && entity.state['marital_status'] && entity.state['marital_status'] !== pc.value) {
          issues.push(makeIssue(
            this.name, event.id, pc.entityId, 'error',
            `World rule contradiction: "${pc.entityId}" marital_status set to "${pc.value}" but registry defines "${entity.state['marital_status']}"`,
            'Review scene for world rule compliance, or update the character definition.',
            'edit_file',
            'marital_status',
          ));
        }
      }
    }

    return issues;
  }

  validatePost(input: PostRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    if (!input.analysis) return issues;

    const ruleChecks = z.array(ruleCheckSchema).safeParse(input.analysis.analysis.ruleChecks).data ?? [];
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
      schema: z.array(ruleCheckSchema),
      instruction: 'ruleChecks: For each active world rule, check if the prose complies with or violates the stated rule. Report in the ruleChecks block with the ruleId, whether the rule was violated (true/false), a direct quote from the prose as evidence, and severity as "minor" or "major". A rule is violated if the prose depicts an action, event, or state that directly contradicts the rule\'s statement.',
    }];
  }
}
