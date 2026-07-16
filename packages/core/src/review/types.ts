// ============================================================================
// Review System — Local type definitions
// ============================================================================

import type { ReviewComment } from '../types/index.js';

/** Filter used by getComments() */
export interface CommentFilter {
  status?: ReviewComment['status'];
  severity?: ReviewComment['severity'];
  targetType?: string;
  targetId?: string;
}

/** Shape returned by getSummary() */
export interface StatusSummary {
  total: number;
  open: number;
  blocking: number;
  addressed: number;
  resolved: number;
  wontfix: number;
}
