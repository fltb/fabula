// ============================================================================
// AliasValidator — Character names used in prose vs known aliases
// ============================================================================
//
// Checks that all names used in prose (reported by Pass 2 characterReferences)
// match known names for the character: entity id, CharacterDefinition.name,
// or CharacterDefinition.aliases[].
// ============================================================================

import { z } from 'zod';
import type { PostRenderInput, ValidationIssue, Validator } from '../types/index.js';
import { getAttributesBySemanticRole, makeIssue } from './base.js';

export const characterReferenceSchema = z.object({
  entityId: z.string(),
  namesUsed: z.array(z.string()),
});
export type CharacterReference = z.infer<typeof characterReferenceSchema>;

export class AliasValidator implements Validator {
  name = 'alias';
  category = 'characterization' as const;

  validatePost(input: PostRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const { event, analysis, worldState } = input;

    if (!analysis) return issues;

    const charRefs =
      z.array(characterReferenceSchema).safeParse(analysis.analysis.characterReferences).data ?? [];
    if (charRefs.length === 0) return issues;

    for (const ref of charRefs) {
      const entityId = ref.entityId;
      const namesUsed = ref.namesUsed ?? [];

      if (namesUsed.length === 0) continue;

      // Build set of valid names for this entity
      const validNames = new Set<string>();

      // Derive the aliases attribute ID from catalog (semanticRole: 'identity')
      const identityAttrs = getAttributesBySemanticRole(
        input.entityTypeCatalog,
        'character',
        'identity',
      );
      const aliasAttrId = identityAttrs.find((a) => a === 'aliases') ?? 'aliases';

      // The entity ID itself is always valid
      validNames.add(entityId.toLowerCase());

      // Check worldState for stored state that may contain aliases
      const entityState = worldState.entities[entityId];
      if (entityState) {
        // Check for aliases field (from CharacterDefinition.aliases mapped to state)
        const stateAliases = entityState[aliasAttrId];
        if (Array.isArray(stateAliases)) {
          for (const alias of stateAliases) {
            validNames.add(String(alias).toLowerCase());
          }
        }
      }

      // Fallback: check entity registry directly when worldState lacks aliases
      if (input.entities) {
        const registryEntity = input.entities.resolve(entityId);
        if (registryEntity) {
          const regAliases = registryEntity.state[aliasAttrId];
          if (Array.isArray(regAliases)) {
            for (const alias of regAliases) {
              validNames.add(String(alias).toLowerCase());
            }
          }
        }
      }
      // Also check the entity registry info accessible via event participants
      // and fall back to checking the entity ID variations
      const idParts = entityId.split(/[._\s-]+/);
      for (const part of idParts) {
        if (part.length > 1) validNames.add(part.toLowerCase());
      }

      // Check each name used in prose
      for (const usedName of namesUsed) {
        const lowerUsed = usedName.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
        if (lowerUsed.length === 0) continue;

        let matched = false;
        for (const valid of validNames) {
          // Direct match or partial match (e.g., "Rainsford" matches "rainsford")
          if (lowerUsed === valid || lowerUsed.includes(valid) || valid.includes(lowerUsed)) {
            matched = true;
            break;
          }
        }

        if (!matched) {
          const refIndex = charRefs.indexOf(ref);
          issues.push(
            makeIssue(
              this.name,
              event.id,
              entityId,
              'warning',
              `Unknown name "${usedName}" used for character "${entityId}" — not in known names/aliases`,
              'If this is a deliberate variation, add it to the character definition aliases. Otherwise, use a consistent name.',
              'add_field',
              aliasAttrId,
              undefined,
              usedName,
              'evidence_mismatch',
              refIndex >= 0
                ? {
                    field: 'characterReferences',
                    analysisPointer: `/characterReferences/${refIndex}`,
                  }
                : { field: 'characterReferences' },
            ),
          );
        }
      }
    }

    return issues;
  }

  getAnalysisRequirements() {
    return [
      {
        field: 'characterReferences',
        schema: z.array(characterReferenceSchema),
        instruction:
          'characterReferences: For each character present in the scene, record every name variant used in the prose (full name, nickname, title, epithet — do NOT include pronouns; pronoun consistency is handled by PronounValidator via narrativeChecks) in the characterReferences block under namesUsed. This helps verify that all names are valid aliases for the character.',
      },
    ];
  }
}
