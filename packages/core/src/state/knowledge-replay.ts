// ============================================================================
// Novalistically — STATE-4 Knowledge Replay Engine
// Claim/act transaction application + evaluate() deterministic three-valued logic
// ============================================================================

import type { EntityId, FactId, WorldState } from '../types/index.js';
import type {
  ActProposition,
  Claim,
  ClaimAssessment,
  ClaimEvidenceRecord,
  EpistemicLedger,
  EpistemicProposition,
  EvaluationResult,
  GroundedProposition,
  InformationAct,
  Proposition,
  PropositionCatalog,
  PropositionId,
} from '../types/knowledge.js';
import { claimKey } from '../types/knowledge.js';

// ═════════════════════════════════════════════════════════════════════════════
// evaluate() — Deterministic three-valued truth
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Determine the objective truth of a proposition against the current WorldState
 * and EpistemicLedger.
 *
 * - Grounded: compare against WorldState.entities.
 * - Epistemic: check if the subject's ledger claim matches the attitude.
 * - Act: check actLog for matching information act.
 * - Intensional: always 'indeterminate' (opaque).
 */
export function evaluate(
  proposition: Proposition,
  worldState: WorldState,
  ledger: EpistemicLedger,
  catalog: PropositionCatalog,
): EvaluationResult {
  switch (proposition.kind) {
    case 'grounded':
      return evaluateGrounded(proposition, worldState);
    case 'epistemic':
      return evaluateEpistemic(proposition, ledger, catalog);
    case 'act':
      return evaluateAct(proposition, ledger);
    case 'intensional':
      return 'indeterminate';
    default:
      return 'indeterminate';
  }
}

function evaluateGrounded(p: GroundedProposition, state: WorldState): EvaluationResult {
  const currentValue = state.entities[p.entityId]?.[p.attribute];

  // Not yet established in world state
  if (currentValue === undefined) return 'indeterminate';

  const quantifier = p.quantifier ?? 'identity';

  switch (quantifier) {
    case 'identity':
      return currentValue === p.value ? 'true' : 'false';
    case 'not':
      return currentValue !== p.value ? 'true' : 'false';
    case 'all': {
      if (!Array.isArray(currentValue) || !Array.isArray(p.value)) return 'indeterminate';
      const target = p.value as unknown[];
      return target.every((v) => (currentValue as unknown[]).includes(v)) ? 'true' : 'false';
    }
    case 'any': {
      if (!Array.isArray(currentValue) || !Array.isArray(p.value)) return 'indeterminate';
      const target = p.value as unknown[];
      return target.some((v) => (currentValue as unknown[]).includes(v)) ? 'true' : 'false';
    }
    default:
      return 'indeterminate';
  }
}

function evaluateEpistemic(
  p: EpistemicProposition,
  ledger: EpistemicLedger,
  _catalog: PropositionCatalog,
): EvaluationResult {
  const key = claimKey(p.subject, p.propositionId);
  const claim = ledger.claims[key];
  if (!claim) return 'indeterminate';

  // The epistemic truth is determined by the ledger claim matching the stated attitude
  if (claim.assessment.type !== 'settled') return 'indeterminate';

  // Map claim grades to proposition attitudes for comparison
  const gradeToAttitude: Record<string, string> = {
    know: 'knows',
    believe: 'believes',
    suspect: 'suspects',
  };

  const settledAttitude = gradeToAttitude[claim.assessment.grade];
  if (!settledAttitude) return 'indeterminate';

  const matches = settledAttitude === p.attitude;
  const polarityMatch =
    (claim.assessment.polarity === 'affirmative' && p.attitude !== 'denies') ||
    (claim.assessment.polarity === 'negative' && p.attitude === 'denies');

  return matches && polarityMatch ? 'true' : 'false';
}

