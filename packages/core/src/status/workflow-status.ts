// ============================================================================
// Workflow Status V1 — Deterministic project workflow state projection
// ============================================================================
//
// `buildWorkflowStatus()` derives the single `WorkflowStatusV1` accepted-layer
// status contract used by `nova_status` and the Node Host status reporter.
//
// Design rules (plan Step 3.4):
//   - Inputs are INJECTED ports. This module performs no file I/O, no network
//     access, no provider/LLM calls and no compilation; the Host supplies the
//     accepted snapshot, validation result, ISS snapshot, per-event execution
//     state, working/review/publication projections and an optional clock.
//   - `render.completed` only counts events whose accepted-scene record carries
//     `AcceptedSceneRecord.sourceHash === snapshot.sourceHash`. It never infers
//     rendered state from `scenes/**/*.md` source documents.
//   - `render.ready/blocked/waiting` reuse the render pipeline's release
//     semantics: error-severity validation issues, empty prose, missing
//     analysis and exhausted retries block a scene; everything queued behind a
//     blocked scene waits; the remainder is ready.
//   - `nextActions` is a deterministic rule chain (no LLM); `guidance` is
//     generated from the same action list.
// ============================================================================

import type { ProjectSourceSnapshotV1 } from '../contracts/source.ts';
import type { AcceptedSceneRecord } from '../ports/execution-repository.ts';
import type { ISSSnapshot } from '../types/iss.ts';
import type { ValidationIssue } from '../types/validator.ts';

// ── Blocker ─────────────────────────────────────────────────────────────────

/**
 * One blocking condition on the accepted layer. Distinct from the legacy MCP
 * `StatusReport` blocker (types/status.ts), which describes missing
 * preconditions; this is the workflow-status blocker contract.
 */
export interface Blocker {
  readonly code: string;
  readonly message: string;
  readonly eventId?: string;
  readonly severity: 'error' | 'warning';
}

// ── Workflow next actions ───────────────────────────────────────────────────

export type WorkflowNextActionCode =
  | 'FIX_ACCEPTED_SOURCE'
  | 'VALIDATE_WORKING'
  | 'SUBMIT_WORKING'
  | 'RESOLVE_CONFLICT'
  | 'RENDER'
  | 'REVIEW_GATE'
  | 'PUBLISH'
  | 'DONE';

export type WorkflowActionPriority = 'critical' | 'high' | 'medium' | 'low';

export interface WorkflowNextActionV1 {
  readonly code: WorkflowNextActionCode;
  readonly priority: WorkflowActionPriority;
  /** The MCP tool name that performs this action. Empty when no tool applies (DONE). */
  readonly tool: string;
  /** Deterministic identifiers for the conditions that produced this action. */
  readonly reasonCodes: readonly string[];
}

// ── Injected projections (Host supplies these; no core internals required) ──

/**
 * Per-planned-event execution state. The Host builds one entry per event the
 * scene contracts plan for rendering, in canonical order. Raw accepted-scene
 * records are carried so core applies the sourceHash identity rule itself.
 */
export interface WorkflowEventExecutionV1 {
  readonly eventId: string;
  /** Accepted scene head from the execution repository; null when never rendered. */
  readonly acceptedScene: AcceptedSceneRecord | null;
  /**
   * Release-blocking diagnostics from the last render attempt (empty prose,
   * missing analysis, exhausted retries). Mirrors the render pipeline's
   * blocked semantics: an event with any of these is `blocked`.
   */
  readonly renderBlockedReasons: readonly string[];
}

export interface WorkflowExecutionProjectionV1 {
  /** All planned events, in canonical render order. */
  readonly events: readonly WorkflowEventExecutionV1[];
}

export interface WorkflowValidationProjectionV1 {
  readonly errors: readonly ValidationIssue[];
  readonly warnings: readonly ValidationIssue[];
}

