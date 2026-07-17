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

export class ForeshadowingValidator implements Validator {
  name = 'foreshadowing';
  category = 'factual_detail' as const;

  validatePre(input: PreRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const { event, events, chapter } = input;

    // Check existing foreshadows: are they past due?
    for (const f of event.foreshadowing) {
      if (
        f.targetRevealChapter > 0 &&
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
    const { prose, event } = input;
    const proseLower = prose.toLowerCase();

    for (const f of event.foreshadowing) {
      const hintWords = f.hint.split(/\s+/).filter((w) => w.length > 3);
      if (hintWords.length === 0) continue;

      const foundCount = hintWords.filter((w) => proseLower.includes(w.toLowerCase())).length;
      const threshold = Math.max(1, Math.floor(hintWords.length * 0.5));

      if (foundCount < threshold) {
        issues.push(makeIssue(
          this.name, event.id, f.id, 'warning',
          `Foreshadow hint "${f.hint}" is not reflected in the rendered prose — reader may miss this setup`,
          'Weave the foreshadowing hint into the narrative prose.',
          'edit_file',
          'foreshadowing',
        ));
      }
    }

    return issues;
  }
}
