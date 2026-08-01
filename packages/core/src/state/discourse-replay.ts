// ============================================================================
// Novalistically — DISCOURSE-1: Discourse State Replay Logic
//
// Replays a PlannedDiscourseLedger up to a given DiscoursePosition,
// producing an immutable DiscourseState snapshot. Also provides the
// Pass 1 DiscourseContextProjection derivation.
//
// Binding constraints enforced:
//   §1 — DiscourseState NOT part of WorldState
//   §3 — Canonical = PlannedDiscourseLedger only
//   §5 — reveal asserted-status hard rule
//   §6 — claim no truth commitment
//   §7 — hint contract states (6)
//   §8 — retraction no fake forget
//   §9 — correction NEVER retcons WorldState
//  §12 — Pass 1 projection capability-separated
//  §14 — branch-independent ledger
//  §15 — NarrativeEllipsis no discourse effect
//  §16 — sparse corpus modes
//  §17 — Pass 2 observation non-mutation (enforced at type level)
// ============================================================================

import type {
  DisclosureAction,
  DisclosureObservation,
  DiscourseContextProjection,
  DiscoursePosition,
  DiscourseState,
  Hint,
  HintState,
  ModelReaderProfile,
  NarratorAccess,
  NarratorAssertion,
  NarratorAssertionCapability,
  NarratorFidelity,
  NarratorProfile,
  NarratorSincerity,
  NarratorTruthCapability,
  PlannedDiscourseLedger,
} from '../types/discourse.js';

// ═════════════════════════════════════════════════════════════════════════════
// Default constants
// ═════════════════════════════════════════════════════════════════════════════

const DEFAULT_MODEL_READER_PROFILE_ID = 'default_model_reader_v1';

// ═════════════════════════════════════════════════════════════════════════════
// ModelReaderProfile factory (§2)
// ═════════════════════════════════════════════════════════════════════════════

