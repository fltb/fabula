// ============================================================================
// ForeshadowingValidator — Check foreshadow status
// ============================================================================

import type {
  Validator,
  ValidationIssue,
  PreRenderInput,
  PostRenderInput,
} from '../types/index.js';
import { makeIssue } from './base.js';
import { z } from 'zod';
export const foreshadowingDeployedSchema = z.array(z.string());
 

export class ForeshadowingValidator implements Validator {
  name = 'foreshadowing';
  category = 'factual_detail' as const;

  validatePre(input: PreRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const { event, events, chapter } = input;

    // Check existing foreshadows: are they past due?
    for (const f of event.foreshadowing) {
      if (
        f.targetRevealChapter >= 0 &&
        chapter > f.targetRevealChapter
      ) {
        issues.push(makeIssue(
          this.name, event.id, f.id, 'warning',
          `Foreshadow "${f.id}" (${f.hint}) was supposed to be revealed by chapter ${f.targetRevealChapter}, but we're at chapter ${chapter}`,
          'Add the reveal event, or update the target_reveal_chapter.',
          'change_value',
          'target_reveal_chapter',
        ));
      }
    }

    // Check all foreshadows in the event store: any dangling?
    // (partial check — full check is in ReachabilityValidator)
    const allForeshadows = events.flatMap((e) => e.foreshadowing);
    for (const f of allForeshadows) {
      if (f.targetRevealChapter > 0 && chapter > f.targetRevealChapter + 2) {
        // Already 2 chapters past due
        const alreadyReported = issues.some((i) => i.entity === f.id);
        if (!alreadyReported) {
          issues.push(makeIssue(
            this.name, f.id, f.id, 'error',
            `Foreshadow "${f.id}" is 2+ chapters past its reveal deadline (chapter ${f.targetRevealChapter})`,
            'Write the reveal scene or update the target chapter.',
            'change_value',
            'target_reveal_chapter',
          ));
        }
      }
    }

    return issues;
  }

  validatePost(input: PostRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    if (!input.analysis) return issues;

    const fsResult = foreshadowingDeployedSchema.safeParse(input.analysis.analysis.foreshadowingDeployed);
    const deployed = new Set(fsResult.success ? fsResult.data : []);
    const declared = input.event.foreshadowing ?? [];

    for (const fs of declared) {
      if (!fs.hint) continue;
      if (!deployed.has(fs.id)) {
        issues.push(makeIssue(
          this.name,
          input.event.id,
          fs.id,
          'warning',
          `Foreshadowing "${fs.id}" not detected in prose: "${fs.hint}"`,
          'Ensure foreshadowing is present in the rendered prose',
          'edit_file',
          'foreshadowing',
        ));
      }
    }

    return issues;
  }

  getAnalysisRequirements() {
    return [{
      field: 'foreshadowingDeployed',
      schema: foreshadowingDeployedSchema,
      instruction: 'foreshadowingDeployed: List which foreshadowing IDs from the scene specification have their hints appear in the prose. Report in the foreshadowingDeployed block as an array of foreshadowing IDs that are reflected. If a hint is woven naturally into the narrative, it counts as deployed.',
    }];
  }
}
