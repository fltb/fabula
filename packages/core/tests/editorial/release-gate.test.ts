// ============================================================================
// Release Gate Resolution — pending_waiver candidates, maintainer decisions
//
// Covers:
//   1. Full-pipeline: require-waiver policy renders warning candidates to
//      `pending_waiver` with `candidate_pending_waiver` disposition; the
//      candidate envelope is archived with the deterministic gate identity
//      and the gate is opened in the review stream. The accepted head is
//      NOT touched.
//   2. Full-pipeline: projects WITHOUT `releasePolicy` default to
//      accept-and-record — warning candidates are accepted and committed.
//   3. resolveReleaseGate accept/reject/stale/superseded with ZERO provider
//      calls (a throwing provider proves it); error candidates can never be
//      waived.
//   4. The pending candidate envelope is persisted in the append-only scene
//      revision archive and read back by resolveReleaseGate.
// ============================================================================

import * as crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type MockPass2Entry, MockPass2Provider } from '../../src/ai/providers/mock-pass2.ts';
import type { LLMProvider } from '../../src/ai/types.ts';
import {
  type AssemblySemanticInput,
  validateManifestHeads,
} from '../../src/assembler/release-assembly.ts';
import type { JsonValue } from '../../src/contracts/json.ts';
import type { ProjectSourceSnapshotV1, SourceDocumentV1 } from '../../src/contracts/source.ts';
import { resolveReleaseGate } from '../../src/editorial/release-gate.ts';
import { executeEditorialCandidates } from '../../src/editorial/render-service.ts';
import {
  computeReleaseGateId,
  computeWarningFingerprint,
} from '../../src/pipeline/release-decision.ts';
import { ReviewManager } from '../../src/review/manager.ts';
import {
  MemoryExecutionRepository,
  MemoryRenderCacheRepository,
  MemoryStateLogRepository,
  MemoryStateSnapshotRepository,
} from '../../src/testing/memory-repositories.ts';
import type {
  EditorialRenderRequestV1,
  EditorialRuntime,
  SceneRevisionEnvelopeV1,
} from '../../src/types/editorial.ts';
import type { ReleaseDecision, ValidationIssue } from '../../src/types/index.ts';
import { makeCustomEntry, makeObservations, makeProtocol } from '../fixtures/mock-pass2-helpers.ts';

const PROJECT_ID = 'gate-project';
const EVENT_ID = 'E1';
const FIXED_NOW = '2026-01-01T00:00:00.000Z';
const sha = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');

const PROSE = 'Test prose for event E1. The morning light filtered through the tall windows.';

const analysis: Record<string, unknown> = {
  postconditions: { covered: [], dropped: [] },
  preconditions: { violated: [] },
  pov: { consistent: true, leaks: [] },
  inventedDetails: [],
  quality: {
    proseScore: 4,
    maxScore: 5,
    strengths: ['clear'],
    weaknesses: [],
    estimatedWordCount: 80,
  },
  threadProgressAchieved: [],
  foreshadowingDeployed: [],
  narrativeChecks: [],
  appearanceChecks: [],
  characterReferences: [],
  tenseDetected: 'past',
  conflictAnalysis: { primaryType: 'none', resolutionAchieved: true },
  ruleChecks: [],
  knowledgeChecks: [],
  checklistResults: [],
};

/**
 * Entry whose conflictAnalysis measurement abstained → one
 * analysis_uncertainty warning. An abstained observation requires the
 * canonical payload to be absent from `analysis`, so `conflictAnalysis` is
 * dropped from the payload.
 */
function warningEntry(id: string): MockPass2Entry {
  const prose = PROSE;
  const { conflictAnalysis: _removed, ...payload } = analysis;
  const result = {
    eventId: id,
    protocol: makeProtocol(prose),
    observations: {
      ...makeObservations(payload, prose),
      conflictAnalysis: {
        disposition: 'abstained' as const,
        reason: 'prose does not reveal a clear conflict',
        evidence: [],
      },
    },
    analysis: payload,
  };
  return makeCustomEntry(id, prose, result);
}

function cleanEntry(id: string): MockPass2Entry {
  return makeCustomEntry(id, PROSE, {
    eventId: id,
    protocol: makeProtocol(PROSE),
    observations: makeObservations(analysis, PROSE),
    analysis,
  });
}

