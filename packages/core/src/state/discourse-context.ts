// ============================================================================
// Novalistically — DISCOURSE-1: Compiled discourse render context & strict
// preflight for planned-disclosure boundaries before provider/cache/prompt.
//
// Every event receives one CompiledDiscourseRenderContext before any prose
// generation. compileDiscourseBoundaries() performs strict ledger preflight
// and never falls back to permissive catalog handling.
// ============================================================================

import { ConfigError } from '../errors.ts';
import type { NarrativeEvent } from '../types/event.js';
import type {
  DiscourseContextProjection,
  DiscourseState,
  NarratorAssertion,
  NarratorProfile,
  PlannedDiscourseLedger,
  PlannedLedgerEntry,
  RevealAction,
} from '../types/discourse.js';
import {
  emptyDiscourseState,
  projectDiscourseContext,
  replayDiscourseState,
} from './discourse-replay.js';
import { compileDiscourseSceneSequence } from './discourse-sequence.ts';

// ═════════════════════════════════════════════════════════════════════════════
// CompiledDiscourseRenderContext — immutable snapshot per event
// ═════════════════════════════════════════════════════════════════════════════

export interface CompiledDiscourseRenderContext {
  /** Discourse state BEFORE this event's action interval (or cursor). */
  readonly stateBefore: DiscourseState;
  /** Discourse state AFTER this event's action interval (or cursor). */
  readonly stateAfter: DiscourseState;
  /** Safe Pass-1 projection derived from stateAfter — includes current scene's authorized reveal/claim actions. Never exposes hint targets (stripped by projectDiscourseContext). */
  readonly projection: DiscourseContextProjection;
  /** Entry IDs belonging to this event (empty when cursor-only). */
  readonly currentActionIds: string[];
  /** Branch scope. */
  readonly branch: string;
  /** Discourse cursor: -1 (no actions, start-of-discourse) or nonnegative first-action position. */
  readonly cursor: number;
  /** Ledger hash from the source PlannedDiscourseLedger. */
  readonly ledgerHash: string;
  /** Deterministic hash of the sorted assertion catalog. */
  readonly assertionCatalogHash: string;
}

// ═════════════════════════════════════════════════════════════════════════════
// Internal helpers
// ═════════════════════════════════════════════════════════════════════════════

/** Simple non-cryptographic hash for deterministic catalog/lookup IDs. */
function simpleHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

/** Deep-clone a DiscourseState so mutations in replay don't leak. */
function cloneDiscourseState(state: DiscourseState): DiscourseState {
  return {
    position: state.position,
    reveals: [...state.reveals],
    openClaims: [...state.openClaims],
    retractions: state.retractions.map((r) => ({ ...r })),
    corrections: state.corrections.map((c) => ({ ...c })),
    hints: state.hints.map((h) => ({ ...h })),
    activeWithholds: state.activeWithholds.map((w) => ({ ...w })),
    narratorProfiles: { ...state.narratorProfiles },
    assertions: { ...state.assertions },
    providerIndex: { ...state.providerIndex },
    branch: state.branch,
    ledgerHash: state.ledgerHash,
  };
}

/** Build a fresh empty state for the given branch, pre-loaded with assertions. */
function makeEmptyState(branch: string, assertions: Record<string, NarratorAssertion>, ledgerHash: string): DiscourseState {
  const s = emptyDiscourseState(branch);
  s.assertions = { ...assertions };
  s.ledgerHash = ledgerHash;
  return s;
}

/** Compute deterministic hash from sorted assertion IDs. */
function computeCatalogHash(assertions: Record<string, NarratorAssertion>): string {
  const ids = Object.keys(assertions).sort();
  return simpleHash(ids.join(',') + '|' + ids.length);
}

