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

import { z } from 'zod/v3';
import type {
  PostRenderInput,
  PreRenderInput,
  ValidationIssue,
  Validator,
} from '../types/index.js';
import { getAttributeSemanticRole, getAttributesBySemanticRole, makeIssue } from './base.js';
import { matchLevelSchema } from './schemas.js';

export const appearanceCheckSchema = z.object({
  entityId: z.string(),
  feature: z.string(),
  declared: z.string(),
  evidence: z.string(),
  matchLevel: matchLevelSchema,
});
export type AppearanceCheck = z.infer<typeof appearanceCheckSchema>;

export class AppearanceValidator implements Validator {
  name = 'appearance';
  category = 'factual_detail' as const;

  validatePre(input: PreRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const { event } = input;

    // Deterministic check: if an event has multiple appearance postconditions
    // for the same entity with different values, that's a contradiction
    const appearanceFacts = event.postconditions.filter(
      (pc) =>
        getAttributeSemanticRole(input.entityTypeCatalog, 'character', pc.attribute) ===
          'appearance' && pc.value !== undefined,
    );
    if (appearanceFacts.length > 1) {
      const values = [...new Set(appearanceFacts.map((f) => f.value))];
      if (values.length > 1) {
        issues.push(
          makeIssue(
            this.name,
            event.id,
            appearanceFacts[0].entityId,
            'error',
            `Contradictory appearance values within same event: [${values.join(', ')}]`,
            'Remove the contradictory postcondition or resolve the contradiction.',
            'edit_file',
            getAttributesBySemanticRole(input.entityTypeCatalog, 'character', 'appearance')[0] ??
              'appearance',
          ),
        );
      }
    }

    return issues;
  }
  validatePost(input: PostRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const { event, analysis, worldState } = input;

    if (!analysis) return issues;

    const appChecks =
      z.array(appearanceCheckSchema).safeParse(analysis.analysis.appearanceChecks).data ?? [];
    if (appChecks.length === 0) return issues;

    for (const check of appChecks) {
      const entityId = check.entityId;
      const feature = check.feature;
      const matchLevel = check.matchLevel;

      // Verify the entity exists
      const entityState = worldState.entities[entityId];
      if (!entityState) {
        const checkIndex = appChecks.indexOf(check);
        issues.push(
          makeIssue(
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
            'evidence_mismatch',
            checkIndex >= 0
              ? { field: 'appearanceChecks', analysisPointer: `/appearanceChecks/${checkIndex}` }
              : { field: 'appearanceChecks' },
          ),
        );
        continue;
      }
      // Check for absent or contradicted appearance details
      if (matchLevel === 'absent') {
        const checkIndex = appChecks.indexOf(check);
        issues.push(
          makeIssue(
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
            'evidence_mismatch',
            checkIndex >= 0
              ? { field: 'appearanceChecks', analysisPointer: `/appearanceChecks/${checkIndex}` }
              : { field: 'appearanceChecks' },
          ),
        );
      } else if (matchLevel === 'contradicted') {
        const checkIndex = appChecks.indexOf(check);
        issues.push(
          makeIssue(
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
            'evidence_mismatch',
            checkIndex >= 0
              ? { field: 'appearanceChecks', analysisPointer: `/appearanceChecks/${checkIndex}` }
              : { field: 'appearanceChecks' },
          ),
        );
      }
    }

    return issues;
  }

  getAnalysisRequirements() {
    return [
      {
        field: 'appearanceChecks',
        schema: z.array(appearanceCheckSchema),
        instruction:
          'appearanceChecks: For each character present in the scene, check if their declared appearance features (face, build, eyes, hair, clothing) match what is described in the prose. Report each feature in the appearanceChecks block with the declared value, a direct quote as evidence, and matchLevel as "exact", "similar", "absent" (feature not mentioned), or "contradicted" (prose contradicts the definition).',
      },
    ];
  }
}
