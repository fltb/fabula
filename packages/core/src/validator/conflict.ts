// ============================================================================
// ConflictValidator — Scene conflict resolution consistency
// ============================================================================
//
// Consumes Pass 2 conflictAnalysis block to verify that:
// - If a scene declares a resolutionType, the analysis should confirm resolution
// - If analysis says resolutionAchieved=false but scene expects resolution = error
// ============================================================================

import type {
  PostRenderInput,
  Validator,
  ValidationIssue,
} from '../types/index.js';
import { makeIssue } from './base.js';

export class ConflictValidator implements Validator {
  name = 'conflict';
  category = 'factual_detail' as const;

  validatePost(input: PostRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const { event, analysis } = input;

    if (!analysis) return issues;

    const conflictAnalysis = analysis.analysis.conflictAnalysis;
    if (!conflictAnalysis) return issues;

    const eventResolutionType = event.resolutionType;
    const eventConflictType = event.conflictType;

    // Check 1: If scene declares a resolution type, it should be achieved
    if (eventResolutionType && !conflictAnalysis.resolutionAchieved) {
      const message = eventConflictType
        ? `Scene "${event.id}" declares conflict type "${eventConflictType}" with resolution "${eventResolutionType}" but Pass 2 analysis indicates resolution was NOT achieved`
        : `Scene "${event.id}" declares resolution type "${eventResolutionType}" but Pass 2 analysis indicates resolution was NOT achieved`;

      issues.push(makeIssue(
        this.name,
        event.id,
        'system',
        'error',
        message,
        'Rewrite the scene to explicitly resolve the conflict according to the declared resolution type, or remove the resolutionType if this is a setup scene.',
        'edit_file',
        'resolutionType',
      ));
    }

    // Check 2: If conflict type is declared, verify the analysis detected it
    if (eventConflictType && conflictAnalysis.primaryType !== eventConflictType) {
      issues.push(makeIssue(
        this.name,
        event.id,
        'system',
        'info',
        `Scene "${event.id}" declares conflict type "${eventConflictType}" but Pass 2 detected "${conflictAnalysis.primaryType}"`,
        'Either the conflict was portrayed differently in prose, or the declaration needs updating.',
        'change_value',
        'conflictType',
      ));
    }

    // Check 3: If analysis says resolution achieved but no resolution type declared
    if (conflictAnalysis.resolutionAchieved && !eventResolutionType) {
      issues.push(makeIssue(
        this.name,
        event.id,
        'system',
        'info',
        `Pass 2 indicates conflict resolution was achieved, but no resolutionType is declared for this scene`,
        'Consider adding a resolutionType to document how this conflict wraps up.',
        'add_field',
        'resolutionType',
      ));
    }

    return issues;
  }

  getAnalysisRequirements() {
    return [{
      field: 'conflictAnalysis',
      schemaExample: { primaryType: 'character vs. character', resolutionAchieved: false },
      instruction: 'conflictAnalysis: Identify the primary type of conflict depicted in the scene (e.g., character vs. character, character vs. self, character vs. nature, character vs. society) and whether it achieves resolution by the end of the scene. Report in the conflictAnalysis block with primaryType and resolutionAchieved.',
    }];
  }
}
