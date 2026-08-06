// ============================================================================
// Workflow Status V1 — deterministic accepted-layer status projection
// ============================================================================

import { describe, expect, it } from 'vitest';
import type { AcceptedSceneRecord } from '../../src/ports/execution-repository.ts';
import {
  buildWorkflowStatus,
  type WorkflowEventExecutionV1,
  type WorkflowNextActionV1,
  type WorkflowStatusInputV1,
} from '../../src/status/index.ts';
import type { ISSSnapshot } from '../../src/types/iss.ts';
import type { ValidationIssue } from '../../src/types/validator.ts';
import { createSourceSnapshot } from '../fixtures/source-snapshot.ts';

// ── Helpers ─────────────────────────────────────────────────────────────────

const ISS: ISSSnapshot = { overall: 100, target: 80, dimensions: [] };

const SNAPSHOT = createSourceSnapshot({ 'nova.yaml': 'version: 1\n' });

function makeIssue(eventId: string, severity: 'error' | 'warning'): ValidationIssue {
  return {
    validator: 'test-validator',
    severity,
    kind: 'compiler_invariant',
    event: eventId,
    entity: 'alice',
    message: `${severity} on ${eventId}`,
    fixSuggestion: 'fix it',
    fixAction: 'edit_file',
    fixTarget: { file: 'chapters/chapter_01/E1.yaml' },
  };
}

function scene(eventId: string, sourceHash: string): AcceptedSceneRecord {
  return {
    version: 1,
    projectId: 'proj',
    eventId,
    sourceHash,
    revisionId: `rev-${eventId}`,
    prose: 'Rendered prose.',
    proseHash: `prose-${eventId}`,
    sceneHash: `scene-${eventId}`,
  };
}

function plannedEvent(
  eventId: string,
  options: { renderedWith?: string; blockedReasons?: readonly string[] } = {},
): WorkflowEventExecutionV1 {
  return {
    eventId,
    acceptedScene: options.renderedWith === undefined ? null : scene(eventId, options.renderedWith),
    renderBlockedReasons: options.blockedReasons ?? [],
  };
}

function makeInput(overrides: Partial<WorkflowStatusInputV1> = {}): WorkflowStatusInputV1 {
  return {
    projectId: 'proj',
    snapshot: SNAPSHOT,
    acceptedRevisionId: 'rev-accepted-1',
    validation: { errors: [], warnings: [] },
    iss: ISS,
    execution: {
      events: [
        plannedEvent('E1', { renderedWith: SNAPSHOT.sourceHash }),
        plannedEvent('E2', { renderedWith: SNAPSHOT.sourceHash }),
      ],
    },
    working: { dirty: false, validated: false, validationPassed: false, conflict: false },
    review: { open: 0, blocking: 0, pendingGates: 0 },
    publication: { status: 'current', publicationId: 'pub-1', novelHash: 'novel-hash' },
    now: () => '2026-08-06T00:00:00.000Z',
    ...overrides,
  };
}

function codes(actions: readonly WorkflowNextActionV1[]): string[] {
  return actions.map((action) => action.code);
}

function byCode(actions: readonly WorkflowNextActionV1[], code: string): WorkflowNextActionV1 {
  const found = actions.find((action) => action.code === code);
  if (!found) throw new Error(`missing action ${code}`);
  return found;
}

// ── All clear ───────────────────────────────────────────────────────────────

describe('buildWorkflowStatus — all clear', () => {
  it('produces DONE with low priority and no tool', () => {
    const status = buildWorkflowStatus(makeInput());
    expect(status.version).toBe(1);
    expect(status.layer).toBe('accepted');
    expect(status.sourceHash).toBe(SNAPSHOT.sourceHash);
    expect(status.acceptedRevisionId).toBe('rev-accepted-1');
    expect(status.validation.passed).toBe(true);
    expect(codes(status.nextActions)).toEqual(['DONE']);
    const done = status.nextActions[0];
    expect(done.priority).toBe('low');
    expect(done.tool).toBe('');
    expect(done.reasonCodes).toEqual(['ALL_CLEAR']);
    expect(status.guidance).toBe('All workflow steps are complete — nothing outstanding.');
    expect(status.generatedAt).toBe('2026-08-06T00:00:00.000Z');
    expect(status.blockers).toEqual([]);
    expect(status.review).toEqual({ open: 0, blocking: 0, pendingGates: 0 });
    expect(status.publication).toEqual({
      status: 'current',
      publicationId: 'pub-1',
      novelHash: 'novel-hash',
    });
  });

  it('reports validation, render, review and publication projections verbatim', () => {
    const status = buildWorkflowStatus(
      makeInput({
        validation: { errors: [], warnings: [makeIssue('E1', 'warning')] },
        review: { open: 2, blocking: 1, pendingGates: 3 },
      }),
    );
    expect(status.validation.warnings).toHaveLength(1);
    expect(status.review).toEqual({ open: 2, blocking: 1, pendingGates: 3 });
  });
});

