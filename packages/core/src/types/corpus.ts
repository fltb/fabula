// ============================================================================
// Novalistically — CORPUS-1: NarrativeEllipsis & NarrativeNode Types
// Formalizes NarrativeNode = NarrativeEvent | NarrativeEllipsis with explicit
// discriminant. NarrativeEllipsis models non-renderable narrative gaps with
// identity, branch scope, single story time, optional source-grounded
// diagnostic summary, precondition/postcondition facts, and
// Entity/Relationship/Knowledge/Thread/Rule transactions.
// ============================================================================

import type { BranchPath } from './branch.js';
import type { StoryTimestamp, Fact } from './entity.js';
import type { NarrativeEvent } from './event.js';
import type { RelationshipTransaction } from './relationship.js';
import type { InformationAct } from './knowledge.js';
import type { ThreadTransaction } from './thread.js';
import type { RuleTransaction } from './rule.js';

// ─── EllipsisProvenance — atomic source grounding (§CORPUS-1) ─────────────

export interface EllipsisProvenance {
  /** Hash of the source material this ellipsis was extracted from */
  sourceHash: string;
  /** Character range in the source material */
  sourceRange: { start: number; end: number };
  /** Optional reviewer identity for manual review pass */
  reviewerId?: string;
  /** Timestamp of the review/annotation */
  reviewTimestamp?: string;
}

// ─── NarrativeEllipsis — non-renderable narrative gap (§CORPUS-1) ─────────

export interface NarrativeEllipsis {
  /** Explicit discriminant — 'ellipsis' for discriminated union with NarrativeEvent */
  kind: 'ellipsis';
  /** Unique identifier within the narrative corpus */
  id: string;
  /** Branch scope this ellipsis belongs to */
  branchScope: BranchPath;
  /** Exactly one valid story time — multiple incompatible storyTimes MUST be split */
  storyTime: StoryTimestamp;
  /**
   * Source-grounded diagnostic summary.
   * Raw textual review ONLY — NEVER creates claim/provider, Fact, causal edge,
   * WorldState change, or DiscourseState change. NEVER enters logical prompt.
   */
  summary?: string;
  /** Preconditions that must hold for this ellipsis to be valid */
  preconditions: Fact[];
  /** Postconditions: Entity attribute writes resulting from this ellipsis */
  postconditions: Fact[];
  /** Relationship state changes applied by this ellipsis */
  relationshipEffects: RelationshipTransaction[];
  /** Knowledge/belief transactions (InformationAct array) applied by this ellipsis */
  knowledgeTransactions: InformationAct[];
  /** Thread progress transactions applied by this ellipsis */
  threadProgress: ThreadTransaction[];
  /** Rule state transactions applied by this ellipsis */
  ruleEffects: RuleTransaction[];
  /**
   * Atomic provenance — every replay-changing Fact/effect MUST have this.
   * Multiple incompatible storyTimes, branches, or causal positions within one
   * ellipsis MUST be split into separate NarrativeEllipsis instances.
   */
  provenance: EllipsisProvenance;
}

// ─── NarrativeNode — union covering all replay nodes (§CORPUS-1) ──────────
// Discriminated by the `kind` field: 'event' | 'ellipsis'.
// Works with existing DAG/replay code that expects NarrativeEvent nodes.

export type NarrativeNode = NarrativeEvent | NarrativeEllipsis;
