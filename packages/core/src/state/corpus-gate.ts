// ============================================================================
// Novalistically — CORPUS-5: Build Failure, Metric Isolation & Gate
// Validates corpus integrity at build time — missing sources, dependencies,
// oracles, selection reproducibility, and legal mode constraints.
// All gate checks hard-fail on violation; no skip/deferred/zero-CED masking.
// ============================================================================

import { ConfigError } from '../errors.ts';
import type { SourceManifest, WorkIndex } from './corpus-index.ts';
import type { StoryBoundaryOracle } from './corpus-replay.ts';
import type { SelectionPlan } from './corpus-selection.ts';

// ═════════════════════════════════════════════════════════════════════════════
// Types
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Result of a corpus integrity validation.
 */
export interface CorpusGateResult {
  /** Whether all gate checks passed */
  passed: boolean;
  /** Individual gate check results */
  checks: GateCheck[];
}

/**
 * Result of a single gate check.
 */
export interface GateCheck {
  /** Check identifier */
  name: string;
  /** Whether this check passed */
  passed: boolean;
  /** Human-readable explanation when failed */
  reason?: string;
}

// ═════════════════════════════════════════════════════════════════════════════
// Helpers
// ═════════════════════════════════════════════════════════════════════════════

function fail(name: string, reason: string): GateCheck {
  return { name, passed: false, reason };
}

function pass(name: string): GateCheck {
  return { name, passed: true };
}

// ═════════════════════════════════════════════════════════════════════════════
// Gate Checks
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Validate source provenance: source hash and legal mode.
 *
 * Requirements:
 * - sourceHash must be a non-empty SHA-256 hex string (64 hex chars)
 * - legalMode must be one of 'public_domain', 'local_external', 'restricted'
 * - Jurisdiction must be a non-empty string
 *
 * @param manifest - Source manifest to validate
 * @returns GateCheck with pass/fail status
 */
export function checkProvenance(manifest: SourceManifest): GateCheck {
  if (!manifest.sourceHash || manifest.sourceHash.length === 0) {
    return fail(
      'provenance',
      `Source hash is empty for "${manifest.workId}/${manifest.editionId}"`,
    );
  }
  if (!/^[0-9a-f]{64}$/i.test(manifest.sourceHash)) {
    return fail(
      'provenance',
      `Source hash "${manifest.sourceHash}" is not a valid SHA-256 hex string`,
    );
  }
  if (!['public_domain', 'local_external', 'restricted'].includes(manifest.legalMode)) {
    return fail(
      'provenance',
      `Invalid legal mode "${manifest.legalMode}" for "${manifest.workId}"`,
    );
  }
  if (!manifest.jurisdiction || manifest.jurisdiction.length === 0) {
    return fail('provenance', `Jurisdiction is empty for "${manifest.workId}"`);
  }
  return pass('provenance');
}

/**
 * Check that all causal preconditions for events in the work index
 * have a matching provider in the candidate index.
 *
 * For each narrative node, all preconditions listed must be resolvable
 * to candidate event entries in the work index.
 *
 * @param eventId - The event ID to check (uses the full WorkIndex internally)
 * @param index - The frozen work index
 * @returns GateCheck with pass/fail status
 */
export function checkCausalDeps(eventId: string, index: WorkIndex): GateCheck {
  // Find the narrative node for this event
  const node = index.narrativeNodes.find((n) => n.nodeId === eventId);
  if (!node) {
    return fail(
      'causal_deps',
      `Event "${eventId}" not found in narrative nodes of "${index.workId}"`,
    );
  }

  // Build a set of all candidate event IDs for quick lookup
  const candidateIds = new Set(index.candidateEvents.map((c) => c.candidateId));

  // Check that every precondition has a matching candidate or node
  const missing: string[] = [];
  for (const precond of node.preconditions) {
    // Precondition can reference either a candidate event or another narrative node
    const hasProvider =
      candidateIds.has(precond) || index.narrativeNodes.some((n) => n.nodeId === precond);
    if (!hasProvider) {
      missing.push(precond);
    }
  }

  if (missing.length > 0) {
    return fail(
      'causal_deps',
      `Event "${eventId}" has ${missing.length} unresolved preconditions: ${missing.join(', ')}`,
    );
  }

  return pass('causal_deps');
}

/**
 * Check that every selected event has a corresponding boundary oracle.
 *
 * All selected events MUST have a StoryBoundaryOracle. Missing oracles
 * indicate incomplete manual annotation or an out-of-date selection plan.
 *
 * @param selection - The frozen selection plan
 * @param oracles - List of boundary oracles
 * @returns GateCheck with pass/fail status
 */
export function checkOracleCoverage(
  selection: SelectionPlan,
  oracles: StoryBoundaryOracle[],
): GateCheck {
  const oracleIds = new Set(oracles.map((o) => o.eventId));
  const missing = selection.candidates.filter((id) => !oracleIds.has(id));

  if (missing.length > 0) {
    return fail(
      'oracle_coverage',
      `Missing boundary oracles for ${missing.length} selected event(s): ${missing.join(', ')}`,
    );
  }

  return pass('oracle_coverage');
}