// ── Validation errors → FIX_ACCEPTED_SOURCE ─────────────────────────────────

describe('buildWorkflowStatus — validation errors', () => {
  it('emits FIX_ACCEPTED_SOURCE critical with the performing tool', () => {
    const status = buildWorkflowStatus(
      makeInput({
        validation: { errors: [makeIssue('E1', 'error')], warnings: [] },
        // Scenes were rendered for an earlier source; the accepted snapshot now
        // carries a validation error, so the old renders are stale.
        execution: {
          events: [
            plannedEvent('E1', { renderedWith: 'old-source-hash' }),
            plannedEvent('E2', { renderedWith: 'old-source-hash' }),
          ],
        },
      }),
    );
    expect(status.validation.passed).toBe(false);
    const fix = byCode(status.nextActions, 'FIX_ACCEPTED_SOURCE');
    expect(fix.priority).toBe('critical');
    expect(fix.tool).toBe('nova_authoring_document_edit');
    expect(fix.reasonCodes).toEqual(['VALIDATION_ERRORS']);
    // The errored event is render-blocked and surfaced as a blocker; the other
    // stale scene waits behind it and nothing counts as completed.
    expect(status.render.blocked).toEqual(['E1']);
    expect(status.render.waiting).toEqual(['E2']);
    expect(status.render.completed).toEqual([]);
    expect(status.blockers).toEqual([
      {
        code: 'VALIDATION_ERROR',
        message: 'error on E1',
        eventId: 'E1',
        severity: 'error',
      },
    ]);
  });

  it('keeps events queued behind a blocked event in waiting', () => {
    const status = buildWorkflowStatus(
      makeInput({
        validation: { errors: [makeIssue('E2', 'error')], warnings: [] },
        execution: {
          events: [plannedEvent('E1'), plannedEvent('E2'), plannedEvent('E3'), plannedEvent('E4')],
        },
      }),
    );
    expect(status.render.ready).toEqual(['E1']);
    expect(status.render.blocked).toEqual(['E2']);
    expect(status.render.waiting).toEqual(['E3', 'E4']);
    expect(status.render.completed).toEqual([]);
  });

  it('marks every unrendered event ready when nothing is blocked', () => {
    const status = buildWorkflowStatus(
      makeInput({
        execution: { events: [plannedEvent('E1'), plannedEvent('E2')] },
      }),
    );
    expect(status.render.ready).toEqual(['E1', 'E2']);
    expect(status.render.blocked).toEqual([]);
    expect(status.render.waiting).toEqual([]);
    expect(status.render.completed).toEqual([]);
    expect(codes(status.nextActions)).toEqual(['RENDER']);
  });

  it('treats stale rendered scenes as not completed (re-render required)', () => {
    const status = buildWorkflowStatus(
      makeInput({
        snapshot: SNAPSHOT,
        execution: {
          events: [
            plannedEvent('E1', { renderedWith: 'old-source-hash' }),
            plannedEvent('E2', { renderedWith: 'old-source-hash' }),
          ],
        },
      }),
    );
    expect(status.render.completed).toEqual([]);
    expect(status.render.ready).toEqual(['E1', 'E2']);
    expect(codes(status.nextActions)).toEqual(['RENDER']);
  });
});

// ── Working layer lifecycle ─────────────────────────────────────────────────