function source(releasePolicy?: string, eventIds: string[] = [EVENT_ID]): ProjectSourceSnapshotV1 {
  const events = eventIds.map(
    (id, i) =>
      `event: ${id}\nnarrativeOrder: ${i + 1}\ntitle: ${id} scene\nstoryTime: day_1\npov:\n  character: narrator\n  type: first_person\nsceneBrief: Test scene\nbeats:\n  - Test scene\npreconditions: []\nexpectedPostconditions: []\n`,
  );
  const docs: Record<string, string> = {
    'nova.yaml': `project: ${PROJECT_ID}\ntitle: Test Novel\nauthor: Test Author\ndefaultModel: mock-pass2\ndefaultLanguage: en${
      releasePolicy ? `\n${releasePolicy}` : ''
    }\n`,
    'definitions/state_initial.yaml':
      'info:\n  currentEra: contemporary\n  politicalSituation: stable\ntimeAnchors:\n  - { id: day_1, at: day_1, description: Day 1 }\nthreads: []\nworldFacts: []\nknowledge: { claims: [], commonGround: [] }\n',
    'definitions/thread-types.yaml':
      'types:\n  primary:\n    typeId: primary\n    description: Primary narrative thread type\n    allowedPhases: [opening, development, resolution]\n    lifecyclePolicy: { reopenPolicy: forbidden }\n    timeDomain: story\n    stableGoals: []\n    stableMilestones: []\n',
    'definitions/propositions.yaml': 'version: 1\npropositions: {}\ndependencyGraph: {}\n',
    'definitions/relationship-types.yaml': 'types: {}\n',
    'definitions/rule-types.yaml': 'types: {}\n',
    'definitions/entity-types.yaml':
      'types:\n  character:\n    typeId: character\n    kind: character\n    attributes:\n      lifecycle:\n        attributeId: lifecycle\n        valueType: string\n        requiredAt: introduction\n        writePolicy: lifecycle_managed\n        allowedLifecycleStates: [active, inactive, retired]\n        unsetAllowed: false\n        semanticRole: lifecycle\n      traits:\n        attributeId: traits\n        valueType: string_list\n        requiredAt: never\n        writePolicy: immutable\n        unsetAllowed: true\n    lifecyclePolicy:\n      allowedTransitions:\n        - [active, inactive]\n        - [active, retired]\n        - [inactive, active]\n        - [inactive, retired]\n    referenceCapabilities:\n      defaultEligibility: live\n    typedInvariants: []\n',
    'definitions/characters/narrator.yaml':
      'id: narrator\nname: Narrator\ntype: person\ndescription: narrator\ninitialState: {}\ntraits: []\n',
    'definitions/discourse-ledger.yaml': `id: test-ledger\nchapters:\n  - branch: main\n    chapter: 1\n    sceneIds: [${eventIds.join(', ')}]\nentries: []\n`,
    'chapters/chapter_01/_chapter.yaml': `chapter: 1\ntitle: Chapter 1\nsummary: Lifecycle\nintent: Test\nplannedScenes: ${eventIds.length}\n`,
  };
  eventIds.forEach((id, i) => {
    const event = events[i];
    if (event === undefined) {
      throw new Error(`Missing generated event document for ${id}`);
    }
    docs[`chapters/chapter_01/${id}.yaml`] = event;
  });
  const documents: SourceDocumentV1[] = Object.entries(docs)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([logicalPath, content]) => ({
      version: 1,
      logicalPath,
      content,
      contentHash: sha(content),
      parseResult: { status: 'parsed', value: { value: content } },
      diagnostics: [],
    }));
  return {
    version: 1,
    documents,
    sourceHash: sha(documents.map((d) => `${d.logicalPath}\0${d.content}`).join('')),
  };
}

function services(
  provider: LLMProvider,
  execution = new MemoryExecutionRepository(),
): EditorialRuntime['services'] {
  return {
    execution,
    renderCache: new MemoryRenderCacheRepository(),
    stateLog: new MemoryStateLogRepository(),
    stateSnapshots: new MemoryStateSnapshotRepository(),
    promptTemplates: { get: async () => null },
    clock: { now: () => FIXED_NOW },
    ids: { next: () => `rev-${Math.floor(Math.random() * 1_000_000)}` },
    llm: provider,
  };
}

function runtimeWith(
  execution: MemoryExecutionRepository,
  provider: LLMProvider = throwingProvider(),
): EditorialRuntime {
  return { provider, services: services(provider, execution) };
}

function throwingProvider(): LLMProvider {
  return {
    name: 'throwing',
    complete: async () => {
      throw new Error('provider must never be called during release-gate resolution');
    },
  };
}

// ——— Direct candidate envelope helpers (resolveReleaseGate unit fixtures) ———

function warningIssue(
  message = 'Pass 2 measurement for analysis field "conflictAnalysis" is abstained',
): ValidationIssue {
  return {
    validator: 'conflict',
    severity: 'warning',
    kind: 'analysis_uncertainty',
    event: EVENT_ID,
    entity: 'system',
    message,
    fixSuggestion: 'Review the measurement uncertainty or waive the finding.',
    fixAction: 'manual',
    fixTarget: { file: '' },
    observationRef: { field: 'conflictAnalysis' },
  };
}

function errorIssue(): ValidationIssue {
  return {
    validator: 'conflict',
    severity: 'error',
    kind: 'evidence_mismatch',
    event: EVENT_ID,
    entity: 'system',
    message:
      'Scene declares resolution type "resolved" but Pass 2 analysis indicates resolution was NOT achieved',
    fixSuggestion: 'Rewrite the scene.',
    fixAction: 'edit_file',
    fixTarget: { file: '' },
    observationRef: { field: 'conflictAnalysis' },
  };
}

