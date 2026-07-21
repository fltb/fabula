// ============================================================================
// Novalistically — INTEGRATION-2: ReferenceIndex computation & eligibility
// ReferenceIndex is recomputed from canonical WorldState domains.
// NOT independently writable; snapshot/cache MUST match recomputation hash.
// ============================================================================

import type { WorldState, EntityRuntimeState } from '../types/index.js';
import type {
  ReferenceIndex,
  ReferenceEntry,
  ReferenceMode,
  ReferenceKind,
} from '../types/reference.js';

// ═════════════════════════════════════════════════════════════════════════════
// Constants
// ═════════════════════════════════════════════════════════════════════════════

/** All 14 reference kinds for enumeration/validation */
export const ALL_REFERENCE_KINDS: ReferenceKind[] = [
  'declaration',
  'runtime_foreign_key',
  'relationship_membership',
  'knowledge_subject',
  'proposition_target',
  'thread_binding',
  'rule_scope',
  'scene_participant',
  'pov_focalizer',
  'narrator_subject',
  'discourse_target',
  'causal_output',
  'provenance',
  'historical_boundary',
];

// ═════════════════════════════════════════════════════════════════════════════
// computeReferenceIndex — recompute from canonical WorldState
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Recompute the full ReferenceIndex by scanning every domain in the canonical
 * WorldState. Every call produces an identical index for identical state.
 *
 * Domains scanned:
 *  - Entity declarations (identity)
 *  - Thread bindings (live or historical based on thread lifecycle)
 *  - Rule scope bindings (live or historical based on activation)
 *  - Relationship memberships (live or historical based on epoch lifecycle)
 *  - EpistemicLedger claims (live knowledge_subject refs)
 *  - InformationActs (automatically historical per constraint 4)
 *  - Proposition catalog targets (identity)
 */
export function computeReferenceIndex(worldState: WorldState): ReferenceIndex {
  const entries: ReferenceEntry[] = [];

  // ── 1. Entity declarations (identity) ──────────────────────────────────
  for (const entityId of Object.keys(worldState.entities)) {
    entries.push({
      targetEntityId: entityId,
      mode: 'identity',
      kind: 'declaration',
      sourceDomain: 'entity',
      sourceId: entityId,
    });
  }

  // ── 2. Thread bindings ─────────────────────────────────────────────────
  for (const [threadId, threadState] of Object.entries(worldState.threads)) {
    const threadLive = isThreadLive(threadState.status);
    for (const [_role, boundEntityId] of Object.entries(threadState.bindings)) {
      if (typeof boundEntityId === 'string') {
        entries.push({
          targetEntityId: boundEntityId,
          mode: threadLive ? 'live' : 'historical',
          kind: 'thread_binding',
          sourceDomain: 'thread',
          sourceId: `${threadId}:${threadState.currentRunId}`,
        });
      }
    }
  }

  // ── 3. Rule scope bindings ─────────────────────────────────────────────
  for (const [ruleId, ruleState] of Object.entries(worldState.rules)) {
    const ruleLive = ruleState.activation === 'enabled';
    for (const [key, value] of Object.entries(ruleState.scopeBindings)) {
      if (typeof value === 'string') {
        entries.push({
          targetEntityId: value,
          mode: ruleLive ? 'live' : 'historical',
          kind: 'rule_scope',
          sourceDomain: 'rule',
          sourceId: `${ruleId}:${key}`,
        });
      }
    }
  }

  // ── 4. Relationship memberships ────────────────────────────────────────
  for (const [relId, relState] of Object.entries(worldState.relationships)) {
    for (const [epochId, epoch] of Object.entries(relState.epochs)) {
      const epochLive = epoch.lifecycle === 'active';
      for (const [memId, membership] of Object.entries(epoch.memberships)) {
        entries.push({
          targetEntityId: membership.entityId,
          mode: epochLive ? 'live' : 'historical',
          kind: 'relationship_membership',
          sourceDomain: 'relationship',
          sourceId: `${relId}:${epochId}:${memId}`,
        });
      }
    }
  }

  // ── 5. EpistemicLedger: claim subjects (live knowledge_subject) ────────
  if (worldState.epistemicLedger) {
    const ledger = worldState.epistemicLedger;
    for (const [subjectId, propIds] of Object.entries(ledger.bySubject)) {
      for (const propId of propIds) {
        entries.push({
          targetEntityId: subjectId,
          mode: 'live',
          kind: 'knowledge_subject',
          sourceDomain: 'knowledge',
          sourceId: `claim:${subjectId}:${propId}`,
        });
      }
    }

    // ── 5b. InformationActs -> automatically historical (constraint 4) ──
    for (const act of ledger.actLog) {
      entries.push({
        targetEntityId: act.actor,
        mode: 'historical',
        kind: 'knowledge_subject',
        sourceDomain: 'knowledge',
        sourceId: `information_act:${act.eventId}:actor`,
        boundary: act.storyBoundary,
      });
      for (let i = 0; i < act.recipients.length; i++) {
        entries.push({
          targetEntityId: act.recipients[i],
          mode: 'historical',
          kind: 'knowledge_subject',
          sourceDomain: 'knowledge',
          sourceId: `information_act:${act.eventId}:recipient:${i}`,
          boundary: act.storyBoundary,
        });
      }
    }
  }

  // ── 6. Proposition catalog targets (identity) ──────────────────────────
  if (worldState.propositionCatalog) {
    for (const propId of Object.keys(worldState.propositionCatalog.propositions)) {
      entries.push({
        targetEntityId: propId,
        mode: 'identity',
        kind: 'proposition_target',
        sourceDomain: 'proposition',
        sourceId: propId,
      });
    }
  }

  // ── Build index ────────────────────────────────────────────────────────
  return buildIndex(entries);
}

