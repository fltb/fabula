// ============================================================================
// DiscourseBalanceValidator — Distribution of discourse modes across scenes
// ============================================================================
//
// Checks that no single discourseMode dominates >80% of scenes,
// ensuring a healthy mix of action, dialogue, description, etc.
// ============================================================================

import type {
  PreRenderInput,
  PostRenderInput,
  Validator,
  ValidationIssue,
} from '../types/index.js';
import { makeIssue } from './base.js';

const MAX_DOMINANCE_FRACTION = 0.8;

export class DiscourseBalanceValidator implements Validator {
  name = 'discourse_balance';
  category = 'narrative_style' as const;

  validatePre(input: PreRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const { event, events } = input;

    // Check current event's discourseMode
    // (If no discourseMode set, that's informational but not an error)
    if (!event.discourseMode) {
      issues.push(makeIssue(
        this.name,
        event.id,
        'system',
        'info',
        `Scene "${event.id}" has no discourseMode set`,
          'Consider setting a discourseMode (action, dialogue, description, exposition, reflection, transition) to guide the LLM.',
          'add_field',
          'discourseMode',
      ));
    }

    // Check distribution across ALL events (pre-render has access to full events array)
    if (events.length < 3) return issues; // Too few scenes to judge balance

    const modeCount = new Map<string, number>();
    let totalWithMode = 0;

    for (const evt of events) {
      if (evt.discourseMode) {
        modeCount.set(evt.discourseMode, (modeCount.get(evt.discourseMode) ?? 0) + 1);
        totalWithMode++;
      }
    }

    if (totalWithMode === 0) return issues;

    for (const [mode, count] of modeCount.entries()) {
      const fraction = count / totalWithMode;
      if (fraction > MAX_DOMINANCE_FRACTION) {
        issues.push(makeIssue(
          this.name,
          event.id,
          'system',
          'warning',
          `discourseMode "${mode}" dominates ${(fraction * 100).toFixed(0)}% of scenes (${count}/${totalWithMode}) — max recommended is ${MAX_DOMINANCE_FRACTION * 100}%`,
          'Introduce variety by assigning different discourse modes to upcoming scenes.',
          'change_value',
          'discourseMode',
        ));
      }
    }

    return issues;
  }

  validatePost(input: PostRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const { event, analysis } = input;

    if (!analysis) return issues;

    // Check Pass 2 narrativeChecks for discourse balance hints
    const narrativeChecks = analysis.analysis.narrativeChecks ?? [];
    for (const check of narrativeChecks) {
      if (check.attribute === 'discourse_balance' || check.attribute === 'discourseMode') {
        if (check.matchLevel === 'absent' || check.matchLevel === 'contradicted') {
          issues.push(makeIssue(
            this.name,
            event.id,
            check.entityId,
            'info',
            `Discourse balance signal: "${check.hint}" — ${check.matchLevel}`,
            check.evidence,
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
      attributes: ['discourse_balance', 'discourseMode'],
      schemaExample: { entityId: 'E1', attribute: 'discourse_balance', hint: '...', evidence: '...', matchLevel: 'exact' },
      instruction: 'narrativeChecks[discourse]: Evaluate whether the prose\'s discourse mode aligns with the expected discourseMode (action, dialogue, description, exposition, reflection, transition) from the scene spec. Use the narrativeChecks block with attribute "discourse_balance" or "discourseMode" to report whether the prose stays in the intended mode or shifts awkwardly.',
    }];
  }
}