const GATE_SCOPE = 'scope-a';
const GATE_VALIDATION_IDENTITY = 'validators-v1';
const GATE_SOURCE_HASH = sha('source-v1');

function gateIdFor(warnings: readonly ValidationIssue[]): string {
  return computeReleaseGateId({
    projectId: PROJECT_ID,
    sourceHash: GATE_SOURCE_HASH,
    eventId: EVENT_ID,
    proseHash: sha(PROSE),
    scopeHash: GATE_SCOPE,
    validationIdentity: GATE_VALIDATION_IDENTITY,
    warnings,
  });
}

function pendingDecision(warnings: readonly ValidationIssue[]): ReleaseDecision {
  return {
    status: 'pending_waiver',
    scopeHash: GATE_SCOPE,
    validationIdentity: GATE_VALIDATION_IDENTITY,
    reasons: warnings.map((w) => w.message),
    gateId: gateIdFor(warnings),
    releasePolicy: { warnings: 'require-waiver', openBlockingReviews: 'block' },
    warningFingerprints: warnings.map(computeWarningFingerprint).sort(),
  };
}

function makeEnvelope(overrides: Partial<SceneRevisionEnvelopeV1> = {}): SceneRevisionEnvelopeV1 {
  const warnings = [warningIssue()];
  const decision = pendingDecision(warnings);
  return {
    version: 1,
    revisionId: 'candidate-rev-1',
    parentRevisionId: null,
    operationId: 'op-gate-1',
    planHash: sha('plan'),
    actorId: 'renderer',
    eventId: EVENT_ID,
    origin: 'llm_draft',
    prose: PROSE,
    proseHash: sha(PROSE),
    sceneHash: sha(PROSE),
    editorialBasisHash: sha('basis'),
    scopeHash: GATE_SCOPE,
    validationIdentity: GATE_VALIDATION_IDENTITY,
    feedbackHash: null,
    reviewIds: [],
    analysis: {
      eventId: EVENT_ID,
      protocol: makeProtocol(PROSE),
      observations: makeObservations(analysis, PROSE),
      analysis,
    },
    validation: { passed: true, errors: [], warnings, infos: [] },
    releaseDecision: decision,
    released: false,
    cacheHit: false,
    errors: [],
    llmPass1: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    llmPass2: null,
    attempts: 1,
    needsReview: false,
    promptHash: sha('prompt'),
    providerCalls: [],
    promotionReadSet: [],
    requestRecords: [],
    createdAt: FIXED_NOW,
    ...overrides,
  };
}

async function archiveCandidate(
  execution: MemoryExecutionRepository,
  envelope: SceneRevisionEnvelopeV1,
  sourceHash = GATE_SOURCE_HASH,
): Promise<void> {
  const result = await execution.compareAndSwapSceneRevision({
    projectId: PROJECT_ID,
    eventId: envelope.eventId,
    revisionId: envelope.revisionId,
    expectedVersion: null,
    value: {
      version: 1,
      projectId: PROJECT_ID,
      eventId: envelope.eventId,
      revisionId: envelope.revisionId,
      parentRevisionId: envelope.parentRevisionId,
      sourceHash,
      value: envelope as unknown as JsonValue,
    },
  });
  if (result.kind !== 'committed') throw new Error('Failed to archive candidate envelope');
}

async function openGateRecord(
  execution: MemoryExecutionRepository,
  envelope: SceneRevisionEnvelopeV1,
): Promise<void> {
  const decision = envelope.releaseDecision;
  await new ReviewManager(execution, PROJECT_ID).openGate(
    {
      gateId: decision.gateId ?? '',
      sourceHash: GATE_SOURCE_HASH,
      eventId: envelope.eventId,
      proseHash: envelope.proseHash,
      scopeHash: envelope.scopeHash,
      validationIdentity: envelope.validationIdentity,
      warningFingerprints: decision.warningFingerprints ?? [],
      revisionId: envelope.revisionId,
    },
    'maintainer-bot',
  );
}

/** Inject a concurrent accepted head inside the resolution CAS (stale path). */
class ConcurrentHeadExecutionRepository extends MemoryExecutionRepository {
  private armed = false;
  private injected = false;

  arm(): void {
    this.armed = true;
  }

  override async compareAndSwapAcceptedScene(
    input: Parameters<MemoryExecutionRepository['compareAndSwapAcceptedScene']>[0],
  ) {
    if (this.armed && !this.injected) {
      this.injected = true;
      const current = await super.readAcceptedScene({
        projectId: input.projectId,
        eventId: input.eventId,
      });
      if (current) {
        await super.compareAndSwapAcceptedScene({
          projectId: input.projectId,
          eventId: input.eventId,
          expectedVersion: current.revision,
          value: {
            version: 1,
            projectId: input.projectId,
            eventId: input.eventId,
            sourceHash: 'concurrent-source',
            revisionId: 'concurrent-rev',
            prose: 'Concurrent head prose.',
            proseHash: sha('Concurrent head prose.'),
            sceneHash: sha('Concurrent head prose.'),
          },
        });
      }
    }
    return super.compareAndSwapAcceptedScene(input);
  }
}

