import type { CoreRuntimeServices } from '../ports/runtime-services.ts';
import type { ReviewComment } from '../types/index.js';

/** Filter used by semantic ReviewManager queries. */
export interface CommentFilter {
  status?: ReviewComment['status'];
  severity?: ReviewComment['severity'];
  targetType?: string;
  targetId?: string;
}

/** Time and ID sources injected by the host for review ledger mutations. */
export type ReviewServices = Pick<CoreRuntimeServices, 'clock' | 'ids'>;

export interface StatusSummary {
  total: number;
  open: number;
  blocking: number;
  addressed: number;
  resolved: number;
  wontfix: number;
  superseded: number;
}