// ═════════════════════════════════════════════════════════════════════════════
// Eligibility validation
// ═════════════════════════════════════════════════════════════════════════════

export type EligibilityOutcome = 'eligible' | 'ineligible';

export interface EligibilityResult {
  outcome: EligibilityOutcome;
  reason?: string;
}

/**
 * Default eligibility for creating a new reference to an entity.
 *
 * Per constraint 6:
 *  - Active -> can create new live references
 *  - Inactive -> existing live references retained, CANNOT create new (by default;
 *    type/role/scope can versionedly widen)
 *  - Retired -> permanently forbidden new live use, only identity/historical
 *  - Absent / catalog-only -> CANNOT create new live reference
 *
 * Per constraint 8 (core safety):
 *  - CANNOT allow absent/retired to accept new live reference
 *  - Retired CAN ONLY become historical via explicit conversion + fixed boundary
 *
 * Per constraint 12 (discourse/narrator):
 *  - narrator_subject, discourse_target, scene_participant, pov_focalizer
 *    are allowed as historical references for retired entities (narrator can
 *    reference historical entity, but cannot create new live reference).
 */
export function checkNewReferenceEligibility(
  lifecycle: EntityRuntimeState | undefined,
  mode: ReferenceMode,
  kind: ReferenceKind,
  override?: { inactiveOverride?: boolean },
): EligibilityResult {
  // Identity refs are always eligible (stable declaration only, no current
  // existence assertion per constraint 1)
  if (mode === 'identity') {
    return { outcome: 'eligible' };
  }

  // Historical refs: can reference any entity that has a lifecycle state.
  // Retired entities CAN become historical via explicit conversion.
  if (mode === 'historical') {
    if (lifecycle === undefined) {
      return {
        outcome: 'ineligible',
        reason: `Cannot create historical reference to absent entity (kind=${kind})`,
      };
    }

    // Retired entities: narrator_subject, discourse_target, scene_participant,
    // pov_focalizer, historical_boundary, provenance, causal_output are
    // approved for historical reference (constraint 12: narrator can reference
    // historical entity; constraint 11: explicit historical conversion).
    if (lifecycle === 'retired') {
      const approvedHistoricalForRetired: ReferenceKind[] = [
        'historical_boundary',
        'provenance',
        'causal_output',
        'narrator_subject',
        'discourse_target',
        'scene_participant',
        'pov_focalizer',
      ];
      if (approvedHistoricalForRetired.includes(kind)) {
        return { outcome: 'eligible' };
      }
      return {
        outcome: 'ineligible',
        reason: `Retired entity requires explicit historical conversion for ${kind} reference`,
      };
    }

    return { outcome: 'eligible' };
  }

  // Live references:
  if (lifecycle === undefined) {
    return {
      outcome: 'ineligible',
      reason: 'Absent/catalog-only entity cannot accept new live reference',
    };
  }

  if (lifecycle === 'retired') {
    return {
      outcome: 'ineligible',
      reason: 'Retired entity permanently forbidden from new live reference',
    };
  }

  if (lifecycle === 'inactive') {
    if (override?.inactiveOverride) {
      return { outcome: 'eligible' };
    }
    return {
      outcome: 'ineligible',
      reason: 'Inactive entity cannot accept new live references (override not set)',
    };
  }

  // Active
  return { outcome: 'eligible' };
}