describe('buildWorkflowStatus — working layer', () => {
  it('working dirty and unvalidated → VALIDATE_WORKING high', () => {
    const status = buildWorkflowStatus(
      makeInput({
        working: { dirty: true, validated: false, validationPassed: false, conflict: false },
      }),
    );
    const action = byCode(status.nextActions, 'VALIDATE_WORKING');
    expect(action.priority).toBe('high');
    expect(action.tool).toBe('nova_authoring_validate');
    expect(action.reasonCodes).toEqual(['WORKING_DIRTY']);
    // DONE must not fire while the working layer has outstanding changes.
    expect(codes(status.nextActions)).toEqual(['VALIDATE_WORKING']);
  });

  it('working dirty and failed validation → VALIDATE_WORKING with failure reason', () => {
    const status = buildWorkflowStatus(
      makeInput({
        working: { dirty: true, validated: true, validationPassed: false, conflict: false },
      }),
    );
    expect(byCode(status.nextActions, 'VALIDATE_WORKING').reasonCodes).toEqual([
      'WORKING_VALIDATION_FAILED',
    ]);
  });

  it('working dirty and validated → SUBMIT_WORKING high', () => {
    const status = buildWorkflowStatus(
      makeInput({
        working: { dirty: true, validated: true, validationPassed: true, conflict: false },
      }),
    );
    const submit = byCode(status.nextActions, 'SUBMIT_WORKING');
    expect(submit.priority).toBe('high');
    expect(submit.tool).toBe('nova_authoring_submit');
    expect(submit.reasonCodes).toEqual(['WORKING_VALIDATED']);
    expect(codes(status.nextActions)).toEqual(['SUBMIT_WORKING']);
  });

  it('conflict → RESOLVE_CONFLICT critical', () => {
    const status = buildWorkflowStatus(
      makeInput({
        working: { dirty: true, validated: true, validationPassed: true, conflict: true },
      }),
    );
    const resolve = byCode(status.nextActions, 'RESOLVE_CONFLICT');
    expect(resolve.priority).toBe('critical');
    expect(resolve.tool).toBe('nova_conflict_resolve');
    expect(resolve.reasonCodes).toEqual(['CONFLICT_PENDING']);
    // Conflict is critical so it sorts ahead of the working-layer actions.
    expect(status.nextActions[0].code).toBe('RESOLVE_CONFLICT');
  });
});

// ── Review gates and publication ────────────────────────────────────────────

describe('buildWorkflowStatus — review and publication', () => {
  it('open blocking review → REVIEW_GATE medium', () => {
    const status = buildWorkflowStatus(
      makeInput({ review: { open: 1, blocking: 1, pendingGates: 0 } }),
    );
    const gate = byCode(status.nextActions, 'REVIEW_GATE');
    expect(gate.priority).toBe('medium');
    expect(gate.tool).toBe('nova_release_gate_decide');
    expect(gate.reasonCodes).toEqual(['BLOCKING_REVIEWS', 'OPEN_REVIEWS']);
  });

  it('pending release gates → REVIEW_GATE', () => {
    const status = buildWorkflowStatus(
      makeInput({ review: { open: 0, blocking: 0, pendingGates: 2 } }),
    );
    expect(byCode(status.nextActions, 'REVIEW_GATE').reasonCodes).toEqual(['PENDING_GATES']);
  });

  it('publication stale after review clear → PUBLISH medium', () => {
    const status = buildWorkflowStatus(
      makeInput({ publication: { status: 'stale', publicationId: 'pub-1', novelHash: 'old' } }),
    );
    const publish = byCode(status.nextActions, 'PUBLISH');
    expect(publish.priority).toBe('medium');
    expect(publish.tool).toBe('nova_publish');
    expect(publish.reasonCodes).toEqual(['PUBLICATION_STALE']);
  });

  it('publication missing after review clear → PUBLISH with missing reason', () => {
    const status = buildWorkflowStatus(
      makeInput({
        publication: { status: 'missing', publicationId: null, novelHash: null },
      }),
    );
    expect(byCode(status.nextActions, 'PUBLISH').reasonCodes).toEqual(['PUBLICATION_MISSING']);
  });

  it('review outranks publication and DONE', () => {
    const status = buildWorkflowStatus(
      makeInput({
        review: { open: 1, blocking: 0, pendingGates: 0 },
        publication: { status: 'stale', publicationId: 'pub-1', novelHash: 'old' },
      }),
    );
    expect(codes(status.nextActions)).toEqual(['REVIEW_GATE']);
  });

  it('PUBLISH waits until every scene is rendered for the current source', () => {
    const status = buildWorkflowStatus(
      makeInput({
        execution: { events: [plannedEvent('E1')] },
        publication: { status: 'stale', publicationId: 'pub-1', novelHash: 'old' },
      }),
    );
    expect(codes(status.nextActions)).toEqual(['RENDER']);
  });

  it('DONE is suppressed while a validation error or dirty working layer stands', () => {
    const withError = buildWorkflowStatus(
      makeInput({
        validation: { errors: [makeIssue('E9', 'error')], warnings: [] },
        execution: { events: [] },
      }),
    );
    expect(codes(withError.nextActions)).toEqual(['FIX_ACCEPTED_SOURCE']);

    const dirty = buildWorkflowStatus(
      makeInput({
        working: { dirty: true, validated: true, validationPassed: true, conflict: false },
      }),
    );
    expect(codes(dirty.nextActions)).toEqual(['SUBMIT_WORKING']);
  });
});

