// ============================================================================
// ConflictValidator — Scene conflict resolution consistency
// ============================================================================
//
// Consumes Pass 2 conflictAnalysis block to verify that:
// - If a scene declares a resolutionType, the analysis should confirm resolution
// - If analysis says resolutionAchieved=false but scene expects resolution = error
//
// Note: Uses event-level conflictType/resolutionType fields, not entity attribute
// lookups. conflictType and resolutionType are event-schema fields, not entity
// attributes. Catalog functions imported for future use.
// ============================================================================

import { z } from 'zod/v3';
import type {
  PostRenderInput,
  PreRenderInput,
  ValidationIssue,
  Validator,
} from '../types/index.js';
import { makeIssue } from './base.js';

export const conflictAnalysisSchema = z.object({
  primaryType: z.string(),
  resolutionAchieved: z.boolean(),
});

export type ConflictAnalysis = z.infer<typeof conflictAnalysisSchema>;

export class ConflictValidator implements Validator {
  name = 'conflict';
  category = 'factual_detail' as const;

  validatePre(input: PreRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const { event } = input;

    // Deterministic check: if resolutionType is set to 'unresolved'
    // but the scene has a conflict type that implies resolution,
    // flag a warning
    // event-level field, not in entity attribute catalog
    if (event.resolutionType === 'unresolved' && event.conflictType) {
      issues.push(
        makeIssue(
          this.name,
          event.id,
          'system',
          'warning',
          `Scene "${event.id}" declares conflict type "${event.conflictType}" but resolution is "unresolved" — conflict may be left dangling`,
          'Ensure the conflict reaches explicit resolution, or mark it as intentionally unresolved.',
          'edit_file',
          'resolutionType',
        ),
      );
    }

    return issues;
  }
  validatePost(input: PostRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const { event, analysis } = input;

    if (!analysis) return issues;

    const conflictResult = conflictAnalysisSchema.safeParse(analysis.analysis.conflictAnalysis);
    if (!conflictResult.success) return issues;
    const conflictAnalysis = conflictResult.data;
    const eventResolutionType = event.resolutionType; // event-level field, not in entity attribute catalog
    const eventConflictType = event.conflictType; // event-level field, not in entity attribute catalog
    // Resolution types that explicitly do NOT expect Pass 2 to confirm achievement.
    // These denote "conflict established/continues, no in-scene resolution required."
    const NON_RESOLVING = new Set(['unresolved', 'negative_resolution', 'setup', 'ongoing']);

    const expectsResolution =
      eventResolutionType !== undefined && !NON_RESOLVING.has(eventResolutionType);
    if (expectsResolution && !conflictAnalysis.resolutionAchieved) {
      const message = eventConflictType
        ? `Scene "${event.id}" declares conflict type "${eventConflictType}" with resolution "${eventResolutionType}" but Pass 2 analysis indicates resolution was NOT achieved`
        : `Scene "${event.id}" declares resolution type "${eventResolutionType}" but Pass 2 analysis indicates resolution was NOT achieved`;

      issues.push(
        makeIssue(
          this.name,
          event.id,
          'system',
          'error',
          message,
          'Rewrite the scene to explicitly resolve the conflict according to the declared resolution type, or remove the resolutionType if this is a setup scene.',
          'edit_file',
          'resolutionType',
          undefined,
          undefined,
          'interpretive_assessment',
        ),
      );
    }

    // Check 2: If conflict type is declared, verify the analysis detected it
    if (eventConflictType && conflictAnalysis.primaryType !== eventConflictType) {
      issues.push(
        makeIssue(
          this.name,
          event.id,
          'system',
          'info',
          `Scene "${event.id}" declares conflict type "${eventConflictType}" but Pass 2 detected "${conflictAnalysis.primaryType}"`,
          'Either the conflict was portrayed differently in prose, or the declaration needs updating.',
          'change_value',
          'conflictType',
          undefined,
          undefined,
          'interpretive_assessment',
        ),
      );
    }

    // Check 3: If analysis says resolution achieved but no resolution type declared
    if (conflictAnalysis.resolutionAchieved && !eventResolutionType) {
      issues.push(
        makeIssue(
          this.name,
          event.id,
          'system',
          'info',
          `Pass 2 indicates conflict resolution was achieved, but no resolutionType is declared for this scene`,
          'Consider adding a resolutionType to document how this conflict wraps up.',
          'add_field',
          'resolutionType',
          undefined,
          undefined,
          'interpretive_assessment',
        ),
      );
    }

    return issues;
  }

  getAnalysisRequirements() {
    return [
      {
        field: 'conflictAnalysis',
        schema: conflictAnalysisSchema,
        instruction:
          'conflictAnalysis: Identify the primary type of conflict depicted in the scene (e.g., character vs. character, character vs. self, character vs. nature, character vs. society) and whether it achieves resolution by the end of the scene. Report in the conflictAnalysis block with primaryType and resolutionAchieved.',
      },
    ];
  }
}
