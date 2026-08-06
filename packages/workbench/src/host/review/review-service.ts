// ============================================================================
// Host Review & Release-Gate Service (plan Step 5)
// ----------------------------------------------------------------------------
// Wraps the Core review facade (`addReviewComment` / `replaceReviewComment` /
// `updateReviewComment` / `listReviewComments`) and Core `resolveReleaseGate`
// over the project session's EditorialRuntime, and records every mutation as
// a durable `ProjectOperationRecordV1` (kind 'review' for comment add/update,
// 'release-gate' for a maintainer gate decision) with the actorId and
// capabilityVersion taken from the caller grant — mirroring the authoring
// coordinator's record writing. Gate decisions go through Core
// `resolveReleaseGate` and NEVER re-invoke the provider.
//
// Reads are pure projections of the append-only review event stream; the
// status counts for `nova_status` are derived from `projectReviewState` here
// (open = open comments; pendingGates = open gates; blocking = open blocking
// comments plus pending gates), so `nova_status` stops reporting honest zeros
// once this service is wired.
// ============================================================================

import { randomUUID } from 'node:crypto';
import type {
  ReviewGateV1,
  ReviewProjectionV1,
  WorkflowReviewProjectionV1,
} from '@novalistically/core';
import { projectReviewState } from '@novalistically/core';
import {
  addReviewComment,
  type EditorialRuntime,
  listReviewComments,
  type ReleaseGateResolutionV1,
  type ResolveReleaseGateInputV1,
  replaceReviewComment,
  resolveReleaseGate,
  updateReviewComment,
} from '@novalistically/core/editorial';
import type {
  ProjectOperationKindV1,
  ProjectOperationRecordV1,
} from '../../contracts/persistence.js';
import type { ProjectOperationStore } from '../../persistence/project-operation-store.js';
import type { McpAuthorizedCaller } from '../mcp/auth.js';
import type { ProjectSession } from '../project-session.js';

// The Core review comment types are not part of the public Core surface
// (top-level index exports only the event-stream/gate types), so the wire
// shapes are mirrored here; they are structurally identical to Core's
// `ReviewComment` / `NewReviewComment` and flow through the facade unchanged.

export interface HostReviewCommentTargetV1 {
  readonly type: 'novel' | 'chapter' | 'scene' | 'line' | 'character' | 'worldrule';
  readonly id: string;
  readonly lineRange?: [number, number];
  readonly lineBasis?: { readonly revisionId: string; readonly proseHash: string };
}

export interface HostNewReviewCommentV1 {
  readonly target: HostReviewCommentTargetV1;
  readonly severity: 'nit' | 'suggestion' | 'blocking';
  readonly category:
    | 'style'
    | 'pacing'
    | 'character_voice'
    | 'plot_logic'
    | 'world_consistency'
    | 'reader_experience';
  readonly content: string;
}

export interface HostReviewApplicationV1 {
  readonly eventId: string;
  readonly revisionId: string;
  readonly operationId: string;
  readonly appliedAt: string;
}

/** Full projected comment (wire mirror of Core `ReviewComment`). */
export interface HostReviewCommentV1 {
  readonly id: string;
  readonly author: 'human' | 'llm';
  readonly actorId: string;
  readonly target: HostReviewCommentTargetV1;
  readonly severity: HostNewReviewCommentV1['severity'];
  readonly category: HostNewReviewCommentV1['category'];
  readonly content: string;
  readonly status: 'open' | 'addressed' | 'resolved' | 'wontfix' | 'superseded';
  readonly applications: readonly HostReviewApplicationV1[];
  readonly supersedesId?: string;
  readonly resolvedBy?: string;
  readonly createdAt: string;
  readonly resolvedAt?: string;
}

/** Project-scoped comment read filter; `eventId` narrows to scene/line targets. */
export interface HostReviewCommentFilterV1 {
  readonly status?: HostReviewCommentV1['status'];
  readonly severity?: HostReviewCommentV1['severity'];
  readonly targetType?: string;
  readonly targetId?: string;
  readonly eventId?: string;
}

export type HostReviewCommentUpdateV1 =
  | {
      readonly action: 'replace';
      readonly commentId: string;
      readonly input: HostNewReviewCommentV1;
    }
  | {
      readonly action: 'resolve' | 'wontfix' | 'reopen' | 'escalate';
      readonly commentId: string;
    };

export interface HostReviewGateDecisionInputV1 {
  readonly eventId: string;
  readonly candidateRevisionId: string;
  readonly decision: 'accept' | 'reject';
  readonly reason: string;
}

