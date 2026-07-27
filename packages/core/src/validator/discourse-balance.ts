// ============================================================================
// DiscourseBalanceValidator — Distribution of discourse modes across scenes
// ============================================================================
//
// Checks that no single discourseMode dominates >80% of scenes,
// ensuring a healthy mix of action, dialogue, description, etc.
// ============================================================================

import { z } from 'zod';
import type {
  PostRenderInput,
  PreRenderInput,
  ValidationIssue,
  Validator,
} from '../types/index.js';
import {
  consumeNarrativeChecks,
  getAttributeSemanticRole,
  getAttributesBySemanticRole,
  makeIssue,
} from './base.js';
import { narrativeCheckSchema } from './schemas.js';

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
      issues.push(
        makeIssue(
          this.name,
          event.id,
          'system',
          'info',
          `Scene "${event.id}" has no discourseMode set`,
          'Consider setting a discourseMode (action, dialogue, description, exposition, reflection, transition) to guide the LLM.',
          'add_field',
          'discourseMode',
        ),
      );
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
        issues.push(
          makeIssue(
            this.name,
            event.id,
            'system',
            'warning',
            `discourseMode "${mode}" dominates ${(fraction * 100).toFixed(0)}% of scenes (${count}/${totalWithMode}) — max recommended is ${MAX_DOMINANCE_FRACTION * 100}%`,
            'Introduce variety by assigning different discourse modes to upcoming scenes.',
            'change_value',
            'discourseMode',
          ),
        );
      }
    }

    return issues;
  }

  validatePost(input: PostRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const { event, analysis } = input;

    if (!analysis) return issues;

    // Check Pass 2 narrativeChecks for discourse balance hints
    const narrativeChecks =
      z.array(narrativeCheckSchema).safeParse(analysis.analysis.narrativeChecks).data ?? [];
    issues.push(
      ...consumeNarrativeChecks(
        narrativeChecks,
        (check) => {
          // Catalog-driven: verify attribute is a narrative attribute
          const entityKind = input.entityRegistry?.resolve(check.entityId)?.kind;
          if (entityKind) {
            const role = getAttributeSemanticRole(entityKind, check.attribute);
            if (role !== 'narrative') return false;
            // Narrow to discourse-specific narrative attributes from catalog
            const narrativeAttrs = getAttributesBySemanticRole(entityKind, 'narrative');
            const discourseAttrs: string[] = narrativeAttrs.filter(
              (a) => a === 'discourse_balance' || a === 'discourseMode',
            );
            if (!discourseAttrs.includes(check.attribute)) return false;
          } else if (
            check.attribute !== 'discourse_balance' &&
            check.attribute !== 'discourseMode'
          ) {
            return false;
          }
          return check.matchLevel === 'absent' || check.matchLevel === 'contradicted';
        },
        (check) =>
          makeIssue(
            this.name,
            event.id,
            check.entityId,
            'info',
            `Discourse balance signal: "${check.hint}" — ${check.matchLevel}`,
            check.evidence,
            'manual',
          ),
      ),
    );

    return issues;
  }

  getAnalysisRequirements() {
    return [
      {
        field: 'narrativeChecks',
        attributes: ['discourse_balance', 'discourseMode'],
        schema: z.array(narrativeCheckSchema),
        instruction:
          'narrativeChecks[discourse]: Evaluate whether the prose\'s discourse mode aligns with the expected discourseMode (action, dialogue, description, exposition, reflection, transition) from the scene spec. Use the narrativeChecks block with attribute "discourse_balance" or "discourseMode" to report whether the prose stays in the intended mode or shifts awkwardly.',
      },
    ];
  }
}
