// ============================================================================
// Novalistically — STATE-4 Knowledge/Belief Types
// Knowledge = subject's attitude toward immutable proposition
// ============================================================================

import type {
  AuthoredStoryTime,
  EntityId,
  FactId,
  LocatableStoryTimestamp,
  StoryTimestamp,
} from './entity.js';

// ─── Proposition ─────────────────────────────────────────────────────────────

export type PropositionId = FactId;

export type PropositionKind = 'grounded' | 'epistemic' | 'act' | 'intensional';

export type InformationActType =
  | 'perception'
  | 'thought'
  | 'testimony'
  | 'assertion'
  | 'inference'
  | 'reading'
  | 'recall'
  | 'revelation';

export interface GroundedProposition {
  kind: 'grounded';
  id: PropositionId;
  entityId: EntityId;
  attribute: string;
  /** The canonical value this proposition asserts */
  value: unknown;
  /**
   * Quantifier for collection/negation semantics:
   * - 'identity' (default): exact value match
   * - 'all': entity's value must contain all members
   * - 'any': entity's value must contain at least one member
   * - 'not': entity's value must NOT equal this value
   */
  quantifier?: 'identity' | 'all' | 'any' | 'not';
  /** Reference to the canonical fact that grounds this proposition (when available) */
  factId?: FactId;
}

export interface EpistemicProposition {
  kind: 'epistemic';
  id: PropositionId;
  subject: EntityId;
  propositionId: PropositionId;
  attitude: 'knows' | 'believes' | 'suspects' | 'denies' | 'doubts';
}

export interface ActProposition {
  kind: 'act';
  id: PropositionId;
  actType: InformationActType;
  actor: EntityId;
  recipients: EntityId[];
  contentPropositions: PropositionId[];
  /** The story-timeline boundary within which this act is visible */
  storyBoundary?: string;
  /** In-world source identifier (e.g. a document, prophecy, artifact) */
  inWorldSource?: string;
  /** Corpus/metadata provenance */
  corpusProvenance?: string;
}

export interface IntensionalProposition {
  kind: 'intensional';
  id: PropositionId;
  /** Opaque stable content — not semantically decomposed */
  content: string;
  domain: 'plan' | 'dream' | 'prophecy' | 'theory' | 'moral_judgment' | 'counterfactual';
}

export type Proposition =
  | GroundedProposition
  | EpistemicProposition
  | ActProposition
  | IntensionalProposition;

// ─── PropositionCatalog ──────────────────────────────────────────────────────
// Immutable/versioned catalog of all propositions in the story universe.
// Intensional propositions are recognised but do NOT provide world-truth access.

export interface PropositionCatalog {
  version: 1;
  propositions: Record<PropositionId, Proposition>;
  /**
   * Dependency graph: edges from one proposition to propositions it references.
   * Must be acyclic. Self-references are rejected.
   * Grounded → [] (no deps)
   * Epistemic → [propositionId] (the nested target)
   * Act → contentPropositions
   * Intensional → [] (opaque)
   */
  dependencyGraph: Record<PropositionId, PropositionId[]>;
}

// ─── ClaimSemanticState ──────────────────────────────────────────────────────

export type ClaimGrade = 'know' | 'believe' | 'suspect';

export type ClaimPolarity = 'affirmative' | 'negative';

export interface SettledAssessment {
  type: 'settled';
  grade: ClaimGrade;
  polarity: ClaimPolarity;
}

export interface ConflictedAssessment {
  type: 'conflicted';
  affirmations: number;
  rejections: number;
}

export interface SuspendedAssessment {
  type: 'suspended';
}

export interface ForgottenAssessment {
  type: 'forgotten';
}

export interface UnsetAssessment {
  type: 'unset';
}

export type ClaimAssessment =
  | SettledAssessment
  | ConflictedAssessment
  | SuspendedAssessment
  | ForgottenAssessment
  | UnsetAssessment;

// ─── ClaimEvidenceRecord ─────────────────────────────────────────────────────

export type EvidenceSource =
  | 'direct_experience'
  | 'testimony'
  | 'inference'
  | 'revelation'
  | 'default';

export interface ClaimEvidenceRecord {
  source: EvidenceSource;
  /** Qualitative warrant description */
  warrant?: string;
  /** Entity that provided the evidence (e.g. testifier) */
  provider?: EntityId;
  /** Event-ID chain establishing provenance */
  provenance: string[];
  acquiredAt: StoryTimestamp;
}

// ─── Claim ───────────────────────────────────────────────────────────────────
// Canonical cell key: `${subject}:${propositionId}`

export interface Claim {
  subject: EntityId;
  propositionId: PropositionId;
  assessment: ClaimAssessment;
  /** Ordered evidence lineage (most recent first) */
  evidence: ClaimEvidenceRecord[];
}

// ─── EpistemicLedger ─────────────────────────────────────────────────────────
// Per-character knowledge state, replayed per concrete branch.

