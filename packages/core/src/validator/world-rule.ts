// ============================================================================
// WorldRuleValidator — Consume Pass 2 AnalysisResult rule checks
// ============================================================================

import { z } from 'zod';
import type {
  PostRenderInput,
  PreRenderInput,
  ValidationIssue,
  Validator,
} from '../types/index.js';
import { getAttributeWritePolicy, makeIssue } from './base.js';

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

    // Deterministic check: rule transactions that nullify established rules
    // Uses RuleRuntimeState instead of scalar activeEvidence
    for (const re of event.ruleEffects) {
      if (re.operation === 'set_effectiveness' && re.newEffectiveness === 'nullified') {
        const ruleId = re.ruleId;
        const ruleState = worldState.rules[ruleId];
        if (
          ruleState &&
          ruleState.activation === 'enabled' &&
          ruleState.effectiveness !== 'nullified'
        ) {
          issues.push(
            makeIssue(
              this.name,
              event.id,
              ruleId,
              'error',
              `World rule "${ruleId}" is being nullified but its current effectiveness is "${ruleState.effectiveness}"`,
              'Either remove the nullify transaction or add enough weaken/nullify evidence.',
              'edit_file',
              'ruleEffects',
            ),
          );
        }
      }
    }
    // Check postconditions: flag changes to immutable attributes (world rule contradiction)
    // Mutable attributes like marital_status (semanticRole: 'lifecycle') can change freely.
    for (const pc of event.postconditions) {
      const entity = input.entities.resolve(pc.entityId);
      if (!entity) continue;
      const writePolicy = getAttributeWritePolicy(
        input.entityTypeCatalog,
        entity.kind,
        pc.attribute,
      );
      if (
        writePolicy === 'immutable' &&
        entity.state[pc.attribute] !== undefined &&
        entity.state[pc.attribute] !== pc.value
      ) {
        issues.push(
          makeIssue(
            this.name,
            event.id,
            pc.entityId,
            'error',
            `World rule contradiction: "${pc.entityId}" ${pc.attribute} set to "${pc.value}" but registry defines "${entity.state[pc.attribute]}"`,
            'Review scene for world rule compliance, or update the character definition.',
            'edit_file',
            pc.attribute,
          ),
        );
      }
    }

    return issues;
  }

  validatePost(input: PostRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    if (!input.analysis) return issues;

    const ruleChecks =
      z.array(ruleCheckSchema).safeParse(input.analysis.analysis.ruleChecks).data ?? [];
    for (const check of ruleChecks) {
      if (check.violated) {
        const checkIndex = ruleChecks.indexOf(check);
        issues.push(
          makeIssue(
            'world_rule',
            input.event.id,
            check.ruleId,
            check.severity === 'major' ? 'error' : 'warning',
            `World rule violation: ${check.evidence}`,
            'Review scene for rule compliance',
            'edit_file',
            'ruleEffects',
            undefined,
            undefined,
            'evidence_mismatch',
            checkIndex >= 0
              ? { field: 'ruleChecks', analysisPointer: `/ruleChecks/${checkIndex}` }
              : { field: 'ruleChecks' },
          ),
        );
      }
    }
    return issues;
  }

  getAnalysisRequirements() {
    return [
      {
        field: 'ruleChecks',
        schema: z.array(ruleCheckSchema),
        instruction:
          'ruleChecks: For each active world rule, check if the prose complies with or violates the stated rule. Report in the ruleChecks block with the ruleId, whether the rule was violated (true/false), a direct quote from the prose as evidence, and severity as "minor" or "major". A rule is violated if the prose depicts an action, event, or state that directly contradicts the rule\'s statement.',
      },
    ];
  }
}