export interface WorkflowWorkingProjectionV1 {
  /** Working documents differ from the accepted snapshot (changes pending). */
  readonly dirty: boolean;
  /** `validateWorking` has run on the current working digest. */
  readonly validated: boolean;
  /** The last working validation passed (candidate ready to submit). */
  readonly validationPassed: boolean;
  /** Authoring is blocked awaiting conflict recovery. */
  readonly conflict: boolean;
}

export interface WorkflowReviewProjectionV1 {
  readonly open: number;
  readonly blocking: number;
  readonly pendingGates: number;
}

export interface WorkflowPublicationProjectionV1 {
  readonly status: 'missing' | 'current' | 'stale';
  readonly publicationId: string | null;
  readonly novelHash: string | null;
}

export interface WorkflowStatusInputV1 {
  readonly projectId: string;
  /** Immutable accepted source snapshot; identity (sourceHash) is read here. */
  readonly snapshot: ProjectSourceSnapshotV1;
  readonly acceptedRevisionId: string | null;
  readonly validation: WorkflowValidationProjectionV1;
  readonly iss: ISSSnapshot;
  readonly execution: WorkflowExecutionProjectionV1;
  readonly working: WorkflowWorkingProjectionV1;
  readonly review: WorkflowReviewProjectionV1;
  readonly publication: WorkflowPublicationProjectionV1;
  /** ISO-8601 clock; defaults to `new Date().toISOString()`. */
  readonly now?: () => string;
}

// ── Output contract (exact wire shape) ──────────────────────────────────────

export interface WorkflowStatusV1 {
  readonly version: 1;
  readonly projectId: string;
  readonly layer: 'accepted';
  readonly sourceHash: string;
  readonly acceptedRevisionId: string | null;
  readonly iss: ISSSnapshot;
  readonly validation: {
    readonly passed: boolean;
    readonly errors: readonly ValidationIssue[];
    readonly warnings: readonly ValidationIssue[];
  };
  readonly render: {
    readonly ready: readonly string[];
    readonly blocked: readonly string[];
    readonly waiting: readonly string[];
    readonly completed: readonly string[];
  };
  readonly blockers: readonly Blocker[];
  readonly review: {
    readonly open: number;
    readonly blocking: number;
    readonly pendingGates: number;
  };
  readonly publication: {
    readonly status: 'missing' | 'current' | 'stale';
    readonly publicationId: string | null;
    readonly novelHash: string | null;
  };
  readonly nextActions: readonly WorkflowNextActionV1[];
  readonly guidance: string;
  readonly generatedAt: string;
}

// ── Deterministic action chain tables ───────────────────────────────────────

const PRIORITY_ORDER: readonly WorkflowActionPriority[] = ['critical', 'high', 'medium', 'low'];

const PRIORITY_BY_CODE: Readonly<Record<WorkflowNextActionCode, WorkflowActionPriority>> = {
  FIX_ACCEPTED_SOURCE: 'critical',
  RESOLVE_CONFLICT: 'critical',
  VALIDATE_WORKING: 'high',
  SUBMIT_WORKING: 'high',
  RENDER: 'medium',
  REVIEW_GATE: 'medium',
  PUBLISH: 'medium',
  DONE: 'low',
};

const TOOLS: Readonly<Record<WorkflowNextActionCode, string>> = {
  FIX_ACCEPTED_SOURCE: 'nova_authoring_document_edit',
  VALIDATE_WORKING: 'nova_authoring_validate',
  SUBMIT_WORKING: 'nova_authoring_submit',
  RESOLVE_CONFLICT: 'nova_conflict_resolve',
  RENDER: 'nova_render',
  REVIEW_GATE: 'nova_release_gate_decide',
  PUBLISH: 'nova_publish',
  DONE: '',
};