export interface EpistemicLedger {
  /** Key = `${subject}:${propositionId}` */
  claims: Record<string, Claim>;
  /** Index: subject → proposition IDs */
  bySubject: Record<EntityId, PropositionId[]>;
  /** Index: proposition ID → all subjects with claims about it */
  byProposition: Record<PropositionId, EntityId[]>;
  /** Information acts that have occurred (ordered) */
  actLog: InformationAct[];
}

// ─── InformationAct ──────────────────────────────────────────────────────────
// Immutable event-log output: records an information/psychological/communication act.

export interface InformationAct {
  type: InformationActType;
  actor: EntityId;
  recipients: EntityId[];
  contentPropositions: PropositionId[];
  storyBoundary?: string;
  inWorldSource?: string;
  corpusProvenance?: string;
  timestamp: StoryTimestamp;
  eventId: string;
  /** Semantic warrant justification for 'know' production */
  warrantJustification?: string;
}

// ─── Group Epistemic Forms ───────────────────────────────────────────────────

export type GroupEpistemicMode = 'institutional' | 'distributed' | 'mutual';

export interface GroupEpistemicQueryDefinition {
  groupId: string;
  mode: GroupEpistemicMode;
  propositionId: PropositionId;
  /** Frozen audience snapshot; empty audience → both false (no vacuous mutual truth) */
  audience: EntityId[];
}

export interface CommonGroundRecord {
  propositionId: PropositionId;
  participants: EntityId[];
  establishedAt: StoryTimestamp;
  establishedBy: string; // eventId
}
// ─── Source declarations and event transactions ─────────────────────────────

/** Author-wire evidence; the mapper normalizes its timestamp exactly once. */
export interface SourceClaimEvidence {
  source: EvidenceSource;
  acquiredAt: AuthoredStoryTime;
  warrant?: string;
  provider?: EntityId;
  provenance: string[];
}

/** Explicit initial claim declaration; no derived ledger indexes are authored. */
export interface KnowledgeClaimDeclaration {
  subject: EntityId;
  propositionId: PropositionId;
  assessment: ClaimAssessment;
  evidence: SourceClaimEvidence[];
}

/** Explicit initial common-ground declaration; no ledger indexes are authored. */
export interface KnowledgeCommonGroundDeclaration {
  propositionId: PropositionId;
  participants: EntityId[];
  establishedAt: AuthoredStoryTime;
  establishedBy?: string;
}

export interface KnowledgeInitialState {
  claims: KnowledgeClaimDeclaration[];
  commonGround: KnowledgeCommonGroundDeclaration[];
}

export interface ClaimWriteTransaction {
  type: 'claim_write';
  subject: EntityId;
  propositionId: PropositionId;
  assessment: ClaimAssessment;
  evidence: SourceClaimEvidence[];
}

export interface InformationActTransaction {
  type: 'information_act';
  actType: InformationActType;
  actor: EntityId;
  recipients: EntityId[];
  contentPropositions: PropositionId[];
  timestamp: AuthoredStoryTime;
  storyBoundary?: string;
  inWorldSource?: string;
  corpusProvenance?: string;
  warrantJustification?: string;
}

export interface CommonGroundTransaction {
  type: 'common_ground';
  propositionId: PropositionId;
  participants: EntityId[];
  establishedAt: AuthoredStoryTime;
  establishedBy?: string;
}

/** Canonical source EventFile knowledge effect union. */
export type KnowledgeTransaction =
  | ClaimWriteTransaction
  | InformationActTransaction
  | CommonGroundTransaction;

/** Runtime counterpart after authored timestamps are normalized. */
export interface RuntimeClaimWriteTransaction extends Omit<ClaimWriteTransaction, 'evidence'> {
  evidence: ClaimEvidenceRecord[];
}

export interface RuntimeInformationActTransaction
  extends Omit<InformationActTransaction, 'timestamp'> {
  timestamp: StoryTimestamp;
  eventId: string;
}

export interface RuntimeCommonGroundTransaction
  extends Omit<CommonGroundTransaction, 'establishedAt'> {
  establishedAt: StoryTimestamp;
  provenance?: string;
}

export type RuntimeKnowledgeTransaction =
  | RuntimeClaimWriteTransaction
  | RuntimeInformationActTransaction
  | RuntimeCommonGroundTransaction;

// ─── NarrativeKnowledgeBoundary ──────────────────────────────────────────────
// Focalizer's accessible claims at a specific event stateBefore.

export interface NarrativeKnowledgeBoundary {
  focalizer: EntityId;
  /** Allowlisted claim keys (`${subject}:${propositionId}`) accessible to the focalizer */
  allowlistedClaims: string[];
  boundaryTime: LocatableStoryTimestamp;
}

// ─── Evaluation ──────────────────────────────────────────────────────────────

export type EvaluationResult = 'true' | 'false' | 'indeterminate';

// ─── Helper: build claim key ─────────────────────────────────────────────────

export function claimKey(subject: EntityId, propositionId: PropositionId): string {
  return `${subject}:${propositionId}`;
}
