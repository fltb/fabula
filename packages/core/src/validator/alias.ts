// ============================================================================
// AliasValidator — Character names used in prose vs known aliases
// ============================================================================
//
// Checks that all names used in prose (reported by Pass 2 characterReferences)
// match known names for the character: entity id, CharacterDefinition.name,
// or CharacterDefinition.aliases[].
// ============================================================================

import type {
  PostRenderInput,
  Validator,
  ValidationIssue,
} from '../types/index.js';
import { makeIssue } from './base.js';

export class AliasValidator implements Validator {
  name = 'alias';
  category = 'characterization' as const;

  validatePost(input: PostRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const { event, analysis, worldState } = input;

    if (!analysis) return issues;

    const charRefs = analysis.analysis.characterReferences ?? [];
    if (charRefs.length === 0) return issues;

    for (const ref of charRefs) {
      const entityId = ref.entityId;
      const namesUsed = ref.namesUsed ?? [];

      if (namesUsed.length === 0) continue;

      // Build set of valid names for this entity
      const validNames = new Set<string>();

      // The entity ID itself is always valid
      validNames.add(entityId.toLowerCase());

      // Check worldState for stored state that may contain aliases
      const entityState = worldState.entities[entityId];
      if (entityState) {
        // Check for aliases field (from CharacterDefinition.aliases mapped to state)
        const stateAliases = entityState['aliases'];
        if (Array.isArray(stateAliases)) {
          for (const alias of stateAliases) {
            validNames.add(String(alias).toLowerCase());
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
          issues.push(makeIssue(
            this.name,
            event.id,
            entityId,
            'info',
            `Unknown name "${usedName}" used for character "${entityId}" — not in known names/aliases`,
            'If this is a deliberate variation, add it to the character definition aliases. Otherwise, use a consistent name.',
            'add_field',
            'aliases',
            undefined,
            usedName,
          ));
        }
      }
    }

    return issues;
  }

  getAnalysisRequirements() {
    return [{
      field: 'characterReferences',
      schemaExample: { entityId: 'char_001', namesUsed: ['John', 'Mr. Smith', 'he'] },
      instruction: 'characterReferences: For each character present in the scene, record every name variant used in the prose (full name, nickname, title, epithet, pronoun) in the characterReferences block under namesUsed. This helps verify that all names are valid aliases for the character.',
    }];
  }
}
