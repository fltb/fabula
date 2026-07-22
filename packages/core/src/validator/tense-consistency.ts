// ============================================================================
// TenseConsistencyValidator — Cross-scene and per-scene tense consistency
// ============================================================================
//
// Checks:
// - Pass 2 tenseDetected matches the scene-level tense override (if set)
// - Cross-scene changes detected from input.events in validatePre
// ============================================================================

import { z } from 'zod';
import { makeIssue, getAttributeSemanticRole, getAttributesBySemanticRole } from './base.js';
import type {
  PostRenderInput,
  PreRenderInput,
  Validator,
  ValidationIssue,
} from '../types/index.js';

export const tenseDetectedSchema = z.enum(['past', 'present', 'mixed']);
export type TenseDetected = z.infer<typeof tenseDetectedSchema>;

export class TenseConsistencyValidator implements Validator {
  name = 'tense_consistency';
  category = 'narrative_style' as const;

  validatePre(input: PreRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const { event, events } = input;

    // Deterministic check: detect if this event's tense differs from
    // previously seen events (cross-scene tense change)
    // event-level field, not in entity attribute catalog
    if (event.tense) {
      const earlierEvents = events.filter(
        (e) => e.narrativeOrder < event.narrativeOrder && e.id !== 'system:genesis' && e.tense,
      );
      if (earlierEvents.length > 0) {
        const earlierTenses = new Set(earlierEvents.map((e) => e.tense));
        if (!earlierTenses.has(event.tense)) {
          issues.push(makeIssue(
            this.name, event.id, 'system', 'error',
            `Tense "${event.tense}" differs from earlier scenes' tense(s): [${[...earlierTenses].join(', ')}]`,
            'Ensure tense is consistent across scenes, or mark the transition clearly.',
            'edit_file',
            'tense',
          ));
        }
      }
    }

    return issues;
  }
  validatePost(input: PostRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const { event, analysis } = input;

    if (!analysis) return issues;

    const tenseResult = tenseDetectedSchema.safeParse(analysis.analysis.tenseDetected);
    if (!tenseResult.success) return issues;
    const tenseDetected = tenseResult.data;

    // Check 1: If scene declares a tense override, it should match what was detected
    // event-level field, not in entity attribute catalog
    if (event.tense) {
      if (tenseDetected === 'mixed') {
        issues.push(makeIssue(
          this.name,
          event.id,
          'system',
          'warning',
          `Scene "${event.id}" declares tense "${event.tense}" but Pass 2 detected mixed tense usage`,
          'Review the prose to ensure consistent tense throughout this scene.',
          'edit_file',
          'tense',
        ));
      } else if (tenseDetected !== event.tense) {
        issues.push(makeIssue(
          this.name,
          event.id,
          'system',
          'warning',
          `Scene "${event.id}" declares tense "${event.tense}" but Pass 2 detected "${tenseDetected}"`,
          'Update the prose to match the declared tense, or change the tense declaration.',
          'edit_file',
          'tense',
        ));
      }
    }

    return issues;
  }

  getAnalysisRequirements() {
    return [{
      field: 'tenseDetected',
      schema: tenseDetectedSchema,
      instruction: 'tenseDetected: Determine the grammatical tense used in the prose and report it as "past", "present", or "mixed" in the tenseDetected field. If mixed, note which sections deviate from the event\'s specified tense.',
    }];
  }
}