// ============================================================================
// Full-pipeline release policy behavior
// ============================================================================

function renderRequest(operationId: string) {
  return {
    version: 1 as const,
    source: source(),
    mutation: { operationId, actorId: 'test' },
    model: 'mock-pass2' as const,
  };
}

function renderRequestStrict(operationId: string) {
  return {
    version: 1 as const,
    source: source('releasePolicy:\n  warnings: require-waiver'),
    mutation: { operationId, actorId: 'test' },
    model: 'mock-pass2' as const,
  };
}

/** Two-scene (E1 + E2) require-waiver batch render request. */
function renderBatchRequestStrict(operationId: string) {
  return {
    version: 1 as const,
    source: source('releasePolicy:\n  warnings: require-waiver', ['E1', 'E2']),
    mutation: { operationId, actorId: 'test' },
    model: 'mock-pass2' as const,
  };
}

/**
 * The first render in a process computes a different validation identity/plan
 * hash than all later renders (pre-existing validator/schema state mutation
 * observed by the split-suite); warm up once so the policy assertions below
 * run on the stable identity.
 */
async function warmup(
  entries: Record<string, MockPass2Entry>,
  request: EditorialRenderRequestV1,
): Promise<void> {
  const provider = new MockPass2Provider({ entries });
  const outcome = await executeEditorialCandidates(
    request,
    runtimeWith(new MemoryExecutionRepository(), provider),
  );
  if (outcome.kind !== 'candidates') throw new Error('Expected the warm-up candidate set');
}

describe('executeEditorialCandidates — release policy wiring', () => {
  it('require-waiver: pending_waiver decision, candidate_pending_waiver disposition, archived envelope + open gate', async () => {
    const entries = { E1: warningEntry(EVENT_ID) };
    await warmup(entries, renderRequestStrict('00000000-0000-4000-8000-000000000099'));
    const execution = new MemoryExecutionRepository();
    const provider = new MockPass2Provider({ entries });
    const runtime = runtimeWith(execution, provider);
    const outcome = await executeEditorialCandidates(
      {
        version: 1,
        source: source('releasePolicy:\n  warnings: require-waiver'),
        mutation: { operationId: '00000000-0000-4000-8000-000000000001', actorId: 'test' },
        model: 'mock-pass2',
      },
      runtime,
    );
    expect(outcome.kind).toBe('candidates');
    if (outcome.kind !== 'candidates') return;

    const { candidateSet } = outcome;
    const decision = candidateSet.decisions.get(EVENT_ID);
    expect(decision?.status).toBe('pending_waiver');
    expect(decision?.gateId).toMatch(/^[a-f0-9]{64}$/);
    expect(decision?.releasePolicy?.warnings).toBe('require-waiver');
    expect(decision?.warningFingerprints?.length).toBeGreaterThan(0);
    expect(candidateSet.sceneDispositions.get(EVENT_ID)).toBe('candidate_pending_waiver');
    // The accepted head is NOT touched during candidate execution.
    expect(
      await execution.readAcceptedScene({ projectId: PROJECT_ID, eventId: EVENT_ID }),
    ).toBeNull();

    // The pending candidate envelope is persisted in the revision archive
    // with the deterministic gate identity.
    const manager = new ReviewManager(execution, PROJECT_ID);
    const gates = await manager.getGates();
    expect(gates).toHaveLength(1);
    const gate = gates[0];
    expect(gate?.status).toBe('open');
    expect(gate?.revisionId).toBeTruthy();
    const archived = await execution.readSceneRevision({
      projectId: PROJECT_ID,
      eventId: EVENT_ID,
      revisionId: gate?.revisionId ?? '',
    });
    expect(archived).not.toBeNull();
    const envelope = archived?.value.value as unknown as SceneRevisionEnvelopeV1;
    expect(envelope.releaseDecision.status).toBe('pending_waiver');
    expect(envelope.releaseDecision.gateId).toBe(gate?.gateId);
    expect(envelope.releaseDecision.releasePolicy?.warnings).toBe('require-waiver');
    expect(envelope.released).toBe(false);
  });

  it('no releasePolicy in nova.yaml → accept-and-record default: warnings accepted and committed', async () => {
    const entries = { E1: warningEntry(EVENT_ID) };
    await warmup(entries, renderRequest('00000000-0000-4000-8000-000000000098'));
    const execution = new MemoryExecutionRepository();
    const provider = new MockPass2Provider({ entries });
    const runtime = runtimeWith(execution, provider);
    const outcome = await executeEditorialCandidates(
      renderRequest('00000000-0000-4000-8000-000000000002'),
      runtime,
    );
    expect(outcome.kind).toBe('candidates');
    if (outcome.kind !== 'candidates') return;

    const { candidateSet } = outcome;
    const decision = candidateSet.decisions.get(EVENT_ID);
    expect(decision?.status).toBe('accepted');
    expect(decision?.releasePolicy?.warnings).toBe('accept-and-record');
    expect(decision?.reasons.length).toBeGreaterThan(0);
    expect(candidateSet.sceneDispositions.get(EVENT_ID)).toBe('candidate_promoted');
    // No gate is opened under accept-and-record: the decision + envelope
    // record the warnings.
    const gates = await new ReviewManager(execution, PROJECT_ID).getGates();
    expect(gates).toHaveLength(0);
  });
});