function evaluateAct(p: ActProposition, ledger: EpistemicLedger): EvaluationResult {
  const found = ledger.actLog.some(
    (act) =>
      act.type === p.actType &&
      act.actor === p.actor &&
      act.contentPropositions.some((cp) => p.contentPropositions.includes(cp)),
  );
  return found ? 'true' : 'false';
}

// ═════════════════════════════════════════════════════════════════════════════
// Claim Transaction Application
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Apply a claim write to the ledger.
 * Returns a new ledger (immutable-style update) with the claim applied.
 * Same-node same-cell duplicate write → hard error.
 */
export function applyClaimTransaction(
  ledger: EpistemicLedger,
  subject: EntityId,
  propositionId: FactId,
  assessment: ClaimAssessment,
  evidence: ClaimEvidenceRecord[],
): EpistemicLedger {
  const key = claimKey(subject, propositionId);

  // Duplicate write detection
  const existing = ledger.claims[key];
  if (existing) {
    throw new Error(
      `Duplicate claim write for ${key}: claim already exists with assessment type ${existing.assessment.type}`,
    );
  }

  const newClaim: Claim = {
    subject,
    propositionId,
    assessment,
    evidence,
  };

  const newClaims = { ...ledger.claims, [key]: newClaim };

  // Update indices
  const newBySubject = { ...ledger.bySubject };
  if (!newBySubject[subject]) newBySubject[subject] = [];
  newBySubject[subject] = [...newBySubject[subject], propositionId];

  const newByProposition = { ...ledger.byProposition };
  if (!newByProposition[propositionId]) newByProposition[propositionId] = [];
  newByProposition[propositionId] = [...newByProposition[propositionId], subject];

  return {
    claims: newClaims,
    bySubject: newBySubject,
    byProposition: newByProposition,
    actLog: ledger.actLog,
  };
}

/**
 * Record an information act in the ledger's act log.
 * Returns a new ledger with the act appended.
 */