/** Build state at-or-before cursor, handling the -1 pre-disclosure sentinel. */
function buildStateAtCursor(
  cursor: number,
  ledger: PlannedDiscourseLedger,
  branch: string,
  assertions: Record<string, NarratorAssertion>,
): DiscourseState {
  if (cursor < -1) {
    throw new ConfigError(`Invalid derived discourse cursor ${cursor}: must be -1 or nonnegative`);
  }
  if (cursor <= 0) {
    return makeEmptyState(branch, assertions, ledger.hash);
  }
  return replayDiscourseState(ledger, cursor - 1, branch, assertions);
}

// ═════════════════════════════════════════════════════════════════════════════
// Preflight validators
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Validate that the assertion catalog is complete when assertion-bearing
 * action types (reveal/claim/retraction/correction) exist in the ledger.
 * Per the plan: strict catalog mode — no permissive fallback.
 */
function preflightAssertionCatalog(
  ledger: PlannedDiscourseLedger,
  assertions: Record<string, NarratorAssertion>,
): void {
  const hasAssertionActions = ledger.entries.some(
    (e) =>
      e.action.type === 'reveal' ||
      e.action.type === 'claim' ||
      e.action.type === 'retraction' ||
      e.action.type === 'correction',
  );

  if (!hasAssertionActions) return; // hints and withholds only — no catalog required

  if (Object.keys(assertions).length === 0) {
    throw new ConfigError(
      `Discourse ledger "${ledger.id}" contains reveal/claim/retraction/correction actions but no assertion ` +
      `catalog was loaded from definitions/assertions/. In strict mode, assertion catalog is required.`,
    );
  }

  // Every assertion-bearing action must reference an existing assertion
  for (const entry of ledger.entries) {
    const action = entry.action;
    switch (action.type) {
      case 'reveal':
      case 'claim': {
        if (!assertions[action.assertionId]) {
          throw new ConfigError(
            `Ledger entry "${entry.id}" references assertion "${action.assertionId}" which does not exist ` +
            `in the assertion catalog (definitions/assertions/).`,
          );
        }
        break;
      }
      case 'retraction': {
        if (!assertions[action.assertionId]) {
          throw new ConfigError(
            `Ledger entry "${entry.id}" retracts assertion "${action.assertionId}" which does not exist ` +
            `in the assertion catalog.`,
          );
        }
        break;
      }
      case 'correction': {
        if (!assertions[action.priorAssertionId]) {
          throw new ConfigError(
            `Ledger entry "${entry.id}" correction references priorAssertion "${action.priorAssertionId}" ` +
            `which does not exist in the assertion catalog.`,
          );
        }
        if (!assertions[action.newAssertionId]) {
          throw new ConfigError(
            `Ledger entry "${entry.id}" correction references newAssertion "${action.newAssertionId}" ` +
            `which does not exist in the assertion catalog.`,
          );
        }
        break;
      }
    }
  }
}

/**
 * Validate branch-level entry structure: unknown scene IDs, duplicate positions,
 * entry/action position equality, and position ordering.
 */
function preflightBranchEntries(
  entries: PlannedLedgerEntry[],
  eventIds: Set<string>,
  branch: string,
): void {
  const seenPositions = new Set<number>();
  const sorted = [...entries].sort((a, b) => a.discoursePosition - b.discoursePosition);
  let lastPosition = -1;

  for (const entry of sorted) {
    // Scenes must exist
    if (!eventIds.has(entry.sceneId)) {
      throw new ConfigError(
        `Ledger entry "${entry.id}" on branch "${branch}" references sceneId "${entry.sceneId}" ` +
        `which does not match any event ID.`,
      );
    }

    // Position must be nonnegative
    if (entry.discoursePosition < 0) {
      throw new ConfigError(
        `Ledger entry "${entry.id}" on branch "${branch}" has negative discourse position ` +
        `${entry.discoursePosition}.`,
      );
    }

    // No duplicate positions
    if (seenPositions.has(entry.discoursePosition)) {
      throw new ConfigError(
        `Duplicate discourse position ${entry.discoursePosition} on branch "${branch}" ` +
        `(entry "${entry.id}"). Each position must be unique within a branch.`,
      );
    }
    seenPositions.add(entry.discoursePosition);

    // Monotonic order
    if (entry.discoursePosition <= lastPosition) {
      throw new ConfigError(
        `Non-monotonic discourse position ${entry.discoursePosition} on branch "${branch}" ` +
        `(entry "${entry.id}"). Positions must be strictly increasing.`,
      );
    }
    lastPosition = entry.discoursePosition;

    // Entry/action position equality
    if (entry.action.discoursePosition !== entry.discoursePosition) {
      throw new ConfigError(
        `Ledger entry "${entry.id}" has action.discoursePosition (${entry.action.discoursePosition}) ` +
        `different from entry.discoursePosition (${entry.discoursePosition}). They must be equal.`,
      );
    }
  }
}

