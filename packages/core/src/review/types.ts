import type { ReviewComment } from '../types/index.js';

/** Filter used by semantic ReviewManager queries. */
export interface CommentFilter {
  status?: ReviewComment['status'];
  severity?: ReviewComment['severity'];
  targetType?: string;
  targetId?: string;
}


export interface StatusSummary {
  total: number;
  open: number;
  blocking: number;
  addressed: number;
  resolved: number;
  wontfix: number;
  superseded: number;
}
