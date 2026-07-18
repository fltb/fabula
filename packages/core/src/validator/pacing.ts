// ============================================================================
// PacingValidator — Arc position progression and narrative pacing checks
// ============================================================================
//
// Checks that arcPosition values follow a coherent story arc:
// - Climax events should be at ~60-85% of total events
// - Early events (1-2) should typically be 'opening'
// - arcPosition should not regress (e.g., climax → rising)
// ============================================================================

import type {
  PreRenderInput,
  PostRenderInput,
  Validator,
  ValidationIssue,
} from '../types/index.js';
import { makeIssue } from './base.js';

const ARC_PROGRESSION: readonly string[] = [
  'opening',
  'rising',
  'climax',
  'falling',
  'denouement',
] as const;

const CLIMAX_MIN_FRACTION = 0.6;
const CLIMAX_MAX_FRACTION = 0.85;

export class PacingValidator implements Validator {
  name = 'pacing';
  category = 'narrative_style' as const;

  validatePre(input: PreRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const { event, events } = input;

    const totalEvents = events.length;
    if (totalEvents < 2) return issues; // Too few events to judge pacing

    // Check 1: Climax events should be at ~60-85% of total events
    if (event.arcPosition === 'climax') {
      const position = event.narrativeOrder;
      const fraction = (position - 1) / (totalEvents - 1);
      if (fraction < CLIMAX_MIN_FRACTION || fraction > CLIMAX_MAX_FRACTION) {
        issues.push(makeIssue(
          this.name,
          event.id,
          'system',
          'warning',
          `Climax at position ${position}/${totalEvents} (${(fraction * 100).toFixed(0)}%) — expected between ${CLIMAX_MIN_FRACTION * 100}% and ${CLIMAX_MAX_FRACTION * 100}%`,
          'Consider repositioning this event to fall in the 60-85% range, or change its arcPosition.',
          'change_value',
          'arcPosition',
        ));
      }
    }

    // Check 2: Early events (first 2) should typically be 'opening'
    if (event.narrativeOrder <= 2 && event.arcPosition && event.arcPosition !== 'opening') {
      issues.push(makeIssue(
        this.name,
        event.id,
        'system',
        'info',
        `Early event (#${event.narrativeOrder}) has arcPosition "${event.arcPosition}" — first events are typically "opening"`,
        'Consider using "opening" for story setup events, or confirm this is intentional.',
        'change_value',
        'arcPosition',
      ));
    }

    return issues;
  }

  validatePost(input: PostRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const { event, analysis } = input;

    if (!analysis) return issues;

    // Check: narrativeChecks can surface pacing-related issues from Pass 2
    const narrativeChecks = analysis.analysis.narrativeChecks ?? [];
    for (const check of narrativeChecks) {
      if (check.attribute.includes('pacing') || check.attribute.includes('pace')) {
        if (check.matchLevel === 'absent' || check.matchLevel === 'contradicted') {
          issues.push(makeIssue(
            this.name,
            event.id,
            check.entityId,
            'warning',
            `Pacing issue: "${check.hint}" — ${check.matchLevel} (${check.evidence})`,
            check.matchLevel === 'absent'
              ? 'Expected pacing signal was not detected in the prose.'
              : 'Prose contradicts expected pacing signal.',
            'manual',
          ));
        }
      }
    }

    return issues;
  }

  getAnalysisRequirements() {
    return [{
      field: 'narrativeChecks',
      attributes: ['pacing', 'pace'],
      schemaExample: { entityId: 'E1', attribute: 'pacing', hint: '...', evidence: '...', matchLevel: 'exact' },
      instruction: 'narrativeChecks[pacing]: For each character or scene element with pacing expectations, check if the prose\'s narrative pace (sentence length, action density, reflective passages) aligns with the expected pacing. Use the narrativeChecks block with attribute containing "pacing" or "pace" to report whether the pacing signal matches expectations. Report matchLevel as "exact", "similar", "absent", or "contradicted".',
    }];
  }
}
