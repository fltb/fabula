// ============================================================================
// Review System — Summary computation (pure functions)
// ============================================================================

import type { ReviewComment } from '../types/index.js';
import type { StatusSummary } from './types.js';

/** Count comments by status, with a blocking tally */
export function getSummary(comments: ReviewComment[], _currentChapter: number): StatusSummary {
  const byStatus: StatusSummary = {
    total: comments.length,
    open: 0,
    blocking: 0,
    addressed: 0,
    resolved: 0,
    wontfix: 0,
  };
  for (const c of comments) {
    byStatus[c.status]++;
    if (c.severity === 'blocking' && c.status === 'open') byStatus.blocking++;
  }
  return byStatus;
}