const GUIDANCE_BY_CODE: Readonly<Record<WorkflowNextActionCode, string>> = {
  FIX_ACCEPTED_SOURCE:
    'Fix the accepted source: validation errors must be resolved before scenes can release.',
  VALIDATE_WORKING: 'Validate the working layer before submitting it.',
  SUBMIT_WORKING: 'Submit the validated working layer to accept it as the new source.',
  RESOLVE_CONFLICT: 'Resolve the pending authoring conflict before continuing.',
  RENDER: 'Render the remaining scenes for the accepted source.',
  REVIEW_GATE: 'Resolve open reviews and pending release gates.',
  PUBLISH: 'Publish the completed novel.',
  DONE: 'All workflow steps are complete — nothing outstanding.',
};

function action(
  code: WorkflowNextActionCode,
  reasonCodes: readonly string[],
): WorkflowNextActionV1 {
  return { code, priority: PRIORITY_BY_CODE[code], tool: TOOLS[code], reasonCodes };
}

function sortActions(actions: readonly WorkflowNextActionV1[]): WorkflowNextActionV1[] {
  return [...actions].sort((left, right) => {
    const leftIndex = PRIORITY_ORDER.indexOf(left.priority);
    const rightIndex = PRIORITY_ORDER.indexOf(right.priority);
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
    return left.code < right.code ? -1 : left.code > right.code ? 1 : 0;
  });
}

function buildGuidance(actions: readonly WorkflowNextActionV1[]): string {
  return actions.map((next) => GUIDANCE_BY_CODE[next.code]).join(' ');
}

function groupIssuesByEvent(
  issues: readonly ValidationIssue[],
): ReadonlyMap<string, readonly ValidationIssue[]> {
  const grouped = new Map<string, ValidationIssue[]>();
  for (const issue of issues) {
    const list = grouped.get(issue.event);
    if (list) list.push(issue);
    else grouped.set(issue.event, [issue]);
  }
  return grouped;
}

// ── Public entry ────────────────────────────────────────────────────────────

/**
 * Build the unique accepted-layer workflow status for a project.
 *
 * Pure and deterministic: all state is injected, no file/network/provider
 * access, and `guidance` is derived from the same action list that is
 * returned. Render completeness is judged exclusively by accepted-scene
 * records whose `sourceHash` matches the accepted snapshot.
 */