/**
 * Validate a set of new reference entries against the lifecycle map.
 * Returns an array of error strings (empty if all eligible).
 */
export function validateNewReferenceSet(
  entries: ReferenceEntry[],
  lifecycleMap: Record<string, EntityRuntimeState | undefined>,
  overrides?: Record<string, { inactiveOverride?: boolean }>,
): string[] {
  const errors: string[] = [];
  for (const entry of entries) {
    const lifecycle = lifecycleMap[entry.targetEntityId];
    const override = overrides?.[entry.targetEntityId];
    const result = checkNewReferenceEligibility(lifecycle, entry.mode, entry.kind, override);
    if (result.outcome === 'ineligible') {
      errors.push(
        `Reference to ${entry.targetEntityId} (${entry.mode}/${entry.kind}): ${result.reason}`,
      );
    }
  }
  return errors;
}

/**
 * Validate retirement closure: verify all incoming live references to the
 * retiring entity are closed or converted to historical.
 *
 * Per constraint 5: live references MUST be explicitly closed:
 *  - relationship membership
 *  - runtime foreign key
 *  - active Thread binding
 *  - active Rule scope
 *
 * Per constraint 11: committed artifacts are automatically historical and
 * do NOT block retirement. Relationship memberships/current foreign keys MUST
 * be explicitly closed. Thread/Rule bindings MUST be explicitly closed OR
 * fixed-boundary historical conversion authorized by type policy.
 *
 * Returns an array of unclosed live reference descriptions.
 */
export function validateRetirementClosure(
  retiringEntityId: string,
  currentIndex: ReferenceIndex,
): string[] {
  const unclosed: string[] = [];
  const refs = currentIndex.byEntity[retiringEntityId] ?? [];

  for (const ref of refs) {
    if (ref.mode !== 'live') continue;

    // Live references that MUST be explicitly closed before retirement.
    // Constraint 11: committed artifacts are automatically historical.
    switch (ref.kind) {
      case 'relationship_membership':
        unclosed.push(
          `Live relationship_membership not closed: ${ref.sourceId} references ${retiringEntityId}`,
        );
        break;
      case 'runtime_foreign_key':
        unclosed.push(
          `Live runtime_foreign_key not closed: ${ref.sourceId} references ${retiringEntityId}`,
        );
        break;
      case 'thread_binding':
        unclosed.push(
          `Live thread_binding not closed: ${ref.sourceId} references ${retiringEntityId}`,
        );
        break;
      case 'rule_scope':
        unclosed.push(
          `Live rule_scope not closed: ${ref.sourceId} references ${retiringEntityId}`,
        );
        break;
      case 'scene_participant':
      case 'pov_focalizer':
      case 'narrator_subject':
        unclosed.push(
          `Live ${ref.kind} not closed: ${ref.sourceId} references ${retiringEntityId}`,
        );
        break;
      case 'discourse_target':
        unclosed.push(
          `Live discourse_target not closed: ${ref.sourceId} references ${retiringEntityId}`,
        );
        break;
      // knowledge_subject and proposition_target are automatically handled
      // via constraint 4 (committed artifacts -> automatically historical)
      // and constraint 11 (committed InformationActs/claims -> archival historical)
      default:
        break;
    }
  }

  return unclosed;
}

