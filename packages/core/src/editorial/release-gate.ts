// ============================================================================
// Release Gate Resolution — maintainer decisions on pending warning gates
// ----------------------------------------------------------------------------
// resolveReleaseGate loads the pending candidate envelope from the append-only
// scene revision archive, recomputes the deterministic gate identity, re-runs
// the SOLE release evaluator (evaluateReleaseDecision), and — only when the
// candidate is accepted — promotes the candidate through a single-head
// accepted-scene CAS in a detached commit slot.
//
// NEVER re-invokes the provider: the archived envelope carries the prose,
// analysis and validation that were already computed. Error / empty prose /
// missing analysis / exhausted retries are ALWAYS blocked — no waiver can
// bypass them.
//
// Outcomes:
//   accepted   — accepted-head CAS committed; candidateRevisionId is the head
//   rejected   — maintainer rejected (or the candidate is unwaivable-blocked);
//                candidate is retained in the archive, never promoted; a
//                blocking review is associated with the scene
//   stale      — a concurrent commit won the accepted head; candidate retained
//   superseded — the gate identity drifted (source hash changed, or the
//                archived gate id no longer matches the recomputed identity)
// ============================================================================

import { DEFAULT_RELEASE_POLICY } from '../config/defaults.ts';
import type { JsonValue } from '../contracts/json.ts';
import {
  computeReleaseGateId,
  evaluateReleaseDecision,
  InteractionManager,
} from '../pipeline/index.ts';
import { ReviewManager } from '../review/manager.ts';
import type { EditorialRuntime, SceneRevisionEnvelopeV1 } from '../types/editorial.ts';
import type { ReleaseDecision } from '../types/index.ts';
import { EditorialOperationError } from './errors.ts';

/** Maintainer decision input for a pending release gate. */
export interface ResolveReleaseGateInputV1 {
  readonly projectId: string;
  readonly sourceHash: string;
  readonly eventId: string;
  readonly candidateRevisionId: string;
  readonly decision: 'accept' | 'reject';
  readonly actorId: string;
  readonly capabilityVersion: number;
  readonly reason: string;
}

/**
 * Typed outcome of a release-gate resolution. `outcome` is one of
 * `accepted | rejected | stale | superseded`; `acceptedRevisionId` is set only
 * when the candidate was promoted. `decision` is the re-evaluated release
 * decision (the archived policy re-applied by `evaluateReleaseDecision`).
 */
export interface ReleaseGateResolutionV1 {
  readonly version: 1;
  readonly projectId: string;
  readonly gateId: string;
  readonly eventId: string;
  readonly candidateRevisionId: string;
  readonly outcome: 'accepted' | 'rejected' | 'stale' | 'superseded';
  readonly acceptedRevisionId: string | null;
  readonly decision: ReleaseDecision;
  readonly reason: string;
  readonly actorId: string;
  readonly capabilityVersion: number;
  readonly decidedAt: string;
}

function assertRuntime(runtime: EditorialRuntime): asserts runtime is EditorialRuntime & {
  services: NonNullable<EditorialRuntime['services']>;
} {
  if (!runtime.services) {
    throw new EditorialOperationError('INVALID_OPERATION', 'CoreExecutionRepository is required');
  }
}

function toResolution(
  input: ResolveReleaseGateInputV1,
  gateId: string,
  outcome: ReleaseGateResolutionV1['outcome'],
  acceptedRevisionId: string | null,
  decision: ReleaseDecision,
  decidedAt: string,
): ReleaseGateResolutionV1 {
  return {
    version: 1,
    projectId: input.projectId,
    gateId,
    eventId: input.eventId,
    candidateRevisionId: input.candidateRevisionId,
    outcome,
    acceptedRevisionId,
    decision,
    reason: input.reason,
    actorId: input.actorId,
    capabilityVersion: input.capabilityVersion,
    decidedAt,
  };
}

/** Record `gate_decided` only while the gate record is still open (best-effort projection). */
async function decideGateIfOpen(
  manager: ReviewManager,
  gateId: string,
  input: ResolveReleaseGateInputV1,
  decision: 'waived' | 'rejected' | 'accepted',
): Promise<void> {
  const gate = await manager.getGate(gateId);
  if (gate?.status !== 'open') return;
  await manager.decideGate(
    {
      gateId,
      decision,
      revisionId: input.candidateRevisionId,
      capabilityVersion: input.capabilityVersion,
      reason: input.reason,
    },
    input.actorId,
  );
}