// ============================================================================
// resolveReleaseGate — maintainer decisions, zero provider calls
// ============================================================================

describe('resolveReleaseGate', () => {
  it('accept promotes the archived candidate with ZERO provider calls', async () => {
    const execution = new MemoryExecutionRepository();
    const envelope = makeEnvelope();
    await archiveCandidate(execution, envelope);
    await openGateRecord(execution, envelope);

    const resolution = await resolveReleaseGate(
      {
        projectId: PROJECT_ID,
        sourceHash: GATE_SOURCE_HASH,
        eventId: EVENT_ID,
        candidateRevisionId: envelope.revisionId,
        decision: 'accept',
        actorId: 'maintainer-1',
        capabilityVersion: 7,
        reason: 'uncertainty is acceptable; prose reads well',
      },
      runtimeWith(execution),
    );

    expect(resolution.outcome).toBe('accepted');
    expect(resolution.acceptedRevisionId).toBe(envelope.revisionId);
    expect(resolution.gateId).toBe(envelope.releaseDecision.gateId);
    expect(resolution.decision.status).toBe('accepted');

    const head = await execution.readAcceptedScene({ projectId: PROJECT_ID, eventId: EVENT_ID });
    expect(head?.value.revisionId).toBe(envelope.revisionId);
    expect(head?.value.sourceHash).toBe(GATE_SOURCE_HASH);
    expect(head?.value.proseHash).toBe(envelope.proseHash);

    // The committed scene carries the RE-DECIDED accepted decision (not the
    // archived pending_waiver one), so assembly manifest-head validation
    // passes and publication is not REVISION_BLOCKED.
    const headEnvelope = head?.value.value as unknown as SceneRevisionEnvelopeV1;
    expect(headEnvelope.releaseDecision.status).toBe('accepted');
    expect(headEnvelope.releaseDecision.gateId).toBe(envelope.releaseDecision.gateId);
    expect(headEnvelope.releaseDecision.waiverId).toBe(envelope.releaseDecision.gateId);
    expect(headEnvelope.releaseDecision.releasePolicy?.warnings).toBe('require-waiver');
    expect(headEnvelope.released).toBe(true);

    const semantic: AssemblySemanticInput = {
      projectId: PROJECT_ID,
      sourceHash: GATE_SOURCE_HASH,
      manifest: {
        version: 1,
        status: 'current',
        branch_scope_hash: 'branch-scope',
        novel_hash: null,
        revision_ids: { [EVENT_ID]: envelope.revisionId },
        last_assembled_at: null,
        reasons: [],
      },
      revisions: new Map([[EVENT_ID, headEnvelope]]),
      scenes: new Map([
        [
          EVENT_ID,
          {
            prose: PROSE,
            chapterNumber: 1,
            metadata: { prose_source: 'llm', rendered_at: headEnvelope.createdAt },
          },
        ],
      ]),
      discourseSequence: [{ sceneId: EVENT_ID, sequence: 0, chapter: 1 }],
    };
    const manifest = await validateManifestHeads(semantic.manifest, execution, semantic);
    expect(manifest.errors).toEqual([]);
    expect(manifest.scenes.get(EVENT_ID)?.eventId).toBe(EVENT_ID);

    // The review-stream gate is decided (waived: require-waiver acceptance).
    const gates = await new ReviewManager(execution, PROJECT_ID).getGates();
    expect(gates).toHaveLength(1);
    expect(gates[0]?.status).toBe('decided');
    expect(gates[0]?.decision?.decision).toBe('waived');
    expect(gates[0]?.decision?.actorId).toBe('maintainer-1');
    expect(gates[0]?.decision?.capabilityVersion).toBe(7);

    // The candidate envelope is retained in the archive.
    const archived = await execution.readSceneRevision({
      projectId: PROJECT_ID,
      eventId: EVENT_ID,
      revisionId: envelope.revisionId,
    });
    expect(archived).not.toBeNull();
  });

  it('reject retains the candidate, associates a blocking review, never promotes', async () => {
    const execution = new MemoryExecutionRepository();
    const envelope = makeEnvelope();
    await archiveCandidate(execution, envelope);
    await openGateRecord(execution, envelope);

    const resolution = await resolveReleaseGate(
      {
        projectId: PROJECT_ID,
        sourceHash: GATE_SOURCE_HASH,
        eventId: EVENT_ID,
        candidateRevisionId: envelope.revisionId,
        decision: 'reject',
        actorId: 'maintainer-2',
        capabilityVersion: 7,
        reason: 'the uncertainty is material to the conflict arc',
      },
      runtimeWith(execution),
    );

    expect(resolution.outcome).toBe('rejected');
    expect(resolution.acceptedRevisionId).toBeNull();
    expect(
      await execution.readAcceptedScene({ projectId: PROJECT_ID, eventId: EVENT_ID }),
    ).toBeNull();

    // Blocking review associated with the scene.
    const comments = await new ReviewManager(execution, PROJECT_ID).getComments();
    const blocking = comments.filter((c) => c.severity === 'blocking' && c.target.id === EVENT_ID);
    expect(blocking).toHaveLength(1);
    expect(blocking[0]?.content).toContain(envelope.revisionId);
    expect(blocking[0]?.content).toContain('the uncertainty is material');

    // Gate decided as rejected.
    const gates = await new ReviewManager(execution, PROJECT_ID).getGates();
    expect(gates[0]?.status).toBe('decided');
    expect(gates[0]?.decision?.decision).toBe('rejected');

    // Candidate envelope retained.
    const archived = await execution.readSceneRevision({
      projectId: PROJECT_ID,
      eventId: EVENT_ID,
      revisionId: envelope.revisionId,
    });
    expect(archived).not.toBeNull();
    // Reject never rewrites the candidate: the archived envelope still
    // carries the pending_waiver decision (unchanged, never CASed).
    const archivedEnvelope = archived?.value.value as unknown as SceneRevisionEnvelopeV1;
    expect(archivedEnvelope.releaseDecision.status).toBe('pending_waiver');
    expect(archivedEnvelope.released).toBe(false);
  });

  it('stale when a concurrent commit wins the accepted head during the CAS', async () => {
    const execution = new ConcurrentHeadExecutionRepository();
    const envelope = makeEnvelope();
    await archiveCandidate(execution, envelope);
    // A different head already exists (another commit won before resolution).
    await execution.compareAndSwapAcceptedScene({
      projectId: PROJECT_ID,
      eventId: EVENT_ID,
      expectedVersion: null,
      value: {
        version: 1,
        projectId: PROJECT_ID,
        eventId: EVENT_ID,
        sourceHash: 'other-source',
        revisionId: 'other-rev',
        prose: 'Other head prose.',
        proseHash: sha('Other head prose.'),
        sceneHash: sha('Other head prose.'),
      },
    });
    // A second commit lands DURING the resolution CAS → conflict → stale.
    execution.arm();

    const resolution = await resolveReleaseGate(
      {
        projectId: PROJECT_ID,
        sourceHash: GATE_SOURCE_HASH,
        eventId: EVENT_ID,
        candidateRevisionId: envelope.revisionId,
        decision: 'accept',
        actorId: 'maintainer-3',
        capabilityVersion: 7,
        reason: 'accept despite uncertainty',
      },
      runtimeWith(execution),
    );

    expect(resolution.outcome).toBe('stale');
    expect(resolution.acceptedRevisionId).toBeNull();
    const head = await execution.readAcceptedScene({ projectId: PROJECT_ID, eventId: EVENT_ID });
    expect(head?.value.revisionId).toBe('concurrent-rev');
    // The candidate is retained as an auditable stale candidate.
    const archived = await execution.readSceneRevision({
      projectId: PROJECT_ID,
      eventId: EVENT_ID,
      revisionId: envelope.revisionId,
    });
    expect(archived).not.toBeNull();
  });

  it('superseded when the source hash changed since the candidate was archived', async () => {
    const execution = new MemoryExecutionRepository();
    const envelope = makeEnvelope();
    await archiveCandidate(execution, envelope);
    await openGateRecord(execution, envelope);

    const resolution = await resolveReleaseGate(
      {
        projectId: PROJECT_ID,
        sourceHash: sha('source-v2'),
        eventId: EVENT_ID,
        candidateRevisionId: envelope.revisionId,
        decision: 'accept',
        actorId: 'maintainer-4',
        capabilityVersion: 7,
        reason: 'accept despite uncertainty',
      },
      runtimeWith(execution),
    );

    expect(resolution.outcome).toBe('superseded');
    expect(resolution.acceptedRevisionId).toBeNull();
    expect(
      await execution.readAcceptedScene({ projectId: PROJECT_ID, eventId: EVENT_ID }),
    ).toBeNull();
    // The old gate is superseded in the review stream.
    const gates = await new ReviewManager(execution, PROJECT_ID).getGates();
    expect(gates[0]?.status).toBe('superseded');
    expect(gates[0]?.supersedeReason).toContain('source');
  });

  it('error candidates can never be waived: accept on a blocked candidate → rejected, no CAS', async () => {
    const execution = new MemoryExecutionRepository();
    const blocked = makeEnvelope({
      revisionId: 'candidate-blocked-1',
      validation: {
        passed: false,
        errors: [errorIssue()],
        warnings: [],
        infos: [],
      },
      releaseDecision: {
        status: 'blocked',
        scopeHash: GATE_SCOPE,
        validationIdentity: GATE_VALIDATION_IDENTITY,
        reasons: [errorIssue().message],
      },
    });
    await archiveCandidate(execution, blocked);

    const resolution = await resolveReleaseGate(
      {
        projectId: PROJECT_ID,
        sourceHash: GATE_SOURCE_HASH,
        eventId: EVENT_ID,
        candidateRevisionId: blocked.revisionId,
        decision: 'accept',
        actorId: 'maintainer-5',
        capabilityVersion: 7,
        reason: 'waive the error',
      },
      runtimeWith(execution),
    );

    expect(resolution.outcome).toBe('rejected');
    expect(resolution.decision.status).toBe('blocked');
    expect(resolution.acceptedRevisionId).toBeNull();
    expect(
      await execution.readAcceptedScene({ projectId: PROJECT_ID, eventId: EVENT_ID }),
    ).toBeNull();
  });

  it('missing candidate revision fails fast with REVISION_NOT_FOUND', async () => {
    const execution = new MemoryExecutionRepository();
    await expect(
      resolveReleaseGate(
        {
          projectId: PROJECT_ID,
          sourceHash: GATE_SOURCE_HASH,
          eventId: EVENT_ID,
          candidateRevisionId: 'never-archived',
          decision: 'accept',
          actorId: 'maintainer',
          capabilityVersion: 7,
          reason: 'n/a',
        },
        runtimeWith(execution),
      ),
    ).rejects.toThrow('not archived');
  });

  it('batch: resolving one gate does NOT supersede the other — each scene gate is independent', async () => {
    const entries = { E1: warningEntry('E1'), E2: warningEntry('E2') };
    await warmup(entries, renderBatchRequestStrict('00000000-0000-4000-8000-000000000097'));
    const execution = new MemoryExecutionRepository();
    const provider = new MockPass2Provider({ entries });
    const runtime = runtimeWith(execution, provider);
    const outcome = await executeEditorialCandidates(
      renderBatchRequestStrict('00000000-0000-4000-8000-000000000011'),
      runtime,
    );
    expect(outcome.kind).toBe('candidates');
    if (outcome.kind !== 'candidates') return;

    const { candidateSet } = outcome;
    expect(candidateSet.decisions.get('E1')?.status).toBe('pending_waiver');
    expect(candidateSet.decisions.get('E2')?.status).toBe('pending_waiver');

    const manager = new ReviewManager(execution, PROJECT_ID);
    const gates = await manager.getGates();
    expect(gates).toHaveLength(2);
    const gateE1 = gates.find((g) => g.eventId === 'E1');
    const gateE2 = gates.find((g) => g.eventId === 'E2');
    expect(gateE1?.revisionId).toBeTruthy();
    expect(gateE2?.revisionId).toBeTruthy();
    // Distinct scenes get distinct gate identities (eventId is part of the id).
    expect(gateE1?.gateId).not.toBe(gateE2?.gateId);

    // The gate identity archived in each envelope MUST be reproducible from
    // the envelope itself — resolveReleaseGate recomputes it (from the
    // open-time identity recorded in the archived decision) and compares.
    for (const gate of [gateE1, gateE2]) {
      const archived = await execution.readSceneRevision({
        projectId: PROJECT_ID,
        eventId: gate?.eventId ?? '',
        revisionId: gate?.revisionId ?? '',
      });
      expect(archived).not.toBeNull();
      const envelope = archived?.value.value as unknown as SceneRevisionEnvelopeV1;
      const recomputed = computeReleaseGateId({
        projectId: PROJECT_ID,
        sourceHash: archived?.value.sourceHash ?? '',
        eventId: gate?.eventId ?? '',
        proseHash: envelope.proseHash,
        // The archived gateId was bound with the DECISION's scopeHash /
        // validationIdentity (plan-wide), which can legitimately differ from
        // the envelope's per-scene top-level fields for later batch scenes.
        scopeHash: envelope.releaseDecision.scopeHash,
        validationIdentity: envelope.releaseDecision.validationIdentity,
        warnings: envelope.validation?.warnings ?? [],
      });
      expect(recomputed).toBe(envelope.releaseDecision.gateId);
    }

    // Resolve gate E1 FIRST: its promotion must not affect E2's identity.
    const resolutionE1 = await resolveReleaseGate(
      {
        projectId: PROJECT_ID,
        sourceHash: candidateSet.sourceHash,
        eventId: 'E1',
        candidateRevisionId: gateE1?.revisionId ?? '',
        decision: 'accept',
        actorId: 'maintainer-a',
        capabilityVersion: 7,
        reason: 'uncertainty acceptable',
      },
      runtimeWith(execution),
    );
    expect(resolutionE1.outcome).toBe('accepted');
    expect(resolutionE1.acceptedRevisionId).toBe(gateE1?.revisionId);

    // Gate E2 is still resolvable with its own identity — NOT superseded.
    const resolutionE2 = await resolveReleaseGate(
      {
        projectId: PROJECT_ID,
        sourceHash: candidateSet.sourceHash,
        eventId: 'E2',
        candidateRevisionId: gateE2?.revisionId ?? '',
        decision: 'accept',
        actorId: 'maintainer-b',
        capabilityVersion: 7,
        reason: 'uncertainty acceptable',
      },
      runtimeWith(execution),
    );
    expect(resolutionE2.outcome).toBe('accepted');
    expect(resolutionE2.acceptedRevisionId).toBe(gateE2?.revisionId);

    // Each scene has its OWN promoted accepted head.
    const headE1 = await execution.readAcceptedScene({ projectId: PROJECT_ID, eventId: 'E1' });
    const headE2 = await execution.readAcceptedScene({ projectId: PROJECT_ID, eventId: 'E2' });
    expect(headE1?.value.revisionId).toBe(gateE1?.revisionId);
    expect(headE2?.value.revisionId).toBe(gateE2?.revisionId);
    expect(headE1?.value.sourceHash).toBe(candidateSet.sourceHash);
    expect(headE2?.value.sourceHash).toBe(candidateSet.sourceHash);
  });

  it('batch: a GENUINE source change still supersedes the second gate after the first was accepted', async () => {
    const entries = { E1: warningEntry('E1'), E2: warningEntry('E2') };
    await warmup(entries, renderBatchRequestStrict('00000000-0000-4000-8000-000000000096'));
    const execution = new MemoryExecutionRepository();
    const provider = new MockPass2Provider({ entries });
    const runtime = runtimeWith(execution, provider);
    const outcome = await executeEditorialCandidates(
      renderBatchRequestStrict('00000000-0000-4000-8000-000000000013'),
      runtime,
    );
    expect(outcome.kind).toBe('candidates');
    if (outcome.kind !== 'candidates') return;
    const { candidateSet } = outcome;

    const gates = await new ReviewManager(execution, PROJECT_ID).getGates();
    const gateE1 = gates.find((g) => g.eventId === 'E1');
    const gateE2 = gates.find((g) => g.eventId === 'E2');

    const resolutionE1 = await resolveReleaseGate(
      {
        projectId: PROJECT_ID,
        sourceHash: candidateSet.sourceHash,
        eventId: 'E1',
        candidateRevisionId: gateE1?.revisionId ?? '',
        decision: 'accept',
        actorId: 'maintainer-a',
        capabilityVersion: 7,
        reason: 'uncertainty acceptable',
      },
      runtimeWith(execution),
    );
    expect(resolutionE1.outcome).toBe('accepted');

    // The source was re-rendered (new sourceHash) before E2's gate decision:
    // the archived candidate is stale w.r.t. the source → genuine supersede.
    const resolutionE2 = await resolveReleaseGate(
      {
        projectId: PROJECT_ID,
        sourceHash: sha('source-v2'),
        eventId: 'E2',
        candidateRevisionId: gateE2?.revisionId ?? '',
        decision: 'accept',
        actorId: 'maintainer-b',
        capabilityVersion: 7,
        reason: 'uncertainty acceptable',
      },
      runtimeWith(execution),
    );
    expect(resolutionE2.outcome).toBe('superseded');
    expect(resolutionE2.acceptedRevisionId).toBeNull();
    const e2Gates = await new ReviewManager(execution, PROJECT_ID).getGates();
    expect(e2Gates.find((g) => g.eventId === 'E2')?.status).toBe('superseded');
    expect(await execution.readAcceptedScene({ projectId: PROJECT_ID, eventId: 'E2' })).toBeNull();
  });

  it('candidate identity drift (warning set changed since gate open) still supersedes', async () => {
    const execution = new MemoryExecutionRepository();
    // The archived gate was bound to the warning set [w1]; the candidate now
    // carries an ADDITIONAL warning (re-validated with a different result).
    const drifted = makeEnvelope({
      revisionId: 'candidate-drifted-1',
      validation: {
        passed: true,
        errors: [],
        warnings: [warningIssue(), warningIssue('A second, newly surfaced uncertainty')],
        infos: [],
      },
    });
    await archiveCandidate(execution, drifted);
    await openGateRecord(execution, drifted);

    const resolution = await resolveReleaseGate(
      {
        projectId: PROJECT_ID,
        sourceHash: GATE_SOURCE_HASH,
        eventId: EVENT_ID,
        candidateRevisionId: drifted.revisionId,
        decision: 'accept',
        actorId: 'maintainer-6',
        capabilityVersion: 7,
        reason: 'waive the original uncertainty',
      },
      runtimeWith(execution),
    );

    expect(resolution.outcome).toBe('superseded');
    expect(resolution.acceptedRevisionId).toBeNull();
    expect(
      await execution.readAcceptedScene({ projectId: PROJECT_ID, eventId: EVENT_ID }),
    ).toBeNull();
  });
});
