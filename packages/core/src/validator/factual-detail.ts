// ============================================================================
// FactualDetailValidator — LLM-assisted detail checking
// ============================================================================

import type {
  PostRenderInput,
  PreRenderInput,
  Validator,
  ValidationIssue,
} from '../types/index.js';
import { makeIssue } from './base.js';
import { z } from 'zod';
 
export const inventedDetailSchema = z.object({
  detail: z.string(),
  severity: z.enum(['minor', 'major']),
});
export type InventedDetail = z.infer<typeof inventedDetailSchema>;
 

export class FactualDetailValidator implements Validator {
  name = 'factual_detail';
  category = 'factual_detail' as const;

  validatePre(input: PreRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const event = input.event;

    // Deterministic part: check entity attribute consistency
    for (const pc of event.preconditions) {
      const entity = input.entityRegistry.resolve(pc.entityId);
      if (!entity) continue;

      const currentTraits = entity.state['traits'] as string[] | undefined;

      // Check trait-level contradictions (only for deterministic values)
      if (pc.attribute === 'traits' && currentTraits && pc.value !== undefined) {
        const requestedTraits = Array.isArray(pc.value) ? pc.value : [pc.value];
        for (const trait of requestedTraits) {
          if (currentTraits.includes(trait as string)) {
            issues.push(makeIssue(
              this.name, event.id, pc.entityId, 'info',
              `Trait "${trait}" confirmed for "${pc.entityId}"`,
              'No action needed.',
              'manual',
            ));
          }
        }
      }
    }

    // Check for naming inconsistencies: entity IDs should match across references
    for (const pc of event.preconditions) {
      if (pc.value === 'changed' || pc.value === 'resolved' || pc.value === 'updated') {
        issues.push(makeIssue(
          this.name, event.id, pc.entityId, 'warning',
          `Placeholder value "${pc.value}" used for "${pc.entityId}.${pc.attribute}" — this is not a verifiable fact`,
          'Use a specific, concrete value instead of a placeholder.',
          'change_value',
          pc.attribute,
        ));
      }
    }

    // Check: postconditions with placeholder values (should be caught by schema)
    for (const pc of event.postconditions) {
      if (pc.value === 'changed' || pc.value === 'resolved' || pc.value === 'updated') {
        issues.push(makeIssue(
          this.name, event.id, pc.entityId, 'warning',
          `Placeholder value "${pc.value}" used in postcondition "${pc.entityId}.${pc.attribute}" — this should be a concrete value`,
          'Use a specific, concrete value instead of a placeholder.',
          'change_value',
          pc.attribute,
        ));
      }
    }

    // Check: mutual exclusion — fact must not have both value and narrativeHint
    for (const pc of event.postconditions) {
      if (pc.value !== undefined && pc.narrativeHint !== undefined && pc.narrativeHint !== '') {
        issues.push(makeIssue(
          this.name, event.id, pc.entityId, 'error',
          `Fact "${pc.id}" has both value and narrativeHint set — they are mutually exclusive`,
          'Remove one of value or narrativeHint.',
          'change_value',
          pc.attribute,
        ));
      }
    }

    // Check: postconditions referencing entities not in the registry
    // (invented details / nonexistent entities)
    for (const pc of event.postconditions) {
      if (pc.value === undefined) continue;
      const entity = input.entityRegistry.resolve(pc.entityId);
      if (!entity) {
        issues.push(makeIssue(
          this.name, event.id, pc.entityId, 'warning',
          `Postcondition references entity "${pc.entityId}" which is not defined in the entity registry`,
          'Define this entity in definitions/, or remove the postcondition referencing it.',
          'create_file',
          'entity',
          undefined,
          pc.entityId,
        ));
      }
    }

    return issues;
  }

  validatePost(input: PostRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const analysis = input.analysis;

    if (!analysis) return issues;

    const inventedResult = z.array(inventedDetailSchema).safeParse(analysis.analysis.inventedDetails);
    const details = inventedResult.success ? inventedResult.data : [];
    for (const detail of details) {
      if (detail.severity !== 'major') continue;

      issues.push(makeIssue(
        this.name, input.event.id, 'system', 'warning',
        `Major invented detail: "${detail.detail}" — not specified in event definitions.`,
        'Add this detail to event preconditions/postconditions, or mark it intentional.',
        'manual',
      ));
    }

    return issues;
  }

  getAnalysisRequirements() {
    return [{
      field: 'inventedDetails',
      schema: z.array(inventedDetailSchema),
      instruction: 'inventedDetails: List any significant details in the prose that are not present in the event specification. For each invented detail, note the detail text and whether its severity is "minor" (e.g., atmospheric description) or "major" (plot or character change not in the specification). Report in the inventedDetails block.',
    }];
  }
}
