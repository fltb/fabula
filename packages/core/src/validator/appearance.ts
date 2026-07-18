// ============================================================================
// AppearanceValidator — Character appearance consistency in prose
// ============================================================================
//
// Consumes Pass 2 appearanceChecks block to verify that character appearance
// descriptions in the prose match the declared appearance in definitions.
//
// Any matchLevel of 'absent' (expected detail missing) or 'contradicted'
// (detail contradicts the definition) is flagged as an error.
// ============================================================================

import type {
  PostRenderInput,
  Validator,
  ValidationIssue,
} from '../types/index.js';
import { makeIssue } from './base.js';

export class AppearanceValidator implements Validator {
  name = 'appearance';
  category = 'factual_detail' as const;

  validatePost(input: PostRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const { event, analysis, worldState } = input;

    if (!analysis) return issues;

    const appChecks = analysis.analysis.appearanceChecks ?? [];
    if (appChecks.length === 0) return issues;

    for (const check of appChecks) {
      const entityId = check.entityId;
      const feature = check.feature;
      const matchLevel = check.matchLevel;

      // Verify the entity exists
      const entityState = worldState.entities[entityId];
      if (!entityState) {
        issues.push(makeIssue(
          this.name,
          event.id,
          entityId,
          'warning',
          `Appearance check references unknown entity "${entityId}"`,
          'Ensure the entity is defined in definitions/characters/.',
          'create_file',
          'character',
          undefined,
          entityId,
        ));
        continue;
      }

      // Check for absent or contradicted appearance details
      if (matchLevel === 'absent') {
        issues.push(makeIssue(
          this.name,
          event.id,
          entityId,
          'warning',
          `Missing appearance detail: "${feature}" for "${entityId}" — declared as "${check.declared}" but not found in prose`,
          `Add a visual description of ${feature} to the scene prose where ${entityId} appears.`,
          'edit_file',
          undefined,
          undefined,
          check.declared,
        ));
      } else if (matchLevel === 'contradicted') {
        issues.push(makeIssue(
          this.name,
          event.id,
          entityId,
          'error',
          `Contradicted appearance: "${feature}" for "${entityId}" — declared "${check.declared}" but prose says "${check.evidence}"`,
          'Correct the prose to match the character definition, or update the definition.',
          'edit_file',
          undefined,
          undefined,
          { declared: check.declared, prose: check.evidence },
        ));
      }
    }

    return issues;
  }

  getAnalysisRequirements() {
    return [{
      field: 'appearanceChecks',
      schemaExample: { entityId: 'char_001', feature: 'eyes', declared: 'blue', evidence: '...', matchLevel: 'exact' },
      instruction: 'appearanceChecks: For each character present in the scene, check if their declared appearance features (face, build, eyes, hair, clothing) match what is described in the prose. Report each feature in the appearanceChecks block with the declared value, a direct quote as evidence, and matchLevel as "exact", "similar", "absent" (feature not mentioned), or "contradicted" (prose contradicts the definition).',
    }];
  }
}