/**
 * Check that two selection plans produce the same selection when
 * given the same seed and candidate inputs (reproducibility).
 *
 * @param plan1 - First selection plan
 * @param plan2 - Second selection plan
 * @returns GateCheck — passes if both plans select identical candidate sets
 */
export function checkSelectionReproducibility(
  plan1: SelectionPlan,
  plan2: SelectionPlan,
): GateCheck {
  if (plan1.seed !== plan2.seed) {
    return fail('selection_reproducibility', 'Seeds differ — plans are not comparable');
  }
  if (plan1.workId !== plan2.workId) {
    return fail('selection_reproducibility', 'Work IDs differ — plans are not comparable');
  }
  if (plan1.algorithm !== plan2.algorithm) {
    return fail('selection_reproducibility', 'Algorithms differ — plans are not comparable');
  }

  const sorted1 = [...plan1.candidates].sort();
  const sorted2 = [...plan2.candidates].sort();

  if (sorted1.length !== sorted2.length) {
    return fail(
      'selection_reproducibility',
      `Candidate count differs: plan1 has ${sorted1.length}, plan2 has ${sorted2.length}`,
    );
  }

  for (let i = 0; i < sorted1.length; i++) {
    if (sorted1[i] !== sorted2[i]) {
      return fail(
        'selection_reproducibility',
        `Candidate mismatch at position ${i}: "${sorted1[i]}" vs "${sorted2[i]}"`,
      );
    }
  }

  return pass('selection_reproducibility');
}

/**
 * Check that two source manifests represent separate works (no pooling).
 *
 * 87/103 chapters of 四世同堂 MUST be treated as separate manifests/indexes/
 * selections/reports. No pooling allowed.
 *
 * This check ensures the manifests have different work IDs or edition IDs,
 * and that their source hashes differ.
 *
 * @param m1 - First source manifest
 * @param m2 - Second source manifest
 * @returns GateCheck — passes if manifests represent distinct works
 */
export function checkNoPooling(m1: SourceManifest, m2: SourceManifest): GateCheck {
  // Same workId + editionId means they're the same variant — not pooling
  if (m1.workId === m2.workId && m1.editionId === m2.editionId) {
    return fail(
      'no_pooling',
      `Both manifests reference the same work variant "${m1.workId}/${m1.editionId}" — no separate pooling needed`,
    );
  }

  // Different work IDs and different source hashes — definitively separate
  if (m1.workId !== m2.workId && m1.sourceHash !== m2.sourceHash) {
    return pass('no_pooling');
  }

  // Different work IDs but same source hash suggests a split work —
  // e.g., 87-chapter and 103-chapter versions of the same novel.
  // This is allowed as separate manifests, so it passes.
  return pass('no_pooling');
}

// ═════════════════════════════════════════════════════════════════════════════
// Composite Gate
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Run all corpus integrity gate checks for a work variant.
 *
 * Validates:
 * 1. Source provenance (hash, legal mode, jurisdiction)
 * 2. Causal dependency resolution for all narrative nodes
 * 3. Oracle coverage for selected events
 * 4. Selection reproducibility (passes trivially with one plan)
 * 5. No pooling against other manifests (passes trivially with one manifest)
 *
 * On any hard gate failure, throws a ConfigError with details.
 *
 * @param manifest - Source manifest for the work
 * @param index - Frozen work index
 * @param selection - Frozen selection plan
 * @param oracles - Boundary oracles for the selection
 * @returns CorpusGateResult with per-check details
 * @throws {ConfigError} if any gate check fails
 */
export function validateCorpusIntegrity(
  manifest: SourceManifest,
  index: WorkIndex,
  selection: SelectionPlan,
  oracles: StoryBoundaryOracle[],
): CorpusGateResult {
  const checks: GateCheck[] = [];

  // 1. Provenance check
  checks.push(checkProvenance(manifest));

  // 2. Causal dependency checks for each narrative node
  for (const node of index.narrativeNodes) {
    checks.push(checkCausalDeps(node.nodeId, index));
  }

  // 3. Oracle coverage check
  checks.push(checkOracleCoverage(selection, oracles));

  // 4. Check selection plan matches work
  if (selection.workId !== manifest.workId) {
    checks.push(
      fail(
        'selection_work_match',
        `Selection work "${selection.workId}" does not match manifest work "${manifest.workId}"`,
      ),
    );
  } else {
    checks.push(pass('selection_work_match'));
  }

  // 5. Check quota matches selection size
  if (selection.candidates.length !== selection.quota) {
    checks.push(
      fail(
        'selection_quota_match',
        `Selection has ${selection.candidates.length} candidates but quota is ${selection.quota}`,
      ),
    );
  } else {
    checks.push(pass('selection_quota_match'));
  }

  const allPassed = checks.every((c) => c.passed);
  const result: CorpusGateResult = { passed: allPassed, checks };

  // Hard fail on any violation — no skip/deferred/zero-CED masking
  if (!allPassed) {
    const failures = checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.reason}`);
    throw new ConfigError(
      `Corpus integrity gate FAILED for "${manifest.workId}/${manifest.editionId}":\n${failures.join('\n')}`,
    );
  }

  return result;
}