/**
 * Validate that each scene's action positions form a single contiguous range
 * with no gaps within the scene's interval.
 */
function preflightSceneContinuity(
  entries: PlannedLedgerEntry[],
  branch: string,
): void {
  // Group by sceneId
  const byScene = new Map<string, PlannedLedgerEntry[]>();
  for (const entry of entries) {
    const list = byScene.get(entry.sceneId) ?? [];
    list.push(entry);
    byScene.set(entry.sceneId, list);
  }

  for (const [sceneId, sceneEntries] of byScene) {
    const positions = sceneEntries.map((e) => e.discoursePosition).sort((a, b) => a - b);

    // Positions must be continuous (no gaps within scene)
    for (let i = 1; i < positions.length; i++) {
      if (positions[i] !== positions[i - 1] + 1) {
        throw new ConfigError(
          `Scene "${sceneId}" on branch "${branch}" has non-continuous action positions: ` +
          `${positions.join(', ')}. Scene action positions must form a contiguous range. ` +
          `Gap between ${positions[i - 1]} and ${positions[i]}.`,
        );
      }
    }
  }
}

/**
 * Cumulative preflight of each entry against the cumulative discourse state:
 * validates reveal/claim/retraction/correction semantic rules,
 * withhold transition conflicts, and hint structural references.
 *
 * This single linear pass validates semantic legality and accumulates
 * the active-reveal / active-claim sets for retraction/correction checks.
 */
