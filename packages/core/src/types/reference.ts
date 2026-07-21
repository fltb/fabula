// ============================================================================
// Novalistically — INTEGRATION-2: Reference Eligibility Types
// Every entity reference has explicit identity|live|historical mode.
// ReferenceIndex is recomputed from canonical state, not independently writable.
// ============================================================================

import type { EntityId } from './entity.js';

// ─── ReferenceMode ──────────────────────────────────────────────────────────
// identity  = only references stable declaration, no current existence assertion
// live      = current runtime participation
// historical = bound to fixed past boundary/tombstone

export type ReferenceMode = 'identity' | 'live' | 'historical';

// ─── ReferenceKind (MUST include all 14 kinds, per constraint 9) ────────────

export type ReferenceKind =
  | 'declaration'
  | 'runtime_foreign_key'
  | 'relationship_membership'
  | 'knowledge_subject'
  | 'proposition_target'
  | 'thread_binding'
  | 'rule_scope'
  | 'scene_participant'
  | 'pov_focalizer'
  | 'narrator_subject'
  | 'discourse_target'
  | 'causal_output'
  | 'provenance'
  | 'historical_boundary';

// ─── ReferenceEntry ─────────────────────────────────────────────────────────

export interface ReferenceEntry {
  /** Target entity being referenced */
  targetEntityId: EntityId;
  /** Mode: identity (stable), live (runtime), historical (bound to boundary) */
  mode: ReferenceMode;
  /** Kind of reference */
  kind: ReferenceKind;
  /** Domain where the reference originates */
  sourceDomain: string;
  /** Specific ID within the domain */
  sourceId: string;
  /** Fixed boundary/tombstone for historical refs (mandatory for historical_boundary kind) */
  boundary?: string;
}

// ─── ReferenceIndex ─────────────────────────────────────────────────────────
// Runtime-maintained, recomputed from canonical state. NOT independently writable.
// Snapshot/cache MUST match canonical recomputation hash.

export interface ReferenceIndex {
  /** Map: targetEntityId → references from every domain */
  byEntity: Record<EntityId, ReferenceEntry[]>;
  /** Deterministic hash covering every entry — MUST match canonical recomputation */
  hash: string;
}