// ── Render-attempt failures ─────────────────────────────────────────────────

describe('buildWorkflowStatus — render-attempt failures', () => {
  it('empty prose / missing analysis blocks the scene and retries RENDER', () => {
    const status = buildWorkflowStatus(
      makeInput({
        execution: {
          events: [plannedEvent('E1', { blockedReasons: ['missing analysis output'] })],
        },
      }),
    );
    expect(status.render.blocked).toEqual(['E1']);
    expect(status.render.completed).toEqual([]);
    expect(status.blockers).toEqual([
      {
        code: 'RENDER_BLOCKED',
        message: 'missing analysis output',
        eventId: 'E1',
        severity: 'error',
      },
    ]);
    expect(codes(status.nextActions)).toEqual(['RENDER']);
  });

  it('joins multiple render blockers into one RENDER_BLOCKED entry', () => {
    const status = buildWorkflowStatus(
      makeInput({
        execution: {
          events: [plannedEvent('E1', { blockedReasons: ['empty prose', 'exhausted retries'] })],
        },
      }),
    );
    expect(status.blockers).toEqual([
      {
        code: 'RENDER_BLOCKED',
        message: 'empty prose | exhausted retries',
        eventId: 'E1',
        severity: 'error',
      },
    ]);
  });
});

// ── Sorting, guidance, determinism ──────────────────────────────────────────

describe('buildWorkflowStatus — sorting, guidance and determinism', () => {
  it('sorts mixed actions critical → high → medium → low → code', () => {
    const status = buildWorkflowStatus(
      makeInput({
        validation: { errors: [makeIssue('E1', 'error')], warnings: [] },
        working: { dirty: true, validated: true, validationPassed: true, conflict: true },
        execution: {
          events: [plannedEvent('E0'), plannedEvent('E1', { renderedWith: 'old-source-hash' })],
        },
      }),
    );
    expect(codes(status.nextActions)).toEqual([
      'FIX_ACCEPTED_SOURCE',
      'RESOLVE_CONFLICT',
      'SUBMIT_WORKING',
      'RENDER',
    ]);
  });

  it('ties within a priority sort by code', () => {
    const status = buildWorkflowStatus(
      makeInput({
        validation: { errors: [makeIssue('E1', 'error')], warnings: [] },
        working: { dirty: false, validated: false, validationPassed: false, conflict: true },
        execution: {
          events: [plannedEvent('E1'), plannedEvent('E2', { renderedWith: SNAPSHOT.sourceHash })],
        },
      }),
    );
    expect(codes(status.nextActions)).toEqual(['FIX_ACCEPTED_SOURCE', 'RESOLVE_CONFLICT']);
  });

  it('guidance is derived deterministically from the same action list', () => {
    const status = buildWorkflowStatus(
      makeInput({
        validation: { errors: [makeIssue('E1', 'error')], warnings: [] },
        working: { dirty: true, validated: true, validationPassed: true, conflict: false },
        execution: {
          events: [plannedEvent('E1', { blockedReasons: ['empty prose'] }), plannedEvent('E2')],
        },
      }),
    );
    expect(codes(status.nextActions)).toEqual(['FIX_ACCEPTED_SOURCE', 'SUBMIT_WORKING', 'RENDER']);
    expect(status.guidance).toBe(
      'Fix the accepted source: validation errors must be resolved before scenes can release. ' +
        'Submit the validated working layer to accept it as the new source. ' +
        'Render the remaining scenes for the accepted source.',
    );
    // Same input yields byte-identical output.
    const again = buildWorkflowStatus(
      makeInput({
        validation: { errors: [makeIssue('E1', 'error')], warnings: [] },
        working: { dirty: true, validated: true, validationPassed: true, conflict: false },
        execution: {
          events: [plannedEvent('E1', { blockedReasons: ['empty prose'] }), plannedEvent('E2')],
        },
      }),
    );
    expect(again).toEqual(status);
  });

  it('respects an injected clock', () => {
    const status = buildWorkflowStatus(makeInput({ now: () => '2030-01-02T03:04:05.000Z' }));
    expect(status.generatedAt).toBe('2030-01-02T03:04:05.000Z');
  });
});