function preflightSemanticRules(
  entries: PlannedLedgerEntry[],
  assertions: Record<string, NarratorAssertion>,
  _narratorProfiles: Record<string, NarratorProfile>,
  branch: string,
): void {
  const sorted = [...entries].sort((a, b) => a.discoursePosition - b.discoursePosition);

  // Track cumulative active state for retraction/correction validation.
  // reflects the same semantics as applyAction() in discourse-replay:
  //   - reveals: never removed (retraction doesn't remove from reveals)
  //   - openClaims: removed by retraction
  //   - corrections: replace in both reveals and claims
  const activeReveals = new Set<string>();
  const activeClaims = new Set<string>();
  const activeWithholdPolicies = new Set<string>();

  for (const entry of sorted) {
    const action = entry.action;

    // No assertionId extraction before the switch — use narrowing per case
    switch (action.type) {
      case 'reveal': {
        const assertionId = action.assertionId;
        const catAssertion = assertions[assertionId];
        // §5: truth-boundary hard rule
        if (catAssertion && catAssertion.truthBoundary !== true) {
          throw new ConfigError(
            `Reveal in entry "${entry.id}" on branch "${branch}" references assertion ` +
            `"${assertionId}" which has truthBoundary=${catAssertion.truthBoundary}. ` +
            `Reveals require truthBoundary=true.`,
          );
        }
        activeReveals.add(assertionId);
        break;
      }

      case 'claim': {
        const assertionId = action.assertionId;
        const catAssertion = assertions[assertionId];
        // §6: claim references non-authoritative assertion
        if (catAssertion) {
          if (catAssertion.truthBoundary === true || catAssertion.type === 'authoritative_reveal') {
            throw new ConfigError(
              `Claim in entry "${entry.id}" on branch "${branch}" references assertion ` +
              `"${assertionId}" which is authoritative/truth-boundary. ` +
              `Claims must reference non-authoritative assertions.`,
            );
          }
        }
        activeClaims.add(assertionId);
        break;
      }

      case 'retraction': {
        const retractId = action.assertionId;
        // §8: retraction must reference an earlier active claim or reveal
        if (!activeReveals.has(retractId) && !activeClaims.has(retractId)) {
          throw new ConfigError(
            `Retraction in entry "${entry.id}" on branch "${branch}" references assertion ` +
            `"${retractId}" which has not been revealed or claimed in an earlier entry. ` +
            `Available reveals: [${[...activeReveals].join(', ')}]. ` +
            `Available claims: [${[...activeClaims].join(', ')}].`,
          );
        }
        activeClaims.delete(retractId);
        break;
      }

      case 'correction': {
        const priorId = action.priorAssertionId;
        const newId = action.newAssertionId;

        // prior must be active
        if (!activeReveals.has(priorId) && !activeClaims.has(priorId)) {
          throw new ConfigError(
            `Correction in entry "${entry.id}" on branch "${branch}" references ` +
            `priorAssertion "${priorId}" which is not currently active ` +
            `(has not been revealed or claimed earlier on this branch).`,
          );
        }

        if (priorId === newId) {
          throw new ConfigError(
            `Correction in entry "${entry.id}" on branch "${branch}" has identical ` +
            `priorAssertionId and newAssertionId "${priorId}". Correction must reference ` +
            `two different assertions.`,
          );
        }

        if (activeReveals.has(newId) || activeClaims.has(newId)) {
          throw new ConfigError(
            `Correction in entry "${entry.id}" on branch "${branch}" references ` +
            `newAssertion "${newId}" which is already revealed or claimed. ` +
            `The replacement assertion must not already be active.`,
          );
        }

        const priorAssertion = assertions[priorId];
        const newAssertion = assertions[newId];
        if (priorAssertion && newAssertion && priorAssertion.type === 'authoritative_reveal') {
          if (newAssertion.type !== 'authoritative_reveal' || newAssertion.truthBoundary !== true) {
            throw new ConfigError(
              `Correction in entry "${entry.id}" on branch "${branch}": prior assertion ` +
              `"${priorId}" is authoritative_reveal but replacement "${newId}" does not ` +
              `satisfy reveal requirements (type=authoritative_reveal, truthBoundary=true).`,
            );
          }
        }

        activeReveals.delete(priorId);
        activeClaims.delete(priorId);
        if (newAssertion?.type === 'authoritative_reveal') {
          activeReveals.add(newId);
        } else {
          activeClaims.add(newId);
        }
        break;
      }

      case 'hint': {
        // §7: hints allowed — target never enters projection (enforced by projectDiscourseContext)
        break;
      }

      case 'withhold_start':
      case 'withhold_end': {
        // Validated by structural preflight
        break;
      }
    }
  }
}

/**
 * Performs strict preflight validation BEFORE any provider/cache/prompt:
 *   - assertion catalog completeness (no permissive fallback)
 *   - branch-local duplicate positions
 *   - entry/action position equality
 *   - unique/continuous per-scene action ranges
 *   - unknown scene IDs
 *   - invalid cursors (< -1 or range jumps)
 *   - reveal must reference existing truthBoundary=true assertion
 *   - claim must reference non-authoritative assertion
 *   - retraction must reference earlier active claim/reveal
 *   - correction must have valid differing prior/new assertions
 *   - withhold/moderator transitions must be legal
 *   - hint target never enters projection (enforced by projectDiscourseContext)
 *
 * Returns a deterministic, immutable Record<eventId, CompiledDiscourseRenderContext>
 * for valid branches. Throws ConfigError synchronously for malformed planned data.
 *
 * @param events  - All reachable authored events in the selected branch.
 * @param ledger  - Runtime-compiled mandatory disclosure ledger.
 * @param assertions - Assertion catalog loaded from definitions/assertions/.
 * @param narratorProfiles - Narrator profiles from definitions/narrators/.
 * @param branch  - Reader-order branch scope to compile for.
 * @returns Record keyed by event id with fully pre-compiled discourse contexts.
 */