export interface HostReviewService {
  readonly projectId: string;
  listComments(filter?: HostReviewCommentFilterV1): Promise<readonly HostReviewCommentV1[]>;
  getComment(commentId: string): Promise<HostReviewCommentV1 | null>;
  addComment(
    input: HostNewReviewCommentV1,
    caller: McpAuthorizedCaller,
  ): Promise<HostReviewCommentV1>;
  updateComment(
    input: HostReviewCommentUpdateV1,
    caller: McpAuthorizedCaller,
  ): Promise<HostReviewCommentV1>;
  listGates(eventId?: string): Promise<readonly ReviewGateV1[]>;
  decideGate(
    input: HostReviewGateDecisionInputV1,
    caller: McpAuthorizedCaller,
  ): Promise<ReleaseGateResolutionV1>;
  /** Full projected review state (comments + gates + event history). */
  reviewProjection(): Promise<ReviewProjectionV1>;
  /** The same projection narrowed to the `nova_status` review counts. */
  workflowReviewProjection(): Promise<WorkflowReviewProjectionV1>;
}

export interface CreateHostReviewServiceOptions {
  readonly projectId: string;
  /** The one project session; its runtime carries the Core execution services. */
  readonly session: ProjectSession;
  /** Durable per-project operation queue for the mutation records. */
  readonly operationStore: ProjectOperationStore;
  readonly now?: () => string;
  /**
   * Store-first observer fired after every persisted status transition
   * (queued creation, queued→running, running→terminal). SSE/broadcast
   * consumers never observe a state the durable row does not yet have — the
   * mirror of the operation service's `onStatusChange` contract.
   */
  readonly onStatusChange?: (record: ProjectOperationRecordV1) => void;
  /**
   * Fired after a release-gate decision promotes a candidate (accepted scene
   * commit). The Host uses it to trigger the best-effort canonical
   * publication refresh (plan 6.5); never awaited or error-propagated.
   */
  readonly onGateAccepted?: () => void;
}

/**
 * Pure status projection over the append-only review stream. Blocking counts
 * open blocking comments AND open (pending) gates — a pending gate blocks
 * release independently of any comment.
 */
export function workflowReviewProjectionFromState(
  state: ReviewProjectionV1,
): WorkflowReviewProjectionV1 {
  const openComments = state.comments.filter((comment) => comment.status === 'open');
  const pendingGates = state.gates.filter((gate) => gate.status === 'open');
  return {
    open: openComments.length,
    blocking:
      openComments.filter((comment) => comment.severity === 'blocking').length +
      pendingGates.length,
    pendingGates: pendingGates.length,
  };
}

function errorCodeOf(error: unknown): string {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'INTERNAL_ERROR';
}