/**
 * Full candidate validation per atomic node order (constraint 13):
 * 1. stateBefore preconditions
 * 2. Build lifecycle/cross-domain candidate
 * 3. Recompute candidate ReferenceIndex
 * 4. Validate each new reference target eligibility
 * 5. Validate each retirement has closed/historicalized all incoming live refs
 * 6. Commit or reject
 *
 * This function covers steps 4-5. Steps 1-3 are caller responsibilities.
 */
export function validateCandidateIndex(
  candidateIndex: ReferenceIndex,
  lifecycleMap: Record<string, EntityRuntimeState | undefined>,
  retiringEntityIds: string[],
  newEntries?: ReferenceEntry[],
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Step 4: Validate new reference eligibility
  if (newEntries && newEntries.length > 0) {
    const newRefErrors = validateNewReferenceSet(newEntries, lifecycleMap);
    errors.push(...newRefErrors);
  }

  // Step 5: Validate retirement closure
  for (const entityId of retiringEntityIds) {
    const closureErrors = validateRetirementClosure(entityId, candidateIndex);
    for (const err of closureErrors) {
      errors.push(`Retirement closure failure for ${entityId}: ${err}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

// ═════════════════════════════════════════════════════════════════════════════
// Helpers
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Determine whether a thread status counts as "live" for reference purposes.
 * 'planned' and 'active' and 'blocked' are ongoing; completed/abandoned/retired are done.
 */
function isThreadLive(status: string): boolean {
  return status === 'planned' || status === 'active' || status === 'blocked';
}

/**
 * Build a ReferenceIndex from an entry list: group by entity and compute hash.
 */
function buildIndex(entries: ReferenceEntry[]): ReferenceIndex {
  const byEntity = groupByEntity(entries);
  const hash = computeIndexHash(byEntity);
  return { byEntity, hash };
}

function groupByEntity(entries: ReferenceEntry[]): Record<string, ReferenceEntry[]> {
  const map: Record<string, ReferenceEntry[]> = {};
  for (const entry of entries) {
    const key = entry.targetEntityId;
    if (!map[key]) map[key] = [];
    map[key].push(entry);
  }
  return map;
}

/**
 * Deterministic hash computed from sorted reference entries.
 * Sorting ensures stable hash for identical index content.
 * Used to verify snapshot/cache matches canonical recomputation (constraint 2).
 */
export function computeIndexHash(byEntity: Record<string, ReferenceEntry[]>): string {
  // Flatten and sort deterministically
  const allEntries: Array<{
    targetEntityId: string;
    mode: string;
    kind: string;
    sourceDomain: string;
    sourceId: string;
    boundary?: string;
  }> = [];

  for (const [entityId, refs] of Object.entries(byEntity)) {
    for (const ref of refs) {
      allEntries.push({
        targetEntityId: entityId,
        mode: ref.mode,
        kind: ref.kind,
        sourceDomain: ref.sourceDomain,
        sourceId: ref.sourceId,
        ...(ref.boundary ? { boundary: ref.boundary } : {}),
      });
    }
  }

  // Sort by targetEntityId, then sourceDomain, then sourceId
  allEntries.sort((a, b) => {
    const ka = `${a.targetEntityId}|${a.sourceDomain}|${a.sourceId}`;
    const kb = `${b.targetEntityId}|${b.sourceDomain}|${b.sourceId}`;
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return 0;
  });

  const json = JSON.stringify(allEntries);
  return simpleHash(json);
}

/** djb2 string hash -> hex string */
function simpleHash(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash) + input.charCodeAt(i);
    hash = hash >>> 0; // unsigned 32-bit
  }
  return hash.toString(16);
}
