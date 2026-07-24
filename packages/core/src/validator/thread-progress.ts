// ============================================================================
// ThreadProgressValidator — Verify narrative threads are advanced in prose
// ============================================================================

import type {
  PostRenderInput,
  PreRenderInput,
  Validator,
  ValidationIssue,
} from '../types/index.js';
import { makeIssue, getAttributeSemanticRole, getAttributesBySemanticRole } from './base.js';
import { z } from 'zod';
export const threadProgressAchievedSchema = z.array(z.string());
 

export class ThreadProgressValidator implements Validator {
  name = 'thread_progress';
  category = 'timeline_plot' as const;
  // Uses event-level threadProgress fields, not entity attribute lookups.
  // Thread IDs are project-defined narrative markers, not entity attributes.
  // Catalog functions imported for future use.

  validatePre(input: PreRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    // Check: threadProgress entries reference threads that exist in world state
    // (after replay, state.threads contains all established thread IDs from
    //  every event's threadProgress — unknown thread IDs indicate a schema concern)
    for (const tp of input.event.threadProgress) {
      const threadState = input.getThreadProgress(tp.thread);
      const missing = !threadState || !input.worldState.threads[tp.thread];
      if (missing) {
        issues.push(makeIssue(
          this.name, input.event.id, tp.thread, 'warning',
          `Thread "${tp.thread}" referenced in threadProgress is not defined in world state`,
          'Add a matching thread definition or remove the reference.',
          'edit_file',
          'threadProgress',
        ));
      }
    }

    return issues;
  }

  validatePost(input: PostRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    if (!input.analysis) return issues;

    const achievedIds = (threadProgressAchievedSchema.safeParse(input.analysis.analysis.threadProgressAchieved).data ?? [])
      .map(s => s.split(/[:：]/)[0].trim());
    const achieved = new Set(achievedIds);
    const declared = input.event.threadProgress ?? [];

    for (const tp of declared) {
      if (!achieved.has(tp.thread)) {
        issues.push(makeIssue(
          'thread_progress', input.event.id, tp.thread, 'warning',
          `Thread "${tp.thread}" not advanced in prose: "${tp.advancement}"`,
          'Ensure the scene advances this narrative thread.',
          'edit_file', 'threadProgress',
        ));
      }
    }
    return issues;
  }

  getAnalysisRequirements() {
    return [{
      field: 'threadProgressAchieved',
      schema: threadProgressAchievedSchema,
      instruction: 'threadProgressAchieved: List the IDs of narrative threads that this scene meaningfully advances. Only include threads where new information, character development, or plot movement occurs.',
    }];
  }
}
