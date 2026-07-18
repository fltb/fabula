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

export class ThreadProgressValidator implements Validator {
  name = 'thread_progress';
  category = 'timeline_plot' as const;

  validatePre(_input: PreRenderInput): ValidationIssue[] {
    return [];
  }

  validatePost(input: PostRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    if (!input.analysis) return issues;

    const achieved = new Set(input.analysis.analysis.threadProgressAchieved ?? []);
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
      schemaExample: ['thread ID that the prose advances'],
      instruction: 'threadProgressAchieved: List the IDs of narrative threads that this scene meaningfully advances. Only include threads where new information, character development, or plot movement occurs.',
    }];
  }
}
