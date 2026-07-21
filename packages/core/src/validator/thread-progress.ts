// ============================================================================
// ThreadProgressValidator — Verify narrative threads are advanced in prose
// ============================================================================

import type {
  PostRenderInput,
  PreRenderInput,
  Validator,
  ValidationIssue,
} from '../types/index.js';
import { makeIssue } from './base.js';
import { z } from 'zod';
export const threadProgressAchievedSchema = z.array(z.string());
 

export class ThreadProgressValidator implements Validator {
  name = 'thread_progress';
  category = 'timeline_plot' as const;

  validatePre(input: PreRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // Check: threadProgress entries reference threads that exist in world state
    // (after replay, state.threads contains all established thread IDs from
    //  every event's threadProgress — unknown thread IDs indicate a schema concern)
    for (const tp of input.event.threadProgress) {
      const threadState = input.getThreadProgress(tp.thread);
      if (!threadState || (threadState.progress === 0 && threadState.total === 0 && !input.worldState.threads[tp.thread])) {
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

    const achieved = new Set(threadProgressAchievedSchema.safeParse(input.analysis.analysis.threadProgressAchieved).data ?? []);
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