/** Record `gate_superseded` only when a gate record exists and is not already superseded. */
async function supersedeGateIfRecorded(
  manager: ReviewManager,
  gateId: string,
  reason: string,
  actorId: string,
): Promise<void> {
  const gate = await manager.getGate(gateId);
  if (!gate || gate.status === 'superseded') return;
  await manager.supersedeGate(gateId, reason, actorId);
}

/** Associate a blocking review with the rejected scene (append-only event). */
async function createBlockingReview(
  manager: ReviewManager,
  input: ResolveReleaseGateInputV1,
  gateId: string,
): Promise<void> {
  await manager.addReviewComment(
    {
      target: { type: 'scene', id: input.eventId },
      severity: 'blocking',
      category: 'plot_logic',
      content: `Release gate ${gateId} rejected candidate revision ${input.candidateRevisionId}: ${input.reason}`,
    },
    input.actorId,
  );
}

/**
 * Resolve a pending release gate with a maintainer decision.
 *
 * @param input   - project/source/event identity, the archived candidate
 *                  revision to promote or retain, and the maintainer decision.
 * @param runtime - editorial runtime carrying the semantic execution services.
 *                  The provider is NEVER touched.
 */
export async function resolveReleaseGate(
  input: ResolveReleaseGateInputV1,
  runtime: EditorialRuntime,
): Promise<ReleaseGateResolutionV1> {
  assertRuntime(runtime);
  const execution = runtime.services.execution;
  const manager = new ReviewManager(execution, input.projectId);
  const decidedAt = runtime.services.clock.now();

  // 1. Load the pending candidate envelope from the append-only scene
  //    revision archive. The envelope IS the persisted candidate: prose,
  //    analysis, validation, archived release decision.
  const record = await execution.readSceneRevision({
    projectId: input.projectId,
    eventId: input.eventId,
    revisionId: input.candidateRevisionId,
  });
  if (!record) {
    throw new EditorialOperationError(
      'REVISION_NOT_FOUND',
      `Candidate revision ${input.candidateRevisionId} for event ${input.eventId} is not archived`,
    );
  }
  const envelope = record.value.value as unknown as SceneRevisionEnvelopeV1;

  // 2. Recompute the deterministic gate identity from the archived candidate.
  //
  // The gate identity is bound ONCE at gate-open time and recorded inside the
  // archived release decision (the open-time scopeHash/validationIdentity the
  // decision and the gate were computed with — the plan-wide render scope).
  // The envelope's top-level scopeHash/validationIdentity are the PER-SCENE
  // variants used by surface scheduling and assembly; for any scene after the
  // first in a batch they legitimately differ from the plan-wide identity
  // (a scene whose scope includes a predecessor's packet), so recomputing
  // from them would spuriously supersede the gate. Derive the identity from
  // the archived decision instead: it is a pure function of the persisted
  // candidate envelope and cannot drift when OTHER scenes are promoted.
  const gateScopeHash = envelope.releaseDecision.scopeHash || envelope.scopeHash;
  const gateValidationIdentity =
    envelope.releaseDecision.validationIdentity || envelope.validationIdentity;
  const recomputedGateId = computeReleaseGateId({
    projectId: input.projectId,
    sourceHash: record.value.sourceHash,
    eventId: input.eventId,
    proseHash: envelope.proseHash,
    scopeHash: gateScopeHash,
    validationIdentity: gateValidationIdentity,
    warnings: envelope.validation?.warnings ?? [],
  });
  const archivedGateId = envelope.releaseDecision.gateId;
  const gateId = archivedGateId ?? recomputedGateId;

  // 3. Identity drift → the old gate is superseded; waivers must never carry
  //    across a source/candidate/validator identity change.
  if (record.value.sourceHash !== input.sourceHash) {
    await supersedeGateIfRecorded(
      manager,
      gateId,
      `candidate source hash ${record.value.sourceHash} no longer matches current source ${input.sourceHash}`,
      input.actorId,
    );
    return toResolution(input, gateId, 'superseded', null, envelope.releaseDecision, decidedAt);
  }
  if (archivedGateId !== undefined && archivedGateId !== recomputedGateId) {
    await supersedeGateIfRecorded(
      manager,
      gateId,
      'release gate identity changed (source/candidate/validator identity drift)',
      input.actorId,
    );
    return toResolution(input, gateId, 'superseded', null, envelope.releaseDecision, decidedAt);
  }

  // 4. Idempotent guard: the candidate is already the accepted head.
  const currentHead = await execution.readAcceptedScene({
    projectId: input.projectId,
    eventId: input.eventId,
  });
  if (currentHead?.value.revisionId === input.candidateRevisionId) {
    return toResolution(
      input,
      gateId,
      'accepted',
      input.candidateRevisionId,
      envelope.releaseDecision,
      decidedAt,
    );
  }

  // 5. Re-run the SOLE release evaluator under the archived policy. Accept
  //    records the maintainer waiver (waive semantics under require-waiver;
  //    acceptance is automatic under accept-and-record); reject evaluates
  //    without a waiver so the blocked branches are never bypassed.
  const policy = envelope.releaseDecision.releasePolicy ?? DEFAULT_RELEASE_POLICY;
  const interactionManager = new InteractionManager();
  if (input.decision === 'accept') {
    interactionManager.recordWaiver(gateId, input.reason, input.actorId);
  }
  const redecided = evaluateReleaseDecision(
    {
      eventId: input.eventId,
      prose: envelope.prose,
      analysis: envelope.analysis,
      validation: envelope.validation,
      needsReview: envelope.needsReview,
      errors: envelope.errors,
    },
    gateScopeHash,
    gateValidationIdentity,
    interactionManager,
    {
      policy,
      gateIdentity: {
        projectId: input.projectId,
        sourceHash: record.value.sourceHash,
        proseHash: envelope.proseHash,
      },
    },
  );

  // 6. A maintainer rejection is final: the candidate is retained in the
  //    archive, never promoted, and a blocking review is associated.
  if (input.decision === 'reject') {
    await decideGateIfOpen(manager, gateId, input, 'rejected');
    await createBlockingReview(manager, input, gateId);
    return toResolution(input, gateId, 'rejected', null, redecided, decidedAt);
  }

  // 7. Accept path: error / empty prose / missing analysis / exhausted
  //    retries are ALWAYS blocked — no waiver can bypass them. A blocked
  //    candidate is never promoted and no review is fabricated.
  if (redecided.status !== 'accepted') {
    await decideGateIfOpen(manager, gateId, input, 'rejected');
    return toResolution(input, gateId, 'rejected', null, redecided, decidedAt);
  }

  // 8. Detached commit slot: single-head accepted-scene CAS. Any conflict
  //    means a concurrent commit won — the whole resolution is stale and the
  //    candidate stays archived as an auditable stale candidate.
  //    The review-stream record distinguishes a maintainer WAIVER (required
  //    under require-waiver) from an automatic ACCEPTANCE (accept-and-record).
  const gateRecordDecision = redecided.waiverId ? 'waived' : 'accepted';
  // The committed scene carries the RE-DECIDED accepted decision, not the
  // archived pending_waiver one: assembly `validateManifestHeads` requires
  // `releaseDecision.status === 'accepted'` (and the render invariant
  // `released === (status === 'accepted')`) on the accepted head, so a
  // waived candidate is publishable after the gate accepts it.
  const acceptedEnvelope: SceneRevisionEnvelopeV1 = {
    ...envelope,
    releaseDecision: redecided,
    released: redecided.status === 'accepted',
  };
  const cas = await execution.compareAndSwapAcceptedScene({
    projectId: input.projectId,
    eventId: input.eventId,
    expectedVersion: currentHead?.revision ?? null,
    value: {
      version: 1,
      projectId: input.projectId,
      eventId: input.eventId,
      sourceHash: record.value.sourceHash,
      revisionId: input.candidateRevisionId,
      prose: envelope.prose,
      proseHash: envelope.proseHash,
      sceneHash: envelope.sceneHash,
      value: acceptedEnvelope as unknown as JsonValue,
    },
  });
  if (cas.kind === 'conflict') {
    await decideGateIfOpen(manager, gateId, input, gateRecordDecision);
    return toResolution(input, gateId, 'stale', null, redecided, decidedAt);
  }

  await decideGateIfOpen(manager, gateId, input, gateRecordDecision);
  return toResolution(input, gateId, 'accepted', input.candidateRevisionId, redecided, decidedAt);
}
