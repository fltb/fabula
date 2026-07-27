// ============================================================================
// ForeshadowingValidator — Check foreshadow status
// ============================================================================
// Uses event-level foreshadowing fields (id, hint, targetRevealChapter), not
// entity attribute lookups. Foreshadowing is an event-level construct, not
// represented in entity attribute catalog. Catalog functions imported for
// future use.

/** 2-chapter threshold for dangling foreshadow detection */
export const FORESHADOW_THRESHOLD_CHAPTERS = 2;

import { z } from 'zod';
import type {
  PostRenderInput,
  PreRenderInput,
  ValidationIssue,
  Validator,
} from '../types/index.js';
import { getAttributeSemanticRole, getAttributesBySemanticRole, makeIssue } from './base.js';
export const foreshadowingDeployedSchema = z.array(z.string());

export class ForeshadowingValidator implements Validator {
  name = 'foreshadowing';
  category = 'factual_detail' as const;

  validatePre(input: PreRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const { event, events, chapter } = input;

    // Check existing foreshadows: are they past due?
    for (const f of event.foreshadowing) {
      if (f.targetRevealChapter >= 0 && chapter > f.targetRevealChapter) {
        issues.push(
          makeIssue(
            this.name,
            event.id,
            f.id,
            'warning',
            `Foreshadow "${f.id}" (${f.hint}) was supposed to be revealed by chapter ${f.targetRevealChapter}, but we're at chapter ${chapter}`,
            'Add the reveal event, or update the target_reveal_chapter.',
            'change_value',
            'target_reveal_chapter',
          ),
        );
      }
    }

    // Check all foreshadows in the event store: any dangling?
    const allForeshadows = events.flatMap((e) =>
      e.foreshadowing.map((f) => ({ ...f, eventId: e.id })),
    );
    for (const f of allForeshadows) {
      if (
        f.targetRevealChapter > 0 &&
        chapter > f.targetRevealChapter + FORESHADOW_THRESHOLD_CHAPTERS
      ) {
        // Already past the threshold past due
        const alreadyReported = issues.some((i) => i.entity === f.id);
        if (!alreadyReported) {
          issues.push(
            makeIssue(
              this.name,
              f.eventId,
              f.id,
              'error',
              `Foreshadow "${f.id}" planted in ${f.eventId} (target: chapter ${f.targetRevealChapter}) is ${FORESHADOW_THRESHOLD_CHAPTERS}+ chapters overdue at chapter ${chapter}`,
              'Write the reveal scene or update the target chapter.',
              'change_value',
              'target_reveal_chapter',
            ),
          );
        }
      }
    }

    return issues;
  }

  validatePost(input: PostRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    if (!input.analysis) return issues;

    const fsResult = foreshadowingDeployedSchema.safeParse(
      input.analysis.analysis.foreshadowingDeployed,
    );
    const deployed = new Set(fsResult.success ? fsResult.data : []);
    const declared = input.event.foreshadowing ?? [];

    for (const fs of declared) {
      if (!fs.hint) continue;
      if (!deployed.has(fs.id)) {
        issues.push(
          makeIssue(
            this.name,
            input.event.id,
            fs.id,
            'warning',
            `Foreshadowing "${fs.id}" not detected in prose: "${fs.hint}"`,
            'Ensure foreshadowing is present in the rendered prose',
            'edit_file',
            'foreshadowing',
          ),
        );
      }
    }

    return issues;
  }

  getAnalysisRequirements() {
    return [
      {
        field: 'foreshadowingDeployed',
        schema: foreshadowingDeployedSchema,
        instruction:
          'foreshadowingDeployed: List which foreshadowing IDs from the scene specification have their hints appear in the prose. Report in the foreshadowingDeployed block as an array of foreshadowing IDs that are reflected. If a hint is woven naturally into the narrative, it counts as deployed.',
      },
    ];
  }
}
