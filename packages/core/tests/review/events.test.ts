// ============================================================================
// Review event stream — projection, store CAS semantics, legacy import
//
// Covers the pure projection (`projectReviewState`) across every event kind,
// the review event store CAS contract on MemoryExecutionRepository, and the
// one-time legacy ledger conversion helpers.
// ============================================================================

import { describe, expect, it } from 'vitest';
import type { JsonValue } from '../../src/contracts/json.ts';
import { EditorialOperationError } from '../../src/editorial/errors.ts';
import {
  legacyLedgerToReviewEvents,
  parseLegacyReviewLedger,
  projectReviewState,
  type ReviewEventKindV1,
  type ReviewEventRecordV1,
  type ReviewGateDecisionV1,
  type ReviewGateInputV1,
} from '../../src/review/index.ts';
import { ReviewManager } from '../../src/review/manager.ts';
import { MemoryExecutionRepository } from '../../src/testing/memory-repositories.ts';
import type { ReviewApplicationV1, ReviewComment, ReviewLedgerV1 } from '../../src/types/index.ts';

const PROJECT_ID = 'test-project';
const NOW = '2026-08-02T00:00:00.000Z';

/** JSON-normalize a structured value into the JsonValue payload shape. */
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

function comment(id: string, overrides?: Partial<ReviewComment>): ReviewComment {
  return {
    id,
    author: 'human',
    actorId: 'reviewer',
    target: { type: 'scene', id: 'E1' },
    severity: 'suggestion',
    category: 'style',
    content: 'Tighten',
    status: 'open',
    applications: [],
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function event(
  kind: ReviewEventKindV1,
  sequence: number,
  payload: JsonValue,
  extra?: Partial<ReviewEventRecordV1>,
): ReviewEventRecordV1 {
  return { version: 1, sequence, projectId: PROJECT_ID, kind, payload, createdAt: NOW, ...extra };
}

function application(eventId: string): ReviewApplicationV1 {
  return {
    eventId,
    revisionId: '11111111-1111-4111-8111-111111111111',
    operationId: '22222222-2222-4222-8222-222222222222',
    appliedAt: NOW,
  };
}

function gateInput(overrides?: Partial<ReviewGateInputV1>): ReviewGateInputV1 {
  return {
    gateId: 'gate-1',
    sourceHash: 'a'.repeat(64),
    eventId: 'E1',
    proseHash: 'b'.repeat(64),
    scopeHash: 'c'.repeat(64),
    validationIdentity: 'validators-v1',
    warningFingerprints: ['w1', 'w2'],
    revisionId: 'rev-1',
    ...overrides,
  };
}

function gateDecision(overrides?: Partial<ReviewGateDecisionV1>): ReviewGateDecisionV1 {
  return {
    gateId: 'gate-1',
    decision: 'waived',
    revisionId: 'rev-1',
    capabilityVersion: 3,
    reason: 'maintainer waived',
    actorId: 'maintainer',
    createdAt: NOW,
    ...overrides,
  };
}

// ─── Projection: comments ───────────────────────────────────────────────────

describe('projectReviewState', () => {
  it('projects comment_added events into open comments with applications', () => {
    const state = projectReviewState([
      event('comment_added', 1, json({ comment: comment('c1') })),
      event(
        'comment_added',
        2,
        json({
          comment: comment('c2', {
            applications: [application('E1')],
            createdAt: '2026-08-01T01:00:00.000Z',
          }),
        }),
      ),
    ]);

    expect(state.version).toBe(2);
    expect(state.comments).toHaveLength(2);
    const c2 = state.comments.find((c) => c.id === 'c2');
    expect(c2?.status).toBe('open');
    expect(c2?.applications).toHaveLength(1);
  });

  it('comment_replaced supersedes the original and adds the replacement', () => {
    const state = projectReviewState([
      event('comment_added', 1, json({ comment: comment('c1') })),
      event(
        'comment_replaced',
        2,
        json({
          replacedCommentId: 'c1',
          replacement: comment('c2', { supersedesId: 'c1', createdAt: NOW }),
          at: NOW,
          by: 'actor-b',
        }),
        { commentId: 'c1' },
      ),
    ]);

    const original = state.comments.find((c) => c.id === 'c1');
    expect(original?.status).toBe('superseded');
    expect(original?.resolvedAt).toBe(NOW);
    expect(original?.resolvedBy).toBe('actor-b');
    const replacement = state.comments.find((c) => c.id === 'c2');
    expect(replacement?.status).toBe('open');
    expect(replacement?.supersedesId).toBe('c1');
  });

  it('comment_status_changed transitions resolve/reopen/escalate', () => {
    const base = [
      event('comment_added', 1, json({ comment: comment('c1') })),
      event('comment_status_changed', 2, json({ to: 'resolved', at: NOW, by: 'reviewer-1' }), {
        commentId: 'c1',
      }),
    ];
    const resolved = projectReviewState(base).comments[0];
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolvedAt).toBe(NOW);
    expect(resolved.resolvedBy).toBe('reviewer-1');

    const reopened = projectReviewState([
      ...base,
      event('comment_status_changed', 3, json({ to: 'open' }), { commentId: 'c1' }),
    ]).comments[0];
    expect(reopened.status).toBe('open');
    expect(reopened.resolvedAt).toBeUndefined();
    expect(reopened.resolvedBy).toBeUndefined();

    const escalated = projectReviewState([
      ...base,
      event('comment_status_changed', 3, json({ to: 'open', severity: 'blocking' }), {
        commentId: 'c1',
      }),
    ]).comments[0];
    expect(escalated.severity).toBe('blocking');
    expect(escalated.status).toBe('open');
  });

  it('comment_applied appends an application and can mark addressed', () => {
    const state = projectReviewState([
      event('comment_added', 1, json({ comment: comment('c1') })),
      event('comment_applied', 2, json({ application: application('E1'), addressed: true }), {
        commentId: 'c1',
      }),
      event('comment_applied', 3, json({ application: application('E2'), addressed: false }), {
        commentId: 'c1',
      }),
    ]);

    const projected = state.comments[0];
    expect(projected.status).toBe('addressed');
    expect(projected.applications.map((a) => a.eventId)).toEqual(['E1', 'E2']);
  });

  it('ignores events referencing unknown comments', () => {
    const state = projectReviewState([
      event('comment_status_changed', 1, json({ to: 'resolved' }), { commentId: 'missing' }),
      event('comment_applied', 2, json({ application: application('E1') }), {
        commentId: 'missing',
      }),
    ]);
    expect(state.comments).toEqual([]);
  });

  it('returns the full event history in order', () => {
    const events = [
      event('comment_added', 1, json({ comment: comment('c1') })),
      event('comment_status_changed', 2, json({ to: 'wontfix' }), { commentId: 'c1' }),
    ];
    const state = projectReviewState(events);
    expect(state.events).toEqual(events);
    expect(state.comments[0].status).toBe('wontfix');
  });

  // ─── Projection: gates ───────────────────────────────────────────────────

  it('projects the gate lifecycle: opened → decided → superseded', () => {
    const state = projectReviewState([
      event('gate_opened', 1, json({ gate: gateInput() }), { gateId: 'gate-1', actorId: 'system' }),
      event('gate_decided', 2, json({ decision: gateDecision() }), {
        gateId: 'gate-1',
        actorId: 'maintainer',
      }),
    ]);

    expect(state.gates).toHaveLength(1);
    const gate = state.gates[0];
    expect(gate.status).toBe('decided');
    expect(gate.openedAt).toBe(NOW);
    expect(gate.openedBy).toBe('system');
    expect(gate.decision?.decision).toBe('waived');
    expect(gate.decision?.actorId).toBe('maintainer');
    expect(gate.warningFingerprints).toEqual(['w1', 'w2']);
  });

  it('gate_superseded marks the gate superseded and records the reason', () => {
    const state = projectReviewState([
      event('gate_opened', 1, json({ gate: gateInput() }), { gateId: 'gate-1', actorId: 'system' }),
      event('gate_superseded', 2, json({ reason: 'identity changed' }), {
        gateId: 'gate-1',
        actorId: 'system',
      }),
    ]);

    const gate = state.gates[0];
    expect(gate.status).toBe('superseded');
    expect(gate.supersedeReason).toBe('identity changed');
    expect(gate.supersededBy).toBe('system');
  });

  it('gate_decided on a superseded gate is ignored', () => {
    const state = projectReviewState([
      event('gate_opened', 1, json({ gate: gateInput() }), { gateId: 'gate-1', actorId: 'system' }),
      event('gate_superseded', 2, json({ reason: 'identity changed' }), {
        gateId: 'gate-1',
        actorId: 'system',
      }),
      event('gate_decided', 3, json({ decision: gateDecision() }), {
        gateId: 'gate-1',
        actorId: 'maintainer',
      }),
    ]);

    expect(state.gates[0].status).toBe('superseded');
    expect(state.gates[0].decision).toBeNull();
  });
});

// ─── Event store CAS ────────────────────────────────────────────────────────

describe('review event store CAS', () => {
  it('assigns contiguous sequences and reports the count as version', async () => {
    const store = new MemoryExecutionRepository();
    const added = await store.appendReviewEvents({
      projectId: PROJECT_ID,
      expectedVersion: 0,
      events: [
        { version: 1, projectId: PROJECT_ID, kind: 'comment_added', payload: {}, createdAt: NOW },
        { version: 1, projectId: PROJECT_ID, kind: 'comment_added', payload: {}, createdAt: NOW },
      ],
    });
    expect(added.kind).toBe('committed');
    if (added.kind !== 'committed') return;
    expect(added.version).toBe(2);
    expect(added.value.map((record) => record.sequence)).toEqual([1, 2]);

    const read = await store.readReviewEvents({ projectId: PROJECT_ID });
    expect(read.version).toBe(2);
    expect(read.events).toHaveLength(2);
  });

  it('rejects appends with a stale expected version', async () => {
    const store = new MemoryExecutionRepository();
    await store.appendReviewEvents({
      projectId: PROJECT_ID,
      expectedVersion: 0,
      events: [
        { version: 1, projectId: PROJECT_ID, kind: 'comment_added', payload: {}, createdAt: NOW },
      ],
    });
    const conflict = await store.appendReviewEvents({
      projectId: PROJECT_ID,
      expectedVersion: 0,
      events: [
        { version: 1, projectId: PROJECT_ID, kind: 'comment_added', payload: {}, createdAt: NOW },
      ],
    });
    expect(conflict).toEqual({ kind: 'conflict', expectedVersion: 0, actualVersion: 1 });
  });

  it('isolates streams per project and supports fromSequence reads', async () => {
    const store = new MemoryExecutionRepository();
    await store.appendReviewEvents({
      projectId: PROJECT_ID,
      expectedVersion: 0,
      events: [
        { version: 1, projectId: PROJECT_ID, kind: 'comment_added', payload: {}, createdAt: NOW },
        { version: 1, projectId: PROJECT_ID, kind: 'comment_added', payload: {}, createdAt: NOW },
        { version: 1, projectId: PROJECT_ID, kind: 'comment_added', payload: {}, createdAt: NOW },
      ],
    });
    const other = await store.readReviewEvents({ projectId: 'other' });
    expect(other.version).toBe(0);
    expect(other.events).toEqual([]);

    const tail = await store.readReviewEvents({ projectId: PROJECT_ID, fromSequence: 3 });
    expect(tail.events.map((record) => record.sequence)).toEqual([3]);
  });

  it('ReviewManager retries appends after a concurrent write and lands its event', async () => {
    const fixedIds = (...ids: string[]) => {
      let index = 0;
      return { next: () => ids[index++] ?? `rev_${index}` };
    };
    const execution = new MemoryExecutionRepository();
    const manager = new ReviewManager(execution, PROJECT_ID, {
      clock: { now: () => NOW },
      ids: fixedIds('rev_a', 'rev_c'),
    });
    const other = new ReviewManager(execution, PROJECT_ID, {
      clock: { now: () => NOW },
      ids: fixedIds('rev_b'),
    });
    // A concurrent writer commits between the first manager's reads and its
    // append; the append retries on the version conflict and still lands.
    await other.addReviewComment(
      { target: { type: 'scene', id: 'E2' }, severity: 'nit', category: 'style', content: 'b' },
      'b',
    );
    await manager.addReviewComment(
      { target: { type: 'scene', id: 'E1' }, severity: 'nit', category: 'style', content: 'a' },
      'a',
    );
    await manager.addReviewComment(
      { target: { type: 'scene', id: 'E3' }, severity: 'nit', category: 'style', content: 'c' },
      'c',
    );
    const comments = await manager.getComments();
    expect(comments.map((entry) => entry.target.id).sort()).toEqual(['E1', 'E2', 'E3']);
    const read = await execution.readReviewEvents({ projectId: PROJECT_ID });
    expect(read.version).toBe(3);
  });
});

// ─── ReviewManager gate methods ─────────────────────────────────────────────

describe('ReviewManager gate lifecycle', () => {
  it('open/decide/supersede append one event each and project current state', async () => {
    const execution = new MemoryExecutionRepository();
    const manager = new ReviewManager(execution, PROJECT_ID);

    const opened = await manager.openGate(gateInput(), 'system');
    expect(opened.status).toBe('open');

    const decided = await manager.decideGate(
      {
        gateId: 'gate-1',
        decision: 'accepted',
        revisionId: 'rev-1',
        capabilityVersion: 3,
        reason: 'ok',
      },
      'maintainer',
    );
    expect(decided.status).toBe('decided');
    expect(decided.decision?.actorId).toBe('maintainer');
    expect(await manager.getGate('gate-1')).toEqual(decided);

    await manager.supersedeGate('gate-1', 'identity changed', 'system');
    const gates = await manager.getGates();
    expect(gates[0].status).toBe('superseded');
    expect(gates[0].supersedeReason).toBe('identity changed');

    const history = await manager.getHistory();
    expect(history.map((record) => record.kind)).toEqual([
      'gate_opened',
      'gate_decided',
      'gate_superseded',
    ]);
  });

  it('decideGate rejects unknown or already-decided gates', async () => {
    const execution = new MemoryExecutionRepository();
    const manager = new ReviewManager(execution, PROJECT_ID);

    await expect(
      manager.decideGate(
        {
          gateId: 'missing',
          decision: 'waived',
          revisionId: 'r',
          capabilityVersion: 1,
          reason: 'x',
        },
        'maintainer',
      ),
    ).rejects.toThrow(EditorialOperationError);

    await manager.openGate(gateInput(), 'system');
    await manager.decideGate(
      {
        gateId: 'gate-1',
        decision: 'accepted',
        revisionId: 'rev-1',
        capabilityVersion: 3,
        reason: 'ok',
      },
      'maintainer',
    );
    await expect(
      manager.decideGate(
        {
          gateId: 'gate-1',
          decision: 'accepted',
          revisionId: 'rev-1',
          capabilityVersion: 3,
          reason: 'again',
        },
        'maintainer',
      ),
    ).rejects.toThrow(EditorialOperationError);
  });

  it('supersedeGate rejects unknown or already-superseded gates', async () => {
    const execution = new MemoryExecutionRepository();
    const manager = new ReviewManager(execution, PROJECT_ID);

    await expect(manager.supersedeGate('missing', 'why', 'system')).rejects.toThrow(
      EditorialOperationError,
    );
    await manager.openGate(gateInput(), 'system');
    await manager.supersedeGate('gate-1', 'first', 'system');
    await expect(manager.supersedeGate('gate-1', 'second', 'system')).rejects.toThrow(
      EditorialOperationError,
    );
  });
});

// ─── Legacy ledger conversion ───────────────────────────────────────────────

describe('legacy ledger conversion', () => {
  it('parseLegacyReviewLedger accepts a v1 ledger and a legacy unversioned shape', () => {
    const v1: ReviewLedgerV1 = { version: 1, comments: [comment('c1')], patches: [] };
    expect(parseLegacyReviewLedger(v1).comments).toHaveLength(1);

    const legacy = { comments: [{ ...comment('c2'), applications: undefined }], patches: [] };
    const normalized = parseLegacyReviewLedger(legacy);
    expect(normalized.comments[0].actorId).toBe('reviewer');
    expect(normalized.comments[0].applications).toEqual([]);
  });

  it('parseLegacyReviewLedger throws for non-ledger values', () => {
    expect(() => parseLegacyReviewLedger('just a string')).toThrow(
      'Invalid review ledger structure',
    );
    expect(() =>
      parseLegacyReviewLedger({ version: 1, comments: 'not-an-array', patches: [] }),
    ).toThrow('Invalid review ledger structure');
  });

  it('legacyLedgerToReviewEvents emits comment_added plus status_changed for non-open comments', () => {
    const ledger: ReviewLedgerV1 = {
      version: 1,
      comments: [
        comment('c1'),
        comment('c2', { status: 'resolved', resolvedAt: NOW, resolvedBy: 'reviewer-1' }),
        comment('c3', { status: 'addressed', applications: [application('E1')] }),
      ],
      patches: [],
    };
    const drafts = legacyLedgerToReviewEvents({
      projectId: PROJECT_ID,
      ledger,
      createdAt: NOW,
      actorId: 'legacy-import',
    });

    expect(drafts.map((draft) => draft.kind)).toEqual([
      'comment_added',
      'comment_added',
      'comment_status_changed',
      'comment_added',
      'comment_status_changed',
    ]);
    const addressed = drafts.filter((draft) => draft.commentId === 'c3');
    expect(addressed).toHaveLength(2);
    const statusEvent = addressed.find((draft) => draft.kind === 'comment_status_changed');
    expect(statusEvent?.payload).toEqual({
      to: 'addressed',
      at: '2026-08-01T00:00:00.000Z',
      by: 'reviewer',
    });

    // Replaying the drafts through the projection reproduces the legacy state.
    const state = projectReviewState(
      drafts.map((draft, index) => ({ ...draft, sequence: index + 1 }) as ReviewEventRecordV1),
    );
    expect(state.comments.find((c) => c.id === 'c2')?.status).toBe('resolved');
    expect(state.comments.find((c) => c.id === 'c3')?.status).toBe('addressed');
    expect(state.comments.find((c) => c.id === 'c3')?.applications).toHaveLength(1);
  });
});