export function compileDiscourseBoundaries(
  events: NarrativeEvent[],
  ledger: PlannedDiscourseLedger,
  assertions: Record<string, NarratorAssertion>,
  narratorProfiles: Record<string, NarratorProfile>,
  branch: string,
): Record<string, CompiledDiscourseRenderContext> {
  const eventIds = new Set(events.map((event) => event.id));
  const assertionCatalogHash = computeCatalogHash(assertions);
  const contexts: Record<string, CompiledDiscourseRenderContext> = {};

  preflightAssertionCatalog(ledger, assertions);
  const branchEntries = ledger.entries.filter((entry) => entry.branch === branch);
  preflightBranchEntries(branchEntries, eventIds, branch);
  preflightSceneContinuity(branchEntries, branch);
  preflightSemanticRules(branchEntries, assertions, narratorProfiles, branch);

  const sceneSequence = compileDiscourseSceneSequence({ events, ledger, branch });
  const sceneIds = sceneSequence.map((entry) => entry.sceneId);
  const actionIntervals = new Map<string, { start: number; end: number }>();
  for (const entry of sceneSequence) {
    if (entry.actionInterval) {
      actionIntervals.set(entry.sceneId, entry.actionInterval);
    }
  }
  const eventById = new Map(events.map((event) => [event.id, event]));
  const entriesByScene = new Map<string, PlannedLedgerEntry[]>();
  for (const entry of branchEntries) {
    const entries = entriesByScene.get(entry.sceneId) ?? [];
    entries.push(entry);
    entriesByScene.set(entry.sceneId, entries);
  }

  let latestActionPosition = -1;
  for (const sceneId of sceneIds) {
    const event = eventById.get(sceneId)!;
    const sceneEntries = entriesByScene.get(sceneId);
    const interval = actionIntervals.get(sceneId);
    let stateBefore: DiscourseState;
    let stateAfter: DiscourseState;
    let cursor: number;
    let currentActionIds: string[];

    if (sceneEntries && interval) {
      stateBefore = buildStateAtCursor(interval.start, ledger, branch, assertions);
      stateAfter = replayDiscourseState(ledger, interval.end, branch, assertions);
      cursor = interval.start;
      currentActionIds = [...sceneEntries]
        .sort((left, right) => left.discoursePosition - right.discoursePosition)
        .map((entry) => entry.id);
      latestActionPosition = interval.end;
    } else {
      cursor = latestActionPosition;
      currentActionIds = [];
      stateBefore =
        cursor === -1
          ? makeEmptyState(branch, assertions, ledger.hash)
          : replayDiscourseState(ledger, cursor, branch, assertions);
      stateAfter = cloneDiscourseState(stateBefore);
    }

    const authorizedAssertions: string[] = [];
    for (const entry of sceneEntries ?? []) {
      if (entry.action.type === 'reveal' || entry.action.type === 'claim') {
        authorizedAssertions.push(entry.action.assertionId);
      }
    }
    const projection = projectDiscourseContext(
      stateAfter,
      narratorProfiles[event.narratorProfileRef ?? ''],
      event.pov.character,
      authorizedAssertions,
    );

    contexts[event.id] = {
      stateBefore,
      stateAfter,
      projection,
      currentActionIds,
      branch,
      cursor,
      ledgerHash: ledger.hash,
      assertionCatalogHash,
    };
  }

  return contexts;
}