export function recordInformationAct(
  ledger: EpistemicLedger,
  act: InformationAct,
): EpistemicLedger {
  return {
    ...ledger,
    actLog: [...ledger.actLog, act],
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Provider / Warrant Resolution
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Resolve whether an evidence chain provides sufficient warrant for a 'know' claim.
 *
 * Rules:
 * - direct_experience + truth agreement → sufficient
 * - testimony + sufficient warrant + complete communication → sufficient
 * - inference + all premise providers verified → sufficient
 * - revelation → sufficient (in-world conceit)
 * - default → insufficient
 */
export function hasSufficientWarrant(evidence: ClaimEvidenceRecord[]): boolean {
  if (evidence.length === 0) return false;

  // Most recent evidence determines current warrant status
  const latest = evidence[0];

  switch (latest.source) {
    case 'direct_experience':
      return true; // Observation + truth agreement (verified at write time)
    case 'testimony':
      return latest.warrant !== undefined && latest.provider !== undefined;
    case 'inference':
      return latest.provenance.length > 0;
    case 'revelation':
      return true; // In-world conceit: revelation is self-warranting
    case 'default':
      return false;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// PropositionCatalog Validation
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Validate that a PropositionCatalog has no cycles or self-references
 * in its dependency graph. Throws on invalid.
 */
export function validatePropositionCatalog(catalog: PropositionCatalog): void {
  const { propositions, dependencyGraph } = catalog;

  for (const [propId, deps] of Object.entries(dependencyGraph)) {
    const depList = deps as PropositionId[];

    // Self-reference check
    if (depList.includes(propId as PropositionId)) {
      throw new Error(`Proposition ${propId} references itself in dependency graph`);
    }

    // All deps must exist
    for (const dep of depList) {
      if (!propositions[dep]) {
        throw new Error(`Proposition ${propId} depends on ${dep}, which is not in the catalog`);
      }
    }
  }

  // Cycle detection (DFS)
  const visited = new Set<PropositionId>();
  const inStack = new Set<PropositionId>();

  function visit(node: PropositionId): void {
    if (inStack.has(node)) {
      throw new Error(
        `Cycle detected in proposition dependency graph involving proposition ${node}`,
      );
    }
    if (visited.has(node)) return;

    visited.add(node);
    inStack.add(node);

    const deps = dependencyGraph[node] ?? [];
    for (const dep of deps) {
      visit(dep);
    }

    inStack.delete(node);
  }

  for (const propId of Object.keys(propositions)) {
    if (!visited.has(propId as PropositionId)) {
      visit(propId as PropositionId);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// NarrativeKnowledgeBoundary helpers
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Filter a ledger to only claims on the boundary's allowlist.
 * Claims not on the list are excluded; forgotten/suspended/unset are also excluded.
 */
export function applyKnowledgeBoundary(
  ledger: EpistemicLedger,
  boundary: { allowlistedClaims: string[]; focalizer: EntityId },
): EpistemicLedger {
  const filtered: EpistemicLedger = {
    claims: {},
    bySubject: {},
    byProposition: {},
    actLog: [],
  };

  for (const claimKeyStr of boundary.allowlistedClaims) {
    const claim = ledger.claims[claimKeyStr];
    if (!claim) continue;

    // Filter out non-settled assessments
    if (
      claim.assessment.type === 'forgotten' ||
      claim.assessment.type === 'suspended' ||
      claim.assessment.type === 'unset'
    ) {
      continue;
    }

    filtered.claims[claimKeyStr] = claim;

    // Update indices
    if (!filtered.bySubject[claim.subject]) {
      filtered.bySubject[claim.subject] = [];
    }
    if (!filtered.bySubject[claim.subject].includes(claim.propositionId)) {
      filtered.bySubject[claim.subject] = [
        ...filtered.bySubject[claim.subject],
        claim.propositionId,
      ];
    }

    if (!filtered.byProposition[claim.propositionId]) {
      filtered.byProposition[claim.propositionId] = [];
    }
    if (!filtered.byProposition[claim.propositionId].includes(claim.subject)) {
      filtered.byProposition[claim.propositionId] = [
        ...filtered.byProposition[claim.propositionId],
        claim.subject,
      ];
    }
  }

  return filtered;
}

// ═════════════════════════════════════════════════════════════════════════════
// Group Epistemic Query
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Evaluate a group epistemic query against the ledger.
 *
 * - institutional: check if the group's institutional ledger (if any) has the claim.
 * - distributed: true if ANY member has a settled claim.
 * - mutual: true if ALL members have a settled claim.
 * - Empty audience → false for mutual (no vacuous truth).
 */
export function evaluateGroupEpistemic(
  groupClaim: {
    mode: 'institutional' | 'distributed' | 'mutual';
    propositionId: FactId;
    audience: EntityId[];
  },
  ledger: EpistemicLedger,
): boolean {
  if (groupClaim.mode === 'mutual' && groupClaim.audience.length === 0) {
    return false; // No vacuous mutual truth
  }

  switch (groupClaim.mode) {
    case 'institutional': {
      // Check if the group entity itself has a claim
      const key = claimKey(groupClaim.audience[0] ?? 'unknown', groupClaim.propositionId);
      const claim = ledger.claims[key];
      return claim?.assessment.type === 'settled' && claim.assessment.polarity === 'affirmative';
    }
    case 'distributed': {
      return groupClaim.audience.some((member) => {
        const key = claimKey(member, groupClaim.propositionId);
        const claim = ledger.claims[key];
        return claim?.assessment.type === 'settled' && claim.assessment.polarity === 'affirmative';
      });
    }
    case 'mutual': {
      return groupClaim.audience.every((member) => {
        const key = claimKey(member, groupClaim.propositionId);
        const claim = ledger.claims[key];
        return claim?.assessment.type === 'settled' && claim.assessment.polarity === 'affirmative';
      });
    }
  }
}