/** Build the immutable default_model_reader_v1 profile. */
export function createDefaultModelReaderProfile(): ModelReaderProfile {
  return {
    id: DEFAULT_MODEL_READER_PROFILE_ID,
    hash: 'hash_default_model_reader_v1',
    audienceSemantics: {
      narrativeInterpretation: 'default',
      disclosureInterpretation: 'default',
    },
    narrationDisclosurePolicy: {
      allowPrivateThoughtDisclosure: true,
      allowDirectAddress: false,
    },
    initialExposureContract: {
      initialReveals: [],
      initialClaims: [],
      initialWithholds: [],
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// NarratorProfile factory helpers
// ═════════════════════════════════════════════════════════════════════════════

export function createFocalizerBoundProfile(
  id: string,
  access: NarratorAccess,
  assertion: NarratorAssertionCapability,
  truth: NarratorTruthCapability,
  fidelity: NarratorFidelity,
  sincerity: NarratorSincerity,
): NarratorProfile {
  return { type: 'focalizer_bound', id, access, assertion, truth, fidelity, sincerity };
}

export function createRetrospectiveEntityProfile(
  id: string,
  knowledgeBoundary: string,
  access: NarratorAccess,
  assertion: NarratorAssertionCapability,
  truth: NarratorTruthCapability,
  fidelity: NarratorFidelity,
  sincerity: NarratorSincerity,
): NarratorProfile {
  return {
    type: 'retrospective_entity',
    id,
    knowledgeBoundary,
    access,
    assertion,
    truth,
    fidelity,
    sincerity,
  };
}

export function createExplicitLedgerProfile(
  id: string,
  access: NarratorAccess,
  assertion: NarratorAssertionCapability,
  truth: NarratorTruthCapability,
  fidelity: NarratorFidelity,
  sincerity: NarratorSincerity,
): NarratorProfile {
  return { type: 'explicit_ledger', id, access, assertion, truth, fidelity, sincerity };
}

export function createOmniscientProfile(
  id: string,
  access: NarratorAccess,
  assertion: NarratorAssertionCapability,
  truth: NarratorTruthCapability,
  fidelity: NarratorFidelity,
  sincerity: NarratorSincerity,
): NarratorProfile {
  return {
    type: 'omniscient',
    id,
    access,
    assertion,
    truth,
    fidelity,
    sincerity,
    autoReveal: false,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Internal: empty DiscourseState
// ═════════════════════════════════════════════════════════════════════════════

export function emptyDiscourseState(branch: string): DiscourseState {
  return {
    position: 0,
    reveals: [],
    openClaims: [],
    retractions: [],
    corrections: [],
    hints: [],
    activeWithholds: [],
    narratorProfiles: {},
    assertions: {},
    providerIndex: {},
    branch,
    ledgerHash: '',
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Action application helpers
// ═════════════════════════════════════════════════════════════════════════════

function findAssertion(
  assertions: Record<string, NarratorAssertion>,
  assertionId: string,
): NarratorAssertion | undefined {
  return assertions[assertionId];
}

/**
 * True only when the resolved narrator may expose this assertion's surface.
 * `focalizer_only` and `limited` both require the assertion's focalizer
 * boundary until the contract introduces a narrower limited-access scope.
 */
function canProjectAssertionSurface(
  assertion: NarratorAssertion,
  narratorProfile: NarratorProfile | undefined,
  focalizerId: string | undefined,
): boolean {
  if (
    narratorProfile === undefined ||
    narratorProfile.id !== assertion.narrationBoundary.narratorId
  ) {
    return false;
  }
  switch (narratorProfile.access) {
    case 'full':
      return true;
    case 'focalizer_only':
    case 'limited':
      return focalizerId !== undefined && assertion.narrationBoundary.focalizerId === focalizerId;
  }
}

/**
 * Apply a single disclosure action to a DiscourseState.
 * Mutates the state in place for efficiency — caller must clone/hold
 * immutable semantics if needed.
 */
function applyAction(
  state: DiscourseState,
  action: DisclosureAction,
  assertions: Record<string, NarratorAssertion>,
): void {
  switch (action.type) {
    case 'reveal': {
      // §5: when a catalog is supplied, reveal asserted-status is a hard rule.
      // Sparse ledgers without a matching assertion retain legacy replay semantics.
      const assertion = findAssertion(assertions, action.assertionId);
      if (assertion !== undefined && assertion.status !== 'asserted') {
        throw new Error(`Reveal requires status=asserted for assertion "${action.assertionId}"`);
      }
      if (!state.reveals.includes(action.assertionId)) {
        state.reveals.push(action.assertionId);
      }
      // Remove from open claims if present (reveal supersedes claim)
      state.openClaims = state.openClaims.filter((id) => id !== action.assertionId);
      break;
    }

    case 'claim': {
      // §6: claim exposes assertion without committing truth
      if (!state.openClaims.includes(action.assertionId)) {
        state.openClaims.push(action.assertionId);
      }
      break;
    }

    case 'hint': {
      // §7: hint enters planned state
      const existing = state.hints.find((h) => h.hintId === action.hintId);
      if (existing) {
        // Update existing hint state
        existing.state = 'planned';
      } else {
        state.hints.push({
          hintId: action.hintId,
          state: 'planned',
          surfaceProposition: action.surfaceProposition,
          targetProposition: action.targetProposition,
          threadId: action.threadId,
          discoursePosition: action.discoursePosition,
        });
      }
      break;
    }

    case 'retraction': {
      // §8: retraction does NOT make reader fake forget
      state.retractions.push({
        assertionId: action.assertionId,
        discoursePosition: action.discoursePosition,
      });
      // Remove from open claims
      state.openClaims = state.openClaims.filter((id) => id !== action.assertionId);
      break;
    }

    case 'correction': {
      // §9: correction ONLY supersedes prior assertion contract
      state.corrections.push({
        priorAssertionId: action.priorAssertionId,
        newAssertionId: action.newAssertionId,
        discoursePosition: action.discoursePosition,
      });
      // Replace in reveals if present
      const revealIdx = state.reveals.indexOf(action.priorAssertionId);
      if (revealIdx !== -1) {
        state.reveals[revealIdx] = action.newAssertionId;
      }
      // Replace in open claims if present
      const claimIdx = state.openClaims.indexOf(action.priorAssertionId);
      if (claimIdx !== -1) {
        state.openClaims[claimIdx] = action.newAssertionId;
      }
      break;
    }

    case 'withhold_start': {
      const existingPolicy = state.activeWithholds.find((w) => w.policyId === action.policyId);
      if (!existingPolicy) {
        state.activeWithholds.push({
          policyId: action.policyId,
          reason: action.reason,
          startPosition: action.discoursePosition,
          endPosition: null,
          active: true,
        });
      } else {
        existingPolicy.active = true;
        existingPolicy.endPosition = null;
        existingPolicy.startPosition = Math.min(
          existingPolicy.startPosition,
          action.discoursePosition,
        );
      }
      break;
    }

    case 'withhold_end': {
      const policy = state.activeWithholds.find((w) => w.policyId === action.policyId);
      if (policy) {
        policy.active = false;
        policy.endPosition = action.discoursePosition;
      }
      break;
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Public API
// ═════════════════════════════════════════════════════════════════════════════
/**
 * Replay a PlannedDiscourseLedger up to (and including) the given position
 * for the specified branch.
 *
 * Returns the DiscourseState at that position.
 *
 * @param ledger - The canonical planned discourse ledger.
 * @param position - Discourse position to replay to. -1 returns a pristine empty state.
 *                  Nonnegative positions are sparse-safe (no upper-bound against entry count).
 * @param branch - Branch path to filter entries by.
 * @returns Immutable DiscourseState snapshot.
 *
 * Hard fails (§19):
 * - duplicate discourse position in entries
 * - negative position other than -1
 */
export function replayDiscourseState(
  ledger: PlannedDiscourseLedger,
  position: DiscoursePosition,
  branch: string,
  narratorAssertions: Record<string, NarratorAssertion> = {},
): DiscourseState {
  // -1 returns a pristine empty state (before any discourse)
  if (position === -1) {
    const state = emptyDiscourseState(branch);
    state.assertions = { ...narratorAssertions };
    state.ledgerHash = ledger.hash;
    return state;
  }

  if (position < -1) {
    throw new Error(`DiscoursePosition out of range: ${position}. Must be -1 or nonnegative.`);
  }

  const state = emptyDiscourseState(branch);
  state.assertions = { ...narratorAssertions };
  state.ledgerHash = ledger.hash;

  // Assertion definitions are loaded separately from the ledger. Keep them in
  // the replayed state so truth boundaries and Pass 1 claim surfaces are usable.
  const assertions = state.assertions;

  // Filter entries for this branch up to position (sparse-safe: no upper-bound on entry count)
  const relevantEntries = ledger.entries.filter(
    (e) => e.branch === branch && e.discoursePosition <= position,
  );

  // Sort by discourse position (should already be sorted, but be safe)
  relevantEntries.sort((a, b) => a.discoursePosition - b.discoursePosition);

  // Check for duplicate positions (§19)
  const seenPositions = new Set<DiscoursePosition>();
  for (const entry of relevantEntries) {
    if (seenPositions.has(entry.discoursePosition)) {
      throw new Error(
        `DuplicateDiscoursePositionError: position ${entry.discoursePosition} appears more than once`,
      );
    }
    seenPositions.add(entry.discoursePosition);
  }

  // Apply each action in order
  for (const entry of relevantEntries) {
    applyAction(state, entry.action, assertions);
    state.position = entry.discoursePosition;
  }

  return state;
}

/**
 * - accessible claims whose narrator/focalizer boundary permits their surface
 * - authorized targets
 * - active withholding policies
 *
 * FORBIDDEN items are excluded (§12).
 */
export function projectDiscourseContext(
  state: DiscourseState,
  narratorProfile: NarratorProfile | undefined,
  focalizerId: string | undefined,
  authorizedAssertions: string[],
): DiscourseContextProjection {
  // Visible hints — surface only, NEVER target (§12)
  const visibleHints = state.hints
    .filter((h) => h.state !== 'retracted')
    .map((h) => ({
      hintId: h.hintId,
      surfaceProposition: h.surfaceProposition,
      state: h.state,
    }));

  // Accessible claims require both the scene authorization and narrator boundary.
  const accessibleClaims = state.openClaims
    .filter((assertionId) => {
      const assertion = state.assertions[assertionId];
      return (
        assertion !== undefined &&
        authorizedAssertions.includes(assertionId) &&
        canProjectAssertionSurface(assertion, narratorProfile, focalizerId)
      );
    })
    .map((assertionId) => {
      const assertion = state.assertions[assertionId];
      return {
        assertionId,
        narrator: assertion.narrator,
        type: assertion.type,
        surface: assertion.proposition,
      };
    });

  // Authorized targets for the current scene
  const authorizedTargets = authorizedAssertions
    .filter((assertionId) => {
      const isReveal = state.reveals.includes(assertionId);
      const isClaim = state.openClaims.includes(assertionId);
      return isReveal || isClaim;
    })
    .map((assertionId) => ({
      assertionId,
      actionType: (state.reveals.includes(assertionId) ? 'reveal' : 'claim') as 'reveal' | 'claim',
      discoursePosition: state.position,
    }));

  return {
    plannedReveals: [...state.reveals],
    openClaims: [...state.openClaims],
    visibleHints,
    accessibleClaims,
    authorizedTargets,
    activeWithholdingPolicies: state.activeWithholds.filter((w) => w.active),
  };
}

/**
 * Check whether two DiscourseContextProjections are identical.
 *
 * Used for shared post-merge scene validation (§14):
 * shared post-merge scene ONLY if all incoming branches have IDENTICAL
 * complete discourse read projection — otherwise generate branch variants.
 */
export function areProjectionsIdentical(
  a: DiscourseContextProjection,
  b: DiscourseContextProjection,
): boolean {
  // Compare plannedReveals
  if (a.plannedReveals.length !== b.plannedReveals.length) return false;
  for (let i = 0; i < a.plannedReveals.length; i++) {
    if (a.plannedReveals[i] !== b.plannedReveals[i]) return false;
  }

  // Compare openClaims
  if (a.openClaims.length !== b.openClaims.length) return false;
  for (let i = 0; i < a.openClaims.length; i++) {
    if (a.openClaims[i] !== b.openClaims[i]) return false;
  }

  // Compare visibleHints
  if (a.visibleHints.length !== b.visibleHints.length) return false;
  for (let i = 0; i < a.visibleHints.length; i++) {
    const ha = a.visibleHints[i];
    const hb = b.visibleHints[i];
    if (ha.hintId !== hb.hintId) return false;
    if (ha.surfaceProposition !== hb.surfaceProposition) return false;
    if (ha.state !== hb.state) return false;
  }

  // Compare accessibleClaims
  if (a.accessibleClaims.length !== b.accessibleClaims.length) return false;
  for (let i = 0; i < a.accessibleClaims.length; i++) {
    const ca = a.accessibleClaims[i];
    const cb = b.accessibleClaims[i];
    if (ca.assertionId !== cb.assertionId) return false;
    if (ca.narrator !== cb.narrator) return false;
    if (ca.type !== cb.type) return false;
    if (ca.surface !== cb.surface) return false;
  }

  // Compare authorizedTargets
  if (a.authorizedTargets.length !== b.authorizedTargets.length) return false;
  for (let i = 0; i < a.authorizedTargets.length; i++) {
    const ta = a.authorizedTargets[i];
    const tb = b.authorizedTargets[i];
    if (ta.assertionId !== tb.assertionId) return false;
    if (ta.actionType !== tb.actionType) return false;
    if (ta.discoursePosition !== tb.discoursePosition) return false;
  }

  // Compare activeWithholdingPolicies
  if (a.activeWithholdingPolicies.length !== b.activeWithholdingPolicies.length) return false;
  for (let i = 0; i < a.activeWithholdingPolicies.length; i++) {
    const wa = a.activeWithholdingPolicies[i];
    const wb = b.activeWithholdingPolicies[i];
    if (wa.policyId !== wb.policyId) return false;
    if (wa.active !== wb.active) return false;
    if (wa.startPosition !== wb.startPosition) return false;
    if (wa.endPosition !== wb.endPosition) return false;
  }

  return true;
}

/**
 * Validate the reveal status rule (§5).
 * reveal can ONLY plan to expose status=asserted propositions.
 *
 * @returns true if the assertion may be revealed; false if only claim/conjecture.
 */
export function canReveal(assertion: NarratorAssertion): boolean {
  return assertion.status === 'asserted';
}

/**
 * Advance a hint's contract state (§7).
 * Returns a new Hint with the updated state.
 */
export function advanceHintState(hint: Hint, newState: HintState): Hint {
  return { ...hint, state: newState };
}

/**
 * Create a Pass 2 observation without mutating any canonical state (§17).
 * This is a pure data constructor — observations NEVER write/revise the
 * canonical discourse ledger.
 */
export function createObservation(
  plannedEffectId: string,
  observationType: DisclosureObservation['observationType'],
  proposition: string,
  polarity: string,
  assertion: string,
  matchLevel: DisclosureObservation['matchLevel'],
  overrides?: Partial<DisclosureObservation>,
): DisclosureObservation {
  return {
    plannedEffectId,
    observationType,
    proposition,
    polarity: polarity as 'affirmative' | 'negative',
    assertion,
    matchLevel,
    ...overrides,
  };
}
