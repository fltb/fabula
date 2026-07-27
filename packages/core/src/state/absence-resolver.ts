// ============================================================================
// AbsenceResolver — Deterministic absence resolution for reads with no provider
// Constructs AbsenceWitness instances bound to concrete branch, temporal prefix,
// and catalog/lifecycle/closed-world basis.
// ============================================================================

import type { AbsenceBasis, AbsenceWitness, BranchPath } from '../types/index.js';

// ─── Helper: compute a resolution hash for given parameters ──────────────────

function computeResolutionHash(
  branch: BranchPath,
  temporalPrefix: string,
  basis: AbsenceBasis,
  latestUnsetOutput?: string,
): string {
  const components = [
    `branch:${JSON.stringify(branch.decisions)}`,
    `prefix:${temporalPrefix}`,
    `basis:${basis}`,
  ];
  if (latestUnsetOutput !== undefined) {
    components.push(`unset:${latestUnsetOutput}`);
  }
  // Simple deterministic hash based on concatenated components
  let hash = 0;
  const input = components.join('|');
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

// ─── Build an AbsenceWitness for a read with no provider ─────────────────────

export interface BuildAbsenceWitnessParams {
  /** Concrete branch path */
  branch: BranchPath;
  /** Ancestor-closed temporal node prefix */
  temporalPrefix: string;
  /** Absence basis — never_written | pre_introduction | after_unset | branch_local */
  basis: AbsenceBasis;
  /** Latest unset output ID, if applicable */
  latestUnsetOutput?: string;
}

/**
 * Construct an immutable AbsenceWitness for a deterministic read
 * that found no provider.
 *
 * Satisfies presence-aware reads (exists/not_exists). Does NOT produce
 * a WorldState write, does NOT represent initialState unset,
 * does NOT originate from author-origin output, does NOT represent
 * narrative causation.
 *
 * @returns A new AbsenceWitness bound to the given parameters
 */
export function buildAbsenceWitness(params: BuildAbsenceWitnessParams): AbsenceWitness {
  const { branch, temporalPrefix, basis, latestUnsetOutput } = params;
  const resolutionHash = computeResolutionHash(branch, temporalPrefix, basis, latestUnsetOutput);
  const witness: AbsenceWitness = {
    branch,
    temporalPrefix,
    basis,
    resolutionHash,
  };
  if (latestUnsetOutput !== undefined) {
    witness.latestUnsetOutput = latestUnsetOutput;
  }
  return witness;
}

// ─── Determine absence basis from context flags ──────────────────────────────

export interface AbsenceContext {
  /** True if the entity/cell was never written in any branch */
  neverWritten: boolean;
  /** True if the entity exists but was not yet introduced at this temporal prefix */
  preIntroduction: boolean;
  /** True if a prior unset operation removed the value */
  afterUnset: boolean;
  /** True if the cell exists in another branch but not this one */
  branchLocal: boolean;
}

/**
 * Resolve which AbsenceBasis applies given contextual flags.
 * Priority order: never_written > pre_introduction > after_unset > branch_local.
 * Exactly one basis is returned.
 *
 * @throws {Error} if no flag is set
 */
export function resolveAbsenceBasis(context: AbsenceContext): AbsenceBasis {
  if (context.neverWritten) return 'never_written';
  if (context.preIntroduction) return 'pre_introduction';
  if (context.afterUnset) return 'after_unset';
  if (context.branchLocal) return 'branch_local';
  throw new Error(
    'Cannot resolve absence basis: no absence context flag is set. ' +
      'At least one of neverWritten, preIntroduction, afterUnset, or branchLocal must be true.',
  );
}

/**
 * Aggregate three-valued evaluation: given a set of AbsenceWitness readings,
 * determine the composite result.
 *
 * never_written or pre_introduction → not_exists
 * after_unset → not_exists (with unset provenance)
 * branch_local → not_exists (branch-scoped)
 * Mixed → not_exists (strongest basis wins: never_written > pre_introduction > after_unset > branch_local)
 */
export function aggregateAbsenceEvaluation(witnesses: AbsenceWitness[]): {
  exists: boolean;
  basis: AbsenceBasis;
  resolutionHash: string;
  witnessCount: number;
} {
  if (witnesses.length === 0) {
    return { exists: false, basis: 'never_written', resolutionHash: '00000000', witnessCount: 0 };
  }

  // Strongest basis priority: never_written > pre_introduction > after_unset > branch_local
  const strength: Record<AbsenceBasis, number> = {
    never_written: 4,
    pre_introduction: 3,
    after_unset: 2,
    branch_local: 1,
  };

  let strongest: AbsenceBasis = 'branch_local';
  for (const w of witnesses) {
    if (strength[w.basis] > strength[strongest]) {
      strongest = w.basis;
    }
  }

  // Use the strongest witness's hash
  const strongestWitness = witnesses.find((w) => w.basis === strongest) ?? witnesses[0];

  return {
    exists: false,
    basis: strongest,
    resolutionHash: strongestWitness.resolutionHash,
    witnessCount: witnesses.length,
  };
}