export function createHostReviewService(
  options: CreateHostReviewServiceOptions,
): HostReviewService {
  const { projectId, session, operationStore } = options;
  const now = options.now ?? (() => session.runtime.services.clock.now());
  const fireStatusChange = options.onStatusChange ?? ((): void => {});
  const runtime = session.runtime as unknown as EditorialRuntime;
  const actorOf = (caller: McpAuthorizedCaller): string => caller.grant.userId;

  /**
   * Create one synchronous mutation record in `queued` (the worker only
   * accepts creation in queued). One-shot idempotency key (the operation id
   * itself), exactly like the authoring coordinator.
   */
  async function createRecord(input: {
    readonly kind: ProjectOperationKindV1;
    readonly actorId: string;
    readonly capabilityVersion: number;
    readonly sourceHash: string | null;
  }): Promise<ProjectOperationRecordV1> {
    const operationId = randomUUID();
    const createdAt = now();
    const created = await operationStore.upsert({
      record: {
        version: 1,
        projectId,
        operationId,
        idempotencyKey: operationId,
        kind: input.kind,
        status: 'queued',
        actorId: input.actorId,
        capabilityVersion: input.capabilityVersion,
        sourceHash: input.sourceHash,
        acceptedRevisionId: null,
        progress: null,
        resultRef: null,
        errorCode: null,
        createdAt,
        updatedAt: createdAt,
      },
    });
    fireStatusChange(created.record);
    return created.record;
  }

  /**
   * Transition the durable record to its terminal status. A fresh record
   * (queued) first moves to `running` — the worker automaton only allows
   * terminal transitions from `running`, mirroring the coordinator.
   */
  async function transitionRecord(
    record: ProjectOperationRecordV1,
    patch: {
      readonly status: 'succeeded' | 'failed';
      readonly errorCode?: string | null;
      readonly acceptedRevisionId?: string | null;
    },
  ): Promise<ProjectOperationRecordV1> {
    let running = record;
    if (record.status === 'queued') {
      const applied = await operationStore.upsert({
        record: { ...record, status: 'running', updatedAt: now() },
        expectedStatus: 'queued',
      });
      running = applied.record;
      fireStatusChange(applied.record);
    }
    const transitioned = await operationStore.upsert({
      record: {
        ...running,
        status: patch.status,
        ...(patch.errorCode === undefined ? {} : { errorCode: patch.errorCode }),
        ...(patch.acceptedRevisionId === undefined
          ? {}
          : { acceptedRevisionId: patch.acceptedRevisionId }),
        updatedAt: now(),
      },
      expectedStatus: running.status,
    });
    fireStatusChange(transitioned.record);
    return transitioned.record;
  }

  /** Run one mutation under a durable record; core failures become failed rows. */
  async function withRecord<T>(
    input: {
      readonly kind: 'review' | 'release-gate';
      readonly actorId: string;
      readonly capabilityVersion: number;
    },
    run: (operationId: string) => Promise<T>,
  ): Promise<T> {
    const record = await createRecord({
      kind: input.kind,
      actorId: input.actorId,
      capabilityVersion: input.capabilityVersion,
      sourceHash: session.source?.sourceHash ?? null,
    });
    try {
      const result = await run(record.operationId);
      await transitionRecord(record, { status: 'succeeded' });
      return result;
    } catch (error) {
      await transitionRecord(record, {
        status: 'failed',
        errorCode: errorCodeOf(error),
      }).catch(() => undefined);
      throw error;
    }
  }

  return {
    projectId,
    async listComments(filter) {
      const comments = await listReviewComments(
        {
          projectId,
          filter:
            filter === undefined
              ? undefined
              : {
                  ...(filter.status === undefined ? {} : { status: filter.status }),
                  ...(filter.severity === undefined ? {} : { severity: filter.severity }),
                  ...(filter.targetType === undefined ? {} : { targetType: filter.targetType }),
                  ...(filter.targetId === undefined ? {} : { targetId: filter.targetId }),
                },
        },
        runtime,
      );
      if (filter?.eventId === undefined) return comments;
      return comments.filter((comment) => comment.target.id === filter.eventId);
    },
    async getComment(commentId) {
      const comments = await listReviewComments({ projectId }, runtime);
      return comments.find((comment) => comment.id === commentId) ?? null;
    },
    async addComment(input, caller) {
      const actorId = actorOf(caller);
      return withRecord(
        {
          kind: 'review',
          actorId,
          capabilityVersion: caller.grant.version,
        },
        (operationId) =>
          addReviewComment({ projectId, input, mutation: { operationId, actorId } }, runtime),
      );
    },
    async updateComment(input, caller) {
      const actorId = actorOf(caller);
      return withRecord(
        {
          kind: 'review',
          actorId,
          capabilityVersion: caller.grant.version,
        },
        (operationId) =>
          input.action === 'replace'
            ? replaceReviewComment(
                {
                  projectId,
                  commentId: input.commentId,
                  input: input.input,
                  mutation: { operationId, actorId },
                },
                runtime,
              )
            : updateReviewComment(
                {
                  projectId,
                  commentId: input.commentId,
                  action: input.action,
                  mutation: { operationId, actorId },
                },
                runtime,
              ),
      );
    },
    async listGates(eventId) {
      const state = await projectReviewState(
        (await session.runtime.services.execution.readReviewEvents({ projectId })).events,
      );
      const gates = [...state.gates];
      return eventId === undefined ? gates : gates.filter((gate) => gate.eventId === eventId);
    },
    async decideGate(input, caller) {
      const source = session.source;
      if (source === null) {
        throw Object.assign(new Error('The session has no accepted source to gate.'), {
          code: 'NO_ACCEPTED_SOURCE',
        });
      }
      const actorId = actorOf(caller);
      const resolveInput: ResolveReleaseGateInputV1 = {
        projectId,
        sourceHash: source.sourceHash,
        eventId: input.eventId,
        candidateRevisionId: input.candidateRevisionId,
        decision: input.decision,
        actorId,
        capabilityVersion: caller.grant.version,
        reason: input.reason,
      };
      const record = await createRecord({
        kind: 'release-gate',
        actorId,
        capabilityVersion: caller.grant.version,
        sourceHash: source.sourceHash,
      });
      try {
        const resolution = await resolveReleaseGate(resolveInput, runtime);
        await transitionRecord(record, {
          status: 'succeeded',
          ...(resolution.outcome === 'accepted' && resolution.acceptedRevisionId !== null
            ? { acceptedRevisionId: resolution.acceptedRevisionId }
            : {}),
        });
        // An accepted scene commit is a canonical-publication trigger: notify
        // the Host best-effort (never awaited, never error-propagated).
        if (resolution.outcome === 'accepted' && resolution.acceptedRevisionId !== null) {
          options.onGateAccepted?.();
        }
        return resolution;
      } catch (error) {
        await transitionRecord(record, {
          status: 'failed',
          errorCode: errorCodeOf(error),
        }).catch(() => undefined);
        throw error;
      }
    },
    async reviewProjection() {
      const { events } = await session.runtime.services.execution.readReviewEvents({ projectId });
      return projectReviewState(events);
    },
    async workflowReviewProjection() {
      return workflowReviewProjectionFromState(await this.reviewProjection());
    },
  };
}
