import type { CoreRuntimeServices } from '../ports/runtime-services.ts';
import type { ReviewComment } from '../types/index.js';

/** Filter used by semantic ReviewManager queries. */
export interface CommentFilter {
  status?: ReviewComment['status'];
  severity?: ReviewComment['severity'];
  targetType?: string;
  targetId?: string;
}

/** Time and ID sources injected by the host for review event mutations. */
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

export type {
  ReviewCommentAppliedPayloadV1,
  ReviewCommentDraftV1,
  ReviewCommentReplacedPayloadV1,
  ReviewCommentStatusChangedPayloadV1,
  ReviewEventDraftV1,
  ReviewEventKindV1,
  ReviewEventReadResultV1,
  ReviewEventRecordV1,
  ReviewGateDecisionV1,
  ReviewGateInputV1,
  ReviewGateV1,
  ReviewProjectionV1,
} from './events.js';