export function buildWorkflowStatus(input: WorkflowStatusInputV1): WorkflowStatusV1 {
  const {
    projectId,
    snapshot,
    acceptedRevisionId,
    validation,
    iss,
    execution,
    working,
    review,
    publication,
    now,
  } = input;
  const sourceHash = snapshot.sourceHash;

  // ── Render buckets ────────────────────────────────────────────────────────

  const errorIssuesByEvent = groupIssuesByEvent(validation.errors);
  const completedSet = new Set<string>();
  const blockedSet = new Set<string>();
  const blockedByRenderFailure = new Set<string>();
  const blockers: Blocker[] = [];

  for (const event of execution.events) {
    const errorIssues = errorIssuesByEvent.get(event.eventId) ?? [];
    if (event.acceptedScene !== null && event.acceptedScene.sourceHash === sourceHash) {
      completedSet.add(event.eventId);
      continue;
    }
    if (errorIssues.length > 0 || event.renderBlockedReasons.length > 0) {
      blockedSet.add(event.eventId);
      for (const issue of errorIssues) {
        blockers.push({
          code: 'VALIDATION_ERROR',
          message: issue.message,
          eventId: event.eventId,
          severity: 'error',
        });
      }
      if (event.renderBlockedReasons.length > 0) {
        blockedByRenderFailure.add(event.eventId);
        blockers.push({
          code: 'RENDER_BLOCKED',
          message: event.renderBlockedReasons.join(' | '),
          eventId: event.eventId,
          severity: 'error',
        });
      }
    }
  }

  // Validation errors on events outside the render plan are still blockers.
  for (const issue of validation.errors) {
    if (!blockedSet.has(issue.event)) {
      blockers.push({
        code: 'VALIDATION_ERROR',
        message: issue.message,
        eventId: issue.event,
        severity: 'error',
      });
    }
  }

  const firstBlockedIndex = execution.events.findIndex((event) => blockedSet.has(event.eventId));
  const ready: string[] = [];
  const waiting: string[] = [];
  const completed: string[] = [];
  for (let index = 0; index < execution.events.length; index++) {
    const event = execution.events[index];
    if (completedSet.has(event.eventId)) {
      completed.push(event.eventId);
      continue;
    }
    if (blockedSet.has(event.eventId)) continue;
    if (firstBlockedIndex === -1 || index < firstBlockedIndex) ready.push(event.eventId);
    else waiting.push(event.eventId);
  }

  const allScenesRendered =
    execution.events.length === 0 || completedSet.size === execution.events.length;

  // ── Deterministic next-action chain ───────────────────────────────────────

  const actions: WorkflowNextActionV1[] = [];

  // Critical: accepted source validation errors.
  if (validation.errors.length > 0) {
    actions.push(action('FIX_ACCEPTED_SOURCE', ['VALIDATION_ERRORS']));
  }

  // Critical: conflict / recovery required.
  if (working.conflict) {
    actions.push(action('RESOLVE_CONFLICT', ['CONFLICT_PENDING']));
  }

  // High: working layer lifecycle.
  if (working.dirty) {
    if (working.validated && working.validationPassed) {
      actions.push(action('SUBMIT_WORKING', ['WORKING_VALIDATED']));
    } else if (working.validated) {
      actions.push(action('VALIDATE_WORKING', ['WORKING_VALIDATION_FAILED']));
    } else {
      actions.push(action('VALIDATE_WORKING', ['WORKING_DIRTY']));
    }
  }

  // Medium: scenes not yet released for the current sourceHash. Render fires
  // when there is immediately renderable work (ready) or a render attempt
  // failed retryably (empty prose / missing analysis). Scenes blocked purely
  // by validation errors are not renderable until the source is fixed.
  if (ready.length > 0 || blockedByRenderFailure.size > 0) {
    actions.push(action('RENDER', ['SCENES_NOT_RENDERED']));
  }

  // Medium: review / release gates once rendering is complete and unblocked.
  if (allScenesRendered) {
    const reviewReasonCodes: string[] = [];
    if (review.blocking > 0) reviewReasonCodes.push('BLOCKING_REVIEWS');
    if (review.open > 0) reviewReasonCodes.push('OPEN_REVIEWS');
    if (review.pendingGates > 0) reviewReasonCodes.push('PENDING_GATES');
    if (reviewReasonCodes.length > 0) {
      actions.push(action('REVIEW_GATE', reviewReasonCodes));
    } else if (publication.status !== 'current') {
      actions.push(
        action('PUBLISH', [
          publication.status === 'missing' ? 'PUBLICATION_MISSING' : 'PUBLICATION_STALE',
        ]),
      );
    } else if (validation.errors.length === 0 && !working.dirty && !working.conflict) {
      // DONE only when nothing else is outstanding: no source errors, no
      // working-layer changes, no conflict, all scenes rendered, review
      // clear and the publication current.
      actions.push(action('DONE', ['ALL_CLEAR']));
    }
  }

  const sorted = sortActions(actions);

  return {
    version: 1,
    projectId,
    layer: 'accepted',
    sourceHash,
    acceptedRevisionId,
    iss,
    validation: {
      passed: validation.errors.length === 0,
      errors: validation.errors,
      warnings: validation.warnings,
    },
    render: {
      ready,
      blocked: [...blockedSet],
      waiting,
      completed,
    },
    blockers,
    review: {
      open: review.open,
      blocking: review.blocking,
      pendingGates: review.pendingGates,
    },
    publication: {
      status: publication.status,
      publicationId: publication.publicationId,
      novelHash: publication.novelHash,
    },
    nextActions: sorted,
    guidance: buildGuidance(sorted),
    generatedAt: now ? now() : new Date().toISOString(),
  };
}
